/**
 * @module packages/pm-vcs/extensions/vcs/index
 *
 * A beyond-project-management exemplar that implements a small VCS-style
 * changeset engine entirely through the published pm SDK and extension API.
 */
import type {
  PmClient,
  RelationshipEventStore,
  BeforeCommandHookContext,
  CommandDefinition,
  CommandHandlerContext,
  ExtensionApi,
  GetResult,
  ItemMetadata,
  ProjectProfileDefinition,
  RelationshipEventProjection,
  RelationshipKindDefinition,
  SchemaFieldDefinition,
  SchemaItemTypeDefinition,
} from "@unbrained/pm-cli/sdk";

/** Declarative package manifest consumed by the extension loader. */
export const manifest = {
  name: "builtin-vcs-exemplar",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema", "hooks"],
};

/** Domain types contributed by the VCS exemplar. */
export const VCS_ITEM_TYPES = [
  {
    name: "Changeset",
    folder: "changesets",
    aliases: ["change", "commit"],
    required_create_fields: ["vcs_ref", "vcs_tree_hash"],
  },
  {
    name: "VcsRef",
    folder: "refs",
    aliases: ["branch", "vcs-ref"],
    required_create_fields: ["vcs_ref"],
  },
] satisfies Array<
  SchemaItemTypeDefinition & { folder: string; aliases: string[] }
>;

/** Domain metadata stored on changesets and refs without core schema changes. */
export const VCS_ITEM_FIELDS: SchemaFieldDefinition[] = [
  { name: "vcs_ref", type: "string", optional: false },
  { name: "vcs_tree_hash", type: "string", optional: true },
  { name: "vcs_parent", type: "string", optional: true },
  { name: "vcs_message", type: "string", optional: true },
];

/** Custom relationship used by the package-owned immutable merge ledger. */
export const VCS_RELATIONSHIP_KIND: RelationshipKindDefinition = {
  kind: "commits_to",
  direction: "directed",
  inverse: "contains_commit",
  ordering: true,
  precedence: "source_before_target",
  hierarchy: false,
  outgoing: "one",
  incoming: "many",
  lifecycle: "supersedable",
  aliases: ["merged_into"],
  compatibilityVersion: 1,
  allowSelf: false,
};

/** Complete non-PM domain profile staged with `pm profile apply vcs`. */
export const vcsProfile: ProjectProfileDefinition = {
  name: "vcs",
  title: "VCS changeset workflow",
  summary:
    "Draft, propose, merge, and abandon changesets with immutable history and typed ref relationships.",
  types: VCS_ITEM_TYPES.map((definition) => ({
    name: definition.name,
    folder: definition.folder,
    aliases: [...definition.aliases],
  })),
  statuses: [
    {
      id: "proposed",
      roles: ["active"],
      aliases: ["review"],
      description: "Changeset is immutable for review and ready for a merge decision.",
    },
    {
      id: "merged",
      roles: ["terminal"],
      aliases: ["committed"],
      description: "Changeset was accepted into its target ref.",
    },
    {
      id: "abandoned",
      roles: ["terminal"],
      aliases: ["rejected"],
      description: "Changeset was deliberately retired without merging.",
    },
  ],
  fields: VCS_ITEM_FIELDS.map((field) => ({
    key: field.name,
    type: field.type,
    commands: ["create", "update", "list"],
    description: `VCS exemplar field ${field.name}.`,
  })),
  workflows: [
    {
      type: "Changeset",
      allowed_transitions: [
        ["draft", "proposed"],
        ["proposed", "draft"],
        ["proposed", "merged"],
        ["draft", "abandoned"],
        ["proposed", "abandoned"],
      ],
    },
  ],
  config: [],
  templates: [],
  packages: [],
};

interface VcsListResult {
  items: Array<Partial<ItemMetadata>>;
}

interface VcsLogState {
  relationships: string[];
}

/** Structured output shared by VCS domain commands. */
export interface VcsCommandResult {
  /** Stable domain action name. */
  action: string;
  /** Item or ref identifier affected by the command. */
  id?: string;
  /** Current domain status when one is available. */
  status?: string;
  /** Additional command-specific data. */
  details?: Record<string, unknown>;
}

/** Return one required non-empty string option with a domain-focused error. */
function requiredOption(
  options: Record<string, unknown>,
  key: string,
): string {
  const value =
    options[key] ??
    options[
      key.replaceAll(/_([a-z])/g, (_match, letter: string) =>
        letter.toUpperCase(),
      )
    ];
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`vcs requires --${key.replaceAll("_", "-")}`);
  return value.trim();
}

/** Resolve the first non-empty positional argument. */
function requiredArgument(context: CommandHandlerContext, label: string): string {
  const value = context.args.find((argument) => !argument.startsWith("-"));
  if (!value?.trim()) throw new TypeError(`vcs requires ${label}`);
  return value.trim();
}

/** Construct a tracker-bound SDK client for one extension command invocation. */
function clientFor(context: CommandHandlerContext): PmClient {
  if (!context.sdk)
    throw new TypeError("vcs requires the extension command SDK runtime");
  return context.sdk.client;
}

