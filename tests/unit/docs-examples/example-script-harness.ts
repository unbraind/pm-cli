import { vi } from "vitest";

const ORIGINAL_ARGV = [...process.argv];
const REPO_ROOT_URL = new URL("../../../", import.meta.url);
let importSequence = 0;

/**
 * Imports a docs example module with a fresh module URL so each branch test can
 * set process argv and module mocks independently.
 */
export async function importExampleScript<T>(relativePath: string, queryPrefix: string): Promise<T> {
  importSequence += 1;
  const cacheBustToken = `${queryPrefix}-${importSequence}`;
  const moduleUrl = new URL(relativePath, REPO_ROOT_URL);
  moduleUrl.searchParams.set(queryPrefix, cacheBustToken);
  return (await import(moduleUrl.href)) as T;
}

/**
 * Restores the process and mocked module state shared by docs example scripts.
 */
export function resetExampleScriptHarness(): void {
  process.argv = [...ORIGINAL_ARGV];
  vi.doUnmock("@unbrained/pm-cli/sdk");
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
  vi.resetModules();
}
