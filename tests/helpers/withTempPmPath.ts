import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runDirectDistCli, runInProcessDistCli, type DirectCliRunResult } from "./cliRunner.js";

export type CliRunResult = DirectCliRunResult;

export interface TempPmContext {
  tempRoot: string;
  pmPath: string;
  env: NodeJS.ProcessEnv;
  runCli: (args: string[], options?: { expectJson?: boolean; cwd?: string; input?: string }) => CliRunResult;
  runCliInProcess: (args: string[], options?: { expectJson?: boolean; cwd?: string }) => Promise<CliRunResult>;
}

const LEGACY_NONE_TOKENS = new Set(["none", "null"]);

const CREATE_VALUE_FLAG_TO_UNSET_FIELD: Readonly<Record<string, string | undefined>> = {
  "--tags": "tags",
  "--deadline": "deadline",
  "--estimate": "estimate",
  "--estimated-minutes": "estimate",
  "--acceptance-criteria": "acceptance-criteria",
  "--ac": "acceptance-criteria",
  "--definition-of-ready": "definition-of-ready",
  "--definition_of_ready": "definition-of-ready",
  "--order": "order",
  "--rank": "order",
  "--goal": "goal",
  "--objective": "objective",
  "--value": "value",
  "--impact": "impact",
  "--outcome": "outcome",
  "--why-now": "why-now",
  "--why_now": "why-now",
  "--author": "author",
  "--assignee": "assignee",
  "--parent": "parent",
  "--reviewer": "reviewer",
  "--risk": "risk",
  "--confidence": "confidence",
  "--sprint": "sprint",
  "--release": "release",
  "--blocked-by": "blocked-by",
  "--blocked_by": "blocked-by",
  "--blocked-reason": "blocked-reason",
  "--blocked_reason": "blocked-reason",
  "--unblock-note": "unblock-note",
  "--unblock_note": "unblock-note",
  "--reporter": "reporter",
  "--severity": "severity",
  "--environment": "environment",
  "--repro-steps": "repro-steps",
  "--repro_steps": "repro-steps",
  "--resolution": "resolution",
  "--expected-result": "expected-result",
  "--expected_result": "expected-result",
  "--actual-result": "actual-result",
  "--actual_result": "actual-result",
  "--affected-version": "affected-version",
  "--affected_version": "affected-version",
  "--fixed-version": "fixed-version",
  "--fixed_version": "fixed-version",
  "--component": "component",
  "--regression": "regression",
  "--customer-impact": "customer-impact",
  "--customer_impact": "customer-impact",
};

const CREATE_REPEATABLE_CLEAR_FLAG: Readonly<Record<string, string | undefined>> = {
  "--dep": "--clear-deps",
  "--comment": "--clear-comments",
  "--note": "--clear-notes",
  "--learning": "--clear-learnings",
  "--file": "--clear-files",
  "--test": "--clear-tests",
  "--doc": "--clear-docs",
  "--reminder": "--clear-reminders",
  "--event": "--clear-events",
  "--type-option": "--clear-type-options",
  "--type_option": "--clear-type-options",
};

const CREATE_VALUE_FLAGS = new Set([
  ...Object.keys(CREATE_VALUE_FLAG_TO_UNSET_FIELD),
  ...Object.keys(CREATE_REPEATABLE_CLEAR_FLAG),
  "--title",
  "--description",
  "--type",
  "--template",
  "--create-mode",
  "--create_mode",
  "--status",
  "--priority",
  "--body",
  "--message",
  "--close-reason",
  "--close_reason",
  "--metadata-profile",
  "--metadata_profile",
]);

interface LegacyCreateNormalizationState {
  normalized: string[];
  unsetCandidates: Set<string>;
  unsetWithConcreteValue: Set<string>;
  clearCandidates: Set<string>;
  clearWithConcreteValue: Set<string>;
  sawLegacyNone: boolean;
  hasCreateMode: boolean;
}

const TEMP_PM_ENV_KEYS = [
  "PM_PATH",
  "PM_GLOBAL_PATH",
  "PM_AUTHOR",
  "PM_TELEMETRY_DISABLED",
  "PM_TELEMETRY_OTEL_DISABLED",
  "PM_TELEMETRY_PROMPT",
  "PM_DISABLE_OLLAMA_AUTO_DEFAULTS",
] as const;

type TempPmEnvKey = (typeof TEMP_PM_ENV_KEYS)[number];
type TempPmEnvSnapshot = Record<TempPmEnvKey, string | undefined>;

function shouldNormalizeLegacyCreateArgs(args: string[], createIndex: number): boolean {
  return createIndex >= 0 && (createIndex === 0 || args.slice(0, createIndex).every((token) => token.startsWith("-")));
}

function createLegacyNormalizationState(args: string[], createIndex: number): LegacyCreateNormalizationState {
  return {
    normalized: args.slice(0, createIndex + 1),
    unsetCandidates: new Set<string>(),
    unsetWithConcreteValue: new Set<string>(),
    clearCandidates: new Set<string>(),
    clearWithConcreteValue: new Set<string>(),
    sawLegacyNone: false,
    hasCreateMode: false,
  };
}

function recordConcreteCreateValue(state: LegacyCreateNormalizationState, unsetField: string | undefined, clearFlag: string | undefined): void {
  if (unsetField) {
    state.unsetWithConcreteValue.add(unsetField);
  }
  if (clearFlag) {
    state.clearWithConcreteValue.add(clearFlag);
  }
}

