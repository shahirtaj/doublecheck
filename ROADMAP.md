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

- Weeks 1-N: doubled opponents (first game)
- Weeks N+1 through W-N: single opponents (shuffled)
- Weeks W-N+1 through W: doubled opponents (rematch, same order)
- Every doubled pair gets maximum separation (e.g., 11 weeks for 14-week / 3-double format)
- Lookback window derived per format: hard-avoid recent seasons, soft-avoid the next oldest (~6 forced repeats from oldest avoided season)
- Full rotation cycle varies by format (~4 years for 12-team/14-week)
- Identity tracking via Sleeper user IDs, ESPN user IDs, or Yahoo manager GUIDs (survives name changes, team name changes, roster position changes)
- Rivalry pins: commissioner-supplied matchup constraints that override the avoidance system. 1 pin = forced single at that week; 2 pins for the same pair = forced double at both weeks. Pins integrate with the block-pair structure so pinned weeks at block boundaries naturally double while middle-week pins stay single.

---

## Supported formats

| Format  | Doubles/team | Singles/team | Rotation cycle | Notes                                      |
| ------- | ------------ | ------------ | -------------- | ------------------------------------------ |
| 8 / 13  | 6            | 1            | ~7 years       | Inverted problem (who do you NOT double)   |
| 10 / 13 | 4            | 5            | ~3 years       |                                            |
| 10 / 14 | 5            | 4            | ~2 years       |                                            |
| 12 / 13 | 2            | 9            | ~6 years       |                                            |
| 12 / 14 | 3            | 8            | ~4 years       | Most common league shape                   |
| 14 / 14 | 1            | 12           | ~13 years      | Minimal impact, tool should be transparent |
| 14 / 15 | 2            | 11           | ~7 years       |                                            |

Formats with zero doubles (e.g., 14-team / 13-week) are pure round-robins - the tool detects these and tells the user no schedule is needed.

Formats with complete double round-robins (e.g., 8-team / 14-week) also have no fairness problem - the tool detects and communicates this.

Odd-number leagues and 16+ team leagues are out of scope.

---

## Platform landscape

| Platform | Users           | API                   | Auth                        | Status                         |
| -------- | --------------- | --------------------- | --------------------------- | ------------------------------ |
| Sleeper  | Fastest growing | Fully public, free    | None                        | ✅ Integrated                  |
| ESPN     | ~13M            | Undocumented, fragile | Cookies for private leagues | ✅ Integrated (public leagues) |
| Yahoo    | ~5-10M          | Official, OAuth 2.0   | Developer app registration  | ✅ Integrated (OAuth 2.0)      |
| NFL.com  | Small           | None                  | N/A                         | Not supported                  |
| CBS      | Small           | None                  | N/A                         | Not supported                  |

No write APIs exist on any platform for schedule input. Commissioners enter the generated schedule manually through their platform's commissioner tools. This is a one-time annual task (~10 minutes).

---

## Tech stack

| Layer        | Choice                                        | Rationale                                                                                                                                                            |
| ------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework    | Next.js 16 (App Router, Turbopack default)    | SSR for SEO landing page, API routes for proxy, React for app                                                                                                        |
| UI           | React 19                                      | Latest stable React runtime                                                                                                                                          |
| Language     | TypeScript                                    | Type safety for the algorithm and API integrations                                                                                                                   |
| Styling      | Tailwind CSS                                  | Standard for Next.js, rapid responsive development                                                                                                                   |
| Linting      | ESLint 9 (flat config in `eslint.config.mjs`) | Enforced in CI; `next lint` was removed in Next 16 so we call ESLint directly                                                                                        |
| Deployment   | Vercel                                        | Native Next.js support, serverless functions, free tier                                                                                                              |
| Domain       | doublecheckff.com                             | Purchased via Vercel                                                                                                                                                 |
| Storage (v2) | Upstash Redis                                 | Stores share-link payloads keyed by short slug; no auth or user accounts needed. Originally Vercel KV; auto-migrated to Upstash Redis when Vercel KV was deprecated. |
| Analytics    | Vercel Web Analytics                          | Free tier, zero-config on Vercel, privacy-friendly (no cookies, no PII)                                                                                              |
| Testing      | Vitest                                        | Fast, TypeScript-native                                                                                                                                              |
| CI           | GitHub Actions                                | Typecheck + lint + test + build on push/PR to main                                                                                                                   |
| License      | MIT                                           | Maximizes credibility, community signal                                                                                                                              |

localStorage for local state. Upstash Redis for shareable links.

---

## Phases

### Phase 1: Generalize the algorithm ✅

**Tool:** Claude Code

Parameterized the core algorithm by `(teamCount, weekCount)`. Covers all 7 supported formats with derived double counts, rotation cycles, lookback windows, spacing constraints, and decomposition proofs.

**Deliverable:** `lib/algorithm/` module with 92 Vitest tests.

---

### Phase 2: Next.js project ✅

**Tool:** Claude Code

Next.js (App Router) with Tailwind CSS. Tool is the homepage (`app/page.tsx`). Responsive UI - matrix grid scrolls horizontally on mobile, week navigator wraps. localStorage for persistence. Originally shipped on Next.js 14; later upgraded through 15 to **Next.js 16** (Turbopack default for both dev and build, React 19). Lint moved to ESLint 9 flat config (`eslint.config.mjs`) because Next 16 removed `next lint`.

**Deliverable:** Full app running locally and deployed.

---

### Phase 3: Platform integrations ✅

**Tool:** Claude Code

Server-side API routes at `/api/import/sleeper` and `/api/import/espn`. Walk the season-history chain and fetch up to the format's recommended lookback (clamped to `MAX_SEASONS_CAP = 13` to bound the chain walk on long-running leagues), normalize doubled pairs into `ImportedSeasonRecord` shape. IP-based rate limiting via `lib/api/rate-limit.ts`.

**Sleeper username lookup** lets users enter their Sleeper username instead of a league ID; the route lists all NFL leagues for the user so they can pick from a dropdown - no league-ID hunting.

**Manual entry mode** covers unsupported platforms (NFL.com, CBS, etc.): the commissioner picks the league format, names the teams, and clicks each past season's doubled matchups on an interactive grid. Same downstream pipeline as a platform import once the data is in.

**Deliverable:** Unified import UI - enter league ID or Sleeper username, pick a platform or click into manual entry, fetch, apply.

---

### Phase 4: GitHub ✅

**Tool:** Claude Code

Public repo at `github.com/shahirtaj/doublecheck`. README explains the fairness problem, math, supported formats, and algorithm. MIT license. GitHub Actions CI (typecheck + test + build on push/PR).

**Deliverable:** Public repo with passing CI.

---

### Phase 5: Deploy ✅

**Tool:** Vercel

Deployed on Vercel with auto-deploy from `main`. Custom domain `doublecheckff.com` configured. Framework preset: Next.js.

