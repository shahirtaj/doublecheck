# DoubleCheck — Product Blueprint

## What it is

A web tool that generates fair rotational schedules for fantasy football leagues. It ensures no team is doubled against the same opponent in consecutive seasons, with mathematically optimal spacing between rematches.

---

## The Problem

In a 12-team, 14-week fantasy football league, each team plays 3 opponents twice and 8 once. With random scheduling, some pairs get doubled year after year — creating a measurable competitive imbalance. The probability that any specific pair repeats across 3+ of 4 seasons is ~6.5%, but with 66 total pairs, ~4 pairs will experience this in any league. It's a near-certainty someone is getting a raw deal.

---

## The Algorithm

- Weeks 1–3: doubled opponents (first game)
- Weeks 4–(N-3): single opponents (shuffled)
- Weeks (N-2)–N: doubled opponents (rematch, same order as weeks 1–3)
- Every doubled pair gets maximum separation (11 weeks for 14-week seasons)
- 3-year lookback: hard-avoid last 2 seasons, soft-avoid 3rd season (~6 forced repeats from oldest)
- Full rotation cycle: ~4 years for 12-team/14-week (every opponent doubled exactly once)
- Identity tracking via Sleeper user IDs (survives name changes, team name changes, roster position changes)

---

## Supported Formats

| Format | Doubles/team | Singles/team | Rotation cycle | Notes |
|--------|-------------|-------------|----------------|-------|
| 8 / 13 | 6 | 1 | ~7 years | Inverted problem (who do you NOT double) |
| 10 / 13 | 4 | 5 | ~3 years | |
| 10 / 14 | 5 | 4 | ~2 years | |
| 12 / 13 | 2 | 9 | ~6 years | |
| 12 / 14 | 3 | 8 | ~4 years | Current working version |
| 14 / 14 | 1 | 12 | ~13 years | Minimal impact, tool should be transparent |
| 14 / 15 | 2 | 11 | ~7 years | |

Formats with zero doubles (e.g., 14-team / 13-week) are pure round-robins — the tool should detect these and tell the user no schedule is needed.

Formats with complete double round-robins (e.g., 8-team / 14-week) also have no fairness problem — the tool should detect and communicate this.

Odd-number leagues and 16+ team leagues are out of scope.

---

## Platform Landscape

| Platform | Users | API | Auth | Notes |
|----------|-------|-----|------|-------|
| ESPN | ~13M | Undocumented, fragile | Cookies (espn_s2 + SWID) for private leagues | Endpoints change without notice |
| Yahoo | ~5-10M | Official, OAuth 2.0 | Developer app registration required | Most friction, cleanest long-term |
| Sleeper | Fastest growing | Fully public, free | None | Best integration story |
| NFL.com | Small | None | N/A | Paste-and-parse only |
| CBS | Small | None | N/A | Paste-and-parse only |
| Fantrax | Niche | Unknown | Unknown | Research needed |

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | Next.js 14 (App Router) | SSR for SEO landing page, API routes for proxy, React for app |
| Language | TypeScript | Type safety for the algorithm and API integrations |
| Styling | Tailwind CSS | Standard for Next.js, rapid responsive development |
| Deployment | Vercel | Native Next.js support, serverless functions, free tier |
| Database (v2) | Supabase (Postgres) | Auth + DB in one, free tier covers launch |
| Auth (v2) | Supabase Auth (Google sign-in) | Most fantasy players have Google accounts |
| Analytics | Plausible or Umami | Privacy-friendly, free self-hosted |
| Testing | Vitest | Fast, TypeScript-native |
| License | MIT | Maximizes credibility, community signal |

v1 launches with localStorage. Supabase added when shareable links justify the complexity.

---

## Phases

### Phase 1: Generalize the Algorithm
**Tool: Claude Code**

Parameterize the core algorithm by `(teamCount, weekCount)`. For each supported format: derive double counts, compute rotation cycle length, determine optimal lookback window, calculate spacing constraints, prove decomposition is solvable. Handle edge cases (zero-double formats, complete round-robins, inverted problems like 8/13).

**Deliverable:** TypeScript algorithm module (`lib/algorithm/`) with Vitest tests proving constraints hold for all 7 supported formats.

---

### Phase 2: Next.js Project
**Tool: Claude Code**

Initialize Next.js 14 App Router project. Codebase structure:

```
lib/
  algorithm/     — pure math, no dependencies
  platforms/     — Sleeper/ESPN/Yahoo fetchers
app/
  page.tsx       — landing page (Phase 6)
  generate/      — the tool UI
  api/
    import/      — platform proxy routes
```

Port current React artifact into this structure. Responsive from day one — matrix grid and week navigator need mobile layouts. No database yet — localStorage for persistence.

**Deliverable:** Local dev environment running the full app with generalized algorithm.

---

### Phase 3: Platform Integrations
**Tool: Claude Code**

Server-side API routes that eliminate CORS, the Terminal script, and JSON pasting.

- **Sleeper** (`/api/import/sleeper`): Direct port of current fetch logic. User enters league ID, done.
- **ESPN** (`/api/import/espn`): Public leagues by league ID. Private leagues require user-provided espn_s2 and SWID cookies (with clear instructions). Build with graceful fallback to paste-and-parse since ESPN's API is undocumented and fragile.
- **Yahoo** (`/api/import/yahoo`): OAuth 2.0 flow. Register Yahoo Developer app, implement auth redirect. User clicks "Connect Yahoo," authorizes, app pulls their leagues.
- **NFL.com / CBS / Others**: Paste-and-parse with per-platform format hints.

