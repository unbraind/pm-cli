/**
 * @module sdk/query/search/corpus
 * Reads cached item bodies and linked content with lexical and realpath containment checks.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  getActiveExtensionRegistrations,
  runActiveOnReadHooks,
} from "../../../core/extensions/index.js";
import { collectRegisteredItemFieldNames } from "../../../core/extensions/item-fields.js";
import { isPathWithinDirectory } from "../../../core/fs/path-utils.js";
import { parseItemDocument } from "../../../core/item/item-format.js";
import { listAllDocumentCandidatesCached } from "../../../core/store/item-metadata-cache.js";
import { listAllItemMetadata } from "../../../core/store/item-store.js";
import {
  getItemPath,
  resolveGlobalPmRoot
} from "../../../core/store/paths.js";
import type {
  ItemDocument,
  ItemFormat,
  ItemMetadata,
  ItemType,
  PmSettings
} from "../../../types/index.js";
import {
  type SearchMode
} from "../search-rendering.js";

/** Collect linked file and document paths eligible for optional search corpus enrichment. */
function collectLinkedPaths(
  item: ItemMetadata,
): Array<{ scope: "project" | "global"; path: string }> {
  const fromFiles = (item.files ?? []).map((entry) => ({
    scope: entry.scope,
    path: entry.path.trim(),
  }));
  const fromDocs = (item.docs ?? []).map((entry) => ({
    scope: entry.scope,
    path: entry.path.trim(),
  }));
  const fromTests = (item.tests ?? [])
    .filter(
      (entry): entry is typeof entry & { path: string } =>
        typeof entry.path === "string" && entry.path.trim().length > 0,
    )
    .map((entry) => ({
      scope: entry.scope,
      path: entry.path.trim(),
    }));
  const sorted = [...fromFiles, ...fromDocs, ...fromTests]
    .filter((entry) => entry.path.length > 0)
    .sort(
      (a, b) => a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path),
    );
  const deduped = new Map<
    string,
    { scope: "project" | "global"; path: string }
  >();
  for (const entry of sorted) {
    deduped.set(`${entry.scope}:${entry.path}`, entry);
  }
  return [...deduped.values()];
}

interface ContainmentRoot {
  resolved: string;
  realpath: string;
}

interface LinkedCorpusRoots {
  projectContainmentRoot: ContainmentRoot | null;
  globalContainmentRoot: ContainmentRoot | null;
}

async function resolveContainmentRoot(
  root: string,
): Promise<ContainmentRoot | null> {
  const resolved = path.resolve(root);
  try {
    const realpathRoot = await fs.realpath(resolved);
    return {
      resolved,
      realpath: realpathRoot,
    };
  } catch {
    return null;
  }
}

/** Resolve the workspace and global roots used to contain linked-content reads. */
async function resolveLinkedCorpusRoots(
  projectRoot: string,
  globalRoot: string,
): Promise<LinkedCorpusRoots> {
  const [projectContainmentRoot, globalContainmentRoot] = await Promise.all([
    resolveContainmentRoot(projectRoot),
    resolveContainmentRoot(globalRoot),
  ]);
  return {
    projectContainmentRoot,
    globalContainmentRoot,
  };
}

/** Read eligible linked content while retaining lexical and canonical path containment checks. */
async function loadLinkedCorpus(
  document: ItemDocument,
  roots: LinkedCorpusRoots,
): Promise<string> {
  const linkedPaths = collectLinkedPaths(document.metadata);
  const chunks: string[] = [];
  for (const linkedPath of linkedPaths) {
    const containmentRoot =
      linkedPath.scope === "global"
        ? roots.globalContainmentRoot
        : roots.projectContainmentRoot;
    if (!containmentRoot) {
      continue;
    }
    const resolved = path.resolve(containmentRoot.resolved, linkedPath.path);
    if (!isPathWithinDirectory(containmentRoot.resolved, resolved)) {
      continue;
    }
    let linkedRealpath: string;
    try {
      linkedRealpath = await fs.realpath(resolved);
    } catch {
      continue;
    }
    if (!isPathWithinDirectory(containmentRoot.realpath, linkedRealpath)) {
      continue;
    }
    try {
      await runActiveOnReadHooks({
        path: resolved,
        scope: linkedPath.scope,
      });
      chunks.push(await fs.readFile(resolved, "utf8"));
    } catch {
      // Best-effort linked-content indexing: unreadable paths are ignored.
    }
  }
  return chunks.join("\n");
}

