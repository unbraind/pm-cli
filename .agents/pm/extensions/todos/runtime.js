import fs from "node:fs/promises";
import path from "node:path";
import { getActiveExtensionRegistrations, runActiveOnReadHooks, runActiveOnWriteHooks } from "../../../../dist/core/extensions/index.js";
import { pathExists, removeFileIfExists, writeFileAtomic } from "../../../../dist/core/fs/fs-utils.js";
import { appendHistoryEntry, createHistoryEntry } from "../../../../dist/core/history/history.js";
import { generateItemId, normalizeItemId } from "../../../../dist/core/item/id.js";
import { canonicalDocument, normalizeFrontMatter, serializeItemDocument, splitFrontMatter } from "../../../../dist/core/item/item-format.js";
import { normalizeStatusInput } from "../../../../dist/core/item/status.js";
import { resolveItemTypeRegistry } from "../../../../dist/core/item/type-registry.js";
import { parseTags } from "../../../../dist/core/item/parse.js";
import { acquireLock } from "../../../../dist/core/lock/lock.js";
import { EXIT_CODE } from "../../../../dist/core/shared/constants.js";
import { PmCliError } from "../../../../dist/core/shared/errors.js";
import { nowIso } from "../../../../dist/core/shared/time.js";
import { listAllFrontMatter, locateItem, readLocatedItem } from "../../../../dist/core/store/item-store.js";
import { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../../../../dist/core/store/paths.js";
import { readSettings } from "../../../../dist/core/store/settings.js";
import { CONFIDENCE_TEXT_VALUES, ISSUE_SEVERITY_VALUES, RISK_VALUES } from "../../../../dist/types/index.js";
const DEFAULT_TODOS_FOLDER = ".pi/todos";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toNonEmptyString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function toIsoString(value) {
    const raw = toNonEmptyString(value);
    if (!raw) {
        return undefined;
    }
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) {
        return undefined;
    }
    return new Date(timestamp).toISOString();
}
function toEstimatedMinutes(value) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed;
        }
    }
    return undefined;
}
function toInteger(value) {
    if (typeof value === "number" && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) {
            return parsed;
        }
    }
    return undefined;
}
function toPriority(value) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 4) {
            return parsed;
        }
    }
    return 2;
}
function toConfidence(value) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) {
        return value;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
        return undefined;
    }
    if (normalized === "med") {
        return "medium";
    }
    if (CONFIDENCE_TEXT_VALUES.includes(normalized)) {
        return normalized;
    }
    const parsed = Number(normalized);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100) {
        return parsed;
    }
    return undefined;
}
function toNormalizedEnum(value, allowed) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
        return undefined;
    }
    const candidate = normalized === "med" ? "medium" : normalized;
    if (allowed.includes(candidate)) {
        return candidate;
    }
    return undefined;
}
function toBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "1") {
            return true;
        }
        if (normalized === "false" || normalized === "0") {
            return false;
        }
    }
    if (typeof value === "number") {
        if (value === 1) {
            return true;
        }
        if (value === 0) {
            return false;
        }
    }
    return undefined;
}
function toTags(value) {
    if (Array.isArray(value)) {
        const tags = value
            .filter((entry) => typeof entry === "string")
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry.length > 0);
        return Array.from(new Set(tags)).sort((left, right) => left.localeCompare(right));
    }
    if (typeof value === "string") {
        return parseTags(value);
    }
    return [];
}
function toItemType(value, typeNames) {
    const normalized = toNonEmptyString(value)?.toLowerCase();
    const fallbackType = typeNames.find((entry) => entry.toLowerCase() === "task") ?? typeNames[0] ?? "Task";
    if (!normalized) {
        return fallbackType;
    }
    for (const candidate of typeNames) {
        if (candidate.toLowerCase() === normalized) {
            return candidate;
        }
    }
    return fallbackType;
}
function toStatus(value) {
    const normalized = toNonEmptyString(value);
    if (normalized) {
        const canonical = normalizeStatusInput(normalized);
        if (canonical) {
            return canonical;
        }
    }
    return "open";
}
function selectAuthor(explicitAuthor, settingsAuthor) {
    const candidate = explicitAuthor ?? process.env.PM_AUTHOR ?? settingsAuthor;
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed : "unknown";
}
function ensureInitHasRun(pmRoot) {
    return pathExists(getSettingsPath(pmRoot)).then((exists) => {
        if (!exists) {
            throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
        }
    });
}
function normalizeBody(body) {
    return body.replace(/^\n+/, "").replace(/\s+$/, "");
}
function emptyDocument() {
    return {
        metadata: {},
        body: "",
    };
}
function resolveFolderPath(rawPath) {
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}
function parseTodoMarkdown(content) {
    const split = splitFrontMatter(content);
    if (split.frontMatter.length === 0) {
        throw new TypeError("Missing JSON front matter");
    }
    const parsed = JSON.parse(split.frontMatter);
    if (!isRecord(parsed)) {
        throw new TypeError("Front matter must be a JSON object");
    }
    return {
        frontMatter: parsed,
        body: normalizeBody(split.body),
    };
}
async function readTodoCandidate(sourceFolder, entry) {
    const sourcePath = path.join(sourceFolder, entry.name);
    let raw;
    try {
        raw = await fs.readFile(sourcePath, "utf8");
    }
    catch {
        return { warning: `todos_import_read_failed:${entry.name}` };
    }
    const readWarnings = await runActiveOnReadHooks({
        path: sourcePath,
        scope: "project",
    });
    let parsed;
    try {
        parsed = parseTodoMarkdown(raw);
    }
    catch {
        return { warning: `todos_import_invalid_front_matter:${entry.name}` };
    }
    return {
        entryName: entry.name,
        frontMatter: parsed.frontMatter,
        body: parsed.body,
        readWarnings,
    };
}
async function importTodoCandidate(candidate, runtime) {
    const title = toNonEmptyString(candidate.frontMatter.title);
    if (!title) {
        return { warning: `todos_import_missing_title:${candidate.entryName}` };
    }
    const explicitId = toNonEmptyString(candidate.frontMatter.id);
    const derivedId = path.basename(candidate.entryName, path.extname(candidate.entryName));
    // Hidden filenames (for example `.md`) do not provide stable human ids.
    const idSource = explicitId ?? (derivedId.startsWith(".") ? undefined : derivedId);
    const id = idSource
        ? normalizeItemId(idSource, runtime.settings.id_prefix)
        : await generateItemId(runtime.pmRoot, runtime.settings.id_prefix);
    const createdAt = toIsoString(candidate.frontMatter.created_at) ?? nowIso();
    const updatedAt = toIsoString(candidate.frontMatter.updated_at) ?? createdAt;
    const type = toItemType(candidate.frontMatter.type, runtime.typeNames);
    const located = await locateItem(runtime.pmRoot, id, runtime.settings.id_prefix, runtime.settings.item_format, runtime.typeToFolder);
    if (located) {
        return { warning: `todos_import_item_exists:${id}` };
    }
    const itemPath = getItemPath(runtime.pmRoot, type, id, "toon", runtime.typeToFolder);
    const afterDocument = canonicalDocument({
        metadata: normalizeFrontMatter({
            id,
            title,
            description: toNonEmptyString(candidate.frontMatter.description) ?? "",
            type,
            status: toStatus(candidate.frontMatter.status),
            priority: toPriority(candidate.frontMatter.priority),
            confidence: toConfidence(candidate.frontMatter.confidence),
            tags: toTags(candidate.frontMatter.tags),
            created_at: createdAt,
            updated_at: updatedAt,
            deadline: toIsoString(candidate.frontMatter.deadline),
            assignee: toNonEmptyString(candidate.frontMatter.assignee),
            author: toNonEmptyString(candidate.frontMatter.author) ?? runtime.author,
            estimated_minutes: toEstimatedMinutes(candidate.frontMatter.estimated_minutes),
            acceptance_criteria: toNonEmptyString(candidate.frontMatter.acceptance_criteria),
            definition_of_ready: toNonEmptyString(candidate.frontMatter.definition_of_ready),
            order: toInteger(candidate.frontMatter.order),
            goal: toNonEmptyString(candidate.frontMatter.goal),
            objective: toNonEmptyString(candidate.frontMatter.objective),
            value: toNonEmptyString(candidate.frontMatter.value),
            impact: toNonEmptyString(candidate.frontMatter.impact),
            outcome: toNonEmptyString(candidate.frontMatter.outcome),
            why_now: toNonEmptyString(candidate.frontMatter.why_now),
            parent: toNonEmptyString(candidate.frontMatter.parent),
            reviewer: toNonEmptyString(candidate.frontMatter.reviewer),
            risk: toNormalizedEnum(candidate.frontMatter.risk, RISK_VALUES),
            sprint: toNonEmptyString(candidate.frontMatter.sprint),
            release: toNonEmptyString(candidate.frontMatter.release),
            blocked_by: toNonEmptyString(candidate.frontMatter.blocked_by),
            blocked_reason: toNonEmptyString(candidate.frontMatter.blocked_reason),
            unblock_note: toNonEmptyString(candidate.frontMatter.unblock_note),
            reporter: toNonEmptyString(candidate.frontMatter.reporter),
            severity: toNormalizedEnum(candidate.frontMatter.severity, ISSUE_SEVERITY_VALUES),
            environment: toNonEmptyString(candidate.frontMatter.environment),
            repro_steps: toNonEmptyString(candidate.frontMatter.repro_steps),
            resolution: toNonEmptyString(candidate.frontMatter.resolution),
            expected_result: toNonEmptyString(candidate.frontMatter.expected_result),
            actual_result: toNonEmptyString(candidate.frontMatter.actual_result),
            affected_version: toNonEmptyString(candidate.frontMatter.affected_version),
            fixed_version: toNonEmptyString(candidate.frontMatter.fixed_version),
            component: toNonEmptyString(candidate.frontMatter.component),
            regression: toBoolean(candidate.frontMatter.regression),
            customer_impact: toNonEmptyString(candidate.frontMatter.customer_impact),
            close_reason: toNonEmptyString(candidate.frontMatter.close_reason),
            dependencies: Array.isArray(candidate.frontMatter.dependencies) ? candidate.frontMatter.dependencies : undefined,
            comments: Array.isArray(candidate.frontMatter.comments) ? candidate.frontMatter.comments : undefined,
            notes: Array.isArray(candidate.frontMatter.notes) ? candidate.frontMatter.notes : undefined,
            learnings: Array.isArray(candidate.frontMatter.learnings) ? candidate.frontMatter.learnings : undefined,
            files: Array.isArray(candidate.frontMatter.files) ? candidate.frontMatter.files : undefined,
            docs: Array.isArray(candidate.frontMatter.docs) ? candidate.frontMatter.docs : undefined,
            tests: Array.isArray(candidate.frontMatter.tests) ? candidate.frontMatter.tests : undefined,
        }),
        body: candidate.body,
    });
    const historyPath = getHistoryPath(runtime.pmRoot, id);
    let writeWarnings = [];
    try {
        const releaseLock = await acquireLock(runtime.pmRoot, id, runtime.settings.locks.ttl_seconds, runtime.author);
        try {
            await writeFileAtomic(itemPath, serializeItemDocument(afterDocument, { format: "toon" }));
            try {
                const historyEntry = createHistoryEntry({
                    nowIso: nowIso(),
                    author: runtime.author,
                    op: "import",
                    before: emptyDocument(),
                    after: afterDocument,
                    message: runtime.message,
                });
                await appendHistoryEntry(historyPath, historyEntry);
                writeWarnings = [
                    ...(await runActiveOnWriteHooks({
                        path: itemPath,
                        scope: "project",
                        op: "import",
                    })),
                    ...(await runActiveOnWriteHooks({
                        path: historyPath,
                        scope: "project",
                        op: "import:history",
                    })),
                ];
            }
            catch (error) {
                await removeFileIfExists(itemPath);
                throw error;
            }
        }
        finally {
            await releaseLock();
        }
    }
    catch (error) {
        if (error instanceof PmCliError && error.exitCode === EXIT_CODE.CONFLICT) {
            return { warning: `todos_import_lock_conflict:${id}` };
        }
        throw error;
    }
    return { id, writeWarnings };
}
export async function runTodosImport(options, global) {
    const pmRoot = resolvePmRoot(process.cwd(), global.path);
    await ensureInitHasRun(pmRoot);
    const settings = await readSettings(pmRoot);
    const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
    const folder = toNonEmptyString(options.folder) ?? DEFAULT_TODOS_FOLDER;
    const sourceFolder = resolveFolderPath(folder);
    let entries;
    try {
        entries = await fs.readdir(sourceFolder, { withFileTypes: true });
    }
    catch {
        throw new PmCliError(`Todos source folder not found at ${sourceFolder}`, EXIT_CODE.NOT_FOUND);
    }
    const author = selectAuthor(toNonEmptyString(options.author), settings.author_default);
    const message = toNonEmptyString(options.message) ?? "Import from todos markdown";
    const warnings = [
        ...(await runActiveOnReadHooks({
            path: sourceFolder,
            scope: "project",
        })),
    ];
    const ids = [];
    let imported = 0;
    let skipped = 0;
    const markdownFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .sort((left, right) => left.name.localeCompare(right.name));
    const runtime = {
        pmRoot,
        sourceFolder,
        settings,
        typeNames: typeRegistry.types,
        typeToFolder: typeRegistry.type_to_folder,
        author,
        message,
    };
    for (const entry of markdownFiles) {
        const candidate = await readTodoCandidate(sourceFolder, entry);
        if ("warning" in candidate) {
            warnings.push(candidate.warning);
            skipped += 1;
            continue;
        }
        warnings.push(...candidate.readWarnings);
        const importedCandidate = await importTodoCandidate(candidate, runtime);
        if ("warning" in importedCandidate) {
            warnings.push(importedCandidate.warning);
            skipped += 1;
            continue;
        }
        warnings.push(...importedCandidate.writeWarnings);
        ids.push(importedCandidate.id);
        imported += 1;
    }
    return {
        ok: true,
        folder,
        imported,
        skipped,
        ids,
        warnings,
    };
}
export async function runTodosExport(options, global) {
    const pmRoot = resolvePmRoot(process.cwd(), global.path);
    await ensureInitHasRun(pmRoot);
    const settings = await readSettings(pmRoot);
    const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
    const folder = toNonEmptyString(options.folder) ?? DEFAULT_TODOS_FOLDER;
    const destinationFolder = resolveFolderPath(folder);
    await fs.mkdir(destinationFolder, { recursive: true });
    const warnings = [];
    const ids = [];
    let exported = 0;
    const items = await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder);
    const sorted = [...items].sort((left, right) => left.id.localeCompare(right.id));
    for (const item of sorted) {
        const located = await locateItem(pmRoot, item.id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
        if (!located) {
            warnings.push(`todos_export_missing_item:${item.id}`);
            continue;
        }
        try {
            const { document } = await readLocatedItem(located);
            const todoFrontMatter = { ...document.metadata };
            const frontMatter = JSON.stringify(todoFrontMatter, null, 2);
            const body = normalizeBody(document.body);
            const serialized = body.length > 0 ? `${frontMatter}\n\n${body}\n` : `${frontMatter}\n`;
            const exportPath = path.join(destinationFolder, `${document.metadata.id}.md`);
            await writeFileAtomic(exportPath, serialized);
            warnings.push(...(await runActiveOnWriteHooks({
                path: exportPath,
                scope: "project",
                op: "todos:export",
            })));
            ids.push(document.metadata.id);
            exported += 1;
        }
        catch {
            warnings.push(`todos_export_read_failed:${item.id}`);
        }
    }
    return {
        ok: true,
        folder,
        exported,
        ids,
        warnings,
    };
}