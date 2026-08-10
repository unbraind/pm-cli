/**
 * @module sdk/source-traceability
 *
 * Composes linked-file evidence, bounded Git line attribution, item rationale,
 * and typed relationship paths into an explainable source-to-work projection.
 */
import { execFile, type ExecFileException } from "node:child_process";
import path from "node:path";
import type { ItemMetadata, LinkedFile } from "../../types/index.js";
import { assembleWorkspaceRelationshipGraph } from "../graph/assembly.js";

/** Inclusive one-based source range accepted by traceability lookup. */
export interface SourceLineRange {
  /** First included source line. */
  start: number;
  /** Last included source line. */
  end: number;
}

/** One evidence class supporting a source-to-item association. */
export interface SourceTraceabilityEvidence {
  /** Evidence producer. */
  kind: "linked_file" | "git_commit";
  /** Linked path or abbreviated commit identifier. */
  reference: string;
  /** Number of selected lines attributed to this evidence. */
  contribution_lines?: number;
}

/** Rationale fields projected without arbitrary body or comment content. */
export interface SourceTraceabilityRationale {
  /** User or project value statement. */
  value: string | null;
  /** Recorded timing rationale. */
  why_now: string | null;
  /** Recorded intended or achieved outcome. */
  outcome: string | null;
  /** Recorded implementation objective. */
  objective: string | null;
}

/** Shortest typed path from source-owning work to a governing decision. */
export interface SourceDecisionPath {
  /** Whether a unique decision path was found under the bound. */
  status: "found" | "ambiguous" | "not_found";
  /** Ordered item identifiers, including source work and decision. */
  nodes: string[];
  /** Relationship kinds connecting consecutive nodes. */
  kinds: string[];
  /** Equally short governing decision candidates. */
  alternative_decision_ids: string[];
}

/** Explainable fields added to one reverse linked-file match. */
export interface SourceTraceabilityExplanation {
  /** Higher values sort first within the original scheduling priority. */
  score: number;
  /** Selected source lines attributable to commits naming this item. */
  contribution_lines: number;
  /** Structured evidence supporting the association. */
  evidence: SourceTraceabilityEvidence[];
  /** Project rationale carried by the item. */
  rationale: SourceTraceabilityRationale;
  /** Governing decision path under the declared graph bound. */
  decision_path: SourceDecisionPath;
  /** Honest ambiguity codes; an empty list means no ambiguity was observed. */
  ambiguities: string[];
}

/** Aggregate line-attribution receipt returned beside explained matches. */
export interface SourceTraceabilityReceipt {
  /** Inclusive selected range, or null for path-only explanation. */
  line_range: SourceLineRange | null;
  /** Number of distinct blamed commits. */
  blamed_commit_count: number;
  /** Number of blamed commits whose message named at least one pm item. */
  mapped_commit_count: number;
  /** Number of blamed commits without an item reference. */
  unmapped_commit_count: number;
  /** Maximum relationship depth searched for a governing decision. */
  decision_depth: number;
}

interface TraceabilityCandidate {
  item: ItemMetadata;
  files: LinkedFile[];
}

interface GitAttribution {
  commitLines: Map<string, number>;
  commitItems: Map<string, string[]>;
  available: boolean;
}

function runGit(
  workspaceRoot: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
      (error: ExecFileException | null, stdout: string) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function validateLineRange(range: SourceLineRange | undefined): void {
  if (
    range &&
    (!Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 1 ||
      range.end < range.start)
  ) {
    throw new RangeError(
      "Source line range must be inclusive positive integers with end >= start.",
    );
  }
}

/** Parse an inclusive `start:end` source-line selector. */
export function parseSourceLineRange(value: string): SourceLineRange {
  const match = /^(\d+):(\d+)$/u.exec(value.trim());
  const range = match
    ? { start: Number(match[1]), end: Number(match[2]) }
    : undefined;
  validateLineRange(range);
  if (!range) {
    throw new RangeError("Source line range must use start:end.");
  }
  return range;
}

function parseBlameCommits(output: string): Map<string, number> {
  const lines = new Map<string, number>();
  for (const row of output.split("\n")) {
    const commit = /^([0-9a-f^]{40,64}) \d+ \d+(?: \d+)?$/u.exec(row)?.[1];
    if (commit) lines.set(commit, (lines.get(commit) ?? 0) + 1);
  }
  return lines;
}

function parseCommitItemReferences(output: string): Map<string, string[]> {
  const fields = output.split("\0");
  const references = new Map<string, string[]>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const commit = fields[index]?.trim();
    if (!commit) continue;
    const ids = [
      ...new Set(
        fields[index + 1]?.match(/\bpm-[a-z0-9][a-z0-9-]{2,63}\b/gu) ?? [],
      ),
    ].sort((left, right) => left.localeCompare(right));
    references.set(commit, ids);
  }
  return references;
}

