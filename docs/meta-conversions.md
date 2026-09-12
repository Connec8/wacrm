# Meta conversions for Click to WhatsApp ads

wacrm can report ad-driven conversions back to Meta through the
[Conversions API for Business Messaging](https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging),
so a Click to WhatsApp campaign can optimise for leads and purchases
instead of conversations started.

## What gets sent

| wacrm action | Meta event | Payload extras |
|---|---|---|
| A deal is created for a contact | `LeadSubmitted` | — |
| A deal is marked **won** (first time only) | `Purchase` | `custom_data.value`, `custom_data.currency` |

Only contacts whose chat started from a Click to WhatsApp ad produce
events: the webhook stores Meta's `referral` object on the inbound
message (migration 040) and the event carries its `ctwa_clid`. Organic
chats, and WhatsApp Status ad placements (Meta omits `ctwa_clid` there),
produce nothing.

Every event is sent with `action_source: "business_messaging"`,
`messaging_channel: "whatsapp"` and
`user_data: { whatsapp_business_account_id, ctwa_clid }`.

## How it works

1. A trigger on `deals` (migration 041) writes a row to
   `meta_conversion_events`. It works no matter where the deal changed —
   the pipeline board, an automation, or the public API.
2. A dispatcher sends pending rows to `POST /{dataset_id}/events`. It
   runs after every inbound WhatsApp webhook, and from
   `GET /api/meta/conversions/cron`.
3. The dataset is created (or fetched — Meta returns the existing one)
   with `POST /{waba_id}/dataset` on first send and cached in
   `whatsapp_config.meta_dataset_id`.

Meta does **not** deduplicate business-messaging events. wacrm allows one
`LeadSubmitted` and one `Purchase` per deal, so reopening and re-winning a
deal is not counted twice. Failed sends retry up to 5 times, 5 minutes
apart. Events older than 7 days are marked `expired`, because Meta
rejects the whole request if any `event_time` is that old.

## Setup

1. **Apply migrations 040 and 041** before deploying this code.
2. **Token permission.** Generate the system-user token with
   `whatsapp_business_manage_events` in addition to
   `whatsapp_business_messaging` and `whatsapp_business_management`, and
   save it in Settings → WhatsApp. Direct developers using their own
   business's assets don't need App Review for this.
3. **Currency.** `Purchase` uses the deal's currency, falling back to the
   account default. Both default to USD — set them to what you actually
   charge in.
4. **Turn it on** for the account:

   ```sql
   UPDATE whatsapp_config
   SET meta_conversions_enabled = TRUE
   WHERE waba_id = '<YOUR_WABA_ID>';
   ```

5. **Schedule the cron** (optional on a busy number, recommended
   otherwise):

   ```bash
   curl -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
     https://<your-host>/api/meta/conversions/cron
   ```

## Testing

Set `META_CONVERSIONS_TEST_EVENT_CODE` to the code from Events Manager →
your dataset → Test events. Events then show up in the Test events tab.
Remove the variable for production — test events are still used for
measurement.

Check what was reported:

```sql
SELECT event_name, status, attempts, last_error, sent_at
FROM meta_conversion_events
ORDER BY created_at DESC
LIMIT 20;
```
