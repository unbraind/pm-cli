import { describe, expect, it } from "vitest";
import { quoteCommandArg } from "../../../../src/core/shared/command-line.js";
import type { PmCliErrorContext } from "../../../../src/core/shared/errors.js";
import {
  redactRefusalCredentials,
  redactRefusalEnvelopeCredentials,
  redactRefusalTextCredentials,
} from "../../../../src/cli/runtime/refusal-credential-redaction.js";

const SOURCE = "https://u:fake-secret@example.invalid/x.tgz";
const SAFE_SOURCE = "https://[redacted]@example.invalid/x.tgz";
const RESTORE = /restore them before replaying/;

describe("refusal credential redaction (pm-nhauur)", () => {
  it("returns the original message and context when nothing carries credentials", () => {
    const context: PmCliErrorContext = { code: "unknown_option", recovery: { suggested_retry: "pm list" } };
    const result = redactRefusalCredentials(["list", "--bogus"], "Unknown option --bogus", context);
    expect(result.message).toBe("Unknown option --bogus");
    expect(result.context).toBe(context);
    expect(redactRefusalCredentials(["list"], "plain", undefined)).toEqual({ message: "plain", context: undefined });
  });

  it("redacts every field, withholds the changed retry and names what to restore", () => {
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
    const { message, context: safe } = redactRefusalCredentials(argv, `Cannot install ${SOURCE}`, context);
    expect(message).toBe(`Cannot install ${SAFE_SOURCE}`);
    expect(JSON.stringify(safe)).not.toContain("fake-secret");
    expect(safe?.recovery?.suggested_retry).toBeUndefined();
    expect(safe?.recovery?.suggested_retry_args).toBeUndefined();
    expect(safe?.recovery?.normalized_args).toEqual(["package", "install", SAFE_SOURCE, "--bogus"]);
    expect(safe?.recovery?.parsed_positionals).toEqual([{ role: "source", value: SAFE_SOURCE }]);
    expect(safe?.nextSteps?.at(-1)).toMatch(RESTORE);
    expect(context.recovery?.suggested_retry).toContain("fake-secret");
  });

  it("withholds a retry whose arguments alone changed and keeps an unchanged one", () => {
    const argv = ["package", "install", SOURCE];
    const argsOnly = redactRefusalCredentials(argv, "refused", { recovery: { suggested_retry: "pm package --help", suggested_retry_args: argv } });
    expect(argsOnly.context?.recovery).toEqual(expect.objectContaining({ suggested_retry: undefined, suggested_retry_args: undefined }));
    const kept = redactRefusalCredentials(argv, `refused ${SOURCE}`, { recovery: { suggested_retry: "pm package --help" } });
    expect(kept.context?.recovery?.suggested_retry).toBe("pm package --help");
    expect(kept.context?.nextSteps).toEqual([expect.stringMatching(RESTORE)]);
    const noRecovery = redactRefusalCredentials(argv, "refused", { code: "x", path: SOURCE });
    expect(noRecovery.context).toEqual({ code: "x", path: SAFE_SOURCE, nextSteps: [expect.stringMatching(RESTORE)] });
  });

  it("removes userinfo containing whitespace and shell escapes from every rendered spelling", () => {
    const spaced = 'https://u:my "pass\\word@example.invalid/x.tgz';
    const inline = `--install=${spaced}`;
    const argv = ["package", inline, "key=https://k:v@h/x"];
    const rendered = [quoteCommandArg(inline, "linux"), quoteCommandArg(inline, "win32"), spaced].join(" | ");
    const { context } = redactRefusalCredentials(argv, "refused", {
      recovery: { attempted_command: rendered, provided_fields: [inline] },
      code: "unknown_option",
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toMatch(/my |pass|k:v/);
    expect(context?.recovery?.provided_fields).toEqual(["--install=https://[redacted]@example.invalid/x.tgz"]);
  });

  it("redacts shared and cyclic references once, so no alias keeps the raw token", () => {
    const shared = [SOURCE];
    const cyclic: Record<string, unknown> = { value: SOURCE };
    cyclic.self = cyclic;
    const context = { recovery: { normalized_args: shared, provided_fields: shared }, details: cyclic } as unknown as PmCliErrorContext;
    const safe = redactRefusalCredentials([SOURCE], "refused", context).context as unknown as {
      recovery: { normalized_args: string[]; provided_fields: string[] };
      details: { value: string; self: unknown };
    };
    expect(safe.recovery.normalized_args).toEqual([SAFE_SOURCE]);
    expect(safe.recovery.provided_fields).toBe(safe.recovery.normalized_args);
    expect(safe.details.value).toBe(SAFE_SOURCE);
    expect(safe.details.self).toBe(safe.details);
  });

  it("redacts a rendered envelope before accounting and appends the restore step", () => {
    const envelope = {
      code: "unknown_option",
      next_steps: [`Replay: pm package install ${SOURCE}`],
      examples: [`pm package install ${SOURCE}`],
      recovery: { suggested_retry: `pm package install ${SOURCE}`, normalized_args: ["package", SOURCE], count: 2, ok: true },
    };
    const safe = redactRefusalEnvelopeCredentials(["package", SOURCE], envelope);
    expect(JSON.stringify(safe)).not.toContain("fake-secret");
    expect(safe.recovery.suggested_retry).toBeUndefined();
    expect(safe.recovery).toEqual(expect.objectContaining({ count: 2, ok: true }));
    expect(safe.next_steps.at(-1)).toMatch(RESTORE);
    const withoutSteps = redactRefusalEnvelopeCredentials([SOURCE], { detail: SOURCE }) as { next_steps?: string[] };
    expect(withoutSteps.next_steps).toEqual([expect.stringMatching(RESTORE)]);
    const untouched = { code: "x", next_steps: ["none"] };
    expect(redactRefusalEnvelopeCredentials(["list"], untouched)).toBe(untouched);
  });

  it("redacts rendered text and appends the restore note only when something changed", () => {
    const text = `Error: refused\nRecovery bundle:\n  attempted_command: pm package install ${SOURCE}`;
    const safe = redactRefusalTextCredentials(["package", "install", SOURCE], text);
    expect(safe).not.toContain("fake-secret");
    expect(safe).toMatch(RESTORE);
    expect(redactRefusalTextCredentials(["list"], "Error: refused")).toBe("Error: refused");
  });
});
