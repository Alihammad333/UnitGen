import fs from "fs";
import path from "path";

/**
 * usageSnippetMiner.js
 *
 * Purpose:
 * Mines real usage examples from README/docs/examples/tests so UnitGen can give
 * the LLM better context before generating candidate tests.
 *
 * This is inspired by TestPilot's snippet mining idea, but designed for UnitGen:
 * - safe read-only scanning
 * - no code execution
 * - no pipeline-breaking errors
 * - function-wise snippet mapping
 * - compact snippets suitable for prompt injection later
 *
 * This file is NOT connected yet.
 * Later, index.js can call mineUsageSnippetsForFunctions(...) and pass results
 * into llmContexts, then promptBuilder.js can include them in the prompt.
 */

const DEFAULT_MAX_FILES = 120;
const DEFAULT_MAX_FILE_SIZE_BYTES = 350_000;
const DEFAULT_MAX_SNIPPETS_PER_FUNCTION = 5;
const DEFAULT_MAX_SNIPPET_CHARS = 900;

const DEFAULT_SCAN_DIRS = [
  "",
  "docs",
  "doc",
  "examples",
  "example",
  "demo",
  "demos",
  "samples",
  "sample",
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
];

const ALLOWED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
]);

const PRIORITY_FILE_NAMES = [
  "readme.md",
  "readme.markdown",
  "usage.md",
  "getting-started.md",
  "examples.md",
  "example.md",
  "api.md",
  "index.js",
  "index.mjs",
  "example.js",
  "examples.js",
];

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".github",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "vendor",
  "tmp",
  "temp",
]);

function safeString(value) {
  return String(value || "");
}

function normalizePathForDisplay(filePath) {
  return safeString(filePath).split(path.sep).join(path.posix.sep);
}

function isAllowedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

function isMarkdownFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".md" || ext === ".markdown" || ext === ".mdx";
}

function safeReadFile(filePath, maxBytes = DEFAULT_MAX_FILE_SIZE_BYTES) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) return null;

    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function shouldSkipDir(dirName) {
  return IGNORED_DIR_NAMES.has(String(dirName || "").toLowerCase());
}

function uniqueArray(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeFunctionNames(fnNames = []) {
  return uniqueArray(
    (Array.isArray(fnNames) ? fnNames : [])
      .map((x) => String(x || "").trim())
      .filter((x) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(x))
  );
}

function scoreFile(filePath) {
  const normalized = normalizePathForDisplay(filePath).toLowerCase();
  const base = path.basename(normalized);

  let score = 0;

  const priorityIndex = PRIORITY_FILE_NAMES.indexOf(base);
  if (priorityIndex !== -1) {
    score += 100 - priorityIndex;
  }

  if (normalized.includes("/examples/") || normalized.includes("/example/")) {
    score += 60;
  }

  if (normalized.includes("/demo/") || normalized.includes("/demos/")) {
    score += 45;
  }

  if (normalized.includes("/docs/") || normalized.includes("/doc/")) {
    score += 40;
  }

  if (normalized.includes("/test/") || normalized.includes("/tests/")) {
    score += 25;
  }

  if (base.includes("readme")) score += 80;
  if (base.includes("usage")) score += 60;
  if (base.includes("api")) score += 40;

  if (isMarkdownFile(filePath)) score += 20;

  return score;
}

function walkFiles(rootDir, options = {}) {
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  const scanDirs = options.scanDirs || DEFAULT_SCAN_DIRS;

  const root = path.resolve(rootDir || ".");
  const found = [];
  const seen = new Set();

  function addFile(filePath) {
    const abs = path.resolve(filePath);
    if (seen.has(abs)) return;
    if (!isAllowedFile(abs)) return;

    seen.add(abs);
    found.push(abs);
  }

  function walk(currentDir) {
    if (found.length >= maxFiles) return;

    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= maxFiles) break;

      const full = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        walk(full);
        continue;
      }

      if (entry.isFile()) {
        addFile(full);
      }
    }
  }

  for (const rel of scanDirs) {
    if (found.length >= maxFiles) break;

    const target = path.resolve(root, rel);

    try {
      if (!fs.existsSync(target)) continue;

      const stat = fs.statSync(target);

      if (stat.isFile()) {
        addFile(target);
        continue;
      }

      if (stat.isDirectory()) {
        walk(target);
      }
    } catch {
      // Keep miner non-breaking.
    }
  }

  return found
    .sort((a, b) => scoreFile(b) - scoreFile(a))
    .slice(0, maxFiles);
}

