/** Stage the tested runtime closure without copying pnpm's development store. Tracker: pm-gh1417. */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Decode npm 11 and npm 12's single-package receipts. */
function readArtifact(output) {
  const report = JSON.parse(output);
  const artifacts = Array.isArray(report) ? report : Object.values(report);
  if (artifacts.length !== 1 || !Array.isArray(artifacts[0]?.files))
    throw new Error("Distribution packing requires exactly one npm artifact");
  return artifacts[0];
}

/** Resolve a physical package through Node's ancestor lookup, including pnpm symlinks. */
function resolveRuntimePackage(parent, name) {
  let directory = parent;
  while (true) {
    const candidate = path.join(
      directory,
      "node_modules",
      name,
      "package.json",
    );
    if (existsSync(candidate)) return realpathSync(path.dirname(candidate));
    const ancestor = path.dirname(directory);
    if (ancestor === directory)
      throw new Error(`Missing tested runtime package: ${name}`);
    directory = ancestor;
  }
}

/** Find the ledger location visible to one package without flattening version conflicts. */
function resolveRuntimeLocation(parent, name, packages) {
  let directory = parent;
  while (true) {
    const candidate = `${directory}${directory ? "/" : ""}node_modules/${name}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (!directory) throw new Error(`Runtime ledger lacks dependency: ${name}`);
    directory = directory.includes("/node_modules/")
      ? directory.slice(0, directory.lastIndexOf("/node_modules/"))
      : "";
  }
}

/** Copy exactly the installed production closure and reject version or dependency drift. */
function stageRuntime(root, stage, manifest, ledger) {
  const queue = Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  }).map((name) => [name, "", root]);
  const copied = new Map();
  for (let index = 0; index < queue.length; index += 1) {
    const [name, parentLocation, parentSource] = queue[index];
    const location = resolveRuntimeLocation(
      parentLocation,
      name,
      ledger.packages,
    );
    const source = resolveRuntimePackage(parentSource, name);
    if (copied.has(location)) {
      if (copied.get(location) !== source)
        throw new Error(`Conflicting runtime peer context: ${location}`);
      continue;
    }
    const metadata = JSON.parse(
      readFileSync(path.join(source, "package.json"), "utf8"),
    );
    const expected = ledger.packages[location];
    if (metadata.name !== name || metadata.version !== expected.version)
      throw new Error(`Installed runtime drift: ${location}`);
    const target = path.join(stage, location);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, {
      recursive: true,
      dereference: false,
      filter: (file) => {
        if (
          file !== source &&
          (file.endsWith(".map") || path.basename(file) === "node_modules")
        )
          return false;
        if (lstatSync(file).isSymbolicLink())
          throw new Error(
            "Runtime packages must contain physical publication files",
          );
        return true;
      },
    });
    copied.set(location, source);
    for (const child of Object.keys({
      ...expected.dependencies,
      ...expected.optionalDependencies,
    }))
      queue.push([child, location, source]);
  }
  const expectedLocations = Object.keys(ledger.packages).filter(Boolean);
  if (
    expectedLocations.length !== copied.size ||
    expectedLocations.some((location) => !copied.has(location))
  )
    throw new Error(
      "Runtime bundle does not match the complete tested closure",
    );
}

/** Pack an isolated physical publication tree; never mutate the checkout or its node_modules. */
export function packDistribution(root, options = {}) {
  let npm = "npm";
  const prefix = [];
  if (process.platform === "win32") {
    npm = process.execPath;
    prefix.push(
      path.join(
        path.dirname(
          createRequire(import.meta.url).resolve("npm/package.json", {
            paths: [path.dirname(process.execPath)],
          }),
        ),
        "bin/npm-cli.js",
      ),
    );
  }
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const ledger = JSON.parse(
    readFileSync(path.join(root, "runtime-dependencies.json"), "utf8"),
  );
  for (const field of [
    "name",
    "version",
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bin",
    "engines",
  ]) {
    if (
      JSON.stringify(ledger.packages[""][field]) !==
      JSON.stringify(manifest[field])
    )
      throw new Error("Runtime ledger does not match the publication manifest");
  }
  for (const location of Object.keys(ledger.packages).filter(Boolean)) {
    if (
      !/^node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:\/node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)*$/u.test(
        location,
      ) ||
      location.split("/").includes("..")
    )
      throw new Error("Unsafe runtime ledger location");
  }
  const stage = mkdtempSync(path.join(tmpdir(), "pm-publication-"));
  try {
    const sourceReport = readArtifact(
      execFileSync(
        npm,
        [...prefix, "pack", "--dry-run", "--json", "--ignore-scripts"],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        },
      ),
    );
    for (const file of sourceReport.files) {
      if (
        typeof file.path !== "string" ||
        path.isAbsolute(file.path) ||
        file.path.split(/[\\/]/u).includes("..") ||
        file.path.startsWith("node_modules/")
      )
        throw new Error("Unsafe source distribution path");
      const target = path.join(stage, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      const source = realpathSync(path.join(root, file.path));
      const relative = path.relative(realpathSync(root), source);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error("Source distribution file escapes the checkout");
      cpSync(source, target);
    }
    stageRuntime(root, stage, manifest, ledger);
    const published = structuredClone(manifest);
    delete published.devDependencies;
    delete published.scripts;
    published.bundleDependencies = Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    });
    writeFileSync(
      path.join(stage, "package.json"),
      `${JSON.stringify(published, null, 2)}\n`,
    );
    const args = [...prefix, "pack", "--json", "--ignore-scripts"];
    if (options.destination)
      args.push("--pack-destination", path.resolve(options.destination));
    else args.push("--dry-run");
    return readArtifact(
      execFileSync(npm, args, {
        cwd: stage,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      }),
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args[0] !== undefined && !args[0].startsWith("--destination="))
  )
    throw new Error(
      "Usage: package-distribution.mjs [--destination=<directory>]",
    );
  console.log(
    JSON.stringify(
      packDistribution(process.cwd(), {
        destination: args[0]?.slice("--destination=".length),
      }),
      null,
      2,
    ),
  );
}
