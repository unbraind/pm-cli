import { describe, expect, it } from "vitest";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createTask(context: TempPmContext, title: string): string {
  const created = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--create-mode",
      "progressive",
      "--message",
      `Create ${title}`,
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  const payload = created.json as { item?: { id?: string } };
  expect(typeof payload.item?.id).toBe("string");
  return payload.item?.id ?? "";
}

describe("task lifecycle aliases", () => {
  it("exposes lifecycle aliases in top-level help", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("start-task");
      expect(help.stdout).toContain("pause-task");
      expect(help.stdout).toContain("close-task");
    });
  });

  it("runs start-task, pause-task, and close-task lifecycle flows", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "lifecycle-alias-flow");

      const started = context.runCli(
        ["start-task", id, "--json", "--author", "lifecycle-bot", "--message", "Start task via alias"],
        { expectJson: true },
      );
      expect(started.code).toBe(0);
      expect((started.json as { action?: string }).action).toBe("start_task");

      const afterStart = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(afterStart.code).toBe(0);
      expect((afterStart.json as { item?: { status?: string } }).item?.status).toBe("in_progress");
      expect((afterStart.json as { item?: { assignee?: string } }).item?.assignee).toBe("lifecycle-bot");

      const paused = context.runCli(
        ["pause-task", id, "--json", "--author", "lifecycle-bot", "--message", "Pause task via alias"],
        { expectJson: true },
      );
      expect(paused.code).toBe(0);
      expect((paused.json as { action?: string }).action).toBe("pause_task");

      const afterPause = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(afterPause.code).toBe(0);
      expect((afterPause.json as { item?: { status?: string } }).item?.status).toBe("open");
      expect((afterPause.json as { item?: { assignee?: string } }).item?.assignee).toBeUndefined();

      const closed = context.runCli(
        ["close-task", id, "Lifecycle complete", "--json", "--author", "lifecycle-bot", "--message", "Close via alias"],
        { expectJson: true },
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
