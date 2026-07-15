/**
 * @module sdk/init-agent-guidance
 *
 * Implements the pm init agent guidance command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runActiveOnWriteHooks } from "../core/extensions/index.js";
import { pathExists, writeFileAtomic } from "../core/fs/fs-utils.js";
import type { PmSettings } from "../types/index.js";

/** Restricts init agent guidance mode values accepted by command, SDK, and storage contracts. */
export type InitAgentGuidanceMode = "ask" | "add" | "skip" | "status";

/** Supported values accepted by the init agent guidance mode contract. */
export const INIT_AGENT_GUIDANCE_MODE_VALUES: InitAgentGuidanceMode[] = [
  "ask",
  "add",
  "skip",
  "status",
];

const AGENT_GUIDANCE_TARGET_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;
const AGENT_GUIDANCE_REQUIRED_TOKENS = [
  "pm init",
  "pm context",
  "pm search",
  "pm create",
  "pm claim",
  "pm files",
  "pm docs",
  "pm test --run",
  "pm close",
  "pm release",
  "pm_author",
] as const;
const AGENT_GUIDANCE_REQUIRED_TOKEN_THRESHOLD = 8;
const AGENT_GUIDANCE_TEMPLATE_VERSION = 1;
const AGENT_GUIDANCE_START_MARKER_PREFIX = "<!-- pm-cli:agent-guidance:start:";
const AGENT_GUIDANCE_START_MARKER = `<!-- pm-cli:agent-guidance:start:v${AGENT_GUIDANCE_TEMPLATE_VERSION} -->`;
const AGENT_GUIDANCE_END_MARKER = "<!-- pm-cli:agent-guidance:end -->";
const AGENT_GUIDANCE_ADD_LATER_HINT =
  "Add workflow guidance later: pm init --agent-guidance add";

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  toPortableRelativePath,
  ensureTrailingNewline,
  detectLineEnding,
  findGuidanceBlockRange,
  buildAgentGuidanceBlock,
  upsertAgentGuidanceBlock,
  resolveProjectRoot,
  resolveTargetGuidancePath,
  parsePromptChoice,
  pushUnique,
  promptForGuidanceWrite,
  normalizeAgentGuidanceState,
  applyAgentGuidanceState,
  writeGuidanceFile,
  setAgentGuidanceReadlineFactoryForTests,
};

type AgentGuidanceReadlineInterface = ReturnType<
  typeof readline.createInterface
>;
let createAgentGuidanceReadlineInterface = (): AgentGuidanceReadlineInterface =>
  readline.createInterface({ input, output });

function setAgentGuidanceReadlineFactoryForTests(
  factory: (() => AgentGuidanceReadlineInterface) | undefined,
): void {
  createAgentGuidanceReadlineInterface =
    factory ?? (() => readline.createInterface({ input, output }));
}

interface AgentGuidanceFileScan {
  file_path: string;
  exists: boolean;
  has_guidance: boolean;
  has_marker: boolean;
}

interface AgentGuidanceBlockRange {
  start_index: number;
  end_index: number;
}

/** Documents the init agent guidance summary payload exchanged by command, SDK, and package integrations. */
export interface InitAgentGuidanceSummary {
  /** Value that configures or reports mode for this contract. */
  mode: InitAgentGuidanceMode;
  /** Value that configures or reports present for this contract. */
  present: boolean;
  /** Value that configures or reports prompted for this contract. */
  prompted: boolean;
  /** Value that configures or reports applied for this contract. */
  applied: boolean;
  /** Value that configures or reports skipped for this contract. */
  skipped: boolean;
  /** Value that configures or reports declined for this contract. */
  declined: boolean;
  /** Value that configures or reports prompt completed for this contract. */
  prompt_completed: boolean;
  /** Value that configures or reports template version for this contract. */
  template_version: number;
  /** Value that configures or reports target file for this contract. */
  target_file: string;
  /** Value that configures or reports checked files for this contract. */
  checked_files: string[];
  /** Value that configures or reports files with guidance for this contract. */
  files_with_guidance: string[];
  /** Value that configures or reports missing files for this contract. */
  missing_files: string[];
}

