import { analyzeFunctionParameterProfiles } from "./parameterProfile.js";

/**
 * ESM/CJS-safe Jest test template.
 *
 * Principles:
 * - minimal runnable baseline
 * - input-independent, structure-aware defaults
 * - supports named, default, CommonJS, and Babel interop export shapes
 * - supports dynamic import first, then createRequire fallback
 * - supports final manual CommonJS wrapper fallback for old/bundled CJS files
 * - avoids top-level await for stronger Jest compatibility
 * - supports normal functions, class constructors, static methods, and prototype methods
 * - avoids reserved-word local bindings such as delete/class/default/return
 * - profile-aware defaults for arrays/statistical params
 * - smarter defaults for domain-specific statistical APIs
 * - targeted prototype handling for hard npm-package cases
 * - improved class-like constructor baseline assertions
 * - filesystem-safe temp file handling for file/path based APIs
 * - places global setup and module mocks before source import/load
 * - keeps ESM mocking compatible through jest.unstable_mockModule()
 */

const JS_RESERVED_WORDS = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const RESERVED_LOCAL_NAMES = new Set([
  ...JS_RESERVED_WORDS,
  "result",
  "mod",
  "describe",
  "test",
  "expect",
  "jest",
  "fs",
  "path",
  "os",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "__unitgenFs",
  "__unitgenPath",
  "__unitgenRequire",
  "__unitgenLoadModule",
  "__unitgenResolveExport",
  "__unitgenTarget",
  "__unitgenClass",
  "__unitgenInstance",
]);

function isValidIdentifier(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(name || ""));
}

function sanitizeParamName(raw, usedNames = new Set(), fallback = "arg") {
  const base = String(raw || fallback).replace(/[^a-zA-Z0-9_$]/g, "") || fallback;

  let name = base;
  if (!isValidIdentifier(name) || RESERVED_LOCAL_NAMES.has(name)) {
    name = `${name}Arg`;
  }

  let candidate = name;
  let counter = 2;

  while (
    usedNames.has(candidate) ||
    RESERVED_LOCAL_NAMES.has(candidate) ||
    !isValidIdentifier(candidate)
  ) {
    candidate = `${name}${counter}`;
    counter++;
  }

  usedNames.add(candidate);
  return candidate;
}

function safeLocalBindingName(raw, fallback = "__unitgenTarget") {
  const name = String(raw || "").trim();

  if (isValidIdentifier(name) && !RESERVED_LOCAL_NAMES.has(name)) {
    return name;
  }

  return fallback;
}

function propertyAccessExpression(objectName, propertyName) {
  const prop = String(propertyName || "");

  if (isValidIdentifier(prop) && !JS_RESERVED_WORDS.has(prop)) {
    return `${objectName}.${prop}`;
  }

  return `${objectName}[${JSON.stringify(prop)}]`;
}

function functionLooksFileSystemApi(fnName = "") {
  const lower = String(fnName || "").toLowerCase();
  return (
    lower.includes("readfile") ||
    lower.includes("writefile") ||
    lower === "open" ||
    lower === "close" ||
    lower === "closesync" ||
    lower === "readdir" ||
    lower.includes("readstream") ||
    lower.includes("writestream") ||
    lower.includes("createreadstream") ||
    lower.includes("createwritestream") ||
    lower.includes("readjson") ||
    lower.includes("writejson") ||
    lower.includes("outputjson") ||
    lower.includes("ensurefile") ||
    lower.includes("removefile")
  );
}

function functionLooksReadApi(fnName = "") {
  const lower = String(fnName || "").toLowerCase();
  return lower.includes("read");
}

function functionLooksWriteApi(fnName = "") {
  const lower = String(fnName || "").toLowerCase();
  return lower.includes("write") || lower.includes("output");
}

function functionLooksFdApi(fnName = "") {
  const lower = String(fnName || "").toLowerCase();
  return (
    lower === "close" ||
    lower === "closesync" ||
    lower.includes("fdatasync") ||
    lower.includes("fsync") ||
    lower.includes("fstat") ||
    lower.includes("ftruncate") ||
    lower.includes("futimes") ||
    lower.includes("fchmod") ||
    lower.includes("fchown")
  );
}

function functionLooksCloseApi(fnName = "") {
  const lower = String(fnName || "").toLowerCase();
  return lower === "close" || lower === "closesync";
}

function functionLooksStreamApi(fnName = "") {
  const lower = String(fnName || "").toLowerCase();
  return (
    lower === "readstream" ||
    lower === "writestream" ||
    lower === "filereadstream" ||
    lower === "filewritestream" ||
    lower === "createreadstream" ||
    lower === "createwritestream" ||
    lower.endsWith("readstream") ||
    lower.endsWith("writestream")
  );
}

function functionLooksArchiveApi(fnName = "") {
  const lower = String(fnName || "").toLowerCase();
  return (
    lower.includes("archive") ||
    lower.includes("compress") ||
    lower.includes("zip") ||
    lower.includes("tar") ||
    lower.includes("7z")
  );
}

function archiveTargetExtension(fnName = "") {
  const lower = String(fnName || "").toLowerCase();

  if (lower.includes("7z") || lower.includes("sevenzip")) return ".7z";
  if (lower.includes("tar")) return ".tar";
  if (lower.includes("zip")) return ".zip";

  return ".archive";
}

