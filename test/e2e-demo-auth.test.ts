/**
 * F1(A) — the orchestrator access gate. With DEMO_AUTH_TOKEN set, every
 * state/spend endpoint requires an authenticated session: unauthenticated and
 * wrong-token requests are 401; /api/login with the right token unlocks the
 * session. Also covers the fail-closed boot guard (refuse to start exposed with
 * no token). Fully offline.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const TOKEN = "s3cret-demo-token";
const PUBLIC_TOKEN = "published-demo-token";

// Configure BEFORE importing the module (per-file env, like fail-closed-encryptor).
process.env.PROOF_MODE = "local";
process.env.WALLET_FLOW = "delegated";
process.env.MERCHANT_PORT = "0";
process.env.PROOF_CLIENT_ID = "";
process.env.PROOF_CLIENT_SECRET = "";
process.env.DEMO_AUTH_TOKEN = TOKEN;
process.env.DEMO_PUBLIC_TOKEN = PUBLIC_TOKEN;
process.env.DEMO_SESSION_SECRET = "test-session-secret";

let base: string;
let demoServer: Server;
let closeDemo: () => Promise<void>;
let createDemoApp: typeof import("../apps/wallet-demo/server/index.ts").createDemoApp;

beforeAll(async () => {
  ({ createDemoApp } = await import("../apps/wallet-demo/server/index.ts"));
  const demo = await createDemoApp();
  closeDemo = demo.close;
  demoServer = await new Promise<Server>((resolve) => {
    const s = demo.app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(demoServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => demoServer.close(() => r()));
  await closeDemo();
});

function makeClient(at = () => base) {
  let cookie = "";
  return async (path: string, body?: unknown) => {
    const res = await fetch(`${at()}${path}`, {
      method: body !== undefined ? "POST" : "GET",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = res.headers.get("set-cookie");
    const reissued = Boolean(setCookie);
    if (setCookie) cookie = setCookie.split(";")[0];
    return {
      status: res.status,
      headers: res.headers,
      reissued,
      body: (await res.json().catch(() => ({}))) as any,
    };
  };
}

describe("orchestrator access gate (F1)", () => {
  it("/api/me reports authRequired and withholds state before login", async () => {
    const api = makeClient();
    const me = await api("/api/me");
    expect(me.body.authRequired).toBe(true);
    expect(me.body.authed).toBe(false);
    expect(me.body.intent).toBeUndefined();
    expect(me.body.flow).toBeUndefined(); // no state leak pre-auth
    // The published token is the ONE thing served pre-auth beyond gate status —
    // the login screen renders it. The private token must never appear here.
    expect(me.body.publicToken).toBe(PUBLIC_TOKEN);
    expect(JSON.stringify(me.body)).not.toContain(TOKEN);
  });

  it("rejects a protected endpoint without authentication (401)", async () => {
    const api = makeClient();
    const r = await api("/api/agent/run", {});
    expect(r.status).toBe(401);
    expect(r.body.authRequired).toBe(true);
  });

  it("rejects login with the wrong token", async () => {
    const api = makeClient();
    const r = await api("/api/login", { token: "wrong" });
    expect(r.status).toBe(401);
    // still gated
    expect((await api("/api/flow", { flow: "self-issued" })).status).toBe(401);
  });

  it("unlocks the session after login with the right token", async () => {
    const api = makeClient();
    const login = await api("/api/login", { token: TOKEN });
    expect(login.status).toBe(200);
    expect(login.body.authed).toBe(true);
    const me = await api("/api/me");
    expect(me.body.authed).toBe(true);
    expect(me.body.flow).toBe("delegated"); // full payload now visible
    expect((await api("/api/flow", { flow: "self-issued" })).status).toBe(200);
  });

  it("does not allocate server-side state for unauthenticated callers", async () => {
    // An unauthed caller gets a cookie but NO stored session, so each request is
    // a fresh mint (observable as a re-issued cookie every time). This is what
    // stops a cookie-less flood from filling the session store — and, under the
    // file store, rewriting the whole session file per request.
    const api = makeClient();
    expect((await api("/api/me")).reissued).toBe(true);
    expect((await api("/api/me")).reissued).toBe(true);
    expect((await api("/api/me")).reissued).toBe(true);

    // Once authenticated the session IS stored, so the cookie stops churning.
    expect((await api("/api/login", { token: TOKEN })).status).toBe(200);
    const after = await api("/api/me");
    expect(after.reissued).toBe(false);
    expect(after.body.authed).toBe(true);
  });

  it("serves baseline security headers", async () => {
    const api = makeClient();
    const { headers } = await api("/api/me");
    const csp = headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("serves the Proof callback under a nonce CSP matching its inline script", async () => {
    const res = await fetch(`${base}/proof/callback`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    // The inline script must carry the SAME nonce, or the page is inert.
    expect(await res.text()).toContain(`<script nonce="${nonce}">`);
  });

  it("fails closed: refuses to boot exposed with no token", async () => {
    const saved = process.env.DEMO_AUTH_TOKEN;
    delete process.env.DEMO_AUTH_TOKEN;
    process.env.DEMO_REQUIRE_AUTH = "true";
    try {
      await expect(createDemoApp()).rejects.toThrow(/DEMO_AUTH_TOKEN/);
    } finally {
      process.env.DEMO_AUTH_TOKEN = saved;
      delete process.env.DEMO_REQUIRE_AUTH;
    }
  });
});

/**
 * F1(B) — the PUBLISHED token (DEMO_PUBLIC_TOKEN). It unlocks the same session as
 * the private token so a visitor can start the demo from a shared link, but it is
 * a distinct credential: it is the only one surfaced pre-auth, and it draws on its
 * own throttle budget so honest visitors behind one IP don't lock each other out.
 */
