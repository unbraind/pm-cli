/**
 * @module sdk/test/command-resolution
 * Confirms shell executable lookup failures without treating child diagnostics
 * or a deliberate exit status as evidence that a command never started.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isFileAbsentError } from "../../core/fs/fs-utils.js";

const execFileAsync = promisify(execFile);

/** Extract one literal leading executable; shell expansion remains the shell's responsibility. */
function leadingExecutable(command: string): string | undefined {
  const match = command.match(/^\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([\w./\\:-]+))(?=\s|$)/u);
  const executable = match?.[1] ?? match?.[2] ?? match?.[3];
  return executable && !/[$`%&|<>^;]/u.test(executable) ? executable : undefined;
}

/** Match only the shell's named lookup diagnostic and its platform-specific failure status. */
function shellReportsMissing(executable: string, code: number | null, stderr: string): boolean {
  if (process.platform === "win32") {
    return (code === 1 || code === 9009) && stderr.split(/\r?\n/u).some((line) =>
      line.trim() === `'${executable}' is not recognized as an internal or external command,`);
  }
  if (code !== 126 && code !== 127) return false;
  return stderr.split(/\r?\n/u).some((line) =>
    (code === 127 && (line.endsWith(`: ${executable}: not found`) || line.endsWith(`: ${executable}: command not found`))) ||
    (code === 126 && line.includes(`: ${executable}: `) && line.endsWith(": bad interpreter: No such file or directory")));
}

/** Read only a bounded shebang header; never execute a script a second time to probe its interpreter. */
async function hasAbsentScriptInterpreter(resolved: string, cwd: string): Promise<boolean> {
  const filename = resolved.trim();
  if (!filename || /[\r\n]/u.test(filename)) return false;
  try {
    const file = await open(path.resolve(cwd, filename), constants.O_RDONLY | constants.O_NONBLOCK);
    let header: string;
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      header = buffer.toString("utf8", 0, bytesRead);
      if (bytesRead === buffer.length && !header.includes("\n")) return false;
    } finally {
      await file.close();
    }
    const interpreter = header.match(/^#![ \t]*(\/[^ \t\n]+)(?:[ \t\n]|$)/u)?.[1];
    if (!interpreter) return false;
    try {
      await access(interpreter);
      return false;
    } catch (error) {
      return isFileAbsentError(error);
    }
  } catch {
    return false;
  }
}

/** Require a fresh negative executable or interpreter lookup in the same environment before classifying setup failure. */
export async function detectLinkedTestCommandNotFound(
  command: string,
  result: { exitCode: number | null; stderr: string },
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<boolean> {
  if (/[;&|<>()`$\r\n]/u.test(command)) return false;
  const executable = leadingExecutable(command);
  if (!executable || !shellReportsMissing(executable, result.exitCode, result.stderr)) return false;
  const windows = process.platform === "win32";
  const resolver = windows ? path.join(env.SystemRoot ?? "C:\\Windows", "System32", "where.exe") : "/bin/sh";
  const args = windows ? [executable] : ["-c", 'command -v "$1"', "pm-linked-test-resolution", executable];
  try {
    const { stdout } = await execFileAsync(resolver, args, { env, cwd, timeout: 1_000, windowsHide: true });
    return !windows && hasAbsentScriptInterpreter(stdout, cwd);
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; signal?: unknown };
    if (failure.killed || failure.signal) return false;
    const code = failure.code;
    return code === 1 || (!windows && code === 127);
  }
}
