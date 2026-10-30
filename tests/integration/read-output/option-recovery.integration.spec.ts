import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderPmCommand } from "../../../src/sdk/command-line.js";
import { resolveReadCompletenessControls } from "../../../src/sdk/agent/command-recovery.js";
import { PM_READ_OUTPUT_SURFACE_CONTRACTS } from "../../../src/sdk/read-output-contracts.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

/** One misspelled completeness control per declaring read surface, generated from the runtime contracts. */
function completenessMisspellings(id: string): string[][] {
  const operands: Record<string, string[]> = { get: [id], deps: [id], history: [id], graph: ["analyze"], search: ["Whitespace query", "--mode", "keyword"] };
  return PM_READ_OUTPUT_SURFACE_CONTRACTS.flatMap(({ command }) => {
    const controls = resolveReadCompletenessControls(command);
    if (controls === undefined) return [];
    const level = controls.depth_values.find((value) => !controls.declared_flags.includes(`--${value}`));
    const spelling = level === undefined ? ["--depth", controls.modes[0]!] : [`--${level}`];
    return [[command, ...(operands[command] ?? []), ...spelling], [command, ...(operands[command] ?? []), "--depth", "standard"]]
      .filter((args) => level === undefined || args.at(-1) !== "standard");
  });
}

/** Snapshot authoritative bytes while excluding regenerable runtime/search caches. */
async function authoritativeFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (/^(?:runtime|search|locks)\//u.test(relative)) continue;
    files[relative] = await readFile(absolute, "utf8");
  }
  return files;
}