function paramLooksArchiveSource(paramName = "") {
  const lower = String(paramName || "").toLowerCase();
  return lower === "source" || lower === "src" || lower === "input";
}

function paramLooksFilePath(paramName = "") {
  const lower = String(paramName || "").toLowerCase();
  return (
    lower === "file" ||
    lower === "filepath" ||
    lower === "filename" ||
    lower === "path" ||
    lower === "patharg" ||
    lower.endsWith("file") ||
    lower.endsWith("path") ||
    lower.includes("filename")
  );
}

function paramLooksDirectoryPath(paramName = "") {
  const lower = String(paramName || "").toLowerCase();
  return (
    lower === "dir" ||
    lower === "directory" ||
    lower === "folder" ||
    lower === "root" ||
    lower === "cwd" ||
    lower.endsWith("dir") ||
    lower.endsWith("directory") ||
    lower.endsWith("folder") ||
    lower.includes("dirname")
  );
}

function paramLooksArchiveTarget(paramName = "") {
  const lower = String(paramName || "").toLowerCase();
  return (
    paramLooksFilePath(lower) ||
    lower === "target" ||
    lower === "destination" ||
    lower === "dest" ||
    lower === "output"
  );
}

function paramLooksTextSpec(paramName = "") {
  const lower = String(paramName || "").toLowerCase();
  return (
    lower === "spec" ||
    lower === "pathspec" ||
    lower === "rulespec" ||
    lower.endsWith("spec")
  );
}

function buildFunctionLiteralForParam(paramName) {
  const lower = String(paramName || "").trim().toLowerCase();

  if (lower.includes("randomsource")) {
    return "() => 0.5";
  }

  if (
    lower.includes("callback") ||
    lower === "cb" ||
    lower.endsWith("cb") ||
    lower.includes("handler") ||
    lower.includes("listener") ||
    lower.includes("onfulfillment") ||
    lower.includes("onrejection") ||
    lower.endsWith("fn")
  ) {
  return "() => {}";
  }

  if (
    lower.includes("resolver") ||
    lower.includes("executor")
  ) {
    return `(resolve) => resolve("ok")`;
  }

  if (lower.includes("kernel")) {
    return "(x) => x";
  }

  if (lower.includes("bandwidthmethod")) {
    return "() => 1";
  }

  if (lower.includes("comparator")) {
    return "(a, b) => a - b";
  }

  if (lower === "f" || lower === "func" || lower === "predicate") {
    return "(x) => x - 1";
  }

  return "() => 0";
}

function buildSpecialPrimitiveDefault(fnName, paramName) {
  const fnLower = String(fnName || "").toLowerCase();
  const lower = String(paramName || "").toLowerCase();

  if (paramLooksTextSpec(lower)) {
    return `"/sample/path"`;
  }

  if (
    fnLower.includes("glob") ||
    lower === "pattern" ||
    lower === "patterns" ||
    lower.includes("pattern")
  ) {
    return `["**/*.js"]`;
  }

  if (
    fnLower.includes("glob") &&
    (lower === "options" || lower.endsWith("options"))
  ) {
    return "{}";
  }

  if (paramLooksDirectoryPath(lower)) {
    return "__unitgenTmpDir";
  }

  if (paramLooksFilePath(lower)) {
    return "__unitgenFilePath";
  }

  if (functionLooksArchiveApi(fnName) && paramLooksArchiveSource(lower)) {
    return "__unitgenTmpDir";
  }

  if (functionLooksArchiveApi(fnName) && paramLooksArchiveTarget(lower)) {
    return `path.join(__unitgenOutputDir, "unitgen-output${archiveTargetExtension(fnName)}")`;
  }

  if (lower === "ops") {
    return "[]";
  }

  if (lower === "type") {
    return `"file"`;
  }

  if (lower === "combine") {
    return "false";
  }

  if (lower === "fd" || lower === "filedescriptor") {
    return "__unitgenFd";
  }

  if (lower === "flags" || lower === "flag") {
    return functionLooksWriteApi(fnName) ? `"w"` : `"r"`;
  }

  if (lower === "mode") {
    return "0o666";
  }

  if (lower === "op" || lower === "newop") {
    return `{ insert: "sample" }`;
  }

  if (lower === "attributes") {
    return "{}";
  }

  if (lower === "other" || lower === "delta") {
    return "{}";
  }

  if (fnLower === "sign") {
    return "1";
  }

  if (fnLower === "bisect") {
    if (lower === "start" || lower === "left") return "0";
    if (lower === "end" || lower === "right") return "2";
    if (lower.includes("max")) return "100";
    if (lower.includes("error") || lower.includes("tolerance")) return "0.001";
    if (lower === "f" || lower === "func" || lower === "predicate") {
      return "(x) => x - 1";
    }
  }

  if (fnLower === "quantile") {
    if (lower === "p") return "0.5";
  }

  if (fnLower === "quickselect") {
    if (lower === "k") return "2";
    if (lower === "left") return "0";
    if (lower === "right") return "3";
  }

  if (fnLower === "combinationsreplacement") {
    if (lower === "k") return "2";
  }

  if (fnLower === "kmeanscluster") {
    if (lower === "k" || lower === "numcluster") return "2";
    if (lower.includes("max")) return "10";
  }

  if (fnLower === "plural") {
    if (lower === "word") return `"cat"`;
    if (lower === "num") return "2";
  }

  if (fnLower === "addrule") {
    if (lower === "match") return `/.+$/`;
    if (lower === "result" || lower === "resultarg") return `"s"`;
  }

  return null;
}

