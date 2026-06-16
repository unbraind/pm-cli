import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

export function commandFor(binary) {
  if (process.platform !== "win32") {
    return binary;
  }
  if (binary.endsWith(".cmd")) {
    return binary;
  }
  return `${binary}.cmd`;
}

export function runCommand(command, args, options = {}) {
  const {
    cwd = repoRoot,
    env = {},
    capture = false,
    allowFailure = false,
    shell = false,
  } = options;
  const mergedEnv = { ...process.env, ...env };

  const result = spawnSync(command, args, {
    cwd,
    env: mergedEnv,
    shell,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  const status = result.status ?? 1;
  if (status !== 0 && !allowFailure) {
    const stderr = capture ? (result.stderr || "").trim() : "";
    const detail = stderr.length > 0 ? `\n${stderr}` : "";
    fail(`Command failed: ${command} ${args.join(" ")}${detail}`, status);
  }

  return {
    status,
    stdout: capture ? result.stdout ?? "" : "",
    stderr: capture ? result.stderr ?? "" : "",
  };
}

export function runCommandJson(command, args, options = {}) {
  const result = runCommand(command, args, { ...options, capture: true });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    /* c8 ignore next -- JSON.parse only throws SyntaxError (an Error); the String(error) fallback is unreachable */
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to parse JSON output from ${command}: ${message}`);
  }
}

export function utcDateKey(now = new Date()) {
  return `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;
}

export function utcIsoDate(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseFlags(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }
    flags.set(key, next);
    index += 1;
  }
  return { flags, positionals };
}

export function requireFlag(flags, key, message) {
  const value = flags.get(key);
  if (value === undefined || value === true) {
    fail(message);
  }
  return String(value);
}

export function flagString(flags, key, fallback = null) {
  const value = flags.get(key);
  if (value === undefined || value === true) {
    return fallback;
  }
  return String(value);
}

export function flagBool(flags, key, fallback = false) {
  const value = flags.get(key);
  if (value === undefined) {
    return fallback;
  }
  if (value === true) {
    return true;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}
