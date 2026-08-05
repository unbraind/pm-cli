import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegisteredExtensionSchemaMigrationDefinition } from "../../../src/core/extensions/extension-types.js";
import {
  applyStoredExtensionMigrationState,
  readExtensionMigrationState,
  resolveExtensionMigrationStatePath,
  runExtensionMigrations,
} from "../../../src/sdk/extension/migrations.js";

const tempRoots: string[] = [];

async function createPmRoot(): Promise<string> {
  const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-extension-migrations-"));
  tempRoots.push(pmRoot);
  return pmRoot;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) =>
      rm(tempRoot, { recursive: true, force: true }),
    ),
  );
});

describe("extension migration SDK", () => {
  it("plans, applies, persists, retries, and overlays durable outcomes", async () => {
    const pmRoot = await createPmRoot();
    const successfulRun = vi.fn();
    const failingRun = vi.fn(() => {
      throw new Error("cannot migrate");
    });
    const migrations: RegisteredExtensionSchemaMigrationDefinition[] = [
      {
        layer: "project",
        name: "already",
        definition: { id: "done", status: "applied" },
        runtime_definition: { id: "done", status: "applied" },
      },
      {
        layer: "project",
        name: "success",
        definition: { id: "ok", status: "pending", reason: "queued" },
        runtime_definition: { id: "ok", status: "pending", run: successfulRun },
      },
      {
        layer: "project",
        name: "manual",
        definition: { id: "manual", status: "pending" },
        runtime_definition: { id: "manual", status: "pending" },
      },
      {
        layer: "global",
        name: "failure",
        definition: { id: "bad", status: "pending" },
        runtime_definition: { id: "bad", status: "pending", run: failingRun },
      },
    ];

    const preview = await runExtensionMigrations({
      pmRoot,
      migrations,
      author: "migration-test",
      dryRun: true,
    });
    expect(preview).toMatchObject({
      ok: true,
      dry_run: true,
      total: 4,
      pending_count: 3,
      skipped_count: 1,
    });
    expect(successfulRun).not.toHaveBeenCalled();
    await expect(readFile(resolveExtensionMigrationStatePath(pmRoot), "utf8")).rejects.toThrow();

    const applied = await runExtensionMigrations({
      pmRoot,
      migrations,
      author: "migration-test",
    });
    expect(applied).toMatchObject({
      ok: false,
      total: 4,
      pending_count: 1,
      applied_count: 1,
      skipped_count: 1,
      failed_count: 1,
    });
    expect(successfulRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ok", command: "migration" }),
    );
    expect(await readExtensionMigrationState(pmRoot)).toMatchObject({
      version: 1,
      entries: [
        { key: "global:failure:bad", status: "failed", error: "cannot migrate" },
        { key: "project:success:ok", status: "applied" },
      ],
    });

    migrations[3]!.runtime_definition.run = vi.fn();
    const retried = await runExtensionMigrations({
      pmRoot,
      migrations,
      author: "migration-test",
    });
    expect(retried).toMatchObject({
      ok: true,
      applied_count: 1,
      skipped_count: 2,
      pending_count: 1,
      failed_count: 0,
    });
    expect((await readExtensionMigrationState(pmRoot)).entries[0]).toMatchObject({
      key: "global:failure:bad",
      status: "applied",
    });

    const fresh = migrations.map((migration) => ({
      ...migration,
      definition: { ...migration.definition, status: "pending" as const },
    }));
    await applyStoredExtensionMigrationState(pmRoot, fresh);
    expect(fresh.map((migration) => migration.definition.status)).toEqual([
      "pending",
      "applied",
      "pending",
      "applied",
    ]);
  });

  it("keeps generated migration ids stable when applying one layer", async () => {
    const pmRoot = await createPmRoot();
    const projectRun = vi.fn();
    const migrations: RegisteredExtensionSchemaMigrationDefinition[] = [
      {
        layer: "global",
        name: "global-first",
        definition: { status: "pending" },
        runtime_definition: { status: "pending", run: vi.fn() },
      },
      {
        layer: "project",
        name: "project-second",
        definition: { status: "pending" },
        runtime_definition: { status: "pending", run: projectRun },
      },
    ];
    const result = await runExtensionMigrations({
      pmRoot,
      migrations,
      author: "migration-test",
      scope: "project",
    });
    expect(result.migrations).toEqual([
      expect.objectContaining({
        key: "project:project-second:migration-002",
        outcome: "applied",
      }),
    ]);
    expect(projectRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "migration-002" }),
    );
  });

  it("normalizes malformed state and records non-Error migration failures", async () => {
    const pmRoot = await createPmRoot();
    await writeFile(
      resolveExtensionMigrationStatePath(pmRoot),
      JSON.stringify({ updated_at: 42, entries: "invalid" }),
      "utf8",
    );
    await expect(readExtensionMigrationState(pmRoot)).resolves.toEqual({
      version: 1,
      updated_at: "",
      entries: [],
    });

    const migrations: RegisteredExtensionSchemaMigrationDefinition[] = [
      {
        layer: "project",
        name: "string-failure",
        definition: { id: "bad", status: "failed" },
        runtime_definition: {
          id: "bad",
          status: "failed",
          run: () => {
            throw "non-error failure";
          },
        },
      },
      {
        layer: "project",
        name: "implicit-pending",
        definition: { id: "pending" },
        runtime_definition: { id: "pending" },
      },
    ];
    const result = await runExtensionMigrations({
      pmRoot,
      migrations,
      author: "migration-test",
    });
    expect(result).toMatchObject({
      ok: false,
      failed_count: 1,
      pending_count: 1,
      migrations: [
        { before: "failed", outcome: "failed", error: "non-error failure" },
        { before: "pending", outcome: "pending" },
      ],
    });
  });
});
