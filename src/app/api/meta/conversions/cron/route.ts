import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { dispatchPendingConversions } from '@/lib/meta/conversions'

export const maxDuration = 60

/**
 * Drain the Meta conversions outbox (migration 041).
 *
 * The inbound WhatsApp webhook already dispatches after every delivery,
 * so on a busy number this is only a backstop — but a deal won during a
 * quiet spell would otherwise wait for the next message. Meta rejects
 * events older than 7 days, so run it at least every few hours; every
 * 5–15 minutes keeps reporting close to real time.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` (same header as
 * /api/automations/cron and /api/flows/cron).
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const summary = await dispatchPendingConversions(supabaseAdmin(), {
    limit: 200,
  })
  return NextResponse.json(summary)
}
