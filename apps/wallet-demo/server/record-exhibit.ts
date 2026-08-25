/**
 * record:proof — capture ONE real Proof presentation and save it as the demo's
 * "exhibit": the recorded credential the public demo re-verifies in front of a
 * visitor who has not been through Proof's IDV.
 *
 *   npm run record:proof -- [--amount 12.99] [--sku exhibit-01] [--scope <urn>]
 *                           [--out .proof-recording.json] [--paste]
 *
 * This is the ONLY script in the repo that drives the real Proof network with
 * your own credential, so it reuses the orchestrator's own fail-closed config
 * (`resolveDemoConfig` with PROOF_MODE forced to "live"): the Fairfax pin and
 * the non-default X401_ENCRYPTOR_KEY requirement both apply here exactly as they
 * do in a live deployment. A recording made with the built-in dev key would not
 * be a genuine authorization, so it is refused.
 *
 * What it does, mirroring `/api/authorize/start` + `/api/authorize/complete`:
 *   1. seals a payment `transaction_data` digest into a single-use x401
 *      challenge — that challenge value IS the OID4VP nonce
 *   2. builds the hosted Proof authorize URL (PAR; the client secret stays here)
 *   3. captures the returned `vp_token` (local callback listener, or --paste)
 *   4. verifies it two ways:
 *        - the FULL x401 check (challenge + payment binding + credential), which
 *          is what proves the recording was a real authorization at capture time
 *        - the SELF-CONTAINED credential check (issuer x5c chain -> Proof's
 *          bundled Fairfax CA, holder key-binding, nonce), which is the part the
 *          public exhibit can honestly re-run later, with no secrets and offline
 *   5. prints the DISCLOSURE INVENTORY — every claim value Proof released — so
 *      you can decide whether this artifact is publishable before it ever is
 *   6. writes the recording (claim NAMES only; values live solely in the signed
 *      vp_token) to a gitignored file
 *
 * The output file contains a real, signed, non-repudiable statement about a real
 * person. It is gitignored on purpose. Read the inventory in step 5 before you
 * put it anywhere public.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildAgentDid, dollarsToAtomic, loadEnv } from "@agentic-payments/shared";
import { createLocalSigner } from "@agentic-payments/agent";
import {
  buildPaymentMandateTransactionData,
  buildProofRequest,
  buildProofSdkAuthorizeUrl,
  createEncryptor,
  createIdentityChallenge,
  createVcVerifier,
  encodeTransactionData,
  packCredentialResult,
  proofTransactionData,
  unwrapVpToken,
  verifyAuthorization,
  PROOF_BASIC_SCOPE,
  type PaymentMandateTransactionData,
  type PresentationProof,
} from "@agentic-payments/credentials";
import { resolveDemoConfig } from "./config.ts";
import {
  decodeIssuerJwtPayload,
  PROOF_EXHIBIT_FILE,
  PROOF_EXHIBIT_VERSION,
  type ProofExhibitRecording,
} from "./exhibit.ts";

// Load the repo-root .env regardless of cwd (npm --workspace runs from the app dir).
loadEnv(path.resolve(fileURLToPath(new URL("../../..", import.meta.url)), ".env"));


/**
 * Claims that reveal a predicate rather than an identifier. Everything else Proof
 * releases identifies the holder directly and should be treated as unpublishable
 * until you have decided otherwise.
 */
const PREDICATE_CLAIMS = new Set(["age_over_18", "age_over_21", "age_equal_or_over"]);

const log = (msg: string) => console.log(`[record-exhibit] ${msg}`);


const asIsoSeconds = (v: unknown): string | undefined =>
  typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : undefined;

