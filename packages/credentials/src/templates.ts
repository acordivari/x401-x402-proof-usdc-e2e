/**
 * Proof's `transaction_data` templates — the Sign Transactions catalog.
 *
 * Each template is an OID4VP `transaction_data` object (`type`,
 * `credential_ids`, `payload`), base64url-encoded on the wire. The wallet shows
 * the terms exactly as sent, and the Key Binding JWT carries each one's
 * `payload` back as a signed TOP-LEVEL claim named after the template
 * (`payment_itemized_v1`, ...). So the verifier's check is "terms match": the
 * claim in the holder-signed KB-JWT must equal the payload we asked them to
 * sign, byte-for-byte in meaning. Change one cent after the fact and the
 * signature no longer covers it.
 *
 * The July build used one template for everything (`payment-mandate:v1`, a
 * recurring-charge authorization) and carried its own digest in a sealed
 * challenge. Proof now publishes a template per use case, so a one-off
 * checkout is `payment-itemized:v1` and only a standing authorization is a
 * `payment-mandate:v1`.
 */
import { encodeJsonB64url } from "./crypto.ts";
import { PROOF_SCOPES, scopeDefinition } from "./proof-credential-v1.ts";

export const TX_TEMPLATES = {
  wireInstructions: "urn:proof:params:vc:transaction-data:wire-instructions:v1",
  paymentMandate: "urn:proof:params:vc:transaction-data:payment-mandate:v1",
  paymentItemized: "urn:proof:params:vc:transaction-data:payment-itemized:v1",
  sessionData: "urn:proof:params:vc:transaction-data:session-data",
} as const;
export type TxTemplateType = (typeof TX_TEMPLATES)[keyof typeof TX_TEMPLATES];

/** The KB-JWT claim each template's payload comes back under. */
export const TX_TEMPLATE_CLAIM: Record<TxTemplateType, string> = {
  [TX_TEMPLATES.wireInstructions]: "wire_instructions_v1",
  [TX_TEMPLATES.paymentMandate]: "payment_mandate_v1",
  [TX_TEMPLATES.paymentItemized]: "payment_itemized_v1",
  [TX_TEMPLATES.sessionData]: "session_data",
};

/** `credential_ids` must be exactly this: the basic scope's credential query id. */
export const TX_CREDENTIAL_IDS = ["proof_id_default"] as const;

export interface PaymentMandatePayloadV1 {
  payment_instrument: { type: string; id: string; description?: string };
  payee: { id?: string; name: string; website?: string };
  prompt_summary: string;
  amount: number;
  currency: string;
}

export interface PaymentItemizedPayloadV1 {
  title?: string;
  description?: string;
  currency: string;
  items: { quantity: number; unit_cost: number; label: string }[];
}

export interface SessionDataPayload {
  ip_address: string;
  device_id?: string;
}

export interface WireInstructionsPayloadV1 {
  recipient: {
    individual_name?: string;
    institution_name: string;
    routing_number: string;
    account_number: string;
    website?: string;
  };
  source: {
    individual_name: string;
    institution_name?: string;
    account_number: string;
    routing_number: string;
  };
  amount: number;
  currency: string;
  memo?: string;
}

interface PayloadByType {
  [TX_TEMPLATES.wireInstructions]: WireInstructionsPayloadV1;
  [TX_TEMPLATES.paymentMandate]: PaymentMandatePayloadV1;
  [TX_TEMPLATES.paymentItemized]: PaymentItemizedPayloadV1;
  [TX_TEMPLATES.sessionData]: SessionDataPayload;
}

export interface TransactionDataV1<T extends TxTemplateType = TxTemplateType> {
  type: T;
  credential_ids: string[];
  payload: PayloadByType[T];
}

export function txData<T extends TxTemplateType>(type: T, payload: PayloadByType[T]): TransactionDataV1<T> {
  return { type, credential_ids: [...TX_CREDENTIAL_IDS], payload };
}

export const paymentItemized = (p: PaymentItemizedPayloadV1) => txData(TX_TEMPLATES.paymentItemized, p);
export const paymentMandate = (p: PaymentMandatePayloadV1) => txData(TX_TEMPLATES.paymentMandate, p);
export const sessionData = (p: SessionDataPayload) => txData(TX_TEMPLATES.sessionData, p);
export const wireInstructions = (p: WireInstructionsPayloadV1) => txData(TX_TEMPLATES.wireInstructions, p);

/** base64url(JSON) — one wire value per template. */
export function encodeTxData(td: TransactionDataV1): string {
  return encodeJsonB64url(td);
}

export function decodeTxData(encoded: string): TransactionDataV1 {
  const json = typeof atob === "function"
    ? new TextDecoder().decode(Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))
    : Buffer.from(encoded, "base64url").toString("utf8");
  const td = JSON.parse(json) as TransactionDataV1;
  if (!td || typeof td.type !== "string" || !Array.isArray(td.credential_ids) || typeof td.payload !== "object") {
    throw new Error("malformed transaction_data");
  }
  return td;
}

/**
 * Mirror Proof's request-side rules so a request that Proof would reject fails
 * here first: `credential_ids` exactly `["proof_id_default"]`, known template
 * types only, and transaction_data only alongside the basic scope.
 */
export function assertTxDataAllowed(scope: string, tds: TransactionDataV1[]): void {
  if (tds.length === 0) return;
  if (!scopeDefinition(scope).acceptsTransactionData) {
    throw new Error(`transaction_data is only accepted with ${PROOF_SCOPES.basic}`);
  }
  for (const td of tds) {
    if (!(td.type in TX_TEMPLATE_CLAIM)) throw new Error(`unsupported transaction_data type ${td.type}`);
    if (td.credential_ids.length !== 1 || td.credential_ids[0] !== TX_CREDENTIAL_IDS[0]) {
      throw new Error('transaction_data credential_ids must be exactly ["proof_id_default"]');
    }
  }
}

/** Deterministic JSON (sorted keys) so "same terms" never depends on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface TermsCheck {
  type: TxTemplateType;
  claim: string;
  /** The KB-JWT carried the claim at all. */
  present: boolean;
  /** ...and it equals what we sent. */
  matches: boolean;
}

/**
 * "Terms match": every template we sent must come back, unchanged, as its
 * top-level claim in the holder-signed KB-JWT. Missing counts as a mismatch —
 * a presentation that omits the terms did not consent to them.
 */
export function checkTerms(kbPayload: Record<string, unknown>, sent: TransactionDataV1[]): TermsCheck[] {
  return sent.map((td) => {
    const claim = TX_TEMPLATE_CLAIM[td.type];
    const got = kbPayload[claim];
    return {
      type: td.type,
      claim,
      present: got !== undefined,
      matches: got !== undefined && canonicalJson(got) === canonicalJson(td.payload),
    };
  });
}

/** Total of an itemized payment in its own (decimal) currency units. */
export function itemizedTotal(p: PaymentItemizedPayloadV1): number {
  return Math.round(p.items.reduce((s, it) => s + it.quantity * it.unit_cost, 0) * 100) / 100;
}
