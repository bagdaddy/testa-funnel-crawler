# Quiz Funnel Screenshot Crawler

## Tech Stack
- Node.js (ES modules) on Node >= 20
- Apify SDK (`apify`) + Crawlee (`crawlee`) with PlaywrightCrawler
- Playwright (Chromium)

## What It Does
Crawls ecommerce quiz funnels by replaying click sequences from the start URL, screenshotting every step, and mapping all possible paths through the funnel. Each "request" in Crawlee's queue represents a funnel state (a sequence of clicks). The handler navigates to `startUrl`, replays clicks, screenshots, detects new clickable options, and enqueues child states.

## How to Run
```bash
# Install
npm install

# Run locally (requires APIFY_TOKEN or local emulation)
apify run --input '{"startUrl": "https://example.com/quiz"}'

# Or directly
echo '{"startUrl": "https://example.com/quiz"}' > ./storage/key_value_stores/default/INPUT.json
node src/main.js

# Deploy to Apify
apify push
```

## Project Structure
```
src/main.js              — Core actor logic (entry point)
.actor/actor.json        — Actor metadata
.actor/input_schema.json — Input schema definition
Dockerfile               — Production build
```

## Key Design Decisions
- `maxConcurrency: 1` — sequential execution to keep memory low
- Each state replays clicks from scratch (stateless per request)
- Navigation buttons (Next/Continue) are auto-clicked without branching
- Deduplication via path fingerprint as Crawlee request uniqueKey
