-- ============================================================
-- 041_meta_conversions
--
-- Report Click-to-WhatsApp ad conversions back to Meta through the
-- Conversions API for Business Messaging, so campaigns can optimise
-- for leads and purchases instead of just conversations started.
--
-- The conversion signal is the pipeline:
--
--   * a deal is CREATED for a contact     -> LeadSubmitted
--   * a deal is first marked WON          -> Purchase (deal value + currency)
--
-- and only when that contact's chat carries a ctwa_clid (migration
-- 040 stores the referral). Organic chats and WhatsApp Status ad
-- placements (which omit ctwa_clid) produce nothing.
--
-- Why a trigger + outbox rather than code at each call site: deals
-- change from the browser (deal-form writes straight to Supabase under
-- RLS), from the automations engine, and from the public API. A trigger
-- catches all three, and the outbox lets a server-side dispatcher hold
-- the Meta token, retry, and dedupe. Meta does NOT deduplicate business
-- messaging events, so the UNIQUE (deal_id, event_name) constraint is
-- the only thing stopping a reopened-and-rewon deal from counting twice.
--
-- Opt-in per account: nothing is queued until
-- whatsapp_config.meta_conversions_enabled is set.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. whatsapp_config: opt-in flag + cached dataset id
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS meta_conversions_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS meta_dataset_id TEXT;

COMMENT ON COLUMN whatsapp_config.meta_conversions_enabled IS
  'When true, deals created/won for contacts who arrived from a Click to '
  'WhatsApp ad are reported to Meta via the Conversions API.';
COMMENT ON COLUMN whatsapp_config.meta_dataset_id IS
  'Dataset linked to this WABA (POST /{waba_id}/dataset). Filled in by the '
  'dispatcher on first send.';

-- ============================================================
-- 2. Outbox
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_conversion_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id         UUID REFERENCES deals(id) ON DELETE SET NULL,
  contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  event_name      TEXT NOT NULL CHECK (event_name IN ('LeadSubmitted', 'Purchase')),
  ctwa_clid       TEXT NOT NULL,
  value           NUMERIC(12,2),
  currency        TEXT,
  event_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed', 'expired')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  meta_response   JSONB,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_conversion_events_deal_event_key UNIQUE (deal_id, event_name)
);

CREATE INDEX IF NOT EXISTS meta_conversion_events_pending_idx
  ON meta_conversion_events (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS meta_conversion_events_account_idx
  ON meta_conversion_events (account_id, created_at DESC);

-- Members can see what was reported for their account. There are no
-- write policies: only the trigger (SECURITY DEFINER) and the
-- service-role dispatcher write here.
ALTER TABLE meta_conversion_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_conversion_events_select ON meta_conversion_events;
CREATE POLICY meta_conversion_events_select ON meta_conversion_events
  FOR SELECT USING (is_account_member(account_id));

-- ============================================================
-- 3. Trigger: queue events from deal changes
-- ============================================================
CREATE OR REPLACE FUNCTION public.queue_meta_conversion_from_deal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clid     TEXT;
  v_currency TEXT;
  v_won      BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM whatsapp_config
    WHERE account_id = NEW.account_id
      AND meta_conversions_enabled
  ) THEN
    RETURN NEW;
  END IF;

  -- Most recent ad click for this contact. Conversations are one per
  -- contact per account (migration 036), so the contact is the key.
  SELECT m.referral->>'ctwa_clid'
    INTO v_clid
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE c.account_id = NEW.account_id
    AND c.contact_id = NEW.contact_id
    AND m.referral ? 'ctwa_clid'
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF v_clid IS NULL OR v_clid = '' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO meta_conversion_events
      (account_id, deal_id, contact_id, event_name, ctwa_clid, event_time)
    VALUES
      (NEW.account_id, NEW.id, NEW.contact_id, 'LeadSubmitted', v_clid,
       COALESCE(NEW.created_at, NOW()))
    ON CONFLICT (deal_id, event_name) DO NOTHING;
  END IF;

  -- OLD is unassigned on INSERT, so the transition test is split
  -- rather than folded into one boolean expression.
  IF TG_OP = 'INSERT' THEN
    v_won := NEW.status = 'won';
  ELSE
    v_won := NEW.status = 'won' AND OLD.status IS DISTINCT FROM 'won';
  END IF;

  IF v_won THEN
    SELECT UPPER(COALESCE(NULLIF(NEW.currency, ''), a.default_currency))
      INTO v_currency
    FROM accounts a
    WHERE a.id = NEW.account_id;

    INSERT INTO meta_conversion_events
      (account_id, deal_id, contact_id, event_name, ctwa_clid, value, currency, event_time)
    VALUES
      (NEW.account_id, NEW.id, NEW.contact_id, 'Purchase', v_clid,
       NEW.value, COALESCE(v_currency, UPPER(NEW.currency)), NOW())
    ON CONFLICT (deal_id, event_name) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Reporting must never block a deal save.
  RAISE WARNING 'queue_meta_conversion_from_deal failed for deal %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_queue_meta_conversion ON deals;
CREATE TRIGGER deals_queue_meta_conversion
  AFTER INSERT OR UPDATE OF status ON deals
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_meta_conversion_from_deal();
