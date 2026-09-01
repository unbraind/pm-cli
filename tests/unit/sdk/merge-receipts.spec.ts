import { execFileSync } from "node:child_process";
import type { Stats } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readBoundedRegularFile,
  resolveReceiptNoFollowFlag,
  type ReceiptFileBoundary,
} from "../../../src/sdk/merge/receipt-file-boundary.js";
import {
  _testOnlyMergeReceipts,
  inspectMergeReceiptEvidence,
  listMergeReceipts,
  markMergeReceiptReconciled,
  runMergeReceiptEvidenceReport,
  runMergeReceiptReport,
  summarizeMergeReceipt,
  writeMergeReceipt,
} from "../../../src/sdk/merge/receipts.js";

const workspaces: string[] = [];

function boundaryStats(params: {
  size: number;
  file?: boolean;
  symbolicLink?: boolean;
}): Stats {
  return {
    size: params.size,
    isFile: () => params.file !== false,
    isSymbolicLink: () => params.symbolicLink === true,
  } as Stats;
}

function fakeReceiptBoundary(params: {
  pathStats: Stats;
  openedStats?: Stats[];
  bytes?: string;
  zeroRead?: boolean;
}): { boundary: ReceiptFileBoundary; close: ReturnType<typeof vi.fn> } {
  const openedStats = [...(params.openedStats ?? [params.pathStats])];
  const close = vi.fn(async () => undefined);
  const handle = {
    stat: vi.fn(async () => openedStats.shift() ?? params.pathStats),
    read: vi.fn(async (buffer: Buffer, offset: number) => {
      if (params.zeroRead === true) return { bytesRead: 0, buffer };
      const bytes = Buffer.from(params.bytes ?? "");
      bytes.copy(buffer, offset);
      return { bytesRead: bytes.length, buffer };
    }),
    close,
  } as unknown as FileHandle;
  return {
    boundary: {
      lstat: vi.fn(async () => params.pathStats),
      open: vi.fn(async () => handle),
    },
    close,
  };
}

