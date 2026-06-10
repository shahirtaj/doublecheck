// Yahoo OAuth 2.0 entry point. Generates a CSRF state token, stashes it in a
// short-lived httpOnly cookie, and redirects to Yahoo's authorization page.
// The callback route validates the cookie value against the state Yahoo echoes
// back to detect tampering.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";

export const runtime = "nodejs";

const YAHOO_AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const STATE_COOKIE = "yahoo_oauth_state";
const STATE_MAX_AGE = 600;
// Sized for carrier CGNAT, not individual users: traffic is ~80% mobile, so
// a launch spike can put several legitimate sign-ins behind one carrier IP
// in the same minute. The long window tolerates that burst (~30 full flows
// per IP per peak minute) while the sustained per-IP rate stays below the
// 10/min default (360/hr vs 600/hr) - the amplification concern is
// sustained volume, not one burst. Keep in sync with the callback route;
// both share the namespace.
const OAUTH_RATE_LIMIT = {
  namespace: "yahoo-oauth",
  windowMs: 10 * 60_000,
  max: 60,
};

function getRedirectUri(): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL || "https://doublecheckff.com";
  return `${base.replace(/\/$/, "")}/api/auth/yahoo/callback`;
}

export async function GET(req: Request) {
  // Own namespace so OAuth attempts and league imports don't share a quota.
  const rl = await checkRateLimit(getClientIp(req), OAUTH_RATE_LIMIT);
  if (!rl.ok) {
    // This route is reached by full-page navigation (window.location in
    // StepImport), so a JSON 429 would render as bare JSON with no way back
    // into the app - redirect to the same in-app error surface the callback
    // uses for its limit hits.
    const base = process.env.NEXT_PUBLIC_BASE_URL || new URL(req.url).origin;
    const url = new URL("/", base);
    url.searchParams.set("yahoo", "error");
    url.searchParams.set("reason", "rate_limited");
    return NextResponse.redirect(url.toString());
  }

  const clientId = process.env.YAHOO_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      {
        error:
          "Yahoo Fantasy OAuth is not configured (YAHOO_CLIENT_ID missing).",
      },
      { status: 500 },
    );
  }

  const state = crypto.randomBytes(32).toString("hex");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: "fspt-r",
    state,
    language: "en-us",
  });

  const res = NextResponse.redirect(`${YAHOO_AUTH_URL}?${params.toString()}`);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_MAX_AGE,
  });
  return res;
}