/** Pull `vp_token` (+ `state`) out of a redirect URL's fragment or query. */
export function readRedirect(url: string): { vpToken?: string; state?: string } {
  let hash = "";
  let query = "";
  try {
    const parsed = new URL(url);
    hash = parsed.hash.slice(1);
    query = parsed.search.slice(1);
  } catch {
    // Tolerate a bare fragment pasted on its own.
    hash = url.replace(/^#/, "");
  }
  const params = new URLSearchParams(hash || query);
  const vpToken = params.get("vp_token") ?? undefined;
  const state = params.get("state") ?? undefined;
  return { ...(vpToken !== undefined ? { vpToken } : {}), ...(state !== undefined ? { state } : {}) };
}

/**
 * The page Proof redirects to in fragment mode. The vp_token never reaches the
 * server in the URL (that is the point of a fragment), so this reads it in the
 * browser and POSTs it back to the local recorder. Status text is written with
 * textContent — its input arrives from the URL.
 */
const captureHtml = `<!doctype html><meta charset="utf-8"><title>Recording presentation</title>
<body style="font:14px ui-sans-serif,system-ui;background:#0b0f1a;color:#e8eef9;padding:28px">
<h3 style="margin:0 0 8px">x401 · recording your presentation</h3>
<p id="out" style="color:#93a3c4">Reading presentation…</p>
<script>
(async () => {
  const out = document.getElementById("out");
  const p = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  const vpToken = p.get("vp_token");
  if (!vpToken) { out.textContent = "No vp_token in the callback URL."; return; }
  out.textContent = "Sending it to the recorder…";
  try {
    const r = await fetch("/__record/vp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vpToken, state: p.get("state") }),
    });
    out.textContent = r.ok
      ? "✓ Captured. Return to your terminal — you can close this tab."
      : "✗ Recorder rejected the capture: " + (await r.text());
  } catch (e) { out.textContent = "Error reaching the recorder: " + e; }
})();
</script></body>`;

interface Captured { vpToken: string; state?: string }

/**
 * Serve the redirect URI locally until Proof hands the presentation back.
 * Handles both response modes: `fragment` (browser POSTs it to /__record/vp via
 * the page above) and `direct_post` (Proof POSTs it straight to the callback).
 */
export async function captureViaListener(callbackUri: string, timeoutMs: number): Promise<Captured> {
  const target = new URL(callbackUri);
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  if (target.hostname !== "localhost" && target.hostname !== "127.0.0.1") {
    throw new Error(
      `PROOF_REDIRECT_URI is ${callbackUri}, which this script cannot listen on. ` +
        "Re-run with --paste and paste the redirect URL by hand.",
    );
  }

  return await new Promise<Captured>((resolve, reject) => {
    const readBody = async (req: IncomingMessage): Promise<string> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        const done = (captured: Captured) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          clearTimeout(timer);
          server.close();
          resolve(captured);
        };

        // fragment mode: the browser posts what it lifted out of the fragment.
        if (req.method === "POST" && url.pathname === "/__record/vp") {
          const body = JSON.parse((await readBody(req)) || "{}") as Partial<Captured>;
          if (!body.vpToken) {
            res.writeHead(400, { "content-type": "text/plain" });
            return res.end("vpToken required");
          }
          return done({ vpToken: body.vpToken, ...(body.state ? { state: body.state } : {}) });
        }

        // direct_post mode: Proof posts the form straight to the callback.
        if (req.method === "POST" && url.pathname === target.pathname) {
          const params = new URLSearchParams(await readBody(req));
          const vpToken = params.get("vp_token");
          if (!vpToken) {
            res.writeHead(400, { "content-type": "text/plain" });
            return res.end("vp_token required");
          }
          const state = params.get("state");
          return done({ vpToken, ...(state ? { state } : {}) });
        }

        if (req.method === "GET" && url.pathname === target.pathname) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(captureHtml);
        }

        res.writeHead(404).end();
      })().catch((err: unknown) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(err));
      });
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the presentation`));
    }, timeoutMs);

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `could not listen on ${callbackUri}: ${(err as Error).message} — ` +
            "stop anything already bound to that port (e.g. `npm run demo`), or use --paste",
        ),
      );
    });
    server.listen(port, "127.0.0.1", () => log(`listening on ${callbackUri} for the redirect`));
  });
}

/** Fallback for a redirect URI this machine cannot serve: paste the URL back. */
async function captureViaPaste(): Promise<Captured> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("\nPaste the full redirect URL (including the #fragment):\n> ");
    const { vpToken, state } = readRedirect(answer.trim());
    if (!vpToken) throw new Error("no vp_token found in the pasted URL");
    return { vpToken, ...(state !== undefined ? { state } : {}) };
  } finally {
    rl.close();
  }
}

/** The step this whole script exists for: show exactly what Proof released. */
function reportDisclosure(proof: PresentationProof): void {
  const subject = proof.subject ?? {};
  const names = proof.claimsDisclosed ?? [];
  console.log("");
  log("DISCLOSURE INVENTORY — every claim this recording would publish:");
  if (names.length === 0) {
    log("  (none — the credential disclosed no user claims)");
  }
  const identifying: string[] = [];
  for (const name of names) {
    const predicate = PREDICATE_CLAIMS.has(name);
    if (!predicate) identifying.push(name);
    const value = JSON.stringify(subject[name]);
    console.log(`  ${predicate ? "·" : "!"} ${name.padEnd(22)} ${value}`);
  }
  console.log("");
  if (identifying.length > 0) {
    log(`WARNING: ${identifying.length} of these identify the holder directly: ${identifying.join(", ")}.`);
    log("  A vp_token is signed and non-repudiable — publishing it publishes these values");
    log("  permanently, and they cannot be redacted after the fact. If this set is wider");
    log("  than you want public, try a narrower --scope and re-record before deploying it.");
  } else {
    log("Only predicate claims were disclosed — no direct identifiers in this presentation.");
  }
  console.log("");
}

export interface RecordExhibitOptions {
  amountUsd: string;
  sku: string;
  scope: string;
  ttlSeconds: number;
  paste: boolean;
  timeoutMs: number;
}

/** Drive one real presentation end to end and return the recording. */
export async function recordExhibit(opts: RecordExhibitOptions): Promise<ProofExhibitRecording> {
  // Force the live posture so the orchestrator's own fail-closed checks apply:
  // the Fairfax pin, and the refusal to seal a challenge with the dev key.
  process.env.PROOF_MODE = "live";
  const cfg = resolveDemoConfig();
  if (!cfg.proof.clientId || !cfg.proof.clientSecret) {
    throw new Error(
      "PROOF_CLIENT_ID + PROOF_CLIENT_SECRET are required to record — they mint the hosted " +
        "presentation request (via PAR). Set them in .env from your Proof OAuth application.",
    );
  }

  const verifier = createVcVerifier({
    mode: "live",
    proof: {
      trustRoot: cfg.proof.trustRoot,
      sdkInit: {
        environment: cfg.proof.environment as never,
        clientId: cfg.proof.clientId,
        clientSecret: cfg.proof.clientSecret,
        callbackUri: cfg.proof.callbackUri,
        responseMode: cfg.proof.responseMode,
        usePushedAuthorizationRequest: true,
      },
    },
  });

  const signer = createLocalSigner();
  const encryptor = createEncryptor({ key: cfg.encryptorKey, purpose: "x401-agentic-payments" });
  const resource = `${cfg.verifierId}/exhibit/${opts.sku}`;

  // 1. Seal the payment into the challenge. Same shape as /api/authorize/start.
  const td = buildPaymentMandateTransactionData({
    amount: dollarsToAtomic(opts.amountUsd).toString(),
    currency: "USDC",
    merchant: cfg.merchantPayTo,
    network: cfg.network,
    sku: opts.sku,
    description: "Recorded Proof credential exhibit",
  });
  const transactionData = encodeTransactionData(td);
  const challenge = await createIdentityChallenge({
    encryptor,
    verifierId: cfg.verifierId,
    resource,
    method: "GET",
    ttlSeconds: opts.ttlSeconds,
    transactionData,
  });
  const { payload } = buildProofRequest({
    challenge,
    tokenEndpoint: `${cfg.verifierId}/oauth/token`,
    scope: opts.scope,
    requestId: "proof-exhibit-v1",
  });

  // 2. Build the hosted authorize URL, with the payment the human will approve.
  const state = randomUUID();
  const authorizeUrl = await buildProofSdkAuthorizeUrl({
    nonce: challenge.value,
    scope: opts.scope,
    state,
    ...(cfg.proof.loginHint ? { loginHint: cfg.proof.loginHint } : {}),
    transactionData: proofTransactionData.paymentMandate({
      payment_instrument: {
        type: cfg.proof.paymentInstrumentType,
        id: cfg.proof.paymentInstrumentId ?? `usdc:${cfg.network}:${signer.address}`,
        description: "Agent USDC wallet (Base Sepolia)",
      },
      payee: { name: "Mock VeryGood-RX", website: "https://verygood-rx.example" },
      prompt_summary: `Authorize Mock VeryGood-RX to charge $${opts.amountUsd} (recorded demo exhibit).`,
      amount: Number(opts.amountUsd),
      currency: cfg.proof.paymentCurrency,
    }),
  });

  log(`environment  ${cfg.proof.environment} (trust root: ${cfg.proof.trustRoot})`);
  log(`scope        ${opts.scope}`);
  log(`nonce        ${challenge.value.slice(0, 24)}… (expires ${challenge.expires_at})`);
  console.log("");
  log("Open this URL and complete the presentation as yourself:");
  console.log(`\n  ${authorizeUrl}\n`);

  // 3. Capture the vp_token.
  const captured = opts.paste
    ? await captureViaPaste()
    : await captureViaListener(cfg.proof.callbackUri, opts.timeoutMs);
  if (captured.state !== undefined && captured.state !== state) {
    throw new Error("state mismatch — the redirect did not come from the request this script made");
  }
  log(`captured vp_token (${captured.vpToken.length} chars)`);

  // 4a. The FULL x401 check — proves this was a real authorization, right now.
  const full = await verifyAuthorization({
    artifact: packCredentialResult({
      payload,
      agentId: buildAgentDid(cfg.network as `eip155:${number}`, signer.address),
      vpToken: captured.vpToken,
    }).artifact,
    encryptor,
    vcVerifier: verifier,
    expectedVerifierId: cfg.verifierId,
    expectedResource: resource,
    expectedMethod: "GET",
    transactionData,
  });
  if (!full.result.ok) {
    throw new Error(
      `presentation did not verify — refusing to record it:\n  - ${full.result.violations.join("\n  - ")}`,
    );
  }

  // 4b. The SELF-CONTAINED check — the half the public exhibit can re-run with
  //     no secrets, offline, against Proof's bundled Fairfax CA.
  const standalone = await verifier.verifyPresentation({
    vpToken: captured.vpToken,
    nonce: challenge.value,
  });
  if (!standalone.result.ok) {
    throw new Error(
      "the credential does not verify on its own, so the exhibit could not re-verify it:\n  - " +
        standalone.result.violations.join("\n  - "),
    );
  }
  log("verified: x401 challenge ✓  payment binding ✓  issuer chain ✓  holder key ✓  nonce ✓");

  // 5. Show what Proof actually released.
  reportDisclosure(standalone);

  const meta = decodeIssuerJwtPayload(captured.vpToken);
  return {
    version: PROOF_EXHIBIT_VERSION,
    capturedAt: new Date().toISOString(),
    proof: { environment: cfg.proof.environment, trustRoot: cfg.proof.trustRoot, scope: opts.scope },
    nonce: challenge.value,
    vpToken: captured.vpToken,
    transactionData,
    transactionDataDecoded: td,
    verifierId: cfg.verifierId,
    resource,
    method: "GET",
    credential: {
      ...(standalone.issuer !== undefined ? { issuer: standalone.issuer } : {}),
      claimsDisclosed: standalone.claimsDisclosed ?? [],
      ...(standalone.issuerCert !== undefined ? { issuerCert: standalone.issuerCert } : {}),
      holderBound: standalone.holderBound,
      nonceBound: standalone.nonceBound,
      paymentApproved: standalone.paymentApproved !== undefined,
      ...(typeof meta.vct === "string" ? { vct: meta.vct } : {}),
      ...(asIsoSeconds(meta.iat) !== undefined ? { issuedAt: asIsoSeconds(meta.iat) } : {}),
      ...(asIsoSeconds(meta.exp) !== undefined ? { expiresAt: asIsoSeconds(meta.exp) } : {}),
    },
    capturedVerification: {
      ok: full.result.ok,
      challengeOk: full.challengeOk,
      txDataBound: full.txDataBound,
    },
  };
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const { values } = parseArgs({
    options: {
      amount: { type: "string", default: "12.99" },
      sku: { type: "string", default: "exhibit-01" },
      scope: { type: "string", default: PROOF_BASIC_SCOPE },
      ttl: { type: "string", default: "900" },
      out: { type: "string", default: PROOF_EXHIBIT_FILE },
      paste: { type: "boolean", default: false },
      timeout: { type: "string", default: "600" },
    },
  });

  (async () => {
    const recording = await recordExhibit({
      amountUsd: Number(values.amount).toFixed(2),
      sku: values.sku,
      scope: values.scope,
      ttlSeconds: Number(values.ttl),
      paste: values.paste,
      timeoutMs: Number(values.timeout) * 1000,
    });
    writeFileSync(values.out, `${JSON.stringify(recording, null, 2)}\n`);
    log(`issuer     ${recording.credential.issuer ?? "(none)"}`);
    log(`signed by  ${recording.credential.issuerCert?.subject ?? "(unknown leaf)"}`);
    log(`expires    ${recording.credential.expiresAt ?? "(no exp claim)"}`);
    log(`payment    ${recording.credential.paymentApproved ? "approved on Proof's screen" : "not present"}`);
    log(`saved to   ${values.out} (gitignored — nothing publishes this until you deploy it)`);
  })().catch((err: unknown) => {
    console.error(`[record-exhibit] failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