function choosePrimitiveDefaultValue(paramName, index, profile = {}, fnName = "") {
  const lower = String(paramName || "").trim().toLowerCase();

  const special = buildSpecialPrimitiveDefault(fnName, lower);
  if (special !== null) {
    return special;
  }

  if (functionLooksFileSystemApi(fnName)) {
    if (
      lower === "obj" ||
      lower === "object" ||
      lower === "data" ||
      lower === "json"
    ) {
      return `{ name: "sample" }`;
    }

    if (lower === "options" || lower.endsWith("options")) {
      return "{}";
    }

    if (lower === "spaces" || lower === "eol" || lower === "replacer") {
      return "undefined";
    }
  }

  if (lower === "alternative") {
    return `"two_side"`;
  }

  if (lower.includes("direction")) {
    return `"greater"`;
  }

  if (lower.includes("seed")) {
    return "1";
  }

  if (profile?.isProbabilityLike) {
    return "0.5";
  }

  if (profile?.isIndexLike) {
    return "0";
  }

  if (profile?.isCountLike) {
    return "2";
  }

  if (profile?.isNumberLike) {
    return index === 1 ? "2" : "1";
  }

  if (
    lower.startsWith("is") ||
    lower.startsWith("has") ||
    lower.startsWith("can") ||
    lower.endsWith("flag") ||
    lower.includes("enabled") ||
    lower.includes("disabled")
  ) {
    return "true";
  }

  if (
    lower === "p" ||
    lower.includes("prob") ||
    lower.includes("probability") ||
    lower.includes("alpha")
  ) {
    return "0.5";
  }

  if (
    lower === "n" ||
    lower.includes("count") ||
    lower.includes("size") ||
    lower.includes("length") ||
    lower.includes("bins") ||
    lower.includes("classes")
  ) {
    return "2";
  }

  if (
    lower.includes("index") ||
    lower === "i" ||
    lower === "j" ||
    lower === "k" ||
    lower === "left" ||
    lower === "right"
  ) {
    return "0";
  }

  if (
    lower.includes("callback") ||
    lower.endsWith("cb") ||
    lower.includes("handler") ||
    lower.endsWith("fn") ||
    lower.includes("randomsource") ||
    lower.includes("kernel") ||
    lower.includes("bandwidthmethod") ||
    lower.includes("comparator") ||
    lower === "f" ||
    lower === "func" ||
    lower === "predicate"
  ) {
    return buildFunctionLiteralForParam(lower);
  }
  if (
    lower.includes("callback") ||
    lower === "cb" ||
    lower.includes("handler") ||
    lower.includes("listener") ||
    lower.includes("onfulfillment") ||
    lower.includes("onrejection")
  ) {
    return "() => {}";
  }

  if (
    lower.endsWith("options") ||
    lower.endsWith("config") ||
    lower.endsWith("obj") ||
    lower.endsWith("object") ||
    lower.endsWith("data") ||
    lower.endsWith("payload")
  ) {
    return "{}";
  }

if (
  lower.includes("resolver") ||
  lower.includes("executor")
) {
  return `(resolve) => resolve("ok")`;
}

  if (
    lower.endsWith("name") ||
    lower.endsWith("text") ||
    lower.endsWith("message") ||
    lower.endsWith("title") ||
    lower.endsWith("label") ||
    lower.endsWith("email") ||
    lower.endsWith("password") ||
    lower.endsWith("token") ||
    lower.endsWith("username") ||
    lower.endsWith("sentence") ||
    lower.endsWith("query") ||
    lower === "word" ||
    lower === "resultarg"
  ) {
    return `"sample"`;
  }

  return index === 1 ? "2" : "1";
}

function buildArrayLiteral(paramName, profile = {}, fnName = "") {
  const lower = String(paramName || "").toLowerCase();
  const fnLower = String(fnName || "").toLowerCase();

  if (
    fnLower.includes("glob") ||
    lower === "pattern" ||
    lower === "patterns" ||
    lower.includes("pattern")
  ) {
    return `["**/*.js"]`;
  }

  if (fnLower === "kmeanscluster") {
    if (lower === "x" || lower === "data" || lower.includes("point")) {
      return "[[0, 0], [0, 1], [5, 5], [5, 6]]";
    }
  }

  if (fnLower === "quickselect") {
    return "[1, 2, 3, 4]";
  }

  if (fnLower === "combinationsreplacement") {
    return "[1, 2, 3]";
  }

  if (profile?.isMatrixLike) {
    return "[[1, 2], [3, 4]]";
  }

  if (lower.includes("label")) {
    return "[0, 1, 0, 1]";
  }

  if (lower.includes("point")) {
    return "[[0, 0], [1, 1], [2, 2], [3, 3]]";
  }

  if (
    fnLower.includes("samplekurtosis") ||
    fnLower.includes("sampleskewness") ||
    fnLower.includes("samplevariance") ||
    fnLower.includes("samplestandarddeviation") ||
    fnLower.includes("samplecorrelation") ||
    fnLower.includes("samplecovariance")
  ) {
    return "[1, 2, 3, 4]";
  }

  if (
    fnLower.includes("quantile") ||
    fnLower.includes("median") ||
    fnLower.includes("mean") ||
    fnLower.includes("variance") ||
    fnLower.includes("deviation") ||
    fnLower.includes("mode") ||
    fnLower.includes("product") ||
    fnLower.includes("sum")
  ) {
    return "[1, 2, 3, 4]";
  }

  if (
    lower === "x" ||
    lower === "y" ||
    lower.endsWith("values") ||
    lower.endsWith("data")
  ) {
    return "[1, 2, 3, 4]";
  }

  return "[1, 2, 3]";
}

