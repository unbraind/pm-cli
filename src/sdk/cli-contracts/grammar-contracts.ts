/**
 * @module sdk/cli-contracts/grammar-contracts
 *
 * Declares and verifies the agent-facing noun–verb grammar. The destination
 * census is intentionally exact: live command contracts are compared with
 * this checked-in table in both directions so adding or removing a command
 * cannot silently bypass the architecture decision.
 */
import type { PmCommandAliasContract } from "./command-aliases.js";

/** Canonical top-level domains an agent must retain to route pm operations. */
export const PM_CLI_GRAMMAR_NOUNS = [
  "item",
  "list",
  "context",
  "search",
  "graph",
  "history",
  "workspace",
  "package",
  "ops",
  "plan",
  "contracts",
  "help",
] as const;

/** Shared verbs whose meaning transfers across domain nouns. */
export const PM_CLI_SHARED_VERBS = [
  "activate",
  "add",
  "adopt",
  "adopt-all",
  "catalog",
  "compact",
  "complete",
  "create",
  "deactivate",
  "delete",
  "describe",
  "doctor",
  "edit",
  "explore",
  "import",
  "init",
  "inspect",
  "install",
  "list",
  "manage",
  "migrate",
  "mutate",
  "read",
  "redact",
  "reload",
  "remove",
  "repair",
  "restore",
  "run",
  "show",
  "uninstall",
  "verify",
] as const;

/** Why a current command is permitted while the grammar migration proceeds. */
export type PmCommandDestinationDisposition =
  | "target_noun"
  | "consolidation"
  | "package_owned"
  | "keep_as_is";

/** Exact destination decision for one command emitted by runtime contracts. */
export interface PmCommandDestinationContract {
  /** Current executable command path. */
  command: string;
  /** Canonical noun that owns the capability. */
  noun: (typeof PM_CLI_GRAMMAR_NOUNS)[number];
  /** Canonical noun-first invocation or family destination. */
  target: string;
  /** Why the current spelling remains in the executable surface. */
  disposition: PmCommandDestinationDisposition;
  /** PM item or package identifier owning the disposition. */
  owner: string;
  /** Reason required only for a deliberate keep-as-is exception. */
  reason?: string;
}

/** Semantic value class for one positional slot, independent of its display label. */
export type PmCommandPositionalValueKind =
  | "action"
  | "integer"
  | "item_id"
  | "string";

/** One ordered positional slot accepted by a command path. */
export interface PmCommandPositionalSlotContract {
  /** Stable agent-facing slot name. */
  name: string;
  /** Whether Commander and the SDK action both require the slot. */
  required: boolean;
  /** Whether the final slot consumes every remaining positional token. */
  variadic: boolean;
  /** Semantic value class used to compare shapes across commands. */
  value_kind: PmCommandPositionalValueKind;
  /** Whether the slot accepts more than one concept for compatibility. */
  polymorphic: boolean;
}

/** Complete positional signature for one executable or virtual action path. */
export interface PmCommandPositionalContract {
  /** Normalized command path. */
  command: string;
  /** Ordered positional slots after the command path. */
  slots: readonly PmCommandPositionalSlotContract[];
}

/** Discoverable positional action projected through help, contracts, and completion. */
export interface PmPositionalActionContract extends PmCommandPositionalContract {
  /** Commander command that dispatches the action positionally. */
  parent: "assurance" | "plan";
  /** Literal action token accepted in the parent's first positional slot. */
  action: string;
  /** Canonical flags applicable to this action-specific view. */
  accepted_flags: readonly string[];
  /** Concise action-specific intent. */
  description: string;
  /** Executable example suitable for recovery and help output. */
  example: string;
}

function positionalSlot(
  name: string,
  valueKind: PmCommandPositionalValueKind,
  required: boolean,
  options: { variadic?: boolean; polymorphic?: boolean } = {},
): PmCommandPositionalSlotContract {
  return {
    name,
    required,
    variadic: options.variadic === true,
    value_kind: valueKind,
    polymorphic: options.polymorphic === true,
  };
}

/** Convert a kebab-case positional action into a sentence-leading verb phrase. */
function positionalActionVerb(action: string): string {
  const phrase = action.replaceAll("-", " ");
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
}

const ITEM_ID = positionalSlot("id", "item_id", true);
const OPTIONAL_ITEM_ID = positionalSlot("id", "item_id", false);
const OPTIONAL_TEXT = positionalSlot("text", "string", false);
const PLAN_ITEM_ID = positionalSlot("plan-id", "item_id", true);
const PLAN_STEP = positionalSlot("step", "string", true);