describe("published demo token (F1B)", () => {
  it("unlocks a session just like the private token", async () => {
    const api = makeClient();
    const login = await api("/api/login", { token: PUBLIC_TOKEN });
    expect(login.status).toBe(200);
    expect(login.body.authed).toBe(true);
    const me = await api("/api/me");
    expect(me.body.authed).toBe(true);
    expect(me.body.flow).toBe("delegated");
    expect((await api("/api/flow", { flow: "self-issued" })).status).toBe(200);
  });

  it("stops publishing the token once the caller is authenticated", async () => {
    const api = makeClient();
    await api("/api/login", { token: PUBLIC_TOKEN });
    expect((await api("/api/me")).body.publicToken).toBeUndefined();
  });

  it("does not spend the private token's brute-force budget", async () => {
    // Its own orchestrator, so the per-app counters start clean.
    const demo = await createDemoApp();
    const server = await new Promise<Server>((resolve) => {
      const s = demo.app.listen(0, () => resolve(s));
    });
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const api = makeClient(() => at);
      // Well past LOGIN_MAX_ATTEMPTS (10) — a shared conference IP looks like this.
      for (let i = 0; i < 15; i += 1) {
        expect((await api("/api/login", { token: PUBLIC_TOKEN })).status).toBe(200);
      }
      // ...and the private token's window is untouched by all of that.
      expect((await makeClient(() => at)("/api/login", { token: TOKEN })).status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await demo.close();
    }
  });

  it("fails closed: refuses to boot when it equals the private token", async () => {
    process.env.DEMO_PUBLIC_TOKEN = TOKEN;
    try {
      await expect(createDemoApp()).rejects.toThrow(/must differ from DEMO_AUTH_TOKEN/);
    } finally {
      process.env.DEMO_PUBLIC_TOKEN = PUBLIC_TOKEN;
    }
  });

  it("fails closed: refuses to boot alongside PROOF_MODE=live", async () => {
    // A published token plus live Proof credentials = any visitor spending them.
    // The encryptor key is set too: PROOF_MODE=live fails closed on that FIRST,
    // and this test is about the guard after it.
    process.env.PROOF_MODE = "live";
    process.env.X401_ENCRYPTOR_KEY = "a-strong-non-default-encryptor-key";
    try {
      await expect(createDemoApp()).rejects.toThrow(/PROOF_MODE=live/);
    } finally {
      process.env.PROOF_MODE = "local";
      delete process.env.X401_ENCRYPTOR_KEY;
    }
  });

  it("fails closed: refuses to publish a token with no private token behind it", async () => {
    const saved = process.env.DEMO_AUTH_TOKEN;
    delete process.env.DEMO_AUTH_TOKEN;
    process.env.DEMO_REQUIRE_AUTH = "";
    try {
      await expect(createDemoApp()).rejects.toThrow(/DEMO_PUBLIC_TOKEN requires DEMO_AUTH_TOKEN/);
    } finally {
      process.env.DEMO_AUTH_TOKEN = saved;
      delete process.env.DEMO_REQUIRE_AUTH;
    }
  });
});

/**
 * The shared token is the gate's only credential, so unthrottled /api/login is an
 * online brute-force channel. Booted as its OWN orchestrator so the per-app
 * attempt counter starts clean and can't be perturbed by the tests above.
 */
describe("login throttle", () => {
  let throttleBase: string;
  let server: Server;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const demo = await createDemoApp();
    close = demo.close;
    server = await new Promise<Server>((resolve) => {
      const s = demo.app.listen(0, () => resolve(s));
    });
    throttleBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await close();
  });

  it("rejects with 429 + Retry-After once the per-IP window is exhausted", async () => {
    const api = makeClient(() => throttleBase);
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 15; i += 1) {
      const r = await api("/api/login", { token: "wrong" });
      statuses.push(r.status);
      retryAfter ??= r.status === 429 ? r.headers.get("retry-after") : null;
    }
    expect(statuses[0]).toBe(401); // early attempts are judged on the token
    expect(statuses).toContain(429); // the window closes before 15 guesses land
    expect(statuses.at(-1)).toBe(429); // and stays closed
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("keeps the throttle on even for the CORRECT token once tripped", async () => {
    const api = makeClient(() => throttleBase);
    // Same IP as the loop above, whose window is still open.
    expect((await api("/api/login", { token: TOKEN })).status).toBe(429);
  });
});