**Deliverable:** Unified import UI — pick your platform, authenticate if needed, select your league.

---

### Phase 4: GitHub
**Tool: Claude Code**

Initialize repo. Write README that explains the fairness problem, the math, the rotation proof, and supported formats (doubles as SEO content for Phase 6). Add Vitest tests, GitHub Actions CI.

License: MIT.

**Deliverable:** Public repo with passing CI and a README that markets the tool.

---

### Phase 5: Deploy
**Tool: Vercel**

Next.js deploys natively on Vercel with zero config. API routes become serverless functions automatically. Set environment variables for Yahoo OAuth credentials. Free tier covers launch traffic.

**Action item:** Buy the domain for DoubleCheck before this phase. Do it early — before the Reddit post makes the name public.

**Deliverable:** Live URL.

---

### Phase 6: Landing Page + SEO
**Tool: Claude Code**

Root page (`/`) is a marketing/explainer page:
- The fairness problem in plain English
- Visual example of how doubles cluster under random scheduling
- The math behind the rotation
- Which formats benefit (and which don't need the tool)
- CTA to use the tool at `/generate`

Target keywords: "fantasy football schedule fairness," "fantasy football repeat matchups," "rotational scheduling fantasy football," "fantasy football schedule generator."

**Deliverable:** SEO-optimized landing page.

---

### Phase 6.5: Yahoo Integration
**Tool: Claude Code**

Yahoo's official Fantasy Sports API requires a registered developer app and a full OAuth 2.0 user-consent flow — substantially more friction than Sleeper or ESPN. Worth doing because Yahoo still hosts 5–10M fantasy players, but it carries an external dependency: Yahoo's developer-app approval process can take days.

Kick this off **after Phase 5 deploy** so the approval clock runs in parallel with Phase 6 SEO work.

- Register Yahoo Developer app (request "Fantasy Sports Read" scope)
- Implement `/api/auth/yahoo/start` and `/api/auth/yahoo/callback` redirect flow
- Encrypt and store the access/refresh tokens (server-side; not in localStorage)
- `/api/import/yahoo` route: list user's leagues, fetch matchups by league_key
- Surface a "Connect Yahoo" button in the generate page in place of the current "coming soon" placeholder

**Deliverable:** Yahoo league import with the same UX as Sleeper/ESPN.

---

### Phase 7: Auth + Database
**Tool: Claude Code**

Add Supabase: Google sign-in, Postgres for user data / league history / team names. Enables:
- Cross-device access (commissioner uses laptop at home, phone on draft day)
- Shareable read-only league links (the viral loop — 11 managers see the tool, some are commissioners in other leagues, they use it for theirs)

Post-launch. localStorage works for v1.

**Deliverable:** Persistent accounts, shareable league links.

---

### Phase 8: Reddit Launch
**Tool: Claude chat**

Two posts, different audiences:

**r/FFCommish** (~50K members): Commissioner-focused. Lead with the problem ("Has anyone noticed the same teams getting doubled year after year?"), explain the math, link the tool. This audience understands immediately.

**r/fantasyfootball** (~2M members): Broader audience. Lead with the unfairness angle ("Your league's schedule might be screwing you — here's the math"), make it accessible, link the tool.

**Timing:** Late July or early August, when commissioners are setting up leagues.

**Deliverable:** Two posts, ready to publish.

---

### Phase 9: Analytics + Rate Limiting
**Tool: Claude Code**

- Plausible or Umami from day one (add during Phase 5, listed here for clarity)
- IP-based rate limiting on `/api/import/*` routes
- Track: which platforms people use, which formats are most common, Reddit referral traffic

Data shapes what to prioritize post-launch.

---

## Priority Order

Phases 1–2 are the foundation. Phase 3 is the biggest UX win. Phases 4–5 get it live. Phase 6 makes it findable. Phases 7–8 make it grow. Phase 9 is infrastructure hygiene.

## Estimated Effort

2–3 weekends with Claude Code doing the heavy lifting.

---

## Current State

Phases 1–3 are complete:

- **Phase 1 — Generalized algorithm.** `lib/algorithm/` module covers all 7 supported formats with a `(teamCount, weekCount)` parameterization. 92 Vitest tests prove constraints (decomposability, separation, lookback feasibility, identity preservation) hold across every format.
- **Phase 2 — Next.js 14 App Router.** Prototype ported into `app/` with Tailwind CSS and a responsive UI (matrix grid scrolls horizontally on mobile, week navigator wraps). localStorage persistence; no database yet.
- **Phase 3 — Server-side platform integrations.** `app/api/import/sleeper` and `app/api/import/espn` walk the season-history chain, normalize doubled pairs into the shared `ImportedSeasonRecord` shape, and apply IP-based rate limiting via `lib/api/rate-limit.ts`. The generate page consumes both routes plus a JSON paste fallback.

### Post-Phase 3 follow-up

Add a lookback window override control in Step 2 (Review). After import, display "Using last N seasons (recommended for X-team / Y-week)" with a dropdown to override. Defaults to the format's lookback (hard + soft from `describeFormat`).