**Deliverable:** Live at doublecheckff.com.

---

### Phase 6: SEO, auto-detection, lookback override, favicon ✅

**Tool:** Claude Code

Generic positioning across the surface: a "Fair schedules for fantasy football leagues" tagline, an inline-SVG favicon (dark slate rounded square with two emerald checkmarks - the "double check" pun), Open Graph and Twitter meta tags for social sharing, and an SEO title of "DoubleCheck - Fair Fantasy Football Schedules". League format is now auto-detected from imported data (team count from roster size, week count from regWeeks) rather than picked manually, so the pre-import view shows an "Import a league to get started" prompt with Sleeper/ESPN options and edge-case formats (pure round-robin, complete double round-robin) get their own explanatory messages instead of running the algorithm needlessly. Step 2 (Review) gained a lookback window override dropdown ("Using last N seasons (recommended for X-team / Y-week)") capped at the format-recommended maximum, and every `TEAM_COUNT`/`WEEK_COUNT` constant was replaced with dynamic state derived from the import. The platform selector consolidated into a single dropdown (Sleeper/ESPN/Yahoo) instead of separate sections, step navigation allows backward navigation but blocks forward jumps past unreached steps, and the footer picked up a GitHub Issues bug-report link and a Buy Me a Coffee link. Duplicate import prevention skips entries with the same year and identical doubles, and smaller polish landed alongside (simplified copy, destructive button styling, season history scoped to the Review step).

**Deliverable:** SEO-optimized, format-aware tool with user-controllable lookback.

---

### Phase 6.5: Yahoo integration ✅

**Tool:** Claude Code

Yahoo's official Fantasy Sports API requires a registered developer app and the full OAuth 2.0 user-consent flow. The Yahoo Developer app is registered with the `fspt-r` (Fantasy Sports Read) scope. `/api/auth/yahoo/start` and `/api/auth/yahoo/callback` handle the redirect dance with a CSRF state cookie; access and refresh tokens are encrypted with AES-256-GCM (keyed off `YAHOO_TOKEN_SECRET`) and stored in an httpOnly cookie, so there's no database and no user accounts. `/api/import/yahoo` runs in two modes - an empty body lists the user's NFL leagues for a picker, while `{leagueKey}` walks the league's renew chain and returns `ImportedSeasonRecord[]` for completed seasons. Expired access tokens auto-refresh and the cookie gets rewritten before the response goes out. The Yahoo dropdown option now shows a "Connect Yahoo" button instead of "coming soon". A follow-up pass added the Yahoo Fantasy attribution required by Yahoo's API terms: a shared `YahooAttribution` component (cropped-viewBox logo + "Fantasy data provided by Yahoo Fantasy" link to `sports.yahoo.com/fantasy/`) renders below the apply-instructions line on both the schedule step and the shared schedule view (gated on `platform === "yahoo"`), is appended to the copy-as-text export, and every user-facing string was rebranded from "Yahoo" to "Yahoo Fantasy" while internal identifiers, route paths, cookie names, and type-union members kept the short `"yahoo"` form.

**Deliverable:** Yahoo league import with the same UX as Sleeper/ESPN.

---

### Phase 7: Shareable links ✅

**Tool:** Claude Code

Upstash Redis backs shareable read-only league links - the viral loop. Eleven managers see the tool, some are commissioners in other leagues, they take it back to theirs. No auth, no accounts, no Postgres: the share link itself is the identifier. The "Save & Share" button in Step 3 serializes the current league state (format, teams, userIds, history, manualDoubles, schedule) and POSTs to `/api/share`, which writes the payload to Upstash Redis under an 8-char alphanumeric slug and returns `/s/{slug}`. The `/s/[slug]` route server-renders a read-only view from Upstash Redis - league format, manager list, week navigator, matchup list, and double-matchup summary - with no edit, save, or import controls. Entries carry a 365-day TTL; expired or missing slugs render a "Link expired or not found" message. IP-based rate limiting caps shares at 5 per hour, namespaced separately from the import quota. Local-first usage stays on localStorage; Upstash Redis is opt-in per share.

**Deliverable:** Shareable league links that work cross-device without sign-in.

---

### Phase 8: Analytics ✅

**Tool:** Claude Code

Vercel Web Analytics (free tier) gives privacy-friendly traffic insights - no cookies, no PII, zero-config when deployed on Vercel. The `@vercel/analytics/next` `<Analytics />` component is mounted in the root layout so every page (including `/s/[slug]` share views) reports pageviews. The IP-based rate limiting already in place from Phase 3 (`lib/api/rate-limit.ts`) covers abuse vectors. The numbers shape post-launch priorities: which platforms people use, which formats dominate, Reddit referral traffic, and share-link reach.

**Deliverable:** Vercel Web Analytics integrated for traffic insights.

---

### Phase 9: Reddit launch (Wave 1 ✅)

**Tool:** Claude chat

Two waves, different audiences and timing. **Wave 1 (May 2026, complete):** r/FFCommish landed 12 upvotes, 6 comments, and 3.9K views with positive reception. r/DynastyNerds (1.8K views) and r/SleeperApp (907 views) shipped with the link in comments after the inline link got filtered as spam - modmail's open at r/SleeperApp for a fresh post approval. r/fantasyfootball took off: 548 upvotes, 139 comments, 363K views, 1.3K shares, 88.2% upvote ratio on a 3.4M-subscriber subreddit. The top comment (164 pts) requested rivalry weeks, Sleeper username lookup shipped live in the thread, and manual entry shipped in response to NFL.com/CBS requests in the same thread. r/DynastyFF landed in the Friday megathread (Rule 11 restricts tools to the megathread; the standalone post was denied by mods). Shipped alongside Wave 1: platform-specific how-to-apply instructions on the schedule step (Sleeper / ESPN / Yahoo / Manual, each deep-linking to the platform's docs), ESPN private-league error improvements (active-voice message, inline "see instructions" link, Manual entry fallback), mobile viewport fixes (Step 1 dropdown/input wrap, Start button stays on row in Manual entry), avoidance list styling (opponents wrap below team name, sorted hard > soft > alphabetical), soft-avoid color contrast bump in the matrix, and input clearing on platform switch. Site metrics (first 30 days): 2,460+ unique visitors, 3,840+ pageviews, 86 shared schedules, 82 Yahoo OAuth completions, 82% mobile traffic, with top referrers from reddit.com (662 visitors across reddit.com, com.reddit.frontpage, and old.reddit.com). **Wave 2 (late July/August 2026):** r/DynastyFF (megathread), r/FFCommish, r/DynastyNerds, r/SleeperApp, r/Fantasy_Football. Redraft league setup season, fresh angle for the second round.

**Deliverable:** Reddit reach across the dynasty + commissioner + Sleeper communities, with redraft-season follow-up in Wave 2.

---

### Phase 10: Rivalry weeks ✅

**Tool:** Claude Code