function extractMarkdownCodeBlocks(markdown) {
  const blocks = [];
  const text = safeString(markdown);

  const fenceRegex = /```([A-Za-z0-9_-]*)\s*\n([\s\S]*?)```/g;
  let match;

  while ((match = fenceRegex.exec(text))) {
    const lang = safeString(match[1]).toLowerCase();
    const code = safeString(match[2]).trim();

    if (!code) continue;

    const isCodeLike =
      !lang ||
      [
        "js",
        "javascript",
        "node",
        "nodejs",
        "mjs",
        "cjs",
        "ts",
        "typescript",
        "jsx",
        "tsx",
        "bash",
        "sh",
      ].includes(lang);

    if (isCodeLike) {
      blocks.push({
        kind: "code-fence",
        language: lang || "unknown",
        code,
      });
    }
  }

  return blocks;
}

function extractMarkdownNearbyLines(markdown) {
  const lines = safeString(markdown).split(/\r?\n/);
  const chunks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line || !/[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(line)) continue;

    const start = Math.max(0, i - 2);
    const end = Math.min(lines.length, i + 3);

    const snippet = lines.slice(start, end).join("\n").trim();
    if (snippet) {
      chunks.push({
        kind: "markdown-nearby-lines",
        language: "markdown",
        code: snippet,
      });
    }
  }

  return chunks;
}

function splitCodeIntoCandidateBlocks(code) {
  const text = safeString(code);
  const lines = text.split(/\r?\n/);
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!/[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(line)) continue;

    const start = Math.max(0, i - 4);
    const end = Math.min(lines.length, i + 8);

    const snippet = lines.slice(start, end).join("\n").trim();

    if (snippet) {
      blocks.push({
        kind: "code-nearby-lines",
        language: "javascript",
        code: snippet,
      });
    }
  }

  return blocks;
}

function extractCandidateBlocks(filePath, content) {
  if (isMarkdownFile(filePath)) {
    return [
      ...extractMarkdownCodeBlocks(content),
      ...extractMarkdownNearbyLines(content),
    ];
  }

  return splitCodeIntoCandidateBlocks(content);
}

