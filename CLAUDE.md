# Web Funnel Screenshot Crawler

## Tech Stack
- Node.js (ES modules) on Node >= 20
- Apify SDK (`apify`) + Crawlee (`crawlee`) with PlaywrightCrawler
- Playwright (Chromium)
- Anthropic SDK (`@anthropic-ai/sdk`) — Claude Haiku 4.5 for page analysis

## What It Does
Crawls any multi-step web funnel or website (quizzes, e-shops, SaaS signups, landing pages, info sites) using LLM-driven page analysis. Each page state is analyzed by Claude Haiku which returns structured actions via `tool_use`. The crawler screenshots every meaningful state, maps all possible paths, and POSTs results to an optional webhook.

## Architecture — Adaptive Prompt Selection + Direct URL Branching

### Per-page prompt selection
Three focused LLM prompts selected by heuristic in `selectPrompt(snapshot)` (no extra API call):
- **`LANDING_PROMPT`** — For pages with 3+ links, few form fields. Emphasizes branch actions using `<a>` tags from the snapshot's `links` section for reliable direct navigation.
- **`FUNNEL_PROMPT`** — For pages with 2+ form fields, radio buttons, or option-like buttons. Advance-first strategy, fills forms with test data.
- **`CHECKOUT_PROMPT`** — For pages with payment keywords (credit card, Stripe, PayPal). Confirms terminal state.

Selection heuristic priority: checkout keywords → form fields >= 2 → radio >= 3 / option buttons 3-8 → links >= 3 → default funnel.

### Three-tier branch resolution
Every branch gets a direct URL via `resolveBranchUrl()`:
1. **DOM href** — Check element/parent/child for `<a href>` (fast, no side effects)
2. **Link text match** — Bidirectional text match against snapshot `links` array via `matchLinkText()`
3. **Click-and-capture** — Click element, capture URL change, navigate back

All branches use `directUrl` — no session replay needed.

### Crawl loop
1. Navigate to URL (directUrl for branches, goto for seed)
2. Trigger lazy content via `triggerAnimations()` (scroll to fire IntersectionObservers, scroll back)
3. Extract simplified HTML snapshot (headings, body text, up to 40 interactive elements, up to 5 forms, up to 15 same-origin links)
4. Send snapshot to Claude Haiku via `tool_use` for structured analysis
5. LLM returns `{ pageType, actions: [...], isTerminal, reasoning }` where each action has a `kind`:
   - **`branch`** — mutually exclusive choices (up to maxBranches). Resolve URLs, enqueue each as separate request
   - **`advance`** — linear forward click (CTA, continue, buy now). Execute, check content changed, re-analyze
   - **`fill`** — form field (text, select, checkbox, consent toggle). Execute all fills, then process advance/branch
   - **`isTerminal`** — nothing left to click (order confirmation, thank you, payment form). Screenshot and stop
6. Content change detection via SHA-256 hash of URL+innerText (`hashPageContent`) + structural snapshot diff (`snapshotDiff`)
7. Cycle detection via `localSeenHashes` per request + `globalVisitedUrls` across requests
8. Re-consult LLM up to 2 times when advances don't produce visible changes, with `actionContext` describing what failed
9. Webhook POST at end of run with all collected `{ screenshot_url, page_url }` pairs

### Analysis cache
In-memory cache keyed on `headings + bodyText prefix (300 chars) + sorted element labels`. Avoids redundant LLM calls for identical page states. Cache is bypassed via `skipCache` after re-consults and when `forceSkipCache` is set.

## How to Run
```bash
# Install
npm install

# Run locally
echo '{"startUrl": "https://example.com/quiz", "anthropicApiKey": "sk-ant-..."}' > ./storage/key_value_stores/default/INPUT.json
node src/main.js

# Or via Apify CLI
apify run --input '{"startUrl": "https://example.com/quiz", "anthropicApiKey": "sk-ant-..."}'

# Deploy to Apify
apify push
```

## Input Parameters
| Parameter | Default | Description |
|-----------|---------|-------------|
| `startUrl` | (required) | URL to begin crawling |
| `maxDepth` | 20 | Max click steps before stopping a path |
| `maxBranches` | 6 (code) / 5 (schema) | Max branch options to follow per page |
| `waitAfterClick` | 1000ms | Delay after clicks before next action |
| `viewportWidth` | 1440 (code) / 390 (schema) | Browser viewport width |
| `viewportHeight` | 1080 (code) / 844 (schema) | Browser viewport height |
| `anthropicApiKey` | env `ANTHROPIC_API_KEY` | Anthropic API key |
| `webhookUrl` | env `WEBHOOK_URL` | URL to POST results when run finishes |
| `webhookSecret` | env `WEBHOOK_SECRET` | Sent as `X-Webhook-Secret` header |
| `runId` | auto UUID | Echoed in webhook payload for correlation |