Top requested feature from the r/fantasyfootball thread (164-point top comment). Commissioners can pin specific matchups to specific weeks, creating designated rivalry weeks where chosen opponents always face each other regardless of the normal avoidance rotation, and the algorithm honors those locks while continuing to rotate the remaining doubles fairly. `buildSchedule` accepts an optional `rivalryPins` array of `RivalryPin` objects (`teamA`, `teamB`, `week` or null for "any week"), and `resolvePins()` runs in four passes: a 2-pin both-specific pair gets forced into a double at both weeks; a 1-pin specific lands at the pinned week (doubling naturally if it sits on a block boundary); a 2-pin with any-week lets the algorithm pick the second week optimally; and a 1-pin any-week picks a compatible week, preferring middle (single) weeks for spread. Pins override hard- and soft-avoid (a hard-avoided pair pinned to a week still plays that week - one pin + hard-avoid is a forced single, two pins fully override avoidance and force a double). Per-pair pin cap is `ceil(weekCount / (teamCount - 1))`, currently 2 for all supported formats. Full-week pins (every team paired once at a single week) work across all 7 formats, including with hard-avoided pairs mixed in, and multi-week rivalry scenarios are supported via independent matchings per pinned week. `RivalryPlacement` output tracks where each pin landed (`pinnedWeek` vs `placedWeek`) for UI display, and non-partner-week doubles use `recordNonPartner` bookkeeping so slot assignment stays consistent. Types added: `RivalryPin` (`{teamA, teamB, week: number | null}`), `RivalryPlacement` (`{teamA, teamB, pinnedWeek: number | null, placedWeek: number}`), plus `ScheduleConfig.rivalryPins` and `ScheduleSuccess.rivalryPlacements`. The pin builder in Step 2 (Review) has Team A / Team B / Week selectors with smart disabling: weeks where either team is already pinned show "(pinned)", exact-pair duplicates show "(already pinned)", dp=1 formats restrict the second pin to the natural partner week, and weeks with no valid partner show "(unavailable)". Adding a pin for a hard-avoided pair surfaces an amber warning explaining the override behavior; the pin list has inline remove buttons; pins clear on reset, reimport, or new manual flow; and a `pinJustAdded` flag suppresses stale validation errors immediately after a successful pin. Share links carry `rivalryPlacements` so the read-only view renders them, with pre-Phase-10 links treated as empty for backward compat. The test suite gained 57 new rivalry-pin tests (188 total), covering single-pin and double-pin scenarios, any-week placement, avoidance override behavior, full-week pins across every supported format (with and without a hard-avoided pair in the mix), multi-week rivalry partitions, 14-team edge cases (pure round-robin 14/13 and minimal-double 14/14), mixed scenarios with full-week and individual pins coexisting, non-partner pins (independent matchings, separation-floor checks, dp=1 infeasibility detection), and rejection paths for exact duplicates, over-cap pins, and unsolvable configurations.

**Deliverable:** Full rivalry-weeks feature - algorithm, UI, share links, and comprehensive test coverage.

---

### Phase 11: UI polish ✅

**Tool:** Claude Code + Claude chat

Comprehensive polish pass across the main app and shared schedule views. Manager names sort alphabetically at import time and in every display-only context (numeric-aware `localeCompare` throughout, so "Team 10" lands after "Team 2"), with team indices remapped consistently so the algorithm sees the same alphabetized roster as the UI. The redundant green fetch-success status line collapsed into a single import preview box that shows league name · format · platform, the season list, the sorted Managers list, and Apply/Cancel actions. The lookback box flipped to control-first layout, with the "Recommended" reference line appearing only when the dropdown deviates from the format default; the now-redundant pair-count summary and trailing period went away. Season history rows shed the constant doubled-pair count and divider rules. Matchup cards got a deterministic home/away display assignment via a greedy post-pass that lands every team at 7/7 left appearances in 14-week formats and 7/8 in 15-week formats; the assignment is computed once at generation and persisted in share payloads as `displayWeeks` so recipients see the same layout. The Copy Full Schedule textarea picked up a dedicated Copy button (with "✓ Copied" confirmation) replacing the click-to-select handler that was interfering with mobile scrolling. The schedule year is now pinned to the current calendar year (no more rollforward on regenerate), Save & Share short-circuits when a link already exists for the current schedule, and the per-IP share rate limit went from 5 to 15 per hour. The reimport branch that preserved custom names is gone - fresh imported data always wins. Back on Step 1 returns to the import view (with the previous picker and preview intact) instead of nuking everything; the Reset button stays the nuclear option. Apply/Cancel and similar button rows normalized to the right-primary convention, the share link bookmark hint shows for every platform (since rivalry pins live in the share payload), and shared schedule pages picked up platform-specific apply instructions, the Copy Full Schedule section, and the platform field in the payload while dropping the Managers section that duplicated names already visible in the matchup cards. Avoidance matrix improvements: filled both halves of the triangle so any team's full row shows all their avoids, symmetric clicking that toggles the same pair from either cell, darkened diagonal cells for cleaner separation, hover crosshair highlighting gated behind a `(hover: hover)` media query so touch devices don't flash the highlight on tap, and a neutral-slate CT row on the Add Past Season matrix (no color coding against the current format since past seasons may not conform). The Avoidance by Team section hides entirely when no team has any avoidance, the hard-avoid legend entry hides when the hard lookback window is zero (mirroring the existing soft-avoid hide), and the Add Past Season pair count went away since the CT row already provides per-team feedback. Copy and label tweaks rounded out the pass: "Double & Rival Matchups", "Clear Manual Avoids", "Generate Your Own →", "Import Your League", title-cased headings on the error / not-found / expired pages, "Restore from link" dropdown label, and a mobile-constrained Pin button that no longer stretches full-width.

**Deliverable:** Comprehensive UI polish pass across the main app and shared schedule views.

---

### Phase 12: Share link restore ✅

**Tool:** Claude Code + Claude chat