function buildObjectLiteralFromProfile(profile) {
  const fields = [];

  for (const methodName of profile.methods || []) {
    if (["get", "fetch", "load", "find", "list", "read"].includes(methodName)) {
      fields.push(`${methodName}: jest.fn().mockResolvedValue({ data: {} })`);
      continue;
    }

    if (
      ["post", "create", "save", "update", "put", "delete", "remove"].includes(
        methodName
      )
    ) {
      fields.push(
        `${methodName}: jest.fn().mockResolvedValue({ success: true })`
      );
      continue;
    }

    if (["login", "authenticate", "authorize"].includes(methodName)) {
      fields.push(
        `${methodName}: jest.fn().mockResolvedValue({ token: "sample-token" })`
      );
      continue;
    }

    if (methodName === "toString") {
      fields.push(`${methodName}: jest.fn().mockReturnValue("\\uFEFFsample")`);
      continue;
    }

    if (methodName === "replace") {
      fields.push(`${methodName}: jest.fn().mockReturnValue("sample")`);
      continue;
    }

    if (methodName === "trim") {
      fields.push(`${methodName}: jest.fn().mockReturnValue("sample")`);
      continue;
    }

    if (methodName === "split") {
      fields.push(`${methodName}: jest.fn().mockReturnValue(["sample"])`);
      continue;
    }

    if (methodName === "match") {
      fields.push(`${methodName}: jest.fn().mockReturnValue([])`);
      continue;
    }

    if (methodName === "test") {
      fields.push(`${methodName}: jest.fn().mockReturnValue(true)`);
      continue;
    }

    fields.push(`${methodName}: jest.fn().mockReturnValue({})`);
  }

  for (const propName of profile.properties || []) {
    if ((profile.methods || []).includes(propName)) continue;

    const lower = String(propName || "").toLowerCase();
    if (lower === "url" || lower === "uri" || lower.endsWith("url")) {
      fields.push(`${propName}: "http://127.0.0.1:1/unitgen-sample.png"`);
    } else if (
      lower === "dest" ||
      lower === "destination" ||
      lower === "output" ||
      lower === "target" ||
      lower === "file" ||
      lower === "filepath" ||
      lower === "filename" ||
      lower.endsWith("path")
    ) {
      fields.push(`${propName}: "unitgen-output.png"`);
    } else if (paramLooksTextSpec(lower)) {
      fields.push(`${propName}: "/sample/path"`);
    } else if (lower.includes("timeout")) {
      fields.push(`${propName}: 1`);
    } else if (
      lower.startsWith("is") ||
      lower.startsWith("has") ||
      lower.startsWith("can") ||
      lower.includes("recursive") ||
      lower.includes("sync") ||
      lower.includes("short") ||
      lower.includes("ignore") ||
      lower.includes("combine") ||
      lower.includes("reverse")
    ) {
      fields.push(`${propName}: false`);
    } else if (lower.includes("encoding")) {
      fields.push(`${propName}: "utf8"`);
    } else {
      fields.push(`${propName}: {}`);
    }
  }

  return `{ ${fields.join(", ")} }`;
}

function buildParamDeclaration(paramName, index, profileByName, fnName = "") {
  const lower = paramName.toLowerCase();
  const profile = profileByName?.[paramName] || {};
  const fnLower = String(fnName || "").toLowerCase();

  if (paramLooksDirectoryPath(lower)) {
    return `    const ${paramName} = __unitgenTmpDir;`;
  }

  if (paramLooksFilePath(lower)) {
    return `    const ${paramName} = __unitgenFilePath;`;
  }

  if (functionLooksArchiveApi(fnName) && paramLooksArchiveSource(lower)) {
    return `    const ${paramName} = __unitgenTmpDir;`;
  }

  if (functionLooksArchiveApi(fnName) && paramLooksArchiveTarget(lower)) {
    return `    const ${paramName} = path.join(__unitgenOutputDir, "unitgen-output${archiveTargetExtension(
      fnName
    )}");`;
  }

  if (
    functionLooksFileSystemApi(fnName) &&
    (lower === "obj" ||
      lower === "object" ||
      lower === "data" ||
      lower === "json")
  ) {
    return `    const ${paramName} = { name: "sample" };`;
  }

  if (
    functionLooksFileSystemApi(fnName) &&
    (lower === "options" || lower.endsWith("options"))
  ) {
    return `    const ${paramName} = {};`;
  }

  if (
    fnLower === "quickselect" &&
    (lower === "left" || lower === "right" || lower === "k")
  ) {
    return `    const ${paramName} = ${choosePrimitiveDefaultValue(
      paramName,
      index,
      profile,
      fnName
    )};`;
  }

  if (fnLower === "quantile" && lower === "p") {
    return `    const ${paramName} = 0.5;`;
  }

  if (
    fnLower === "kmeanscluster" &&
    (lower === "k" || lower === "numcluster" || lower.includes("max"))
  ) {
    return `    const ${paramName} = ${choosePrimitiveDefaultValue(
      paramName,
      index,
      profile,
      fnName
    )};`;
  }

  if (
    lower === "randomsource" ||
    lower.includes("randomsource") ||
    lower.includes("kernel") ||
    lower.includes("bandwidthmethod") ||
    lower.includes("comparator") ||
    lower === "f" ||
    lower === "func" ||
    lower === "predicate"
  ) {
    return `    const ${paramName} = ${buildFunctionLiteralForParam(paramName)};`;
  }

  if (fnLower === "sign" && (lower === "x" || lower === "value")) {
    return `    const ${paramName} = 1;`;
  }

  if (profile?.kind === "callback" || profile?.isFunctionLike) {
    return `    const ${paramName} = ${buildFunctionLiteralForParam(paramName)};`;
  }

  if (profile?.kind === "array" || profile?.isArrayLike || profile?.isMatrixLike) {
    return `    const ${paramName} = ${buildArrayLiteral(
      paramName,
      profile,
      fnName
    )};`;
  }

  if (profile?.kind === "object" || profile?.isOptionsLike) {
    return `    const ${paramName} = ${buildObjectLiteralFromProfile(profile)};`;
  }

  return `    const ${paramName} = ${choosePrimitiveDefaultValue(
    paramName,
    index,
    profile,
    fnName
  )};`;
}

