import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

const ROOT_VERSION = "2026.7.11";

type JsonValue = Record<string, unknown>;

interface Scenario {
  args: string[];
  /** Repo-relative posix path -> parsed JSON content served by the fs mock. */
  files: Record<string, JsonValue>;
  /** Directory entries returned for the `packages/` scan. */
  packageDirs: string[];
}

interface WriteRecord {
  path: string;
  content: string;
}

/** Compare mocked manifest identities consistently across POSIX and Windows hosts. */
function normalize(filePath: string): string {
  return filePath.split("\\").join("/");
}

/** Resolve a mocked absolute path to the longest matching repo-relative key. */
function resolveKey(
  files: Record<string, JsonValue>,
  filePath: string,
): string | null {
  const normalized = normalize(filePath);
  const matches = Object.keys(files).filter(
    (key) => normalized === key || normalized.endsWith(`/${key}`),
  );
  if (matches.length === 0) {
    return null;
  }
  matches.sort((a, b) => b.length - a.length);
  return matches[0];
}

/** Model every supported manifest shape with coherent distribution versions and runtime pins. */
function inSyncFiles(): Record<string, JsonValue> {
  return {
    "package.json": { name: "@unbrained/pm-cli", version: ROOT_VERSION },
    "packages/pm-alpha/package.json": {
      name: "@unbrained/pm-alpha",
      version: ROOT_VERSION,
    },
    "plugins/pm-claude/.claude-plugin/plugin.json": {
      name: "pm-claude",
      version: ROOT_VERSION,
    },
    "plugins/pm-codex/.codex-plugin/plugin.json": {
      name: "pm-codex",
      version: ROOT_VERSION,
    },
    "plugins/pm-codex/plugin.json": {
      name: "pm-codex",
      version: ROOT_VERSION,
    },
    "plugins/pm-claude/package.json": {
      name: "pm-claude-runtime", version: ROOT_VERSION,
      dependencies: { "@unbrained/pm-cli": ROOT_VERSION },
    },
    "plugins/pm-codex/package.json": {
      name: "pm-codex-runtime", version: ROOT_VERSION,
      dependencies: { "@unbrained/pm-cli": ROOT_VERSION },
    },
    ".claude-plugin/marketplace.json": {
      name: "pm",
      metadata: { version: ROOT_VERSION },
      plugins: [{ name: "pm-claude", version: ROOT_VERSION }],
    },
    "marketplace.json": {
      name: "pm",
      metadata: { version: ROOT_VERSION },
      plugins: [{ name: "pm-claude", version: ROOT_VERSION }],
    },
    ".agents/plugins/marketplace.json": {
      name: "pm-local",
      // `metadata` without a string `version` and non-object/version-less
      // plugin entries exercise the slot-detection false branches.
      metadata: {},
      plugins: [
        null,
        { name: "pm-codex" },
        { name: "pm-claude", version: ROOT_VERSION },
      ],
    },
  };
}

/** Seed independent workspace, catalog, and runtime-pin drift for synchronization checks. */
function driftedFiles(): Record<string, JsonValue> {
  const files = inSyncFiles();
  files["packages/pm-alpha/package.json"] = {
    name: "@unbrained/pm-alpha",
    version: "0.1.0",
  };
  (
    files[".claude-plugin/marketplace.json"] as {
      metadata: { version: string };
    }
  ).metadata.version = "1.4.1";
  (
    files["marketplace.json"] as { plugins: Array<{ version: string }> }
  ).plugins[0].version = "1.4.1";
  (
    files[".agents/plugins/marketplace.json"] as {
      plugins: Array<{ version?: string } | null>;
    }
  ).plugins[2] = {
    version: "1.1.0",
  };
  (files["plugins/pm-claude/package.json"] as {
    dependencies: { "@unbrained/pm-cli": string };
  }).dependencies["@unbrained/pm-cli"] = "2026.7.10";
  files["plugins/pm-codex/plugin.json"].version = "2026.7.10";
  return files;
}

/** Execute the real synchronizer against a controlled filesystem and capture all writes and refusals. */
async function runSyncVersionsScenario(scenario: Scenario) {
  process.argv = ["node", "scripts/sync-versions.mjs", ...scenario.args];

  const writes: WriteRecord[] = [];
  const readFileSync = vi.fn((filePath: string) => {
    const key = resolveKey(scenario.files, filePath);
    if (key === null) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    return JSON.stringify(scenario.files[key], null, 2);
  });
  const writeFileSync = vi.fn((filePath: string, content: string) => {
    writes.push({ path: normalize(filePath), content });
  });
  const readdirSync = vi.fn(() => scenario.packageDirs);
  const existsSync = vi.fn(
    (filePath: string) => resolveKey(scenario.files, filePath) !== null,
  );
  vi.doMock("node:fs", () => ({
    existsSync,
    readdirSync,
    readFileSync,
    writeFileSync,
  }));

  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    logs.push(String(value ?? ""));
  });
  vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
    errors.push(String(value ?? ""));
  });
  const exitSpy = harness.mockProcessExit();

  let failure: unknown = null;
  try {
    await harness.importModule(
      "scripts/sync-versions.mjs",
      "syncVersionsScenario",
    );
  } catch (error) {
    failure = error;
  }
  exitSpy.mockRestore();
  return { failure, logs, errors, writes, readdirSync };
}