"Restore from link" added to the import platform dropdown lets returning users paste a share URL (full URL, `/s/slug` path, or bare 8-character slug) to bring a previously-shared league back into a fresh browser. A new GET `/api/share/[slug]` route reads the payload out of Upstash Redis (rate-limited at 30/hour per IP, namespaced separately from share creation, 404 on missing/expired). The client uses the same Fetch → preview → Apply → Step 1 flow as platform imports: the preview box confirms league name · format · platform plus the season list and sorted managers, Apply hydrates `format`/`teams`/`userIds`/`leagueName`/`history`/`rivalryPins` (sorting alphabetically and remapping team indices the same way platform imports do; `manualDoubles` are intentionally dropped because they're one-time overrides for a specific season and carrying them forward would silently over-constrain the next generation), then lands on Step 1 so the user can verify names, add the new season, and regenerate. The old schedule is not pre-loaded - it's stale by next season anyway, so the user runs Generate fresh against the current avoidance constraints. `rivalryPins` were added to the share payload so commissioner pin configurations survive the round-trip, completing the year-over-year continuity story for manual-entry leagues that don't have a platform API to re-import from. Older share links missing the new fields are treated as empty arrays so the restore path stays backward-compatible. A Buy Me a Coffee link was wired into `.github/FUNDING.yml` so the GitHub repo's Sponsor button surfaces it.

**Deliverable:** Full restore-from-share-link flow with rivalry pin persistence, completing the year-over-year continuity story for all platforms including manual entry.

---

### Phase 13: Component refactor ✅

**Tool:** Claude Code

Refactored `app/page.tsx` from a single 3,153-line client component into a modular structure under `app/components/`. New files: `constants.ts` (`STORAGE_KEY`, `CURRENT_YEAR`, `STEP_ORDER`), `types.ts` (all shared types - `ImportPlatform`, `ImportPreview`, `LinkPreview`, `SelectedFormat`, and friends), `utils.ts` (pure helpers - `platformLabel`, `extractSlug`, `detectFormatFromImport`, `deriveLookback`, `computeDisplayWeeks`, `abbrev`), `styles.ts` (Tailwind class atoms and `statusToneClass`), `state.ts` (single `useReducer` state with `State`, `Action`, `reducer`, `initialState`, plus `Patch` and `SaveToStorageFn` aliases), `StepImport.tsx` (Step 1 import UI plus all import handlers - `handleFetch`, `handleApplyImport`, `handleManualStart`, `handleFetchLink`, `handleApplyLinkImport`, `fetchYahooLeagues`, `fetchYahooLeagueSeasons`, `fetchSleeperLeagueSeasons`, `resetImportUi`, `filterToDetectedFormat`), `StepReview.tsx` (Step 2 avoidance matrix, past-season editor, and the rivalry pin builder broken out as a `RivalryPinBuilder` subcomponent with its smart-disabling logic), and `StepSchedule.tsx` (Step 3 schedule viewer with share and copy flows - `handleSaveAndShare`, `handleCopyShareLink`, `handleCopySchedule`, `formatScheduleText`). `page.tsx` shrank to 525 lines containing only the shared `useReducer` state, derived values (`format`, `avoidSets`, `effectiveLookback`, `recommendedLookbackTotal`, `scheduleYear`), step navigation tabs, back and reset buttons, footer, the floating tooltip div, hydration and Yahoo OAuth effects, `saveToStorage`, and `handleGenerate` - the last one passed as `onGenerate` to both StepReview and StepSchedule so the Regenerate button in Step 3 shares the same logic as Step 2's Generate Schedule button. The reducer uses a single `patch` action type plus a `reset` action; per-field wrapper setters (`setStep`, `setFurthestStep`, `setSelectedFormat`, `setConfirmReset`) wrap `patch` so the back/reset button call sites in page.tsx read like the old `useState` API. A `pendingYahooConnect` state flag bridges the OAuth callback `useEffect` in `page.tsx` to `fetchYahooLeagues` inside `StepImport` (page sets the flag on return from OAuth, StepImport's `useEffect` watches the flag and runs the fetch). No behavior, UI, or test changes - all 188 tests continue to pass and the production build succeeds.

**Deliverable:** Modular component architecture with identical behavior, all 188 tests passing.

---

### Phase 14: Font stack ✅

**Tool:** Claude Code

Swapped the all-mono JetBrains Mono stack for a paired Inter + Inconsolata stack served through `next/font/google`. Inter (proportional sans) becomes the default body font for prose, buttons, labels, headings, manager names, and `<select>` controls; Inconsolata (the matching monospace family from the same designer) is reserved for content that needs fixed-width alignment - matrix cells (column headers, row headers, clickable toggles, diagonal spacers, CT count row across both the avoidance matrix and the Add Past Season matrix), the week navigator buttons in Step 3 and the shared schedule view, the Copy Full Schedule textarea, the league ID input, the share link input on Step 1, and the share URL input that appears after Save & Share. Inter is mounted via `inter.className` on `<body>` so it cascades as the default font; both fonts are also exposed as CSS variables (`--font-sans`, `--font-mono`) and registered in `tailwind.config.ts` so the `font-sans` and `font-mono` utility classes resolve to the new families. The pre-existing hardcoded `font-family` declaration in `globals.css` (JetBrains Mono / SF Mono / Fira Code) was deleted, and every `font-mono` class on outer wrappers (`app/page.tsx`, `app/error.tsx`, `app/not-found.tsx`, `app/s/[slug]/page.tsx`, `app/s/[slug]/error.tsx`) was removed so children inherit Inter by default. The shared `cls.leagueInput`, `cls.teamInput`, and `cls.navBtn` Tailwind atoms in `styles.ts` had `font-mono` stripped; consumers that should remain mono (league ID input, share link input) re-add it explicitly while consumers that should inherit Inter (Sleeper/Yahoo league pickers, manual league name input, navigation buttons, team name inputs) simply pick up the new default. No font sizes, cell widths, or padding changed - Inconsolata is metrically similar enough to JetBrains Mono that every `text-[Npx]` class and fixed cell width stays correct. The `abbrev()` truncation cutoff was bumped from 7 to 8 chars in a follow-up commit since the extra character still fits comfortably in the 48-50px header cells at `text-[8px]` Inconsolata. A `code.font-mono { font-size: 1.19em; }` rule in `globals.css` scales inline `<code>` snippets up to Inter's x-height when they sit next to prose (the Sleeper and ESPN URL hints in Step 1); the matrix cells, week buttons, Copy textarea, and inputs use `font-mono` on `<div>`/`<button>`/`<textarea>`/`<input>` rather than `<code>`, so the rule doesn't touch them. `public/og.png` was regenerated under the new stack (Inconsolata Bold title in white, Inter subtitle in emerald `#34d399`) using `node-canvas` with the TTF files pulled directly from `raw.githubusercontent.com/rsms/inter` and `raw.githubusercontent.com/googlefonts/Inconsolata`; `screenshot.png` was recaptured under the new fonts as well. Reasoning: legibility at small sizes on mobile (82% of traffic is mobile, and team names in the matrix sit at 8px), and the shared schedule page conversion case where viewers should be able to skim manager names and instructions in a proportional font without losing the grid alignment in the week navigator or copy block.

**Deliverable:** Inter for body/UI text, Inconsolata for matrix cells and tabular elements, served through `next/font/google` with CSS variables wired into Tailwind. All 188 tests pass and the production build succeeds.

---

### Phase 15: Avoidance season years ✅

**Tool:** Claude Code

The Avoidance by Team list now shows which past season produced each auto-avoid. Hard- and soft-avoid opponents display the contributing season year(s) in parentheses after the name (e.g. "(2025)", or "(2025, 2024)" when a pair repeats across the lookback window); the opponent name is color-coded to the avoid tier while the year parenthetical stays neutral slate so the name remains the scannable landmark; manual avoids stay unlabeled. `buildAvoidMap` returns a new `seasons` map (resolved pair key -> contributing year(s)) to drive this. 6 new tests cover the seasons map (194 total).