function buildFunctionCallRegex(fnName) {
  const escaped = String(fnName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /*
   * Matches:
   *   getCountry(...)
   *   pkg.getCountry(...)
   *   module.getCountry(...)
   *   await getCountry(...)
   *
   * Avoids matching function declarations as strongly as possible later using
   * filters.
   */
  return new RegExp(`(?:\\b|\\.)${escaped}\\s*\\(`, "m");
}

function looksLikeDefinitionOnly(snippet, fnName) {
  const escaped = String(fnName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const s = safeString(snippet);

  const definitionPatterns = [
    new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`),
    new RegExp(`\\bconst\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\(`),
    new RegExp(`\\blet\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\(`),
    new RegExp(`\\bvar\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\(`),
    new RegExp(`\\bexport\\s+function\\s+${escaped}\\s*\\(`),
    new RegExp(`\\b${escaped}\\s*:\\s*(?:async\\s*)?function\\s*\\(`),
  ];

  if (!definitionPatterns.some((re) => re.test(s))) return false;

  /*
   * If it also contains another call to the function later, keep it.
   */
  const callCount = (s.match(buildFunctionCallRegex(fnName)) || []).length;
  return callCount <= 1;
}

function cleanSnippet(code, maxChars = DEFAULT_MAX_SNIPPET_CHARS) {
  let s = safeString(code)
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .trim();

  const lines = s
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line, index, arr) => {
      if (index === 0 || index === arr.length - 1) return line.trim().length > 0;
      return true;
    });

  s = lines.join("\n").trim();

  if (s.length > maxChars) {
    s = `${s.slice(0, maxChars).trim()}\n// ...truncated`;
  }

  return s;
}

function scoreSnippet({ snippet, fnName, sourcePath }) {
  const code = safeString(snippet);
  const lower = code.toLowerCase();
  const displayPath = normalizePathForDisplay(sourcePath).toLowerCase();

  let score = 0;

  const callMatches = code.match(buildFunctionCallRegex(fnName)) || [];
  score += callMatches.length * 30;

  if (/\bawait\b/.test(code)) score += 10;
  if (/\bexpect\s*\(/.test(code)) score += 20;
  if (/\bconsole\.log\s*\(/.test(code)) score += 5;
  if (/\bconst\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=/.test(code)) score += 8;

  if (lower.includes("example")) score += 8;
  if (lower.includes("usage")) score += 8;

  if (displayPath.includes("readme")) score += 25;
  if (displayPath.includes("example")) score += 30;
  if (displayPath.includes("demo")) score += 20;
  if (displayPath.includes("test") || displayPath.includes("spec")) score += 15;

  /*
   * Penalize too much unrelated complexity.
   */
  if (code.length > 700) score -= 10;
  if ((code.match(/\bimport\b/g) || []).length > 3) score -= 10;
  if ((code.match(/\brequire\s*\(/g) || []).length > 3) score -= 10;

  return score;
}

function findFunctionSnippetsInBlocks({
  fnName,
  blocks,
  sourcePath,
  projectRoot,
  maxSnippetChars,
}) {
  const callRegex = buildFunctionCallRegex(fnName);
  const out = [];

  for (const block of blocks) {
    const code = cleanSnippet(block.code, maxSnippetChars);

    if (!code) continue;
    if (!callRegex.test(code)) continue;
    if (looksLikeDefinitionOnly(code, fnName)) continue;

    const relativePath = normalizePathForDisplay(
      path.relative(projectRoot, sourcePath) || sourcePath
    );

    out.push({
      fnName,
      sourcePath,
      relativePath,
      kind: block.kind || "unknown",
      language: block.language || "unknown",
      snippet: code,
      score: scoreSnippet({
        snippet: code,
        fnName,
        sourcePath,
      }),
    });
  }

  return out;
}

function dedupeSnippets(snippets = []) {
  const seen = new Set();
  const out = [];

  for (const item of snippets) {
    const key = `${item.fnName}::${item.relativePath}::${item.snippet}`;

    if (seen.has(key)) continue;

    seen.add(key);
    out.push(item);
  }

  return out;
}

function createEmptySnippetMap(fnNames) {
  const map = {};

  for (const fnName of fnNames) {
    map[fnName] = [];
  }

  return map;
}

/**
 * Main API.
 *
 * Usage later from index.js:
 *
 * const usageSnippets = mineUsageSnippetsForFunctions({
 *   projectRoot: input.root,
 *   fnNames: functions.map((f) => f.name),
 * });
 *
 * Then attach:
 * ctx.usageSnippets = usageSnippets[fnName] || [];
 */
export function mineUsageSnippetsForFunctions({
  projectRoot,
  fnNames = [],
  maxFiles = DEFAULT_MAX_FILES,
  maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES,
  maxSnippetsPerFunction = DEFAULT_MAX_SNIPPETS_PER_FUNCTION,
  maxSnippetChars = DEFAULT_MAX_SNIPPET_CHARS,
  scanDirs = DEFAULT_SCAN_DIRS,
} = {}) {
  const root = path.resolve(projectRoot || ".");
  const names = normalizeFunctionNames(fnNames);
  const snippetsByFunction = createEmptySnippetMap(names);

  if (!names.length) {
    return {
      snippetsByFunction,
      filesScanned: 0,
      snippetsFound: 0,
      root,
    };
  }

  let files = [];

  try {
    files = walkFiles(root, {
      maxFiles,
      scanDirs,
    });
  } catch {
    files = [];
  }

  for (const filePath of files) {
    const content = safeReadFile(filePath, maxFileSizeBytes);
    if (!content) continue;

    const blocks = extractCandidateBlocks(filePath, content);
    if (!blocks.length) continue;

    for (const fnName of names) {
      const matches = findFunctionSnippetsInBlocks({
        fnName,
        blocks,
        sourcePath: filePath,
        projectRoot: root,
        maxSnippetChars,
      });

      if (matches.length > 0) {
        snippetsByFunction[fnName].push(...matches);
      }
    }
  }

  let total = 0;

  for (const fnName of names) {
    const clean = dedupeSnippets(snippetsByFunction[fnName])
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSnippetsPerFunction);

    snippetsByFunction[fnName] = clean;
    total += clean.length;
  }

  return {
    snippetsByFunction,
    filesScanned: files.length,
    snippetsFound: total,
    root,
  };
}

/**
 * Formats snippets for promptBuilder.js.
 *
 * Keep this compact. The LLM should receive useful examples, not huge docs.
 */
export function formatUsageSnippetsForPrompt(snippets = [], maxSnippets = 3) {
  const list = Array.isArray(snippets) ? snippets.slice(0, maxSnippets) : [];

  if (!list.length) {
    return "No usage snippets were found for this function.";
  }

  return list
    .map((item, index) => {
      const source = item.relativePath || "unknown source";
      const snippet = cleanSnippet(item.snippet, DEFAULT_MAX_SNIPPET_CHARS);

      return [
        `Snippet ${index + 1} from ${source}:`,
        "```js",
        snippet,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * Lightweight helper for logging.
 */
export function summarizeUsageSnippetMining(result = {}) {
  const snippetsByFunction = result.snippetsByFunction || {};
  const perFunction = {};

  for (const [fnName, snippets] of Object.entries(snippetsByFunction)) {
    perFunction[fnName] = Array.isArray(snippets) ? snippets.length : 0;
  }

  return {
    filesScanned: result.filesScanned || 0,
    snippetsFound: result.snippetsFound || 0,
    perFunction,
  };
}