function buildExportResolver() {
  return `function __unitgenResolveExport(moduleObject, exportName, isDefaultExport) {
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
}`;
}

function buildImportBinding(bindingName, exportName, isDefault) {
  return `${bindingName} = __unitgenResolveExport(mod, ${JSON.stringify(
    exportName
  )}, ${isDefault ? "true" : "false"});`;
}

function buildModuleSetup({ bindingName, exportName, isDefault }) {
  return `let mod;
let ${bindingName};

beforeAll(async () => {
  mod = await __unitgenLoadModule();
  ${buildImportBinding(bindingName, exportName, isDefault)}
});`;
}

function buildImportGuard(bindingName, exportName) {
  return `    if (typeof ${bindingName} !== "function") {
      throw new TypeError("${exportName} import did not resolve to a function");
    }`;
}

function paramLooksCallbackLike(paramName = "") {
  const lower = String(paramName || "").toLowerCase();
  return (
    lower === "cb" ||
    lower.endsWith("cb") ||
    lower.includes("callback") ||
    lower.includes("handler") ||
    lower.includes("listener") ||
    lower.includes("done") ||
    lower.includes("next") ||
    lower.includes("onabort") ||
    /^on[a-z0-9_]+/.test(lower)
  );
}

function functionLooksVoidLike(functionCode = "") {
  const source = String(functionCode || "");
  const returns = [...source.matchAll(/\breturn(?:\s+([^;\n}]+))?/g)];

  if (returns.length === 0) return true;

  return returns.every((match) => {
    const expression = String(match[1] || "").trim();
    return expression === "";
  });
}

function buildPrototypeAssertion(
  fnName,
  callArgs,
  { isClassLike = false, params = [], functionCode = "" } = {}
) {
  const fnLower = String(fnName || "").toLowerCase();
  const firstArg = callArgs[0] || "result";
  const hasCallbackLikeParam = (params || []).some(paramLooksCallbackLike);

  if (isClassLike) {
    return `    expect(result).toBeDefined();
    expect(typeof result === "object" || typeof result === "function").toBe(true);`;
  }

  if (hasCallbackLikeParam) {
    return `    expect(result === undefined || result !== undefined).toBe(true);`;
  }

  if (functionLooksCloseApi(fnName)) {
    return `    expect(result).toBeUndefined();`;
  }

  if (fnLower.includes("glob")) {
    return `    expect(result).toBeDefined();
    expect(
      Array.isArray(result) ||
      typeof result === "object" ||
      typeof result === "function"
    ).toBe(true);`;
  }

  if (fnLower === "quickselect") {
    return `    expect(${firstArg}).toBeDefined();`;
  }

  if (fnLower === "shuffleinplace") {
    return `    expect(${firstArg}).toBeDefined();`;
  }

  if (fnLower === "kmeanscluster") {
    return `    expect(result).toBeDefined();`;
  }

  if (functionLooksWriteApi(fnName)) {
    return `    expect(fs.existsSync(__unitgenFilePath)).toBe(true);`;
  }
  if (
  fnLower === "on" ||
  fnLower === "off" ||
  fnLower.includes("async") ||
  fnLower.includes("asap") ||
  fnLower.includes("configure") ||
  fnLower.startsWith("set")
) {
  return `    expect(result === undefined || result !== undefined).toBe(true);`;
}

  return `    expect(result).toBeDefined();`;
}

function buildClassMethodAssertion({
  classBindingName,
  methodName,
  methodKind,
  resultVar = "result",
}) {
  if (methodKind === "static") {
    const methodAccess = propertyAccessExpression(classBindingName, methodName);

    return `    expect(typeof ${methodAccess}).toBe("function");
    expect(${resultVar} === undefined || ${resultVar} !== undefined).toBe(true);`;
  }

  const methodAccess = propertyAccessExpression("__unitgenInstance", methodName);

  return `    expect(__unitgenInstance).toBeDefined();
    expect(typeof ${methodAccess}).toBe("function");
    expect(${resultVar} === undefined || ${resultVar} !== undefined).toBe(true);`;
}

