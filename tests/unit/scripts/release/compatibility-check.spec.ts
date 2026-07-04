import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type * as ReleaseUtils from "../../../../scripts/release/utils.mjs";
import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../../helpers/scriptModule";

const UTILS_SPECIFIER = "../../../../scripts/release/utils.mjs";

const harness = createScriptHarness([UTILS_SPECIFIER]);

interface SeedState {
  taskId: string;
  issueId: string;
  itemCount: number;
  comments: string[];
  notes: string[];
  learnings: string[];
  tests: Array<{ command: string }>;
}

type RunCommandResult = { status: number; stdout: string; stderr: string };
type RunCommandOptions = { env?: Record<string, string>; capture?: boolean };
type LegacyCommandHandler = (pmArgs: string[], env: Record<string, string>, state: SeedState) => RunCommandResult;
type CurrentPayloadHandler = (pmArgs: string[], state: SeedState) => object;

interface ScenarioOverrides {
  npmViewVersion?: string;
  npmViewEmpty?: boolean;
  /** Override the dist/cli.js command handler; return null to fall through to defaults. */
  currentOverride?: (cmd: string, id: string | undefined, pmArgs: string[], state: SeedState) => RunCommandResult | null;
  /** Override the npx legacy command handler; return null to fall through to defaults. */
  legacyOverride?: (cmd: string, pmArgs: string[], state: SeedState) => RunCommandResult | null;
  /** Skip writing the toon file during the migration update so the migration guard fails. */
  skipToonMigration?: boolean;
  /** Leave the markdown file in place after migration so the persistence guard fails. */
  keepMarkdown?: boolean;
}

function jsonResult(payload: unknown): RunCommandResult {
  return {
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  };
}

const NPM_VIEW_COMMANDS = new Set(["npm", "npm.cmd"]);
const NPX_COMMANDS = new Set(["npx", "npx.cmd"]);

function handleNpmViewCommand(command: string, cmdArgs: string[], overrides: ScenarioOverrides): RunCommandResult | null {
  if (!NPM_VIEW_COMMANDS.has(command) || cmdArgs[0] !== "view") {
    return null;
  }
  const stdout = overrides.npmViewEmpty ? "\n" : `${overrides.npmViewVersion ?? "2026.6.14"}\n`;
  return { status: 0, stdout, stderr: "" };
}

function legacyNpxPmArgs(command: string, cmdArgs: string[]): string[] | null {
  if (!NPX_COMMANDS.has(command) || !cmdArgs.includes("pm")) {
    return null;
  }
  return cmdArgs.slice(cmdArgs.indexOf("pm") + 1).filter((entry) => entry !== "--json");
}

const LEGACY_PM_COMMAND_HANDLERS: Record<string, LegacyCommandHandler> = {
  init(_pmArgs, env) {
    mkdirSync(path.join(env.PM_PATH ?? "", "tasks"), { recursive: true });
    return jsonResult({ ok: true });
  },
  create(pmArgs, _env, state) {
    const type = pmArgs[pmArgs.indexOf("--type") + 1];
    return jsonResult({ item: { id: type === "Issue" ? state.issueId : state.taskId } });
  },
  "list-all"(_pmArgs, _env, state) {
    return jsonResult({ count: state.itemCount });
  },
  get(_pmArgs, _env, state) {
    return jsonResult({ item: { id: state.taskId }, body: "legacy seeded body" });
  },
};

function defaultLegacyPmCommand(): RunCommandResult {
  return jsonResult({ ok: true });
}

function runLegacyPmCommand(pmArgs: string[], env: Record<string, string>, state: SeedState, overrides: ScenarioOverrides): RunCommandResult {
  const cmd = pmArgs[0];
  const legacyOverride = overrides.legacyOverride?.(cmd, pmArgs, state);
  if (legacyOverride) {
    return legacyOverride;
  }
  const handler = LEGACY_PM_COMMAND_HANDLERS[cmd ?? ""];
  if (handler) {
    return handler(pmArgs, env, state);
  }
  return defaultLegacyPmCommand();
}

function isCurrentDistCommand(command: string, cmdArgs: string[]): boolean {
  return command === process.execPath && Boolean(cmdArgs[0]?.endsWith(path.join("dist", "cli.js")));
}

