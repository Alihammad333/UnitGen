// src/core/parser/dynamicApiTestGenerator.js

import fs from "fs";
import path from "path";

import { exploreDynamicPackageApi } from "./dynamicApiExplorer.js";
import { runJestForFile } from "../runner/jestRunner.js";

/* ======================================================
   JEST RESULT HELPERS
====================================================== */

function getJestJson(result) {
  if (!result) return null;

  if (result?.json && typeof result.json === "object") {
    return result.json;
  }

  if (
    typeof result === "object" &&
    (
      "numTotalTests" in result ||
      "testResults" in result ||
      "numFailedTests" in result ||
      "numFailedTestSuites" in result ||
      "numRuntimeErrorTestSuites" in result
    )
  ) {
    return result;
  }

  return null;
}

function dynamicPreflightPassed(result) {
  const json = getJestJson(result);
  if (!json) return false;

  const totalTests = Number(json.numTotalTests || 0);
  const failedTests = Number(json.numFailedTests || 0);
  const failedSuites =
    Number(json.numFailedTestSuites || 0) +
    Number(json.numRuntimeErrorTestSuites || 0);

  return totalTests > 0 && failedTests === 0 && failedSuites === 0;
}

function deleteFileSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // never crash pipeline during cleanup
  }
}

async function preflightDynamicApiTestFile(outFile, displayName) {
  try {
    const result = await runJestForFile(outFile);

    if (dynamicPreflightPassed(result)) {
      console.log(`✅ Dynamic preflight passed: ${displayName}`);
      return true;
    }

    console.log(`⚠️ Dynamic preflight failed, skipping API: ${displayName}`);
    deleteFileSafe(outFile);
    return false;
  } catch (err) {
    console.log(
      `⚠️ Dynamic preflight crashed, skipping API: ${displayName} (${err?.message || err})`
    );
    deleteFileSafe(outFile);
    return false;
  }
}

/* ======================================================
   PATH / NAME HELPERS
====================================================== */

function computePackageRequirePath(packageRootAbs) {
  const fromDir = path.resolve("tests", "generated");
  let rel = path.relative(fromDir, packageRootAbs);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.split(path.sep).join(path.posix.sep);
}

