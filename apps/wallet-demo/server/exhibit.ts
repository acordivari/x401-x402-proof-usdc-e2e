/**
 * The "exhibit": one recorded, real Proof presentation the public demo
 * re-verifies in front of a visitor who has not been through Proof's IDV.
 *
 * This module owns the recording's on-disk shape and the read side. The write
 * side is `record-exhibit.ts` (`npm run record:proof`).
 *
 * The load-bearing property is what the exhibit CANNOT do. A recorded
 * presentation is key-bound to the single-use OID4VP nonce it was captured
 * with, so replaying it against any fresh challenge fails on
 * `nonceBound` — which is exactly the replay gate that makes x401 worth
 * anything. The exhibit therefore never reaches the mandate-issuing path; it
 * demonstrates a real credential and then demonstrates its own unusability.
 */
import { readFileSync } from "node:fs";
import { unwrapVpToken, type PaymentMandateTransactionData } from "@agentic-payments/credentials";

/** Bump when the recording's shape changes. Older files are refused, not migrated. */
export const PROOF_EXHIBIT_VERSION = 1;

/** Default filename, resolved against the repo root. Gitignored — see .gitignore. */
export const PROOF_EXHIBIT_FILE = ".proof-recording.json";

/**
 * A captured Proof presentation, as persisted. Deliberately carries claim NAMES
 * but never claim VALUES: the values are inside the signed `vpToken` and there
 * is no reason to duplicate them in cleartext next to it. (Same discipline as
 * `logSafeVerification` in index.ts.)
 */
export interface ProofExhibitRecording {
  version: number;
  capturedAt: string;
  proof: { environment: string; trustRoot: string; scope: string };
  /** The OID4VP nonce this presentation is key-bound to (= the x401 challenge). */
  nonce: string;
  /** The presentation itself. Re-verifiable offline against Proof's bundled CA. */
  vpToken: string;
  /** The encoded transaction_data whose digest was sealed into the challenge. */
  transactionData: string;
  transactionDataDecoded: PaymentMandateTransactionData;
  verifierId: string;
  resource: string;
  method: string;
  /** What the SDK reported at capture time. The exhibit re-runs this live. */
  credential: {
    issuer?: string;
    claimsDisclosed: string[];
    issuerCert?: { subject?: string; issuer?: string };
    holderBound: boolean;
    nonceBound: boolean;
    /** Whether the holder approved a payment-mandate on Proof's screen. */
    paymentApproved: boolean;
    vct?: string;
    issuedAt?: string;
    /**
     * The credential's own expiry, when it has one. Proof's Fairfax sandbox
     * mints these per presentation with NO `exp` and NO `status`, so in practice
     * a recording neither expires nor can be revoked upstream: removing it from
     * the deployment is the only way to withdraw it. Keep it a runtime secret
     * file, never a committed artifact, so removal is actually complete.
     */
    expiresAt?: string;
  };
  /**
   * Provenance only. The full x401 check (challenge + payment binding) passed at
   * capture time; it is NOT re-checkable later, because the challenge is
   * single-use, time-boxed, and sealed with the recording machine's
   * X401_ENCRYPTOR_KEY. Only a fully verified presentation is ever recorded, so
   * these are always true: they record WHAT was checked at capture time, and by
   * omission which checks the exhibit deliberately cannot repeat.
   */
  capturedVerification: {
    ok: boolean;
    challengeOk: boolean;
    txDataBound: boolean;
  };
}

/** Decode an SD-JWT-VC's issuer-JWT payload (unverified — metadata only). */
export function decodeIssuerJwtPayload(vpToken: string): Record<string, unknown> {
  const compact = unwrapVpToken(vpToken);
  const issuerJwt = compact.split("~")[0] ?? "";
  const payload = issuerJwt.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * How many selectively-disclosable claims the credential holds in total. The
 * issuer JWT's `_sd` array carries one salted digest per top-level SD claim,
 * including the ones the holder withheld — so this minus the disclosed count is
 * what selective disclosure actually kept back.
 */
export function countSdClaims(vpToken: string): number {
  const sd = decodeIssuerJwtPayload(vpToken)._sd;
  return Array.isArray(sd) ? sd.length : 0;
}

/**
 * Read a recording from disk. Absent or unreadable => `undefined` (the exhibit
 * is simply unavailable). This is deliberately NOT fail-closed: the exhibit is a
 * read-only display that cannot move value or authorize anything, so a missing
 * or stale file must not take down a demo that otherwise works offline.
 */
export function loadExhibitRecording(file: string): ProofExhibitRecording | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[demo] exhibit recording at ${file} could not be read: ${(err as Error).message}`);
    }
    return undefined;
  }
  const rec = parsed as Partial<ProofExhibitRecording>;
  if (rec.version !== PROOF_EXHIBIT_VERSION) {
    console.warn(
      `[demo] exhibit recording at ${file} is version ${String(rec.version)}, expected ` +
        `${PROOF_EXHIBIT_VERSION} — ignoring it. Re-run \`npm run record:proof\`.`,
    );
    return undefined;
  }
  if (typeof rec.vpToken !== "string" || typeof rec.nonce !== "string") {
    console.warn(`[demo] exhibit recording at ${file} is missing vpToken/nonce — ignoring it.`);
    return undefined;
  }
  return rec as ProofExhibitRecording;
}
