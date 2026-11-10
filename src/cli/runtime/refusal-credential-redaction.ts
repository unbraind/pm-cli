/**
 * @module cli/runtime/refusal-credential-redaction
 * Removes URL credentials from every representation a CLI refusal prints on
 * stdout or stderr (pm-nhauur). Recovery builders receive the invocation with
 * each token already redacted, so anything they derive from it (lower-cased,
 * truncated, re-quoted or wrapped) is safe by construction. What a producer
 * echoed from the raw invocation is removed from the guidance itself, the one
 * object every JSON and text refusal is rendered from, and every executable
 * retry is withheld there when the invocation carried credentials.
 */
import {
  URL_CREDENTIAL_PLACEHOLDER,
  invocationCarriesUrlCredentials,
  redactUrlCredentialsInText,
  redactUrlCredentialsInToken,
} from "../../sdk/command-line.js";

/** Context and envelope fields holding one argv token per entry. */
const ARGV_TOKEN_FIELDS: ReadonlySet<string> = new Set([
  "normalized_args",
  "suggested_retry_args",
  "provided_fields",
  "parsed_positionals",
  "normalizedInvocationArgs",
  "providedOptionFlags",
  "suggestedRetryArgs",
]);

/**
 * Contract fields the CLI itself fills from a closed vocabulary. They never
 * echo caller input, and a secret's fragments must not rewrite them: a
 * client dispatches on `code` (Greptile review on PR #1701).
 */
const FIXED_CONTRACT_FIELDS: ReadonlySet<string> = new Set([
  "code",
  "original_code",
  "type",
  "recovery_mode",
  "option_scope",
  "diagnostic_class",
]);

/** Final guidance step whenever an invocation's URL credentials were removed. */
export const RESTORE_CREDENTIALS_STEP =
  `URL credentials in this invocation were replaced with ${URL_CREDENTIAL_PLACEHOLDER}; restore them before replaying any command shown here.`;

/** Redact each token, so builders derive guidance only from credential-free arguments. */
export function redactRefusalArgv(argv: readonly string[]): string[] {
  return argv.map(redactUrlCredentialsInToken);
}

interface RedactionPass {
  /** Shared or cyclic references map to one redacted copy, so no alias keeps the raw value. */
  copies: Map<object, unknown>;
  changed: boolean;
}

/** Producers may key diagnostics by a source URL; a redacted key that collides gets a numbered suffix. */
function redactKey(key: string, copy: Record<string, unknown>, pass: RedactionPass): string {
  const safe = redactUrlCredentialsInText(key);
  if (safe !== key) pass.changed = true;
  // Original keys are unique, so only a key a redacted one already took can collide.
  let candidate = safe;
  for (let suffix = 2; Object.hasOwn(copy, candidate); suffix += 1) candidate = `${safe} (${suffix})`;
  return candidate;
}

function redactValue(value: unknown, pass: RedactionPass, tokenField: boolean): unknown {
  // The restore step is this module's own text; redacting it again would garble and duplicate it.
  if (value === RESTORE_CREDENTIALS_STEP) return value;
  if (typeof value === "string") {
    // An argv token is redacted whole, even when its userinfo contains whitespace.
    const redacted = tokenField ? redactUrlCredentialsInToken(value) : redactUrlCredentialsInText(value);
    if (redacted !== value) pass.changed = true;
    return redacted;
  }
  if (typeof value !== "object" || value === null) return value;
  const existing = pass.copies.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    pass.copies.set(value, copy);
    for (const entry of value) copy.push(redactValue(entry, pass, tokenField));
    return copy;
  }
  const copy: Record<string, unknown> = {};
  pass.copies.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    if (FIXED_CONTRACT_FIELDS.has(key) && typeof entry === "string") {
      copy[key] = entry;
      continue;
    }
    copy[redactKey(key, copy, pass)] = redactValue(entry, pass, tokenField || ARGV_TOKEN_FIELDS.has(key));
  }
  return copy;
}

type RecoveryShape = { suggested_retry?: string; suggested_retry_args?: string[] };

/**
 * Redact one refusal's guidance before it becomes a JSON envelope or text,
 * so the diagnostic budget and output accounting measure what is delivered.
 * When anything was removed or the invocation carried credentials, the
 * executable retry is withheld, since it would run a different command, and
 * the guidance gains one restore step. Returns the original object otherwise.
 */
export function redactGuidanceCredentials<T extends { recovery?: RecoveryShape; nextSteps?: string[] }>(guidance: T): T {
  const pass: RedactionPass = { copies: new Map(), changed: false };
  const safe = redactValue(guidance, pass, false) as T;
  if (!pass.changed && !invocationCarriesUrlCredentials()) return guidance;
  if (safe.recovery) safe.recovery = { ...safe.recovery, suggested_retry: undefined, suggested_retry_args: undefined };
  const steps = safe.nextSteps ?? [];
  if (!steps.includes(RESTORE_CREDENTIALS_STEP)) safe.nextSteps = [...steps, RESTORE_CREDENTIALS_STEP];
  return safe;
}
