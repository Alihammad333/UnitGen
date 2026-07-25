import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default;

/**
 * docCommentExtractor.js
 *
 * Purpose:
 * Extracts JSDoc / nearby comments for functions so UnitGen can give the LLM
 * stronger semantic context before generating tests.
 *
 * This helps improve:
 * - expected parameter meaning
 * - return-shape understanding
 * - safer assertions
 * - fewer hallucinated inputs
 * - better generated test quality
 *
 * Important:
 * - This module is read-only.
 * - It never executes user/package code.
 * - It is designed to fail safely and return empty context instead of breaking
 *   the UnitGen pipeline.
 *
 * This file is NOT connected yet.
 * Later we will connect it in:
 * - backend/src/index.js
 * - backend/src/core/llm/promptBuilder.js
 */

const DEFAULT_MAX_COMMENT_CHARS = 1200;
const DEFAULT_MAX_NEARBY_LINES = 6;

function safeString(value) {
  return String(value || "");
}

function normalizeWhitespace(text) {
  return safeString(text)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function truncateText(text, maxChars = DEFAULT_MAX_COMMENT_CHARS) {
  const s = normalizeWhitespace(text);

  if (s.length <= maxChars) return s;

  return `${s.slice(0, maxChars).trim()}\n...truncated`;
}

function parseSourceSafely(code) {
  try {
    return parse(safeString(code), {
      sourceType: "unambiguous",
      plugins: [
        "topLevelAwait",
        "dynamicImport",
        "importMeta",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "objectRestSpread",
        "optionalChaining",
        "nullishCoalescingOperator",
        "jsx",
        "typescript",
      ],
      attachComment: true,
      tokens: true,
      ranges: true,
    });
  } catch {
    try {
      return parse(safeString(code), {
        sourceType: "module",
        plugins: [
          "topLevelAwait",
          "dynamicImport",
          "importMeta",
          "classProperties",
          "objectRestSpread",
          "optionalChaining",
          "nullishCoalescingOperator",
        ],
        attachComment: true,
        tokens: true,
        ranges: true,
      });
    } catch {
      return null;
    }
  }
}

function cleanCommentText(raw) {
  let s = safeString(raw);

  /*
   * Babel comment.value already removes //, /*, and *\/ markers.
   * This cleanup handles JSDoc leading stars and formatting.
   */
  s = s
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();

  return normalizeWhitespace(s);
}

function commentNodeToText(comment) {
  if (!comment) return "";

  return cleanCommentText(comment.value || "");
}

function isUsefulComment(text) {
  const s = normalizeWhitespace(text);

  if (!s) return false;
  if (s.length < 3) return false;

  const lower = s.toLowerCase();

  const useless = [
    "eslint-disable",
    "eslint-enable",
    "istanbul ignore",
    "prettier-ignore",
    "@ts-ignore",
    "@ts-nocheck",
    "@ts-check",
    "use strict",
  ];

  return !useless.some((x) => lower.includes(x));
}

function getLeadingCommentText(node) {
  const comments = node?.leadingComments || [];

  if (!Array.isArray(comments) || comments.length === 0) return "";

  /*
   * Prefer the closest leading block/JSDoc comment.
   */
  const sorted = [...comments].sort((a, b) => (b.end || 0) - (a.end || 0));

  for (const comment of sorted) {
    const text = commentNodeToText(comment);
    if (isUsefulComment(text)) return text;
  }

  return "";
}

function getTrailingCommentText(node) {
  const comments = node?.trailingComments || [];

  if (!Array.isArray(comments) || comments.length === 0) return "";

  const parts = [];

  for (const comment of comments) {
    const text = commentNodeToText(comment);
    if (isUsefulComment(text)) parts.push(text);
  }

  return parts.join("\n");
}

function lineIndexFromCode(code) {
  const lines = safeString(code).split(/\r?\n/);
  return lines;
}

function getNearbyCommentsFromLines({
  code,
  startLine,
  endLine,
  maxNearbyLines = DEFAULT_MAX_NEARBY_LINES,
}) {
  const lines = lineIndexFromCode(code);
  const start = Math.max(0, Number(startLine || 1) - 1);
  const end = Math.max(start, Number(endLine || startLine || 1) - 1);

  const beforeStart = Math.max(0, start - maxNearbyLines);
  const beforeLines = lines.slice(beforeStart, start);

  const afterEnd = Math.min(lines.length, end + 1 + maxNearbyLines);
  const afterLines = lines.slice(end + 1, afterEnd);

  const beforeComments = extractCommentLines(beforeLines).join("\n");
  const afterComments = extractCommentLines(afterLines).join("\n");

  const combined = [beforeComments, afterComments]
    .filter((x) => isUsefulComment(x))
    .join("\n");

  return normalizeWhitespace(combined);
}

function extractCommentLines(lines = []) {
  const out = [];

  let insideBlock = false;
  let blockLines = [];

  for (const line of lines) {
    const trimmed = safeString(line).trim();

    if (!trimmed) continue;

    if (insideBlock) {
      blockLines.push(trimmed);

      if (trimmed.includes("*/")) {
        insideBlock = false;
        out.push(cleanBlockCommentLines(blockLines));
        blockLines = [];
      }

      continue;
    }

    if (trimmed.startsWith("//")) {
      out.push(trimmed.replace(/^\/\/\s?/, ""));
      continue;
    }

    if (trimmed.startsWith("/*")) {
      insideBlock = true;
      blockLines = [trimmed];

      if (trimmed.includes("*/")) {
        insideBlock = false;
        out.push(cleanBlockCommentLines(blockLines));
        blockLines = [];
      }
    }
  }

  if (blockLines.length > 0) {
    out.push(cleanBlockCommentLines(blockLines));
  }

  return out.map(cleanCommentText).filter(isUsefulComment);
}

function cleanBlockCommentLines(lines = []) {
  return lines
    .join("\n")
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");
}

function parseJsDocTags(commentText) {
  const text = safeString(commentText);
  const tags = {
    params: [],
    returns: "",
    throws: [],
    examples: [],
    description: "",
    rawTags: [],
  };

  if (!text.trim()) return tags;

  const lines = text.split("\n");
  const descriptionLines = [];

  let currentExample = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (currentExample !== null) currentExample.push("");
      continue;
    }

    const tagMatch = trimmed.match(/^@([A-Za-z]+)\s*(.*)$/);

    if (tagMatch) {
      const tag = tagMatch[1].toLowerCase();
      const body = tagMatch[2] || "";

      tags.rawTags.push({
        tag,
        body,
      });

      currentExample = null;

      if (tag === "param" || tag === "arg" || tag === "argument") {
        tags.params.push(parseParamTag(body));
        continue;
      }

      if (tag === "returns" || tag === "return") {
        tags.returns = normalizeWhitespace(body);
        continue;
      }

      if (tag === "throws" || tag === "throw") {
        tags.throws.push(normalizeWhitespace(body));
        continue;
      }

      if (tag === "example") {
        currentExample = [body].filter(Boolean);
        tags.examples.push(currentExample);
        continue;
      }

      continue;
    }

    if (currentExample !== null) {
      currentExample.push(line);
    } else {
      descriptionLines.push(line);
    }
  }

  tags.examples = tags.examples
    .map((exampleLines) => normalizeWhitespace(exampleLines.join("\n")))
    .filter(Boolean);

  tags.description = normalizeWhitespace(descriptionLines.join("\n"));

  return tags;
}

