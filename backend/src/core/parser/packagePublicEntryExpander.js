// src/core/parser/packagePublicEntryExpander.js

import fs from "fs";
import path from "path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default;

function normalizePath(filePath = "") {
  return String(filePath || "").replace(/\\/g, "/");
}

function isJsLikeFile(filePath = "") {
  return /\.(js|cjs|mjs)$/i.test(filePath);
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function parseModule(code) {
  return parse(String(code || ""), {
    sourceType: "module",
    plugins: [
      "dynamicImport",
      "importMeta",
      "topLevelAwait",
      "classProperties",
      "objectRestSpread",
      "optionalChaining",
      "nullishCoalescingOperator",
    ],
  });
}

/* ======================================================
   UNSAFE / NON-PUBLIC FILE FILTER
====================================================== */

export function isUnsafePublicExpansionFile(filePathAbs = "") {
  const lower = normalizePath(filePathAbs).toLowerCase();
  const base = path.basename(lower);

  const unsafePathParts = [
    "/test/",
    "/tests/",
    "/__tests__/",
    "/spec/",
    "/__mocks__/",
    "/server/",
    "/demo/",
    "/demos/",
    "/example/",
    "/examples/",
    "/benchmark/",
    "/bench/",
    "/coverage/",
    "/tap-snapshots/",
    "/fixtures/",
    "/fixture/",
  ];

  if (unsafePathParts.some((part) => lower.includes(part))) {
    return true;
  }

  const unsafeBaseNames = new Set([
    "test.js",
    "tests.js",
    "spec.js",
    "testem.js",
    "karma.conf.js",
    "webpack.config.js",
    "rollup.config.js",
    "babel.config.js",
    "ember-cli-build.js",
    "gulpfile.js",
    "gruntfile.js",
  ]);

  if (unsafeBaseNames.has(base)) return true;

  if (base.startsWith("-")) return true;

  if (
    base.includes("internal") ||
    base.includes("rethrow") ||
    base.includes("instrument")
  ) {
    return true;
  }

  return false;
}

/* ======================================================
   LOCAL MODULE RESOLUTION
====================================================== */

function resolveLocalModule(fromFileAbs, sourceValue) {
  if (!sourceValue || typeof sourceValue !== "string") return null;
  if (!sourceValue.startsWith(".")) return null;

  const fromDir = path.dirname(fromFileAbs);
  const raw = path.resolve(fromDir, sourceValue);

  const candidates = [
    raw,
    `${raw}.js`,
    `${raw}.cjs`,
    `${raw}.mjs`,
    path.join(raw, "index.js"),
    path.join(raw, "index.cjs"),
    path.join(raw, "index.mjs"),
  ];

  for (const candidate of candidates) {
    if (fileExists(candidate) && isJsLikeFile(candidate)) {
      return path.resolve(candidate);
    }
  }

  return null;
}

/* ======================================================
   ENTRY PUBLIC EXPORT ANALYSIS
====================================================== */

function collectImportedBindings(ast) {
  const imported = new Map();

  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source?.value;
      if (!source || !source.startsWith(".")) return;

      for (const spec of path.node.specifiers || []) {
        if (spec.local?.name) {
          imported.set(spec.local.name, source);
        }
      }
    },
  });

  return imported;
}

function collectCommonJsRequiredBindings(ast) {
  const required = new Map();

  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      const init = path.node.init;

      if (
        !init ||
        init.type !== "CallExpression" ||
        init.callee?.type !== "Identifier" ||
        init.callee.name !== "require"
      ) {
        return;
      }

      const arg = init.arguments?.[0];
      if (arg?.type !== "StringLiteral") return;
      if (!arg.value.startsWith(".")) return;

      if (id?.type === "Identifier") {
        required.set(id.name, arg.value);
      }

      if (id?.type === "ObjectPattern") {
        for (const prop of id.properties || []) {
          const localName =
            prop?.value?.type === "Identifier" ? prop.value.name : null;

          if (localName) {
            required.set(localName, arg.value);
          }
        }
      }
    },
  });

  return required;
}

