# Git Commit Standards

## Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

## Types

- `feat` — new feature or capability
- `fix` — bug fix
- `refactor` — code change that neither fixes a bug nor adds a feature
- `docs` — documentation only
- `test` — adding or correcting tests
- `chore` — build process, dependencies, tooling
- `style` — formatting, whitespace, semicolons (no logic change)
- `perf` — performance improvement
- `ci` — CI/CD configuration
- `build` — build system or external dependency changes
- `revert` — reverts a previous commit

## Subject Line Rules

1. Complete the sentence: "If applied, this commit will \_\_\_"
2. Use imperative mood: "Add" not "Added" or "Adds"
3. Capitalize the first word after the type prefix
4. No period at the end
5. Aim for 50 characters including type and scope; hard limit is 72
6. Be specific: `fix(auth): Prevent token reuse after logout` not `fix: Fix bug`

## Body Rules

- Separate from subject with a blank line
- Wrap at 72 characters
- Explain WHAT changed and WHY, not HOW (the diff shows how)
- Use when the subject alone doesn't provide enough context
- Simple changes (typo fixes, renames) need no body
- For multi-paragraph bodies, separate points with blank lines
- Do not use bullet lists or markdown formatting in commit bodies

## Footer Rules

- Reference issues: `Fixes #42` or `Closes #17`
- Breaking changes: start with `BREAKING CHANGE: <description>`
- Co-authorship: `Co-authored-by: Name <email>`

## Scope

Use the module, component, or area of code affected.
Pick a scope name and keep it consistent — don't use `authentication`
in one commit and `auth` in another.

## Examples

Good:

```
feat(api): Add rate limiting to public endpoints

The /search and /export endpoints were unbounded, allowing a single
client to saturate the server. This adds a token bucket limiter at
100 req/min per API key.

Without this, a misbehaving client could degrade service for all
users, which happened twice last week in production.

Fixes #134
```

```
fix(db): Use advisory lock for migration runner

Two server instances were running migrations concurrently on deploy,
causing table-already-exists errors. An advisory lock ensures only
one instance runs migrations at a time.

Fixes #201
```

```
refactor(auth): Extract token validation into middleware
```

```
docs(readme): Add local development setup instructions
```

Bad:

```
updated stuff
```

No type, no scope, no imperative mood, no specificity.

```
fix: Fix the bug
```

Which bug? This tells a future reader nothing.

```
feat(auth): Add OAuth2 PKCE flow, update user model,
refactor session handling, and fix token expiry bug
```

This is four commits stuffed into one. Split it.

```
address PR feedback
```

Describe the actual changes, not the reason you're committing.

## Atomic Commits

- Each commit does exactly ONE logical thing
- The codebase builds and tests pass after every commit
- Never mix refactoring with behavior changes
- Never mix formatting or whitespace changes with logic changes
- Never mix dependency updates with code changes
- A commit should be revertible without unrelated side effects
- If you can't describe it in one subject line, split the commit

## Commit Workflow

- Commit after each completed task before starting the next
- Structure prompts to match atomic commit boundaries
- When staging, use `git add -p` to review hunks — never blind `git add .`
- If a task produced changes across unrelated concerns, split into
  multiple commits before moving on

## Branch Naming

Use the commit type as a prefix, then a short kebab-case description:

```
feat/oauth2-pkce-flow
fix/token-reuse-after-logout
refactor/extract-auth-middleware
chore/upgrade-node-22
```

## Merge Strategy

- Rebase feature branches onto main before merging
- Merge with `--no-ff` to preserve a merge commit marking where the
  feature landed
- Do not squash merge — squashing destroys the atomic commit history
- Delete the feature branch after merging

## AI Attribution

Claude Code appends co-authorship trailers to commits by default.
Keep this enabled. It provides a useful signal when reviewing history:
AI-generated code may carry assumptions worth verifying that a human
author wouldn't have made. The trailer also creates a transparent
audit trail for collaborators, contributors, and any future
compliance requirements.

To customize the trailer format, edit `.claude/settings.json`:

```json
{
  "attribution": {
    "commit": "Generated with Claude Code\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
    "pr": "Generated with Claude Code"
  }
}
```

## Enforcement

These rules are enforced by commitlint at two levels:

- **Locally**: a husky `commit-msg` hook rejects non-conforming messages
  before they enter the repository. Do not use `--no-verify` to bypass this.
- **CI**: the GitHub Actions workflow runs commitlint against all commits
  in a PR, so direct pushes or machines without the hook installed are
  still caught before merge.

## Anti-patterns

- `WIP` or `work in progress` — stash instead, or use a branch
- `misc fixes` or `various changes` — split into atomic commits
- `fix bug` without specifying which bug
- `update code` — what code, why
- `address review comments` — describe the actual changes made
- `oops` or `forgot this file` — amend the previous commit instead
- Mixing unrelated changes in a single commit
- Empty commit bodies on complex changes
