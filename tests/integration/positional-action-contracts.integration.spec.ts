import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("positional action contracts", () => {
  it("projects plan actions through direct help, generic help, and runtime contracts", async () => {
    await withTempPmPath(async (context) => {
      const direct = context.runCli(["plan", "create", "--help", "--json"], {
        expectJson: true,
      }).json as {
        usage: string;
        arguments: Array<{ name: string; required: boolean }>;
        options: Array<{ flags: string }>;
        subcommands: unknown[];
      };
      expect(direct).toMatchObject({
        usage: "plan create [title]",
        arguments: [{ name: "title", required: false }],
        subcommands: [],
      });
      expect(direct.options.some(({ flags }) => flags.includes("--title"))).toBe(
        true,
      );
      expect(direct.options.some(({ flags }) => flags.includes("--depth"))).toBe(
        false,
      );

      const generic = context.runCli(["help", "plan", "create", "--json"], {
        expectJson: true,
      }).json as { usage: string; arguments: Array<{ name: string }> };
      expect(generic).toMatchObject({
        usage: direct.usage,
        arguments: [{ name: "title" }],
      });

      const root = context.runCli(["plan", "--help", "--json"], {
        expectJson: true,
      }).json as {
        arguments: Array<{ name: string; required: boolean }>;
        subcommands: Array<{ name: string }>;
      };
      expect(root.arguments[0]).toEqual({
        name: "subcommand",
        required: true,
        variadic: false,
        description: expect.any(String),
      });
      expect(root.subcommands.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["create", "materialize", "reorder-step"]),
      );

      const contracts = context.runCli(
        [
          "contracts",
          "--command",
          "plan create",
          "--json",
          "--output-budget",
          "unbounded",
        ],
        { expectJson: true },
      ).json as {
        actions: string[];
        command_flags: Array<{
          command: string;
          flags: Array<{ flag: string }>;
          positionals: Array<{ name: string; required: boolean }>;
        }>;
      };
      expect(contracts.actions).toEqual(["plan"]);
      expect(contracts.command_flags).toEqual([
        expect.objectContaining({
          command: "plan create",
          flags: expect.arrayContaining([{ flag: "--title" }]),
          positionals: [
            expect.objectContaining({ name: "title", required: false }),
          ],
        }),
      ]);
    });
  });

  it("keeps rich dispatch recovery when a required subcommand is omitted", async () => {
    await withTempPmPath(async (context) => {
      for (const command of ["plan", "profile", "schema"]) {
        const result = context.runCli([command, "--json"]);
        expect(result.code).toBe(2);
        expect(JSON.parse(result.stderr)).toMatchObject({
          code: "missing_required_argument",
          detail: expect.stringContaining("requires a subcommand"),
        });
      }
    });
  });

  it("executes structured linked-resource names as create and update aliases", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--create-mode",
          "progressive",
          "--title",
          "Alias parity fixture",
          "--type",
          "Task",
          "--status",
          "open",
          "--linked-file",
          "path=README.md,scope=project",
          "--linked-test",
          "command=pnpm build,scope=project",
          "--json",
        ],
        { expectJson: true },
      ).json as {
        item: {
          id: string;
          files: Array<{ path: string }>;
          tests: Array<{ command: string }>;
        };
      };
      expect(created.item.files).toContainEqual(
        expect.objectContaining({ path: "README.md" }),
      );
      expect(created.item.tests).toContainEqual(
        expect.objectContaining({ command: "pnpm build" }),
      );

      const updated = context.runCli(
        [
          "update",
          created.item.id,
          "--linked-file",
          "path=package.json,scope=project",
          "--linked-test",
          "command=pnpm lint,scope=project",
          "--json",
        ],
        { expectJson: true },
      ).json as {
        item: {
          files: Array<{ path: string }>;
          tests: Array<{ command: string }>;
        };
      };
      expect(updated.item.files).toContainEqual(
        expect.objectContaining({ path: "package.json" }),
      );
      expect(updated.item.tests).toContainEqual(
        expect.objectContaining({ command: "pnpm lint" }),
      );

      const rejected = context.runCli([
        "update",
        created.item.id,
        "--linked-files",
        "package.json",
        "--json",
      ]);
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain("--linked-file");
    });
  });
});
