import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "- Pending.",
  "",
  "## 2026.6.10",
  "- Older entry.",
].join("\n");

function mockFs(readFileSync: (target: string) => string, writeFileSync = vi.fn(), existsSync = () => false) {
  vi.doMock("node:fs", () => ({
    existsSync: vi.fn(existsSync),
    readFileSync: vi.fn(readFileSync),
    writeFileSync,
  }));
  return writeFileSync;
}

function changelogAndPackage(version = "2026.6.14", changelogText = changelog) {
  return (target: string) => {
    if (String(target).endsWith("CHANGELOG.md")) return changelogText;
    if (String(target).endsWith("package.json")) return JSON.stringify({ version });
    throw new Error(`unexpected readFileSync ${target}`);
  };
}

describe("generate-release-notes", () => {
  it("writes release notes to the output path and notes the skipped pm summary", async () => {
    const outputChangelog = [
      "# Changelog",
      "",
      "## [2026.6.14]",
      "- Added deterministic release smoke coverage.",
      "",
      "## [Unreleased]",
      "- Ongoing work.",
    ].join("\n");
    const writeFileSync = vi.fn();
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "log") {
        const tag = String(args[3] ?? "");
        return tag === "v2026.6.13" ? "2026-06-13T00:00:00.000Z\n" : "2026-06-14T00:00:00.000Z\n";
      }
      throw new Error(`Unexpected execFileSync: ${command} ${args.join(" ")}`);
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    mockFs(changelogAndPackage("2026.6.14", outputChangelog), writeFileSync);

    process.argv = [
      "node",
      "scripts/generate-release-notes.mjs",
      "--version",
      "2026.6.14",
      "--from",
      "v2026.6.13",
      "--output",
      "release-notes.md",
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await harness.importModule("scripts/generate-release-notes.mjs");

    const written = String(writeFileSync.mock.calls.at(-1)?.[1] ?? "");
    expect(written).toContain("# @unbrained/pm-cli 2026.6.14");
    expect(written).toContain("Source range: v2026.6.13...v2026.6.14");
    expect(written).toContain("dist/cli.js is not built; pm tracker summary skipped.");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Wrote release notes"));
  });

  it("prints usage and exits 0 on --help", async () => {
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn() }));
    mockFs(() => "");
    const exit = harness.mockProcessExit();
    process.argv = ["node", "scripts/generate-release-notes.mjs", "--help"];
    await expect(harness.importModule("scripts/generate-release-notes.mjs")).rejects.toThrow("EXIT:0");
    exit.mockRestore();
  });

  it("fails with exit 1 on an unknown flag", async () => {
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn() }));
    mockFs(() => "");
    const exit = harness.mockProcessExit();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = ["node", "scripts/generate-release-notes.mjs", "--mystery"];
    await expect(harness.importModule("scripts/generate-release-notes.mjs")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('Unknown flag "--mystery"');
    exit.mockRestore();
  });

  it("reads package version, resolves previous tag, loads pm items, and writes a stdout summary", async () => {
    const pmItems = {
      items: [
        {
          id: "pm-rel1",
          title: "Release pipeline hardening",
          type: "Chore",
          status: "closed",
          priority: 1,
          tags: ["release"],
          closed_at: "2026-06-12T00:00:00.000Z",
          updated_at: "2026-06-12T00:00:00.000Z",
        },
        {
          id: "pm-rel2",
          title: "Compatibility migration",
          type: "Bug",
          status: "closed",
          priority: 2,
          tags: [],
          updated_at: "2026-06-12T01:00:00.000Z",
          created_at: "2026-06-12T01:00:00.000Z",
        },
        {
          id: "pm-cancel",
          title: "release canceled item",
          type: "Task",
          status: "canceled",
          tags: ["release"],
          closed_at: "2026-06-12T02:00:00.000Z",
        },
        {
          id: "pm-other",
          title: "Unrelated closed work",
          type: "Task",
          status: "closed",
          closed_at: "2026-06-12T03:00:00.000Z",
        },
        {
          id: "pm-open",
          title: "Open release work",
          type: "Task",
          status: "open",
          tags: ["release"],
          updated_at: "2026-06-12T04:00:00.000Z",
        },
      ],
    };
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "tag") {
        return "v2026.6.14\nv2026.6.10\n\n";
      }
      if (command === "git" && args[0] === "log") {
        const tag = String(args[3] ?? "");
        return tag === "v2026.6.10" ? "2026-06-09T00:00:00.000Z" : "2026-06-14T00:00:00.000Z";
      }
      if (String(args[args.length - 1]) === "--json" || args.includes("list-all")) {
        return JSON.stringify(pmItems);
      }
      throw new Error(`unexpected execFileSync ${command} ${args.join(" ")}`);
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    mockFs(changelogAndPackage(), vi.fn(), () => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await harness.importModule("scripts/generate-release-notes.mjs");
    const out = stdoutWrite.mock.calls.map((call) => String(call[0])).join("");
    expect(out).toContain("# @unbrained/pm-cli 2026.6.14");
    expect(out).toContain("Source range: v2026.6.10...v2026.6.14");
    expect(out).toContain("Closed pm items in release window:");
    expect(out).toContain("pm-rel1");
    expect(out).toContain("Compatibility migration");
    expect(out).not.toContain("pm-cancel");
  });

  it("falls back to PM_AUTHOR=release-notes when PM_AUTHOR is empty", async () => {
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "tag") return "";
      if (command === "git" && args[0] === "log") return "";
      return JSON.stringify({ items: [] });
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    mockFs(changelogAndPackage(), vi.fn(), () => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.env.PM_AUTHOR = "";
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await harness.importModule("scripts/generate-release-notes.mjs");
    expect(stdoutWrite).toHaveBeenCalled();

    const pmCall = execFileSync.mock.calls.find(([command]) => command === process.execPath);
    const pmEnv = (pmCall?.[2] as { env?: Record<string, string | undefined> } | undefined)?.env;
    expect(pmEnv?.PM_AUTHOR).toBe("release-notes");
  });

  it("reports no items and tolerates git tag/log failures plus invalid pm output", async () => {
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "tag") {
        throw new Error("no tags");
      }
      if (command === "git" && args[0] === "log") {
        throw new Error("no log");
      }
      return JSON.stringify({ items: "broken" });
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    mockFs(changelogAndPackage(), vi.fn(), () => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await harness.importModule("scripts/generate-release-notes.mjs");
    const out = stdoutWrite.mock.calls.map((call) => String(call[0])).join("");
    expect(out).toContain("Source range: initial...v2026.6.14");
    expect(out).toContain("No closed pm tracker items were updated");
  });

  it("omits overflow release items beyond the first twenty", async () => {
    const manyReleaseItems = Array.from({ length: 25 }, (_, index) => ({
      id: `pm-r${index}`,
      title: `release item ${index}`,
      type: "Chore",
      status: "closed",
      priority: 5,
      tags: ["release"],
      closed_at: "2026-06-12T00:00:00.000Z",
      updated_at: `2026-06-12T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "tag") return "";
      if (command === "git" && args[0] === "log") return "";
      return JSON.stringify({ items: manyReleaseItems });
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    mockFs(changelogAndPackage(), vi.fn(), () => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await harness.importModule("scripts/generate-release-notes.mjs");
    const out = stdoutWrite.mock.calls.map((call) => String(call[0])).join("");
    expect(out).toContain("more release-related tracker items omitted");
  });

  it("reports no release-tagged items when closed items exist but none are release-related", async () => {
    const items = [
      {
        id: "pm-plain",
        title: "Generic closed work",
        type: "Task",
        status: "closed",
        closed_at: "2026-06-12T00:00:00.000Z",
        updated_at: "2026-06-12T00:00:00.000Z",
      },
    ];
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "tag") return "";
      if (command === "git" && args[0] === "log") return "";
      return JSON.stringify({ items });
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    mockFs(changelogAndPackage(), vi.fn(), () => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await harness.importModule("scripts/generate-release-notes.mjs");
    const out = stdoutWrite.mock.calls.map((call) => String(call[0])).join("");
    expect(out).toContain("No release-tagged pm items found");
  });

  it.each([
    { label: "Error", thrown: () => new Error("pm crashed"), expected: "pm crashed" },
    {
      label: "non-Error",
      thrown: () => {
         
        throw "raw pm failure";
      },
      expected: "raw pm failure",
    },
  ])("surfaces a warning when the pm CLI throws a $label", async ({ thrown, expected }) => {
    const execFileSync = vi.fn((command: string) => {
      if (command === "git") return "";
      throw thrown();
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    mockFs(changelogAndPackage(), vi.fn(), () => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await harness.importModule("scripts/generate-release-notes.mjs");
    const out = stdoutWrite.mock.calls.map((call) => String(call[0])).join("");
    expect(out).toContain(`pm tracker summary skipped: ${expected}`);
  });

  it("fails when no changelog section matches the version or Unreleased", async () => {
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));
    mockFs(changelogAndPackage("2026.6.14", "# Changelog\n\nNothing here.\n"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = harness.mockProcessExit();
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await expect(harness.importModule("scripts/generate-release-notes.mjs")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Could not find CHANGELOG.md section");
    exit.mockRestore();
  });

  it("fails when package.json has no valid version", async () => {
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));
    mockFs((target: string) => {
      if (String(target).endsWith("package.json")) return JSON.stringify({ version: "   " });
      return "";
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = harness.mockProcessExit();
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await expect(harness.importModule("scripts/generate-release-notes.mjs")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("package.json is missing a valid version");
    exit.mockRestore();
  });

  it.each(["--version", "--from", "--output"])("rejects %s when its required value is missing", async (flag) => {
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));
    mockFs(() => "");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = harness.mockProcessExit();
    process.argv = ["node", "scripts/generate-release-notes.mjs", flag];
    await expect(harness.importModule("scripts/generate-release-notes.mjs")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain(`${flag} requires a value`);
    exit.mockRestore();
  });

  it("applies defaults for non-string item fields and extracts a last-section changelog", async () => {
    const lastSectionChangelog = ["# Changelog", "", "## [2026.6.14]", "- Final section entry."].join("\n");
    const items = [
      {
        id: 123,
        title: 999,
        type: 7,
        status: "closed",
        tags: ["release"],
        closed_at: "2026-06-12T00:00:00.000Z",
      },
      {
        id: "pm-x",
        title: "Compatibility tweak",
        status: "closed",
        closed_at: "2026-06-12T00:00:01.000Z",
      },
      {
        id: "pm-upd",
        title: "release via updated_at",
        status: "closed",
        priority: 1,
        tags: ["release"],
        updated_at: "2026-06-12T00:00:02.000Z",
      },
      {
        id: "pm-cre",
        title: "release via created_at",
        status: "closed",
        priority: 1,
        tags: ["release"],
        created_at: "2026-06-12T00:00:03.000Z",
      },
      {
        id: "pm-numts",
        title: "release numeric ts",
        status: "closed",
        closed_at: 123456,
      },
      {
        id: "pm-numstatus",
        title: "release weird status",
        status: 5,
        closed_at: "2026-06-12T00:00:04.000Z",
      },
    ];
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "tag") return "";
      if (command === "git" && args[0] === "log") return "";
      return JSON.stringify({ items });
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    mockFs(changelogAndPackage("2026.6.14", lastSectionChangelog), vi.fn(), () => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs"];
    await harness.importModule("scripts/generate-release-notes.mjs");
    const out = stdoutWrite.mock.calls.map((call) => String(call[0])).join("");
    expect(out).toContain("Final section entry");
    expect(out).toContain("[Unknown/closed] Untitled");
    expect(out).toContain("By type:");
  });

  it("ignores a bare -- separator argument", async () => {
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));
    mockFs(changelogAndPackage());
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "scripts/generate-release-notes.mjs", "--"];
    await harness.importModule("scripts/generate-release-notes.mjs");
    expect(stdoutWrite.mock.calls.map((call) => String(call[0])).join("")).toContain("# @unbrained/pm-cli 2026.6.14");
  });
});
