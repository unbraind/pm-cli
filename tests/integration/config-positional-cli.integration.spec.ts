import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { quoteCommandArg } from "../../src/core/shared/command-line.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { runConfig } from "../../src/sdk/config.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("config positional CLI parser", () => {
  it("writes dotted settings paths and recovers from unknown keys and strict close without mutation", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "--title", "Evidence probe", "--description", "Recovery fixture", "--type", "Task", "--create-mode", "progressive", "--json"], { expectJson: true });
      const id = (created.json as { item: { id: string } }).item.id;
      for (const key of ["governance.preset", "validation.metadata_profile"]) {
        const result = context.runCli(["config", "set", key, "strict", "--json"], { expectJson: true });
        expect(result.code, result.stderr).toBe(0);
      }
      for (const [key, value] of [["context.default_depth", "Deep"], ["context.activity_limit", "17"], ["context.stale_threshold_days", "7"], ["context.sections.activity", "false"]]) {
        const result = context.runCli(["config", "set", key, value, "--json"], { expectJson: true });
        expect(result.code, result.stderr).toBe(0);
      }
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = await readFile(settingsPath, "utf8");
      expect(JSON.parse(settings).context).toMatchObject({ default_depth: "deep", activity_limit: 17, stale_threshold_days: 7, sections: { activity: false } });
      for (const [key, value] of [["context.default_depth", "unknown"], ["context.activity_limit", "0"], ["context.activity_limit", "1e2"], ["context.stale_threshold_days", "0x10"], ["context.stale_threshold_days", "9007199254740992"]]) {
        expect(context.runCli(["config", "set", key, value]).code).toBe(2);
        expect(await readFile(settingsPath, "utf8")).toBe(settings);
      }
      const typo = context.runCli(["config", "set", "governance.presett", "strict"]);
      expect(typo.code).toBe(2);
      expect(typo.stderr).toContain("Did you mean governance-preset");
      expect(typo.stderr).toContain("allowed_values_omitted:");
      expect(typo.stderr.length).toBeLessThan(1800);
      expect(await readFile(settingsPath, "utf8")).toBe(settings);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const history = await readFile(historyPath, "utf8");
      const refused = context.runCli(["close", id, "done"]);
      expect(refused.code).toBe(2);
      expect(refused.stderr.split("\n")[0]).toBe("Error: Close is missing required evidence");
      expect(refused.stderr).toContain("--actual-result");
      expect(refused.stderr).not.toContain("pm enforces explicit, deterministic contracts");
      expect(await readFile(historyPath, "utf8")).toBe(history);
      const retry = refused.stderr.split("\n").find((line) => line.startsWith("Run: "))!.slice(5);
      expect(retry).toMatch(/^pm .*close /u);
      const evidence = "Verified evidence from displayed retry";
      const command = retry.replaceAll(/<[^>]+>/gu, evidence).replace(/^pm /u, `${quoteCommandArg(process.execPath)} ${quoteCommandArg(path.resolve("dist/cli.js"))} `);
      const closed = spawnSync(command, { shell: true, env: context.env, cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
      expect(closed.status, closed.stderr).toBe(0);
      const item = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(item.json).toMatchObject({ item: { status: "closed", resolution: evidence, expected_result: evidence, actual_result: evidence } });
    });
  });

  it("replays SDK configuration inventory in the selected tracker with an ambient negative control", async () => {
    await withTempPmPath(async (selected) => {
      expect(selected.runCli(["config", "set", "context.activity_limit", "11"]).code).toBe(0);
      await withTempPmPath(async (ambient) => {
        expect(ambient.runCli(["config", "set", "context.activity_limit", "22"]).code).toBe(0);
        let refusal: PmCliError | undefined;
        try {
          await runConfig("project", "get", "governance.presett", {}, { path: selected.pmPath, noExtensions: true, json: true, quiet: false, profile: false });
        } catch (error) {
          expect(error).toBeInstanceOf(PmCliError);
          refusal = error as PmCliError;
        }
        const retry = refusal?.context.recovery?.next_best_command;
        if (!retry) throw new Error("Expected SDK configuration refusal with an inventory recovery command");
        expect(retry).toContain("--pm-path");
        expect(retry).toContain("--no-extensions");
        const execute = (command: string) => {
          const qualified = command.replace(/^pm /u, `${quoteCommandArg(process.execPath)} ${quoteCommandArg(path.resolve("dist/cli.js"))} `);
          const result = spawnSync(qualified, { shell: true, env: ambient.env, cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
          expect(result.status, result.stderr).toBe(0);
          return JSON.parse(result.stdout) as { nested_settings: Array<{ path: string; value: unknown }> };
        };
        expect(execute(retry).nested_settings).toContainEqual(expect.objectContaining({ path: "context.activity_limit", value: 11 }));
        const unselected = retry.replace(`--pm-path ${quoteCommandArg(selected.pmPath)} `, "");
        expect(unselected).not.toBe(retry);
        expect(execute(unselected).nested_settings).toContainEqual(expect.objectContaining({ path: "context.activity_limit", value: 22 }));
      });
    });
  });

  it("accepts telemetry local-analytics as a backward-compatible subcommand namespace", async () => {
    await withTempPmPath(async (context) => {
      const status = context.runCli(["telemetry", "local-analytics", "status", "--json"], { expectJson: true });
      expect(status.code).toBe(0);
      expect(status.json).toMatchObject({
        action: "telemetry",
        subcommand: "status",
      });
    });
  });

  it("accepts config set values through the real CLI positional parser", async () => {
    await withTempPmPath(async (context) => {
      const telemetry = context.runCli(["config", "set", "telemetry.enabled", "off", "--json"], { expectJson: true });
      expect(telemetry.code).toBe(0);
      expect((telemetry.json as { policy?: string; changed?: boolean }).policy).toBe("disabled");
      expect((telemetry.json as { changed?: boolean }).changed).toBe(true);
      // GH-1660: the documented scope-less opt-out targets the global profile, where consent is read.
      expect((telemetry.json as { scope?: string }).scope).toBe("global");
      const status = context.runCli(["ops", "telemetry", "status", "--json"], { expectJson: true });
      expect((status.json as { status?: { configured_enabled?: boolean } }).status?.configured_enabled).toBe(false);

      const format = context.runCli(["config", "project", "set", "item-format", "toon", "--json"], { expectJson: true });
      expect(format.code).toBe(0);
      expect((format.json as { format?: string }).format).toBe("toon");

      const criterion = context.runCli(["config", "set", "definition-of-done", "Tests pass", "--json"], { expectJson: true });
      expect(criterion.code).toBe(0);
      expect((criterion.json as { criteria?: string[] }).criteria).toEqual(["Tests pass"]);
    });
  });
});
