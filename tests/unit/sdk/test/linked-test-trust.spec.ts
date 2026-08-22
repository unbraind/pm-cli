import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntimePath } from "../../../../src/core/store/paths.js";
import { _testOnlyTestAll } from "../../../../src/sdk/test/batch.js";
import {
  parseLinkedTestJsonEntries,
  parseLinkedTestWorkspaceContextMode,
} from "../../../../src/sdk/test/parsers.js";
import {
  acknowledgeLinkedTests,
  attachLinkedTestMutationProvenance,
  attachLinkedTestProvenance,
  linkedTestTrustFingerprint,
  resolveLinkedTestSourceRef,
  resolveLinkedTestSourceWorkspaceRoot,
  resolveLinkedTestTrust,
  resolveLinkedTestTrustBatch,
} from "../../../../src/sdk/test/trust.js";
import type { LinkedTest } from "../../../../src/types/index.js";

const localTest: LinkedTest = {
  command: "node --version",
  scope: "project",
  workspace_context_mode: "isolated",
  provenance: {
    author: "maintainer",
    created_at: "2026-08-22T12:00:00.000Z",
    source_kind: "local_mutation",
    source_ref: "feature/trust",
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("linked-test trust", () => {
  it("attaches immutable provenance only to new command entries", () => {
    expect(
      attachLinkedTestProvenance(
        undefined,
        "maintainer",
        "2026-08-22T12:00:00.000Z",
        "feature/trust",
      ),
    ).toBeUndefined();
    const existing = { ...localTest };
    expect(
      attachLinkedTestProvenance(
        [{ path: "tests/a.spec.ts", scope: "project" }, existing],
        "other",
        "2026-08-22T13:00:00.000Z",
        undefined,
      ),
    ).toEqual([{ path: "tests/a.spec.ts", scope: "project" }, existing]);
    expect(
      attachLinkedTestProvenance(
        [{ command: "pnpm test", scope: "project" }],
        "maintainer",
        "2026-08-22T12:00:00.000Z",
        "feature/trust",
      ),
    ).toEqual([
      {
        command: "pnpm test",
        scope: "project",
        provenance: {
          author: "maintainer",
          created_at: "2026-08-22T12:00:00.000Z",
          source_kind: "local_mutation",
          source_ref: "feature/trust",
        },
      },
    ]);
    expect(
      attachLinkedTestProvenance(
        [{ command: "pnpm lint", scope: "project" }],
        "maintainer",
        "2026-08-22T12:00:00.000Z",
        undefined,
      )?.[0]?.provenance,
    ).toEqual({
      author: "maintainer",
      created_at: "2026-08-22T12:00:00.000Z",
      source_kind: "local_mutation",
    });
  });

  it("skips source-ref inspection for empty mutations", async () => {
    await expect(
      attachLinkedTestMutationProvenance(
        undefined,
        "maintainer",
        "2026-08-22T12:00:00.000Z",
      ),
    ).resolves.toBeUndefined();
    await expect(
      attachLinkedTestMutationProvenance(
        [],
        "maintainer",
        "2026-08-22T12:00:00.000Z",
      ),
    ).resolves.toEqual([]);
    vi.stubEnv("GITHUB_HEAD_REF", "feature/trust");
    await expect(
      attachLinkedTestMutationProvenance(
        [{ command: "pnpm test", scope: "project" }],
        "maintainer",
        "2026-08-22T12:00:00.000Z",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        provenance: expect.objectContaining({
          source_ref: "feature/trust",
        }),
      }),
    ]);
  });

  it("binds fingerprints to command, context, and provenance", () => {
    const fingerprint = linkedTestTrustFingerprint(localTest);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      linkedTestTrustFingerprint({
        ...localTest,
        workspace_context_mode: "snapshot",
      }),
    ).not.toBe(fingerprint);
    expect(
      linkedTestTrustFingerprint({ ...localTest, path: "tests/a.spec.ts" }),
    ).not.toBe(fingerprint);
    expect(
      linkedTestTrustFingerprint({ path: "tests/a.spec.ts", scope: "project" }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves hosted, Git, and absent source refs without a shell", async () => {
    vi.stubEnv("PM_SOURCE_WORKSPACE_ROOT", "/source/workspace");
    expect(resolveLinkedTestSourceWorkspaceRoot("/fallback")).toBe(
      "/source/workspace",
    );
    vi.stubEnv("PM_SOURCE_WORKSPACE_ROOT", "");
    expect(resolveLinkedTestSourceWorkspaceRoot("/fallback")).toBe("/fallback");
    vi.stubEnv("GITHUB_HEAD_REF", "hosted/feature");
    expect(await resolveLinkedTestSourceRef("/missing")).toBe("hosted/feature");
    vi.stubEnv("GITHUB_HEAD_REF", "");
    vi.stubEnv("GITHUB_REF_NAME", "hosted/fallback");
    expect(await resolveLinkedTestSourceRef("/missing")).toBe(
      "hosted/fallback",
    );
    vi.stubEnv("GITHUB_REF_NAME", "");

    const root = await mkdtemp(path.join(os.tmpdir(), "pm-trust-git-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["checkout", "-b", "local/trust", "--quiet"], {
        cwd: root,
      });
      expect(await resolveLinkedTestSourceRef(root)).toBe("local/trust");
      expect(
        await resolveLinkedTestSourceRef(path.join(root, "missing")),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies legacy, local, foreign, and acknowledged commands", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-trust-ledger-"));
    try {
      await expect(
        resolveLinkedTestTrust(
          pmRoot,
          { command: "node --version", scope: "project" },
          "main",
        ),
      ).resolves.toMatchObject({ trusted: true, reason: "legacy" });
      await expect(
        resolveLinkedTestTrust(pmRoot, localTest, "feature/trust"),
      ).resolves.toMatchObject({
        trusted: true,
        reason: "local_source_ref",
        source_ref: "feature/trust",
        current_source_ref: "feature/trust",
      });
      await expect(
        resolveLinkedTestTrust(
          pmRoot,
          {
            ...localTest,
            provenance: {
              ...localTest.provenance!,
              source_ref: undefined,
            },
          },
          "main",
        ),
      ).resolves.toMatchObject({ trusted: true, reason: "local_mutation" });
      const localWithoutRefs = await resolveLinkedTestTrust(
        pmRoot,
        {
          ...localTest,
          provenance: {
            ...localTest.provenance!,
            source_ref: undefined,
          },
        },
        undefined,
      );
      expect(localWithoutRefs).toMatchObject({
        trusted: true,
        reason: "local_mutation",
      });
      expect(localWithoutRefs).not.toHaveProperty("current_source_ref");
      const foreignWithoutCurrentRef = await resolveLinkedTestTrust(
        pmRoot,
        localTest,
        undefined,
      );
      expect(foreignWithoutCurrentRef).toMatchObject({
        trusted: false,
        reason: "foreign_source_ref",
        source_ref: "feature/trust",
      });
      expect(foreignWithoutCurrentRef).not.toHaveProperty("current_source_ref");
      await expect(
        resolveLinkedTestTrust(
          pmRoot,
          {
            ...localTest,
            provenance: {
              ...localTest.provenance!,
              source_kind: "merge_union",
            },
          },
          "feature/trust",
        ),
      ).resolves.toMatchObject({
        trusted: false,
        reason: "foreign_source_ref",
      });
      await expect(
        resolveLinkedTestTrust(pmRoot, localTest, "main"),
      ).resolves.toMatchObject({
        trusted: false,
        reason: "foreign_source_ref",
      });
      await expect(
        resolveLinkedTestTrust(
          pmRoot,
          {
            command: "node --version",
            scope: "project",
            provenance: {
              source_kind: "merge_union",
            } as LinkedTest["provenance"],
          },
          "main",
        ),
      ).resolves.toMatchObject({
        trusted: false,
        reason: "invalid_provenance",
        current_source_ref: "main",
      });
      for (const provenance of [null, "tampered"]) {
        const invalidWithoutCurrentRef = await resolveLinkedTestTrust(
          pmRoot,
          {
            command: "node --version",
            scope: "project",
            provenance: provenance as unknown as LinkedTest["provenance"],
          },
          undefined,
        );
        expect(invalidWithoutCurrentRef).toMatchObject({
          trusted: false,
          reason: "invalid_provenance",
        });
        expect(invalidWithoutCurrentRef).not.toHaveProperty(
          "current_source_ref",
        );
      }

      await mkdir(getRuntimePath(pmRoot), { recursive: true });
      await writeFile(
        path.join(getRuntimePath(pmRoot), "linked-test-trust.json"),
        "not-json",
      );
      await expect(
        resolveLinkedTestTrust(pmRoot, localTest, "main"),
      ).resolves.toMatchObject({ trusted: false });
      await writeFile(
        path.join(getRuntimePath(pmRoot), "linked-test-trust.json"),
        JSON.stringify({ version: 2, acknowledged: [] }),
      );
      await expect(
        resolveLinkedTestTrust(pmRoot, localTest, "main"),
      ).resolves.toMatchObject({ trusted: false });
      for (const acknowledged of [null, []]) {
        await writeFile(
          path.join(getRuntimePath(pmRoot), "linked-test-trust.json"),
          JSON.stringify({ version: 1, acknowledged }),
        );
        await expect(
          resolveLinkedTestTrust(pmRoot, localTest, "main"),
        ).resolves.toMatchObject({ trusted: false });
      }

      const acknowledgement = await acknowledgeLinkedTests(
        pmRoot,
        [localTest, { path: "tests/a.spec.ts", scope: "project" }],
        "2026-08-22T14:00:00.000Z",
      );
      expect(acknowledgement).toEqual({
        acknowledged: 1,
        fingerprints: [linkedTestTrustFingerprint(localTest)],
      });
      await expect(
        resolveLinkedTestTrustBatch(pmRoot, [localTest], "main"),
      ).resolves.toEqual([
        expect.objectContaining({ trusted: true, reason: "acknowledged" }),
      ]);

      const noRefForeign: LinkedTest = {
        ...localTest,
        provenance: {
          ...localTest.provenance!,
          source_kind: "merge_union",
          source_ref: undefined,
        },
      };
      const foreignWithoutRefs = await resolveLinkedTestTrust(
        pmRoot,
        noRefForeign,
        undefined,
      );
      expect(foreignWithoutRefs).toMatchObject({
        trusted: false,
        reason: "foreign_source_ref",
      });
      expect(foreignWithoutRefs).not.toHaveProperty("source_ref");
      expect(foreignWithoutRefs).not.toHaveProperty("current_source_ref");
      await acknowledgeLinkedTests(
        pmRoot,
        [noRefForeign],
        "2026-08-22T14:01:00.000Z",
      );
      const acknowledgedWithoutRefs = await resolveLinkedTestTrust(
        pmRoot,
        noRefForeign,
        undefined,
      );
      expect(acknowledgedWithoutRefs).toMatchObject({
        trusted: true,
        reason: "acknowledged",
      });
      expect(acknowledgedWithoutRefs).not.toHaveProperty("source_ref");
      expect(acknowledgedWithoutRefs).not.toHaveProperty("current_source_ref");
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("validates workspace modes and preserves their batch identity", () => {
    expect(parseLinkedTestWorkspaceContextMode(undefined, "--workspace")).toBe(
      undefined,
    );
    expect(
      parseLinkedTestWorkspaceContextMode(" SNAPSHOT ", "--workspace"),
    ).toBe("snapshot");
    expect(() =>
      parseLinkedTestWorkspaceContextMode("host", "--workspace"),
    ).toThrow(/must be one of/);
    expect(
      parseLinkedTestJsonEntries(
        '{"command":"node --version","workspace_context_mode":" ISOLATED "}',
        "--add-json",
      )[0]?.workspace_context_mode,
    ).toBe("isolated");
    expect(() =>
      parseLinkedTestJsonEntries(
        '{"command":"node --version","workspace_context_mode":"host"}',
        "--add-json",
      ),
    ).toThrow(/must be one of/);

    const implicit = _testOnlyTestAll.buildLinkedTestKey({
      command: "node --version",
      scope: "project",
    });
    expect(implicit).toContain(":source:");
    expect(
      _testOnlyTestAll.buildLinkedTestKey({
        command: "node --version",
        scope: "project",
        workspace_context_mode: "   " as LinkedTest["workspace_context_mode"],
      }),
    ).toBe(implicit);
    expect(
      _testOnlyTestAll.buildLinkedTestKey({
        command: "node --version",
        scope: "project",
        workspace_context_mode: "snapshot",
      }),
    ).toContain(":snapshot:");
  });
});