function recordLegacyNoneCreateValue(state: LegacyCreateNormalizationState, unsetField: string | undefined, clearFlag: string | undefined): void {
  state.sawLegacyNone = true;
  if (unsetField) {
    state.unsetCandidates.add(unsetField);
  }
  if (clearFlag) {
    state.clearCandidates.add(clearFlag);
  }
}

function appendLegacyCreateClearArgs(state: LegacyCreateNormalizationState): void {
  if (!state.hasCreateMode) {
    state.normalized.push("--create-mode", "progressive");
  }

  for (const field of state.unsetCandidates) {
    if (!state.unsetWithConcreteValue.has(field)) {
      state.normalized.push("--unset", field);
    }
  }
  for (const clearFlag of state.clearCandidates) {
    if (!state.clearWithConcreteValue.has(clearFlag)) {
      state.normalized.push(clearFlag);
    }
  }
}

function normalizeLegacyCreateArgsForTests(args: string[]): string[] {
  const createIndex = args.indexOf("create");
  if (!shouldNormalizeLegacyCreateArgs(args, createIndex)) {
    return args;
  }

  const state = createLegacyNormalizationState(args, createIndex);

  for (let index = createIndex + 1; index < args.length; index += 1) {
    const token = args[index];
    if (!CREATE_VALUE_FLAGS.has(token)) {
      state.normalized.push(token);
      continue;
    }
    const next = args[index + 1];
    if (next === undefined) {
      state.normalized.push(token);
      continue;
    }
    const nextNormalized = next.trim().toLowerCase();
    const unsetField = CREATE_VALUE_FLAG_TO_UNSET_FIELD[token];
    const clearFlag = CREATE_REPEATABLE_CLEAR_FLAG[token];
    if (token === "--create-mode" || token === "--create_mode") {
      state.hasCreateMode = true;
    }
    if (!LEGACY_NONE_TOKENS.has(nextNormalized)) {
      state.normalized.push(token, next);
      recordConcreteCreateValue(state, unsetField, clearFlag);
      index += 1;
      continue;
    }
    recordLegacyNoneCreateValue(state, unsetField, clearFlag);
    index += 1;
  }

  if (!state.sawLegacyNone) {
    return args;
  }

  appendLegacyCreateClearArgs(state);
  return state.normalized;
}

function runNodeCli(
  env: NodeJS.ProcessEnv,
  args: string[],
  options?: { expectJson?: boolean; cwd?: string; input?: string },
): CliRunResult {
  const normalizedArgs = normalizeLegacyCreateArgsForTests(args);
  return runDirectDistCli(normalizedArgs, {
    cwd: options?.cwd,
    env,
    input: options?.input,
    expectJson: options?.expectJson,
  });
}

async function runNodeCliInProcess(
  env: NodeJS.ProcessEnv,
  args: string[],
  options?: { expectJson?: boolean; cwd?: string },
): Promise<CliRunResult> {
  const normalizedArgs = normalizeLegacyCreateArgsForTests(args);
  return runInProcessDistCli(normalizedArgs, {
    cwd: options?.cwd,
    env,
    expectJson: options?.expectJson,
  });
}

async function removeTempRoot(tempRoot: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      lastError = error;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (!new Set(["ENOTEMPTY", "EBUSY", "EPERM"]).has(code)) {
        throw error;
      }
      await delay(25 * (attempt + 1));
    }
  }
  throw lastError;
}

function buildTempPmEnv(tempRoot: string, pmPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PM_PATH: pmPath,
    PM_GLOBAL_PATH: path.join(tempRoot, ".pm-cli-global"),
    PM_AUTHOR: "test-author",
    PM_TELEMETRY_DISABLED: "1",
    PM_TELEMETRY_OTEL_DISABLED: "1",
    PM_TELEMETRY_PROMPT: "0",
    PM_DISABLE_OLLAMA_AUTO_DEFAULTS: "1",
    FORCE_COLOR: "0",
  };
}

function snapshotTempPmEnv(): TempPmEnvSnapshot {
  const snapshot = {} as TempPmEnvSnapshot;
  for (const key of TEMP_PM_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function applyTempPmEnv(env: NodeJS.ProcessEnv): void {
  for (const key of TEMP_PM_ENV_KEYS) {
    process.env[key] = env[key];
  }
}

function restoreTempPmEnv(snapshot: TempPmEnvSnapshot): void {
  for (const key of TEMP_PM_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export async function withTempPmPath<T>(callback: (context: TempPmContext) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-cli-test-"));
  const pmPath = path.join(tempRoot, ".agents", "pm");
  const env = buildTempPmEnv(tempRoot, pmPath);

  const runCli = (args: string[], options?: { expectJson?: boolean; cwd?: string; input?: string }): CliRunResult =>
    runNodeCli(env, args, options);
  const runCliInProcess = (args: string[], options?: { expectJson?: boolean; cwd?: string }): Promise<CliRunResult> =>
    runNodeCliInProcess(env, args, options);

  const previousEnv = snapshotTempPmEnv();
  applyTempPmEnv(env);

  try {
    const initResult = runCli(["init", "--json"], { expectJson: true });
    if (initResult.code !== 0) {
      throw new Error(`Failed to initialize test PM_PATH: ${initResult.stderr || initResult.stdout}`);
    }

    return await callback({
      tempRoot,
      pmPath,
      env,
      runCli,
      runCliInProcess,
    });
  } finally {
    restoreTempPmEnv(previousEnv);
    await removeTempRoot(tempRoot);
  }
}