function safeDynamicApiStem(packageRootAbs, displayName) {
  const packageName = path.basename(packageRootAbs || "package");
  return `${packageName}.dynamic.${displayName}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function makeDynamicTestStemName(api = {}) {
  const displayName = api.fnName || api.accessPath || "api";
  const accessSuffix = String(api.accessPath || "")
    .replace(/^pkg\.?/, "")
    .replace(/^$/, "default");

  return `${displayName}.${accessSuffix}`;
}

function normalizeParamList(params = []) {
  return (params || []).map((p, index) => {
    if (typeof p === "string") return p;
    if (p?.name) return p.name;
    return `arg${index + 1}`;
  });
}

function sanitizeIdentifier(raw, fallback = "Subject") {
  let value = String(raw || fallback).replace(/[^A-Za-z0-9_$]/g, "");

  if (!value || /^[0-9]/.test(value)) value = fallback;

  return value;
}

function propertyAccessExpression(root, key) {
  const safeKey = String(key || "");

  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(safeKey)) {
    return `${root}.${safeKey}`;
  }

  return `${root}[${JSON.stringify(safeKey)}]`;
}

function ownerNameFromApi(api = {}) {
  const ownerPath = String(api.ownerAccessPath || "");
  const parts = ownerPath.split(".").filter(Boolean);
  const last = parts[parts.length - 1] || "Subject";

  if (last === String(api.rootIdentifier || "pkg")) return "Subject";

  return sanitizeIdentifier(last, "Subject");
}

/* ======================================================
   API TARGET FILTER
====================================================== */

function shouldGenerateDynamicApiTarget(api = {}) {
  if (!api?.accessPath) return false;

  const name = String(api.fnName || api.exportName || api.accessPath || "");

  if (!name) return false;
  if (name.startsWith("_")) return false;
  if (api.methodName && String(api.methodName).startsWith("_")) return false;

  return true;
}

function hasUnsafeUnmockedDynamicBehavior(api = {}) {
  const source = String(api.functionCode || "");
  if (!source) return false;

  const bodyStart = source.indexOf("{");
  const executableSource = bodyStart >= 0 ? source.slice(bodyStart + 1) : source;

  const directExternalIo = [
    /\bfs\s*\./,
    /\b(?:readFile|writeFile|createReadStream|createWriteStream|readdir|mkdir|unlink|rm)\s*\(/,
    /\b(?:archiver|tar|unzipper|extract|compress)\s*\(/,
    /\b(?:http|https|net|tls|dgram|child_process)\s*\./,
    /\b(?:fetch|axios)\s*\(/,
    /\b(?:spawn|exec|execFile|fork)\s*\(/,
  ].some((pattern) => pattern.test(executableSource));

  const streamOrEmitterLifecycle =
    /\.\s*(?:pipe|finalize)\s*\(/.test(source) ||
    /\.\s*(?:on|once)\s*\(\s*["'](?:close|finish|error|data|end)["']/.test(source);

  const callbackDrivenPromiseWrapper =
    /\bnew\s+Promise\s*\(/.test(source) &&
    /\.\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*(?:=>|function\s*\()/.test(source);

  return directExternalIo || streamOrEmitterLifecycle || callbackDrivenPromiseWrapper;
}

function hasSourceRecognizedFilesystemWrapper(api = {}) {
  const source = String(api.functionCode || "");
  const params = normalizeParamList(api.params || []).map((name) =>
    String(name || "").toLowerCase()
  );

  const delegatesThroughFs =
    /\b(?:orig|read|readSync)\s*\.\s*call\s*\(\s*fs\b/.test(source);
  const hasObservableCallback = params.some((name) =>
    name === "cb" || name.includes("callback")
  );
  const hasBoundedRetry =
    /\b(?:eagCounter|retry|queue)\b/.test(source) &&
    /\b(?:EAGAIN|EMFILE|ENFILE)\b/.test(source);
  const normalizesFsErrors = /\bchownErOk\s*\(/.test(source);

  return delegatesThroughFs &&
    (hasObservableCallback || hasBoundedRetry || normalizesFsErrors);
}
function dedupeDynamicTargets(apis = []) {
  const seen = new Set();
  const output = [];

  for (const api of apis) {
    const key = api.isPrototypeMethod
      ? `prototype:${api.methodName}:${(api.params || []).join(",")}`
      : `direct:${api.accessPath}:${(api.params || []).join(",")}`;

    if (seen.has(key)) continue;
    seen.add(key);
    output.push(api);
  }

  return output;
}

function dynamicBehaviorPriority(api = {}) {
  const source = String(api.functionCode || "");
  const accessPath = String(api.accessPath || "");
  const name = String(api.methodName || api.fnName || api.exportName || "");
  const branchSignals = (
    source.match(/\bif\b|\bswitch\b|\bcase\b|\?|&&|\|\|/g) || []
  ).length;
  const arity = normalizeParamList(api.params || []).length;
  let score = 0;

  if (hasSourceRecognizedFilesystemWrapper(api)) score += 100;
  if (source && !/\[native code\]/.test(source)) score += 40;
  else if (/\[native code\]/.test(source)) score -= 40;

  score += Math.min(branchSignals, 10) * 3;
  score += Math.min(arity, 4) * 3;
  score += Math.min(Math.floor(Math.log2(source.length + 1)), 10);

  if (!api.isPrototypeMethod) score += 10;
  else score += 6;

  if (accessPath.split(".").some((part) => part.startsWith("_"))) score -= 30;
  if (/^(?:constructor\$?|toString|valueOf|toLocaleString)$/i.test(name)) score -= 15;

  return score;
}

/* ======================================================
   TEST TEMPLATE
====================================================== */

function renderDynamicApiTestTemplate({ api, packageRequirePath }) {
  const supportImports = `import fs from "node:fs";
import path from "node:path";
import os from "node:os";`;

  if (api.isPrototypeMethod) {
    const ownerName = ownerNameFromApi(api);
    const methodAccess = propertyAccessExpression(
      "__unitgen_owner__.prototype",
      api.methodName
    );

    return `import { createRequire } from "module";
${supportImports}

const require = createRequire(import.meta.url);
const pkg = require("${packageRequirePath}");
const ${ownerName} = ${api.ownerAccessPath};
const __unitgen_owner__ = ${ownerName};
const __unitgen_target__ = ${methodAccess};

describe("${api.fnName || api.accessPath}", () => {
  test("should be exported as a function", () => {
    expect(typeof __unitgen_target__).toBe("function");
  });

  /*__UNITGEN_LLM_TESTS__*/
});
`;
  }

  return `import { createRequire } from "module";
${supportImports}

const require = createRequire(import.meta.url);
const pkg = require("${packageRequirePath}");
const __unitgen_target__ = ${api.accessPath};

describe("${api.fnName || api.accessPath}", () => {
  test("should be exported as a function", () => {
    expect(typeof __unitgen_target__).toBe("function");
  });

  /*__UNITGEN_LLM_TESTS__*/
});
`;
}

/* ======================================================
   CONTEXT BUILDER
====================================================== */

function buildDynamicLlmContext({
  api,
  outFile,
  packageRequirePath,
  packageRoot,
  packageName,
}) {
  const displayName = api.fnName || api.accessPath;
  const params = normalizeParamList(api.params || []).filter(
    (name) => !String(name || "").startsWith("_")
  );
  const isAsync = true;
  const ownerClassName = api.isPrototypeMethod ? ownerNameFromApi(api) : "";
  const methodName = api.isPrototypeMethod ? String(api.methodName || api.exportName || "") : "";

  return {
    fnName: api.isPrototypeMethod ? methodName : "__unitgen_target__",
    targetKey: displayName,
    displayName,
    isAsync,
    isDefault: false,
    isClassLike: !!api.isClassLike,
    isClassMethod: !!api.isPrototypeMethod,
    isDynamicApi: true,
    dynamicApi: api,

    ownerClassName,
    methodName,
    methodKind: api.isPrototypeMethod ? "prototype" : "",
    constructorParams: normalizeParamList(api.ownerConstructorParams || []),
    constructorCode: api.ownerConstructorCode || "",
    classCode: api.ownerConstructorCode || api.functionCode || "",
    classMethods: Array.isArray(api.ownerMethodNames) ? api.ownerMethodNames : [],

    params,
    functionCode: api.functionCode || api.signature || "",
    testFilePath: outFile,
    importPath: packageRequirePath,
    sourceFile: api.entryPath || packageRoot,

    mockHeader: api.isPrototypeMethod
      ? `import { createRequire } from "module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const pkg = require("${packageRequirePath}");
const ${ownerClassName} = ${api.ownerAccessPath};
const __unitgen_owner__ = ${ownerClassName};
const __unitgen_target__ = ${propertyAccessExpression("__unitgen_owner__.prototype", methodName)};`
      : `import { createRequire } from "module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const pkg = require("${packageRequirePath}");
const __unitgen_target__ = ${api.accessPath};`,

    mockEntries: [],
    dependencyUsage: [],
    dependencies: [],
    usageSnippets: [],
    docComment: null,

    accessPath: api.accessPath,
    packageRoot,
    packageName,
  };
}

/* ======================================================
   MAIN GENERATOR
====================================================== */

export async function generateDynamicApiTests({
  projectRoot,
  writeGeneratedTest,
  rootIdentifier = "pkg",
  maxDepth = Number(process.env.UNITGEN_DYNAMIC_API_MAX_DEPTH || 4),
  maxApis = Number(process.env.UNITGEN_DYNAMIC_API_MAX_APIS || 200),
  includeLlmContexts = true,
  maxLlmContexts = Number.POSITIVE_INFINITY,
} = {}) {
  if (!projectRoot) {
    return {
      processedFiles: 0,
      skippedFiles: 0,
      generatedTestFiles: 0,
      skippedClassLikeExports: 0,
      llmContexts: [],
    };
  }

  if (typeof writeGeneratedTest !== "function") {
    throw new Error("generateDynamicApiTests requires writeGeneratedTest function.");
  }

  const packageRoot = path.resolve(projectRoot || "");
  const packageRequirePath = computePackageRequirePath(packageRoot);

  console.log("\n🔎 Running dynamic package API discovery fallback...\n");

  const discovery = await exploreDynamicPackageApi({
    packageRoot,
    rootIdentifier,
    maxDepth,
    maxApis,
  });

  if (!discovery?.ok) {
    console.log(`⚠️ Dynamic API discovery failed: ${discovery?.reason || "unknown"}`);

    for (const err of discovery?.errors || []) {
      console.log(`   - ${err}`);
    }

    return {
      processedFiles: 0,
      skippedFiles: 0,
      generatedTestFiles: 0,
      skippedClassLikeExports: 0,
      llmContexts: [],
    };
  }

  const apis = dedupeDynamicTargets(
    (discovery.apis || []).filter(shouldGenerateDynamicApiTarget)
  ).sort(
    (left, right) => dynamicBehaviorPriority(right) - dynamicBehaviorPriority(left)
  );

  console.log(
    `✅ Dynamic API discovery found ${discovery.totalApis || 0} API candidate(s), ${apis.length} public target candidate(s).`
  );

  let generatedTestFiles = 0;
  let skippedByPreflight = 0;
  const llmContexts = [];

  for (const api of apis) {
    const displayName = api.fnName || api.accessPath;

    const testContent = renderDynamicApiTestTemplate({
      api,
      packageRequirePath,
    });

    const stem = safeDynamicApiStem(packageRoot, makeDynamicTestStemName(api));
    const outFile = writeGeneratedTest(stem, testContent);

    const preflightOk = await preflightDynamicApiTestFile(outFile, displayName);

    if (!preflightOk) {
      skippedByPreflight++;
      continue;
    }

    if (includeLlmContexts && llmContexts.length < maxLlmContexts) {
      if (
        hasUnsafeUnmockedDynamicBehavior(api) &&
        !hasSourceRecognizedFilesystemWrapper(api)
      ) {
        console.log(
          `ℹ️ Keeping dynamic export smoke test only for side-effectful API: ${displayName}`
        );
      } else {
        llmContexts.push(
          buildDynamicLlmContext({
            api,
            outFile,
            packageRequirePath,
            packageRoot,
            packageName: discovery.packageName,
          })
        );
      }
    }

    generatedTestFiles++;
    console.log(`✅ Generated dynamic API test: ${outFile} (${displayName})`);
  }

  console.log(
    `ℹ️ Dynamic API preflight kept ${generatedTestFiles} test file(s), skipped ${skippedByPreflight} unsafe/non-executable API(s).`
  );
  if (includeLlmContexts) {
    console.log(
      `ℹ️ Dynamic API behavior contexts prepared for LLM/fallback: ${llmContexts.length}`
    );
  }

  return {
    processedFiles: 1,
    skippedFiles: skippedByPreflight,
    generatedTestFiles,
    skippedClassLikeExports: 0,
    llmContexts,
  };
}

export default generateDynamicApiTests;
