/**
 * @module core/session/session-state
 *
 * Maintains lightweight agent session state for contextual workflows.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../fs/fs-utils.js";
import { getRuntimePath } from "../store/paths.js";

/**
 * Session-local, gitignored state stored under `.agents/pm/runtime/session.json`.
 *
 * This is intentionally NOT the git-tracked settings.json: it holds ephemeral
 * per-checkout context (currently the "focused" parent item used as a default
 * --parent for `pm create`). Missing or corrupt state is treated as empty so a
 * stale or hand-edited file never blocks a command.
 */
export interface SessionState {
  focused_item?: string;
}

const SESSION_FILENAME = "session.json";

/**
 * Implements get session state path for the public runtime surface of this module.
 */
export function getSessionStatePath(pmRoot: string): string {
  return path.join(getRuntimePath(pmRoot), SESSION_FILENAME);
}

/**
 * Implements read session state for the public runtime surface of this module.
 */
export async function readSessionState(pmRoot: string): Promise<SessionState> {
  try {
    const raw = await fs.readFile(getSessionStatePath(pmRoot), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const focused = (parsed as Record<string, unknown>).focused_item;
    if (typeof focused === "string" && focused.trim().length > 0) {
      return { focused_item: focused };
    }
    return {};
  } catch {
    return {};
  }
}

async function writeSessionState(pmRoot: string, state: SessionState): Promise<void> {
  const target = getSessionStatePath(pmRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, JSON.stringify(state));
}

/**
 * Implements get focused item for the public runtime surface of this module.
 */
export async function getFocusedItem(pmRoot: string): Promise<string | undefined> {
  const state = await readSessionState(pmRoot);
  return state.focused_item;
}

/**
 * Implements set focused item for the public runtime surface of this module.
 */
export async function setFocusedItem(pmRoot: string, id: string): Promise<void> {
  const state = await readSessionState(pmRoot);
  await writeSessionState(pmRoot, { ...state, focused_item: id });
}

/**
 * Implements clear focused item for the public runtime surface of this module.
 */
export async function clearFocusedItem(pmRoot: string): Promise<void> {
  const state = await readSessionState(pmRoot);
  const next: SessionState = { ...state };
  delete next.focused_item;
  await writeSessionState(pmRoot, next);
}
