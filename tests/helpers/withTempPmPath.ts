import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json?: unknown;
}

export interface TempPmContext {
  tempRoot: string;
  pmPath: string;
  env: NodeJS.ProcessEnv;
  runCli: (args: string[], options?: { expectJson?: boolean; cwd?: string }) => CliRunResult;
}

function distCliPath(): string {
  return path.resolve(process.cwd(), "dist/cli.js");
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

function normalizeLegacyCreateArgsForTests(args: string[]): string[] {
  const createIndex = args.indexOf("create");
  if (createIndex < 0) {
    return args;
  }
  if (createIndex > 0 && args.slice(0, createIndex).some((token) => !token.startsWith("-"))) {
    return args;
  }

  const normalized: string[] = args.slice(0, createIndex + 1);
  const unsetCandidates = new Set<string>();
  const unsetWithConcreteValue = new Set<string>();
  const clearCandidates = new Set<string>();
  const clearWithConcreteValue = new Set<string>();
  let sawLegacyNone = false;
  let hasCreateMode = false;

  for (let index = createIndex + 1; index < args.length; index += 1) {
    const token = args[index];
    if (!CREATE_VALUE_FLAGS.has(token)) {
      normalized.push(token);
      continue;
    }
    const next = args[index + 1];
    if (next === undefined) {
      normalized.push(token);
      continue;
    }
    const nextNormalized = next.trim().toLowerCase();
    const unsetField = CREATE_VALUE_FLAG_TO_UNSET_FIELD[token];
    const clearFlag = CREATE_REPEATABLE_CLEAR_FLAG[token];
    if (token === "--create-mode" || token === "--create_mode") {
      hasCreateMode = true;
    }
    if (!LEGACY_NONE_TOKENS.has(nextNormalized)) {
      normalized.push(token, next);
      if (unsetField) {
        unsetWithConcreteValue.add(unsetField);
      }
      if (clearFlag) {
        clearWithConcreteValue.add(clearFlag);
      }
      index += 1;
      continue;
    }
    sawLegacyNone = true;
    if (unsetField) {
      unsetCandidates.add(unsetField);
    }
    if (clearFlag) {
      clearCandidates.add(clearFlag);
    }
    index += 1;
  }

  if (!sawLegacyNone) {
    return args;
  }

  if (!hasCreateMode) {
    normalized.push("--create-mode", "progressive");
  }

  for (const field of unsetCandidates) {
    if (!unsetWithConcreteValue.has(field)) {
      normalized.push("--unset", field);
    }
  }
  for (const clearFlag of clearCandidates) {
    if (!clearWithConcreteValue.has(clearFlag)) {
      normalized.push(clearFlag);
    }
  }

  return normalized;
}

function runNodeCli(
  env: NodeJS.ProcessEnv,
  args: string[],
  options?: { expectJson?: boolean; cwd?: string },
): CliRunResult {
  const normalizedArgs = normalizeLegacyCreateArgsForTests(args);
  const completed = spawnSync(process.execPath, [distCliPath(), ...normalizedArgs], {
    cwd: options?.cwd ?? process.cwd(),
    env,
    encoding: "utf8",
  });

  const result: CliRunResult = {
    code: completed.status,
    stdout: completed.stdout ?? "",
    stderr: completed.stderr ?? "",
  };

  if (options?.expectJson && result.stdout.trim()) {
    result.json = JSON.parse(result.stdout);
  }

  return result;
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

export async function withTempPmPath<T>(callback: (context: TempPmContext) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-cli-test-"));
  const pmPath = path.join(tempRoot, ".agents", "pm");
  const env: NodeJS.ProcessEnv = {
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

  const runCli = (args: string[], options?: { expectJson?: boolean; cwd?: string }): CliRunResult =>
    runNodeCli(env, args, options);

  const previousEnv = {
    PM_PATH: process.env.PM_PATH,
    PM_GLOBAL_PATH: process.env.PM_GLOBAL_PATH,
    PM_AUTHOR: process.env.PM_AUTHOR,
    PM_TELEMETRY_DISABLED: process.env.PM_TELEMETRY_DISABLED,
    PM_TELEMETRY_OTEL_DISABLED: process.env.PM_TELEMETRY_OTEL_DISABLED,
    PM_TELEMETRY_PROMPT: process.env.PM_TELEMETRY_PROMPT,
    PM_DISABLE_OLLAMA_AUTO_DEFAULTS: process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS,
  };
  process.env.PM_PATH = env.PM_PATH;
  process.env.PM_GLOBAL_PATH = env.PM_GLOBAL_PATH;
  process.env.PM_AUTHOR = env.PM_AUTHOR;
  process.env.PM_TELEMETRY_DISABLED = env.PM_TELEMETRY_DISABLED;
  process.env.PM_TELEMETRY_OTEL_DISABLED = env.PM_TELEMETRY_OTEL_DISABLED;
  process.env.PM_TELEMETRY_PROMPT = env.PM_TELEMETRY_PROMPT;
  process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;

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
    });
  } finally {
    if (previousEnv.PM_PATH === undefined) {
      delete process.env.PM_PATH;
    } else {
      process.env.PM_PATH = previousEnv.PM_PATH;
    }
    if (previousEnv.PM_GLOBAL_PATH === undefined) {
      delete process.env.PM_GLOBAL_PATH;
    } else {
      process.env.PM_GLOBAL_PATH = previousEnv.PM_GLOBAL_PATH;
    }
    if (previousEnv.PM_AUTHOR === undefined) {
      delete process.env.PM_AUTHOR;
    } else {
      process.env.PM_AUTHOR = previousEnv.PM_AUTHOR;
    }
    if (previousEnv.PM_TELEMETRY_DISABLED === undefined) {
      delete process.env.PM_TELEMETRY_DISABLED;
    } else {
      process.env.PM_TELEMETRY_DISABLED = previousEnv.PM_TELEMETRY_DISABLED;
    }
    if (previousEnv.PM_TELEMETRY_OTEL_DISABLED === undefined) {
      delete process.env.PM_TELEMETRY_OTEL_DISABLED;
    } else {
      process.env.PM_TELEMETRY_OTEL_DISABLED = previousEnv.PM_TELEMETRY_OTEL_DISABLED;
    }
    if (previousEnv.PM_TELEMETRY_PROMPT === undefined) {
      delete process.env.PM_TELEMETRY_PROMPT;
    } else {
      process.env.PM_TELEMETRY_PROMPT = previousEnv.PM_TELEMETRY_PROMPT;
    }
    if (previousEnv.PM_DISABLE_OLLAMA_AUTO_DEFAULTS === undefined) {
      delete process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;
    } else {
      process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = previousEnv.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;
    }
    await removeTempRoot(tempRoot);
  }
}