/** Documents the run init agent guidance options payload exchanged by command, SDK, and package integrations. */
export interface RunInitAgentGuidanceOptions {
  /** Value that configures or reports pm root for this contract. */
  pm_root: string;
  /** Value that configures or reports cwd for this contract. */
  cwd: string;
  /** Value that configures or reports mode for this contract. */
  mode: InitAgentGuidanceMode;
  /** Value that configures or reports interactive for this contract. */
  interactive: boolean;
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
}

/** Documents the run init agent guidance result payload exchanged by command, SDK, and package integrations. */
export interface RunInitAgentGuidanceResult {
  /** Value that configures or reports summary for this contract. */
  summary: InitAgentGuidanceSummary;
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports next steps for this contract. */
  next_steps: string[];
  /** Value that configures or reports settings changed for this contract. */
  settings_changed: boolean;
}

function toPortableRelativePath(
  projectRoot: string,
  targetPath: string,
): string {
  const relative = path.relative(projectRoot, targetPath);
  if (relative.length === 0) {
    return path.basename(targetPath);
  }
  return relative.split(path.sep).join("/");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function detectLineEnding(value: string): "\n" | "\r\n" {
  return value.includes("\r\n") ? "\r\n" : "\n";
}

function findGuidanceBlockRange(
  content: string,
): AgentGuidanceBlockRange | null {
  const startIndex = content.indexOf(AGENT_GUIDANCE_START_MARKER_PREFIX);
  if (startIndex === -1) {
    return null;
  }
  const endMarkerIndex = content.indexOf(AGENT_GUIDANCE_END_MARKER, startIndex);
  if (endMarkerIndex === -1) {
    return null;
  }
  return {
    start_index: startIndex,
    end_index: endMarkerIndex + AGENT_GUIDANCE_END_MARKER.length,
  };
}

function hasGuidanceMarker(content: string): boolean {
  return findGuidanceBlockRange(content) !== null;
}

function buildAgentGuidanceBlock(lineEnding: "\n" | "\r\n"): string {
  const lines = [
    AGENT_GUIDANCE_START_MARKER,
    "## pm Workflow (Agent Quickstart)",
    "",
    '- Orient before mutate: `pm context --limit 10`, `pm search "<keywords>" --limit 10`, `pm list-open --limit 20`.',
    "- Claim and execute: `pm claim <id>` then `pm update <id> --status in_progress`.",
    '- Link evidence while coding: `pm files <id> --add ...`, `pm docs <id> --add ...`, `pm test <id> --add command="node scripts/run-tests.mjs test -- ..."`.',
    '- Verify and close: `pm test <id> --run --progress`, `pm close <id> "<evidence>" --validate-close warn`, `pm release <id>`.',
    "- Set `PM_AUTHOR=<stable-agent-id>` before mutation commands.",
    "",
    AGENT_GUIDANCE_END_MARKER,
    "",
  ];
  return lines.join(lineEnding);
}

function upsertAgentGuidanceBlock(existingContent: string): {
  next_content: string;
  changed: boolean;
} {
  const lineEnding = detectLineEnding(existingContent);
  const nextBlock = buildAgentGuidanceBlock(lineEnding);
  const existingRange = findGuidanceBlockRange(existingContent);
  if (existingRange) {
    const trailingContent = existingContent.slice(existingRange.end_index);
    const normalizedTrailingContent = trailingContent.startsWith("\r\n")
      ? trailingContent.slice(2)
      : trailingContent.startsWith("\n")
        ? trailingContent.slice(1)
        : trailingContent;
    const nextContent = ensureTrailingNewline(
      `${existingContent.slice(0, existingRange.start_index)}${nextBlock}${normalizedTrailingContent}`,
    );
    return {
      next_content: nextContent,
      changed: nextContent !== existingContent,
    };
  }
  const separator =
    existingContent.length === 0
      ? ""
      : existingContent.endsWith("\n")
        ? "\n"
        : "\n\n";
  const nextContent = ensureTrailingNewline(
    `${existingContent}${separator}${nextBlock}`,
  );
  return {
    next_content: nextContent,
    changed: nextContent !== existingContent,
  };
}

function resolveProjectRoot(pmRoot: string, cwd: string): string {
  const parent = path.dirname(pmRoot);
  if (path.basename(pmRoot) === "pm" && path.basename(parent) === ".agents") {
    return path.dirname(parent);
  }
  return path.resolve(cwd, pmRoot);
}

function resolveTargetGuidancePath(
  scans: AgentGuidanceFileScan[],
  projectRoot: string,
): string {
  const existingAgents = scans.find(
    (entry) => path.basename(entry.file_path) === "AGENTS.md" && entry.exists,
  );
  if (existingAgents) {
    return existingAgents.file_path;
  }
  const existingAny = scans.find((entry) => entry.exists);
  if (existingAny) {
    return existingAny.file_path;
  }
  return path.join(projectRoot, "AGENTS.md");
}

function parsePromptChoice(answer: string, currentDefault: boolean): boolean {
  const normalized = answer.trim().toLowerCase();
  if (normalized.length === 0) {
    return currentDefault;
  }
  if (normalized === "y" || normalized === "yes") {
    return true;
  }
  if (normalized === "n" || normalized === "no") {
    return false;
  }
  return currentDefault;
}

async function promptForGuidanceWrite(
  targetRelativePath: string,
): Promise<boolean> {
  const rl = createAgentGuidanceReadlineInterface();
  try {
    output.write("\nAgent guidance check\n");
    output.write(
      "No AGENTS.md/CLAUDE.md file currently contains compact pm workflow guidance.\n",
    );
    const answer = await rl.question(
      `Add a compact pm workflow section to ${targetRelativePath}? [Y/n] `,
    );
    output.write("\n");
    return parsePromptChoice(answer, true);
  } finally {
    rl.close();
  }
}

function normalizeAgentGuidanceState(
  settings: PmSettings,
): PmSettings["agent_guidance"] {
  const current = settings.agent_guidance;
  return {
    prompt_completed: current?.prompt_completed === true,
    declined: current?.declined === true,
    declined_at:
      typeof current?.declined_at === "string" ? current.declined_at : "",
    template_version:
      typeof current?.template_version === "number" &&
      Number.isInteger(current.template_version) &&
      current.template_version > 0
        ? current.template_version
        : AGENT_GUIDANCE_TEMPLATE_VERSION,
    last_checked_files: Array.isArray(current?.last_checked_files)
      ? [
          ...new Set(
            current.last_checked_files
              .map((value) => value.trim())
              .filter((value) => value.length > 0),
          ),
        ].sort((left, right) => left.localeCompare(right))
      : [],
  };
}

async function scanGuidanceFiles(
  projectRoot: string,
): Promise<AgentGuidanceFileScan[]> {
  const scans: AgentGuidanceFileScan[] = [];
  for (const filename of AGENT_GUIDANCE_TARGET_FILENAMES) {
    const filePath = path.join(projectRoot, filename);
    const exists = await pathExists(filePath);
    if (!exists) {
      scans.push({
        file_path: filePath,
        exists,
        has_guidance: false,
        has_marker: false,
      });
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    const contentLower = content.toLowerCase();
    const tokenHits = AGENT_GUIDANCE_REQUIRED_TOKENS.filter((token) =>
      contentLower.includes(token),
    );
    const hasMarker = hasGuidanceMarker(content);
    scans.push({
      file_path: filePath,
      exists,
      has_guidance:
        hasMarker ||
        tokenHits.length >= AGENT_GUIDANCE_REQUIRED_TOKEN_THRESHOLD,
      has_marker: hasMarker,
    });
  }
  return scans;
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function applyAgentGuidanceState(
  settings: PmSettings,
  currentState: PmSettings["agent_guidance"],
): { changed: boolean; state: PmSettings["agent_guidance"] } {
  const existing = normalizeAgentGuidanceState(settings);
  const changed = JSON.stringify(existing) !== JSON.stringify(currentState);
  if (changed) {
    settings.agent_guidance = currentState;
  }
  return { changed, state: currentState };
}

async function writeGuidanceFile(
  filePath: string,
): Promise<{ changed: boolean; warnings: string[] }> {
  const exists = await pathExists(filePath);
  const currentContent = exists ? await fs.readFile(filePath, "utf8") : "";
  const nextContent = upsertAgentGuidanceBlock(currentContent);
  if (!nextContent.changed) {
    return { changed: false, warnings: [] };
  }
  await writeFileAtomic(filePath, nextContent.next_content);
  return {
    changed: true,
    warnings: await runActiveOnWriteHooks({
      path: filePath,
      scope: "project",
      op: "init:agent_guidance_file",
    }),
  };
}

function buildInitAgentGuidanceSummary(params: {
  mode: InitAgentGuidanceMode;
  scans: AgentGuidanceFileScan[];
  projectRoot: string;
  targetRelativePath: string;
  prompted: boolean;
  applied: boolean;
  skipped: boolean;
  state: PmSettings["agent_guidance"];
}): InitAgentGuidanceSummary {
  return {
    mode: params.mode,
    present: params.scans.some((entry) => entry.has_guidance),
    prompted: params.prompted,
    applied: params.applied,
    skipped: params.skipped,
    declined: params.state.declined,
    prompt_completed: params.state.prompt_completed,
    template_version: params.state.template_version,
    target_file: params.targetRelativePath,
    checked_files: params.scans.map((entry) =>
      toPortableRelativePath(params.projectRoot, entry.file_path),
    ),
    files_with_guidance: params.scans
      .filter((entry) => entry.has_guidance)
      .map((entry) =>
        toPortableRelativePath(params.projectRoot, entry.file_path),
      ),
    missing_files: params.scans
      .filter((entry) => !entry.exists)
      .map((entry) =>
        toPortableRelativePath(params.projectRoot, entry.file_path),
      ),
  };
}

async function refreshGuidanceScansAfterApply(
  applied: boolean,
  scans: AgentGuidanceFileScan[],
  projectRoot: string,
): Promise<AgentGuidanceFileScan[]> {
  return applied ? await scanGuidanceFiles(projectRoot) : scans;
}

interface InitAgentGuidanceFlowState {
  warnings: string[];
  nextSteps: string[];
  prompted: boolean;
  applied: boolean;
  skipped: boolean;
  state: PmSettings["agent_guidance"];
}

interface InitAgentGuidanceModeContext {
  mode: InitAgentGuidanceMode;
  interactive: boolean;
  targetPath: string;
  targetRelativePath: string;
  checkedFiles: string[];
  presentBefore: boolean;
}

function markAgentGuidanceRunState(
  flow: InitAgentGuidanceFlowState,
  checkedFiles: string[],
  partial: Partial<PmSettings["agent_guidance"]>,
): void {
  flow.state = {
    ...flow.state,
    ...partial,
    template_version: AGENT_GUIDANCE_TEMPLATE_VERSION,
    last_checked_files: checkedFiles,
  };
}

async function addAgentGuidanceBlockIfMissing(
  flow: InitAgentGuidanceFlowState,
  context: Pick<
    InitAgentGuidanceModeContext,
    "presentBefore" | "targetPath" | "targetRelativePath"
  >,
): Promise<void> {
  if (context.presentBefore) {
    return;
  }
  const writeResult = await writeGuidanceFile(context.targetPath);
  flow.warnings.push(...writeResult.warnings);
  if (writeResult.changed) {
    flow.applied = true;
    flow.warnings.push(`agent_guidance:added:${context.targetRelativePath}`);
  }
}

function handleAgentGuidanceStatusMode(
  flow: InitAgentGuidanceFlowState,
  presentBefore: boolean,
): void {
  if (!presentBefore) {
    flow.warnings.push("agent_guidance:missing");
    pushUnique(flow.nextSteps, AGENT_GUIDANCE_ADD_LATER_HINT);
  }
}

function handleAgentGuidanceSkipMode(
  flow: InitAgentGuidanceFlowState,
  checkedFiles: string[],
): void {
  flow.skipped = true;
  markAgentGuidanceRunState(flow, checkedFiles, {
    prompt_completed: true,
    declined: true,
    declined_at: flow.state.declined_at || new Date().toISOString(),
  });
  flow.warnings.push("agent_guidance:explicit_skip");
  pushUnique(flow.nextSteps, AGENT_GUIDANCE_ADD_LATER_HINT);
}

async function handleAgentGuidanceAddMode(
  flow: InitAgentGuidanceFlowState,
  context: InitAgentGuidanceModeContext,
): Promise<void> {
  await addAgentGuidanceBlockIfMissing(flow, context);
  markAgentGuidanceRunState(flow, context.checkedFiles, {
    prompt_completed: true,
    declined: false,
    declined_at: "",
  });
}

function handlePresentAgentGuidance(
  flow: InitAgentGuidanceFlowState,
  checkedFiles: string[],
): void {
  if (flow.state.declined) {
    markAgentGuidanceRunState(flow, checkedFiles, {
      prompt_completed: true,
      declined: false,
      declined_at: "",
    });
  }
}

function handleDeclinedAgentGuidance(flow: InitAgentGuidanceFlowState): void {
  flow.skipped = true;
  flow.warnings.push("agent_guidance:skipped_declined");
  pushUnique(flow.nextSteps, AGENT_GUIDANCE_ADD_LATER_HINT);
}

async function handleInteractiveAgentGuidancePrompt(
  flow: InitAgentGuidanceFlowState,
  context: InitAgentGuidanceModeContext,
): Promise<void> {
  flow.prompted = true;
  const approved = await promptForGuidanceWrite(context.targetRelativePath);
  if (approved) {
    await addAgentGuidanceBlockIfMissing(flow, context);
    markAgentGuidanceRunState(flow, context.checkedFiles, {
      prompt_completed: true,
      declined: false,
      declined_at: "",
    });
    return;
  }
  flow.skipped = true;
  markAgentGuidanceRunState(flow, context.checkedFiles, {
    prompt_completed: true,
    declined: true,
    declined_at: new Date().toISOString(),
  });
  flow.warnings.push("agent_guidance:declined");
  pushUnique(flow.nextSteps, AGENT_GUIDANCE_ADD_LATER_HINT);
}

function handleNonInteractiveMissingAgentGuidance(
  flow: InitAgentGuidanceFlowState,
): void {
  flow.warnings.push("agent_guidance:missing_non_interactive");
  pushUnique(flow.nextSteps, AGENT_GUIDANCE_ADD_LATER_HINT);
}

async function applyAgentGuidanceMode(
  initialState: PmSettings["agent_guidance"],
  context: InitAgentGuidanceModeContext,
): Promise<InitAgentGuidanceFlowState> {
  const flow: InitAgentGuidanceFlowState = {
    warnings: [],
    nextSteps: [],
    prompted: false,
    applied: false,
    skipped: false,
    state: initialState,
  };

  if (context.mode === "status") {
    handleAgentGuidanceStatusMode(flow, context.presentBefore);
    return flow;
  }
  if (context.mode === "skip") {
    handleAgentGuidanceSkipMode(flow, context.checkedFiles);
    return flow;
  }
  if (context.mode === "add") {
    await handleAgentGuidanceAddMode(flow, context);
    return flow;
  }
  if (context.presentBefore) {
    handlePresentAgentGuidance(flow, context.checkedFiles);
    return flow;
  }
  if (flow.state.prompt_completed && flow.state.declined) {
    handleDeclinedAgentGuidance(flow);
    return flow;
  }
  if (context.interactive) {
    await handleInteractiveAgentGuidancePrompt(flow, context);
    return flow;
  }
  handleNonInteractiveMissingAgentGuidance(flow);
  return flow;
}

/** Implements run init agent guidance for the public runtime surface of this module. */
export async function runInitAgentGuidance(
  options: RunInitAgentGuidanceOptions,
): Promise<RunInitAgentGuidanceResult> {
  const projectRoot = resolveProjectRoot(options.pm_root, options.cwd);
  let scans = await scanGuidanceFiles(projectRoot);
  const targetPath = resolveTargetGuidancePath(scans, projectRoot);
  const targetRelativePath = toPortableRelativePath(projectRoot, targetPath);
  const checkedFiles = scans.map((entry) =>
    toPortableRelativePath(projectRoot, entry.file_path),
  );
  const presentBefore = scans.some((entry) => entry.has_guidance);
  const flow = await applyAgentGuidanceMode(
    normalizeAgentGuidanceState(options.settings),
    {
      mode: options.mode,
      interactive: options.interactive,
      targetPath,
      targetRelativePath,
      checkedFiles,
      presentBefore,
    },
  );

  const stateUpdate = applyAgentGuidanceState(options.settings, flow.state);
  scans = await refreshGuidanceScansAfterApply(
    flow.applied,
    scans,
    projectRoot,
  );

  const summary = buildInitAgentGuidanceSummary({
    mode: options.mode,
    scans,
    projectRoot,
    targetRelativePath,
    prompted: flow.prompted,
    applied: flow.applied,
    skipped: flow.skipped,
    state: flow.state,
  });

  return {
    summary,
    warnings: flow.warnings,
    next_steps: flow.nextSteps,
    settings_changed: stateUpdate.changed,
  };
}
