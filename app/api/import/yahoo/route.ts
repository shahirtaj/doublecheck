// Yahoo Fantasy Sports import. Two modes share the route:
//   - POST {} → list the user's NFL leagues across all seasons (for the picker).
//   - POST { leagueKey } → walk the renew chain back from leagueKey, returning
//     ImportedSeasonRecord[] for completed seasons.
//
// The parsers for Yahoo's nested-array JSON live in ./parsers (unit-tested
// there); this file keeps the HTTP/token/handler shell.
//
// Tokens come from the encrypted httpOnly cookie set by the OAuth callback. If
// the access token has expired the route refreshes via the refresh token and
// rewrites the cookie before responding so the next call has fresh credentials.
//
// Rate limiting matches /api/import/sleeper and /api/import/espn.

import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";
import {
  encryptTokens,
  refreshAccessToken,
  readTokenCookie,
  type YahooTokens,
} from "@/lib/api/yahoo-tokens";
import { walkSeasonChain } from "./chain";
import {
  fetchSeasonRecord,
  parseLeagueDetails,
  parseLeaguesList,
  YAHOO_BASE,
} from "./parsers";

export const runtime = "nodejs";

const TOKEN_COOKIE = "yahoo_tokens";
const TOKEN_MAX_AGE = 60 * 60 * 24 * 30;
// Fallback when the client doesn't specify ?seasons=N.
const DEFAULT_SEASONS = 5;
// Hard cap so a misbehaving client can't blow up our chain walk. Set to 14:
// the largest recommended lookback across supported formats (14-team /
// 14-week needs 13 prior seasons) plus the newest season that anchors
// format detection. Matches MAX_IMPORT_SEASONS on the client; keep them in
// sync.
const MAX_SEASONS_CAP = 14;
// Seven seasons ending at the current year (e.g. in 2026: 2020–2026). Derived
// at module load so we don't need a yearly hand-edit; the chain traversal
// further down still caps the final return at the request's seasonsCount.
const NFL_SEASONS = Array.from(
  { length: 7 },
  (_, i) => new Date().getFullYear() - 6 + i,
).join(",");

async function fetchYahooJson(
  url: string,
  accessToken: string,
): Promise<unknown> {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}format=json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  // No "Yahoo" prefix: the route-level wrappers already read "… from Yahoo
  // Fantasy: <this message>".
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getValidTokens(
  req: Request,
): Promise<{ tokens: YahooTokens; refreshed: boolean }> {
  const tokens = readTokenCookie(req, TOKEN_COOKIE);
  if (!tokens) throw new Error("NOT_AUTHENTICATED");
  if (Date.now() >= tokens.expiresAt - 60_000) {
    const refreshed = await refreshAccessToken(tokens.refreshToken);
    return { tokens: refreshed, refreshed: true };
  }
  return { tokens, refreshed: false };
}

function setRefreshedCookie(res: NextResponse, tokens: YahooTokens) {
  res.cookies.set(TOKEN_COOKIE, encryptTokens(tokens), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TOKEN_MAX_AGE,
  });
}

async function readBody(req: Request): Promise<{ leagueKey?: string }> {
  try {
    const raw = await req.text();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { leagueKey?: unknown };
    if (typeof parsed?.leagueKey === "string") {
      return { leagueKey: parsed.leagueKey };
    }
    return {};
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(getClientIp(req));
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Rate limit exceeded. Retry in ${rl.retryAfter}s.` },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
      );
    }

    // Optional ?seasons=N lets the client right-size the fetch to the
    // format's recommended lookback. Falls back to DEFAULT_SEASONS when
    // missing/invalid and is clamped to MAX_SEASONS_CAP.
    const requestedSeasons = parseInt(
      new URL(req.url).searchParams.get("seasons") || "",
      10,
    );
    const seasonsCount =
      Number.isFinite(requestedSeasons) && requestedSeasons > 0
        ? Math.min(requestedSeasons, MAX_SEASONS_CAP)
        : DEFAULT_SEASONS;

    const body = await readBody(req);
    const leagueKey = body.leagueKey?.trim();

    let tokens: YahooTokens;
    let refreshed = false;
    try {
      const got = await getValidTokens(req);
      tokens = got.tokens;
      refreshed = got.refreshed;
    } catch (e) {
      if ((e as Error).message === "NOT_AUTHENTICATED") {
        return NextResponse.json(
          { error: "Not connected to Yahoo Fantasy. Connect first." },
          { status: 401 },
        );
      }
      console.error("[/api/import/yahoo] Token error:", e);
      return NextResponse.json(
        { error: `Yahoo Fantasy token error: ${(e as Error).message}` },
        { status: 502 },
      );
    }

    try {
      if (!leagueKey) {
        const json = await fetchYahooJson(
          `${YAHOO_BASE}/users;use_login=1/games;game_codes=nfl;seasons=${NFL_SEASONS}/leagues`,
          tokens.accessToken,
        );
        const leagues = parseLeaguesList(json);
        const res = NextResponse.json({ leagues });
        if (refreshed) setRefreshedCookie(res, tokens);
        return res;
      }

      if (!/^[\w.]+\.l\.\d+$/.test(leagueKey)) {
        return NextResponse.json(
          { error: "leagueKey must look like '<gameKey>.l.<leagueId>'." },
          { status: 400 },
        );
      }

      // The chain walk's stop-condition logic lives in ./chain (walkSeasonChain)
      // with the two fetches injected: details fetch + parse (throws on fetch
      // errors, null on unparseable responses) and the full season fetch.
      const records = await walkSeasonChain(leagueKey, seasonsCount, {
        fetchDetails: async (key) =>
          parseLeagueDetails(
            await fetchYahooJson(
              `${YAHOO_BASE}/league/${key};out=settings`,
              tokens.accessToken,
            ),
          ),
        fetchRecord: (details) =>
          fetchSeasonRecord(details, (url) =>
            fetchYahooJson(url, tokens.accessToken),
          ),
      });
      if (records.length === 0) {
        return NextResponse.json(
          {
            error:
              "No completed seasons found in this Yahoo Fantasy league's history.",
          },
          { status: 404 },
        );
      }
      const res = NextResponse.json(records);
      if (refreshed) setRefreshedCookie(res, tokens);
      return res;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "UNAUTHORIZED") {
        return NextResponse.json(
          {
            error:
              "Yahoo Fantasy authorization expired. Reconnect and try again.",
          },
          { status: 401 },
        );
      }
      console.error("[/api/import/yahoo] Fetch error:", e);
      return NextResponse.json(
        { error: `Failed to fetch from Yahoo Fantasy: ${msg}` },
        { status: 502 },
      );
    }
  } catch (e) {
    console.error("[/api/import/yahoo] Unhandled error:", e);
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? `Failed to fetch from Yahoo Fantasy: ${e.message}`
            : "Unexpected error processing Yahoo Fantasy import.",
      },
      { status: 502 },
    );
  }
}
