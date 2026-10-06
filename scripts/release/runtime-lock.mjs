/** Project the tested pnpm runtime graph into a publication dependency ledger. Tracker: pm-gh1417. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

/** Resolve production roots only when the tested importer still matches the manifest. */
function readRuntimeRoots(manifest, lock) {
  const importer = lock.importers?.["."];
  const roots = new Map();
  for (const [name, specifier] of Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })) {
    const entry = Object.hasOwn(manifest.optionalDependencies ?? {}, name)
      ? importer?.optionalDependencies?.[name]
      : importer?.dependencies?.[name];
    if (!entry || entry.specifier !== specifier)
      throw new Error(`Runtime importer drift: ${name}`);
    roots.set(name, `${name}@${entry.version}`);
  }
  return roots;
}

/** Decode one exact pnpm snapshot without consulting registry metadata or discarding its peer context. */
function readRuntimePackage(name, key, lock) {
  const snapshot = lock.snapshots?.[key];
  const base = key.split("(")[0];
  const metadata = lock.packages?.[base];
  const version = base.slice(base.lastIndexOf("@") + 1);
  if (
    !snapshot ||
    !metadata?.resolution?.integrity ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)
  ) {
    throw new Error(`Runtime package is not integrity-locked: ${key}`);
  }
  const resolved =
    metadata.resolution.tarball ??
    `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
  const url = new URL(resolved);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(`Unsafe runtime tarball URL: ${name}`);
  const entry = { version, resolved, integrity: metadata.resolution.integrity };
  for (const field of [
    "peerDependencies",
    "peerDependenciesMeta",
    "engines",
    "os",
    "cpu",
    "hasBin",
  ]) {
    if (metadata[field] !== undefined) entry[field] = metadata[field];
  }
  for (const field of ["dependencies", "optionalDependencies"]) {
    if (snapshot[field] !== undefined) {
      entry[field] = Object.fromEntries(
        Object.entries(snapshot[field]).map(([child, value]) => [
          child,
          value.split("(")[0],
        ]),
      );
    }
  }
  return {
    ...entry,
    children: new Map(
      Object.entries({
        ...snapshot.dependencies,
        ...snapshot.optionalDependencies,
      }).map(([child, value]) => [child, `${child}@${value}`]),
    ),
  };
}

/** Traverse the production closure once and choose deterministic root hoists for each name. */
function buildRuntimeGraph(roots, lock) {
  const graph = new Map();
  const hoisted = new Map(roots);
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    const [name, key] = queue[index];
    if (graph.has(key)) continue;
    const entry = readRuntimePackage(name, key, lock);
    graph.set(key, entry);
    for (const child of entry.children) {
      queue.push(child);
      if (!hoisted.has(child[0])) hoisted.set(...child);
    }
  }
  return { graph, hoisted };
}

/** Mark packages reachable through mandatory edges so shared optional paths cannot weaken required installs. */
function collectRequiredRuntimeKeys(manifest, roots, lock) {
  const required = new Set();
  const queue = [...roots]
    .filter(
      ([name]) => !Object.hasOwn(manifest.optionalDependencies ?? {}, name),
    )
    .map(([, key]) => key);
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index];
    if (required.has(key)) continue;
    required.add(key);
    for (const [name, version] of Object.entries(
      lock.snapshots[key].dependencies ?? {},
    )) {
      queue.push(`${name}@${version}`);
    }
  }
  return required;
}

/** Mount only conflicts with the nearest visible package; ancestor identity terminates dependency cycles. */
function mountRuntimePackage(name, key, parent, ancestors, context) {
  const location = `${parent}${parent ? "/" : ""}node_modules/${name}`;
  const { children, ...entry } = context.graph.get(key);
  context.packages[location] = {
    ...entry,
    ...(!context.required.has(key) ? { optional: true } : {}),
  };
  const visible = new Map(ancestors);
  visible.set(name, key);
  for (const [child, childKey] of children) {
    if (visible.get(child) !== childKey)
      mountRuntimePackage(child, childKey, location, visible, context);
  }
}

/** Preserve exact versions, integrity, peer contexts, conflicts and cycles without registry resolution. */
export function buildRuntimeLock(manifest, lock) {
  if (lock.lockfileVersion !== "9.0")
    throw new Error("Runtime lock requires pnpm lockfile version 9.0");
  const roots = readRuntimeRoots(manifest, lock);
  const { graph, hoisted } = buildRuntimeGraph(roots, lock);
  const required = collectRequiredRuntimeKeys(manifest, roots, lock);
  const rootEntry = { name: manifest.name, version: manifest.version };
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bin",
    "engines",
  ]) {
    if (manifest[field] !== undefined) rootEntry[field] = manifest[field];
  }
  const packages = { "": rootEntry };
  const context = { graph, required, packages };
  for (const [name, key] of hoisted)
    mountRuntimePackage(name, key, "", hoisted, context);
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: Object.fromEntries(
      Object.entries(packages).sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      ),
    ),
  };
}

/** Check or regenerate the complete runtime projection; drift never silently changes the tested tree. */
export function synchronizeRuntimeLock(root, mode) {
  if (!["check", "apply"].includes(mode))
    throw new Error("Usage: runtime-lock.mjs check|apply");
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const lock = parse(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  const projection = buildRuntimeLock(manifest, lock);
  const expected = `${JSON.stringify(projection, null, 2)}\n`;
  const target = path.join(root, "runtime-dependencies.json");
  if (mode === "apply") writeFileSync(target, expected);
  else if (readFileSync(target, "utf8") !== expected)
    throw new Error(
      "Runtime lock drift: run node scripts/release/runtime-lock.mjs apply after pnpm install",
    );
  return {
    ok: true,
    mode,
    version: manifest.version,
    packages: Object.keys(projection.packages).length - 1,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(
    JSON.stringify(
      synchronizeRuntimeLock(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
        process.argv[2] ?? "check",
      ),
    ),
  );
}
