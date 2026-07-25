import fs from "fs";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import { ollamaGenerate } from "./ollamaClient.js";
import { buildOllamaPrompt } from "./promptBuilder.js";
import {
  validateLlmCandidate,
  buildFinalInjectedContent,
  summarizeRuntimeValidation,
  UNITGEN_REPAIR_CANDIDATE_MARKER,
} from "./candidateRuntimeValidator.js";
import {
  buildFallbackCases,
  buildSourceDrivenBehaviorCases,
  getFallbackCaseLimit,
} from "./fallbackCaseBuilder.js";
import { runJestForFile } from "../runner/jestRunner.js";

const traverse = traverseModule.default;

const UNITGEN_LLM_MARKER = "/*__UNITGEN_LLM_TESTS__*/";

const MAX_FINAL_INJECTIONS_PER_FUNCTION = Number(
  process.env.UNITGEN_MAX_FINAL_INJECTIONS_PER_FUNCTION || 8
);
const MAX_RUNTIME_VALIDATED_INJECTIONS = Number(
  process.env.UNITGEN_MAX_RUNTIME_VALIDATED_INJECTIONS || MAX_FINAL_INJECTIONS_PER_FUNCTION
);
const MAX_FALLBACK_INJECTIONS = getFallbackCaseLimit();

const MAX_REPAIR_CANDIDATE_INJECTIONS_PER_FUNCTION = Number(
  process.env.UNITGEN_REPAIR_CANDIDATES_PER_FUNCTION || 1
);
const MAX_AUTO_NORMALIZED_REPAIR_CANDIDATES_PER_FUNCTION = Number(
  process.env.UNITGEN_AUTO_NORMALIZED_REPAIR_CANDIDATES_PER_FUNCTION || 2
);

const REPAIRABLE_ORACLE_FAILURE_TYPES = new Set([
  "NUMERIC_ORACLE_FAILURE",
  "DEEP_EQUALITY_ORACLE_FAILURE",
  "NULL_ORACLE_FAILURE",
  "UNDEFINED_ORACLE_FAILURE",
  "BOOLEAN_ORACLE_FAILURE",
  "VALUE_ORACLE_FAILURE",
  "THROW_ORACLE_FAILURE",
  "ASSERTION_ORACLE_FAILURE",
]);

const ALLOWED_GLOBALS = new Set([
  "expect",
  "jest",
  "Array",
  "Object",
  "JSON",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "Promise",
  "Set",
  "Map",
  "Buffer",
  "undefined",
  "null",
  "NaN",
  "Infinity",
  "fs",
  "path",
  "os"
]);

const SPECIAL_CALLBACK_PARAM_NAMES = [
  "callback",
  "cb",
  "fn",
  "handler",
  "randomsource",
  "distributiontype",
  "kernel",
  "bandwidthmethod",
  "func",
  "predicate",
  "comparator",
];

const NUMERIC_HEAVY_FN_HINTS = [
  "mean",
  "median",
  "variance",
  "deviation",
  "covariance",
  "correlation",
  "quantile",
  "rank",
  "kurtosis",
  "skewness",
  "gamma",
  "gammaln",
  "logit",
  "probit",
  "zscore",
  "ttest",
  "poisson",
  "binomial",
  "wilcoxon",
  "jenks",
  "silhouette",
  "distance",
  "regression",
  "coefficient",
  "average",
  "cumulative",
  "normal",
  "logistic",
  "std",
  "errorfunction",
  "inverseerrorfunction",
  "relativeerror",
  "abs",
  "magnitude",
  "angle",
  "bearing",
  "radius",
];

const RANDOM_OR_MUTATING_FN_HINTS = [
  "shuffle",
  "sample",
  "quickselect",
  "permutation",
];

const SHAPE_SENSITIVE_FN_HINTS = [
  "matrix",
  "cluster",
  "silhouette",
  "ckmeans",
  "jenks",
  "kerneldensity",
];

const KEEP_UNVALIDATED_PROTOTYPE_TESTS = process.env.UNITGEN_KEEP_UNVALIDATED_PROTOTYPES === "true";

function stripMarkdownCodeFences(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*\n/, "");
  s = s.replace(/\n```$/, "");
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*/, "");
  s = s.replace(/```$/g, "");
  return s.trim();
}

function extractJsonArray(text) {
  let s = String(text || "").trim();

  const startTag = "<JSON>";
  const endTag = "</JSON>";
  const start = s.indexOf(startTag);
  const end = s.lastIndexOf(endTag);

  if (start !== -1 && end !== -1 && end > start) {
    return s.slice(start + startTag.length, end).trim();
  }

  s = s.replace(/```[a-zA-Z0-9_-]*\s*/g, "");
  s = s.replace(/```/g, "");
  s = s.replace(/`/g, "");

  const b0 = s.indexOf("[");
  const b1 = s.lastIndexOf("]");

  if (b0 === -1 || b1 === -1 || b1 <= b0) {
    throw new Error("LLM output did not contain a JSON array.");
  }

  return s.slice(b0, b1 + 1);
}

function indentBlock(code, spaces = 4) {
  const pad = " ".repeat(spaces);

  return String(code || "")
    .split("\n")
    .map((line) => (line.trim().length ? pad + line : line))
    .join("\n");
}

function parseJavaScriptSnippet(code) {
  parse(String(code || ""), {
    sourceType: "module",
    plugins: ["topLevelAwait", "dynamicImport"],
  });
}

function extractImportedTemplateBindings(template = "") {
  const bindings = new Set();

  try {
    const ast = parse(String(template || ""), {
      sourceType: "module",
      plugins: ["topLevelAwait", "dynamicImport"],
    });

    traverse(ast, {
      ImportDeclaration(path) {
        for (const specifier of path.node.specifiers || []) {
          if (specifier.local?.name) {
            bindings.add(specifier.local.name);
          }
        }
      },
    });
  } catch {
    // Template syntax is validated elsewhere; missing bindings just keep sanitizer strict.
  }

  return Array.from(bindings);
}

function validateJavaScriptModule(code) {
  parseJavaScriptSnippet(code);
}

function normalizeTitle(title, fallback = "generated test") {
  const t = String(title || fallback).trim();
  return t.replace(/\s+/g, " ").replace(/"/g, '\\"') || fallback;
}

function cleanFragment(code) {
  return stripMarkdownCodeFences(String(code || ""))
    .replace(/^\s*\/\/.*$/gm, "")
    .trim();
}

function extractExpectStatements(code) {
  const s = cleanFragment(code);

  if (!s) return "";

  if (!/\bexpect\s*\(/.test(s)) return s;

  const lines = s
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const expectLines = lines.filter((line) => /\bexpect\s*\(/.test(line));

  if (expectLines.length > 0) {
    return expectLines
      .map((line) => (line.endsWith(";") ? line : `${line};`))
      .join("\n");
  }

  const start = s.indexOf("expect(");
  if (start === -1) return s;

  const sliced = s.slice(start);
  const semi = sliced.lastIndexOf(";");

  if (semi !== -1) {
    return sliced.slice(0, semi + 1).trim();
  }

  return sliced.trim();
}

function unwrapCommonTestWrapperFromAssert(assertCode) {
  let s = cleanFragment(assertCode);

  if (!/\b(describe|test|it)\s*\(/.test(s)) {
    return s;
  }

  const extracted = extractExpectStatements(s);

  if (extracted && /\bexpect\s*\(/.test(extracted)) {
    return extracted;
  }

  return s;
}

function normalizeActFragment(actCode) {
  let s = cleanFragment(actCode);

  s = s.replace(/^\s*await\s+/, "");

  const resultDecl = s.match(
    /^\s*(?:const|let|var)\s+result\s*=\s*([\s\S]*?)\s*;?\s*$/i
  );

  if (resultDecl) {
    s = resultDecl[1].trim();
  }

  return s.replace(/;\s*$/, "").trim();
}

function normalizeArrangeFragment(arrangeCode) {
  let s = cleanFragment(arrangeCode);

  if (/\b(describe|test|it)\s*\(/.test(s)) {
    const withoutWrappers = s
      .split("\n")
      .filter((line) => !/\b(describe|test|it|expect)\s*\(/.test(line))
      .join("\n")
      .trim();

    if (withoutWrappers) return withoutWrappers;
  }

  return s;
}

function normalizeCase(rawCase) {
  if (!rawCase || typeof rawCase !== "object") return null;

  const title = typeof rawCase.title === "string" ? rawCase.title.trim() : "";
  const arrange =
    typeof rawCase.arrange === "string"
      ? normalizeArrangeFragment(rawCase.arrange)
      : "";
  const act =
    typeof rawCase.act === "string" ? normalizeActFragment(rawCase.act) : "";
  const assert =
    typeof rawCase.assert === "string"
      ? unwrapCommonTestWrapperFromAssert(rawCase.assert)
      : "";

  if (!title || !act || !assert) return null;

  return { title, arrange, act, assert, isAsync: rawCase.isAsync === true };
}

function hasStatementLevelSyntaxIssues(code) {
  const s = String(code || "");

  const banned = [
    /\bawait\s+const\b/i,
    /```/,
    /\bTODO\b/i,
    /\byour code here\b/i,
    /\bexample only\b/i,
  ];

  return banned.some((re) => re.test(s));
}

