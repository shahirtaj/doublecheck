# DoubleCheck

Fair rotational schedules for fantasy football leagues.
Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS 3, Inter (sans) + Inconsolata (mono) via `next/font/google`.

## Bash commands

- `npm run dev` - start dev server
- `npm run build` - production build
- `npm run typecheck` - TypeScript check
- `npm run lint` - ESLint (flat config in `eslint.config.mjs`)
- `npm test` - Vitest (279 tests)
- `npm run test:watch` - Vitest in watch mode

## Project structure

- `app/page.tsx` - homepage (client component, shared state via useReducer)
- `app/components/` - StepImport, StepReview, StepSchedule, state, types, utils, styles, constants
- `app/s/[slug]/` - shared schedule view (server component reads from Upstash Redis)
- `app/api/import/` - Sleeper, ESPN, Yahoo import routes
- `app/api/auth/yahoo/` - Yahoo OAuth 2.0 flow
- `app/api/share/` - share link creation and retrieval
- `lib/algorithm/` - scheduling algorithm (format, schedule, matching, avoid, pair, types)
- `lib/api/` - rate limiting, Yahoo token encryption
- `app/components/MatchupSummary.tsx`, `app/components/ScheduleHeading.tsx`, and `buildScheduleText` in `app/components/utils.ts` are shared between StepSchedule and SharedScheduleView; update once for both views. ScheduleHeading renders the schedule `<h2>` (each view passes its own size/color/margin class); buildScheduleText builds the copied plain-text export (each view passes its own heading prefix).
- `app/components/Footer.tsx` is the shared site footer used by every page-level view (`app/page.tsx`, `app/s/[slug]/page.tsx`, both `error.tsx`, `not-found.tsx`). Each view wraps its content in `min-h-dvh flex flex-col` so the footer's `mt-auto` pins it to the viewport bottom on short content (`dvh`, not `screen`/`vh`, so the pin tracks the visible viewport on mobile Safari instead of landing behind the browser chrome) - keep that wrapper class if you touch a page's layout. `app/page.tsx` additionally needs a `flex-1` content wrapper (see the inline note there before removing it).
- `@/*` path alias maps to the project root (configured in `tsconfig.json`), so `@/lib/algorithm` resolves to `./lib/algorithm`

## Code style

- ES modules (import/export), never CommonJS
- Destructure imports when possible
- `localeCompare` with `{ numeric: true }` for all user-facing sorts
- Team indices are assigned once at import time (alphabetical sort) and never reassigned
- User IDs stored as platform-specific identifiers (Sleeper user_id, ESPN primaryOwner, Yahoo manager GUID)
- `PairKey` is typed as `string` but semantically always `"i-j"` (lower index first). Always use `pairKey(i, j)` to construct and `unpackPairKey(key)` to destructure - never build the string manually.
- Named exports for all non-page files. Default exports only where Next.js requires them (page.tsx, layout.tsx, error.tsx, not-found.tsx).
- Weeks are 1-indexed in the algorithm, UI labels, and `RivalryPlacement.placedWeek`. The `schedule.weeks` array is 0-indexed. Convert with `weeks[W - 1]` when going from algorithm week to array access.

## Testing

- Algorithm tests are in `lib/algorithm/schedule.test.ts`
- API route logic tests are colocated with the routes (`app/api/**/*.test.ts`). The testable logic lives in sibling modules (`seasons.ts`, `chain.ts`, `validate.ts`) because Next.js route files may only export route handlers - put new route logic there, not inline in `route.ts`. `vitest.config.ts` maps the `@/*` alias for these tests.
- Tests use deterministic Mulberry32 PRNG seeded per test case
- All 7 supported formats have full constraint coverage
- Run tests after any change to `lib/algorithm/`
- Tests are fully deterministic - each test case seeds a Mulberry32 PRNG so results are reproducible. No flakiness; if tests pass once, they pass every time. Always run `npm test` after any change.

## Git commit standards

See `git-commit-standards.md` for the full standard. Summary:

- Conventional Commits: `type(scope): Subject`
- Imperative mood, aim for 50 chars, hard limit 72
- One logical change per commit (atomic commits)
- Enforced by commitlint (local husky hook + CI)

## Deployment

- Vercel, auto-deploy from `main`
- Environment variables in `.env.example`
- Upstash Redis for share links (no database otherwise)
- Yahoo OAuth tokens stored in encrypted httpOnly cookie

## Common change patterns

