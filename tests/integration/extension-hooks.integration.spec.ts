import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("extension lifecycle hooks", () => {
  it("passes affected item transition context to afterCommand hooks", async () => {
    await withTempPmPath(async (context) => {
      const extensionDir = path.join(context.pmPath, "extensions", "hook-transition-ext");
      const hookLogPath = path.join(context.tempRoot, "hook-transition-events.log");
      await mkdir(extensionDir, { recursive: true });

      await writeFile(
        path.join(extensionDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "hook-transition-ext",
            version: "1.0.0",
            entry: "./index.mjs",
            capabilities: ["hooks"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await writeFile(
        path.join(extensionDir, "index.mjs"),
        [
          "import fs from 'node:fs';",
          "export default {",
          "  activate(api) {",
          String.raw`    api.hooks.afterCommand((event) => { fs.appendFileSync(${JSON.stringify(hookLogPath)}, JSON.stringify({ command: event.command, affected: event.affected }) + '\n', 'utf8'); });`,
          "  }",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const created = context.runCli(["create", "--title", "Transition source", "--type", "Task", "--status", "open", "--json"], {
        expectJson: true,
      });
      expect(created.code).toBe(0);
      const itemId = (created.json as { item: { id: string } }).item.id;

      const update = context.runCli(["update", itemId, "--status", "in_progress", "--json"], { expectJson: true });
      expect(update.code).toBe(0);
      const restore = context.runCli(["restore", itemId, "1", "--json"], { expectJson: true });
      expect(restore.code).toBe(0);
      const deleted = context.runCli(["delete", itemId, "--json"], { expectJson: true });
      expect(deleted.code).toBe(0);

      const hookEvents = (await readFile(hookLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { command: string; affected?: Array<Record<string, unknown>> });
      const createEvent = hookEvents.find((event) => event.command === "create");
      const updateEvent = hookEvents.find((event) => event.command === "update");
      const restoreEvent = hookEvents.find((event) => event.command === "restore");
      const deleteEvent = hookEvents.find((event) => event.command === "delete");
      expect(createEvent?.affected).toEqual([
        expect.objectContaining({
          id: itemId,
          op: "create",
          item_type: "Task",
          status: "open",
          changed_fields: expect.arrayContaining(["status", "title", "type"]),
          current: expect.objectContaining({ id: itemId, status: "open", type: "Task" }),
        }),
      ]);
      expect(updateEvent?.affected).toEqual([
        expect.objectContaining({
          id: itemId,
          op: "update",
          item_type: "Task",
          previous_status: "open",
          status: "in_progress",
          changed_fields: expect.arrayContaining(["status"]),
          previous: expect.objectContaining({ id: itemId, status: "open", type: "Task" }),
          current: expect.objectContaining({ id: itemId, status: "in_progress", type: "Task" }),
        }),
      ]);
      expect(restoreEvent?.affected).toEqual([
        expect.objectContaining({
          id: itemId,
          op: "restore",
          item_type: "Task",
          previous_status: "in_progress",
          status: "open",
          changed_fields: expect.arrayContaining(["status"]),
          previous: expect.objectContaining({ id: itemId, status: "in_progress", type: "Task" }),
          current: expect.objectContaining({ id: itemId, status: "open", type: "Task" }),
        }),
      ]);
      expect(deleteEvent?.affected).toEqual([
        expect.objectContaining({
          id: itemId,
          op: "delete",
          item_type: "Task",
          previous_status: "open",
          changed_fields: ["deleted"],
          previous: expect.objectContaining({ id: itemId, status: "open", title: "Transition source", type: "Task" }),
        }),
      ]);
    });
  });
});
