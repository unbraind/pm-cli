import { rmSync } from "node:fs";

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function removeTempDirectory(path) {
  const attempts = 8;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(code) || attempt === attempts) {
        throw error;
      }
      sleepSync(50 * attempt);
    }
  }
}