function parseParamTag(body) {
  const s = normalizeWhitespace(body);

  /*
   * Handles common forms:
   * @param {string} id description
   * @param id description
   * @param {Object} options
   * @param {number[]} values
   */
  const typed = s.match(/^\{([^}]+)\}\s+([A-Za-z_$][A-Za-z0-9_$.[\]-]*)\s*(.*)$/);
  if (typed) {
    return {
      name: typed[2],
      type: typed[1],
      description: normalizeWhitespace(typed[3]),
      raw: s,
    };
  }

  const untyped = s.match(/^([A-Za-z_$][A-Za-z0-9_$.[\]-]*)\s*(.*)$/);
  if (untyped) {
    return {
      name: untyped[1],
      type: "",
      description: normalizeWhitespace(untyped[2]),
      raw: s,
    };
  }

  return {
    name: "",
    type: "",
    description: s,
    raw: s,
  };
}

function getNodeName(node, parentPath = null) {
  if (!node) return "";

  if (node.id?.name) return node.id.name;

  if (node.key?.name) return node.key.name;
  if (node.key?.value) return String(node.key.value);

  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
    return node.id.name;
  }

  if (
    node.type === "AssignmentExpression" &&
    node.left?.type === "Identifier"
  ) {
    return node.left.name;
  }

  if (
    node.type === "AssignmentExpression" &&
    node.left?.type === "MemberExpression"
  ) {
    return getMemberExpressionName(node.left);
  }

  const parent = parentPath?.node;

  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return parent.id.name;
  }

  if (parent?.type === "ObjectProperty") {
    if (parent.key?.name) return parent.key.name;
    if (parent.key?.value) return String(parent.key.value);
  }

  if (parent?.type === "ExportNamedDeclaration" && node.declaration?.id?.name) {
    return node.declaration.id.name;
  }

  return "";
}

