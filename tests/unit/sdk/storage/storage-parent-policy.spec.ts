import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { acquireLock, writeFileAtomic } from "../../../../src/sdk/index.js";
import { withTempDir } from "../../../helpers/temp.js";

it("lets background SDK consumers update existing storage without reviving removed parents", async () => {
  await withTempDir("pm-sdk-storage-policy-", async (parent) => {
    const root = path.join(parent, "installation");
    await mkdir(path.join(root, "locks"), { recursive: true });
    const file = path.join(root, "settings.json");
    const policy = { createParentDirectories: false };
    const release = await acquireLock(root, "worker", 60, "fixture", false, false, 1000, policy);
    await writeFileAtomic(file, "existing storage", policy);
    expect(await readFile(file, "utf8")).toBe("existing storage");
    await rm(root, { recursive: true });
    await release();
    await expect(writeFileAtomic(file, "removed storage", policy)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(acquireLock(root, "worker", 60, "fixture", false, false, 1000, policy)).rejects.toThrow("ENOENT");
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
