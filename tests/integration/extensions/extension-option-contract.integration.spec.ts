/**
 * pm-gh1665 / pm-gh1666: an extension command receives the same handler
 * options from every caller, and its per-command discovery lists every flag it
 * accepts with the runtime that owns it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient } from "../../../src/sdk/index.js";
import {
  activateExtensionForTest,
  runRegisteredCommandForTest,
} from "../../../src/sdk/testing.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

const FLAGS = [
  { long: "--item-id", value_type: "string", description: "Item to brief" },
  { long: "--status-filter", value_type: "string", default: "open", description: "Lifecycle bucket" },
  { long: "--commit", value_type: "boolean", description: "Record the brief as a comment" },
];

/** A mutating command: with --commit it records a comment on --item-id through the host SDK. */
const EXTENSION_SOURCE = [
  "export default {",
  "  activate(api) {",
  `    api.registerFlags("demo-brief", ${JSON.stringify(FLAGS)});`,
  "    api.registerCommand({",
  "      name: 'demo-brief',",
  "      run: async (context) => {",
  "        if (context.options.commit === true && context.options.itemId && context.sdk) {",
  "          await context.sdk.client.run('comments', { id: context.options.itemId, options: { add: `brief:${context.options.statusFilter}` } });",
  "        }",
  "        return { selection: context.options.statusFilter, options: context.options, global_keys: Object.keys(context.global).sort() };",
  "      },",
  "    });",
  "    api.registerCommand({ name: 'demo-plain', run: (context) => ({ options: context.options }) });",
  "    api.registerFlags('list', [{ long: '--demo-extra', value_type: 'boolean' }]);",
  "  },",
  "};",
  "",
].join("\n");

