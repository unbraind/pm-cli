import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();

const SCRIPT = "scripts/release/tracker-measurement-gate.mjs";

interface SpawnResult {
  status: number;
  stdout: string;
  stderr: string;
}

type SpawnHandler = (command: string, args: readonly string[]) => SpawnResult;

interface GateModule {
  SELECTOR_SOURCES: readonly string[];
  EXHAUSTIVE_SELECTOR_SOURCES: readonly string[];
  TERMINAL_OWNER_STATUSES: readonly string[];
  HEALTH_STATUS_SEVERITY: Readonly<Record<string, number>>;
  measureDependencyKinds: (items: unknown) => Map<string, number>;
  measureDependencyContributors: (items: unknown, declarations: readonly unknown[]) => Map<string, unknown[]>;
  measureValidateWarnings: (report: unknown) => Map<string, number>;
  measureGraphProfile: (report: unknown) => Map<string, number>;
  measureGraphFindings: (report: unknown) => Map<string, number>;
  resolveGraphAuditMeasurements: (
    context: Record<string, unknown>,
    sources: Set<string>,
  ) => { graph_profile: Map<string, number>; graph_finding: Map<string, number> };
  measureHealthChecks: (report: unknown) => Map<string, number>;
  selectorKey: (selector: unknown) => string | undefined;
  formatSelector: (selector: unknown) => string;
  observeDeclaration: (
    declaration: unknown,
    measurements: Record<string, Map<string, number>>,
  ) => { observed?: number; error?: string };
  evaluateDeclarations: (input: {
    declarations: unknown;
    measurements: Record<string, Map<string, number>>;
    ownerStatuses?: Map<string, string>;
    contributors?: Map<string, unknown[]>;
  }) => { observations: Record<string, unknown>[]; violations: Record<string, unknown>[] };
  formatViolation: (observation: Record<string, unknown>) => string;
  buildUpdatedDeclarations: (
    document: Record<string, unknown>,
    evaluation: { observations: Record<string, unknown>[] },
    today: string,
  ) => { declarations: Record<string, unknown>[] };
  loadDocument: (path: string) => Record<string, unknown>;
  measureTracker: (
    context: Record<string, unknown>,
    declarations: readonly unknown[],
  ) => {
    measurements: Record<string, Map<string, number>>;
    ownerStatuses: Map<string, string>;
    contributors: Map<string, unknown[]>;
    item_count: number;
  };
  cliContext: (flags: Map<string, string | true>) => Record<string, unknown>;
  materializeCommitView: (root?: string) => {
    root: string;
    materialized_file_count: number;
    pending_deletion_count: number;
  };
  contextForCommitView: (
    context: Record<string, unknown>,
    view: { root: string },
  ) => Record<string, unknown>;
  runNegativeControl: (flags: Map<string, string | true>) => void;
  main: (argv?: readonly string[]) => void;
}

/**
 * Import the gate under mocked process boundaries. The module guards its own
 * entrypoint, so importing it never runs `main`; each test drives the exported
 * surface directly.
 */
async function loadGate(options: {
  spawn?: SpawnHandler;
  files?: Record<string, string>;
  missingSources?: readonly string[];
  refuseLinks?: boolean;
} = {}) {
  const spawnSync = vi.fn((command: string, args: readonly string[]) =>
    (options.spawn ?? (() => ({ status: 0, stdout: "{}", stderr: "" })))(command, args),
  );
  const writes: Record<string, string> = {};
  const readFileSync = vi.fn((file: string) => {
    const contents = options.files?.[String(file)];
    if (contents === undefined) {
      throw new Error(`unexpected read: ${String(file)}`);
    }
    return contents;
  });
  const writeFileSync = vi.fn((file: string, contents: string) => {
    writes[String(file)] = contents;
  });
  const mkdtempSync = vi.fn((prefix: string) => `${String(prefix)}fixed`);
  const rmSync = vi.fn();
  const missing = new Set(options.missingSources ?? []);
  // The materializer joins paths with the host separator, so a fixture written
  // with forward slashes only matches on POSIX unless the probe is normalized.
  const existsSync = vi.fn((file: string) => !missing.has(String(file).replaceAll("\\", "/")));
  const mkdirSync = vi.fn();
  const linkSync = vi.fn(() => {
    if (options.refuseLinks === true) {
      throw new Error("EXDEV: cross-device link not permitted");
    }
  });
  const copyFileSync = vi.fn();
  vi.doMock("node:child_process", () => ({ spawnSync }));
  vi.doMock("node:fs", () => ({
    copyFileSync,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
  }));
  const exit = harness.mockProcessExit();
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const module = await harness.importModule<GateModule>(SCRIPT);
  return {
    module,
    spawnSync,
    readFileSync,
    rmSync,
    writeFileSync,
    writes,
    exit,
    stdout,
    stderr,
    copyFileSync,
    linkSync,
    mkdirSync,
    existsSync,
  };
}

