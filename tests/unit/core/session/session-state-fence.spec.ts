import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../../../../src/core/fs/fs-utils.js";
import { _testOnly as lockTestOnly } from "../../../../src/core/lock/lock.js";
import {
  getFocusedItem,
  getSessionStatePath,
  setFocusedItem,
} from "../../../../src/core/session/session-state.js";
import { getLockPath } from "../../../../src/core/store/paths.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session-state write fence (GH-1706 review)", () => {
  it("refuses to save a stale snapshot once another writer reclaimed the lease", async () => {
    const pmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-session-fence-"));
    try {
      await setFocusedItem(pmRoot, "pm-newer");
      const sessionPath = getSessionStatePath(pmRoot);
      const realReadFile = fs.readFile.bind(fs);
      let tookOver = false;
      // While this writer holds its snapshot, a peer reclaims the expired lease and publishes its own generation.
      vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        const result = await realReadFile(...args);
        if (!tookOver && args[0] === sessionPath) {
          tookOver = true;
          const payload = await lockTestOnly.buildLockPayload("session-state", "session-state", 1800);
          await writeFileAtomic(getLockPath(pmRoot, "session-state"), `${JSON.stringify(payload)}\n`);
        }
        return result;
      });

      await expect(setFocusedItem(pmRoot, "pm-stale")).rejects.toMatchObject({ context: { code: "lock_lost" } });
      vi.restoreAllMocks();
      expect(tookOver).toBe(true);
      expect(await getFocusedItem(pmRoot)).toBe("pm-newer");
    } finally {
      await fs.rm(pmRoot, { recursive: true, force: true });
    }
  });
});
