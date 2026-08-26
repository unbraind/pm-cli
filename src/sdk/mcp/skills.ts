/**
 * @module sdk/mcp/skills
 *
 * Implements pm's draft Skills over MCP registry with bounded filesystem
 * discovery, per-file digests, origin provenance, pagination, and fail-closed
 * revision negotiation.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { isFileAbsentError } from "../../core/fs/fs-utils.js";
import {
  PM_MCP_ERROR_CODES,
  PM_MCP_PROTOCOL_VERSION,
  PmMcpProtocolError,
  isMcpRecord,
  type PmMcpRequestContext,
} from "./protocol.js";

/** Draft extension identifier proposed by SEP-2640. */
export const PM_MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills" as const;

/** Exact draft proposal revision implemented by pm. */
export const PM_MCP_SKILLS_DRAFT_REVISION =
  "SEP-2640@a3e147ca2710f68214247aecc729731ee1ae8d03" as const;

/** Server-side draft capability advertised through discovery. */
export const PM_MCP_SKILLS_SERVER_CAPABILITY = Object.freeze({
  revision: PM_MCP_SKILLS_DRAFT_REVISION,
  status: "draft" as const,
  directoryRead: true,
});

/** Require exact draft negotiation for a skills method. */
export function assertPmMcpSkillsCapability(
  context: PmMcpRequestContext,
  directoryRead = false,
): void {
  const extensions = context.clientCapabilities.extensions;
  const declaration = isMcpRecord(extensions)
    ? extensions[PM_MCP_SKILLS_EXTENSION]
    : undefined;
  if (
    !isMcpRecord(declaration) ||
    declaration.revision !== PM_MCP_SKILLS_DRAFT_REVISION ||
    (directoryRead && declaration.directoryRead !== true)
  ) {
    throw new PmMcpProtocolError(
      "Missing or incompatible Skills over MCP draft capability",
      PM_MCP_ERROR_CODES.missingRequiredClientCapability,
      {
        requiredCapabilities: {
          extensions: { [PM_MCP_SKILLS_EXTENSION]: PM_MCP_SKILLS_SERVER_CAPABILITY },
        },
      },
    );
  }
}

/** Security and context limits applied independently to every skill origin. */
export const PM_MCP_SKILL_LIMITS = Object.freeze({
  maxFilesPerSkill: 512,
  maxFileBytes: 16 * 1024 * 1024,
  maxSkillBytes: 16 * 1024 * 1024,
  defaultPageSize: 20,
  maxPageSize: 100,
});

/** Origin from which a skill was loaded. */
export type PmMcpSkillOrigin = "package" | "workspace";

/** One immutable file advertised by a skill. */
export interface PmMcpSkillResource {
  /** Addressable skill resource URI. */
  uri: string;
  /** SEP-2640 SHA-256 digest of the exact bytes returned by reads. */
  digest: string;
  /** Exact byte length. */
  size: number;
}

/** Discoverable skill descriptor from the current SEP draft. */
export interface PmMcpSkillDescriptor {
  /** URI of the skill's mandatory SKILL.md. */
  uri: string;
  /** Parsed, verbatim frontmatter object. */
  frontmatter: Record<string, unknown>;
  /** Every bounded file in the skill directory. */
  resources: PmMcpSkillResource[];
  /** pm-specific compatibility and trust provenance. */
  _meta: {
    contractVersion: 1;
    extensionRevision: typeof PM_MCP_SKILLS_DRAFT_REVISION;
    origin: PmMcpSkillOrigin;
    packageVersion: string;
    protocolVersion: typeof PM_MCP_PROTOCOL_VERSION;
    trust: "untrusted";
    estimatedTokens: number;
  };
}

interface LoadedSkill extends PmMcpSkillDescriptor {
  files: Map<string, Buffer>;
  fingerprint: string;
}

/** Inputs for loading the canonical package skills plus repository overrides. */
export interface LoadPmMcpSkillsOptions {
  /** pm package root containing `.agents/skills`. */
  packageRoot: string;
  /** Workspace root whose `.agents/skills` override package skills by name. */
  workspaceRoot?: string;
  /** Exact package version included in compatibility metadata. */
  packageVersion: string;
}

/** List request inputs with opaque cursor pagination. */
export interface ListPmMcpSkillsOptions {
  /** Opaque cursor returned by a previous page. */
  cursor?: string;
  /** Requested page size, bounded to 100. */
  limit?: number;
}

