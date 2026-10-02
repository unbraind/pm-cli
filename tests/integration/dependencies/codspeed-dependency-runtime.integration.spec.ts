import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.resolve("@codspeed/vitest-plugin"));
const coreRoot = path.dirname(path.dirname(require.resolve("@codspeed/core")));
const coreRequire = createRequire(path.join(coreRoot, "package.json"));
const axiosVersion = (JSON.parse(await readFile(coreRequire.resolve("axios/package.json"), "utf8")) as { version: string }).version;

describe("CodSpeed patched dependency runtime", () => {
  it.each(["cjs", "es5"])("preserves %s public contracts and performs real audited HTTP requests", async (entry) => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-codspeed-runtime-"));
    const requests: Array<{ method?: string; url?: string; body: unknown; agent?: string; applicationHeader?: string | string[] }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { mongoUrl?: string };
        requests.push({ method: request.method, url: request.url, body: parsed, agent: request.headers["user-agent"], applicationHeader: request.headers["x-application-client"] });
        response.setHeader("Content-Type", "application/json");
        response.statusCode = parsed.mongoUrl === "reject" ? 500 : 200;
        response.end(JSON.stringify(parsed.mongoUrl === "reject" ? { error: "test failure" } : { remoteAddr: "mongodb://127.0.0.1:27017" }));
      });
    });
    try {
      await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing loopback listener address");
      const moduleUrl = pathToFileURL(path.join(coreRoot, `dist/index.${entry}.js`)).href;
      const childFile = path.join(root, "probe.mjs");
      await writeFile(childFile, [
        "import assert from 'node:assert/strict';",
        `import applicationAxios from ${JSON.stringify(pathToFileURL(entry === "cjs" ? coreRequire.resolve("axios") : path.join(path.dirname(coreRequire.resolve("axios/package.json")), "index.js")).href)};`,
        entry === "cjs"
          ? `import { createRequire } from 'node:module'; const core = createRequire(import.meta.url)(${JSON.stringify(path.join(coreRoot, `dist/index.${entry}.js`))});`
          : `import * as core from ${JSON.stringify(moduleUrl)};`,
        "applicationAxios.interceptors.request.use(config => { config.headers.set('X-Application-Client', 'intercepted'); return config; });",
        "applicationAxios.interceptors.response.use(response => response.data);",
        "assert.equal(core.msToNs(2), 2_000_000);",
        "assert.equal(core.nsToMs(2_000_000), 2);",
        "assert.equal(core.msToS(2000), 2);",
        "assert.equal(core.wrapWithRootFrameSync(() => 42)(), 42);",
        "assert.equal(await core.wrapWithRootFrame(async () => 43)(), 43);",
        "assert.deepEqual([core.MARKER_TYPE_SAMPLE_START, core.MARKER_TYPE_SAMPLE_END, core.MARKER_TYPE_BENCHMARK_START, core.MARKER_TYPE_BENCHMARK_END], [0, 1, 2, 3]);",
        "assert.deepEqual(core.getV8Flags(), ['--interpreted-frames-native-stack', '--allow-natives-syntax']);",
        "assert.equal(Object.keys(core).length, 26);",
        "const setup = await core.mongoMeasurement.setupInstruments({ mongoUrl: 'mongodb://127.0.0.1:27017' });",
        "assert.equal(setup.remoteAddr, 'mongodb://127.0.0.1:27017');",
        "await core.mongoMeasurement.start('probe');",
        "await core.mongoMeasurement.stop('probe');",
        "await assert.rejects(core.mongoMeasurement.setupInstruments({ mongoUrl: 'reject' }), { name: 'ApiError', status: 500, body: { error: 'test failure' } });",
        "process.stdout.write('runtime verified');",
      ].join("\n"));
      const child = spawn(process.execPath, [childFile], {
        cwd: root,
        env: { ...process.env, CODSPEED_RUNNER_MODE: "disabled", CODSPEED_MONGO_INSTR_SERVER_ADDRESS: `http://127.0.0.1:${address.port}`, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code, stderr).toBe(0);
      expect(stdout).toBe("runtime verified");
      expect(requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
        { method: "POST", url: "/instruments/setup", body: { mongoUrl: "mongodb://127.0.0.1:27017" } },
        { method: "POST", url: "/benchmark/start", body: { uri: "probe" } },
        { method: "POST", url: "/benchmark/stop", body: { uri: "probe" } },
        { method: "POST", url: "/instruments/setup", body: { mongoUrl: "reject" } },
      ]);
      expect(requests.every(({ agent }) => agent === `axios/${axiosVersion}`)).toBe(true);
      expect(requests.every(({ applicationHeader }) => applicationHeader === undefined)).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await rm(root, { recursive: true, force: true });
    }
  });
});
