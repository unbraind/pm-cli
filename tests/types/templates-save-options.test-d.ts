/** @module tests/types/templates-save-options.test-d Template priority inputs (pm-gh1561). */
import { runTemplatesSave, type TemplatesSaveOptions } from "@unbrained/pm-cli/sdk/runtime";
import { runTemplatesSave as rootSave, type TemplatesSaveOptions as RootOptions } from "@unbrained/pm-cli/sdk";

const options: TemplatesSaveOptions = { type: "Task", priority: 0, customer: "example" };
const rootOptions: RootOptions = options;
void runTemplatesSave("numeric", options, {});
void rootSave("named", { ...rootOptions, priority: "critical" }, {});
// @ts-expect-error boolean priorities must fail before runtime
void runTemplatesSave("invalid", { priority: false }, {});
// @ts-expect-error array priorities are unsupported
void rootSave("invalid", { priority: ["0"] }, {});
