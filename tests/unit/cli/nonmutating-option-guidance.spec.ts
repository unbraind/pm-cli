import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCommanderErrorForJson } from "../../../src/cli/error-guidance.js";
import { maybeRenderBootstrapJsonHelp } from "../../../src/cli/help-json-payload.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent command guidance", () => {
  it("preserves preview intent even when a producer supplies a retry", () => {
    const refusal = formatCommanderErrorForJson(
      "unknown option '--dry-run'",
      "close",
      "Task|Issue",
      2,
      {
        normalizedInvocationArgs: ["close", "pm-sample", "done", "--dry-run"],
        suggestedRetryCommand: "pm close pm-sample done",
      },
    );
    expect(refusal.code).toBe("unknown_option");
    expect(refusal.recovery?.suggested_retry).toBeUndefined();
    expect(refusal.recovery?.suggested_retry_args).toBeUndefined();
    expect(refusal.next_steps).toContainEqual(expect.stringContaining("preview"));
  });

  it("reports the terminal command for an executable alias", async () => {
    const root = new Command("pm");
    root.command("restore").argument("<id>").argument("<target>");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await maybeRenderBootstrapJsonHelp(
      root,
      ["help", "restore", "--json"],
      new Map(),
    )).toBe(true);
    const payload = JSON.parse(String(stdout.mock.calls[0]?.[0])) as {
      requested_path: string[];
      resolved_path: string;
    };
    expect(payload.requested_path).toEqual(["restore"]);
    expect(payload.resolved_path).toBe("history restore");
  });
});