## Project Structure
```
src/main.js              — Entry point, request handler, branch resolution, analysis loop
src/llm.js               — Anthropic client, three prompts, selectPrompt(), analyzePage()
src/page-utils.js        — HTML extraction, content hashing, snapshot diff, screenshots
.actor/actor.json        — Actor metadata (4GB memory, 1h timeout)
.actor/input_schema.json — Input schema definition
Dockerfile               — Production build
```

## Key Design Decisions
- `maxConcurrency: 1` — sequential execution to keep memory low and avoid race conditions on global state
- Direct URL navigation for all branches — no session replay
- Three focused prompts instead of one monolithic prompt — better LLM accuracy per page type
- `resolveBranchUrl()` three-tier resolution — DOM href → link text match → click-and-capture
- Content change detection: `hashPageContent()` for cycle detection, `snapshotDiff()` for structural change after advances
- `globalVisitedUrls` checked during branch enqueue AND in request handler (safety net for redirects)
- `enqueueBranches()` deduplicated helper — single function for both main and re-analysis paths
- Analysis loop extracted into named functions: `handleNoActions()`, `handleAdvances()`, `maybeScreenshot()`
- LLM retry with exponential backoff on 429/529 (up to 5 retries, max 60s delay)
- Screenshot quality auto-reduces from 85 to 30 JPEG quality to stay under 10MB limit
- Cost: ~$0.002-0.003/page with Haiku, ~$0.10-0.15 for a 50-page funnel

## Known Shortcomings & Future Fixes

### Input schema / code defaults mismatch
- `maxBranches` defaults to 6 in code but 5 in `input_schema.json`
- `viewportWidth/Height` defaults to 1440x1080 in code but 390x844 (mobile) in schema
- Need to align one direction or the other

### selectPrompt() heuristic is too aggressive on funnel detection
- `optionLikeCount >= 3` triggers funnel prompt on landing pages that have product buttons (e.g. bioma.health landing page has product cards that look like option buttons)
- Funnel prompt tells the LLM to advance rather than branch, so the crawler dives into one path instead of exploring all products
- Needs a more nuanced heuristic — possibly checking link count alongside button count, or looking at button text patterns

### No cross-origin branch following
- `extractPageSnapshot()` only collects same-origin links (`href.startsWith(currentOrigin)`)
- Sites that link to subdomains or external product pages (e.g. `shop.example.com` from `www.example.com`) are invisible to branching
- Should optionally allow cross-origin links within a configured domain list

### No iframe support
- Content inside iframes (common for embedded forms, payment widgets, Typeform quizzes) is not extracted in the snapshot
- The LLM never sees iframe content and can't interact with it

### No authentication support
- Cannot crawl pages behind login walls
- No cookie injection or auth token support
- Would need a pre-auth step or cookie/session input parameter

### Global mutable state
- `globalSeenHashes`, `globalVisitedUrls`, `collectedScreenshots`, `screenshotCounter`, `screenshotsPerUrl` are module-level mutable variables
- Safe only because `maxConcurrency: 1`, but would break if concurrency increased
- Should be encapsulated in a crawl session object

### snapshotDiff() ignores body text changes
- Only compares headings, element labels, form field count, and links
- Pages that change only body text (e.g. dynamic results, personalized content) are not detected as structurally different
- Advance clicks on such pages may be incorrectly flagged as "no change"

### Content hash is URL-dependent
- `hashPageContent()` hashes `url + innerText`, so identical content served at different URLs (redirects, URL params) produces different hashes
- Can cause duplicate screenshots of the same visual state

### Snapshot element cap may miss important elements
- `extractPageSnapshot()` caps at 40 interactive elements and 15 links
- Large pages (mega-menus, product listings) may have important elements truncated
- The prioritization (above-fold first) helps but isn't guaranteed to capture all navigation

### Analysis cache key doesn't include URL
- Identical page structures on different URLs return cached results from the first analysis
- Intentional for performance (quiz pages repeat structure), but can cause wrong prompt selection if URL context matters

### No tests
- `package.json` has `"test": "echo \"No tests yet\""` — zero test coverage
- Critical logic (selectPrompt, snapshotDiff, resolveBranchUrl, enqueueBranches) needs unit tests
- End-to-end test with a mock site would catch regressions

### No incremental webhook updates
- Webhook POST only fires at the end of the entire run
- Long-running crawls (50+ pages) provide no progress indication to the caller
- Should support periodic progress webhooks or streaming

### No structured error reporting
- Failed requests are logged but not included in webhook payload or dataset
- Caller has no visibility into which paths failed or were skipped

### No mobile/desktop toggle
- Viewport is set once at run start — no way to crawl both mobile and desktop views in one run
- Some funnels render completely different content per viewport

### Popup dismissal is best-effort
- `dismissPopups()` tries common patterns but can miss custom modals, interstitials, or app-install prompts
- Force-removing overlays by z-index can accidentally remove legitimate UI elements
