/**
 * pm-gh1726 / pm-gh1727 / pm-gh1729 / pm-gh1769 / pm-g2zzus: direct callers
 * (`PmClient.run`, the extension test harness) get the refusals CLI argv gets,
 * with the same machine codes, before the handler runs, including universal
 * output controls on a command that is not a read surface; a repeatable
 * boolean switch reaches the handler with every bare and attached occurrence
 * in argv order; and the harness admits a read-output result exactly as the
 * native CLI does.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient } from "../../../src/sdk/index.js";
import { createExtensionTestHarness } from "../../../src/sdk/testing.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

const FLAGS = [
  { long: "--from-tracker", value_type: "string", required: true, description: "Source tracker" },
  { long: "--enabled", value_type: "boolean", value_validation: "strict", description: "Strict switch" },
  { long: "--many", value_type: "boolean", value_validation: "strict", repeatable: true, description: "Repeatable switch" },
  { long: "--tags", value_type: "string", list: true, required: true, description: "Required list" },
  { long: "--legacy", value_type: "string", enabled: false, description: "Disabled flag" },
];

/**
 * `probe option` echoes its options and counts handler runs; `probe report`
 * declares structured rows and returns whatever shape `--shape` asks for, so
 * the same command exercises every admission case; an output_format service
 * renders its compact receipt.
 */
const EXTENSION_SOURCE = [
  "let runs = 0;",
  "const SHAPES = {",
  "  receipt: { ok: true, output: 'receipt.md' },",
  "  rows: { ok: true, output: 'receipt.md', rows: [{ id: 'synthetic' }] },",
  "  empty: { ok: true, output: 'receipt.md', rows: [] },",
  "  malformed: { ok: true, output: 'receipt.md', rows: 'synthetic' },",
  "  huge: { ok: true, output: 'receipt.md', rows: [{ id: 'synthetic' }], oversized: true },",
  "};",
  "export default {",
  "  activate(api) {",
  `    api.registerCommand({ name: 'probe option', flags: ${JSON.stringify(FLAGS)}, run: (context) => ({ runs: ++runs, options: context.options }) });`,
  "    api.registerCommand({",
  "      name: 'probe report',",
  "      read_output: { row_keys: ['rows'] },",
  "      flags: [{ long: '--shape', value_type: 'string', default: 'rows' }],",
  "      run: (context) => SHAPES[context.options.shape],",
  "    });",
  "    api.registerService('output_format', (context) => context.command !== 'probe report' ? { handled: false }",
  "      : { handled: true, result: context.payload?.result?.oversized === true ? 'x'.repeat(20000) : JSON.stringify({ ok: true, output: 'receipt.md' }) });",
  "  },",
  "};",
  "",
].join("\n");

const CAPABILITIES = ["commands", "schema", "services"];

async function installProbeExtension(context: TempPmContext): Promise<string> {
  const extensionDir = path.join(context.pmPath, "extensions", "probe-contract-ext");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    path.join(extensionDir, "manifest.json"),
    `${JSON.stringify({ name: "probe-contract-ext", version: "1.0.0", entry: "./index.mjs", capabilities: CAPABILITIES }, null, 2)}\n`,
    "utf8",
  );
  const entry = path.join(extensionDir, "index.mjs");
  await writeFile(entry, EXTENSION_SOURCE, "utf8");
  return entry;
}

interface Refusal {
  code?: string;
  flag?: string;
  field?: string;
  required?: string;
  examples?: string[];
  recovery?: { missing?: string[] };
}

/** Run argv in-process and parse the refusal envelope the CLI prints. */
async function cliRefusal(context: TempPmContext, args: string[]): Promise<Refusal> {
  const result = await context.runCliInProcess([...args, "--json"]);
  expect(result.code).toBe(2);
  return JSON.parse(result.stderr) as Refusal;
}

