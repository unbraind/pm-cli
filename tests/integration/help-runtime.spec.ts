import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

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

function setGovernancePreset(context: TempPmContext, preset: "minimal" | "default" | "strict"): void {
  const result = context.runCli(["config", "project", "set", "governance-preset", "--policy", preset, "--json"], {
    expectJson: true,
  });
  expect(result.code).toBe(0);
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
      expect(compactHelp.stdout).toContain("--no-pager");

      const explicitNoPagerHelp = context.runCli(["--help", "--no-pager"]);
      expect(explicitNoPagerHelp.code).toBe(0);
      expect(explicitNoPagerHelp.stdout).toContain("Usage: pm [options] [command]");

      const detailedHelp = context.runCli(["--help", "--explain"]);
      expect(detailedHelp.code).toBe(0);
      expect(detailedHelp.stdout).toContain("Why use this command:");
      expect(detailedHelp.stdout).toContain("Examples:");
      expect(detailedHelp.stdout).toContain("Tips:");
      expect(detailedHelp.stdout).toContain("pm install guide-shell --project");
      expect(detailedHelp.stdout).toContain("Install guide-shell before using pm guide");
    });
  });

  it("reports guide command as optional package surface in bare core mode", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["guide", "--help"]);
      expect(help.code).toBe(2);
      expect(help.stderr).toContain("Unknown command guide");
      expect(help.stderr).toContain("pm install guide-shell");
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
      expect(textHelp.stderr).toContain("pm --help");
      expect(textHelp.stderr).toContain("Recovery bundle:");
      expect(textHelp.stderr).toContain("attempted_command: pm beads --help");
      expect(textHelp.stderr).toContain("pm install beads");
      expect(textHelp.stderr).not.toContain("pm todos --help");

      const jsonHelp = context.runCli(["beads", "--help", "--json"]);
      expect(jsonHelp.code).toBe(2);
      const envelope = JSON.parse(jsonHelp.stderr) as {
        code: string;
        title: string;
        exit_code: number;
        examples?: string[];
        recovery?: { attempted_command?: string; normalized_args?: string[] };
      };
      expect(envelope.code).toBe("unknown_command");
      expect(envelope.title).toContain("Unknown command beads");
      expect(envelope.exit_code).toBe(2);
      expect(envelope.examples).toBeDefined();
      expect(envelope.examples?.[0]).toBe("pm --help");
      expect(envelope.examples?.some((example) => example.includes("beads"))).toBe(false);
      expect(envelope.examples?.some((example) => example.includes("todos"))).toBe(false);
      expect(envelope.recovery?.attempted_command).toBe("pm beads --help --json");
      expect(envelope.recovery?.normalized_args).toEqual(["beads", "--help", "--json"]);
    });
  });

  it("applies help_format service overrides for commander usage errors", async () => {
    await withTempPmPath(async (context) => {
      await createProjectExtension(
        context.pmPath,
        "help-format-service",
        {
          name: "help-format-service",
          version: "1.0.0",
          entry: "./index.mjs",
          capabilities: ["services"],
        },
        [
          "export default {",
          "  activate(api) {",
          "    api.registerService('help_format', (context) => {",
          "      const payload = typeof context.payload === 'object' && context.payload !== null ? context.payload : {};",
          "      const message = typeof payload.message === 'string' ? payload.message : String(context.payload ?? '');",
          "      return `${message}\\n[service-help-format-applied]`;",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      const usage = context.runCli(["list-open", "--bogus"]);
      expect(usage.code).toBe(2);
      expect(usage.stderr).toContain("Unknown option --bogus");
      expect(usage.stderr).toContain("[service-help-format-applied]");
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

      const planJsonHelp = context.runCli(["plan", "--help", "--json"], { expectJson: true });
      expect(planJsonHelp.code).toBe(0);
      const planPayload = planJsonHelp.json as {
        options: Array<{ long: string | null; aliases?: string[]; alias_for: string | null }>;
      };
      expect(planPayload.options.some((entry) => entry.long === "--blocked_by")).toBe(false);
      expect(planPayload.options.find((entry) => entry.long === "--blocked-by")?.aliases).toContain("--blocked_by");

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

  it("reports search package commands as optional package-owned commands in bare core mode", async () => {
    await withTempPmPath(async (context) => {
      for (const commandName of ["reindex", "search-advanced"]) {
        const help = context.runCli([commandName, "--help"]);
        expect(help.code).toBe(2);
        expect(help.stderr).toContain(`Unknown command ${commandName}`);
        expect(help.stderr).toContain("pm install search-advanced");
      }
    });
  });

  it("describes search help text as keyword-first with opt-in semantic modes", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["search", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("Search items with keyword, semantic, or hybrid retrieval.");
      expect(help.stdout).toMatch(/Search mode: keyword\|semantic\|hybrid \(default:\s+keyword\)/);
      expect(help.stdout).toContain("--include-linked");
    });
  });

  it("accepts get depth for lower-token item inspection", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["get", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("--depth");
      expect(help.stdout).toContain("--fields");
      expect(help.stdout).toContain("brief|standard|deep");

      const created = context.runCli(
        [
          "create",
          "--title",
          "Get depth runtime",
          "--description",
          "Verify get depth projection.",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--create-mode",
          "progressive",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item?: { id?: string } }).item?.id ?? "";

      const brief = context.runCli(["get", id, "--depth", "brief", "--json"], { expectJson: true });
      expect(brief.code).toBe(0);
      const payload = brief.json as { item?: { id?: string }; body?: string; linked?: { files?: unknown[] } };
      expect(payload.item?.id).toBe(id);
      expect(payload.body).toBe("");
      expect(payload.linked?.files).toEqual([]);

      const fields = context.runCli(["get", id, "--fields", "id,title,status,parent,type", "--json"], { expectJson: true });
      expect(fields.code).toBe(0);
      const fieldsPayload = fields.json as { item?: Record<string, unknown>; body?: string; linked?: { files?: unknown[] } };
      expect(fieldsPayload.item).toEqual({
        id,
        title: "Get depth runtime",
        status: "open",
        type: "Task",
      });
      expect(fieldsPayload.item).not.toHaveProperty("description");
      expect(fieldsPayload.body).toBeUndefined();
      expect(fieldsPayload.linked).toBeUndefined();
    });
  });

  it("renders intent and example sections for installed templates plus core commands", async () => {
    await withTempPmPath(async (context) => {
      const installTemplates = context.runCli(["install", "templates", "--project", "--json"], { expectJson: true });
      expect(installTemplates.code).toBe(0);

      for (const commandName of ["templates", "deps", "update-many"] as const) {
        const compact = context.runCli([commandName, "--help"]);
        expect(compact.code).toBe(0);
        if (commandName === "templates") {
          expect(compact.stdout).toContain("Extension command metadata:");
          expect(compact.stdout).toContain("Action contract:");
        } else {
          expect(compact.stdout).toContain("Intent:");
          expect(compact.stdout).toContain("Example:");
        }

        const detailed = context.runCli([commandName, "--help", "--explain"]);
        expect(detailed.code).toBe(0);
        if (commandName === "templates") {
          expect(detailed.stdout).toContain("Extension command metadata:");
        } else {
          expect(detailed.stdout).toContain("Why use this command:");
          expect(detailed.stdout).toContain("Examples:");
        }
      }

      const normalizeHelp = context.runCli(["normalize", "--help"]);
      expect(normalizeHelp.code).toBe(2);
      expect(normalizeHelp.stderr).toContain("Unknown command normalize");
      expect(normalizeHelp.stderr).toContain("pm install governance-audit");
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
      // create-mode=strict disables the default-Task fallback to keep the strict required-option contract
      const usage = context.runCli([
        "create",
        "--title",
        "Only title",
        "--description",
        "Only description",
        "--create-mode",
        "strict",
        "--json",
      ]);
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
        recovery?: {
          attempted_command?: string;
          normalized_args?: string[];
          provided_fields?: string[];
          missing?: string[];
          suggested_retry?: string;
        };
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
      expect(envelope.recovery?.attempted_command).toBe(
        'pm create --title "Only title" --description "Only description" --create-mode strict --json',
      );
      expect(envelope.recovery?.normalized_args).toEqual([
        "create",
        "--title",
        "Only title",
        "--description",
        "Only description",
        "--create-mode",
        "strict",
        "--json",
      ]);
      expect(envelope.recovery?.provided_fields).toEqual(
        expect.arrayContaining(["--description", "--json", "--title", "--create-mode"]),
      );
      expect(envelope.recovery?.missing).toEqual(expect.arrayContaining(["--type"]));
      expect(envelope.recovery?.suggested_retry).toContain("--type");
    });
  });

  it("does not mark malformed provided reminder as missing or suggest an identical retry", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "--title", "Reminder validation", "--type", "Task", "--json"], {
        expectJson: true,
      });
      expect(created.code).toBe(0);
      const itemId = (created.json as { item?: { id?: string } }).item?.id;
      expect(itemId).toBeDefined();

      const usage = context.runCli(["update", itemId ?? "", "--reminder", "text=missing-at", "--json"]);
      expect(usage.code).toBe(2);
      const envelope = JSON.parse(usage.stderr) as {
        code: string;
        recovery?: {
          provided_fields?: string[];
          missing?: string[];
          suggested_retry?: string;
        };
      };
      expect(envelope.code).toBe("invalid_argument_value");
      expect(envelope.recovery?.provided_fields).toEqual(expect.arrayContaining(["--json", "--reminder"]));
      expect(envelope.recovery?.missing ?? []).not.toContain("--reminder");
      expect(envelope.recovery?.suggested_retry).toBeUndefined();
    });
  });

  it("allows create templates to satisfy missing --type", async () => {
    await withTempPmPath(async (context) => {
      const installTemplates = context.runCli(["install", "templates", "--project", "--json"], { expectJson: true });
      expect(installTemplates.code).toBe(0);

      const savedTemplate = context.runCli(
        ["templates", "save", "typed-task-default", "--type", "Task", "--priority", "1", "--json"],
        { expectJson: true },
      );
      expect(savedTemplate.code).toBe(0);

      const created = context.runCli(
        [
          "create",
          "--title",
          "Template type item",
          "--description",
          "Type should come from template",
          "--template",
          "typed-task-default",
          "--create-mode",
          "progressive",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const payload = created.json as {
        item: {
          type: string;
          priority: number;
        };
      };
      expect(payload.item.type).toBe("Task");
      expect(payload.item.priority).toBe(1);
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

  it("supports lightweight scheduling create preset for Reminder/Meeting/Event", async () => {
    await withTempPmPath(async (context) => {
      for (const type of ["Reminder", "Meeting", "Event"] as const) {
        const created = context.runCli(
          [
            "create",
            "--title",
            `${type} lightweight seed`,
            "--description",
            `Minimal ${type.toLowerCase()} schedule artifact`,
            "--type",
            type,
            "--schedule-preset",
            "lightweight",
            "--json",
          ],
          { expectJson: true },
        );
        expect(created.code).toBe(0);
        const payload = created.json as { item: { type: string; status: string; priority: number } };
        expect(payload.item.type).toBe(type);
        expect(payload.item.status).toBe("open");
        expect(payload.item.priority).toBe(2);
      }
    });
  });

  it("supports --allow-audit-comment for non-owner append-only comment audits", async () => {
    await withTempPmPath(async (context) => {
      setGovernancePreset(context, "strict");
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

  it("supports command-specific audit aliases for notes/learnings with legacy compatibility", async () => {
    await withTempPmPath(async (context) => {
      setGovernancePreset(context, "strict");
      const created = context.runCli(
        [
          "create",
          "--title",
          "Audit note-learning seed",
          "--description",
          "Seed item for notes/learnings audit alias checks",
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

      const blockedNote = context.runCli(["notes", id, "--add", "audit note", "--author", "owner-b", "--json"]);
      expect(blockedNote.code).toBe(4);
      const blockedNoteEnvelope = JSON.parse(blockedNote.stderr) as {
        code: string;
        required: string;
        next_steps?: string[];
      };
      expect(blockedNoteEnvelope.code).toBe("ownership_conflict");
      expect(blockedNoteEnvelope.required).toContain("--allow-audit-note");
      expect(blockedNoteEnvelope.required).toContain("--allow-audit-comment");
      expect(blockedNoteEnvelope.next_steps?.some((step) => step.includes("--allow-audit-note"))).toBe(true);

      const allowedNote = context.runCli(
        ["notes", id, "--add", "audit note", "--author", "owner-b", "--allow-audit-note", "--json"],
        { expectJson: true },
      );
      expect(allowedNote.code).toBe(0);
      const allowedNotePayload = allowedNote.json as { notes: Array<{ text: string; author: string }> };
      expect(allowedNotePayload.notes.at(-1)).toMatchObject({ text: "audit note", author: "owner-b" });

      const allowedNoteLegacy = context.runCli(
        ["notes", id, "--add", "legacy alias note", "--author", "owner-b", "--allow-audit-comment", "--json"],
        { expectJson: true },
      );
      expect(allowedNoteLegacy.code).toBe(0);
      const allowedNoteLegacyPayload = allowedNoteLegacy.json as { notes: Array<{ text: string; author: string }> };
      expect(allowedNoteLegacyPayload.notes.at(-1)).toMatchObject({ text: "legacy alias note", author: "owner-b" });

      const blockedLearning = context.runCli(["learnings", id, "--add", "audit learning", "--author", "owner-b", "--json"]);
      expect(blockedLearning.code).toBe(4);
      const blockedLearningEnvelope = JSON.parse(blockedLearning.stderr) as {
        code: string;
        required: string;
        next_steps?: string[];
      };
      expect(blockedLearningEnvelope.code).toBe("ownership_conflict");
      expect(blockedLearningEnvelope.required).toContain("--allow-audit-learning");
      expect(blockedLearningEnvelope.required).toContain("--allow-audit-comment");
      expect(blockedLearningEnvelope.next_steps?.some((step) => step.includes("--allow-audit-learning"))).toBe(true);

      const allowedLearning = context.runCli(
        ["learnings", id, "--add", "audit learning", "--author", "owner-b", "--allow-audit-learning", "--json"],
        { expectJson: true },
      );
      expect(allowedLearning.code).toBe(0);
      const allowedLearningPayload = allowedLearning.json as { learnings: Array<{ text: string; author: string }> };
      expect(allowedLearningPayload.learnings.at(-1)).toMatchObject({ text: "audit learning", author: "owner-b" });

      const allowedLearningLegacy = context.runCli(
        ["learnings", id, "--add", "legacy alias learning", "--author", "owner-b", "--allow-audit-comment", "--json"],
        { expectJson: true },
      );
      expect(allowedLearningLegacy.code).toBe(0);
      const allowedLearningLegacyPayload = allowedLearningLegacy.json as { learnings: Array<{ text: string; author: string }> };
      expect(allowedLearningLegacyPayload.learnings.at(-1)).toMatchObject({
        text: "legacy alias learning",
        author: "owner-b",
      });
    });
  });

  it("supports --allow-audit-release for non-owner release handoffs", async () => {
    await withTempPmPath(async (context) => {
      setGovernancePreset(context, "strict");
      const created = context.runCli(
        [
          "create",
          "--title",
          "Audit release seed",
          "--description",
          "Seed item for audit release policy checks",
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

      const blocked = context.runCli(["release", id, "--author", "owner-b", "--json"]);
      expect(blocked.code).toBe(4);
      const blockedEnvelope = JSON.parse(blocked.stderr) as {
        code: string;
        required: string;
        next_steps?: string[];
      };
      expect(blockedEnvelope.code).toBe("ownership_conflict");
      expect(blockedEnvelope.required).toContain("--allow-audit-release");
      expect(blockedEnvelope.next_steps?.some((step) => step.includes("--allow-audit-release"))).toBe(true);

      const allowed = context.runCli(["release", id, "--author", "owner-b", "--allow-audit-release", "--json"], {
        expectJson: true,
      });
      expect(allowed.code).toBe(0);
      const payload = allowed.json as { item: { assignee?: string }; released_by: string; audit_release: boolean };
      expect(payload.released_by).toBe("owner-b");
      expect(payload.audit_release).toBe(true);
      expect(payload.item.assignee).toBeUndefined();
    });
  });

  it("renders ownership conflict guidance with explicit force-usage scenarios", async () => {
    await withTempPmPath(async (context) => {
      setGovernancePreset(context, "strict");
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
