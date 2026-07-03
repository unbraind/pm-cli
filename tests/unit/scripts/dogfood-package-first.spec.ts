import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

const SCRIPT = "scripts/dogfood-package-first.mjs";
const CLI_TAIL = path.join("dist", "cli.js");

type SpawnResult = { status: number | null; stdout: string | null; stderr: string | null };

const pmJson = (payload: unknown): SpawnResult => ({ status: 0, stdout: JSON.stringify(payload), stderr: "" });

interface Overrides {
  /** Return a SpawnResult to override the default for a given pm command. */
  pm?: (cmd: string, pmArgs: string[], jsonMode: boolean) => SpawnResult | undefined;
  /** Override the SDK direct-import (`--input-type=module`) result. */
  sdk?: SpawnResult;
  /** Override the semantic reindex / search results when semantic enabled. */
  semantic?: (pmArgs: string[]) => SpawnResult | undefined;
  /** Override the scaffold TypeScript build (`tsc`) result. */
  tsc?: SpawnResult;
}

interface DogfoodSpawnState {
  planAddStepCount: number;
  guidancePresent: boolean;
}

type DogfoodPmHandler = (pmArgs: string[], state: DogfoodSpawnState) => SpawnResult | undefined;

function flagRows(flags: string[]): Array<{ flag: string }> {
  return flags.map((flag) => ({ flag }));
}

function runtimeActionRows(actions: string[]): Array<{ action: string; available: boolean; invocable: boolean }> {
  return actions.map((action) => ({ action, available: true, invocable: true }));
}

function parseSpawnedPmArgs(args: string[]): { jsonMode: boolean; pmArgs: string[]; cmd: string } {
  const rawPmArgs = args.slice(1);
  const jsonMode = rawPmArgs[0] === "--json";
  const pmArgs = jsonMode ? rawPmArgs.slice(1) : rawPmArgs;
  return { jsonMode, pmArgs, cmd: pmArgs[0] };
}

function handleTextPmCommand(cmd: string): SpawnResult {
  const textResponses: Record<string, string | undefined> = {
    calendar: "# pm calendar\n\nDogfood calendar event\n",
    completion: "function _pm_completion() {}\n",
  };
  return { status: 0, stdout: textResponses[cmd] ?? "", stderr: "" };
}

function handleInitCommand(pmArgs: string[], state: DogfoodSpawnState): SpawnResult {
  if (pmArgs[1] === "--agent-guidance") {
    const action = pmArgs[2];
    if (action === "status") {
      return pmJson({ agent_guidance: { present: state.guidancePresent } });
    }
    if (action === "add") {
      state.guidancePresent = true;
      return pmJson({ agent_guidance: { present: true, applied: true } });
    }
  }
  return pmJson({
    installed_packages: { installed_all: true, installed_count: 10 },
    agent_guidance: { mode: "ask", present: false },
  });
}

function handleCreateCommand(pmArgs: string[]): SpawnResult {
  const typeIndex = pmArgs.indexOf("--type");
  const type = typeIndex >= 0 ? pmArgs[typeIndex + 1] : null;
  return pmJson({ item: { id: type === "Event" ? "pm-event-1" : "pm-dogfood-1" } });
}

function handleGetCommand(pmArgs: string[]): SpawnResult | undefined {
  if (pmArgs.includes("--depth") && pmArgs.includes("brief")) {
    return pmJson({ item: { id: "pm-dogfood-1" } });
  }
  if (!pmArgs.includes("--fields")) {
    return undefined;
  }
  return pmJson({
    item: { id: "pm-dogfood-1", title: "Dogfood package-first workflow", status: "in_progress", parent: null, type: "Task" },
  });
}

function fullContractsPayload(): SpawnResult {
  return pmJson({
    command_flags: [
      { command: "package", flags: flagRows(["--catalog", "--explore", "--doctor", "--install", "--project", "--global"]) },
      { command: "upgrade", flags: flagRows(["--packages-only", "--dry-run"]) },
      { command: "init", flags: flagRows(["--agent-guidance", "--with-packages"]) },
      { command: "get", flags: flagRows(["--fields"]) },
    ],
    command_aliases: [{ canonical: "package", aliases: ["install"] }],
  });
}

