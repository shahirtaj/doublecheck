# DoubleCheck

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)

Fair schedules for fantasy football leagues. No team gets doubled against the same opponent year after year.

---

## The problem

In a 12-team, 14-week fantasy football league, every team plays 3 opponents twice and 8 once. Random scheduling clusters those repeat matchups: some pairs get doubled multiple seasons in a row, others never. With 66 possible pairs across the league, ~4 will draw the short straw in any given season.

Across four seasons of random schedules, the probability that a *specific* pair gets doubled in 3+ seasons is ~6.5% - but multiplied across the league, somebody is almost always living it.

## The math

In a 12-team / 14-week league each team doubles **3 of 11** opponents. Over four seasons that's 12 doubled-opponent slots competing for 11 unique opponents, which means:

- **Every opponent gets doubled exactly once** in a four-season cycle, plus
- **~6 forced repeats** drawn from the oldest no-longer-avoided season (12 teams × 1 forced repeat ÷ 2).

The tool generates each year's doubles to satisfy that rotation, with the lookback window derived per format (see below). Every doubled pair plays in week 1–3 *and* in week 12–14, giving the maximum-possible 11-week gap between the two meetings.

## Supported formats

| Format | Doubles/team | Singles/team | Rotation cycle | Notes |
|--------|--------------|--------------|----------------|-------|
| 8 / 13 | 6 | 1 | ~7 years | Inverted problem (who do you NOT double) |
| 10 / 13 | 4 | 5 | ~3 years | |
| 10 / 14 | 5 | 4 | ~2 years | |
| 12 / 13 | 2 | 9 | ~6 years | |
| 12 / 14 | 3 | 8 | ~4 years | Most common league shape |
| 14 / 14 | 1 | 12 | ~13 years | Minimal impact |
| 14 / 15 | 2 | 11 | ~7 years | |

Pure round-robins (e.g. 14-team / 13-week) and complete double round-robins (e.g. 8-team / 14-week) have no fairness problem - the tool detects these and tells you no schedule is needed. Odd-sized and 16+ team leagues are out of scope.

## The algorithm

- **Maximum separation.** Doubled pairs play in the first N and last N weeks (N = doubles per team). For 12/14 that's weeks 1–3 and 12–14 - an 11-week gap between the two meetings.
- **Per-format lookback window.** The lookback is computed per format to maximize rotation coverage. Recent seasons are hard-avoided (cannot repeat), with the next oldest soft-avoided (preferred to skip but allowed when the constraint set is too tight).
- **Identity tracking via user IDs.** Doubled pairs are stored by Sleeper / ESPN user ID, not team name. The schedule survives team renames, manager changes, and roster reshuffles between seasons.

## Supported platforms

- **Sleeper** - fully public API, paste your league ID and you're done.
- **ESPN** - public leagues by league ID. Private league support follows ESPN's undocumented API quirks.
- **Yahoo** - sign in with Yahoo (OAuth 2.0). Tokens are stored in an encrypted httpOnly cookie - no database, no account needed.

## Quick start

1. Visit [DoubleCheck](https://doublecheckff.com).
2. Pick your platform and enter your league ID.
3. Review the avoidance matrix and generate this year's schedule.
4. Save the season - its doubles automatically feed next year's lookback.
5. Click **Share** to get a read-only `/s/{slug}` link your league members can open from any device. Links expire after 365 days; re-share to refresh.

## Tech stack

- **Next.js 14** (App Router) with TypeScript
- **Tailwind CSS** for styling
- **Vitest** for the algorithm test suite (92 tests across 7 supported formats)
- **Vercel** for deployment

See [ROADMAP.md](ROADMAP.md) for the full product roadmap and current state.

## Support

If DoubleCheck saves your league from unfair schedules, [buy me a coffee](https://buymeacoffee.com/shahirtaj).

## License

MIT - see [LICENSE](LICENSE).
