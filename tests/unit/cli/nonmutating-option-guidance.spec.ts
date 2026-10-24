import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCommanderErrorForJson } from "../../../src/cli/error-guidance.js";
import { maybeRenderBootstrapJsonHelp } from "../../../src/cli/help-json-payload.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent command guidance", () => {
  it("preserves an existing activity lower bound instead of accepting a fallback that drops it", () => {
    const timestamp = "2026-02-01T00:00:00.000Z";
    const existingBound = "2026-01-01T00:00:00.000Z";
    const refusal = formatCommanderErrorForJson("unknown option '--since'", "activity", "Task|Issue", 2, {
      normalizedInvocationArgs: ["activity", "--since", timestamp, "--from", existingBound, "--raw"],
      suggestedRetryCommand: `pm activity --from ${timestamp} --raw`,
    });
    expect(refusal.code).toBe("unknown_option");
    expect(refusal.recovery?.suggested_retry).toBeUndefined();
    expect(refusal.recovery?.suggested_retry_args).toBeUndefined();
  });

  it("preserves explicit JSON intent when TOON conflicts even with a supplied fallback", () => {
    const refusal = formatCommanderErrorForJson("unknown option '--toon'", "get", "Task|Issue", 2, {
      normalizedInvocationArgs: ["get", "pm-one", "--json", "--toon"],
      suggestedRetryCommand: "pm get pm-one --output-format toon",
    });
    expect(refusal.recovery?.suggested_retry).toBeUndefined();
    expect(refusal.recovery?.suggested_retry_args).toBeUndefined();
  });
  it("prioritizes a semantic read correction over a supplied fallback", () => {
    const refusal = formatCommanderErrorForJson("unknown option '--full'", "context", "Task|Issue", 2, {
      normalizedInvocationArgs: ["context", "--full", "--pm-path", "tracker with spaces", "--no-extensions", "--json"],
      suggestedRetryCommand: "pm context --help",
    });
    expect(refusal.code).toBe("unknown_option");
    expect(refusal.recovery?.suggested_retry_args).toEqual([
      "context", "--depth", "full", "--pm-path", "tracker with spaces", "--no-extensions", "--json",
    ]);
    expect(refusal.recovery?.suggested_retry).toContain("pm context --depth full");
  });
  it("preserves read intent when no command was resolved", () => {
    const refusal = formatCommanderErrorForJson("unknown option '--toon'", undefined, "Task|Issue", 2);
    expect(refusal.code).toBe("unknown_option");
    expect(refusal.recovery?.suggested_retry).toBeUndefined();
    expect(refusal.recovery?.suggested_retry_args).toBeUndefined();
    expect(refusal.examples).toEqual(["pm --help --all"]);
  });
  it.each(["--full", "--ful"])("preserves unsupported read intent %s in the real JSON refusal", (option) => {
    const refusal = formatCommanderErrorForJson(`unknown option '${option}'`, "telemetry status", "Task|Issue", 2, {
      normalizedInvocationArgs: ["telemetry", "status", option, "--json"],
    });
    expect(refusal.code).toBe("unknown_option");
    expect(refusal.recovery?.suggested_retry).toBeUndefined();
    expect(refusal.recovery?.suggested_retry_args).toBeUndefined();
  });
  it("preserves preview intent even when a producer supplies a retry", () => {
    for (const option of ["--dry-run", "--dry-run=true"]) {
      const refusal = formatCommanderErrorForJson(
        `unknown option '${option}'`,
        "close",
        "Task|Issue",
        2,
        {
          normalizedInvocationArgs: ["close", "pm-sample", "done", option],
          suggestedRetryCommand: "pm close pm-sample done",
        },
      );
      expect(refusal.code).toBe("unknown_option");
      expect(refusal.recovery?.suggested_retry).toBeUndefined();
      expect(refusal.recovery?.suggested_retry_args).toBeUndefined();
      expect(refusal.next_steps).toContainEqual(
        expect.stringContaining("preview"),
      );
    }
  });

  it("reports the terminal command for an executable alias", async () => {
    const root = new Command("pm");
    root.command("restore").argument("<id>").argument("<target>");
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    expect(
      await maybeRenderBootstrapJsonHelp(
        root,
        ["help", "restore", "--json"],
        new Map(),
      ),
    ).toBe(true);
    const payload = JSON.parse(String(stdout.mock.calls[0]?.[0])) as {
      requested_path: string[];
      resolved_path: string;
    };
    expect(payload.requested_path).toEqual(["restore"]);
    expect(payload.resolved_path).toBe("history restore");
  });
});
