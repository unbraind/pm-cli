/** @module core/extensions/version-diagnostics Target-specific recovery for enabled and disabled package version bounds. */
import { renderPmCommand } from "../../sdk/command-line.js";

/** Explain one version-bound finding without changing package enablement or compatibility policy. */
export function extensionVersionRemediation(warning: string): string | undefined {
  const match = /^extension_(disabled_)?pm_(min|max)_version_([a-z_]+):(project|global):([^:]+):(.+)$/u.exec(warning);
  if (!match) return undefined;
  const [, disabled, bound, status, scope, name, details] = match;
  const constraint = details.split(":")[0].replace(bound === "min" ? "required=" : "allowed=", "");
  const requirement = status === "invalid" ? `a valid pm_${bound}_version instead of ${constraint}` : `pm ${bound === "min" ? ">=" : "<="} ${constraint}`;
  if (disabled) {
    return `Package ${name} is disabled and requires ${requirement} before activation. After satisfying the bound, run ${renderPmCommand(["package", "activate", name, `--${scope}`])}.`;
  }
  return `Package ${name} requires ${requirement}. Use a compatible host or package version, or keep it disabled with ${renderPmCommand(["package", "deactivate", name, `--${scope}`])}.`;
}
