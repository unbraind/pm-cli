import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../../src/mcp/server.js";
import { buildItemCompletionMutations, commitItemMutations, previewItemMutations } from "../../../src/sdk/item-transaction.js";
import { createEmptyExtensionHookRegistry, setActiveExtensionHooks } from "../../../src/core/extensions/index.js";
import { runPmCli } from "../../../src/cli/main.js";
import { runDirectDistCli, runInProcessDistCli } from "../../helpers/cliRunner.js";
import type { PmSettings } from "../../../src/types/index.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { resolveExtensionMigrationStatePath } from "../../../src/sdk/extension/migrations.js";
import { EXIT_CODE, setFocusedItem } from "../../../src/sdk/runtime-primitives.js";
import { readSettings } from "../../../src/core/store/settings.js";
import { waitForPendingFlush } from "../../../src/core/telemetry/runtime.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

/** Snapshot durable tracker bytes, including session and telemetry state but excluding queues, caches, and locks. */
async function durableSnapshot(root: string): Promise<Record<string, string>> {
  const bytes: Record<string, string> = {};
  const retainedRuntimePaths = ["runtime", path.join("runtime", "session.json"), path.join("runtime", "telemetry"), path.join("runtime", "telemetry", "state.json")];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      const topLevel = relative.split(path.sep)[0]!;
      if (["locks", "cache", ".cache"].includes(topLevel) || (topLevel === "runtime" && !retainedRuntimePaths.includes(relative))) continue;
      if (entry.isDirectory()) await visit(file);
      else bytes[relative] = await readFile(file, "utf8");
    }
  }
  await visit(root);
  return bytes;
}

