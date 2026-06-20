/**
 * Import a `src/**` module through a Vitest-transformable relative specifier.
 *
 * Absolute `file://` URLs for TypeScript sources are not transformed reliably on
 * Windows, so source-entry tests should use this helper when they need a fresh
 * import with top-level code re-executed.
 *
 * Only `"cli.js"` and `"cli/main.js"` are supported. Extend this closed
 * dispatch set when another source entrypoint needs Windows-safe imports.
 */
export async function importFreshSourceModule<T>(sourcePath: string, queryPrefix = "source"): Promise<T> {
  const normalizedPath = sourcePath.replace(/^\/+/, "");
  if (normalizedPath === "cli.js") {
    if (queryPrefix === "entryFastVersion") {
      return (await import("../../src/cli.js?entryFastVersion")) as T;
    }
    if (queryPrefix === "entryFallthrough") {
      return (await import("../../src/cli.js?entryFallthrough")) as T;
    }
    return (await import("../../src/cli.js?source")) as T;
  }
  if (normalizedPath === "cli/main.js") {
    if (queryPrefix === "sourceCli") {
      return (await import("../../src/cli/main.js")) as T;
    }
    if (queryPrefix === "packageRootBlank") {
      return (await import("../../src/cli/main.js?packageRootBlank")) as T;
    }
    if (queryPrefix === "packageRootPresent") {
      return (await import("../../src/cli/main.js?packageRootPresent")) as T;
    }
    return (await import("../../src/cli/main.js")) as T;
  }
  throw new Error(`Unsupported source module import: ${sourcePath}`);
}
