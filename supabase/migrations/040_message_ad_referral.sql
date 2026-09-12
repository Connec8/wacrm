-- ============================================================
-- 040_message_ad_referral
--
-- Click-to-WhatsApp ad attribution. When a customer taps a Click to
-- WhatsApp ad, Meta attaches a `referral` object to the first inbound
-- message of that chat: the ad id (`source_id`), the ad URL, headline,
-- body, media, and `ctwa_clid` — the click id the Conversions API needs
-- to report a lead or purchase back against the ad. The webhook used to
-- drop it, so an ad-driven chat was indistinguishable from an organic
-- one and the click id was unrecoverable (Meta has no API to fetch it
-- afterwards).
--
-- Stored as the raw JSON Meta sent rather than as split-out columns:
-- Meta has added fields to this object over time (`ctwa_clid`,
-- `welcome_message`, `media_type`), and it omits `ctwa_clid` entirely
-- for WhatsApp Status placements, so a fixed column set would either
-- lose data or carry permanently-null columns.
--
-- NO BACKFILL IS POSSIBLE. Referrals on messages received before this
-- migration were never persisted.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS referral JSONB;

COMMENT ON COLUMN messages.referral IS
  'Meta''s `referral` object, verbatim, when this inbound message came '
  'from a Click to WhatsApp ad (source_id = ad id, ctwa_clid = click id '
  'for the Conversions API). NULL for every other message and for rows '
  'written before migration 040.';

-- Ad-attributed messages are a tiny fraction of all messages; a partial
-- index keeps "which chats came from ad X" cheap without indexing the
-- rest of the table.
CREATE INDEX IF NOT EXISTS messages_referral_source_id_idx
  ON messages ((referral->>'source_id'))
  WHERE referral IS NOT NULL;

-- "Latest ad click in this conversation" — what migration 041's
-- conversion trigger looks up whenever a deal is created or won.
CREATE INDEX IF NOT EXISTS messages_referral_clid_lookup_idx
  ON messages (conversation_id, created_at DESC)
  WHERE referral ? 'ctwa_clid';
