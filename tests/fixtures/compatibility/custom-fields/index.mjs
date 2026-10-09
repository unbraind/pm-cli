/** Register fixture fields from data without constructing executable source. */
import { readFileSync } from "node:fs";

/** Activate the same static extension module in each isolated workspace. */
export function activate(api) {
  api.registerItemFields(JSON.parse(readFileSync(new URL("./fields.json", import.meta.url), "utf8")));
}