/** One deterministic list page. */
export interface ListPmMcpSkillsResult {
  /** Skills in lexical URI order. */
  skills: PmMcpSkillDescriptor[];
  /** Opaque continuation cursor when more skills exist. */
  nextCursor?: string;
  /** Explicit completeness signal. */
  hasMore: boolean;
}

/** Exact read result for one skill resource. */
export interface ReadPmMcpSkillResourceResult {
  /** Resource content returned as UTF-8 text or lossless Base64 bytes. */
  contents: Array<
    | {
        uri: string;
        mimeType: "text/markdown" | "text/plain";
        text: string;
        _meta: { digest: string; origin: PmMcpSkillOrigin; trust: "untrusted" };
      }
    | {
        uri: string;
        mimeType: "application/octet-stream";
        blob: string;
        _meta: { digest: string; origin: PmMcpSkillOrigin; trust: "untrusted" };
      }
  >;
}

/** Direct-child directory listing defined by the current SEP draft. */
export interface ReadPmMcpSkillDirectoryResult {
  /** Direct child file and directory resources in lexical URI order. */
  resources: Array<{
    uri: string;
    name: string;
    mimeType: "application/octet-stream" | "inode/directory" | "text/markdown" | "text/plain";
  }>;
  /** Opaque continuation cursor when more direct children exist. */
  nextCursor?: string;
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SKILL_PAGE_SIZES = new Set(
  Array.from({ length: PM_MCP_SKILL_LIMITS.maxPageSize }, (_, index) => index + 1),
);

function skillError(message: string, data?: Record<string, unknown>): never {
  throw new PmMcpProtocolError(message, -32602, data);
}

function skillFileMimeType(
  name: string,
  bytes: Buffer,
): "application/octet-stream" | "text/markdown" | "text/plain" {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return name.endsWith(".md") ? "text/markdown" : "text/plain";
  } catch {
    return "application/octet-stream";
  }
}

function parseSkillFrontmatter(content: string, source: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) skillError(`Skill ${source} is missing YAML frontmatter.`);
  const document = parseDocument(match[1], {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    skillError(`Skill ${source} has invalid YAML frontmatter.`, {
      errors: document.errors.map((error) => error.message),
    });
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error: unknown) {
    skillError(`Skill ${source} has unsupported YAML aliases.`, {
      error: String(error),
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    skillError(`Skill ${source} frontmatter must be an object.`);
  }
  return value as Record<string, unknown>;
}

async function collectSkillFiles(
  root: string,
  relative = "",
): Promise<Array<{ relative: string; bytes: Buffer }>> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ relative: string; bytes: Buffer }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.posix.join(relative.split(path.sep).join("/"), entry.name);
    const childPath = path.join(root, ...childRelative.split("/"));
    const stats = await lstat(childPath);
    if (stats.isSymbolicLink()) {
      skillError(`Skill resource must not be a symbolic link: ${childRelative}.`);
    }
    if (stats.isDirectory()) {
      files.push(...(await collectSkillFiles(root, childRelative)));
    } else if (stats.isFile()) {
      if (stats.size > PM_MCP_SKILL_LIMITS.maxFileBytes) {
        skillError(`Skill resource exceeds the per-file limit: ${childRelative}.`);
      }
      files.push({ relative: childRelative, bytes: await readFile(childPath) });
    } else {
      skillError(`Skill resource must be a regular file or directory: ${childRelative}.`);
    }
    if (files.length > PM_MCP_SKILL_LIMITS.maxFilesPerSkill) {
      skillError(`Skill exceeds ${PM_MCP_SKILL_LIMITS.maxFilesPerSkill} files.`);
    }
  }
  return files;
}

