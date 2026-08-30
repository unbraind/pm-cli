import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  _testOnlyTestCommand,
  classifyLinkedTestCommandSafety,
} from "../../../src/sdk/test/execution.js";
import {
  extractPmInvocationArgsFromSegment,
  isPmCliScriptToken,
} from "../../../src/sdk/test/linked-command-detection.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("linked command executable identity", () => {
  it("does not treat an unrelated dist/cli.js as pm, including through env", async () => {
    await withTempPmPath(async ({ tempRoot }) => {
      await mkdir(path.join(tempRoot, "dist"), { recursive: true });
      await writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({ name: "unrelated-cli" }),
        "utf8",
      );
      await writeFile(path.join(tempRoot, "dist", "cli.js"), "", "utf8");

      expect(isPmCliScriptToken("dist/cli.js", tempRoot)).toBe(false);
      expect(isPmCliScriptToken("missing/dist/cli.js", tempRoot)).toBe(false);
      expect(
        extractPmInvocationArgsFromSegment(
          "READ_ONLY=1 node dist/cli.js schema research --format json",
          tempRoot,
        ),
      ).toBeNull();
    });
  });

  it("recognizes checkout-relative and absolute pm CLI scripts by package identity", () => {
    const repositoryRoot = process.cwd();
    const absoluteCli = path.join(repositoryRoot, "dist", "cli.js");

    expect(isPmCliScriptToken("dist/cli.js", repositoryRoot)).toBe(true);
    expect(isPmCliScriptToken(absoluteCli, path.dirname(repositoryRoot))).toBe(
      true,
    );
    expect(
      extractPmInvocationArgsFromSegment(
        `node ${absoluteCli} get pm-example --json`,
        path.dirname(repositoryRoot),
      ),
    ).toEqual(["get", "pm-example", "--json"]);
  });

  it("classifies equivalent direct-runner spellings as advisory and accepts them at intake", () => {
    const equivalentCommands = [
      "node --test x.ts",
      "node vitest run x.ts",
      'sh -c "node --test x.ts"',
      "vitest run x.ts",
      "/workspace/node_modules/.bin/vitest run x.ts",
      "/workspace/vitest.mjs run x.ts",
      "npx vitest run x.ts",
      "npx test x.ts",
      "npx test:unit x.ts",
      "bunx test x.ts",
      "pnpm dlx vitest run x.ts",
      "pnpm run vitest x.ts",
      "pnpm run test:unit x.ts",
      "pnpm test -- --runInBand",
      "npm exec -- vitest run x.ts",
      "npm run vitest x.ts",
      "npm run test:unit x.ts",
      "npm test -- --runInBand",
      "yarn run vitest x.ts",
      "yarn run test:unit x.ts",
      "yarn test --runInBand",
      "bun run vitest x.ts",
      "bun run test:unit x.ts",
      "bun test --runInBand",
    ];
    for (const command of equivalentCommands) {
      expect(classifyLinkedTestCommandSafety(command)).toMatchObject({
        accepted: true,
        command_kind: "direct_runner",
        tracker_isolation: "runtime_injected",
        trust_boundary: "provenance",
      });
      expect(() =>
        _testOnlyTestCommand.parseAddJsonEntries([
          JSON.stringify({ command }),
        ]),
      ).not.toThrow();
    }

    for (const command of [
      "node scripts/run-tests.mjs test",
      "node ./scripts/run-tests.mjs",
    ]) {
      expect(classifyLinkedTestCommandSafety(command).command_kind).toBe(
        "sandbox_runner",
      );
    }

    for (const command of [
      "",
      "PM_PATH=/tmp/isolated",
      "sh script.sh",
      "node --test-name-pattern=abc x.ts",
      "node test/x.test.ts",
      "pytest -k name",
    ]) {
      expect(classifyLinkedTestCommandSafety(command)).toMatchObject({
        accepted: true,
        command_kind: "other",
      });
      if (command.length > 0) {
        expect(() =>
          _testOnlyTestCommand.parseAddJsonEntries([
            JSON.stringify({ command }),
          ]),
        ).not.toThrow();
      }
    }
  });
});
