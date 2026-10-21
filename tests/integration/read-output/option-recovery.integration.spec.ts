import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
        ["get", id, "--toon"],
        ["list", "--toon"],
        ["search", "Whitespace query", "--mode", "keyword", "--toon"],
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
        if (args.includes("--toon")) {
          expect(retry.slice(-2)).toEqual(["--output-format", "toon"]);
          expect(recovered.stdout.trimStart().startsWith("{")).toBe(false);
        }
      }
      expect(await authoritativeFiles(context.pmPath)).toEqual(before);
    });
  });
});
