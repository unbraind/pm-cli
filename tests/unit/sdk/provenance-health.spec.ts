import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanProvenanceResolverHealth } from "../../../src/sdk/governance/provenance-health.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provenance resolver health", () => {
  it("returns an empty receipt when history storage is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-provenance-empty-"));
    tempRoots.push(root);
    await expect(scanProvenanceResolverHealth(root)).resolves.toEqual({
      outcomes: [],
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
      warnings: [
        "provenance_resolver_zero_success:claude-code:version:claude_session_file:1",
        "provenance_value_domain_invalid:claude-code:effort:single_digit:1",
        "provenance_value_domain_invalid:claude-code:role:boolean:1",
        "provenance_value_domain_invalid:claude-code:role:single_digit:1",
        "provenance_value_domain_invalid:claude-code:version:single_digit:1",
      ],
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
