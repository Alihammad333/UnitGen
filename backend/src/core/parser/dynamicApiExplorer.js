// src/core/parser/dynamicApiExplorer.js

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";

const requireFromUnitGen = createRequire(import.meta.url);

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_APIS = 200;

function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function isFunction(value) {
  return typeof value === "function";
}

function isAsyncFunction(fn) {
  if (fn?.constructor?.name === "AsyncFunction") return true;

  const source = safeFunctionSource(fn);
  return /\bnew\s+Promise\s*\(|\bPromise\s*\.\s*(?:resolve|reject|all|allSettled|any|race)\s*\(/.test(source);
}

function isClassLike(fn) {
  if (!isFunction(fn)) return false;
  const src = Function.prototype.toString.call(fn);
  return /^class\s/.test(src);
}

function safeFunctionSource(fn) {
  try {
    return Function.prototype.toString.call(fn);
  } catch {
    return "";
  }
}

function getFunctionParams(fn) {
  const source = safeFunctionSource(fn);
  const params = [];

  const match =
    source.match(/^[^(]*\(([^)]*)\)/) ||
    source.match(/^(?:async\s*)?([^=()]+?)\s*=>/) ||
    source.match(/^class\s+[^{]*constructor\s*\(([^)]*)\)/);

  const raw = match?.[1] || "";

  for (const part of raw.split(",")) {
    const cleaned = part
      .trim()
      .replace(/=.*$/g, "")
      .replace(/[{}\[\]\s]/g, "")
      .replace(/^\.{3}/, "");

    if (cleaned && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cleaned)) {
      params.push(cleaned);
    }
  }

  if (params.length > 0) return params;

  const count = Number(fn.length || 0);
  return Array.from({ length: count }, (_, i) => `arg${i + 1}`);
}

function makeDisplayName(propertyPath = []) {
  if (!propertyPath.length) return "defaultExport";
  return propertyPath.join(".");
}

function getRuntimeFunctionName(fn) {
  const name = String(fn?.name || "").trim();

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return "";
  if (["anonymous", "bound", "default"].includes(name.toLowerCase())) return "";

  return name;
}

function makeAccessPath(rootIdentifier, propertyPath = []) {
  if (!propertyPath.length) return rootIdentifier;

  return propertyPath.reduce((acc, part) => {
    const key = String(part);

    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
      return `${acc}.${key}`;
    }

    return `${acc}[${JSON.stringify(key)}]`;
  }, rootIdentifier);
}

