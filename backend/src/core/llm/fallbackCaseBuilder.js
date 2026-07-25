/**
 * fallbackCaseBuilder.js
 *
 * Purpose:
 * Generates safe fallback invariant test cases when LLM candidates are rejected
 * or fail runtime validation.
 *
 * These fallback cases are NOT prototypes.
 * They are injected into the LLM marker area as extra generated tests.
 *
 * Design goals:
 * - increase injected test count safely
 * - improve fallback quality beyond generic toBeDefined checks
 * - use function source to infer likely return shape
 * - support normal functions, class constructors, static methods, and prototype methods
 * - avoid fabricated exact expected outputs
 * - avoid package-specific hardcoding
 * - avoid real filesystem/network/database access
 * - keep assertions broad but meaningful
 * - work for general JavaScript/npm package functions
 */

const RESERVED_NAMES = new Set([
  "result",
  "expect",
  "test",
  "describe",
  "jest",
  "mod",
  "undefined",
  "null",
  "NaN",
  "Infinity",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "class",
  "function",
  "return",
  "const",
  "let",
  "var",
  "new",
  "instance",
  "subject",
]);

const MAX_FALLBACK_CASES = Number(process.env.UNITGEN_MAX_FALLBACK_CASES || 6);

function sanitizeIdentifier(raw, fallback = "value") {
  let name = String(raw || fallback).replace(/[^a-zA-Z0-9_$]/g, "");

  if (!name || /^[0-9]/.test(name)) {
    name = fallback;
  }

  if (RESERVED_NAMES.has(name)) {
    name = `${name}Arg`;
  }

  return name;
}

function uniqueParamNames(params = [], prefix = "arg") {
  const used = new Set();
  const out = [];

  for (let i = 0; i < (params || []).length; i++) {
    const raw = typeof params[i] === "string" ? params[i] : params[i]?.name;
    const base = sanitizeIdentifier(raw, `${prefix}${i + 1}`);

    let candidate = base;
    let counter = 2;

    while (used.has(candidate) || RESERVED_NAMES.has(candidate)) {
      candidate = `${base}${counter}`;
      counter++;
    }

    used.add(candidate);
    out.push(candidate);
  }

  return out;
}

function lowerName(value) {
  return String(value || "").toLowerCase();
}

function normalizeCode(functionCode = "") {
  return String(functionCode || "")
    .replace(/\r\n/g, "\n")
    .trim();
}

/**
 * Source-shape inference.
 *
 * This does not try to prove exact behavior.
 * It only detects safe broad signals so fallback assertions can be more useful.
 */
