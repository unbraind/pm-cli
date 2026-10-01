import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("scope-preserving projection retries (GH-1364)", () => {
  it("executes the exact emitted argv against the selected tracker for projections and intent conflicts", async () => {
    await withTempPmPath(async (context) => {
      const other = path.join(context.tempRoot, "other tracker with spaces");
      const run = (args: string[]) => context.runCliInProcess(args, { expectJson: true, cwd: context.tempRoot });
      expect((await run(["init", other, "--defaults", "--agent-guidance", "skip", "--json"])).code).toBe(0);
      for (const [scope, title] of [[[], "Default tracker"], [["--pm-path", other], "Selected tracker"]] as const) {
        expect((await run([...scope, "create", "task", title, "--id", "collision", "--json"])).code).toBe(0);
      }
      const flagPath = path.join(context.tempRoot, "--fields");
      expect((await run(["init", flagPath, "--defaults", "--agent-guidance", "skip", "--json"])).code).toBe(0);
      expect((await run(["--pm-path", flagPath, "create", "task", "Selected tracker", "--id", "collision", "--json"])).code).toBe(0);
      for (const invocation of [
        ["--pm-path", "--fields", "get", "pm-collision", "--fields", "title,titlle,close_reason", "--json"],
        ["--pm-path", other, "get", "pm-collision", "--fields", "title,titlle,close_reason", "--json"],
        ["get", "pm-collision", `--pm-path=${other}`, "--fields=title,titlle,close_reason", "--json"],
        ["--path", other, "show", "pm-collision", "--fields", "title", "--fields", "titlle,close_reason", "--json"],
        ["get", "pm-collision", "--pm-path", other, "--for", "inspect", "--full", "--json"],
        ["--pm-path", other, "list", "--fields", "title,titlle", "--limit", "1", "--json"],
        ["search", "Selected", "--pm-path", other, "--fields=title,titlle", "--limit", "1", "--json"],
      ]) {
        const refused = await run(invocation);
        expect(refused.code).toBe(2);
        const error = JSON.parse(refused.stderr) as { recovery: { suggested_retry_args: string[] } };
        const args = error.recovery.suggested_retry_args;
        expect(args).toContain("--json");
        const replay = await run(args);
        expect(replay.code).toBe(0);
        if (invocation.includes("list") || invocation.includes("search")) {
          expect(replay.json).toMatchObject({ items: [{ title: "Selected tracker" }] });
          expect(args).toContain("--limit");
        } else {
          expect(replay.json).toMatchObject({ item: { id: "pm-collision", title: "Selected tracker" } });
        }
        if (invocation.some((token) => token.startsWith("--fields"))) {
          expect(args[args.lastIndexOf("--fields") + 1]).toBe(invocation.some((token) => token.includes("close_reason")) ? "title,close_reason" : "title");
        }
      }
    });
  });
});
