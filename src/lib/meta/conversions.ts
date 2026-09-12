import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Conversions API for Business Messaging — Click to WhatsApp ads.
 *
 * Migration 041's trigger queues rows in `meta_conversion_events` when a
 * deal is created (LeadSubmitted) or won (Purchase) for a contact whose
 * chat came from an ad. This module drains that outbox:
 *
 *   1. resolve the WABA's dataset (POST /{waba_id}/dataset returns the
 *      existing one if there is one), cached on whatsapp_config
 *   2. POST /{dataset_id}/events with action_source=business_messaging,
 *      messaging_channel=whatsapp and the ctwa_clid
 *
 * The token needs `whatsapp_business_manage_events` in addition to the
 * messaging/management scopes.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

// Meta rejects the whole request if any event_time is more than 7 days
// old. Stop a few minutes short so clock skew can't tip an event over.
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000
export const MAX_ATTEMPTS = 5
export const RETRY_BACKOFF_MS = 5 * 60 * 1000

export type ConversionEventName = 'LeadSubmitted' | 'Purchase'

export interface ConversionEventRow {
  id: string
  account_id: string
  deal_id: string | null
  event_name: ConversionEventName
  ctwa_clid: string
  /** NUMERIC comes back from PostgREST as a string. */
  value: number | string | null
  currency: string | null
  event_time: string
  attempts: number
}

export interface MetaConversionEvent {
  event_name: ConversionEventName
  event_time: number
  event_id: string
  action_source: 'business_messaging'
  messaging_channel: 'whatsapp'
  user_data: {
    whatsapp_business_account_id: string
    ctwa_clid: string
  }
  custom_data?: {
    currency: string
    value: number
  }
}

export class MetaConversionsError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message)
    this.name = 'MetaConversionsError'
  }
}

async function toMetaError(response: Response): Promise<MetaConversionsError> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string; code?: number; error_subcode?: number }
    }
    if (body.error?.message) {
      return new MetaConversionsError(
        body.error.message,
        body.error.code,
        body.error.error_subcode,
      )
    }
  } catch {
    // body wasn't JSON — fall through to the status-only message
  }
  return new MetaConversionsError(`Meta API error: ${response.status}`)
}

/** Shape one outbox row as Meta documents the business-messaging event. */
export function buildConversionEvent(
  row: ConversionEventRow,
  wabaId: string,
): MetaConversionEvent {
  const event: MetaConversionEvent = {
    event_name: row.event_name,
    event_time: Math.floor(Date.parse(row.event_time) / 1000),
    // Our row id: stable across retries, unique per conversion.
    event_id: row.id,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: {
      whatsapp_business_account_id: wabaId,
      ctwa_clid: row.ctwa_clid,
    },
  }

  if (row.event_name === 'Purchase') {
    // currency and value are required for Purchase.
    if (!row.currency) {
      throw new MetaConversionsError('Purchase event has no currency')
    }
    event.custom_data = {
      currency: row.currency.toUpperCase(),
      value: Number(row.value ?? 0),
    }
  }

  return event
}

export function isExpired(eventTime: string, now: Date): boolean {
  return now.getTime() - Date.parse(eventTime) > MAX_EVENT_AGE_MS
}

export async function ensureDatasetId(args: {
  wabaId: string
  accessToken: string
}): Promise<string> {
  const response = await fetch(`${META_API_BASE}/${args.wabaId}/dataset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.accessToken}` },
  })
  if (!response.ok) throw await toMetaError(response)
  const body = (await response.json()) as { id?: string }
  if (!body.id) {
    throw new MetaConversionsError('Meta did not return a dataset id')
  }
  return body.id
}