function stdoutText(stdout: { mock: { calls: unknown[][] } }): string {
  return stdout.mock.calls.map((call) => String(call[0])).join("");
}

function errorText(stderr: { mock: { calls: unknown[][] } }): string {
  return stderr.mock.calls.map((call) => String(call[0])).join("");
}

const LISTING = {
  items: [
    {
      id: "pm-owner",
      status: "open",
      dependencies: [
        { id: "pm-a", kind: "blocks" },
        { id: "pm-b", kind: "related_to" },
        { id: "pm-c", kind: "related" },
      ],
    },
    { id: "pm-closed", status: "closed", dependencies: [{ id: "pm-a", kind: "blocks" }] },
    { id: "pm-empty", status: "open" },
  ],
};

const VALIDATE = { warnings: ["validate_files_missing_linked_paths:7"] };
const GRAPH = {
  profile: { isolated_active_nodes: 0, edges_by_kind: { blocks: 2 } },
  findings: [
    { code: "duplicate_dependency_row", count: 3 },
    { code: "legacy_ordering_cycle", count: 7 },
    { code: "legacy_ordering_cycle", count: 2 },
  ],
};
const HEALTH = { checks: [{ name: "storage", status: "ok" }] };

/** Two committable paths, NUL-separated, exactly as `git ls-files -z` emits them. */
const COMMITTABLE = "src/kept.ts\0src/deleted.ts\0";

function trackerSpawn(overrides: Partial<Record<string, unknown>> = {}): SpawnHandler {
  return (command, args) => {
    const argv = args.join(" ");
    if (command === "git") {
      return {
        status: overrides.gitStatus === undefined ? 0 : Number(overrides.gitStatus),
        stdout: overrides.committable === undefined ? COMMITTABLE : String(overrides.committable),
        stderr: "not a git repository",
      };
    }
    if (argv.includes(" list ") || argv.includes("list ")) {
      return { status: 0, stdout: JSON.stringify(overrides.listing ?? LISTING), stderr: "" };
    }
    if (argv.includes("validate")) {
      return { status: 0, stdout: JSON.stringify(overrides.validate ?? VALIDATE), stderr: "" };
    }
    if (argv.includes("graph audit") || argv.includes("graph")) {
      return { status: 0, stdout: JSON.stringify(overrides.graph ?? GRAPH), stderr: "" };
    }
    if (argv.includes("health")) {
      return { status: 0, stdout: JSON.stringify(overrides.health ?? HEALTH), stderr: "" };
    }
    return { status: 0, stdout: "{}", stderr: "" };
  };
}

const DECLARATION = {
  id: "blocks-rows",
  owner: "pm-owner",
  selector: { source: "dependency_kind", kind: "blocks" },
  ceiling: 2,
};

