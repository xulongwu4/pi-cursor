import { describe, expect, it, vi } from "bun:test";

import { createCursorAuthClient, isCursorSessionToken } from "../src/auth/oauth.js";

function sessionJwt(payload: Record<string, unknown> = {}): string {
  const body = Buffer.from(JSON.stringify({ type: "session", ...payload })).toString("base64url");
  return `header.${body}.signature`;
}

describe("Cursor OAuth transport", () => {
  it("honors cancellation before polling starts", async () => {
    const fetchMock = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const client = createCursorAuthClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
    });

    await expect(client.poll("uuid", "verifier", { signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("interrupts the polling backoff when cancelled", async () => {
    const fetchMock = vi.fn();
    const controller = new AbortController();
    const client = createCursorAuthClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: () => new Promise<void>(() => {}),
    });

    const polling = client.poll("uuid", "verifier", { signal: controller.signal });
    controller.abort();

    await expect(polling).rejects.toThrow(/aborted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out a hung refresh request", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), {
            once: true,
          });
        }),
    );
    const client = createCursorAuthClient({
      fetch: fetchMock as unknown as typeof fetch,
      requestTimeoutMs: 1,
    });

    await expect(client.refreshToken("refresh-token")).rejects.toThrow(/aborted/);
  });

  it("rejects successful responses without an access token", async () => {
    const client = createCursorAuthClient({
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ refreshToken: "refresh" })),
      ) as unknown as unknown as typeof fetch,
    });
    await expect(client.refreshToken("refresh-token")).rejects.toThrow(/no access token/);
  });

  it("rejects a session token without touching the network", async () => {
    const fetchMock = vi.fn();
    const client = createCursorAuthClient({
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.refreshToken(sessionJwt())).rejects.toThrow(/\/login cursor/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still exchanges a user API key, which is not a JWT", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ accessToken: sessionJwt({ exp: 1 }) })),
    );
    const client = createCursorAuthClient({
      fetch: fetchMock as unknown as typeof fetch,
    });

    const credentials = await client.refreshToken("key_abc123");

    expect(credentials.refresh).toBe("key_abc123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies tokens by the session claim, not by shape", () => {
    expect(isCursorSessionToken(sessionJwt())).toBe(true);
    // A JWT that is not a session token must keep the network path.
    expect(isCursorSessionToken(sessionJwt({ type: "api-key" }))).toBe(false);
    expect(isCursorSessionToken("key_abc123")).toBe(false);
    expect(isCursorSessionToken("not.a.jwt")).toBe(false);
    expect(isCursorSessionToken("")).toBe(false);
  });

  it("redacts refresh error bodies", async () => {
    const jwt = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiIxMjM0In0",
      "signaturepad",
    ].join(".");
    const client = createCursorAuthClient({
      fetch: vi.fn(
        async () => new Response(jwt, { status: 401 }),
      ) as unknown as unknown as typeof fetch,
    });
    await expect(client.refreshToken("refresh-token")).rejects.toThrow(/\[redacted-jwt\]/);
  });
});
