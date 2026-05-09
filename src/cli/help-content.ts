import { Command } from "commander";

export interface HelpBundle {
  why: string;
  examples: string[];
  tips?: string[];
}

export interface HelpNarrative {
  intent: string;
  examples: string[];
  tips: string[];
  detail_mode: HelpDetailMode;
}

export type HelpDetailMode = "compact" | "detailed";

function renderCompactHelpBundle(bundle: HelpBundle): string {
  const lines: string[] = [
    "",
    "Intent:",
    `  ${bundle.why}`,
  ];
  if (bundle.examples.length > 0) {
    lines.push("", "Example:");
    lines.push(`  ${bundle.examples[0]}`);
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

export function resolveHelpDetailMode(argv: string[]): HelpDetailMode {
  if (argv.includes("--explain")) {
    return "detailed";
  }
  return "compact";
}

const HELP_BY_COMMAND_PATH: Record<string, HelpBundle> = {
  init: {
    why: "Bootstraps tracker storage and settings so all other commands can run safely.",
    examples: ['pm init', 'pm init acme', "pm init --preset minimal", "pm init --preset strict"],
    tips: [
      "Run this once per repository before create/list/update commands.",
      "Use --preset for non-interactive automation; omit it in a TTY to use the setup wizard.",
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
      "Installs, explores, manages, diagnoses, adopts (single or bulk), and activates/deactivates custom extensions across project or global scope.",
    examples: [
      "pm extension init ./my-extension",
      "pm extension install beads --project",
      "pm extension install todos --global",
      "pm extension install .agents/pm/extensions/sample --project",
      "pm extension install https://github.com/unbraind/pm-cli/tree/main/.agents/pm/extensions/pi --global",
      "pm extension install --gh unbraind/pm-cli/pi --project",
      "pm extension explore --project",
      "pm extension manage --global",
      "pm extension doctor --detail deep",
      "pm extension adopt sample-ext --project",
      "pm extension adopt-all --project",
      "pm extension adopt sample-ext --project --gh owner/repo/path --ref main",
      "pm extension activate sample-ext --project",
      "pm extension deactivate sample-ext --project",
      "pm extension uninstall sample-ext --global",
      "pm extension --install beads --project",
    ],
    tips: [
      "Prefer explicit subcommands (init/scaffold/install/uninstall/explore/manage/doctor/adopt/adopt-all/activate/deactivate) for discoverability.",
      "Legacy lifecycle flags remain supported as backward-compatible aliases.",
      "Bundled aliases beads and todos resolve to package-shipped extension sources.",
      "Use --gh/--github shorthand for GitHub sources and --ref to pin a branch, tag, or ref.",
      "Install updates settings activation state automatically unless extension allowlist mode is unchanged.",
      "Use --adopt for single-extension adoption and --adopt-all to bulk-register unmanaged installs as managed without reinstalling.",
      "Use --manage for concise triage summaries and remediation-oriented diagnostics alongside full extension details.",
      "Use --doctor for consolidated diagnostics with warning codes, remediation hints, and optional deep detail payloads.",
    ],
  },
  create: {
    why: "Creates a new planning item with deterministic metadata and history.",
    examples: [
      'pm create --title "Harden lock flow" --description "Improve stale lock handling" --type Task --status open --priority 1 --message "Create lock hardening task" --create-mode progressive',
      'pm create --title "Weekly planning sync" --description "Recurring coordination meeting" --type Meeting --schedule-preset lightweight',
      'pm create --title "Asset: Hero model" --description "Track playable model asset" --type Asset --status open --priority 1 --message "Create asset item" --type-option category=Character --dep "id=pm-epic01,kind=parent,author=codex-agent,created_at=now" --comment "author=codex-agent,created_at=now,text=Why this asset item exists." --note "author=codex-agent,created_at=now,text=Initial implementation note." --learning "author=codex-agent,created_at=now,text=Durable lesson placeholder." --file "path=src/assets/hero.glb,scope=project,note=tracked asset" --test "command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=240" --doc "path=README.md,scope=project,note=asset docs"',
    ],
    tips: [
      "Use --schedule-preset lightweight for Reminder/Meeting/Event when you want minimal required create inputs.",
      "Use --type <value> to load type-aware policy guidance in --help output.",
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
      'pm update-many --filter-tag wave:7 --replace-tests --test "command=node scripts/run-tests.mjs test -- tests/core/history.spec.ts,scope=project,timeout_seconds=240"',
      'pm update-many --filter-tag governance --reviewer maintainer-review --message "Normalize reviewer metadata"',
      "pm update-many --rollback ckpt-abc123",
    ],
    tips: [
      "Use --dry-run first to inspect proposed changes before apply mode.",
      "Linked-array mutation flags mirror pm update semantics (for example --replace-tests, --clear-files, and repeatable --doc/--note seeds).",
      "Checkpoints are enabled by default for apply mode and can be restored with --rollback.",
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
      "High-level focus contains Epics/Features and low-level focus contains Tasks/Issues/Chores/Event/Reminder/Milestone/Meeting.",
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
  reindex: {
    why: "Rebuilds search artifacts after large changes to item corpus or provider/vector config.",
    examples: ["pm reindex --mode keyword", "pm reindex --mode hybrid"],
  },
  get: {
    why: "Shows complete details for one item by ID.",
    examples: ["pm get pm-a1b2", "pm get pm-a1b2 --json"],
    tips: ["JSON output shape is { item, body, linked, claim_state }; body is top-level (not item.body)."],
  },
  history: {
    why: "Inspects item mutation timeline and audit trail.",
    examples: ["pm history pm-a1b2 --limit 20"],
  },
  activity: {
    why: "Reviews recent tracker-wide activity across items.",
    examples: [
      "pm activity --limit 50",
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
      'pm files pm-a1b2 --add "path=src/cli/main.ts,scope=project,note=help orchestration"',
      "pm files discover pm-a1b2",
      'pm files discover pm-a1b2 --apply --note "discovered from item text"',
    ],
  },
  docs: {
    why: "Associates relevant documentation paths with tracker items.",
    examples: ['pm docs pm-a1b2 --add "path=README.md,scope=project,note=user-facing command guidance"'],
  },
  test: {
    why: "Links test commands/paths and optionally executes them for one item.",
    examples: [
      'pm test pm-a1b2 --add "command=node scripts/run-tests.mjs test -- tests/unit/output.spec.ts,scope=project,timeout_seconds=2400"',
      'pm test pm-a1b2 --add "command=pm list-all --type Task --limit 200,scope=project,assert_stdout_contains=count:,assert_stdout_regex=count:\\s+\\d+"',
      'pm test pm-a1b2 --add "command=pm list-all --type Task --limit 200,scope=project,pm_context_mode=auto"',
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
  health: {
    why: "Validates tracker/runtime health including extension triage, migration, and integrity diagnostics.",
    examples: ["pm health", "pm health --json", "pm health --check-only", "pm health --no-refresh", "pm health --refresh-vectors"],
  },
  validate: {
    why:
      "Runs standalone metadata, resolution, lifecycle (including dependency-cycle diagnostics), linked-file, linked-command reference, and history drift checks with default remediation hints for resolution gaps.",
    examples: [
      "pm validate",
      "pm validate --check-resolution --json",
      "pm validate --check-lifecycle --dependency-cycle-severity error",
      "pm validate --check-files --scan-mode tracked-all",
      "pm validate --check-files --scan-mode tracked-all-strict --include-pm-internals",
      "pm validate --check-command-references",
      "pm validate --check-resolution --fail-on-warn --json",
    ],
    tips: ["Resolution-gap warnings include default `pm update <id> ...` remediation hint templates in check details."],
  },
  gc: {
    why: "Cleans optional cache artifacts to keep local tracker state tidy.",
    examples: ["pm gc"],
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
    "pm guide",
    "pm list-open --limit 10",
    'pm create --title "..." --description "..." --type Task --status open --priority 1 --message "..." --create-mode progressive',
  ],
  tips: [
    "Use <command> --help for command-specific guidance and examples.",
    "Use pm guide for local docs and skills routing with progressive disclosure.",
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

export function resolveHelpBundleForPath(commandPath: string | undefined): HelpBundle {
  const canonicalPath = resolveCanonicalHelpPath(commandPath);
  if (!canonicalPath) {
    return ROOT_HELP_BUNDLE;
  }
  return HELP_BY_COMMAND_PATH[canonicalPath] ?? ROOT_HELP_BUNDLE;
}

export function resolveHelpNarrative(commandPath: string | undefined, detailMode: HelpDetailMode): HelpNarrative {
  const bundle = resolveHelpBundleForPath(commandPath);
  return {
    intent: bundle.why,
    examples: detailMode === "detailed" ? [...bundle.examples] : bundle.examples.length > 0 ? [bundle.examples[0]] : [],
    tips: detailMode === "detailed" ? [...(bundle.tips ?? [])] : [],
    detail_mode: detailMode,
  };
}

export function listDocumentedHelpPaths(): string[] {
  return Object.keys(HELP_BY_COMMAND_PATH).sort((left, right) => left.localeCompare(right));
}

export function attachRichHelpText(program: Command, argv: string[] = process.argv.slice(2)): void {
  const detailMode = resolveHelpDetailMode(argv);
  program.addHelpText("after", renderHelpBundle(ROOT_HELP_BUNDLE, detailMode));
  for (const [commandPath, bundle] of Object.entries(HELP_BY_COMMAND_PATH)) {
    attachBundleByPath(program, commandPath, bundle, detailMode);
  }
}
