/**
 * @module cli/help-content
 *
 * Provides CLI runtime support for Help Content.
 */
import { Command } from "commander";

/**
 * Documents the help bundle payload exchanged by command, SDK, and package integrations.
 */
export interface HelpBundle {
  why: string;
  examples: string[];
  tips?: string[];
}

/**
 * Documents the help narrative payload exchanged by command, SDK, and package integrations.
 */
export interface HelpNarrative {
  intent: string;
  examples: string[];
  tips: string[];
  detail_mode: HelpDetailMode;
}

/**
 * Restricts help detail mode values accepted by command, SDK, and storage contracts.
 */
export type HelpDetailMode = "compact" | "detailed";

// Compact help/narrative surfaces show at most the first example. Centralizing this
// keeps the empty-examples guard in one place for renderCompactHelpBundle and
// resolveHelpNarrative (both must degrade to an empty list rather than [undefined]).
/**
 * Implements first example or empty for the public runtime surface of this module.
 */
export function firstExampleOrEmpty(examples: string[]): string[] {
  return examples.length > 0 ? [examples[0]] : [];
}

function renderCompactHelpBundle(bundle: HelpBundle): string {
  const lines: string[] = [
    "",
    "Intent:",
    `  ${bundle.why}`,
  ];
  const compactExamples = firstExampleOrEmpty(bundle.examples);
  if (compactExamples.length > 0) {
    lines.push("", "Example:");
    lines.push(`  ${compactExamples[0]}`);
  }
  lines.push("", "Need deeper rationale and more examples?");
  lines.push("  Re-run with --explain.");
  return lines.join("\n");
}

function renderDetailedHelpBundle(bundle: HelpBundle): string {
  const lines: string[] = [
    "",
    "Why use this command:",
    `  ${bundle.why}`,
    "",
    "Examples:",
    ...bundle.examples.map((example) => `  ${example}`),
  ];
  if (bundle.tips && bundle.tips.length > 0) {
    lines.push("", "Tips:");
    lines.push(...bundle.tips.map((tip) => `  - ${tip}`));
  }
  return lines.join("\n");
}

function renderHelpBundle(bundle: HelpBundle, detailMode: HelpDetailMode): string {
  if (detailMode === "detailed") {
    return renderDetailedHelpBundle(bundle);
  }
  return renderCompactHelpBundle(bundle);
}

/**
 * Implements normalize help command path for the public runtime surface of this module.
 */
