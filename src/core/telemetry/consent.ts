import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { GlobalOptions } from "../shared/command-types.js";
import { resolveGlobalPmRoot } from "../store/paths.js";
import { readSettings, writeSettings } from "../store/settings.js";

const TELEMETRY_PROMPT_DISABLE_ENV = "PM_TELEMETRY_PROMPT";
const TELEMETRY_PROMPT_DISABLE_VALUES = new Set(["0", "false", "no", "off"]);
const TELEMETRY_PROMPT_SKIPPED_COMMANDS = new Set(["init", "completion", "completion-tags"]);

function parseBooleanLike(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return TELEMETRY_PROMPT_DISABLE_VALUES.has(value.trim().toLowerCase());
}

function shouldSkipTelemetryPrompt(commandPath: string, globalOptions: GlobalOptions): boolean {
  if (globalOptions.json === true || globalOptions.quiet === true) {
    return true;
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return true;
  }
  if (parseBooleanLike(process.env[TELEMETRY_PROMPT_DISABLE_ENV])) {
    return true;
  }
  if (parseBooleanLike(process.env.CI)) {
    return true;
  }
  const normalizedCommandPath = commandPath.trim().toLowerCase();
  if (normalizedCommandPath.length === 0) {
    return true;
  }
  return TELEMETRY_PROMPT_SKIPPED_COMMANDS.has(normalizedCommandPath);
}

function parseTelemetryPromptAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "n" || normalized === "no") {
    return false;
  }
  return true;
}

async function promptTelemetryConsent(currentDefault: boolean): Promise<boolean> {
  const defaultLabel = currentDefault ? "Y/n" : "y/N";
  const prompt =
    `pm telemetry helps improve reliability and usage diagnostics.\n` +
    `It is enabled by default and can be changed anytime via:\n` +
    `pm config global set telemetry-tracking --policy disabled\n` +
    `Enable telemetry now? [${defaultLabel}] `;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    if (answer.trim().length === 0) {
      return currentDefault;
    }
    return parseTelemetryPromptAnswer(answer);
  } finally {
    rl.close();
  }
}

export async function maybeRunFirstUseTelemetryPrompt(commandPath: string, globalOptions: GlobalOptions): Promise<void> {
  if (shouldSkipTelemetryPrompt(commandPath, globalOptions)) {
    return;
  }
  try {
    const globalPmRoot = resolveGlobalPmRoot(process.cwd());
    const settings = await readSettings(globalPmRoot);
    if (settings.telemetry.first_run_prompt_completed) {
      return;
    }
    const enabled = await promptTelemetryConsent(settings.telemetry.enabled);
    settings.telemetry.enabled = enabled;
    settings.telemetry.first_run_prompt_completed = true;
    await writeSettings(globalPmRoot, settings, "telemetry:first_run_prompt");
    output.write(
      `Telemetry ${enabled ? "enabled" : "disabled"} for this CLI install. ` +
        `Update any time with pm config global set telemetry-tracking --policy ${enabled ? "disabled" : "enabled"}.\n`,
    );
  } catch {
    // Prompt and persistence failures should never block command execution.
  }
}
