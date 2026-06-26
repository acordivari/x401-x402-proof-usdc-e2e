/**
 * The orchestrator session store persists across a restart (F1's last deferred
 * item). With SESSION_STORE=file and a stable DEMO_SESSION_SECRET, a client's
 * session — and any standing mandate held in it — survives the process going down
 * and coming back up.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

// Configure BEFORE importing the server module (per-file env). A durable file
// store + a STABLE signing secret are both required for cross-restart continuity.
process.env.PROOF_MODE = "local";
process.env.MERCHANT_PORT = "0";
process.env.PROOF_CLIENT_ID = "";
process.env.PROOF_CLIENT_SECRET = "";
process.env.SESSION_STORE = "file";
process.env.DEMO_SESSION_SECRET = "fixed-secret-for-restart-continuity";
dir = mkdtempSync(join(tmpdir(), "e2e-sessions-"));
process.env.SESSION_FILE = join(dir, "sessions.json");

let createDemoApp: typeof import("../apps/wallet-demo/server/index.ts").createDemoApp;

beforeAll(async () => {
  ({ createDemoApp } = await import("../apps/wallet-demo/server/index.ts"));
});

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** Boot a fresh orchestrator instance (a "process") on an ephemeral port. */
async function boot() {
  const demo = await createDemoApp();
  const server = await new Promise<Server>((resolve) => {
    const s = demo.app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await demo.close();
  };
  return { base, stop };
}

function makeClient(base: string) {
  let cookie = "";
  return async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: body !== undefined ? "POST" : "GET",
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any, cookieHeader: () => cookie };
  };
}

describe("session store persistence across a restart", () => {
  it("keeps a client's session (flow) when the orchestrator restarts", async () => {
    // --- process 1: establish a session and mutate it ---
    const app1 = await boot();
    const c1 = makeClient(app1.base);
    await c1("/api/me"); // mint the session cookie
    expect((await c1("/api/flow", { flow: "delegated" })).body.flow).toBe("delegated");
    // The signed session cookie to carry into the "restarted" process.
    const savedCookie = (await c1("/api/me")).cookieHeader();
    await app1.stop();

    // --- process 2: same file + same secret = the same orchestrator, restarted ---
    const app2 = await boot();
    const res = await fetch(`${app2.base}/api/me`, { headers: { cookie: savedCookie } });
    const me = await res.json();
    expect(me.flow).toBe("delegated"); // the session survived the restart
    await app2.stop();
  });
});
