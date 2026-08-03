/**
 * @module sdk/extension/runtime-summary
 *
 * Projects activated package command registrations into stable install output.
 */
import { normalizeExtensionNameForMatch } from "./shared.js";

/** Return stable runtime command and action paths registered by one extension. */
export function summarizeRuntimeCommandPathsForExtension(
  extensionName: string,
  installed: ReadonlyArray<{
    name: string;
    command_paths?: string[];
    action_paths?: string[];
  }>,
): { command_paths: string[]; action_paths: string[] } {
  const normalizedName = normalizeExtensionNameForMatch(extensionName);
  const entry = installed.find(
    (candidate) =>
      normalizeExtensionNameForMatch(candidate.name) === normalizedName,
  );
  return {
    command_paths: [...(entry?.command_paths ?? [])].sort((left, right) =>
      left.localeCompare(right),
    ),
    action_paths: [...(entry?.action_paths ?? [])].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}
