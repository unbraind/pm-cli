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
import { isDeepStrictEqual } from "node:util";
import { registerTempCleanup } from "../temp-lifecycle.mjs";
import { withBuildLease } from "../build-lease.mjs";

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

/** Materialize tested peer bindings in the staged manifest so npm walks their complete runtime subtrees. */
function materializeRuntimePeerBindings(target, metadata, expected) {
  const declared = { ...metadata.dependencies, ...metadata.optionalDependencies };
  let changed = false;
  for (const field of ["dependencies", "optionalDependencies"]) {
    const peers = Object.entries(expected[field] ?? {}).filter(([name]) => Object.hasOwn(expected.peerDependencies ?? {}, name) && !Object.hasOwn(declared, name));
    if (peers.length) {
      metadata[field] = { ...metadata[field], ...Object.fromEntries(peers) };
      changed = true;
    }
  }
  if (changed)
    writeFileSync(path.join(target, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

/** Pin each required peer that the tested closure installs at the root to its tested version (pm-2csj4k). Bun resolves a package's dependencies from the registry instead of its bundleDependencies, so an unpinned peer resolves to its newest release even when the bundled packages declare a narrower range. A peer resolved only in a nested node_modules is not pinned: the root manifest may only name packages the ledger places at the root, which the installed-runtime verifier enforces. */
export function pinRuntimePeers(manifest, ledger) {
  const declared = { ...manifest.dependencies, ...manifest.optionalDependencies };
  const peers = new Map();
  for (const entry of Object.values(ledger.packages)) {
    for (const name of Object.keys(entry.peerDependencies ?? {})) {
      const tested = ledger.packages[`node_modules/${name}`];
      if (tested && entry.peerDependenciesMeta?.[name]?.optional !== true && !Object.hasOwn(declared, name))
        peers.set(name, tested.version);
    }
  }
  return { ...manifest.dependencies, ...Object.fromEntries([...peers].sort(([left], [right]) => left.localeCompare(right))) };
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
    materializeRuntimePeerBindings(target, metadata, expected);
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

/** A pipe that separates cells: one preceded by an even number of backslashes, as GFM reads it. */
const CELL_SEPARATOR = /(?<=(?:^|[^\\])(?:\\\\)*)\|/u;

/**
 * Trim spaces and tabs only, the whitespace GFM strips around cell text.
 * String.prototype.trim would also strip U+00A0 and other Unicode spaces, which
 * are cell content.
 */
function trimSpaces(text) {
  return text.replace(/^[ \t]+|[ \t]+$/gu, "");
}

/** A blank line as CommonMark defines it: nothing but spaces and tabs. */
function isBlank(line) {
  return /^[ \t]*$/u.test(line);
}

/** Split a GFM table row into trimmed cells; an escaped pipe stays inside its cell. */
function tableCells(row) {
  const body = trimSpaces(row).replace(/^\|/u, "").replace(new RegExp(`${CELL_SEPARATOR.source}$`, "u"), "");
  return body.split(new RegExp(CELL_SEPARATOR.source, "gu")).map(trimSpaces);
}

/** A separator cell's alignment: what GFM reads from it, independent of dash count. */
function separatorAlignment(cell) {
  return /^:?-{3,}:?$/u.test(cell) ? `${cell.startsWith(":") ? ":" : ""}-${cell.endsWith(":") ? ":" : ""}` : undefined;
}

/** A pipe-bordered row, at most three spaces in (four make indented code). */
const TABLE_ROW = /^( {0,3})\|.*\|[ \t]*$/u;
/** HTML blocks whose raw lines run to a closing marker (CommonMark start conditions 1-5). */
const RAW_HTML_TO_MARKER = [
  [/^ {0,3}<(?:pre|script|style|textarea)(?=[\s>]|$)/iu, (text) => /<\/(?:pre|script|style|textarea)>/iu.test(text)],
  [/^ {0,3}<!--/u, (text) => text.includes("-->")],
  [/^ {0,3}<\?/u, (text) => text.includes("?>")],
  [/^ {0,3}<![A-Za-z]/u, (text) => text.includes(">")],
  [/^ {0,3}<!\[CDATA\[/u, (text) => text.includes("]]>")],
];
/** Condition 6: a block-level tag, raw up to the next blank line, which may interrupt a paragraph. */
const RAW_HTML_BLOCK_TAG = new RegExp(
  String.raw`^ {0,3}</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \t>]|/>|$)`,
  "iu",
);
/**
 * Condition 7: one complete open or closing tag alone on its line, raw up to the
 * next blank line. It starts a block after any ended block but cannot interrupt
 * a paragraph, where it is paragraph text and a fence after it still opens.
 */
const RAW_HTML_LONE_TAG = new RegExp(
  String.raw`^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>` + "`" + String.raw`]+|'[^']*'|"[^"]*"))?)*\s*/?>|</[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$`,
  "u",
);
/** An ATX heading: a one-line block, so the line after it starts a new block. */
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/u;
/** A fence marker after indentation or a list-item or block-quote marker, whose extent depends on containers. */
const CONTAINED_FENCE = /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*(?<=.)(?:`{3,}|~{3,})/u;

/** The marker a line opens a fence with; a backtick info string cannot hold a backtick. */
function fenceOpener(content) {
  const open = /^(`{3,}|~{3,})(.*)$/u.exec(content);
  return open && !(open[1][0] === "`" && open[2].includes("`")) ? open[1] : undefined;
}

/** A fence closes only on a bare marker of the opening character that is at least as long. */
function closesFence(content, fence) {
  const close = /^(`{3,}|~{3,})[ \t]*$/u.exec(content)?.[1];
  return close?.[0] === fence[0] && close.length >= fence.length;
}

/**
 * Where the HTML block a line opens ends: a closing-marker test, "blank", or
 * undefined when it closes on the same line. Null when the line opens none, and
 * "unknown" for a lone tag that may continue a paragraph, a table body or a
 * list item, which a line scanner cannot tell apart.
 */
function rawHtmlEnd(line, blockEnded) {
  const opener = RAW_HTML_TO_MARKER.find(([start]) => start.test(line));
  if (opener) return opener[1](line.replace(opener[0], "")) ? undefined : opener[1];
  if (RAW_HTML_BLOCK_TAG.test(line)) return "blank";
  if (!RAW_HTML_LONE_TAG.test(line)) return null;
  return blockEnded ? "blank" : "unknown";
}

/**
 * Classify one line and advance the scan state: true for prose, false for
 * fenced code or raw HTML, undefined where the block a lone tag belongs to
 * cannot be established.
 */
function scanLine(state, line) {
  if (state.fence !== undefined) {
    if (closesFence(line, state.fence)) state.fence = undefined;
    return false;
  }
  if (state.rawEnd !== undefined) {
    if (state.rawEnd === "blank" ? isBlank(line) : state.rawEnd(line)) state.rawEnd = undefined;
    return false;
  }
  state.fence = fenceOpener(line);
  if (state.fence !== undefined) return false;
  const end = rawHtmlEnd(line, state.blockEnded);
  if (end === "unknown") return undefined;
  if (end === null) return true;
  state.rawEnd = end;
  return false;
}

/**
 * Mark the lines Markdown renders as prose, outside fenced code and raw HTML
 * blocks, or undefined when a lone tag's block is uncertain. A lone tag is raw
 * at the start, after a blank line or heading, or right after a fence or raw
 * block ends. Only fences at the left margin occur here: a file with any other
 * fence is never compacted.
 */
function proseLines(lines) {
  const state = { fence: undefined, rawEnd: undefined, blockEnded: true };
  const prose = [];
  for (const line of lines) {
    const isProse = scanLine(state, line);
    if (isProse === undefined) return undefined;
    prose.push(isProse);
    state.blockEnded = !isProse || isBlank(line) || ATX_HEADING.test(line);
  }
  return prose;
}

/** Compact one table row; a delimiter row keeps each column's alignment, any other row its cell text. */
function compactTableRow(line, delimiter) {
  const cells = tableCells(line);
  const compact = delimiter
    ? `|${cells.map((cell) => cell.replace(/-{3,}/u, "---")).join("|")}|`
    : `| ${cells.join(" | ")} |`;
  const reparsed = tableCells(compact);
  const same = delimiter ? (cell, index) => separatorAlignment(cell) === separatorAlignment(cells[index]) : (cell, index) => cell === cells[index];
  /* c8 ignore next 2 -- defensive: every compacted row reparses to the same cells and alignment */
  if (reparsed.length !== cells.length || !reparsed.every(same))
    throw new Error(`Non-lossless markdown table row: ${line}`);
  return `${TABLE_ROW.exec(line)[1]}${compact}`;
}

/**
 * Collapse alignment padding in GFM tables outside code and raw HTML. A table is
 * a pipe row that starts a block, a delimiter row with the same cell count, and
 * the pipe rows that follow, all at the header's indentation. Cells, their order
 * and column alignment are unchanged, so the rendered table is identical
 * (pm-998juj). Line endings are kept. A file is returned unchanged when its
 * fences sit inside list items, block quotes or indentation, or when a lone HTML
 * tag follows a line that may be a paragraph, because those block boundaries
 * depend on structure a line scanner does not model. Release controls run
 * this script without node_modules, so its losslessness over the shipped files is
 * proven by rendering them in the spec instead of here.
 */
export function compactMarkdownTables(text) {
  const raw = text.split("\n");
  const lines = raw.map((line) => line.replace(/\r$/u, ""));
  if (lines.some((line) => CONTAINED_FENCE.test(line))) return text;
  const prose = proseLines(lines);
  if (prose === undefined) return text;
  const indent = (index) => (prose[index] ? TABLE_ROW.exec(lines[index])?.[1] : undefined);
  const startsBlock = (index) => index === 0 || isBlank(lines[index - 1]) || ATX_HEADING.test(lines[index - 1]);
  for (let header = 0; header + 1 < lines.length; header += 1) {
    const level = indent(header);
    if (level === undefined || indent(header + 1) !== level || !startsBlock(header)) continue;
    const alignments = tableCells(lines[header + 1]).map(separatorAlignment);
    if (alignments.length !== tableCells(lines[header]).length || !alignments.every(Boolean)) continue;
    let row = header;
    for (; row < lines.length && indent(row) === level; row += 1) {
      raw[row] = `${compactTableRow(lines[row], row === header + 1)}${raw[row].endsWith("\r") ? "\r" : ""}`;
    }
    header = row - 1;
  }
  return raw.join("\n");
}

/** A relative module specifier in an emitted declaration: `from "./x.js"` or `import("./x.js")`. */
const DECLARATION_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/gu;

/**
 * Collect the declarations a consumer can reach from the manifest's exported `types` entries (pm-998juj).
 *
 * The exports map refuses every unexported subpath, so a dist declaration outside this closure is
 * unreachable for any consumer, and packing stops shipping it. Callers apply this only when the
 * manifest declares an exports map: without one every subpath stays importable. The walk fails closed: an entry or a
 * referenced declaration that is not in the packlist, or a relative specifier that is not a `.js`
 * module path, refuses the pack instead of publishing a dangling type reference.
 */
export function exportedDeclarationClosure(manifest, packedPaths, readText) {
  const packed = new Set(packedPaths);
  const pending = [];
  const collect = (value) => {
    if (typeof value === "string") {
      if (value.endsWith(".d.ts")) pending.push(path.posix.normalize(value));
    } else if (value !== null && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(manifest.exports);
  collect(manifest.types);
  const reachable = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (reachable.has(file)) continue;
    if (!packed.has(file)) throw new Error(`Exported type closure references an unpacked declaration: ${file}`);
    reachable.add(file);
    for (const [, specifier] of readText(file).matchAll(DECLARATION_SPECIFIER)) {
      if (!specifier.startsWith(".") || specifier.endsWith(".json")) continue;
      if (!specifier.endsWith(".js")) throw new Error(`Unsupported declaration specifier ${specifier} in ${file}`);
      pending.push(path.posix.join(path.posix.dirname(file), `${specifier.slice(0, -".js".length)}.d.ts`));
    }
  }
  return reachable;
}

/** Stage first-party files with compact JSON and markdown tables, retaining values and readable checkout bytes. */
function copyPublicationFile(relative, source, target) {
  if (relative.endsWith(".md")) {
    writeFileSync(target, compactMarkdownTables(readFileSync(source, "utf8")));
    return;
  }
  if (!relative.endsWith(".json")) {
    cpSync(source, target);
    return;
  }
  const value = JSON.parse(readFileSync(source, "utf8"));
  const compact = `${JSON.stringify(value)}\n`;
  if (!isDeepStrictEqual(value, JSON.parse(compact)))
    throw new Error(`Non-lossless publication JSON: ${relative}`);
  writeFileSync(target, compact);
}

/** Copy the checked source packlist into the publication tree, leaving out declarations no consumer can reach. */
function stageSourceFiles(root, stage, manifest, files) {
  // Without an exports map a consumer can deep-import any subpath, so every declaration ships.
  const exportedDeclarations = manifest.exports === undefined ? undefined : exportedDeclarationClosure(
    manifest,
    files.map((file) => file.path),
    (file) => readFileSync(path.join(root, file), "utf8"),
  );
  for (const file of files) {
    if (
      typeof file.path !== "string" ||
      path.isAbsolute(file.path) ||
      file.path.split(/[\\/]/u).includes("..") ||
      file.path.startsWith("node_modules/")
    )
      throw new Error("Unsafe source distribution path");
    // A dist declaration no exported types entry reaches cannot be imported by any consumer.
    if (file.path.startsWith("dist/") && file.path.endsWith(".d.ts") && exportedDeclarations !== undefined && !exportedDeclarations.has(file.path)) continue;
    const target = path.join(stage, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    const source = realpathSync(path.join(root, file.path));
    const relative = path.relative(realpathSync(root), source);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Source distribution file escapes the checkout");
    copyPublicationFile(file.path, source, target);
  }
}

/** Materialize one leased, complete generation into an isolated physical publication tree. */
function packLeasedDistribution(root, options) {
  if (existsSync(path.join(root, ".cache", "build-incomplete")))
    throw new Error("Cannot pack an incomplete build generation. Run pnpm build before packing.");
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
  const releaseCleanup = registerTempCleanup(stage);
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
    stageSourceFiles(root, stage, manifest, sourceReport.files);
    stageRuntime(root, stage, manifest, ledger);
    const published = structuredClone(manifest);
    delete published.devDependencies;
    delete published.scripts;
    published.dependencies = pinRuntimePeers(manifest, ledger);
    published.bundleDependencies = Object.keys({
      ...published.dependencies,
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
    releaseCleanup();
  }
}

/** Hold the verified build-consumer lease throughout source inventory, staging, and packing. */
export async function packDistribution(root, options = {}) {
  const physicalRoot = realpathSync(root);
  const token = process.env.PM_BUILD_CONSUMER_LEASE;
  const ownerRoot = process.env.PM_BUILD_CONSUMER_LEASE_ROOT ?? path.resolve(import.meta.dirname, "../..");
  let inherited;
  if (token) {
    try {
      if (physicalRoot === realpathSync(ownerRoot)) inherited = token;
    } catch {
      // An unresolvable parent never authorizes inheritance; acquire independent ownership.
    }
  }
  return withBuildLease(physicalRoot, () => packLeasedDistribution(physicalRoot, options), { inherited });
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
      await packDistribution(process.cwd(), {
        destination: args[0]?.slice("--destination=".length),
      }),
      null,
      2,
    ),
  );
}
