export interface GuideDocReference {
  path: string;
  purpose: string;
  optional?: boolean;
}

export interface GuideWorkflowTemplate {
  name: string;
  goal: string;
  prompt: string;
  commands: string[];
}

export interface GuideTopicDefinition {
  id: string;
  aliases: string[];
  title: string;
  summary: string;
  intent: string;
  commands: string[];
  workflows: GuideWorkflowTemplate[];
  docs: GuideDocReference[];
  related: string[];
}

function normalizeTopicToken(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

const GUIDE_TOPICS: GuideTopicDefinition[] = [
  {
    id: "quickstart",
    aliases: ["start", "getting-started", "bootstrap"],
    title: "Quickstart",
    summary: "Initialize a tracker and run the shortest safe plan -> execute -> close loop.",
    intent: "Use this when a human or agent needs to start productive work quickly with minimal context load.",
    commands: [
      "pm init",
      "pm context --limit 10",
      "pm list-open --limit 20",
      "pm create --create-mode progressive --title \"...\" --description \"...\" --type Task",
      "pm claim <ID>",
      "pm update <ID> --status in_progress",
      "pm close <ID> \"<reason with evidence>\" --validate-close warn",
    ],
    workflows: [
      {
        name: "Start Session Safely",
        goal: "Bootstrap without mutating unrelated state.",
        prompt:
          "You are bootstrapping pm work. Use a token-efficient context snapshot first, then select one open item, claim it, and only then mutate.",
        commands: ["pm context --limit 10", "pm list-open --limit 20", "pm claim <ID>"],
      },
    ],
    docs: [
      { path: "README.md", purpose: "High-level project and install entrypoint." },
      { path: "docs/QUICKSTART.md", purpose: "Short setup and first-command walkthrough." },
      { path: "docs/COMMANDS.md", purpose: "Task-oriented command recipes." },
    ],
    related: ["commands", "workflows", "release"],
  },
  {
    id: "commands",
    aliases: ["cli", "operations", "reference"],
    title: "CLI Command Routing",
    summary: "Find the right command family quickly and use command-scoped help/contracts output.",
    intent: "Use this when selecting command paths, flags, and output formats for implementation or automation.",
    commands: [
      "pm --help",
      "pm <command> --help",
      "pm <command> --help --explain",
      "pm contracts --command <command> --flags-only",
      "pm contracts --command <command> --availability-only --runtime-only",
      "pm completion <bash|zsh|fish>",
    ],
    workflows: [
      {
        name: "Flag Discovery",
        goal: "Resolve command flags deterministically before mutations.",
        prompt:
          "You are preparing to run a command. Use help and contracts surfaces to verify required/optional flags before execution.",
        commands: ["pm <command> --help --explain", "pm contracts --command <command> --flags-only"],
      },
    ],
    docs: [
      { path: "docs/COMMANDS.md", purpose: "Command grouping and examples." },
      { path: "docs/CONFIGURATION.md", purpose: "Project/global settings and policy controls." },
      { path: "docs/TESTING.md", purpose: "Linked-test orchestration and safety guidance." },
    ],
    related: ["quickstart", "workflows", "sdk", "extensions"],
  },
  {
    id: "workflows",
    aliases: ["developer", "maintainer", "agent"],
    title: "Developer and Agent Workflows",
    summary: "Apply canonical claim -> execute -> verify -> close workflows with append-only evidence.",
    intent: "Use this for day-to-day coding-agent execution loops and handoff-safe updates.",
    commands: [
      "pm claim <ID>",
      "pm update <ID> --status in_progress",
      "pm files <ID> --add ...",
      "pm test <ID> --add ...",
      "pm comments <ID> \"...\"",
      "pm validate --check-resolution --check-history-drift",
      "pm release <ID>",
    ],
    workflows: [
      {
        name: "Execution Loop",
        goal: "Keep code, tests, and tracker evidence synchronized.",
        prompt:
          "You are implementing a scoped change. Claim first, link files/tests/docs as you go, append evidence comments, and close only after validation.",
        commands: [
          "pm claim <ID>",
          "pm update <ID> --status in_progress",
          "pm files <ID> --add path=<file>,scope=project",
          "pm test <ID> --run --progress",
          "pm close <ID> \"<evidence>\" --validate-close warn",
        ],
      },
    ],
    docs: [
      { path: "AGENTS.md", purpose: "Repository operating rules and required workflow." },
      { path: "docs/AGENT_GUIDE.md", purpose: "Agent-oriented usage and context strategy." },
      { path: "docs/TESTING.md", purpose: "Sandbox-safe test execution rules." },
    ],
    related: ["quickstart", "commands", "skills"],
  },
  {
    id: "sdk",
    aliases: ["api", "typescript-sdk"],
    title: "SDK and Integrations",
    summary: "Use the published SDK surface for extension authoring and contract-safe integrations.",
    intent: "Use this when building or reviewing programmatic integrations against @unbrained/pm-cli/sdk.",
    commands: [
      "pm contracts --schema-only",
      "pm contracts --command extension --flags-only",
      "pm contracts --runtime-only --availability-only",
    ],
    workflows: [
      {
        name: "Integration Contract Check",
        goal: "Confirm action schemas and runtime availability before coding.",
        prompt:
          "You are wiring an integration. Capture schema + runtime availability first, then map your adapter payload fields to contract keys.",
        commands: [
          "pm contracts --schema-only",
          "pm contracts --availability-only --runtime-only",
          "pm contracts --command <command> --flags-only",
        ],
      },
    ],
    docs: [
      { path: "docs/SDK.md", purpose: "Public SDK exports and extension authoring references." },
      { path: "docs/ARCHITECTURE.md", purpose: "Core runtime composition and extension load flow." },
    ],
    related: ["extensions", "commands"],
  },
  {
    id: "extensions",
    aliases: ["plugins", "extension-authoring", "packages", "package-authoring"],
    title: "Packages and Extensions",
    summary: "Install, author, and diagnose packages/extensions with deterministic lifecycle controls.",
    intent: "Use this for package management, extension capability registration, and runtime diagnostics.",
    commands: [
      "pm install <target> --project",
      "pm upgrade --dry-run",
      "pm package explore --project",
      "pm package manage --detail summary",
      "pm package doctor --detail deep",
      "pm package activate <target> --project",
      "pm package deactivate <target> --project",
    ],
    workflows: [
      {
        name: "Lifecycle Triage",
        goal: "Diagnose extension state before forceful lifecycle actions.",
        prompt:
          "You are debugging package behavior. Inspect managed state first, then run doctor diagnostics, then apply install/adopt/activate actions.",
        commands: [
          "pm package explore --project",
          "pm package manage --detail summary",
          "pm package doctor --detail deep",
          "pm upgrade --packages-only --dry-run",
        ],
      },
    ],
    docs: [
      { path: "docs/EXTENSIONS.md", purpose: "Capability model and lifecycle command usage." },
      {
        path: "docs/examples/starter-extension/README.md",
        purpose: "Starter extension scaffold and local development path.",
      },
      { path: "docs/SDK.md", purpose: "SDK contracts used by extension implementations." },
    ],
    related: ["sdk", "commands", "skills"],
  },
  {
    id: "skills",
    aliases: ["agent-skills", "agentskills"],
    title: "Agent Skills",
    summary: "Skill bundles for developer, user, extensions, and sdk workflows aligned to the current CLI.",
    intent: "Use this when an agent needs reproducible prompts/workflows with strict compatibility metadata.",
    commands: [
      "pm guide skills --depth deep",
      "pm contracts --command guide --flags-only",
      "pm validate --check-command-references",
    ],
    workflows: [
      {
        name: "Skill Selection",
        goal: "Pick the narrowest compatible skill first to minimize context usage.",
        prompt:
          "Select a pm skill based on the task intent, then execute only the workflow section needed for the current change.",
        commands: ["pm guide skills", "pm guide skills --depth deep"],
      },
    ],
    docs: [
      { path: "docs/AGENT_GUIDE.md", purpose: "Agent-first usage and context model." },
      { path: "docs/README.md", purpose: "Documentation routing with progressive disclosure." },
      { path: ".agents/skills/README.md", purpose: "Agent skills index and routing overview." },
      { path: ".agents/skills/pm-developer/SKILL.md", purpose: "Developer-oriented pm skill workflow." },
      { path: ".agents/skills/pm-user/SKILL.md", purpose: "User/operator pm skill workflow." },
      { path: ".agents/skills/pm-extensions/SKILL.md", purpose: "Extension-focused pm skill workflow." },
      { path: ".agents/skills/pm-sdk/SKILL.md", purpose: "SDK integration pm skill workflow." },
    ],
    related: ["workflows", "harnesses", "commands"],
  },
  {
    id: "harnesses",
    aliases: ["compatibility", "agent-compatibility"],
    title: "Agent Harness Compatibility",
    summary: "Cross-harness compatibility guidance for docs routing.",
    intent: "Use this when adapting pm docs and SDK contracts for an external automation harness.",
    commands: ["pm guide skills", "pm guide commands", "pm contracts --runtime-only --availability-only"],
    workflows: [
      {
        name: "Harness Mapping",
        goal: "Route each harness to the same canonical skill/docs sources.",
        prompt:
          "Map harness-specific entrypoints to the same pm guide topics and .agents/skills workflows without adding runtime harness-specific code.",
        commands: ["pm guide harnesses --depth standard", "pm guide skills --depth deep"],
      },
    ],
    docs: [
      { path: "docs/AGENT_GUIDE.md", purpose: "Agent context and output-mode conventions." },
      { path: "docs/README.md", purpose: "Single-source documentation routing entrypoint." },
      { path: ".agents/skills/HARNESS_COMPATIBILITY.md", purpose: "Harness compatibility matrix and usage notes." },
    ],
    related: ["skills", "workflows"],
  },
  {
    id: "release",
    aliases: ["gates", "ship", "release-readiness"],
    title: "Release and Staleness Gates",
    summary: "Run release gates and docs/skills freshness checks before publishing.",
    intent: "Use this when validating release readiness and preventing docs/skills drift.",
    commands: [
      "pnpm build",
      "pnpm test:coverage",
      "pnpm quality:static",
      "node scripts/release/run-gates.mjs --telemetry-mode best-effort",
      "pnpm security:scan",
    ],
    workflows: [
      {
        name: "Pre-Release Gate Sweep",
        goal: "Ensure code, docs, and skills are all green before publish.",
        prompt:
          "Run release gates in deterministic order and treat docs/skills freshness failures as release blockers.",
        commands: [
          "pnpm build",
          "pnpm test:coverage",
          "node scripts/release/run-gates.mjs --telemetry-mode best-effort",
        ],
      },
    ],
    docs: [
      { path: "docs/RELEASING.md", purpose: "Release flow and safety checks." },
      { path: "CHANGELOG.md", purpose: "Versioned release history and unreleased notes." },
      { path: "scripts/release/run-gates.mjs", purpose: "Source of truth for release gate ordering." },
    ],
    related: ["commands", "skills", "workflows"],
  },
];

const TOPIC_BY_TOKEN = new Map<string, GuideTopicDefinition>();
for (const topic of GUIDE_TOPICS) {
  TOPIC_BY_TOKEN.set(topic.id, topic);
  for (const alias of topic.aliases) {
    TOPIC_BY_TOKEN.set(alias, topic);
  }
}

export function listGuideTopics(): GuideTopicDefinition[] {
  return GUIDE_TOPICS.map((topic) => ({
    ...topic,
    aliases: [...topic.aliases],
    commands: [...topic.commands],
    workflows: topic.workflows.map((workflow) => ({
      ...workflow,
      commands: [...workflow.commands],
    })),
    docs: topic.docs.map((doc) => ({ ...doc })),
    related: [...topic.related],
  }));
}

export function listGuideTopicIds(): string[] {
  return GUIDE_TOPICS.map((topic) => topic.id);
}

export function resolveGuideTopic(rawTopic: string | undefined): GuideTopicDefinition | null {
  if (!rawTopic) {
    return null;
  }
  const normalized = normalizeTopicToken(rawTopic);
  if (!normalized) {
    return null;
  }
  return TOPIC_BY_TOKEN.get(normalized) ?? null;
}
