import { pathExists } from "../../core/fs/fs-utils.js";
import { parseCsvKv } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { SCOPE_VALUES } from "../../types/index.js";
import type { LinkedDoc, LinkScope } from "../../types/index.js";

export interface DocsCommandOptions {
  add?: string[];
  remove?: string[];
  author?: string;
  message?: string;
  force?: boolean;
}

export interface DocsResult {
  id: string;
  docs: LinkedDoc[];
  changed: boolean;
  count: number;
}

function resolveAuthor(candidate: string | undefined, fallback: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? fallback;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function ensureScope(raw: string | undefined): LinkScope {
  const value = (raw ?? "project") as LinkScope;
  if (!SCOPE_VALUES.includes(value)) {
    throw new PmCliError(`Invalid scope "${raw}"`, EXIT_CODE.USAGE);
  }
  return value;
}

function parseAddEntries(raw: string[] | undefined): LinkedDoc[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const kv = parseCsvKv(entry, "--add");
    if (!kv.path) {
      throw new PmCliError("--add requires path=<value>", EXIT_CODE.USAGE);
    }
    return {
      path: kv.path,
      scope: ensureScope(kv.scope),
      note: kv.note?.trim() || undefined,
    };
  });
}

function parseRemoveEntries(raw: string[] | undefined): string[] {
  if (!raw) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError("--remove requires a path value", EXIT_CODE.USAGE);
    }
    if (trimmed.includes("=")) {
      const kv = parseCsvKv(trimmed, "--remove");
      if (!kv.path) {
        throw new PmCliError("--remove key/value form requires path=<value>", EXIT_CODE.USAGE);
      }
      return kv.path;
    }
    return trimmed;
  });
}

export async function runDocs(id: string, options: DocsCommandOptions, global: GlobalOptions): Promise<DocsResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const adds = parseAddEntries(options.add);
  const removes = parseRemoveEntries(options.remove);
  const shouldMutate = adds.length > 0 || removes.length > 0;

  if (!shouldMutate) {
    const located = await locateItem(pmRoot, id, settings.id_prefix);
    if (!located) {
      throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
    }
    const loaded = await readLocatedItem(located);
    const docs = loaded.document.front_matter.docs ?? [];
    return {
      id: located.id,
      docs,
      changed: false,
      count: docs.length,
    };
  }

  const author = resolveAuthor(options.author, settings.author_default);
  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "docs_add",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      const next = [...(document.front_matter.docs ?? [])];
      for (const add of adds) {
        const exists = next.some((entry) => entry.path === add.path && entry.scope === add.scope);
        if (!exists) {
          next.push(add);
        }
      }
      if (removes.length > 0) {
        for (let i = next.length - 1; i >= 0; i -= 1) {
          if (removes.includes(next[i].path)) {
            next.splice(i, 1);
          }
        }
      }
      document.front_matter.docs = next;
      return { changedFields: ["docs"] };
    },
  });

  const docs = result.item.docs ?? [];
  return {
    id: result.item.id,
    docs,
    changed: true,
    count: docs.length,
  };
}
