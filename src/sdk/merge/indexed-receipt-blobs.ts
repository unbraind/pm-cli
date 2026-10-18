/** Read only requested stage-zero receipt blobs with bounded Git batches. */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isPathOutsideRoot } from "../workspace.js";
import { gitWorkspaceEnvironment } from "./worktree-config.js";

const execFileAsync = promisify(execFile);
const OBJECT_ID = "[a-f0-9]{40}(?:[a-f0-9]{24})?";
const INDEX_ENTRY = new RegExp(`^100(?:644|755) (${OBJECT_ID}) 0$`, "u");
const BLOB_METADATA = new RegExp(`^(${OBJECT_ID}) blob (\\d+)$`, "u");
type GitOptions = { cwd: string; env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean; maxBuffer: number };
type BlobEntry = { id: string; size: number };

/** Close input explicitly and let a broken pipe fail through the child result. */
async function gitBatch(args: string[], ids: string[], options: GitOptions): Promise<Buffer> {
  const pending = execFileAsync("git", args, { ...options, encoding: "buffer" });
  const input = pending.child.stdin;
  if (input !== null) {
    input.on("error", () => { pending.child.kill(); });
    input.end(`${ids.join("\n")}\n`);
  }
  return (await pending).stdout;
}

/** Retain exact requested regular-file paths, excluding unresolved index stages. */
function indexedFiles(listing: string, requested: Set<string>): Map<string, string> {
  const files = new Map<string, string>();
  for (const record of listing.split("\0")) {
    const separator = record.indexOf("\t");
    const file = record.slice(separator + 1);
    const metadata = INDEX_ENTRY.exec(record.slice(0, separator));
    if (metadata !== null && requested.has(file)) files.set(file, metadata[1]!);
  }
  return files;
}

/** Plan batches by actual object sizes so accumulated output stays file-bound. */
function blobBatches(metadata: string, requested: Set<string>, maximumBytes: number): BlobEntry[][] {
  const batches: BlobEntry[][] = [];
  let batch: BlobEntry[] = [];
  let bytes = 0;
  for (const line of metadata.trimEnd().split(/\r?\n/u)) {
    const match = BLOB_METADATA.exec(line);
    if (match === null || !requested.has(match[1]!)) continue;
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > maximumBytes) continue;
    if (batch.length > 0 && bytes + size + 128 > maximumBytes) {
      batches.push(batch); batch = []; bytes = 0;
    }
    batch.push({ id: match[1]!, size }); bytes += size + 128;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** Decode Git's byte-counted protocol without treating JSON newlines as framing. */
function decodeBlobs(output: Buffer, entries: BlobEntry[], blobs: Map<string, string>): void {
  let offset = 0;
  for (const { id, size } of entries) {
    const start = output.indexOf(10, offset) + 1;
    if (start === 0 || output.subarray(offset, start - 1).toString("ascii") !== `${id} blob ${size}` || output[start + size] !== 10) {
      throw new Error("Invalid indexed receipt batch framing");
    }
    blobs.set(id, output.subarray(start, start + size).toString("utf8"));
    offset = start + size + 1;
  }
  if (offset !== output.length) throw new Error("Unexpected indexed receipt batch data");
}

/** Resolve physical roots, list the index once, and batch only requested bounded blobs. */
export async function readIndexedReceiptBlobs(cwd: string, directory: string, fileNames: string[], maximumBytes: number): Promise<Map<string, string>> {
  const env = gitWorkspaceEnvironment();
  // Replacement refs are clone-local; authenticate the stored object bytes.
  env.GIT_NO_REPLACE_OBJECTS = "1";
  if (process.env.GIT_INDEX_FILE !== undefined) env.GIT_INDEX_FILE = path.resolve(process.env.GIT_INDEX_FILE);
  const options: GitOptions = { cwd, env, windowsHide: true, timeout: 10_000, maxBuffer: maximumBytes + 256 };
  try {
    const root = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { ...options, encoding: "utf8" })).stdout.trim();
    const [workspace, physicalDirectory] = await Promise.all([realpath(root), realpath(directory)]);
    const relative = path.relative(workspace, physicalDirectory).replaceAll("\\", "/");
    if (isPathOutsideRoot(relative)) return new Map();
    options.cwd = workspace;
    const names = new Map(fileNames.map((file) => [`${relative}/${file}`, file]));
    const listing = (await execFileAsync("git", ["ls-files", "--stage", "-z", "--", `:(literal)${relative}/`], { ...options, encoding: "utf8" })).stdout;
    const files = indexedFiles(listing, new Set(names.keys()));
    if (files.size === 0) return new Map();
    const ids = new Set(files.values());
    const metadata = (await gitBatch(["cat-file", "--batch-check"], [...ids], options)).toString("utf8");
    const blobs = new Map<string, string>();
    for (const batch of blobBatches(metadata, ids, maximumBytes)) {
      decodeBlobs(await gitBatch(["cat-file", "--batch"], batch.map((entry) => entry.id), options), batch, blobs);
    }
    return new Map([...files].filter(([, id]) => blobs.has(id)).map(([file, id]) => [names.get(file)!, blobs.get(id)!]));
  } catch { return new Map(); }
}