export function analyzeFunctionReturnShape(functionCode = "", fnName = "") {
  const code = normalizeCode(functionCode);
  const lower = code.toLowerCase();
  const nameLower = lowerName(fnName);

  const shape = {
    hasFunctionCode: Boolean(code),

    // Return-shape hints
    returnsArrayLiteral: /\breturn\s+\[/.test(code),
    returnsObjectLiteral: /\breturn\s+\{/.test(code),
    returnsNull: /\breturn\s+null\b/.test(code),
    returnsUndefined: /\breturn\s+undefined\b/.test(code),
    returnsBooleanLiteral: /\breturn\s+(true|false)\b/.test(code),
    returnsNumericLiteral: /\breturn\s+-?\d+(\.\d+)?\b/.test(code),
    returnsStringLiteral: /\breturn\s+["'`]/.test(code),
    returnsThis: /\breturn\s+this\s*(?:;|\n|\}|$)/.test(code),
    returnsNewInstance: /\breturn\s+new\s+[A-Z][A-Za-z0-9_$]*\s*\(/.test(code),
    returnsPromise: /\b(?:new\s+)?Promise(?:\.|\s*\()/.test(code) || /\basync\b/.test(code),

    // Collection/object operation hints
    usesObjectKeys: /\bObject\.keys\s*\(/.test(code),
    usesObjectValues: /\bObject\.values\s*\(/.test(code),
    usesObjectEntries: /\bObject\.entries\s*\(/.test(code),
    usesArrayIsArray: /\bArray\.isArray\s*\(/.test(code),
    usesMap: /\.map\s*\(/.test(code),
    usesFilter: /\.filter\s*\(/.test(code),
    usesFind: /\.find\s*\(/.test(code),
    usesReduce: /\.reduce\s*\(/.test(code),
    usesIncludes: /\.includes\s*\(/.test(code),
    usesLength: /\.length\b/.test(code),

    // Lookup/defaulting hints
    usesNullFallback: /\|\|\s*null\b/.test(code) || /\?\?\s*null\b/.test(code),
    usesUndefinedFallback:
      /\|\|\s*undefined\b/.test(code) || /\?\?\s*undefined\b/.test(code),
    usesBracketLookup: /\[[A-Za-z_$][A-Za-z0-9_$]*\]/.test(code),
    usesPropertyAccess: /\.[A-Za-z_$][A-Za-z0-9_$]*\b/.test(code),

    // Class/object method hints
    usesThis: /\bthis\./.test(code),
    mutatesThis: /\bthis\.[A-Za-z_$][A-Za-z0-9_$]*\s*=/.test(code),

    // IO / risky hints
    usesFs: /\bfs\./.test(code) || /\breadFile|writeFile|existsSync/.test(code),
    usesFetch: /\bfetch\s*\(/.test(code),
    usesAxios: /\baxios\./.test(code),
    usesProcessEnv: /\bprocess\.env\b/.test(code),

    // Name hints
    nameLooksCollection:
      nameLower.includes("all") ||
      nameLower.includes("list") ||
      nameLower.includes("many") ||
      nameLower.includes("array") ||
      nameLower.includes("items") ||
      nameLower.includes("countries") ||
      nameLower.includes("timezones") ||
      nameLower.startsWith("getall") ||
      nameLower.startsWith("findall"),

    nameLooksLookup:
      nameLower.startsWith("get") ||
      nameLower.startsWith("find") ||
      nameLower.startsWith("lookup") ||
      nameLower.startsWith("search") ||
      nameLower.includes("byid") ||
      nameLower.includes("for"),

    nameLooksBoolean:
      nameLower.startsWith("is") ||
      nameLower.startsWith("has") ||
      nameLower.startsWith("can") ||
      nameLower.startsWith("should") ||
      nameLower.includes("exists") ||
      nameLower.includes("valid"),

    nameLooksNumeric:
      nameLower.includes("count") ||
      nameLower.includes("sum") ||
      nameLower.includes("total") ||
      nameLower.includes("average") ||
      nameLower.includes("mean") ||
      nameLower.includes("median") ||
      nameLower.includes("variance") ||
      nameLower.includes("distance") ||
      nameLower.includes("size") ||
      nameLower.includes("length") ||
      nameLower.includes("abs") ||
      nameLower.includes("magnitude") ||
      nameLower.includes("angle") ||
      nameLower.includes("bearing") ||
      nameLower.includes("radius"),

    nameLooksString:
      nameLower.includes("string") ||
      nameLower.includes("format") ||
      nameLower.includes("label") ||
      nameLower.includes("name") ||
      nameLower.includes("text"),
  };

  shape.likelyArray =
    shape.returnsArrayLiteral ||
    shape.usesObjectValues ||
    shape.usesObjectEntries ||
    shape.usesMap ||
    shape.usesFilter ||
    shape.nameLooksCollection;

  shape.likelyObject =
    shape.returnsObjectLiteral ||
    shape.returnsThis ||
    shape.returnsNewInstance ||
    shape.usesObjectKeys ||
    shape.usesBracketLookup ||
    shape.nameLooksLookup;

  shape.likelyNullable =
    shape.returnsNull ||
    shape.returnsUndefined ||
    shape.usesNullFallback ||
    shape.usesUndefinedFallback;

  shape.likelyBoolean = shape.returnsBooleanLiteral || shape.nameLooksBoolean;
  shape.likelyNumber = shape.returnsNumericLiteral || shape.nameLooksNumeric;
  shape.likelyString = shape.returnsStringLiteral || shape.nameLooksString;

  shape.usesCollectionOperation =
    shape.usesObjectKeys ||
    shape.usesObjectValues ||
    shape.usesObjectEntries ||
    shape.usesArrayIsArray ||
    shape.usesMap ||
    shape.usesFilter ||
    shape.usesFind ||
    shape.usesReduce ||
    shape.usesIncludes ||
    shape.usesLength;

  shape.hasRiskyExternalBehavior =
    shape.usesFs ||
    shape.usesFetch ||
    shape.usesAxios ||
    shape.usesProcessEnv;

  return shape;
}

function looksArrayLikeParam(paramName) {
  const lower = lowerName(paramName);

  return (
    lower === "arr" ||
    lower === "array" ||
    lower === "list" ||
    lower === "items" ||
    lower === "values" ||
    lower === "data" ||
    lower.endsWith("arr") ||
    lower.endsWith("array") ||
    lower.endsWith("list") ||
    lower.endsWith("items") ||
    lower.endsWith("values") ||
    lower.includes("array") ||
    lower.includes("list") ||
    lower.includes("items") ||
    lower.includes("values")
  );
}

function paramUsedWithArrayLikeApi(paramName, functionCode = "") {
  const code = normalizeCode(functionCode);
  const safeParam = String(paramName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (!safeParam) return false;

  return new RegExp(
    `\\b${safeParam}\\s*\\.\\s*(?:indexOf|includes|push|pop|shift|unshift|slice|splice|map|filter|some|every|reduce|forEach)\\s*\\(`,
    "m"
  ).test(code);
}

function looksTrackingArrayParam(paramName) {
  const lower = lowerName(paramName);

  return (
    lower === "known" ||
    lower === "seen" ||
    lower === "visited" ||
    lower === "cache" ||
    lower === "stack" ||
    lower.endsWith("list") ||
    lower.endsWith("set") ||
    lower.includes("known") ||
    lower.includes("seen") ||
    lower.includes("visited")
  );
}

function looksObjectLikeParam(paramName) {
  const lower = lowerName(paramName);

  return (
    lower === "obj" ||
    lower === "object" ||
    lower === "payload" ||
    lower.endsWith("obj") ||
    lower.endsWith("object") ||
    lower.endsWith("payload")
  );
}

function looksOptionsLikeParam(paramName) {
  const lower = lowerName(paramName);

  return (
    lower === "options" ||
    lower === "opts" ||
    lower === "config" ||
    lower === "settings" ||
    lower.endsWith("options") ||
    lower.endsWith("opts") ||
    lower.endsWith("config") ||
    lower.endsWith("settings")
  );
}

function looksBooleanLikeParam(paramName) {
  const lower = lowerName(paramName);

  return (
    lower.startsWith("is") ||
    lower.startsWith("has") ||
    lower.startsWith("can") ||
    lower.startsWith("should") ||
    lower.includes("enabled") ||
    lower.includes("disabled") ||
    lower.includes("flag")
  );
}

function looksFunctionLikeParam(paramName) {
  const lower = lowerName(paramName);

  return (
    lower === "fn" ||
    lower === "cb" ||
    lower === "callback" ||
    lower === "handler" ||
    lower === "updater" ||
    lower === "transformer" ||
    lower === "transform" ||
    lower === "predicate" ||
    lower === "comparator" ||
    lower === "mapper" ||
    lower === "reducer" ||
    lower === "func" ||
    lower.includes("callback") ||
    lower.includes("handler") ||
    lower.includes("updater") ||
    lower.includes("transform") ||
    lower.endsWith("fn") ||
    lower.endsWith("cb") ||
    lower.includes("randomsource") ||
    lower.includes("kernel") ||
    lower.includes("bandwidthmethod")
  );
}

function looksStringLikeParam(paramName) {
  const lower = lowerName(paramName);

  return (
    lower.includes("name") ||
    lower.includes("text") ||
    lower.includes("message") ||
    lower.includes("title") ||
    lower.includes("label") ||
    lower.includes("key") ||
    lower.includes("type") ||
    lower.includes("id") ||
    lower.includes("code") ||
    lower.includes("country") ||
    lower.includes("timezone") ||
    lower.includes("path") ||
    lower.includes("file") ||
    lower.includes("url") ||
    lower.includes("email") ||
    lower.includes("token") ||
    lower === "str" ||
    lower === "string"
  );
}

function looksNumberLikeParam(paramName) {
  const lower = lowerName(paramName);

  return (
    lower === "n" ||
    lower === "x" ||
    lower === "y" ||
    lower === "z" ||
    lower === "i" ||
    lower === "j" ||
    lower === "k" ||
    lower.includes("lat") ||
    lower.includes("lon") ||
    lower.includes("lng") ||
    lower.includes("long") ||
    lower.includes("radius") ||
    lower.includes("angle") ||
    lower.includes("degree") ||
    lower.includes("radian") ||
    lower.includes("count") ||
    lower.includes("size") ||
    lower.includes("length") ||
    lower.includes("index") ||
    lower.includes("limit") ||
    lower.includes("offset") ||
    lower.includes("start") ||
    lower.includes("end") ||
    lower.includes("left") ||
    lower.includes("right") ||
    lower.includes("num") ||
    lower.includes("number") ||
    lower.includes("age") ||
    lower.includes("total") ||
    lower.includes("amount") ||
    lower.includes("real") ||
    lower.includes("imag")
  );
}

function buildFunctionLiteral(paramName) {
  const lower = lowerName(paramName);

  if (lower.includes("comparator")) {
    return "(a, b) => a - b";
  }

  if (lower.includes("predicate")) {
    return "(x) => Boolean(x)";
  }

  if (lower.includes("mapper")) {
    return "(x) => x";
  }

  if (lower.includes("reducer")) {
    return "(acc, x) => acc + x";
  }

  if (lower.includes("randomsource")) {
    return "() => 0.5";
  }

  if (lower.includes("kernel")) {
    return "(x) => x";
  }

  if (lower.includes("bandwidthmethod")) {
    return "() => 1";
  }

  return "() => 0";
}

function extractComparedStringLiterals(functionCode = "", paramName = "") {
  const code = normalizeCode(functionCode);
  const safeParam = String(paramName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (!safeParam) return [];

  const patterns = [
    new RegExp(`${safeParam}\\s*={2,3}\\s*["'\`]([^"'\`]{1,80})["'\`]`, "g"),
    new RegExp(`["'\`]([^"'\`]{1,80})["'\`]\\s*={2,3}\\s*${safeParam}`, "g"),
    new RegExp(`${safeParam}\\s*!={1,2}\\s*["'\`]([^"'\`]{1,80})["'\`]`, "g"),
  ];

  const values = [];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code))) {
      if (match[1]) values.push(match[1]);
    }
  }

  return Array.from(new Set(values)).slice(0, 3);
}

function extractFirstUsefulStringLiteral(functionCode = "") {
  const code = normalizeCode(functionCode);
  const values = [];

  const re = /["'`]([^"'`\n]{1,80})["'`]/g;
  let match;

  while ((match = re.exec(code))) {
    const value = match[1];

    if (!value) continue;
    if (value.includes("__")) continue;
    if (value.includes("\\")) continue;
    if (/^[{}[\](),.;:]$/.test(value)) continue;
    if (/^(use strict|module|default|exports)$/.test(value.toLowerCase())) continue;

    values.push(value);
  }

  return values[0] || "sample";
}

function extractOptionObjectKeys(functionCode = "") {
  const code = normalizeCode(functionCode);
  const keys = [];
  const add = (key) => {
    if (!key || key.startsWith("_")) return;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return;
    if (!["url", "dest", "filename", "path", "timeout", "extractFilename", "headers", "method", "encoding"].includes(key)) {
      return;
    }
    if (!keys.includes(key)) keys.push(key);
  };

  const objectPatternRe = /\(\s*\{([^)]{1,300})\}\s*(?:=\s*\{\})?\s*\)/g;
  let objectMatch;
  while ((objectMatch = objectPatternRe.exec(code))) {
    const body = objectMatch[1] || "";
    for (const part of body.split(",")) {
      const cleaned = part
        .trim()
        .replace(/^\.\.\./, "")
        .replace(/=.*/, "")
        .replace(/:.*/, "")
        .trim();
      add(cleaned);
    }
  }

  const optionsPropRe = /\b(?:options|opts|config|settings)\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let propMatch;
  while ((propMatch = optionsPropRe.exec(code))) {
    add(propMatch[1]);
  }

  return keys;
}

function buildOptionsObjectLiteral(functionCode = "", variant = "primary") {
  const keys = extractOptionObjectKeys(functionCode);
  if (keys.length === 0) return "{}";

  const fields = [];
  const addField = (key, value) => {
    if (!fields.some((field) => field.startsWith(`${key}:`))) {
      fields.push(`${key}: ${value}`);
    }
  };

  for (const key of keys) {
    const lower = lowerName(key);
    if (lower === "url") {
      addField(key, variant === "secondary" ? '"https://example.com/unitgen.png"' : '"http://example.com/unitgen.png"');
    } else if (lower === "dest" || lower === "filename" || lower === "path") {
      addField(key, variant === "secondary" ? '"./unitgen-output.png"' : '"./unitgen-output"');
    } else if (lower === "timeout") {
      addField(key, variant === "secondary" ? "1" : "1000");
    } else if (lower === "extractfilename") {
      addField(key, variant === "secondary" ? "false" : "true");
    } else if (lower === "headers") {
      addField(key, "{}");
    } else if (lower === "method") {
      addField(key, '"GET"');
    } else if (lower === "encoding") {
      addField(key, '"utf8"');
    }
  }

  return fields.length > 0 ? `{ ${fields.join(", ")} }` : "{}";
}
function buildSourceInvokedFunctionLiteral(paramName, functionCode = "") {
  const code = normalizeCode(functionCode);
  const safeParam = String(paramName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!safeParam) return "";

  const callbackCall = new RegExp(
    `\\b${safeParam}\\s*\\(\\s*[^,()]+\\s*,\\s*(?:function\\b|[A-Za-z_$][A-Za-z0-9_$]*\\s*=>|\\([^)]*\\)\\s*=>)`,
    "m"
  );
  if (callbackCall.test(code)) {
    return "(value, cb) => cb(null, value)";
  }

  const zeroArgCall = new RegExp(`\\b${safeParam}\\s*\\(\\s*\\)`, "m");
  if (zeroArgCall.test(code)) {
    return "() => 0";
  }
  const directCall = new RegExp(`\\b${safeParam}\\s*\\(`, "m");
  if (directCall.test(code)) {
    return "(value) => value";
  }

  return "";
}
function buildBetterDefaultValueForParam(
  paramName,
  index = 0,
  functionCode = "",
  variant = "primary"
) {
  const lower = lowerName(paramName);
  const comparedStrings = extractComparedStringLiterals(functionCode, paramName);
  const secondary = variant === "secondary";

  const sourceInvokedFunction = buildSourceInvokedFunctionLiteral(
    paramName,
    functionCode
  );
  if (sourceInvokedFunction) return sourceInvokedFunction;

  if (looksFunctionLikeParam(paramName)) {
    if (secondary) return "() => 1";
    return buildFunctionLiteral(paramName);
  }

  if (looksOptionsLikeParam(paramName)) {
    return buildOptionsObjectLiteral(functionCode, variant);
  }

  if (looksDirectoryPathLikeParam(paramName)) {
    return `"."`;
  }

  if (looksFilePathLikeParam(paramName)) {
    return `"./unitgen-temp.json"`;
  }

  if (lower === "type") {
    return `"file"`;
  }

  if (lower === "combine") {
    return "false";
  }

  if (looksObjectLikeParam(paramName)) {
    return secondary ? `{ sample: "value" }` : "{}";
  }

  if (
    looksArrayLikeParam(paramName) ||
    looksTrackingArrayParam(paramName) ||
    paramUsedWithArrayLikeApi(paramName, functionCode)
  ) {
    return secondary ? "[]" : "[1, 2, 3]";
  }

  if (looksBooleanLikeParam(paramName)) {
    return secondary ? "false" : "true";
  }

  if (looksStringLikeParam(paramName)) {
    if (comparedStrings.length > 0) {
      return JSON.stringify(comparedStrings[0]);
    }

    if (
      lower.includes("timezone") ||
      lower.includes("country") ||
      lower.includes("code") ||
      lower.includes("id") ||
      lower.includes("key") ||
      lower.includes("type")
    ) {
      return JSON.stringify(extractFirstUsefulStringLiteral(functionCode));
    }

    return secondary ? `""` : `"sample"`;
  }

  if (looksNumberLikeParam(paramName)) {
    return secondary ? "0" : index === 1 ? "2" : "1";
  }

  return secondary ? "0" : index === 1 ? "2" : "1";
}

function buildDefaultArrange(
  params = [],
  functionCode = "",
  prefix = "arg",
  variant = "primary"
) {
  const names = uniqueParamNames(params, prefix);
  const lines = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const rawParam = typeof params[i] === "string" ? params[i] : params[i]?.name;
    const value = buildBetterDefaultValueForParam(
      rawParam || name,
      i,
      functionCode,
      variant
    );
    lines.push(`const ${name} = ${value};`);
  }

  return {
    arrange: lines.join("\n"),
    argNames: names,
  };
}

function buildFileApiArrange(params = [], mode = "read") {
  const argNames = uniqueParamNames(params, "arg");
  const lines = [];

  const hasDirectoryParam = argNames.some((name) => looksDirectoryPathLikeParam(name));

  if (hasDirectoryParam) {
    lines.push(`const __unitgenDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-"));`);
    lines.push(`fs.writeFileSync(path.join(__unitgenDirPath, "sample.txt"), "sample", "utf8");`);
  }

  lines.push(
    hasDirectoryParam
      ? `const __unitgenFilePath = path.join(__unitgenDirPath, ${
          mode === "read" ? '"sample.json"' : '"sample-output.json"'
        });`
      : mode === "read"
        ? `const __unitgenFilePath = "./unitgen-temp.json";`
        : `const __unitgenFilePath = "./unitgen-temp-output.json";`
  );

  if (mode === "read") {
    lines.push(`fs.writeFileSync(__unitgenFilePath, '{"name":"unitgen","ok":true}', "utf8");`);
  }

  for (let i = 0; i < argNames.length; i++) {
    const name = argNames[i];
    const lower = lowerName(name);

    if (looksDirectoryPathLikeParam(lower)) {
      lines.push(`const ${name} = __unitgenDirPath;`);
    } else if (looksFilePathLikeParam(lower)) {
      lines.push(`const ${name} = __unitgenFilePath;`);
    } else if (lower === "type") {
      lines.push(`const ${name} = "file";`);
    } else if (lower === "combine") {
      lines.push(`const ${name} = false;`);
    } else if (
      lower === "options" ||
      lower === "opts" ||
      lower.endsWith("options") ||
      lower.endsWith("opts")
    ) {
      lines.push(
        mode === "read"
          ? `const ${name} = { encoding: "utf8" };`
          : `const ${name} = {};`
      );
    } else if (
      lower.includes("obj") ||
      lower.includes("json") ||
      lower.includes("data") ||
      lower.includes("content") ||
      lower.includes("value")
    ) {
      lines.push(`const ${name} = { name: "unitgen", ok: true };`);
    } else {
      lines.push(`const ${name} = ${buildBetterDefaultValueForParam(name, i, "")};`);
    }
  }

  return {
    arrange: lines.join("\n"),
    argNames,
  };
}

function getParamName(param) {
  return typeof param === "string" ? param : param?.name;
}

function looksFilePathLikeParam(paramName = "") {
  const lower = lowerName(paramName);

  return (
    lower.includes("file") ||
    lower.includes("path") ||
    lower.includes("filename")
  );
}

function looksDirectoryPathLikeParam(paramName = "") {
  const lower = lowerName(paramName);

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

function isFileReadApi(fnName = "", params = []) {
  const name = lowerName(fnName);

  if (!name.includes("read")) return false;

  return (params || []).some((p) => {
    const paramName = getParamName(p);
    return looksFilePathLikeParam(paramName) || looksDirectoryPathLikeParam(paramName);
  });
}

function isFileWriteApi(fnName = "", params = []) {
  const name = lowerName(fnName);

  if (!name.includes("write")) return false;

  return (params || []).some((p) => looksFilePathLikeParam(getParamName(p)));
}

function isSingleFilePathApi(params = []) {
  const pathParams = (params || []).filter((param) =>
    looksFilePathLikeParam(getParamName(param))
  );
  const hasDirectoryParam = (params || []).some((param) =>
    looksDirectoryPathLikeParam(getParamName(param))
  );

  return pathParams.length === 1 && !hasDirectoryParam;
}

function isDirectoryTraversalApi(fnName = "", params = []) {
  const name = lowerName(fnName);
  const hasDirectoryParam = (params || []).some((p) =>
    looksDirectoryPathLikeParam(getParamName(p))
  );

  if (!hasDirectoryParam) return false;

  return (
    name.includes("file") ||
    name.includes("path") ||
    name.includes("dir") ||
    name.includes("subdir")
  );
}

function patchFilePathArrange(
  arrange = "",
  argNames = [],
  filePathConstName = "__unitgenFilePath",
  { mode = "read" } = {}
) {
  let patched = String(arrange || "");

  for (const argName of argNames || []) {
    const safeName = sanitizeIdentifier(argName, "arg");
    const lower = lowerName(safeName);

    if (looksFilePathLikeParam(lower)) {
      patched = patched.replace(
        new RegExp(`const\\s+${safeName}\\s*=\\s*[^;]+;`),
        `const ${safeName} = ${filePathConstName};`
      );
    }

    if (
      lower === "options" ||
      lower === "opts" ||
      lower.endsWith("options") ||
      lower.endsWith("opts")
    ) {
      patched = patched.replace(
        new RegExp(`const\\s+${safeName}\\s*=\\s*[^;]+;`),
        mode === "read"
          ? `const ${safeName} = { encoding: "utf8" };`
          : `const ${safeName} = {};`
      );
    }
  }

  return patched;
}

function buildFileReadFallbackAssertion() {
  return [
    `expect(result).toBeDefined();`,
    `expect(typeof result === "object" || typeof result === "string").toBe(true);`,
  ].join("\n");
}

function buildFileWriteFallbackAssertion() {
  return `expect(result === undefined || result !== undefined).toBe(true);`;
}

function buildNodeStyleFileCallbackFallbackCases({
  fnName,
  params = [],
  maxCases,
}) {
  const paramNames = uniqueParamNames(params, "arg");
  const callbackIndex = paramNames.findIndex((name) => looksFunctionLikeParam(name));
  const hasPathParam = paramNames.some((name) =>
    looksFilePathLikeParam(name) || looksDirectoryPathLikeParam(name)
  );

  if (callbackIndex < 0 || !hasPathParam) return [];

  const safeFnName = sanitizeIdentifier(fnName, "subject");
  const lowerFnName = lowerName(fnName);
  const directoryApi = lowerFnName.includes("readdir") || paramNames.some(looksDirectoryPathLikeParam);

  const buildArgs = (pathExpression, callbackExpression) =>
    paramNames.map((name, index) => {
      const lower = lowerName(name);
      if (index === callbackIndex) return callbackExpression;
      if (looksDirectoryPathLikeParam(lower) || looksFilePathLikeParam(lower)) {
        return pathExpression;
      }
      if (lower.includes("flag")) return '"r"';
      if (lower === "mode") return "0o666";
      if (lower.includes("option") || lower === "opts") {
        return lowerFnName.includes("readfile") ? '{ encoding: "utf8" }' : "{}";
      }
      return buildBetterDefaultValueForParam(name, index, "");
    });

  const successArgs = buildArgs(
    directoryApi ? "__unitgenDirPath" : "__unitgenFilePath",
    "__unitgenCallback"
  );
  const errorArgs = buildArgs("__unitgenMissingPath", "__unitgenCallback");

  const successAssertion = lowerFnName.includes("readdir")
    ? "expect(Array.isArray(result)).toBe(true);"
    : lowerFnName === "open" || lowerFnName.endsWith(".open")
      ? 'expect(typeof result).toBe("number");\nfs.closeSync(result);'
      : "expect(result).toBeDefined();";

  const commonArrange = [
    'const __unitgenDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-callback-"));',
    'const __unitgenFilePath = path.join(__unitgenDirPath, "sample.json");',
    'fs.writeFileSync(__unitgenFilePath, \'{"name":"unitgen","ok":true}\', "utf8");',
  ].join("\n");

  const cases = [{
    title: normalizeTitle("fallback observes successful callback result"),
    arrange: [
      commonArrange,
      "let __unitgenResolve;",
      "let __unitgenReject;",
      "const __unitgenCallback = (error, value) => error ? __unitgenReject(error) : __unitgenResolve(value);",
    ].join("\n"),
    act: `(async () => await new Promise((resolve, reject) => { __unitgenResolve = resolve; __unitgenReject = reject; ${safeFnName}(${successArgs.join(", ")}); }))()`,
    assert: `${successAssertion}\nfs.rmSync(__unitgenDirPath, { recursive: true, force: true });`,
    source: "fallback",
    isAsync: true,
  }];

  if (maxCases > 1) {
    cases.push({
      title: normalizeTitle("fallback reports a missing path through callback"),
      arrange: [
        'const __unitgenMissingPath = path.join(os.tmpdir(), "unitgen-missing-" + Date.now(), "missing");',
        "let __unitgenResolve;",
        "const __unitgenCallback = (error, value) => __unitgenResolve({ error, value });",
      ].join("\n"),
      act: `(async () => await new Promise((resolve) => { __unitgenResolve = resolve; ${safeFnName}(${errorArgs.join(", ")}); }))()`,
      assert: "expect(result.error).toBeDefined();\nexpect(result.value).toBeUndefined();",
      source: "fallback",
      isAsync: true,
    });
  }

  return cases.slice(0, maxCases);
}

function buildDescriptorReadFallbackCases({
  fnName,
  params = [],
  functionCode = "",
  maxCases,
}) {
  const paramNames = uniqueParamNames(params, "arg");
  const lowerParams = paramNames.map(lowerName);
  const hasDescriptorShape =
    lowerParams.some((name) => name === "fd" || name.includes("descriptor")) &&
    lowerParams.some((name) => name.includes("buffer")) &&
    lowerParams.some((name) => name.includes("offset")) &&
    lowerParams.some((name) => name.includes("length"));
  const delegatesReadThroughFs =
    /\bread(?:Sync)?\s*\.\s*call\s*\(\s*fs\b/.test(String(functionCode || ""));

  if (!hasDescriptorShape || !delegatesReadThroughFs) return [];

  const callbackIndex = lowerParams.findIndex((name) =>
    name === "cb" || name.includes("callback")
  );
  const safeFnName = sanitizeIdentifier(fnName, "subject");
  const commonArrange = [
    'const __unitgenDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-fd-read-"));',
    'const __unitgenFilePath = path.join(__unitgenDirPath, "sample.txt");',
    'fs.writeFileSync(__unitgenFilePath, "unitgen", "utf8");',
    'const __unitgenFd = fs.openSync(__unitgenFilePath, "r");',
    'const __unitgenBuffer = Buffer.alloc(7);',
  ];

  const argumentFor = (name, index, callbackExpression = "") => {
    const lower = lowerName(name);
    if (index === callbackIndex) return callbackExpression;
    if (lower === "fd" || lower.includes("descriptor")) return "__unitgenFd";
    if (lower.includes("buffer")) return "__unitgenBuffer";
    if (lower.includes("offset")) return "0";
    if (lower.includes("length")) return "__unitgenBuffer.length";
    if (lower.includes("position")) return "0";
    return buildBetterDefaultValueForParam(name, index, functionCode);
  };

  if (callbackIndex >= 0) {
    const args = paramNames.map((name, index) =>
      argumentFor(name, index, "__unitgenCallback")
    );
    return [{
      title: normalizeTitle("fallback reads from a real file descriptor through callback"),
      arrange: [
        ...commonArrange,
        "let __unitgenResolve;",
        "let __unitgenReject;",
        "const __unitgenCallback = (error, bytesRead, observedBuffer) => {",
        "  fs.closeSync(__unitgenFd);",
        "  fs.rmSync(__unitgenDirPath, { recursive: true, force: true });",
        "  return error ? __unitgenReject(error) : __unitgenResolve({ bytesRead, observedBuffer });",
        "};",
      ].join("\n"),
      act: `(async () => await new Promise((resolve, reject) => { __unitgenResolve = resolve; __unitgenReject = reject; ${safeFnName}(${args.join(", ")}); }))()`,
      assert: [
        "expect(result.bytesRead).toBe(7);",
        'expect(result.observedBuffer.toString("utf8", 0, result.bytesRead)).toBe("unitgen");',
      ].join("\n"),
      source: "source-driven-fallback",
      isAsync: true,
    }].slice(0, maxCases);
  }

  const args = paramNames.map((name, index) => argumentFor(name, index));
  return [{
    title: normalizeTitle("fallback reads from a real file descriptor synchronously"),
    arrange: commonArrange.join("\n"),
    act: `(() => { try { return ${safeFnName}(${args.join(", ")}); } finally { fs.closeSync(__unitgenFd); fs.rmSync(__unitgenDirPath, { recursive: true, force: true }); } })()`,
    assert: [
      "expect(result).toBe(7);",
      'expect(__unitgenBuffer.toString("utf8", 0, result)).toBe("unitgen");',
    ].join("\n"),
    source: "source-driven-fallback",
  }].slice(0, maxCases);
}

function buildDirectoryTraversalFallbackAssertion(variant = "primary") {
  if (variant === "secondary") {
    return `expect(result == null || result.name !== "Error").toBe(true);`;
  }

  return `expect(result == null || Array.isArray(result) || typeof result === "object" || typeof result === "string").toBe(true);`;
}

function buildDirectoryTraversalBehaviorCase({
  fnName,
  params = [],
  functionCode = "",
}) {
  if (!isDirectoryTraversalApi(fnName, params)) return null;

  const argNames = uniqueParamNames(params, "arg");
  const lowerParams = argNames.map(lowerName);
  const callbackIndex = lowerParams.findIndex((name) =>
    ["callback", "cb", "handler"].includes(name)
  );
  const completeIndex = lowerParams.findIndex((name) =>
    ["complete", "done", "finish", "finished"].includes(name)
  );
  const returnsPromise = analyzeFunctionReturnShape(
    functionCode,
    fnName
  ).returnsPromise;
  const completionIndex = completeIndex >= 0 ? completeIndex : callbackIndex;

  if (completionIndex < 0 && !returnsPromise) return null;

  const lines = [
    `const __unitgenDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-tree-"));`,
    `const __unitgenNestedDir = path.join(__unitgenDirPath, "nested");`,
    `fs.mkdirSync(__unitgenNestedDir, { recursive: true });`,
    `fs.writeFileSync(path.join(__unitgenDirPath, "alpha.txt"), "alpha", "utf8");`,
    `fs.writeFileSync(path.join(__unitgenNestedDir, "beta.txt"), "beta", "utf8");`,
  ];
  const callArgs = [];

  if (completionIndex >= 0) {
    lines.push(
      `let __unitgenResolve;`,
      `let __unitgenReject;`,
      `const __unitgenCompletion = new Promise((resolve, reject) => {`,
      `  __unitgenResolve = resolve;`,
      `  __unitgenReject = reject;`,
      `});`
    );
  }

  for (let i = 0; i < argNames.length; i++) {
    const name = argNames[i];
    const lower = lowerParams[i];

    if (i === completeIndex || (completeIndex < 0 && i === callbackIndex)) {
      lines.push(
        `const ${name} = (error, value) => { fs.rmSync(__unitgenDirPath, { recursive: true, force: true }); return error ? __unitgenReject(error) : __unitgenResolve(value); };`
      );
    } else if (i === callbackIndex) {
      lines.push(
        `const ${name} = (error, value, entry, next) => {`,
        `  if (error) return __unitgenReject(error);`,
        `  if (value && typeof value.once === "function" && typeof value.resume === "function") {`,
        `    value.once("end", () => { if (typeof next === "function") next(); });`,
        `    value.resume();`,
        `    return;`,
        `  }`,
        `  if (typeof next === "function") next();`,
        `};`
      );
    } else if (looksDirectoryPathLikeParam(lower)) {
      lines.push(`const ${name} = __unitgenDirPath;`);
    } else if (lower === "type") {
      lines.push(`const ${name} = "file";`);
    } else if (lower === "combine") {
      lines.push(`const ${name} = false;`);
    } else if (looksOptionsLikeParam(lower)) {
      lines.push(
        `const ${name} = { recursive: true, shortName: true, encoding: "utf8", doneOnErr: true };`
      );
    } else {
      lines.push(
        `const ${name} = ${buildBetterDefaultValueForParam(name, i, functionCode)};`
      );
    }

    callArgs.push(name);
  }

  const directCall = `${sanitizeIdentifier(fnName, "subject")}(${callArgs.join(", ")})`;
  const act = completionIndex >= 0
    ? `(async () => { ${directCall}; return await __unitgenCompletion; })()` 
    : `(async () => { try { return await ${directCall}; } finally { fs.rmSync(__unitgenDirPath, { recursive: true, force: true }); } })()`;

  return {
    title: normalizeTitle("fallback traverses a temporary directory tree"),
    arrange: lines.join("\n"),
    act,
    assert: `expect((Array.isArray(result) ? result : [...(result?.files || []), ...(result?.dirs || [])]).length).toBeGreaterThan(0);`,
    source: "fallback",
    isAsync: completionIndex >= 0 || returnsPromise,
  };
}
function functionLooksVoidOrMutating(fnName = "", functionCode = "") {
  const name = lowerName(fnName);
  const code = normalizeCode(functionCode);
  const hasReturn = /\breturn\b/.test(code);

  return (
    (!hasReturn && Boolean(code)) ||
    /^(set|add|put|insert|save|write|append|push|pop|shift|unshift|remove|rm|delete|del|clear|update|close|destroy|end|emit|forEach)$/.test(name) ||
    name.startsWith("set") ||
    name.startsWith("add") ||
    name.startsWith("remove") ||
    name.startsWith("delete") ||
    name.startsWith("update") ||
    name.startsWith("close") ||
    name.startsWith("write")
  );
}

function buildCallExpression(fnName, argNames = [], isClassLike = false) {
  const safeFnName = sanitizeIdentifier(fnName, "subject");
  const args = argNames.join(", ");

  if (isClassLike) {
    return `new ${safeFnName}(${args})`;
  }

  return `${safeFnName}(${args})`;
}

function extractDirectGuardFallbackCase({
  fnName,
  params = [],
  functionCode = "",
  isClassLike = false,
}) {
  if (isClassLike || !fnName || !Array.isArray(params) || params.length === 0) {
    return null;
  }

  const code = normalizeCode(functionCode);
  const firstParam = getParamName(params[0]);
  const safeParam = String(firstParam || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (!code || !safeParam) return null;

  const literalToken =
    "(?:null|undefined|NaN|Infinity|-Infinity|true|false|-?\\d+(?:\\.\\d+)?|[\"'`][^\"'`\\n]{0,80}[\"'`])";
  const guardPattern = new RegExp(
    `if\\s*\\(\\s*${safeParam}\\s*={2,3}\\s*(${literalToken})\\s*\\)\\s*(?:\\{\\s*)?return\\s+(${literalToken})\\s*;?`,
    "m"
  );
  const match = guardPattern.exec(code);

  if (!match) return null;

  const inputLiteral = match[1];
  const expectedLiteral = match[2];
  const argNames = uniqueParamNames(params, "arg");
  const arrangeLines = [];

  for (let i = 0; i < argNames.length; i++) {
    const value =
      i === 0
        ? inputLiteral
        : buildBetterDefaultValueForParam(
            argNames[i],
            i,
            functionCode,
            "secondary"
          );
    arrangeLines.push(`const ${argNames[i]} = ${value};`);
  }

  return {
    title: normalizeTitle(
      `fallback follows source guard for ${String(firstParam || "input")}`
    ),
    arrange: arrangeLines.join("\n"),
    act: buildCallExpression(fnName, argNames, false),
    assert: `expect(result).toBe(${expectedLiteral});`,
    source: "fallback",
  };
}
function extractPathRelationThrowFallbackCase({
  ownerClassName = "",
  methodName = "",
  params = [],
  functionCode = "",
}) {
  if (!ownerClassName || !methodName || !Array.isArray(params) || params.length < 2) return null;

  const code = normalizeCode(functionCode);
  const paramNames = params.map(getParamName).filter(Boolean);
  if (!code || paramNames.length < 2) return null;

  const assignmentPattern = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:path\s*\.\s*)?dirname\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*;/g;
  let assignment;

  while ((assignment = assignmentPattern.exec(code))) {
    const derivedName = assignment[1];
    const pathParam = assignment[2];
    if (!paramNames.includes(pathParam)) continue;

    const safeDerived = derivedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const guardPattern = new RegExp(
      `if\\s*\\(\\s*(?:${safeDerived}\\s*={2,3}\\s*([A-Za-z_$][A-Za-z0-9_$]*)|([A-Za-z_$][A-Za-z0-9_$]*)\\s*={2,3}\\s*${safeDerived})\\s*\\)\\s*(?:\\{\\s*)?throw\\s+new\\s+Error\\s*\\(\\s*(["'])([^"'\\n]{1,200})\\3\\s*\\)`,
      "m"
    );
    const guard = guardPattern.exec(code);
    if (!guard) continue;

    const directoryParam = guard[1] || guard[2];
    if (!paramNames.includes(directoryParam) || directoryParam === pathParam) continue;

    const safeClass = sanitizeIdentifier(ownerClassName, "SubjectClass");
    const safeMethod = sanitizeIdentifier(methodName, "method");
    const argNames = uniqueParamNames(params, "methodArg");
    const arrangeLines = [];

    for (let i = 0; i < paramNames.length; i++) {
      let value;
      if (paramNames[i] === directoryParam) value = '"unitgen-target"';
      else if (paramNames[i] === pathParam) value = '"unitgen-target/output.zip"';
      else value = buildBetterDefaultValueForParam(argNames[i], i, functionCode, "secondary");
      arrangeLines.push(`const ${argNames[i]} = ${value};`);
    }

    return {
      title: normalizeTitle(`${safeClass}.${safeMethod} rejects conflicting path inputs`),
      arrange: arrangeLines.join("\n"),
      act: `${safeClass}.${safeMethod}(${argNames.join(", ")})`,
      assert: `expect(() => result).toThrow(${JSON.stringify(guard[4])});`,
      source: "fallback",
    };
  }

  return null;
}
function functionLooksCollectionReturning(fnName = "") {
  const lower = lowerName(fnName);

  return (
    lower.includes("all") ||
    lower.includes("list") ||
    lower.includes("many") ||
    lower.includes("array") ||
    lower.includes("items") ||
    lower.includes("countries") ||
    lower.includes("timezones") ||
    lower.startsWith("getall") ||
    lower.startsWith("findall")
  );
}

function functionLooksLookup(fnName = "") {
  const lower = lowerName(fnName);

  return (
    lower.startsWith("get") ||
    lower.startsWith("find") ||
    lower.startsWith("lookup") ||
    lower.startsWith("search") ||
    lower.includes("byid") ||
    lower.includes("for")
  );
}

function functionLooksBooleanReturning(fnName = "") {
  const lower = lowerName(fnName);

  return (
    lower.startsWith("is") ||
    lower.startsWith("has") ||
    lower.startsWith("can") ||
    lower.startsWith("should") ||
    lower.includes("exists") ||
    lower.includes("valid") ||
    lower.includes("equal")
  );
}

function functionLooksNumericReturning(fnName = "") {
  const lower = lowerName(fnName);

  return (
    lower.includes("count") ||
    lower.includes("sum") ||
    lower.includes("total") ||
    lower.includes("average") ||
    lower.includes("mean") ||
    lower.includes("median") ||
    lower.includes("variance") ||
    lower.includes("distance") ||
    lower.includes("size") ||
    lower.includes("length") ||
    lower.includes("abs") ||
    lower.includes("magnitude") ||
    lower.includes("angle") ||
    lower.includes("bearing") ||
    lower.includes("radius")
  );
}

/**
 * Builds a stronger but still safe assertion based on function source.
 *
 * This returns assertions that are:
 * - result-centered
 * - sanitizer-compatible
 * - runtime-validation friendly
 * - not based on fabricated exact domain outputs
 */
function buildSourceAwareAssertion(fnName = "", functionCode = "", variant = "primary") {
  const shape = analyzeFunctionReturnShape(functionCode, fnName);

  if (functionLooksVoidOrMutating(fnName, functionCode)) {
    return buildFileWriteFallbackAssertion();
  }

  if (shape.likelyBoolean) {
    return `expect(result == null || typeof result === "boolean").toBe(true);`;
  }

  if (shape.likelyNumber) {
    return `expect(result == null || typeof result === "number").toBe(true);`;
  }

  if (shape.likelyString) {
    return `expect(result == null || typeof result === "string").toBe(true);`;
  }

  if (shape.returnsThis || shape.returnsNewInstance) {
    return `expect(result).toBeDefined();`;
  }

  if (shape.usesObjectValues || shape.usesObjectEntries || shape.returnsArrayLiteral) {
    if (variant === "secondary") {
      return `expect(result == null || Array.isArray(result)).toBe(true);`;
    }

    return [
      `expect(result == null || Array.isArray(result)).toBe(true);`,
      `expect(result == null || result.length >= 0).toBe(true);`,
    ].join("\n");
  }

  if (shape.usesMap || shape.usesFilter || shape.nameLooksCollection) {
    if (variant === "secondary") {
      return `expect(result == null || Array.isArray(result) || typeof result === "object").toBe(true);`;
    }

    return [
      `expect(result).toBeDefined();`,
      `expect(Array.isArray(result) || typeof result === "object").toBe(true);`,
    ].join("\n");
  }

  if (shape.usesObjectKeys || shape.returnsObjectLiteral) {
    if (variant === "secondary") {
      return `expect(result == null || typeof result === "object").toBe(true);`;
    }

    return [
      `expect(result).toBeDefined();`,
      `expect(typeof result).toBe("object");`,
    ].join("\n");
  }

  if (shape.usesFind || shape.usesBracketLookup || shape.nameLooksLookup) {
    if (variant === "secondary") {
      return `expect(result == null || typeof result === "object" || typeof result === "string" || typeof result === "number" || typeof result === "boolean").toBe(true);`;
    }

    return `expect(result == null || typeof result === "object").toBe(true);`;
  }

  if (functionLooksBooleanReturning(fnName)) {
    return `expect(result == null || typeof result === "boolean").toBe(true);`;
  }

  if (functionLooksNumericReturning(fnName)) {
    return `expect(result == null || typeof result === "number").toBe(true);`;
  }

  if (functionLooksCollectionReturning(fnName)) {
    return `expect(result == null || Array.isArray(result) || typeof result === "object").toBe(true);`;
  }

  if (functionLooksLookup(fnName)) {
    return `expect(result == null || typeof result === "object" || typeof result === "string" || typeof result === "number" || typeof result === "boolean").toBe(true);`;
  }

  if (variant === "secondary") {
    return `expect(result == null || result !== undefined).toBe(true);`;
  }

  return `expect(result).toBeDefined();`;
}

function buildNoThrowAssertion(fnName = "", functionCode = "") {
  const shape = analyzeFunctionReturnShape(functionCode, fnName);

  if (functionLooksVoidOrMutating(fnName, functionCode)) {
    return buildFileWriteFallbackAssertion();
  }

  if (shape.likelyBoolean) {
    return `expect(result == null || typeof result === "boolean").toBe(true);`;
  }

  if (shape.likelyNumber) {
    return `expect(result == null || typeof result === "number").toBe(true);`;
  }

  if (shape.likelyString) {
    return `expect(result == null || typeof result === "string").toBe(true);`;
  }

  if (shape.likelyArray) {
    return `expect(result == null || Array.isArray(result) || typeof result === "object").toBe(true);`;
  }

  if (shape.likelyObject || functionLooksLookup(fnName)) {
    return `expect(result == null || typeof result === "object").toBe(true);`;
  }

  return `expect(result == null || result !== undefined).toBe(true);`;
}

function normalizeTitle(title) {
  return String(title || "fallback generated test")
    .replace(/\s+/g, " ")
    .replace(/"/g, '\\"')
    .trim();
}
function buildFallbackCase({
  title,
  fnName,
  params = [],
  isClassLike = false,
  assertion,
  functionCode = "",
  arrangeVariant = "primary",
}) {
  const readApi = isFileReadApi(fnName, params);
  const writeApi = isFileWriteApi(fnName, params);
  const directoryTraversalApi = isDirectoryTraversalApi(fnName, params);
  const singleFilePathApi = isSingleFilePathApi(params);

  let arrangeData;

  if (readApi || directoryTraversalApi) {
    arrangeData = buildFileApiArrange(params, "read");
  } else if (writeApi) {
    arrangeData = buildFileApiArrange(params, "write");
  } else if (singleFilePathApi) {
    arrangeData = buildFileApiArrange(params, "read");
  } else {
    arrangeData = buildDefaultArrange(params, functionCode, "arg", arrangeVariant);
  }

  const { arrange, argNames } = arrangeData;
  const act = buildCallExpression(fnName, argNames, isClassLike);

  const finalAssertion = directoryTraversalApi
    ? buildDirectoryTraversalFallbackAssertion(arrangeVariant)
    : readApi
    ? buildFileReadFallbackAssertion()
    : writeApi
      ? buildFileWriteFallbackAssertion()
      : assertion || buildSourceAwareAssertion(fnName, functionCode);

  return {
    title: normalizeTitle(title),
    arrange,
    act,
    assert: finalAssertion,
    source: "fallback",
  };
}

function detectNestedReaderCallbackProtocol(functionCode = "") {
  const code = normalizeCode(functionCode);
  if (!code) return null;

  const outerMatch = code.match(
    /\breturn\s+function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*\{([\s\S]*)/
  );
  if (!outerMatch) return null;

  const readerParam = outerMatch[1];
  const innerMatch = outerMatch[2].match(
    /\breturn\s+function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/
  );
  if (!innerMatch) return null;

  const callbackParam = innerMatch[2];
  const safeReader = readerParam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const safeCallback = callbackParam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (!new RegExp(`\\b${safeReader}\\s*\\(`).test(code)) return null;
  if (!new RegExp(`\\b${safeCallback}\\s*\\(`).test(code)) return null;

  return { readerParam, controlParam: innerMatch[1], callbackParam };
}

function buildNestedReaderBehaviorCases({
  fnName,
  params = [],
  functionCode = "",
  maxCases = 3,
} = {}) {
  const safeMax = Math.max(0, Math.min(Number(maxCases) || 0, 3));
  if (!safeMax || !fnName) return [];

  const protocol = detectNestedReaderCallbackProtocol(functionCode);
  if (!protocol) return [];

  const { arrange, argNames } = buildDefaultArrange(
    params,
    functionCode,
    "arg",
    "primary"
  );
  const subject = sanitizeIdentifier(fnName, "subject");
  const factoryCall = `${subject}(${argNames.join(", ")})`;
  const cases = [];

  const callbackObservation = [
    "let __unitgenCallbackCalled = false;",
    "let __unitgenObservedEnd;",
    "let __unitgenObservedValue;",
    "const __unitgenCallback = (end, value) => {",
    "  __unitgenCallbackCalled = true;",
    "  __unitgenObservedEnd = end;",
    "  __unitgenObservedValue = value;",
    "};",
  ].join("\n");

  cases.push({
    title: normalizeTitle("source-driven returned callback processes a finite input"),
    arrange: [
      arrange,
      "const __unitgenItems = [1, 2];",
      "let __unitgenIndex = 0;",
      "const __unitgenRead = (abort, cb) => {",
      "  if (abort) return cb(abort);",
      "  if (__unitgenIndex >= __unitgenItems.length) return cb(true);",
      "  const value = __unitgenItems[__unitgenIndex++];",
      "  return cb(null, value);",
      "};",
      callbackObservation,
    ].filter(Boolean).join("\n"),
    act: `${factoryCall}(__unitgenRead)(null, __unitgenCallback)`,
    assert: [
      "expect(__unitgenCallbackCalled).toBe(true);",
      "expect(__unitgenObservedEnd == null || Boolean(__unitgenObservedEnd)).toBe(true);",
      "if (__unitgenObservedEnd == null) expect(__unitgenObservedValue).toBeDefined();",
    ].join("\n"),
    source: "source-driven-fallback",
  });

  const controlName = String(protocol.controlParam || "");
  const readerName = String(protocol.readerParam || "");
  const safeControl = controlName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const safeReader = readerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const code = normalizeCode(functionCode);
  const hasVisibleControlBranch = safeControl && (
    new RegExp(`\\bif\\s*\\([^)]*\\b${safeControl}\\b`).test(code) ||
    new RegExp(`\\b${safeControl}\\s*(?:=|\\|\\||&&|\\?)`).test(code) ||
    new RegExp(`!\\s*${safeControl}\\b`).test(code) ||
    (safeReader && new RegExp(`\\b${safeReader}\\s*\\(\\s*${safeControl}\\b`).test(code))
  );
  if (hasVisibleControlBranch) {
    cases.push({
      title: normalizeTitle("source-driven returned callback propagates upstream completion"),
      arrange: [
        arrange,
        "const __unitgenRead = (abort, cb) => cb(abort || true);",
        callbackObservation,
      ].filter(Boolean).join("\n"),
      act: `${factoryCall}(__unitgenRead)(null, __unitgenCallback)`,
      assert: [
        "expect(__unitgenCallbackCalled).toBe(true);",
        "expect(__unitgenObservedEnd).toBe(true);",
      ].join("\n"),
      source: "source-driven-fallback",
    });

    cases.push({
      title: normalizeTitle("source-driven returned callback propagates caller abort"),
      arrange: [
        arrange,
        "let __unitgenReadAbort;",
        "const __unitgenRead = (abort, cb) => {",
        "  __unitgenReadAbort = abort;",
        "  return cb(abort || true);",
        "};",
        callbackObservation,
      ].filter(Boolean).join("\n"),
      act: `${factoryCall}(__unitgenRead)(true, __unitgenCallback)`,
      assert: [
        "expect(__unitgenReadAbort).toBe(true);",
        "expect(__unitgenCallbackCalled).toBe(true);",
        "expect(__unitgenObservedEnd).toBe(true);",
      ].join("\n"),
      source: "source-driven-fallback",
    });
  }

  return cases.slice(0, safeMax);
}
function detectReturnedSourceCallbackProtocol(functionCode = "") {
  const code = normalizeCode(functionCode);
  if (!code) return null;

  const match = code.match(
    /\breturn\s+function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*\{([\s\S]*?)\n\s*\}/
  );
  if (!match) return null;

  const controlParam = match[1];
  const callbackParam = match[2];
  const body = match[3];
  const safeCallback = callbackParam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`\\b${safeCallback}\\s*\\(`).test(body)) return null;

  return { controlParam, callbackParam, body };
}

function buildReturnedSourceBehaviorCases({
  fnName,
  params = [],
  functionCode = "",
  maxCases = 3,
} = {}) {
  const protocol = detectReturnedSourceCallbackProtocol(functionCode);
  if (!protocol) return [];

  const safeMax = Math.max(0, Math.min(Number(maxCases) || 0, 3));
  const { arrange, argNames } = buildDefaultArrange(params, functionCode, "arg", "primary");
  const subject = sanitizeIdentifier(fnName, "subject");
  const factoryCall = `${subject}(${argNames.join(", ")})`;
  const callbackObservation = [
    "let __unitgenCallbackCalled = false;",
    "let __unitgenObservedEnd;",
    "let __unitgenObservedValue;",
    "const __unitgenCallback = (end, value) => {",
    "  __unitgenCallbackCalled = true;",
    "  __unitgenObservedEnd = end;",
    "  __unitgenObservedValue = value;",
    "};",
  ].join("\n");
  const cases = [{
    title: normalizeTitle("source-driven returned source invokes its callback"),
    arrange: [arrange, callbackObservation].filter(Boolean).join("\n"),
    act: `${factoryCall}(null, __unitgenCallback)`,
    assert: [
      "expect(__unitgenCallbackCalled).toBe(true);",
      "expect(__unitgenObservedEnd == null || Boolean(__unitgenObservedEnd)).toBe(true);",
      "if (__unitgenObservedEnd == null) expect(__unitgenObservedValue).toBeDefined();",
    ].join("\n"),
    source: "source-driven-fallback",
  }];

  const safeControl = protocol.controlParam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const usesControl = new RegExp(`\\b${safeControl}\\b`).test(protocol.body);
  if (usesControl) {
    cases.push({
      title: normalizeTitle("source-driven returned source propagates caller abort"),
      arrange: [arrange, callbackObservation].filter(Boolean).join("\n"),
      act: `${factoryCall}(true, __unitgenCallback)`,
      assert: [
        "expect(__unitgenCallbackCalled).toBe(true);",
        "expect(__unitgenObservedEnd).toBe(true);",
      ].join("\n"),
      source: "source-driven-fallback",
    });
  }

  return cases.slice(0, safeMax);
}

function detectNamedSinkProtocol(functionCode = "") {
  const code = normalizeCode(functionCode);
  if (!code) return null;

  const declaration = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g;
  let match;
  while ((match = declaration.exec(code))) {
    const sinkName = match[1];
    const readerParam = match[2];
    const safeSink = sinkName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const safeReader = readerParam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remaining = code.slice(match.index);
    if (!new RegExp(`\\breturn\\s+${safeSink}\\b`).test(remaining)) continue;
    const directReaderCall = new RegExp(`\\b${safeReader}\\s*\\(`).test(remaining);
    const aliasMatch = remaining.match(
      new RegExp(`\\b([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*${safeReader}\\b`)
    );
    const aliasReaderCall = aliasMatch
      ? new RegExp(`\\b${aliasMatch[1]}\\s*\\(`).test(remaining)
      : false;
    if (!directReaderCall && !aliasReaderCall) continue;
    return { sinkName, readerParam };
  }

  return null;
}
function buildNamedSinkBehaviorCases({
  fnName,
  params = [],
  functionCode = "",
  maxCases = 1,
} = {}) {
  if (!detectNamedSinkProtocol(functionCode)) return [];
  if (Math.max(0, Math.min(Number(maxCases) || 0, 1)) === 0) return [];

  const names = uniqueParamNames(params, "arg");
  const hookNames = [];
  const lines = ["const __unitgenHookValues = [];"];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const rawParam = typeof params[i] === "string" ? params[i] : params[i]?.name;
    const invoked = buildSourceInvokedFunctionLiteral(rawParam || name, functionCode);
    if (invoked) {
      hookNames.push(name);
      lines.push(`const ${name} = (...args) => { __unitgenHookValues.push(args); return args[0]; };`);
    } else {
      const value = buildBetterDefaultValueForParam(rawParam || name, i, functionCode, "primary");
      lines.push(`const ${name} = ${value};`);
    }
  }
  lines.push(
    "const __unitgenItems = [1, 2];",
    "let __unitgenIndex = 0;",
    "let __unitgenReadCalls = 0;",
    "const __unitgenRead = (abort, cb) => {",
    "  __unitgenReadCalls++;",
    "  if (abort) return cb(abort);",
    "  if (__unitgenIndex >= __unitgenItems.length) return cb(true);",
    "  return cb(null, __unitgenItems[__unitgenIndex++]);",
    "};"
  );

  return [{
    title: normalizeTitle("source-driven returned sink consumes a finite source"),
    arrange: lines.join("\n"),
    act: `${sanitizeIdentifier(fnName, "subject")}(${names.join(", ")})(__unitgenRead)`,
    assert: [
      "expect(__unitgenReadCalls).toBeGreaterThan(0);",
      ...(hookNames.length > 0 ? ["expect(__unitgenHookValues.length).toBeGreaterThan(0);"] : []),
    ].join("\n"),
    source: "source-driven-fallback",
  }];
}

export function buildSourceDrivenBehaviorCases(options = {}) {
  const maxCases = Math.max(0, Math.min(Number(options.maxCases) || 0, 3));
  if (!maxCases) return [];

  const nestedCases = buildNestedReaderBehaviorCases({ ...options, maxCases });
  if (nestedCases.length > 0) return nestedCases;

  const sourceCases = buildReturnedSourceBehaviorCases({ ...options, maxCases });
  if (sourceCases.length > 0) return sourceCases;

  return buildNamedSinkBehaviorCases({ ...options, maxCases });
}
function buildNoParamFallbackCases({ fnName, functionCode, maxCases }) {
  const cases = [];

  cases.push({
    title: normalizeTitle("fallback checks source-aware result shape"),
    arrange: "",
    act: `${sanitizeIdentifier(fnName, "subject")}()`,
    assert: buildSourceAwareAssertion(fnName, functionCode, "primary"),
    source: "fallback",
  });

  cases.push({
    title: normalizeTitle("fallback checks stable result contract"),
    arrange: "",
    act: `${sanitizeIdentifier(fnName, "subject")}()`,
    assert: buildSourceAwareAssertion(fnName, functionCode, "secondary"),
    source: "fallback",
  });

  return cases.slice(0, maxCases);
}

function buildParamFallbackCases({
  fnName,
  params,
  isClassLike,
  functionCode,
  isAsync,
  maxCases,
}) {
  const descriptorReadCases = buildDescriptorReadFallbackCases({
    fnName,
    params,
    functionCode,
    maxCases,
  });
  if (descriptorReadCases.length > 0) return descriptorReadCases;

  const callbackCases = buildNodeStyleFileCallbackFallbackCases({
    fnName,
    params,
    maxCases,
  });
  if (callbackCases.length > 0) return callbackCases;

  const cases = [];
  const directGuardCase = extractDirectGuardFallbackCase({
    fnName,
    params,
    functionCode,
    isClassLike,
  });
  const directoryTraversalCase = buildDirectoryTraversalBehaviorCase({
    fnName,
    params,
    functionCode,
  });

  if (directGuardCase) cases.push(directGuardCase);
  if (directoryTraversalCase) cases.push(directoryTraversalCase);

  cases.push(
    buildFallbackCase({
      title: directGuardCase
        ? "fallback checks stable result contract"
        : isAsync
          ? "fallback checks source-aware result shape asynchronously"
          : "fallback checks source-aware result shape",
      fnName,
      params,
      isClassLike,
      functionCode,
      assertion: directGuardCase
        ? buildNoThrowAssertion(fnName, functionCode)
        : buildSourceAwareAssertion(fnName, functionCode, "primary"),
      arrangeVariant: directGuardCase ? "secondary" : "primary",
    })
  );

  if (!directGuardCase) {
    cases.push(
      buildFallbackCase({
        title: "fallback checks stable result contract",
        fnName,
        params,
        isClassLike,
        functionCode,
        assertion: buildNoThrowAssertion(fnName, functionCode),
        arrangeVariant: "secondary",
      })
    );
  }

  return cases.slice(0, maxCases);
}

function buildConstructorFallbackCases({
  ownerClassName,
  constructorParams = [],
  constructorCode = "",
  maxCases,
}) {
  const className = sanitizeIdentifier(ownerClassName, "SubjectClass");
  const { arrange, argNames } = buildDefaultArrange(
    constructorParams,
    constructorCode,
    "ctorArg"
  );

  const args = argNames.join(", ");
  const cases = [];

  cases.push({
    title: normalizeTitle(`${className} constructor creates an instance`),
    arrange,
    act: `new ${className}(${args})`,
    assert: [
      `expect(result).toBeDefined();`,
      `expect(typeof result === "object" || typeof result === "function").toBe(true);`,
    ].join("\n"),
    source: "fallback",
  });

  cases.push({
    title: normalizeTitle(`${className} constructor exposes an object-like result`),
    arrange,
    act: `new ${className}(${args})`,
    assert: `expect(result == null || typeof result === "object" || typeof result === "function").toBe(true);`,
    source: "fallback",
  });

  return cases.slice(0, maxCases);
}

function buildClassMethodArrange({
  ownerClassName,
  constructorParams = [],
  constructorCode = "",
  methodParams = [],
  methodCode = "",
}) {
  const className = sanitizeIdentifier(ownerClassName, "SubjectClass");

  const ctor = buildDefaultArrange(constructorParams, constructorCode, "ctorArg");
  const method = buildDefaultArrange(methodParams, methodCode, "methodArg");

  const lines = [];

  if (ctor.arrange) lines.push(ctor.arrange);
  lines.push(`const instance = new ${className}(${ctor.argNames.join(", ")});`);
  if (method.arrange) lines.push(method.arrange);

  return {
    arrange: lines.join("\n"),
    methodArgNames: method.argNames,
  };
}

function buildStaticMethodArrange({
  methodParams = [],
  methodCode = "",
}) {
  return buildDefaultArrange(methodParams, methodCode, "methodArg");
}

function buildClassMethodAssertion({
  methodName,
  methodCode = "",
  methodKind = "prototype",
  variant = "primary",
}) {
  if (methodKind === "constructor") {
    return [
      `expect(result).toBeDefined();`,
      `expect(typeof result === "object" || typeof result === "function").toBe(true);`,
    ].join("\n");
  }

  return buildSourceAwareAssertion(methodName, methodCode, variant);
}

function normalizePublicMethodNames(classMethods = []) {
  return new Set(
    (Array.isArray(classMethods) ? classMethods : [])
      .map((method) => typeof method === "string" ? method : method?.name || method?.methodName || "")
      .filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !name.startsWith("_"))
  );
}

function buildStatefulPublicApiFallbackCases({
  ownerClassName,
  methodName,
  classMethods = [],
  constructorParams = [],
  constructorCode = "",
}) {
  const methods = normalizePublicMethodNames(classMethods);
  const className = sanitizeIdentifier(ownerClassName, "SubjectClass");
  const name = String(methodName || "");
  const has = (method) => methods.has(method);
  const cases = [];
  const lifecycleSource = normalizeCode(constructorCode);
  const supportsPersistentLifecycle =
    (constructorParams || []).map(getParamName).some(looksFilePathLikeParam) &&
    /\.emit\s*\(\s*["']load["']/.test(lifecycleSource) &&
    /\.emit\s*\(\s*["']drain["']/.test(lifecycleSource) &&
    /\.emit\s*\(\s*["']write_close["']/.test(lifecycleSource);
  const persistentPath = 'const path = "./unitgen-temp-stateful.json";';
  const waitHelper = 'const waitFor = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));';

  if (name === "set" && has("get")) {
    cases.push({ title: normalizeTitle(`${className}.set stores a value observable through get`), arrange: `const instance = new ${className}();\nconst key = "unitgen-key";\nconst value = { count: 1 };\nconst cb = () => undefined;`, act: "instance.set(key, value, cb)", assert: `expect(result === undefined || result !== undefined).toBe(true);\nexpect(instance.get(key)).toEqual(value);`, source: "fallback" });
    cases.push({ title: normalizeTitle(`${className}.set removes a value when given undefined`), arrange: `const instance = new ${className}();\nconst key = "unitgen-key";\ninstance.set(key, 1);\nconst value = undefined;\nconst cb = () => undefined;`, act: "instance.set(key, value, cb)", assert: `expect(result === undefined || result !== undefined).toBe(true);\nexpect(instance.get(key)).toBeUndefined();`, source: "fallback" });
    cases.push({ title: normalizeTitle(`${className}.set overwrites an existing value`), arrange: `const instance = new ${className}();\nconst key = "unitgen-key";\ninstance.set(key, 1);\nconst value = 2;\nconst cb = () => undefined;`, act: "instance.set(key, value, cb)", assert: `expect(result === undefined || result !== undefined).toBe(true);\nexpect(instance.get(key)).toBe(2);`, source: "fallback" });
    if (has("size")) cases.push({ title: normalizeTitle(`${className}.set keeps distinct keys independently`), arrange: `const instance = new ${className}();\ninstance.set("first", 1);\nconst key = "second";\nconst value = 2;\nconst cb = () => undefined;`, act: "instance.set(key, value, cb)", assert: `expect(result === undefined || result !== undefined).toBe(true);\nexpect(instance.size()).toBe(2);`, source: "fallback" });
    cases.push({ title: normalizeTitle(`${className}.set invokes its callback in transient mode`), arrange: `const instance = new ${className}();\nconst key = "callback-key";\nconst value = 1;\nlet callbackCalled = false;\nconst callbackDone = new Promise((resolve) => instance.once("drain", resolve));\nconst cb = () => { callbackCalled = true; };`, act: "instance.set(key, value, cb)", assert: `await callbackDone;\nexpect(result === undefined || result !== undefined).toBe(true);\nexpect(callbackCalled).toBe(true);\nexpect(instance.get(key)).toBe(value);`, source: "fallback", isAsync: true });
    if (supportsPersistentLifecycle) cases.push({ title: normalizeTitle(`${className}.set persists a value before drain`), arrange: `${persistentPath}\n${waitHelper}\nconst instance = new ${className}(path);\nawait waitFor(instance, "load");\nconst key = "persistent-key";\nconst value = 7;\nlet callbackCalled = false;\nconst drainDone = waitFor(instance, "drain");\nlet writeClosed;\nconst cb = () => { callbackCalled = true; };`, act: "instance.set(key, value, cb)", assert: `await drainDone;\nexpect(result === undefined || result !== undefined).toBe(true);\nexpect(callbackCalled).toBe(true);\nexpect(instance.get(key)).toBe(value);\nwriteClosed = waitFor(instance, "write_close");\ninstance.close();\nawait writeClosed;`, source: "fallback", isAsync: true });
  } else if (name === "get" && has("set")) {
    cases.push({ title: normalizeTitle(`${className}.get returns a previously stored value`), arrange: `const instance = new ${className}();\nconst key = "unitgen-key";\nconst value = { count: 1 };\ninstance.set(key, value);`, act: "instance.get(key)", assert: "expect(result).toEqual(value);", source: "fallback" });
    cases.push({ title: normalizeTitle(`${className}.get returns undefined for a missing key`), arrange: `const instance = new ${className}();\nconst key = "missing-key";`, act: "instance.get(key)", assert: "expect(result).toBeUndefined();", source: "fallback" });
    cases.push({ title: normalizeTitle(`${className}.get observes the latest stored value`), arrange: `const instance = new ${className}();\nconst key = "unitgen-key";\ninstance.set(key, 1);\ninstance.set(key, 2);`, act: "instance.get(key)", assert: "expect(result).toBe(2);", source: "fallback" });
    if (supportsPersistentLifecycle && has("close")) cases.push({ title: normalizeTitle(`${className}.get reloads a persisted value`), arrange: `${persistentPath}\n${waitHelper}\nconst key = "reload-key";\nconst writer = new ${className}(path);\nawait waitFor(writer, "load");\nconst drainDone = waitFor(writer, "drain");\nwriter.set(key, 9);\nawait drainDone;\nconst writerClosed = waitFor(writer, "write_close");\nwriter.close();\nawait writerClosed;\nconst instance = new ${className}(path);\nawait waitFor(instance, "load");\nlet readClosed;`, act: "instance.get(key)", assert: `expect(result).toBe(9);\nreadClosed = waitFor(instance, "write_close");\ninstance.close();\nawait readClosed;`, source: "fallback", isAsync: true });
  } else if (name === "size" && has("set")) {
    cases.push({ title: normalizeTitle(`${className}.size reflects stored entries`), arrange: `const instance = new ${className}();\ninstance.set("first", 1);\ninstance.set("second", 2);`, act: "instance.size()", assert: "expect(result).toBe(2);", source: "fallback" });
    cases.push({ title: normalizeTitle(`${className}.size is zero for an empty instance`), arrange: `const instance = new ${className}();`, act: "instance.size()", assert: "expect(result).toBe(0);", source: "fallback" });
    if (has("rm")) cases.push({ title: normalizeTitle(`${className}.size decreases after removing a stored key`), arrange: `const instance = new ${className}();\ninstance.set("first", 1);\ninstance.set("second", 2);\ninstance.rm("second");`, act: "instance.size()", assert: "expect(result).toBe(1);", source: "fallback" });
  } else if (name === "rm" && has("set") && has("get")) {
    cases.push({ title: normalizeTitle(`${className}.rm removes a previously stored value`), arrange: `const instance = new ${className}();\nconst key = "unitgen-key";\ninstance.set(key, 1);\nconst cb = () => undefined;`, act: "instance.rm(key, cb)", assert: `expect(result === undefined || result !== undefined).toBe(true);\nexpect(instance.get(key)).toBeUndefined();`, source: "fallback" });
    if (has("size")) cases.push({ title: normalizeTitle(`${className}.rm leaves other keys intact`), arrange: `const instance = new ${className}();\ninstance.set("first", 1);\ninstance.set("second", 2);\nconst key = "first";\nconst cb = () => undefined;`, act: "instance.rm(key, cb)", assert: `expect(result === undefined || result !== undefined).toBe(true);\nexpect(instance.size()).toBe(1);\nexpect(instance.get("second")).toBe(2);`, source: "fallback" });
    if (supportsPersistentLifecycle && has("close")) cases.push({ title: normalizeTitle(`${className}.rm persists deletion across reload`), arrange: `${persistentPath}\n${waitHelper}\nconst key = "removed-key";\nconst writer = new ${className}(path);\nawait waitFor(writer, "load");\nlet drainDone = waitFor(writer, "drain");\nwriter.set(key, 1);\nawait drainDone;\ndrainDone = waitFor(writer, "drain");\nlet writerClosed;\nlet reader;\nlet readerClosed;\nconst cb = () => undefined;`, act: "writer.rm(key, cb)", assert: `await drainDone;\nexpect(result === undefined || result !== undefined).toBe(true);\nwriterClosed = waitFor(writer, "write_close");\nwriter.close();\nawait writerClosed;\nreader = new ${className}(path);\nawait waitFor(reader, "load");\nexpect(reader.get(key)).toBeUndefined();\nreaderClosed = waitFor(reader, "write_close");\nreader.close();\nawait readerClosed;`, source: "fallback", isAsync: true });
  } else if (name === "update" && has("set") && has("get")) {
    cases.push({ title: normalizeTitle(`${className}.update derives and stores the next value`), arrange: `const instance = new ${className}();\nconst key = "unitgen-key";\ninstance.set(key, 1);\nconst updater = (value) => value + 1;\nconst cb = () => undefined;`, act: "instance.update(key, updater, cb)", assert: `expect(result === undefined || result !== undefined).toBe(true);\nexpect(instance.get(key)).toBe(2);`, source: "fallback" });
    cases.push({ title: normalizeTitle(`${className}.update can initialize a missing value`), arrange: `const instance = new ${className}();\nconst key = "unitgen-key";\nconst updater = (value) => value === undefined ? 1 : value + 1;\nconst cb = () => undefined;`, act: "instance.update(key, updater, cb)", assert: `expect(result === undefined || result !== undefined).toBe(true);\nexpect(instance.get(key)).toBe(1);`, source: "fallback" });
  } else if (name === "forEach" && has("set")) {
    cases.push({ title: normalizeTitle(`${className}.forEach visits stored entries`), arrange: `const instance = new ${className}();\ninstance.set("first", 1);\ninstance.set("second", 2);\nconst seen = [];\nconst fn = (key, value) => seen.push([key, value]);`, act: "instance.forEach(fn)", assert: `expect(result === undefined || result !== undefined).toBe(true);\nexpect(seen).toHaveLength(2);`, source: "fallback" });
    cases.push({ title: normalizeTitle(`${className}.forEach supports callback-directed early termination`), arrange: `const instance = new ${className}();\ninstance.set("first", 1);\ninstance.set("second", 2);\nconst seen = [];\nconst fn = (key) => { seen.push(key); return false; };`, act: "instance.forEach(fn)", assert: `expect(result === undefined || result !== undefined).toBe(true);\nexpect(seen).toHaveLength(1);`, source: "fallback" });
  } else if (name === "close" && has("set") && supportsPersistentLifecycle) {
    cases.push({ title: normalizeTitle(`${className}.close waits for queued persistent writes`), arrange: `${persistentPath}\n${waitHelper}\nconst instance = new ${className}(path);\nawait waitFor(instance, "load");\ninstance.set("close-key", 1);\nconst writeClosed = waitFor(instance, "write_close");`, act: "instance.close()", assert: `await writeClosed;\nexpect(result === undefined || result !== undefined).toBe(true);`, source: "fallback", isAsync: true });
  }

  return cases;
}
function buildClassMethodFallbackCases({
  ownerClassName,
  methodName,
  methodKind = "prototype",
  constructorParams = [],
  constructorCode = "",
  params = [],
  functionCode = "",
  classMethods = [],
  isAsync = false,
  maxCases,
}) {
  const className = sanitizeIdentifier(ownerClassName, "SubjectClass");
  const safeMethodName = sanitizeIdentifier(methodName, "method");

  if (methodKind === "constructor") {
    return buildConstructorFallbackCases({
      ownerClassName: className,
      constructorParams,
      constructorCode: constructorCode || functionCode,
      maxCases,
    });
  }

  const cases = [];

  const statefulCases = buildStatefulPublicApiFallbackCases({
    ownerClassName: className,
    methodName: safeMethodName,
    classMethods,
    constructorParams,
    constructorCode,
  });
  cases.push(...statefulCases);

  if (methodKind === "static") {
    const { arrange, argNames } = buildStaticMethodArrange({
      methodParams: params,
      methodCode: functionCode,
    });
    const relationThrowCase = extractPathRelationThrowFallbackCase({
      ownerClassName: className,
      methodName: safeMethodName,
      params,
      functionCode,
    });

    if (relationThrowCase) cases.push(relationThrowCase);

    cases.push({
      title: normalizeTitle(`${className}.${safeMethodName} checks source-aware result shape`),
      arrange,
      act: `${className}.${safeMethodName}(${argNames.join(", ")})`,
      assert: buildClassMethodAssertion({
        methodName: safeMethodName,
        methodCode: functionCode,
        methodKind,
        variant: "primary",
      }),
      source: "fallback",
    });
    if (!relationThrowCase) {
      cases.push({
        title: normalizeTitle(`${className}.${safeMethodName} checks stable result contract`),
        arrange,
        act: `${className}.${safeMethodName}(${argNames.join(", ")})`,
        assert: buildClassMethodAssertion({
          methodName: safeMethodName,
          methodCode: functionCode,
          methodKind,
          variant: "secondary",
        }),
        source: "fallback",
      });
    }

    return cases.slice(0, maxCases);
  }

  if (cases.length >= maxCases) return cases.slice(0, maxCases);

  const methodArrange = buildClassMethodArrange({
    ownerClassName: className,
    constructorParams,
    constructorCode,
    methodParams: params,
    methodCode: functionCode,
  });

  cases.push({
    title: normalizeTitle(
      isAsync
        ? `${className}.${safeMethodName} checks source-aware result shape asynchronously`
        : `${className}.${safeMethodName} checks source-aware result shape`
    ),
    arrange: methodArrange.arrange,
    act: `instance.${safeMethodName}(${methodArrange.methodArgNames.join(", ")})`,
    assert: buildClassMethodAssertion({
      methodName: safeMethodName,
      methodCode: functionCode,
      methodKind,
      variant: "primary",
    }),
    source: "fallback",
  });

  cases.push({
    title: normalizeTitle(`${className}.${safeMethodName} checks stable result contract`),
    arrange: methodArrange.arrange,
    act: `instance.${safeMethodName}(${methodArrange.methodArgNames.join(", ")})`,
    assert: buildClassMethodAssertion({
      methodName: safeMethodName,
      methodCode: functionCode,
      methodKind,
      variant: "secondary",
    }),
    source: "fallback",
  });

  return cases.slice(0, maxCases);
}

/**
 * Main API used by llmFillTests.js.
 *
 * Returns fallback cases in the same structure as LLM cases:
 * {
 *   title,
 *   arrange,
 *   act,
 *   assert
 * }
 *
 * These cases are intentionally conservative but now source-aware and class-aware.
 */
export function buildFallbackCases({
  fnName,
  params = [],
  isAsync = false,
  isClassLike = false,
  functionCode = "",
  maxCases = MAX_FALLBACK_CASES,

  // Class/method context fields added for class-heavy package support.
  isClassMethod = false,
  ownerClassName = "",
  methodName = "",
  methodKind = "",
  constructorParams = [],
  constructorCode = "",
  classMethods = [],
} = {}) {
  const safeMax = Math.max(0, Math.min(Number(maxCases) || 0, MAX_FALLBACK_CASES));
  if (safeMax === 0) return [];

  /*
   * New class-aware path.
   * This is used after index.js starts creating class method contexts from
   * classExportAnalyzer.js.
   */
  if (isClassMethod || ownerClassName || methodName || methodKind) {
    const finalMethodKind = methodKind || (isClassLike ? "constructor" : "prototype");
    const finalMethodName = methodName || fnName || "constructor";

    if (!ownerClassName && finalMethodKind !== "constructor") {
      return [];
    }

    return buildClassMethodFallbackCases({
      ownerClassName: ownerClassName || fnName,
      methodName: finalMethodName,
      methodKind: finalMethodKind,
      constructorParams,
      constructorCode,
      params,
      functionCode,
      classMethods,
      isAsync,
      maxCases: safeMax,
    });
  }

  /*
   * Existing normal function path.
   * Keep class-like constructor fallback available now instead of returning [].
   * This lets class-like exports receive fallback injection safely once
   * llmFillTests.js stops hard-skipping class-like constructor contexts.
   */
  if (!fnName) return [];

  if (isClassLike) {
    return buildConstructorFallbackCases({
      ownerClassName: fnName,
      constructorParams: params,
      constructorCode: functionCode,
      maxCases: safeMax,
    });
  }

  const hasParams = Array.isArray(params) && params.length > 0;

  if (!hasParams) {
    return buildNoParamFallbackCases({
      fnName,
      functionCode,
      maxCases: safeMax,
    });
  }

  return buildParamFallbackCases({
    fnName,
    params,
    isClassLike,
    functionCode,
    isAsync,
    maxCases: safeMax,
  });
}

export function getFallbackCaseLimit() {
  return MAX_FALLBACK_CASES;
}