const PLAN_CREATE_FLAGS = [
  "--acceptance-criteria",
  "--actual-result",
  "--affected-version",
  "--assignee",
  "--blocked-by",
  "--blocked-reason",
  "--blocks",
  "--body",
  "--claim",
  "--comment",
  "--component",
  "--confidence",
  "--create-mode",
  "--customer-impact",
  "--deadline",
  "--definition-of-ready",
  "--description",
  "--doc",
  "--environment",
  "--estimate",
  "--event",
  "--expected-result",
  "--fixed-version",
  "--file",
  "--from-search",
  "--goal",
  "--harness",
  "--impact",
  "--learning",
  "--message",
  "--mode",
  "--note",
  "--objective",
  "--order",
  "--outcome",
  "--parent",
  "--priority",
  "--rank",
  "--related",
  "--release",
  "--reminder",
  "--reporter",
  "--repro-steps",
  "--resolution",
  "--resume-context",
  "--reviewer",
  "--risk",
  "--scope",
  "--severity",
  "--sprint",
  "--status",
  "--step",
  "--step-blocked-reason",
  "--step-body",
  "--step-evidence",
  "--step-owner",
  "--step-replacement",
  "--step-status",
  "--step-title",
  "--tags",
  "--template",
  "--test",
  "--title",
  "--type-option",
  "--unblock-note",
  "--value",
  "--why-now",
] as const;

const PLAN_STEP_FLAGS = [
  "--allow-multiple-active",
  "--depends-on",
  "--file",
  "--force",
  "--message",
  "--step-blocked-reason",
  "--step-body",
  "--step-evidence",
  "--step-owner",
  "--step-status",
  "--step-title",
  "--test",
] as const;

/** Virtual action paths dispatched by positional parent commands. */
export const PM_POSITIONAL_ACTION_CONTRACTS: readonly PmPositionalActionContract[] =
  [
    {
      command: "plan create",
      parent: "plan",
      action: "create",
      slots: [positionalSlot("title", "string", false, { polymorphic: true })],
      accepted_flags: PLAN_CREATE_FLAGS,
      description: "Create a Plan item and optionally seed its ordered steps.",
      example: 'pm plan create --title "Refactor lock retry"',
    },
    {
      command: "plan show",
      parent: "plan",
      action: "show",
      slots: [PLAN_ITEM_ID],
      accepted_flags: ["--depth", "--fields"],
      description: "Read one Plan item with a bounded plan projection.",
      example: "pm plan show pm-a1b2 --depth standard",
    },
    {
      command: "plan add-step",
      parent: "plan",
      action: "add-step",
      slots: [PLAN_ITEM_ID],
      accepted_flags: PLAN_STEP_FLAGS,
      description: "Append one ordered step to a Plan item.",
      example: 'pm plan add-step pm-a1b2 --step-title "Run tests"',
    },
    ...[
      "update-step",
      "complete-step",
      "block-step",
      "remove-step",
      "link",
      "unlink",
    ].map(
      (action): PmPositionalActionContract => ({
        command: `plan ${action}`,
        parent: "plan",
        action,
        slots: [PLAN_ITEM_ID, PLAN_STEP],
        accepted_flags: PLAN_STEP_FLAGS,
        description: `${positionalActionVerb(action)} for one declared Plan step.`,
        example: `pm plan ${action} pm-a1b2 plan-step-001`,
      }),
    ),
    {
      command: "plan reorder-step",
      parent: "plan",
      action: "reorder-step",
      slots: [
        PLAN_ITEM_ID,
        PLAN_STEP,
        positionalSlot("new-order", "integer", true),
      ],
      accepted_flags: ["--force", "--message"],
      description: "Move one Plan step to a declared integer order.",
      example: "pm plan reorder-step pm-a1b2 plan-step-001 2",
    },
    ...[
      "decision",
      "discovery",
      "validation",
      "resume",
      "approve",
      "materialize",
    ].map(
      (action): PmPositionalActionContract => ({
        command: `plan ${action}`,
        parent: "plan",
        action,
        slots: [PLAN_ITEM_ID],
        accepted_flags: PLAN_STEP_FLAGS,
        description: `${positionalActionVerb(action)} for one Plan item.`,
        example: `pm plan ${action} pm-a1b2`,
      }),
    ),
    ...["list", "show", "put", "remove"].map(
      (action): PmPositionalActionContract => ({
        command: `assurance ${action}`,
        parent: "assurance",
        action,
        slots: [
          positionalSlot("kind", "string", true),
          ...(action === "list" ? [] : [positionalSlot("id", "string", true)]),
        ],
        accepted_flags:
          action === "put"
            ? ["--author", "--definition", "--message"]
            : action === "remove"
              ? ["--author", "--message"]
              : [],
        description: `${positionalActionVerb(action)} assurance declarations by kind.`,
        example:
          action === "list"
            ? "pm assurance list measurement"
            : `pm assurance ${action} measurement example-id`,
      }),
    ),
    {
      command: "assurance run",
      parent: "assurance",
      action: "run",
      slots: [positionalSlot("gate-id", "string", true)],
      accepted_flags: ["--dry-run", "--trigger", "--tree"],
      description: "Evaluate one assurance gate for a lifecycle trigger.",
      example:
        "pm assurance run tracker-context-quality --trigger ci --dry-run",
    },
    {
      command: "assurance verdicts",
      parent: "assurance",
      action: "verdicts",
      slots: [positionalSlot("gate-id", "string", false)],
      accepted_flags: ["--gate", "--limit"],
      description: "List bounded assurance verdict history.",
      example: "pm assurance verdicts --limit 20",
    },
    ...["presets", "apply"].map(
      (action): PmPositionalActionContract => ({
        command: `assurance ${action}`,
        parent: "assurance",
        action,
        slots: [positionalSlot("preset", "string", action === "apply")],
        accepted_flags: ["--author", "--message", "--owner"],
        description:
          action === "apply"
            ? "Apply one assurance adoption preset."
            : "List available assurance adoption presets.",
        example:
          action === "apply"
            ? "pm assurance apply software-delivery --owner <pm-item-id>"
            : "pm assurance presets",
      }),
    ),
    {
      command: "assurance derive",
      parent: "assurance",
      action: "derive",
      slots: [],
      accepted_flags: ["--apply", "--author", "--message", "--owner"],
      description: "Derive assurance proposals from current project context.",
      example: "pm assurance derive --owner pm-a1b2",
    },
    {
      command: "assurance promote",
      parent: "assurance",
      action: "promote",
      slots: [positionalSlot("assertion-id", "string", true)],
      accepted_flags: ["--author", "--enforcement", "--message"],
      description: "Promote one assertion into a warning or blocking gate.",
      example: "pm assurance promote assertion-id --enforcement warn",
    },
    {
      command: "assurance risk",
      parent: "assurance",
      action: "risk",
      slots: [],
      accepted_flags: ["--definition"],
      description:
        "Analyze bounded defect-recurrence risk for a proposed change.",
      example: 'pm assurance risk --definition \'{"change":{"files":[]}}\'',
    },
  ];