/* c8 ignore start */

/** Load the searchable item corpus for the resolved tracker. */
async function loadDocuments(
  pmRoot: string,
  itemFormat: ItemFormat,
  typeToFolder: Record<string, string>,
  schema: PmSettings["schema"],
): Promise<{ documents: ItemDocument[]; warnings: string[] }> {
  const extensionFieldNames = collectRegisteredItemFieldNames(
    getActiveExtensionRegistrations(),
  );
  const readDocumentBody = async (
    metadata: ItemMetadata,
    preferredPath: string,
    preferredFormat: ItemFormat,
  ): Promise<string> => {
    const tryRead = async (
      targetPath: string,
      format: ItemFormat,
    ): Promise<string> => {
      await runActiveOnReadHooks({ path: targetPath, scope: "project" });
      const raw = await fs.readFile(targetPath, "utf8");
      const parsed = parseItemDocument(raw, {
        format,
        schema,
        extensionFieldNames,
        onWarning: (warning) => listWarnings.push(warning),
      });
      return parsed.body;
    };

    try {
      return await tryRead(preferredPath, preferredFormat);
    } catch {
      const alternateFormat: ItemFormat =
        preferredFormat === "toon" ? "json_markdown" : "toon";
      const alternatePath = getItemPath(
        pmRoot,
        metadata.type as ItemType,
        metadata.id,
        alternateFormat,
        typeToFolder,
      );
      try {
        return await tryRead(alternatePath, alternateFormat);
      } catch {
        listWarnings.push(
          `item_list_item_read_failed:${path.relative(pmRoot, alternatePath)}`,
        );
        return "";
      }
    }
  };

  const listWarnings: string[] = [];
  const cachedDocuments = await listAllDocumentCandidatesCached(
    pmRoot,
    itemFormat,
    typeToFolder,
    listWarnings,
    schema,
  );
  const documents: ItemDocument[] = [];
  if (cachedDocuments.length === 0) {
    const itemMetadataDocuments = await listAllItemMetadata(
      pmRoot,
      itemFormat,
      typeToFolder,
      listWarnings,
      schema,
    );
    for (const metadata of itemMetadataDocuments) {
      const preferredPath = getItemPath(
        pmRoot,
        metadata.type as ItemType,
        metadata.id,
        itemFormat,
        typeToFolder,
      );
      const body = await readDocumentBody(metadata, preferredPath, itemFormat);
      documents.push({ metadata, body });
    }
    return {
      documents,
      warnings: [...new Set(listWarnings)].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  }

  for (const cachedDocument of cachedDocuments) {
    if (typeof cachedDocument.body === "string") {
      documents.push({
        metadata: cachedDocument.metadata,
        body: cachedDocument.body,
      });
      continue;
    }
    const body = await readDocumentBody(
      cachedDocument.metadata,
      cachedDocument.item_path,
      cachedDocument.item_format,
    );
    documents.push({
      metadata: cachedDocument.metadata,
      body,
    });
  }
  return {
    documents,
    warnings: [...new Set(listWarnings)].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

/* c8 ignore stop */

/** Build an item-ID lookup of linked content for provider execution and reranking. */
async function collectLinkedCorpusById(
  includeLinked: boolean,
  effectiveMode: SearchMode,
  filteredDocuments: ItemDocument[],
): Promise<Map<string, string>> {
  const linkedCorpusById = new Map<string, string>();
  if (
    !includeLinked ||
    (effectiveMode !== "keyword" && effectiveMode !== "hybrid")
  ) {
    return linkedCorpusById;
  }
  const projectRoot = process.cwd();
  const linkedCorpusRoots = await resolveLinkedCorpusRoots(
    projectRoot,
    resolveGlobalPmRoot(projectRoot),
  );
  const linkedCorpusEntries = await Promise.all(
    filteredDocuments.map(
      async (document) =>
        [
          document.metadata.id,
          await loadLinkedCorpus(document, linkedCorpusRoots),
        ] as const,
    ),
  );
  for (const [id, corpus] of linkedCorpusEntries) {
    linkedCorpusById.set(id, corpus);
  }
  return linkedCorpusById;
}

export { collectLinkedCorpusById,collectLinkedPaths,loadDocuments,loadLinkedCorpus,resolveLinkedCorpusRoots };
