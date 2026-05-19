# DoubleCheck - Product roadmap

## What it is

A web tool that generates fair rotational schedules for fantasy football leagues. It ensures no team is doubled against the same opponent in consecutive seasons, with mathematically optimal spacing between rematches.

**Live at:** [doublecheckff.com](https://doublecheckff.com)
**Repo:** [github.com/shahirtaj/doublecheck](https://github.com/shahirtaj/doublecheck)

---

## The problem

In a 12-team, 14-week fantasy football league, each team plays 3 opponents twice and 8 once. With random scheduling, some pairs get doubled year after year - creating a measurable competitive imbalance. The probability that any specific pair repeats across 3+ of 4 seasons is ~6.5%, but with 66 total pairs, ~4 pairs will experience this in any league. It's a near-certainty someone is getting a raw deal.

---

## The algorithm

- Weeks 1–N: doubled opponents (first game)
- Weeks N+1 through W-N: single opponents (shuffled)
- Weeks W-N+1 through W: doubled opponents (rematch, same order)
- Every doubled pair gets maximum separation (e.g., 11 weeks for 14-week / 3-double format)
- Lookback window derived per format: hard-avoid recent seasons, soft-avoid the next oldest (~6 forced repeats from oldest avoided season)
- Full rotation cycle varies by format (~4 years for 12-team/14-week)
- Identity tracking via Sleeper user IDs (survives name changes, team name changes, roster position changes)

---

## Supported formats

| Format | Doubles/team | Singles/team | Rotation cycle | Notes |
|--------|-------------|-------------|----------------|-------|
| 8 / 13 | 6 | 1 | ~7 years | Inverted problem (who do you NOT double) |
| 10 / 13 | 4 | 5 | ~3 years | |
| 10 / 14 | 5 | 4 | ~2 years | |
| 12 / 13 | 2 | 9 | ~6 years | |
| 12 / 14 | 3 | 8 | ~4 years | Most common league shape |
| 14 / 14 | 1 | 12 | ~13 years | Minimal impact, tool should be transparent |
| 14 / 15 | 2 | 11 | ~7 years | |

Formats with zero doubles (e.g., 14-team / 13-week) are pure round-robins - the tool detects these and tells the user no schedule is needed.

Formats with complete double round-robins (e.g., 8-team / 14-week) also have no fairness problem - the tool detects and communicates this.

Odd-number leagues and 16+ team leagues are out of scope.

---

## Platform landscape

| Platform | Users | API | Auth | Status |
|----------|-------|-----|------|--------|
| Sleeper | Fastest growing | Fully public, free | None | ✅ Integrated |
| ESPN | ~13M | Undocumented, fragile | Cookies for private leagues | ✅ Integrated (public leagues) |
| Yahoo | ~5-10M | Official, OAuth 2.0 | Developer app registration | ✅ Integrated (OAuth 2.0) |
| NFL.com | Small | None | N/A | Not supported |
| CBS | Small | None | N/A | Not supported |

No write APIs exist on any platform for schedule input. Commissioners enter the generated schedule manually through their platform's commissioner tools. This is a one-time annual task (~10 minutes).

---

## Tech stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | Next.js 16 (App Router, Turbopack default) | SSR for SEO landing page, API routes for proxy, React for app |
| UI | React 19 | Latest stable React runtime |
| Language | TypeScript | Type safety for the algorithm and API integrations |
| Styling | Tailwind CSS | Standard for Next.js, rapid responsive development |
| Linting | ESLint 9 (flat config in `eslint.config.mjs`) | Enforced in CI; `next lint` was removed in Next 16 so we call ESLint directly |
| Deployment | Vercel | Native Next.js support, serverless functions, free tier |
| Domain | doublecheckff.com | Purchased via Vercel |
| Storage (v2) | Upstash Redis | Stores share-link payloads keyed by short slug; no auth or user accounts needed. Originally Vercel KV; auto-migrated to Upstash Redis when Vercel KV was deprecated. |
| Analytics | Vercel Web Analytics | Free tier, zero-config on Vercel, privacy-friendly (no cookies, no PII) |
| Testing | Vitest | Fast, TypeScript-native |
| CI | GitHub Actions | Typecheck + lint + test + build on push/PR to main |
| License | MIT | Maximizes credibility, community signal |

localStorage for local state. Upstash Redis for shareable links.

---

## Phases

### Phase 1: Generalize the algorithm ✅
**Tool: Claude Code**

Parameterized the core algorithm by `(teamCount, weekCount)`. Covers all 7 supported formats with derived double counts, rotation cycles, lookback windows, spacing constraints, and decomposition proofs.

**Deliverable:** `lib/algorithm/` module with 92 Vitest tests.

---

### Phase 2: Next.js project ✅
**Tool: Claude Code**

Next.js (App Router) with Tailwind CSS. Tool is the homepage (`app/page.tsx`). Responsive UI - matrix grid scrolls horizontally on mobile, week navigator wraps. localStorage for persistence. Originally shipped on Next.js 14; later upgraded through 15 to **Next.js 16** (Turbopack default for both dev and build, React 19). Lint moved to ESLint 9 flat config (`eslint.config.mjs`) because Next 16 removed `next lint`.

**Deliverable:** Full app running locally and deployed.

---

### Phase 3: Platform integrations ✅
**Tool: Claude Code**

Server-side API routes at `/api/import/sleeper` and `/api/import/espn`. Walk the season-history chain, fetch all completed seasons (up to 5), normalize doubled pairs into `ImportedSeasonRecord` shape. IP-based rate limiting via `lib/api/rate-limit.ts`.

**Sleeper username lookup** lets users enter their Sleeper username instead of a league ID; the route lists all NFL leagues for the user so they can pick from a dropdown - no league-ID hunting.

**Manual entry mode** covers unsupported platforms (NFL.com, CBS, etc.): the commissioner picks the league format, names the teams, and clicks each past season's doubled matchups on an interactive grid. Same downstream pipeline as a platform import once the data is in.

**Deliverable:** Unified import UI - enter league ID or Sleeper username, pick a platform or click into manual entry, fetch, apply.

---

### Phase 4: GitHub ✅
**Tool: Claude Code**

Public repo at `github.com/shahirtaj/doublecheck`. README explains the fairness problem, math, supported formats, and algorithm. MIT license. GitHub Actions CI (typecheck + test + build on push/PR).

**Deliverable:** Public repo with passing CI.

---

### Phase 5: Deploy ✅
**Tool: Vercel**

Deployed on Vercel with auto-deploy from `main`. Custom domain `doublecheckff.com` configured. Framework preset: Next.js.

**Deliverable:** Live at doublecheckff.com.

---

### Phase 6: SEO, auto-detection, lookback override, favicon ✅
**Tool: Claude Code**

- Generic tagline: "Fair schedules for fantasy football leagues"
- Inline SVG favicon: dark slate rounded square with two emerald checkmarks ("double check")
- Open Graph + Twitter meta tags for social sharing
- SEO title: "DoubleCheck - Fair Fantasy Football Schedule Generator"
- League format auto-detected from imported data (teamCount from roster size, weekCount from regWeeks) - no manual format selector
- Before import: "Import a league to get started" prompt with Sleeper/ESPN options
- Edge-case detection: pure round-robin and complete double round-robin show explanatory messages
- Lookback window override in Step 2 (Review): "Using last N seasons (recommended for X-team / Y-week)" with dropdown to override (1 through history length), defaults to format-recommended value
- Lookback override capped at the format-recommended maximum
- All `TEAM_COUNT`/`WEEK_COUNT` constants replaced with dynamic state derived from import
- Consolidated platform selector (single dropdown for Sleeper/ESPN/Yahoo instead of separate sections)
- Step navigation: tabs allow backward navigation but not forward to unreached steps
- Footer with bug report (GitHub Issues) and Buy Me a Coffee links
- Duplicate import prevention (same year + identical doubles is skipped)
- UI polish: simplified copy, destructive button styling, season history moved to Review step only

**Deliverable:** SEO-optimized, format-aware tool with user-controllable lookback.

---

### Phase 6.5: Yahoo integration ✅
**Tool: Claude Code**

Yahoo's official Fantasy Sports API requires a registered developer app and a full OAuth 2.0 user-consent flow.

- Yahoo Developer app registered with `fspt-r` (Fantasy Sports Read) scope
- `/api/auth/yahoo/start` and `/api/auth/yahoo/callback` handle the redirect flow with a CSRF state cookie
- Access + refresh tokens encrypted with AES-256-GCM (`YAHOO_TOKEN_SECRET`-keyed) and stored in an httpOnly cookie - no database, no user accounts
- `/api/import/yahoo` runs in two modes: empty body lists the user's NFL leagues for a picker; `{leagueKey}` walks the renew chain and returns `ImportedSeasonRecord[]` for completed seasons. Auto-refreshes expired access tokens and rewrites the cookie before responding
- Yahoo dropdown option shows a "Connect Yahoo" button (no more "coming soon")

**Deliverable:** Yahoo league import with the same UX as Sleeper/ESPN.

---

### Phase 7: Shareable links ✅
**Tool: Claude Code**

Upstash Redis backs shareable read-only league links - the viral loop. 11 managers see the tool, some are commissioners in other leagues, they use it for theirs. No auth, no accounts, no Postgres - the share link itself is the identifier.

- "Share" button in Step 3 serializes the current league state (format, teams, userIds, history, manualDoubles, schedule) and POSTs to `/api/share`, which writes to Upstash Redis under an 8-char alphanumeric slug and returns `/s/{slug}`
- `/s/[slug]` server-renders a read-only view from KV: league format, manager list, week navigator, matchup list, and double-matchup summary - no edit, save, or import controls
- 365-day TTL on KV entries; expired or missing slugs render a "Link expired or not found" message
- IP-based rate limit of 5 shares per hour, namespaced separately from the import quota

Local-first usage stays on localStorage. KV is opt-in per share.

**Deliverable:** Shareable league links that work cross-device without sign-in.

---

### Phase 8: Analytics ✅
**Tool: Claude Code**

- Vercel Web Analytics (free tier) for privacy-friendly traffic insights - no cookies, no PII, zero-config when deployed on Vercel
- `@vercel/analytics/next` `<Analytics />` component mounted in the root layout so every page (including `/s/[slug]` share views) reports pageviews
- Rate limiting already implemented in Phase 3 (`lib/api/rate-limit.ts`)
- Track: which platforms people use, which formats are most common, Reddit referral traffic, share-link reach

Data shapes what to prioritize post-launch.

---

### Phase 9: Reddit launch (Wave 1 ✅)
**Tool: Claude chat**

Two waves, different audiences and timing:

**Wave 1 (May 2026) ✅:**
- **r/FFCommish:** Posted ✅ - 12 upvotes, 6 comments, 3.4K views. Positive reception.
- **r/DynastyNerds:** Posted ✅ - Live with link in comments (inline links filtered by spam). 1.6K views.
- **r/SleeperApp:** Posted ✅ - Live with link in comments (inline links filtered by spam). 743 views. Messaged mods for fresh post approval, awaiting response.
- **r/fantasyfootball:** Posted ✅ - 527 upvotes, 118 comments, 88% upvote ratio on a 3.4M subscriber subreddit. Top comment (164 pts) requested rivalry weeks; Sleeper username lookup was shipped live in the thread. Manual entry shipped in response to NFL.com/CBS requests in the same thread.
- **r/DynastyFF:** Posted ✅ - landed in the Friday megathread (Rule 11 restricts tools to the megathread; standalone post denied by mods).

**Shipped alongside Wave 1:** platform-specific how-to-apply instructions on the schedule step (Sleeper / ESPN / Yahoo / Manual, with deep links to each platform's docs), ESPN private-league error improvements (active-voice message, inline "see instructions" link, Manual entry fallback), mobile viewport fixes, and avoidance list styling tweaks.

**Wave 2 (late July/August 2026):** r/DynastyFF (megathread), r/FFCommish, r/DynastyNerds, r/SleeperApp, r/Fantasy_Football. Redraft league setup season. Fresh angle for the second round.

**Deliverable:** Reddit reach across the dynasty + commissioner + Sleeper communities, with redraft-season follow-up in Wave 2.

---

## Priority order

Phases 1–8 are done. Phase 9 Wave 1 is complete (all 5 target subreddits posted; r/DynastyFF landed in the Friday megathread per Rule 11). Phase 10 (rivalry weeks) is next.

## Estimated effort

Phases 1–8 completed across two days. Phase 9 Wave 1 complete; Wave 2 planned for late July/August 2026. Phase 10 (rivalry weeks) next.

---

## Current state

Phases 1–8 are complete. Phase 9 Wave 1 is complete. Phase 10 (rivalry weeks) is next. The tool is live at [doublecheckff.com](https://doublecheckff.com).

- **Phase 1 - Generalized algorithm.** `lib/algorithm/` module covers all 7 supported formats with a `(teamCount, weekCount)` parameterization. 92 Vitest tests prove constraints hold across every format.
- **Phase 2 - Next.js 16 App Router.** Tool is the homepage with Tailwind CSS and responsive UI. localStorage persistence. Originally built on Next.js 14; upgraded through 15 to 16 (Turbopack default, React 19). Linting moved to ESLint 9 flat config in `eslint.config.mjs` since `next lint` was removed in Next 16. `postcss` and `glob` `overrides` from `package.json` were dropped because Next 15+ already resolves both cleanly.
- **Phase 3 - Server-side platform integrations.** `/api/import/sleeper` and `/api/import/espn` walk the season-history chain, fetch all completed seasons, and apply IP-based rate limiting. Sleeper also supports username lookup: enter a Sleeper username and DoubleCheck lists your leagues to pick from (no need to remember the league ID). For platforms without an API (NFL.com, CBS, etc.), a **manual entry** mode lets commissioners pick the format, name their teams, and click each past season's doubled matchups on an interactive grid.
- **Phase 4 - GitHub.** Public repo with README, MIT license, and GitHub Actions CI (92/92 tests passing).
- **Phase 5 - Deployed.** Live on Vercel at doublecheckff.com with auto-deploy from main.
- **Phase 6 - SEO + polish.** Favicon (double checkmark SVG), OG/Twitter meta tags, auto-detected league format from import data, lookback window override control, edge-case format detection. No manual format selector - format is derived from imported seasons.
- **Phase 6.5 - Yahoo OAuth 2.0 import.** `/api/auth/yahoo/start` + `/api/auth/yahoo/callback` handle the OAuth dance with a CSRF state cookie. Access + refresh tokens encrypted with AES-256-GCM and stored in an httpOnly cookie - no database, no user accounts. `/api/import/yahoo` lists the user's NFL leagues for a picker, then walks the renew chain on selection to return `ImportedSeasonRecord[]`. Auto-refreshes expired tokens.
- **Phase 7 - Shareable read-only links via Upstash Redis.** `/api/share` accepts the current league state, generates an 8-char alphanumeric slug, and writes the payload to Upstash Redis (originally Vercel KV, auto-migrated when Vercel KV was deprecated) with a 365-day TTL. `/s/[slug]` server-renders a read-only schedule view (week navigator, matchup list, double-matchup summary). Step 3 has a "Save & Share" button that saves the season and returns the share URL with a "Copy link" affordance in one action. IP rate limit of 5 shares per hour, namespaced separately from the import quota.
- **Phase 8 - Vercel Web Analytics.** `@vercel/analytics/next` `<Analytics />` mounted in `app/layout.tsx` so every route (homepage + share views) reports pageviews on the free tier. No cookies, no PII, zero-config when deployed on Vercel.
- **Phase 9 Wave 1 - Reddit launch complete.** Posted to r/FFCommish (12 upvotes, 6 comments, 3.4K views), r/DynastyNerds (1.6K views, link in comments after spam filter blocked the inline link), r/SleeperApp (743 views, link in comments, modmail open for a fresh post), and r/fantasyfootball (**527 upvotes, 118 comments, 88% upvote ratio** on a 3.4M-subscriber subreddit - top comment, 164 pts, requested rivalry weeks; **Sleeper username lookup shipped live in the thread**, and **manual entry shipped in response to NFL.com/CBS requests in the same thread**). r/DynastyFF landed in the Friday megathread (Rule 11 restricts tools to the megathread; standalone post denied by mods). Shipped alongside the Wave 1 push: platform-specific how-to-apply instructions on the schedule step (Sleeper / ESPN / Yahoo / Manual with deep links to each platform's docs), ESPN private-league error improvements (active-voice message, inline "see instructions" link, Manual entry fallback), mobile viewport fixes, and avoidance list styling tweaks. Wave 2 (late July/August 2026) will hit r/DynastyFF (megathread), r/FFCommish, r/DynastyNerds, r/SleeperApp, and r/Fantasy_Football for redraft setup season.
- **Phase 10 - Rivalry weeks (next).** Top requested feature from the r/fantasyfootball thread (164-point top comment). Let commissioners designate rivalry pairs that get doubled every year regardless of rotation, with the algorithm honoring those locks while still rotating the remaining doubles fairly across the rest of the league.

### Production fixes
- **Sleeper import 502 on single-season leagues** (commit `f67c65a`). Sleeper returns `previous_league_id: "0"` for leagues with no prior season; `"0"` is truthy in JS, so the chain walker fetched `league/0`, got a 404, and crashed the route with a 502. Fix: `nextChainId()` now treats `"0"` (alongside `null`/`undefined`/`""`) as end-of-chain. Added a typed `LeagueNotFoundError`, an outer try/catch with `console.error` logging, and response validation. The same defensive fixes were applied to the ESPN and Yahoo routes so a single bad upstream response can't take down the import endpoints.

### Superseded files removed
- `fetch-sleeper.js` - replaced by `/api/import/sleeper` server-side route
- `prototype.jsx` - replaced by `app/page.tsx`
- Sleeper JSON paste fallback - removed, server-side route eliminates the need
- Manual format selector - removed, replaced by auto-detection from import data
- Schedule text paste - removed - impractical for multi-season history data

### Investigated and deferred
- **Platform write APIs for schedule input:** No write APIs exist on Sleeper, ESPN, or Yahoo. Headless browser automation (Puppeteer/Playwright) would require storing credentials, break on UI changes, and create unsustainable support burden - all to save ~10 minutes of annual manual entry. Not worth building.