function handleContractsCommand(pmArgs: string[]): SpawnResult {
  if (pmArgs.includes("--command") && pmArgs.includes("list-open")) {
    return pmJson({ command_flags: [{ flags: flagRows(["--compact", "--brief", "--full", "--fields", "--include-body"]) }] });
  }
  if (pmArgs.includes("--command") && pmArgs.includes("search-advanced")) {
    return pmJson({ command_flags: [{ flags: flagRows(["--mode", "--semantic", "--hybrid", "--fields", "--limit"]) }] });
  }
  if (pmArgs.includes("--command") && pmArgs.includes("search")) {
    return pmJson({ command_flags: [{ flags: flagRows(["--mode", "--semantic", "--hybrid", "--include-linked"]) }] });
  }
  if (pmArgs.includes("--availability-only") && pmArgs.includes("--runtime-only")) {
    return pmJson({
      action_availability: runtimeActionRows([
        "beads-import", "completion", "comments-audit", "dedupe-audit", "guide",
        "search-advanced", "templates-save", "templates-show", "test-runs-list", "todos-export",
      ]),
    });
  }
  return fullContractsPayload();
}

function handleInstallCommand(pmArgs: string[]): SpawnResult {
  if (pmArgs[1] === "all") {
    return pmJson({ details: { installed_all: true, installed_count: 10 } });
  }
  return pmJson({ details: { installed_count: 1 } });
}

function packageCatalogPayload(): SpawnResult {
  return pmJson({
    details: {
      total: 10,
      packages: [
        "beads", "calendar", "governance-audit", "guide-shell", "kanban", "lifecycle-hooks",
        "linked-test-adapters", "search-advanced", "templates", "todos",
      ].map((alias) => ({ alias })),
    },
  });
}

function handlePackageCommand(pmArgs: string[]): SpawnResult | undefined {
  const sub = pmArgs[1];
  if (sub === "catalog") {
    return packageCatalogPayload();
  }
  if (sub === "list") {
    return pmJson({ action: "catalog", details: { total: 10 } });
  }
  if (sub === "doctor") {
    return pmJson({ details: { summary: { activation_failure_count: 0, blocking_failure_count: 0 }, triage: { warning_codes: [] } } });
  }
  if (sub === "init") {
    return pmJson({ details: { extension: { command: "starter scaffold package ping" } } });
  }
  return undefined;
}

function handlePlanCommand(pmArgs: string[], state: DogfoodSpawnState): SpawnResult | undefined {
  const sub = pmArgs[1];
  if (sub === "add-step") {
    state.planAddStepCount += 1;
    return pmJson({ step: { id: `plan-step-00${state.planAddStepCount}` } });
  }
  const planResponses: Record<string, SpawnResult | undefined> = {
    create: pmJson({ plan: { id: "plan-dogfood-1" } }),
    "update-step": pmJson({ step: { status: "in_progress" } }),
    "complete-step": pmJson({ step: { status: "completed" } }),
    decision: pmJson({ plan: { decisions: [{}] } }),
    discovery: pmJson({ plan: { discoveries: [{}] } }),
    validation: pmJson({ plan: { validation: [{}] } }),
    resume: pmJson({ plan: { resume_context: "step 2 pending; materialize next" } }),
    approve: pmJson({ plan: { mode: "approved" } }),
    materialize: pmJson({ materialized: [{ id: "pm-materialized-1" }] }),
  };
  if (sub === "show" && pmArgs.includes("--depth")) {
    return pmJson({ plan: { steps: [{}, {}] } });
  }
  if (sub === "show" && pmArgs.includes("--fields")) {
    return pmJson({ plan: { id: "plan-dogfood-1", title: "Dogfood plan workflow", steps_summary: { total: 2 } } });
  }
  return planResponses[sub];
}

function handleStarterCommand(pmArgs: string[]): SpawnResult | undefined {
  return pmArgs.slice(1).join(" ") === "scaffold package ping" ? pmJson({ ok: true, command: "starter scaffold package ping" }) : undefined;
}

function handleTemplatesCommand(pmArgs: string[]): SpawnResult | undefined {
  if (pmArgs[1] === "save") {
    return pmJson({ name: "dogfood-defaults" });
  }
  if (pmArgs[1] === "show") {
    return pmJson({ options: { tags: "dogfood,templates" } });
  }
  return undefined;
}

