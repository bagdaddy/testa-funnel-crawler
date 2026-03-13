# Quiz Funnel Crawler — Webhook Integration Guide

## Overview

The crawler POSTs a JSON payload to your endpoint when a crawl run finishes. The webhook fires once per run, after all funnel paths have been explored, and contains every screenshot captured during the run.

## Triggering a Crawl Run

### Via Apify API

```bash
curl -X POST "https://api.apify.com/v2/acts/<ACTOR_ID>/runs" \
  -H "Authorization: Bearer <APIFY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "startUrl": "https://example.com/quiz",
    "runId": "your-correlation-id-123",
    "webhookUrl": "https://your-service.com/api/crawler-webhook",
    "anthropicApiKey": "sk-ant-..."
  }'
```

### Via direct execution (local / Docker)

```bash
cat > ./storage/key_value_stores/default/INPUT.json << 'EOF'
{
  "startUrl": "https://example.com/quiz",
  "runId": "your-correlation-id-123",
  "webhookUrl": "https://your-service.com/api/crawler-webhook"
}
EOF

export ANTHROPIC_API_KEY=sk-ant-...
node src/main.js
```

### Via environment variables (alternative)

All three integration fields can be set via env vars instead of input JSON. Input values take priority over env vars.

| Input field      | Env var fallback     | Required |
|------------------|----------------------|----------|
| `webhookUrl`     | `WEBHOOK_URL`        | No — if absent, webhook is silently skipped |
| `runId`          | `RUN_ID`             | No — auto-generates a UUID v4 if absent |
| `anthropicApiKey`| `ANTHROPIC_API_KEY`  | Yes (one of the two must be set) |

## Input Schema

Only `startUrl` is required. All other fields are optional with sensible defaults.

| Field             | Type    | Default | Description |
|-------------------|---------|---------|-------------|
| `startUrl`        | string  | —       | **(required)** First page of the quiz funnel |
| `runId`           | string  | UUID v4 | Correlation ID echoed back in webhook payload |
| `webhookUrl`      | string  | —       | Your endpoint; skipped if not set |
| `anthropicApiKey` | string  | —       | Claude API key (or use env var) |
| `maxDepth`        | integer | `20`    | Max click steps per path (1–100) |
| `maxBranches`     | integer | `5`     | Max options to explore per page (1–20) |
| `waitAfterClick`  | integer | `1000`  | Post-click settle time in ms (100–10000) |
| `viewportWidth`   | integer | `390`   | Browser width in px (320–1920) |
| `viewportHeight`  | integer | `844`   | Browser height in px (480–1080) |

## Webhook Request

### HTTP Details

- **Method:** `POST`
- **Content-Type:** `application/json`
- **Timing:** Fires once, after `crawler.run()` completes and all paths are explored
- **Condition:** Only fires if `webhookUrl` is set AND at least one screenshot was captured. If the crawl produces zero screenshots, no webhook is sent.

### Payload Schema

```json
{
  "runId": "your-correlation-id-123",
  "startUrl": "https://example.com/quiz",
  "screenshots": [
    {
      "screenshot_url": "https://api.apify.com/v2/key-value-stores/<STORE_ID>/records/screenshot_depth0_<HASH>_<TS>",
      "page_url": "https://example.com/quiz"
    },
    {
      "screenshot_url": "https://api.apify.com/v2/key-value-stores/<STORE_ID>/records/screenshot_depth1_<HASH>_<TS>",
      "page_url": "https://example.com/quiz?step=2"
    }
  ],
  "count": 2,
  "timestamp": "2026-03-08T14:30:00.000Z"
}
```

### Field Reference

| Field                           | Type   | Description |
|---------------------------------|--------|-------------|
| `runId`                         | string | The correlation ID you provided, or the auto-generated UUID |
| `startUrl`                      | string | The funnel entry URL that was crawled |
| `screenshots`                   | array  | All screenshots captured during the run |
| `screenshots[].screenshot_url`  | string | Public URL to the JPEG screenshot in Apify KV store |
| `screenshots[].page_url`        | string | The page URL at the time the screenshot was taken |
| `count`                         | number | Length of the `screenshots` array (convenience field) |
| `timestamp`                     | string | ISO 8601 timestamp of when the webhook was sent |

### Screenshot URLs

Each `screenshot_url` is a public Apify KV store URL with the pattern:
```
https://api.apify.com/v2/key-value-stores/{storeId}/records/screenshot_depth{N}_{hash}_{unixMs}
```
- Returns `image/jpeg` content directly (no auth needed for public stores)
- Full-page screenshots at the configured viewport size (default: 390x844 mobile)
- JPEG quality auto-adjusts to stay under 1 MB per image

## Your Webhook Endpoint Requirements

Your endpoint should:

1. **Accept POST** with `Content-Type: application/json`
2. **Return 2xx** to acknowledge receipt
3. **Respond within 30 seconds** (Node `fetch` default timeout)
4. **Use `runId`** to match the webhook to the originating crawl request

### Minimal Express handler example

```javascript
app.post('/api/crawler-webhook', (req, res) => {
  const { runId, startUrl, screenshots, count, timestamp } = req.body;

  // Match to your pending crawl job
  console.log(`Crawl ${runId} finished: ${count} screenshots from ${startUrl}`);

  // Process screenshots
  for (const { screenshot_url, page_url } of screenshots) {
    // Download, store, analyze, etc.
  }

  res.sendStatus(200);
});
```

## Error Handling

- **Webhook failure never fails the crawl.** If your endpoint is down, returns an error, or times out, the crawler logs the error and exits successfully. Screenshot data is still available in the Apify dataset/KV store.
- **No retries.** The webhook fires exactly once. If you need guaranteed delivery, poll the Apify dataset as a fallback.
- **No webhook on zero screenshots.** If the crawl captures nothing (e.g., start URL is unreachable), no webhook is sent.

## Typical Integration Flow

```
Your Service                          Crawler
    |                                    |
    |-- POST /runs {startUrl, runId, webhookUrl} -->|
    |                                    |
    |   (crawler explores all paths,     |
    |    screenshots each step)          |
    |                                    |
    |<-- POST /webhook {runId, screenshots} --------|
    |                                    |
    |   Process screenshots              |
```
