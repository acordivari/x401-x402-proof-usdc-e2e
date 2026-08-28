/**
 * The read-only Proof "exhibit": a recorded presentation the demo re-verifies in
 * front of a visitor who has not been through Proof's IDV.
 *
 * Two properties matter and both are asserted here:
 *   1. the recording verifies for real against the nonce it was captured with —
 *      issuer signature, holder key-binding, nonce equality
 *   2. it FAILS against any fresh challenge, on `nonceBound`
 * (2) is what makes publishing a real credential defensible: the artifact cannot
 * authorize anything. The route must also be a dead end — no mandate may ever
 * come out of it.
 *
 * Fully offline. The exhibit seam is injected with a locally-issued recording
 * plus `localVcVerifier`, so the route's real logic runs with no Proof
 * credential in CI — the production default (a Proof recording + the SDK
 * verifier pinned to Proof's CA) is the same code path with the other impl.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  buildProofIdDcqlQuery,
  generateEs256Keys,
  localVcVerifier,
  LocalVcIssuer,
  LocalWallet,
  PROOF_CREDENTIAL_ID,
  type Jwk,
} from "@agentic-payments/credentials";
import type { ExhibitSeam } from "../apps/wallet-demo/server/index.ts";
import {
  loadExhibitRecording,
  PROOF_EXHIBIT_VERSION,
} from "../apps/wallet-demo/server/exhibit.ts";

// Offline, and deliberately WITHOUT Proof client credentials: the exhibit must
// work on a deployment that holds no Proof secret (the SDK's verify half needs
// only its bundled trust store). proofLiveReady = false.
process.env.PROOF_MODE = "local";
process.env.MERCHANT_PORT = "0";
process.env.PROOF_CLIENT_ID = "";
process.env.PROOF_CLIENT_SECRET = "";
// Deterministic: an uninjected app must find no recording, whatever this
// machine happens to hold at the repo root.
const TMP = mkdtempSync(path.join(os.tmpdir(), "exhibit-test-"));
process.env.PROOF_EXHIBIT_FILE = path.join(TMP, "absent.json");

const ISSUER_ID = "https://issuer.sandbox.local";
const RECORDED_NONCE = "recorded-challenge-value-from-capture-time";

/** Everything the credential holds — 5 claims, of which the exhibit reveals 2. */
const PERSONA = {
  given_name: "Andy", family_name: "Co", birth_date: "1990-04-12",
  email: "andy@example.com", age_over_21: true,
};
const DISCLOSED = ["given_name", "age_over_21"];

let base: string;
let demoServer: Server;
let closeDemo: () => Promise<void>;
let exhibitSeam: ExhibitSeam;

/** Fabricate the artifact `npm run record:proof` produces, on the local substrate. */
async function buildLocalRecording(): Promise<ExhibitSeam> {
  const issuerKeys = await generateEs256Keys();
  const holder = await generateEs256Keys();
  const issuer = new LocalVcIssuer({ issuerId: ISSUER_ID, privateJwk: issuerKeys.privateJwk });
  const wallet = new LocalWallet(holder.privateJwk, holder.publicJwk);
  wallet.store({
    id: PROOF_CREDENTIAL_ID,
    compact: await issuer.issue(PERSONA, holder.publicJwk),
    claimNames: Object.keys(PERSONA),
  });
  const presented = await wallet.present({
    query: buildProofIdDcqlQuery(DISCLOSED),
    nonce: RECORDED_NONCE,
    audience: "https://sandbox.local/merchant",
  });
  return {
    verifier: localVcVerifier({ issuerId: ISSUER_ID, issuerPublicJwk: issuerKeys.publicJwk as Jwk }),
    recording: {
      version: PROOF_EXHIBIT_VERSION,
      capturedAt: "2026-08-24T21:06:47.117Z",
      proof: { environment: "sandbox", trustRoot: "development", scope: "urn:test:basic" },
      nonce: RECORDED_NONCE,
      vpToken: presented.vpToken,
      transactionData: "encoded-td",
      transactionDataDecoded: {
        type: "urn:proof:params:vc:transaction-data:payment-mandate:v1",
        credential_ids: [PROOF_CREDENTIAL_ID],
        payload: { amount: "12990000", currency: "USDC", merchant: "0xc0ffee", sku: "exhibit-01" },
      },
      verifierId: "https://sandbox.local/merchant",
      resource: "https://sandbox.local/merchant/exhibit/exhibit-01",
      method: "GET",
      credential: {
        issuer: ISSUER_ID,
        claimsDisclosed: presented.disclosed,
        holderBound: true,
        nonceBound: true,
        paymentApproved: false,
        issuedAt: "2026-08-24T21:06:46.000Z",
      },
      capturedVerification: { ok: true, challengeOk: true, txDataBound: true },
    },
  };
}

