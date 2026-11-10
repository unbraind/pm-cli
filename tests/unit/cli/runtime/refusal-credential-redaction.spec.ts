import { afterEach, describe, expect, it } from "vitest";
import type { PmCliErrorContext } from "../../../../src/core/shared/errors.js";
import { registerUrlCredentialInvocation } from "../../../../src/core/shared/url-credentials.js";
import {
  RESTORE_CREDENTIALS_STEP,
  redactRefusalArgv,
  redactRefusalCredentials,
  redactRefusalEnvelopeCredentials,
  redactRefusalTextCredentials,
} from "../../../../src/cli/runtime/refusal-credential-redaction.js";

const SOURCE = "https://u:fake-secret@example.invalid/x.tgz";
const SAFE_SOURCE = "https://[redacted]@example.invalid/x.tgz";

afterEach(() => registerUrlCredentialInvocation([]));

describe("refusal credential redaction (pm-nhauur)", () => {
  it("returns the original context when the invocation carried no credentials", () => {
    const context: PmCliErrorContext = { code: "unknown_option", recovery: { suggested_retry: "pm list" } };
    expect(redactRefusalCredentials(["list", "--bogus"], context)).toBe(context);
    expect(redactRefusalCredentials(["list"], undefined)).toBeUndefined();
    expect(redactRefusalArgv(["package", "install", SOURCE])).toEqual(["package", "install", SAFE_SOURCE]);
  });

  it("redacts every field, withholds the retry and names what to restore", () => {
    const argv = ["package", "install", SOURCE, "--bogus"];
    const context: PmCliErrorContext = {
      code: "unknown_option",
      nextSteps: [`Replay with suggested correction: pm package install ${SOURCE}`],
      recovery: {
        attempted_command: `pm package install ${SOURCE} --bogus`,
        normalized_args: [...argv],
        parsed_positionals: [{ role: "source", value: SOURCE }],
        suggested_retry: `pm package install ${SOURCE}`,
        suggested_retry_args: ["package", "install", SOURCE],
        fallback_candidates: [{ source: "catalog", command: `pm package install ${SOURCE}`, reason: "nearest" }],
      },
    };
    const safe = redactRefusalCredentials(argv, context);
    expect(JSON.stringify(safe)).not.toContain("fake-secret");
    expect(safe?.recovery?.suggested_retry).toBeUndefined();
    expect(safe?.recovery?.suggested_retry_args).toBeUndefined();
    expect(safe?.recovery?.normalized_args).toEqual(["package", "install", SAFE_SOURCE, "--bogus"]);
    expect(safe?.recovery?.parsed_positionals).toEqual([{ role: "source", value: SAFE_SOURCE }]);
    expect(safe?.nextSteps?.at(-1)).toBe(RESTORE_CREDENTIALS_STEP);
    expect(context.recovery?.suggested_retry).toContain("fake-secret");
  });

  it("withholds a retry rebuilt from already-redacted arguments when the invocation carried credentials", () => {
    registerUrlCredentialInvocation(["package", "install", SOURCE]);
    const rebuilt = { recovery: { suggested_retry: `pm package install ${SAFE_SOURCE}`, suggested_retry_args: ["package", "install", SAFE_SOURCE] } };
    const safe = redactRefusalEnvelopeCredentials(redactRefusalArgv(["package", "install", SOURCE]), rebuilt) as typeof rebuilt & { next_steps: string[] };
    expect(safe.recovery).toEqual({ suggested_retry: undefined, suggested_retry_args: undefined });
    expect(safe.next_steps).toEqual([RESTORE_CREDENTIALS_STEP]);
    const noRecovery = redactRefusalCredentials(["x"], { code: "x", path: SOURCE });
    expect(noRecovery).toEqual({ code: "x", path: SAFE_SOURCE, nextSteps: [RESTORE_CREDENTIALS_STEP] });
  });

  it("adds the restore step once, even when the context already carried it", () => {
    const envelope = { code: "x", next_steps: ["first", RESTORE_CREDENTIALS_STEP], detail: SOURCE };
    expect((redactRefusalEnvelopeCredentials([SOURCE], envelope) as { next_steps: string[] }).next_steps).toEqual(["first", RESTORE_CREDENTIALS_STEP]);
    const untouched = { code: "x", next_steps: ["none"] };
    expect(redactRefusalEnvelopeCredentials(["list"], untouched)).toBe(untouched);
  });

  it("redacts a whitespace-bearing userinfo whole in token fields and through the registry in text", () => {
    const spaced = "https://U:my pass@localhost/x";
    registerUrlCredentialInvocation(["package", spaced]);
    const safe = redactRefusalCredentials(["package", spaced], {
      code: "unknown_command",
      recovery: { attempted_command: `pm package '${spaced.toLowerCase()}'`, normalized_args: ["package", spaced] },
      details: { surface: spaced.toLowerCase() },
    });
    expect(JSON.stringify(safe)).not.toMatch(/my pass/iu);
    expect(safe?.recovery?.normalized_args).toEqual(["package", "https://[redacted]@localhost/x"]);
  });

  it("redacts shared and cyclic references once, so no alias keeps the raw token", () => {
    const shared = [SOURCE];
    const cyclic: Record<string, unknown> = { value: SOURCE };
    cyclic.self = cyclic;
    const context = { recovery: { normalized_args: shared, provided_fields: shared }, details: cyclic } as unknown as PmCliErrorContext;
    const safe = redactRefusalCredentials([SOURCE], context) as unknown as {
      recovery: { normalized_args: string[]; provided_fields: string[] };
      details: { value: string; self: unknown };
    };
    expect(safe.recovery.normalized_args).toEqual([SAFE_SOURCE]);
    expect(safe.recovery.provided_fields).toBe(safe.recovery.normalized_args);
    expect(safe.details.value).toBe(SAFE_SOURCE);
    expect(safe.details.self).toBe(safe.details);
  });

  it("keeps non-string envelope values and redacts camel-case usage token fields", () => {
    const safe = redactRefusalEnvelopeCredentials([SOURCE], {
      count: 2, ok: true, missing: null, normalizedInvocationArgs: ["package", SOURCE], suggestedRetryArgs: [SOURCE], providedOptionFlags: ["--x"],
    });
    expect(safe).toEqual(expect.objectContaining({ count: 2, ok: true, missing: null, normalizedInvocationArgs: ["package", SAFE_SOURCE], suggestedRetryArgs: [SAFE_SOURCE] }));
  });

  it("redacts rendered text and appends the restore note only once and only when needed", () => {
    const text = `Error: refused\nRecovery bundle:\n  attempted_command: pm package install ${SOURCE}`;
    const safe = redactRefusalTextCredentials(["package", "install", SOURCE], text);
    expect(safe).not.toContain("fake-secret");
    expect(safe.endsWith(RESTORE_CREDENTIALS_STEP)).toBe(true);
    expect(redactRefusalTextCredentials([SOURCE], safe)).toBe(safe);
    expect(redactRefusalTextCredentials(["package", SAFE_SOURCE], "Error: refused")).toBe("Error: refused");
    registerUrlCredentialInvocation([SOURCE]);
    expect(redactRefusalTextCredentials(["package", SAFE_SOURCE], "Error: refused")).toBe(`Error: refused\n\n${RESTORE_CREDENTIALS_STEP}`);
  });
});
