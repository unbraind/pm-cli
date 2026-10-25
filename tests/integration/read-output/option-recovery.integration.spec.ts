import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderPmCommand } from "../../../src/sdk/command-line.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

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
      const advertised = repeated.json?.read_session?.restore_reference_with as string;
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
});
