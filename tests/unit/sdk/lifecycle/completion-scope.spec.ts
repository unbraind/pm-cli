import { spawnSync } from "node:child_process";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { quoteCommandArg } from "../../../../src/sdk/command-line.js";
import { distCliPath } from "../../../helpers/cliRunner.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("portable completion guidance (pm-gh1611)", () => {
  it("omits the implicit cwd tracker from SDK and CLI completion and evidence guidance", async () => {
    await withTempPmPath(async (context) => {
      const selectedPath = process.env.PM_PATH;
      delete process.env.PM_PATH;
      try {
        const client = new PmClient({ cwd: context.tempRoot });
        const { item } = await client.create({ type: "Task", title: "Default guidance", createMode: "progressive" });
        const closed = await client.close(item.id, "Finished", { validateClose: "warn" });
        expect(JSON.stringify([closed.completion, closed.follow_up])).not.toContain(context.tempRoot);
        expect(closed.completion?.hint).not.toContain("--pm-path");
        expect(closed.follow_up?.suggested_command_args).not.toContain("--pm-path");
        await expect(client.close(item.id, "Again")).rejects.toMatchObject({ context: { recovery: { suggested_retry_args: expect.not.arrayContaining(["--pm-path"]) } } });
        const { item: strict } = await client.create({ type: "Task", title: "Strict guidance", createMode: "progressive" });
        await expect(client.close(strict.id, "Finished", { validateClose: "strict" })).rejects.toMatchObject({ context: { recovery: { suggested_retry: expect.not.stringContaining(context.tempRoot) } } });
        const cli = spawnSync(process.execPath, [distCliPath(), "close", strict.id, "Finished", "--validate-close", "warn", "--json"], { cwd: context.tempRoot, env: { ...context.env, PM_PATH: "" }, encoding: "utf8" });
        expect(cli.status, cli.stderr).toBe(0);
        const result = JSON.parse(cli.stdout);
        expect(result.completion.hint).not.toContain("--pm-path");
        expect(result.follow_up.suggested_command).not.toContain(context.tempRoot);
        process.env.PM_PATH = context.pmPath;
        const same = await client.create({ type: "Task", title: "Matching environment", createMode: "progressive" });
        expect((await client.close(same.item.id, "Finished")).completion?.hint).not.toContain("--pm-path");
        const nested = path.join(context.tempRoot, "nested");
        expect(context.runCli(["init", "--pm-path", nested, "--json"]).code).toBe(0);
        const ancestor = new PmClient({ cwd: nested });
        const selected = await ancestor.create({ type: "Task", title: "Ancestor selection", createMode: "progressive" });
        const ancestorClose = await ancestor.close(selected.item.id, "Finished");
        expect(ancestorClose.completion?.hint).toContain(path.relative(nested, context.pmPath));
        expect(ancestorClose.completion?.hint).not.toContain(context.tempRoot);
      } finally {
        process.env.PM_PATH = selectedPath;
      }
    });
  });

  it("replays relative selected-tracker guidance without changing the ambient tracker", async () => {
    await withTempPmPath(async (selected) => {
      const owner = new PmClient({ pmRoot: selected.pmPath });
      const { item } = await owner.create({ type: "Task", title: "Selected", createMode: "progressive" });
      await withTempPmPath(async (ambient) => {
        const peer = new PmClient({ pmRoot: ambient.pmPath });
        await peer.create({ id: item.id, type: "Task", title: "Ambient", createMode: "progressive" });
        const historyPath = path.join(ambient.pmPath, "history", `${item.id}.jsonl`);
        const before = await readFile(historyPath, "utf8");
        const relative = path.relative(ambient.tempRoot, selected.pmPath);
        const client = new PmClient({ cwd: ambient.tempRoot, pmRoot: relative, noExtensions: true });
        const result = await client.close(item.id, "Finished", { validateClose: "warn" });
        expect(result.completion?.hint).toContain(relative);
        expect(result.completion?.hint).not.toContain(selected.tempRoot);
        expect(result.completion?.hint).toContain("--no-extensions");
        expect(result.follow_up?.suggested_command_args.slice(0, 3)).toEqual(["--pm-path", relative, "--no-extensions"]);
        const correction = result.completion!.hint!.match(/correct it with (pm .*)\.$/)![1]!.replace(/^pm /, "");
        const timestamp = "2026-10-01T10:00:00.000Z";
        const replay = spawnSync(`${quoteCommandArg(process.execPath)} ${quoteCommandArg(distCliPath())} ${correction.replace("<ISO>", timestamp)}`, { shell: true, cwd: ambient.tempRoot, env: ambient.env, encoding: "utf8" });
        expect(replay.status, replay.stderr).toBe(0);
        expect((await owner.get(item.id)).item.completed_at).toBe(timestamp);
        expect(await readFile(historyPath, "utf8")).toBe(before);
      });
    });
  });

  it("replays an environment-selected root-layout tracker at cwd without touching its nested peer", async () => {
    await withTempPmPath(async (context) => {
      await cp(context.pmPath, context.tempRoot, { recursive: true });
      const root = new PmClient({ cwd: context.tempRoot, pmRoot: context.tempRoot, noExtensions: true });
      const nested = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const { item } = await root.create({ type: "Task", title: "Root selection", createMode: "progressive" });
      await nested.create({ id: item.id, type: "Task", title: "Nested peer", createMode: "progressive" });
      await nested.close(item.id, "Peer finished");
      const historyPath = path.join(context.pmPath, "history", `${item.id}.jsonl`);
      const before = await readFile(historyPath, "utf8");
      const selectedPath = process.env.PM_PATH;
      process.env.PM_PATH = ".";
      try {
        const selected = new PmClient({ cwd: context.tempRoot, noExtensions: true });
        const result = await selected.close(item.id, "Root finished", { validateClose: "warn" });
        const correction = result.completion!.hint!.match(/correct it with (pm .*)\.$/)![1]!.replace(/^pm /, "");
        const timestamp = "2026-10-02T10:00:00.000Z";
        const replay = spawnSync(`${quoteCommandArg(process.execPath)} ${quoteCommandArg(distCliPath())} ${correction.replace("<ISO>", timestamp)}`, { shell: true, cwd: context.tempRoot, env: { ...context.env, PM_PATH: "" }, encoding: "utf8" });
        expect(replay.status, replay.stderr).toBe(0);
        expect((await root.get(item.id)).item.completed_at).toBe(timestamp);
        expect(await readFile(historyPath, "utf8")).toBe(before);
        expect(result.follow_up?.suggested_command_args.slice(0, 3)).toEqual(["--pm-path", ".", "--no-extensions"]);
      } finally {
        process.env.PM_PATH = selectedPath;
      }
    });
  });
});
