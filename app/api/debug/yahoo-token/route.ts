// Temporary debug endpoint. Reads the encrypted Yahoo token cookie, decrypts
// it via readTokenCookie (which wraps decryptTokens), and echoes back the
// access token alongside the leagueKey query param so the Yahoo API can be
// exercised directly from a terminal. Gated to non-production builds.

import { NextResponse } from "next/server";
import { readTokenCookie } from "@/lib/api/yahoo-tokens";

export const runtime = "nodejs";

const TOKEN_COOKIE = "yahoo_tokens";

export function GET(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tokens = readTokenCookie(req, TOKEN_COOKIE);
  if (!tokens) {
    return NextResponse.json(
      { error: "No Yahoo token cookie found or decryption failed." },
      { status: 401 },
    );
  }

  const leagueKey = new URL(req.url).searchParams.get("leagueKey");
  return NextResponse.json({
    accessToken: tokens.accessToken,
    leagueKey,
  });
}
