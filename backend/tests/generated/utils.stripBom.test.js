import { describe, test, expect, jest, beforeAll, beforeEach, afterEach, afterAll } from "@jest/globals";
import { createRequire as __unitgenCreateRequire } from "node:module";
import {
  pathToFileURL as __unitgenPathToFileURL,
  fileURLToPath as __unitgenFileURLToPath
} from "node:url";
import * as __unitgenFs from "node:fs";
import * as __unitgenPath from "node:path";

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

  add("specifier", "../../benchmark_packages/jsonfile/utils.js");
  addResolved("../../benchmark_packages/jsonfile/utils.js");

  const fromTestDir = __unitgenPath.dirname(
    __unitgenFileURLToPath(import.meta.url)
  );

  try {
    const absFromTest = __unitgenPath.resolve(fromTestDir, "../../benchmark_packages/jsonfile/utils.js");
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

  throw new Error("UnitGen module load failed for ../../benchmark_packages/jsonfile/utils.js:\n" + __unitgenMessage);
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
let stripBom;

beforeAll(async () => {
  mod = await __unitgenLoadModule();
  stripBom = __unitgenResolveExport(mod, "stripBom", false);
});

describe("stripBom", () => {
  test("auto-generated (prototype)", async () => {
    if (typeof stripBom !== "function") {
      throw new TypeError("stripBom import did not resolve to a function");
    }
    const content = { replace: jest.fn().mockReturnValue("sample"), toString: jest.fn().mockReturnValue("\uFEFFsample") };
    let result;
    try {
      result = stripBom(content);
      if (result && typeof result.then === "function") {
        result = await result;
      }
      expect(result).toBeDefined();
    } catch (error) {
      expect(error && (error instanceof Error || typeof error.message === "string")).toBe(true);
    }
  });

  
  test("Buffer content with BOM character", () => {
    {
      const content = Buffer.from('\uFEFFHello World', 'utf8');
      const result = stripBom(content);
      expect(result).toBe('Hello World');
    }
  });


  test("String content with BOM character", () => {
    {
      const content = '\uFEFFHello World';
      const result = stripBom(content);
      expect(result).toBe('Hello World');
    }
  });


  test("Content without BOM character", () => {
    {
      const content = 'Hello World';
      const result = stripBom(content);
      expect(result).toBe('Hello World');
    }
  });


  test("Empty content", () => {
    {
      const content = '';
      const result = stripBom(content);
      expect(result).toBe('');
    }
  });


  test("Content with multiple BOM characters", () => {
    {
      const content = '\uFEFF\uFEFFHello World';
      const result = stripBom(content);
      expect(result).toBe('\uFEFFHello World');
    }
  });


  test("Content with BOM character at the end", () => {
    {
      const content = 'Hello World\uFEFF';
      const result = stripBom(content);
      expect(result).toBe('Hello World\uFEFF');
    }
  });
});