/** Read and validate one VCS-domain item. */
async function getVcsItem(
  client: PmClient,
  id: string,
  expectedType: "Changeset" | "VcsRef",
): Promise<GetResult> {
  const result = await client.get(id, { depth: "deep" });
  if (result.item.type !== expectedType)
    throw new TypeError(`vcs expected ${expectedType} ${id}`);
  return result;
}

/** Return every active VCS node id so the relationship store validates endpoints. */
async function listVcsNodes(client: PmClient): Promise<string[]> {
  const results = await Promise.all(
    ["Changeset", "VcsRef"].map(
      async (type) =>
        (await client.list({
          type,
          status: "all",
          noTruncate: true,
        })) as VcsListResult,
    ),
  );
  return results
    .flatMap((result) => result.items)
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Open the package-owned durable relationship ledger. */
async function openVcsRelationshipStore(
  context: CommandHandlerContext,
  client: PmClient,
): Promise<RelationshipEventStore> {
  return context.sdk!.openRelationshipEventStore({
    nodes: await listVcsNodes(client),
    definitions: [VCS_RELATIONSHIP_KIND],
    relativePath: "relationships/vcs-events.jsonl",
  });
}

/** Apply one legal VCS lifecycle transition. */
async function transitionChangeset(
  context: CommandHandlerContext,
  targetStatus: "proposed" | "abandoned",
): Promise<VcsCommandResult> {
  const id = requiredArgument(context, "a changeset id");
  const client = clientFor(context);
  const current = await getVcsItem(client, id, "Changeset");
  const allowed =
    targetStatus === "proposed"
      ? current.item.status === "draft"
      : current.item.status === "draft" || current.item.status === "proposed";
  if (!allowed)
    throw new TypeError(
      `vcs cannot move ${id} from ${String(current.item.status)} to ${targetStatus}`,
    );
  await client.update(id, {
    status: targetStatus,
    message: `VCS transition to ${targetStatus}`,
    ...(targetStatus === "abandoned"
      ? { resolution: "Changeset abandoned by domain command" }
      : {}),
  });
  return { action: `vcs-${targetStatus}`, id, status: targetStatus };
}

/** Create one ref item that can receive merged changesets. */
async function runRefCreate(
  context: CommandHandlerContext,
): Promise<VcsCommandResult> {
  const name = requiredArgument(context, "a ref name");
  const result = await clientFor(context).create({
    title: `ref/${name}`,
    type: "VcsRef",
    status: "open",
    field: [`vcs_ref=${name}`],
    body: `# ${name}\n\nVCS exemplar ref.`,
  });
  return { action: "vcs-ref-create", id: result.item.id, status: result.item.status };
}

/** Create one draft changeset through the public lifecycle SDK. */
async function runChangesetCreate(
  context: CommandHandlerContext,
): Promise<VcsCommandResult> {
  const title = requiredArgument(context, "a changeset title");
  const ref = requiredOption(context.options, "ref");
  const treeHash = requiredOption(context.options, "tree_hash");
  const parent =
    typeof context.options.parent === "string" && context.options.parent.trim()
      ? context.options.parent.trim()
      : undefined;
  const result = await clientFor(context).create({
    title,
    type: "Changeset",
    status: "draft",
    field: [
      `vcs_ref=${ref}`,
      `vcs_tree_hash=${treeHash}`,
      ...(parent === undefined ? [] : [`vcs_parent=${parent}`]),
    ],
    body: `# Changeset\n\n${title}`,
  });
  return { action: "vcs-create", id: result.item.id, status: result.item.status };
}

/** Merge one proposed changeset and append its attributable ref relationship. */
async function runChangesetMerge(
  context: CommandHandlerContext,
): Promise<VcsCommandResult> {
  const id = requiredArgument(context, "a changeset id");
  const refId = requiredOption(context.options, "ref");
  const client = clientFor(context);
  const changeset = await getVcsItem(client, id, "Changeset");
  await getVcsItem(client, refId, "VcsRef");
  if (changeset.item.status !== "proposed")
    throw new TypeError(`vcs merge requires proposed changeset ${id}`);
  const store = await openVcsRelationshipStore(context, client);
  const timestamp = new Date().toISOString();
  const relationship = await store.append({
    eventId: `merge-${id}`,
    relationshipId: `changeset-${id}`,
    action: "add",
    edge: { source: id, target: refId, kind: "commits_to" },
    author:
      typeof context.global.author === "string" && context.global.author.trim()
        ? context.global.author.trim()
        : "pm-vcs",
    timestamp,
    reason: "Reviewed VCS changeset merge",
  });
  await client.update(id, {
    status: "merged",
    resolution: `Merged into ${refId}`,
    message: `VCS merge into ${refId}`,
    field: [`vcs_ref=${refId}`],
  });
  return {
    action: "vcs-merge",
    id,
    status: "merged",
    details: { ref: refId, event: relationship },
  };
}

/** Reconstruct one changeset from immutable item history or return current state. */
async function runChangesetShow(
  context: CommandHandlerContext,
): Promise<VcsCommandResult> {
  const id = requiredArgument(context, "a changeset id");
  const target =
    typeof context.options.at === "string" && context.options.at.trim()
      ? context.options.at.trim()
      : undefined;
  if (target === undefined) {
    const result = await getVcsItem(clientFor(context), id, "Changeset");
    return {
      action: "vcs-show",
      id,
      status: result.item.status,
      details: { item: result.item, reconstructed: false },
    };
  }
  if (!context.sdk)
    throw new TypeError("vcs requires the extension command SDK runtime");
  const replay = await context.sdk.getItemAt(id, target);
  if (replay.document.metadata.type !== "Changeset")
    throw new TypeError(`vcs expected Changeset ${id}`);
  return {
    action: "vcs-show",
    id,
    status: replay.document.metadata.status,
    details: { ...replay },
  };
}

/** Project the immutable merge ledger into a compact ref-to-changeset log. */
async function runVcsLog(context: CommandHandlerContext): Promise<VcsCommandResult> {
  const client = clientFor(context);
  const store = await openVcsRelationshipStore(context, client);
  const projection: RelationshipEventProjection<VcsLogState> = await store.project(
    { relationships: [] as string[] },
    (state, event) => ({
      relationships:
        event.action === "remove" || event.edge === undefined
          ? state.relationships.filter((entry) => !entry.startsWith(`${event.relationshipId}:`))
          : [
              ...state.relationships.filter((entry) => !entry.startsWith(`${event.relationshipId}:`)),
              `${event.relationshipId}:${event.edge.source}->${event.edge.target}`,
            ].sort(),
    }),
  );
  return {
    action: "vcs-log",
    details: {
      version: projection.version,
      processed: projection.processed,
      relationships: projection.state.relationships,
    },
  };
}

const ID_ARGUMENT = [
  { name: "id", required: true, description: "Changeset identifier." },
];

/** Build every VCS domain command definition from one contract table. */
export function buildVcsCommands(): CommandDefinition[] {
  return [
    {
      name: "vcs ref-create",
      action: "vcs-ref-create",
      description: "Create a VCS ref through the public pm lifecycle SDK.",
      arguments: [{ name: "name", required: true, description: "Ref name." }],
      run: runRefCreate,
    },
    {
      name: "vcs create",
      action: "vcs-create",
      description: "Create a draft changeset.",
      arguments: [{ name: "title", required: true, description: "Changeset title." }],
      flags: [
        { long: "--ref", value_name: "id", value_type: "string", required: true },
        { long: "--tree-hash", value_name: "hash", value_type: "string", required: true },
        { long: "--parent", value_name: "id", value_type: "string" },
      ],
      run: runChangesetCreate,
    },
    {
      name: "vcs propose",
      action: "vcs-propose",
      description: "Move a draft changeset into review.",
      arguments: ID_ARGUMENT,
      run: (context) => transitionChangeset(context, "proposed"),
    },
    {
      name: "vcs merge",
      action: "vcs-merge",
      description: "Merge a reviewed changeset into a ref.",
      arguments: ID_ARGUMENT,
      flags: [
        { long: "--ref", value_name: "id", value_type: "string", required: true },
        {
          long: "--reviewed",
          value_type: "boolean",
          required: true,
          description: "Affirm the package hook-enforced review invariant.",
        },
      ],
      run: runChangesetMerge,
    },
    {
      name: "vcs abandon",
      action: "vcs-abandon",
      description: "Retire a draft or proposed changeset.",
      arguments: ID_ARGUMENT,
      run: (context) => transitionChangeset(context, "abandoned"),
    },
    {
      name: "vcs show",
      action: "vcs-show",
      description: "Read current or point-in-time changeset state.",
      arguments: ID_ARGUMENT,
      flags: [{ long: "--at", value_name: "version-or-time", value_type: "string" }],
      run: runChangesetShow,
    },
    {
      name: "vcs log",
      action: "vcs-log",
      description: "Project the immutable merge relationship stream.",
      run: runVcsLog,
    },
  ];
}

/** Hook-enforced merge rule: domain merges require an explicit review affirmation. */
export function enforceVcsMergePolicy(context: BeforeCommandHookContext): void {
  if (context.command !== "vcs merge") return;
  if (context.options?.reviewed !== true)
    throw new TypeError("vcs merge requires --reviewed");
}

/** Register schema, profile, domain commands, and merge-policy hook. */
export function activate(api: ExtensionApi): void {
  api.registerItemFields(VCS_ITEM_FIELDS);
  api.registerItemTypes(VCS_ITEM_TYPES);
  api.registerRelationshipKinds([VCS_RELATIONSHIP_KIND]);
  api.registerProfile(vcsProfile);
  for (const command of buildVcsCommands()) api.registerCommand(command);
  api.hooks.beforeCommand(enforceVcsMergePolicy);
}

/** No process-global resources are retained by the package. */
export function deactivate(): void {}

export default { manifest, activate, deactivate };