function handleUpgradeCommand(pmArgs: string[]): SpawnResult | undefined {
  if (pmArgs.includes("--packages-only")) {
    return pmJson({ summary: { requested_packages: true, failed: 0 } });
  }
  if (pmArgs.includes("--dry-run")) {
    return pmJson({ dry_run: true, summary: { requested_cli: true, requested_packages: true } });
  }
  return undefined;
}

function handleHistoryRedactCommand(pmArgs: string[]): SpawnResult {
  if (pmArgs.includes("--dry-run")) {
    return pmJson({ changed: true, history: { audit_entry_added: false } });
  }
  return pmJson({ changed: true, history: { audit_entry_added: true, verify_ok: true } });
}

const DOGFOOD_JSON_HANDLERS: Record<string, DogfoodPmHandler | undefined> = {
  init: handleInitCommand,
  create: (pmArgs) => handleCreateCommand(pmArgs),
  get: (pmArgs) => handleGetCommand(pmArgs),
  "list-open": () => pmJson({ projection: { mode: "compact", fields: ["id", "status", "type", "title"] } }),
  "search-advanced": () => pmJson({ mode: "keyword", query: "Dogfood package-first workflow" }),
  contracts: (pmArgs) => handleContractsCommand(pmArgs),
  install: (pmArgs) => handleInstallCommand(pmArgs),
  package: (pmArgs) => handlePackageCommand(pmArgs),
  starter: (pmArgs) => handleStarterCommand(pmArgs),
  guide: (pmArgs) => (pmArgs.includes("--list") ? pmJson({ topics: [{ id: "workflows" }] }) : undefined),
  "dedupe-audit": () => pmJson({ clusters: [] }),
  "comments-audit": () => pmJson({ items: [] }),
  normalize: () => pmJson({ dry_run: true }),
  "test-runs": (pmArgs) => (pmArgs[1] === "list" ? pmJson({ runs: [] }) : undefined),
  templates: (pmArgs) => handleTemplatesCommand(pmArgs),
  beads: (pmArgs) => (pmArgs[1] === "import" ? pmJson({ imported: 1 }) : undefined),
  todos: (pmArgs) => (pmArgs[1] === "export" ? pmJson({ exported: 1 }) : undefined),
  upgrade: (pmArgs) => handleUpgradeCommand(pmArgs),
  plan: handlePlanCommand,
  history: (pmArgs) => (pmArgs.includes("--verify") ? pmJson({ verification: { ok: true } }) : undefined),
  search: (pmArgs) => (pmArgs[1] === "exponential dogfood" ? pmJson({ items: [] }) : undefined),
  "history-redact": (pmArgs) => handleHistoryRedactCommand(pmArgs),
  health: (pmArgs) => (pmArgs.includes("--brief") ? pmJson({ projection: { mode: "brief" } }) : undefined),
};

function defaultDogfoodJsonResponse(cmd: string, pmArgs: string[], state: DogfoodSpawnState): SpawnResult {
  return DOGFOOD_JSON_HANDLERS[cmd]?.(pmArgs, state) ?? pmJson({ ok: true });
}

function runDogfoodSpawn(command: string, args: string[], state: DogfoodSpawnState, overrides: Overrides): SpawnResult {
  if (command === process.execPath && args[0] === "--input-type=module") {
    return overrides.sdk ?? { status: 0, stdout: "", stderr: "" };
  }
  if (command === process.execPath && args[0]?.endsWith(path.join("typescript", "bin", "tsc"))) {
    return overrides.tsc ?? { status: 0, stdout: "", stderr: "" };
  }
  if (command !== process.execPath || !args[0]?.endsWith(CLI_TAIL)) {
    return { status: 0, stdout: "", stderr: "" };
  }

  const { jsonMode, pmArgs, cmd } = parseSpawnedPmArgs(args);
  const override = overrides.pm?.(cmd, pmArgs, jsonMode);
  if (override) {
    return override;
  }

  if (overrides.semantic && (cmd === "reindex" || cmd === "search" || cmd === "search-advanced")) {
    const semantic = overrides.semantic(pmArgs);
    if (semantic) {
      return semantic;
    }
  }

  return jsonMode ? defaultDogfoodJsonResponse(cmd, pmArgs, state) : handleTextPmCommand(cmd);
}

