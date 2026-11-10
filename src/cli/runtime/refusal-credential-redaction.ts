/**
 * @module cli/runtime/refusal-credential-redaction
 * Removes URL credentials from every representation a CLI refusal prints on
 * stdout or stderr (pm-nhauur). Recovery builders receive the invocation with
 * each token already redacted, so anything they derive from it (lower-cased,
 * truncated, re-quoted or wrapped) is safe by construction. What a producer
 * echoed from the raw invocation is removed at emission. When the invocation
 * carried credentials, every executable retry is withheld from the formatted
 * envelope, because formatters regenerate retries from the recovery arguments.
 */
import type { PmCliErrorContext } from "../../sdk/runtime-primitives.js";
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

/** Final guidance step whenever an invocation's URL credentials were removed. */
export const RESTORE_CREDENTIALS_STEP =
  `URL credentials in this invocation were replaced with ${URL_CREDENTIAL_PLACEHOLDER}; restore them before replaying any command shown here.`;

/** Redact each token, so builders derive guidance only from credential-free arguments. */
export function redactRefusalArgv(argv: readonly string[]): string[] {
  return argv.map(redactUrlCredentialsInToken);
}

/** Whether the running invocation, or the given argv, carried possible URL userinfo. */
function carriesCredentials(argv: readonly string[]): boolean {
  return invocationCarriesUrlCredentials() || argv.some((token) => redactUrlCredentialsInToken(token) !== token);
}

interface RedactionPass {
  /** Shared or cyclic references map to one redacted copy, so no alias keeps the raw value. */
  copies: Map<object, unknown>;
  changed: boolean;
}

function redactValue(value: unknown, pass: RedactionPass, tokenField: boolean): unknown {
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
    copy[key] = redactValue(entry, pass, tokenField || ARGV_TOKEN_FIELDS.has(key));
  }
  return copy;
}

type RecoveryShape = { suggested_retry?: string; suggested_retry_args?: string[] };

/**
 * Redact one refusal payload (an error context or a rendered envelope). When
 * anything was removed or the invocation carried credentials, the executable
 * retry is withheld, since it would run a different command, and the
 * guidance gains one restore step. Returns the original object otherwise.
 */
function redactPayload<T extends { recovery?: RecoveryShape }>(argv: readonly string[], payload: T, nextStepsKey: "nextSteps" | "next_steps"): T {
  const pass: RedactionPass = { copies: new Map(), changed: false };
  const safe = redactValue(payload, pass, false) as T;
  if (!pass.changed && !carriesCredentials(argv)) return payload;
  if (safe.recovery) safe.recovery = { ...safe.recovery, suggested_retry: undefined, suggested_retry_args: undefined };
  const record = safe as Record<string, unknown>;
  const steps = Array.isArray(record[nextStepsKey]) ? (record[nextStepsKey] as unknown[]) : [];
  if (!steps.includes(RESTORE_CREDENTIALS_STEP)) record[nextStepsKey] = [...steps, RESTORE_CREDENTIALS_STEP];
  return safe;
}

/** Redact a typed refusal's context before it is formatted, reported or measured. */
export function redactRefusalCredentials(argv: readonly string[], context: PmCliErrorContext | undefined): PmCliErrorContext | undefined {
  return context === undefined ? undefined : redactPayload(argv, context, "nextSteps");
}

/** Redact and withhold on a formatted JSON envelope, before lean projection and output accounting measure it. */
export function redactRefusalEnvelopeCredentials<T extends object>(argv: readonly string[], envelope: T): T {
  return redactPayload(argv, envelope as T & { recovery?: RecoveryShape }, "next_steps");
}

/** Redact a rendered text refusal; text has no retry field to withhold, so it carries the restore note instead. */
export function redactRefusalTextCredentials(argv: readonly string[], text: string): string {
  const redacted = redactUrlCredentialsInText(text);
  if ((redacted === text && !carriesCredentials(argv)) || redacted.includes(RESTORE_CREDENTIALS_STEP)) return redacted;
  return `${redacted}\n\n${RESTORE_CREDENTIALS_STEP}`;
}
