import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveExtensionHooks,
  setActiveCommandContext,
  setActiveExtensionCommands,
  setActiveExtensionRenderers,
  setActiveExtensionServices,
} from "../../../../src/core/extensions/index.js";
import { formatOutput, outputTestOnly, printError, printResult, writeStderr, writeStdout } from "../../../../src/core/output/output.js";
import { resolveQueryProjectionLabel, withQuerySummary } from "../../../../src/core/output/query-summary.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";

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

  it("covers raw TOON renderer empty collection branches", () => {
    expect(outputTestOnly.compactToonValue({ keep: "value", drop: [null, undefined] })).toEqual({ keep: "value" });
    expect(outputTestOnly.renderToonValue([], 0)).toBe("[]");
    expect(outputTestOnly.renderToonValue({}, 0)).toBe("{}");
    expect(outputTestOnly.renderToonValue({ empty_arr: [], empty_obj: {} }, 0)).toBe("empty_arr: []\nempty_obj: {}");
    expect(outputTestOnly.renderToonValue(null, 0)).toBe("null");
    expect(outputTestOnly.renderToonValue(Symbol.for("pm-output"), 0)).toBe("undefined");
  });

  it("renders scalar fallback output for non-structured values", () => {
    expect(formatOutput([], {})).toBe("{}\n");
    expect(formatOutput({}, {})).toBe("{}\n");
    expect(formatOutput(null, {})).toBe("{}\n");
    expect(formatOutput(undefined, {})).toBe("{}\n");
    expect(formatOutput("value", {})).toBe("\"value\"\n");
    expect(formatOutput(42, {})).toBe("42\n");
    expect(formatOutput(false, {})).toBe("false\n");
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

    stdoutSpy.mockClear();
    printResult(
      { item: { id: "pm-a1b2", status: "open", title: "verbose" }, changed_fields: ["id", "title", "status"] },
      { json: true, idOnly: true },
    );
    const idOnlyRendered = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(JSON.parse(idOnlyRendered)).toEqual({ id: "pm-a1b2", status: "open" });
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

  it("handles direct stream writes and async EPIPE stream events", () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(writeStdout("plain stdout\n")).toBe(true);
    expect(writeStderr("plain stderr\n")).toBe(true);
    expect(stdoutSpy).toHaveBeenCalledWith("plain stdout\n");
    expect(stderrSpy).toHaveBeenCalledWith("plain stderr\n");

    const stdoutPipe = new Error("stdout pipe closed") as Error & { code?: string };
    stdoutPipe.code = "EPIPE";
    process.stdout.emit("error", stdoutPipe);
    expect(process.exitCode).toBe(EXIT_CODE.SUCCESS);

    process.exitCode = undefined;
    const stderrPipe = new Error("stderr pipe closed") as Error & { code?: string };
    stderrPipe.code = "EPIPE";
    process.stderr.emit("error", stderrPipe);
    expect(process.exitCode).toBe(EXIT_CODE.GENERIC_FAILURE);

    process.exitCode = previousExitCode;
  });

  it("forwards non-EPIPE async stream errors to uncaught exception handling", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      writeStdout("install stream handlers\n");
      const uncaught = new Promise<Error>((resolve) => {
        process.once("uncaughtException", (error) => {
          resolve(error);
        });
      });

      process.stdout.emit("error", "async stream failure");

      await expect(uncaught).resolves.toMatchObject({ message: "async stream failure" });
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("forwards non-EPIPE stderr stream errors to uncaught exception handling", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      writeStderr("install stream handlers\n");
      const uncaught = new Promise<Error>((resolve) => {
        process.once("uncaughtException", (error) => {
          resolve(error);
        });
      });

      process.stderr.emit("error", "async stderr stream failure");

      await expect(uncaught).resolves.toMatchObject({ message: "async stderr stream failure" });
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("rethrows async Error instances without rewrapping", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      writeStdout("install stream handlers\n");
      const uncaught = new Promise<Error>((resolve) => {
        process.once("uncaughtException", (error) => {
          resolve(error);
        });
      });

      const original = new Error("async stdout error object");
      process.stdout.emit("error", original);

      await expect(uncaught).resolves.toBe(original);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("reports direct stream write return values and preserves explicit newlines from services", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(false);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(false);

    expect(writeStdout("buffered stdout\n")).toBe(true);
    expect(writeStderr("buffered stderr\n")).toBe(true);
    expect(stdoutSpy).toHaveBeenCalledWith("buffered stdout\n");
    expect(stderrSpy).toHaveBeenCalledWith("buffered stderr\n");

    setActiveExtensionServices({
      overrides: [
        {
          layer: "project",
          name: "newline-output-service-ext",
          service: "output_format",
          run: () => "already newline\n",
        },
        {
          layer: "project",
          name: "newline-error-service-ext",
          service: "error_format",
          run: () => "ERR already newline\n",
        },
      ],
    });

    expect(formatOutput({ ok: true }, {})).toBe("already newline\n");
    printError("ignored");
    expect(stderrSpy).toHaveBeenLastCalledWith("ERR already newline\n");
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

  it("keeps user native-output marker fields unless the marker is true", () => {
    const rendered = formatOutput({ __pm_native_output: false, count: 1 }, { json: true });

    expect(JSON.parse(rendered)).toEqual({
      __pm_native_output: false,
      count: 1,
    });
  });

  it("renders calendar markdown defaults for empty and populated event payloads", () => {
    expect(
      formatOutput(
        {
          output_default: "markdown",
          view: "week",
          summary: { events: 0 },
          events: [],
          days: [],
        },
        {},
      ),
    ).toContain("No calendar events matched the selected filters.");

    const rendered = formatOutput(
      {
        output_default: "markdown",
        view: "agenda",
        summary: { events: 2 },
        days: [{}],
        events: [
          { kind: "reminder", item_id: "pm-a1", item_title: "Review", reminder_text: "soon" },
          { item_id: "pm-b2", item_title: "Ship" },
          "ignored",
        ],
      },
      {},
    );
    expect(rendered).toContain("# pm calendar (agenda)");
    expect(rendered).toContain("- events: 2");
    expect(rendered).toContain("[reminder] pm-a1 Review soon");
    expect(rendered).toContain("[event] pm-b2 Ship");

    expect(formatOutput({ output_default: "markdown", view: "bad", events: [], days: "bad" }, {})).toContain(
      'output_default: "markdown"',
    );

    // No summary object at all → isPlainObject(...) false branch and `events ?? 0`
    // nullish fallback. The event omits kind/item_id/reminder_text so each typeof
    // ternary takes its default/empty branch.
    const noSummary = formatOutput(
      {
        output_default: "markdown",
        view: "month",
        days: [],
        events: [{ item_title: "Untitled-but-present" }, { item_id: "pm-c3", item_title: 42 }],
      },
      {},
    );
    expect(noSummary).toContain("- events: 0");
    expect(noSummary).toContain("[event]  Untitled-but-present");
    expect(noSummary).toContain("[event] pm-c3");
  });

  it("bypasses service and renderer overrides for native output markers", () => {
    setActiveExtensionServices({
      overrides: [
        {
          layer: "project",
          name: "output-service-ext",
          service: "output_format",
          run: () => "service-output",
        },
      ],
    });
    setActiveExtensionRenderers({
      overrides: [
        {
          layer: "project",
          name: "renderer-ext",
          format: "json",
          run: () => "renderer-output",
        },
      ],
    });

    expect(formatOutput({ __pm_native_output: true, ok: true }, { json: true })).toBe(
      `${JSON.stringify({ ok: true }, null, 2)}\n`,
    );
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

  it("uses non-string output service results as the rendered payload and falls back for non-string errors", () => {
    setActiveExtensionServices({
      overrides: [
        {
          layer: "project",
          name: "object-output-service-ext",
          service: "output_format",
          run: () => ({ from_service: true }),
        },
        {
          layer: "project",
          name: "object-error-service-ext",
          service: "error_format",
          run: () => ({ ignored: true }),
        },
      ],
    });

    expect(formatOutput({ ok: true }, {})).toBe("from_service: true\n");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    printError("plain");
    expect(stderrSpy).toHaveBeenCalledWith("plain\n");
  });

});

describe("core/output/query-summary", () => {
  it("resolves projection labels from list/search projection options", () => {
    expect(resolveQueryProjectionLabel({})).toBe("full");
    expect(resolveQueryProjectionLabel({ compact: true })).toBe("compact");
    expect(resolveQueryProjectionLabel({ brief: true })).toBe("brief");
    expect(resolveQueryProjectionLabel({ fields: "id,title" })).toBe("fields");
    // Array fields selectors (direct callers; MCP coerces arrays to CSV) count too.
    expect(resolveQueryProjectionLabel({ fields: ["id", "title"] })).toBe("fields");
    expect(resolveQueryProjectionLabel({ fields: [] })).toBe("full");
    // Blank fields selectors do not count as a fields projection.
    expect(resolveQueryProjectionLabel({ fields: "   " })).toBe("full");
    // brief wins over other labels because it is the most specific request.
    expect(resolveQueryProjectionLabel({ brief: true, compact: true })).toBe("brief");
  });

  it("attaches query_summary from the result filters and the requested options", () => {
    const compactResult = { items: [], count: 0, filters: { status: "open", type: "Task" } };
    const summarized = withQuerySummary(compactResult, { compact: true });
    expect(summarized.query_summary).toEqual({ filters: { status: "open", type: "Task" }, projection: "compact" });
    // The original result fields are preserved untouched.
    expect(summarized.items).toEqual([]);
    expect(summarized.count).toBe(0);
  });

  it("prefers the result's own projection mode for verbose payloads", () => {
    const verboseResult = {
      items: [],
      count: 0,
      filters: { status: null },
      projection: { mode: "fields", fields: ["id"] },
    };
    expect(withQuerySummary(verboseResult, {}).query_summary.projection).toBe("fields");
    // brief is reported as projection mode "compact" by the list command, so
    // the requested brief label wins outright.
    const briefResult = {
      items: [],
      count: 0,
      filters: {},
      projection: { mode: "compact", fields: ["id", "status", "type", "title"] },
    };
    expect(withQuerySummary(briefResult, { brief: true }).query_summary.projection).toBe("brief");
  });

  it("defaults filters to an empty object when the result has none", () => {
    expect(withQuerySummary({ items: [], count: 0 }, {}).query_summary).toEqual({ filters: {}, projection: "full" });
    // Non-record filters/projection values are ignored rather than echoed.
    expect(
      withQuerySummary({ filters: ["not-a-record"], projection: "compact" } as unknown as Record<string, unknown>, { compact: true })
        .query_summary,
    ).toEqual({ filters: {}, projection: "compact" });
  });
});