async function installDemoExtension(context: TempPmContext): Promise<void> {
  const extensionDir = path.join(context.pmPath, "extensions", "demo-brief-ext");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    path.join(extensionDir, "manifest.json"),
    `${JSON.stringify({ name: "demo-brief-ext", version: "1.0.0", entry: "./index.mjs", capabilities: ["commands", "schema"] }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(extensionDir, "index.mjs"), EXTENSION_SOURCE, "utf8");
}

interface ContractRow {
  flag: string;
  owner?: string;
  sdk_option?: string;
  aliases?: string[];
  value_arity?: string;
  value_name?: string;
}

function readCommandFlags(context: TempPmContext): { flags: ContractRow[]; inherited_flags: ContractRow[] } {
  const contracts = context.runCli(["contracts", "--command", "demo-brief", "--flags-only", "--json"], { expectJson: true });
  expect(contracts.code).toBe(0);
  const payload = contracts.json as { command_flags: Array<{ command: string; flags: ContractRow[]; inherited_flags: ContractRow[] }> };
  const entry = payload.command_flags.find((candidate) => candidate.command === "demo-brief");
  expect(entry).toBeDefined();
  return entry!;
}

describe("extension option contract (pm-gh1665)", () => {
  it("delivers one selection to the handler from CLI argv, PmClient.run spellings, and the test harness", async () => {
    await withTempPmPath(async (context) => {
      await installDemoExtension(context);
      const cli = context.runCli(["demo-brief", "--status-filter", "closed", "--json"], { expectJson: true });
      expect(cli.code).toBe(0);
      expect(cli.json).toMatchObject({ selection: "closed" });

      const client = new PmClient({ pmRoot: context.pmPath });
      for (const spelling of ["statusFilter", "status-filter", "--status-filter"]) {
        await expect(client.run("demo-brief", { options: { [spelling]: "closed" } })).resolves.toMatchObject({
          selection: "closed",
          options: { statusFilter: "closed" },
        });
      }
      // Declared defaults and value coercion match CLI dispatch: an omitted flag gets its default and "true" a boolean.
      await expect(client.run("demo-brief", { options: { commit: "false" } })).resolves.toMatchObject({
        selection: "open",
        options: { statusFilter: "open", commit: false },
      });
      // Equal values under two spellings fold; different values are refused instead of picking one.
      await expect(
        client.run("demo-brief", { options: { statusFilter: "closed", "status-filter": "closed" } }),
      ).resolves.toMatchObject({ selection: "closed" });
      await expect(
        client.run("demo-brief", { options: { statusFilter: "closed", "status-filter": "open" } }),
      ).rejects.toMatchObject({
        context: expect.objectContaining({ code: "extension_option_spelling_conflict" }),
        message: expect.stringContaining("Options 'statusFilter' and 'status-filter' both set --status-filter"),
      });

      const module = await import(path.join(context.pmPath, "extensions", "demo-brief-ext", "index.mjs"));
      const activation = await activateExtensionForTest(module.default, { name: "demo-brief-ext", capabilities: ["commands", "schema"] });
      expect(activation.failed).toEqual([]);
      for (const spelling of ["statusFilter", "status-filter"]) {
        const result = await runRegisteredCommandForTest(activation.commands, {
          command: "demo-brief",
          options: { [spelling]: "closed" },
        });
        expect(result).toMatchObject({ handled: true, result: { selection: "closed" } });
      }
      await expect(
        runRegisteredCommandForTest(activation.commands, {
          command: "demo-brief",
          options: { statusFilter: "closed", "status-filter": "open" },
        }),
      ).rejects.toThrow("both set --status-filter");
      // The registrations travel with the registry under a global symbol, so a structurally copied
      // registry that keeps the symbol still normalizes (another SDK copy reads the same symbol).
      const carried = Object.defineProperty(
        { overrides: [], handlers: [...activation.commands.handlers] },
        Symbol.for("pm.sdk.testing.activatedFlagRegistrations"),
        { value: activation.registrations },
      );
      await expect(
        runRegisteredCommandForTest(carried, { command: "demo-brief", options: { "status-filter": "closed" } }),
      ).resolves.toMatchObject({ handled: true, result: { selection: "closed" } });
      // A hand-built registry has no declared flags to normalize against, so options pass through verbatim.
      const unrelated = await runRegisteredCommandForTest(
        { overrides: [], handlers: [...activation.commands.handlers] },
        { command: "demo-brief", options: { "status-filter": "closed" } },
      );
      expect(unrelated).toMatchObject({ handled: true, result: { selection: undefined } });
    });
  });

  it("publishes the handler key for every extension flag", async () => {
    await withTempPmPath(async (context) => {
      await installDemoExtension(context);
      const { flags } = readCommandFlags(context);
      expect(flags.map(({ flag, owner, sdk_option }) => ({ flag, owner, sdk_option }))).toEqual([
        { flag: "--item-id", owner: "extension", sdk_option: "itemId" },
        { flag: "--status-filter", owner: "extension", sdk_option: "statusFilter" },
        { flag: "--commit", owner: "extension", sdk_option: "commit" },
      ]);
      // A core command an extension augments keeps its core rows and gains owned extension rows, but no inherited block.
      const listContracts = context.runCli(["contracts", "--command", "list", "--flags-only", "--json"], { expectJson: true });
      const listEntry = (listContracts.json as { command_flags: Array<{ command: string; provider: string; flags: ContractRow[]; inherited_flags?: unknown }> }).command_flags.find(
        (candidate) => candidate.command === "list",
      );
      expect(listEntry?.provider).toBe("mixed");
      expect(listEntry?.flags.find((row) => row.flag === "--demo-extra")).toMatchObject({ owner: "extension", sdk_option: "demoExtra" });
      expect(listEntry?.flags.find((row) => row.flag === "--all")?.owner).toBeUndefined();
      expect(listEntry?.inherited_flags).toBeUndefined();
      const help = context.runCli(["help", "demo-brief", "--json"], { expectJson: true });
      const helpOptions = (help.json as { options: Array<{ long: string; owner?: string; sdk_option?: string }> }).options;
      expect(helpOptions.find((option) => option.long === "--status-filter")).toMatchObject({ owner: "extension", sdk_option: "statusFilter" });
    });
  });
});

describe("extension per-command discovery (pm-gh1666)", () => {
  it("lists the inherited host flags with ownership, and every listed flag is accepted by a mutating command", async () => {
    await withTempPmPath(async (context) => {
      await installDemoExtension(context);
      const { inherited_flags: inherited } = readCommandFlags(context);
      const inheritedNames = inherited.map((row) => row.flag);
      // Negative control: removing these rows from the per-command contract fails here.
      expect(inheritedNames).toEqual(expect.arrayContaining(["--json", "--author", "--pm-path", "--output-format", "--expect-hash"]));
      expect(inherited.every((row) => row.owner === "host")).toBe(true);
      // Read-output controls apply only to read surfaces, and --no-extensions removes the command itself.
      for (const excluded of ["--output-include", "--output-budget", "--output-cursor", "--no-extensions", "--version", "--all", "--explain"]) {
        expect(inheritedNames).not.toContain(excluded);
      }

      const created = context.runCli(["create", "Task", "Brief target", "--description", "target", "--json"], { expectJson: true });
      const itemId = (created.json as { item: { id: string } }).item.id;
      // Each committed brief changes the item, so the guard reads the current revision right before it binds.
      const currentRevision = (): string =>
        `${itemId}=${(context.runCli(["get", itemId, "--json"], { expectJson: true }).json as { item_hash: string }).item_hash}`;
      const valueFor: Record<string, () => string> = {
        "--output-format": () => "json",
        "--pm-path": () => context.pmPath,
        "--author": () => "brief-author",
        "--expect-hash": currentRevision,
      };
      for (const row of inherited) {
        if (row.flag === "--help") continue;
        const flagArgs = row.value_arity === "required" ? [row.flag, (valueFor[row.flag] ?? (() => "x"))()] : [row.flag];
        const result = context.runCli(["demo-brief", "--item-id", itemId, "--commit", ...flagArgs, "--json"]);
        expect({ flag: row.flag, code: result.code, stderr: result.stderr }).toMatchObject({ flag: row.flag, code: 0 });
      }
      const comments = context.runCli(["comments", itemId, "--json"], { expectJson: true });
      expect(JSON.stringify(comments.json)).toContain("brief:open");

      const textHelp = context.runCli(["demo-brief", "--help"]);
      expect(textHelp.stdout).toContain("Inherited host flags (delivered through context.global):");
      expect(textHelp.stdout).toContain("--pm-path <path>");
      expect(textHelp.stdout).toContain("pm contracts --command demo-brief --flags-only --json");
      const jsonHelp = context.runCli(["help", "demo-brief", "--json"], { expectJson: true });
      const inheritedOptions = (jsonHelp.json as { inherited_options: Array<{ long: string; owner: string }> }).inherited_options;
      expect(inheritedOptions.map((option) => option.long)).toEqual(inheritedNames);
      expect(inheritedOptions.every((option) => option.owner === "host")).toBe(true);
    });
  });

  it("refuses an undeclared root-only flag instead of leaking it into the handler options", async () => {
    await withTempPmPath(async (context) => {
      await installDemoExtension(context);
      // Commands with and without declared flags are both guarded (Codex review).
      for (const command of ["demo-brief", "demo-plain"]) {
        for (const flag of ["--all", "--explain"]) {
          const refused = context.runCli([command, flag, "--json"]);
          expect(refused.code).toBe(2);
          expect(JSON.parse(refused.stderr)).toMatchObject({ code: "unknown_option", detail: expect.stringContaining(`Unknown option '${flag}' for extension command '${command}'`) });
        }
      }
      const plain = context.runCli(["demo-plain", "--json"], { expectJson: true });
      expect(plain).toMatchObject({ code: 0, json: { options: {} } });
      // A core command an extension only augments with flags keeps its own --all (Codex review round 2).
      const augmented = context.runCli(["list", "--all", "--demo-extra", "--json"], { expectJson: true });
      expect(augmented.code).toBe(0);
      expect(augmented.json).toMatchObject({ filters: { status: "all" } });
    });
  });
});