function runCurrentUpdateCommand(pmArgs: string[], env: Record<string, string>, state: SeedState, overrides: ScenarioOverrides): RunCommandResult {
  const tasksDir = path.join(env.PM_PATH ?? "", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  if (!overrides.skipToonMigration) {
    writeFileSync(path.join(tasksDir, `${state.taskId}.toon`), "migrated toon entry\n", "utf8");
  }
  if (!overrides.keepMarkdown) {
    rmSync(path.join(tasksDir, `${state.taskId}.md`), { force: true });
  }
  void pmArgs;
  return jsonResult({ ok: true });
}

const CURRENT_PAYLOAD_HANDLERS: Record<string, CurrentPayloadHandler> = {
  comments(pmArgs, state) {
    if (pmArgs.includes("--add")) {
      state.comments.push("post migration comment");
      return { ok: true };
    }
    return { comments: state.comments };
  },
  notes(_pmArgs, state) {
    return { notes: state.notes };
  },
  learnings(_pmArgs, state) {
    return { learnings: state.learnings };
  },
  test(pmArgs, state) {
    return pmArgs.includes("--run") ? { ok: true } : { tests: state.tests };
  },
  health() {
    return { checks: [{ name: "storage", status: "ok" }] };
  },
  "list-all"(_pmArgs, state) {
    return { count: state.itemCount };
  },
};

function currentCommandPayload(cmd: string | undefined, pmArgs: string[], state: SeedState): object {
  const handler = CURRENT_PAYLOAD_HANDLERS[cmd ?? ""];
  if (handler) {
    return handler(pmArgs, state);
  }
  return { ok: true };
}

function runCurrentPmCommand(pmArgs: string[], env: Record<string, string>, state: SeedState, overrides: ScenarioOverrides): RunCommandResult {
  const cmd = pmArgs[0];
  const id = pmArgs[1];
  const override = overrides.currentOverride?.(cmd, id, pmArgs, state);
  if (override) {
    return override;
  }
  if (cmd === "update" && id === state.taskId) {
    return runCurrentUpdateCommand(pmArgs, env, state, overrides);
  }
  return jsonResult(currentCommandPayload(cmd, pmArgs, state));
}

function runMockedCommand(command: string, cmdArgs: string[], env: Record<string, string>, state: SeedState, overrides: ScenarioOverrides): RunCommandResult {
  const npmView = handleNpmViewCommand(command, cmdArgs, overrides);
  if (npmView) {
    return npmView;
  }

  const legacyArgs = legacyNpxPmArgs(command, cmdArgs);
  if (legacyArgs) {
    return runLegacyPmCommand(legacyArgs, env, state, overrides);
  }

  if (isCurrentDistCommand(command, cmdArgs)) {
    const pmArgs = cmdArgs.slice(1).filter((entry) => entry !== "--json");
    return runCurrentPmCommand(pmArgs, env, state, overrides);
  }

  return { status: 0, stdout: "", stderr: "" };
}

function createRunCommandMock(state: SeedState, overrides: ScenarioOverrides) {
  return vi.fn((command: string, cmdArgs: string[], options?: RunCommandOptions) =>
    runMockedCommand(command, cmdArgs, options?.env ?? {}, state, overrides),
  );
}

async function runCompatibilityScenario(args: string[], overrides: ScenarioOverrides = {}) {
  const state: SeedState = {
    taskId: "pm-compat-task",
    issueId: "pm-compat-issue",
    itemCount: 2,
    comments: ["legacy comment"],
    notes: ["legacy note"],
    learnings: ["legacy learning"],
    tests: [{ command: "node --version" }],
  };

  const runCommand = createRunCommandMock(state, overrides);

  vi.doMock(UTILS_SPECIFIER, async () => {
    const actual = await vi.importActual<typeof ReleaseUtils>(UTILS_SPECIFIER);
    return {
      ...actual,
      runCommand,
      commandFor(binary: string) {
        return binary;
      },
      fail(message: string, exitCode = 1) {
        throw new Error(`FAIL:${exitCode}:${message}`);
      },
    };
  });

  process.argv = ["node", "scripts/release/compatibility-check.mjs", ...args];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    logs.push(String(value ?? ""));
  });

  let failure: unknown = null;
  try {
    await harness.importModuleStable("scripts/release/compatibility-check.mjs");
  } catch (error) {
    failure = error;
  }

  return { failure, stdoutSpy, logs, runCommand, state };
}

