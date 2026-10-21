import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.resolve("vitest/package.json"));
const mockerUrl = pathToFileURL(require.resolve("@vitest/mocker/node")).href;

function runProbe(source: string): void {
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source, mockerUrl], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
}

describe("Vitest public mocker advisory boundaries", () => {
  it("keeps URLs and unusual export names as data through asynchronous rebinding", () => {
    runProbe(String.raw`
      import assert from "node:assert/strict";
      const { createManualModuleSource } = await import(process.argv[1]);
      for (const [url, name] of [
        ["/ordinary-module.js", "value"],
        ['module");globalThis.__unexpected = 1;//', "value"],
        ["/module\\with-quotes\".js", 'export"with\\slashes'],
        ["/unicode-module.js", "line\nbreak\u2028name"],
      ]) {
        let resolveFactory;
        const pending = new Promise(resolve => { resolveFactory = resolve; });
        const factory = { [name]: 3, __factoryPromise: pending };
        let received;
        globalThis.__vitest_mocker__ = { getFactoryModule(value) { received = value; return factory; } };
        const code = createManualModuleSource(url, [name]);
        const module = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
        assert.equal(globalThis.__unexpected, undefined);
        assert.equal(received, url);
        assert.equal(module[name], 3);
        resolveFactory({ [name]: 5 });
        await pending;
        assert.equal(module[name], 5);
      }
    `);
  });

  it("rejects backslash and slash escapes while retaining an allowed redirect", () => {
    runProbe(String.raw`
      import assert from "node:assert/strict";
      import { resolve } from "node:path";
      const { interceptorPlugin } = await import(process.argv[1]);
      const root = resolve("vitest-advisory-root").replaceAll("\\", "/");
      for (const [redirect, allowed] of [
        ["mock:/allowed.js", true],
        ["mock:../outside.js", false],
        ["mock:..\\outside.js", false],
        ["mock:nested/..\\..\\outside.js", false],
      ]) {
        const registered = [];
        const handlers = new Map();
        const plugin = interceptorPlugin({ registry: { register: value => registered.push(value) } });
        plugin.configureServer({
          config: { root, server: { fs: { strict: true, allow: [root] } }, safeModulePaths: new Set(), fsDenyGlob: () => false },
          ws: { on: (event, handler) => handlers.set(event, handler), send() {} },
        });
        handlers.get("vitest:interceptor:register")({ type: "redirect", raw: "/request.js", url: "/request.js", redirect });
        assert.equal(registered.length, allowed ? 1 : 0, redirect);
        if (allowed) assert.equal(registered[0].redirect, root + "/allowed.js");
      }
    `);
  });
});