const EXPLICIT_POSITIONAL_SLOTS = new Map<
  string,
  readonly PmCommandPositionalSlotContract[]
>([
  ["append", [ITEM_ID, OPTIONAL_TEXT]],
  [
    "assurance",
    [
      positionalSlot("action", "action", true),
      positionalSlot("kind", "string", false),
      positionalSlot("id", "string", false),
    ],
  ],
  ["beads import", [positionalSlot("file", "string", false)]],
  ["changelog export", [positionalSlot("file", "string", false)]],
  ["claim", [OPTIONAL_ITEM_ID]],
  ["close", [ITEM_ID, OPTIONAL_TEXT]],
  ["close-task", [ITEM_ID, positionalSlot("reason", "string", false)]],
  ["comments", [ITEM_ID, OPTIONAL_TEXT]],
  ["completion", [positionalSlot("shell", "string", false)]],
  [
    "config",
    [
      positionalSlot("scope", "string", false, { polymorphic: true }),
      positionalSlot("action", "action", false),
      positionalSlot("key", "string", false),
      positionalSlot("value", "string", false, { polymorphic: true }),
    ],
  ],
  ["copy", [ITEM_ID]],
  [
    "create",
    [
      positionalSlot("type-or-title", "string", false, { polymorphic: true }),
      positionalSlot("title", "string", false),
    ],
  ],
  ["delete", [ITEM_ID]],
  ["deps", [ITEM_ID]],
  ["docs", [ITEM_ID]],
  ["event", [positionalSlot("title", "string", true)]],
  [
    "extension",
    [positionalSlot("target", "string", false, { polymorphic: true })],
  ],
  ["files", [ITEM_ID]],
  ["focus", [OPTIONAL_ITEM_ID]],
  ["get", [ITEM_ID]],
  [
    "graph",
    [
      positionalSlot("subcommand", "action", true),
      OPTIONAL_ITEM_ID,
      positionalSlot("target", "item_id", false),
    ],
  ],
  ["guide", [positionalSlot("topic", "string", false)]],
  ["history", [ITEM_ID]],
  ["history-compact", [OPTIONAL_ITEM_ID]],
  ["history-redact", [ITEM_ID]],
  ["history-repair", [OPTIONAL_ITEM_ID]],
  [
    "init",
    [positionalSlot("prefix-or-path", "string", false, { polymorphic: true })],
  ],
  ["install", [positionalSlot("targets", "string", false, { variadic: true })]],
  ["item complete", [ITEM_ID, positionalSlot("reason", "string", false)]],
  ["learnings", [ITEM_ID, OPTIONAL_TEXT]],
  ["meet", [positionalSlot("title", "string", true)]],
  [
    "merge",
    [
      positionalSlot("subcommand", "action", true),
      positionalSlot("artifact", "string", false),
      positionalSlot("base", "string", false),
      positionalSlot("ours", "string", false),
      positionalSlot("theirs", "string", false),
    ],
  ],
  ["notes", [ITEM_ID, OPTIONAL_TEXT]],
  [
    "package",
    [positionalSlot("target", "string", false, { polymorphic: true })],
  ],
  [
    "packages",
    [positionalSlot("target", "string", false, { polymorphic: true })],
  ],
  ["pause-task", [ITEM_ID]],
  [
    "plan",
    [
      positionalSlot("subcommand", "action", true),
      positionalSlot("id", "item_id", false, { polymorphic: true }),
      positionalSlot("step", "string", false),
      positionalSlot("new-order", "integer", false),
    ],
  ],
  [
    "profile",
    [
      positionalSlot("subcommand", "action", true),
      positionalSlot("name", "string", false),
    ],
  ],
  ["release", [ITEM_ID]],
  ["remind", [positionalSlot("title", "string", true)]],
  ["restore", [ITEM_ID, positionalSlot("target", "string", true)]],
  [
    "schema",
    [
      positionalSlot("subcommand", "action", true),
      positionalSlot("name", "string", false),
    ],
  ],
  ["search", [positionalSlot("keywords", "string", true, { variadic: true })]],
  ["start-task", [ITEM_ID]],
  [
    "telemetry",
    [
      positionalSlot("namespace-or-subcommand", "action", false, {
        polymorphic: true,
      }),
      positionalSlot("subcommand", "action", false),
    ],
  ],
  ["test", [ITEM_ID]],
  ["update", [ITEM_ID]],
  ["upgrade", [positionalSlot("target", "string", false)]],
  [
    "workspace snapshot",
    [
      positionalSlot("action", "action", true),
      positionalSlot("target", "string", false),
    ],
  ],
  ...["activate", "adopt", "deactivate", "init", "uninstall"].flatMap(
    (action) =>
      ["extension", "package", "packages"].map(
        (root): [string, readonly PmCommandPositionalSlotContract[]] => [
          `${root} ${action}`,
          [positionalSlot("target", "string", true)],
        ],
      ),
  ),
  ...["describe"].flatMap((action) =>
    ["extension", "package", "packages"].map(
      (root): [string, readonly PmCommandPositionalSlotContract[]] => [
        `${root} ${action}`,
        [positionalSlot("target", "string", false)],
      ],
    ),
  ),
  ...["install"].flatMap((action) =>
    ["extension", "package", "packages"].map(
      (root): [string, readonly PmCommandPositionalSlotContract[]] => [
        `${root} ${action}`,
        [positionalSlot("targets", "string", false, { variadic: true })],
      ],
    ),
  ),
  ["vcs abandon", [ITEM_ID]],
  ["vcs create", [positionalSlot("title", "string", true)]],
  ["vcs merge", [ITEM_ID]],
  ["vcs propose", [ITEM_ID]],
  ["vcs ref-create", [positionalSlot("name", "string", true)]],
  ["vcs show", [ITEM_ID]],
]);

