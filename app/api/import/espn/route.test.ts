// Route-level coverage for the ESPN import's all-private 403 and all-failed
// 502 shapes, with ESPN mocked at global fetch. No Redis env in tests, so
// rate limiting uses the in-memory fallback; each request gets a distinct IP.

import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

let ipCounter = 0;
function postRequest(body: unknown, seasons: number): Request {
  return new Request(`http://localhost/api/import/espn?seasons=${seasons}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.9.1.${++ipCounter}`,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/import/espn", () => {
  it("returns a 403 with helpUrl when every season fails as private, without retries", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(postRequest({ leagueId: "123" }, 3));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; helpUrl?: string };
    expect(body.error).toContain("This ESPN league is private.");
    expect(body.helpUrl).toContain("support.espn.com");
    // Deterministic private statuses are not retried: one call per season.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns the 502 shape when every season fails transiently, after one retry each", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(postRequest({ leagueId: "123" }, 2));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^Could not fetch any seasons from ESPN\./);
    expect(body.error).toContain("Network error fetching season");
    // Transient failures get exactly two attempts per season.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