/** Capture a direct-caller rejection's typed context. */
async function directRefusal(run: () => Promise<unknown>): Promise<Refusal & { message: string; exitCode?: number }> {
  try {
    await run();
  } catch (error) {
    const typed = error as { message: string; exitCode?: number; context?: Refusal };
    return { ...typed.context, message: typed.message, exitCode: typed.exitCode };
  }
  throw new Error("Expected the direct call to be refused");
}

describe("direct-caller extension option contract", () => {
  it("refuses a missing required flag, an undeclared key and a disabled flag with the CLI codes, before the handler runs", async () => {
    await withTempPmPath(async (context) => {
      const entry = await installProbeExtension(context);
      const client = new PmClient({ pmRoot: context.pmPath });
      const harness = await createExtensionTestHarness((await import(entry)).default, { capabilities: CAPABILITIES });
      const callers = {
        client: (options: Record<string, unknown>) => client.run("probe option", { options }),
        harness: (options: Record<string, unknown>) => harness.runCommand({ command: "probe option", options }),
      };
      try {
        for (const run of Object.values(callers)) {
          const missing = await directRefusal(() => run({ tags: ["a"] }));
          expect(missing).toMatchObject({
            code: "missing_required_option",
            exitCode: 2,
            flag: "--from-tracker",
            field: "fromTracker",
            recovery: { missing: ["--from-tracker"] },
          });
          // An empty list is zero occurrences, so a required list flag is still missing.
          expect(await directRefusal(() => run({ fromTracker: "x", tags: [] }))).toMatchObject({
            code: "missing_required_option",
            field: "tags",
          });
          const unknown = await directRefusal(() => run({ fromTracker: "x", tags: ["a"], typoKey: "y" }));
          expect(unknown).toMatchObject({ code: "unknown_option", exitCode: 2, flag: "--typo-key" });
          expect(unknown.message).toBe(
            "Unknown option 'typoKey' for extension command 'probe option'. Expected one of: --from-tracker, --enabled, --many, --tags, --legacy.",
          );
          expect(await directRefusal(() => run({ fromTracker: "x", tags: ["a"], legacy: "v" }))).toMatchObject({
            code: "extension_option_disabled",
            flag: "--legacy",
          });
        }
        // Negative control: every refusal above ran before dispatch, so this is the handler's first run.
        const counted = (await harness.runCommand({ command: "probe option", options: { fromTracker: "x", tags: ["a"] } })).result as { runs: number };
        expect(counted.runs).toBe(1);
        // Host-owned keys (output controls, the transport `force`) keep passing through untouched.
        await expect(client.run("probe option", { options: { fromTracker: "x", tags: ["a"], quiet: true, force: false } })).resolves.toMatchObject({
          options: { fromTracker: "x", tags: ["a"], quiet: true, force: false },
        });

        const cliMissing = await cliRefusal(context, ["probe", "option", "--tags", "a"]);
        expect(cliMissing).toMatchObject({
          code: "missing_required_option",
          flag: "--from-tracker",
          required: "Pass --from-tracker <value>.",
          examples: ["pm probe option --from-tracker <value>"],
          recovery: { missing: ["--from-tracker"] },
        });
        expect(await cliRefusal(context, ["probe", "option", "--from-tracker", "x", "--tags", "a", "--legacy", "v"])).toMatchObject({
          code: "extension_option_disabled",
        });
        expect((await cliRefusal(context, ["probe", "option", "--from-tracker", "x", "--tags", "a", "--typo-key", "y"])).code).toBe("unknown_option");
      } finally {
        await harness.deactivate();
      }
    });
  });

  it("pm-gh1726: a single-value flag refuses any array, a repeatable boolean validates every element, and a bare repeatable switch is true", async () => {
    await withTempPmPath(async (context) => {
      const entry = await installProbeExtension(context);
      const client = new PmClient({ pmRoot: context.pmPath });
      const harness = await createExtensionTestHarness((await import(entry)).default, { capabilities: CAPABILITIES });
      const base = { fromTracker: "x", tags: ["a"] };
      try {
        for (const run of [
          (options: Record<string, unknown>) => client.run("probe option", { options: { ...base, ...options } }),
          async (options: Record<string, unknown>) => (await harness.runCommand({ command: "probe option", options: { ...base, ...options } })).result,
        ]) {
          for (const enabled of [[], [true], {}, 1, "bogus"]) {
            expect(await directRefusal(() => run({ enabled }))).toMatchObject({ code: "extension_flag_value_invalid", exitCode: 2, flag: "--enabled" });
          }
          expect(await directRefusal(() => run({ fromTracker: ["a", "b"] }))).toMatchObject({ code: "extension_flag_value_invalid", flag: "--from-tracker" });
          expect(await directRefusal(() => run({ many: [true, "bogus"] }))).toMatchObject({ code: "extension_flag_value_invalid" });
          // The string token "true" still coerces, and an empty repeatable list is a valid zero-occurrence value.
          expect(await run({ enabled: "true", many: [] })).toMatchObject({ options: { enabled: true, many: [] } });
          expect(await run({ many: ["true", false] })).toMatchObject({ options: { many: [true, false] } });
        }
        for (const enabled of ["--enabled=bogus", "--enabled={}", "--enabled=1"]) {
          const result = await context.runCliInProcess(["probe", "option", "--from-tracker", "x", "--tags", "a", enabled, "--json"]);
          expect(result.code, enabled).toBe(enabled === "--enabled=1" ? 0 : 2);
        }
        // An unrelated attached option (--enabled=1 reaches only the loose parser) no longer empties a list
        // Commander parsed: --tags a stays ["a"] (it reached the handler as [] before).
        const mixed = await context.runCliInProcess(["probe", "option", "--from-tracker", "x", "--tags", "a", "--tags", "b", "--enabled=1", "--json"], { expectJson: true });
        expect(mixed.code, mixed.stderr).toBe(0);
        expect((mixed.json as { options: Record<string, unknown> }).options).toMatchObject({ tags: ["a", "b"], enabled: true });
        // Commander hands the accumulator `undefined` for a bare switch; each bare occurrence is `true`.
        // pm-g2zzus: bare occurrences (Commander's) and attached ones (the loose parser's) mix in argv order.
        for (const [argv, expected] of [
          [["--many"], [true]],
          [["--many", "--many"], [true, true]],
          [["--many=false"], [false]],
          [["--many=false", "--many"], [false, true]],
          [["--many", "--many=false"], [true, false]],
          [["--many", "--many=false", "--many"], [true, false, true]],
          [["--many=true", "--many=false"], [true, false]],
          // A token another option consumes as its value is never a switch occurrence.
          [["--many", "--from-tracker", "--many=false"], [true]],
        ] as const) {
          const result = await context.runCliInProcess(["probe", "option", "--from-tracker", "x", "--tags", "a", ...argv, "--json"], { expectJson: true });
          expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(0);
          expect((result.json as { options: { many: unknown } }).options.many, argv.join(" ")).toEqual(expected);
        }
      } finally {
        await harness.deactivate();
      }
    });
  });

  it("pm-gh1729: the harness refuses a receipt-only or malformed read-output result exactly as the native CLI does", async () => {
    await withTempPmPath(async (context) => {
      const entry = await installProbeExtension(context);
      const harness = await createExtensionTestHarness((await import(entry)).default, { capabilities: CAPABILITIES });
      try {
        for (const shape of ["rows", "empty"]) {
          // Valid rows stay compact: the formatter's receipt is what the built CLI delivers.
          const native = context.runCli(["probe", "report", "--shape", shape, "--json"]);
          expect(native.code, shape).toBe(0);
          expect(JSON.parse(native.stdout)).toEqual({ ok: true, output: "receipt.md" });
          await expect(harness.runCommand({ command: "probe report", options: { shape } })).resolves.toMatchObject({ handled: true });
        }
        for (const shape of ["receipt", "malformed"]) {
          const native = await cliRefusal(context, ["probe", "report", "--shape", shape]);
          expect(native.code, shape).toBe("extension_read_output_invalid");
          const direct = await directRefusal(() => harness.runCommand({ command: "probe report", options: { shape } }));
          expect(direct).toMatchObject({ code: "extension_read_output_invalid", exitCode: 2 });
          expect(direct.message).toBe("Read-only extension result is missing declared row collection rows.");
          expect(direct.required).toContain("an empty collection is valid");
        }
        // Valid rows do not exempt the delivered output: an oversized formatter receipt is still refused natively.
        const oversized = context.runCli(["probe", "report", "--shape", "huge", "--output-budget", "400", "--json"]);
        expect(oversized.code).toBe(2);
        expect(JSON.parse(oversized.stdout)).toMatchObject({ output_budget_exceeded: { omitted_result: true } });
        // The same budget refuses in the harness (CodeRabbit review); without a budget the huge receipt is delivered.
        await expect(harness.runCommand({ command: "probe report", options: { shape: "huge", outputBudget: "400" } })).rejects.toMatchObject({
          exitCode: 2,
          context: expect.objectContaining({ code: "output_budget_exceeded" }),
        });
        await expect(harness.runCommand({ command: "probe report", options: { shape: "huge" } })).resolves.toMatchObject({ handled: true });
      } finally {
        await harness.deactivate();
      }
    });
  });

  it("pm-gh1769: the harness refuses universal output controls on a non-read command before dispatch, exactly as the native CLI does", async () => {
    await withTempPmPath(async (context) => {
      const entry = await installProbeExtension(context);
      const harness = await createExtensionTestHarness((await import(entry)).default, { capabilities: CAPABILITIES });
      const base = { fromTracker: "x", tags: ["a"] };
      try {
        for (const [flag, value, key] of [
          ["--output-budget", "1", "outputBudget"],
          ["--output-limit", "5", "outputLimit"],
          ["--output-include", "runs", "outputInclude"],
          ["--output-cursor", "opaque", "outputCursor"],
        ] as const) {
          const native = await cliRefusal(context, ["probe", "option", "--from-tracker", "x", "--tags", "a", flag, value]);
          expect(native.code, flag).toBe("read_output_surface_unsupported");
          for (const invocation of [{ global: { [key]: value } }, { options: { ...base, [key]: value } }]) {
            const direct = await directRefusal(() => harness.runCommand({ command: "probe option", options: base, ...invocation }));
            expect(direct, flag).toMatchObject({ code: native.code, exitCode: 2 });
            expect(direct.message).toBe("Universal output controls apply only to read commands; probe option is not a read surface.");
          }
        }
        // The refusal runs before the handler: the first handled run after the refusals is the handler's first run.
        await expect(harness.runCommand({ command: "probe option", options: base })).resolves.toMatchObject({ handled: true, result: { runs: 1 } });
        // A malformed encoding is refused natively and in the harness with the same message.
        const encoding = context.runCli(["probe", "option", "--from-tracker", "x", "--tags", "a", "--output-format", "yaml", "--json"]);
        expect(encoding.code).toBe(2);
        expect(encoding.stderr).toContain("--output-format must be toon or json.");
        await expect(harness.runCommand({ command: "probe option", options: base, global: { outputFormat: "yaml" as "json" } })).rejects.toThrow("--output-format must be toon or json.");
        // A command that declares read_output keeps accepting the controls.
        const native = context.runCli(["probe", "report", "--output-limit", "1", "--json"]);
        expect(native.code, native.stderr).toBe(0);
        await expect(harness.runCommand({ command: "probe report", global: { outputLimit: "1" } })).resolves.toMatchObject({ handled: true });
      } finally {
        await harness.deactivate();
      }
    });
  });
});