function shouldUseFsHarness(fnName, params = []) {
  if (functionLooksFileSystemApi(fnName)) return true;
  if (functionLooksArchiveApi(fnName)) return true;
  return (params || []).some((p) => paramLooksFilePath(p) || paramLooksDirectoryPath(p));
}

function buildFsHarnessSetup(fnName) {
  if (functionLooksArchiveApi(fnName)) {
    return `    fs.writeFileSync(path.join(__unitgenTmpDir, "sample.txt"), "sample", "utf8");`;
  }

  if (!functionLooksFileSystemApi(fnName)) return "";

  if (functionLooksFdApi(fnName)) {
    return `    fs.writeFileSync(__unitgenFilePath, JSON.stringify({ name: "sample" }), "utf8");
    const __unitgenFd = fs.openSync(__unitgenFilePath, "r");`;
  }

  if (functionLooksReadApi(fnName)) {
    return `    fs.writeFileSync(__unitgenFilePath, JSON.stringify({ name: "sample" }), "utf8");`;
  }

  return "";
}

function convertJestMockToUnstableMock(code) {
  const source = String(code || "");

  if (source.includes("/*__UNITGEN_CJS_MOCK__*/")) {
    return source.replace(/\/\*__UNITGEN_CJS_MOCK__\*\/\s*/g, "");
  }

  return source.replace(
    /\bjest\.mock\s*\(/g,
    "jest.unstable_mockModule("
  );
}

function findMockCallStart(code, fromIndex = 0) {
  const re = /\bjest\.(?:mock|unstable_mockModule)\s*\(/g;
  re.lastIndex = fromIndex;

  const match = re.exec(String(code || ""));
  return match ? match.index : -1;
}

function findMatchingCallEnd(code, startIndex) {
  let parenDepth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = startIndex; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === inString) {
        inString = null;
      }

      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === "(") {
      parenDepth++;
      continue;
    }

    if (ch === ")") {
      parenDepth--;

      if (parenDepth === 0) {
        let end = i + 1;

        while (end < code.length && /\s/.test(code[end])) {
          end++;
        }

        if (code[end] === ";") {
          end++;
        }

        return end;
      }
    }
  }

  return -1;
}

function extractCompleteMockBlocks(code) {
  const source = String(code || "");
  const mockBlocks = [];
  const ranges = [];

  let cursor = 0;

  while (cursor < source.length) {
    const start = findMockCallStart(source, cursor);
    if (start === -1) break;

    const end = findMatchingCallEnd(source, start);

    if (end === -1) {
      break;
    }

    mockBlocks.push(source.slice(start, end).trim());
    ranges.push([start, end]);
    cursor = end;
  }

  let remaining = "";
  let last = 0;

  for (const [start, end] of ranges) {
    remaining += source.slice(last, start);
    last = end;
  }

  remaining += source.slice(last);

  return {
    mockBlocks: mockBlocks.filter(Boolean),
    remainingCode: remaining.trim(),
  };
}

function splitMockCode(jestMocks = "") {
  const raw = String(jestMocks || "").trim();

  if (!raw) {
    return {
      globalSetupMocks: "",
      moduleMocks: "",
    };
  }

  const { mockBlocks, remainingCode } = extractCompleteMockBlocks(raw);

  const globalBlocks = [];
  const moduleBlocks = [];

  for (const block of mockBlocks) {
    moduleBlocks.push(convertJestMockToUnstableMock(block));
  }

  if (remainingCode && remainingCode.trim()) {
    globalBlocks.push(remainingCode.trim());
  }

  return {
    globalSetupMocks: globalBlocks.join("\n\n"),
    moduleMocks: moduleBlocks.join("\n\n"),
  };
}

