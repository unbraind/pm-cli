/** Verify the shipped dependency ledger against an installed CLI. Tracker: pm-gh1417. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Require every bundled runtime package to retain its tested version after installation. */
export function verifyRuntimeInstallation(packageRoot) {
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  const ledger = JSON.parse(
    readFileSync(path.join(packageRoot, "runtime-dependencies.json"), "utf8"),
  );
  if (ledger.name !== manifest.name || ledger.version !== manifest.version)
    throw new Error("Installed runtime ledger identity mismatch");
  for (const name of Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })) {
    if (!Object.hasOwn(ledger.packages, `node_modules/${name}`))
      throw new Error(`Installed runtime ledger lacks root: ${name}`);
  }
  const locations = Object.keys(ledger.packages).filter(Boolean);
  for (const location of locations) {
    if (
      path.isAbsolute(location) ||
      location.split(/[\\/]/u).includes("..") ||
      !location.startsWith("node_modules/")
    )
      throw new Error("Unsafe installed runtime ledger location");
    const installed = JSON.parse(
      readFileSync(path.join(packageRoot, location, "package.json"), "utf8"),
    );
    const expectedName = location.slice(
      location.lastIndexOf("node_modules/") + "node_modules/".length,
    );
    if (
      installed.name !== expectedName ||
      installed.version !== ledger.packages[location].version
    )
      throw new Error(`Installed runtime version mismatch: ${location}`);
  }
  return {
    ok: true,
    package: manifest.name,
    version: manifest.version,
    runtime_packages: locations.length,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 3)
    throw new Error(
      "Usage: verify-runtime-installation.mjs <installed-package-root>",
    );
  console.log(
    JSON.stringify(verifyRuntimeInstallation(path.resolve(process.argv[2]))),
  );
}