**Deliverable:** Per-opponent season provenance in the avoidance summary.

---

### Phase 16: Destructive-action confirmations ✅

**Tool:** Claude Code

Every destructive action in Step 2 (Review) now gates behind a two-step inline confirm, in two consistent tiers. **Section confirms** - Reset, **Clear Manual Avoids**, **Clear Rivalry Pins**, and **Clear Selections** (the in-progress past-season grid) - share `dangerBtn`/`cancelBtn` style atoms in `styles.ts` (`navBtn` size) and render an identical "<Action>? Can't be undone." + Yes/Cancel row; the Clear Selections confirm replaces the past-season form's action row while armed, so it never shows a second Cancel beside the form's own. **Row confirms** - deleting a saved season ("Delete? Can't be undone.") and removing a single rivalry pin ("Remove? Can't be undone.") - stay compact with tiny inline buttons (`rowDangerBtn`/`rowCancelBtn`/`rowOutlineRed`); the rivalry-pin row gained `flex-wrap` so the armed confirm drops below the matchup on narrow screens. Every destructive trigger is red (`outlineRed`), per the app's color language - emerald = create (Add/Generate), amber = modify (Edit), red = destroy (Reset/Clear/Delete/Remove). Section clears arm boolean flags (`confirmClearManualDoubles`, `confirmClearRivalryPins`, `confirmClearSelections`) while the row confirms use index flags (`confirmDeleteSeasonIndex`, `confirmRemovePinIndex`) so only one row is armed at a time. Entering Add/Edit Past Season clears the pending delete-season and clear-all confirms so none linger behind the open form. Also reworded the past-season instruction copy ("Select the year, then click each pair of teams that played twice that season."). All five confirm flags are ephemeral UI state - not in the share payload or localStorage, so no hydration changes - with no algorithm or test changes (194).

**Deliverable:** Consistent two-step confirms on every destructive Review-step action - each red, with a "Can't be undone." warning; section confirms share one button style, row confirms stay compact inline.

---

## Priority order

Phases 1-16 are done. Phase 9 Wave 2 (Reddit redraft-season push) is next, planned for late July/August 2026.

## Estimated effort

Phases 1-8 completed across two days. Phase 9 Wave 1 complete. Phases 10-16 complete. Wave 2 planned for late July/August 2026.

---

## Current state

