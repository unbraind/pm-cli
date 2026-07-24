import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyInvocationAuthorOverride,
  acknowledgeUnknownAuthorHistoryEvents,
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
import { appendWorkspaceAuditEvent } from "../../../src/core/history/workspace-history.js";

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
        [
          JSON.stringify({ author: "agent" }),
          JSON.stringify({}),
          JSON.stringify({ ts: "not-a-date", author: "unknown" }),
          "",
        ].join("\n"),
      ),
    ).toEqual({
      checked_events: 3,
      unknown_event_count: 2,
      legacy_unknown_event_count: 2,
      actionable_unknown_event_count: 0,
      acknowledged_actionable_event_count: 0,
      samples: [
        { item_id: "pm-memory", line: 2 },
        { item_id: "pm-memory", line: 3 },
      ],
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
        JSON.stringify({
          ts: "2026-07-15T07:00:00.000Z",
          author: "unknown",
        }),
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
    await mkdir(path.join(historyDirectory, "_workspace.jsonl"));

    await expect(scanHistoryAuthorAttribution(pmRoot, 2)).resolves.toEqual({
      checked_streams: 2,
      checked_events: 5,
      unknown_event_count: 4,
      legacy_unknown_event_count: 3,
      actionable_unknown_event_count: 1,
      acknowledged_actionable_event_count: 0,
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
      legacy_unknown_event_count: 0,
      actionable_unknown_event_count: 0,
      acknowledged_actionable_event_count: 0,
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
    expect(stripGlobalBootstrapTokens(["--author", "--json", "list"])).toEqual([
      "list",
    ]);
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
    expect(
      program.options.find((option) => option.long === "--author")?.required,
    ).toBe(true);
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
      `${JSON.stringify({ ts: "2026-07-14T00:00:00.000Z", author: "unknown" })}\n`,
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
    expect(health.warnings).not.toContain("history_unknown_author_events:1");
    expect(
      health.checks.find((check) => check.name === "storage")?.details,
    ).toMatchObject({
      author_attribution: {
        unknown_event_count: 1,
        legacy_unknown_event_count: 1,
        actionable_unknown_event_count: 0,
      },
    });

    const validation = await runValidate({}, { path: pmRoot });
    expect(validation.ok).toBe(true);
    expect(validation.warnings).not.toContain(
      "validate_history_unknown_author_events:1",
    );
    const filesOnlyValidation = await runValidate(
      { checkFiles: true },
      { path: pmRoot },
    );
    expect(filesOnlyValidation.warnings).not.toContain(
      "validate_history_unknown_author_events:1",
    );

    await writeFile(
      path.join(pmRoot, "history", "pm-actionable.jsonl"),
      `${JSON.stringify({ ts: "2026-07-15T07:00:00.000Z", author: "unknown" })}\n`,
    );
    const actionableHealth = await runHealth(
      { path: pmRoot },
      {
        checkOnly: true,
        skipIntegrity: true,
        skipDrift: true,
        skipVectors: true,
      },
    );
    expect(actionableHealth.warnings).toContain(
      "history_unknown_author_events:1",
    );
    expect(actionableHealth.ok).toBe(false);
    expect((await runValidate({}, { path: pmRoot })).warnings).toContain(
      "validate_history_unknown_author_events:1",
    );
  });

  it("dispositions actionable unknown authors through append-only workspace history", async () => {
    const tempRoot = await createTempRoot();
    const pmRoot = path.join(tempRoot, ".agents", "pm");
    await runInit(
      undefined,
      { path: pmRoot },
      { defaults: true, agentGuidance: "skip" },
    );
    await writeFile(
      path.join(pmRoot, "history", "pm-actionable.jsonl"),
      [
        JSON.stringify({
          ts: "2026-07-15T07:00:00.000Z",
          author: "unknown",
        }),
        JSON.stringify({
          ts: "2026-07-15T08:00:00.000Z",
          author: "unknown",
        }),
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(pmRoot, "history", "pm-other.jsonl"),
      `${JSON.stringify({
        ts: "2026-07-15T09:00:00.000Z",
        author: "unknown",
      })}\n`,
    );
    await appendWorkspaceAuditEvent({
      pmRoot,
      op: "review-invalid-author-acknowledgments",
      author: "maintainer",
      context: {
        author_acknowledgment: {
          events: [
            null,
            "not-an-event",
            { item_id: 42, line: 1 },
            { item_id: "pm-actionable", line: 1.5 },
          ],
        },
      },
      message: "Invalid event shapes must not acknowledge history.",
      lockTtlSeconds: 30,
      lockWaitMs: 1000,
    });

    await expect(
      acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
        events: [
          { item_id: "pm-other", line: 1 },
          { item_id: "pm-actionable", line: 2 },
          { item_id: "pm-actionable", line: 1 },
          { item_id: "pm-actionable", line: 1 },
        ],
        attributed_author: "original-agent",
        reviewer: "maintainer",
        reason: "Reviewed immutable event provenance.",
      }),
    ).resolves.toMatchObject({ acknowledged: 3 });
    const scan = await scanHistoryAuthorAttribution(pmRoot);
    expect(scan).toMatchObject({
      unknown_event_count: 3,
      actionable_unknown_event_count: 0,
      acknowledged_actionable_event_count: 3,
      affected_item_ids: ["pm-actionable", "pm-other"],
      samples: [],
    });
    const workspaceHistory = await readFile(
      path.join(pmRoot, "history", "_workspace.jsonl"),
      "utf8",
    );
    expect(workspaceHistory).toContain('"op":"history:author-acknowledge"');
    expect(workspaceHistory).toContain('"attributed_author":"original-agent"');

    await expect(
      acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
        events: [{ item_id: "pm-actionable", line: 1 }],
        attributed_author: " ",
        reviewer: "maintainer",
        reason: "invalid",
      }),
    ).rejects.toThrow("Author acknowledgment requires");
    await expect(
      acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
        events: [{ item_id: "pm-actionable", line: 99 }],
        attributed_author: "original-agent",
        reviewer: "maintainer",
        reason: "invalid target",
      }),
    ).rejects.toThrow("is not readable");
    await expect(
      acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
        events: [{ item_id: "_workspace", line: 1 }],
        attributed_author: "original-agent",
        reviewer: "maintainer",
        reason: "not unknown",
      }),
    ).rejects.toThrow("is not an actionable unknown-author event");
  });
});
