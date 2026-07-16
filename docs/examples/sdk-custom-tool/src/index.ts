/**
 * @module docs/examples/sdk-custom-tool
 *
 * Demonstrates a complete domain-specific project tool built only from the
 * public pm SDK, without CLI or private-core imports.
 */
import path from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";

/** Configuration for the SDK-only acceptance scenario. */
export interface UniversalToolScenarioOptions {
  /** Workspace whose `.agents/pm` tracker the exemplar owns. */
  workspace: string;
  /** Stable mutation author recorded in every scenario history event. */
  author: string;
}

/** Structured proof returned by the SDK-only acceptance scenario. */
export interface UniversalToolScenarioResult {
  /** Registered domain item type. */
  customType: "Deliverable";
  /** Registered domain workflow status. */
  customStatus: "reviewing";
  /** Created parent deliverable id. */
  projectId: string;
  /** Created related child deliverable id. */
  childId: string;
  /** Final lifecycle state of the parent deliverable. */
  projectStatus: string;
  /** Author recorded by the public claim primitive. */
  claimedBy: string;
  /** Prior owner returned by the public release primitive. */
  releasedPreviousAssignee: string | null;
  /** Item ids returned by the typed list primitive. */
  listedIds: string[];
  /** Item ids returned by the typed search primitive. */
  searchedIds: string[];
  /** Active item count observed through bounded context before closeout. */
  activeItemsBeforeClose: number;
  /** Persisted comment count. */
  commentCount: number;
  /** Persisted private-note count. */
  noteCount: number;
  /** Persisted durable-learning count. */
  learningCount: number;
  /** Linked implementation-file count. */
  linkedFileCount: number;
  /** Linked documentation count. */
  linkedDocCount: number;
  /** Dependency edges returned by the graph projection. */
  dependencyEdges: number;
  /** Whether repository health remained clean. */
  healthOk: boolean;
  /** Whether the immutable history drift check passed. */
  historyDriftOk: boolean;
}

/** Extract an id from a typed create result and fail with acceptance context. */
export const requireCreatedId = (
  result: { item?: { id?: unknown } },
  label: string,
): string => {
  const id = result.item?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`SDK exemplar did not receive an id for ${label}.`);
  }
  return id;
};

/** Read a projected item id from compact, full, or scored search rows. */
export const readProjectedItemId = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if ("id" in value && typeof value.id === "string") {
    return value.id;
  }
  if (
    "item" in value &&
    typeof value.item === "object" &&
    value.item !== null &&
    "id" in value.item &&
    typeof value.item.id === "string"
  ) {
    return value.item.id;
  }
  return undefined;
};

/** Require the final item projection to contain its lifecycle status. */
export const requireFinalStatus = (status: unknown): string => {
  if (typeof status !== "string") {
    throw new Error("SDK exemplar final project status is missing.");
  }
  return status;
};

/**
 * Run a cross-domain SDK acceptance flow covering customization, lifecycle,
 * context, annotations, linked resources, relationships, and governance.
 */
export async function runUniversalToolScenario(
  options: UniversalToolScenarioOptions,
): Promise<UniversalToolScenarioResult> {
  const pmRoot = path.join(options.workspace, ".agents", "pm");
  const client = new PmClient({
    pmRoot,
    cwd: options.workspace,
    author: options.author,
    noExtensions: true,
  });

  await client.init("work", { defaults: true, agentGuidance: "skip" });
  await client.schemaAddStatus("reviewing", {
    role: ["active"],
    description: "Deliverable is undergoing domain review.",
    order: 25,
  });
  await client.schemaAddType("Deliverable", {
    description: "A domain deliverable managed by the SDK-only custom tool.",
    defaultStatus: "open",
    folder: "deliverables",
    alias: ["deliverable"],
  });

  const projectId = requireCreatedId(
    await client.create({
      type: "Deliverable",
      title: "Universal launch",
      description: "Coordinate the SDK-only universal-tool acceptance flow.",
      status: "open",
      createMode: "progressive",
    }),
    "parent deliverable",
  );
  const childId = requireCreatedId(
    await client.create({
      type: "Deliverable",
      title: "Ship contextual primitive",
      description: "Prove a related child can be governed without the pm CLI.",
      status: "open",
      parent: projectId,
      dep: [`id=${projectId},kind=related`],
      createMode: "progressive",
    }),
    "child deliverable",
  );
  const claimed = await client.claim(projectId);
  const released = await client.release(projectId);

  const comment = await client.comments(projectId, {
    add: "Public execution evidence belongs with the governed work.",
  });
  const note = await client.notes(projectId, {
    add: "Private implementation rationale stays available to future agents.",
  });
  const learning = await client.learnings(projectId, {
    add: "A domain tool can compose pm primitives without shelling out.",
  });
  const linkedFile = await client.files(projectId, {
    add: ["README.md"],
    note: "Custom workspace implementation surface",
    validatePaths: true,
  });
  const linkedDoc = await client.docs(projectId, {
    add: ["README.md"],
    note: "Custom workspace documentation surface",
    validatePaths: true,
  });
  await client.update(projectId, {
    status: "reviewing",
    message: "Enter custom review workflow",
  });

  const listed = await client.list({ noTruncate: true });
  const searched = await client.search("Universal launch", {
    noTruncate: true,
  });
  const context = await client.context({ limit: "10" });
  const dependencyGraph = await client.deps(childId, { format: "graph" });

  const resolution = {
    resolution: "completed",
    expectedResult: "SDK-only domain workflow completes with durable context.",
    actualResult: "Customization, lifecycle, graph, and governance primitives passed.",
  };
  await client.close(childId, "SDK-only child acceptance completed.", resolution);
  await client.close(projectId, "SDK-only universal-tool acceptance completed.", resolution);

  const finalProject = await client.get(projectId, { full: true });
  const health = await client.health({ checkOnly: true });
  const validation = await client.validate({
    checkResolution: true,
    checkHistoryDrift: true,
  });

  return {
    customType: "Deliverable",
    customStatus: "reviewing",
    projectId,
    childId,
    projectStatus: requireFinalStatus(finalProject.item.status),
    claimedBy: claimed.claimed_by,
    releasedPreviousAssignee: released.previous_assignee,
    listedIds: listed.items
      .map(readProjectedItemId)
      .filter((id): id is string => id !== undefined),
    searchedIds: searched.items
      .map(readProjectedItemId)
      .filter((id): id is string => id !== undefined),
    activeItemsBeforeClose: context.summary.active_items,
    commentCount: comment.count,
    noteCount: note.count,
    learningCount: learning.count,
    linkedFileCount: linkedFile.count,
    linkedDocCount: linkedDoc.count,
    dependencyEdges: dependencyGraph.edge_count,
    healthOk: health.ok,
    historyDriftOk:
      validation.checks.find((check) => check.name === "history_drift")
        ?.status === "ok",
  };
}