async function readGitAttribution(params: {
  workspaceRoot: string;
  sourcePath: string;
  lineRange: SourceLineRange;
}): Promise<GitAttribution> {
  const relativePath = path.relative(
    params.workspaceRoot,
    path.resolve(params.workspaceRoot, params.sourcePath),
  );
  const blame = await runGit(params.workspaceRoot, [
    "blame",
    "--line-porcelain",
    "-L",
    `${params.lineRange.start},${params.lineRange.end}`,
    "--",
    relativePath,
  ]);
  const log = await runGit(params.workspaceRoot, [
    "log",
    "-n",
    "256",
    "--format=%H%x00%B%x00",
    "--",
    relativePath,
  ]);
  return {
    commitLines: parseBlameCommits(blame),
    commitItems: parseCommitItemReferences(log),
    available: true,
  };
}

type DecisionTraversalPath = { nodes: string[]; kinds: string[] };

function expandDecisionPath(params: {
  current: DecisionTraversalPath;
  graph: ReturnType<typeof assembleWorkspaceRelationshipGraph>["graph"];
  details: ReadonlyMap<string, { type?: string }>;
  visitedDepth: Map<string, number>;
  queue: DecisionTraversalPath[];
  found: DecisionTraversalPath[];
}): number | undefined {
  const tail = params.current.nodes.at(-1)!;
  const nextDepth = params.current.kinds.length + 1;
  let foundDepth: number | undefined;
  for (const edge of params.graph.incidentEdges(tail)) {
    const outgoing = edge.source === tail;
    const next = outgoing ? edge.target : edge.source;
    if ((params.visitedDepth.get(next) ?? Number.POSITIVE_INFINITY) < nextDepth)
      continue;
    params.visitedDepth.set(next, nextDepth);
    const definition = params.graph.registry().require(edge.kind);
    const nextPath = {
      nodes: [...params.current.nodes, next],
      kinds: [
        ...params.current.kinds,
        outgoing ? edge.kind : (definition.inverse ?? edge.kind),
      ],
    };
    if (params.details.get(next)?.type?.toLowerCase() === "decision") {
      foundDepth = nextDepth;
      params.found.push(nextPath);
    } else {
      params.queue.push(nextPath);
    }
  }
  return foundDepth;
}

function collectDecisionPaths(params: {
  itemId: string;
  maxDepth: number;
  graph: ReturnType<typeof assembleWorkspaceRelationshipGraph>["graph"];
  details: ReadonlyMap<string, { type?: string }>;
}): Array<{ nodes: string[]; kinds: string[] }> {
  const queue: DecisionTraversalPath[] = [
    { nodes: [params.itemId], kinds: [] },
  ];
  const visitedDepth = new Map<string, number>([[params.itemId, 0]]);
  const found: DecisionTraversalPath[] = [];
  let foundDepth: number | undefined;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = current.kinds.length;
    if (foundDepth !== undefined && depth >= foundDepth) continue;
    if (depth >= params.maxDepth) continue;
    foundDepth =
      expandDecisionPath({
        current,
        graph: params.graph,
        details: params.details,
        visitedDepth,
        queue,
        found,
      }) ?? foundDepth;
  }
  found.sort((left, right) =>
    left.nodes.join("\0").localeCompare(right.nodes.join("\0")),
  );
  return found;
}

function shortestDecisionPath(
  itemId: string,
  corpus: readonly ItemMetadata[],
  maxDepth: number,
): SourceDecisionPath {
  const assembly = assembleWorkspaceRelationshipGraph(corpus);
  if (!assembly.graph.hasNode(itemId)) {
    return {
      status: "not_found",
      nodes: [],
      kinds: [],
      alternative_decision_ids: [],
    };
  }
  const found = collectDecisionPaths({
    itemId,
    maxDepth,
    graph: assembly.graph,
    details: new Map(assembly.details.map((detail) => [detail.id, detail])),
  });
  const selected = found[0];
  if (!selected) {
    return {
      status: "not_found",
      nodes: [],
      kinds: [],
      alternative_decision_ids: [],
    };
  }
  const decisionIds = [...new Set(found.map((entry) => entry.nodes.at(-1)!))];
  return {
    status: decisionIds.length === 1 ? "found" : "ambiguous",
    nodes: selected.nodes,
    kinds: selected.kinds,
    alternative_decision_ids: decisionIds.slice(1),
  };
}

