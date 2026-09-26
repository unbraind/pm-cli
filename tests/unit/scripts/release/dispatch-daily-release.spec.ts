/** Prove timing, duplicate refusal and ambiguous-request safety without live mutations. */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchDailyRelease, main } from "../../../../scripts/release/dispatch-daily-release.mjs";

const transport = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: transport }));
let root: string;
let stateDirectory: string;
const now = new Date("2026-09-27T02:45:00Z");

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pm-morning-dispatch-"));
  stateDirectory = path.join(root, "state");
  transport.mockImplementation((_cmd: string, args: string[]) => args[1]?.includes("/runs?")
    ? '[{"total_count":0,"workflow_runs":[]}]' : "[]");
});
afterEach(() => { transport.mockReset(); rmSync(root, { recursive: true, force: true }); });

describe("independent morning release dispatch", () => {
  it.each(["2026-09-27T02:45:00Z", "2026-12-01T03:45:00Z", "2026-03-29T02:45:00Z", "2026-10-25T03:45:00Z"])("uses Vienna wall time across seasons and DST: %s", (instant) => {
    const report = dispatchDailyRelease({ stateDirectory, now: new Date(instant) });
    expect(report).toMatchObject({ outcome: "dispatch_accepted", local_time: "04:45" });
    expect(transport).toHaveBeenLastCalledWith("gh", ["workflow", "run", "auto-release.yml", "--repo", "unbraind/pm-cli", "--ref", "main", "-f", "push=true", "-f", "dry_run=false", "-f", "telemetry_mode=off"], expect.any(Object));
    expect(dispatchDailyRelease({ stateDirectory, now: new Date(instant) }).outcome).toBe("dispatch_already_attempted");
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it.each(["2026-09-27T02:44:00Z", "2026-09-27T03:16:00Z", "2026-09-27T12:00:00Z"])("refuses early or late catch-up without contacting GitHub: %s", (instant) => {
    expect(dispatchDailyRelease({ stateDirectory, now: new Date(instant) }).outcome).toBe("outside_morning_window");
    expect(transport).not.toHaveBeenCalled();
  });

  it("checks live prerequisites without creating state or dispatching", () => {
    expect(dispatchDailyRelease({ stateDirectory, now, check: true }).outcome).toBe("would_dispatch");
    expect(existsSync(stateDirectory)).toBe(false);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("uses exact UTC-day tags and does not mistake tag existence for publication", () => {
    transport.mockReturnValueOnce('[{"ref":"refs/tags/v2026.9.27"}]');
    expect(dispatchDailyRelease({ stateDirectory, now }).outcome).toBe("existing_tag_requires_publication_verification");
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockReturnValueOnce('[{"ref":"refs/tags/v2026.9.270"}]');
    expect(dispatchDailyRelease({ stateDirectory, now }).outcome).toBe("dispatch_accepted");
  });

  it.each(["queued", "in_progress", "waiting", "pending", "requested"])("defers to an existing %s release run", (status) => {
    transport.mockReturnValueOnce("[]").mockReturnValueOnce(JSON.stringify([{ total_count: 1, workflow_runs: [{ id: 42, status }] }]));
    expect(dispatchDailyRelease({ stateDirectory, now }).outcome).toBe("active_release_workflow");
    expect(existsSync(stateDirectory)).toBe(false);
  });

  it.each(["[]", "{}", '[{"total_count":2,"workflow_runs":[]}]', '[{"total_count":2,"workflow_runs":[{"id":1},{"id":1}]}]'])("refuses incomplete workflow evidence: %s", (raw) => {
    transport.mockReturnValueOnce("[]").mockReturnValueOnce(raw);
    expect(() => dispatchDailyRelease({ stateDirectory, now })).toThrow("census");
    expect(existsSync(stateDirectory)).toBe(false);
  });

  it("accepts complete pagination and keeps failed prior runs visible without blocking a fresh attempt", () => {
    transport.mockReturnValueOnce("[]").mockReturnValueOnce(JSON.stringify([
      { total_count: 2, workflow_runs: [{ id: 1, status: "completed", conclusion: "failure" }] },
      { total_count: 2, workflow_runs: [{ id: 2, status: "completed", conclusion: "success" }] },
    ]));
    expect(dispatchDailyRelease({ stateDirectory, now }).outcome).toBe("dispatch_accepted");
  });

  it("retains intent after an ambiguous POST failure and never retries that day", () => {
    transport.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "workflow") throw new Error("sensitive transport details");
      return args[1]?.includes("/runs?") ? '[{"total_count":0,"workflow_runs":[]}]' : "[]";
    });
    expect(() => dispatchDailyRelease({ stateDirectory, now })).toThrow("GitHub request failed");
    expect(JSON.parse(readFileSync(path.join(stateDirectory, "2026-09-27.json"), "utf8")).outcome).toBe("dispatch_attempted");
    expect(dispatchDailyRelease({ stateDirectory, now }).outcome).toBe("dispatch_already_attempted");
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("fails read errors before intent and rejects unsafe operator arguments", () => {
    transport.mockImplementation(() => { throw new Error("offline"); });
    expect(() => dispatchDailyRelease({ stateDirectory, now })).toThrow("GitHub request failed");
    expect(existsSync(stateDirectory)).toBe(false);
    expect(() => main(["--state-dir", "relative"])).toThrow("absolute");
    for (const args of [[], ["--typo", stateDirectory], ["--state-dir", stateDirectory, "--force"]]) {
      expect(() => main(args)).toThrow("Usage");
    }
  });
});
