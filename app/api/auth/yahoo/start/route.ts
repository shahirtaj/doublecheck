// Yahoo OAuth 2.0 entry point. Generates a CSRF state token, stashes it in a
// short-lived httpOnly cookie, and redirects to Yahoo's authorization page.
// The callback route validates the cookie value against the state Yahoo echoes
// back to detect tampering.

import { NextResponse } from "next/server";
import crypto from "node:crypto";

export const runtime = "nodejs";

const YAHOO_AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const STATE_COOKIE = "yahoo_oauth_state";
const STATE_MAX_AGE = 600;

function getRedirectUri(): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL || "https://doublecheckff.com";
  return `${base.replace(/\/$/, "")}/api/auth/yahoo/callback`;
}

export async function GET() {
  const clientId = process.env.YAHOO_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Yahoo OAuth is not configured (YAHOO_CLIENT_ID missing)." },
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
