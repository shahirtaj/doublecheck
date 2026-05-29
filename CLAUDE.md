# DoubleCheck

Fair rotational schedules for fantasy football leagues.
Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS 3, Inter (sans) + Inconsolata (mono) via `next/font/google`.

## Bash commands

- `npm run dev` - start dev server
- `npm run build` - production build
- `npm run typecheck` - TypeScript check
- `npm run lint` - ESLint (flat config in `eslint.config.mjs`)
- `npm test` - Vitest (194 tests)
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
- `app/components/MatchupSummary.tsx` - shared between StepSchedule and SharedScheduleView; update once for both views
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
- **Adding a destructive action (delete/clear/remove/reset):** Gate it behind a two-step inline confirm backed by an ephemeral `confirm*` State flag (boolean, or `number | null` index for per-row actions in a list - e.g. `confirmReset`, `confirmDeleteSeasonIndex`). The trigger is red (`outlineRed`); arming it shows a `"<Action>? Can't be undone."` warning plus a red confirm + Cancel built from the shared `cls` atoms - `dangerBtn`/`cancelBtn` for section buttons (`navBtn` size), or `rowDangerBtn`/`rowCancelBtn`/`rowOutlineRed` for compact list-row buttons. These `confirm*` flags are ephemeral (see above), so no persistence.