describe("clone-local merge decision receipts", () => {
  afterEach(async () => {
    await Promise.all(
      workspaces
        .splice(0)
        .map((workspace) => rm(workspace, { recursive: true, force: true })),
    );
  });

  it("preserves recoverable values locally and exposes privacy-safe summaries", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-receipts-"));
    workspaces.push(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });

    const receipt = await writeMergeReceipt({
      cwd: workspace,
      itemPath: ".agents/pm/tasks/pm-merge.toon",
      preferred: "ours",
      fieldsFromTheirs: ["priority"],
      unionFields: ["comments"],
      decisions: [
        {
          field: "title",
          base: "base",
          ours: "retained",
          theirs: "discarded",
          retained: "retained",
          discarded: "discarded",
        },
      ],
    });
    const laterReceipt = await writeMergeReceipt({
      cwd: workspace,
      itemPath: ".agents/pm/tasks/pm-later.toon",
      preferred: "theirs",
      fieldsFromTheirs: [],
      unionFields: ["tags"],
      decisions: [],
    });
    const shellQuotedReceipt = await writeMergeReceipt({
      cwd: workspace,
      itemPath: "'.agents/pm/tasks/pm-shell-quoted.toon'",
      preferred: "ours",
      fieldsFromTheirs: [],
      unionFields: [],
      decisions: [],
    });
    const doubleQuotedReceipt = await writeMergeReceipt({
      cwd: workspace,
      itemPath: '".agents/pm/tasks/pm-double-quoted.toon"',
      preferred: "ours",
      fieldsFromTheirs: [],
      unionFields: [],
      decisions: [],
    });
    const receiptDirectory = execFileSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "pm-merge-receipts",
      ],
      { cwd: workspace, encoding: "utf8" },
    ).trim();
    await writeFile(path.join(receiptDirectory, "README"), "local only\n");

    expect(receipt).not.toBeNull();
    expect(receipt).toMatchObject({ requested_preference: "ours" });
    expect(receipt).not.toHaveProperty("preferred");
    expect(laterReceipt).not.toBeNull();
    expect(shellQuotedReceipt).toMatchObject({
      item_path: ".agents/pm/tasks/pm-shell-quoted.toon",
      item_id: "pm-shell-quoted",
    });
    expect(doubleQuotedReceipt).toMatchObject({
      item_path: ".agents/pm/tasks/pm-double-quoted.toon",
      item_id: "pm-double-quoted",
    });
    expect(await listMergeReceipts(workspace)).toHaveLength(4);
    expect((await listMergeReceipts(workspace))[0]).toMatchObject({
      item_id: "pm-merge",
      state: "pending",
      decisions: [{ discarded: "discarded" }],
    });
    const summary = summarizeMergeReceipt(receipt!);
    expect(summary).toMatchObject({
      item_id: "pm-merge",
      requested_preference: "ours",
      conflict_fields: ["title"],
      decisions: [
        {
          field: "title",
          retained_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          discarded_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('"discarded"');
    expect(
      summarizeMergeReceipt({
        ...receipt!,
        requested_preference: undefined,
        preferred: "theirs",
      }).requested_preference,
    ).toBe("theirs");
    expect(
      summarizeMergeReceipt({
        ...receipt!,
        requested_preference: undefined,
        preferred: undefined,
      }).requested_preference,
    ).toBe("ours");
    expect(
      summarizeMergeReceipt({
        ...receipt!,
        decisions: [
          {
            field: "title",
            base: null,
            ours: null,
            theirs: null,
            retained: { pm_value_hash: "not-a-hash" },
            discarded: null,
          },
        ],
      }).decisions[0]?.retained_hash,
    ).toMatch(/^[a-f0-9]{64}$/);

    await markMergeReceiptReconciled(workspace, receipt!);
    await markMergeReceiptReconciled(workspace, laterReceipt!);
    await markMergeReceiptReconciled(workspace, shellQuotedReceipt!);
    await markMergeReceiptReconciled(workspace, doubleQuotedReceipt!);
    expect(await listMergeReceipts(workspace)).toEqual([]);
    expect(
      await runMergeReceiptReport({
        cwd: workspace,
        includeReconciled: true,
      }),
    ).toMatchObject({
      ok: true,
      count: 4,
      receipts: [
        { state: "reconciled" },
        { state: "reconciled" },
        { state: "reconciled" },
        { state: "reconciled" },
      ],
    });
  });

  it("is a safe no-op outside Git and ignores damaged receipt files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-receipts-"));
    workspaces.push(workspace);
    expect(
      await writeMergeReceipt({
        cwd: workspace,
        itemPath: "tasks/pm-none.toon",
        preferred: "ours",
        fieldsFromTheirs: [],
        unionFields: [],
        decisions: [],
      }),
    ).toBeNull();
    expect(await listMergeReceipts(workspace)).toEqual([]);
    expect(await inspectMergeReceiptEvidence(workspace)).toEqual({
      receipts: [],
      invalid_evidence_count: 0,
      invalid_evidence: [],
      invalid_evidence_truncated: false,
      clone_local_evidence_resolved: false,
    });
    expect(
      await runMergeReceiptEvidenceReport({ cwd: workspace }),
    ).toMatchObject({
      ok: false,
      complete: false,
      invalid_evidence_count: 0,
      clone_local_evidence_resolved: false,
    });
    await markMergeReceiptReconciled(workspace, {
      version: 1,
      id: "missing",
      item_path: "tasks/pm-none.toon",
      item_id: "pm-none",
      preferred: "ours",
      conflict_resolution: "preferred_side",
      fields_from_theirs: [],
      union_fields: [],
      decisions: [],
      state: "pending",
      created_at: "2026-07-27T00:00:00.000Z",
    });

    execFileSync("git", ["init", "-q"], { cwd: workspace });
    await expect(
      markMergeReceiptReconciled(workspace, {
        version: 1,
        id: "x".repeat(5_000),
        item_path: "tasks/pm-path-error.toon",
        item_id: "pm-path-error",
        conflict_resolution: "preferred_side",
        fields_from_theirs: [],
        union_fields: [],
        decisions: [],
        state: "pending",
        created_at: "2026-07-27T00:00:00.000Z",
      }),
    ).rejects.toThrow(
      "Merge receipt trusted settlement input failed schema validation.",
    );
    const receiptDirectory = execFileSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "pm-merge-receipts",
      ],
      { cwd: workspace, encoding: "utf8" },
    ).trim();
    await mkdir(receiptDirectory, { recursive: true });
    await writeFile(
      path.join(receiptDirectory, "legacy.json"),
      JSON.stringify({
        version: 1,
        id: "legacy",
        item_path: ".agents/pm/tasks/pm-legacy.toon",
        item_id: "pm-legacy",
        preferred: "ours",
        fields_from_theirs: [],
        union_fields: [],
        decisions: [],
        state: "pending",
        created_at: "2026-07-27T00:00:00.000Z",
      }),
      "utf8",
    );
    await writeFile(
      path.join(receiptDirectory, "pre-preference.json"),
      JSON.stringify({
        version: 1,
        id: "pre-preference",
        item_path: ".agents/pm/tasks/pm-pre-preference.toon",
        item_id: "pm-pre-preference",
        fields_from_theirs: [],
        union_fields: [],
        decisions: [],
        state: "pending",
        created_at: "2026-07-26T00:00:00.000Z",
      }),
      "utf8",
    );
    expect(await listMergeReceipts(workspace)).toMatchObject([
      {
        id: "pre-preference",
        requested_preference: "ours",
        conflict_resolution: "preferred_side",
      },
      {
        id: "legacy",
        requested_preference: "ours",
        conflict_resolution: "preferred_side",
      },
    ]);
    expect((await listMergeReceipts(workspace))[0]).not.toHaveProperty(
      "preferred",
    );
    await markMergeReceiptReconciled(workspace, {
      version: 1,
      id: "legacy",
      item_path: ".agents/pm/tasks/pm-legacy.toon",
      item_id: "pm-legacy",
      preferred: "ours",
      conflict_resolution: undefined as never,
      fields_from_theirs: [],
      union_fields: [],
      decisions: [],
      state: "pending",
      created_at: "2026-07-27T00:00:00.000Z",
    });
    await markMergeReceiptReconciled(workspace, {
      version: 1,
      id: "pre-preference",
      item_path: ".agents/pm/tasks/pm-pre-preference.toon",
      item_id: "pm-pre-preference",
      conflict_resolution: undefined as never,
      fields_from_theirs: [],
      union_fields: [],
      decisions: [],
      state: "pending",
      created_at: "2026-07-26T00:00:00.000Z",
    });
    await rm(receiptDirectory, { recursive: true });
    await writeFile(
      path.join(workspace, ".git", "pm-merge-receipts"),
      "not a directory",
      "utf8",
    );
    expect(receiptDirectory).toContain("pm-merge-receipts");
    expect(await listMergeReceipts(workspace)).toEqual([]);
    expect(await runMergeReceiptReport({})).toMatchObject({
      ok: true,
      count: expect.any(Number),
    });
    expect(await runMergeReceiptEvidenceReport({})).toMatchObject({
      ok: true,
      complete: true,
      invalid_evidence_count: 0,
    });
  });

  it("distinguishes absent receipts from rejected incomplete evidence", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-receipts-"));
    workspaces.push(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    const receiptDirectory = execFileSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "pm-merge-receipts",
      ],
      { cwd: workspace, encoding: "utf8" },
    ).trim();
    await mkdir(receiptDirectory, { recursive: true });
    for (const name of ["aaaa-corrupt.json", "bbbb-corrupt.json"]) {
      await writeFile(
        path.join(receiptDirectory, name),
        `${JSON.stringify({ version: 1, state: "pending" })}\n`,
        "utf8",
      );
    }

    expect(await listMergeReceipts(workspace)).toEqual([]);
    expect(await inspectMergeReceiptEvidence(workspace)).toEqual({
      receipts: [],
      invalid_evidence_count: 2,
      invalid_evidence: [
        {
          evidence_source: "clone_local",
          reason: "schema_or_identity_invalid",
          receipt_id: "aaaa-corrupt",
        },
        {
          evidence_source: "clone_local",
          reason: "schema_or_identity_invalid",
          receipt_id: "bbbb-corrupt",
        },
      ],
      invalid_evidence_truncated: false,
      clone_local_evidence_resolved: true,
    });
    expect(
      await runMergeReceiptEvidenceReport({ cwd: workspace }),
    ).toMatchObject({
      ok: false,
      complete: false,
      count: 0,
      invalid_evidence_count: 2,
      invalid_evidence: [
        {
          evidence_source: "clone_local",
          reason: "schema_or_identity_invalid",
          receipt_id: "aaaa-corrupt",
        },
        {
          evidence_source: "clone_local",
          reason: "schema_or_identity_invalid",
          receipt_id: "bbbb-corrupt",
        },
      ],
      invalid_evidence_truncated: false,
      clone_local_evidence_resolved: true,
      receipts: [],
    });
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "classifies an unreadable receipt candidate without exposing its contents",
    async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-receipts-"));
      workspaces.push(workspace);
      execFileSync("git", ["init", "-q"], { cwd: workspace });
      const receiptDirectory = execFileSync(
        "git",
        [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "pm-merge-receipts",
        ],
        { cwd: workspace, encoding: "utf8" },
      ).trim();
      await mkdir(receiptDirectory, { recursive: true });
      const receiptPath = path.join(receiptDirectory, "unreadable.json");
      await writeFile(receiptPath, "private malformed evidence\n", "utf8");
      await chmod(receiptPath, 0o000);

      await expect(
        inspectMergeReceiptEvidence(workspace),
      ).resolves.toMatchObject({
        invalid_evidence_count: 1,
        invalid_evidence: [
          {
            evidence_source: "clone_local",
            reason: "candidate_unreadable",
            receipt_id: "unreadable",
          },
        ],
      });
    },
  );

  it("fails closed when a receipt directory path cannot be traversed", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-receipts-"));
    workspaces.push(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    const blockedTrackerRoot = path.join(workspace, "blocked-tracker-root");
    await writeFile(blockedTrackerRoot, "not a directory\n", "utf8");

    await expect(
      inspectMergeReceiptEvidence(workspace, {
        pmRoot: blockedTrackerRoot,
      }),
    ).resolves.toEqual({
      receipts: [],
      invalid_evidence_count: 1,
      invalid_evidence: [
        {
          evidence_source: "durable",
          reason: "directory_unreadable",
        },
      ],
      invalid_evidence_truncated: false,
      clone_local_evidence_resolved: true,
    });
  });

  it("classifies ancestor traversal failures without platform error guessing", async () => {
    const missingError = Object.assign(new Error("missing"), {
      code: "ENOENT",
    });
    const deniedError = Object.assign(new Error("denied"), { code: "EACCES" });

    await expect(
      _testOnlyMergeReceipts.receiptDirectoryFailureMeansAbsent(
        "/missing/receipt-store",
        missingError,
        () => Promise.reject(deniedError),
      ),
    ).resolves.toBe(false);
    await expect(
      _testOnlyMergeReceipts.receiptDirectoryFailureMeansAbsent(
        "/missing",
        missingError,
        () => Promise.reject(missingError),
      ),
    ).resolves.toBe(true);
    const inspectPresentFile = vi.fn(() =>
      Promise.resolve({ isDirectory: () => false }),
    );
    await expect(
      _testOnlyMergeReceipts.receiptDirectoryFailureMeansAbsent(
        "/present/receipt-store",
        missingError,
        inspectPresentFile,
      ),
    ).resolves.toBe(false);
    expect(inspectPresentFile).toHaveBeenCalledWith("/present/receipt-store");
  });

  it("bounds invalid candidate details while preserving the complete count", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-receipts-"));
    workspaces.push(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    const receiptDirectory = execFileSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "pm-merge-receipts",
      ],
      { cwd: workspace, encoding: "utf8" },
    ).trim();
    await mkdir(receiptDirectory, { recursive: true });
    await mkdir(path.join(receiptDirectory, "!unsafe candidate.json"));
    await Promise.all(
      Array.from({ length: 100 }, async (_, index) =>
        mkdir(
          path.join(
            receiptDirectory,
            `bounded-${String(index).padStart(3, "0")}.json`,
          ),
        ),
      ),
    );

    const evidence = await inspectMergeReceiptEvidence(workspace);
    expect(evidence).toMatchObject({
      invalid_evidence_count: 101,
      invalid_evidence_truncated: true,
      clone_local_evidence_resolved: true,
    });
    expect(evidence.invalid_evidence).toHaveLength(100);
    expect(evidence.invalid_evidence[0]).toEqual({
      evidence_source: "clone_local",
      reason: "candidate_not_bounded_regular_file",
      candidate_name_hash:
        "137b584a2d5d9672701a261ea012a48531bead7522c216b22d8ca44eff382277",
    });
  });

  it("carries privacy-safe decision evidence into a fresh clone", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "pm-receipts-source-"),
    );
    const clone = await mkdtemp(path.join(os.tmpdir(), "pm-receipts-clone-"));
    workspaces.push(workspace, clone);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "PM Test"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "pm-test@example.invalid"], {
      cwd: workspace,
    });
    const pmRoot = path.join(workspace, ".agents", "pm");
    await mkdir(path.join(pmRoot, "tasks"), { recursive: true });
    await writeFile(path.join(pmRoot, "settings.json"), "{}\n");
    const receipt = await writeMergeReceipt({
      cwd: workspace,
      itemPath: ".agents/pm/tasks/pm-durable.toon",
      preferred: "ours",
      fieldsFromTheirs: [],
      unionFields: [],
      decisions: [
        {
          field: "title",
          base: "base-private",
          ours: "ours-private",
          theirs: "theirs-private",
          retained: "ours-private",
          discarded: "theirs-private",
        },
      ],
    });
    execFileSync("git", ["add", ".agents/pm"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "Track durable merge evidence"], {
      cwd: workspace,
    });
    await rm(clone, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", workspace, clone]);

    const clonedReceipts = await listMergeReceipts(clone, {
      pmRoot: path.join(clone, ".agents", "pm"),
    });
    expect(clonedReceipts).toHaveLength(1);
    expect(clonedReceipts[0]).toMatchObject({
      id: receipt?.id,
      state: "pending",
      value_availability: "hash_only",
    });
    const serialized = JSON.stringify(clonedReceipts[0]);
    expect(serialized).not.toContain("private");
    expect(summarizeMergeReceipt(clonedReceipts[0]!)).toEqual(
      summarizeMergeReceipt(receipt!),
    );
    await markMergeReceiptReconciled(clone, clonedReceipts[0]!);
    expect(
      await listMergeReceipts(clone, {
        pmRoot: path.join(clone, ".agents", "pm"),
      }),
    ).toEqual([]);
    expect(
      await listMergeReceipts(clone, {
        includeReconciled: true,
        pmRoot: path.join(clone, ".agents", "pm"),
      }),
    ).toMatchObject([{ state: "reconciled", value_availability: "hash_only" }]);
    await markMergeReceiptReconciled(clone, {
      ...clonedReceipts[0]!,
      id: "durable-sidecar-missing",
    });
  });

  it("counts divergent same-id local and durable copies as invalid evidence", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "pm-receipts-divergent-"),
    );
    workspaces.push(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    const pmRoot = path.join(workspace, ".agents", "pm");
    await mkdir(path.join(pmRoot, "tasks"), { recursive: true });
    await writeFile(path.join(pmRoot, "settings.json"), "{}\n", "utf8");
    const receipt = await writeMergeReceipt({
      cwd: workspace,
      itemPath: ".agents/pm/tasks/pm-divergent.toon",
      preferred: "ours",
      fieldsFromTheirs: [],
      unionFields: [],
      decisions: [],
    });
    expect(receipt).not.toBeNull();
    const durablePath = path.join(
      pmRoot,
      "merge-receipts",
      `${receipt?.id}.json`,
    );
    const durable = JSON.parse(await readFile(durablePath, "utf8")) as Record<
      string,
      unknown
    >;
    durable.item_id = "pm-divergent-forged";
    durable.item_path = ".agents/pm/tasks/pm-divergent-forged.toon";
    durable.state = "reconciled";
    durable.reconciled_at = "2026-08-24T00:00:00.000Z";
    await writeFile(durablePath, `${JSON.stringify(durable)}\n`, "utf8");

    await expect(
      inspectMergeReceiptEvidence(workspace, { pmRoot }),
    ).resolves.toEqual({
      receipts: [],
      invalid_evidence_count: 1,
      invalid_evidence: [
        {
          evidence_source: "clone_local_and_durable",
          reason: "copy_provenance_mismatch",
          receipt_id: receipt?.id,
        },
      ],
      invalid_evidence_truncated: false,
      clone_local_evidence_resolved: true,
    });
    const receiptDirectory = execFileSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "pm-merge-receipts",
      ],
      { cwd: workspace, encoding: "utf8" },
    ).trim();
    await Promise.all(
      Array.from({ length: 100 }, async (_, index) =>
        mkdir(
          path.join(
            receiptDirectory,
            `000-invalid-${String(index).padStart(3, "0")}.json`,
          ),
        ),
      ),
    );
    const boundedEvidence = await inspectMergeReceiptEvidence(workspace, {
      pmRoot,
    });
    expect(boundedEvidence.invalid_evidence_count).toBe(101);
    expect(boundedEvidence.invalid_evidence).toHaveLength(100);
    expect(boundedEvidence.invalid_evidence_truncated).toBe(true);
    expect(boundedEvidence.invalid_evidence).not.toContainEqual(
      expect.objectContaining({ reason: "copy_provenance_mismatch" }),
    );
  });

  it("enforces the bounded no-follow receipt file boundary", async () => {
    expect(resolveReceiptNoFollowFlag({ O_NOFOLLOW: 128 })).toBe(128);
    expect(resolveReceiptNoFollowFlag({})).toBe(0);

    const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-receipt-file-"));
    workspaces.push(workspace);
    const receiptPath = path.join(workspace, "receipt.json");
    await writeFile(receiptPath, "{}", "utf8");
    await expect(readBoundedRegularFile(receiptPath, 16)).resolves.toBe("{}");

    for (const pathStats of [
      boundaryStats({ size: 1, symbolicLink: true }),
      boundaryStats({ size: 1, file: false }),
      boundaryStats({ size: 17 }),
    ]) {
      await expect(
        readBoundedRegularFile(
          "candidate",
          16,
          fakeReceiptBoundary({ pathStats }).boundary,
        ),
      ).resolves.toBeNull();
    }

    for (const openedStats of [
      boundaryStats({ size: 1, file: false }),
      boundaryStats({ size: 17 }),
    ]) {
      const fake = fakeReceiptBoundary({
        pathStats: boundaryStats({ size: 1 }),
        openedStats: [openedStats],
      });
      await expect(
        readBoundedRegularFile("candidate", 16, fake.boundary),
      ).resolves.toBeNull();
      expect(fake.close).toHaveBeenCalledOnce();
    }

    const shortRead = fakeReceiptBoundary({
      pathStats: boundaryStats({ size: 2 }),
      openedStats: [boundaryStats({ size: 2 }), boundaryStats({ size: 2 })],
      zeroRead: true,
    });
    await expect(
      readBoundedRegularFile("candidate", 16, shortRead.boundary),
    ).resolves.toBeNull();

    const changed = fakeReceiptBoundary({
      pathStats: boundaryStats({ size: 2 }),
      openedStats: [boundaryStats({ size: 2 }), boundaryStats({ size: 3 })],
      bytes: "{}",
    });
    await expect(
      readBoundedRegularFile("candidate", 16, changed.boundary),
    ).resolves.toBeNull();

    const stable = fakeReceiptBoundary({
      pathStats: boundaryStats({ size: 2 }),
      openedStats: [boundaryStats({ size: 2 }), boundaryStats({ size: 2 })],
      bytes: "{}",
    });
    await expect(
      readBoundedRegularFile("candidate", 16, stable.boundary),
    ).resolves.toBe("{}");
    const boundaryFailure = new Error("receipt boundary failed");
    await expect(
      _testOnlyMergeReceipts.prepareReceiptSettlement({
        receiptPath: "candidate",
        receiptId: "receipt-boundary-error",
        evidenceSource: "clone_local",
        reconciledAt: "2026-08-25T00:00:00.000Z",
        readReceipt: async () => {
          throw boundaryFailure;
        },
      }),
    ).rejects.toBe(boundaryFailure);
    expect(shortRead.close).toHaveBeenCalledOnce();
    expect(changed.close).toHaveBeenCalledOnce();
    expect(stable.close).toHaveBeenCalledOnce();
  });
});
