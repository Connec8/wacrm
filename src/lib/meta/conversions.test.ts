import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
}))

import {
  MAX_ATTEMPTS,
  MAX_EVENT_AGE_MS,
  buildConversionEvent,
  dispatchPendingConversions,
  ensureDatasetId,
  isExpired,
  sendConversionEvents,
  type ConversionEventRow,
} from './conversions'

const NOW = new Date('2026-09-13T12:00:00.000Z')

function row(overrides: Partial<ConversionEventRow> = {}): ConversionEventRow {
  return {
    id: 'evt-1',
    account_id: 'acc-1',
    deal_id: 'deal-1',
    event_name: 'Purchase',
    ctwa_clid: 'Aff-clid',
    value: '1500.00',
    currency: 'inr',
    event_time: '2026-09-13T11:00:00.000Z',
    attempts: 0,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('buildConversionEvent', () => {
  it('shapes a Purchase as Meta documents the business-messaging event', () => {
    expect(buildConversionEvent(row(), 'waba-1')).toEqual({
      event_name: 'Purchase',
      event_time: Math.floor(Date.parse('2026-09-13T11:00:00.000Z') / 1000),
      event_id: 'evt-1',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: 'waba-1', ctwa_clid: 'Aff-clid' },
      custom_data: { currency: 'INR', value: 1500 },
    })
  })

  it('sends no custom_data for LeadSubmitted', () => {
    const event = buildConversionEvent(row({ event_name: 'LeadSubmitted' }), 'waba-1')
    expect(event).not.toHaveProperty('custom_data')
  })

  it('refuses a Purchase without a currency', () => {
    expect(() => buildConversionEvent(row({ currency: null }), 'waba-1')).toThrow(/currency/)
  })
})

describe('isExpired', () => {
  it('keeps events inside the 7-day window and drops older ones', () => {
    const fresh = new Date(NOW.getTime() - MAX_EVENT_AGE_MS + 1000).toISOString()
    const stale = new Date(NOW.getTime() - MAX_EVENT_AGE_MS - 1000).toISOString()
    expect(isExpired(fresh, NOW)).toBe(false)
    expect(isExpired(stale, NOW)).toBe(true)
  })
})

describe('Meta calls', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts events to the dataset, with the test code when given', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ events_received: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    const event = buildConversionEvent(row(), 'waba-1')
    await sendConversionEvents({
      datasetId: 'ds-1',
      accessToken: 'tok',
      events: [event],
      testEventCode: 'TEST123',
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/ds-1\/events$/)
    expect(JSON.parse(init.body as string)).toEqual({
      data: [event],
      test_event_code: 'TEST123',
    })
  })

  it("surfaces Meta's error code", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { message: 'Invalid parameter', code: 100, error_subcode: 2804 } }, 400),
      ),
    )
    await expect(
      sendConversionEvents({ datasetId: 'ds-1', accessToken: 'tok', events: [] }),
    ).rejects.toMatchObject({ message: 'Invalid parameter', code: 100, subcode: 2804 })
  })

  it('creates or fetches the dataset for a WABA', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'ds-9' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(ensureDatasetId({ wabaId: 'waba-1', accessToken: 'tok' })).resolves.toBe('ds-9')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/waba-1\/dataset$/)
    expect(init.method).toBe('POST')
  })
})

// ---------------------------------------------------------------------------
// dispatchPendingConversions against a minimal PostgREST-shaped fake.
// ---------------------------------------------------------------------------

interface FakeState {
  rows: ConversionEventRow[]
  config: Record<string, unknown> | null
  claimSucceeds: boolean
}

interface Update {
  table: string
  patch: Record<string, unknown>
  filters: [string, unknown][]
}

function fakeDb(state: FakeState) {
  const updates: Update[] = []

  function from(table: string) {
    const q = {
      op: 'select' as 'select' | 'update',
      patch: {} as Record<string, unknown>,
      filters: [] as [string, unknown][],
    }
    const result = () => {
      if (q.op === 'update') {
        updates.push({ table, patch: q.patch, filters: q.filters })
        const isClaim = 'attempts' in q.patch && !('status' in q.patch)
        if (isClaim) {
          return { data: state.claimSucceeds ? [{ id: 'evt-1' }] : [], error: null }
        }
        return { data: null, error: null }
      }
      if (table === 'meta_conversion_events') return { data: state.rows, error: null }
      return { data: state.config, error: null }
    }
    const builder = {
      select: () => builder,
      update: (patch: Record<string, unknown>) => {
        q.op = 'update'
        q.patch = patch
        return builder
      },
      eq: (col: string, val: unknown) => {
        q.filters.push([col, val])
        return builder
      },
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve(result()),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    }
    return builder
  }

  return { db: { from } as unknown as SupabaseClient, updates }
}