export function normalizeHelpCommandPath(commandPath: string): string {
  return commandPath
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

const HELP_PATH_ALIASES: Record<string, string> = {
  cal: "calendar",
  ctx: "context",
};

function findDirectChildCommand(parent: Command, name: string): Command | null {
  return parent.commands.find((entry) => entry.name() === name) ?? null;
}

function findCommandByPath(root: Command, pathParts: string[]): Command | null {
  let current: Command = root;
  for (const part of pathParts) {
    const next = findDirectChildCommand(current, part);
    if (!next) {
      return null;
    }
    current = next;
  }
  return current;
}

function attachBundleByPath(root: Command, commandPath: string, bundle: HelpBundle, detailMode: HelpDetailMode): void {
  const command = findCommandByPath(root, commandPath.split(" ").filter((part) => part.length > 0));
  if (!command) {
    return;
  }
  command.addHelpText("after", renderHelpBundle(bundle, detailMode));
}

/**
 * Implements resolve help detail mode for the public runtime surface of this module.
 */
export function resolveHelpDetailMode(argv: string[]): HelpDetailMode {
  if (argv.includes("--explain")) {
    return "detailed";
  }
  return "compact";
}

const HELP_BY_COMMAND_PATH: Record<string, HelpBundle> = {
  init: {
    why: "Bootstraps tracker storage and settings so all other commands can run safely.",
    examples: [
      "pm init",
      "pm init acme",
      "pm init ./pm-sandbox --defaults",
      "pm init --preset minimal",
      "pm init --agent-guidance add",
      "pm init --defaults --with-packages",
    ],
    tips: [
      "Run this once per repository before create/list/update commands.",
      "A path-like positional (`./dir`, `/tmp/dir`) initializes that tracker path; a plain word remains an id prefix.",
      "Rewriting id prefix, governance preset, or default author on an existing tracker requires --force.",
      "Use --preset for non-interactive automation; omit it in a TTY to use the setup wizard.",
      "Use --agent-guidance add to inject compact AGENTS/CLAUDE workflow guidance, or --agent-guidance status to inspect missing guidance without modifying files.",
      "Use --with-packages when agents need bundled commands such as calendar and templates available immediately.",
    ],
  },
  config: {
    why: "Reads or updates project/global settings such as definition-of-done, item format, telemetry, and policy toggles.",
    examples: [
      'pm config project get definition-of-done',
      'pm config project set definition-of-done --criterion "tests pass"',
      "pm config project set item-format --format toon",
      "pm config project set sprint-release-format-policy --policy strict_error",
      "pm config project set governance-preset --policy minimal",
      "pm config project set governance-ownership-enforcement --policy none",
      "pm config project set test-result-tracking --policy enabled",
      "pm config global set telemetry-tracking --policy disabled",
    ],
  },
  extension: {
    why:
      "Compatibility command for package-backed runtime extension lifecycle operations across project or global scope.",
    examples: [
      "pm install ./my-package --project",
      "pm install '*' --project",
      "pm package doctor --project --detail summary",
      "pm package manage --global",
      "pm package activate sample-ext --project",
      "pm package deactivate sample-ext --project",
      "pm package uninstall sample-ext --global",
      "pm extension explore --project",
      "pm extension manage --global",
      "pm extension describe sample-ext --project",
      "pm extension doctor --detail deep",
    ],
    tips: [
      "Prefer pm install and pm package in new user-facing automation.",
      "Use pm extension when maintaining existing extension-specific scripts or debugging the compatibility runtime directly.",
      "Bundled aliases beads and todos resolve to package-shipped extension sources.",
      "Use --gh/--github shorthand for GitHub sources and --ref to pin a branch, tag, or ref.",
      "Install updates settings activation state automatically unless extension allowlist mode is unchanged.",
      "Use --adopt for single-extension adoption and --adopt-all to bulk-register unmanaged installs as managed without reinstalling.",
      "Use --manage for concise triage summaries and remediation-oriented diagnostics alongside full extension details.",
      "Use --describe to map exactly what each loaded extension registers (commands, hooks, item types, providers, overrides) in one call.",
      "Use --doctor for consolidated diagnostics with warning codes, remediation hints, and optional deep detail payloads.",
    ],
  },
  package: {
    why:
      "Installs, explores, manages, diagnoses, adopts, activates, deactivates, and refreshes package-backed pm runtime extensions.",
    examples: [
      "pm install npm:@scope/pm-package --project",
      "pm package install ./my-package --project",
      "pm package doctor --project --detail deep",
      "pm package manage --project --runtime-probe",
      "pm package describe --project",
      "pm package activate sample-ext --project",
      "pm upgrade --packages-only --dry-run",
    ],
    tips: [
      "Prefer package vocabulary for user-facing workflows; extension vocabulary remains available for compatibility.",
      "Use pm package describe [name] to map every surface a package registers without reading its manifest or running diagnostics.",
      "Use pm upgrade to refresh the CLI/SDK and managed packages from their recorded sources.",
      "Use --dry-run before upgrade when automation needs a deterministic plan.",
    ],
  },
  "package init": {
    why: "Generates an installable starter pm package with package metadata and a root extension entrypoint.",
    examples: [
      "pm package init ./my-package",
      "pm package init ./my-hook-package --capability hooks",
      "pm package init ./my-search-package --capability search",
      "pm package init ./my-sync-package --capability importers",
      "pm package init ./my-domain-package --capability schema",
      "pm install ./my-sync-package --project",
      "pm package doctor --project --detail summary",
    ],
    tips: [
      "Use --capability hooks for a starter after_command lifecycle reactor with runnable SDK testing coverage.",
      "Use --capability search for a starter search provider/vector-store adapter with runnable SDK testing coverage.",
      "Use --capability importers for paired import/export commands that move project context across systems.",
      "Use --capability schema for a starter custom item type, field, and migration so pm models your project domain.",
      "The generated package is local-install safe; add SDK runtime imports only after declaring dependencies and validating with package doctor.",
      "Use package doctor after changes to verify activation, policy, and collision diagnostics.",
    ],
  },
  "package install": {
    why: "Installs pm packages from local paths, npm sources, GitHub sources, bundled aliases, or wildcard/all aliases.",
    examples: [
      "pm package install ./my-package --project",
      "pm install npm:pm-changelog --project",
      "pm package install --github org/repo/packages/my-pm-package --ref main",
    ],
    tips: [
      "Prefer the top-level pm install alias in scripts when only installation is needed.",
      "Run pm package manage or pm package doctor after installing external packages.",
    ],
  },
  "package catalog": {
    why: "Lists bundled first-party package catalog metadata and compact field projections.",
    examples: [
      "pm package catalog --project",
      "pm package catalog --project --fields alias,installed,install_command",
      "pm package list --project --fields alias,package_name,category",
    ],
    tips: [
      "Use --fields for low-token package discovery in agent loops.",
      "External npm package discovery still belongs to npm search.",
    ],
  },
  "extension init": {
    why: "Generates an installable starter runtime extension with manifest and entrypoint files.",
    examples: [
      "pm extension init ./my-extension",
      "pm extension init ./my-hook-extension --capability hooks",
      "pm extension init ./my-search-extension --capability search",
      "pm extension init ./my-sync-extension --capability importers",
      "pm extension init ./my-domain-extension --capability schema",
      "pm extension --install --project ./my-sync-extension",
      "pm extension --doctor --project --detail summary",
    ],
    tips: [
      "Use --capability hooks when the extension should react to command lifecycle events.",
      "Use --capability search when the extension should register retrieval primitives.",
      "Use --capability importers when the extension should register project-context import/export commands.",
      "Use --capability schema when the extension should register custom item types, fields, and migrations.",
      "Use package init for new distributable package workflows; extension init is the compatibility-level runtime scaffold.",
    ],
  },
  "extension install": {
    why: "Installs a compatibility runtime extension from local, npm, GitHub, bundled alias, or wildcard sources.",
    examples: [
      "pm extension install ./my-extension --project",
      "pm extension --install --project ./my-extension",
      "pm extension doctor --project --detail summary",
    ],
    tips: ["Prefer pm install or pm package install for new package-first automation."],
  },
  "extension catalog": {
    why: "Compatibility view of bundled package catalog metadata.",
    examples: [
      "pm extension catalog --project",
      "pm extension catalog --project --fields alias,installed,install_command",
    ],
    tips: ["Prefer pm package catalog in new user-facing workflows."],
  },
  install: {
    why: "Installs a pm package into project scope by default, using local, npm, GitHub, or bundled alias sources.",
    examples: [
      "pm install '*' --project",
      "pm install ./packages/pm-todos --project",
      "pm install npm:@scope/pm-package --global",
      "pm install --github org/repo/packages/my-pm-package --ref main",
    ],
    tips: ["Installed packages are recorded in managed state and can be inspected with pm package manage."],
  },
  upgrade: {
    why: "Updates the global pm CLI/SDK and refreshes managed pm packages from recorded install sources.",
    examples: [
      "pm upgrade --dry-run",
      "pm upgrade --packages-only --project",
      "pm upgrade todos --dry-run",
      "pm upgrade --cli-only --repair",
      "pm upgrade --tag next --dry-run",
    ],
    tips: [
      "Omit target to include the CLI/SDK plus all managed packages in the selected scope.",
      "Pass a target to refresh one managed package by name, directory, package name, or source.",
      "Use --packages-only in repository automation when the global CLI should not be changed.",
    ],
  },
  create: {
    why: "Creates a new planning item with deterministic metadata and history.",
    examples: [
      'pm create --title "Harden lock flow" --description "Improve stale lock handling" --type Task --status open --priority 1 --message "Create lock hardening task" --create-mode progressive',
      'pm create --title "Weekly planning sync" --description "Recurring coordination meeting" --type Meeting --schedule-preset lightweight',
      'pm create --title "Asset: Hero model" --description "Track playable model asset" --type Asset --status open --priority 1 --message "Create asset item" --type-option category=Character --dep "id=pm-epic01,kind=parent,author=codex-agent,created_at=now" --comment "author=codex-agent,created_at=now,text=Why this asset item exists." --note "author=codex-agent,created_at=now,text=Initial implementation note." --learning "author=codex-agent,created_at=now,text=Durable lesson placeholder." --file "path=src/assets/hero.glb,note=tracked asset" --test "command=node scripts/run-tests.mjs test,timeout_seconds=240" --doc "path=README.md,note=asset docs"',
    ],
    tips: [
      "Use --schedule-preset lightweight for Reminder/Meeting/Event when you want minimal required create inputs.",
      "Use --type <value> to load type-aware policy guidance in --help output.",
    ],
  },
  focus: {
    why: "Sets a session focused item so new pm create items default their --parent to it (project management = context management).",
    examples: [
      "pm focus pm-epic1",
      "pm focus",
      "pm focus --clear",
    ],
    tips: [
      "Focus is session-local (stored in .agents/pm/runtime/session.json, gitignored) — it never affects teammates.",
      "An explicit --parent on pm create always overrides the focused item; use --parent \"\" to create with no parent.",
      "A stale focused item produces the same missing-parent validation as an explicit stale --parent.",
    ],
  },
  update: {
    why: "Mutates existing item fields while preserving history and lock safety.",
    examples: [
      'pm update pm-a1b2 --status in_progress --message "Start implementation"',
      'pm update pm-a1b2 --unset close-reason --message "Clear stale close reason after reopen"',
      'pm update pm-a1b2 --unset assignee --deadline +2d --message "Replan ownership and deadline"',
      'pm update pm-a1b2 --body "Backfilled body text for legacy item" --message "Normalize missing body"',
    ],
    tips: [
      'Use "pm close <ID> <TEXT>" to close items instead of --status closed.',
      "When reopening from closed to a non-terminal status, update clears stale close_reason unless explicitly set via --close-reason.",
      'Use "pm append <ID> --body <text>" for additive notes; use update --body to replace body content.',
    ],
  },
  "update-many": {
    why: "Bulk-updates matched item sets with dry-run previews and rollback checkpoints for safe large-scale metadata changes.",
    examples: [
      "pm update-many --filter-status open --status in_progress --dry-run",
      'pm update-many --filter-tag wave:7 --replace-tests --test "command=node scripts/run-tests.mjs test -- tests/core/history.spec.ts,timeout_seconds=240"',
      'pm update-many --filter-tag governance --reviewer maintainer-review --message "Normalize reviewer metadata"',
      "pm update-many --rollback ckpt-abc123",
    ],
    tips: [
      "Use --dry-run first to inspect proposed changes before apply mode.",
      "Linked-array mutation flags mirror pm update semantics (for example --replace-tests, --clear-files, and repeatable --doc/--note seeds).",
      "Checkpoints are enabled by default for apply mode and can be restored with --rollback.",
    ],
  },
  "close-many": {
    why: "Bulk-closes matched items with a shared reason routed through full pm close semantics (close validation, active-child orphan checks, blocked-edge cleanup) plus dry-run previews and rollback checkpoints — unlike update-many --status closed, which bypasses close validation.",
    examples: [
      'pm close-many --filter-sprint S-12 --reason "Sprint S-12 acceptance criteria met" --dry-run',
      'pm close-many --filter-tag wave:7 --reason "Superseded by redesign" --validate-close warn',
      'pm close-many --ids pm-a,pm-b,pm-c --reason "Closed in batch" --resolution "Verified by integration suite"',
      "pm close-many --rollback close-many-20260604-abc123",
    ],
    tips: [
      "At least one filter (--filter-* or --ids) is required so close-many never matches every item.",
      "Already-terminal matches are skipped by default; pass --force to re-close them.",
      "Use --dry-run to preview matches plus per-item skip reasons and active-child orphan warnings before applying.",
      "Checkpoints are enabled by default for apply mode; restore with --rollback <checkpoint-id>.",
    ],
  },
  normalize: {
    why:
      "Scans items for low-signal lifecycle metadata drift, emits deterministic per-item plans, and optionally applies normalized metadata updates with update-style safety checks.",
    examples: [
      "pm normalize --dry-run",
      "pm normalize --filter-status in_progress --dry-run",
      'pm normalize --filter-status closed --apply --author "codex-agent" --message "Normalize closure metadata"',
    ],
    tips: [
      "Dry-run mode is the default; pass --apply only after reviewing planned changes.",
      "Apply mode honors ownership/audit constraints and supports --allow-audit-update with optional --force override.",
    ],
  },
  templates: {
    why: "Saves, lists, and inspects reusable create option bundles for repeatable workflows.",
    examples: [
      'pm templates save triage-default --title "Triage item" --description "..." --type Task --status open --priority 2 --message "Seed triage template"',
      "pm templates list",
      "pm templates show triage-default",
    ],
    tips: [
      "Template names are positional arguments (`pm templates save <name>` and `pm templates show <name>`), not --name flags.",
      "Combine templates with explicit create flags; explicit flags always override template defaults.",
    ],
  },
  deps: {
    why: "Inspects an item dependency graph as a tree or graph payload to understand blockers and hierarchy links.",
    examples: [
      "pm deps pm-a1b2",
      "pm deps pm-a1b2 --format graph",
      "pm deps pm-a1b2 --max-depth 2 --collapse repeated --summary",
    ],
    tips: ["Use --summary for lightweight counts when full graph payloads are unnecessary."],
  },
  list: {
    why: "Lists active items with deterministic filtering and ordering.",
    examples: [
      "pm list --limit 20",
      "pm list --type Task --priority 0 --tag release --assignee codex-agent",
      "pm list --compact --sort deadline --order asc",
      "pm list --fields id,title,parent,type --sort parent --order asc",
    ],
  },
  "list-all": {
    why: "Lists all item states (including terminal states) when you need full visibility.",
    examples: ["pm list-all --limit 50", "pm list-all --type Issue --include-body"],
  },
  "list-open": {
    why: "Shows work that is ready to claim and start.",
    examples: ["pm list-open --priority 0 --limit 10"],
  },
  "list-in-progress": {
    why: "Tracks active execution and owner progress.",
    examples: ["pm list-in-progress --assignee codex-agent --limit 20"],
  },
  "list-blocked": {
    why: "Surfaces blocked work that needs intervention.",
    examples: ["pm list-blocked --limit 20"],
  },
  "list-closed": {
    why: "Reviews completed work and closure outcomes.",
    examples: ["pm list-closed --limit 20 --type Task"],
  },
  "list-canceled": {
    why: "Audits intentionally discontinued work.",
    examples: ["pm list-canceled --limit 20"],
  },
  "list-draft": {
    why: "Finds incompletely defined items that need refinement before execution.",
    examples: ["pm list-draft --limit 20"],
  },
  aggregate: {
    why: "Runs grouped aggregation queries for governance checks such as decomposition by parent/type or triage by status/priority.",
    examples: [
      "pm aggregate --group-by parent,type --count",
      "pm aggregate --group-by type,status --count",
      "pm aggregate --group-by parent,type --count --status open --parent pm-feature01",
    ],
    tips: ["Current aggregate mode is grouped counts only, so pass --count explicitly."],
  },
  "dedupe-audit": {
    why: "Audits potential duplicate items and emits deterministic merge suggestions before any mutation.",
    examples: [
      "pm dedupe-audit --mode title_exact",
      "pm dedupe-audit --mode title_fuzzy --threshold 0.8 --limit 20",
      "pm dedupe-audit --mode parent_scope --status open",
    ],
    tips: ["Use title_exact for strict collisions, title_fuzzy for near-duplicates, and parent_scope for child-level collisions."],
  },
  guide: {
    why: "Routes local progressive-disclosure documentation so agents can fetch only the context they need.",
    examples: [
      "pm install guide-shell --project",
      "pm guide",
      "pm guide quickstart",
      "pm guide commands --depth standard",
      "pm guide skills --depth deep --format markdown",
      "pm guide release --json",
    ],
    tips: [
      "Use brief depth for minimal token footprint, standard for excerpted docs, and deep for full local document rendering.",
      "Use --list to force topic index output even when topic parsing is ambiguous.",
    ],
  },
  calendar: {
    why: "Provides deadline/reminder/event scheduling views for planning and coordination.",
    examples: [
      "pm calendar",
      "pm calendar --view agenda --from +0d --to +7d --assignee codex-agent",
      "pm calendar --view week --date 2026-04-06 --full-period --include deadlines,events",
      "pm calendar --view month --tag release --format json",
    ],
    tips: [
      "Day/week/month views are anchored period windows; default mode clips the start to now unless --past or --full-period is set.",
      "--full-period applies only to day/week/month views; use --from/--to to bound agenda windows.",
    ],
  },
  context: {
    why: "Builds an agent-optimized snapshot of critical active work plus near-term agenda context with progressive depth levels.",
    examples: [
      "pm context",
      "pm ctx --depth standard --limit 10",
      "pm ctx --depth deep --assignee codex-agent",
      "pm ctx --section hierarchy --section progress --section blockers",
      "pm context --depth standard --activity-limit 20 --stale-threshold 14d",
      "pm context --from +0d --to +7d --format markdown --depth deep",
    ],
    tips: [
      "High-level focus contains Epics/Features and low-level focus contains Tasks/Issues/Chores/Decisions/Event/Reminder/Milestone/Meeting/Plan.",
      "When no open or in-progress work exists, blocked items are shown as fallback context.",
      "--depth brief (default) shows focus+agenda; standard adds hierarchy/activity/progress/workload; deep adds blockers/files/staleness/tests.",
      "--section overrides --depth and selects specific sections: hierarchy, activity, progress, blockers, files, workload, staleness, tests.",
      "Configure defaults via pm config project set context --default-depth standard --activity-limit 15.",
    ],
  },
  search: {
    why: "Finds relevant items by keyword, semantic, or hybrid retrieval modes.",
    examples: [
      'pm search "lock stale retry" --mode keyword --limit 10',
      'pm search "extension migration blockers" --mode hybrid --type Task --priority 0',
      'pm search "Cross-Epic Realism Dependency Council" --mode keyword --title-exact',
    ],
    tips: [
      "Use --title-exact to require exact normalized title parity, or --phrase-exact to require full-phrase matches in item text fields.",
      "Use --include-linked when linked docs/files/tests should influence scoring.",
    ],
  },
  eval: {
    why: "Measures search relevance against a curated golden-query set so retrieval regressions are caught, not guessed.",
    examples: [
      "pm eval --json",
      "pm eval --mode hybrid --k 10",
      "pm eval --fail-under 0.6 --json",
      "pm eval --queries ./my-eval.json --mode semantic",
    ],
    tips: [
      "Curate ground truth in <pmRoot>/search/eval-queries.json as an array of {query, relevant_ids, mode?} objects.",
      "Wire --fail-under into CI to fail the build when aggregate nDCG@k drops below your baseline.",
    ],
  },
  reindex: {
    why: "Rebuilds search artifacts after large changes to item corpus or provider/vector config.",
    examples: ["pm reindex --mode keyword", "pm reindex --mode hybrid --progress --json"],
    tips: [
      "Use --progress for non-interactive visibility during local embedding runs.",
      "JSON output includes semantic stale/unchanged/embed/upsert counts so agents can gate long reindex work without parsing stderr.",
    ],
  },
  get: {
    why: "Shows details for one item by ID, with optional lower-token projections for agent loops.",
    examples: [
      "pm get pm-a1b2",
      "pm get pm-a1b2 --depth brief --json",
      "pm get pm-a1b2 --fields id,title,status,parent,type --json",
    ],
    tips: [
      "Default depth is standard for body plus linked artifacts without append-only logs; use brief for metadata-only checks or --full for complete history-heavy metadata.",
      "Use --fields for the smallest deterministic item metadata payload when an agent only needs specific fields.",
      "JSON output shape is { item, linked, claim_state, children }; body is nested at item.body (parity with list --include-body), and children appears for requested/container rollups.",
    ],
  },
  history: {
    why: "Inspects item mutation timeline and audit trail.",
    examples: ["pm history pm-a1b2 --limit 20", "pm history pm-a1b2 --full --verify"],
  },
  "history-compact": {
    why: "Compacts long history streams into a synthetic checkpoint while preserving replay integrity. Pass an item id for one stream, or a bulk selector (--ids/--all-over/--closed/--all-streams) to sweep many.",
    examples: [
      "pm history-compact pm-a1b2 --dry-run",
      "pm history-compact pm-a1b2 --before 25 --author codex-agent --message \"Compact early history\"",
      "pm history-compact --all-over 500 --dry-run",
      "pm history-compact --closed --author codex-agent",
      "pm history-compact --ids pm-a1b2,pm-c3d4 --dry-run",
    ],
  },
  activity: {
    why: "Reviews recent tracker-wide activity across items.",
    examples: [
      "pm activity --limit 50",
      "pm activity --full --id pm-a1b2 --limit 50",
      "pm activity --id pm-a1b2 --op update --author codex-agent --from -7d --to now",
      "pm activity --json --stream rows --limit 200",
    ],
    tips: ["Use --stream with --json for line-delimited automation output; --from is inclusive and --to is exclusive."],
  },
  restore: {
    why: "Restores an item to a prior timestamp/version with history replay safety.",
    examples: ['pm restore pm-a1b2 2026-04-01T00:00:00.000Z --author "codex-agent" --message "Rollback to known-good state"'],
  },
  close: {
    why: "Transitions work to terminal closed state with explicit rationale.",
    examples: [
      'pm close pm-a1b2 "All acceptance criteria met" --author "codex-agent" --message "Close after verification"',
      'pm close pm-a1b2 "Done" --validate-close',
      'pm close pm-a1b2 "Done" --validate-close off',
      'pm close pm-a1b2 "Done" --validate-close strict',
    ],
  },
  delete: {
    why: "Removes an item while preserving history evidence and lock/ownership checks.",
    examples: ['pm delete pm-a1b2 --author "codex-agent" --message "Remove duplicate item"'],
  },
  append: {
    why: "Adds implementation notes to body without replacing existing content.",
    examples: ['pm append pm-a1b2 --body "Implemented retry with bounded backoff." --message "Record implementation detail"'],
  },
  comments: {
    why: "Adds or reviews lightweight status updates linked to an item.",
    examples: [
      'pm comments pm-a1b2 "Verified fix on Linux and macOS"',
      'pm comments pm-a1b2 --add "Verified fix on Linux and macOS"',
      'printf "%s\\n" "## Verification" "- linux pass" "- mac pass" | pm comments pm-a1b2 --stdin',
      'pm comments pm-a1b2 --file docs/release-evidence.md --author "codex-agent"',
      'pm comments pm-a1b2 --add "text: verification note with commas, key-like words, and parser details"',
      'pm comments pm-a1b2 --add "Follow-up needed after review" --author "codex-agent" --force',
      "pm comments pm-a1b2 --limit 10",
    ],
    tips: [
      "Use exactly one comment source at a time: positional [text], --add, --stdin, or --file.",
      "Use --force when adding comments to items currently assigned to a different owner.",
      "When --add payload resembles CSV-like key fragments (for example text=hello,scope:project), plain-text fallback is intentional; use explicit text=..., markdown text: ..., or stdin token - for structured intent.",
    ],
  },
  "comments-audit": {
    why: "Audits latest comments or full history rows across filtered item sets.",
    examples: [
      "pm comments-audit --status open --latest 1",
      "pm comments-audit --status open --latest 0",
      "pm comments-audit --parent pm-feature01 --tag governance --sprint sprint-12 --release vnext --priority 0",
      "pm comments-audit --full-history --limit 50",
    ],
    tips: [
      "Use either --latest or --full-history (not both). --latest 0 returns item summaries without comment rows. --limit is an alias for --limit-items.",
    ],
  },
  notes: {
    why: "Adds or reviews durable implementation notes linked to an item.",
    examples: [
      'pm notes pm-a1b2 --add "Investigated parser edge case and documented fallback logic."',
      'pm notes pm-a1b2 --add "text: parser rationale with commas, colons, and key-like wording"',
      'pm notes pm-a1b2 --add "Audit note" --author "reviewer" --allow-audit-note',
      "pm notes pm-a1b2 --limit 10",
    ],
    tips: [
      "Use --allow-audit-note for append-only non-owner audits; --allow-audit-comment remains supported as a legacy alias.",
      "CSV-like add payloads with extra key fragments are treated as plain text by design; use explicit text keys (text= or text:) when structured parsing is required.",
    ],
  },
  learnings: {
    why: "Adds or reviews post-implementation learnings for future work.",
    examples: [
      'pm learnings pm-a1b2 --add "Avoid direct test-runner commands in linked tests; use sandbox runner."',
      'pm learnings pm-a1b2 --add "text: lesson with commas, key-like words, and punctuation-safe context"',
      'pm learnings pm-a1b2 --add "Audit learning" --author "reviewer" --allow-audit-learning',
      "pm learnings pm-a1b2 --limit 10",
    ],
    tips: [
      "Use --allow-audit-learning for append-only non-owner audits; --allow-audit-comment remains supported as a legacy alias.",
      "If you intended structured parsing for a key-like payload, prefer explicit text=..., markdown text: ..., or stdin token -; ambiguous CSV-like forms intentionally remain plain text.",
    ],
  },
  files: {
    why: "Associates changed source files with tracker items for reproducibility.",
    examples: [
      'pm files pm-a1b2 --add "path=src/cli/main.ts,note=help orchestration"',
      'pm files pm-a1b2 --add src/cli/main.ts --note "help orchestration"',
      "pm files discover pm-a1b2",
      'pm files discover pm-a1b2 --apply --note "discovered from item text"',
    ],
  },
  docs: {
    why: "Associates relevant documentation paths with tracker items.",
    examples: [
      'pm docs pm-a1b2 --add "path=README.md,note=user-facing command guidance"',
      'pm docs pm-a1b2 --add README.md --note "user-facing command guidance"',
    ],
  },
  test: {
    why: "Links test commands/paths and optionally executes them for one item.",
    examples: [
      'pm test pm-a1b2 --add "command=node scripts/run-tests.mjs test -- tests/unit/output.spec.ts,timeout_seconds=2400"',
      'pm test pm-a1b2 --add "command=pm list-all --type Task --limit 200,assert_stdout_contains=count:,assert_stdout_regex=count:\\s+\\d+"',
      'pm test pm-a1b2 --add "command=pm list-all --type Task --limit 200,pm_context_mode=auto"',
      "pm test pm-a1b2 --run --timeout 2400 --env-set PORT=0 --env-clear PLAYWRIGHT_BASE_URL --shared-host-safe --pm-context tracker --fail-on-context-mismatch --fail-on-skipped",
      "pm test pm-a1b2 --run --timeout 2400 --pm-context auto",
      "pm test pm-a1b2 --run --background --timeout 2400 --progress",
    ],
  },
  "test-all": {
    why: "Runs linked tests in bulk for release/readiness sweeps.",
    examples: [
      "pm test-all --status in_progress --limit 5 --offset 10 --timeout 2400",
      "pm test-all --status closed --timeout 3600 --progress --env-set PORT=0 --shared-host-safe --fail-on-skipped",
      "pm test-all --status in_progress --pm-context tracker --fail-on-context-mismatch --require-assertions-for-pm",
      "pm test-all --status in_progress --pm-context auto --fail-on-context-mismatch",
      "pm test-all --status in_progress --background --timeout 3600",
    ],
  },
  "test-runs": {
    why: "Manages background linked-test runs with lifecycle controls and log/status inspection.",
    examples: [
      "pm test-runs list --status running --limit 20",
      "pm test-runs status tr-abc123",
      "pm test-runs logs tr-abc123 --stream stderr --tail 200",
      "pm test-runs stop tr-abc123",
      "pm test-runs resume tr-abc123",
    ],
  },
  stats: {
    why: "Reports tracker-level totals and distribution by type/status.",
    examples: ["pm stats", "pm stats --json"],
  },
  telemetry: {
    why: "Inspects and manages local telemetry queue/runtime state for observability diagnostics.",
    examples: [
      "pm telemetry status",
      "pm telemetry stats --limit 10",
      "pm telemetry flush",
      "pm telemetry clear",
    ],
  },
  health: {
    why: "Validates tracker/runtime health including extension triage, migration, and integrity diagnostics.",
    examples: [
      "pm health",
      "pm health --check-only --summary --json",
      "pm health --brief --json",
      "pm health --no-refresh",
      "pm health --refresh-vectors",
    ],
  },
  validate: {
    why:
      "Runs standalone metadata, resolution, lifecycle (including dependency-cycle diagnostics), linked-file, linked-command reference, and history drift checks with default remediation hints for resolution gaps.",
    examples: [
      "pm validate",
      "pm validate --check-resolution --json",
      "pm validate --check-lifecycle --dependency-cycle-severity error",
      "pm validate --check-lifecycle --parent-cycle-severity error",
      "pm validate --check-files --scan-mode tracked-all",
      "pm validate --check-files --scan-mode tracked-all-strict --include-pm-internals",
      "pm validate --check-command-references",
      "pm validate --check-resolution --fail-on-warn --json",
    ],
    tips: ["Resolution-gap warnings include default `pm update <id> ...` remediation hint templates in check details."],
  },
  gc: {
    why: "Deletes optional cache artifacts by default to keep local tracker state tidy; use --dry-run to preview targets without deleting files.",
    examples: ["pm gc --dry-run", "pm gc"],
  },
  claim: {
    why: "Claims an item to signal active ownership and reduce conflicts.",
    examples: [
      'pm claim pm-a1b2 --author "codex-agent" --message "Claim for implementation"',
      'pm claim pm-a1b2 --force --author "codex-agent" --message "Take over terminal item"',
    ],
    tips: ["Claim takeover for non-terminal items does not require --force; --force is reserved for terminal/lock overrides."],
  },
  release: {
    why: "Releases an active claim when paused, handed off, or completed.",
    examples: [
      'pm release pm-a1b2 --author "codex-agent" --message "Release after closure"',
      'pm release pm-a1b2 --allow-audit-release --author "reviewer" --message "Audit handoff release"',
    ],
    tips: ["Use --allow-audit-release for non-owner handoffs that only clear assignee metadata."],
  },
  "start-task": {
    why: "Lifecycle alias that claims an item and sets status to in_progress.",
    examples: ['pm start-task pm-a1b2 --author "codex-agent" --message "Start implementation"'],
  },
  "pause-task": {
    why: "Lifecycle alias that sets status to open and releases active assignment.",
    examples: ['pm pause-task pm-a1b2 --author "codex-agent" --message "Pause for dependency unblock"'],
  },
  "close-task": {
    why: "Lifecycle alias that closes with reason text and clears assignment metadata.",
    examples: ['pm close-task pm-a1b2 "All acceptance criteria met" --author "codex-agent" --message "Close and handoff"'],
  },
  meet: {
    why: "Shortcut to create a Meeting from friendly time flags (start/duration) without structured --event CSV.",
    examples: [
      'pm meet "Sprint Planning" --start +1h --duration 1h',
      'pm meet "1:1" --start 2026-07-01T15:00:00Z --end 2026-07-01T15:30:00Z --location "Room A"',
    ],
    tips: [
      "Start defaults to now and duration to 1h; pass --end to set an explicit end instead of --duration.",
      "--duration accepts relative tokens (h/d/w/m where m is months) plus sub-hour forms like 30min or PT30M.",
    ],
  },
  event: {
    why: "Shortcut to create an Event from friendly time flags (start/duration) without structured --event CSV.",
    examples: [
      'pm event "Release v2" --start 2026-07-01T10:00:00Z --duration 2h',
      'pm event "Conference" --start 2026-08-01 --all-day',
    ],
    tips: [
      "Start defaults to now and duration to 1h; pass --end to set an explicit end instead of --duration.",
      "--duration accepts relative tokens (h/d/w/m where m is months) plus sub-hour forms like 30min or PT30M.",
    ],
  },
  remind: {
    why: "Shortcut to create a Reminder from a single point in time without structured --reminder CSV.",
    examples: ['pm remind "Review PR" --at +2d', 'pm remind "Follow up" --at 2026-07-01T09:00:00Z --text "Ping the team"'],
    tips: ["The reminder time defaults to +1d and the reminder text defaults to the title."],
  },
  completion: {
    why: "Generates shell completion scripts for faster and more reliable command entry.",
    examples: ["pm completion bash", "pm completion zsh", "pm completion fish", "pm completion bash --eager-tags"],
    tips: ["Default scripts resolve tag suggestions lazily at completion time; use --eager-tags to embed current tags directly."],
  },
  contracts: {
    why: "Exposes machine-readable CLI command and tool schema contracts for agent integrations.",
    examples: [
      "pm contracts",
      "pm contracts --command list --runtime-only",
      "pm contracts --command update --flags-only",
      "pm contracts --availability-only --runtime-only",
      "pm contracts --action create",
      "pm contracts --schema-only",
    ],
    tips: ["Use --command to narrow actions/schema to one CLI surface; combine with --flags-only or --availability-only for lighter payloads."],
  },
};

export const ROOT_HELP_BUNDLE: HelpBundle = {
  why: "Provides deterministic project management workflows for humans and coding agents.",
  examples: [
    "pm init",
    "pm install guide-shell --project",
    "pm list-open --limit 10",
    'pm create --title "..." --description "..." --type Task --status open --priority 1 --message "..." --create-mode progressive',
  ],
  tips: [
    "Use <command> --help for command-specific guidance and examples.",
    "Install guide-shell before using pm guide for local docs and skills routing.",
    "Use --json for machine parsing and integration flows.",
    "Use --no-pager to force direct help output in CI and other non-interactive shells.",
  ],
};

function resolveCanonicalHelpPath(commandPath: string | undefined): string {
  const normalized = normalizeHelpCommandPath(commandPath ?? "");
  if (!normalized) {
    return "";
  }
  return HELP_PATH_ALIASES[normalized] ?? normalized;
}

/**
 * Implements resolve help bundle for path for the public runtime surface of this module.
 */
export function resolveHelpBundleForPath(commandPath: string | undefined): HelpBundle {
  const canonicalPath = resolveCanonicalHelpPath(commandPath);
  if (!canonicalPath) {
    return ROOT_HELP_BUNDLE;
  }
  return HELP_BY_COMMAND_PATH[canonicalPath] ?? ROOT_HELP_BUNDLE;
}

/**
 * Implements resolve help narrative for the public runtime surface of this module.
 */
export function resolveHelpNarrative(commandPath: string | undefined, detailMode: HelpDetailMode): HelpNarrative {
  const bundle = resolveHelpBundleForPath(commandPath);
  return {
    intent: bundle.why,
    examples: detailMode === "detailed" ? [...bundle.examples] : firstExampleOrEmpty(bundle.examples),
    tips: detailMode === "detailed" ? [...(bundle.tips ?? [])] : [],
    detail_mode: detailMode,
  };
}

/**
 * Implements attach rich help text for the public runtime surface of this module.
 */
export function attachRichHelpText(program: Command, argv: string[] = process.argv.slice(2)): void {
  const detailMode = resolveHelpDetailMode(argv);
  program.addHelpText("after", renderHelpBundle(ROOT_HELP_BUNDLE, detailMode));
  for (const [commandPath, bundle] of Object.entries(HELP_BY_COMMAND_PATH)) {
    attachBundleByPath(program, commandPath, bundle, detailMode);
  }
}

export const _testOnly = {
  renderCompactHelpBundle,
  renderDetailedHelpBundle,
};