describe("tracker measurement gate: measurement primitives", () => {
  it("counts stored dependency rows per kind and ignores malformed rows", async () => {
    const { module } = await loadGate();
    const counts = module.measureDependencyKinds([
      { dependencies: [{ kind: "blocks" }, { kind: "blocks" }, { kind: "" }, { kind: 7 }, null] },
      { dependencies: "not-an-array" },
      null,
    ]);
    expect(counts.get("blocks")).toBe(2);
    expect(counts.has("")).toBe(false);
    expect(module.measureDependencyKinds("not-an-array").size).toBe(0);
  });

  it("parses validate warnings and drops entries without a numeric count", async () => {
    const { module } = await loadGate();
    const counts = module.measureValidateWarnings({
      warnings: ["code_a:12", "code_b", "code_c:not-a-number", 5, "with:colons:3"],
    });
    expect(counts.get("code_a")).toBe(12);
    expect(counts.get("with:colons")).toBe(3);
    expect(counts.has("code_b")).toBe(false);
    expect(counts.has("code_c")).toBe(false);
    expect(module.measureValidateWarnings(null).size).toBe(0);
  });

  it("keeps only finite numeric fields of the graph profile", async () => {
    const { module } = await loadGate();
    const counts = module.measureGraphProfile({
      profile: { isolated_active_nodes: 3, edges_by_kind: {}, ratio: Number.NaN },
    });
    expect(counts.get("isolated_active_nodes")).toBe(3);
    expect(counts.has("edges_by_kind")).toBe(false);
    expect(counts.has("ratio")).toBe(false);
    expect(module.measureGraphProfile({ profile: null }).size).toBe(0);
    expect(module.measureGraphProfile(undefined).size).toBe(0);
  });

  it("sums graph audit findings per code and ignores unusable entries", async () => {
    const { module } = await loadGate();
    const counts = module.measureGraphFindings({
      findings: [
        { code: "duplicate_dependency_row", count: 3 },
        { code: "legacy_ordering_cycle", count: 7 },
        { code: "legacy_ordering_cycle", count: 2 },
        { code: "missing_reference_terminal" },
        { code: "", count: 9 },
        { code: 7, count: 9 },
        null,
      ],
    });
    // Grouped entries sharing a code are one class, so the ratchet sums them.
    expect(counts.get("legacy_ordering_cycle")).toBe(9);
    expect(counts.get("duplicate_dependency_row")).toBe(3);
    // A finding without a numeric count still exists, so it counts as one.
    expect(counts.get("missing_reference_terminal")).toBe(1);
    expect(counts.has("")).toBe(false);
    expect(counts.size).toBe(3);
    expect(module.measureGraphFindings({ findings: null }).size).toBe(0);
    expect(module.measureGraphFindings(undefined).size).toBe(0);
  });

  it("maps health statuses to a stable severity and fails closed on unknown statuses", async () => {
    const { module } = await loadGate();
    const counts = module.measureHealthChecks({
      checks: [
        { name: "storage", status: "ok" },
        { name: "telemetry", status: "warn" },
        { name: "future", status: "unknown" },
        { name: "", status: "error" },
        null,
      ],
    });
    expect(counts.get("storage")).toBe(0);
    expect(counts.get("telemetry")).toBe(1);
    expect(counts.get("future")).toBe(3);
    expect(module.measureHealthChecks(null).size).toBe(0);
    expect(module.HEALTH_STATUS_SEVERITY.error).toBe(2);
  });

  it("attributes post-measurement dependency growth to authored rows", async () => {
    const { module } = await loadGate();
    const contributors = module.measureDependencyContributors(
      [
        {
          id: "pm-holder",
          dependencies: [
            null,
            "not-a-dependency",
            { id: "pm-old", kind: "blocks", created_at: "2026-08-04T01:00:00Z" },
            {
              id: "pm-new",
              kind: "blocks",
              created_at: "2026-08-05T01:00:00Z",
              author: "harness:codex",
              source_kind: "cli:update:dep",
            },
          ],
        },
      ],
      [{ selector: { source: "dependency_kind", kind: "blocks" }, measured_on: "2026-08-04" }],
    );
    expect(contributors.get("dependency_kind:blocks")).toEqual([
      {
        item_id: "pm-holder",
        target_id: "pm-new",
        created_at: "2026-08-05T01:00:00Z",
        author: "harness:codex",
        source_kind: "cli:update:dep",
      },
    ]);
    expect(module.measureDependencyContributors(null, []).size).toBe(0);

    const legacy = module.measureDependencyContributors(
      [{ id: "pm-holder", dependencies: [{ id: "pm-new", kind: "blocks", created_at: "2026-08-05" }] }],
      [{ selector: { source: "dependency_kind", kind: "blocks" }, measured_on: "2026-08-04" }],
    );
    expect(legacy.get("dependency_kind:blocks")?.[0]).toMatchObject({ author: null, source_kind: null });
  });

  it("maps every declared selector source to its measurement key", async () => {
    const { module } = await loadGate();
    expect(module.selectorKey({ source: "dependency_kind", kind: "blocks" })).toBe("blocks");
    expect(module.selectorKey({ source: "validate_warning", code: "c" })).toBe("c");
    expect(module.selectorKey({ source: "graph_profile", field: "f" })).toBe("f");
    expect(module.selectorKey({ source: "health_check", name: "storage" })).toBe("storage");
    expect(module.selectorKey({ source: "other" })).toBeUndefined();
    expect(module.selectorKey(undefined)).toBeUndefined();
    expect(module.formatSelector(undefined)).toBe("unknown:unknown");
    expect(module.SELECTOR_SOURCES).toContain("graph_profile");
    expect(module.EXHAUSTIVE_SELECTOR_SOURCES).toContain("validate_warning");
    expect(module.TERMINAL_OWNER_STATUSES).toContain("canceled");
  });
});

