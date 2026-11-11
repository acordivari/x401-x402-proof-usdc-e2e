/**
 * The browser-held side of the latest variant's demo wallet: a holder key and
 * one ProofCredentialV1-shaped credential, in localStorage under keys of its
 * own so it never collides with the July wallet. Every wallet operation itself
 * (verify the request, present, mint a delegation) is the shared
 * `@agentic-payments/credentials/browser` code the server tests run too.
 */
import { generateEs256Keys, type Jwk } from "@agentic-payments/credentials/browser";

const LS_KEYS = "x401v1.holderKeys";
const LS_CRED = "x401v1.credential";

export interface HolderKeys { publicJwk: Jwk; privateJwk: Jwk }
export interface HeldCredentialV1 {
  compact: string;
  persona: string;
  claims: Record<string, unknown>;
  issuer: string;
  vct: string;
  /** Fingerprint of the issuer key at issuance; a server restart rotates it. */
  issuerKid: string;
}

const read = <T>(k: string): T | undefined => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
};
const write = (k: string, v: unknown) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked: session-only */ }
};

let memKeys: HolderKeys | undefined;
let memCred: HeldCredentialV1 | undefined;

export async function holderKeys(): Promise<HolderKeys> {
  const k = memKeys ?? read<HolderKeys>(LS_KEYS);
  if (k) return (memKeys = k);
  memKeys = (await generateEs256Keys()) as HolderKeys;
  write(LS_KEYS, memKeys);
  return memKeys;
}

export function loadCredential(issuerKid?: string): HeldCredentialV1 | undefined {
  const c = memCred ?? read<HeldCredentialV1>(LS_CRED);
  if (!c) return undefined;
  if (issuerKid && c.issuerKid !== issuerKid) {
    clearHolder();
    return undefined;
  }
  return (memCred = c);
}

export function saveCredential(c: HeldCredentialV1): void {
  memCred = c;
  write(LS_CRED, c);
}

export function clearHolder(): void {
  memKeys = undefined;
  memCred = undefined;
  try {
    localStorage.removeItem(LS_KEYS);
    localStorage.removeItem(LS_CRED);
  } catch { /* nothing stored */ }
}