function collectPubliclyExportedLocalNames(ast) {
  const exported = new Set();
  const directExportSources = new Set();

  traverse(ast, {
    ExportNamedDeclaration(path) {
      const source = path.node.source?.value;

      if (source && source.startsWith(".")) {
        directExportSources.add(source);
        return;
      }

      for (const spec of path.node.specifiers || []) {
        if (spec.local?.name) exported.add(spec.local.name);
        if (spec.exported?.name) exported.add(spec.exported.name);
      }

      const decl = path.node.declaration;
      if (decl?.id?.name) exported.add(decl.id.name);

      if (decl?.declarations) {
        for (const d of decl.declarations) {
          if (d.id?.type === "Identifier") {
            exported.add(d.id.name);
          }
        }
      }
    },

    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      if (decl?.type === "Identifier") {
        exported.add(decl.name);
      }
    },

    ExportAllDeclaration(path) {
      const source = path.node.source?.value;
      if (source && source.startsWith(".")) {
        directExportSources.add(source);
      }
    },

    AssignmentExpression(path) {
      const left = path.node.left;
      const right = path.node.right;

      const isModuleExports =
        left?.type === "MemberExpression" &&
        left.object?.type === "Identifier" &&
        left.object.name === "module" &&
        left.property?.type === "Identifier" &&
        left.property.name === "exports" &&
        !path.scope.getBinding("module");

      const isExportsMember =
        left?.type === "MemberExpression" &&
        left.object?.type === "Identifier" &&
        left.object.name === "exports" &&
        !path.scope.getBinding("exports");

      if (isModuleExports && right?.type === "Identifier") {
        exported.add(right.name);
      }

      if (isExportsMember && right?.type === "Identifier") {
        exported.add(right.name);
      }

      if (
        isModuleExports &&
        right?.type === "ObjectExpression"
      ) {
        for (const prop of right.properties || []) {
          if (prop?.value?.type === "Identifier") {
            exported.add(prop.value.name);
          }

          if (prop?.key?.type === "Identifier") {
            exported.add(prop.key.name);
          }
        }
      }
    },
  });

  return { exported, directExportSources };
}

function collectCandidatePublicSources(ast) {
  const imported = collectImportedBindings(ast);
  const required = collectCommonJsRequiredBindings(ast);
  const { exported, directExportSources } = collectPubliclyExportedLocalNames(ast);

  const sources = new Set();

  for (const source of directExportSources) {
    sources.add(source);
  }

  for (const name of exported) {
    if (imported.has(name)) {
      sources.add(imported.get(name));
    }

    if (required.has(name)) {
      sources.add(required.get(name));
    }
  }

  return Array.from(sources);
}

/* ======================================================
   MAIN API
====================================================== */

export function getPublicEntryExpansionFiles({
  projectRoot,
  entryFiles = [],
  maxFiles = Number(process.env.UNITGEN_PUBLIC_EXPANSION_MAX_FILES || 40),
} = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const entries = Array.isArray(entryFiles) ? entryFiles : [];

  const found = [];
  const seen = new Set();

  for (const entry of entries) {
    const entryAbs = path.resolve(entry || "");
    if (!fileExists(entryAbs)) continue;

    let ast;

    try {
      const code = fs.readFileSync(entryAbs, "utf8");
      ast = parseModule(code);
    } catch {
      continue;
    }

    const candidateSources = collectCandidatePublicSources(ast);

    for (const source of candidateSources) {
      const resolved = resolveLocalModule(entryAbs, source);
      if (!resolved) continue;

      const normalizedResolved = path.resolve(resolved);

      if (!normalizedResolved.startsWith(root)) continue;
      if (normalizedResolved === entryAbs) continue;
      if (seen.has(normalizedResolved)) continue;
      if (isUnsafePublicExpansionFile(normalizedResolved)) continue;

      seen.add(normalizedResolved);
      found.push(normalizedResolved);

      if (found.length >= maxFiles) {
        return found;
      }
    }
  }

  return found;
}

export default getPublicEntryExpansionFiles;
