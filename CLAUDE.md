# Web Funnel Screenshot Crawler

## Tech Stack
- Node.js (ES modules) on Node >= 20
- Apify SDK (`apify`) + Crawlee (`crawlee`) with PlaywrightCrawler
- Playwright (Chromium)
- Anthropic SDK (`@anthropic-ai/sdk`) — Claude Haiku for page analysis

## What It Does
Crawls any multi-step web funnel or website (quizzes, e-shops, SaaS signups, landing pages, info sites) using LLM-driven page analysis. Each page state is analyzed by Claude Haiku which returns an ordered list of actions. The crawler screenshots every meaningful state and maps all possible paths.

## Architecture — Adaptive Prompt Selection + Direct URL Branching

### Per-page prompt selection
Three focused LLM prompts selected by heuristic (no extra API call):
- **`LANDING_PROMPT`** — For pages with 3+ links, few form fields. Emphasizes branch actions using `<a>` tags from the snapshot's `links` section for reliable direct navigation.
- **`FUNNEL_PROMPT`** — For pages with 2+ form fields, radio buttons, or option-like buttons. Advance-first strategy, fills forms with test data.
- **`CHECKOUT_PROMPT`** — For pages with payment keywords (credit card, Stripe, PayPal). Confirms terminal state.

Selection heuristic in `selectPrompt(snapshot)`: checkout keywords → form fields ≥ 2 → radio/option buttons → links ≥ 3 → default funnel.

### Three-tier branch resolution
Every branch gets a direct URL via `resolveBranchUrl()`:
1. **DOM href** — Check element/parent/child for `<a href>` (fast, no side effects)
2. **Link text match** — Bidirectional text match against snapshot `links` array
3. **Click-and-capture** — Click element, capture URL change, navigate back

All branches use `directUrl` — no session replay needed.

### Crawl loop
1. Navigate to URL (directUrl for branches, goto for seed)
2. Trigger lazy content (scroll to fire IntersectionObservers, scroll back)
3. Extract simplified HTML snapshot (headings, body text, interactive elements, forms, links)
4. Send snapshot to Claude Haiku via tool_use for structured analysis
5. LLM returns `{ pageType, actions: [...], isTerminal, reasoning }` where each action has a `kind`:
   - **`branch`** → mutually exclusive choices (2-6 options). Resolve URLs, enqueue each as separate request
   - **`advance`** → linear forward click (CTA, continue, buy now). Execute, check content changed, re-analyze
   - **`fill`** → form field (text, select, checkbox, consent toggle). Execute all fills, then process advance/branch
   - **`isTerminal`** → nothing left to click (order confirmation, thank you, payment form). Screenshot and stop
6. Content change detection via SHA-256 hash + structural snapshot diff
7. Cycle detection via `localSeenHashes` per request + `globalVisitedUrls` across requests

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
src/main.js              — Entry point, request handler, branch resolution, analysis loop
src/llm.js               — Anthropic client, three focused prompts, selectPrompt(), analyzePage (tool_use)
src/page-utils.js         — HTML extraction, content hashing, snapshot diff, form filling, screenshots
.actor/actor.json        — Actor metadata
.actor/input_schema.json — Input schema definition
Dockerfile               — Production build
```

## Key Design Decisions
- `maxConcurrency: 1` — sequential execution to keep memory low
- Direct URL navigation for all branches — no session replay
- Three focused prompts instead of one monolithic prompt — better LLM accuracy per page type
- `resolveBranchUrl()` three-tier resolution — DOM href → link text match → click-and-capture
- Content change detection: `hashPageContent()` for cycle detection, `snapshotDiff()` for structural change after advances
- `globalVisitedUrls` checked during branch enqueue AND in request handler (safety net for redirects)
- `enqueueBranches()` deduplicated helper — single function for both main and re-analysis paths
- Analysis loop extracted into named functions: `handleNoActions()`, `handleAdvances()`, `maybeScreenshot()`
- Cost: ~$0.002-0.003/page with Haiku, ~$0.10-0.15 for a 50-page funnel
