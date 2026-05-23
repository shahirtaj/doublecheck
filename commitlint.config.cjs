module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Subject line: aim for 50, hard limit at 72.
    // Conventional Commits prefixes eat 15-20 chars, so 50 causes
    // constant false positives on real commit messages.
    "header-max-length": [2, "always", 72],
    // Warning, not error: strict sentence-case rejects valid
    // acronyms and proper nouns (OAuth2, PKCE, API, Redis, etc.)
    "subject-case": [1, "always", "sentence-case"],
    "subject-full-stop": [2, "never", "."],
    "subject-empty": [2, "never"],

    // Type
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "refactor",
        "docs",
        "test",
        "chore",
        "style",
        "perf",
        "ci",
        "build",
        "revert",
      ],
    ],
    "type-case": [2, "always", "lower-case"],
    "type-empty": [2, "never"],

    // Scope
    "scope-case": [2, "always", "lower-case"],

    // Body
    "body-max-line-length": [2, "always", 72],
    "body-leading-blank": [2, "always"],

    // Footer
    "footer-leading-blank": [2, "always"],
    "footer-max-line-length": [2, "always", 72],
  },
};
