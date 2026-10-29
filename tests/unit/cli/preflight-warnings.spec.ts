import { afterEach, expect, it, vi } from "vitest";
import {
  attachPreflightWarnings,
  attachSerializedPreflightWarnings,
  emitPreflightWarning,
  runWithPreflightWarnings,
} from "../../../src/cli/preflight-warnings.js";

afterEach(() => vi.restoreAllMocks());

it("preserves immediate human diagnostics and leaves warning-free errors unchanged", async () => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const envelope = { code: "command_failed" };
  emitPreflightWarning("first");
  await runWithPreflightWarnings(false, async () =>
    emitPreflightWarning("second", "Human explanation"),
  );
  expect(output.mock.calls.map(([text]) => text)).toEqual([
    "warning:first\n",
    "Human explanation\n",
  ]);
  expect(attachPreflightWarnings(envelope)).toBe(envelope);
  expect(attachSerializedPreflightWarnings("original bytes")).toBe(
    "original bytes",
  );
});

it("retains existing warnings and consumes deduplicated preflight codes into one failure", async () => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await runWithPreflightWarnings(true, async () => {
    emitPreflightWarning("secret_guard_detected");
    emitPreflightWarning("secret_guard_detected", "Review the detected input.");
    emitPreflightWarning("secret_guard_detected");
    expect(
      attachPreflightWarnings({
        code: "command_failed",
        warnings: ["handler_advisory"],
        warning_details: [
          { code: "handler_advisory", message: "Existing guidance" },
        ],
      }),
    ).toEqual({
      code: "command_failed",
      warnings: ["handler_advisory", "secret_guard_detected"],
      warning_details: [
        { code: "handler_advisory", message: "Existing guidance" },
        {
          code: "secret_guard_detected",
          message: "Review the detected input.",
        },
      ],
    });
    expect(attachSerializedPreflightWarnings("unchanged")).toBe("unchanged");
  });
  expect(output).not.toHaveBeenCalled();
});

it("attaches warnings to a serialized usage refusal without a second diagnostic", async () => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await runWithPreflightWarnings(true, async () => {
    emitPreflightWarning(
      "settings_read_fs_error",
      "Run pm health for remediation.",
    );
    expect(
      JSON.parse(
        attachSerializedPreflightWarnings(
          '{"code":"invalid_command_usage","exit_code":2}',
        ),
      ),
    ).toEqual({
      code: "invalid_command_usage",
      exit_code: 2,
      warnings: ["settings_read_fs_error"],
      warning_details: [
        {
          code: "settings_read_fs_error",
          message: "Run pm health for remediation.",
        },
      ],
    });
  });
  expect(output).not.toHaveBeenCalled();
});

it("isolates nested and concurrent invocations while emitting successful JSON advisories once", async () => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await Promise.all(
    ["first", "second"].map((code) =>
      runWithPreflightWarnings(true, async () => {
        emitPreflightWarning(code);
        await runWithPreflightWarnings(false, async () =>
          emitPreflightWarning("human"),
        );
        await runWithPreflightWarnings(true, async () =>
          emitPreflightWarning(`${code}_nested`),
        );
      }),
    ),
  );
  const chunks = output.mock.calls.map(([text]) => String(text));
  expect(chunks.filter((text) => text === "warning:human\n")).toHaveLength(2);
  expect(
    chunks
      .filter((text) => text.startsWith("{"))
      .map((text) => JSON.parse(text)),
  ).toEqual(
    expect.arrayContaining(
      ["first", "second", "first_nested", "second_nested"].map((code) => ({
        type: "warning",
        warnings: [code],
      })),
    ),
  );
  expect(chunks).toHaveLength(6);
});

it("propagates unexpected failures without leaking their invocation scope", async () => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const error = new Error("outside normal CLI error handling");
  await expect(
    runWithPreflightWarnings(true, async () => {
      emitPreflightWarning("abandoned");
      throw error;
    }),
  ).rejects.toBe(error);
  emitPreflightWarning("next");
  expect(output.mock.calls.map(([text]) => text)).toEqual(["warning:next\n"]);
});