/** Normalize a command path for every positional-contract lookup and identity check. */
function normalizePositionalCommandPath(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/gu, " ");
}

/** Resolve one declared signature without treating arbitrary object keys as commands. */
export function resolvePmCommandPositionalContract(
  command: string,
): PmCommandPositionalContract | undefined {
  const normalized = normalizePositionalCommandPath(command);
  return PM_COMMAND_POSITIONAL_CONTRACTS.find(
    (contract) => contract.command === normalized,
  );
}

/** Resolve one action-specific help/contract view. */
export function resolvePmPositionalActionContract(
  command: string,
): PmPositionalActionContract | undefined {
  const normalized = normalizePositionalCommandPath(command);
  return PM_POSITIONAL_ACTION_CONTRACTS.find(
    (contract) => contract.command === normalized,
  );
}

/** Format the shared action-flag tip rendered by text and structured help. */
export function formatPmPositionalActionFlagTip(
  acceptedFlags: readonly string[],
): string {
  return `Applicable flags: ${acceptedFlags.length > 0 ? acceptedFlags.join(", ") : "none"}.`;
}

function destinationRows(
  noun: PmCommandDestinationContract["noun"],
  target: string,
  disposition: Exclude<PmCommandDestinationDisposition, "keep_as_is">,
  owner: string,
  commands: readonly string[],
): PmCommandDestinationContract[] {
  return commands.map((command) => ({
    command,
    noun,
    target,
    disposition,
    owner,
  }));
}

