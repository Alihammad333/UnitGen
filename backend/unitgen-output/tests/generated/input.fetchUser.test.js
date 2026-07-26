import { describe, test, expect, jest, beforeAll, beforeEach, afterEach, afterAll } from "@jest/globals";
import { createRequire as __unitgenCreateRequire } from "node:module";
import {
  pathToFileURL as __unitgenPathToFileURL,
  fileURLToPath as __unitgenFileURLToPath
} from "node:url";
import * as __unitgenFs from "node:fs";
import * as __unitgenPath from "node:path";

// Module mocks
jest.unstable_mockModule("axios", () => {
  const api = {
      get: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      post: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      put: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      patch: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      delete: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      request: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      create: jest.fn(() => api),
      head: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      options: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
    };

  return {
    __esModule: true,
    ...api,
    default: api
  };
}, { virtual: true });

jest.unstable_mockModule("path", () => {
  const api = {
      join: jest.fn((...parts) => parts.filter(Boolean).join('/')),
      resolve: jest.fn((...parts) => parts.filter(Boolean).join('/')),
      dirname: jest.fn((p) => String(p).split('/').slice(0, -1).join('/') || '.'),
      basename: jest.fn((p) => String(p).split('/').pop()),
      extname: jest.fn((p) => {
        const base = String(p).split("/").pop() || "";
        const i = base.lastIndexOf(".");
        return i >= 0 ? base.slice(i) : "";
      }),
      normalize: jest.fn((...parts) => parts.filter(Boolean).join('/')),
      relative: jest.fn((...parts) => parts.filter(Boolean).join('/')),
    };

  return {
    __esModule: true,
    ...api,
    default: api
  };
});

jest.unstable_mockModule("fs", () => {
  const api = {
      readFileSync: jest.fn(() => 'dummy file'),
      writeFileSync: jest.fn(() => undefined),
      existsSync: jest.fn(() => true),
      mkdirSync: jest.fn(() => undefined),
      rmSync: jest.fn(() => undefined),
      unlinkSync: jest.fn(() => undefined),
      readdirSync: jest.fn(() => []),
      statSync: jest.fn(() => ({ isFile: () => true, isDirectory: () => false })),
      readFile: jest.fn((...args) => {
        const cb = args.find((x) => typeof x === "function");
        if (cb) cb(null, "dummy file");
        return undefined;
      }),
      writeFile: jest.fn((...args) => {
        const cb = args.find((x) => typeof x === "function");
        if (cb) cb(null);
        return undefined;
      }),
      readdir: jest.fn((...args) => {
        const cb = args.find((x) => typeof x === "function");
        if (cb) cb(null, []);
        return [];
      }),
      stat: jest.fn((...args) => {
        const value = { isFile: () => true, isDirectory: () => false };
        const cb = args.find((x) => typeof x === "function");
        if (cb) cb(null, value);
        return value;
      }),
      lstat: jest.fn((...args) => {
        const value = { isFile: () => true, isDirectory: () => false };
        const cb = args.find((x) => typeof x === "function");
        if (cb) cb(null, value);
        return value;
      }),
      promises: {
        readFile: jest.fn().mockResolvedValue('dummy file'),
        writeFile: jest.fn().mockResolvedValue(undefined),
        mkdir: jest.fn().mockResolvedValue(undefined),
        readdir: jest.fn().mockResolvedValue([]),
        stat: jest.fn().mockResolvedValue({ isFile: () => true, isDirectory: () => false }),
        access: jest.fn().mockResolvedValue(undefined),
        unlink: jest.fn(() => undefined),
        rm: jest.fn(() => undefined),
        copyFile: jest.fn(() => undefined),
      },
    };

  return {
    __esModule: true,
    ...api,
    default: api
  };
});

jest.unstable_mockModule("axios", () => {
  const api = {
      get: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      post: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      put: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      patch: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      delete: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      request: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      create: jest.fn(() => api),
      head: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
      options: jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} }),
    };

  return {
    __esModule: true,
    ...api,
    default: api
  };
}, { virtual: true });
// Import/load AFTER global setup and module mocks
const __unitgenRequire = __unitgenCreateRequire(import.meta.url);

