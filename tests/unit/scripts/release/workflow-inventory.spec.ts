import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverWorkflowCheckNames, expandWorkflowMatrix } from "../../../../scripts/release/workflow-inventory.mjs";

describe("static workflow check names", () => {
  it("applies includes to original axes after exclusions and preserves include-only rows", () => {
    expect(expandWorkflowMatrix({
      fruit: ["apple", "pear"], animal: ["cat", "dog"],
      include: [{ color: "green" }, { color: "pink", animal: "cat" }, { fruit: "apple", shape: "circle" }, { fruit: "banana" }, { fruit: "banana", animal: "cat" }],
    })).toEqual([
      { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
      { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
      { fruit: "pear", animal: "cat", color: "pink" },
      { fruit: "pear", animal: "dog", color: "green" },
      { fruit: "banana" }, { fruit: "banana", animal: "cat" },
    ]);
    expect(expandWorkflowMatrix({ os: ["linux", "windows"], node: [22, 24], exclude: [{ os: "windows" }, { missing: true }], include: [{ os: "windows", node: 24 }] })).toEqual([
      { os: "linux", node: 22 }, { os: "linux", node: 24 }, { os: "windows", node: 24 },
    ]);
    expect(expandWorkflowMatrix({ include: [{ os: "linux" }, { os: "linux", node: 24 }] })).toEqual([{ os: "linux" }, { os: "linux", node: 24 }]);
    expect(expandWorkflowMatrix({ node: [{ version: 24 }, { version: 22 }], exclude: [{ node: { version: 22 } }] })).toEqual([{ node: { version: 24 } }]);
  });

  it("does not certify malformed, dynamic, empty, or oversized matrices", () => {
    expect(expandWorkflowMatrix(undefined)).toEqual([{}]);
    for (const matrix of [null, [], "${{ fromJSON(needs.build.outputs.matrix) }}", {}, { node: [] }, { node: "dynamic" }, { include: null }, { exclude: "invalid" }, { include: [null] }, { node: Array.from({ length: 257 }, (_, index) => index) }, { include: Array.from({ length: 257 }, (_, index) => ({ index })) }]) {
      expect(expandWorkflowMatrix(matrix)).toEqual([]);
    }
  });

  it("renders literal and nested matrix names while refusing unresolved expressions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-workflow-names-"));
    try {
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "ci.yml"), JSON.stringify({ name: "CI", jobs: {
        plain: {}, malformed: null,
        unnamed: { strategy: { matrix: { os: ["linux"] } } },
        dynamic: { name: "${{ needs.build.outputs.name }}" },
        matrix: { name: "Check (${{ matrix.node.version }}, ${{ matrix.enabled }})", strategy: { matrix: { include: [{ node: { version: 24 }, enabled: false }, { node: 22 }, { node: null }] } } },
        object: { name: "${{ matrix.node }}", strategy: { matrix: { node: [{ version: 24 }] } } },
      } }));
      await writeFile(path.join(root, "fallback.yaml"), "jobs:\n  plain: {}\n");
      await writeFile(path.join(root, "null.yml"), "null\n");
      await writeFile(path.join(root, "ignored.txt"), "not yaml");
      expect(await discoverWorkflowCheckNames(root)).toEqual([".github/workflows/fallback.yaml / plain", "CI / Check (24, false)", "CI / plain"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
