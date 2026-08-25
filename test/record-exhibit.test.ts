/**
 * Offline coverage for the `record:proof` capture path.
 *
 * Recording a Proof presentation is a ONE-SHOT, human-in-the-loop, real-network
 * act: you complete an IDV presentation and the vp_token comes back exactly
 * once. If the handoff is broken you find out at the worst possible moment. So
 * the handoff — and only the handoff — is exercised here with a synthetic token,
 * across both OID4VP response modes. The Proof round trip itself is not mocked;
 * it is the part a human must actually perform.
 */
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { captureViaListener, readRedirect } from "../apps/wallet-demo/server/record-exhibit.ts";

const FAKE_VP = "eyJhbGciOiJFUzI1NiJ9.fake~disclosure~kb";

/** Claim an ephemeral port, then release it for the listener under test. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("readRedirect", () => {
  it("reads vp_token + state out of the fragment (fragment mode)", () => {
    expect(readRedirect(`http://localhost:4040/proof/callback#vp_token=${FAKE_VP}&state=abc`)).toEqual({
      vpToken: FAKE_VP,
      state: "abc",
    });
  });

  it("falls back to the query string (direct_post redirects)", () => {
    expect(readRedirect(`http://localhost:4040/proof/callback?vp_token=${FAKE_VP}`)).toEqual({
      vpToken: FAKE_VP,
    });
  });

  it("tolerates a bare fragment pasted on its own", () => {
    expect(readRedirect(`#vp_token=${FAKE_VP}`).vpToken).toBe(FAKE_VP);
  });

  it("reports nothing when the redirect carries no presentation", () => {
    expect(readRedirect("http://localhost:4040/proof/callback#error=access_denied").vpToken).toBeUndefined();
  });
});

describe("captureViaListener", () => {
  it("serves the fragment-reading page and captures what the browser posts back", async () => {
    const port = await freePort();
    const uri = `http://localhost:${port}/proof/callback`;
    const captured = captureViaListener(uri, 10_000);

    // The browser lands on the redirect URI: it must get a page, because the
    // vp_token is in the fragment and never reaches the server on its own.
    const page = await fetch(uri);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("vp_token");

    // That page then posts what it lifted out of the fragment.
    const posted = await fetch(`http://localhost:${port}/__record/vp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vpToken: FAKE_VP, state: "xyz" }),
    });
    expect(posted.ok).toBe(true);
    await expect(captured).resolves.toEqual({ vpToken: FAKE_VP, state: "xyz" });
  });

  it("captures a direct_post form submitted straight to the callback", async () => {
    const port = await freePort();
    const uri = `http://localhost:${port}/proof/callback`;
    const captured = captureViaListener(uri, 10_000);

    const posted = await fetch(uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ vp_token: FAKE_VP, state: "xyz" }).toString(),
    });
    expect(posted.ok).toBe(true);
    await expect(captured).resolves.toEqual({ vpToken: FAKE_VP, state: "xyz" });
  });

  it("rejects a capture with no vp_token instead of resolving empty", async () => {
    const port = await freePort();
    const uri = `http://localhost:${port}/proof/callback`;
    const captured = captureViaListener(uri, 2_000);

    const posted = await fetch(`http://localhost:${port}/__record/vp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "xyz" }),
    });
    expect(posted.status).toBe(400);
    // Still waiting — a malformed post must not end the one capture window.
    await expect(captured).rejects.toThrow(/timed out/);
  });

  it("points at --paste when the redirect URI is not one this machine can serve", async () => {
    await expect(captureViaListener("https://wallet.proof.com/callback", 1_000)).rejects.toThrow(
      /--paste/,
    );
  });

  it("times out rather than hanging forever", async () => {
    const port = await freePort();
    await expect(captureViaListener(`http://localhost:${port}/proof/callback`, 300)).rejects.toThrow(
      /timed out after/,
    );
  });
});
