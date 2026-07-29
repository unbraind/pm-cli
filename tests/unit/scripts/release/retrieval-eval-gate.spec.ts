import path from "node:path";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateRetrievalGate,
  main,
  runRetrievalEvalEntrypoint,
  runRetrievalEval,
} from "../../../../scripts/release/retrieval-eval-gate.mjs";
import { withTempDir } from "../../../helpers/temp.js";

const baseline = {
  version: 1,
  minimum_query_count: 2,
  minimum: { ndcg: 0.6, mrr: 0.5, precision: 0.1, recall: 0.7 },
};

const report = {
  query_count: 2,
  aggregate: { ndcg: 0.7, mrr: 0.6, precision: 0.2, recall: 0.8 },
  queries: [{ recall: 1 }, { recall: 0.5 }],
};

function completedChild(
  stdout: string,
  stderr: string,
  code: number | null,
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", 1));
    return true;
  });
  queueMicrotask(() => {
    child.stdout.write(stdout);
    child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}

describe("retrieval evaluation release gate", () => {
  it("accepts a non-saturated report and rejects every missing/regressed contract", () => {
    expect(evaluateRetrievalGate(report, baseline)).toEqual([]);
    expect(
      evaluateRetrievalGate(
        {
          query_count: 1,
          aggregate: { ndcg: 0.5, mrr: null, precision: 0.05 },
          queries: [{ recall: 1 }],
        },
        { ...baseline, version: 2 },
      ),
    ).toEqual([
      "baseline_version:2",
      "query_count:1<2",
      "ndcg:0.5<0.6",
      "mrr:missing",
      "precision:0.05<0.1",
      "recall:missing",
      "judgment_set:saturated_recall",
    ]);
    expect(
      evaluateRetrievalGate(
        { aggregate: report.aggregate, queries: "bad" },
        baseline,
      ),
    ).toContain("query_count:missing");
  });

  it("runs the built CLI gate and its impossible-threshold negative control", async () => {
    const spawn = vi.fn(() => completedChild("{}", "", 0));
    await expect(
      runRetrievalEval(["--fail-under", "0.6"], {
        spawn,
        pmPath: "/tmp/isolated-pm",
      }),
    ).resolves.toMatchObject({ code: 0 });
    expect(spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["--pm-path", "/tmp/isolated-pm"]),
    );
    await expect(
      main(["--negative-control"], {
        run: async () => ({ code: 1, stdout: "", stderr: "rejected" }),
      }),
    ).resolves.toEqual({
      ok: true,
      negative_control: "seeded_ranking_regression",
    });
    await expect(
      runRetrievalEval([], {
        spawn: () => completedChild("{}", "", null),
      }),
    ).resolves.toMatchObject({ code: 1, stdout: "{}" });
  });

  it("bounds subprocess duration and combined output", async () => {
    await expect(
      runRetrievalEval([], {
        executablePath: "/definitely/missing/node",
      }),
    ).rejects.toThrow(/ENOENT/);

    const duplicateSettlement = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    duplicateSettlement.stdout = new PassThrough();
    duplicateSettlement.stderr = new PassThrough();
    duplicateSettlement.kill = vi.fn(() => true);
    queueMicrotask(() => {
      duplicateSettlement.emit("error", new Error("spawn failed"));
      duplicateSettlement.emit("close", 1);
    });
    await expect(
      runRetrievalEval([], {
        spawn: () => duplicateSettlement,
      }),
    ).rejects.toThrow("spawn failed");

    const hanging = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    hanging.stdout = new PassThrough();
    hanging.stderr = new PassThrough();
    hanging.kill = vi.fn(() => true);
    await expect(
      runRetrievalEval([], {
        spawn: () => hanging,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("timed out after 5ms");
    expect(hanging.kill).toHaveBeenCalledWith("SIGKILL");

    const oversized = completedChild("12345", "67890", 0);
    await expect(
      runRetrievalEval([], {
        spawn: () => oversized,
        maxOutputBytes: 8,
      }),
    ).rejects.toThrow("output exceeded 8 bytes");
    expect(oversized.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(
      runRetrievalEval([], {
        spawn: () => completedChild("123456789", "", 0),
        maxOutputBytes: 8,
      }),
    ).rejects.toThrow("output exceeded 8 bytes");
  });

  it("supports baseline updates and fails closed on runner errors", async () => {
    await withTempDir("pm-retrieval-gate-", async (tempRoot) => {
      const baselinePath = path.join(tempRoot, "baseline.json");
      await expect(
        main(
          [
            "--update",
            "--baseline",
            baselinePath,
          ],
          {
            run: async () => ({
              code: 0,
              stdout: JSON.stringify(report),
              stderr: "",
            }),
          },
        ),
      ).resolves.toMatchObject({
        ok: true,
        updated: true,
        baseline: { minimum_query_count: 2 },
      });
      const stronger = {
        ...baseline,
        minimum_query_count: 4,
        minimum: {
          ndcg: 0.9,
          mrr: 0.8,
          precision: 0.3,
          recall: 0.95,
        },
      };
      await writeFile(baselinePath, JSON.stringify(stronger));
      await main(["--update", "--baseline", baselinePath], {
        run: async () => ({
          code: 0,
          stdout: JSON.stringify(report),
          stderr: "",
        }),
      });
      expect(JSON.parse(await readFile(baselinePath, "utf8"))).toMatchObject(
        stronger,
      );
    });
    await expect(
      main([], {
        run: async () => ({ code: 2, stdout: "", stderr: "failed" }),
      }),
    ).rejects.toThrow("Retrieval eval command failed (2): failed");
    await withTempDir("pm-retrieval-missing-baseline-", async (tempRoot) => {
      await expect(
        main(["--baseline", path.join(tempRoot, "missing.json")], {
          run: async () => ({ code: 0, stdout: "{}", stderr: "" }),
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
    await expect(
      main(["--negative-control"], {
        run: async () => ({ code: 0, stdout: "{}", stderr: "" }),
      }),
    ).rejects.toThrow("negative control failed");
    await expect(
      main([], {
        run: async () => ({
          code: 0,
          stdout: JSON.stringify({
            query_count: 0,
            aggregate: { ndcg: 0, mrr: 0, precision: 0, recall: 0 },
            queries: [],
          }),
          stderr: "",
        }),
      }),
    ).rejects.toThrow("Retrieval evaluation gate failed");
    await expect(
      main([], {
        run: async () => ({
          code: 0,
          stdout: JSON.stringify({
            query_count: 5,
            aggregate: {
              ndcg: 0.7,
              mrr: 0.7,
              precision: 0.2,
              recall: 0.9,
            },
            queries: [{ recall: 1 }, { recall: 0.5 }],
          }),
          stderr: "",
        }),
      }),
    ).resolves.toMatchObject({ ok: true, updated: false });
    await withTempDir("pm-retrieval-invalid-update-", async (tempRoot) => {
      await expect(
        main(
          [
            "--update",
            "--baseline",
            path.join(tempRoot, "baseline.json"),
          ],
          {
            run: async () => ({
              code: 0,
              stdout: JSON.stringify({
                ...report,
                aggregate: { ...report.aggregate, ndcg: null },
              }),
              stderr: "",
            }),
          },
        ),
      ).rejects.toThrow("Retrieval gate ndcg must be finite");
    });
  });

  it("runs success, failure, default output, and import entrypoint paths", async () => {
    const scriptPath = path.resolve(
      process.cwd(),
      "scripts/release/retrieval-eval-gate.mjs",
    );
    const write = vi.fn();
    await expect(
      runRetrievalEvalEntrypoint({
        argv: [process.execPath, scriptPath],
        run: async () => ({ ok: true }),
        write,
      }),
    ).resolves.toBe(true);
    expect(String(write.mock.calls[0]?.[0])).toContain('"ok": true');
    await expect(
      runRetrievalEvalEntrypoint({
        argv: [process.execPath, scriptPath, "--negative-control"],
        mainOptions: {
          runOptions: {
            spawn: () => completedChild("", "rejected", 1),
            pmPath: "/tmp/isolated-pm",
          },
        },
        write,
      }),
    ).resolves.toBe(true);
    await expect(
      runRetrievalEvalEntrypoint({ argv: [process.execPath] }),
    ).resolves.toBe(false);
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await runRetrievalEvalEntrypoint({
      argv: [process.execPath, scriptPath],
      run: async () => ({ ok: true }),
    });
    expect(stdout).toHaveBeenCalled();
    stdout.mockRestore();
    const onError = vi.fn();
    await expect(
      runRetrievalEvalEntrypoint({
        argv: [process.execPath, scriptPath],
        run: async () => {
          throw new Error("eval failed");
        },
        onError,
      }),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalled();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("EXIT:1");
      }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runRetrievalEvalEntrypoint({
        argv: [process.execPath, scriptPath],
        run: async () => {
          throw new Error("default eval failure");
        },
      }),
    ).rejects.toThrow("EXIT:1");
    expect(error).toHaveBeenCalledWith("Error: default eval failure");
    exit.mockRestore();
    error.mockRestore();
  });
});