Phases 1-16 are complete. Phase 9 Wave 2 (late July/August 2026 Reddit redraft-season push) is next. The tool is live at [doublecheckff.com](https://doublecheckff.com).

- **Phase 1 - Generalized algorithm.** `lib/algorithm/` module covers all 7 supported formats with a `(teamCount, weekCount)` parameterization. 199 Vitest tests prove constraints hold across every format, including rivalry-pin coverage.
- **Phase 2 - Next.js 16 App Router.** Tool is the homepage with Tailwind CSS and responsive UI. localStorage persistence. Originally built on Next.js 14; upgraded through 15 to 16 (Turbopack default, React 19). Linting moved to ESLint 9 flat config in `eslint.config.mjs` since `next lint` was removed in Next 16. `postcss` and `glob` `overrides` from `package.json` were dropped because Next 15+ already resolves both cleanly.
- **Phase 3 - Server-side platform integrations.** `/api/import/sleeper` and `/api/import/espn` walk the season-history chain, fetch all completed seasons, and apply IP-based rate limiting. Sleeper also supports username lookup: enter a Sleeper username and DoubleCheck lists your leagues to pick from (no need to remember the league ID). For platforms without an API (NFL.com, CBS, etc.), a **manual entry** mode lets commissioners pick the format, name their teams, and click each past season's doubled matchups on an interactive grid.
- **Phase 4 - GitHub.** Public repo with README, MIT license, and GitHub Actions CI (199/199 tests passing).
- **Phase 5 - Deployed.** Live on Vercel at doublecheckff.com with auto-deploy from main.
- **Phase 6 - SEO + polish.** Favicon (double checkmark SVG), OG/Twitter meta tags, auto-detected league format from import data, lookback window override control, edge-case format detection. No manual format selector - format is derived from imported seasons.
- **Phase 6.5 - Yahoo OAuth 2.0 import.** `/api/auth/yahoo/start` + `/api/auth/yahoo/callback` handle the OAuth dance with a CSRF state cookie. Access + refresh tokens encrypted with AES-256-GCM and stored in an httpOnly cookie - no database, no user accounts. `/api/import/yahoo` lists the user's NFL leagues for a picker, then walks the renew chain on selection to return `ImportedSeasonRecord[]`. Auto-refreshes expired tokens.
- **Phase 7 - Shareable read-only links via Upstash Redis.** `/api/share` accepts the current league state, generates an 8-char alphanumeric slug, and writes the payload to Upstash Redis (originally Vercel KV, auto-migrated when Vercel KV was deprecated) with a 365-day TTL. `/s/[slug]` server-renders a read-only schedule view (week navigator, matchup list, double-matchup summary, rivalry placements). Step 3 has a "Save & Share" button that saves the season and returns the share URL with a "Copy link" affordance in one action. IP rate limit of 15 shares per hour (bumped from 5 in Phase 11), namespaced separately from the import quota.
- **Phase 8 - Vercel Web Analytics.** `@vercel/analytics/next` `<Analytics />` mounted in `app/layout.tsx` so every route (homepage + share views) reports pageviews on the free tier. No cookies, no PII, zero-config when deployed on Vercel.
- **Phase 9 Wave 1 - Reddit launch complete.** Posted to r/FFCommish (12 upvotes, 6 comments, 3.9K views), r/DynastyNerds (1.8K views, link in comments after spam filter blocked the inline link), r/SleeperApp (907 views, link in comments, modmail open for a fresh post), and r/fantasyfootball (**548 upvotes, 139 comments, 363K views, 1.3K shares, 88.2% upvote ratio** on a 3.4M-subscriber subreddit - top comment, 164 pts, requested rivalry weeks; **Sleeper username lookup shipped live in the thread**, and **manual entry shipped in response to NFL.com/CBS requests in the same thread**). r/DynastyFF landed in the Friday megathread (Rule 11 restricts tools to the megathread; standalone post denied by mods). Shipped alongside the Wave 1 push: platform-specific how-to-apply instructions on the schedule step (Sleeper / ESPN / Yahoo / Manual with deep links to each platform's docs), ESPN private-league error improvements (active-voice message, inline "see instructions" link, Manual entry fallback), mobile viewport fixes (Step 1 dropdown/input wrap, Start button stays on row in Manual entry), avoidance list styling (opponents wrap below team name, sorted hard > soft > alphabetical), soft-avoid color contrast bump in the matrix, and input clearing on platform switch. Site metrics (first 30 days): 2,460+ unique visitors, 3,840+ pageviews, 86 shared schedules, 82 Yahoo OAuth completions, 82% mobile traffic, with top referrers from reddit.com (662 visitors across reddit.com, com.reddit.frontpage, and old.reddit.com). Wave 2 (late July/August 2026) will hit r/DynastyFF (megathread), r/FFCommish, r/DynastyNerds, r/SleeperApp, and r/Fantasy_Football for redraft setup season.
- **Phase 10 - Rivalry weeks complete.** Top requested feature from the r/fantasyfootball thread. Commissioners pin matchups to specific weeks (or "any week") via a pin builder in Step 2. Pins override the avoidance system while the algorithm continues rotating remaining doubles fairly. Full-week pins work across all 7 formats. 57 new tests added to the suite. Share links include rivalry placements; backward-compatible with pre-Phase-10 links.
- **Phase 11 - UI polish.** Alphabetical manager-name sorting at import time and in every display-only context (numeric-aware `localeCompare` throughout, with team indices remapped consistently). Consolidated import preview box replacing the redundant fetch-success line. Control-first lookback layout with a conditional "Recommended" reference shown only on deviation. Deterministic home/away matchup display assignment (greedy post-pass producing 7/7 or 7/8 left appearances per team), persisted in share payloads via `displayWeeks`. Copy button on the schedule textarea, schedule year pinned to the current calendar year, Save & Share dedup, share rate limit bumped 5 -> 15/hr, simplified reimport (fresh data always wins), Back on Step 1 returns to the import view, right-primary button convention, share link bookmark hint shown for every platform. Shared schedule pages enriched with platform-specific apply instructions and the Copy Full Schedule section; Managers section removed. Avoidance matrix filled to a full grid with symmetric click toggling, darkened diagonals, and hover-crosshair highlighting gated to `(hover: hover)` devices; Add Past Season matrix uses a neutral-slate CT row. Avoidance by Team section hides when empty; hard-avoid and soft-avoid legend entries each hide when their lookback window is zero; Add Past Season pair count removed in favor of the CT row. Sweep of copy and label tweaks ("Double & Rival Matchups", "Clear Manual Avoids", "Generate Your Own ->", "Import Your League", title-cased error/not-found/expired headings, "Restore from link" dropdown label, mobile-constrained Pin button).
- **Phase 12 - Share link restore.** "Restore from link" option in the import dropdown lets returning users paste a share URL to bring a previously-shared league back into a fresh browser. New GET `/api/share/[slug]` route reads the payload from Upstash Redis (rate-limited at 30/hr per IP, namespaced separately from share creation, 404 on missing/expired). The client uses the same Fetch -> preview -> Apply -> Step 1 flow as platform imports. Apply hydrates format/teams/userIds/leagueName/history/rivalryPins (sorted alphabetically with index remapping; manualDoubles are intentionally dropped as one-time per-season overrides) and skips the stale schedule so the user regenerates fresh. `rivalryPins` added to the share payload so commissioner pin configurations survive the round-trip. Backward-compatible with pre-Phase-12 share links. Buy Me a Coffee Sponsor link wired into `.github/FUNDING.yml`.
- **Phase 13 - Component refactor.** `app/page.tsx` split from one 3,153-line client component into a modular tree under `app/components/`: `constants.ts`, `types.ts`, `utils.ts`, `styles.ts`, `state.ts` (single `useReducer` with a `patch` action), `StepImport.tsx` (Step 1 + all import handlers, plus the OAuth-callback `pendingYahooConnect` bridge), `StepReview.tsx` (Step 2 matrix, past-season editor, `RivalryPinBuilder` subcomponent), and `StepSchedule.tsx` (Step 3 viewer + share/copy flows). `page.tsx` is now 525 lines containing only shared state, derived values, step navigation, back/reset buttons, footer, tooltip, hydration/OAuth effects, `saveToStorage`, and `handleGenerate` (passed as `onGenerate` to both StepReview and StepSchedule). No behavior or UI changes; all 188 tests pass and production build succeeds.
- **Phase 14 - Font stack.** Swapped JetBrains Mono everywhere for Inter (proportional, body/UI) + Inconsolata (mono, fixed-width content) via `next/font/google`. Inter cascades as the default `<body>` font through `inter.className`; both fonts are also exposed as CSS variables (`--font-sans`, `--font-mono`) and wired into `tailwind.config.ts` so the `font-sans` and `font-mono` utility classes resolve correctly. Mono is retained only where alignment matters: matrix cells in both Step 2 matrices (column headers, row headers, clickable toggles, diagonal spacers, CT count row), the week navigator buttons in Step 3 and the shared schedule view, the Copy Full Schedule textarea, and the league ID / share-link / share-URL inputs. Everything else (manager names, `<select>` controls, navigation buttons, prose) inherits Inter. No font sizes, cell widths, or padding changed; Inconsolata is metrically close enough to JetBrains Mono that the existing fixed dimensions stay accurate. The `abbrev()` cutoff was bumped 7 -> 8 in a follow-up commit since the extra char fits comfortably at `text-[8px]` Inconsolata. A `globals.css` rule scales inline `<code className="font-mono">` snippets to 1.19em so Inconsolata matches Inter's x-height when adjacent to prose (Step 1 URL hints); fixed-size mono contexts using `<div>`/`<button>`/`<textarea>`/`<input>` aren't `<code>` elements and don't pick up the rule. `public/og.png` was regenerated under the new stack (Inconsolata Bold title in white, Inter subtitle in emerald) using `node-canvas` with TTFs pulled from `raw.githubusercontent.com/rsms/inter` and `raw.githubusercontent.com/googlefonts/Inconsolata`; `screenshot.png` was recaptured under the new fonts as well. Reasoning: better legibility at small sizes on mobile (82% of traffic) and a friendlier feel on the shared schedule page that recipients see without the rest of the app's controls.
- **Phase 15 - Avoidance season years.** The Avoidance by Team list shows the past season year(s) that produced each auto-avoid - hard and soft opponents display "(2025)" / "(2025, 2024)" after the name; the name is tier-colored, the year parenthetical neutral slate; manual avoids stay unlabeled. Backed by a new `seasons` map on `buildAvoidMap` (resolved pair key -> contributing years). 6 new tests (194 total).
- **Phase 16 - Destructive-action confirmations.** Every destructive Step 2 (Review) action gates behind a two-step inline confirm in two tiers. Section confirms (Reset, Clear Manual Avoids, Clear Rivalry Pins, Clear Selections) share `dangerBtn`/`cancelBtn` atoms and render "<Action>? Can't be undone." + Yes/Cancel; row confirms (delete season, remove pin) stay compact via `rowDangerBtn`/`rowCancelBtn`/`rowOutlineRed`. Every destructive trigger is red (`outlineRed`), per the color language (emerald = create, amber = modify, red = destroy). Five ephemeral confirm flags - index-based for season-delete and pin-remove, booleans for the three clears; no share-payload, localStorage, algorithm, or test changes (194). Also reworded the past-season instructions.

### Production fixes

- **Sleeper import 502 on single-season leagues** (commit `f67c65a`). Sleeper returns `previous_league_id: "0"` for leagues with no prior season; `"0"` is truthy in JS, so the chain walker fetched `league/0`, got a 404, and crashed the route with a 502. Fix: `nextChainId()` now treats `"0"` (alongside `null`/`undefined`/`""`) as end-of-chain. Added a typed `LeagueNotFoundError`, an outer try/catch with `console.error` logging, and response validation. The same defensive fixes were applied to the ESPN and Yahoo routes so a single bad upstream response can't take down the import endpoints.
- **Mobile viewport clipping on Step 1.** Platform dropdown goes full-width on mobile and the league-ID input / Fetch button wrap below instead of overflowing the card. In Manual entry, the Start button stays on the same row as the team-count and week-count selects on mobile.
- **Per-team avoidance list and double-matchup summary styling.** Opponents always wrap to a second line below the team name (no more cramped inline layouts on narrow viewports), and the list is sorted manual > hard > soft > alphabetical with default-color commas between names so the colored tokens read as labels rather than blending into the punctuation.
- **Soft-avoid color contrast in the avoidance matrix.** Amber on dark slate was too low-contrast against the hard-avoid red; bumped the soft-avoid cell tone for clearer hard-vs-soft distinction.
- **ESPN private-league error UX.** Replaced the buried 502 dump with a 403 + clear message: "This ESPN league is private. Temporarily make your league public (see instructions), then try again. Or, choose Manual entry to import without changing any ESPN settings." Inline "see instructions" link to the ESPN help article, and the message points users at the Manual entry fallback so a private league never blocks them entirely.
- **Input fields clear on platform switch in Step 1.** Switching the platform dropdown resets `leagueId`, `manualLeagueName`, `manualTeamCount` (12), and `manualWeekCount` (14) so the form doesn't carry stale input from the previous platform into the new one.
- **Platform-specific "how to apply" instructions on Step 3.** Above the Copy Full Schedule details, the schedule view now renders a one-line apply-it instruction tailored to the imported platform (Sleeper, ESPN, Yahoo, Manual). Each platform's version deep-links to the corresponding commissioner-tools doc.
- **Copy-link button on the shared schedule page** (commit `1eedb68`). The `/s/[slug]` view gained a "Copy link" button beside the card heading so mobile viewers (82% of traffic) can grab the share URL in one tap instead of fishing it out of the address bar, and a forwarder doesn't scroll past the whole schedule to find it. Mirrors the existing Copy Full Schedule button: a `linkCopied` flag, `navigator.clipboard.writeText` in a try/catch for insecure contexts, and a 2000ms "✓ Copied" label reset. The copied URL is built from `${window.location.origin}/s/${slug}` so any `?query` or `#fragment` on the page is excluded.
- **Share-page header row and unified schedule heading** (commits `bd4dde6`, `d70163c`, `4e2aa88`, `d133a20`). The shared schedule page's "Copy link" button sat in a flex header row beside the heading; when a long league name filled the row the button collapsed and its label wrapped to two lines, so it was pinned with `shrink-0 whitespace-nowrap` (at the call site, not the reused `secondaryBtn` atom). The schedule heading was then extracted into one `ScheduleHeading` component rendered identically by Step 3 and the share page: it sits on one line when it fits and wraps only when needed, with the break landing at the name/year boundary (a breakable space) while a `whitespace-nowrap` span keeps "&lt;year&gt; Schedule" together so the year never orphans, plus `min-w-0 break-words` so it shrinks in the flex row instead of overflowing. Each view passes its own size/color/margin class; the share page reserves room for the button, so the same name can wrap there while fitting full-width on Step 3 - the _treatment_ is unified, the wrap _threshold_ differs by design. Follow-ups: the share page's now-unreachable dimension-fallback heading branch was dropped (ScheduleHeading owns the no-name fallback), and the two near-identical copy-to-clipboard text exporters were consolidated into a shared `buildScheduleText(weeks, teams, platform, headingPrefix)` helper (body + Yahoo attribution in one place; each view keeps a thin wrapper for its heading prefix). Markup/refactor only, no behavior or output change (199 tests). Two small follow-ups (commits `3d4eb68`, `5f636f6`): Step 3's copy-text export now trims the league name to match ScheduleHeading's on-screen trim (a name with stray whitespace previously displayed trimmed but copied out untrimmed, and a whitespace-only name produced a heading instead of being treated as empty), and `buildScheduleText` gained unit coverage for its week/matchup layout, heading-prefix prepend, Yahoo attribution gating, and empty-weeks handling (199 -> 204 tests).
- **Long manager names overflowed the matchup card on mobile** (commit `b7c911a`). Each team-name span in the week-matchup row was `flex-1` with the default `min-width: auto`, so it couldn't shrink below its content width; a single camelCase token (no spaces or hyphens to break at, e.g. "PageantryManagement") then bled past the card edge. Fix: both name spans get `min-w-0 break-words` so the flex item can shrink and long tokens wrap, and the `vs` / `★` spans get `shrink-0` so they're never squeezed. Applied to both copies of the duplicated row markup (`StepSchedule.tsx` and `SharedScheduleView.tsx`); `MatchupSummary.tsx` already wrapped correctly. No truncation/ellipsis - full names stay readable. CSS-only, no test changes (199).
- **In-progress season no longer drives its own avoidance** (commit `310d5c0`). Save & Share records the current season into `history` so a next-year "Restore from link" already has it in the avoidance window. But mid-session, when the user clicked Regenerate (or went Back to Step 2 and generated again), the schedule year still equaled that just-recorded season's year, so `buildAvoidMap` treated the current season as a prior season - making the regenerated schedule avoid itself, drift onto the wrong prior seasons, and (for formats with a non-zero hard lookback) forcing this season's doubles to be disjoint from the set just shared. Fix: a new `priorSeasons(history, year)` helper scopes avoidance to seasons strictly before the year being scheduled; the full `history` still drives the Season History list, Add Past Season used-years, and lookback-window sizing. 5 new tests (199 total).
- **Duplicate current-season history row on re-save** (commit `8349228`). Regenerate resets the `saved` flag, so a second Save & Share re-ran the first-save branch and appended a _second_ `history` row for the same calendar year; the duplicate landed in both localStorage and the share payload and survived a next-year restore, double-counting the season in the avoidance window. Fix: the save path now upserts by season label (drop any existing current-year row, then append the new entry) so there's always exactly one row for the current season, reflecting the most recently shared schedule. Safe because the current year can only enter `history` via Save & Share - Add Past Season only offers years up to `CURRENT_YEAR - 1`.
- **League pickers returned leagues in API response order** (commits `92e81e6`, `1bf3165`). Both import pickers showed leagues in whatever order the upstream API returned them. Yahoo's `parseLeaguesList` walks the ascending `NFL_SEASONS` param and its by-name dedup preserved each name's first-seen position, so older seasons sorted above newer ones; it now sorts season descending, then name ascending as a tiebreaker, so the most recent league surfaces first across its seven-season window. Sleeper's `fetchUserLeaguesForYear` resolves a single season (current year, falling back to prior), so every entry shares one season string with no recency to sort by; it now sorts alphabetically by name. Both use numeric-aware `localeCompare` per the codebase convention. The `length === 1` auto-select path in StepImport is unaffected. Parsers are module-scoped with no existing coverage, so no tests added (204).
- **Lookback Window control over-counted seasons for young leagues** (commit `e3473d9`). The Step 2 control sized its window total, dropdown options, and visibility off `history.length`, which counts the in-progress season once Save & Share has recorded it. Avoidance itself runs off `priorSeasons`, so a league with fewer than the recommended number of seasons saw a count one too high (e.g. "2 hard seasons" when only one prior season drove avoidance), a current-season-only history showed "1 hard season" over an empty avoid set, and the count contradicted the Phase 15 per-opponent year tags. This revisits the deliberate carve-out from `310d5c0` (which left lookback sizing on full history): the control now sizes off a `priorSeasonCount` (history minus the in-progress season) threaded from page.tsx into StepReview, so a current-season-only history hides the control like an empty one. The Season History list and Add Past Season used-years still count the full history. Schedule-neutral - avoidance already ran off `priorSeasons` - so no algorithm or test changes (199).
- **Footer pinned to the viewport bottom on short-content views** (commit `8a30eca`). On pages where the content didn't fill the screen, the footer ("Report a bug · Buy me a coffee") floated mid-page directly below the content instead of anchoring to the bottom. Fix: the outer page wrapper became a `min-h-screen flex flex-col` column and the footer swapped `mt-4` for `mt-auto pt-7`, so it absorbs the remaining vertical space while keeping a fixed gap above it. The same footer + pinning was then extended from `app/page.tsx` to the four secondary page-level views that previously had no footer at all - the shared schedule page (`app/s/[slug]/page.tsx`, including its expired/not-found branch), the homepage and share-page error boundaries (`app/error.tsx`, `app/s/[slug]/error.tsx`), and the 404 page (`app/not-found.tsx`) - so every route carries the same footer anchored to the bottom. Two follow-ups: on `app/page.tsx` the flex-col made the step cards change width between steps on mobile (cards were stretching to the flex cross-axis), so everything above the footer was wrapped in a `<div className="flex-1">` to restore block-level layout for the content while the wrapper still pushes the footer down (the fixed-position tooltip stays outside the wrapper). And the footer markup was extracted into a shared `Footer` component (`app/components/Footer.tsx`) used by all five views, so the GitHub Issues / Buy Me a Coffee URLs live in one place. CSS/markup + refactor only, no test changes (204).
- **Season History year column aligned with a fixed minimum width** (commits `f4c69d6`, `d83a433`, then this fix). In the Step 2 Season History list, the trailing HARD AVOID / SOFT AVOID / ROTATED OUT label didn't line up vertically because Inter's proportional figures made years with a narrow leading/trailing digit (e.g. a "1") a pixel or two narrower than others. First attempt added `tabular-nums` (commit `f4c69d6`), but Inter's tabular figures pad each digit to a uniform advance and the extra side-bearing lands mostly on the leading digit, so years like "2021" read as having a space in front - reverted. Final fix: `min-w-[2.25rem]` on the year `<strong>` reserves a uniform column so the labels align across rows without altering any digit glyphs. (Do not reintroduce `tabular-nums` here - the side-bearing artifact is inherent to Inter's tabular figures.) CSS-only, no test changes (204).

- **Reimport could duplicate a season year and scramble history order** (commits `8eec82c`, `09a02ef`). `handleApplyImport` merged imported seasons into existing `history` with only an exact-duplicate check (same year AND identical sorted doubles), so an existing row with the same year but different doubles - a manually edited season, a Save & Share row whose generated doubles differ from the actually played ones, or an index-format manual row vs a userid-format import of the same year - gained a second row for that year. The merged array was also never re-sorted: imported seasons (oldest-first) were appended after existing rows, so a manually-added 2024 followed by an import of 2021-2025 produced [2024, 2021, 2022, 2023, 2024, 2025]. `buildAvoidMap` ages entries by array index, so a duplicated year double-counts that season and an out-of-order row shifts every season's hard/soft assignment. Fix: the merge was extracted into a pure `mergeImportedHistory(existing, imported)` helper (utils.ts) that upserts by year - imported rows replace any existing same-year row, consistent with the "fresh imported data always wins" principle and the Save & Share one-row-per-season invariant - then re-sorts ascending by numeric year with the same comparator as Add Past Season. The in-progress current season can't collide because imports only return completed seasons. The underlying `normalizeHistory` (dedup keep-last + chronological sort) also runs over localStorage hydration and link restore, self-healing stored payloads and share links that already carry duplicate-year or out-of-order rows. 8 new tests (212).

### Superseded files removed

- `fetch-sleeper.js` - replaced by `/api/import/sleeper` server-side route
- `prototype.jsx` - replaced by `app/page.tsx`
- Sleeper JSON paste fallback - removed, server-side route eliminates the need
- Manual format selector - removed, replaced by auto-detection from import data
- Schedule text paste - removed - impractical for multi-season history data
- `.eslintrc.json` - replaced by `eslint.config.mjs` (ESLint 9 flat config) when Next 16 removed `next lint` and the lint step moved to direct ESLint invocation in CI (commit `1deb019`)
- `@vercel/kv` dependency - replaced by `@upstash/redis`; Vercel KV was deprecated, so share-link storage was migrated to Upstash Redis (commit `397ad61`). Reads/writes are wire-compatible, no payload migration needed.

### Investigated and deferred

- **Platform write APIs for schedule input:** No write APIs exist on Sleeper, ESPN, or Yahoo. Headless browser automation (Puppeteer/Playwright) would require storing credentials, break on UI changes, and create unsustainable support burden - all to save ~10 minutes of annual manual entry. Not worth building.
- **NFL.com integration:** No public API. The only viable read path is cookie-based scraping that requires the user to copy session cookies from Chrome DevTools - a flow most commissioners won't get through. Manual entry covers NFL.com users with a small upfront cost.
- **CBS integration:** Has a deprecated XML API with username/password auth (no OAuth), and demand from the Reddit launch was effectively zero (1 comment across all 5 subreddits). Not worth the credential-handling surface area when Manual entry covers the case.
- **FleaFlicker, Fantrax, MFL, and other niche platforms:** Combined active user base across all of them is small compared to Sleeper/ESPN/Yahoo, and each would need its own auth model, season-history walker, and ongoing maintenance. Manual entry covers all of them at zero per-platform cost.
