import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyInvocationAuthorOverride,
  acknowledgeUnknownAuthorHistoryEvents,
  createPmCliProgram,
  EXIT_CODE,
  inspectHistoryAuthorStream,
  PmClient,
  PmCliError,
  runAction,
  runConfig,
  runInit,
  runProfileList,
  scanHistoryAuthorAttribution,
} from "../../../src/sdk/index.js";
import { registerMutationCommands } from "../../../src/cli/register-mutation.js";
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
  it("keeps PM_AUTHOR access and author precedence in one source seam", async () => {
    const sourceRoot = path.resolve("src");
    const sourceFiles = (await readdir(sourceRoot, { recursive: true }))
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => path.join(sourceRoot, entry));
    const directEnvironmentReaders: string[] = [];
    const privatePrecedenceHelpers: string[] = [];
    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, "utf8");
      if (source.includes("process.env.PM_AUTHOR")) {
        directEnvironmentReaders.push(path.relative(sourceRoot, sourceFile));
      }
      if (/\b(?:selectAuthor|toAuthor)\s*\(/u.test(source)) {
        privatePrecedenceHelpers.push(path.relative(sourceRoot, sourceFile));
      }
    }
    expect(directEnvironmentReaders).toEqual([
      path.join("core", "shared", "author.ts"),
    ]);
    expect(privatePrecedenceHelpers).toEqual([]);
  });
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
      samples_truncated: false,
      actionable_events: [],
    });
  });

  it("collects complete actionable coordinates only when requested", () => {
    const raw = JSON.stringify({
      ts: "2026-07-31T00:00:00.000Z",
      author: "unknown",
    });
    expect(inspectHistoryAuthorStream("pm-memory", raw)).toMatchObject({
      actionable_unknown_event_count: 1,
      actionable_events: [],
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
      samples_truncated: true,
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
      samples_truncated: false,
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
    const authorEnvironmentNames = [
      "PM_AUTHOR",
      "CLAUDE_CODE",
      "CLAUDECODE",
      "CODEX_HOME",
      "CODEX_CI",
      "CODEX_THREAD_ID",
      "PI_AGENT",
      "PI_CODING_AGENT",
      "OPENCODE",
      "OPENCODE_SESSION_ID",
      "CURSOR_AGENT",
      "CURSOR_TRACE_ID",
      "AIDER",
      "AIDER_MODEL",
      "GEMINI_CLI",
      "GEMINI_CLI_HOME",
      "CI",
      "GITHUB_ACTIONS",
      "BUILDKITE",
      "GITLAB_CI",
    ] as const;
    const previousValues = Object.fromEntries(
      authorEnvironmentNames.map((name) => [name, process.env[name]]),
    ) as Record<(typeof authorEnvironmentNames)[number], string | undefined>;
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
      expect(result.settings.author_default).toBe("");

      process.env.PM_AUTHOR = "environment-agent";
      const environmentRoot = path.join(
        tempRoot,
        "environment",
        ".agents",
        "pm",
      );
      const environmentResult = await runInit(
        undefined,
        { path: environmentRoot },
        {
          defaults: true,
          agentGuidance: "skip",
        },
      );
      expect(environmentResult.settings.author_default).toBe(
        "environment-agent",
      );

      for (const name of authorEnvironmentNames) {
        delete process.env[name];
      }
      const fallbackRoot = path.join(tempRoot, "fallback", ".agents", "pm");
      const fallbackResult = await runInit(
        undefined,
        { path: fallbackRoot },
        {
          defaults: true,
          agentGuidance: "skip",
        },
      );
      expect(fallbackResult.settings.author_default).toBe("");
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
      `${JSON.stringify({
        ts: "2026-07-14T00:00:00.000Z",
        author: "unknown",
        op: "delete",
      })}\n`,
    );

    const health = await runHealth(
      { path: pmRoot },
      {
        checkOnly: true,
        full: true,
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
        full: true,
        skipIntegrity: true,
        skipDrift: true,
        skipVectors: true,
      },
    );
    expect(actionableHealth.warnings).toContain(
      "history_unknown_author_events:1",
    );
    expect(actionableHealth.ok).toBe(false);
    const verboseHealth = await runHealth(
      { path: pmRoot },
      {
        checkOnly: true,
        full: true,
        skipIntegrity: true,
        skipDrift: true,
        skipVectors: true,
        verboseAuthorEvents: true,
      },
    );
    expect(
      verboseHealth.checks.find((check) => check.name === "storage")?.details,
    ).toMatchObject({
      author_attribution: {
        actionable_events: [{ item_id: "pm-actionable", line: 1 }],
      },
    });
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
    await writeFile(
      path.join(pmRoot, "history", "pm-attributed.jsonl"),
      `${JSON.stringify({
        ts: "2026-07-15T09:00:00.000Z",
        author: "agent",
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
        events: [{ item_id: "pm-attributed", line: 1 }],
        attributed_author: "original-agent",
        reviewer: "maintainer",
        reason: "not unknown",
      }),
    ).rejects.toThrow("is not an actionable unknown-author event");
    await expect(
      acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
        events: [{ item_id: "../outside", line: 1 }],
        attributed_author: "original-agent",
        reviewer: "maintainer",
        reason: "invalid item id",
      }),
    ).rejects.toThrow(
      "Unknown-author acknowledgment target ../outside:1 is not readable",
    );
  });

  it("classifies every acknowledgment argument refusal as an expected usage error", async () => {
    const tempRoot = await createTempRoot();
    const pmRoot = path.join(tempRoot, ".agents", "pm");
    await runInit(
      undefined,
      { path: pmRoot },
      { defaults: true, agentGuidance: "skip" },
    );
    await writeFile(
      path.join(pmRoot, "history", "pm-classified.jsonl"),
      `${JSON.stringify({
        ts: "2026-07-16T09:00:00.000Z",
        author: "unknown",
        op: "update",
      })}\n${JSON.stringify({
        ts: "2026-07-16T09:05:00.000Z",
        author: "maintainer",
        op: "update",
      })}\n`,
    );
    const baseOptions = {
      attributed_author: "original-agent",
      reviewer: "maintainer",
      reason: "Reviewed immutable event provenance.",
    };
    const refusals: { options: Record<string, unknown>; code: string }[] = [
      {
        options: {
          ...baseOptions,
          events: [{ item_id: "pm-classified", line: 1 }],
          all_actionable: true,
        },
        code: "history_author_acknowledge_selector_conflict",
      },
      {
        options: { ...baseOptions, reviewer: " ", events: [] },
        code: "history_author_acknowledge_required_values_missing",
      },
      {
        options: {
          ...baseOptions,
          events: [{ item_id: "pm-classified", line: 0 }],
        },
        code: "history_author_acknowledge_target_unreadable",
      },
      {
        options: {
          ...baseOptions,
          events: [{ item_id: "pm-classified", line: 2 }],
        },
        code: "history_author_acknowledge_target_not_actionable",
      },
    ];
    for (const refusal of refusals) {
      const error = await acknowledgeUnknownAuthorHistoryEvents(
        pmRoot,
        refusal.options as never,
      ).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(PmCliError);
      expect((error as PmCliError).exitCode).toBe(EXIT_CODE.USAGE);
      expect((error as PmCliError).code).toBe(refusal.code);
    }

    const unexpected = await acknowledgeUnknownAuthorHistoryEvents(
      pmRoot,
      { events: [{ item_id: "pm-classified", line: 1 }] } as never,
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(unexpected).toBeInstanceOf(Error);
    expect(unexpected).not.toBeInstanceOf(PmCliError);
  });

  it("exposes unknown-author disposition through the typed SDK client", async () => {
    const tempRoot = await createTempRoot();
    const pmRoot = path.join(tempRoot, ".agents", "pm");
    await runInit(
      undefined,
      { path: pmRoot },
      { defaults: true, agentGuidance: "skip" },
    );
    await writeFile(
      path.join(pmRoot, "history", "pm-sdk-action.jsonl"),
      `${JSON.stringify({
        ts: "2026-07-15T09:00:00.000Z",
        author: "unknown",
      })}\n`,
    );

    await expect(
      new PmClient({ pmRoot, noExtensions: true }).historyAuthorAcknowledge({
        events: [{ item_id: "pm-sdk-action", line: 1 }],
        attributed_author: "codex-agent",
        reviewer: "maintainer",
        reason: "Reviewed SDK action provenance.",
      }),
    ).resolves.toMatchObject({ acknowledged: 1 });
    await expect(scanHistoryAuthorAttribution(pmRoot)).resolves.toMatchObject({
      actionable_unknown_event_count: 0,
      acknowledged_actionable_event_count: 1,
    });
  });

  it("bulk-acknowledges the complete actionable set through SDK and CLI selectors", async () => {
    const tempRoot = await createTempRoot();
    const pmRoot = path.join(tempRoot, ".agents", "pm");
    await runInit(
      undefined,
      { path: pmRoot },
      { defaults: true, agentGuidance: "skip" },
    );
    await writeFile(
      path.join(pmRoot, "history", "pm-bulk.jsonl"),
      [
        JSON.stringify({
          ts: "2026-07-15T10:00:00.000Z",
          author: "unknown",
        }),
        JSON.stringify({
          ts: "2026-07-14T10:00:00.000Z",
          author: "unknown",
        }),
        "",
      ].join("\n"),
    );

    await expect(
      scanHistoryAuthorAttribution(pmRoot, 0, true),
    ).resolves.toMatchObject({
      actionable_unknown_event_count: 1,
      samples: [],
      samples_truncated: true,
      actionable_events: [{ item_id: "pm-bulk", line: 1 }],
    });
    await expect(
      new PmClient({ pmRoot, noExtensions: true }).historyAuthorAcknowledge({
        all_actionable: true,
        attributed_author: "bulk-agent",
        reviewer: "maintainer",
        reason: "Reviewed every actionable event.",
      }),
    ).resolves.toMatchObject({ acknowledged: 1 });
    await expect(scanHistoryAuthorAttribution(pmRoot)).resolves.toMatchObject({
      actionable_unknown_event_count: 0,
      legacy_unknown_event_count: 1,
      acknowledged_actionable_event_count: 1,
    });
    await expect(
      acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
        events: [{ item_id: "pm-bulk", line: 1 }],
        all_actionable: true,
        attributed_author: "bulk-agent",
        reviewer: "maintainer",
        reason: "Invalid mixed selectors.",
      }),
    ).rejects.toThrow("either explicit events or all_actionable");
    await expect(
      acknowledgeUnknownAuthorHistoryEvents(pmRoot, {
        attributed_author: "bulk-agent",
        reviewer: "maintainer",
        reason: "Missing selector.",
      }),
    ).rejects.toThrow(
      "requires events, reviewer, attributed_author, and reason",
    );

    const program = createPmCliProgram("1.0.0");
    registerMutationCommands(program);
    await expect(
      program.parseAsync(
        [
          "--pm-path",
          pmRoot,
          "history-author-acknowledge",
          "--all-actionable",
          "--event",
          "pm-bulk:1",
          "--attributed-author",
          "bulk-agent",
          "--reviewer",
          "maintainer",
          "--reason",
          "Invalid mixed selectors.",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow("Specify exactly one selector");

    const missingSelectorProgram = createPmCliProgram("1.0.0");
    registerMutationCommands(missingSelectorProgram);
    await expect(
      missingSelectorProgram.parseAsync(
        [
          "--pm-path",
          pmRoot,
          "history-author-acknowledge",
          "--attributed-author",
          "bulk-agent",
          "--reviewer",
          "maintainer",
          "--reason",
          "Missing selector.",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow("Specify exactly one selector");
  });

  it("exposes unknown-author disposition through CLI and MCP action surfaces", async () => {
    const tempRoot = await createTempRoot();
    const pmRoot = path.join(tempRoot, ".agents", "pm");
    await runInit(
      undefined,
      { path: pmRoot },
      { defaults: true, agentGuidance: "skip" },
    );
    await writeFile(
      path.join(pmRoot, "history", "pm-surface-action.jsonl"),
      [
        "2026-07-15T09:00:00.000Z",
        "2026-07-15T09:01:00.000Z",
        "2026-07-15T09:02:00.000Z",
        "2026-07-15T09:03:00.000Z",
      ]
        .map((ts) => JSON.stringify({ ts, author: "unknown" }))
        .join("\n") + "\n",
    );

    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const program = createPmCliProgram("1.0.0");
      registerMutationCommands(program);
      await program.parseAsync(
        [
          "--pm-path",
          pmRoot,
          "--json",
          "history-author-acknowledge",
          "--event",
          "pm-surface-action:1",
          "--attributed-author",
          "cli-agent",
          "--reviewer",
          "maintainer",
          "--reason",
          "Reviewed CLI provenance.",
        ],
        { from: "user" },
      );

      for (const invalidEvent of [
        "missing-line",
        "../outside:1",
        "pm-surface-action:not-a-number",
        "pm-surface-action:0",
      ]) {
        const invalidProgram = createPmCliProgram("1.0.0");
        registerMutationCommands(invalidProgram);
        await expect(
          invalidProgram.parseAsync(
            [
              "--pm-path",
              pmRoot,
              "history-author-acknowledge",
              "--event",
              invalidEvent,
              "--attributed-author",
              "cli-agent",
              "--reviewer",
              "maintainer",
              "--reason",
              "Invalid selector coverage.",
            ],
            { from: "user" },
          ),
        ).rejects.toThrow("expects <item-id>:<one-based-line>");
      }
    } finally {
      stdout.mockRestore();
    }

    await expect(
      runAction({
        action: "history-author-acknowledge",
        path: pmRoot,
        historyEvent: ["pm-surface-action:2"],
        attributed_author: "mcp-snake-agent",
        reviewer: "maintainer",
        reason: "Reviewed MCP snake-case provenance.",
      }),
    ).resolves.toMatchObject({ acknowledged: 1 });
    await expect(
      runAction({
        action: "history-author-acknowledge",
        path: pmRoot,
        historyEvent: ["pm-surface-action:3"],
        attributedAuthor: "mcp-agent",
        reviewer: "maintainer",
        reason: "Reviewed MCP provenance.",
      }),
    ).resolves.toMatchObject({ acknowledged: 1 });
    await expect(
      runAction({
        action: "history-author-acknowledge",
        path: pmRoot,
        historyEvent: ["pm-surface-action:4"],
      }),
    ).rejects.toThrow("Author acknowledgment requires");
    await expect(scanHistoryAuthorAttribution(pmRoot)).resolves.toMatchObject({
      actionable_unknown_event_count: 1,
      acknowledged_actionable_event_count: 3,
    });
  });
});