/** Checked-in exhaustive destination census for core and known package commands. */
export const PM_COMMAND_DESTINATION_CONTRACTS: readonly PmCommandDestinationContract[] =
  [
    ...destinationRows("item", "item", "target_noun", "pm-pbyu", [
      "item",
      "item complete",
      "item mutate",
    ]),
    ...destinationRows("item", "item", "consolidation", "pm-yql1", [
      "append",
      "claim",
      "close",
      "close-many",
      "close-task",
      "comments",
      "copy",
      "create",
      "delete",
      "docs",
      "files",
      "get",
      "learnings",
      "notes",
      "pause-task",
      "release",
      "start-task",
      "test",
      "update",
      "update-many",
    ]),
    ...destinationRows("list", "list", "target_noun", "pm-pfqi", ["list"]),
    ...destinationRows("list", "list --group-by", "consolidation", "pm-xkgq", [
      "aggregate",
    ]),
    ...destinationRows("context", "context", "target_noun", "pm-pbyu", [
      "context",
    ]),
    ...destinationRows("context", "context", "consolidation", "pm-kcs4", [
      "ctx",
      "focus",
      "next",
    ]),
    ...destinationRows("search", "search", "target_noun", "pm-pbyu", [
      "search",
    ]),
    ...destinationRows(
      "search",
      "search",
      "package_owned",
      "package:search-advanced",
      ["reindex", "search-advanced"],
    ),
    ...destinationRows(
      "search",
      "search duplicates",
      "consolidation",
      "pm-3i9q8g",
      ["duplicates"],
    ),
    ...destinationRows("graph", "graph", "target_noun", "pm-pbyu", ["graph"]),
    ...destinationRows("graph", "graph show", "consolidation", "pm-yql1", [
      "deps",
    ]),
    ...destinationRows("history", "history", "target_noun", "pm-pbyu", [
      "history",
    ]),
    ...destinationRows("history", "history", "consolidation", "pm-tqel", [
      "activity",
      "events",
      "history-author-acknowledge",
      "history-compact",
      "history-redact",
      "history-repair",
      "merge",
      "restore",
    ]),
    ...destinationRows(
      "history",
      "history",
      "package_owned",
      "package:builtin-vcs-exemplar",
      [
        "vcs abandon",
        "vcs create",
        "vcs log",
        "vcs merge",
        "vcs propose",
        "vcs ref-create",
        "vcs show",
      ],
    ),
    ...destinationRows("workspace", "workspace", "target_noun", "pm-pbyu", [
      "workspace",
      "workspace snapshot",
      "workspace snapshot create",
      "workspace snapshot delete",
      "workspace snapshot inspect",
      "workspace snapshot list",
      "workspace snapshot restore",
    ]),
    ...destinationRows(
      "workspace",
      "workspace init",
      "consolidation",
      "pm-n7rr",
      ["init"],
    ),
    ...destinationRows("package", "package", "target_noun", "pm-pbyu", [
      "package",
      "package activate",
      "package adopt",
      "package adopt-all",
      "package catalog",
      "package deactivate",
      "package describe",
      "package doctor",
      "package explore",
      "package init",
      "package install",
      "package manage",
      "package migrate",
      "package reload",
      "package uninstall",
    ]),
    ...destinationRows("package", "package", "consolidation", "pm-tnud", [
      "extension",
      "extension activate",
      "extension adopt",
      "extension adopt-all",
      "extension catalog",
      "extension deactivate",
      "extension describe",
      "extension doctor",
      "extension explore",
      "extension init",
      "extension install",
      "extension manage",
      "extension migrate",
      "extension reload",
      "extension uninstall",
      "install",
      "packages",
      "packages activate",
      "packages adopt",
      "packages adopt-all",
      "packages catalog",
      "packages deactivate",
      "packages describe",
      "packages doctor",
      "packages explore",
      "packages init",
      "packages install",
      "packages manage",
      "packages migrate",
      "packages reload",
      "packages uninstall",
      "upgrade",
    ]),
    ...destinationRows("package", "package", "package_owned", "package:beads", [
      "beads import",
    ]),
    ...destinationRows(
      "package",
      "package",
      "package_owned",
      "package:pm-changelog",
      ["changelog export", "changelog generate"],
    ),
    ...destinationRows(
      "package",
      "package calendar",
      "package_owned",
      "pm-o3fh",
      ["event", "meet", "remind"],
    ),
    ...destinationRows("ops", "ops", "consolidation", "pm-6apl", [
      "assurance",
      "config",
      "eval",
      "gc",
      "health",
      "profile",
      "schema",
      "stats",
      "telemetry",
      "test-all",
      "validate",
    ]),
    ...destinationRows(
      "ops",
      "ops assurance",
      "consolidation",
      "pm-2tan",
      PM_POSITIONAL_ACTION_CONTRACTS.filter(
        ({ parent }) => parent === "assurance",
      ).map(({ command }) => command),
    ),
    ...destinationRows("plan", "plan", "target_noun", "pm-pbyu", ["plan"]),
    ...destinationRows(
      "plan",
      "plan",
      "target_noun",
      "pm-2tan",
      PM_POSITIONAL_ACTION_CONTRACTS.filter(
        ({ parent }) => parent === "plan",
      ).map(({ command }) => command),
    ),
    ...destinationRows("contracts", "contracts", "target_noun", "pm-pbyu", [
      "contracts",
    ]),
    ...destinationRows("help", "help", "target_noun", "pm-pbyu", ["help"]),
    ...destinationRows(
      "help",
      "help",
      "package_owned",
      "package:builtin-guide-shell",
      [
        "completion",
        "completion-statuses",
        "completion-tags",
        "completion-types",
        "guide",
      ],
    ),
  ];

