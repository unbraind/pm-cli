import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ItemMetadata } from "../../../src/types/index.js";
import {
  _testOnlySourceTraceability,
  explainSourceTraceability,
  parseSourceLineRange,
} from "../../../src/sdk/traceability/source-traceability.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function item(
  id: string,
  type: string,
  dependencies: ItemMetadata["dependencies"] = [],
): ItemMetadata {
  return {
    id,
    title: id,
    description: `${id} description`,
    type,
    status: "open",
    priority: 1,
    tags: [],
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
    dependencies,
  };
}

describe("source traceability", () => {
  it("attributes selected lines and returns the shortest typed decision path", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-source-traceability-"),
    );
    temporaryDirectories.push(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "src"));
    await fs.writeFile(
      path.join(workspaceRoot, "src", "feature.ts"),
      "export const first = 1;\nexport const second = 2;\n",
    );
    for (const args of [
      ["init"],
      ["config", "user.email", "pm@example.invalid"],
      ["config", "user.name", "pm test"],
      ["add", "src/feature.ts"],
      [
        "commit",
        "-m",
        "Implement feature ownership (pm-work, pm-zeta, pm-alpha)",
      ],
    ]) {
      execFileSync("git", args, { cwd: workspaceRoot, stdio: "ignore" });
    }
    const work = {
      ...item("pm-work", "Feature", [
        {
          id: "pm-decision",
          kind: "implements",
          created_at: "2026-08-10T00:00:00.000Z",
        },
      ]),
      value: "Operators can explain source ownership.",
      why_now: "Agents need bounded context.",
      outcome: "Traceable implementation decisions.",
      objective: "Connect code, work, and decisions.",
      files: [{ path: "src/feature.ts", scope: "project" as const }],
    };
    const decision = item("pm-decision", "Decision");
    const result = await explainSourceTraceability({
      workspaceRoot,
      paths: ["src/feature.ts"],
      candidates: [{ item: work, files: work.files }],
      corpus: [work, decision],
      lineRange: { start: 1, end: 2 },
      decisionDepth: 4,
    });

    expect(result.receipt).toMatchObject({
      line_range: { start: 1, end: 2 },
      blamed_commit_count: 1,
      mapped_commit_count: 1,
      unmapped_commit_count: 0,
      decision_depth: 4,
    });
    expect(result.explanations.get("pm-work")).toMatchObject({
      contribution_lines: 2,
      rationale: {
        value: "Operators can explain source ownership.",
        why_now: "Agents need bounded context.",
        outcome: "Traceable implementation decisions.",
        objective: "Connect code, work, and decisions.",
      },
      decision_path: {
        status: "found",
        nodes: ["pm-work", "pm-decision"],
        kinds: ["implements"],
      },
      ambiguities: [],
    });
  });

  it("reports ambiguity and unavailable Git evidence without fabricating edges", async () => {
    const work = item("pm-work", "Feature", [
      {
        id: "pm-decision-a",
        kind: "implements",
        created_at: "2026-08-10T00:00:00.000Z",
      },
      {
        id: "pm-decision-b",
        kind: "implements",
        created_at: "2026-08-10T00:00:00.000Z",
      },
    ]);
    const result = await explainSourceTraceability({
      workspaceRoot: path.join(os.tmpdir(), "missing-git-workspace"),
      paths: ["src/missing.ts"],
      candidates: [
        {
          item: work,
          files: [{ path: "src/missing.ts", scope: "project" }],
        },
      ],
      corpus: [
        work,
        item("pm-decision-a", "Decision"),
        item("pm-decision-b", "Decision"),
      ],
      lineRange: { start: 1, end: 1 },
    });
    const explanation = result.explanations.get("pm-work");

    expect(explanation?.decision_path.status).toBe("ambiguous");
    expect(explanation?.decision_path.alternative_decision_ids).toEqual([
      "pm-decision-b",
    ]);
    expect(explanation?.ambiguities).toEqual([
      "git_attribution_unavailable",
      "line_attribution_unmapped",
      "multiple_governing_decisions",
    ]);
    expect(result.receipt.blamed_commit_count).toBe(0);

    const missingGraphNode = await explainSourceTraceability({
      workspaceRoot: path.join(os.tmpdir(), "missing-git-workspace"),
      paths: ["src/missing.ts"],
      candidates: [
        {
          item: item("pm-absent", "Feature"),
          files: [{ path: "src/missing.ts", scope: "project" }],
        },
      ],
      corpus: [],
    });
    expect(missingGraphNode.explanations.get("pm-absent")).toMatchObject({
      decision_path: { status: "not_found" },
      ambiguities: ["governing_decision_not_found"],
    });
  });

  it("traverses inverse and intermediate edges without overstating decisions", async () => {
    const work = item("pm-work", "Feature", [
      {
        id: "pm-middle",
        kind: "related",
        created_at: "2026-08-10T00:00:00.000Z",
      },
    ]);
    const middle = item("pm-middle", "Task", [
      {
        id: "pm-decision",
        kind: "implements",
        created_at: "2026-08-10T00:00:00.000Z",
      },
    ]);
    const decision = item("pm-decision", "Decision");
    const result = await explainSourceTraceability({
      workspaceRoot: process.cwd(),
      paths: ["src/feature.ts"],
      candidates: [
        {
          item: work,
          files: [{ path: "src/feature.ts", scope: "project" }],
        },
      ],
      corpus: [work, middle, decision],
      decisionDepth: 1,
    });
    expect(result.explanations.get("pm-work")?.decision_path.status).toBe(
      "not_found",
    );

    const inverse = await explainSourceTraceability({
      workspaceRoot: process.cwd(),
      paths: ["src/feature.ts"],
      candidates: [
        {
          item: work,
          files: [{ path: "src/feature.ts", scope: "project" }],
        },
      ],
      corpus: [
        work,
        {
          ...decision,
          dependencies: [
            {
              id: "pm-work",
              kind: "implements",
              created_at: "2026-08-10T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    expect(inverse.explanations.get("pm-work")?.decision_path).toMatchObject({
      status: "found",
      nodes: ["pm-work", "pm-decision"],
    });
  });

  it("validates line and graph bounds", async () => {
    expect(parseSourceLineRange("10:24")).toEqual({ start: 10, end: 24 });
    expect(() => parseSourceLineRange("24:10")).toThrow("end >= start");
    expect(() => parseSourceLineRange("0:1")).toThrow("positive integers");
    expect(() => parseSourceLineRange("1-2")).toThrow("start:end");
    expect(
      _testOnlySourceTraceability.parseCommitItemReferences(
        `\0ignored\0${"a".repeat(40)}\0No item references\0`,
      ),
    ).toEqual(new Map([["a".repeat(40), []]]));
    expect(
      _testOnlySourceTraceability.mappedBlamedCommits({
        available: true,
        commitLines: new Map([["b".repeat(40), 1]]),
        commitItems: new Map(),
      }),
    ).toEqual([]);
    const cyclicWork = item("pm-cycle-work", "Feature", [
      {
        id: "pm-cycle-a",
        kind: "related",
        created_at: "2026-08-10T00:00:00.000Z",
      },
      {
        id: "pm-cycle-b",
        kind: "related",
        created_at: "2026-08-10T00:00:00.000Z",
      },
    ]);
    expect(
      _testOnlySourceTraceability.shortestDecisionPath(
        "pm-cycle-work",
        [
          cyclicWork,
          item("pm-cycle-a", "Task", [
            {
              id: "pm-cycle-b",
              kind: "related",
              created_at: "2026-08-10T00:00:00.000Z",
            },
          ]),
          item("pm-cycle-b", "Task"),
        ],
        4,
      ).status,
    ).toBe("not_found");
    await expect(
      explainSourceTraceability({
        workspaceRoot: process.cwd(),
        paths: ["src/index.ts"],
        candidates: [],
        corpus: [],
        decisionDepth: 33,
      }),
    ).rejects.toThrow("from 1 to 32");
  });
});
