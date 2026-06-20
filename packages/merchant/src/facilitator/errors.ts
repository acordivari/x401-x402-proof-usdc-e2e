/**
 * Facilitator error taxonomy. The resilient client only retries *transient*
 * failures (network blips, facilitator 5xx); terminal failures (an invalid or
 * rejected payment) must never be retried — retrying them can't help and risks
 * corrupting state.
 */
export class TransientFacilitatorError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "TransientFacilitatorError";
  }
}

export class TerminalFacilitatorError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "TerminalFacilitatorError";
  }
}

export function isTransient(err: unknown): boolean {
  return err instanceof TransientFacilitatorError;
}