/** Exhaustive current command and positional-action signature table. */
export const PM_COMMAND_POSITIONAL_CONTRACTS: readonly PmCommandPositionalContract[] =
  [
    ...new Set(PM_COMMAND_DESTINATION_CONTRACTS.map(({ command }) => command)),
  ].map((command) => ({
    command,
    slots:
      resolvePmPositionalActionContract(command)?.slots ??
      EXPLICIT_POSITIONAL_SLOTS.get(command) ??
      [],
  }));

/** Immutable grammar policy used by contracts and the CI gate. */
export const PM_CLI_GRAMMAR_CONTRACT = {
  nouns: PM_CLI_GRAMMAR_NOUNS,
  shared_verbs: PM_CLI_SHARED_VERBS,
  scope_before_verb: true,
  visible_top_level_ceiling: 69,
  ceiling_raise_requires_pm_item: true,
  positional_shape_budget: 21,
} as const;

/** One positional-signature drift finding. */
export interface PmCommandPositionalFinding {
  /** Stable remediation category. */
  code:
    | "missing_observed_signature"
    | "positional_shape_budget_exceeded"
    | "positional_signature_mismatch"
    | "stale_observed_signature";
  /** Command path whose positional contract drifted. */
  command: string;
  /** Actionable mismatch detail. */
  detail: string;
}

/** Complete positional grammar conformance receipt. */
export interface PmCommandPositionalReport {
  /** Whether the observed signatures exactly match the declaration. */
  ok: boolean;
  /** Declared command/action paths. */
  declared_command_count: number;
  /** Independently observed command/action paths. */
  observed_command_count: number;
  /** Number of distinct semantic positional shapes. */
  positional_shape_count: number;
  /** Maximum distinct shapes allowed without a tracked grammar decision. */
  positional_shape_budget: number;
  /** Stable positional conformance failures. */
  findings: PmCommandPositionalFinding[];
}

/** Report explicit positional entries that no destination command declares. */
export function verifyExplicitPositionalSlotCensus(
  explicitCommands: Iterable<string>,
  destinationCommands: Iterable<string>,
): PmCommandPositionalFinding[] {
  const destinations = new Set(destinationCommands);
  return [...new Set(explicitCommands)]
    .filter((command) => !destinations.has(command))
    .map((command) => ({
      code: "positional_signature_mismatch",
      command,
      detail: `Explicit positional signature ${command} has no destination declaration.`,
    }));
}

/** Return the semantic shape identity used by the positional-shape budget. */
export function positionalShapeKey(
  slots: readonly PmCommandPositionalSlotContract[],
): string {
  return slots
    .map(
      ({ required, variadic, value_kind: valueKind, polymorphic }) =>
        `${required ? "r" : "o"}:${variadic ? "v" : "s"}:${valueKind}:${polymorphic ? "p" : "m"}`,
    )
    .join("|");
}

/** Return the exact canonical identity of an ordered positional signature. */
export function positionalSignatureKey(
  slots: readonly PmCommandPositionalSlotContract[],
): string {
  return slots
    .map(
      ({ name, required, variadic, value_kind: valueKind, polymorphic }) =>
        `${name}:${required ? "r" : "o"}:${variadic ? "v" : "s"}:${valueKind}:${polymorphic ? "p" : "m"}`,
    )
    .join("|");
}

/** Return one deterministic finding for every repeated command path. */
function duplicatePositionalSignatureFindings(
  contracts: readonly PmCommandPositionalContract[],
  surface: "declared" | "observed",
): PmCommandPositionalFinding[] {
  const counts = new Map<string, number>();
  for (const { command } of contracts) {
    const normalized = normalizePositionalCommandPath(command);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([command, count]) => ({
      code: "positional_signature_mismatch",
      command,
      detail: `${count} ${surface} positional signatures exist for ${command}; exactly one is required.`,
    }));
}

