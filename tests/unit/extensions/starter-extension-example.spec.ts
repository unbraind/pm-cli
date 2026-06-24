import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("starter extension example", () => {
  it("does not leave the reference no-op migration pending", async () => {
    const source = await readFile(new URL("../../../docs/examples/starter-extension/index.ts", import.meta.url), "utf8");
    const migrationBlock = source.match(/api\.registerMigration\(\{[\s\S]*?starter-extension-noop-migration[\s\S]*?\}\);/)?.[0];

    expect(migrationBlock).toContain('status: "applied"');
    expect(migrationBlock).not.toContain('status: "active"');
  });
});
