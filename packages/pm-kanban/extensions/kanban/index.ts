/**
 * pm-kanban — first-party exemplar for shipping a complete project-management
 * *archetype* as an installable pm package, built on public SDK primitives only.
 *
 * Where {@link ../../../pm-command-kit | pm-command-kit} is the exemplar for the
 * `commands` capability, this package is the exemplar for the `schema` capability
 * *and* the project-profile model: it ships a self-contained "Kanban
 * continuous-flow" archetype that complements the three core-baked profiles
 * (agile/ops/research) without modifying core.
 *
 * Two surfaces, two consumers:
 *
 * 1. **Live schema** — `activate` registers the archetype's domain schema through
 *    the public registration API (`registerItemTypes`/`registerItemFields`).
 *    These are GLOBAL contributions, so the manifest
 *    deliberately declares no `activation.commands`: pm activates the package
 *    under its conservative tier for every command, making the `Card` type and
 *    flow fields available to `pm create`, `pm list --type Card`, and `pm validate`
 *    the moment the package is installed.
 * 2. **Profile spec** — {@link kanbanProfile} is a {@link ProjectProfileDefinition}
 *    describing the *complete* archetype (item types, custom statuses, fields, the
 *    `Card` workflow, offline search config, a starter template, and package
 *    recommendations). `activate` registers it through `api.registerProfile`, so
 *    once the package is installed it resolves by name through `pm profile list`,
 *    `pm profile show kanban`, and `pm profile apply kanban` — staging the
 *    non-schema dimensions (statuses/config/templates) idempotently exactly like a
 *    core archetype, with no consumer code required.
 *
 * The extension is intentionally pure: no filesystem, network, environment, or
 * process access — so its manifest declares `sandbox_profile: "strict"` with all
 * permissions false. Only types are imported from the published SDK specifier, so
 * the module loads without resolving the SDK at module-evaluation time when the
 * package is copied into an installed tracker.
 */
import type {
  ExtensionApi,
  ProjectProfileDefinition,
  SchemaFieldDefinition,
  SchemaItemTypeDefinition,
} from "@unbrained/pm-cli/sdk";

/** Declarative package manifest consumed by the extension loader. */
export const manifest = {
  name: "builtin-kanban-profile",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["schema"],
};

/**
 * The Kanban flow card — the archetype's single domain item type.
 *
 * `folder` keeps card items in their own `cards/` directory and `aliases` lets
 * authors type the friendlier `pm create kanban-card`. Registered globally so it
 * is usable wherever built-in commands accept a type.
 */
export const KANBAN_ITEM_TYPE: SchemaItemTypeDefinition = {
  name: "Card",
  folder: "cards",
  aliases: ["kanban-card"],
  required_create_fields: [],
};

/** Flow-control front-matter fields for a Kanban board. None shadow a built-in field key, so they register cleanly alongside core metadata. */
export const KANBAN_ITEM_FIELDS: SchemaFieldDefinition[] = [
  { name: "wip_limit", type: "number", optional: true },
  { name: "class_of_service", type: "string", optional: true },
  { name: "impediment", type: "string", optional: true },
];

/**
 * The complete Kanban archetype as a {@link ProjectProfileDefinition}.
 *
 * This is the authoring anchor a profile package builds on: it bundles the item
 * type, two flow statuses, the flow fields, the `Card` workflow, offline-friendly
 * search config, a starter create template, and advisory package recommendations
 * into one declarative archetype. `activate` hands it to `api.registerProfile`, so
 * `pm profile apply kanban` stages every dimension idempotently. The field keys
 * and type name are kept in lockstep with {@link KANBAN_ITEM_TYPE} and
 * {@link KANBAN_ITEM_FIELDS} (the live registration surfaces); the package test
 * asserts they never drift.
 */
export const kanbanProfile: ProjectProfileDefinition = {
  name: "kanban",
  title: "Kanban continuous flow",
  summary:
    "Continuous-flow delivery with WIP limits, a verifying stage, class of service, and blocked-reason tracking.",
  types: [
    {
      name: "Card",
      folder: "cards",
      aliases: ["kanban-card"],
      description: "A unit of flow work that moves across the board to done.",
    },
  ],
  statuses: [
    {
      id: "doing",
      roles: ["active"],
      aliases: ["wip"],
      description: "Card is actively being worked within the column WIP limit.",
    },
    {
      id: "verifying",
      roles: ["active"],
      aliases: ["verify"],
      description:
        "Work is implementation-complete and being verified before done.",
    },
  ],
  fields: [
    {
      key: "wip_limit",
      type: "number",
      commands: ["create", "update", "list"],
      description:
        "Maximum number of cards allowed in the card's current column.",
      aliases: ["wip"],
    },
    {
      key: "class_of_service",
      type: "string",
      commands: ["create", "update", "list"],
      description:
        "Delivery class: standard, expedite, fixed-date, or intangible.",
      aliases: ["cos"],
    },
    {
      key: "impediment",
      type: "string",
      commands: ["create", "update"],
      description:
        "The impediment currently blocking the card, recorded for flow analysis.",
    },
  ],
  workflows: [
    {
      type: "Card",
      allowed_transitions: [
        ["open", "doing"],
        ["doing", "verifying"],
        ["verifying", "doing"],
        ["verifying", "closed"],
        ["doing", "blocked"],
        ["blocked", "doing"],
      ],
    },
  ],
  config: [
    {
      key: "search_provider",
      value: "bm25",
      summary: "Offline BM25 lexical search needs no embedding service.",
    },
    {
      key: "search_max_results",
      value: "30",
      summary: "Board-sized result cap for quick card lookup.",
    },
  ],
  templates: [
    {
      name: "card",
      options: {
        type: "Card",
        priority: "2",
        tags: "kanban",
        acceptanceCriteria:
          "Card delivers the stated outcome and meets the definition of done.",
        body: "## Context\n\n## Definition of done\n- [ ] \n",
      },
    },
  ],
  packages: [
    {
      spec: "templates",
      reason: "Reusable create templates for recurring card shapes.",
    },
    {
      spec: "lifecycle-hooks",
      reason: "Automate flow transitions and WIP-limit reactions.",
    },
    { spec: "calendar", reason: "Visualize delivery cadence and due dates." },
  ],
};

/**
 * Register the Kanban archetype. The item types and fields are GLOBAL schema
 * contributions, so they are available to every built-in command the moment the
 * package is installed. The {@link kanbanProfile} is registered as a project
 * profile so `pm profile apply kanban` can stage the remaining archetype
 * dimensions (statuses/config/templates/workflow) idempotently. All three calls
 * are covered by the package's single declared `schema` capability.
 */
export function activate(api: ExtensionApi): void {
  api.registerItemFields(KANBAN_ITEM_FIELDS);
  api.registerItemTypes([KANBAN_ITEM_TYPE]);
  api.registerProfile(kanbanProfile);
}

/** No teardown state to release; the archetype schema is host-managed. */
export function deactivate(): void {}

export default {
  manifest,
  activate,
  deactivate,
};
