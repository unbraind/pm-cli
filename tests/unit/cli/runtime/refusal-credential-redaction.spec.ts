import { describe, expect, it } from "vitest";
import { runWithUrlCredentialInvocation } from "../../../../src/core/shared/url-credentials.js";
import {
  RESTORE_CREDENTIALS_STEP,
  redactGuidanceCredentials,
  redactRefusalArgv,
} from "../../../../src/cli/runtime/refusal-credential-redaction.js";

const SOURCE = "https://u:fake-secret@example.invalid/x.tgz";
const SAFE_SOURCE = "https://[redacted]@example.invalid/x.tgz";

describe("refusal credential redaction (pm-nhauur)", () => {
  it("returns the original guidance when the invocation carried no credentials", () => {
    const guidance = { code: "unknown_option", nextSteps: ["pm list --help"], recovery: { suggested_retry: "pm list" } };
    expect(redactGuidanceCredentials(guidance)).toBe(guidance);
    expect(redactRefusalArgv(["package", "install", SOURCE, "--json"])).toEqual(["package", "install", SAFE_SOURCE, "--json"]);
  });

  it("redacts every field, withholds the retry and names what to restore", () => {
    const argv = ["package", "install", SOURCE, "--bogus"];
    const guidance = {
      title: `Cannot install ${SOURCE}`,
      examples: [`pm package install ${SOURCE}`],
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
    const safe = redactGuidanceCredentials(guidance);
    expect(JSON.stringify(safe)).not.toContain("fake-secret");
    expect(safe.recovery.suggested_retry).toBeUndefined();
    expect(safe.recovery.suggested_retry_args).toBeUndefined();
    expect(safe.recovery.normalized_args).toEqual(["package", "install", SAFE_SOURCE, "--bogus"]);
    expect(safe.recovery.parsed_positionals).toEqual([{ role: "source", value: SAFE_SOURCE }]);
    expect(safe.nextSteps.at(-1)).toBe(RESTORE_CREDENTIALS_STEP);
    expect(guidance.recovery.suggested_retry).toContain("fake-secret");
  });

  it("withholds a retry rebuilt from already-redacted arguments when the invocation carried credentials", () => {
    const rebuilt = { recovery: { suggested_retry: `pm package install ${SAFE_SOURCE}`, suggested_retry_args: ["package", "install", SAFE_SOURCE] } };
    const safe = runWithUrlCredentialInvocation(["package", "install", SOURCE], () => redactGuidanceCredentials(rebuilt));
    expect(safe).toEqual({ recovery: { suggested_retry: undefined, suggested_retry_args: undefined }, nextSteps: [RESTORE_CREDENTIALS_STEP] });
    expect(redactGuidanceCredentials({ title: SOURCE })).toEqual({ title: SAFE_SOURCE, nextSteps: [RESTORE_CREDENTIALS_STEP] });
  });

  it("adds the restore step once", () => {
    const guidance = { nextSteps: ["first", RESTORE_CREDENTIALS_STEP], detail: SOURCE };
    expect(redactGuidanceCredentials(guidance).nextSteps).toEqual(["first", RESTORE_CREDENTIALS_STEP]);
  });

  it("redacts a whitespace-bearing userinfo whole in token fields and through the registry in text", () => {
    const spaced = "https://U:my pass@localhost/x";
    const safe = runWithUrlCredentialInvocation(["package", spaced], () => redactGuidanceCredentials({
      happened: `unknown command '${spaced.toLowerCase()}'`,
      recovery: { normalized_args: ["package", spaced], provided_fields: [spaced] },
      details: { surface: JSON.stringify(spaced) },
    }));
    expect(JSON.stringify(safe)).not.toMatch(/my pass/iu);
    expect(safe.recovery.normalized_args).toEqual(["package", "https://[redacted]@localhost/x"]);
  });

  it("redacts shared and cyclic references once, so no alias keeps the raw token", () => {
    const shared = [SOURCE];
    const cyclic: Record<string, unknown> = { value: SOURCE };
    cyclic.self = cyclic;
    const safe = redactGuidanceCredentials({ recovery: { normalized_args: shared, provided_fields: shared }, details: cyclic }) as unknown as {
      recovery: { normalized_args: string[]; provided_fields: string[] };
      details: { value: string; self: unknown };
    };
    expect(safe.recovery.normalized_args).toEqual([SAFE_SOURCE]);
    expect(safe.recovery.provided_fields).toBe(safe.recovery.normalized_args);
    expect(safe.details.value).toBe(SAFE_SOURCE);
    expect(safe.details.self).toBe(safe.details);
  });

  it("redacts credential-bearing dictionary keys and numbers colliding keys", () => {
    const safe = redactGuidanceCredentials({ details: { [SOURCE]: "unavailable", [SAFE_SOURCE]: "kept", other: 1 } });
    expect(safe.details).toEqual({ [SAFE_SOURCE]: "unavailable", [`${SAFE_SOURCE} (2)`]: "kept", other: 1 });
    expect(JSON.stringify(safe)).not.toContain("fake-secret");
  });

  it("never rewrites fixed contract fields with a secret's fragments", () => {
    const safe = runWithUrlCredentialInvocation(["https://u:unknown_option@localhost/x"], () => redactGuidanceCredentials({
      code: "unknown_option",
      recovery: { option_scope: "declared_nowhere", recovery_mode: "compact" },
      detail: "unknown_option refused for https://u:unknown_option@localhost/x",
    }));
    expect(safe.code).toBe("unknown_option");
    expect(safe.recovery).toEqual(expect.objectContaining({ option_scope: "declared_nowhere", recovery_mode: "compact" }));
    expect(safe.detail).not.toContain("u:unknown_option@");
  });

  it("keeps non-string values and redacts camel-case usage token fields", () => {
    const safe = redactGuidanceCredentials({
      count: 2, ok: true, missing: null, normalizedInvocationArgs: ["package", SOURCE], suggestedRetryArgs: [SOURCE], providedOptionFlags: ["--x"],
    });
    expect(safe).toEqual(expect.objectContaining({ count: 2, ok: true, missing: null, normalizedInvocationArgs: ["package", SAFE_SOURCE], suggestedRetryArgs: [SAFE_SOURCE] }));
  });
});
