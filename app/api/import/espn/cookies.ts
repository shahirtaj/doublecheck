// Validation for the user-supplied espn_s2 cookie that unlocks private ESPN
// leagues. The value is a full ESPN sign-in credential: it arrives in the
// POST body, becomes the outbound Cookie header on the lm-api-reads calls,
// and is never logged or stored. Lives in a sibling module (Next.js route
// files may only export route handlers) so the normalization is
// unit-testable.
//
// Only espn_s2 is needed: ESPN authorizes league reads on it alone (verified
// against a private league - SWID adds nothing, and SWID alone is refused).
// The browser stores the value percent-encoded and ESPN accepts both that
// and the decoded form, so the paste goes through untouched apart from the
// trimming below.

// Real values run ~300-400 characters; the bounds only reject obvious
// non-values (a stray word, a whole page).
export const ESPN_S2_MIN_LENGTH = 32;
export const ESPN_S2_MAX_LENGTH = 1024;

// Percent-encoded or decoded base64-ish text. Excludes everything that
// could break out of a Cookie header (";", ",", whitespace, quotes,
// backslash, control characters).
const ESPN_S2_CHARSET = /^[A-Za-z0-9%+/=._~-]+$/;

export const ESPN_S2_INVALID_MESSAGE =
  "That doesn't look like an espn_s2 value. Check that you copied the whole value from the cookie list.";

export type NormalizedEspnS2 =
  { ok: true; value: string | null } | { ok: false; error: string };

function stripWrappingQuotes(s: string): string {
  const m = /^(["'])(.*)\1$/s.exec(s);
  return m ? m[2]!.trim() : s;
}

// Reduces whatever the user pasted to the bare cookie value, or null when
// the field was left empty (a plain public-league import). Accepts the bare
// value, `espn_s2=<value>`, and a whole Cookie line (`espn_s2=<value>;
// SWID={...}` in either order) - DevTools offers all three shapes.
export function normalizeEspnS2(input: unknown): NormalizedEspnS2 {
  if (input == null) return { ok: true, value: null };
  if (typeof input !== "string") {
    return { ok: false, error: ESPN_S2_INVALID_MESSAGE };
  }
  let value = stripWrappingQuotes(input.trim());
  if (value.length === 0) return { ok: true, value: null };

  const named = /(?:^|[;\s])espn_s2\s*=\s*([^;\s]*)/i.exec(value);
  if (named) {
    value = stripWrappingQuotes(named[1]!.trim());
  }

  if (
    value.length < ESPN_S2_MIN_LENGTH ||
    value.length > ESPN_S2_MAX_LENGTH ||
    !ESPN_S2_CHARSET.test(value)
  ) {
    return { ok: false, error: ESPN_S2_INVALID_MESSAGE };
  }
  return { ok: true, value };
}

// The single place the outbound Cookie header is assembled from a validated
// value - keep it that way so the charset check above is the only thing
// between the paste and the header.
export function buildEspnCookieHeader(espnS2: string): string {
  return `espn_s2=${espnS2}`;
}
