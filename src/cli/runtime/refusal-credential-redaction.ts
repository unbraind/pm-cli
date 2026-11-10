/**
 * @module cli/runtime/refusal-credential-redaction
 * Removes URL credentials from every representation a CLI refusal prints on
 * stdout or stderr (pm-nhauur). Recovery guidance is built from the raw argv
 * in many producers, so the redaction runs once, at emission, over the whole
 * envelope instead of at each producer.
 */
import type { PmCliErrorContext } from "../../sdk/runtime-primitives.js";
import {
  URL_CREDENTIAL_PLACEHOLDER,
  quoteCommandArg,
  redactUrlCredentialsInText,
  redactUrlCredentialsInToken,
} from "../../sdk/command-line.js";

/** Context fields holding one argv token per entry, so whitespace inside a userinfo never splits it. */
const ARGV_TOKEN_FIELDS: ReadonlySet<string> = new Set([
  "normalized_args",
  "suggested_retry_args",
  "provided_fields",
  "parsed_positionals",
]);

const RESTORE_CREDENTIALS_STEP =
  `URL credentials in this invocation were replaced with ${URL_CREDENTIAL_PLACEHOLDER}; restore them before replaying any command shown here.`;

type Spelling = readonly [raw: string, safe: string];

/**
 * Every exact spelling of a credential-bearing argv token and inline option
 * value, raw and as both shells render it, longest first. These catch a
 * userinfo that contains whitespace or shell-escaped characters wherever a
 * producer echoed the token.
 */
function knownCredentialSpellings(argv: readonly string[]): Spelling[] {
  const spellings = new Map<string, string>();
  for (const token of argv) {
    const equals = token.indexOf("=");
    for (const value of token.startsWith("-") && equals > 0 ? [token, token.slice(equals + 1)] : [token]) {
      const safe = redactUrlCredentialsInToken(value);
      if (safe === value) continue;
      spellings.set(value, safe);
      for (const platform of ["linux", "win32"] as const) {
        // A token that needs no quoting renders as itself; keep its raw replacement.
        const rendered = quoteCommandArg(value, platform);
        if (rendered !== value) spellings.set(rendered, quoteCommandArg(safe, platform));
      }
    }
  }
  return [...spellings].sort(([left], [right]) => right.length - left.length);
}

function redactText(text: string, spellings: readonly Spelling[]): string {
  let redacted = text;
  for (const [raw, safe] of spellings) {
    if (redacted.includes(raw)) redacted = redacted.replaceAll(raw, safe);
  }
  return redactUrlCredentialsInText(redacted);
}

interface RedactionPass {
  spellings: readonly Spelling[];
  /** Shared or cyclic references map to one redacted copy, so no alias keeps the raw value. */
  copies: Map<object, unknown>;
  changed: boolean;
}

function redactValue(value: unknown, pass: RedactionPass, tokenField: boolean): unknown {
  if (typeof value === "string") {
    const redacted = redactText(tokenField ? redactUrlCredentialsInToken(value) : value, pass.spellings);
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
 * Redact one refusal payload (an error context or a rendered envelope). A
 * retry whose text changed would now run a different command, one without
 * its credentials, so the executable retry is withheld and the guidance says
 * what to restore. Returns the original object when nothing changed.
 */
function redactPayload<T extends { recovery?: RecoveryShape }>(pass: RedactionPass, payload: T, nextStepsKey: "nextSteps" | "next_steps"): T {
  const safe = redactValue(payload, pass, false) as T;
  if (!pass.changed) return payload;
  const original = payload.recovery;
  if (original && safe.recovery
    && (original.suggested_retry !== safe.recovery.suggested_retry
      || JSON.stringify(original.suggested_retry_args) !== JSON.stringify(safe.recovery.suggested_retry_args))) {
    safe.recovery = { ...safe.recovery, suggested_retry: undefined, suggested_retry_args: undefined };
  }
  const record = safe as Record<string, unknown>;
  const steps = record[nextStepsKey];
  record[nextStepsKey] = [...(Array.isArray(steps) ? steps : []), RESTORE_CREDENTIALS_STEP];
  return safe;
}

function newPass(argv: readonly string[]): RedactionPass {
  return { spellings: knownCredentialSpellings(argv), copies: new Map(), changed: false };
}

/** Redact a typed refusal's message and context before it is formatted, reported or measured. */
export function redactRefusalCredentials(
  argv: readonly string[],
  message: string,
  context: PmCliErrorContext | undefined,
): { message: string; context: PmCliErrorContext | undefined } {
  const pass = newPass(argv);
  const safeMessage = redactValue(message, pass, false) as string;
  return { message: safeMessage, context: context === undefined ? undefined : redactPayload(pass, context, "nextSteps") };
}

/** Redact a rendered JSON refusal envelope (Commander usage errors) before output accounting measures it. */
export function redactRefusalEnvelopeCredentials<T extends object>(argv: readonly string[], envelope: T): T {
  return redactPayload(newPass(argv), envelope as T & { recovery?: RecoveryShape }, "next_steps");
}

/** Redact a rendered text refusal; text has no executable retry field to withhold, so it gains the restore note. */
export function redactRefusalTextCredentials(argv: readonly string[], text: string): string {
  const redacted = redactText(text, knownCredentialSpellings(argv));
  return redacted === text ? text : `${redacted}\n\n${RESTORE_CREDENTIALS_STEP}`;
}
