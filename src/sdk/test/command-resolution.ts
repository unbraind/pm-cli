/**
 * @module sdk/test/command-resolution
 * Confirms shell executable lookup failures without treating child diagnostics
 * or a deliberate exit status as evidence that a command never started.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

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
  return code === 127 && stderr.split(/\r?\n/u).some((line) =>
    line.endsWith(`: ${executable}: not found`) || line.endsWith(`: ${executable}: command not found`));
}

/** Require a fresh negative lookup in the same environment and working directory before classifying setup failure. */
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
    await execFileAsync(resolver, args, { env, cwd, timeout: 1_000, windowsHide: true });
    return false;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === 1 || (!windows && code === 127);
  }
}