beforeAll(async () => {
  const { createDemoApp } = await import("../apps/wallet-demo/server/index.ts");
  exhibitSeam = await buildLocalRecording();
  const demo = await createDemoApp(undefined, { exhibit: exhibitSeam });
  closeDemo = demo.close;
  demoServer = demo.app.listen(0);
  base = `http://localhost:${(demoServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await closeDemo();
  await new Promise<void>((resolve) => demoServer.close(() => resolve()));
});

const getExhibit = async () => (await fetch(`${base}/api/proof/exhibit`)).json();

describe("the recorded Proof exhibit", () => {
  it("verifies for real against the nonce it was captured with", async () => {
    const { available, liveVerification } = await getExhibit();
    expect(available).toBe(true);
    expect(liveVerification.asRecorded.ok).toBe(true);
    expect(liveVerification.asRecorded.violations).toEqual([]);
    expect(liveVerification.asRecorded.nonceBound).toBe(true);
    expect(liveVerification.asRecorded.holderBound).toBe(true);
    expect(liveVerification.asRecorded.issuer).toBe(ISSUER_ID);
  });

  it("REFUSES to verify against a fresh challenge — the replay gate", async () => {
    const { liveVerification } = await getExhibit();
    expect(liveVerification.asReplayed.ok).toBe(false);
    expect(liveVerification.asReplayed.nonceBound).toBe(false);
    expect(liveVerification.asReplayed.violations.join(" ")).toMatch(/nonce/i);
    // A genuinely fresh, single-use challenge each time — not a canned failure.
    expect(liveVerification.replayNonce).not.toBe(RECORDED_NONCE);
    const second = await getExhibit();
    expect(second.liveVerification.replayNonce).not.toBe(liveVerification.replayNonce);
  });

  it("shows selective disclosure: what was revealed and what was withheld", async () => {
    const { disclosure } = await getExhibit();
    expect(disclosure.disclosedCount).toBe(DISCLOSED.length);
    expect(disclosure.totalSdClaims).toBe(Object.keys(PERSONA).length);
    expect(disclosure.withheldCount).toBe(Object.keys(PERSONA).length - DISCLOSED.length);
    const byName = Object.fromEntries(
      (disclosure.disclosed as { name: string; value: unknown }[]).map((c) => [c.name, c.value]),
    );
    expect(byName.given_name).toBe("Andy");
    // Withheld claims must not leak through any field of the response.
    expect(JSON.stringify(disclosure)).not.toContain("andy@example.com");
    expect(JSON.stringify(disclosure)).not.toContain("1990-04-12");
  });

  it("is a dead end: viewing it never issues a mandate", async () => {
    await getExhibit();
    const me = await (await fetch(`${base}/api/me`)).json();
    expect(me.intent).toBeUndefined();
  });

  it("serves the vp_token so a visitor can verify it independently", async () => {
    const { vpToken } = await getExhibit();
    expect(vpToken).toBe(exhibitSeam.recording.vpToken);
  });
});

describe("with no recording deployed", () => {
  it("reports unavailable instead of failing the demo", async () => {
    const { createDemoApp } = await import("../apps/wallet-demo/server/index.ts");
    const demo = await createDemoApp(); // no injected seam, no file on disk
    const server = demo.app.listen(0);
    const url = `http://localhost:${(server.address() as AddressInfo).port}/api/proof/exhibit`;
    try {
      expect(await (await fetch(url)).json()).toEqual({ available: false });
    } finally {
      await demo.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * Regression: `npm run demo:server` runs with cwd = apps/wallet-demo, so a bare
 * relative PROOF_EXHIBIT_FILE once resolved to apps/wallet-demo/... and silently
 * missed a secret file mounted at the project root. The knob must mean the same
 * thing however the workspace is invoked.
 */
describe("PROOF_EXHIBIT_FILE resolution", () => {
  const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
  const withEnv = async (value: string) => {
    const prev = process.env.PROOF_EXHIBIT_FILE;
    process.env.PROOF_EXHIBIT_FILE = value;
    try {
      const { resolveDemoConfig } = await import("../apps/wallet-demo/server/config.ts");
      return resolveDemoConfig().exhibitFile;
    } finally {
      process.env.PROOF_EXHIBIT_FILE = prev;
    }
  };

  it("resolves a relative path against the repo root, not the cwd", async () => {
    expect(await withEnv(".proof-recording.json")).toBe(
      path.join(REPO_ROOT, ".proof-recording.json"),
    );
  });

  it("leaves an absolute path alone (platforms that mount secrets elsewhere)", async () => {
    expect(await withEnv("/etc/secrets/.proof-recording.json")).toBe(
      "/etc/secrets/.proof-recording.json",
    );
  });

  it("defaults to the repo root when unset", async () => {
    const prev = process.env.PROOF_EXHIBIT_FILE;
    delete process.env.PROOF_EXHIBIT_FILE;
    try {
      const { resolveDemoConfig } = await import("../apps/wallet-demo/server/config.ts");
      expect(resolveDemoConfig().exhibitFile).toBe(path.join(REPO_ROOT, ".proof-recording.json"));
    } finally {
      process.env.PROOF_EXHIBIT_FILE = prev;
    }
  });
});

/**
 * The read side is not fail-closed on purpose: the exhibit is a display that
 * cannot move value, so a missing or stale file must degrade to "unavailable"
 * rather than take down a demo that otherwise runs entirely offline.
 */
describe("loadExhibitRecording", () => {
  const write = (name: string, body: unknown) => {
    const file = path.join(TMP, name);
    writeFileSync(file, JSON.stringify(body));
    return file;
  };

  it("loads a well-formed recording", () => {
    const file = write("ok.json", exhibitSeam.recording);
    expect(loadExhibitRecording(file)?.nonce).toBe(RECORDED_NONCE);
  });

  it("ignores a missing file", () => {
    expect(loadExhibitRecording(path.join(TMP, "nope.json"))).toBeUndefined();
  });

  it("refuses a recording from an older shape rather than half-reading it", () => {
    const file = write("old.json", { ...exhibitSeam.recording, version: PROOF_EXHIBIT_VERSION - 1 });
    expect(loadExhibitRecording(file)).toBeUndefined();
  });

  it("ignores a recording with no presentation in it", () => {
    const file = write("empty.json", { version: PROOF_EXHIBIT_VERSION, capturedAt: "now" });
    expect(loadExhibitRecording(file)).toBeUndefined();
  });

  it("ignores malformed JSON", () => {
    const file = path.join(TMP, "bad.json");
    writeFileSync(file, "{not json");
    expect(loadExhibitRecording(file)).toBeUndefined();
  });
});
