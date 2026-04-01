import { Command } from "commander";

interface HelpBundle {
  why: string;
  examples: string[];
  tips?: string[];
}

function renderHelpBundle(bundle: HelpBundle): string {
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

function attachBundleByPath(root: Command, commandPath: string, bundle: HelpBundle): void {
  const command = findCommandByPath(root, commandPath.split(" ").filter((part) => part.length > 0));
  if (!command) {
    return;
  }
  command.addHelpText("after", renderHelpBundle(bundle));
}

const HELP_BY_COMMAND_PATH: Record<string, HelpBundle> = {
  init: {
    why: "Bootstraps tracker storage and settings so all other commands can run safely.",
    examples: ['pm init', 'pm init acme'],
    tips: ["Run this once per repository before create/list/update commands."],
  },
  config: {
    why: "Reads or updates project/global settings such as definition-of-done and item format.",
    examples: [
      'pm config project get definition-of-done',
      'pm config project set definition-of-done --criterion "tests pass"',
      "pm config project set item-format --format toon",
    ],
  },
  install: {
    why: "Installs supported integrations (currently Pi extension support).",
    examples: ["pm install pi --project", "pm install pi --global"],
  },
  create: {
    why: "Creates a new planning item with deterministic metadata and history.",
    examples: [
      'pm create --title "Harden lock flow" --description "Improve stale lock handling" --type Task --status open --priority 1 --message "Create lock hardening task" --dep none --comment none --note none --learning none --file none --test none --doc none',
      'pm create --title "Asset: Hero model" --description "Track playable model asset" --type Asset --status open --priority 1 --message "Create asset item" --type-option category=Character --dep none --comment none --note none --learning none --file none --test none --doc none',
    ],
    tips: ["Use --type <value> to load type-aware policy guidance in --help output."],
  },
  update: {
    why: "Mutates existing item fields while preserving history and lock safety.",
    examples: [
      'pm update pm-a1b2 --status in_progress --message "Start implementation"',
      'pm update pm-a1b2 --assignee none --deadline +2d --message "Replan ownership and deadline"',
    ],
    tips: ['Use "pm close <ID> <TEXT>" to close items instead of --status closed.'],
  },
  list: {
    why: "Lists active items with deterministic filtering and ordering.",
    examples: ["pm list --limit 20", "pm list --type Task --priority 0 --tag release --assignee codex-agent"],
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
  calendar: {
    why: "Provides deadline/reminder/event scheduling views for planning and coordination.",
    examples: [
      "pm calendar",
      "pm calendar --view agenda --from +0d --to +7d --assignee codex-agent",
      "pm calendar --view month --tag release --format json",
    ],
  },
  context: {
    why: "Builds an agent-optimized snapshot of critical active work plus near-term agenda context.",
    examples: [
      "pm context",
      "pm ctx --limit 5 --assignee codex-agent",
      "pm context --from +0d --to +7d --format markdown",
    ],
    tips: [
      "High-level focus contains Epics/Features and low-level focus contains Tasks/Issues/Chores.",
      "When no open or in-progress work exists, blocked items are shown as fallback context.",
    ],
  },
  search: {
    why: "Finds relevant items by keyword, semantic, or hybrid retrieval modes.",
    examples: [
      'pm search "lock stale retry" --mode keyword --limit 10',
      'pm search "extension migration blockers" --mode hybrid --type Task --priority 0',
    ],
    tips: ["Use --include-linked when linked docs/files/tests should influence scoring."],
  },
  reindex: {
    why: "Rebuilds search artifacts after large changes to item corpus or provider/vector config.",
    examples: ["pm reindex --mode keyword", "pm reindex --mode hybrid"],
  },
  get: {
    why: "Shows complete details for one item by ID.",
    examples: ["pm get pm-a1b2", "pm get pm-a1b2 --json"],
  },
  history: {
    why: "Inspects item mutation timeline and audit trail.",
    examples: ["pm history pm-a1b2 --limit 20"],
  },
  activity: {
    why: "Reviews recent tracker-wide activity across items.",
    examples: ["pm activity --limit 50"],
  },
  restore: {
    why: "Restores an item to a prior timestamp/version with history replay safety.",
    examples: ['pm restore pm-a1b2 2026-04-01T00:00:00.000Z --author "codex-agent" --message "Rollback to known-good state"'],
  },
  close: {
    why: "Transitions work to terminal closed state with explicit rationale.",
    examples: ['pm close pm-a1b2 "All acceptance criteria met" --author "codex-agent" --message "Close after verification"'],
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
    examples: ['pm comments pm-a1b2 --add "Verified fix on Linux and macOS"', "pm comments pm-a1b2 --limit 10"],
  },
  notes: {
    why: "Adds or reviews durable implementation notes linked to an item.",
    examples: ['pm notes pm-a1b2 --add "Investigated parser edge case and documented fallback logic."', "pm notes pm-a1b2 --limit 10"],
  },
  learnings: {
    why: "Adds or reviews post-implementation learnings for future work.",
    examples: ['pm learnings pm-a1b2 --add "Avoid direct test-runner commands in linked tests; use sandbox runner."', "pm learnings pm-a1b2 --limit 10"],
  },
  files: {
    why: "Associates changed source files with tracker items for reproducibility.",
    examples: ['pm files pm-a1b2 --add "path=src/cli/main.ts,scope=project,note=help orchestration"'],
  },
  docs: {
    why: "Associates relevant documentation paths with tracker items.",
    examples: ['pm docs pm-a1b2 --add "path=README.md,scope=project,note=user-facing command guidance"'],
  },
  test: {
    why: "Links test commands/paths and optionally executes them for one item.",
    examples: [
      'pm test pm-a1b2 --add "command=node scripts/run-tests.mjs test -- tests/unit/output.spec.ts,scope=project,timeout_seconds=2400"',
      "pm test pm-a1b2 --run --timeout 2400",
    ],
  },
  "test-all": {
    why: "Runs linked tests in bulk for release/readiness sweeps.",
    examples: ["pm test-all --status in_progress --timeout 2400", "pm test-all --status closed --timeout 3600"],
  },
  stats: {
    why: "Reports tracker-level totals and distribution by type/status.",
    examples: ["pm stats", "pm stats --json"],
  },
  health: {
    why: "Validates tracker/runtime health including extension and migration diagnostics.",
    examples: ["pm health", "pm health --json"],
  },
  gc: {
    why: "Cleans optional cache artifacts to keep local tracker state tidy.",
    examples: ["pm gc"],
  },
  claim: {
    why: "Claims an item to signal active ownership and reduce conflicts.",
    examples: ['pm claim pm-a1b2 --author "codex-agent" --message "Claim for implementation"'],
  },
  release: {
    why: "Releases an active claim when paused, handed off, or completed.",
    examples: ['pm release pm-a1b2 --author "codex-agent" --message "Release after closure"'],
  },
  completion: {
    why: "Generates shell completion scripts for faster and more reliable command entry.",
    examples: ["pm completion bash", "pm completion zsh", "pm completion fish"],
  },
  "beads import": {
    why: "Imports Beads JSONL records into pm item format.",
    examples: ['pm beads import --file .beads/issues.jsonl --author "codex-agent" --message "Import legacy beads data"'],
  },
  "todos import": {
    why: "Imports todos markdown files as pm items.",
    examples: ['pm todos import --folder .pi/todos --author "codex-agent" --message "Import todos into tracker"'],
  },
  "todos export": {
    why: "Exports pm items into todos markdown files for downstream workflows.",
    examples: ["pm todos export --folder .pi/todos"],
  },
};

const ROOT_HELP_BUNDLE: HelpBundle = {
  why: "Provides deterministic project management workflows for humans and coding agents.",
  examples: ["pm init", "pm list-open --limit 10", 'pm create --title "..." --description "..." --type Task --status open --priority 1 --message "..." --dep none --comment none --note none --learning none --file none --test none --doc none'],
  tips: [
    "Use <command> --help for command-specific guidance and examples.",
    "Use --json for machine parsing and integration flows.",
  ],
};

export function attachRichHelpText(program: Command): void {
  program.addHelpText("after", renderHelpBundle(ROOT_HELP_BUNDLE));
  for (const [commandPath, bundle] of Object.entries(HELP_BY_COMMAND_PATH)) {
    attachBundleByPath(program, commandPath, bundle);
  }
}