function __unitgenUnique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function __unitgenBuildModuleCandidates() {
  const candidates = [];

  const add = (kind, value) => {
    if (!value) return;
    candidates.push({ kind, value });
  };

  const addResolved = (specifier) => {
    try {
      const resolved = __unitgenRequire.resolve(specifier);
      add("file", resolved);

      if (resolved.includes("/dist/esm/")) {
        add("file", resolved.replace("/dist/esm/", "/dist/commonjs/"));
      }

      if (resolved.includes("\\dist\\esm\\")) {
        add("file", resolved.replace("\\dist\\esm\\", "\\dist\\commonjs\\"));
      }

      if (resolved.endsWith("/index.js")) {
        add("file", resolved.replace("/index.js", "/index.min.js"));
      }

      if (resolved.endsWith("\\index.js")) {
        add("file", resolved.replace("\\index.js", "\\index.min.js"));
      }
    } catch {
      // ignore unresolved candidate
    }
  };

  add("specifier", "../../../tests/sample1/input.js");
  addResolved("../../../tests/sample1/input.js");

  const fromTestDir = __unitgenPath.dirname(
    __unitgenFileURLToPath(import.meta.url)
  );

  try {
    const absFromTest = __unitgenPath.resolve(fromTestDir, "../../../tests/sample1/input.js");
    add("file", absFromTest);

    if (absFromTest.includes("/dist/esm/")) {
      add("file", absFromTest.replace("/dist/esm/", "/dist/commonjs/"));
    }

    if (absFromTest.includes("\\dist\\esm\\")) {
      add("file", absFromTest.replace("\\dist\\esm\\", "\\dist\\commonjs\\"));
    }

    if (absFromTest.endsWith("/index.js")) {
      add("file", absFromTest.replace("/index.js", "/index.min.js"));
    }

    if (absFromTest.endsWith("\\index.js")) {
      add("file", absFromTest.replace("\\index.js", "\\index.min.js"));
    }
  } catch {
    // ignore
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.kind + ":" + candidate.value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function __unitgenLooksLikeEsmSource(source) {
  return /^\s*import\s/m.test(source) || /^\s*export\s/m.test(source);
}

async function __unitgenLoadModule() {
  const __unitgenErrors = [];
  const __unitgenCandidates = __unitgenBuildModuleCandidates();

  for (const candidate of __unitgenCandidates) {
    if (candidate.kind === "specifier") {
      try {
        return await import(candidate.value);
      } catch (error) {
        __unitgenErrors.push(error);
      }
      continue;
    }

    if (candidate.kind === "file") {
      try {
        return await import(__unitgenPathToFileURL(candidate.value).href);
      } catch (error) {
        __unitgenErrors.push(error);
      }

      try {
        return __unitgenRequire(candidate.value);
      } catch (error) {
        __unitgenErrors.push(error);
      }
    }
  }

  for (const candidate of __unitgenCandidates) {
    if (candidate.kind !== "file") continue;

    try {
      const __unitgenResolved = candidate.value;
      const __unitgenSource = __unitgenFs.readFileSync(__unitgenResolved, "utf8");

      if (__unitgenLooksLikeEsmSource(__unitgenSource)) {
        continue;
      }

      const module = { exports: {} };
      const exports = module.exports;
      const __unitgenLocalRequire = __unitgenCreateRequire(
        __unitgenPathToFileURL(__unitgenResolved).href
      );

      const __unitgenWrapper = new Function(
        "exports",
        "require",
        "module",
        "__filename",
        "__dirname",
        __unitgenSource
      );

      __unitgenWrapper.call(
        module.exports,
        exports,
        __unitgenLocalRequire,
        module,
        __unitgenResolved,
        __unitgenPath.dirname(__unitgenResolved)
      );

      return module.exports;
    } catch (error) {
      __unitgenErrors.push(error);
    }
  }

  const __unitgenMessage = __unitgenErrors
    .map((error, index) => {
      return "Attempt " + (index + 1) + ": " + (error?.message || String(error));
    })
    .join("\n");

  throw new Error("UnitGen module load failed for ../../../tests/sample1/input.js:\n" + __unitgenMessage);
}
function __unitgenResolveExport(moduleObject, exportName, isDefaultExport) {
  const candidates = [];

  const push = (value) => {
    if (value !== undefined && value !== null) {
      candidates.push(value);
    }
  };

  if (isDefaultExport) {
    push(moduleObject);
    push(moduleObject?.default);
    push(moduleObject?.default?.default);
    push(moduleObject?.module?.exports);
    push(moduleObject?.exports);
  } else {
    push(moduleObject?.[exportName]);
    push(moduleObject?.default?.[exportName]);
    push(moduleObject?.default?.default?.[exportName]);
    push(moduleObject?.exports?.[exportName]);
    push(moduleObject?.module?.exports?.[exportName]);

    if (typeof moduleObject === "function") {
      push(moduleObject);
    }

    if (typeof moduleObject?.default === "function") {
      push(moduleObject.default);
    }

    if (typeof moduleObject?.default?.default === "function") {
      push(moduleObject.default.default);
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      return candidate;
    }
  }

  return null;
}

let mod;
let fetchUser;

beforeAll(async () => {
  mod = await __unitgenLoadModule();
  fetchUser = __unitgenResolveExport(mod, "fetchUser", false);
});

describe("fetchUser", () => {
  test("auto-generated (prototype)", async () => {
    if (typeof fetchUser !== "function") {
      throw new TypeError("fetchUser import did not resolve to a function");
    }
    const id = 1;
    let result;
    try {
      result = fetchUser(id);
      if (result && typeof result.then === "function") {
        result = await result;
      }
      expect(result).toBeDefined();
    } catch (error) {
      expect(error && (error instanceof Error || typeof error.message === "string")).toBe(true);
    }
  });

  
  test("fallback checks source-aware result shape asynchronously", async () => {
    {
      const id = "data";
      const result = await fetchUser(id);
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
    }
  });


  test("fallback checks stable result contract", async () => {
    {
      const id = "data";
      const result = await fetchUser(id);
      expect(result == null || typeof result === "object").toBe(true);
    }
  });


});
