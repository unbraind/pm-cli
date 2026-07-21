import { cleanupTempRoot } from "./smoke-cleanup.mjs";

export function removeTempDirectory(path) {
  cleanupTempRoot(path);
}