describe("scripts/release/compatibility-check", () => {
  it("prints usage for --help and runs nothing", async () => {
    const { logs, runCommand } = await runCompatibilityScenario(["--help"]);
    expect(logs.join("\n")).toContain("scripts/release/compatibility-check.mjs");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("emits a JSON summary on the legacy-seed migration success path", async () => {
    const { stdoutSpy, runCommand } = await runCompatibilityScenario(["--json"]);
    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      item_count_before: number;
      item_count_after: number;
      validation_ok: boolean;
      health_ok: boolean;
    };
    expect(payload.ok).toBe(true);
    expect(payload.item_count_before).toBe(2);
    expect(payload.item_count_after).toBe(2);
    expect(payload.validation_ok).toBe(true);
    expect(payload.health_ok).toBe(true);
    expect(runCommand).toHaveBeenCalled();
  });

  it("prints a text summary when --json is omitted", async () => {
    const { logs } = await runCompatibilityScenario([]);
    expect(logs.join("\n")).toContain("Compatibility gate passed:");
  });

  it("resolves the published version from npm when --base-version is absent", async () => {
    const { stdoutSpy } = await runCompatibilityScenario(["--json"], { npmViewVersion: "2026.5.31" });
    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as { base_version: string };
    expect(payload.base_version).toBe("2026.5.31");
  });

  it("uses an explicit --base-version without querying npm", async () => {
    const { stdoutSpy, runCommand } = await runCompatibilityScenario(["--json", "--base-version", "2026.1.1"]);
    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as { base_version: string };
    expect(payload.base_version).toBe("2026.1.1");
    expect(
      runCommand.mock.calls.some((call) => call[0] === "npm" && (call[1] as string[])[0] === "view"),
    ).toBe(false);
  });

  it("fails when npm view returns an empty version", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], { npmViewEmpty: true });
    expect(String(failure ?? "")).toContain("Failed to resolve latest published");
  });

  it("retains the temp directory with --keep-temp", async () => {
    const { stdoutSpy } = await runCompatibilityScenario(["--json", "--keep-temp"]);
    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as { keep_temp: boolean };
    expect(payload.keep_temp).toBe(true);
  });

  it("fails when legacy comments do not survive the current read path", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      currentOverride: (cmd, _id, pmArgs) =>
        cmd === "comments" && !pmArgs.includes("--add")
          ? { status: 0, stdout: JSON.stringify({ comments: [] }), stderr: "" }
          : null,
    });
    expect(String(failure ?? "")).toContain("expected legacy comments to survive");
  });

  it("fails when legacy notes do not survive the current read path", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      currentOverride: (cmd) =>
        cmd === "notes" ? { status: 0, stdout: JSON.stringify({ notes: [] }), stderr: "" } : null,
    });
    expect(String(failure ?? "")).toContain("expected legacy notes to survive");
  });

  it("fails when legacy learnings do not survive the current read path", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      currentOverride: (cmd) =>
        cmd === "learnings" ? { status: 0, stdout: JSON.stringify({ learnings: [] }), stderr: "" } : null,
    });
    expect(String(failure ?? "")).toContain("expected legacy learnings to survive");
  });

  it("fails when legacy linked tests do not survive the current read path", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      currentOverride: (cmd, _id, pmArgs) =>
        cmd === "test" && !pmArgs.includes("--run")
          ? { status: 0, stdout: JSON.stringify({ tests: [] }), stderr: "" }
          : null,
    });
    expect(String(failure ?? "")).toContain("expected legacy linked tests to survive");
  });

  it("fails when the mixed-frontmatter item does not migrate to TOON", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], { skipToonMigration: true });
    expect(String(failure ?? "")).toContain("did not migrate to TOON");
  });

  it("fails when the markdown variant persists after TOON migration", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], { keepMarkdown: true });
    expect(String(failure ?? "")).toContain("markdown item variant persisted");
  });

  it("fails when validate returns ok=false", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      currentOverride: (cmd) =>
        cmd === "validate" ? { status: 0, stdout: JSON.stringify({ ok: false }), stderr: "" } : null,
    });
    expect(String(failure ?? "")).toContain("returned ok=false");
  });

  it("fails when health reports a blocking check", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      currentOverride: (cmd) =>
        cmd === "health"
          ? { status: 0, stdout: JSON.stringify({ checks: [{ name: "storage", status: "error" }] }), stderr: "" }
          : null,
    });
    expect(String(failure ?? "")).toContain("reported blocking checks");
  });

  it("fails when the item count drifts after the current build mutations", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      currentOverride: (cmd) =>
        cmd === "list-all" ? { status: 0, stdout: JSON.stringify({ count: 99 }), stderr: "" } : null,
    });
    expect(String(failure ?? "")).toContain("item count drift detected");
  });

  it("fails when a legacy command emits non-JSON output (parseJson catch)", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      currentOverride: (cmd) =>
        cmd === "validate" ? { status: 0, stdout: "<<<not json>>>", stderr: "" } : null,
    });
    expect(String(failure ?? "")).toContain("Failed to parse JSON output for");
  });

  it("fails when a current command emits empty output (parseJson empty guard)", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      currentOverride: (cmd, _id, pmArgs) =>
        cmd === "comments" && !pmArgs.includes("--add")
          ? { status: 0, stdout: "   \n", stderr: "" }
          : null,
    });
    expect(String(failure ?? "")).toContain("received empty output");
  });

  it("fails when the legacy create omits the task id", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      legacyOverride: (cmd, pmArgs) => {
        if (cmd === "create" && pmArgs[pmArgs.indexOf("--type") + 1] === "Task") {
          return { status: 0, stdout: JSON.stringify({ item: {} }), stderr: "" };
        }
        return null;
      },
    });
    expect(String(failure ?? "")).toContain("did not return a valid task id");
  });

  it("fails when the legacy create omits the issue id", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      legacyOverride: (cmd, pmArgs) => {
        if (cmd === "create" && pmArgs[pmArgs.indexOf("--type") + 1] === "Issue") {
          return { status: 0, stdout: JSON.stringify({ item: {} }), stderr: "" };
        }
        return null;
      },
    });
    expect(String(failure ?? "")).toContain("did not return a valid issue id");
  });

  it("writes an empty body when the legacy task snapshot body is not a string", async () => {
    const { stdoutSpy } = await runCompatibilityScenario(["--json"], {
      legacyOverride: (cmd, pmArgs) =>
        cmd === "get" && pmArgs.includes("--depth")
          ? { status: 0, stdout: JSON.stringify({ item: { id: "pm-compat-task" }, body: { not: "a string" } }), stderr: "" }
          : null,
    });
    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });

  it("treats nullish list-all counts as zero before and after", async () => {
    const { stdoutSpy } = await runCompatibilityScenario(["--json"], {
      legacyOverride: (cmd) => (cmd === "list-all" ? { status: 0, stdout: JSON.stringify({}), stderr: "" } : null),
      currentOverride: (cmd) => (cmd === "list-all" ? { status: 0, stdout: JSON.stringify({}), stderr: "" } : null),
    });
    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      item_count_before: number;
      item_count_after: number;
    };
    expect(payload.item_count_before).toBe(0);
    expect(payload.item_count_after).toBe(0);
  });

  it("defaults health checks to [] and tolerates nullish status/name fields", async () => {
    const { stdoutSpy } = await runCompatibilityScenario(["--json"], {
      currentOverride: (cmd) =>
        cmd === "health" ? { status: 0, stdout: JSON.stringify({ checks: "not-an-array" }), stderr: "" } : null,
    });
    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as { health_ok: boolean };
    expect(payload.health_ok).toBe(true);
  });

  it("reports nullish health status/name in the blocking-check message", async () => {
    const { failure } = await runCompatibilityScenario(["--json"], {
      currentOverride: (cmd) =>
        cmd === "health"
          ? { status: 0, stdout: JSON.stringify({ checks: [{ status: "error" }, {}] }), stderr: "" }
          : null,
    });
    expect(String(failure ?? "")).toContain("reported blocking checks");
    expect(String(failure ?? "")).toContain("unknown");
  });
});
