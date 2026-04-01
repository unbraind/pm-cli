import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveExtensionHooks,
  setActiveCommandContext,
  setActiveExtensionCommands,
  setActiveExtensionRenderers,
  setActiveExtensionServices,
} from "../../src/core/extensions/index.js";
import { formatOutput, printError, printResult } from "../../src/core/output/output.js";

describe("core/output/output", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
    vi.restoreAllMocks();
  });

  it("formats JSON output with a trailing newline", () => {
    const payload = { ok: true, count: 2 };
    expect(formatOutput(payload, { json: true })).toBe(`${JSON.stringify(payload, null, 2)}\n`);
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
