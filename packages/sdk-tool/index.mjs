/**
 * @module packages/sdk-tool
 *
 * Demonstrates a standalone project-management application whose only pm
 * dependency is the stable public SDK package entrypoint.
 */
import { PmClient } from "@unbrained/pm-cli/sdk";

/** Stable author recorded by the exemplar's mutation history. */
export const SDK_TOOL_AUTHOR = "pm-sdk-tool";

/**
 * Initialize a new tracker for the custom tool without invoking the pm CLI.
 *
 * @param {string} pmRoot Absolute path to the tracker root.
 * @returns {Promise<unknown>} SDK initialization result.
 */
export function initializeCustomTool(pmRoot) {
  return new PmClient({
    pmRoot,
    author: SDK_TOOL_AUTHOR,
    noExtensions: true,
  }).init("work", { defaults: true, author: SDK_TOOL_AUTHOR });
}

/**
 * Run a complete customizable workflow through public SDK primitives.
 *
 * The workflow registers a domain-specific lifecycle and item type, creates a
 * hierarchy, exercises ownership and mutation transitions, attaches durable
 * context, queries the project and relationship graph, runs governance checks,
 * then closes the work. It intentionally uses no command implementation or
 * private storage import.
 *
 * @param {{pmRoot: string, artifactPath?: string}} options Tool configuration.
 * @returns {Promise<{parentId: string, childId: string, listed: number, searched: number, contextItems: number, relationshipEdges: number, validationOk: boolean, healthOk: boolean}>} Workflow summary.
 */
export async function runCustomToolDemo({
  pmRoot,
  artifactPath = "README.md",
}) {
  const client = new PmClient({
    pmRoot,
    author: SDK_TOOL_AUTHOR,
    noExtensions: true,
  });

  await client.schemaAddStatus("tool_review", {
    role: ["active"],
    description: "Domain review performed by the custom SDK tool.",
    author: SDK_TOOL_AUTHOR,
  });
  await client.schemaAddType("WorkUnit", {
    defaultStatus: "open",
    description: "Custom work unit owned by the standalone SDK tool.",
    author: SDK_TOOL_AUTHOR,
  });

  const parent = await client.create({
    title: "SDK custom tool project",
    description: "A domain project created without invoking the pm CLI.",
    type: "WorkUnit",
    acceptanceCriteria:
      "Public SDK lifecycle and context primitives complete the workflow",
  });
  const parentId = parent.item.id;
  const child = await client.create({
    title: "SDK custom tool delivery",
    description: "A governed child work unit managed by the SDK exemplar.",
    type: "WorkUnit",
    parent: parentId,
    acceptanceCriteria: "The custom workflow closes with governance evidence",
  });
  const childId = child.item.id;

  await client.claim(childId, { message: "Custom tool starts delivery" });
  await client.update(childId, {
    status: "tool_review",
    dep: [`id=${parentId},kind=related`],
    message: "Custom domain review is ready",
  });
  await client.comments(childId, {
    add: "SDK exemplar recorded public workflow evidence.",
    author: SDK_TOOL_AUTHOR,
  });
  await client.notes(childId, {
    add: "Private integration context remains available to future tool runs.",
    author: SDK_TOOL_AUTHOR,
  });
  await client.files(childId, {
    add: [artifactPath],
    note: "Artifact managed by the standalone SDK tool",
    author: SDK_TOOL_AUTHOR,
  });

  const listed = await client.list({ type: "WorkUnit", status: "all", limit: "10" });
  const searched = await client.search("SDK custom tool", {
    type: "WorkUnit",
    status: "all",
    limit: "10",
  });
  const projectContext = await client.context({
    type: "WorkUnit",
    limit: "10",
  });
  const relationships = await client.deps(childId, {
    format: "context",
    maxDepth: 4,
    nodeLimit: 20,
    edgeLimit: 40,
  });
  const validation = await client.validate({
    checkResolution: true,
    checkHistoryDrift: true,
  });
  const health = await client.health({ checkOnly: true, summary: true });

  await client.release(childId, { message: "Custom tool review handoff" });
  await client.claim(childId, { message: "Custom tool accepts review" });
  await client.close(
    childId,
    "SDK-only lifecycle, annotations, graph context, and governance checks passed.",
    {
      resolution: "Standalone SDK workflow completed successfully.",
      validateClose: "warn",
    },
  );
  await client.close(
    parentId,
    "The standalone SDK project completed after its governed child closed.",
    {
      resolution: "Custom SDK project delivered.",
      validateClose: "warn",
    },
  );

  return {
    parentId,
    childId,
    listed: listed.count,
    searched: searched.count,
    contextItems:
      projectContext.high_level.length + projectContext.low_level.length,
    relationshipEdges: relationships.edge_count,
    validationOk: validation.ok,
    healthOk: health.ok,
  };
}
