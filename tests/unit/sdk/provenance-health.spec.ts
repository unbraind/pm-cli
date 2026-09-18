import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listInvalidProvenanceHistoryStreamIds,
  scanProvenanceResolverHealth,
} from "../../../src/sdk/governance/provenance-health.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provenance resolver health", () => {
  it("reports the observed time range without pretending file order is chronological", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-provenance-window-"));
    tempRoots.push(root);
    await mkdir(path.join(root, "history"));
    const timestamps = [
      "2026-09-18T09:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      "2026-09-18T11:00:00.000+01:00",
      "invalid",
    ];
    await writeFile(
      path.join(root, "history", "window.jsonl"),
      timestamps.map((ts) => JSON.stringify({ ts })).join("\n"),
    );
    expect((await scanProvenanceResolverHealth(root)).sample).toMatchObject({
      earliest_event_at: "2026-08-01T00:00:00.000Z",
      latest_event_at: "2026-09-18T10:00:00.000Z",
      complete: true,
    });
    expect(await scanProvenanceResolverHealth(root, 0)).toMatchObject({
      events_read: 0,
      truncated: true,
      sample: { complete: false },
    });
    for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(scanProvenanceResolverHealth(root, limit)).rejects.toThrow(
        RangeError,
      );
    }
  });

  it("returns an empty receipt when history storage is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-provenance-empty-"));
    tempRoots.push(root);
    expect(await listInvalidProvenanceHistoryStreamIds(root)).toEqual([]);
    await expect(scanProvenanceResolverHealth(root)).resolves.toEqual({
      outcomes: [],
      sample: {
        scope: "history_prefix",
        event_limit: 10_000,
        byte_limit: 8_388_608,
        bytes_read: 0,
        events_read: 0,
        truncated: false,
        unreadable_sources: 1,
        malformed_events: 0,
        earliest_event_at: null,
        latest_event_at: null,
        complete: false,
      },
      invalid_values: [],
      warnings: [],
      events_read: 0,
      truncated: false,
    });
  });

  it("bounds malformed history and distinguishes failed and successful attempts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-provenance-health-"));
    tempRoots.push(root);
    const history = path.join(root, "history");
    await mkdir(history);
    await mkdir(path.join(history, "00-unreadable.jsonl"));
    try {
      await symlink(
        "missing-history-target",
        path.join(history, "01-missing.jsonl"),
      );
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
      if (!["EACCES", "ENOTSUP", "EPERM"].includes(code)) throw error;
    }
    const entries = [
      "not-json",
      "null",
      JSON.stringify({ context: null }),
      JSON.stringify({
        agent_harness: "legacy-host",
        context: { agent_provenance_outcomes: null },
      }),
      JSON.stringify({
        agent_harness: "claude-code",
        agent_provenance: {
          effort: { source: "legacy", value: "1" },
          role: { source: "legacy", value: true },
          topic: { source: "legacy", value: "delivery" },
          version: { source: "legacy", value: 7 },
        },
        context: {
          agent_provenance_outcomes: {
            ignored_null: null,
            ignored_no_resolver: { status: "failed" },
            ignored_unavailable: {
              status: "unavailable",
              resolver: "claude_session_file",
            },
            model: {
              status: "failed",
              resolver: "claude_session_file",
            },
          },
        },
      }),
      JSON.stringify({
        agent_harness: "claude-code",
        agent_provenance: {
          role: { source: "legacy", value: "1" },
        },
        context: {
          agent_provenance_outcomes: {
            effort: {
              status: "resolved",
              resolver: "ai_agent_version",
            },
            model: {
              status: "resolved",
              resolver: "claude_session_file",
            },
            role: {
              status: "resolved",
              resolver: "ai_agent_version",
            },
            version: {
              status: "failed",
              resolver: "claude_session_file",
            },
          },
        },
      }),
      JSON.stringify({
        agent_harness: "codex",
        context: {
          agent_provenance_outcomes: {
            version: {
              status: "resolved",
              resolver: "ai_agent_version",
            },
          },
        },
      }),
      JSON.stringify({
        agent_harness: "claude-code",
        context: {
          agent_provenance_outcomes: {
            model: {
              status: "resolved",
              resolver: "ai_agent_version",
            },
          },
        },
      }),
    ];
    await writeFile(
      path.join(history, "events.jsonl"),
      `\n${entries.join("\n")}\n`,
      "utf8",
    );

    const result = await scanProvenanceResolverHealth(root, 100);
    expect(result).toEqual({
      outcomes: [
        {
          harness: "claude-code",
          dimension: "effort",
          resolver: "ai_agent_version",
          attempts: 1,
          successes: 1,
        },
        {
          harness: "claude-code",
          dimension: "model",
          resolver: "ai_agent_version",
          attempts: 1,
          successes: 1,
        },
        {
          harness: "claude-code",
          dimension: "model",
          resolver: "claude_session_file",
          attempts: 2,
          successes: 1,
        },
        {
          harness: "claude-code",
          dimension: "role",
          resolver: "ai_agent_version",
          attempts: 1,
          successes: 1,
        },
        {
          harness: "claude-code",
          dimension: "version",
          resolver: "claude_session_file",
          attempts: 1,
          successes: 0,
        },
        {
          harness: "codex",
          dimension: "version",
          resolver: "ai_agent_version",
          attempts: 1,
          successes: 1,
        },
      ],
      warnings: [],
      sample: {
        scope: "history_prefix",
        event_limit: 100,
        byte_limit: 8_388_608,
        bytes_read: Buffer.byteLength(`\n${entries.join("\n")}\n`),
        events_read: entries.length,
        truncated: false,
        unreadable_sources: expect.any(Number),
        malformed_events: 2,
        earliest_event_at: null,
        latest_event_at: null,
        complete: false,
      },
      invalid_values: [
        {
          harness: "claude-code",
          dimension: "effort",
          kind: "single_digit",
          count: 1,
        },
        {
          harness: "claude-code",
          dimension: "role",
          kind: "boolean",
          count: 1,
        },
        {
          harness: "claude-code",
          dimension: "role",
          kind: "single_digit",
          count: 1,
        },
        {
          harness: "claude-code",
          dimension: "version",
          kind: "single_digit",
          count: 1,
        },
      ],
      events_read: entries.length,
      truncated: false,
    });
    expect(result.sample.unreadable_sources).toBeGreaterThanOrEqual(1);
    expect(await scanProvenanceResolverHealth(root, 1)).toMatchObject({
      events_read: 1,
      truncated: true,
      warnings: [],
    });
    await writeFile(
      path.join(history, "zz-after-limit.jsonl"),
      `${JSON.stringify({ agent_harness: "ignored" })}\n`,
      "utf8",
    );
    expect(await scanProvenanceResolverHealth(root, 1)).toMatchObject({
      events_read: 1,
      truncated: true,
      warnings: [],
    });
  });

  it("distinguishes an exact event boundary and bounds bytes before reading", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-provenance-bounds-"));
    tempRoots.push(root);
    const history = path.join(root, "history");
    await mkdir(history);
    const failed = JSON.stringify({
      agent_harness: "claude-code",
      context: {
        agent_provenance_outcomes: {
          model: { status: "failed", resolver: "claude_session_file" },
        },
      },
    });
    await writeFile(path.join(history, "one.jsonl"), `${failed}\n`, "utf8");

    await expect(scanProvenanceResolverHealth(root, 1)).resolves.toMatchObject({
      events_read: 1,
      truncated: false,
      warnings: [
        "provenance_resolver_zero_success:claude-code:model:claude_session_file:1",
      ],
    });
    await writeFile(
      path.join(history, "one.jsonl"),
      `${failed}\n${"x".repeat(8_388_608)}`,
      "utf8",
    );
    await expect(scanProvenanceResolverHealth(root, 10)).resolves.toMatchObject(
      {
        events_read: 1,
        truncated: true,
        warnings: [],
      },
    );
    await writeFile(
      path.join(history, "one.jsonl"),
      "x".repeat(8_388_609),
      "utf8",
    );
    await expect(scanProvenanceResolverHealth(root, 10)).resolves.toMatchObject(
      {
        events_read: 0,
        truncated: true,
        warnings: [],
      },
    );
  });
});
