/**
 * Executes rendered pm command arguments through the real shell of each
 * dialect and checks the program receives them byte for byte, with nothing
 * expanded (pm-kjoudp, GH-1774). POSIX runs wherever `sh` exists, cmd.exe on
 * Windows, and PowerShell wherever `pwsh` is installed.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  quoteCommandArg,
  quoteWindowsCommandArg,
  type CommandShellDialect,
} from "../../../src/core/shared/command-line.js";

/** A variable every shell could expand; the arguments below reference it in each dialect's syntax. */
const PROBE = "PM_SHELL_PROBE";
const PROBE_VALUE = "EXPANDED-BY-SHELL";

/** Arguments a recovery command can carry: tracker paths, titles and selectors with each dialect's metacharacters. */
const HOSTILE_ARGUMENTS = [
  `C:\\repo\\%${PROBE}%\\pm`,
  `%${PROBE}:E=X%`,
  `%${PROBE}%%${PROBE}%`,
  "100%",
  'a"b & echo PWNED',
  'title "quoted"',
  `$(Write-Output PWNED)`,
  `$env:${PROBE}`,
  `\${${PROBE}}`,
  "`tick` and $(echo sub)",
  "it's",
  "smart\u2019s",
  "a,b",
  "@splat",
  "--",
  "--fields",
  "",
  "tab\there",
  "C:\\Program Files\\pm\\",
  "^caret ^& (paren) <in> >out |pipe",
  "!bang!",
  "literal !! and !$ and it's !",
  "line;next",
];

const historyBash = spawnSync("bash", ["--version"]).status === 0;
const powerShell = ["pwsh"].find((candidate) => spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"]).status === 0);

let workdir: string;
let echoScript: string;

beforeAll(async () => {
  workdir = await mkdtemp(path.join(os.tmpdir(), "pm-shell-safety-"));
  echoScript = path.join(workdir, "argv.cjs");
  await writeFile(echoScript, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

/** The rendered arguments, quoted for one dialect exactly as recovery commands quote them. */
function renderArguments(dialect: CommandShellDialect): string {
  return HOSTILE_ARGUMENTS.map((arg) => quoteCommandArg(arg, process.platform, dialect)).join(" ");
}

function parseEcho(result: ReturnType<typeof spawnSync>): string[] {
  expect(result.error).toBeUndefined();
  expect(result.status, String(result.stderr)).toBe(0);
  return JSON.parse(String(result.stdout)) as string[];
}

const env = { ...process.env, [PROBE]: PROBE_VALUE };

describe("rendered command arguments survive their declared shell unchanged", () => {
  it.runIf(process.platform !== "win32")("posix: sh receives every argument literally", () => {
    const line = `${quoteCommandArg(process.execPath, process.platform, "posix")} ${quoteCommandArg(echoScript, process.platform, "posix")} ${renderArguments("posix")}`;
    // sh reads the rendered line from stdin and parses it exactly as a pasted, non-interactive command.
    const received = parseEcho(spawnSync("sh", ["-s"], { env, input: `${line}\n` }));
    expect(received).toEqual(HOSTILE_ARGUMENTS);
  });

  it.runIf(process.platform !== "win32" && historyBash)("posix: bash with history expansion on receives every argument literally", () => {
    const line = `${quoteCommandArg(process.execPath, process.platform, "posix")} ${quoteCommandArg(echoScript, process.platform, "posix")} ${renderArguments("posix")}`;
    // History and history expansion on, as at an interactive prompt (bash -i would wait for a terminal).
    const result = spawnSync("bash", ["--norc", "--noprofile", "-s"], {
      env,
      input: `set -o history -o histexpand\necho history-seed\n${line}\n`,
      timeout: 30_000,
    });
    const echoed = String(result.stdout).split("\n").find((output) => output.startsWith("["));
    expect(echoed, String(result.stderr)).toBeDefined();
    expect(JSON.parse(echoed!)).toEqual(HOSTILE_ARGUMENTS);
  });

  it.runIf(process.platform === "win32")("cmd: cmd.exe /c neither expands %VAR% nor splits at a quoted &", () => {
    const line = `${quoteWindowsCommandArg(process.execPath)} ${quoteWindowsCommandArg(echoScript)} ${renderArguments("cmd")}`;
    // /s strips only the outer quotes, so cmd.exe parses the rendered line exactly as a pasted one.
    const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      env,
      windowsVerbatimArguments: true,
    });
    const received = parseEcho(result);
    expect(received).toEqual(HOSTILE_ARGUMENTS);
    expect(String(result.stdout)).not.toContain(PROBE_VALUE);
  });

  it.runIf(powerShell !== undefined)("powershell: literal strings never expand $, $(...), backticks or %VAR%", () => {
    const line = `& ${quoteCommandArg(process.execPath, process.platform, "powershell")} ${quoteCommandArg(echoScript, process.platform, "powershell")} ${renderArguments("powershell")}`;
    const encoded = Buffer.from(line, "utf16le").toString("base64");
    const result = spawnSync(powerShell!, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { env });
    const received = parseEcho(result);
    expect(received).toEqual(HOSTILE_ARGUMENTS);
    expect(String(result.stdout)).not.toContain(PROBE_VALUE);
  });
});