- **Adding a field to the share payload:** Update four files - `StepSchedule.tsx` (serialize it), `app/api/share/route.ts` (validate it), `app/s/[slug]/page.tsx` (type guard + pass as prop), and `SharedScheduleView.tsx` (render it). New fields must be optional with a fallback for backward compatibility with older share links that predate the field.
- **Adding a field to State:** Add a default in `initialState` (state.ts). If the field is persisted (part of the `saveToStorage` payload), also add defensive hydration in the `useEffect` localStorage reader in `page.tsx` - returning users will have saved payloads without the new field. Ephemeral UI flags (e.g. `confirmReset`, `pinJustAdded`, the `confirm*` flags, hover state) aren't persisted, so the `initialState` default is enough - skip hydration.
- **Adding an import fetch helper (StepImport.tsx):** Define a `stale()` closure at entry (compare `platformRef.current`/`importSourceRef.current` against the platform/source the request was started for - both refs live in page.tsx) and bail after every await and at the top of the catch block. In-flight responses must never patch the shared `importStatus`/`importMsg`/`importPreview`/`linkPreview` fields after the user switches the dropdown. The platform check alone is not enough: switching to "Restore from link" deliberately leaves `platform` unchanged, so the source check is what protects the link flow. The flip side: any code that lands the user on a platform programmatically (e.g. the Yahoo OAuth return effect in page.tsx) must patch `importSource` alongside `platform`, or the guards will discard that platform's own responses and the UI hangs on its loading status.
- **Adding a destructive action (delete/clear/remove/reset):** Gate it behind a two-step inline confirm backed by an ephemeral `confirm*` State flag (boolean, or `number | null` index for per-row actions in a list - e.g. `confirmReset`, `confirmDeleteSeasonIndex`). The trigger is red (`outlineRed`); arming it shows a `"<Action>? Can't be undone."` warning plus a red confirm + Cancel built from the shared `cls` atoms - `dangerBtn`/`cancelBtn` for section buttons (`navBtn` size), or `rowDangerBtn`/`rowCancelBtn`/`rowOutlineRed` for compact list-row buttons. These `confirm*` flags are ephemeral (see above), so no persistence.

## History / avoidance invariants

Save & Share records the _current_ season into `history` so a next-year "Restore from link" already has it in the avoidance window. Three invariants keep history trustworthy - don't break any of them:

- **Avoidance and the lookback control are scoped to prior seasons.** Compute the avoidance set from `priorSeasons(history, scheduleYear)` (utils.ts), never the full `history`. Mid-session the schedule year equals the just-recorded season's year, so feeding the full history would make the schedule avoid itself. The Step 2 Lookback Window control sizes its window total, dropdown options, and visibility off the same prior-season count (`priorSeasonCount`, threaded from page.tsx into StepReview) so the displayed window never claims more seasons than actually drive avoidance. Only the Season History list and the Add Past Season used-years count the full `history` (they intentionally include the in-progress season).
- **Exactly one row per season in `history`, in chronological order.** Save & Share upserts by season label (filter out any existing row for that year, then append the new entry) rather than appending. `saved` resets on Regenerate, so a plain append would write a second same-year row that survives into localStorage, the share payload, and a next-year restore - double-counting the season. Safe to filter current-year rows because the current year only ever enters `history` via Save & Share (Add Past Season caps at `CURRENT_YEAR - 1`). The import path maintains the same invariant via `mergeImportedHistory` (utils.ts): on reimport, imported rows replace any existing row for the same year (fresh imported data wins over manual edits and Save & Share rows), then the merged array is re-sorted ascending by numeric year - `buildAvoidMap` ages entries by array index, so a duplicated or out-of-order year corrupts the avoidance window. A Save & Share row for the in-progress season may be replaced by the merge - Yahoo and ESPN only return completed seasons, but a mid-season Sleeper import includes the current year - which is fine: the upsert keeps one row, and `priorSeasons` keeps the current year out of avoidance. localStorage hydration (page.tsx) and link restore run `normalizeHistory` (dedup keep-last + chronological sort) to self-heal stored payloads that predate this.
- **History must be contiguous, anchored at the newest season.** Positional aging is only meaningful over a gap-free run ending at the newest season: a missing year makes every older season read one age younger than reality, and the missing season's doubled pairs carry zero avoidance cost - the optimizer treats them as clean candidates for doubling. Truncated-but-contiguous history is strictly trustworthy (same semantics, shorter window); gapped history lies. "Contiguous" means no holes from LOST data - a season that was attempted but didn't make it into history, whether the fetch failed or the client's format filter dropped it for a different roster size. A league that genuinely skipped a calendar year is fine: aging is positional, the skipped year was never a season, and it must not be "fixed" (client-side year arithmetic would wrongly truncate such leagues - only attempted-but-missing years count as gaps). The Sleeper and ESPN routes re-attempt failed season fetches once and report persistent failures as `{ seasons, failed: [{ season, error }] }` (full success stays a bare array - `Array.isArray` is the client's discriminator). The shared client landing path (`previewFetchedSeasons` in StepImport.tsx, decision logic in `withholdPreGapSeasons` in utils.ts) unions fetch-failed years with roster-filtered years (`filterToDetectedFormat` drops seasons whose team count differs from the newest season's - e.g. a 12 -> 10 -> 12 league loses the 10-team middle years) into one cause-blind withholding decision: imported seasons older than the newest gap not already filled by an existing history row are withheld (a format change drops history at merge time, so existing rows can't fill gaps then). Messaging is cause-specific because the remedies differ - retry can recover a failed fetch, never a different-sized season (the remedy there is Add Past Season for the gap year, marking doubles among current teams, then re-import - advertised only when the Add Past Season year dropdown can actually offer that year). The import errors out when the newest attempted season itself failed; detection anchors on the newest season, so the roster filter can never drop it. The Yahoo route's sequential renew-chain walk can't report per-season failures, so it truncates instead: any mid-chain failure stops the walk and returns the contiguous newer run.
