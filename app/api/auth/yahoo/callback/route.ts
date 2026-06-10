// Yahoo OAuth callback. Validates the CSRF state cookie against the state
// Yahoo echoes back, exchanges the auth code for tokens, encrypts them, drops
// them into an httpOnly cookie, and bounces the user back to the homepage with
// a hint param the UI uses to auto-fetch leagues.

import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";
import {
  encryptTokens,
  exchangeAuthCode,
  refreshAccessToken,
  type YahooTokens,
} from "@/lib/api/yahoo-tokens";

export const runtime = "nodejs";

const STATE_COOKIE = "yahoo_oauth_state";
const TOKEN_COOKIE = "yahoo_tokens";
const TOKEN_MAX_AGE = 60 * 60 * 24 * 30;
// Sized for carrier CGNAT, not individual users: traffic is ~80% mobile, so
// a launch spike can put several legitimate sign-ins behind one carrier IP
// in the same minute. The long window tolerates that burst (~30 full flows
// per IP per peak minute) while the sustained per-IP rate stays below the
// 10/min default (360/hr vs 600/hr) - the amplification concern is
// sustained volume, not one burst. Keep in sync with the start route; both
// share the namespace.
const OAUTH_RATE_LIMIT = {
  namespace: "yahoo-oauth",
  windowMs: 10 * 60_000,
  max: 60,
};

function getRedirectUri(): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL || "https://doublecheckff.com";
  return `${base.replace(/\/$/, "")}/api/auth/yahoo/callback`;
}

function getHomeUrl(req: Request, params: Record<string, string>): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL || new URL(req.url).origin;
  const url = new URL("/", base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function setTokenCookie(res: NextResponse, tokens: YahooTokens) {
  res.cookies.set(TOKEN_COOKIE, encryptTokens(tokens), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TOKEN_MAX_AGE,
  });
}

function clearStateCookie(res: NextResponse) {
  res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
}

export async function GET(req: Request) {
  // Unthrottled, every bogus ?code= hit would trigger a server-side token
  // exchange POST to Yahoo with the app's client credentials - outbound
  // amplification that risks Yahoo throttling the app's client ID. This
  // route only ever answers with redirects, so the rate-limit response is
  // the same in-app error surface as the other failure paths.
  const rl = await checkRateLimit(getClientIp(req), OAUTH_RATE_LIMIT);
  if (!rl.ok) {
    const res = NextResponse.redirect(
      getHomeUrl(req, { yahoo: "error", reason: "rate_limited" }),
    );
    clearStateCookie(res);
    return res;
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    const res = NextResponse.redirect(
      getHomeUrl(req, { yahoo: "error", reason: oauthError }),
    );
    clearStateCookie(res);
    return res;
  }

  if (!code || !state) {
    const res = NextResponse.redirect(
      getHomeUrl(req, { yahoo: "error", reason: "missing_params" }),
    );
    clearStateCookie(res);
    return res;
  }

  const storedState = readCookie(req, STATE_COOKIE);
  if (!storedState || storedState !== state) {
    const res = NextResponse.redirect(
      getHomeUrl(req, { yahoo: "error", reason: "state_mismatch" }),
    );
    clearStateCookie(res);
    return res;
  }

  let tokens: YahooTokens;
  try {
    tokens = await exchangeAuthCode(code, getRedirectUri());
  } catch (e) {
    const reason = (e as Error).message || "token_exchange_failed";
    const res = NextResponse.redirect(
      getHomeUrl(req, { yahoo: "error", reason }),
    );
    clearStateCookie(res);
    return res;
  }

  // Defensive: if Yahoo's expires_in put us at or near zero (rare clock-skew
  // case), refresh before storing so the UI's first call doesn't 401.
  if (Date.now() >= tokens.expiresAt - 60_000) {
    try {
      tokens = await refreshAccessToken(tokens.refreshToken);
    } catch (e) {
      const reason = (e as Error).message || "token_refresh_failed";
      const res = NextResponse.redirect(
        getHomeUrl(req, { yahoo: "error", reason }),
      );
      clearStateCookie(res);
      return res;
    }
  }

  const res = NextResponse.redirect(getHomeUrl(req, { yahoo: "connected" }));
  setTokenCookie(res, tokens);
  clearStateCookie(res);
  return res;
}
