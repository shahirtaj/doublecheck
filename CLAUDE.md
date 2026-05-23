# DoubleCheck

Fair rotational schedules for fantasy football leagues.
Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS 3.

## Bash commands

- `npm run dev` — start dev server
- `npm run build` — production build
- `npm run typecheck` — TypeScript check
- `npm run lint` — ESLint (flat config in `eslint.config.mjs`)
- `npm test` — Vitest (149 tests)
- `npm run test:watch` — Vitest in watch mode

## Project structure

- `app/page.tsx` — homepage (client component, shared state via useReducer)
- `app/components/` — StepImport, StepReview, StepSchedule, state, types, utils, styles, constants
- `app/s/[slug]/` — shared schedule view (server component reads from Upstash Redis)
- `app/api/import/` — Sleeper, ESPN, Yahoo import routes
- `app/api/auth/yahoo/` — Yahoo OAuth 2.0 flow
- `app/api/share/` — share link creation and retrieval
- `lib/algorithm/` — scheduling algorithm (format, schedule, matching, avoid, pair, types)
- `lib/api/` — rate limiting, Yahoo token encryption

## Code style

- ES modules (import/export), never CommonJS
- Destructure imports when possible
- `localeCompare` with `{ numeric: true }` for all user-facing sorts
- Team indices are assigned once at import time (alphabetical sort) and never reassigned
- User IDs stored as platform-specific identifiers (Sleeper user_id, ESPN primaryOwner, Yahoo manager GUID)

## Testing

- Algorithm tests are in `lib/algorithm/schedule.test.ts`
- Tests use deterministic Mulberry32 PRNG seeded per test case
- All 7 supported formats have full constraint coverage
- Run tests after any change to `lib/algorithm/`

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
