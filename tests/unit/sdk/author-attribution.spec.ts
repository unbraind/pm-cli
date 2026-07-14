import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyInvocationAuthorOverride,
  createPmCliProgram,
  inspectHistoryAuthorStream,
  runConfig,
  runInit,
  runProfileList,
  scanHistoryAuthorAttribution,
} from "../../../src/sdk/index.js";
import {
  parseBootstrapCommandName,
  parseBootstrapGlobalOptions,
  stripGlobalBootstrapTokens,
} from "../../../src/cli/bootstrap-args.js";
import { runHealth } from "../../../src/cli/commands/health.js";
import { runValidate } from "../../../src/cli/commands/validate.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
  );
});

async function createTempRoot(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-author-sdk-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

describe("SDK author attribution primitives", () => {
  it("inspects one in-memory stream through the public pure primitive", () => {
    expect(
      inspectHistoryAuthorStream(
        "pm-memory",
        `${JSON.stringify({ author: "agent" })}\n${JSON.stringify({})}\n`,
      ),
    ).toEqual({
      checked_events: 2,
      unknown_event_count: 1,
      samples: [{ item_id: "pm-memory", line: 2 }],
    });
  });

  it("scans valid events and bounds stable unknown-author samples", async () => {
    const pmRoot = await createTempRoot();
    const historyDirectory = path.join(pmRoot, "history");
    await mkdir(historyDirectory);
    await writeFile(
      path.join(historyDirectory, "pm-b.jsonl"),
      [
        JSON.stringify({ author: "agent-b" }),
        JSON.stringify({ author: "unknown" }),
        "not-json",
        JSON.stringify(null),
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(historyDirectory, "pm-a.jsonl"),
      `${JSON.stringify({})}\n${JSON.stringify({ author: "  " })}\n`,
    );
    await mkdir(path.join(historyDirectory, "pm-unreadable.jsonl"));

    await expect(scanHistoryAuthorAttribution(pmRoot, 2)).resolves.toEqual({
      checked_streams: 2,
      checked_events: 5,
      unknown_event_count: 4,
      affected_item_ids: ["pm-a", "pm-b"],
      samples: [
        { item_id: "pm-a", line: 1 },
        { item_id: "pm-a", line: 2 },
      ],
    });
    expect((await scanHistoryAuthorAttribution(pmRoot, -1)).samples).toEqual(
      [],
    );
  });

  it("returns an empty diagnostic when history is absent", async () => {
    await expect(
      scanHistoryAuthorAttribution(await createTempRoot()),
    ).resolves.toEqual({
      checked_streams: 0,
      checked_events: 0,
      unknown_event_count: 0,
      affected_item_ids: [],
      samples: [],
    });
  });

  it("scopes and restores invocation authors without leaking between hosts", () => {
    const previousAuthor = process.env.PM_AUTHOR;
    delete process.env.PM_AUTHOR;
    try {
      const restoreUnset = applyInvocationAuthorOverride(undefined);
      restoreUnset();
      expect(process.env.PM_AUTHOR).toBeUndefined();

      const restoreMissing = applyInvocationAuthorOverride(" agent-one ");
      expect(process.env.PM_AUTHOR).toBe("agent-one");
      restoreMissing();
      restoreMissing();
      expect(process.env.PM_AUTHOR).toBeUndefined();

      process.env.PM_AUTHOR = "prior-agent";
      const restorePrior = applyInvocationAuthorOverride("agent-two");
      restorePrior();
      expect(process.env.PM_AUTHOR).toBe("prior-agent");
      expect(() => applyInvocationAuthorOverride("   ")).toThrow(
        "--author requires a non-empty value",
      );
    } finally {
      if (previousAuthor === undefined) {
        delete process.env.PM_AUTHOR;
      } else {
        process.env.PM_AUTHOR = previousAuthor;
      }
    }
  });

  it("recognizes author overrides before or after command tokens", () => {
    expect(
      parseBootstrapGlobalOptions(["--author", "root-agent", "list"]),
    ).toMatchObject({ author: "root-agent" });
    expect(
      parseBootstrapGlobalOptions(["create", "--author=command-agent"]),
    ).toMatchObject({ author: "command-agent" });
    expect(parseBootstrapGlobalOptions(["--author"]).author).toBeUndefined();
    const flagFollowingAuthor = parseBootstrapGlobalOptions([
      "--author",
      "--json",
      "list",
    ]);
    expect(flagFollowingAuthor.author).toBeUndefined();
    expect(flagFollowingAuthor.json).toBe(true);
    expect(
      stripGlobalBootstrapTokens(["--author", "--json", "list"]),
    ).toEqual(["list"]);
    expect(parseBootstrapCommandName(["--author", "--json", "list"])).toBe(
      "list",
    );
    expect(
      stripGlobalBootstrapTokens([
        "--author",
        "agent",
        "create",
        "--author=override",
      ]),
    ).toEqual(["create"]);
    expect(parseBootstrapCommandName(["--author", "agent", "create"])).toBe(
      "create",
    );
    expect(parseBootstrapCommandName(["--author=agent", "list"])).toBe("list");
  });

  it("publishes SDK-owned CLI construction, config, profile, and init primitives", async () => {
    const program = createPmCliProgram("1.2.3");
    expect(program.version()).toBe("1.2.3");
    expect(program.options.some((option) => option.long === "--author")).toBe(
      true,
    );
    expect(typeof runConfig).toBe("function");
    expect(runProfileList().profiles.length).toBeGreaterThan(0);

    const tempRoot = await createTempRoot();
    const pmRoot = path.join(tempRoot, ".agents", "pm");
    const previousValues = {
      PM_AUTHOR: process.env.PM_AUTHOR,
    };
    delete process.env.PM_AUTHOR;
    try {
      const result = await runInit(
        undefined,
        { path: pmRoot },
        {
          defaults: true,
          agentGuidance: "skip",
        },
      );
      expect(result.settings.author_default).toBe(
        `${os.userInfo().username}@${os.hostname()}`,
      );
    } finally {
      for (const [key, value] of Object.entries(previousValues)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("surfaces unknown historical authors as non-blocking health and validate advice", async () => {
    const tempRoot = await createTempRoot();
    const pmRoot = path.join(tempRoot, ".agents", "pm");
    await runInit(
      undefined,
      { path: pmRoot },
      {
        defaults: true,
        agentGuidance: "skip",
      },
    );
    await writeFile(
      path.join(pmRoot, "history", "pm-legacy.jsonl"),
      `${JSON.stringify({ author: "unknown" })}\n`,
    );

    const health = await runHealth(
      { path: pmRoot },
      {
        checkOnly: true,
        skipIntegrity: true,
        skipDrift: true,
        skipVectors: true,
      },
    );
    expect(health.ok).toBe(true);
    expect(health.warnings).toContain("history_unknown_author_events:1");
    expect(
      health.checks.find((check) => check.name === "storage")?.details,
    ).toMatchObject({
      author_attribution: { unknown_event_count: 1 },
    });

    const validation = await runValidate({}, { path: pmRoot });
    expect(validation.ok).toBe(true);
    expect(validation.warnings).toContain(
      "validate_history_unknown_author_events:1",
    );
  });
});