describe("semantic transaction previews (GH-1370)", () => {
  for (const command of ["mutate", "complete"]) {
    it.each(["missing-inside", "missing-outside"])(`keeps ${command} CLI schema bootstrap inside staging: %s`, async (mode) => {
      await withTempPmPath(async (context) => {
        expect(context.runCli(["create", "task", "Bootstrap target", "--id", "bootstrap", "--json"]).code).toBe(0);
        const settingsPath = path.join(context.pmPath, "settings.json");
        const original = await readFile(settingsPath, "utf8");
        const settings = JSON.parse(original) as PmSettings;
        const schemaPath = path.join(mode === "missing-inside" ? context.pmPath : context.tempRoot, "schema", "not-created-statuses.json");
        await mkdir(path.dirname(schemaPath), { recursive: true });
        settings.schema.files.statuses = schemaPath;
        await writeFile(settingsPath, JSON.stringify(settings));
        const before = await durableSnapshot(context.pmPath);
        for (const noExtensions of [false, true]) {
          const args = ["item", command, ...(command === "complete" ? ["pm-bootstrap", "Staged closure"] : []), "--transaction-id", "bootstrap-boundary", "--dry-run", "--json", ...(noExtensions ? ["--no-extensions"] : [])];
          const result = command === "mutate"
            ? context.runCli(args, { input: JSON.stringify([{ op: "update", id: "pm-bootstrap", options: { title: "Staged title" } }]), expectJson: true })
            : noExtensions
              ? runDirectDistCli(args, { env: context.env, expectJson: true })
              : await runInProcessDistCli(args, { env: context.env, expectJson: true }, runPmCli);
          expect(result.code).toBe(mode === "missing-inside" ? 0 : 2);
          if (mode === "missing-inside") expect(result.json).toMatchObject({ validation: { validated: true, state: "staged_snapshot" } });
          else expect(JSON.parse(result.stderr)).toMatchObject({ code: "transaction_preview_external_schema" });
          expect(await durableSnapshot(context.pmPath)).toEqual(before);
          await expect(readFile(schemaPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await writeFile(settingsPath, original);
        expect((await runInProcessDistCli(["get", "pm-bootstrap", "--json"], { env: context.env, expectJson: true }, runPmCli)).code).toBe(0);
      });
    });
  }

  for (const command of ["mutate", "complete"]) {
    it.skipIf(process.platform === "win32").each(["linked-parent", "pipe", "settings-link", "settings-pipe"])(`refuses unsafe ${command} CLI schema inputs before bootstrap access: %s`, async (kind) => {
      await withTempPmPath(async (context) => {
        expect(context.runCli(["create", "task", "Unsafe schema target", "--id", "unsafe", "--json"]).code).toBe(0);
        const settingsPath = path.join(context.pmPath, "settings.json");
        const original = await readFile(settingsPath, "utf8");
        const settings = JSON.parse(original) as PmSettings;
        const target = path.join(context.pmPath, "schema", "unsafe-statuses.json");
        const outside = path.join(context.tempRoot, "outside-schema");
        await mkdir(outside);
        switch (kind) {
          case "settings-pipe":
            await rm(settingsPath);
            execFileSync("mkfifo", [settingsPath]);
            break;
          case "settings-link":
            await rm(settingsPath);
            await writeFile(path.join(outside, "settings.json"), original);
            await symlink(path.join(outside, "settings.json"), settingsPath);
            break;
          case "pipe":
            execFileSync("mkfifo", [target]);
            settings.schema.files.statuses = target;
            await writeFile(settingsPath, JSON.stringify(settings));
            break;
          default:
            await symlink(outside, path.join(context.pmPath, "linked-schema"));
            settings.schema.files.statuses = "linked-schema/not-created.json";
            await writeFile(settingsPath, JSON.stringify(settings));
        }
        const beforeSettings = kind.startsWith("settings-") ? original : await readFile(settingsPath, "utf8");
        const itemPath = path.join(context.pmPath, "tasks", "pm-unsafe.toon");
        const beforeItem = await readFile(itemPath, "utf8");
        for (const noExtensions of [false, true]) {
          const args = ["item", command, ...(command === "complete" ? ["pm-unsafe", "Staged closure"] : []), "--transaction-id", "unsafe-schema", "--dry-run", "--json", ...(noExtensions ? ["--no-extensions"] : [])];
          const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...args], { env: context.env, encoding: "utf8", timeout: 10_000, input: command === "mutate" ? JSON.stringify([{ op: "update", id: "pm-unsafe", options: { title: "Staged title" } }]) : undefined });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(1);
          expect(result.stderr).toContain("Transaction preview requires regular files and directories");
          if (kind === "settings-pipe") expect((await lstat(settingsPath)).isFIFO()).toBe(true);
          else expect(await readFile(settingsPath, "utf8")).toBe(beforeSettings);
          expect(await readFile(itemPath, "utf8")).toBe(beforeItem);
          await expect(readFile(path.join(outside, "not-created.json"))).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    });
  }

  it("hydrates captured custom statuses during CLI preview and restores ordinary schema bootstrap afterward", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["create", "task", "Custom lifecycle target", "--id", "custom-status", "--json"]).code).toBe(0);
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as PmSettings;
      const statusesPath = path.join(context.pmPath, "schema", "statuses.json");
      const statuses = JSON.parse(await readFile(statusesPath, "utf8")) as { statuses: unknown[] };
      statuses.statuses.push({ id: "reviewed", roles: ["active"] });
      await writeFile(statusesPath, JSON.stringify(statuses));
      const before = await durableSnapshot(context.pmPath);
      const result = context.runCli(["item", "mutate", "--transaction-id", "custom-status", "--dry-run", "--json"], { input: JSON.stringify([{ op: "update", id: "pm-custom-status", options: { status: "reviewed" } }]), expectJson: true });
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ validation: { validated: true } });
      expect(await durableSnapshot(context.pmPath)).toEqual(before);
      settings.schema.files.statuses = path.join(context.pmPath, "schema", "ordinary-bootstrap.json");
      await writeFile(settingsPath, JSON.stringify(settings));
      expect((await runInProcessDistCli(["item", "complete", "pm-custom-status", "Staged closure", "--transaction-id", "restore-bootstrap", "--dry-run", "--json"], { env: context.env, expectJson: true }, runPmCli)).code).toBe(0);
      await expect(readFile(settings.schema.files.statuses)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await runInProcessDistCli(["get", "pm-custom-status", "--json"], { env: context.env, expectJson: true }, runPmCli)).code).toBe(0);
      expect(await readFile(settings.schema.files.statuses, "utf8")).toContain("statuses");
    });
  });

  it.each(["mutate", "complete"])("keeps pending extension migrations out of %s preview and runs them on ordinary commit", async (command) => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["create", "task", "Migration target", "--id", "migration", "--json"]).code).toBe(0);
      await writeTestExtension({ root: context.pmPath, placement: "projectRoot", directory: "preview-schema", entryFilename: "index.mjs", manifestOverrides: { capabilities: ["schema"], activation: { commands: ["item"] } }, entrySource: 'export default { activate(api) { api.registerMigration({ id: "pending-preview", status: "pending", run: () => undefined }); api.registerItemTypes([{ name: "PreviewTicket", folder: "preview-tickets" }]); } };' });
      const before = await durableSnapshot(context.pmPath);
      const args = ["item", command, ...(command === "complete" ? ["pm-migration", "Staged closure"] : []), "--transaction-id", "pending-migration", "--json"];
      const mutations = [{ op: "create", id: "pm-declarative", options: { title: "Declarative preview", type: "PreviewTicket" } }];
      const preview = command === "mutate"
        ? context.runCli([...args, "--dry-run"], { input: JSON.stringify(mutations), expectJson: true })
        : await runInProcessDistCli([...args, "--dry-run"], { env: context.env, expectJson: true }, runPmCli);
      expect(preview.code).toBe(0);
      expect(preview.json).toMatchObject({ validation: { validated: true } });
      expect(await durableSnapshot(context.pmPath)).toEqual(before);
      await expect(readFile(resolveExtensionMigrationStatePath(context.pmPath))).rejects.toMatchObject({ code: "ENOENT" });
      const committed = command === "mutate"
        ? context.runCli(args, { input: JSON.stringify(mutations), expectJson: true })
        : await runInProcessDistCli(args, { env: context.env, expectJson: true }, runPmCli);
      expect(committed.code).toBe(0);
      expect(JSON.parse(await readFile(resolveExtensionMigrationStatePath(context.pmPath), "utf8"))).toMatchObject({ entries: [expect.objectContaining({ id: "pending-preview", status: "applied" })] });
    });
  });

  it.each([
    { name: "extension consumes dry-run as a value", command: "item complete", beforeLeaf: [], flags: ["--package-note", "--dry-run"], preview: false },
    { name: "real dry-run follows an extension value", command: "item complete", beforeLeaf: [], flags: ["--package-note", "package", "--dry-run"], preview: true },
    { name: "namespace contributes inherited preview", command: "item", beforeLeaf: ["--dry-run"], flags: [], preview: true },
    { name: "namespace option precedes the selected action", command: "item", beforeLeaf: ["--package-note", "package"], flags: ["--dry-run"], preview: true },
  ])("uses registered option arity for structured settings policy: $name", async ({ command, beforeLeaf, flags, preview }) => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["create", "task", "Registered parser boundary", "--id", "parser-preview", "--json"]).code).toBe(0);
      await writeTestExtension({ root: context.pmPath, placement: "projectRoot", directory: "preview-flags", entryFilename: "index.mjs", manifestOverrides: { capabilities: ["schema"], activation: { commands: ["item"] } }, entrySource: `export default { activate(api) { api.registerFlags(${JSON.stringify(command)}, [${command === "item" && beforeLeaf.includes("--dry-run") ? '{ long: "--dry-run" }' : '{ long: "--package-note", value_name: "text" }'}]); api.registerMigration({ id: "registered-parser", status: "pending", run: () => undefined }); } };` });
      const statusesPath = path.join(context.pmPath, "schema", "statuses.json");
      const statuses = JSON.parse(await readFile(statusesPath, "utf8")) as { statuses: unknown[] };
      statuses.statuses.push({ id: "reviewed", roles: ["terminal", "terminal_done"] });
      await writeFile(statusesPath, JSON.stringify(statuses));
      const workflowsPath = path.join(context.pmPath, "schema", "workflows.json");
      const workflows = JSON.parse(await readFile(workflowsPath, "utf8")) as { workflow: { close_status: string } };
      workflows.workflow.close_status = "reviewed";
      await writeFile(workflowsPath, JSON.stringify(workflows));
      const globalRoot = context.env.PM_GLOBAL_PATH!;
      await mkdir(globalRoot, { recursive: true });
      const settings = JSON.parse(await readFile(path.join(context.pmPath, "settings.json"), "utf8")) as PmSettings;
      const schemaPath = path.join(globalRoot, "schema", "registered-normal-statuses.json");
      settings.schema.files.statuses = schemaPath;
      settings.telemetry = { ...settings.telemetry, enabled: true, installation_id: "", endpoint: "", first_run_prompt_completed: true };
      await writeFile(path.join(globalRoot, "settings.json"), JSON.stringify(settings));
      const beforeGlobal = await durableSnapshot(globalRoot);
      const beforeProject = await durableSnapshot(context.pmPath);
      const env = { ...context.env, PM_TELEMETRY_DISABLED: "0", PM_NO_TELEMETRY: "0", DO_NOT_TRACK: "0", PM_TELEMETRY_SEND_TEST_EVENTS: "1", PM_TELEMETRY_INLINE_FLUSH: "1" };
      const result = await runInProcessDistCli(["item", ...beforeLeaf, "complete", "pm-parser-preview", "Delivered", "--transaction-id", "registered-parser", "--json", "--validate-close", "off", ...flags], { env, expectJson: true }, runPmCli);
      expect(result.code, result.stderr).toBe(EXIT_CODE.SUCCESS);
      await waitForPendingFlush();
      if (preview) {
        expect(result.json).toMatchObject({ validation: { validated: true, state: "staged_snapshot" } });
        expect(await durableSnapshot(globalRoot)).toEqual(beforeGlobal);
        expect(await durableSnapshot(context.pmPath)).toEqual(beforeProject);
        await expect(readFile(schemaPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(resolveExtensionMigrationStatePath(context.pmPath))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(result.json).toMatchObject({ status: "committed" });
        expect((JSON.parse(await readFile(path.join(globalRoot, "settings.json"), "utf8")) as PmSettings).telemetry.installation_id.length).toBeGreaterThan(0);
        expect(await readFile(schemaPath, "utf8")).toContain("statuses");
        expect(JSON.parse(await readFile(resolveExtensionMigrationStatePath(context.pmPath), "utf8"))).toMatchObject({ entries: [expect.objectContaining({ id: "registered-parser", status: "applied" })] });
      }
      expect(context.runCli(["get", "pm-parser-preview", "--json"], { expectJson: true }).json).toMatchObject({ item: { status: preview ? "open" : "reviewed" } });
    });
  });

  it("protects a real package preview when another core command owns its boolean flag name", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["create", "task", "Package boolean preview", "--id", "boolean-preview", "--json"]).code).toBe(0);
      await writeTestExtension({ root: context.pmPath, placement: "projectRoot", directory: "boolean-flags", entryFilename: "index.mjs", manifestOverrides: { capabilities: ["schema"], activation: { commands: ["item"] } }, entrySource: 'export default { activate(api) { api.registerFlags("item mutate", [{ long: "--reason" }]); } };' });
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as PmSettings;
      const schemaPath = path.join(context.pmPath, "schema", "boolean-not-created.json");
      settings.schema.files.statuses = schemaPath;
      await writeFile(settingsPath, JSON.stringify(settings));
      const before = await durableSnapshot(context.pmPath);
      const result = context.runCli(["item", "mutate", "--transaction-id", "package-boolean", "--reason", "--dry-run", "--json"], { input: JSON.stringify([{ op: "update", id: "pm-boolean-preview", options: { title: "Staged title" } }]), expectJson: true });
      expect(result.code, result.stderr).toBe(EXIT_CODE.SUCCESS);
      expect(result.json).toMatchObject({ validation: { validated: true, state: "staged_snapshot" } });
      await expect(readFile(schemaPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await durableSnapshot(context.pmPath)).toEqual(before);
    });
  });

  it("preserves source preparation through unknown namespace option diagnostics", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["create", "task", "Invalid preview boundary", "--id", "invalid-preview", "--json"]).code).toBe(0);
      const globalRoot = context.env.PM_GLOBAL_PATH!;
      await mkdir(globalRoot, { recursive: true });
      for (const root of [context.pmPath, globalRoot]) {
        const settings = JSON.parse(await readFile(path.join(context.pmPath, "settings.json"), "utf8")) as PmSettings;
        settings.schema.files.statuses = path.join(root, "schema", "invalid-not-created.json");
        settings.telemetry = { ...settings.telemetry, enabled: true, installation_id: "", endpoint: "", first_run_prompt_completed: true };
        await writeFile(path.join(root, "settings.json"), JSON.stringify(settings));
      }
      const before = await Promise.all([durableSnapshot(context.pmPath), durableSnapshot(globalRoot)]);
      const env = { ...context.env, PM_TELEMETRY_DISABLED: "0", PM_NO_TELEMETRY: "0", DO_NOT_TRACK: "0", PM_TELEMETRY_SEND_TEST_EVENTS: "1", PM_TELEMETRY_INLINE_FLUSH: "1" };
      const result = await runInProcessDistCli(["item", "--unknown", "complete", "pm-invalid-preview", "Delivered", "--transaction-id", "invalid-preview", "--dry-run", "--json"], { env }, runPmCli);
      expect(result.code).toBe(EXIT_CODE.USAGE);
      expect(result.stderr).toContain("unknown_option");
      await waitForPendingFlush();
      expect(await Promise.all([durableSnapshot(context.pmPath), durableSnapshot(globalRoot)])).toEqual(before);
    });
  });

  it.each(["", "22222222-2222-4222-8222-222222222222"])("preserves global preparation while retaining consented CLI preview telemetry: %s", async (installationId) => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["create", "task", "Telemetry boundary", "--id", "telemetry-preview", "--json"]).code).toBe(0);
      const globalRoot = context.env.PM_GLOBAL_PATH!;
      await mkdir(globalRoot, { recursive: true });
      const settings = JSON.parse(await readFile(path.join(context.pmPath, "settings.json"), "utf8")) as PmSettings;
      const schemaPath = path.join(globalRoot, "schema", "not-created-global-statuses.json");
      settings.schema.files.statuses = schemaPath;
      settings.telemetry = { ...settings.telemetry, enabled: true, installation_id: installationId, endpoint: "", first_run_prompt_completed: true };
      await writeFile(path.join(globalRoot, "settings.json"), JSON.stringify(settings));
      const beforeGlobal = await durableSnapshot(globalRoot);
      const beforeProject = await durableSnapshot(context.pmPath);
      const env = { ...context.env, PM_TELEMETRY_DISABLED: "0", PM_NO_TELEMETRY: "0", DO_NOT_TRACK: "0", PM_TELEMETRY_SEND_TEST_EVENTS: "1", PM_TELEMETRY_INLINE_FLUSH: "1" };
      for (const id of ["pm-telemetry-preview", "pm-missing-telemetry"]) {
        const result = await runInProcessDistCli(["item", "complete", id, "Delivered", "--transaction-id", id, "--dry-run", "--json", "--no-extensions", "--validate-close", "off"], { env, expectJson: true }, runPmCli);
        expect(result.code).toBe(id === "pm-telemetry-preview" ? EXIT_CODE.SUCCESS : EXIT_CODE.NOT_FOUND);
        expect(await durableSnapshot(globalRoot)).toEqual(beforeGlobal);
        expect(await durableSnapshot(context.pmPath)).toEqual(beforeProject);
        await expect(readFile(schemaPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const queuePath = path.join(globalRoot, "runtime", "telemetry", "events.jsonl");
      if (installationId.length === 0) await expect(readFile(queuePath)).rejects.toMatchObject({ code: "ENOENT" });
      else {
        const queued = (await readFile(queuePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { event: { event_type: string; installation_id: string } });
        expect(queued.map(({ event }) => event.event_type)).toEqual(["command_start", "command_finish", "command_start", "command_error", "command_finish"]);
        expect(queued.every(({ event }) => event.installation_id === installationId)).toBe(true);
        await expect(readFile(path.join(globalRoot, "runtime", "telemetry", "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      const applied = await runInProcessDistCli(["item", "complete", "pm-telemetry-preview", "Delivered", "--transaction-id", "ordinary-telemetry", "--json", "--no-extensions", "--validate-close", "off"], { env, expectJson: true }, runPmCli);
      expect(applied.code).toBe(0);
      await waitForPendingFlush();
      expect(await readFile(schemaPath, "utf8")).toContain("statuses");
      expect((await readSettings(globalRoot)).telemetry.installation_id.length).toBeGreaterThan(0);
    });
  });

  it("rejects invalid scalar domains and missing targets with apply's codes and no source writes", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["create", "task", "Preview target", "--id", "preview", "--json"]).code).toBe(0);
      for (const [index, mutation] of [
        { op: "update", id: "pm-preview", options: { risk: "invalid" } },
        { op: "update", id: "pm-preview", options: { status: "invalid" } },
        { op: "update", id: "pm-missing", options: { title: "Absent" } },
      ].entries()) {
        const before = await durableSnapshot(context.pmPath);
        const base = ["item", "mutate", "--transaction-id", `invalid-${index}`, "--json", "--lean"];
        const preview = context.runCli([...base, "--dry-run"], { input: JSON.stringify([mutation]) });
        expect(await durableSnapshot(context.pmPath)).toEqual(before);
        const applied = context.runCli(base, { input: JSON.stringify([mutation]) });
        expect(preview.code).toBe(applied.code);
        expect(preview.code).not.toBe(0);
        const diagnostic = JSON.parse(preview.stderr);
        expect(diagnostic.code).toBe(JSON.parse(applied.stderr).code);
        expect(diagnostic.transaction_operation).toEqual({ index: 0, op: "update", id: mutation.id });
      }
    });
  });

  it("validates strict completion after earlier staged evidence while preserving claims and history", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["create", "task", "Completion target", "--id", "complete", "--json"]).code).toBe(0);
      expect(context.runCli(["claim", "pm-complete", "--author", "preview-agent", "--json"]).code).toBe(0);
      await setFocusedItem(context.pmPath, "pm-complete");
      const before = await durableSnapshot(context.pmPath);
      expect(JSON.parse(before[path.join("runtime", "session.json")] ?? "null") as unknown).toMatchObject({ focused_item: "pm-complete" });
      const base = ["item", "complete", "pm-complete", "Delivered", "--validate-close", "strict", "--author", "preview-agent", "--json"];
      const invalid = context.runCli([...base, "--transaction-id", "completion", "--dry-run"]);
      expect(invalid.code).toBe(2);
      expect(await durableSnapshot(context.pmPath)).toEqual(before);
      expect(context.runCli([...base, "--transaction-id", "completion"]).code).toBe(2);
      const valid = [...base, "--transaction-id", "completion-valid", "--comment", "text=Staged completion evidence", "--resolution", "Delivered", "--expected-result", "Expected", "--actual-result", "Observed"];
      const beforeValid = await durableSnapshot(context.pmPath);
      const preview = context.runCli([...valid, "--dry-run"], { expectJson: true });
      expect(preview.code).toBe(0);
      expect(preview.json).toMatchObject({ mutation_count: 3, validation: { validated: true, state: "staged_snapshot", unresolved_commit_constraints: ["concurrent_tracker_changes", "extension_mutation_guards_and_hooks"] } });
      expect(await durableSnapshot(context.pmPath)).toEqual(beforeValid);
      expect(context.runCli(valid).code).toBe(0);
      expect(context.runCli(["get", "pm-complete", "--full", "--json"], { expectJson: true }).json).toMatchObject({ item: { status: "closed", resolution: "Delivered", comments: [expect.objectContaining({ text: "Staged completion evidence" })] } });
    });
  });

  it("shares SDK and MCP validation, suppresses source hooks, and still revalidates commit", async () => {
    await withTempPmPath(async (context) => {
      const options = { pmRoot: context.pmPath, transactionId: "sdk-preview", author: "preview-agent", mutations: [
        { op: "create" as const, id: "pm-staged", options: { title: "Staged", type: "Task" } },
        { op: "update" as const, id: "pm-staged", options: { resolution: "Delivered", expectedResult: "Expected", actualResult: "Observed" } },
        ...buildItemCompletionMutations({ id: "pm-staged", reason: "Complete", closeOptions: { validateClose: "strict" } }),
      ] };
      let hooks = 0;
      setActiveExtensionHooks({ ...createEmptyExtensionHookRegistry(), beforeMutation: [{ layer: "project", name: "guard", run: async () => { hooks += 1; return { allow: true }; } }], onWrite: [{ layer: "project", name: "writer", run: async () => { hooks += 1; } }] });
      try {
        const before = await durableSnapshot(context.pmPath);
        expect(await previewItemMutations(options)).toMatchObject({ validated: true });
        expect(hooks).toBe(0);
        expect(await durableSnapshot(context.pmPath)).toEqual(before);
      } finally { setActiveExtensionHooks(null); }
      await commitItemMutations(options);
      const beforeReplay = await durableSnapshot(context.pmPath);
      expect(await previewItemMutations(options)).toMatchObject({ validated: false, state: "replayed_committed_plan" });
      const replayCli = context.runCli(["item", "mutate", "--transaction-id", options.transactionId, "--author", options.author, "--dry-run", "--json"], { expectJson: true, input: JSON.stringify(options.mutations) });
      expect(replayCli.code).toBe(0);
      expect(replayCli.json).toMatchObject({ validation: { validated: false, state: "replayed_committed_plan" } });
      const replayMcp = await handleRequest({ jsonrpc: "2.0", id: "replay", method: "tools/call", params: { name: "pm_mutate", arguments: { path: context.pmPath, transactionId: options.transactionId, author: options.author, dryRun: true, mutations: options.mutations } } });
      expect(replayMcp?.structuredContent).toMatchObject({ result: { validation: { validated: false, state: "replayed_committed_plan" } } });
      expect(await durableSnapshot(context.pmPath)).toEqual(beforeReplay);
      await expect(previewItemMutations({ ...options, mutations: options.mutations.slice(0, 1) })).rejects.toThrow("journal does not match the supplied plan");
      await expect(handleRequest({ jsonrpc: "2.0", id: "preview", method: "tools/call", params: { name: "pm_mutate", arguments: { path: context.pmPath, transactionId: "mcp-preview", dryRun: true, mutations: [{ op: "update", id: "pm-staged", options: { risk: "invalid" } }] } } })).rejects.toMatchObject({ exitCode: 2, context: { transaction_operation: { index: 0, op: "update", id: "pm-staged" } } });
      const beforeExplicitCwd = await durableSnapshot(context.pmPath);
      const previewWithCwd = await handleRequest({ jsonrpc: "2.0", id: "cwd-preview", method: "tools/call", params: { name: "pm_mutate", arguments: { cwd: context.tempRoot, path: context.pmPath, transactionId: "mcp-explicit-cwd-preview", dryRun: true, author: "preview-agent", mutations: [{ op: "update", id: "pm-staged", options: { risk: "low" } }] } } });
      expect(previewWithCwd?.structuredContent).toMatchObject({ result: { dry_run: true, validation: { validated: true } } });
      expect(await durableSnapshot(context.pmPath)).toEqual(beforeExplicitCwd);
      await expect(previewItemMutations({ ...options, mutations: [] })).rejects.toThrow("at least one mutation");
      await expect(previewItemMutations({ ...options, transactionId: "../invalid" })).rejects.toThrow();
      await expect(previewItemMutations({ ...options, mutations: [{ op: "invalid", id: "x" } as never] })).rejects.toThrow("op must be");
      await expect(previewItemMutations({ ...options, pmRoot: path.join(context.tempRoot, "missing") })).rejects.toThrow();
      await expect(previewItemMutations({ ...options, transactionId: "native-validation", mutations: [{ op: "create", id: "pm-native", options: { title: "Native validation", type: [] as never } }] })).rejects.toBeInstanceOf(TypeError);
      const next = { ...options, transactionId: "changed-since-preview", mutations: [{ op: "update" as const, id: "pm-staged", options: { risk: "low" } }] };
      expect(await previewItemMutations(next)).toMatchObject({ validated: true });
      expect(context.runCli(["delete", "pm-staged", "--reason", "Concurrent fixture change", "--json"]).code).toBe(0);
      await expect(commitItemMutations(next)).rejects.toMatchObject({ exitCode: 3 });
    });
  });
});