describe("tracker measurement gate: observation", () => {
  it("treats an unmatched dependency kind as a genuine zero", async () => {
    const { module } = await loadGate();
    const result = module.observeDeclaration(
      { selector: { source: "dependency_kind", kind: "gone" } },
      { dependency_kind: new Map(), validate_warning: new Map(), graph_profile: new Map() },
    );
    expect(result).toEqual({ observed: 0 });
  });

  it("rejects an unusable selector, an uncollected source, and an absent profile field", async () => {
    const { module } = await loadGate();
    const measurements = {
      dependency_kind: new Map(),
      validate_warning: new Map(),
      graph_profile: new Map(),
    };
    expect(module.observeDeclaration({ selector: { source: "nope" } }, measurements).error).toContain(
      "unusable selector",
    );
    expect(
      module.observeDeclaration({ selector: { source: "dependency_kind", kind: "" } }, measurements)
        .error,
    ).toContain("unusable selector");
    expect(
      module.observeDeclaration(
        { selector: { source: "dependency_kind", kind: "blocks" } },
        { dependency_kind: undefined } as never,
      ).error,
    ).toContain("no measurement collected");
    expect(
      module.observeDeclaration({ selector: { source: "graph_profile", field: "absent" } }, measurements)
        .error,
    ).toContain('no numeric field "absent"');
  });
});

describe("tracker measurement gate: evaluation", () => {
  const measurements = () => ({
    dependency_kind: new Map([["blocks", 3]]),
    validate_warning: new Map(),
    graph_profile: new Map(),
  });

  it("passes a population at its declared ceiling", async () => {
    const { module } = await loadGate();
    const result = module.evaluateDeclarations({
      declarations: [{ ...DECLARATION, ceiling: 3 }],
      measurements: measurements(),
      ownerStatuses: new Map([["pm-owner", "open"]]),
    });
    expect(result.violations).toHaveLength(0);
    expect(result.observations[0]).toMatchObject({ observed: 3, ok: true, reason: "within_ceiling" });
  });

  it("fails a population that grew past the number its owner filed", async () => {
    const { module } = await loadGate();
    const result = module.evaluateDeclarations({
      declarations: [DECLARATION],
      measurements: measurements(),
      ownerStatuses: new Map([["pm-owner", "open"]]),
      contributors: new Map([["dependency_kind:blocks", [{ item_id: "pm-new" }]]]),
    });
    expect(result.violations).toHaveLength(1);
    expect(module.formatViolation(result.violations[0])).toContain("+1 since it was filed");
    expect(module.formatViolation(result.violations[0])).toContain("ceiling_exceeded");
    expect(module.formatViolation(result.violations[0])).toContain("pm-new-><target>@unknown");
    expect(result.violations[0].contributors).toEqual([{ item_id: "pm-new" }]);
  });

  it("fails closed when an exhaustive source contains an undeclared key", async () => {
    const { module } = await loadGate();
    const result = module.evaluateDeclarations({
      declarations: [],
      measurements: {
        dependency_kind: new Map(),
        validate_warning: new Map([["new_warning", 1]]),
        graph_profile: new Map(),
        health_check: new Map([["new_check", 0]]),
      },
      ownerStatuses: new Map(),
    });
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((entry) => entry.selector)).toEqual([
      "validate_warning:new_warning",
      "health_check:new_check",
    ]);
    expect(result.violations[0].reason).toBe("undeclared_population");
  });

  it("accepts declared exhaustive keys and executes their selector projection", async () => {
    const { module } = await loadGate();
    const result = module.evaluateDeclarations({
      declarations: [
        {
          id: "warning",
          owner: "pm-owner",
          selector: { source: "validate_warning", code: "known_warning" },
          ceiling: 1,
        },
      ],
      measurements: {
        dependency_kind: new Map(),
        validate_warning: new Map([["known_warning", 1]]),
        graph_profile: new Map(),
        health_check: new Map(),
      },
      ownerStatuses: new Map([["pm-owner", "open"]]),
    });
    expect(result.violations).toHaveLength(0);
  });

  it("retires a ceiling whose owning item reached a terminal status", async () => {
    const { module } = await loadGate();
    for (const status of ["closed", "canceled"]) {
      const result = module.evaluateDeclarations({
        declarations: [DECLARATION],
        measurements: measurements(),
        ownerStatuses: new Map([["pm-owner", status]]),
      });
      expect(result.violations).toHaveLength(0);
      expect(result.observations[0]).toMatchObject({ retired: true, reason: "retired_with_owner" });
    }
  });

  it("fails a declaration whose owner is absent, whose selector is broken, or whose ceiling is not a count", async () => {
    const { module } = await loadGate();
    const missingOwner = module.evaluateDeclarations({
      declarations: [DECLARATION],
      measurements: measurements(),
      ownerStatuses: new Map(),
    });
    expect(missingOwner.violations[0]).toMatchObject({ reason: "owner_not_found", observed: null });
    expect(module.formatViolation(missingOwner.violations[0])).toContain("unmeasured");

    const brokenSelector = module.evaluateDeclarations({
      declarations: [{ ...DECLARATION, selector: { source: "nope" } }],
      measurements: measurements(),
      ownerStatuses: new Map([["pm-owner", "open"]]),
    });
    expect(brokenSelector.violations[0].reason).toContain("unusable selector");

    const badCeiling = module.evaluateDeclarations({
      declarations: [{ ...DECLARATION, ceiling: -1 }, { ...DECLARATION, ceiling: 1.5 }],
      measurements: measurements(),
      ownerStatuses: new Map([["pm-owner", "open"]]),
    });
    expect(badCeiling.violations).toHaveLength(2);
    expect(badCeiling.violations[0].reason).toBe("ceiling_not_a_count");

    expect(module.evaluateDeclarations({ declarations: null, measurements: measurements() }).observations)
      .toHaveLength(0);
  });

  it("ratchets observed improvements down but never raises, retires, or invents measurements", async () => {
    const { module } = await loadGate();
    const document = {
      version: 1,
      declarations: [
        { id: "a", ceiling: 1 },
        { id: "b", ceiling: 1 },
        { id: "c", ceiling: 1 },
        { id: "d", ceiling: 1 },
        { id: "e", ceiling: 1, measured_on: "2026-08-03" },
      ],
    };
    const updated = module.buildUpdatedDeclarations(
      document,
      {
        observations: [
          { id: "a", observed: 0, retired: false },
          { id: "b", observed: null, retired: false },
          { id: "c", observed: 4, retired: true },
          { id: "e", observed: 1, retired: false },
        ],
      },
      "2026-08-04",
    );
    expect(updated.declarations[0]).toEqual({ id: "a", ceiling: 0, measured_on: "2026-08-04" });
    expect(updated.declarations[1]).toEqual({ id: "b", ceiling: 1 });
    expect(updated.declarations[2]).toEqual({ id: "c", ceiling: 1 });
    expect(updated.declarations[3]).toEqual({ id: "d", ceiling: 1 });
    expect(updated.declarations[4]).toEqual({ id: "e", ceiling: 1, measured_on: "2026-08-03" });
  });
});

