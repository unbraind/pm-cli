import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Hold an exclusive checkout lease through a complete producer or consumer.
 * Never steal a lock by age: a slow compiler or test is still its owner.
 * Nested read-only runners may reuse the parent's opaque, live-owner receipt.
 */
export async function withBuildLease(root, operation, options = {}) {
  const directory = path.join(await realpath(root), ".cache", "build-lease");
  const ownerFile = path.join(directory, "owner.json");
  if (options.inherited) {
    const owner = JSON.parse(await readFile(ownerFile, "utf8"));
    if (owner.token !== options.inherited || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
      throw new Error("Invalid inherited build lease; run validation from an independent shell.");
    }
    process.kill(owner.pid, 0);
    return operation(owner.token);
  }
  await mkdir(path.dirname(directory), { recursive: true });
  const deadline = Date.now() + (options.timeoutMs ?? 1_200_000);
  for (;;) {
    try {
      await mkdir(directory);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for build lease. Check .cache/build-lease/owner.json; remove an abandoned lease only after confirming its producer and consumers have stopped.", { cause: error });
      }
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }
  const token = randomUUID();
  try {
    await writeFile(ownerFile, JSON.stringify({ token, pid: process.pid }), "utf8");
    return await operation(token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