/** Compare independently observed Commander signatures with the SDK declaration. */
export function verifyPmCommandPositionalContracts(
  observed: readonly PmCommandPositionalContract[],
  options: {
    declared?: readonly PmCommandPositionalContract[];
    positionalShapeBudget?: number;
  } = {},
): PmCommandPositionalReport {
  const declared = options.declared ?? PM_COMMAND_POSITIONAL_CONTRACTS;
  const positionalShapeBudget =
    options.positionalShapeBudget ??
    PM_CLI_GRAMMAR_CONTRACT.positional_shape_budget;
  const declaredByCommand = new Map(
    declared.map(
      (contract) =>
        [normalizePositionalCommandPath(contract.command), contract] as const,
    ),
  );
  const observedByCommand = new Map(
    observed.map(
      (contract) =>
        [normalizePositionalCommandPath(contract.command), contract] as const,
    ),
  );
  const findings: PmCommandPositionalFinding[] = [
    ...duplicatePositionalSignatureFindings(declared, "declared"),
    ...duplicatePositionalSignatureFindings(observed, "observed"),
    ...(options.declared === undefined
      ? verifyExplicitPositionalSlotCensus(
          EXPLICIT_POSITIONAL_SLOTS.keys(),
          PM_COMMAND_DESTINATION_CONTRACTS.map(({ command }) => command),
        )
      : []),
  ];
  for (const contract of declaredByCommand.values()) {
    const normalizedCommand = normalizePositionalCommandPath(contract.command);
    const actual = observedByCommand.get(normalizedCommand);
    if (!actual) {
      findings.push({
        code: "missing_observed_signature",
        command: contract.command,
        detail: `No observed positional signature exists for ${contract.command}.`,
      });
    } else if (
      positionalSignatureKey(actual.slots) !==
      positionalSignatureKey(contract.slots)
    ) {
      findings.push({
        code: "positional_signature_mismatch",
        command: contract.command,
        detail: `Observed positional signature for ${contract.command} differs from its declared SDK contract.`,
      });
    }
  }
  for (const contract of observedByCommand.values()) {
    if (
      !declaredByCommand.has(normalizePositionalCommandPath(contract.command))
    ) {
      findings.push({
        code: "stale_observed_signature",
        command: contract.command,
        detail: `Observed positional signature ${contract.command} has no declaration.`,
      });
    }
  }
  const positionalShapeCount = new Set(
    declared.map(({ slots }) => positionalShapeKey(slots)),
  ).size;
  if (positionalShapeCount > positionalShapeBudget) {
    findings.push({
      code: "positional_shape_budget_exceeded",
      command: "*",
      detail: `Distinct positional shape count ${positionalShapeCount} exceeds budget ${positionalShapeBudget}.`,
    });
  }
  findings.sort((left, right) =>
    left.command !== right.command
      ? left.command.localeCompare(right.command)
      : left.code.localeCompare(right.code),
  );
  return {
    ok: findings.length === 0,
    declared_command_count: declared.length,
    observed_command_count: observed.length,
    positional_shape_count: positionalShapeCount,
    positional_shape_budget: positionalShapeBudget,
    findings,
  };
}

/** One self-correcting grammar-gate finding. */
export interface PmCliGrammarFinding {
  /** Stable diagnostic category suitable for automated remediation. */
  code:
    | "alias_target_missing"
    | "duplicate_destination"
    | "missing_destination"
    | "stale_destination"
    | "unknown_noun"
    | "visible_surface_ceiling_exceeded";
  /** Exact command or alias spelling that violated the contract. */
  spelling: string;
  /** Human-readable explanation of the violated invariant. */
  message: string;
  /** Closest canonical invocation or corrective policy action. */
  nearest_target: string;
}

/** Deterministic conformance report for the live command and alias surfaces. */
export interface PmCliGrammarReport {
  /** Whether every checked grammar invariant passed. */
  ok: boolean;
  /** Number of normalized live command paths evaluated. */
  command_count: number;
  /** Number of checked-in destination-census rows. */
  destination_count: number;
  /** Number of declared aliases omitted from default discovery. */
  hidden_alias_count: number;
  /** Number of distinct visible non-package single-token command paths. */
  visible_top_level_count: number;
  /** Maximum visible single-token command paths permitted by the ADR. */
  visible_top_level_ceiling: number;
  /** Self-correcting conformance diagnostics, empty when `ok` is true. */
  findings: PmCliGrammarFinding[];
}