function getMemberExpressionName(node) {
  if (!node || node.type !== "MemberExpression") return "";

  const parts = [];

  let current = node;

  while (current?.type === "MemberExpression") {
    const prop = current.property;

    if (prop?.type === "Identifier") {
      parts.unshift(prop.name);
    } else if (prop?.type === "StringLiteral") {
      parts.unshift(prop.value);
    }

    current = current.object;
  }

  if (current?.type === "Identifier") {
    parts.unshift(current.name);
  }

  return parts.join(".");
}

function getFunctionParamNames(node) {
  const params = node?.params || [];

  return params.map((param, index) => {
    if (param.type === "Identifier") return param.name;
    if (param.type === "AssignmentPattern" && param.left?.type === "Identifier") {
      return param.left.name;
    }
    if (param.type === "RestElement" && param.argument?.type === "Identifier") {
      return param.argument.name;
    }
    if (param.type === "ObjectPattern") return `objectParam${index + 1}`;
    if (param.type === "ArrayPattern") return `arrayParam${index + 1}`;

    return `arg${index + 1}`;
  });
}

function isFunctionLikeNode(node) {
  return [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "ObjectMethod",
    "ClassMethod",
    "ClassPrivateMethod",
  ].includes(node?.type);
}

function getFunctionNodeFromPath(path) {
  const node = path.node;

  if (isFunctionLikeNode(node)) {
    return node;
  }

  if (
    node?.type === "VariableDeclarator" &&
    isFunctionLikeNode(node.init)
  ) {
    return node.init;
  }

  if (
    node?.type === "AssignmentExpression" &&
    isFunctionLikeNode(node.right)
  ) {
    return node.right;
  }

  return null;
}

function getCommentCarrierNode(path) {
  const node = path.node;

  if (!node) return null;

  /*
   * For const foo = () => {}, the useful leading comment is often attached to
   * the VariableDeclaration parent, not only VariableDeclarator or ArrowFunction.
   */
  if (node.type === "VariableDeclarator") {
    return path.parentPath?.node || node;
  }

  if (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  ) {
    if (path.parentPath?.node?.type === "VariableDeclarator") {
      return path.parentPath.parentPath?.node || path.parentPath.node;
    }

    return node;
  }

  return node;
}

