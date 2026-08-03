/**
 * @module SDK extension diagnostics for custom fields that shadow MCP inputs.
 */

import { resolvePmToolCustomFieldCollision } from "../cli-contracts/tool-schema.js";
import type { activateExtensions } from "../../core/extensions/index.js";

/** Report extension and extension-profile fields shadowed by canonical MCP inputs. */
export const collectMcpCustomFieldCollisionDoctorWarnings = (
  activationResult: Awaited<ReturnType<typeof activateExtensions>>,
): string[] =>
  [
    ...activationResult.registrations.item_fields.flatMap((registration) =>
      registration.fields.map((field) => ({
        layer: registration.layer,
        extension: registration.name,
        field: field.name,
      })),
    ),
    ...activationResult.registrations.profiles.flatMap((registration) =>
      registration.profile.fields.map((field) => ({
        layer: registration.layer,
        extension: registration.name,
        field: field.key ?? "",
      })),
    ),
  ]
    .flatMap((entry) => {
      const collision = resolvePmToolCustomFieldCollision(entry.field);
      return collision
        ? [
            `extension_custom_field_mcp_input_collision:${entry.layer}:${entry.extension}:${collision.field}:${collision.property}:${collision.owner}:use=${collision.nested_path}`,
          ]
        : [];
    })
    .filter((warning, index, warnings) => warnings.indexOf(warning) === index)
    .sort((left, right) => left.localeCompare(right));
