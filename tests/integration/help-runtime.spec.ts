import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

async function createProjectExtension(
  pmPath: string,
  directory: string,
  manifest: Record<string, unknown>,
  entrySource: string,
): Promise<void> {
  const extensionRoot = path.join(pmPath, "extensions", directory);
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(path.join(extensionRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(extensionRoot, "index.mjs"), entrySource, "utf8");
}

describe("CLI help runtime coverage (sandboxed)", () => {
  it("describes top-level help as a universal extensible CLI", async () => {
    await withTempPmPath(async (context) => {
      const compactHelp = context.runCli(["--help"]);
      expect(compactHelp.code).toBe(0);
      expect(compactHelp.stdout.replaceAll(/\s+/g, " ").trim()).toContain(
        "Universal, flexible, extensible, agent-optimized project management CLI for any project or programming language.",
      );
      expect(compactHelp.stdout).toContain("Intent:");
      expect(compactHelp.stdout).toContain("Need deeper rationale and more examples?");
      expect(compactHelp.stdout).toContain("Re-run with --explain.");

      const detailedHelp = context.runCli(["--help", "--explain"]);
      expect(detailedHelp.code).toBe(0);
      expect(detailedHelp.stdout).toContain("Why use this command:");
      expect(detailedHelp.stdout).toContain("Examples:");
      expect(detailedHelp.stdout).toContain("Tips:");
    });
  });

  it("treats help command paths as successful help output", async () => {
    await withTempPmPath(async (context) => {
      const topLevelHelp = context.runCli(["help"]);
      expect(topLevelHelp.code).toBe(0);
      expect(topLevelHelp.stdout).toContain("Usage: pm [options] [command]");
      expect(topLevelHelp.stderr.trim()).toBe("");

      const createHelp = context.runCli(["help", "create"]);
      expect(createHelp.code).toBe(0);
      expect(createHelp.stdout).toContain("Usage: pm create [options]");
      expect(createHelp.stderr.trim()).toBe("");
    });
  });

  it("returns non-zero unknown-command guidance for unavailable command help paths", async () => {
    await withTempPmPath(async (context) => {
      const textHelp = context.runCli(["beads", "--help"]);
      expect(textHelp.code).toBe(2);
      expect(textHelp.stderr).toContain("Unknown command beads");

      const jsonHelp = context.runCli(["beads", "--help", "--json"]);
      expect(jsonHelp.code).toBe(2);
      const envelope = JSON.parse(jsonHelp.stderr) as {
        code: string;
        title: string;
        exit_code: number;
      };
      expect(envelope.code).toBe("unknown_command");
      expect(envelope.title).toContain("Unknown command beads");
      expect(envelope.exit_code).toBe(2);
    });
  });

  it("renders machine-readable help payloads for --help --json and help --json", async () => {
    await withTempPmPath(async (context) => {
      const directJsonHelp = context.runCli(["create", "--help", "--json"], { expectJson: true });
      expect(directJsonHelp.code).toBe(0);
      const directPayload = directJsonHelp.json as {
        format: string;
        detail_mode: string;
        resolved_path: string;
        intent: string;
        options: Array<{ long: string | null; required: boolean; value_name: string | null }>;
      };
      expect(directPayload.format).toBe("pm_help_v1");
      expect(directPayload.detail_mode).toBe("compact");
      expect(directPayload.resolved_path).toBe("create");
      expect(directPayload.intent.length).toBeGreaterThan(0);
      expect(directPayload.options.some((entry) => entry.long === "--title" && entry.required)).toBe(true);
      expect(directPayload.options.some((entry) => entry.long === "--title" && entry.value_name === "value")).toBe(true);

      const helpCommandJson = context.runCli(["help", "create", "--json"], { expectJson: true });
      expect(helpCommandJson.code).toBe(0);
      const helpCommandPayload = helpCommandJson.json as {
        format: string;
        resolved_path: string;
      };
      expect(helpCommandPayload.format).toBe("pm_help_v1");
      expect(helpCommandPayload.resolved_path).toBe("create");

      const detailedRootJson = context.runCli(["--help", "--json", "--explain"], { expectJson: true });
      expect(detailedRootJson.code).toBe(0);
      const detailedPayload = detailedRootJson.json as {
        detail_mode: string;
        resolved_path: string;
        examples: string[];
        tips: string[];
      };
      expect(detailedPayload.detail_mode).toBe("detailed");
      expect(detailedPayload.resolved_path).toBe("pm");
      expect(detailedPayload.examples.length).toBeGreaterThan(1);
      expect(detailedPayload.tips.length).toBeGreaterThan(0);
    });
  });

  it("describes reindex help text as keyword plus semantic and hybrid capable", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["reindex", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("Rebuild search artifacts for keyword, semantic, and hybrid modes.");
      expect(help.stdout).toContain("Reindex mode: keyword|semantic|hybrid");
    });
  });

  it("describes include-linked help text as keyword and hybrid lexical scoring", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["search", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout.replaceAll(/\s+/g, " ").trim()).toContain(
        "Include readable linked docs/files/tests content in keyword and hybrid lexical scoring",
      );
    });
  });

  it("surfaces extension command schema details in help output and JSON payloads", async () => {
    await withTempPmPath(async (context) => {
      await createProjectExtension(
        context.pmPath,
        "migrate-asset-help",
        {
          name: "migrate-asset-help",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["commands", "schema"],
        },
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'migrate-asset',",
          "      action: 'migrate-asset',",
          "      description: 'Migrate asset descriptors to the active schema.',",
          "      intent: 'Validate and migrate asset descriptors before writing output.',",
          "      examples: [",
          "        'pm migrate-asset --source assets/source.json --target assets/output.json'",
          "      ],",
          "      failure_hints: [",
          "        'Ensure --source points to a readable descriptor file.'",
          "      ],",
          "      arguments: [",
          "        { name: 'assetId', required: false, description: 'Optional asset identifier override.' }",
          "      ],",
          "      flags: [",
          "        { long: '--source', value_name: 'path', required: true, description: 'Source descriptor path.' },",
          "        { long: '--target', value_name: 'path', description: 'Target descriptor path.' },",
          "        { long: '--dry-run', description: 'Preview migration without writing output.' }",
          "      ],",
          "      run: (context) => ({ ok: true, command: context.command, options: context.options })",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      const textHelp = context.runCli(["migrate-asset", "--help"]);
      expect(textHelp.code).toBe(0);
      expect(textHelp.stdout).toContain("Migrate asset descriptors to the active schema.");
      expect(textHelp.stdout).toContain("[assetId]");
      expect(textHelp.stdout).toContain("--source <path>");
      expect(textHelp.stdout).toContain("--target <path>");
      expect(textHelp.stdout).toContain("--dry-run");
      expect(textHelp.stdout).toContain("Extension command metadata:");
      expect(textHelp.stdout).toContain("Action contract: migrate-asset");
      expect(textHelp.stdout).toContain("Common failure hints:");

      const compactJsonHelp = context.runCli(["migrate-asset", "--help", "--json"], { expectJson: true });
      expect(compactJsonHelp.code).toBe(0);
      const compactPayload = compactJsonHelp.json as {
        detail_mode: string;
        intent: string;
        examples: string[];
        arguments: Array<{ name: string }>;
        options: Array<{ long: string | null; value_name: string | null }>;
      };
      expect(compactPayload.detail_mode).toBe("compact");
      expect(compactPayload.intent).toBe("Validate and migrate asset descriptors before writing output.");
      expect(compactPayload.examples).toEqual(["pm migrate-asset --source assets/source.json --target assets/output.json"]);
      expect(compactPayload.arguments).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "assetId" })]),
      );
      expect(compactPayload.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ long: "--source", value_name: "path" }),
          expect.objectContaining({ long: "--target", value_name: "path" }),
          expect.objectContaining({ long: "--dry-run", value_name: null }),
        ]),
      );

      const detailedJsonHelp = context.runCli(["migrate-asset", "--help", "--json", "--explain"], { expectJson: true });
      expect(detailedJsonHelp.code).toBe(0);
      const detailedPayload = detailedJsonHelp.json as {
        detail_mode: string;
        tips: string[];
      };
      expect(detailedPayload.detail_mode).toBe("detailed");
      expect(detailedPayload.tips).toEqual(["Ensure --source points to a readable descriptor file."]);
    });
  });

  it("renders structured usage guidance for missing required options", async () => {
    await withTempPmPath(async (context) => {
      const usage = context.runCli(["create", "--title", "Only title", "--description", "Only description", "--json"]);
      expect(usage.code).toBe(2);
      const envelope = JSON.parse(usage.stderr) as {
        type: string;
        code: string;
        title: string;
        detail: string;
        required: string;
        exit_code: number;
        examples?: string[];
        next_steps?: string[];
      };
      expect(envelope).toMatchObject({
        type: "urn:pm-cli:error:missing_required_option",
        code: "missing_required_option",
        title: "Missing required option --type <value>",
        exit_code: 2,
      });
      expect(envelope.detail).toContain("--type <value>");
      expect(envelope.required).toContain("Pass --type <value>");
      expect(envelope.examples?.length ?? 0).toBeGreaterThan(0);
      expect(envelope.next_steps?.length ?? 0).toBeGreaterThan(0);
    });
  });

  it("renders plural guidance when create is missing multiple type-required options", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Asset",
            folder: "assets",
            required_create_fields: [],
            required_create_repeatables: [],
            command_option_policies: [
              { command: "create", option: "message", required: true },
              { command: "create", option: "goal", required: true },
            ],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const usage = context.runCli(["create", "--title", "Asset title", "--description", "Asset description", "--type", "Asset", "--json"]);
      expect(usage.code).toBe(2);
      const envelope = JSON.parse(usage.stderr) as {
        type: string;
        code: string;
        title: string;
        detail: string;
        required: string;
        exit_code: number;
      };
      expect(envelope).toMatchObject({
        type: "urn:pm-cli:error:missing_required_option",
        code: "missing_required_option",
        title: "Missing required options",
        exit_code: 2,
      });
      expect(envelope.detail).toContain("--goal");
      expect(envelope.detail).toContain("--message");
    });
  });

  it("allows staged minimal create flows with --create-mode progressive", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--title",
          "Progressive create seed",
          "--description",
          "Staged governance triage item",
          "--type",
          "Task",
          "--create-mode",
          "progressive",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const payload = created.json as {
        item: {
          status: string;
          priority: number;
          tags: string[];
        };
      };
      expect(payload.item.status).toBe("open");
      expect(payload.item.priority).toBe(2);
      expect(payload.item.tags).toEqual([]);
    });
  });

  it("supports --allow-audit-comment for non-owner append-only comment audits", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--title",
          "Audit comment seed",
          "--description",
          "Seed item for audit comment policy checks",
          "--type",
          "Task",
          "--create-mode",
          "progressive",
          "--assignee",
          "owner-a",
          "--author",
          "owner-a",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;

      const blocked = context.runCli(["comments", id, "--add", "audit note", "--author", "owner-b", "--json"]);
      expect(blocked.code).toBe(4);
      const blockedEnvelope = JSON.parse(blocked.stderr) as {
        code: string;
        required: string;
        next_steps?: string[];
      };
      expect(blockedEnvelope.code).toBe("ownership_conflict");
      expect(blockedEnvelope.required).toContain("--allow-audit-comment");
      expect(blockedEnvelope.next_steps?.some((step) => step.includes("--allow-audit-comment"))).toBe(true);

      const allowed = context.runCli(
        ["comments", id, "--add", "audit note", "--author", "owner-b", "--allow-audit-comment", "--json"],
        { expectJson: true },
      );
      expect(allowed.code).toBe(0);
      const payload = allowed.json as { comments: Array<{ text: string; author: string }> };
      expect(payload.comments.at(-1)).toMatchObject({ text: "audit note", author: "owner-b" });
    });
  });

  it("renders ownership conflict guidance with explicit force-usage scenarios", async () => {
    await withTempPmPath(async (context) => {
      const createResult = context.runCli(
        [
          "create",
          "--title",
          "Ownership conflict guidance seed",
          "--description",
          "Seed item for ownership conflict guidance runtime checks.",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "help-runtime,ownership",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "5",
          "--acceptance-criteria",
          "Ownership conflict guidance remains actionable and deterministic.",
          "--author",
          "owner-a",
          "--message",
          "Seed ownership guidance test",
          "--assignee",
          "owner-a",
          "--dep",
          "none",
          "--comment",
          "none",
          "--note",
          "none",
          "--learning",
          "none",
          "--file",
          "none",
          "--test",
          "none",
          "--doc",
          "none",
          "--json",
        ],
        { expectJson: true },
      );
      expect(createResult.code).toBe(0);
      const id = (createResult.json as { item: { id: string } }).item.id;

      const jsonConflict = context.runCli(["update", id, "--status", "in_progress", "--author", "owner-b", "--json"]);
      expect(jsonConflict.code).toBe(4);
      const envelope = JSON.parse(jsonConflict.stderr) as {
        type: string;
        code: string;
        title: string;
        detail: string;
        required: string;
        exit_code: number;
        next_steps?: string[];
      };
      expect(envelope).toMatchObject({
        type: "urn:pm-cli:error:ownership_conflict",
        code: "ownership_conflict",
        title: "Ownership conflict",
        exit_code: 4,
      });
      expect(envelope.required).toContain("--force");
      expect(envelope.next_steps?.some((step) => step.includes("PM audits"))).toBe(true);
      expect(envelope.next_steps?.some((step) => step.includes("stale metadata"))).toBe(true);
      expect(envelope.next_steps?.some((step) => step.includes("pm claim <ID>"))).toBe(true);

      const textConflict = context.runCli(["update", id, "--status", "in_progress", "--author", "owner-b"]);
      expect(textConflict.code).toBe(4);
      expect(textConflict.stderr).toContain("Next steps:");
      expect(textConflict.stderr).toContain("PM audits");
    });
  });

  it("surfaces type-option schema details in create/update type-aware help", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Asset",
            folder: "assets",
            required_create_fields: [],
            required_create_repeatables: [],
            options: [
              {
                key: "category",
                values: ["feature", "maintenance"],
                required: true,
                aliases: ["cat"],
                description: "Asset category selector",
              },
            ],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const createHelp = context.runCli(["create", "--help", "--type", "Asset"]);
      expect(createHelp.code).toBe(0);
      expect(createHelp.stdout).toContain("Type-aware option policies for Asset:");
      expect(createHelp.stdout).toContain("type options:");
      expect(createHelp.stdout).toContain("- category (required)");
      expect(createHelp.stdout).toContain("values: feature|maintenance");
      expect(createHelp.stdout).toContain("aliases: cat");
      expect(createHelp.stdout).toContain("description: Asset category selector");

      const updateHelp = context.runCli(["update", "--help", "--type", "Asset"]);
      expect(updateHelp.code).toBe(0);
      expect(updateHelp.stdout).toContain("Type-aware option policies for Asset:");
      expect(updateHelp.stdout).toContain("type options:");
      expect(updateHelp.stdout).toContain("- category (required)");
    });
  });
});