function extractFunctionRecordFromPath(path, code) {
  const functionNode = getFunctionNodeFromPath(path);
  if (!functionNode) return null;

  const node = path.node;
  const name = getNodeName(node, path);

  if (!name) return null;

  const carrier = getCommentCarrierNode(path);
  const leading = getLeadingCommentText(carrier) || getLeadingCommentText(node);
  const trailing = getTrailingCommentText(carrier) || getTrailingCommentText(node);

  const loc = functionNode.loc || node.loc || {};
  const startLine = loc.start?.line || 1;
  const endLine = loc.end?.line || startLine;

  const nearby = getNearbyCommentsFromLines({
    code,
    startLine,
    endLine,
  });

  const combinedComment = [leading, trailing, nearby]
    .filter(isUsefulComment)
    .join("\n");

  const jsDoc = parseJsDocTags(combinedComment);

  return {
    name,
    comment: truncateText(combinedComment),
    leadingComment: truncateText(leading),
    trailingComment: truncateText(trailing),
    nearbyComment: truncateText(nearby),
    jsDoc,
    params: getFunctionParamNames(functionNode),
    loc: {
      startLine,
      endLine,
    },
  };
}

function mergeCommentRecords(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingScore = scoreCommentRecord(existing);
  const incomingScore = scoreCommentRecord(incoming);

  return incomingScore > existingScore ? incoming : existing;
}

function scoreCommentRecord(record) {
  if (!record) return 0;

  let score = 0;

  if (record.leadingComment) score += 30;
  if (record.jsDoc?.description) score += 20;
  if (record.jsDoc?.params?.length) score += record.jsDoc.params.length * 10;
  if (record.jsDoc?.returns) score += 15;
  if (record.jsDoc?.examples?.length) score += 25;
  if (record.nearbyComment) score += 5;

  score += Math.min(String(record.comment || "").length / 40, 20);

  return score;
}

function emptyCommentRecord(fnName = "") {
  return {
    name: fnName,
    comment: "",
    leadingComment: "",
    trailingComment: "",
    nearbyComment: "",
    jsDoc: {
      params: [],
      returns: "",
      throws: [],
      examples: [],
      description: "",
      rawTags: [],
    },
    params: [],
    loc: {
      startLine: 0,
      endLine: 0,
    },
  };
}

/**
 * Extracts doc comments for every function-like declaration found in code.
 *
 * Return shape:
 * {
 *   fnName: {
 *     name,
 *     comment,
 *     leadingComment,
 *     trailingComment,
 *     nearbyComment,
 *     jsDoc: {
 *       description,
 *       params,
 *       returns,
 *       throws,
 *       examples,
 *       rawTags
 *     },
 *     params,
 *     loc
 *   }
 * }
 */
export function extractDocCommentsFromCode(code, options = {}) {
  const ast = parseSourceSafely(code);

  if (!ast) return {};

  const out = {};
  const maxCommentChars = options.maxCommentChars || DEFAULT_MAX_COMMENT_CHARS;

  function addRecord(record) {
    if (!record?.name) return;

    record.comment = truncateText(record.comment, maxCommentChars);
    record.leadingComment = truncateText(record.leadingComment, maxCommentChars);
    record.trailingComment = truncateText(record.trailingComment, maxCommentChars);
    record.nearbyComment = truncateText(record.nearbyComment, maxCommentChars);

    out[record.name] = mergeCommentRecords(out[record.name], record);
  }

  try {
    traverse(ast, {
      FunctionDeclaration(path) {
        addRecord(extractFunctionRecordFromPath(path, code));
      },

      VariableDeclarator(path) {
        if (isFunctionLikeNode(path.node.init)) {
          addRecord(extractFunctionRecordFromPath(path, code));
        }
      },

      AssignmentExpression(path) {
        if (isFunctionLikeNode(path.node.right)) {
          addRecord(extractFunctionRecordFromPath(path, code));
        }
      },

      ObjectMethod(path) {
        addRecord(extractFunctionRecordFromPath(path, code));
      },

      ClassMethod(path) {
        addRecord(extractFunctionRecordFromPath(path, code));
      },
    });
  } catch {
    return out;
  }

  return out;
}