function hasForbiddenTopLevelConstructs(code) {
  const s = String(code || "");

  const forbidden = [
    /\bimport\s.+from\s.+/i,
    /\bexport\s+(default|const|function|class)\b/i,
    /\brequire\s*\(/i,
    /\bjest\.mock\s*\(/i,
    /\bjest\.unstable_mockModule\s*\(/i,
    /\bvi\.mock\s*\(/i,
    /\bsinon\./i,
    /\bmockImplementation\b/i,
    /\bbeforeEach\s*\(/i,
    /\bafterEach\s*\(/i,
    /\bbeforeAll\s*\(/i,
    /\bafterAll\s*\(/i,
  ];

  return forbidden.some((re) => re.test(s));
}

function countResultDeclarations(code) {
  const s = String(code || "");
  return (s.match(/\bconst\s+result\s*=/g) || []).length;
}

function parseWrappedFunctionBody(code) {
  const wrapped = `
    async function __unitgen_decl_scope__() {
      ${code}
    }
  `;

  return parse(String(wrapped), {
    sourceType: "module",
    plugins: ["topLevelAwait", "dynamicImport"],
  });
}

function extractDeclaredVariables(code) {
  const declared = new Set();

  if (!code || !String(code).trim()) return declared;

  const addBindingPattern = (pattern) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      declared.add(pattern.name);
      return;
    }
    if (pattern.type === "AssignmentPattern") {
      addBindingPattern(pattern.left);
      return;
    }
    if (pattern.type === "RestElement") {
      addBindingPattern(pattern.argument);
      return;
    }
    if (pattern.type === "ObjectPattern") {
      for (const prop of pattern.properties || []) {
        addBindingPattern(prop?.value || prop?.argument);
      }
      return;
    }
    if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements || []) addBindingPattern(element);
    }
  };

  try {
    const ast = parseWrappedFunctionBody(code);

    traverse(ast, {
      Function(path) {
        for (const param of path.node.params || []) addBindingPattern(param);
      },
      VariableDeclarator(path) {
        const id = path.node.id;

        if (id?.type === "Identifier") {
          declared.add(id.name);
        }

        if (id?.type === "ObjectPattern") {
          for (const prop of id.properties || []) {
            if (prop?.value?.type === "Identifier") {
              declared.add(prop.value.name);
            }
          }
        }

        if (id?.type === "ArrayPattern") {
          for (const element of id.elements || []) {
            if (element?.type === "Identifier") {
              declared.add(element.name);
            }
          }
        }
      },
      FunctionDeclaration(path) {
        if (path.node.id?.name) declared.add(path.node.id.name);
      },
      FunctionExpression(path) {
        if (path.node.id?.name) declared.add(path.node.id.name);
      },
      CatchClause(path) {
        if (path.node.param?.type === "Identifier") {
          declared.add(path.node.param.name);
        }
      },
    });
  } catch {
    // malformed cases are rejected later
  }

  return declared;
}

function collectReferencedIdentifiers(code) {
  const referenced = new Set();

  if (!code || !String(code).trim()) return referenced;

  try {
    const ast = parseWrappedFunctionBody(code);

    traverse(ast, {
      ReferencedIdentifier(path) {
        // Parameters and variables declared inside a candidate expression
        // (for example Promise executors and Node-style callbacks) are local
        // bindings, not external references that must be supplied by the test
        // template or arrange block.
        if (path.scope.hasBinding(path.node.name)) return;
        referenced.add(path.node.name);
      },
    });
  } catch {
    // malformed cases are rejected later
  }

  return referenced;
}

function buildDefaultArgForParam(paramName) {
  const name = String(paramName || "arg");
  const lower = name.toLowerCase();

  if (
    lower === "x" ||
    lower === "y" ||
    lower === "z" ||
    lower.endsWith("arr") ||
    lower.endsWith("array") ||
    lower.endsWith("values") ||
    lower.endsWith("data") ||
    lower.endsWith("points") ||
    lower.endsWith("labels")
  ) {
    return "[1, 2, 3]";
  }

  if (
    lower.includes("lat") ||
    lower.includes("lon") ||
    lower.includes("lng") ||
    lower.includes("long") ||
    lower.includes("radius") ||
    lower.includes("angle") ||
    lower.includes("degree") ||
    lower.includes("radian") ||
    lower.includes("real") ||
    lower.includes("imag")
  ) {
    return "1";
  }

  if (lower.includes("prob") || lower.includes("alpha") || lower === "p") {
    return "0.5";
  }

  if (
    lower.includes("name") ||
    lower.includes("text") ||
    lower.includes("message") ||
    lower.includes("title") ||
    lower.includes("country") ||
    lower.includes("timezone") ||
    lower.includes("code") ||
    lower.includes("id")
  ) {
    return `"sample"`;
  }

  if (
    lower.startsWith("is") ||
    lower.startsWith("has") ||
    lower.includes("flag") ||
    lower.includes("enabled")
  ) {
    return "true";
  }

  if (
    lower.includes("cb") ||
    lower.includes("callback") ||
    lower.includes("fn") ||
    lower.includes("handler") ||
    lower.includes("randomsource") ||
    lower.includes("distributiontype") ||
    lower.includes("kernel") ||
    lower.includes("bandwidthmethod")
  ) {
    return "() => 0";
  }

  if (
    lower.includes("api") ||
    lower.includes("client") ||
    lower.includes("service") ||
    lower.includes("options") ||
    lower.includes("config") ||
    lower.includes("settings")
  ) {
    return "{}";
  }

  if (
    lower.includes("count") ||
    lower.includes("size") ||
    lower.includes("length") ||
    lower === "n"
  ) {
    return "2";
  }

  return "1";
}

function extractFunctionCall(fnName, act) {
  const s = String(act || "");
  const escapedFn = String(fnName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const callRegex = new RegExp(`\\b${escapedFn}\\s*\\(([^)]*)\\)`, "m");
  const match = s.match(callRegex);

  if (!match) return null;

  const fullCall = match[0];
  const argsText = match[1].trim();

  let args = [];
  if (argsText.length > 0) {
    args = argsText.split(",").map((x) => x.trim()).filter(Boolean);
  }

  return { fullCall, args };
}

function extractMethodCall(methodName, act) {
  const s = String(act || "");
  const escapedMethod = String(methodName || "").replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const re = new RegExp(
    `([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\.\\s*${escapedMethod}\\s*\\(([^)]*)\\)`,
    "m"
  );

  const match = s.match(re);
  if (!match) return null;

  const objectName = match[1];
  const argsText = match[2].trim();

  let args = [];
  if (argsText.length > 0) {
    args = argsText.split(",").map((x) => x.trim()).filter(Boolean);
  }

  return {
    objectName,
    fullCall: match[0],
    args,
  };
}

function buildArgListFromParams({ params = [], arrange = "", extractedArgs = [] }) {
  const declared = extractDeclaredVariables(arrange);
  const finalArgs = [];

  for (let i = 0; i < (params || []).length; i++) {
    const param = String(params[i] || `arg${i + 1}`).trim();

    if (extractedArgs?.[i]) {
      finalArgs.push(extractedArgs[i]);
      continue;
    }

    if (declared.has(param)) {
      finalArgs.push(param);
      continue;
    }

    finalArgs.push(buildDefaultArgForParam(param));
  }

  return finalArgs;
}

function isPrototypeMethodKind(methodKind = "") {
  const kind = String(methodKind || "").toLowerCase();
  return kind && kind !== "constructor" && kind !== "static";
}

function buildPrototypeInstanceDeclaration({
  arrange = "",
  ownerClassName = "",
  constructorParams = [],
}) {
  const owner = String(ownerClassName || "").trim();
  if (!owner) return "";

  const declared = extractDeclaredVariables(arrange);
  if (declared.has("instance")) return "";

  const args = buildArgListFromParams({
    params: constructorParams || [],
    arrange,
    extractedArgs: [],
  });

  return `const instance = new ${owner}(${args.join(", ")});`;
}

function ensurePrototypeInstanceArrange({
  arrange = "",
  act = "",
  ownerClassName = "",
  constructorParams = [],
}) {
  const needsInstance = /\binstance\s*\./.test(String(act || ""));
  if (!needsInstance) return arrange;

  const declared = extractDeclaredVariables(arrange);
  if (declared.has("instance")) return arrange;

  const declaration = buildPrototypeInstanceDeclaration({
    arrange,
    ownerClassName,
    constructorParams,
  });

  if (!declaration) return arrange;

  return [arrange, declaration].filter((x) => String(x || "").trim()).join("\n");
}

function preserveValidatedNestedCallExpression(rawAct = "", targetName = "") {
  const expression = String(rawAct || "").trim().replace(/;\s*$/, "");
  const safeTarget = String(targetName || "").trim();
  if (!expression || !safeTarget) return "";

  try {
    const ast = parse(`const __unitgen_nested_act__ = ${expression};`, {
      sourceType: "module",
      plugins: ["topLevelAwait", "dynamicImport"],
    });
    const init = ast.program.body?.[0]?.declarations?.[0]?.init;
    if (!init || init.type !== "CallExpression") return "";

    let current = init;
    let callDepth = 0;
    while (current?.type === "CallExpression") {
      callDepth++;
      current = current.callee;
    }

    if (callDepth < 2 || current?.type !== "Identifier") return "";
    return current.name === safeTarget ? expression : "";
  } catch {
    return "";
  }
}
function preserveValidatedAsyncActExpression(rawAct = "", targetName = "") {
  const expression = String(rawAct || "").trim().replace(/;\s*$/, "");
  const escapedTarget = String(targetName || "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (!escapedTarget) return "";
  if (!/^\(\s*async\s*(?:\([^)]*\)\s*=>|function\b)/.test(expression)) {
    return "";
  }
  if (!new RegExp(`\\b${escapedTarget}\\s*\\(`).test(expression)) {
    return "";
  }

  try {
    parseJavaScriptSnippet(`const __unitgen_async_act__ = ${expression};`);
    return expression;
  } catch {
    return "";
  }
}
function buildRecoveredCall({
  fnName,
  rawAct,
  params,
  arrange,
  isClassLike = false,
  isClassMethod = false,
  ownerClassName = "",
  methodName = "",
  methodKind = "",
  constructorParams = [],
}) {
  const safeFnName = String(fnName || "subject").trim();
  const safeOwner = String(ownerClassName || safeFnName).trim();
  const safeMethod = String(methodName || safeFnName).trim();
  const kind = String(methodKind || "").trim();
  const canPreserveDirectExpression = !isClassLike && !isClassMethod && !kind;
  const preservedAsyncAct = canPreserveDirectExpression
    ? preserveValidatedAsyncActExpression(rawAct, safeFnName)
    : "";
  const preservedNestedAct = canPreserveDirectExpression
    ? preserveValidatedNestedCallExpression(rawAct, safeFnName)
    : "";

  if (preservedAsyncAct) return preservedAsyncAct;
  if (preservedNestedAct) return preservedNestedAct;

  if (isClassMethod || kind) {
    if (kind === "constructor") {
      const extracted = extractFunctionCall(safeOwner, rawAct);
      const args = buildArgListFromParams({
        params: constructorParams?.length ? constructorParams : params,
        arrange,
        extractedArgs: extracted?.args || [],
      });

      return `new ${safeOwner}(${args.join(", ")})`;
    }

    if (kind === "static") {
      const methodCall = extractMethodCall(safeMethod, rawAct);
      const args = buildArgListFromParams({
        params,
        arrange,
        extractedArgs: methodCall?.args || [],
      });

      return `${safeOwner}.${safeMethod}(${args.join(", ")})`;
    }

    const methodCall = extractMethodCall(safeMethod, rawAct);
    const declared = extractDeclaredVariables(arrange);
    let objectName = methodCall?.objectName || "instance";

    const objectLooksLikeClass =
      objectName === safeOwner ||
      /^[A-Z]/.test(objectName);

    if (!declared.has(objectName) || objectLooksLikeClass) {
      objectName = "instance";
    }

    const args = buildArgListFromParams({
      params,
      arrange,
      extractedArgs: methodCall?.args || [],
    });

    return `${objectName}.${safeMethod}(${args.join(", ")})`;
  }

  const extracted = extractFunctionCall(safeFnName, rawAct);
  const args = buildArgListFromParams({
    params,
    arrange,
    extractedArgs: extracted?.args || [],
  });

  if (isClassLike) {
    return `new ${safeFnName}(${args.join(", ")})`;
  }

  return `${safeFnName}(${args.join(", ")})`;
}

function isThrowAssertion(assertCode) {
  const s = String(assertCode || "").toLowerCase();
  return s.includes("tothrow") || s.includes("tothrowerror");
}

function normalizeAssertionForThrow({ assert, callExpr, isAsync }) {
  const raw = String(assert || "").trim();
  const messageMatch = raw.match(/toThrow(?:Error)?\((.*)\)/i);
  const messageArg = messageMatch?.[1]?.trim();

  if (isAsync) {
    return `await expect(${callExpr}).rejects.toThrow(${messageArg || ""});`
      .replace(/\(\s*\)/, "()");
  }

  return `expect(() => ${callExpr}).toThrow(${messageArg || ""});`
    .replace(/\(\s*\)/, "()");
}

function buildCanonicalActAndAssert({
  fnName,
  isAsync,
  rawAct,
  rawAssert,
  params,
  arrange,
  isClassLike = false,
  isClassMethod = false,
  ownerClassName = "",
  methodName = "",
  methodKind = "",
  constructorParams = [],
}) {
  const recoveredCall = buildRecoveredCall({
    fnName,
    rawAct,
    params,
    arrange,
    isClassLike,
    isClassMethod,
    ownerClassName,
    methodName,
    methodKind,
    constructorParams,
  });

  if (isThrowAssertion(rawAssert)) {
    return {
      act: "",
      assert: normalizeAssertionForThrow({
        assert: rawAssert,
        callExpr: recoveredCall,
        isAsync,
      }),
    };
  }

  return {
    act: isAsync
      ? `const result = await ${recoveredCall};`
      : `const result = ${recoveredCall};`,
    assert: rawAssert,
  };
}

function hasAsyncMatcherMisuse({ assert, isAsync }) {
  const s = String(assert || "");

  if (s.includes(".rejects") || s.includes(".resolves")) {
    return !isAsync;
  }

  return false;
}

function canParseCaseAsFunctionBody({
  arrange,
  act,
  assert,
  isAsync = false,
}) {
  const wrapped = `
    ${isAsync ? "async " : ""}function __unitgen_case__() {
      ${arrange}
      ${act}
      ${assert}
    }
  `;

  try {
    parseJavaScriptSnippet(wrapped);
    return true;
  } catch {
    return false;
  }
}

function hasUndeclaredExternalReferences({
  fnName,
  arrange,
  act,
  assert,
  extraAllowedIdentifiers = [],
}) {
  const declaredInArrange = extractDeclaredVariables(arrange);
  const referencedInArrange = collectReferencedIdentifiers(arrange);
  const referencedInAct = collectReferencedIdentifiers(act);
  const referencedInAssert = collectReferencedIdentifiers(assert);

  const allowed = new Set([
    fnName,
    "result",
    ...declaredInArrange,
    ...extraAllowedIdentifiers,
    ...ALLOWED_GLOBALS,
  ]);

  for (const name of referencedInArrange) {
    if (!allowed.has(name)) return true;
  }

  for (const name of referencedInAct) {
    if (!allowed.has(name)) return true;
  }

  for (const name of referencedInAssert) {
    if (!allowed.has(name)) return true;
  }

  return false;
}

function maxBracketDepth(text) {
  let depth = 0;
  let maxDepth = 0;

  for (const ch of String(text || "")) {
    if (ch === "[" || ch === "{") {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
    }

    if (ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
    }
  }

  return maxDepth;
}

function extractMatcherArgument(assertCode, matcherNames) {
  const s = String(assertCode || "").trim();
  const matcher = matcherNames.join("|");

  const re = new RegExp(
    `expect\\s*\\(\\s*result\\s*\\)\\s*\\.\\s*(${matcher})\\s*\\(([^;]*)\\)\\s*;?\\s*$`,
    "is"
  );

  const match = s.match(re);
  if (!match) return null;

  return {
    matcher: match[1],
    arg: match[2]?.trim() || "",
  };
}

function hasBrittleComplexLiteralAssertion(assertCode) {
  const s = String(assertCode || "").replace(/\s+/g, " ").trim();

  const deep = extractMatcherArgument(s, ["toEqual", "toStrictEqual"]);
  if (deep) {
    const arg = deep.arg;

    if (/^\s*[\[{]/.test(arg)) {
      if (arg.length > 260) return true;
      if (maxBracketDepth(arg) > 3) return true;
      return false;
    }

    return false;
  }

  const primitive = extractMatcherArgument(s, ["toBe"]);
  if (primitive) {
    const arg = primitive.arg;

    if (/^\s*["'`]/.test(arg)) {
      if (arg.length > 140) return true;
      return false;
    }

    return false;
  }

  return false;
}

function hasIndirectFabricatedExpectation(arrangeCode, actCode, assertCode) {
  const arrange = String(arrangeCode || "");
  const act = String(actCode || "");
  const assertText = String(assertCode || "").replace(/\s+/g, " ");

  const expectVarMatch = assertText.match(
    /expect\s*\(\s*result\s*\)\s*\.\s*(toEqual|toStrictEqual)\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/i
  );

  if (!expectVarMatch) return false;

  const expectedVar = expectVarMatch[2];

  const arrayDecl = new RegExp(
    `\\b(?:const|let|var)\\s+${expectedVar}\\s*=\\s*\\[`,
    "m"
  );

  const objectDecl = new RegExp(
    `\\b(?:const|let|var)\\s+${expectedVar}\\s*=\\s*\\{`,
    "m"
  );

  const declaredAsStructuredValue = arrayDecl.test(arrange) || objectDecl.test(arrange);
  if (!declaredAsStructuredValue) return false;

  // Exact structured values are evidence-based when arrangement stores that
  // same value and the act observes the same instance. Runtime validation still
  // proves the relationship before the case can be injected.
  const instanceMatches = [
    ...arrange.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/g),
  ];

  for (const match of instanceMatches) {
    const instanceName = match[1];
    const setupCall = new RegExp(
      `\\b${instanceName}\\s*\\.\\s*[A-Za-z_$][A-Za-z0-9_$]*\\s*\\([^;]*\\b${expectedVar}\\b[^;]*\\)`,
      "m"
    );
    const observationCall = new RegExp(
      `\\b${instanceName}\\s*\\.\\s*[A-Za-z_$][A-Za-z0-9_$]*\\s*\\(`,
      "m"
    );

    if (setupCall.test(arrange) && observationCall.test(act)) return false;
  }

  return true;
}

function rewriteResultNullishAssertion(assertCode) {
  const s = String(assertCode || "").trim();

  const nullishPatterns = [
    /^\s*expect\s*\(\s*result\s*\)\s*\.\s*toBeUndefined\s*\(\s*\)\s*;?\s*$/i,
    /^\s*expect\s*\(\s*result\s*\)\s*\.\s*toBeNull\s*\(\s*\)\s*;?\s*$/i,
    /^\s*expect\s*\(\s*result\s*\)\s*\.\s*toEqual\s*\(\s*null\s*\)\s*;?\s*$/i,
    /^\s*expect\s*\(\s*result\s*\)\s*\.\s*toStrictEqual\s*\(\s*null\s*\)\s*;?\s*$/i,
  ];

  for (const re of nullishPatterns) {
    if (re.test(s)) {
      return "expect(result == null).toBe(true);";
    }
  }

  return s;
}

function hasMockCallAssertion(assertCode) {
  const s = String(assertCode || "").replace(/\s+/g, " ");

  const patterns = [
    /\.toHaveBeenCalled\s*\(/i,
    /\.toHaveBeenCalledTimes\s*\(/i,
    /\.toHaveBeenCalledWith\s*\(/i,
    /\.toHaveBeenLastCalledWith\s*\(/i,
    /\.toHaveBeenNthCalledWith\s*\(/i,
  ];

  return patterns.some((re) => re.test(s));
}

function hasComplexToHavePropertyValue(assertCode) {
  const s = String(assertCode || "").replace(/\s+/g, " ");

  const complexPropertyValue =
    /expect\s*\(\s*result(?:\.[^)]+)?\s*\)\s*\.\s*toHaveProperty\s*\(\s*[^,]+,\s*[\[{]/i;

  return complexPropertyValue.test(s);
}

function hasFullResultDeepEqualityWithLiteral(assertCode) {
  const s = String(assertCode || "").replace(/\s+/g, " ").trim();

  const fullResultLiteral =
    /expect\s*\(\s*result\s*\)\s*\.\s*(toEqual|toStrictEqual)\s*\(\s*[\[{]/i;

  return fullResultLiteral.test(s);
}

function hasMeaningfulArrangeInput(arrangeCode) {
  const s = String(arrangeCode || "").trim();

  if (!s) return false;

  const declarations = (
    s.match(/\b(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=/g) || []
  ).length;

  return declarations > 0;
}

function getMemberRootIdentifier(node) {
  let current = node;
  while (current?.type === "MemberExpression" || current?.type === "OptionalMemberExpression") {
    current = current.object;
  }
  return current?.type === "Identifier" ? current.name : "";
}

function collectCallbackObservedIdentifiers(arrangeCode = "", actCode = "") {
  const observed = new Set();
  const actReferences = collectReferencedIdentifiers(actCode);
  const mutatingMethods = new Set([
    "push", "pop", "shift", "unshift", "splice", "sort", "reverse",
    "copyWithin", "fill", "add", "set", "delete", "clear",
  ]);

  const collectMutations = (functionPath) => {
    functionPath.traverse({
      AssignmentExpression(innerPath) {
        const left = innerPath.node.left;
        if (left?.type === "Identifier") observed.add(left.name);
        else {
          const root = getMemberRootIdentifier(left);
          if (root) observed.add(root);
        }
      },
      UpdateExpression(innerPath) {
        const arg = innerPath.node.argument;
        if (arg?.type === "Identifier") observed.add(arg.name);
        else {
          const root = getMemberRootIdentifier(arg);
          if (root) observed.add(root);
        }
      },
      CallExpression(innerPath) {
        const callee = innerPath.node.callee;
        if (callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression") return;
        const propertyName = callee.computed ? callee.property?.value : callee.property?.name;
        if (!mutatingMethods.has(String(propertyName || ""))) return;
        const root = getMemberRootIdentifier(callee.object);
        if (root) observed.add(root);
      },
    });
  };

  try {
    const ast = parseWrappedFunctionBody(arrangeCode);
    traverse(ast, {
      VariableDeclarator(path) {
        if (path.node.id?.type !== "Identifier") return;
        const callbackName = path.node.id.name;
        const init = path.node.init;
        if (!actReferences.has(callbackName)) return;
        if (!init || !["ArrowFunctionExpression", "FunctionExpression"].includes(init.type)) return;
        collectMutations(path.get("init"));
      },
      FunctionDeclaration(path) {
        const callbackName = path.node.id?.name;
        if (callbackName && actReferences.has(callbackName)) collectMutations(path);
      },
    });
  } catch {
    return new Set();
  }

  const arrangeDeclarations = extractDeclaredVariables(arrangeCode);
  return new Set(Array.from(observed).filter((name) => arrangeDeclarations.has(name)));
}

function hasCallbackObservedAssertion({ arrange = "", act = "", assert = "" }) {
  const observed = collectCallbackObservedIdentifiers(arrange, act);
  if (observed.size === 0) return false;
  const assertReferences = collectReferencedIdentifiers(assert);
  return Array.from(observed).some((name) => assertReferences.has(name));
}
function hasResultCenteredAssertion(assertCode) {
  const s = String(assertCode || "");

  return (
    /\bresult\b/.test(s) ||
    /expect\s*\(\s*Array\.isArray\s*\(\s*result\s*\)\s*\)/i.test(s) ||
    /expect\s*\(\s*Object\.keys\s*\(\s*result\s*\)\s*\)/i.test(s) ||
    /expect\s*\(\s*Object\.values\s*\(\s*result\s*\)\s*\)/i.test(s) ||
    /expect\s*\(\s*Object\.entries\s*\(\s*result\s*\)\s*\)/i.test(s)
  );
}

function declaredValuesUsedByAct(arrangeCode, actCode, valuePattern) {
  const arrange = String(arrangeCode || "");
  const act = String(actCode || "");
  const names = [];
  const declaration = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*${valuePattern}`,
    "g"
  );

  let match;
  while ((match = declaration.exec(arrange))) names.push(match[1]);

  return names.some((name) => new RegExp(`\\b${name}\\b`).test(act));
}

function hasEmptyArrayInput(arrangeCode, actCode) {
  const act = String(actCode || "");
  return (
    /\(\s*\[\s*\](?:\s*[,)]|$)/.test(act) ||
    /,\s*\[\s*\](?:\s*[,)]|$)/.test(act) ||
    declaredValuesUsedByAct(arrangeCode, actCode, "\\[\\s*\\]")
  );
}

function hasNullInput(arrangeCode, actCode) {
  const act = String(actCode || "");
  return (
    /\(\s*null(?:\s*[,)]|$)/.test(act) ||
    /,\s*null(?:\s*[,)]|$)/.test(act) ||
    declaredValuesUsedByAct(arrangeCode, actCode, "null\\b")
  );
}

function looksLikeSpecialCallbackParam(paramName) {
  const lower = String(paramName || "").toLowerCase();
  return SPECIAL_CALLBACK_PARAM_NAMES.some((x) => lower.includes(x));
}

function functionNeedsSpecialCallbackHandling(params = []) {
  return (params || []).some((p) => looksLikeSpecialCallbackParam(p));
}

function fnMatchesAnyHint(fnName, hints) {
  const lower = String(fnName || "").toLowerCase();
  return hints.some((x) => lower.includes(x));
}

function fnLooksNumericHeavy(fnName) {
  return fnMatchesAnyHint(fnName, NUMERIC_HEAVY_FN_HINTS);
}

function fnLooksRandomOrMutating(fnName) {
  return fnMatchesAnyHint(fnName, RANDOM_OR_MUTATING_FN_HINTS);
}

function fnLooksShapeSensitive(fnName) {
  return fnMatchesAnyHint(fnName, SHAPE_SENSITIVE_FN_HINTS);
}

function hasOverconfidentNumericAssertion(assertCode) {
  const s = String(assertCode || "").replace(/\s+/g, " ");

  const exactNumeric = [
    /expect\s*\(\s*result\s*\)\s*\.\s*toBe\s*\(\s*-?\d+(\.\d+)?\s*\)/i,
    /expect\s*\(\s*result\s*\)\s*\.\s*toEqual\s*\(\s*-?\d+(\.\d+)?\s*\)/i,
    /expect\s*\(\s*result\s*\)\s*\.\s*toBeCloseTo\s*\(\s*-?\d+(\.\d+)?\s*(,\s*\d+\s*)?\)/i,
  ];

  return exactNumeric.some((re) => re.test(s));
}

function hasSimpleDeterministicArrange(arrangeCode) {
  const s = String(arrangeCode || "").trim();

  if (!s) return true;

  const riskyPatterns = [
    /\bMath\.random\s*\(/i,
    /\bDate\.now\s*\(/i,
    /\bnew\s+Date\s*\(/i,
    /\bfetch\s*\(/i,
    /\baxios\./i,
    /\bfs\./i,
    /\bprocess\.env\b/i,
    /\bsetTimeout\s*\(/i,
    /\bsetInterval\s*\(/i,
    /\bcrypto\./i,
  ];

  if (riskyPatterns.some((re) => re.test(s))) return false;
  if (s.length > 900) return false;
  if (maxBracketDepth(s) > 5) return false;

  const simpleDeclaration =
    /\b(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:-?\d+(\.\d+)?|true|false|null|undefined|["'`][^"'`]{0,120}["'`]|\[[^\]]{0,220}\]|\{[^}]{0,220}\}|\([^)]*\)\s*=>|\bfunction\s*\(|new\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\()/i;

  return simpleDeclaration.test(s) || !s.includes("=");
}

function hasDeepEqualityAgainstResult(assertCode) {
  const s = String(assertCode || "").replace(/\s+/g, " ");

  return /expect\s*\(\s*result\s*\)\s*\.\s*(toEqual|toStrictEqual)\s*\(/i.test(s);
}

function hasLiteralFunctionArrange(arrangeCode) {
  const s = String(arrangeCode || "");
  return /=>/.test(s) || /\bfunction\s*\(/.test(s) || /\bjest\.fn\s*\(/.test(s);
}

function titleHasExplicitThrowIntent(title) {
  const s = String(title || "").toLowerCase();

  return (
    s.includes("throws") ||
    s.includes("throw") ||
    s.includes("error") ||
    s.includes("exception") ||
    s.includes("rejects") ||
    s.includes("reject") ||
    s.includes("invalid input") ||
    s.includes("invalid argument")
  );
}

function arrangeHasIntentionalInvalidInput(arrange) {
  const s = String(arrange || "").toLowerCase();

  return (
    /\b(?:const|let|var)\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*null\b/.test(s) ||
    /\b(?:const|let|var)\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*undefined\b/.test(s)
  );
}

function shouldForceThrowCase({ arrange, title, assert }) {
  if (isThrowAssertion(assert)) return false;

  if (titleHasExplicitThrowIntent(title)) return true;

  if (
    arrangeHasIntentionalInvalidInput(arrange) &&
    /\b(invalid|throws?|error|exception|rejects?)\b/i.test(String(title || ""))
  ) {
    return true;
  }

  return false;
}

function shouldSkipLlmForFunction({
  isClassLike = false,
  isClassMethod = false,
  methodKind = "",
}) {
  if (!isClassLike) return false;
  if (isClassMethod) return false;
  if (methodKind === "constructor") return false;

  return false;
}

function acceptCase(testCase) {
  return {
    ok: true,
    case: testCase,
  };
}

function rejectCase(reason, detail = "") {
  return {
    ok: false,
    reason,
    detail,
  };
}

function buildExtraAllowedIdentifiers({
  fnName,
  ownerClassName = "",
  methodName = "",
  isClassMethod = false,
}) {
  const allowed = new Set();

  if (fnName) allowed.add(fnName);
  if (ownerClassName) allowed.add(ownerClassName);
  if (methodName) allowed.add(methodName);

  if (isClassMethod) {
    allowed.add("instance");
  }

  return Array.from(allowed);
}

function sanitizeSingleCase({
  fnName,
  isAsync,
  params,
  testCase,
  isClassLike = false,
  isClassMethod = false,
  ownerClassName = "",
  methodName = "",
  methodKind = "",
  constructorParams = [],
  extraAllowedIdentifiers = [],
}) {
  const c = normalizeCase(testCase);
  if (!c) return rejectCase("INVALID_CASE_SHAPE");

  c.title = normalizeTitle(c.title);
  const effectiveIsAsync = Boolean(isAsync || c.isAsync);

  const normalized = buildCanonicalActAndAssert({
    fnName,
    isAsync: effectiveIsAsync,
    rawAct: c.act,
    rawAssert: c.assert,
    params,
    arrange: c.arrange,
    isClassLike,
    isClassMethod,
    ownerClassName,
    methodName,
    methodKind,
    constructorParams,
  });

  c.act = normalized.act;
  c.assert = rewriteResultNullishAssertion(normalized.assert);

  if (isClassMethod && isPrototypeMethodKind(methodKind)) {
    c.arrange = ensurePrototypeInstanceArrange({
      arrange: c.arrange,
      act: c.act,
      ownerClassName,
      constructorParams,
    });
  }

  const combined = `${c.arrange}\n${c.act}\n${c.assert}`;

  if (hasStatementLevelSyntaxIssues(combined)) {
    return rejectCase("STATEMENT_LEVEL_SYNTAX_ISSUE");
  }

  if (hasForbiddenTopLevelConstructs(combined)) {
    return rejectCase("FORBIDDEN_TOP_LEVEL_CONSTRUCT");
  }

  if (hasAsyncMatcherMisuse({ assert: c.assert, isAsync: effectiveIsAsync })) {
    return rejectCase("ASYNC_MATCHER_MISUSE");
  }

  if (countResultDeclarations(c.arrange) > 0) {
    return rejectCase("RESULT_DECLARED_IN_ARRANGE");
  }

  if (countResultDeclarations(c.assert) > 0) {
    return rejectCase("RESULT_DECLARED_IN_ASSERT");
  }

  if (!isThrowAssertion(c.assert) && countResultDeclarations(c.act) !== 1) {
    return rejectCase("INVALID_RESULT_DECLARATION_IN_ACT");
  }

  if (
    hasUndeclaredExternalReferences({
      fnName,
      arrange: c.arrange,
      act: c.act,
      assert: c.assert,
      extraAllowedIdentifiers: buildExtraAllowedIdentifiers({
        fnName,
        ownerClassName,
        methodName,
        isClassMethod,
      }).concat(extraAllowedIdentifiers),
    })
  ) {
    return rejectCase("UNDECLARED_REFERENCE");
  }

  if (hasMockCallAssertion(c.assert)) {
    return rejectCase("MOCK_CALL_ASSERTION_NOT_ALLOWED");
  }

  if (hasComplexToHavePropertyValue(c.assert)) {
    return rejectCase("COMPLEX_TO_HAVE_PROPERTY_VALUE");
  }

  if (
    hasFullResultDeepEqualityWithLiteral(c.assert) &&
    !hasMeaningfulArrangeInput(c.arrange)
  ) {
    return rejectCase("FULL_RESULT_DEEP_EQUALITY_WITHOUT_INPUT");
  }

  if (
    !isThrowAssertion(c.assert) &&
    !hasResultCenteredAssertion(c.assert) &&
    !hasCallbackObservedAssertion({
      arrange: c.arrange,
      act: c.act,
      assert: c.assert,
    })
  ) {
    return rejectCase("ASSERTION_NOT_RESULT_CENTERED");
  }

  if (hasBrittleComplexLiteralAssertion(c.assert)) {
    return rejectCase("COMPLEX_LITERAL_TOO_LARGE");
  }

  if (hasIndirectFabricatedExpectation(c.arrange, c.act, c.assert)) {
    return rejectCase("FABRICATED_EXPECTED_VARIABLE");
  }

  if (shouldForceThrowCase({ arrange: c.arrange, title: c.title, assert: c.assert })) {
    return rejectCase("INVALID_OR_ERROR_CASE_WITHOUT_THROW_ASSERTION");
  }

  if (
    fnLooksNumericHeavy(fnName) &&
    hasOverconfidentNumericAssertion(c.assert) &&
    !hasSimpleDeterministicArrange(c.arrange)
  ) {
    return rejectCase("OVERCONFIDENT_NUMERIC_ASSERTION");
  }

  if (fnLooksRandomOrMutating(fnName)) {
    if (hasDeepEqualityAgainstResult(c.assert)) {
      return rejectCase("RANDOM_OR_MUTATING_DEEP_EQUALITY_ASSERTION");
    }
  }

  if (fnLooksShapeSensitive(fnName)) {
    if (
      hasDeepEqualityAgainstResult(c.assert) &&
      !hasSimpleDeterministicArrange(c.arrange)
    ) {
      return rejectCase("SHAPE_SENSITIVE_COMPLEX_DEEP_EQUALITY_ASSERTION");
    }
  }

  if (functionNeedsSpecialCallbackHandling(params)) {
    if (!hasLiteralFunctionArrange(c.arrange)) {
      return rejectCase("CALLBACK_PARAM_WITHOUT_FUNCTION_LITERAL");
    }

    if (hasEmptyArrayInput(c.arrange, c.act) || hasNullInput(c.arrange, c.act)) {
      return rejectCase("CALLBACK_CASE_WITH_EMPTY_OR_NULL_INPUT");
    }
  }

  if (
    !canParseCaseAsFunctionBody({
      arrange: c.arrange,
      act: c.act,
      assert: c.assert,
      isAsync: effectiveIsAsync,
    })
  ) {
    return rejectCase("CASE_PARSE_FAILED");
  }

  return acceptCase(c);
}

function createEmptySanitizeStats(received = 0) {
  return {
    received,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    reasons: {},
  };
}

function createEmptyRuntimeStats() {
  return {
    attempted: 0,
    passed: 0,
    failed: 0,
    syntaxFailed: 0,
    runnerFailed: 0,
    skipped: 0,
    runtimeFailedCandidates: 0,
    repairableRuntimeCandidates: 0,
    nonRepairableRuntimeCandidates: 0,
    reasons: {},
    failureTypes: {},
  };
}

function isInjectableRepairFailureType(failureType = "") {
  return REPAIRABLE_ORACLE_FAILURE_TYPES.has(String(failureType || ""));
}

function hasNonRepairableRuntimeSignal(error = "") {
  const s = String(error || "").toLowerCase();

  return (
    s.includes("typeerror") ||
    s.includes("referenceerror") ||
    s.includes("rangeerror") ||
    s.includes("syntaxerror") ||
    s.includes("is not a function") ||
    s.includes("is not defined") ||
    s.includes("cannot read properties") ||
    s.includes("cannot read property") ||
    s.includes("cannot find module") ||
    s.includes("module not found") ||
    s.includes("err_module_not_found") ||
    /invalid .*argument/.test(s) ||
    /bad .*argument/.test(s) ||
    /must provide/.test(s) ||
    /required .*argument/.test(s) ||
    s.includes("enoent") ||
    s.includes("eacces") ||
    s.includes("eperm") ||
    s.includes("timed out") ||
    s.includes("exceeded timeout")
  );
}

function isInjectableRepairCandidateRecord(record) {
  if (!record) return false;
  if (!record.repairable) return false;
  if (record.source && record.source !== "llm") return false;
  if (record.reason !== "RUNTIME_FAILED") return false;
  if (!record.candidate) return false;

  if (!isInjectableRepairFailureType(record.failureType)) {
    return false;
  }

  if (hasNonRepairableRuntimeSignal(record.error)) {
    return false;
  }

  return true;
}

function addRejectReason(stats, reason) {
  stats.rejected += 1;
  stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
}

function addRuntimeReason(stats, reason, failureType = "", repairable = false) {
  stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;

  if (failureType) {
    stats.failureTypes[failureType] = (stats.failureTypes[failureType] || 0) + 1;
  }

  if (reason === "RUNTIME_PASSED") {
    stats.passed += 1;
    return;
  }

  if (reason === "SYNTAX_FAILED") {
    stats.syntaxFailed += 1;
    stats.failed += 1;
    return;
  }

  if (reason === "RUNNER_FAILED") {
    stats.runnerFailed += 1;
    stats.failed += 1;
    return;
  }

  if (reason === "SKIPPED_MAX_REACHED") {
    stats.skipped += 1;
    return;
  }

  if (reason === "RUNTIME_FAILED") {
    stats.runtimeFailedCandidates += 1;
    stats.failed += 1;

    if (repairable) {
      stats.repairableRuntimeCandidates += 1;
    } else {
      stats.nonRepairableRuntimeCandidates += 1;
    }

    return;
  }

  stats.failed += 1;
}

function sanitizeCases({
  fnName,
  isAsync,
  params,
  cases,
  isClassLike = false,
  isClassMethod = false,
  ownerClassName = "",
  methodName = "",
  methodKind = "",
  constructorParams = [],
  extraAllowedIdentifiers = [],
}) {
  if (!Array.isArray(cases)) {
    return {
      safeCases: [],
      stats: {
        ...createEmptySanitizeStats(0),
        rejected: 1,
        reasons: {
          LLM_OUTPUT_NOT_ARRAY: 1,
        },
      },
    };
  }

  const safeCases = [];
  const seen = new Set();
  const stats = createEmptySanitizeStats(cases.length);

  for (const testCase of cases) {
    const result = sanitizeSingleCase({
      fnName,
      isAsync,
      params,
      testCase,
      isClassLike,
      isClassMethod,
      ownerClassName,
      methodName,
      methodKind,
      constructorParams,
      extraAllowedIdentifiers,
    });

    if (!result.ok) {
      addRejectReason(stats, result.reason || "UNKNOWN_REJECTION");
      continue;
    }

    const safe = result.case;
    const signature = JSON.stringify({
      title: safe.title,
      arrange: safe.arrange,
      act: safe.act,
      assert: safe.assert,
    });

    if (seen.has(signature)) {
      stats.duplicates += 1;
      continue;
    }

    seen.add(signature);
    safeCases.push(safe);
    stats.accepted += 1;
  }

  return { safeCases, stats };
}

function buildTestBlocks({ isAsync, cases }) {
  return cases
    .map((c) => {
      const repairMarker = c.__unitgenRepairCandidate
        ? `    // ${UNITGEN_REPAIR_CANDIDATE_MARKER}
    // failureType: ${String(c.__unitgenFailureType || "RUNTIME_FAILED")}
    // runtimeReason: ${String(c.__unitgenRuntimeReason || "RUNTIME_FAILED")}`
        : "";

      return `
  test("${c.title}", ${isAsync || c.isAsync ? "async " : ""}() => {
${repairMarker ? repairMarker + "\n" : ""}    {
${c.arrange ? indentBlock(c.arrange, 6) + "\n" : ""}${c.act ? indentBlock(c.act, 6) + "\n" : ""}${indentBlock(c.assert, 6)}
    }
  });`.trimEnd();
    })
    .join("\n\n");
}

async function runtimeValidateCases({
  ctx,
  template,
  cases,
  seedCases = [],
  isAsync,
  maxPassing,
  collectRepairCandidates = true,
}) {
  const passingCases = [...seedCases];
  const failedCandidates = [];
  const repairCandidates = [];
  const stats = createEmptyRuntimeStats();

  const candidates = Array.isArray(cases) ? cases : [];

  for (const candidate of candidates) {
    if (passingCases.length >= maxPassing) {
      stats.attempted += 1;
      addRuntimeReason(stats, "SKIPPED_MAX_REACHED");
      continue;
    }

    stats.attempted += 1;

    const result = await validateLlmCandidate({
      ctx,
      template,
      candidate,
      acceptedCases: passingCases,
      buildTestBlocks,
      runJestForFile,
      isAsync,
    });

    const candidateRepairable = isInjectableRepairCandidateRecord(result.repairCandidate);
    addRuntimeReason(stats, result.reason, result.failureType, candidateRepairable);

    if (result.ok) {
      passingCases.push(candidate);
    } else {
      const failedCandidate = {
        candidate,
        reason: result.reason,
        error: result.error || "",
        failureType: result.failureType || "",
        repairable: candidateRepairable,
        repairCandidate: result.repairCandidate || null,
      };

      failedCandidates.push(failedCandidate);

      if (
        collectRepairCandidates &&
        result.reason === "RUNTIME_FAILED" &&
        candidateRepairable
      ) {
        repairCandidates.push(result.repairCandidate);
      }
    }
  }

  return {
    passingCases,
    newPassingCases: passingCases.slice(seedCases.length),
    failedCandidates,
    repairCandidates,
    stats,
  };
}

function normalizeRepairCandidateAsyncMatchers(candidate = {}) {
  const normalized = { ...candidate };
  const act = String(normalized.act || "");
  const assertion = String(normalized.assert || "");

  if (/\bconst\s+result\s*=\s*await\b/.test(act) && /expect\s*\(\s*result\s*\)\s*\.resolves\b/.test(assertion)) {
    normalized.assert = assertion.replace(
      /expect\s*\(\s*result\s*\)\s*\.resolves\b/g,
      "expect(result)"
    );
  }

  return normalized;
}
function parseObservedPrimitiveFromJestError(errorText = "") {
  const text = String(errorText || "");
  const match = text.match(
    /Received:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?\d+(?:\.\d+)?|true|false|null|undefined)/i
  );

  if (!match) return null;

  const token = match[1];
  if (token === "undefined") return { source: "undefined" };
  if (token === "null" || token === "true" || token === "false" || /^-?\d/.test(token)) {
    return { source: token };
  }

  if (token.startsWith('"')) {
    try {
      return { source: JSON.stringify(JSON.parse(token)) };
    } catch {
      return null;
    }
  }

  if (token.startsWith("'")) {
    const value = token.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    return { source: JSON.stringify(value) };
  }

  return null;
}

function normalizeRepairCandidatePrimitiveOracle(record = {}, candidate = {}) {
  const allowedFailureTypes = new Set([
    "VALUE_ORACLE_FAILURE",
    "BOOLEAN_ORACLE_FAILURE",
    "NULL_ORACLE_FAILURE",
    "UNDEFINED_ORACLE_FAILURE",
  ]);

  if (!allowedFailureTypes.has(record.failureType)) return candidate;

  const observed = parseObservedPrimitiveFromJestError(record.error);
  if (!observed) return candidate;

  const assertion = String(candidate.assert || "");
  const normalizedAssertion = assertion.replace(
    /(expect\s*\(\s*result\s*\)\s*\.toBe\s*\()([^)]*)(\))/,
    `$1${observed.source}$3`
  );

  if (normalizedAssertion === assertion) return candidate;

  return {
    ...candidate,
    title: `Observed behavior returns ${observed.source}`,
    assert: normalizedAssertion,
  };
}
function buildRepairCandidateCases(repairCandidates = []) {
  const safeRepairCandidates = (Array.isArray(repairCandidates)
    ? repairCandidates
    : []).filter(isInjectableRepairCandidateRecord);

  const primaryLimit = Math.max(0, MAX_REPAIR_CANDIDATE_INJECTIONS_PER_FUNCTION);
  const selectedRecords = safeRepairCandidates.slice(0, primaryLimit);
  const selectedBehaviorKeys = new Set(
    selectedRecords.map((record) =>
      `${String(record.arrange || record.candidate?.arrange || "").trim()}\n${String(
        record.act || record.candidate?.act || ""
      ).trim()}`
    )
  );

  let autoNormalizedAdded = 0;
  const autoNormalizedLimit = Math.max(
    0,
    MAX_AUTO_NORMALIZED_REPAIR_CANDIDATES_PER_FUNCTION
  );

  for (const record of safeRepairCandidates.slice(primaryLimit)) {
    if (autoNormalizedAdded >= autoNormalizedLimit) break;

    const asyncNormalized = normalizeRepairCandidateAsyncMatchers(record.candidate || {});
    const oracleNormalized = normalizeRepairCandidatePrimitiveOracle(record, asyncNormalized);

    // Extra candidates are admitted only when a primitive result observed by
    // Jest lets us deterministically correct the exact oracle. Keep distinct
    // arrange/act behavior so repeated candidates do not inflate the suite.
    if (String(oracleNormalized.assert || "") === String(asyncNormalized.assert || "")) {
      continue;
    }

    const behaviorKey = `${String(record.arrange || oracleNormalized.arrange || "").trim()}\n${String(
      record.act || oracleNormalized.act || ""
    ).trim()}`;
    if (selectedBehaviorKeys.has(behaviorKey)) continue;

    selectedBehaviorKeys.add(behaviorKey);
    selectedRecords.push(record);
    autoNormalizedAdded += 1;
  }

  return selectedRecords.map((record, index) => {
      const asyncNormalizedCandidate = normalizeRepairCandidateAsyncMatchers(record.candidate || {});
      const candidate = normalizeRepairCandidatePrimitiveOracle(record, asyncNormalizedCandidate);
      const title = normalizeTitle(
        candidate.title || record.title || `repair candidate ${index + 1}`
      );

      return {
        ...candidate,
        title: `[repair-candidate] ${title}`,
        __unitgenRepairCandidate: true,
        __unitgenFailureType: record.failureType || "RUNTIME_FAILED",
        __unitgenRuntimeReason: record.runtimeReason || record.reason || "RUNTIME_FAILED",
        __unitgenRuntimeError: record.error || "",
      };
    });
}

function printReasonSection(title, reasons = {}) {
  const entries = Object.entries(reasons || {}).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) return;

  console.log(`   ${title}:`);
  for (const [reason, count] of entries) {
    console.log(`   - ${reason}: ${count}`);
  }
}

function printEnhancedInjectionSummary({
  displayName,
  sanitizeStats,
  runtimeStats,
  fallbackSanitizeStats,
  fallbackRuntimeStats,
  fallbackInjected,
  repairCandidatesAvailable = 0,
  repairCandidatesInjected = 0,
  finalInjected,
}) {
  const runtime = summarizeRuntimeValidation(runtimeStats || {});
  const fallbackRuntime = summarizeRuntimeValidation(fallbackRuntimeStats || {});

  console.log(`🧪 LLM injection summary for ${displayName}`);
  console.log(`   received: ${sanitizeStats?.received ?? 0}`);
  console.log(`   sanitizer accepted: ${sanitizeStats?.accepted ?? 0}`);
  console.log(`   sanitizer rejected: ${sanitizeStats?.rejected ?? 0}`);
  console.log(`   duplicates: ${sanitizeStats?.duplicates ?? 0}`);
  console.log(`   runtime attempted: ${runtime.attempted ?? 0}`);
  console.log(`   runtime passed: ${runtime.passed ?? 0}`);
  console.log(`   runtime failed: ${runtime.failed ?? 0}`);
  console.log(`   runtime repair candidates available: ${repairCandidatesAvailable}`);
  console.log(`   runtime repair candidates injected: ${repairCandidatesInjected}`);
  console.log(`   fallback sanitizer received: ${fallbackSanitizeStats?.received ?? 0}`);
  console.log(`   fallback sanitizer accepted: ${fallbackSanitizeStats?.accepted ?? 0}`);
  console.log(`   fallback sanitizer rejected: ${fallbackSanitizeStats?.rejected ?? 0}`);
  console.log(`   fallback runtime attempted: ${fallbackRuntime.attempted ?? 0}`);
  console.log(`   fallback runtime passed: ${fallbackRuntime.passed ?? 0}`);
  console.log(`   fallback runtime failed: ${fallbackRuntime.failed ?? 0}`);
  console.log(`   fallback injected: ${fallbackInjected ?? 0}`);
  console.log(`   final injected: ${finalInjected ?? 0}`);

  printReasonSection("LLM sanitizer reasons", sanitizeStats?.reasons);
  printReasonSection("LLM runtime reasons", runtime?.reasons);
  printReasonSection("LLM runtime failure types", runtime?.failureTypes);
  printReasonSection("fallback sanitizer reasons", fallbackSanitizeStats?.reasons);
  printReasonSection("fallback runtime reasons", fallbackRuntime?.reasons);
}

function buildModuleSourceContext(ctx = {}) {
  const sourceFile = ctx.sourceFile || ctx.filePath || "";

  if (!sourceFile || !fs.existsSync(sourceFile)) return "";

  try {
    const stat = fs.statSync(sourceFile);
    if (!stat.isFile() || stat.size > 120000) return "";

    const source = fs.readFileSync(sourceFile, "utf8");
    const normalized = String(source || "").replace(/\r\n/g, "\n").trim();
    if (!normalized) return "";

    const maxChars = Number(process.env.UNITGEN_MODULE_CONTEXT_CHARS || 4200);
    if (normalized.length <= maxChars) return normalized;

    const functionCode = String(ctx.functionCode || "").trim();
    const fnIndex = functionCode ? normalized.indexOf(functionCode.slice(0, 160)) : -1;

    if (fnIndex > 0) {
      const beforeStart = Math.max(0, fnIndex - Math.floor(maxChars * 0.7));
      const afterEnd = Math.min(normalized.length, fnIndex + Math.floor(maxChars * 0.3));
      return normalized.slice(beforeStart, afterEnd).trim();
    }

    return normalized.slice(0, maxChars).trim();
  } catch {
    return "";
  }
}
function buildHarnessNotes(ctx = {}) {
  const classNotes = [];

  if (ctx.isClassLike || ctx.isClassMethod || ctx.ownerClassName) {
    classNotes.push(
      "This target may be a class constructor or class method.",
      "For constructor targets, act should be new ClassName(...args).",
      "For prototype method targets, arrange must create an instance using new OwnerClass(...), then act must call instance.methodName(...args).",
      "Never call prototype methods as OwnerClass.methodName(...).",
      "For static method targets, act should call OwnerClass.methodName(...args).",
      "Do not invent prototype methods. Use only methods listed in the discovered public class API.",
      ctx.classMethods?.length
        ? `Discovered public class methods: ${ctx.classMethods.join(", ")}. For stateful APIs, arrange may establish state with one public method and assert the target behavior through another public method when the relationship is clear from source.`
        : ""
    );
  }

  return [
    "Tool already handles imports, scaffolding, dependency mocks, candidate runtime validation, and fallback injection.",
    "Return ONLY JSON inside <JSON>...</JSON>.",
    "Do NOT write imports, exports, requires, mocks, describe, it, or test blocks.",
    "Provide only title, arrange, act, and assert fields.",
    "Generate 6 to 8 candidate test cases.",
    "At least 2 candidates should be safe invariant tests that check result shape, type, defined/null behavior, array/object structure, or broad valid output.",
    "At least 1 candidate should test a simple deterministic/default behavior.",
    "If parameters exist, include at least 1 simple parameterized behavior test using safe literals or variables declared in arrange.",
    ...classNotes,
    "The act should express the function call intent. Missing simple arguments may be recovered by the tool.",
    "For exception cases, write an assertion that uses toThrow/toThrowError and the tool will normalize it.",
    "Use only literals, variables you declare in arrange, the function name/class name in act, and result in assert.",
    "Do NOT reference helper variables, internal source variables, private helpers, or undeclared identifiers.",
    "Prefer deterministic and simple test cases.",
    "Prefer assertions on result or values clearly derived from result.",
    "Do NOT assert that local mock functions, callbacks, private helpers, or invented helper functions were called.",
    "Do NOT use toHaveBeenCalled, toHaveBeenCalledTimes, toHaveBeenCalledWith, toHaveBeenLastCalledWith, or toHaveBeenNthCalledWith.",
    "Do NOT fabricate option/config/settings object fields. Use an empty object unless the key clearly appears in the function code.",
    "For numeric or mathematical functions, exact numeric assertions are allowed only when the input is simple and deterministic.",
    "For arrays, objects, and strings, use simple expected values only when they are clearly derived from the input or function behavior.",
    "For object properties, prefer toHaveProperty(path) or simple property checks instead of toHaveProperty(path, fullObject).",
    "Do NOT use full result deep equality against object or array literals for no-argument functions.",
    "For no-argument functions returning collections or maps, prefer safe structural assertions such as toBeDefined, typeof result, Object.keys(result).length, toHaveProperty(path), or Array.isArray(result).",
    "For random, mutating, clustering, matrix, or shape-sensitive functions, prefer invariant assertions such as defined result, array type, length, containment, or safe structural checks.",
    "If the function accepts callback-like parameters such as randomSource, distributionType, kernel, bandwidthMethod, comparator, handler, callback, cb, or fn, provide a simple valid function literal in arrange.",
    "If the function returns another function, do not assert a primitive result from the outer call unless the function is actually invoked.",
    "Avoid fabricated expected variables that simply duplicate the input without proving behavior.",
    "Do NOT redeclare const result.",
  ].join(" ");
}

function buildPromptFunctionName(ctx) {
  if (ctx.isClassMethod && ctx.ownerClassName && ctx.methodName) {
    if (ctx.methodKind === "static") {
      return `${ctx.ownerClassName}.${ctx.methodName}`;
    }

    if (ctx.methodKind === "constructor") {
      return ctx.ownerClassName;
    }

    return `${ctx.ownerClassName}.${ctx.methodName}`;
  }

  return ctx.fnName;
}

export async function fillGeneratedTestsWithLLM({
  contexts,
  model = "qwen2.5:1.5b",
}) {
  let updated = 0;
  let failed = 0;
  const processedTestFiles = new Set();

  for (const ctx of contexts) {
    const displayName = ctx.displayName || ctx.fullName || ctx.fnName;
    const normalizedTestFilePath = String(ctx.testFilePath || "")
      .replace(/\\/g, "/")
      .toLowerCase();

    if (processedTestFiles.has(normalizedTestFilePath)) {
      console.log(`Skipping duplicate LLM context for ${displayName}: ${ctx.testFilePath}`);
      continue;
    }

    processedTestFiles.add(normalizedTestFilePath);

    try {
      const template = fs.readFileSync(ctx.testFilePath, "utf8");
      const templateAllowedIdentifiers = extractImportedTemplateBindings(template);

      if (!template.includes(UNITGEN_LLM_MARKER)) {
        throw new Error("Template marker not found in generated test file.");
      }

      if (shouldSkipLlmForFunction({
        fnName: ctx.fnName,
        params: ctx.params || [],
        isClassLike: !!ctx.isClassLike,
        isClassMethod: !!ctx.isClassMethod,
        methodKind: ctx.methodKind || "",
      })) {
        failed++;
        console.log(
          `⚠️ LLM skipped for ${displayName}; no safe class/function context available.`
        );
        continue;
      }

      const prompt = buildOllamaPrompt({
        fnName: buildPromptFunctionName(ctx),
        isAsync: ctx.isAsync,
        params: ctx.params,
        functionCode: ctx.functionCode,
        harnessNotes: buildHarnessNotes(ctx),
        usageSnippets: ctx.usageSnippets || [],
        docComment: ctx.docComment || null,
        moduleContext: buildModuleSourceContext(ctx),
        classContext: {
          isClassLike: !!ctx.isClassLike,
          isClassMethod: !!ctx.isClassMethod,
          ownerClassName: ctx.ownerClassName || "",
          methodName: ctx.methodName || "",
          methodKind: ctx.methodKind || "",
          constructorParams: ctx.constructorParams || [],
        },
      });

      let parsedCases = [];
      let llmGenerationError = null;

      try {
        let raw = await ollamaGenerate({
          model,
          prompt,
          temperature: 0.15,
        });

        raw = stripMarkdownCodeFences(raw);

        const jsonText = extractJsonArray(raw);
        parsedCases = JSON.parse(jsonText);
      } catch (e) {
        llmGenerationError = e;
        console.log(
          `⚠️ LLM unavailable for ${displayName}; trying fallback generation: ${e?.message ?? e}`
        );
      }

      const { safeCases, stats: sanitizeStats } = sanitizeCases({
        fnName: ctx.fnName,
        isAsync: ctx.isAsync,
        params: ctx.params || [],
        cases: parsedCases,
        isClassLike: !!ctx.isClassLike,
        isClassMethod: !!ctx.isClassMethod,
        ownerClassName: ctx.ownerClassName || "",
        methodName: ctx.methodName || "",
        methodKind: ctx.methodKind || "",
        constructorParams: ctx.constructorParams || [],
        extraAllowedIdentifiers: templateAllowedIdentifiers,
      });

      const rawSourceDrivenCases = buildSourceDrivenBehaviorCases({
        fnName: ctx.fnName,
        params: ctx.params || [],
        functionCode: ctx.functionCode,
        maxCases: 3,
      });
      const sourceDrivenSanitized = sanitizeCases({
        fnName: ctx.fnName,
        isAsync: ctx.isAsync,
        params: ctx.params || [],
        cases: rawSourceDrivenCases,
        isClassLike: !!ctx.isClassLike,
        isClassMethod: !!ctx.isClassMethod,
        ownerClassName: ctx.ownerClassName || "",
        methodName: ctx.methodName || "",
        methodKind: ctx.methodKind || "",
        constructorParams: ctx.constructorParams || [],
        extraAllowedIdentifiers: templateAllowedIdentifiers,
      });
      const sourceDrivenRuntime = await runtimeValidateCases({
        ctx,
        template,
        cases: sourceDrivenSanitized.safeCases,
        seedCases: [],
        isAsync: ctx.isAsync,
        maxPassing: 3,
        collectRepairCandidates: false,
      });
      const sourceDrivenCases = sourceDrivenRuntime.passingCases;

      if (rawSourceDrivenCases.length > 0) {
        console.log(
          `Source-driven higher-order behavior: ${sourceDrivenCases.length > 0 ? "accepted" : "rejected by validation"} for ${displayName}`
        );
      }

      const runtimeResult = await runtimeValidateCases({
        ctx,
        template,
        cases: safeCases,
        seedCases: sourceDrivenCases,
        isAsync: ctx.isAsync,
        maxPassing: MAX_RUNTIME_VALIDATED_INJECTIONS,
        collectRepairCandidates: true,
      });

      let finalCases = runtimeResult.passingCases.slice(
        0,
        MAX_FINAL_INJECTIONS_PER_FUNCTION
      );

      let fallbackSanitizeStats = createEmptySanitizeStats(0);
      let fallbackRuntimeResult = {
        passingCases: finalCases,
        newPassingCases: [],
        failedCandidates: [],
        repairCandidates: [],
        stats: createEmptyRuntimeStats(),
      };

      let fallbackInjected = 0;

      const remainingSlots =
        MAX_FINAL_INJECTIONS_PER_FUNCTION - finalCases.length;

      if (remainingSlots > 0) {
        const fallbackLimit = Math.min(
          MAX_FALLBACK_INJECTIONS,
          remainingSlots
        );

        const rawFallbackCases = buildFallbackCases({
          fnName: ctx.fnName,
          params: ctx.params || [],
          isAsync: ctx.isAsync,
          isClassLike: !!ctx.isClassLike,
          functionCode: ctx.functionCode,
          maxCases: fallbackLimit,

          isClassMethod: !!ctx.isClassMethod,
          ownerClassName: ctx.ownerClassName || "",
          methodName: ctx.methodName || "",
          methodKind: ctx.methodKind || "",
          constructorParams: ctx.constructorParams || [],
          constructorCode: ctx.constructorCode || ctx.classCode || "",
          classMethods: ctx.classMethods || [],
        });

        const fallbackSanitized = sanitizeCases({
          fnName: ctx.fnName,
          isAsync: ctx.isAsync,
          params: ctx.params || [],
          cases: rawFallbackCases,
          isClassLike: !!ctx.isClassLike,
          isClassMethod: !!ctx.isClassMethod,
          ownerClassName: ctx.ownerClassName || "",
          methodName: ctx.methodName || "",
          methodKind: ctx.methodKind || "",
          constructorParams: ctx.constructorParams || [],
          extraAllowedIdentifiers: templateAllowedIdentifiers,
        });

        fallbackSanitizeStats = fallbackSanitized.stats;

        fallbackRuntimeResult = await runtimeValidateCases({
          ctx,
          template,
          cases: fallbackSanitized.safeCases,
          seedCases: finalCases,
          isAsync: ctx.isAsync,
          maxPassing: MAX_FINAL_INJECTIONS_PER_FUNCTION,
          collectRepairCandidates: false,
        });

        finalCases = fallbackRuntimeResult.passingCases.slice(
          0,
          MAX_FINAL_INJECTIONS_PER_FUNCTION
        );

        fallbackInjected = fallbackRuntimeResult.newPassingCases.length;
      }

      const repairCandidateCases = buildRepairCandidateCases(runtimeResult.repairCandidates);

      const finalCasesWithRepairCandidates = [
        ...finalCases,
        ...repairCandidateCases,
      ];

      ctx.llmInjectionSummary = {
        displayName,
        llmGenerationError: llmGenerationError?.message || "",
        sanitizerReceived: sanitizeStats?.received ?? 0,
        sanitizerAccepted: sanitizeStats?.accepted ?? 0,
        sanitizerRejected: sanitizeStats?.rejected ?? 0,
        llmRuntimePassed: runtimeResult?.stats?.passed ?? 0,
        llmRuntimeFailed: runtimeResult?.stats?.failed ?? 0,
        fallbackInjected,
        repairCandidatesAvailable: runtimeResult?.repairCandidates?.length ?? 0,
        repairCandidatesInjected: repairCandidateCases.length,
        finalPassingInjected: finalCases.length,
        finalInjected: finalCasesWithRepairCandidates.length,
      };

      printEnhancedInjectionSummary({
        displayName,
        sanitizeStats,
        runtimeStats: runtimeResult.stats,
        fallbackSanitizeStats,
        fallbackRuntimeStats: fallbackRuntimeResult.stats,
        fallbackInjected,
        repairCandidatesAvailable: runtimeResult.repairCandidates.length,
        repairCandidatesInjected: repairCandidateCases.length,
        finalInjected: finalCasesWithRepairCandidates.length,
      });

      if (finalCasesWithRepairCandidates.length === 0) {
        failed++;
        console.log(
          `⚠️ No runtime-passing LLM or fallback cases for ${displayName}; keeping prototype only.`
        );
        continue;
      }

      const finalTestFile = buildFinalInjectedContent({
        template,
        cases: finalCasesWithRepairCandidates,
        buildTestBlocks,
        isAsync: ctx.isAsync,
      });

      validateJavaScriptModule(finalTestFile);

      fs.writeFileSync(ctx.testFilePath, finalTestFile, "utf8");
      updated++;

      const repairSuffix =
        repairCandidateCases.length > 0
          ? ` + ${repairCandidateCases.length} repair candidate(s)`
          : "";

      console.log(
        `✨ Runtime-validated tests injected: ${ctx.testFilePath} (${finalCases.length}${repairSuffix})`
      );
    } catch (e) {
      failed++;
      console.log(`⚠️ LLM failed for ${displayName}: ${e?.message ?? e}`);
    }
  }

  return { updated, failed };
}
