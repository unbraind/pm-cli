import { decode as decodeToon } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import {
  renderCalendarMarkdown,
  renderCalendarToon,
  runCalendar,
  type CalendarResult,
} from "../../src/cli/commands/calendar.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

function createCalendarSeed(context: Parameters<Parameters<typeof withTempPmPath>[0]>[0]): void {
  const result = context.runCli(
    [
      "create",
      "--json",
      "--title",
      "Calendar TOON seed",
      "--description",
      "Calendar TOON seed description",
      "--type",
      "Task",
      "--create-mode",
      "progressive",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "calendar,toon",
      "--body",
      "",
      "--estimate",
      "10",
      "--acceptance-criteria",
      "calendar toon seed",
      "--author",
      "calendar-toon-test",
      "--message",
      "Create calendar TOON seed",
      "--deadline",
      "2026-04-02T12:00:00.000Z",
      "--reminder",
      "at=2026-04-02T09:30:00.000Z,text=calendar toon reminder",
    ],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
}

describe("calendar TOON renderer", () => {
  it("renders the calendar result as TOON that round-trips through @toon-format/toon", async () => {
    await withTempPmPath(async (context) => {
      createCalendarSeed(context);

      const result: CalendarResult = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-02T00:00:00.000Z",
          to: "2026-04-03T00:00:00.000Z",
        },
        { path: context.pmPath },
      );

      const toonOutput = renderCalendarToon(result);
      expect(typeof toonOutput).toBe("string");
      expect(toonOutput.length).toBeGreaterThan(0);

      // Strict decoder must accept what the renderer emits.
      const decoded = decodeToon(toonOutput) as Record<string, unknown>;
      expect(decoded).toBeTruthy();
      expect(typeof decoded).toBe("object");
      expect(decoded.view).toBe("agenda");
      expect(decoded.now).toBe(result.now);
      expect(Array.isArray(decoded.events)).toBe(true);
      expect((decoded.events as unknown[]).length).toBe(result.events.length);

      // Both renderers must reference the same set of event-bearing item ids so we
      // never emit a calendar view that silently drops events when the user picks
      // --format toon over the markdown default.
      const markdown = renderCalendarMarkdown(result);
      for (const event of result.events) {
        expect(toonOutput).toContain(event.item_id);
        expect(markdown).toContain(event.item_id);
      }
    });
  });

  it("emits TOON via the CLI when --format toon is passed (no markdown fallback)", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["install", "calendar", "--project", "--json"], { expectJson: true });
      expect(install.code).toBe(0);

      createCalendarSeed(context);

      const cli = context.runCli([
        "calendar",
        "--view",
        "agenda",
        "--date",
        "2026-04-02T00:00:00.000Z",
        "--format",
        "toon",
        "--limit",
        "10",
      ]);
      expect(cli.code).toBe(0);
      // Markdown output starts with a `# pm calendar (...)` H1; TOON must not.
      expect(cli.stdout.startsWith("# pm calendar")).toBe(false);
      // TOON output is strictly decodable.
      const decoded = decodeToon(cli.stdout) as Record<string, unknown>;
      expect(decoded.view).toBe("agenda");
      expect(Array.isArray(decoded.events)).toBe(true);
    });
  });
});
