import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSessionStore,
  InMemorySessionStore,
} from "../apps/wallet-demo/server/session-store.ts";

type S = { lastSeen: number; flow: string; intent?: { id: string } };

describe("InMemorySessionStore", () => {
  it("get/set/delete round-trips", () => {
    const s = new InMemorySessionStore<S>();
    expect(s.get("a")).toBeUndefined();
    s.set("a", { lastSeen: 1, flow: "delegated" });
    expect(s.get("a")?.flow).toBe("delegated");
    s.delete("a");
    expect(s.get("a")).toBeUndefined();
  });

  it("sweep evicts sessions idle past maxAge", () => {
    const s = new InMemorySessionStore<S>();
    s.set("old", { lastSeen: Date.now() - 10_000, flow: "x" });
    s.set("fresh", { lastSeen: Date.now(), flow: "y" });
    s.sweep(5_000);
    expect(s.get("old")).toBeUndefined();
    expect(s.get("fresh")?.flow).toBe("y");
  });
});

describe("FileSessionStore (durable)", () => {
  let dir: string;
  let file: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("persists sessions and reloads them after a 'restart'", () => {
    dir = mkdtempSync(join(tmpdir(), "sessions-"));
    file = join(dir, "sessions.json");

    const s1 = new FileSessionStore<S>(file);
    s1.set("sid1", { lastSeen: Date.now(), flow: "delegated", intent: { id: "i1" } });

    // A fresh instance from the same file = a process restart.
    const s2 = new FileSessionStore<S>(file);
    expect(s2.get("sid1")?.flow).toBe("delegated");
    expect(s2.get("sid1")?.intent?.id).toBe("i1");
  });

  it("persists deletes and sweeps across a reload", () => {
    dir = mkdtempSync(join(tmpdir(), "sessions-"));
    file = join(dir, "sessions.json");

    const s1 = new FileSessionStore<S>(file);
    s1.set("keep", { lastSeen: Date.now(), flow: "a" });
    s1.set("stale", { lastSeen: Date.now() - 10_000, flow: "b" });
    s1.sweep(5_000); // drops "stale", persists

    const s2 = new FileSessionStore<S>(file);
    expect(s2.get("keep")?.flow).toBe("a");
    expect(s2.get("stale")).toBeUndefined();

    s2.delete("keep"); // persists
    expect(new FileSessionStore<S>(file).get("keep")).toBeUndefined();
  });
});
