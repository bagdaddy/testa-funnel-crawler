# Quiz Funnel Screenshot Crawler

## Tech Stack
- Node.js (ES modules) on Node >= 20
- Apify SDK (`apify`) + Crawlee (`crawlee`) with PlaywrightCrawler
- Playwright (Chromium)
- Anthropic SDK (`@anthropic-ai/sdk`) — Claude Haiku for page analysis

## What It Does
Crawls ecommerce quiz funnels using LLM-driven page analysis. Instead of hardcoded button detection and regex exclusion lists, each page state is analyzed by Claude Haiku which classifies the page type (quiz choices, form, navigation, end-of-funnel, or other) and decides what actions to take. The crawler only screenshots when page content actually changes, fills forms with realistic test data, and maps all possible paths through quiz funnels.

## Architecture
1. Navigate to `startUrl`, replay any saved actions to reach current state
2. Extract simplified HTML snapshot (headings, body text, interactive elements, forms)
3. Send snapshot to Claude Haiku via tool_use for structured classification
4. Based on page type:
   - **quiz_choices** → screenshot, enqueue one child state per choice option
   - **form** → fill fields with LLM-suggested values, submit, continue if content changed
   - **navigation** → click advance button, continue if content changed
   - **end_of_funnel** → screenshot, stop
   - **other** → screenshot, stop
5. Content change detection via SHA-256 hash of URL + body text

## How to Run
```bash
# Install
npm install

# Run locally (requires APIFY_TOKEN or local emulation + ANTHROPIC_API_KEY)
apify run --input '{"startUrl": "https://example.com/quiz", "anthropicApiKey": "sk-ant-..."}'

# Or directly
echo '{"startUrl": "https://example.com/quiz"}' > ./storage/key_value_stores/default/INPUT.json
export ANTHROPIC_API_KEY=sk-ant-...
node src/main.js

# Deploy to Apify
apify push
```

## Project Structure
```
src/main.js              — Entry point, request handler with LLM analysis loop
src/llm.js               — Anthropic client, system prompt, analyzePage (tool_use)
src/page-utils.js         — HTML extraction, content hashing, form filling, screenshots
.actor/actor.json        — Actor metadata
.actor/input_schema.json — Input schema definition
Dockerfile               — Production build
```

## Key Design Decisions
- `maxConcurrency: 1` — sequential execution to keep memory low
- Each state replays actions from scratch (stateless per request)
- LLM classifies pages instead of hardcoded regex lists
- Content change detection: only screenshot when `hashPageContent()` changes
- Cycle detection via `seenHashes` set prevents infinite loops
- Actions support both `click` and `fill_and_submit` types
- Deduplication via action fingerprint as Crawlee request uniqueKey
- Cost: ~$0.002-0.003/page with Haiku, ~$0.10-0.15 for a 50-page funnel