export async function sendConversionEvents(args: {
  datasetId: string
  accessToken: string
  events: MetaConversionEvent[]
  testEventCode?: string
}): Promise<unknown> {
  const response = await fetch(`${META_API_BASE}/${args.datasetId}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: args.events,
      ...(args.testEventCode ? { test_event_code: args.testEventCode } : {}),
    }),
  })
  if (!response.ok) throw await toMetaError(response)
  return response.json()
}

interface AccountConfig {
  waba_id: string | null
  access_token: string
  meta_dataset_id: string | null
  meta_conversions_enabled: boolean
}

export interface DispatchSummary {
  sent: number
  retrying: number
  failed: number
  expired: number
  skipped: number
}

/**
 * Send pending outbox rows. Safe to run concurrently (the webhook and
 * the cron both call it): each row is claimed with a compare-and-swap
 * on `attempts` before anything goes to Meta.
 */
export async function dispatchPendingConversions(
  db: SupabaseClient,
  opts: { now?: Date; limit?: number; testEventCode?: string } = {},
): Promise<DispatchSummary> {
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const testEventCode =
    opts.testEventCode ?? process.env.META_CONVERSIONS_TEST_EVENT_CODE
  const retryBefore = new Date(now.getTime() - RETRY_BACKOFF_MS).toISOString()
  const summary: DispatchSummary = {
    sent: 0,
    retrying: 0,
    failed: 0,
    expired: 0,
    skipped: 0,
  }

  const { data: rows, error } = await db
    .from('meta_conversion_events')
    .select(
      'id, account_id, deal_id, event_name, ctwa_clid, value, currency, event_time, attempts',
    )
    .eq('status', 'pending')
    .or(`last_attempt_at.is.null,last_attempt_at.lt."${retryBefore}"`)
    .order('created_at', { ascending: true })
    .limit(opts.limit ?? 50)

  if (error) {
    console.error('[meta-conversions] outbox scan failed:', error.message)
    return summary
  }
  if (!rows?.length) return summary

  const configs = new Map<string, AccountConfig | null>()

  async function loadConfig(accountId: string): Promise<AccountConfig | null> {
    if (configs.has(accountId)) return configs.get(accountId) ?? null
    const { data } = await db
      .from('whatsapp_config')
      .select('waba_id, access_token, meta_dataset_id, meta_conversions_enabled')
      .eq('account_id', accountId)
      .maybeSingle()
    const config = (data as AccountConfig | null) ?? null
    configs.set(accountId, config)
    return config
  }

  async function finish(
    row: ConversionEventRow,
    status: 'failed' | 'expired',
    reason: string,
  ) {
    await db
      .from('meta_conversion_events')
      .update({ status, last_error: reason, last_attempt_at: nowIso })
      .eq('id', row.id)
      .eq('status', 'pending')
  }

  for (const row of rows as ConversionEventRow[]) {
    if (isExpired(row.event_time, now)) {
      await finish(row, 'expired', 'event_time is more than 7 days old; Meta would reject it')
      summary.expired++
      continue
    }
    if (!row.deal_id) {
      await finish(row, 'failed', 'deal was deleted before the event was sent')
      summary.failed++
      continue
    }

    const config = await loadConfig(row.account_id)
    if (!config?.meta_conversions_enabled) {
      await finish(row, 'failed', 'Meta conversions are disabled for this account')
      summary.failed++
      continue
    }
    if (!config.waba_id) {
      await finish(row, 'failed', 'No WABA ID saved in WhatsApp settings')
      summary.failed++
      continue
    }

    // Claim: only the dispatcher that bumps `attempts` first may send.
    const attempts = row.attempts + 1
    const { data: claimed } = await db
      .from('meta_conversion_events')
      .update({ attempts, last_attempt_at: nowIso })
      .eq('id', row.id)
      .eq('status', 'pending')
      .eq('attempts', row.attempts)
      .select('id')
    if (!Array.isArray(claimed) || claimed.length === 0) {
      summary.skipped++
      continue
    }

    try {
      const accessToken = decrypt(config.access_token)

      if (!config.meta_dataset_id) {
        const datasetId = await ensureDatasetId({
          wabaId: config.waba_id,
          accessToken,
        })
        config.meta_dataset_id = datasetId
        await db
          .from('whatsapp_config')
          .update({ meta_dataset_id: datasetId })
          .eq('account_id', row.account_id)
      }

      const response = await sendConversionEvents({
        datasetId: config.meta_dataset_id,
        accessToken,
        events: [buildConversionEvent(row, config.waba_id)],
        testEventCode,
      })

      await db
        .from('meta_conversion_events')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          meta_response: response,
          last_error: null,
        })
        .eq('id', row.id)
      summary.sent++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const final = attempts >= MAX_ATTEMPTS
      await db
        .from('meta_conversion_events')
        .update({ status: final ? 'failed' : 'pending', last_error: message })
        .eq('id', row.id)
      if (final) summary.failed++
      else summary.retrying++
      console.warn(
        `[meta-conversions] ${row.event_name} ${row.id} attempt ${attempts} failed:`,
        message,
      )
    }
  }

  return summary
}
