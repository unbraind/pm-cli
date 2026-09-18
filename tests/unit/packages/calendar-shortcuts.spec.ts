import { describe, expect, it } from "vitest";
import { runContracts } from "../../../src/sdk/cli-contracts/runtime-contracts.js";
import { runGet, type CreateResult } from "../../../src/sdk/index.js";
import { activateExtensionForTest, runRegisteredCommandForTest } from "../../../src/sdk/testing.js";
import calendar from "../../../packages/pm-calendar/extensions/calendar/index.ts";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("calendar package scheduling ownership", () => {
  it("declares all shortcut contracts and preserves SDK scheduling behavior", async () => {
    const activated = await activateExtensionForTest(calendar);
    expect(activated.registrations.commands.map((command) => command.command), JSON.stringify(activated.failed)).toEqual(
      expect.arrayContaining(["calendar", "cal", "meet", "event", "remind"]),
    );
    await withTempPmPath(async (context) => {
      for (const [command, type] of [["meet", "Meeting"], ["event", "Event"], ["remind", "Reminder"]]) {
        const result = await runRegisteredCommandForTest(activated.commands, {
          command, args: ["Default schedule"], pmRoot: context.pmPath,
          global: { path: context.pmPath },
        });
        expect(result.handled).toBe(true);
        const id = (result.result as CreateResult).item.id;
        const stored = await runGet(id, { path: context.pmPath }, { full: true });
        expect(stored.item.type).toBe(type);
        if (command === "remind") {
          expect(stored.item.reminders).toEqual([expect.objectContaining({ text: "Default schedule" })]);
        } else {
          const event = stored.item.events?.[0];
          expect(Date.parse(event!.end_at!) - Date.parse(event!.start_at)).toBe(3_600_000);
        }
      }
    });
  });

  it("configures canonical commands and legacy aliases only when installed", async () => {
    await withTempPmPath(async (context) => {
      const missing = context.runCli(["meet", "Planning", "--json"], { expectJson: true });
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("calendar");
      const bare = await runContracts({ action: "meet", runtimeOnly: true }, { path: context.pmPath });
      expect(bare.action_availability).toEqual([expect.objectContaining({
        action: "meet", invocable: true, cli_exposed: false,
      })]);
      const installed = context.runCli(["package", "install", "calendar", "--project", "--json"], { expectJson: true });
      expect(installed.code, installed.stderr + installed.stdout).toBe(0);
      const available = await runContracts({ command: "calendar meet", runtimeOnly: true }, { path: context.pmPath });
      expect(available.action_availability).toEqual([expect.objectContaining({
        action: "meet", invocable: true, cli_exposed: true,
      })]);
      expect(available.commands).toContain("calendar meet");
      for (const command of [["calendar", "meet"], ["meet"], ["calendar", "event"], ["event"]]) {
        const created = context.runCli([...command, "Planning", "--start", "2026-09-18T09:00:00Z", "--duration", "5min", "--json"], { expectJson: true });
        expect(created.code, created.stderr).toBe(0);
        const fetched = context.runCli(["get", String((created.json as { id: string }).id), "--depth", "full", "--json"], { expectJson: true });
        expect(fetched.json).toMatchObject({ item: { events: [{ end_at: "2026-09-18T09:05:00.000Z" }] } });
      }
      const reminder = context.runCli(["calendar", "remind", "Review", "--at", "+1d", "--json"], { expectJson: true });
      expect(reminder.code, reminder.stderr).toBe(0);
      const fetchedReminder = context.runCli(["get", String((reminder.json as { id: string }).id), "--depth", "full", "--json"], { expectJson: true });
      expect(fetchedReminder.json).toMatchObject({ item: { type: "Reminder", reminders: [{ text: "Review" }] } });
    });
  });
  it("persists every common option through canonical and legacy package handlers", async () => {
    await withTempPmPath(async (context) => {
      context.runCli(["package", "install", "calendar", "--project"]);
      const created = context.runCli([
        "calendar", "meet", "Planning", "--start", "2026-09-18T09:00:00Z",
        "--end", "2026-09-18T10:00:00Z", "--duration", "5m",
        "--location", "Room A, floor 3", "--timezone", "Europe/Vienna", "--all-day",
        "--parent", "pm-missing", "--allow-missing-parent", "--tags", "team,planning",
        "--priority", "1", "--body", "Agenda", "--description", "Sprint discussion",
        "--author", "calendar-test", "--message", "Schedule planning", "--json",
      ], { expectJson: true });
      expect(created.code, created.stderr).toBe(0);
      const id = (created.json as { id: string }).id;
      const fetched = context.runCli(["get", id, "--depth", "full", "--json"], { expectJson: true });
      expect(fetched.json).toMatchObject({ item: {
        parent: "pm-missing", priority: 1, body: "Agenda", description: "Sprint discussion",
        tags: expect.arrayContaining(["team", "planning"]), author: "calendar-test",
        events: [{ start_at: "2026-09-18T09:00:00.000Z", end_at: "2026-09-18T10:00:00.000Z",
          location: "Room A, floor 3", timezone: "Europe/Vienna", all_day: true }],
      } });
      const history = context.runCli(["history", id, "--full", "--json"], { expectJson: true });
      expect(history.stdout).toContain("Schedule planning");
      const rejected = context.runCli(["event", "Ambiguous", "--duration", "5m", "--json"], { expectJson: true });
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toMatch(/ambiguous.*min.*mo/);
      const reminder = context.runCli(["remind", "Follow up", "--text", 'Check "results", then close', "--json"], { expectJson: true });
      expect(reminder.code, reminder.stderr).toBe(0);
      const reminderItem = context.runCli(["get", (reminder.json as { id: string }).id, "--depth", "full", "--json"], { expectJson: true });
      expect(reminderItem.json).toMatchObject({ item: { reminders: [{ text: 'Check "results", then close' }] } });
      const listed = context.runCli(["list", "--json"], { expectJson: true });
      expect(listed.json).toMatchObject({ count: 2 });
    });
  });

});
