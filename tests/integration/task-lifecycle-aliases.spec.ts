import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { runPmCli } from "../../src/cli/main.js";
import { describe, expect, it } from "vitest";
import { runInProcessDistCli } from "../helpers/cliRunner.js";
import { createTestItemId } from "../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createTask(context: TempPmContext, title: string): string {
  return createTestItemId(context, {
    title,
    createMode: "progressive",
    tags: "lifecycle,alias",
  });
}

describe("task lifecycle aliases", () => {
  it("keeps lifecycle aliases out of core help while preserving direct help", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).not.toContain("start-task");
      expect(help.stdout).not.toContain("pause-task");
      expect(help.stdout).not.toContain("close-task");
      expect(context.runCli(["start-task", "--help"]).code).toBe(0);
      expect(context.runCli(["pause-task", "--help"]).code).toBe(0);
      expect(context.runCli(["close-task", "--help"]).code).toBe(0);
    });
  });

  it("shows migration hints only for enabled human alias invocations", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "lifecycle-hint-flow");
      const started = await runInProcessDistCli(["start-task", id], { env: context.env }, runPmCli);
      expect(started.code, started.stderr).toBe(0);
      expect(started.stderr).toContain("pm claim --start");
      const paused = await runInProcessDistCli(["pause-task", id, "--json"], { env: context.env }, runPmCli);
      expect(paused.code, paused.stderr).toBe(0);
      expect(paused.stderr).not.toContain("Deprecated command");
      const quiet = await runInProcessDistCli(["start-task", id, "--quiet"], { env: context.env }, runPmCli);
      expect(quiet.code, quiet.stderr).toBe(0);
      expect(quiet.stderr).not.toContain("Deprecated command");
      const settings = await readSettings(context.pmPath);
      settings.ux = { ...settings.ux, deprecation_hints: false };
      await writeSettings(context.pmPath, settings);
      const suppressed = await runInProcessDistCli(["pause-task", id], { env: context.env }, runPmCli);
      expect(suppressed.code, suppressed.stderr).toBe(0);
      expect(suppressed.stderr).not.toContain("Deprecated command");
    });
  });

  it.each([
    { name: "legacy", start: ["start-task"], pause: ["pause-task"], close: ["close-task"] },
    { name: "canonical", start: ["claim", "--start"], pause: ["release", "--pause"], close: ["close", "--release-assignment"] },
  ])("runs $name lifecycle flows", async ({ start, pause, close }) => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "lifecycle-alias-flow");

      const started = await runInProcessDistCli(
        [...start, id, "--json", "--author", "lifecycle-bot", "--message", "Start task via alias"],
        { expectJson: true, env: context.env },
        runPmCli,
      );
      expect(started.code).toBe(0);
      expect((started.json as { action?: string }).action).toBe("start_task");

      const afterStart = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(afterStart.code).toBe(0);
      expect((afterStart.json as { item?: { status?: string } }).item?.status).toBe("in_progress");
      expect((afterStart.json as { item?: { assignee?: string } }).item?.assignee).toBe("lifecycle-bot");

      const paused = await runInProcessDistCli(
        [...pause, id, "--json", "--author", "lifecycle-bot", "--message", "Pause task via alias"],
        { expectJson: true, env: context.env },
        runPmCli,
      );
      expect(paused.code).toBe(0);
      expect((paused.json as { action?: string }).action).toBe("pause_task");

      const afterPause = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(afterPause.code).toBe(0);
      expect((afterPause.json as { item?: { status?: string } }).item?.status).toBe("open");
      expect((afterPause.json as { item?: { assignee?: string } }).item?.assignee).toBeUndefined();

      const closed = await runInProcessDistCli(
        [...close, id, "Lifecycle complete", "--json", "--author", "lifecycle-bot", "--message", "Close via alias"],
        { expectJson: true, env: context.env },
        runPmCli,
      );
      expect(closed.code).toBe(0);
      expect((closed.json as { action?: string }).action).toBe("close_task");

      const afterClose = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(afterClose.code).toBe(0);
      expect((afterClose.json as { item?: { status?: string } }).item?.status).toBe("closed");
      expect((afterClose.json as { item?: { close_reason?: string } }).item?.close_reason).toBe("Lifecycle complete");
      expect((afterClose.json as { item?: { assignee?: string } }).item?.assignee).toBeUndefined();
    });
  });
});