async function loadSkillOrigin(
  skillsRoot: string,
  origin: PmMcpSkillOrigin,
  packageVersion: string,
): Promise<Map<string, LoadedSkill>> {
  const skills = new Map<string, LoadedSkill>();
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isFileAbsentError(error)) {
      return skills;
    }
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !SKILL_NAME_PATTERN.test(entry.name)) continue;
    const files = await collectSkillFiles(path.join(skillsRoot, entry.name));
    const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (totalBytes > PM_MCP_SKILL_LIMITS.maxSkillBytes) {
      skillError(`Skill ${entry.name} exceeds the aggregate byte limit.`);
    }
    const main = files.find((file) => file.relative === "SKILL.md");
    if (!main) continue;
    const frontmatter = parseSkillFrontmatter(main.bytes.toString("utf8"), entry.name);
    if (frontmatter.name !== entry.name) {
      skillError(`Skill directory ${entry.name} must match frontmatter name.`, {
        actual: frontmatter.name ?? null,
        expected: entry.name,
      });
    }
    if (
      typeof frontmatter.description !== "string" ||
      frontmatter.description.trim().length === 0
    ) {
      skillError(`Skill ${entry.name} requires a non-empty frontmatter description.`, {
        required: ["description"],
      });
    }
    const resources = files.map((file) => ({
      uri: `skill://${entry.name}/${file.relative}`,
      digest: `sha256:${createHash("sha256").update(file.bytes).digest("hex")}`,
      size: file.bytes.byteLength,
    }));
    const fingerprint = createHash("sha256")
      .update(resources.map((resource) => `${resource.uri}:${resource.digest}`).join("\n"))
      .digest("hex");
    skills.set(entry.name, {
      uri: `skill://${entry.name}/SKILL.md`,
      frontmatter,
      resources,
      _meta: {
        contractVersion: 1,
        extensionRevision: PM_MCP_SKILLS_DRAFT_REVISION,
        origin,
        packageVersion,
        protocolVersion: PM_MCP_PROTOCOL_VERSION,
        trust: "untrusted",
        estimatedTokens: Math.ceil(totalBytes / 4),
      },
      files: new Map(files.map((file) => [file.relative, file.bytes])),
      fingerprint,
    });
  }
  return skills;
}

function projectSkill(skill: LoadedSkill): PmMcpSkillDescriptor {
  const { files: _files, fingerprint: _fingerprint, ...descriptor } = skill;
  return descriptor;
}

/** Immutable in-memory registry for one request's package/workspace origins. */
export class PmMcpSkillRegistry {
  readonly #skills: Map<string, LoadedSkill>;
  readonly #fingerprint: string;

