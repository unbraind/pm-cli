import { describe, expect, it } from "vitest";
import { resolveLinkedResourcePositionalRecovery } from "../../../src/sdk/index.js";
import { formatCommanderErrorForDisplay, formatCommanderErrorForJson } from "../../../src/cli/error-guidance.js";
import { PM_ERROR_CODE_CATALOG } from "../../../src/sdk/generated-error-code-catalog.js";

describe("linked-resource positional recovery", () => {
  it("publishes the same usage exit class as the CLI refusal", () => {
    const envelope = formatCommanderErrorForJson("too many arguments", "docs", "Task", 2, { normalizedInvocationArgs: ["docs", "pm-x", "design.md"] });
    expect(envelope).toMatchObject({ code: "linked_resource_positional_value", exit_code: 2 });
    expect(PM_ERROR_CODE_CATALOG.find(({ code }) => code === envelope.code)).toMatchObject({ exit_code: envelope.exit_code, class: "usage" });
  });
  it.each([
    ["files", ["files", "pm-x", "src/a.ts", "--json"], ["files", "pm-x", "--add", 'path="src/a.ts"', "--json"]],
    ["docs", ["--pm-path", "docs", "item", "docs", "pm-x", "path=design.md", "--output-budget=500"], ["--pm-path", "docs", "item", "docs", "pm-x", "--add", "path=design.md", "--output-budget=500"]],
    ["test", ["test", "pm-x", "command=node -e 1", "--output-budget", "500"], ["test", "pm-x", "--add-json", '{"command":"node -e 1"}', "--output-budget", "500"]],
    ["test", ["test", "pm-x", "node --version"], ["test", "pm-x", "--add-json", '{"command":"node --version"}']],
  ] as const)("preserves tokens for %s", (command, argv, retry) => {
    expect(resolveLinkedResourcePositionalRecovery(command, argv)?.retryArgs).toEqual(retry);
    const context = { normalizedInvocationArgs: [...argv] };
    const envelope = formatCommanderErrorForJson("too many arguments", command, "Task", 2, context);
    expect(envelope.recovery?.suggested_retry_args).toEqual(retry);
    expect(formatCommanderErrorForDisplay("too many arguments", command, "Task", context)).toContain("--add");
  });
  it.each([
    [undefined, []], ["get", ["get", "pm-x", "extra"]], ["docs", []], ["docs", ["files", "pm-x", "a"]],
    ["docs", ["docs"]], ["docs", ["docs", "add", "pm-x"]], ["docs", ["docs", "--json", "a"]],
    ["docs", ["docs", "pm-x", "--json"]], ["docs", ["docs", "pm-x"]], ["docs", ["docs", "pm-x", ""]],
    ["test", ["test", "pm-x", "status=passed"]], ["docs", ["docs", "pm-x", "a", "--pm-path", "b"]], ["docs", ["docs", "pm-x", "a", "b"]],
    ["test", ["test", "pm-x", "node --version", "--run"]], ["docs", ["docs", "pm-x", "scope=project"]],
    ["docs", ["docs", "pm-x", "a", "--output-budget"]], ["docs", ["docs", "pm-x", "a", "--output-budget", "--json"]],
    ["docs", ["docs", "pm-x", "a", "--all"]],
  ] as const)("does not guess for %s %s", (command, argv) => {
    expect(resolveLinkedResourcePositionalRecovery(command, argv)).toBeUndefined();
  });
  it("names missing command metadata without an executable invented retry", () => {
    const envelope = formatCommanderErrorForJson("too many arguments", "test", "Task", 2, { normalizedInvocationArgs: ["test", "pm-x", "timeout_seconds=3600"] });
    expect(envelope.required).toContain("command=<actual command>,timeout_seconds=3600");
    expect(envelope.required).toContain("pm test pm-x --add");
    expect(envelope.recovery?.suggested_retry_args).toBeUndefined();
    expect(formatCommanderErrorForJson("another failure", "docs", "Task", 2).code).toBe("invalid_command_usage");
  });
  it("retains the selected tracker, canonical command and output flags in a metadata-only template", () => {
    const argv = ["--pm-path", "/foreign/.agents/pm", "item", "test", "pm-x", "timeout_seconds=90", "--json"];
    const recovery = resolveLinkedResourcePositionalRecovery("test", argv);
    expect(recovery?.retryArgs).toBeUndefined();
    expect(recovery?.templateArgs).toEqual(["--pm-path", "/foreign/.agents/pm", "item", "test", "pm-x", "--add", "command=<actual command>,timeout_seconds=90", "--json"]);
    const envelope = formatCommanderErrorForJson("too many arguments", "test", "Task", 2, { normalizedInvocationArgs: argv });
    expect(envelope.examples?.[0]).toContain("--pm-path /foreign/.agents/pm item test pm-x --add");
    expect(envelope.examples?.[0]).toContain("--json");
    expect(envelope.recovery?.suggested_retry_args).toBeUndefined();
  });
});