function readPackageJson(packageRoot) {
  const pkgPath = path.join(packageRoot, "package.json");

  if (!fs.existsSync(pkgPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
}

function resolveExportEntry(exportsField) {
  if (!exportsField) return null;

  if (typeof exportsField === "string") return exportsField;

  if (typeof exportsField === "object") {
    const rootExport = exportsField["."] || exportsField;

    if (typeof rootExport === "string") return rootExport;

    if (rootExport && typeof rootExport === "object") {
      return (
        rootExport.require ||
        rootExport.import ||
        rootExport.default ||
        rootExport.node ||
        null
      );
    }
  }

  return null;
}

function getEntryCandidates(packageRoot, pkg) {
  const candidates = [];

  const add = (value) => {
    if (!value || typeof value !== "string") return;

    const clean = value.split("?")[0];
    candidates.push(path.resolve(packageRoot, clean));
  };

  add(resolveExportEntry(pkg?.exports));
  add(pkg?.main);
  add(pkg?.module);
  add(pkg?.browser);

  candidates.push(path.resolve(packageRoot, "index.js"));
  candidates.push(path.resolve(packageRoot, "lib/index.js"));
  candidates.push(path.resolve(packageRoot, "dist/index.js"));
  candidates.push(path.resolve(packageRoot, "dist/commonjs/index.js"));
  candidates.push(path.resolve(packageRoot, "dist/commonjs/index.min.js"));
  candidates.push(path.resolve(packageRoot, "dist/esm/index.js"));
  candidates.push(path.resolve(packageRoot, "dist/esm/index.min.js"));

  return [...new Set(candidates)];
}

function fileExistsMaybeWithExtension(filePath) {
  const candidates = [
    filePath,
    `${filePath}.js`,
    `${filePath}.cjs`,
    `${filePath}.mjs`,
    path.join(filePath, "index.js"),
    path.join(filePath, "index.cjs"),
    path.join(filePath, "index.mjs"),
  ];

  return candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) || null;
}

async function loadPackageExports(packageRoot) {
  const pkg = readPackageJson(packageRoot);
  const errors = [];

  try {
    const mod = requireFromUnitGen(packageRoot);
    return {
      ok: true,
      moduleExports: mod,
      entryPath: packageRoot,
      loadMode: "require-package-root",
      packageJson: pkg,
      errors,
    };
  } catch (err) {
    errors.push(`require(packageRoot): ${err?.message || String(err)}`);
  }

  for (const candidate of getEntryCandidates(packageRoot, pkg)) {
    const entry = fileExistsMaybeWithExtension(candidate);
    if (!entry) continue;

    try {
      const mod = requireFromUnitGen(entry);
      return {
        ok: true,
        moduleExports: mod,
        entryPath: entry,
        loadMode: "require-entry",
        packageJson: pkg,
        errors,
      };
    } catch (err) {
      errors.push(`require(${entry}): ${err?.message || String(err)}`);
    }

    try {
      const mod = await import(pathToFileURL(entry).href);
      return {
        ok: true,
        moduleExports: mod?.default ?? mod,
        rawModule: mod,
        entryPath: entry,
        loadMode: "dynamic-import-entry",
        packageJson: pkg,
        errors,
      };
    } catch (err) {
      errors.push(`import(${entry}): ${err?.message || String(err)}`);
    }
  }

  return {
    ok: false,
    moduleExports: null,
    entryPath: null,
    loadMode: "failed",
    packageJson: pkg,
    errors,
  };
}

function getOwnEnumerableKeysSafe(value) {
  if (!isObjectLike(value)) return [];

  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function getOwnPropertyNamesSafe(value) {
  if (!isObjectLike(value)) return [];

  try {
    return Object.getOwnPropertyNames(value);
  } catch {
    return [];
  }
}

function getPropertyDescriptorSafe(value, key) {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return null;
  }
}

function getPropertyValueSafe(value, key) {
  const descriptor = getPropertyDescriptorSafe(value, key);

  if (!descriptor) return { ok: false, value: undefined, reason: "NO_DESCRIPTOR" };

  if (typeof descriptor.get === "function" && !("value" in descriptor)) {
    return { ok: false, value: undefined, reason: "GETTER_SKIPPED" };
  }

  try {
    return { ok: true, value: value[key], reason: "OK" };
  } catch (err) {
    return { ok: false, value: undefined, reason: err?.message || "READ_FAILED" };
  }
}

function shouldSkipKey(key) {
  return [
    "__esModule",
    "default",
    "prototype",
    "constructor",
    "length",
    "name",
    "arguments",
    "caller",
    "callee",
  ].includes(String(key));
}

function createApiRecord({
  fn,
  propertyPath,
  rootIdentifier,
  packageRoot,
  entryPath,
  importMode,
}) {
  const runtimeName = getRuntimeFunctionName(fn);
  const fnName = propertyPath.length ? makeDisplayName(propertyPath) : runtimeName || "defaultExport";
  const source = safeFunctionSource(fn);

  return {
    source: "dynamic-api",
    fnName,
    exportName: propertyPath[propertyPath.length - 1] || "defaultExport",
    propertyPath,
    accessPath: makeAccessPath(rootIdentifier, propertyPath),
    rootIdentifier,

    params: getFunctionParams(fn),
    arity: Number(fn.length || 0),

    isAsync: isAsyncFunction(fn),
    isClassLike: isClassLike(fn),
    isConstructor: isClassLike(fn),

    functionCode: source,
    signature: `${fnName}(${getFunctionParams(fn).join(", ")})`,

    packageRoot,
    entryPath,
    importMode,

    dynamic: true,
  };
}

function exploreValue({
  value,
  propertyPath = [],
  rootIdentifier,
  packageRoot,
  entryPath,
  importMode,
  visited,
  results,
  depth,
  maxDepth,
  maxApis,
}) {
  if (results.length >= maxApis) return;
  if (!isObjectLike(value)) return;

  if (visited.has(value)) return;
  visited.add(value);

  if (isFunction(value)) {
    results.push(
      createApiRecord({
        fn: value,
        propertyPath,
        rootIdentifier,
        packageRoot,
        entryPath,
        importMode,
      })
    );

    if (results.length >= maxApis) return;
  }

  if (depth >= maxDepth) return;

  const keys = [
    ...new Set([
      ...getOwnEnumerableKeysSafe(value),
      ...getOwnPropertyNamesSafe(value),
    ]),
  ].filter((key) => !shouldSkipKey(key));

  for (const key of keys) {
    if (results.length >= maxApis) break;

    const read = getPropertyValueSafe(value, key);
    if (!read.ok) continue;

    const child = read.value;
    if (!isObjectLike(child)) continue;

    exploreValue({
      value: child,
      propertyPath: [...propertyPath, key],
      rootIdentifier,
      packageRoot,
      entryPath,
      importMode,
      visited,
      results,
      depth: depth + 1,
      maxDepth,
      maxApis,
    });
  }

  if (isFunction(value) && value.prototype && isObjectLike(value.prototype)) {
    const protoKeys = getOwnPropertyNamesSafe(value.prototype).filter(
      (key) => !shouldSkipKey(key)
    );

    for (const key of protoKeys) {
      if (results.length >= maxApis) break;

      const read = getPropertyValueSafe(value.prototype, key);
      if (!read.ok || !isFunction(read.value)) continue;

      results.push({
        ...createApiRecord({
          fn: read.value,
          propertyPath: [...propertyPath, "prototype", key],
          rootIdentifier,
          packageRoot,
          entryPath,
          importMode,
        }),
        isPrototypeMethod: true,
        ownerAccessPath: makeAccessPath(rootIdentifier, propertyPath),
        ownerMethodNames: protoKeys,
        ownerConstructorParams: getFunctionParams(value),
        ownerConstructorCode: safeFunctionSource(value),
        methodName: key,
      });
    }
  }
}

function dedupeApiRecords(records = []) {
  const seen = new Set();
  const output = [];

  for (const record of records) {
    const key = `${record.accessPath}::${record.signature}`;

    if (seen.has(key)) continue;
    seen.add(key);
    output.push(record);
  }

  return output;
}

export async function exploreDynamicPackageApi({
  packageRoot,
  rootIdentifier = "pkg",
  maxDepth = DEFAULT_MAX_DEPTH,
  maxApis = DEFAULT_MAX_APIS,
} = {}) {
  if (!packageRoot) {
    return {
      ok: false,
      reason: "MISSING_PACKAGE_ROOT",
      apis: [],
      errors: [],
    };
  }

  const absRoot = path.resolve(packageRoot);

  if (!fs.existsSync(absRoot)) {
    return {
      ok: false,
      reason: "PACKAGE_ROOT_NOT_FOUND",
      packageRoot: absRoot,
      apis: [],
      errors: [],
    };
  }

  const loaded = await loadPackageExports(absRoot);

  if (!loaded.ok) {
    return {
      ok: false,
      reason: "PACKAGE_LOAD_FAILED",
      packageRoot: absRoot,
      packageJson: loaded.packageJson,
      apis: [],
      errors: loaded.errors,
    };
  }

  const results = [];
  const visited = new WeakSet();

  exploreValue({
    value: loaded.moduleExports,
    propertyPath: [],
    rootIdentifier,
    packageRoot: absRoot,
    entryPath: loaded.entryPath,
    importMode: loaded.loadMode,
    visited,
    results,
    depth: 0,
    maxDepth,
    maxApis,
  });

  const apis = dedupeApiRecords(results);

  return {
    ok: true,
    reason: "DYNAMIC_API_DISCOVERY_COMPLETED",
    packageRoot: absRoot,
    packageName: loaded.packageJson?.name || path.basename(absRoot),
    packageJson: loaded.packageJson,
    entryPath: loaded.entryPath,
    importMode: loaded.loadMode,
    rootIdentifier,
    totalApis: apis.length,
    apis,
    errors: loaded.errors,
  };
}

export default exploreDynamicPackageApi;
