/**
 * A tiny validation-result type shared by every validator so the whole system
 * reports failures the same way: either ok, or a list of human-readable
 * violations. Keeps payment + mandate validators DRY and uniformly testable.
 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; violations: string[] };

export const ok = (): ValidationResult => ({ ok: true });

export const fail = (violations: string[]): ValidationResult => ({
  ok: false,
  violations,
});

/** Collapse a list of "violation or null" checks into a single result. */
export function collect(checks: Array<string | null | undefined>): ValidationResult {
  const violations = checks.filter((c): c is string => Boolean(c));
  return violations.length === 0 ? ok() : fail(violations);
}
