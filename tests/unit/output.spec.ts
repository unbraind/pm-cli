import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveExtensionHooks,
  setActiveCommandContext,
  setActiveExtensionCommands,
  setActiveExtensionRenderers,
  setActiveExtensionServices,
} from "../../src/core/extensions/index.js";
import { formatOutput, printError, printResult } from "../../src/core/output/output.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";

describe("core/output/output", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
    vi.restoreAllMocks();
  });

  it("formats JSON output with a trailing newline", () => {
    const payload = { ok: true, count: 2 };
    expect(formatOutput(payload, { json: true })).toBe(`${JSON.stringify(payload, null, 2)}\n`);
  });

  it("honors default output format and explicit json overrides", () => {
    const payload = { ok: true };
    const renderedFromDefault = formatOutput(payload, { defaultOutputFormat: "json" });
    expect(renderedFromDefault).toBe(`${JSON.stringify(payload, null, 2)}\n`);

    // Explicit json=false should keep TOON output even when defaults prefer JSON.
    const renderedFromExplicitToon = formatOutput(payload, { json: false, defaultOutputFormat: "json" });
    expect(renderedFromExplicitToon).toContain("ok: true");
  });

  it("renders deterministic TOON output for nested values", () => {
    const rendered = formatOutput(
      {
        text: "hello",
        num: 3,
        bool: false,
        none: null,
        arr_empty: [],
        obj_empty: {},
        arr_scalars: ["x", 2, true, null, undefined],
        arr_single_nested: [{ key: "value", drop: null }],
        arr_multi_line: [{ nested: ["a", { deep: 1, drop: undefined }, {}], empty_nested: [] }, {}],
        nested: { child: { leaf: "done", gone: null }, empty_child: {} },
      },
      {},
    );

    expect(rendered).toContain('text: "hello"');
    expect(rendered).toContain("num: 3");
    expect(rendered).toContain("bool: false");
    expect(rendered).not.toContain("none:");
    expect(rendered).not.toContain("arr_empty:");
    expect(rendered).not.toContain("obj_empty:");
    expect(rendered).toContain('  - "x"');
    expect(rendered).toContain("  - 2");
    expect(rendered).toContain("  - true");
    expect(rendered).not.toContain("  - null");
    expect(rendered).toContain('  - key: "value"');
    expect(rendered).toContain("arr_multi_line:");
    expect(rendered).toContain("- nested:");
    expect(rendered).toContain("- deep: 1");
    expect(rendered).not.toContain("drop:");
    expect(rendered).not.toContain("empty_nested:");
    expect(rendered).not.toContain("empty_child:");
    expect(rendered).toContain("nested:");
    expect(rendered).toContain("  child:");
    expect(rendered).toContain('    leaf: "done"');
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("keeps TOON array object continuation lines at the expected indentation", () => {
    const rendered = formatOutput(
      {
        items: [
          {
            id: "pm-a1b2",
            title: "Compact output",
          },
        ],
      },
      {},
    );

    expect(rendered).toContain('items:\n  - id: "pm-a1b2"\n    title: "Compact output"\n');
    expect(rendered).not.toContain('\n      title: "Compact output"');
  });

  it("renders scalar fallback output for non-structured values", () => {
    expect(formatOutput([], {})).toBe("{}\n");
    expect(formatOutput({}, {})).toBe("{}\n");
    expect(formatOutput(null, {})).toBe("{}\n");
    expect(formatOutput(undefined, {})).toBe("{}\n");
    expect(formatOutput("value", {})).toBe("\"value\"\n");
  });

  it("keeps JSON output backward-compatible with empty/null fields", () => {
    const payload = {
      keep: true,
      none: null,
      arr_empty: [],
      obj_empty: {},
      nested: { child: null, keep: "value" },
    };
    const rendered = formatOutput(payload, { json: true });
    expect(JSON.parse(rendered)).toEqual(payload);
  });

  it("prints to stdout and stderr unless quiet mode suppresses result output", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    printResult({ ok: true }, { quiet: true });
    expect(stdoutSpy).not.toHaveBeenCalled();

    printResult({ ok: true }, { json: true });
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"ok\": true"));

    printError("boom");
    expect(stderrSpy).toHaveBeenCalledWith("boom\n");

    stdoutSpy.mockClear();
    printResult({ item: { id: "pm-a1b2" }, changed_fields: ["id", "title", "status"] }, { json: true, noChangedFields: true });
    const compactRendered = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(compactRendered).not.toContain("changed_fields");
    expect(compactRendered).toContain("\"changed_field_count\": 3");

    stdoutSpy.mockClear();
    printResult({ changed_fields: ["audit", "metadata"] }, { json: true, noChangedFields: true });
    const nonMutationRendered = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(nonMutationRendered).toContain("changed_fields");
    expect(nonMutationRendered).not.toContain("changed_field_count");
  });

  it("suppresses synchronous stdout EPIPE and preserves success exit semantics", () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      const error = new Error("write EPIPE") as Error & { code?: string };
      error.code = "EPIPE";
      throw error;
    });

    expect(() => printResult({ ok: true }, { json: true })).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODE.SUCCESS);

    process.exitCode = previousExitCode;
  });

  it("suppresses synchronous stderr EPIPE and sets a non-zero exit code", () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      const error = new Error("write EPIPE") as Error & { code?: string };
      error.code = "EPIPE";
      throw error;
    });

    expect(() => printError("boom")).not.toThrow();
    expect(stderrSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);

    process.exitCode = previousExitCode;
  });

  it("does not override an existing non-zero exit code for stdout EPIPE", () => {
    const previousExitCode = process.exitCode;
    process.exitCode = EXIT_CODE.USAGE;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      const error = new Error("write EPIPE") as Error & { code?: string };
      error.code = "EPIPE";
      throw error;
    });

    expect(() => printResult({ ok: true }, { json: true })).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODE.USAGE);

    process.exitCode = previousExitCode;
  });

  it("does not override an existing non-zero exit code for stderr EPIPE", () => {
    const previousExitCode = process.exitCode;
    process.exitCode = EXIT_CODE.USAGE;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      const error = new Error("write EPIPE") as Error & { code?: string };
      error.code = "EPIPE";
      throw error;
    });

    expect(() => printError("boom")).not.toThrow();
    expect(stderrSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_CODE.USAGE);

    process.exitCode = previousExitCode;
  });

  it("rethrows non-EPIPE stdout stream errors", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw new Error("write failed");
    });

    expect(() => printResult({ ok: true }, { json: true })).toThrow("write failed");
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("rethrows non-EPIPE stderr stream errors", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("write failed");
    });

    expect(() => printError("boom")).toThrow("write failed");
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("applies active command overrides before rendering", () => {
    setActiveExtensionCommands({
      overrides: [
        {
          layer: "project",
          name: "command-override-ext",
          command: "list-open",
          run: (context) => ({
            ...(context.result as Record<string, unknown>),
            overridden: true,
          }),
        },
      ],
      handlers: [],
    });
    setActiveCommandContext({
      command: "list-open",
      args: ["--limit", "1"],
      pm_root: "/tmp/project",
    });

    const rendered = formatOutput({ count: 1 }, { json: true });
    expect(JSON.parse(rendered)).toEqual({
      count: 1,
      overridden: true,
    });
  });

  it("renders command results directly in TOON without envelope and omits empty/null fields", () => {
    setActiveCommandContext({
      command: "create",
      args: [],
      pm_root: "/tmp/project",
    });

    const rendered = formatOutput(
      {
        item: { id: "pm-a1b2", status: "open", assignee: null },
        changed_fields: ["id", "status"],
        warnings: [],
        extra: null,
      },
      {},
    );

    expect(rendered).toContain("item:");
    expect(rendered).toContain('  id: "pm-a1b2"');
    expect(rendered).toContain('  status: "open"');
    expect(rendered).toContain("changed_fields:");
    expect(rendered).not.toContain("summary:");
    expect(rendered).not.toContain("highlights:");
    expect(rendered).not.toContain("next_steps:");
    expect(rendered).not.toContain("result:");
    expect(rendered).not.toContain("assignee:");
    expect(rendered).not.toContain("warnings:");
    expect(rendered).not.toContain("extra:");
  });

  it("applies active renderer overrides and falls back when they fail", () => {
    setActiveExtensionRenderers({
      overrides: [
        {
          layer: "project",
          name: "json-renderer-ext",
          format: "json",
          run: (context) => JSON.stringify({ wrapped: context.result }),
        },
      ],
    });
    const renderedJson = formatOutput({ ok: true }, { json: true });
    expect(renderedJson).toBe(`${JSON.stringify({ wrapped: { ok: true } })}\n`);

    setActiveExtensionRenderers({
      overrides: [
        {
          layer: "project",
          name: "newline-renderer-ext",
          format: "json",
          run: (context) => `${JSON.stringify({ wrapped: context.result })}\n`,
        },
      ],
    });
    expect(formatOutput({ ok: true }, { json: true })).toBe(`${JSON.stringify({ wrapped: { ok: true } })}\n`);

    setActiveExtensionRenderers({
      overrides: [
        {
          layer: "project",
          name: "broken-renderer-ext",
          format: "toon",
          run: () => {
            throw new Error("boom");
          },
        },
      ],
    });
    const fallbackToToon = formatOutput({ ok: true }, {});
    expect(fallbackToToon).toContain("ok: true");
  });

  it("applies service overrides for output and errors", () => {
    setActiveExtensionServices({
      overrides: [
        {
          layer: "project",
          name: "output-service-ext",
          service: "output_format",
          run: (context) => JSON.stringify({ wrapped: (context.payload as { result: unknown }).result }),
        },
        {
          layer: "project",
          name: "error-service-ext",
          service: "error_format",
          run: (context) => `ERR:${(context.payload as { message: string }).message}`,
        },
      ],
    });
    expect(formatOutput({ ok: true }, { json: true })).toBe(`${JSON.stringify({ wrapped: { ok: true } })}\n`);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    printError("boom");
    expect(stderrSpy).toHaveBeenCalledWith("ERR:boom\n");
  });
});
