// Yahoo OAuth token storage. Tokens live only in an encrypted httpOnly cookie -
// no database, no user accounts. The encryption key is derived from
// YAHOO_TOKEN_SECRET so a stolen cookie alone is useless without the secret.
//
// AES-256-GCM ciphertext layout: [12-byte IV][16-byte auth tag][ciphertext],
// then base64url-encoded for cookie transport.

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

const YAHOO_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";

export type YahooTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

function getKey(): Buffer {
  const secret = process.env.YAHOO_TOKEN_SECRET;
  if (!secret) {
    throw new Error("YAHOO_TOKEN_SECRET is not set.");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptTokens(tokens: YahooTokens): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(tokens), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptTokens(encrypted: string): YahooTokens | null {
  try {
    const buf = Buffer.from(encrypted, "base64url");
    if (buf.length < IV_LEN + TAG_LEN + 1) return null;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as YahooTokens;
    if (
      typeof parsed?.accessToken !== "string" ||
      typeof parsed?.refreshToken !== "string" ||
      typeof parsed?.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function exchangeAuthCode(
  code: string,
  redirectUri: string,
): Promise<YahooTokens> {
  const clientId = process.env.YAHOO_CLIENT_ID;
  const clientSecret = process.env.YAHOO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET not configured.");
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(YAHOO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    // No "Yahoo" prefix: both surfaces re-add Yahoo context - the import
    // route wraps this as "Yahoo Fantasy token error: <this message>" and
    // the OAuth callback feeds it into "Failed to connect to Yahoo
    // Fantasy: <this message>".
    throw new Error(`Token exchange failed (${res.status}).`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token) {
    throw new Error(
      "Yahoo token response missing access_token or refresh_token.",
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<YahooTokens> {
  const clientId = process.env.YAHOO_CLIENT_ID;
  const clientSecret = process.env.YAHOO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET not configured.");
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(YAHOO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    // Same no-prefix rationale as the exchange error above.
    throw new Error(`Token refresh failed (${res.status}).`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Yahoo refresh response missing access_token.");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

export function readTokenCookie(
  req: Request,
  cookieName: string,
): YahooTokens | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const re = new RegExp(`(?:^|; )${cookieName}=([^;]+)`);
  const match = header.match(re);
  if (!match) return null;
  return decryptTokens(decodeURIComponent(match[1]!));
}