const ENABLED_CONFIG = {
  waba_id: 'waba-1',
  access_token: 'enc',
  meta_dataset_id: 'ds-1',
  meta_conversions_enabled: true,
}

function eventUpdates(updates: Update[]) {
  return updates.filter((u) => u.table === 'meta_conversion_events').map((u) => u.patch)
}

describe('dispatchPendingConversions', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ events_received: 1 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('claims, sends and marks a pending event sent', async () => {
    const { db, updates } = fakeDb({ rows: [row()], config: ENABLED_CONFIG, claimSucceeds: true })

    const summary = await dispatchPendingConversions(db, { now: NOW, testEventCode: '' })

    expect(summary.sent).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const patches = eventUpdates(updates)
    expect(patches[0]).toMatchObject({ attempts: 1 })
    expect(patches[1]).toMatchObject({ status: 'sent', last_error: null })
  })

  it('creates the dataset on first use and caches it on the config', async () => {
    fetchMock
      .mockImplementationOnce(async () => jsonResponse({ id: 'ds-new' }))
      .mockImplementationOnce(async () => jsonResponse({ events_received: 1 }))
    const { db, updates } = fakeDb({
      rows: [row()],
      config: { ...ENABLED_CONFIG, meta_dataset_id: null },
      claimSucceeds: true,
    })

    await dispatchPendingConversions(db, { now: NOW, testEventCode: '' })

    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toMatch(/\/ds-new\/events$/)
    expect(updates).toContainEqual(
      expect.objectContaining({ table: 'whatsapp_config', patch: { meta_dataset_id: 'ds-new' } }),
    )
  })

  it('expires events Meta would reject, without calling Meta', async () => {
    const stale = new Date(NOW.getTime() - MAX_EVENT_AGE_MS - 60_000).toISOString()
    const { db, updates } = fakeDb({
      rows: [row({ event_time: stale })],
      config: ENABLED_CONFIG,
      claimSucceeds: true,
    })

    const summary = await dispatchPendingConversions(db, { now: NOW, testEventCode: '' })

    expect(summary.expired).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(eventUpdates(updates)[0]).toMatchObject({ status: 'expired' })
  })

  it('fails events for accounts that have turned conversions off', async () => {
    const { db, updates } = fakeDb({
      rows: [row()],
      config: { ...ENABLED_CONFIG, meta_conversions_enabled: false },
      claimSucceeds: true,
    })

    await dispatchPendingConversions(db, { now: NOW, testEventCode: '' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(eventUpdates(updates)[0]).toMatchObject({ status: 'failed' })
  })

  it('does not send when another dispatcher already claimed the row', async () => {
    const { db } = fakeDb({ rows: [row()], config: ENABLED_CONFIG, claimSucceeds: false })

    const summary = await dispatchPendingConversions(db, { now: NOW, testEventCode: '' })

    expect(summary.skipped).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps a failed send pending for retry, then gives up at the attempt cap', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: { message: 'temporarily unavailable', code: 2 } }, 500),
    )

    const first = fakeDb({ rows: [row({ attempts: 0 })], config: ENABLED_CONFIG, claimSucceeds: true })
    const retrying = await dispatchPendingConversions(first.db, { now: NOW, testEventCode: '' })
    expect(retrying.retrying).toBe(1)
    expect(eventUpdates(first.updates)[1]).toMatchObject({
      status: 'pending',
      last_error: 'temporarily unavailable',
    })

    const last = fakeDb({
      rows: [row({ attempts: MAX_ATTEMPTS - 1 })],
      config: ENABLED_CONFIG,
      claimSucceeds: true,
    })
    const exhausted = await dispatchPendingConversions(last.db, { now: NOW, testEventCode: '' })
    expect(exhausted.failed).toBe(1)
    expect(eventUpdates(last.updates)[1]).toMatchObject({ status: 'failed' })
  })
})