async function resolveGitAttribution(params: {
  workspaceRoot: string;
  paths: readonly string[];
  lineRange?: SourceLineRange;
}): Promise<GitAttribution> {
  if (!params.lineRange) {
    return {
      commitLines: new Map<string, number>(),
      commitItems: new Map<string, string[]>(),
      available: true,
    };
  }
  try {
    return await readGitAttribution({
      workspaceRoot: params.workspaceRoot,
      sourcePath: params.paths[0]!,
      lineRange: params.lineRange,
    });
  } catch {
    return {
      commitLines: new Map<string, number>(),
      commitItems: new Map<string, string[]>(),
      available: false,
    };
  }
}

function sourceAmbiguities(params: {
  hasLineRange: boolean;
  attributionAvailable: boolean;
  contributionLines: number;
  decisionStatus: SourceDecisionPath["status"];
}): string[] {
  const ambiguities: string[] = [];
  if (params.hasLineRange && !params.attributionAvailable) {
    ambiguities.push("git_attribution_unavailable");
  }
  if (params.hasLineRange && params.contributionLines === 0) {
    ambiguities.push("line_attribution_unmapped");
  }
  if (params.decisionStatus === "ambiguous") {
    ambiguities.push("multiple_governing_decisions");
  }
  if (params.decisionStatus === "not_found") {
    ambiguities.push("governing_decision_not_found");
  }
  return ambiguities;
}

function mappedBlamedCommits(attribution: GitAttribution): string[] {
  return [...attribution.commitLines.keys()].filter(
    (commit) => (attribution.commitItems.get(commit)?.length ?? 0) > 0,
  );
}

/** Enrich reverse linked-file candidates with bounded source rationale. */
export async function explainSourceTraceability(params: {
  workspaceRoot: string;
  paths: readonly string[];
  candidates: readonly TraceabilityCandidate[];
  corpus: readonly ItemMetadata[];
  lineRange?: SourceLineRange;
  decisionDepth?: number;
}): Promise<{
  explanations: Map<string, SourceTraceabilityExplanation>;
  receipt: SourceTraceabilityReceipt;
}> {
  validateLineRange(params.lineRange);
  const decisionDepth = params.decisionDepth ?? 8;
  if (
    !Number.isSafeInteger(decisionDepth) ||
    decisionDepth < 1 ||
    decisionDepth > 32
  ) {
    throw new RangeError(
      "Decision path depth must be an integer from 1 to 32.",
    );
  }
  const attribution = await resolveGitAttribution(params);
  const mappedCommits = mappedBlamedCommits(attribution);
  const explanations = new Map<string, SourceTraceabilityExplanation>();
  for (const candidate of params.candidates) {
    const attributedCommits = [...attribution.commitLines.entries()].filter(
      ([commit]) =>
        attribution.commitItems.get(commit)?.includes(candidate.item.id),
    );
    const contributionLines = attributedCommits.reduce(
      (total, [, lines]) => total + lines,
      0,
    );
    const decisionPath = shortestDecisionPath(
      candidate.item.id,
      params.corpus,
      decisionDepth,
    );
    const ambiguities = sourceAmbiguities({
      hasLineRange: params.lineRange !== undefined,
      attributionAvailable: attribution.available,
      contributionLines,
      decisionStatus: decisionPath.status,
    });
    explanations.set(candidate.item.id, {
      score:
        contributionLines * 100 +
        candidate.files.length * 10 +
        Math.max(
          0,
          9 -
            Math.floor(
              (Date.now() - Date.parse(candidate.item.updated_at)) /
                (30 * 24 * 60 * 60 * 1000),
            ),
        ),
      contribution_lines: contributionLines,
      evidence: [
        ...candidate.files.map((file) => ({
          kind: "linked_file" as const,
          reference: file.path,
        })),
        ...attributedCommits.map(([commit, lines]) => ({
          kind: "git_commit" as const,
          reference: commit.slice(0, 12),
          contribution_lines: lines,
        })),
      ],
      rationale: {
        value: candidate.item.value?.trim() || null,
        why_now: candidate.item.why_now?.trim() || null,
        outcome: candidate.item.outcome?.trim() || null,
        objective: candidate.item.objective?.trim() || null,
      },
      decision_path: decisionPath,
      ambiguities,
    });
  }
  return {
    explanations,
    receipt: {
      line_range: params.lineRange ?? null,
      blamed_commit_count: attribution.commitLines.size,
      mapped_commit_count: mappedCommits.length,
      unmapped_commit_count:
        attribution.commitLines.size - mappedCommits.length,
      decision_depth: decisionDepth,
    },
  };
}

/** Internal parser and traversal seams for deterministic boundary tests. */
export const _testOnlySourceTraceability = {
  mappedBlamedCommits,
  parseBlameCommits,
  parseCommitItemReferences,
  shortestDecisionPath,
};
