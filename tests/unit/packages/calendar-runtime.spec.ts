import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdkRuntime from "../../../src/sdk/runtime.js";
import {
  _testOnly,
  renderCalendarPackageOutput,
  runCalendarPackage,
} from "../../../packages/pm-calendar/extensions/calendar/runtime.ts";

const calendarResult = {
  output_default: "markdown" as const,
  events: [],
  days: [],
} as never;

describe("calendar package static SDK runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates execution through the public runtime entrypoint", async () => {
    const resolve = vi
      .spyOn(sdkRuntime, "resolveCalendarOutputFormat")
      .mockReturnValue("markdown");
    const run = vi
      .spyOn(sdkRuntime, "runCalendar")
      .mockResolvedValue(calendarResult);
    await expect(
      runCalendarPackage({ view: "week" }, { path: "/tmp/pm" }),
    ).resolves.toBe(calendarResult);
    expect(resolve).toHaveBeenCalledWith({ view: "week" }, { path: "/tmp/pm" });
    expect(run).toHaveBeenCalledWith({ view: "week" }, { path: "/tmp/pm" });
  });

  it("covers payload guards and every output format", () => {
    expect(_testOnly.readPayloadFormat(null)).toBe("toon");
    expect(_testOnly.readPayloadFormat({ format: "json" })).toBe("json");
    expect(_testOnly.readPayloadResult("raw")).toBe("raw");
    expect(_testOnly.readPayloadResult({ result: calendarResult })).toBe(
      calendarResult,
    );
    expect(_testOnly.readPayloadCommandOptions([])).toEqual({});
    expect(
      _testOnly.readPayloadCommandOptions({ command_options: [] }),
    ).toEqual({});
    expect(
      _testOnly.readPayloadCommandOptions({ command_options: { view: "day" } }),
    ).toEqual({ view: "day" });
    expect(_testOnly.readPayloadGlobalOptions([])).toEqual({});
    expect(_testOnly.readPayloadGlobalOptions({ global: [] })).toEqual({});
    expect(
      _testOnly.readPayloadGlobalOptions({ global: { path: "/tmp/pm" } }),
    ).toEqual({ path: "/tmp/pm" });

    expect(renderCalendarPackageOutput({ payload: null } as never)).toBeNull();
    expect(
      renderCalendarPackageOutput({
        payload: { output_default: "markdown", events: {}, days: [] },
      } as never),
    ).toBeNull();

    const resolve = vi.spyOn(sdkRuntime, "resolveCalendarOutputFormat");
    vi.spyOn(sdkRuntime, "renderCalendarMarkdown").mockReturnValue(
      "# calendar",
    );
    const toon = vi.spyOn(sdkRuntime, "renderCalendarToon");
    resolve.mockReturnValueOnce("markdown");
    expect(
      renderCalendarPackageOutput({ payload: calendarResult } as never),
    ).toBe("# calendar\n");

    resolve.mockReturnValueOnce("json");
    expect(
      renderCalendarPackageOutput({ payload: calendarResult } as never),
    ).toBe(`${JSON.stringify(calendarResult, null, 2)}\n`);

    resolve.mockReturnValueOnce("markdown");
    expect(
      renderCalendarPackageOutput({
        payload: { format: "json", result: calendarResult },
        options: { format: "json" },
      } as never),
    ).toBe("# calendar\n");

    resolve.mockReturnValueOnce("toon");
    toon.mockReturnValueOnce("toon");
    expect(
      renderCalendarPackageOutput({
        payload: {
          result: calendarResult,
          command_options: { format: "toon" },
          global: { path: "/tmp/pm" },
        },
      } as never),
    ).toBe("toon\n");

    resolve.mockReturnValueOnce("toon");
    toon.mockReturnValueOnce("toon\n");
    expect(
      renderCalendarPackageOutput({
        payload: calendarResult,
        global: {},
      } as never),
    ).toBe("toon\n");

    resolve.mockReturnValueOnce("invalid" as never);
    expect(
      renderCalendarPackageOutput({ payload: calendarResult } as never),
    ).toBeNull();
  });
});