  private constructor(skills: Map<string, LoadedSkill>) {
    this.#skills = skills;
    this.#fingerprint = createHash("sha256")
      .update(
        [...skills.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, skill]) => `${name}:${skill.fingerprint}`)
          .join("\n"),
      )
      .digest("hex")
      .slice(0, 16);
  }

  /** Decode one registry-bound cursor for a list or directory scope. */
  #decodeCursor(cursor: string | undefined, scope: string): number {
    if (!cursor) return 0;
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("fingerprint" in parsed) ||
        parsed.fingerprint !== this.#fingerprint ||
        !("scope" in parsed) ||
        parsed.scope !== scope ||
        !("offset" in parsed) ||
        !Number.isInteger(parsed.offset) ||
        Number(parsed.offset) < 0
      ) {
        skillError("Skill cursor is invalid or stale.");
      }
      return Number(parsed.offset);
    } catch (error: unknown) {
      if (error instanceof PmMcpProtocolError) throw error;
      return skillError("Skill cursor is invalid or stale.");
    }
  }

  /** Encode one registry-bound continuation cursor. */
  #encodeCursor(offset: number, scope: string): string {
    return Buffer.from(
      JSON.stringify({ fingerprint: this.#fingerprint, offset, scope }),
    ).toString("base64url");
  }

  /** Load package skills and apply validated workspace overrides by name. */
  static async load(options: LoadPmMcpSkillsOptions): Promise<PmMcpSkillRegistry> {
    const packaged = await loadSkillOrigin(
      path.join(options.packageRoot, ".agents", "skills"),
      "package",
      options.packageVersion,
    );
    if (options.workspaceRoot) {
      const packageSkillsRoot = path.resolve(options.packageRoot, ".agents", "skills");
      const workspaceSkillsRoot = path.resolve(options.workspaceRoot, ".agents", "skills");
      if (workspaceSkillsRoot !== packageSkillsRoot) {
        const overrides = await loadSkillOrigin(
          workspaceSkillsRoot,
          "workspace",
          options.packageVersion,
        );
        for (const [name, skill] of overrides) packaged.set(name, skill);
      }
    }
    return new PmMcpSkillRegistry(packaged);
  }

  /** List skills in deterministic pages without loading file bodies. */
  list(options: ListPmMcpSkillsOptions = {}): ListPmMcpSkillsResult {
    const limit = options.limit ?? PM_MCP_SKILL_LIMITS.defaultPageSize;
    if (!SKILL_PAGE_SIZES.has(limit)) {
      skillError(`Skill list limit must be an integer from 1 to ${PM_MCP_SKILL_LIMITS.maxPageSize}.`);
    }
    const offset = this.#decodeCursor(options.cursor, "skills/list");
    const ordered = [...this.#skills.values()].sort((left, right) =>
      left.uri.localeCompare(right.uri),
    );
    const page = ordered.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < ordered.length;
    return {
      skills: page.map(projectSkill),
      hasMore,
      ...(hasMore
        ? {
            nextCursor: this.#encodeCursor(nextOffset, "skills/list"),
          }
        : {}),
    };
  }

  /** Get one skill descriptor by its SKILL.md URI. */
  get(uri: string): PmMcpSkillDescriptor {
    const match = /^skill:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/u.exec(uri);
    const skill = match ? this.#skills.get(match[1]) : undefined;
    if (!skill) skillError(`Unknown pm MCP skill: ${uri}.`, { field: "uri" });
    return projectSkill(skill);
  }

  /** Read one digest-bound skill resource without following filesystem links. */
  read(uri: string): ReadPmMcpSkillResourceResult {
    const match = /^skill:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/u.exec(uri);
    const skill = match ? this.#skills.get(match[1]) : undefined;
    const relative = match?.[2] ?? "";
    const bytes = skill && relative ? skill.files.get(relative) : undefined;
    const resource = skill?.resources.find((candidate) => candidate.uri === uri);
    if (!skill || !bytes || !resource) {
      skillError(`Unknown pm MCP skill resource: ${uri}.`, { field: "uri" });
    }
    const metadata = {
      digest: resource.digest,
      origin: skill._meta.origin,
      trust: "untrusted" as const,
    };
    const mimeType = skillFileMimeType(relative, bytes);
    if (mimeType !== "application/octet-stream") {
      return {
        contents: [
          {
            uri,
            mimeType,
            text: bytes.toString("utf8"),
            _meta: metadata,
          },
        ],
      };
    }
    return {
      contents: [
        {
          uri,
          mimeType,
          blob: bytes.toString("base64"),
          _meta: metadata,
        },
      ],
    };
  }

  /** List one directory's direct children with opaque cursor pagination. */
  readDirectory(
    uri: string,
    options: ListPmMcpSkillsOptions = {},
  ): ReadPmMcpSkillDirectoryResult {
    const match = /^skill:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(.+))?$/u.exec(uri);
    const skill = match ? this.#skills.get(match[1]) : undefined;
    if (!skill) skillError(`Unknown pm MCP skill directory: ${uri}.`, { field: "uri" });
    const directory = (match?.[2] ?? "").replace(/\/$/u, "");
    const prefix = directory.length > 0 ? `${directory}/` : "";
    const children = new Map<string, ReadPmMcpSkillDirectoryResult["resources"][number]>();
    for (const resource of skill.resources) {
      const relative = resource.uri.slice(`skill://${match![1]}/`.length);
      if (!relative.startsWith(prefix)) continue;
      const remainder = relative.slice(prefix.length);
      const [name, ...descendants] = remainder.split("/");
      const childUri = `${uri}/${name}`;
      const childBytes = skill.files.get(`${prefix}${name}`);
      children.set(name, {
        uri: childUri,
        name,
        mimeType:
          descendants.length > 0
            ? "inode/directory"
            : skillFileMimeType(name, childBytes!),
      });
    }
    if (directory.length > 0 && children.size === 0) {
      skillError(`Unknown pm MCP skill directory: ${uri}.`, { field: "uri" });
    }
    const limit = options.limit ?? PM_MCP_SKILL_LIMITS.maxPageSize;
    if (!SKILL_PAGE_SIZES.has(limit)) {
      skillError(`Skill directory limit must be an integer from 1 to ${PM_MCP_SKILL_LIMITS.maxPageSize}.`);
    }
    const offset = this.#decodeCursor(options.cursor, uri);
    const ordered = [...children.values()].sort((left, right) => left.uri.localeCompare(right.uri));
    const resources = ordered.slice(offset, offset + limit);
    const nextOffset = offset + resources.length;
    return {
      resources,
      ...(nextOffset < ordered.length
        ? {
            nextCursor: this.#encodeCursor(nextOffset, uri),
          }
        : {}),
    };
  }
}
