import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseItemDocument,
  serializeItemDocument,
} from "../../../../src/core/item/item-format.js";
import { mergeItemDocuments } from "../../../../src/sdk/merge/three-way.js";
import { resolveLinkedTestTrustBatch } from "../../../../src/sdk/test/trust.js";
import type {
  ItemDocument,
  ItemTestRunSummary,
  LinkedTest,
} from "../../../../src/types/index.js";

function document(tests: LinkedTest[] = []): ItemDocument {
  return {
    metadata: {
      id: "pm-linked-trust",
      title: "linked trust",
      description: "merge provenance",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      created_at: "2026-08-22T12:00:00.000Z",
      updated_at: "2026-08-22T12:00:00.000Z",
      tests,
    },
    body: "",
  };
}

function linkedTest(command: string, sourceRef: string): LinkedTest {
  return {
    command,
    scope: "project",
    workspace_context_mode: "snapshot",
    provenance: {
      author: "maintainer",
      created_at: "2026-08-22T12:00:00.000Z",
      source_kind: "local_mutation",
      source_ref: sourceRef,
    },
  };
}

describe("linked-test provenance merge contract", () => {
  it("marks commands contributed by a union merge and refuses them locally", async () => {
    const base = document();
    const ours = document([linkedTest("node --version", "main")]);
    const theirs = document([linkedTest("pnpm --version", "feature/trust")]);
    const merge = mergeItemDocuments(
      serializeItemDocument(base),
      serializeItemDocument(ours),
      serializeItemDocument(theirs),
    );
    const tests = parseItemDocument(merge.merged).metadata.tests ?? [];

    expect(merge.union_fields).toContain("tests");
    expect(tests).toHaveLength(2);
    expect(tests[0]?.provenance?.source_kind).toBe("local_mutation");
    expect(tests[1]?.provenance).toMatchObject({
      source_kind: "merge_union",
      source_ref: "feature/trust",
    });

    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-merge-trust-"));
    try {
      await expect(
        resolveLinkedTestTrustBatch(pmRoot, tests, "main"),
      ).resolves.toEqual([
        expect.objectContaining({ trusted: true, reason: "local_source_ref" }),
        expect.objectContaining({
          trusted: false,
          reason: "foreign_source_ref",
        }),
      ]);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates the same test definition across provenance variants", () => {
    const base = document();
    const ours = document([linkedTest("node --version", "main")]);
    const theirs = document([linkedTest("node --version", "feature/trust")]);
    const first = mergeItemDocuments(
      serializeItemDocument(base),
      serializeItemDocument(ours),
      serializeItemDocument(theirs),
    );
    const repeated = mergeItemDocuments(
      serializeItemDocument(base),
      first.merged,
      serializeItemDocument(theirs),
    );
    expect(parseItemDocument(repeated.merged).metadata.tests).toHaveLength(1);
  });

  it("retains a base test preserved by both branches", () => {
    const shared = linkedTest("node --version", "main");
    const base = document([shared]);
    const merge = mergeItemDocuments(
      serializeItemDocument(base),
      serializeItemDocument(document([shared])),
      serializeItemDocument(document([shared])),
    );
    expect(parseItemDocument(merge.merged).metadata.tests).toEqual([shared]);
  });

  it("preserves legacy tests contributed by a merge", () => {
    const base = document();
    const ours = document();
    const theirs = document([{ command: "node --version", scope: "project" }]);
    const merge = mergeItemDocuments(
      serializeItemDocument(base),
      serializeItemDocument(ours),
      serializeItemDocument(theirs),
    );
    expect(parseItemDocument(merge.merged).metadata.tests).toEqual([
      { command: "node --version", scope: "project" },
    ]);
  });

  it("round-trips workspace, provenance, and execution trust fields", () => {
    const input = document([linkedTest("node --version", "main")]);
    input.metadata.test_runs = [
      {
        run_id: "run-1",
        kind: "test",
        status: "passed",
        started_at: "2026-08-22T12:00:00.000Z",
        finished_at: "2026-08-22T12:00:01.000Z",
        recorded_at: "2026-08-22T12:00:01.000Z",
        passed: 1,
        failed: 0,
        skipped: 0,
        executions: [
          {
            command: "node --version",
            workspace_context_mode: "snapshot",
            trust_reason: "local_mutation",
          },
        ],
      } satisfies ItemTestRunSummary,
    ];
    const parsed = parseItemDocument(serializeItemDocument(input));
    expect(parsed.metadata.tests?.[0]).toMatchObject({
      workspace_context_mode: "snapshot",
      provenance: { source_kind: "local_mutation", source_ref: "main" },
    });
    expect(parsed.metadata.test_runs?.[0]?.executions?.[0]).toMatchObject({
      workspace_context_mode: "snapshot",
      trust_reason: "local_mutation",
    });

    input.metadata.tests = [
      {
        command: "pnpm lint",
        scope: "project",
        provenance: {
          author: "maintainer",
          created_at: "not-a-timestamp",
          source_kind: "local_mutation",
        },
      },
    ];
    expect(
      parseItemDocument(serializeItemDocument(input)).metadata.tests?.[0]
        ?.provenance,
    ).toBeUndefined();
  });
});