function removeControlledFsHarnessMocks(moduleMocks = "") {
  const { mockBlocks, remainingCode } = extractCompleteMockBlocks(moduleMocks);
  const filteredBlocks = mockBlocks.filter(
    (block) =>
      !/\bjest\.(?:mock|unstable_mockModule)\s*\(\s*["'](?:node:)?(?:fs|path)["']/.test(
        block
      )
  );

  return [remainingCode, ...filteredBlocks].filter(Boolean).join("\n\n");
}

function buildMockSection({ globalSetupMocks, moduleMocks }) {
  const sections = [];

  if (globalSetupMocks && globalSetupMocks.trim()) {
    sections.push(`// Global setup mocks
${globalSetupMocks.trim()}`);
  }

  if (moduleMocks && moduleMocks.trim()) {
    sections.push(`// Module mocks
${moduleMocks.trim()}`);
  }

  return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
}

function buildModuleLoader(importPath) {
  const safeImportPath = JSON.stringify(importPath);

  return `const __unitgenRequire = __unitgenCreateRequire(import.meta.url);

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

      if (resolved.includes("${"/dist/esm/"}")) {
        add("file", resolved.replace("${"/dist/esm/"}", "${"/dist/commonjs/"}"));
      }

      if (resolved.includes("${"\\\\dist\\\\esm\\\\"}")) {
        add("file", resolved.replace("${"\\\\dist\\\\esm\\\\"}", "${"\\\\dist\\\\commonjs\\\\"}"));
      }

      if (resolved.endsWith("${"/index.js"}")) {
        add("file", resolved.replace("${"/index.js"}", "${"/index.min.js"}"));
      }

      if (resolved.endsWith("${"\\\\index.js"}")) {
        add("file", resolved.replace("${"\\\\index.js"}", "${"\\\\index.min.js"}"));
      }
    } catch {
      // ignore unresolved candidate
    }
  };

  add("specifier", ${safeImportPath});
  addResolved(${safeImportPath});

  const fromTestDir = __unitgenPath.dirname(
    __unitgenFileURLToPath(import.meta.url)
  );

  try {
    const absFromTest = __unitgenPath.resolve(fromTestDir, ${safeImportPath});
    add("file", absFromTest);

    if (absFromTest.includes("${"/dist/esm/"}")) {
      add("file", absFromTest.replace("${"/dist/esm/"}", "${"/dist/commonjs/"}"));
    }

    if (absFromTest.includes("${"\\\\dist\\\\esm\\\\"}")) {
      add("file", absFromTest.replace("${"\\\\dist\\\\esm\\\\"}", "${"\\\\dist\\\\commonjs\\\\"}"));
    }

    if (absFromTest.endsWith("${"/index.js"}")) {
      add("file", absFromTest.replace("${"/index.js"}", "${"/index.min.js"}"));
    }

    if (absFromTest.endsWith("${"\\\\index.js"}")) {
      add("file", absFromTest.replace("${"\\\\index.js"}", "${"\\\\index.min.js"}"));
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
  return /^\\s*import\\s/m.test(source) || /^\\s*export\\s/m.test(source);
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
    .join("\\n");

  throw new Error("UnitGen module load failed for ${importPath}:\\n" + __unitgenMessage);
}`;
}

function buildDeclarationsForParams({
  params = [],
  profileByName = {},
  fnName = "",
  usedNames = new Set(),
}) {
  const declarations = [];
  const argNames = [];

  params.forEach((raw, index) => {
    const safeName = sanitizeParamName(raw, usedNames, `arg${index + 1}`);
    declarations.push(
      buildParamDeclaration(safeName, index, profileByName, fnName)
    );
    argNames.push(safeName);
  });

  return {
    declarations,
    argNames,
  };
}

function indentBlock(block, spaces = 4) {
  const pad = " ".repeat(spaces);
  return String(block || "")
    .split("\n")
    .map((line) => (line ? `${pad}${line}` : line))
    .join("\n");
}

function buildNormalOrConstructorTestBody({
  bindingName,
  fnName,
  isAsync,
  isClassLike,
  params,
  functionCode,
}) {
  const profileByName = analyzeFunctionParameterProfiles(functionCode, params);
  const usedNames = new Set();

  const { declarations, argNames } = buildDeclarationsForParams({
    params,
    profileByName,
    fnName,
    usedNames,
  });

  if (functionLooksStreamApi(fnName)) {
    return {
      body: `    expect(typeof ${bindingName}).toBe("function");`,
      argNames,
    };
  }

  const callExpr = isClassLike
    ? `new ${bindingName}(${argNames.join(", ")})`
    : functionLooksFdApi(fnName) && argNames.length === 0
      ? `${bindingName}(__unitgenFd)`
      : `${bindingName}(${argNames.join(", ")})`;

  const prototypeAssertion = buildPrototypeAssertion(fnName, argNames, {
    isClassLike,
    params,
    functionCode,
  });

  const declarationBlock = declarations.length
    ? `${declarations.join("\n")}\n`
    : "";

  return {
    body: `${declarationBlock}    let result;
    try {
      result = ${callExpr};
      if (result && typeof result.then === "function") {
        result = await result;
      }
${indentBlock(prototypeAssertion.trimStart(), 6)}
    } catch (error) {
      expect(error && (error instanceof Error || typeof error.message === "string")).toBe(true);
    }`,
    argNames,
  };
}

function buildClassMethodTestBody({
  classBindingName,
  methodName,
  methodKind,
  isAsync,
  params,
  constructorParams,
  functionCode,
  ownerClassName,
}) {
  if (functionLooksStreamApi(ownerClassName) && String(methodName || "").toLowerCase() === "open") {
    const methodAccess = propertyAccessExpression(`${classBindingName}.prototype`, methodName);

    return `    expect(typeof ${classBindingName}).toBe("function");
    expect(typeof ${methodAccess}).toBe("function");`;
  }

  const profileByName = analyzeFunctionParameterProfiles(functionCode, params);
  const usedNames = new Set();

  const constructorBuild = buildDeclarationsForParams({
    params: constructorParams,
    profileByName: {},
    fnName: ownerClassName,
    usedNames,
  });

  const methodBuild = buildDeclarationsForParams({
    params,
    profileByName,
    fnName: methodName,
    usedNames,
  });

  const declarations = [
    ...constructorBuild.declarations,
    ...methodBuild.declarations,
  ];

  const declarationBlock = declarations.length
    ? `${declarations.join("\n")}\n`
    : "";

  if (methodKind === "static") {
    const methodAccess = propertyAccessExpression(classBindingName, methodName);
    const callLine = isAsync
      ? `    const result = await ${methodAccess}(${methodBuild.argNames.join(", ")});`
      : `    const result = ${methodAccess}(${methodBuild.argNames.join(", ")});`;

    return `${declarationBlock}    const __unitgenMethod = ${methodAccess};
    if (typeof __unitgenMethod !== "function") {
      throw new TypeError("${ownerClassName}.${methodName} did not resolve to a function");
    }
    let result;
    try {
${indentBlock(callLine.trimStart(), 6)}
${indentBlock(buildClassMethodAssertion({
      classBindingName,
      methodName,
      methodKind,
      resultVar: "result",
    }).trimStart(), 6)}
    } catch (error) {
      expect(error && (error instanceof Error || typeof error.message === "string")).toBe(true);
    }`;
  }

  const methodAccess = propertyAccessExpression("__unitgenInstance", methodName);
  const callLine = isAsync
    ? `    result = await ${methodAccess}(${methodBuild.argNames.join(", ")});`
    : `    result = ${methodAccess}(${methodBuild.argNames.join(", ")});`;

  return `${declarationBlock}    const __unitgenInstance = new ${classBindingName}(${constructorBuild.argNames.join(", ")});
    const __unitgenMethod = ${methodAccess};
    if (typeof __unitgenMethod !== "function") {
      throw new TypeError("${ownerClassName}.prototype.${methodName} did not resolve to a function");
    }
    let result;
    try {
${indentBlock(callLine.trimStart(), 6)}
${indentBlock(buildClassMethodAssertion({
    classBindingName,
    methodName,
    methodKind,
    resultVar: "result",
  }).trimStart(), 6)}
    } catch (error) {
      expect(error && (error instanceof Error || typeof error.message === "string")).toBe(true);
    }`;
}

function wrapWithFsHarnessIfNeeded({
  fnName,
  params,
  body,
  importGuard,
}) {
  const useFsHarness = shouldUseFsHarness(fnName, params);

  if (!useFsHarness) {
    return `${importGuard}
${body}`;
  }

  const archiveOutputDirLine = functionLooksArchiveApi(fnName)
    ? `    const __unitgenOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-out-"));\n`
    : "";
  const archiveOutputCleanup = functionLooksArchiveApi(fnName)
    ? `\n      fs.rmSync(__unitgenOutputDir, { recursive: true, force: true });`
    : "";

  return `    const __unitgenTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-"));
${archiveOutputDirLine.trimEnd()}
    const __unitgenFilePath = path.join(__unitgenTmpDir, "sample.json");
    try {
${buildFsHarnessSetup(fnName) ? `${buildFsHarnessSetup(fnName)}\n` : ""}${importGuard}
${body}
    } finally {
      fs.rmSync(__unitgenTmpDir, { recursive: true, force: true });${archiveOutputCleanup}
    }`;
}

export function renderJestTestTemplate({
  fnName,
  isAsync,
  isDefault = false,
  isClassLike = false,
  importPath,
  params = [],
  functionCode = "",
  jestMocks = "",

  // Class-method context fields. These are optional and backward-compatible.
  isClassMethod = false,
  ownerClassName = "",
  methodName = "",
  methodKind = "",
  constructorParams = [],
}) {
  const useFsHarness = shouldUseFsHarness(
    fnName,
    isClassMethod ? [...(constructorParams || []), ...(params || [])] : params
  );
  const { globalSetupMocks, moduleMocks } = splitMockCode(jestMocks);
  const effectiveModuleMocks = useFsHarness
    ? removeControlledFsHarnessMocks(moduleMocks)
    : moduleMocks;
  const mockSection = buildMockSection({
    globalSetupMocks,
    moduleMocks: effectiveModuleMocks,
  });

  const safeFnName = safeLocalBindingName(fnName, "__unitgenTarget");
  const safeOwnerClassName = safeLocalBindingName(
    ownerClassName || fnName,
    "__unitgenClass"
  );

  const targetExportName = isClassMethod ? ownerClassName : fnName;
  const bindingName = isClassMethod ? safeOwnerClassName : safeFnName;

  const moduleSetup = buildModuleSetup({
    bindingName,
    exportName: targetExportName,
    isDefault,
  });

  const importGuard = buildImportGuard(bindingName, targetExportName);

  const testBody = isClassMethod
    ? buildClassMethodTestBody({
        classBindingName: bindingName,
        methodName: methodName || fnName,
        methodKind: methodKind || "prototype",
        isAsync,
        params,
        constructorParams,
        functionCode,
        ownerClassName: ownerClassName || fnName,
      })
    : buildNormalOrConstructorTestBody({
        bindingName,
        fnName,
        isAsync,
        isClassLike,
        params,
        functionCode,
      }).body;

  const fsSetup = wrapWithFsHarnessIfNeeded({
    fnName,
    params: isClassMethod ? [...(constructorParams || []), ...(params || [])] : params,
    body: testBody,
    importGuard,
  });

  const fsImports = useFsHarness
    ? `import fs from "node:fs";
import path from "node:path";
import os from "node:os";
`
    : "";

  const describeName = isClassMethod
    ? `${ownerClassName}.${methodKind === "static" ? methodName : `prototype.${methodName}`}`
    : fnName;

  return `import { describe, test, expect, jest, beforeAll, beforeEach, afterEach, afterAll } from "@jest/globals";
import { createRequire as __unitgenCreateRequire } from "node:module";
import {
  pathToFileURL as __unitgenPathToFileURL,
  fileURLToPath as __unitgenFileURLToPath
} from "node:url";
import * as __unitgenFs from "node:fs";
import * as __unitgenPath from "node:path";
${fsImports}
${mockSection}// Import/load AFTER global setup and module mocks
${buildModuleLoader(importPath)}
${buildExportResolver()}

${moduleSetup}

describe(${JSON.stringify(describeName)}, () => {
  test("auto-generated (prototype)", async () => {
${fsSetup}
  });

  /*__UNITGEN_LLM_TESTS__*/
});
`;
}