function buildSpawnSync(overrides: Overrides = {}) {
  const state: DogfoodSpawnState = { planAddStepCount: 0, guidancePresent: false };
  return vi.fn((command: string, args: string[]): SpawnResult => runDogfoodSpawn(command, args, state, overrides));
}

function mockFs(rmThrows = false, indexEmitted = true) {
  const rmSync = rmThrows
    ? vi.fn(() => {
        throw new Error("rm failed");
      })
    : vi.fn();
  vi.doMock("node:fs", () => ({
    // `existsSync` reports the authored `index.ts` per `indexEmitted` (the
    // `typecheckScaffoldedPackage` manifest-entry assertion — pm loads the .ts
    // entry directly, ADR pm-m1uz), and the scaffold's node_modules links absent
    // so symlinkSync always runs.
    existsSync: vi.fn((target: string) => indexEmitted && String(target).endsWith("index.ts")),
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(() => "/tmp/pm-dogfood"),
    readdirSync: vi.fn(() => ["README.md", "scripts", ".hidden"]),
    rmSync,
    symlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
  }));
  return rmSync;
}

describe("dogfood-package-first", () => {
  it("runs the full success path (semantic skipped) and reports ok", async () => {
    const spawnSync = buildSpawnSync();
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const rmSync = mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await harness.importModule(SCRIPT);

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      semantic_dogfood: { attempted: boolean; skipped_reason: string };
      commands: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.semantic_dogfood.attempted).toBe(false);
    expect(payload.semantic_dogfood.skipped_reason).toContain("PM_DOGFOOD_SEMANTIC not set");
    expect(payload.commands).toBeGreaterThan(20);
    expect(rmSync).toHaveBeenCalled();
  });

  it("runs the semantic probe when PM_DOGFOOD_SEMANTIC=1 and keeps the temp root", async () => {
    const semantic = (pmArgs: string[]): SpawnResult | undefined => {
      if (pmArgs[0] === "reindex" && pmArgs.includes("hybrid")) {
        return pmJson({ semantic: { enabled: true, batches_completed: 2, embedded_items: 3, vector_upserted: 4 } });
      }
      if (pmArgs[0] === "search" && pmArgs[1] === "package workflow") {
        return pmJson({ mode: "hybrid", items: [{ id: "x" }] });
      }
      if (pmArgs[0] === "search-advanced" && pmArgs.includes("--hybrid")) {
        return pmJson({ mode: "hybrid", query: "package workflow" });
      }
      return undefined;
    };
    const spawnSync = buildSpawnSync({ semantic });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const rmSync = mockFs();
    process.env.PM_DOGFOOD_SEMANTIC = "1";
    process.env.PM_DOGFOOD_KEEP_TEMP = "1";
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await harness.importModule(SCRIPT);

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      semantic_dogfood: { attempted: boolean; model: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.semantic_dogfood.attempted).toBe(true);
    expect(payload.semantic_dogfood.model).toBeTruthy();
    // PM_DOGFOOD_KEEP_TEMP=1 -> finally skips cleanup.
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("fails and warns on cleanup when a pm command exits non-zero (with stdout + stderr)", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd) =>
        cmd === "init"
          ? { status: 3, stdout: "init partial output", stderr: "init boom" }
          : undefined,
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs(true);
    delete process.env.PM_DOGFOOD_SEMANTIC;
    delete process.env.PM_DOGFOOD_KEEP_TEMP;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await harness.importModule(SCRIPT);

    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("init failed with exit 3"))).toBe(true);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("init boom"))).toBe(true);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("failed to remove dogfood temp root"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails when a pm command emits invalid JSON", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd) => (cmd === "init" ? { status: 0, stdout: "not-json", stderr: "" } : undefined),
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("did not emit valid JSON"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails when create does not return an item id (idFrom guard)", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd, pmArgs) => {
        if (cmd === "create" && !pmArgs.includes("Event")) return pmJson({ item: {} });
        return undefined;
      },
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("did not return an item id"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails when an assertion does not hold (init installed_all false)", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd, pmArgs) => {
        if (cmd === "init" && pmArgs.includes("--with-packages")) {
          return pmJson({ installed_packages: { installed_all: false, installed_count: 0 }, agent_guidance: { mode: "ask", present: false } });
        }
        return undefined;
      },
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("installed_all=true"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails when the SDK direct import returns non-zero", async () => {
    const spawnSync = buildSpawnSync({ sdk: { status: 2, stdout: "", stderr: "sdk import boom" } });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("SDK direct import failed"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails when the scaffold TypeScript typecheck (tsc) exits non-zero", async () => {
    const spawnSync = buildSpawnSync({ tsc: { status: 2, stdout: "tsc partial", stderr: "tsc boom" } });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("package typecheck scaffold (tsc) failed with exit 2"))).toBe(true);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("tsc boom"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("formats the scaffold typecheck failure with null status and empty output", async () => {
    const spawnSync = buildSpawnSync({ tsc: { status: null, stdout: "", stderr: "" } });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("package typecheck scaffold (tsc) failed with exit unknown"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("formats the scaffold typecheck failure when spawnSync returns null output streams", async () => {
    const spawnSync = buildSpawnSync({ tsc: { status: null, stdout: null, stderr: null } });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("package typecheck scaffold (tsc) failed with exit unknown"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails when the scaffold is missing the ./index.ts manifest entry", async () => {
    const spawnSync = buildSpawnSync();
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs(false, false);
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("did not author the ./index.ts manifest entry"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails when the semantic hybrid reindex exits non-zero", async () => {
    const semantic = (pmArgs: string[]): SpawnResult | undefined => {
      if (pmArgs[0] === "reindex" && pmArgs.includes("hybrid")) {
        return { status: 1, stdout: "reindex partial", stderr: "reindex boom" };
      }
      return undefined;
    };
    const spawnSync = buildSpawnSync({ semantic });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    process.env.PM_DOGFOOD_SEMANTIC = "1";
    delete process.env.PM_DOGFOOD_KEEP_TEMP;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("semantic hybrid reindex failed"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails when the semantic hybrid search exits non-zero", async () => {
    const semantic = (pmArgs: string[]): SpawnResult | undefined => {
      if (pmArgs[0] === "reindex" && pmArgs.includes("hybrid")) {
        return pmJson({ semantic: { enabled: true, batches_completed: 1, embedded_items: 1, vector_upserted: 1 } });
      }
      if (pmArgs[0] === "search" && pmArgs[1] === "package workflow") {
        return { status: 1, stdout: "", stderr: "search boom" };
      }
      return undefined;
    };
    const spawnSync = buildSpawnSync({ semantic });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    process.env.PM_DOGFOOD_SEMANTIC = "1";
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("semantic hybrid search failed"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails when the semantic search-advanced alias exits non-zero", async () => {
    const semantic = (pmArgs: string[]): SpawnResult | undefined => {
      if (pmArgs[0] === "reindex" && pmArgs.includes("hybrid")) {
        return pmJson({ semantic: { enabled: true, batches_completed: 1, embedded_items: 1, vector_upserted: 1 } });
      }
      if (pmArgs[0] === "search" && pmArgs[1] === "package workflow") {
        return pmJson({ mode: "hybrid", items: [{ id: "x" }] });
      }
      if (pmArgs[0] === "search-advanced" && pmArgs.includes("--hybrid")) {
        return { status: 1, stdout: "", stderr: "search-advanced boom" };
      }
      return undefined;
    };
    const spawnSync = buildSpawnSync({ semantic });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    process.env.PM_DOGFOOD_SEMANTIC = "1";
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("semantic search-advanced --hybrid failed"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("formats a failure with null status and empty stdout/stderr (?? fallbacks)", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd) => (cmd === "init" ? { status: null as unknown as number, stdout: "", stderr: "" } : undefined),
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("init failed with exit unknown"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("formats a json:false (runText) command failure with the bare command label", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd, _pmArgs, jsonMode) =>
        cmd === "calendar" && !jsonMode ? { status: 4, stdout: "", stderr: "calendar text boom" } : undefined,
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("failed with exit 4"))).toBe(true);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("calendar text boom"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("warns with String(error) when cleanup throws a non-Error", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd) => (cmd === "init" ? { status: 5, stdout: "", stderr: "" } : undefined),
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/pm-dogfood"),
      readdirSync: vi.fn(() => ["README.md"]),
      rmSync: vi.fn(() => {
        throw "raw-rm-string-failure";
      }),
      writeFileSync: vi.fn(),
    }));
    delete process.env.PM_DOGFOOD_SEMANTIC;
    delete process.env.PM_DOGFOOD_KEEP_TEMP;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("raw-rm-string-failure"))).toBe(true);
  });

  it("reports String(error) in the top-level catch when a non-Error is thrown", async () => {
    const spawnSync = buildSpawnSync();
    vi.doMock("node:child_process", () => ({ spawnSync }));
    // writeFileSync throws a non-Error before any pm command runs.
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/pm-dogfood"),
      readdirSync: vi.fn(() => ["README.md"]),
      rmSync: vi.fn(),
      writeFileSync: vi.fn(() => {
        throw "raw-write-string-failure";
      }),
    }));
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]) === "raw-write-string-failure")).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("formats the SDK direct-import failure with null status and empty output", async () => {
    const spawnSync = buildSpawnSync({ sdk: { status: null as unknown as number, stdout: "", stderr: "" } });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("SDK direct import failed"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("formats the semantic reindex failure with null status and empty output", async () => {
    const semantic = (pmArgs: string[]): SpawnResult | undefined =>
      pmArgs[0] === "reindex" && pmArgs.includes("hybrid")
        ? { status: null as unknown as number, stdout: "", stderr: "" }
        : undefined;
    const spawnSync = buildSpawnSync({ semantic });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    process.env.PM_DOGFOOD_SEMANTIC = "1";
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("semantic hybrid reindex failed with exit unknown"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    { name: "batches", payload: { enabled: true }, expected: "completed no batches" },
    { name: "embedded items", payload: { enabled: true, batches_completed: 1 }, expected: "embedded no items" },
    { name: "vector upserts", payload: { enabled: true, batches_completed: 1, embedded_items: 1 }, expected: "upserted no vectors" },
  ])("falls back to 0 and fails the reindex assertion when $name are absent", async ({ payload, expected }) => {
    const semantic = (pmArgs: string[]): SpawnResult | undefined =>
      pmArgs[0] === "reindex" && pmArgs.includes("hybrid") ? pmJson({ semantic: payload }) : undefined;
    const spawnSync = buildSpawnSync({ semantic });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    process.env.PM_DOGFOOD_SEMANTIC = "1";
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes(expected))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("formats the semantic search failure with null status and empty output", async () => {
    const semantic = (pmArgs: string[]): SpawnResult | undefined => {
      if (pmArgs[0] === "reindex" && pmArgs.includes("hybrid")) {
        return pmJson({ semantic: { enabled: true, batches_completed: 1, embedded_items: 1, vector_upserted: 1 } });
      }
      if (pmArgs[0] === "search" && pmArgs[1] === "package workflow") {
        return { status: null as unknown as number, stdout: "", stderr: "" };
      }
      return undefined;
    };
    const spawnSync = buildSpawnSync({ semantic });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    process.env.PM_DOGFOOD_SEMANTIC = "1";
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("semantic hybrid search failed"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails the semantic search assertion when items are absent", async () => {
    const semantic = (pmArgs: string[]): SpawnResult | undefined => {
      if (pmArgs[0] === "reindex" && pmArgs.includes("hybrid")) {
        return pmJson({ semantic: { enabled: true, batches_completed: 1, embedded_items: 1, vector_upserted: 1 } });
      }
      if (pmArgs[0] === "search" && pmArgs[1] === "package workflow") {
        return pmJson({ mode: "hybrid" });
      }
      return undefined;
    };
    const spawnSync = buildSpawnSync({ semantic });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    process.env.PM_DOGFOOD_SEMANTIC = "1";
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("search returned no items"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("formats the semantic search-advanced failure with null status and empty output", async () => {
    const semantic = (pmArgs: string[]): SpawnResult | undefined => {
      if (pmArgs[0] === "reindex" && pmArgs.includes("hybrid")) {
        return pmJson({ semantic: { enabled: true, batches_completed: 1, embedded_items: 1, vector_upserted: 1 } });
      }
      if (pmArgs[0] === "search" && pmArgs[1] === "package workflow") {
        return pmJson({ mode: "hybrid", items: [{ id: "x" }] });
      }
      if (pmArgs[0] === "search-advanced" && pmArgs.includes("--hybrid")) {
        return { status: null as unknown as number, stdout: "", stderr: "" };
      }
      return undefined;
    };
    const spawnSync = buildSpawnSync({ semantic });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    process.env.PM_DOGFOOD_SEMANTIC = "1";
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("semantic search-advanced --hybrid failed"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("falls back to [] when contracts list-open omits the flags array", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd, pmArgs) =>
        cmd === "contracts" && pmArgs.includes("list-open") ? pmJson({ command_flags: [{}] }) : undefined,
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("contracts list-open flags missing"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("falls back to [] when contracts search omits the flags array", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd, pmArgs) =>
        cmd === "contracts" && pmArgs.includes("--command") && pmArgs.includes("search") && !pmArgs.includes("search-advanced") && !pmArgs.includes("list-open")
          ? pmJson({ command_flags: [{}] })
          : undefined,
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("contracts search flags missing"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("falls back to [] when contracts search-advanced omits the flags array", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd, pmArgs) =>
        cmd === "contracts" && pmArgs.includes("--command") && pmArgs.includes("search-advanced")
          ? pmJson({ command_flags: [{}] })
          : undefined,
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("contracts search-advanced flags missing"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("falls back to [] when the all-flags contracts payload omits command_flags and aliases", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd, pmArgs) => {
        // The bare `contracts --flags-only` call (no --command, no --availability-only).
        if (cmd === "contracts" && pmArgs.includes("--flags-only") && !pmArgs.includes("--command") && !pmArgs.includes("--availability-only")) {
          return pmJson({});
        }
        return undefined;
      },
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("contracts --flags-only missing"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("falls back to [] when a command_flags entry omits its flags array", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd, pmArgs) => {
        if (cmd === "contracts" && pmArgs.includes("--flags-only") && !pmArgs.includes("--command") && !pmArgs.includes("--availability-only")) {
          return pmJson({
            command_flags: [{ command: "package" }],
            command_aliases: [{ canonical: "package", aliases: ["install"] }],
          });
        }
        return undefined;
      },
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("contracts --flags-only missing"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("falls back to [] when the package command-alias entry omits its aliases array", async () => {
    const fullCommandFlags = [
      { command: "package", flags: ["--catalog", "--explore", "--doctor", "--install", "--project", "--global"].map((flag) => ({ flag })) },
      { command: "upgrade", flags: ["--packages-only", "--dry-run"].map((flag) => ({ flag })) },
      { command: "init", flags: ["--agent-guidance", "--with-packages"].map((flag) => ({ flag })) },
      { command: "get", flags: ["--fields"].map((flag) => ({ flag })) },
    ];
    const spawnSync = buildSpawnSync({
      pm: (cmd, pmArgs) => {
        if (cmd === "contracts" && pmArgs.includes("--flags-only") && !pmArgs.includes("--command") && !pmArgs.includes("--availability-only")) {
          // All requireContractFlag assertions pass; the package alias entry lacks `aliases`.
          return pmJson({ command_flags: fullCommandFlags, command_aliases: [{ canonical: "package" }] });
        }
        return undefined;
      },
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("missing install command alias"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("falls back to [] when the package catalog omits its packages array", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd, pmArgs) =>
        cmd === "package" && pmArgs[1] === "catalog" ? pmJson({ details: { total: 9 } }) : undefined,
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("package catalog missing bundled alias"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("falls back to {}/[] when package doctor omits summary and warning codes", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd, pmArgs) =>
        cmd === "package" && pmArgs[1] === "doctor" ? pmJson({ details: {} }) : undefined,
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("package doctor reported activation failures"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("falls back to [] when runtime contracts omit action_availability", async () => {
    const spawnSync = buildSpawnSync({
      pm: (cmd, pmArgs) =>
        cmd === "contracts" && pmArgs.includes("--availability-only") ? pmJson({}) : undefined,
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    mockFs();
    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await harness.importModule(SCRIPT);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("runtime contracts missing installed package action"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
