import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  main,
  scanMcpDeprecations,
} from "../../../../scripts/release/mcp-deprecation-inventory.mjs";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-mcp-deprecation-"));
  roots.push(root);
  await Promise.all([
    mkdir(path.join(root, "src/mcp"), { recursive: true }),
    mkdir(path.join(root, "src/sdk/mcp"), { recursive: true }),
    mkdir(path.join(root, "docs"), { recursive: true }),
    mkdir(path.join(root, "tests/integration"), { recursive: true }),
    mkdir(path.join(root, "scripts/release"), { recursive: true }),
    mkdir(path.join(root, "examples/mcp"), { recursive: true }),
    mkdir(path.join(root, "node_modules/ignored/mcp"), { recursive: true }),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("MCP deprecation inventory gate", () => {
  it("classifies legacy, migration, negative-control, and canonical findings", async () => {
    const root = await fixture();
    await Promise.all([
      writeFile(
        path.join(root, "src/mcp/legacy-adapter.ts"),
        'if (method === "ping") {}\n',
      ),
      writeFile(
        path.join(root, "docs/MCP_2026_07_28.md"),
        "Mcp-Session-Id migration\n",
      ),
      writeFile(
        path.join(root, "tests/integration/mcp-stateless-protocol.spec.ts"),
        'expect(method).not.toBe("initialize")\n',
      ),
      writeFile(
        path.join(root, "src/mcp/server.ts"),
        'if (method === "ping") {} // mcp-deprecation-negative-control\n',
      ),
      writeFile(
        path.join(root, "src/sdk/mcp/new.ts"),
        'const method = "tasks/result";\n',
      ),
      writeFile(
        path.join(root, "node_modules/ignored/mcp/file.ts"),
        'const method = "resources/subscribe";\n',
      ),
      writeFile(
        path.join(root, "scripts/release/mcp-deprecation-inventory.mjs"),
        'const ignored = "ping";\n',
      ),
      writeFile(path.join(root, "examples/mcp/clean.ts"), "export {};\n"),
      symlink(
        path.join(root, "examples/mcp/clean.ts"),
        path.join(root, "examples/mcp/clean-link.ts"),
      ),
    ]);
    const report = await scanMcpDeprecations(root);
    expect(report.counts).toEqual({
      total: 5,
      legacy_adapter: 1,
      migration_document: 1,
      negative_control: 1,
      bounded_source_control: 1,
      canonical_violation: 1,
    });
    expect(report.findings.at(-1)).toMatchObject({
      path: "tests/integration/mcp-stateless-protocol.spec.ts",
      disposition: "negative_control",
    });
  });

  it("sets a failing exit code only when canonical violations exist", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src/mcp/legacy-adapter.ts"), '"ping"\n');
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const passing = await main(root);
    expect(passing.counts.canonical_violation).toBe(0);
    expect(process.exitCode).toBeUndefined();
    await writeFile(
      path.join(root, "src/sdk/mcp/current.ts"),
      '"logging/setLevel"\n',
    );
    const failing = await main(root);
    expect(failing.counts.canonical_violation).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });
});