describe("same-command read option recovery (GH-1528)", () => {
  it("restores a repeated session item by executing the advertised recovery command", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "Task", "Restore session context", "--json"], { expectJson: true });
      expect(created.code).toBe(0);
      const id = created.json?.item?.id as string;
      const initial = { version: 1, id: "recovery", token_budget: 10_000, spent_tokens: 0, seen_item_ids: [] };
      const first = context.runCli(["list", "--output-session", JSON.stringify(initial), "--json"], { expectJson: true });
      expect(first.code, first.stderr).toBe(0);
      const repeated = context.runCli(["list", "--output-session", JSON.stringify(first.json?.read_session?.next_state), "--json"], { expectJson: true });
      expect(repeated.code, repeated.stderr).toBe(0);
      expect(repeated.json?.items).toEqual([{ id, context_ref: `session:recovery:${id}` }]);
      const advertised: unknown = repeated.json?.read_session?.restore_reference_with;
      if (typeof advertised !== "string") throw new Error("Missing executable session-reference recovery command");
      const args = advertised.replace("<item-id>", id).split(" ");
      expect(args.shift()).toBe("pm");
      const restored = context.runCli([...args, "--json"], { expectJson: true });
      expect(restored.code, restored.stderr).toBe(0);
      expect(restored.json?.item).toMatchObject({ id, title: "Restore session context" });
    });
  });

  it("executes emitted retries without losing operands, explicit tracker selection or authoritative bytes", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "Task", "Whitespace query", "--json"], { expectJson: true });
      expect(created.code).toBe(0);
      const id = created.json?.item?.id as string;
      const before = await authoritativeFiles(context.pmPath);
      for (const args of [
        ["context", "--full"],
        ["list", "--depth", "full"],
        ["search", "Whitespace query", "--mode", "keyword", "--depth=full"],
      ]) {
        const refused = context.runCli(["--pm-path", context.pmPath, "--no-extensions", "--json", ...args], { expectJson: true });
        expect(refused.code).toBe(2);
        const error = JSON.parse(refused.stderr) as { recovery: { suggested_retry_args: string[] } };
        const retry = error.recovery.suggested_retry_args;
        expect(retry, refused.stderr).toBeDefined();
        expect(retry.slice(0, 3)).toEqual(["--pm-path", context.pmPath, "--no-extensions"]);
        expect(retry).toContain(args[0]);
        if (args[0] === "search") expect(retry).toContain("Whitespace query");
        const recovered = context.runCli(retry);
        expect(recovered.code, recovered.stderr).toBe(0);
      }
      const prefix = ["--pm-path", context.pmPath, "--no-extensions"];
      for (const args of [["get", id], ["list"], ["search", "Whitespace query", "--mode", "keyword"], ["context"]]) {
        const retry = [...prefix, ...args, "--output-format", "toon"];
        const refused = context.runCli([...prefix, ...args, "--toon"]);
        expect(refused.code).toBe(2);
        expect(refused.stderr).toContain(`suggested_retry: ${renderPmCommand(retry)}`);
        const recovered = context.runCli(retry);
        expect(recovered.code, recovered.stderr).toBe(0);
        expect(recovered.stdout.trimStart().startsWith("{")).toBe(false);

        const conflict = context.runCli([...prefix, "--json", ...args, "--toon"]);
        expect(conflict.code).toBe(2);
        const error = JSON.parse(conflict.stderr) as { recovery?: { suggested_retry_args?: string[]; suggested_retry?: string } };
        expect(error.recovery?.suggested_retry_args).toBeUndefined();
        expect(error.recovery?.suggested_retry).toBeUndefined();
      }
      expect(await authoritativeFiles(context.pmPath)).toEqual(before);
    });
  });

  it("executes the contract-derived completeness correction on every declaring read surface (GH-1626)", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "Task", "Whitespace query", "--json"], { expectJson: true });
      expect(created.code).toBe(0);
      const id = created.json?.item?.id as string;
      const prefix = ["--pm-path", context.pmPath, "--no-extensions"];
      const before = await authoritativeFiles(context.pmPath);
      const cases = completenessMisspellings(id);
      expect(cases.length).toBeGreaterThanOrEqual(20);
      for (const args of cases) {
        const refused = context.runCli([...prefix, "--json", ...args], { expectJson: true });
        expect(refused.code, args.join(" ")).toBe(2);
        const error = JSON.parse(refused.stderr) as { recovery: { suggested_retry_args?: string[] } };
        const retry = error.recovery.suggested_retry_args;
        expect(retry, `${args.join(" ")}: ${refused.stderr}`).toBeDefined();
        const recovered = context.runCli(retry!);
        expect(recovered.code, `${renderPmCommand(retry!)}: ${recovered.stderr}`).toBe(0);
      }
      const unmatched = context.runCli([...prefix, "search", "Whitespace query", "--depth", "brief"]);
      expect(unmatched.code).toBe(2);
      expect(unmatched.stderr).toContain("Completeness controls accepted by pm search: --compact, --full.");
      expect(unmatched.stderr).not.toContain("Replay with suggested correction");
      expect(await authoritativeFiles(context.pmPath)).toEqual(before);
    });
  }, 180_000);

  it("replays a dash-leading close reason and comment without losing the text (pm-stq61b)", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "Task", "Dash-leading values", "--json"], { expectJson: true });
      expect(created.code).toBe(0);
      const id = created.json?.item?.id as string;
      const prefix = ["--pm-path", context.pmPath, "--no-extensions"];
      for (const args of [["comments", id, "--flag style comment"], ["close", id, "--unset is now a list"]]) {
        const refused = context.runCli([...prefix, "--json", ...args], { expectJson: true });
        expect(refused.code, args.join(" ")).toBe(2);
        const retry = (JSON.parse(refused.stderr) as { recovery: { suggested_retry_args?: string[] } }).recovery.suggested_retry_args;
        expect(retry?.slice(-2)).toEqual(["--", args[2]]);
        const replayed = context.runCli(retry!);
        expect(replayed.code, replayed.stderr).toBe(0);
      }
      const read = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(read.json?.item).toMatchObject({ status: "closed", close_reason: "--unset is now a list" });
      expect(JSON.stringify(context.runCli(["comments", id, "--json"], { expectJson: true }).json)).toContain("--flag style comment");
    });
  });
});