/**
 * Extracts comment context for a known function list.
 *
 * Recommended later from index.js:
 *
 * const docComments = extractDocCommentsForFunctions({
 *   code,
 *   functions,
 * });
 *
 * Then:
 * ctx.docComment = docComments[fnName]
 */
export function extractDocCommentsForFunctions({
  code,
  functions = [],
  fnNames = [],
  maxCommentChars = DEFAULT_MAX_COMMENT_CHARS,
} = {}) {
  const extracted = extractDocCommentsFromCode(code, {
    maxCommentChars,
  });

  const names = new Set();

  for (const fn of Array.isArray(functions) ? functions : []) {
    if (fn?.name) names.add(fn.name);
  }

  for (const name of Array.isArray(fnNames) ? fnNames : []) {
    if (name) names.add(String(name));
  }

  const result = {};

  for (const name of names) {
    result[name] = extracted[name] || emptyCommentRecord(name);
  }

  return result;
}

/**
 * Formats one doc-comment record for promptBuilder.js.
 *
 * Keep this compact, because prompts already include function source.
 */
export function formatDocCommentForPrompt(record, maxChars = DEFAULT_MAX_COMMENT_CHARS) {
  if (!record || !record.name) {
    return "No doc comment was found for this function.";
  }

  const parts = [];

  if (record.jsDoc?.description) {
    parts.push(`Description:\n${record.jsDoc.description}`);
  } else if (record.leadingComment) {
    parts.push(`Comment:\n${record.leadingComment}`);
  } else if (record.comment) {
    parts.push(`Comment:\n${record.comment}`);
  }

  if (record.jsDoc?.params?.length) {
    const paramLines = record.jsDoc.params
      .map((p) => {
        const pieces = [];

        if (p.name) pieces.push(p.name);
        if (p.type) pieces.push(`{${p.type}}`);
        if (p.description) pieces.push(`- ${p.description}`);

        return `- ${pieces.join(" ")}`.trim();
      })
      .join("\n");

    if (paramLines) {
      parts.push(`Parameters:\n${paramLines}`);
    }
  }

  if (record.jsDoc?.returns) {
    parts.push(`Returns:\n${record.jsDoc.returns}`);
  }

  if (record.jsDoc?.throws?.length) {
    parts.push(`Throws:\n${record.jsDoc.throws.map((x) => `- ${x}`).join("\n")}`);
  }

  if (record.jsDoc?.examples?.length) {
    const examples = record.jsDoc.examples
      .slice(0, 2)
      .map((example, index) => `Example ${index + 1}:\n${example}`)
      .join("\n\n");

    if (examples) {
      parts.push(examples);
    }
  }

  if (!parts.length && record.nearbyComment) {
    parts.push(`Nearby comment:\n${record.nearbyComment}`);
  }

  if (!parts.length) {
    return "No doc comment was found for this function.";
  }

  return truncateText(parts.join("\n\n"), maxChars);
}

/**
 * Logging helper.
 */
export function summarizeDocCommentExtraction(commentMap = {}) {
  const perFunction = {};
  let found = 0;

  for (const [fnName, record] of Object.entries(commentMap || {})) {
    const hasComment = Boolean(record?.comment || record?.leadingComment);
    const hasJsDoc =
      Boolean(record?.jsDoc?.description) ||
      Boolean(record?.jsDoc?.params?.length) ||
      Boolean(record?.jsDoc?.returns);

    perFunction[fnName] = {
      hasComment,
      hasJsDoc,
      paramTags: record?.jsDoc?.params?.length || 0,
      hasReturns: Boolean(record?.jsDoc?.returns),
      examples: record?.jsDoc?.examples?.length || 0,
    };

    if (hasComment || hasJsDoc) found++;
  }

  return {
    functionsAnalyzed: Object.keys(commentMap || {}).length,
    functionsWithComments: found,
    perFunction,
  };
}