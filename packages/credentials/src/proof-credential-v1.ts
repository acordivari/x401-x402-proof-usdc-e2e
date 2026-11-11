/**
 * ProofCredentialV1 — the credential Proof issues to every verified Holder
 * (SD-JWT VC, ES256, holder key bound by `cnf.jwk`, x5c chain to Proof Root CA
 * R1). This replaces the July model (`proof_id_default` with flat `email` /
 * `age_over_21` / `document_number` claims, every one requestable on its own):
 * Proof now exposes FIXED scopes, each mapping to a predefined set of
 * disclosures, and the age and nationality claims are nested objects whose
 * members are disclosed individually (`age_equal_or_over.18`).
 *
 * In local mode we self-issue the same claim shape under our own issuer and a
 * sandbox `vct`, so the wallet, the disclosure selection and the verifier run
 * the same code paths as a live Proof presentation without ever presenting a
 * self-issued credential under Proof's type identifier.
 */

/** Proof's type identifier. Compared as an opaque string, never dereferenced. */
export const PROOF_CREDENTIAL_V1_VCT = "https://credentials.notarize.com/ProofCredentialV1";

/** The `vct` our local issuer stamps on self-issued ProofCredentialV1-shaped credentials. */
export const LOCAL_CREDENTIAL_V1_VCT = "https://issuer.sandbox.local/vct/ProofCredentialV1-shape";

/** The selectively-disclosable claims of a ProofCredentialV1. */
export interface ProofCredentialV1Claims {
  given_name: string;
  family_name: string;
  /** ISO 8601 (YYYY-MM-DD). */
  birthdate: string;
  /** Always all three thresholds; `false` means under that age, not unknown. */
  age_equal_or_over: { "18": boolean; "21": boolean; "65": boolean };
  /** Present only when true — absence is NOT proof of non-nationality. */
  is_national?: { us: true };
}

/** A claim path as a DCQL-style array: `["age_equal_or_over", "18"]`. */
export type ClaimPath = readonly string[];

export const PROOF_SCOPES = {
  basic: "urn:proof:params:scope:verifiable-credentials:basic",
  nationalityUs: "urn:proof:params:scope:verifiable-credentials:nationality:us",
} as const;
export type ProofScope = (typeof PROOF_SCOPES)[keyof typeof PROOF_SCOPES];

export interface ScopeDefinition {
  scope: ProofScope;
  /** Short label for UIs. */
  label: string;
  /** The DCQL credential query id the scope maps to — and the vp_token key. */
  credentialQueryId: string;
  /** Exactly what a presentation for this scope discloses. */
  disclosures: ClaimPath[];
  /** `transaction_data` is only accepted with the basic scope. */
  acceptsTransactionData: boolean;
}

/** Proof's scope catalog, as published. */
export const PROOF_SCOPE_CATALOG: Record<ProofScope, ScopeDefinition> = {
  [PROOF_SCOPES.basic]: {
    scope: PROOF_SCOPES.basic,
    label: "basic",
    credentialQueryId: "proof_id_default",
    disclosures: [["given_name"], ["family_name"], ["age_equal_or_over", "18"]],
    acceptsTransactionData: true,
  },
  [PROOF_SCOPES.nationalityUs]: {
    scope: PROOF_SCOPES.nationalityUs,
    label: "nationality:us",
    credentialQueryId: "proof_id_nationality_us",
    disclosures: [["age_equal_or_over", "18"], ["is_national", "us"]],
    acceptsTransactionData: false,
  },
};

export function scopeDefinition(scope: string): ScopeDefinition {
  const def = PROOF_SCOPE_CATALOG[scope as ProofScope];
  if (!def) throw new Error(`unsupported Proof scope: ${scope}`);
  return def;
}

/** "age_equal_or_over.18" — the dotted form Proof's docs use for a nested claim. */
export const claimPathLabel = (path: ClaimPath): string => path.join(".");

/**
 * The @sd-jwt disclosure frame for a ProofCredentialV1: every top-level claim is
 * selectively disclosable, and so is every member of the nested objects, which
 * is what lets a presentation reveal `age_equal_or_over.18` without `.21`.
 */
export function proofCredentialV1Frame(claims: ProofCredentialV1Claims): Record<string, unknown> {
  const top = ["given_name", "family_name", "birthdate", "age_equal_or_over"];
  const frame: Record<string, unknown> = {
    _sd: claims.is_national ? [...top, "is_national"] : top,
    age_equal_or_over: { _sd: ["18", "21", "65"] },
  };
  if (claims.is_national) frame.is_national = { _sd: ["us"] };
  return frame;
}

/**
 * The @sd-jwt presentation frame that reveals exactly `paths` — a nested member
 * needs its parent object's disclosure too, which the frame expresses by
 * nesting (`{ age_equal_or_over: { "18": true } }`).
 */
export function presentationFrameFor(paths: ClaimPath[]): Record<string, unknown> {
  const frame: Record<string, unknown> = {};
  for (const path of paths) {
    let node = frame;
    path.forEach((seg, i) => {
      if (i === path.length - 1) {
        if (node[seg] === undefined) node[seg] = true;
      } else {
        const next = node[seg];
        node[seg] = typeof next === "object" && next !== null ? next : {};
        node = node[seg] as Record<string, unknown>;
      }
    });
  }
  return frame;
}

/** Read a nested claim value by path from decoded claims; undefined when absent. */
export function readClaim(claims: Record<string, unknown>, path: ClaimPath): unknown {
  let cur: unknown = claims;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Which of `paths` actually appear in a set of decoded claims. */
export function disclosedPaths(claims: Record<string, unknown>, paths: ClaimPath[]): ClaimPath[] {
  return paths.filter((p) => readClaim(claims, p) !== undefined);
}

/** Every disclosable leaf of a ProofCredentialV1, in display order. */
export const PROOF_CREDENTIAL_V1_LEAVES: ClaimPath[] = [
  ["given_name"],
  ["family_name"],
  ["birthdate"],
  ["age_equal_or_over", "18"],
  ["age_equal_or_over", "21"],
  ["age_equal_or_over", "65"],
  ["is_national", "us"],
];

/** Derive the age thresholds from a birthdate, as Proof's issuer does. */
export function ageThresholds(birthdate: string, today: Date = new Date()): ProofCredentialV1Claims["age_equal_or_over"] {
  const [y, m, d] = birthdate.split("-").map(Number) as [number, number, number];
  let age = today.getUTCFullYear() - y;
  const beforeBirthday =
    today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return { "18": age >= 18, "21": age >= 21, "65": age >= 65 };
}

/** Demo holders for local mode. Ages are derived, so they stay right as time passes. */
export function demoHoldersV1(today: Date = new Date()): Record<string, ProofCredentialV1Claims> {
  const holder = (
    given_name: string,
    family_name: string,
    birthdate: string,
    usNational: boolean,
  ): ProofCredentialV1Claims => ({
    given_name,
    family_name,
    birthdate,
    age_equal_or_over: ageThresholds(birthdate, today),
    ...(usNational ? { is_national: { us: true as const } } : {}),
  });
  return {
    "Andrew Smith": holder("Andrew", "Smith", "1990-04-12", true),
    "Sam Rivera": holder("Sam", "Rivera", "2009-09-30", true),
    "Priya Nair": holder("Priya", "Nair", "1957-02-03", false),
  };
}
