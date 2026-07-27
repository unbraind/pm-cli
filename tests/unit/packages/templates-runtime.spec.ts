import { describe, expect, it, vi } from "vitest";
import * as sdk from "../../../src/sdk/index.js";
import {
  loadCreateTemplateOptions,
  runTemplatesList,
  runTemplatesSave,
  runTemplatesShow,
} from "../../../packages/pm-templates/extensions/templates/runtime.ts";

describe("templates package static SDK runtime", () => {
  it("delegates every template operation without a loader shim", async () => {
    const options = { title: "Template" };
    const saved = { name: "demo" } as never;
    const listed = { templates: ["demo"], count: 1, builtin_templates: [], user_templates: ["demo"] };
    const shown = { name: "demo" } as never;
    const load = vi.spyOn(sdk, "loadCreateTemplateOptions").mockResolvedValue(options);
    const save = vi.spyOn(sdk, "runTemplatesSave").mockResolvedValue(saved);
    const list = vi.spyOn(sdk, "runTemplatesList").mockResolvedValue(listed);
    const show = vi.spyOn(sdk, "runTemplatesShow").mockResolvedValue(shown);

    await expect(loadCreateTemplateOptions("/tmp/pm", "demo")).resolves.toBe(options);
    expect(load).toHaveBeenCalledWith("/tmp/pm", "demo");
    await expect(runTemplatesSave("demo", options, { path: "/tmp/pm" })).resolves.toBe(saved);
    expect(save).toHaveBeenCalledWith("demo", options, { path: "/tmp/pm" });
    await expect(runTemplatesList({ path: "/tmp/pm" })).resolves.toBe(listed);
    expect(list).toHaveBeenCalledWith({ path: "/tmp/pm" });
    await expect(runTemplatesShow("demo", { path: "/tmp/pm" })).resolves.toBe(shown);
    expect(show).toHaveBeenCalledWith("demo", { path: "/tmp/pm" });
    vi.restoreAllMocks();
  });
});
