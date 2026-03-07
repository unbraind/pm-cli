import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveExtensionHooks,
  setActiveCommandContext,
  setActiveExtensionCommands,
  setActiveExtensionRenderers,
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
        arr_scalars: ["x", 2, true, null],
        arr_single_nested: [{ key: "value" }],
        arr_multi_line: [{ nested: ["a", { deep: 1 }] }],
        nested: { child: { leaf: "done" } },
      },
      {},
    );

    expect(rendered).toContain('text: "hello"');
    expect(rendered).toContain("num: 3");
    expect(rendered).toContain("bool: false");
    expect(rendered).toContain("none: null");
    expect(rendered).toContain("arr_empty: []");
    expect(rendered).toContain("obj_empty: {}");
    expect(rendered).toContain('  - "x"');
    expect(rendered).toContain("  - 2");
    expect(rendered).toContain("  - true");
    expect(rendered).toContain("  - null");
    expect(rendered).toContain('  - key: "value"');
    expect(rendered).toContain("arr_multi_line:");
    expect(rendered).toContain("- nested:");
    expect(rendered).toContain("- deep: 1");
    expect(rendered).toContain("nested:");
    expect(rendered).toContain("  child:");
    expect(rendered).toContain('    leaf: "done"');
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("renders scalar fallback output for non-structured values", () => {
    expect(formatOutput([], {})).toBe("[]\n");
    expect(formatOutput({}, {})).toBe("{}\n");
    expect(formatOutput("value", {})).toBe("\"value\"\n");
    expect(formatOutput(undefined, {})).toBe("undefined\n");
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
});