function validateCommandDestinations(
  commands: readonly string[],
  destinationsByCommand: ReadonlyMap<
    string,
    readonly PmCommandDestinationContract[]
  >,
  nounSet: ReadonlySet<string>,
): PmCliGrammarFinding[] {
  return commands.flatMap((command) => {
    const destinations = destinationsByCommand.get(command) ?? [];
    if (destinations.length === 0) {
      const separatorIndex = command.indexOf(" ");
      const root =
        separatorIndex === -1 ? command : command.slice(0, separatorIndex);
      return [
        {
          code: "missing_destination" as const,
          spelling: command,
          message: `Command \`${command}\` has no destination census row.`,
          nearest_target: nounSet.has(root) ? root : `ops ${command}`,
        },
      ];
    }
    const duplicateFinding: PmCliGrammarFinding[] =
      destinations.length > 1
        ? [
            {
              code: "duplicate_destination",
              spelling: command,
              message: `Command \`${command}\` has ${destinations.length} destination rows.`,
              nearest_target: destinations[0]!.target,
            },
          ]
        : [];
    return destinations.reduce<PmCliGrammarFinding[]>(
      (findings, destination) => {
        if (
          destination.disposition === "keep_as_is" &&
          (destination.reason?.trim().length ?? 0) === 0
        ) {
          findings.push({
            code: "missing_destination",
            spelling: command,
            message: `Command \`${command}\` is kept as-is without a documented reason.`,
            nearest_target: destination.target,
          });
        }
        if (!nounSet.has(destination.noun)) {
          findings.push({
            code: "unknown_noun",
            spelling: command,
            message: `Command \`${command}\` names undeclared noun \`${destination.noun}\`.`,
            nearest_target: destination.target,
          });
        }
        return findings;
      },
      duplicateFinding,
    );
  });
}

function validateDestinationCensus(
  commandSet: ReadonlySet<string>,
  destinations: readonly PmCommandDestinationContract[],
): PmCliGrammarFinding[] {
  return destinations
    .filter(
      (destination) =>
        destination.disposition !== "package_owned" &&
        !commandSet.has(destination.command),
    )
    .map((destination) => ({
      code: "stale_destination" as const,
      spelling: destination.command,
      message: `Destination row \`${destination.command}\` is absent from live contracts.`,
      nearest_target: destination.target,
    }));
}

function validateAliasTargets(
  aliases: readonly PmCommandAliasContract[],
  commandSet: ReadonlySet<string>,
): PmCliGrammarFinding[] {
  return aliases
    .filter((alias) => !commandSet.has(alias.canonical))
    .map((alias) => ({
      code: "alias_target_missing" as const,
      spelling: alias.alias,
      message: `Alias \`${alias.alias}\` targets missing canonical command \`${alias.canonical}\`.`,
      nearest_target: alias.canonical_argv.join(" "),
    }));
}

/** Verify exhaustive census parity, noun ownership, alias targets, and growth. */
export function verifyPmCliGrammar(
  commands: readonly string[],
  aliases?: readonly PmCommandAliasContract[],
): PmCliGrammarReport;
/** Implementation seam accepts an injected census for isolated conformance tests. */
export function verifyPmCliGrammar(
  commands: readonly string[],
  aliases: readonly PmCommandAliasContract[] = [],
  destinations: readonly PmCommandDestinationContract[] = PM_COMMAND_DESTINATION_CONTRACTS,
): PmCliGrammarReport {
  const normalizedCommands = [
    ...new Set(commands.map((command) => command.trim())),
  ]
    .filter((command) => command.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const commandSet = new Set(normalizedCommands);
  const nounSet = new Set<string>(PM_CLI_GRAMMAR_NOUNS);
  const destinationsByCommand = new Map<
    string,
    PmCommandDestinationContract[]
  >();
  for (const destination of destinations) {
    const entries = destinationsByCommand.get(destination.command) ?? [];
    entries.push(destination);
    destinationsByCommand.set(destination.command, entries);
  }
  const findings = [
    ...validateCommandDestinations(
      normalizedCommands,
      destinationsByCommand,
      nounSet,
    ),
    ...validateDestinationCensus(commandSet, destinations),
    ...validateAliasTargets(aliases, commandSet),
  ];
  const hiddenAliasNames = new Set(
    aliases.filter((alias) => alias.hidden).map((alias) => alias.alias),
  );
  const visibleTopLevelCount = new Set(
    normalizedCommands.filter(
      (command) =>
        !command.includes(" ") &&
        !hiddenAliasNames.has(command) &&
        !(destinationsByCommand.get(command) ?? []).some(
          (destination) => destination.disposition === "package_owned",
        ),
    ),
  ).size;
  if (
    visibleTopLevelCount > PM_CLI_GRAMMAR_CONTRACT.visible_top_level_ceiling
  ) {
    findings.push({
      code: "visible_surface_ceiling_exceeded",
      spelling: String(visibleTopLevelCount),
      message: `Visible non-package top-level command count ${visibleTopLevelCount} exceeds ceiling ${PM_CLI_GRAMMAR_CONTRACT.visible_top_level_ceiling}.`,
      nearest_target:
        "Declare the noun placement and tracked waiver before raising the ceiling.",
    });
  }
  return {
    ok: findings.length === 0,
    command_count: normalizedCommands.length,
    destination_count: destinations.length,
    hidden_alias_count: aliases.filter((alias) => alias.hidden).length,
    visible_top_level_count: visibleTopLevelCount,
    visible_top_level_ceiling:
      PM_CLI_GRAMMAR_CONTRACT.visible_top_level_ceiling,
    findings,
  };
}