describe("tracker measurement gate: tracker access", () => {
  it("collects only the measurements the declared selectors need", async () => {
    const { module, spawnSync } = await loadGate({ spawn: trackerSpawn() });
    const context = module.cliContext(new Map());
    const onlyDependencies = module.measureTracker(context, [DECLARATION]);
    expect(onlyDependencies.item_count).toBe(3);
    expect(onlyDependencies.measurements.dependency_kind.get("blocks")).toBe(2);
    expect(onlyDependencies.measurements.validate_warning.size).toBe(0);
    expect(onlyDependencies.measurements.graph_profile.size).toBe(0);
    expect(spawnSync).toHaveBeenCalledTimes(1);

    const everything = module.measureTracker(context, [
      DECLARATION,
      { selector: { source: "validate_warning", code: "validate_files_missing_linked_paths" } },
      { selector: { source: "graph_profile", field: "isolated_active_nodes" } },
      { selector: { source: "health_check", name: "storage" } },
    ]);
    expect(everything.measurements.validate_warning.get("validate_files_missing_linked_paths")).toBe(7);
    expect(everything.measurements.graph_profile.get("isolated_active_nodes")).toBe(0);
    expect(everything.measurements.health_check.get("storage")).toBe(0);
    expect(everything.ownerStatuses.get("pm-closed")).toBe("closed");
  });

  it("runs the graph audit once for both graph-derived sources and not at all for neither", async () => {
    const { module, spawnSync } = await loadGate({ spawn: trackerSpawn() });
    const context = module.cliContext(new Map());

    const neither = module.resolveGraphAuditMeasurements(context, new Set<string>());
    expect(neither.graph_profile.size).toBe(0);
    expect(neither.graph_finding.size).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();

    const both = module.resolveGraphAuditMeasurements(
      context,
      new Set(["graph_profile", "graph_finding"]),
    );
    expect(both.graph_profile.get("isolated_active_nodes")).toBe(0);
    expect(both.graph_finding.get("duplicate_dependency_row")).toBe(3);
    expect(both.graph_finding.get("legacy_ordering_cycle")).toBe(9);
    // One invocation serves both projections of the same report.
    expect(spawnSync).toHaveBeenCalledTimes(1);

    const findingsOnly = module.resolveGraphAuditMeasurements(
      context,
      new Set(["graph_finding"]),
    );
    expect(findingsOnly.graph_profile.size).toBe(0);
    expect(findingsOnly.graph_finding.get("duplicate_dependency_row")).toBe(3);
  });

  it("treats an undeclared graph finding code as a class nothing has ratcheted", async () => {
    const { module } = await loadGate({ spawn: trackerSpawn() });
    const measured = module.measureTracker(module.cliContext(new Map()), [
      DECLARATION,
      { selector: { source: "graph_finding", code: "duplicate_dependency_row" } },
    ]);
    expect(measured.measurements.graph_finding.get("duplicate_dependency_row")).toBe(3);
    const evaluation = module.evaluateDeclarations({
      declarations: [
        {
          id: "graph-finding-duplicate-dependency-row",
          owner: "pm-owner",
          selector: { source: "graph_finding", code: "duplicate_dependency_row" },
          ceiling: 0,
        },
      ],
      measurements: measured.measurements,
      ownerStatuses: new Map([["pm-owner", "open"]]),
    });
    const codes = evaluation.violations.map((violation) => violation.selector);
    // The declared class exceeds its ceiling, and the grouped cycle class is
    // reported as undeclared because graph_finding is an exhaustive source.
    expect(codes).toContain("graph_finding:duplicate_dependency_row");
    expect(codes).toContain("graph_finding:legacy_ordering_cycle");
  });

  it("tolerates a listing envelope without an items array", async () => {
    const { module } = await loadGate({ spawn: trackerSpawn({ listing: {} }) });
    const result = module.measureTracker(module.cliContext(new Map()), [DECLARATION]);
    expect(result.item_count).toBe(0);
  });

  it("targets an explicit bin and tracker path when asked, and this checkout otherwise", async () => {
    const { module } = await loadGate();
    const local = module.cliContext(new Map());
    expect(local.pmBin).toBe(process.execPath);
    expect((local.pmPrefixArgs as string[])[0]).toContain("cli.js");
    expect(local.env).toEqual({});

    const remote = module.cliContext(
      new Map<string, string | true>([
        ["pm-bin", "/usr/bin/pm"],
        ["pm-path", "/sandbox/.agents/pm"],
      ]),
    );
    expect(remote.pmBin).toBe("/usr/bin/pm");
    expect(remote.pmPrefixArgs).toEqual([]);
    expect(remote.env).toMatchObject({ PM_PATH: "/sandbox/.agents/pm", PM_NO_TELEMETRY: "1" });
  });

  it("materializes only the files the next commit would carry, and reports pending deletions", async () => {
    const { module, spawnSync, linkSync, copyFileSync, mkdirSync } = await loadGate({
      spawn: trackerSpawn(),
      missingSources: ["/repo/src/deleted.ts"],
    });
    const view = module.materializeCommitView("/repo");
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(view.root).toContain("pm-tracker-commit-view-");
    expect(view.materialized_file_count).toBe(1);
    expect(view.pending_deletion_count).toBe(1);
    expect(mkdirSync).toHaveBeenCalledTimes(1);
    expect(linkSync).toHaveBeenCalledTimes(1);
    expect(copyFileSync).not.toHaveBeenCalled();
  });

  it("falls back to a byte copy on a filesystem that refuses hardlinks", async () => {
    const { module, linkSync, copyFileSync } = await loadGate({
      spawn: trackerSpawn(),
      refuseLinks: true,
    });
    expect(module.materializeCommitView("/repo").materialized_file_count).toBe(2);
    expect(linkSync).toHaveBeenCalledTimes(2);
    expect(copyFileSync).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the committable file set cannot be enumerated", async () => {
    const { module, exit, stderr } = await loadGate({ spawn: trackerSpawn({ gitStatus: 128 }) });
    expect(() => module.materializeCommitView("/repo")).toThrow("EXIT:1");
    expect(errorText(stderr)).toContain("could not enumerate committable files in /repo");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("treats an enumeration that reported no status, no stdout and no stderr as a failure", async () => {
    const { module, exit, stderr } = await loadGate({
      spawn: () => ({}) as unknown as SpawnResult,
    });
    expect(() => module.materializeCommitView("/repo")).toThrow("EXIT:1");
    expect(errorText(stderr)).toContain("could not enumerate committable files in /repo");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("materializes nothing when the enumeration succeeds with no stdout", async () => {
    const { module, mkdirSync } = await loadGate({
      spawn: () => ({ status: 0 }) as unknown as SpawnResult,
    });
    const view = module.materializeCommitView("/repo");
    expect(view.materialized_file_count).toBe(0);
    expect(view.pending_deletion_count).toBe(0);
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it("redirects a measurement context at the commit view without losing its bin resolution", async () => {
    const { module } = await loadGate();
    const redirected = module.contextForCommitView(module.cliContext(new Map()), { root: "/view" });
    expect(redirected.cwd).toBe("/view");
    expect(redirected.env).toMatchObject({
      PM_PATH: expect.stringContaining("view"),
      PM_GLOBAL_PATH: expect.stringContaining("view"),
      PM_NO_TELEMETRY: "1",
    });
    expect((redirected.pmPrefixArgs as string[])[0]).toContain("cli.js");
  });

  it("renders a violation whose declaration carries no id, owner, or owner status", async () => {
    const { module } = await loadGate();
    expect(
      module.formatViolation({
        selector: "dependency_kind:blocks",
        ceiling: 0,
        observed: null,
        reason: "owner_not_found",
      }),
    ).toBe(
      "<unnamed> [dependency_kind:blocks] owner <none> (unknown): declared 0, observed unmeasured — owner_not_found",
    );
    expect(
      module.formatViolation({
        id: "growth",
        owner: "pm-owner",
        owner_status: "open",
        selector: "dependency_kind:blocks",
        ceiling: 0,
        observed: 1,
        reason: "ceiling_exceeded",
        contributors: [{}],
      }),
    ).toContain("<item>-><target>@unknown unknown-time unknown-source");
  });

  it("treats a spawn that reported no status and no stderr as a failure", async () => {
    const { module, exit, stderr } = await loadGate({
      spawn: () => ({}) as never,
    });
    expect(() => module.measureTracker(module.cliContext(new Map()), [DECLARATION])).toThrow("EXIT:1");
    expect(errorText(stderr)).toContain("Tracker measurement command failed");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails loudly when a tracker command exits non-zero", async () => {
    const { module, exit, stderr } = await loadGate({
      spawn: () => ({ status: 2, stdout: "", stderr: "boom" }),
    });
    expect(() => module.measureTracker(module.cliContext(new Map()), [DECLARATION])).toThrow("EXIT:1");
    expect(errorText(stderr)).toContain("boom");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails closed with bounded output when a tracker command emits invalid JSON", async () => {
    const invalid = `warning banner ${"x".repeat(600)}UNIQUE_TRUNCATED_TAIL`;
    const { module, exit, stderr } = await loadGate({
      spawn: () => ({ status: 0, stdout: invalid, stderr: "" }),
    });
    expect(() => module.measureTracker(module.cliContext(new Map()), [DECLARATION])).toThrow("EXIT:1");
    expect(errorText(stderr)).toContain("Tracker measurement command returned unparsable JSON");
    expect(errorText(stderr)).toContain(invalid.slice(0, 500));
    expect(errorText(stderr)).not.toContain("UNIQUE_TRUNCATED_TAIL");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("tracker measurement gate: entrypoint", () => {
  const declarationsPath = "/repo/declarations.json";
  const document = { version: 1, declarations: [DECLARATION] };

  it("passes and prints a receipt naming enforced and retired ceilings", async () => {
    const { module, stdout } = await loadGate({
      spawn: trackerSpawn(),
      files: { [declarationsPath]: JSON.stringify({ ...document, declarations: [{ ...DECLARATION, ceiling: 2 }] }) },
    });
    module.main(["--declarations", declarationsPath]);
    expect(stdoutText(stdout)).toContain(
      "Tracker measurement ratchet passed (1 enforced, 0 retired, 3 items, commit view of 2 committable files)",
    );
  });

  it("measures the working copy when asked, and whenever an explicit tracker path is given", async () => {
    const bypassed = await loadGate({
      spawn: trackerSpawn(),
      files: { [declarationsPath]: JSON.stringify({ ...document, declarations: [{ ...DECLARATION, ceiling: 2 }] }) },
    });
    bypassed.module.main(["--declarations", declarationsPath, "--working-copy"]);
    expect(stdoutText(bypassed.stdout)).toContain("working copy");
    expect(bypassed.spawnSync).not.toHaveBeenCalledWith("git", expect.anything(), expect.anything());

    const sandboxed = await loadGate({
      spawn: trackerSpawn(),
      files: { [declarationsPath]: JSON.stringify({ ...document, declarations: [{ ...DECLARATION, ceiling: 2 }] }) },
    });
    sandboxed.module.main(["--declarations", declarationsPath, "--pm-path", "/sandbox/.agents/pm"]);
    expect(stdoutText(sandboxed.stdout)).toContain("working copy");
  });

  it("removes the commit view even when the measurement pass fails", async () => {
    const { module, rmSync, exit } = await loadGate({
      spawn: (command) =>
        command === "git"
          ? { status: 0, stdout: COMMITTABLE, stderr: "" }
          : { status: 1, stdout: "", stderr: "tracker unavailable" },
      files: { [declarationsPath]: JSON.stringify(document) },
    });
    expect(() => module.main(["--declarations", declarationsPath])).toThrow("EXIT:1");
    expect(rmSync).toHaveBeenCalledWith(expect.stringContaining("pm-tracker-commit-view-"), {
      recursive: true,
      force: true,
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails the build when an observed population exceeds its declared ceiling", async () => {
    const { module, exit, stderr } = await loadGate({
      spawn: trackerSpawn(),
      files: { [declarationsPath]: JSON.stringify({ ...document, declarations: [{ ...DECLARATION, ceiling: 1 }] }) },
    });
    expect(() => module.main(["--declarations", declarationsPath])).toThrow("EXIT:1");
    expect(errorText(stderr)).toContain("Tracker measurement ratchet failed");
    expect(errorText(stderr)).toContain("A filed measurement is a ceiling");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("emits a machine-readable report under --json", async () => {
    const { module, stdout } = await loadGate({
      spawn: trackerSpawn(),
      files: { [declarationsPath]: JSON.stringify({ ...document, declarations: [{ ...DECLARATION, ceiling: 2 }] }) },
    });
    module.main(["--declarations", declarationsPath, "--json"]);
    const report = JSON.parse(stdoutText(stdout)) as { ok: boolean; item_count: number };
    expect(report.ok).toBe(true);
    expect(report.item_count).toBe(3);
  });

  it("refuses to absorb a regression under --update", async () => {
    const { module, writes, exit, stderr } = await loadGate({
      spawn: trackerSpawn(),
      files: { [declarationsPath]: JSON.stringify({ ...document, declarations: [{ ...DECLARATION, ceiling: 0 }] }) },
    });
    expect(() => module.main(["--declarations", declarationsPath, "--update"])).toThrow("EXIT:1");
    expect(writes[declarationsPath]).toBeUndefined();
    expect(errorText(stderr)).toContain("Refusing to update tracker measurements");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("writes a shrinking-only update when observation improves", async () => {
    const { module, writes, stdout } = await loadGate({
      spawn: trackerSpawn(),
      files: { [declarationsPath]: JSON.stringify({ ...document, declarations: [{ ...DECLARATION, ceiling: 3 }] }) },
    });
    module.main(["--declarations", declarationsPath, "--update"]);
    const written = JSON.parse(writes[declarationsPath]) as { declarations: { ceiling: number }[] };
    expect(written.declarations[0].ceiling).toBe(2);
    expect(stdoutText(stdout)).toContain("Updated tracker measurement declarations");
  });

  it("refuses a declaration document of an unsupported shape", async () => {
    const { module, exit } = await loadGate({
      files: { [declarationsPath]: JSON.stringify({ version: 99, declarations: [] }) },
    });
    expect(() => module.main(["--declarations", declarationsPath])).toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);

    const missing = await loadGate({ files: { [declarationsPath]: JSON.stringify({ version: 1 }) } });
    expect(() => missing.module.loadDocument(declarationsPath)).toThrow("EXIT:1");
  });

  it("proves the gate can fail by seeding a row beyond a declared ceiling of zero", async () => {
    const created: string[] = [];
    const spawn: SpawnHandler = (_command, args) => {
      const argv = args.join(" ");
      if (argv.includes("create")) {
        const id = `ctl-${String(created.length)}`;
        created.push(id);
        return { status: 0, stdout: JSON.stringify({ id }), stderr: "" };
      }
      if (argv.includes("list")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            items: [
              { id: "ctl-0", status: "open", dependencies: [] },
              { id: "ctl-1", status: "open", dependencies: [{ id: "ctl-0", kind: "blocks" }] },
            ],
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    };
    const { module, rmSync, stdout } = await loadGate({ spawn });
    module.main(["--negative-control"]);
    expect(stdoutText(stdout)).toContain("Tracker measurement negative control passed");
    expect(stdoutText(stdout)).toContain("declared 0, observed 1");
    expect(rmSync).toHaveBeenCalledWith(expect.stringContaining("pm-tracker-ratchet-fixed"), {
      recursive: true,
      force: true,
    });
  });

  it("fails the negative control when the seeded overshoot is not detected", async () => {
    const spawn: SpawnHandler = (_command, args) => {
      const argv = args.join(" ");
      if (argv.includes("create")) {
        return { status: 0, stdout: JSON.stringify({ id: "ctl-0" }), stderr: "" };
      }
      if (argv.includes("list")) {
        return {
          status: 0,
          stdout: JSON.stringify({ items: [{ id: "ctl-0", status: "open", dependencies: [] }] }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    };
    const { module, exit, rmSync, stderr } = await loadGate({ spawn });
    expect(() => module.runNegativeControl(new Map())).toThrow("EXIT:1");
    expect(errorText(stderr)).toContain("negative control did not fail");
    expect(exit).toHaveBeenCalledWith(1);
    expect(rmSync).toHaveBeenCalledWith(expect.stringContaining("pm-tracker-ratchet-fixed"), {
      recursive: true,
      force: true,
    });
  });
});
