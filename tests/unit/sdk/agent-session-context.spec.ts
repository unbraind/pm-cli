import { describe, expect, it } from "vitest";
import { createHistoryEntry } from "../../../src/core/history/history.js";
import {
  detectAgentIdentity,
  resolveAuthor,
  runWithHarnessDetectionSignals,
} from "../../../src/core/shared/author.js";
import { EMPTY_CANONICAL_DOCUMENT } from "../../../src/core/shared/constants.js";
import {
  agentSessionEnvironment,
  boundAgentEpisodeIdentity,
  resolveAgentSessionContextFromSignals,
  runWithAgentSessionContext,
} from "../../../src/sdk/agent-session-context.js";
import {
  groupHistoryByEpisode,
  resolveHistoryEpisodeGroupIdentity,
  summarizeAgentProvenance,
} from "../../../src/sdk/provenance.js";
import type { HistoryEntry, ItemDocument } from "../../../src/types.js";

const emptyDocument = EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument;

function historyEntry(
  ts: string,
  author: string,
  values: Partial<HistoryEntry>,
): HistoryEntry {
  return {
    ts,
    author,
    op: "test",
    patch: [],
    before_hash: "before",
    after_hash: "after",
    ...values,
  };
}

describe("agent session and episode context", () => {
  it("inherits one session declaration across SDK history writes and nested episodes", () => {
    const entries = runWithAgentSessionContext(
      {
        provenance: { role: "implementer", topic: "episode contracts" },
        episode: { id: "release-episode", label: "SDK release" },
      },
      () => {
        const parent = runWithHarnessDetectionSignals(
          { env: { CODEX_THREAD_ID: "thread-1" } },
          () => {
            const author = resolveAuthor(undefined, "");
            return createHistoryEntry({
              nowIso: "2026-08-01T10:00:00.000Z",
              author,
              op: "parent",
              before: emptyDocument,
              after: emptyDocument,
            });
          },
        );
        const child = runWithAgentSessionContext(
          { episode: { id: "release-review", label: "Review" } },
          () =>
            runWithHarnessDetectionSignals(
              { env: { CODEX_THREAD_ID: "thread-2" } },
              () => {
                const author = resolveAuthor(undefined, "");
                return createHistoryEntry({
                  nowIso: "2026-08-01T10:01:00.000Z",
                  author,
                  op: "child",
                  before: emptyDocument,
                  after: emptyDocument,
                });
              },
            ),
        );
        return [parent, child];
      },
    );

    expect(entries[0]).toMatchObject({
      agent_episode: { id: "release-episode", label: "SDK release" },
      agent_provenance: {
        role: { source: "session", value: "implementer" },
        topic: { source: "session", value: "episode contracts" },
      },
    });
    expect(entries[1]).toMatchObject({
      agent_episode: {
        id: "release-review",
        label: "Review",
        parent_id: "release-episode",
      },
      agent_provenance: {
        role: { source: "session", value: "implementer" },
        topic: { source: "session", value: "episode contracts" },
      },
    });
  });

  it("serializes a session declaration into inherited CLI environment signals", () => {
    const env = agentSessionEnvironment({
      provenance: { role: "grader", topic: "portable acceptance" },
      episode: {
        id: "episode-42",
        label: "Acceptance",
        parent_id: "programme-1",
      },
    });
    expect(env).toEqual({
      PM_AGENT_EPISODE_ID: "episode-42",
      PM_AGENT_EPISODE_LABEL: "Acceptance",
      PM_AGENT_EPISODE_PARENT_ID: "programme-1",
      PM_AGENT_SESSION_ROLE: "grader",
      PM_AGENT_SESSION_TOPIC: "portable acceptance",
    });
    expect(
      detectAgentIdentity({ env: { CODEX_THREAD_ID: "thread-3", ...env } }),
    ).toMatchObject({
      episode: {
        id: "episode-42",
        label: "Acceptance",
        parent_id: "programme-1",
      },
      provenance: {
        role: { source: "session", value: "grader" },
        topic: { source: "session", value: "portable acceptance" },
      },
    });
    expect(
      resolveAgentSessionContextFromSignals(
        { client_info: { episode: { id: "mcp-episode" } } },
        {},
      ),
    ).toEqual({ episode: { id: "mcp-episode" } });
  });

  it("bounds empty and malformed declarations without making context load-bearing", () => {
    expect(boundAgentEpisodeIdentity("not-an-object", false)).toBeUndefined();
    expect(resolveAgentSessionContextFromSignals({}, {})).toEqual({});
    expect(
      resolveAgentSessionContextFromSignals(
        { session_context: { provenance: { role: "reviewer" } } },
        {},
      ),
    ).toEqual({ provenance: { role: "reviewer" } });
    expect(agentSessionEnvironment({})).toEqual({});
    expect(
      agentSessionEnvironment({ episode: { id: "episode-only" } }),
    ).toEqual({ PM_AGENT_EPISODE_ID: "episode-only" });
    expect(
      agentSessionEnvironment({ provenance: { role: "reviewer" } }),
    ).toEqual({ PM_AGENT_SESSION_ROLE: "reviewer" });
    expect(() =>
      agentSessionEnvironment({ episode: { id: "invalid episode" } }),
    ).toThrow("Agent episode ids must be");
    expect(
      runWithAgentSessionContext({}, () =>
        resolveAgentSessionContextFromSignals({}, {}),
      ),
    ).toEqual({});
    expect(
      runWithAgentSessionContext({ episode: { id: "outer" } }, () =>
        runWithAgentSessionContext(
          { provenance: { topic: "inherited episode" } },
          () => detectAgentIdentity({ env: { CODEX_THREAD_ID: "thread-4" } }),
        ),
      ),
    ).toMatchObject({ episode: { id: "outer" } });
  });

  it("groups declared nested episodes order-independently and infers legacy cohorts", () => {
    const declaredParent = historyEntry(
      "2026-08-01T10:00:00.000Z",
      "harness:codex",
      { agent_episode: { id: "episode-1", label: "Build" } },
    );
    const declaredChild = historyEntry(
      "2026-08-01T10:02:00.000Z",
      "harness:codex",
      {
        agent_episode: {
          id: "episode-2",
          label: "Review",
          parent_id: "episode-1",
        },
      },
    );
    const inferred = historyEntry(
      "2026-08-01T10:03:00.000Z",
      "harness:claude-code",
      { agent_instance: "legacy-session" },
    );
    const declaredChildContinuation = historyEntry(
      "2026-08-01T10:02:30.000Z",
      "harness:codex",
      {
        agent_episode: {
          id: "episode-2",
          label: "Review",
          parent_id: "episode-1",
        },
      },
    );
    const inferredAuthor = historyEntry(
      "2026-08-01T11:03:00.000Z",
      "harness:legacy",
      {},
    );

    expect(resolveHistoryEpisodeGroupIdentity(declaredParent)).toEqual({
      id: "episode-1",
      source: "declared",
    });
    expect(resolveHistoryEpisodeGroupIdentity(inferred)).toEqual({
      id: "inferred:instance:legacy-session",
      source: "inferred",
    });

    const forward = groupHistoryByEpisode([
      declaredParent,
      declaredChild,
      declaredChildContinuation,
      inferred,
      inferredAuthor,
    ]);
    const reverse = groupHistoryByEpisode([
      inferredAuthor,
      inferred,
      declaredChildContinuation,
      declaredChild,
      declaredParent,
    ]);
    expect(reverse).toEqual(forward);
    expect(forward).toMatchObject([
      {
        id: "episode-1",
        source: "declared",
        children: [{ id: "episode-2", source: "declared", entries: [{}, {}] }],
      },
      {
        id: "inferred:instance:legacy-session",
        source: "inferred",
        children: [],
      },
      {
        id: "inferred:author:harness:legacy:2026-08-01T11",
        source: "inferred",
        children: [],
      },
    ]);
  });

  it("keeps declared and inferred namespaces distinct and roots malformed ancestry", () => {
    const declaredCollision = historyEntry(
      "2026-08-01T10:00:00.000Z",
      "harness:codex",
      { agent_episode: { id: "inferred:instance:shared" } },
    );
    const inferredCollision = historyEntry(
      "2026-08-01T10:00:00.000Z",
      "harness:codex",
      { agent_instance: "shared", after_hash: "legacy" },
    );
    const missingParent = historyEntry(
      "2026-08-01T10:01:00.000Z",
      "harness:codex",
      { agent_episode: { id: "orphan", parent_id: "absent" } },
    );
    const cycleA = historyEntry("2026-08-01T10:02:00.000Z", "harness:codex", {
      agent_episode: { id: "cycle-a", parent_id: "cycle-b" },
    });
    const cycleB = historyEntry("2026-08-01T10:03:00.000Z", "harness:codex", {
      agent_episode: { id: "cycle-b", parent_id: "cycle-a" },
    });

    const groups = groupHistoryByEpisode([
      cycleB,
      inferredCollision,
      missingParent,
      cycleA,
      declaredCollision,
    ]);
    expect(groups).toHaveLength(5);
    expect(
      groups.filter((group) => group.id === "inferred:instance:shared"),
    ).toHaveLength(2);
    expect(groups.every((group) => group.children.length === 0)).toBe(true);
  });

  it("classifies observed, unavailable, and legacy provenance for every dimension", () => {
    const entries = [
      historyEntry("2026-08-01T10:00:00.000Z", "harness:codex", {
        agent_harness: "codex",
        agent_provenance: {
          effort: null,
          model: { source: "environment", value: "gpt-test" },
          role: null,
          topic: { source: "session", value: "coverage" },
        },
      }),
      historyEntry("2026-07-01T10:00:00.000Z", "harness:codex", {
        agent_harness: "codex",
      }),
    ];

    expect(summarizeAgentProvenance(entries)).toEqual([
      {
        harness: "codex",
        dimension: "effort",
        entries: 2,
        observed: 0,
        unavailable: 1,
        legacy_missing: 1,
        coverage: 0,
        inert: true,
      },
      {
        harness: "codex",
        dimension: "model",
        entries: 2,
        observed: 1,
        unavailable: 0,
        legacy_missing: 1,
        coverage: 1,
        inert: false,
      },
      {
        harness: "codex",
        dimension: "role",
        entries: 2,
        observed: 0,
        unavailable: 1,
        legacy_missing: 1,
        coverage: 0,
        inert: true,
      },
      {
        harness: "codex",
        dimension: "topic",
        entries: 2,
        observed: 1,
        unavailable: 0,
        legacy_missing: 1,
        coverage: 1,
        inert: false,
      },
      {
        harness: "codex",
        dimension: "version",
        entries: 2,
        observed: 0,
        unavailable: 0,
        legacy_missing: 2,
        coverage: null,
        inert: false,
      },
    ]);
  });

  it("reports null coverage when a dimension has only legacy history", () => {
    expect(summarizeAgentProvenance([{}])).toEqual([]);
    expect(
      summarizeAgentProvenance(
        [
          historyEntry("2026-01-01T00:00:00.000Z", "harness:legacy", {
            agent_harness: "legacy",
          }),
        ],
        ["topic"],
      ),
    ).toEqual([
      {
        harness: "legacy",
        dimension: "topic",
        entries: 1,
        observed: 0,
        unavailable: 0,
        legacy_missing: 1,
        coverage: null,
        inert: false,
      },
    ]);
  });
});