describe("scripts/sync-versions: check mode", () => {
  it("passes by default (no command) when every manifest matches the root version", async () => {
    const result = await runSyncVersionsScenario({
      args: [],
      files: inSyncFiles(),
      packageDirs: ["pm-alpha", "not-a-package"],
    });
    expect(result.failure).toBeNull();
    expect(result.logs.join("\n")).toContain(
      `Version sync check passed (${ROOT_VERSION}).`,
    );
    expect(result.writes).toEqual([]);
  });

  it("fails with one line per drifted slot and does not write", async () => {
    const result = await runSyncVersionsScenario({
      args: ["check"],
      files: driftedFiles(),
      packageDirs: ["pm-alpha"],
    });
    expect(result.failure).toEqual(new Error("EXIT:1"));
    const message = result.errors.join("\n");
    expect(message).toContain(`Version drift from root ${ROOT_VERSION}:`);
    expect(message).toContain(
      `${path.join("packages", "pm-alpha", "package.json")} version: 0.1.0 -> ${ROOT_VERSION}`,
    );
    expect(message).toContain(
      `.claude-plugin/marketplace.json metadata.version: 1.4.1 -> ${ROOT_VERSION}`,
    );
    expect(message).toContain(
      `marketplace.json plugins[0].version: 1.4.1 -> ${ROOT_VERSION}`,
    );
    expect(message).toContain(
      `.agents/plugins/marketplace.json plugins[2].version: 1.1.0 -> ${ROOT_VERSION}`,
    );
    expect(message).toContain(`plugins/pm-claude/package.json dependencies.@unbrained/pm-cli: 2026.7.10 -> ${ROOT_VERSION}`);
    expect(message).toContain(`plugins/pm-codex/plugin.json version: 2026.7.10 -> ${ROOT_VERSION}`);
    expect(message).toContain("pnpm version:sync");
    expect(result.writes).toEqual([]);
  });
});

describe("scripts/sync-versions: apply mode", () => {
  it("stamps the root version into every drifted manifest and reports each slot", async () => {
    const result = await runSyncVersionsScenario({
      args: ["apply"],
      files: driftedFiles(),
      packageDirs: ["pm-alpha"],
    });
    expect(result.failure).toBeNull();
    expect(result.logs.join("\n")).toContain(`Stamped ${ROOT_VERSION} into:`);

    const writtenPaths = result.writes.map(
      (write) => write.path.split("/").slice(-1)[0],
    );
    expect(result.writes).toHaveLength(6);
    expect(writtenPaths).toContain("package.json");
    expect(writtenPaths).toContain("marketplace.json");
    for (const write of result.writes) {
      expect(write.content.endsWith("\n")).toBe(true);
      expect(write.content).toContain(ROOT_VERSION);
      expect(write.content).not.toContain("0.1.0");
      expect(write.content).not.toContain("1.4.1");
      expect(write.content).not.toContain("1.1.0");
    }
  });

  it("reports when everything is already in sync and writes nothing", async () => {
    const result = await runSyncVersionsScenario({
      args: ["apply"],
      files: inSyncFiles(),
      packageDirs: ["pm-alpha"],
    });
    expect(result.failure).toBeNull();
    expect(result.logs.join("\n")).toContain(
      `All manifests already at ${ROOT_VERSION}.`,
    );
    expect(result.writes).toEqual([]);
  });
});

describe("scripts/sync-versions: guard rails", () => {
  it.each([undefined, null, 7])("rejects a portable plugin without a string version %#", async (version) => {
    const files = inSyncFiles();
    files["plugins/pm-codex/plugin.json"].version = version;
    const result = await runSyncVersionsScenario({ args: ["check"], files, packageDirs: ["pm-alpha"] });
    expect(result.failure).toEqual(new Error("EXIT:1"));
    expect(result.errors.join("\n")).toContain("plugins/pm-codex/plugin.json requires a string version");
    expect(result.writes).toEqual([]);
  });
  it.each([undefined, null, 7])("rejects malformed runtime versions in apply mode %#", async (version) => {
    const files = inSyncFiles();
    files["plugins/pm-claude/package.json"].version = version;
    const result = await runSyncVersionsScenario({ args: ["apply"], files, packageDirs: ["pm-alpha"] });
    expect(result.failure).toEqual(new Error("EXIT:1"));
    expect(result.errors.join("\n")).toContain("plugins/pm-claude/package.json");
    expect(result.writes).toEqual([]);
  });

  it.each(["pm-claude", "pm-codex"].flatMap((plugin) =>
    [undefined, null, {}, { "@unbrained/pm-cli": null }, { "@unbrained/pm-cli": 7 }]
      .map((dependencies) => ({ plugin, dependencies })),
  ))("rejects invalid runtime dependency declarations %#", async ({ plugin, dependencies }) => {
    const files = inSyncFiles();
    files[`plugins/${plugin}/package.json`] = { version: ROOT_VERSION, dependencies };
    const result = await runSyncVersionsScenario({ args: ["check"], files, packageDirs: ["pm-alpha"] });
    expect(result.failure).toEqual(new Error("EXIT:1"));
    expect(result.errors.join("\n")).toContain(`plugins/${plugin}/package.json`);
    expect(result.writes).toEqual([]);
  });

  it("rejects unknown commands", async () => {
    const result = await runSyncVersionsScenario({
      args: ["bump"],
      files: inSyncFiles(),
      packageDirs: [],
    });
    expect(result.failure).toEqual(new Error("EXIT:1"));
    expect(result.errors.join("\n")).toContain(
      'Unknown command "bump". Use "check" or "apply".',
    );
  });

  it("refuses to propagate a non-date-based root version", async () => {
    const files = inSyncFiles();
    files["package.json"] = { name: "@unbrained/pm-cli", version: "1.2.3" };
    const result = await runSyncVersionsScenario({
      args: ["check"],
      files,
      packageDirs: [],
    });
    expect(result.failure).toEqual(new Error("EXIT:1"));
    expect(result.errors.join("\n")).toContain(
      'Root package.json version "1.2.3" is not date-based',
    );
  });
});
