import { describe, expect, it } from "vitest";
import { runPmCli } from "../../../src/cli/main.js";
import type { JsonErrorEnvelope } from "../../../src/cli/error-guidance.js";
import { PmClient, runAction, runGet } from "../../../src/sdk/runtime.js";
import type { OutputOmissionReceipt } from "../../../src/sdk/output-projection.js";
import { createTaskFixture } from "../../helpers/createTaskFixture.js";
import { runInProcessDistCli } from "../../helpers/cliRunner.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("agent receipt and recovery contracts", () => {
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
      const full = await new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "test-author" }).startTask("composite");
      expect(full).toMatchObject({ id: "pm-composite", claim: { item: { id: "pm-composite" } }, update: { item: { status: "in_progress" } } });
      const explicit = await runInProcessDistCli(["claim", "composite", "--start", "--full-changed-fields", "--json"], { env: context.env }, runPmCli);
      expect(explicit.code).toBe(0);
      expect(JSON.parse(explicit.stdout)).toMatchObject({ id: "pm-composite", claim: { item: { description: "Detailed context. ".repeat(1_000) } } });
    });
  });
});
