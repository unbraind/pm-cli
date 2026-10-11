import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPmCli } from "../../../src/cli/main.js";
import { runRuntimeCompatibleCli } from "../../../src/cli/runtime-compatibility-boundary.js";
import type { JsonErrorEnvelope } from "../../../src/cli/error-guidance.js";
import { PmClient, runAction, runGet } from "../../../src/sdk/runtime.js";
import type { OutputOmissionReceipt } from "../../../src/sdk/output-projection.js";
import { applyContextIntentProjection } from "../../../src/sdk/context-intent-contracts.js";
import { createTaskFixture } from "../../helpers/createTaskFixture.js";
import { runDirectDistCli, runInProcessDistCli } from "../../helpers/cliRunner.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { verifyInstalledAgentRecovery } from "../../../scripts/release/agent-recovery-acceptance.mjs";

describe("agent receipt and recovery contracts", () => {
  it.runIf(process.platform === "win32")(
    "executes real Windows command shims with JSON operands intact",
    async () => {
      await withTempPmPath(async (context) => {
        const shimRoot = path.join(
          context.tempRoot,
          "command shim with spaces",
        );
        await mkdir(shimRoot);
        const shim = path.join(shimRoot, "pm-recovery.cmd");
        await writeFile(
          shim,
          `@"${process.execPath}" "${path.join(process.cwd(), "dist", "cli.js")}" %*\r\n`,
        );
        const direct = spawnSync(shim, ["--version"], { encoding: "utf8" });
        expect(direct.error).toBeDefined();
        expect(
          verifyInstalledAgentRecovery(shim, [], {
            env: context.env,
            cwd: context.tempRoot,
          }),
        ).toMatchObject({
          ok: true,
          authoritative_bytes_preserved: true,
          measurement_recovery: true,
        });
      });
    },
  );


  it("replays extension help in the explicitly selected tracker from a different default tracker", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, "pm-extension-scope", "Keep the selected tracker unchanged.");
      const extensionDir = path.join(context.tempRoot, "scoped-package");
      await mkdir(extensionDir);
      await writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify({ name: "recoveryprobe", version: "1.0.0", entry: "index.js", capabilities: ["commands"] }));
      await writeFile(path.join(extensionDir, "index.js"), "export default { activate(api) { for (const name of ['recoveryprobe scoped-help', 'recoveryprobe subgroup inspect', 'subgroup misplaced']) api.registerCommand({ name, run: () => ({ ok: true }) }); } };\n");
      expect(context.runCli(["package", "install", extensionDir, "--json"], { expectJson: true }).code).toBe(0);
      const otherTracker = path.join(context.tempRoot, "other-tracker");
      expect(context.runCli(["--pm-path", otherTracker, "init", "--json"], { expectJson: true }).code).toBe(0);
      const env = { ...context.env, PM_PATH: otherTracker };
      const historyPath = path.join(context.pmPath, "history", "pm-extension-scope.jsonl");
      const before = await readFile(historyPath, "utf8");
      const refusedArgs = ["--pm-path", path.relative(context.tempRoot, context.pmPath), "item", "scoped-help", "--help", "--json"];
      const refusal = runDirectDistCli(refusedArgs, { env, cwd: context.tempRoot });
      expect(refusal.code, refusal.stderr).toBe(2);
      const recovery = (JSON.parse(refusal.stderr) as JsonErrorEnvelope).recovery!;
      expect(recovery.suggested_retry_args, refusal.stderr).toEqual(["--pm-path", context.pmPath, "recoveryprobe", "scoped-help", "--help"]);
      expect((JSON.parse(refusal.stderr) as JsonErrorEnvelope).examples?.[0]).toBe(recovery.suggested_retry);
      const sourceRefusal = await runInProcessDistCli(refusedArgs, { env, cwd: context.tempRoot }, runPmCli);
      expect(sourceRefusal.code, sourceRefusal.stderr).toBe(2);
      expect((JSON.parse(sourceRefusal.stderr) as JsonErrorEnvelope).recovery?.suggested_retry_args).toEqual(recovery.suggested_retry_args);
      const help = runDirectDistCli([...recovery.suggested_retry_args!, "--json"], { env, cwd: otherTracker });
      expect(help.code, help.stderr).toBe(0);
      expect(JSON.parse(help.stdout)).toMatchObject({ resolved_path: "recoveryprobe scoped-help" });
      const nestedArgs = ["--pm-path", context.pmPath, "recoveryprobe", "subgroup", "misplaced", "--help", "--json"];
      const nested = runDirectDistCli(nestedArgs, { env, cwd: context.tempRoot });
      expect(nested.code, nested.stderr).toBe(2);
      const nestedRetry = (JSON.parse(nested.stderr) as JsonErrorEnvelope).recovery?.suggested_retry_args;
      expect(nestedRetry, nested.stderr).toEqual(["--pm-path", context.pmPath, "subgroup", "misplaced", "--help"]);
      assert(nestedRetry, "Missing nested command recovery arguments");
      const sourceNested = await runInProcessDistCli(nestedArgs, { env, cwd: context.tempRoot }, runPmCli);
      expect(sourceNested.code, sourceNested.stderr).toBe(2);
      expect((JSON.parse(sourceNested.stderr) as JsonErrorEnvelope).recovery?.suggested_retry_args).toEqual(nestedRetry);
      const nestedHelp = runDirectDistCli([...nestedRetry, "--json"], { env, cwd: otherTracker });
      expect(nestedHelp.code, nestedHelp.stderr).toBe(0);
      expect(JSON.parse(nestedHelp.stdout)).toMatchObject({ resolved_path: "subgroup misplaced" });
      for (const [invocation, expectedRetry] of [
        [refusedArgs, recovery.suggested_retry_args!],
        [["--no-extensions", "--pm-path", context.pmPath, "item", "update", "--help", "--json"], ["--pm-path", context.pmPath, "--no-extensions", "update", "--help"]],
      ]) {
        for (const json of [true, false]) {
          const isolatedInvocation = await runInProcessDistCli(["stats"], { env, cwd: context.tempRoot }, async () => {
            await runPmCli(json ? invocation : invocation.filter((arg) => arg !== "--json"));
          });
          expect(isolatedInvocation.code, isolatedInvocation.stderr).toBe(2);
          if (json) expect((JSON.parse(isolatedInvocation.stderr) as JsonErrorEnvelope).recovery?.suggested_retry_args).toEqual(expectedRetry);
          else {
            expect(isolatedInvocation.stderr).toContain(context.pmPath);
            if (expectedRetry.includes("--no-extensions")) expect(isolatedInvocation.stderr).toContain("--no-extensions");
          }
        }
      }
      const unscoped = runDirectDistCli(["recoveryprobe", "scoped-help", "--help", "--json"], { env, cwd: context.tempRoot });
      expect(unscoped.code).toBe(2);
      const suppressed = runDirectDistCli(["--no-extensions", "--pm-path", context.pmPath, "item", "scoped-help", "--help"], { env, cwd: context.tempRoot });
      expect(suppressed.code).toBe(2);
      expect(suppressed.stderr).not.toContain("recoveryprobe scoped-help");
      expect(await readFile(historyPath, "utf8")).toBe(before);
    });
  });

  it("executes the advertised recovery through a real executable and preserves authoritative bytes", async () => {
    await withTempPmPath(async (context) => {
      expect(verifyInstalledAgentRecovery(process.execPath, [path.resolve("dist/cli.js")], {
        cwd: context.tempRoot, env: context.env,
      })).toEqual({ ok: true, namespace_refusals: 2, measurement_recovery: true, authoritative_bytes_preserved: true });
    });
    expect(() => verifyInstalledAgentRecovery(process.execPath, ["-e", "process.stdout.write('launcher notice')", "--"], {
      env: {},
    })).toThrow("Missing CLI JSON response");
  });

  it("recovers misplaced namespaces and measurement prerequisites without rewriting a nonempty tracker", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, "pm-recovery", "Keep this item and its provenance intact.");
      const historyPath = path.join(context.pmPath, "history", "pm-recovery.jsonl");
      const before = await readFile(historyPath, "utf8");
      for (const args of [
        ["item", "update", "--help"], ["item", "update", "pm-recovery", "--title", "Must not execute"],
        ["test", "pm-recovery", "--measure", "coverage=100", "--only-index", "1"],
      ]) {
        const refusal = await runInProcessDistCli(["--no-extensions", ...args, "--json"], { env: context.env }, runPmCli);
        expect(refusal.code, refusal.stderr).toBe(2);
        const envelope = JSON.parse(refusal.stderr) as JsonErrorEnvelope;
        expect(envelope).toMatchObject({ code: args[0] === "item" ? "unknown_command" : "test_measure_requires_run" });
        const retryArgs = envelope.recovery?.suggested_retry_args;
        expect(retryArgs).toBeDefined();
        expect(retryArgs).not.toContain("--force");
        expect(retryArgs).not.toContain("--allow-untrusted-linked-tests");
        if (args[0] === "item") {
          expect(retryArgs).toEqual(["--no-extensions", "update", "--help"]);
          expect(envelope.examples?.[0]).toBe("pm --no-extensions update --help");
          const help = await runInProcessDistCli([...retryArgs!, "--json"], { env: context.env }, runPmCli);
          expect(help.code).toBe(0);
          expect(JSON.parse(help.stdout)).toMatchObject({ resolved_path: "update" });
        } else {
          expect(retryArgs).toEqual(expect.arrayContaining(["--run", "--measure", "coverage=100", "--only-index", "1"]));
        }
        expect(await readFile(historyPath, "utf8")).toBe(before);
        expect(context.runCli(["get", "pm-recovery", "--json"], { expectJson: true }).json).toMatchObject({ item: { title: "pm-recovery" } });
      }
    });
  });

  it("attributes failed validation to its owner independently of valid argument order", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, "pm-attribution", "Persisted execution detail");
      const before = context.runCli(["get", "pm-attribution", "--full", "--json"], { expectJson: true }).json;
      for (const [args, surface, value] of [
        [["--priority", "high", "--risk", "invalid"], "--risk", "invalid"],
        [["--risk=invalid", "--title=x"], "--risk", "invalid"],
        [["--title", "x", "--deadline", "not-a-date"], "--deadline", "not-a-date"],
        [["--deadline=2026-02-30", "--priority", "high"], "--deadline", "2026-02-30"],
      ] as const) {
        const result = await runInProcessDistCli(["update", "pm-attribution", ...args, "--json"], { env: context.env }, runPmCli);
        expect(result.code, result.stderr).toBe(2);
        const error = JSON.parse(result.stderr) as JsonErrorEnvelope;
        expect(error.refusal).toMatchObject({ surface, rejected_value: value, exit_code: 2 });
        if (surface === "--risk") expect(error.refusal.legal_domain).toEqual(["low", "medium", "high", "critical"]);
      }
      const invalidDepth = await runInProcessDistCli(["get", "pm-attribution", "--depth=nonsense", "--json"], { env: context.env }, runPmCli);
      expect(invalidDepth.code).toBe(2);
      expect(JSON.parse(invalidDepth.stderr)).toMatchObject({ refusal: {
        surface: "--depth", rejected_value: "nonsense", legal_domain: ["brief", "standard", "deep", "full"],
      } });
      await expect(runGet("pm-attribution", { path: context.pmPath }, { depth: "nonsense" })).rejects.toMatchObject({
        exitCode: 2, context: { field: "depth", value: "nonsense", recovery: { allowed_values: ["brief", "standard", "deep", "full"] } },
      });
      for (const controls of [["--full", "--fields", "id"], ["--fields", "id", "--full"], ["--depth", "deep", "--full"]]) {
        const conflict = await runInProcessDistCli(["get", "pm-attribution", ...controls, "--json"], { env: context.env }, runPmCli);
        expect(conflict.code).toBe(2);
        const refusal = JSON.parse(conflict.stderr) as JsonErrorEnvelope;
        expect(refusal.refusal).toMatchObject({ surface: "--full" });
        expect(refusal.refusal).not.toHaveProperty("rejected_value");
      }
      const sdkConflict = await runGet("pm-attribution", { path: context.pmPath }, { full: true, fields: "id" }).catch((error: unknown) => error);
      expect(sdkConflict).toMatchObject({ context: { flag: "--full" } });
      expect(sdkConflict).not.toHaveProperty("context.value");
      for (const controls of [["--for", "orient", "--token-budget", "200"], ["--token-budget=200", "--for=orient"]]) {
        const budget = await runInProcessDistCli(["context", ...controls, "--json"], { env: context.env }, runPmCli);
        expect(budget.code).toBe(2);
        expect(JSON.parse(budget.stderr)).toMatchObject({ refusal: { surface: "--token-budget", rejected_value: "200" } });
      }
      expect(() => applyContextIntentProjection("context", { for: "orient", tokenBudget: 200 })).toThrowError(expect.objectContaining({
        exitCode: 2, context: expect.objectContaining({ field: "tokenBudget", value: "200" }),
      }));
      const missing = await runInProcessDistCli(["update", "missing", "--title", "x", "--json"], { env: context.env }, runPmCli);
      expect(missing.code).toBe(3);
      expect(JSON.parse(missing.stderr)).toMatchObject({ refusal: { surface: "id", rejected_value: "missing" } });
      expect(context.runCli(["get", "pm-attribution", "--full", "--json"], { expectJson: true }).json).toEqual(before);
    });
  });

  it("uses equivalent JSON selectors for lookup, validation and parser failures", async () => {
    await withTempPmPath(async (context) => {
      for (const selector of [["--json"], ["--output-format", "json"], ["--output-format=json"]]) {
        for (const args of [["get", "missing"], ["search", "fixture", "--limit", "bad"], ["get"], ["get", "missing", "--nonsense"]]) {
          for (const invocation of [[...selector, ...args], [...args, ...selector]]) {
            const result = await runInProcessDistCli(invocation, { env: context.env }, runPmCli);
            expect(result.code).not.toBe(0);
            expect(result.stdout).toBe("");
            expect(JSON.parse(result.stderr)).toMatchObject({ exit_code: result.code, code: expect.any(String), refusal: expect.any(Object) });
          }
        }
      }
      for (const selector of [["--json", "--output-format=toon"], ["--output-format=toon", "--json"]]) {
        const text = await runInProcessDistCli(["get", "missing", ...selector], { env: context.env }, runPmCli);
        expect(text.code).toBe(3);
        expect(text.stderr).toContain("What is required:");
        expect(text.stderr.trimStart()).not.toMatch(/^\{/u);
      }
      const before = context.runCli(["list", "--json"], { expectJson: true }).json as { items: unknown[]; count: number };
      await writeFile(path.join(context.tempRoot, "package.json"), JSON.stringify({
        devDependencies: { "@unbrained/pm-cli": "2099.1.1" },
      }));
      for (const [selector, json] of [
        [["--json"], true],
        [["--output-format", "json"], true],
        [["--output-format=json"], true],
        [["--json", "--output-format", "toon"], false],
        [["--output-format=toon", "--json"], false],
      ] as const) {
        for (const invocation of [[...selector, "create", "Refused mutation"], ["create", "Refused mutation", ...selector]]) {
          const early = runDirectDistCli(invocation, { env: context.env, cwd: context.tempRoot });
          expect(early.code, early.stderr).toBe(4);
          expect(early.stdout).toBe("");
          if (json) {
            expect(JSON.parse(early.stderr)).toMatchObject({ code: "project_runtime_stale_mutation", exit_code: 4 });
          } else {
            expect(early.stderr).toContain("cannot mutate a project pinned to newer pm");
            expect(early.stderr.trimStart()).not.toMatch(/^\{/u);
          }
        }
        if (json) {
          const args = ["get", "missing", ...selector];
          const failedRead = runDirectDistCli(args, { env: context.env, cwd: context.tempRoot });
          const instrumentedRead = await runInProcessDistCli(args, { env: context.env, cwd: context.tempRoot },
            (argv) => runRuntimeCompatibleCli({
              executingVersion: "2026.8.7", projectRoot: context.tempRoot, argv, allowStale: false,
              run: () => runPmCli(argv), writeError: (message) => { process.stderr.write(message); },
            }));
          const reads = [failedRead, instrumentedRead];
          expect(reads.map((result) => result.code)).toEqual([3, 3]);
          expect(reads.map((result) => result.stdout)).toEqual(["", ""]);
          expect(reads.map((result) => JSON.parse(result.stderr))).toMatchObject([
            { code: "item_not_found", exit_code: 3 }, { code: "item_not_found", exit_code: 3 },
          ]);
        }
      }
      expect(context.runCli(["list", "--json"], { expectJson: true }).json).toMatchObject({ items: before.items, count: before.count });
    });
  });

  it("executes each omission restore instruction while retaining the handoff intent", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, "pm-handoff", "Execution detail");
      const args = ["context", "--for", "handoff", "--json"];
      const initial = await runInProcessDistCli(args, { env: context.env }, runPmCli);
      expect(initial.code, initial.stderr).toBe(0);
      const result = JSON.parse(initial.stdout) as { omission_receipt: OutputOmissionReceipt };
      expect(result.omission_receipt.omitted_field_groups).not.toContainEqual(expect.objectContaining({ name: "workspace_memory" }));
      for (const group of result.omission_receipt.omitted_field_groups) {
        const restored = await runInProcessDistCli([...args, ...group.restore_with.split(" ")], { env: context.env }, runPmCli);
        expect(restored.code, restored.stderr).toBe(0);
        expect(JSON.parse(restored.stdout), group.name).toHaveProperty(group.name);
        expect(JSON.parse(restored.stdout)).toMatchObject({ context_intent: { intent: "handoff" } });
      }
      for (const intent of ["orient", "handoff"]) {
        for (const depth of ["standard", "deep", "full"]) {
          const expanded = await runInProcessDistCli(["context", "--for", intent, "--depth", depth, "--token-budget", "10000", "--json"], { env: context.env }, runPmCli);
          expect(expanded.code, expanded.stderr).toBe(0);
          expect(JSON.parse(expanded.stdout)).toHaveProperty("hierarchy");
          if (depth !== "standard") expect(JSON.parse(expanded.stdout)).toHaveProperty("files");
        }
      }
    });
  });

  it("rejects unsupported inherited context controls before recommending work", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, "pm-inherited", "Requested detail");
      for (const control of [["--fields", "id,title,description"], ["--fields", "notafield"], ["--depth", "deep"], ["--depth", "nonsense"], ["--section", "files"], ["--date", "2026-10-03"]]) {
        for (const args of [["context", "next", ...control], ["context", `${control[0]}=${control[1]}`, "next"], ["ctx", "next", ...control]]) {
          const result = await runInProcessDistCli([...args, "--json"], { env: context.env }, runPmCli);
          expect(result.code, args.join(" ")).toBe(2);
          expect(result.stdout).toBe("");
          expect(JSON.parse(result.stderr)).toMatchObject({ code: "unknown_option", refusal: { surface: control[0] } });
        }
      }
      const valid = await runInProcessDistCli(["context", "--tag", "absent", "next", "--json"], { env: context.env }, runPmCli);
      expect(valid.code, valid.stderr).toBe(0);
      expect(JSON.parse(valid.stdout)).toHaveProperty("recommended", null);
      const precedence = await runInProcessDistCli(["context", "--limit", "2", "next", "--limit", "1", "--json"], { env: context.env }, runPmCli);
      expect(precedence.code, precedence.stderr).toBe(0);
      expect(JSON.parse(precedence.stdout)).toMatchObject({ filters: { limit: 1 } });
    });
  });

  it("returns canonical compact start receipts for short IDs across CLI, MCP and SDK", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, "pm-composite", "Detailed context. ".repeat(1_000));
      const first = await runInProcessDistCli(["claim", "composite", "--start", "--json"], { env: context.env }, runPmCli);
      expect(first.code, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({ id: "pm-composite", status: "in_progress", changed_field_count: 3, claim: { id: "pm-composite" }, update: { id: "pm-composite" } });
      expect(first.stdout.length).toBeLessThan(650);
      const args = { path: context.pmPath, noExtensions: true, author: "test-author", action: "start_task", id: "composite" };
      const repeated = await runAction(args);
      expect(repeated).toMatchObject({ id: "pm-composite", status: "in_progress", changed_field_count: 0 });
      expect(repeated).not.toHaveProperty("claim.item");
      expect(repeated).not.toHaveProperty("update.item");
      const full = await new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "test-author" }).startTask("composite");
      expect(full).toMatchObject({ id: "pm-composite", claim: { item: { id: "pm-composite" } }, update: { item: { status: "in_progress" } } });
      const explicit = await runInProcessDistCli(["claim", "composite", "--start", "--full-changed-fields", "--json"], { env: context.env }, runPmCli);
      expect(explicit.code).toBe(0);
      expect(JSON.parse(explicit.stdout)).toMatchObject({ id: "pm-composite", claim: { item: { description: "Detailed context. ".repeat(1_000) } } });
    });
  });
});
