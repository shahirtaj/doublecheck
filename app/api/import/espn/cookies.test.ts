import { describe, expect, it } from "vitest";
import {
  ESPN_S2_INVALID_MESSAGE,
  ESPN_S2_MAX_LENGTH,
  buildEspnCookieHeader,
  normalizeEspnS2,
} from "./cookies";

// Shaped like a real value: percent-encoded base64, ~350 characters.
const ENCODED = `AEB${"x9Qz".repeat(60)}%2Bab%2Fcd%3D%3D`;
const DECODED = `AEB${"x9Qz".repeat(60)}+ab/cd==`;

describe("normalizeEspnS2", () => {
  it("treats a missing or blank field as no cookie", () => {
    expect(normalizeEspnS2(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeEspnS2(null)).toEqual({ ok: true, value: null });
    expect(normalizeEspnS2("")).toEqual({ ok: true, value: null });
    expect(normalizeEspnS2("  \n ")).toEqual({ ok: true, value: null });
  });

  it("passes a bare value through untouched apart from trimming", () => {
    expect(normalizeEspnS2(`  ${ENCODED}\n`)).toEqual({
      ok: true,
      value: ENCODED,
    });
  });

  it("accepts the decoded form as-is - ESPN takes either encoding", () => {
    expect(normalizeEspnS2(DECODED)).toEqual({ ok: true, value: DECODED });
  });

  it("strips wrapping quotes", () => {
    expect(normalizeEspnS2(`"${ENCODED}"`)).toEqual({
      ok: true,
      value: ENCODED,
    });
    expect(normalizeEspnS2(`'${ENCODED}'`)).toEqual({
      ok: true,
      value: ENCODED,
    });
  });

  it("extracts the value from a name=value paste", () => {
    expect(normalizeEspnS2(`espn_s2=${ENCODED}`)).toEqual({
      ok: true,
      value: ENCODED,
    });
    expect(normalizeEspnS2(`ESPN_S2 = "${ENCODED}"`)).toEqual({
      ok: true,
      value: ENCODED,
    });
  });

  it("extracts the value from a whole Cookie line in either order", () => {
    const swid = "SWID={A6265C5F-DB69-4E8D-A65C-5FDB697E8D21}";
    expect(normalizeEspnS2(`espn_s2=${ENCODED}; ${swid}`)).toEqual({
      ok: true,
      value: ENCODED,
    });
    expect(normalizeEspnS2(`${swid}; espn_s2=${ENCODED}`)).toEqual({
      ok: true,
      value: ENCODED,
    });
    expect(normalizeEspnS2(`Cookie: espn_s2=${ENCODED}`)).toEqual({
      ok: true,
      value: ENCODED,
    });
  });

  it("rejects header-breaking characters", () => {
    for (const bad of [
      `${ENCODED};path=/`,
      `${ENCODED}\r\nX-Injected: 1`,
      `${ENCODED} ${ENCODED}`,
      `${ENCODED},${ENCODED}`,
      `${ENCODED}"`,
      `${ENCODED}\\`,
    ]) {
      expect(normalizeEspnS2(bad)).toEqual({
        ok: false,
        error: ESPN_S2_INVALID_MESSAGE,
      });
    }
  });

  it("rejects values outside the length bounds", () => {
    expect(normalizeEspnS2("tooshort")).toEqual({
      ok: false,
      error: ESPN_S2_INVALID_MESSAGE,
    });
    expect(normalizeEspnS2("A".repeat(ESPN_S2_MAX_LENGTH + 1))).toEqual({
      ok: false,
      error: ESPN_S2_INVALID_MESSAGE,
    });
    expect(normalizeEspnS2("A".repeat(ESPN_S2_MAX_LENGTH)).ok).toBe(true);
  });

  it("rejects a non-string field", () => {
    expect(normalizeEspnS2(42)).toEqual({
      ok: false,
      error: ESPN_S2_INVALID_MESSAGE,
    });
    expect(normalizeEspnS2({ value: ENCODED })).toEqual({
      ok: false,
      error: ESPN_S2_INVALID_MESSAGE,
    });
  });

  it("rejects a SWID-only paste - SWID alone doesn't authorize anything", () => {
    expect(
      normalizeEspnS2("SWID={A6265C5F-DB69-4E8D-A65C-5FDB697E8D21}"),
    ).toEqual({ ok: false, error: ESPN_S2_INVALID_MESSAGE });
  });
});

describe("buildEspnCookieHeader", () => {
  it("names the cookie and nothing else", () => {
    expect(buildEspnCookieHeader(ENCODED)).toBe(`espn_s2=${ENCODED}`);
  });
});
