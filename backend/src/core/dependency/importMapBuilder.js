import traverseModule from "@babel/traverse";
import { parseSource } from "../parser/parseFile.js";

const traverse = traverseModule.default;

/**
 * Normalize Node.js built-in module names.
 *
 * Examples:
 * node:fs           -> fs
 * node:path         -> path
 * node:fs/promises  -> fs/promises
 */
export function normalizeModuleName(moduleName) {
  return String(moduleName || "").replace(/^node:/, "");
}

function getPropertyName(node) {
  if (!node) return null;

  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "NumericLiteral") return String(node.value);
  if (node.type === "PrivateName" && node.id?.name) return node.id.name;

  return null;
}

function createImportInfo({
  localName,
  moduleName,
  importKind,
  importedName,
  sourceType,
  accessPath = [],
}) {
  const normalizedModuleName = normalizeModuleName(moduleName);

  return {
    localName,
    moduleName,
    normalizedModuleName,
    importKind,
    importedName,
    sourceType,
    accessPath,
  };
}

function safeAddImport(importMap, info) {
  if (!info?.localName || !info?.moduleName) return;

  importMap[info.localName] = info;
}

function isRequireCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments?.length === 1 &&
    node.arguments[0]?.type === "StringLiteral"
  );
}

function isDynamicImportCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "Import" &&
    node.arguments?.length === 1 &&
    node.arguments[0]?.type === "StringLiteral"
  );
}

function unwrapAwaitExpression(node) {
  if (node?.type === "AwaitExpression") return node.argument;
  return node;
}

/**
 * Extract module information from:
 *   require("fs")
 *   require("fs").promises
 *   require("fs").promises.readFile
 *   await import("fs")
 *   (await import("fs")).promises
 */
function extractModuleAccess(node) {
  const unwrapped = unwrapAwaitExpression(node);

  if (isRequireCall(unwrapped)) {
    return {
      moduleName: unwrapped.arguments[0].value,
      sourceType: "cjs",
      accessPath: [],
    };
  }

  if (isDynamicImportCall(unwrapped)) {
    return {
      moduleName: unwrapped.arguments[0].value,
      sourceType: "dynamic-import",
      accessPath: [],
    };
  }

  if (unwrapped?.type === "MemberExpression") {
    const base = extractModuleAccess(unwrapped.object);
    if (!base) return null;

    const propName = getPropertyName(unwrapped.property);
    if (!propName) return base;

    return {
      ...base,
      accessPath: [...base.accessPath, propName],
    };
  }

  return null;
}

function getImportKindForSource(sourceType, baseKind) {
  if (sourceType === "dynamic-import") {
    if (baseKind === "require") return "dynamic-import";
    if (baseKind === "destructured-require") return "destructured-dynamic-import";
    if (baseKind === "require-member") return "dynamic-import-member";
  }

  return baseKind;
}

function addIdentifierBinding({
  importMap,
  id,
  moduleName,
  sourceType,
  importKind,
  importedName,
  accessPath = [],
}) {
  if (id?.type !== "Identifier") return;

  safeAddImport(
    importMap,
    createImportInfo({
      localName: id.name,
      moduleName,
      importKind: getImportKindForSource(sourceType, importKind),
      importedName,
      sourceType,
      accessPath,
    })
  );
}

function addObjectPatternBindings({
  importMap,
  pattern,
  moduleName,
  sourceType,
  importKind = "destructured-require",
  accessPathPrefix = [],
}) {
  if (pattern?.type !== "ObjectPattern") return;

  for (const prop of pattern.properties || []) {
    if (!prop) continue;

    if (prop.type === "ObjectProperty") {
      const keyName = getPropertyName(prop.key);
      if (!keyName) continue;

      const accessPath = [...accessPathPrefix, keyName];
      const importedName = accessPath.join(".");

      if (prop.value?.type === "Identifier") {
        addIdentifierBinding({
          importMap,
          id: prop.value,
          moduleName,
          sourceType,
          importKind,
          importedName,
          accessPath,
        });
        continue;
      }

      if (
        prop.value?.type === "AssignmentPattern" &&
        prop.value.left?.type === "Identifier"
      ) {
        addIdentifierBinding({
          importMap,
          id: prop.value.left,
          moduleName,
          sourceType,
          importKind,
          importedName,
          accessPath,
        });
        continue;
      }

      if (prop.value?.type === "ObjectPattern") {
        addObjectPatternBindings({
          importMap,
          pattern: prop.value,
          moduleName,
          sourceType,
          importKind,
          accessPathPrefix: accessPath,
        });
        continue;
      }

      continue;
    }

    if (prop.type === "RestElement" && prop.argument?.type === "Identifier") {
      addIdentifierBinding({
        importMap,
        id: prop.argument,
        moduleName,
        sourceType,
        importKind: "destructured-rest",
        importedName: "*",
        accessPath: accessPathPrefix,
      });
    }
  }
}

/**
 * Builds a rich import map.
 *
 * Output shape:
 *
 * {
 *   axios: {
 *     localName: "axios",
 *     moduleName: "axios",
 *     normalizedModuleName: "axios",
 *     importKind: "default",
 *     importedName: "default",
 *     sourceType: "esm",
 *     accessPath: []
 *   },
 *   read: {
 *     localName: "read",
 *     moduleName: "fs",
 *     normalizedModuleName: "fs",
 *     importKind: "destructured-require",
 *     importedName: "readFileSync",
 *     sourceType: "cjs",
 *     accessPath: ["readFileSync"]
 *   }
 * }
 */
export function buildImportMap(code) {
  const importMap = {};

  let ast;
  try {
    ast = parseSource(code);
  } catch {
    return importMap;
  }

  traverse(ast, {
    ImportDeclaration(path) {
      const moduleName = path.node.source?.value;
      if (!moduleName) return;

      if (path.node.importKind === "type") return;

      for (const spec of path.node.specifiers || []) {
        if (!spec?.local?.name) continue;
        if (spec.importKind === "type") continue;

        if (spec.type === "ImportDefaultSpecifier") {
          safeAddImport(
            importMap,
            createImportInfo({
              localName: spec.local.name,
              moduleName,
              importKind: "default",
              importedName: "default",
              sourceType: "esm",
              accessPath: [],
            })
          );
          continue;
        }

        if (spec.type === "ImportSpecifier") {
          const importedName = getPropertyName(spec.imported) || spec.local.name;

          safeAddImport(
            importMap,
            createImportInfo({
              localName: spec.local.name,
              moduleName,
              importKind: "named",
              importedName,
              sourceType: "esm",
              accessPath: [importedName],
            })
          );
          continue;
        }

        if (spec.type === "ImportNamespaceSpecifier") {
          safeAddImport(
            importMap,
            createImportInfo({
              localName: spec.local.name,
              moduleName,
              importKind: "namespace",
              importedName: "*",
              sourceType: "esm",
              accessPath: [],
            })
          );
        }
      }
    },

    VariableDeclarator(path) {
      const id = path.node.id;
      const init = path.node.init;
      const moduleAccess = extractModuleAccess(init);

      if (!moduleAccess?.moduleName) return;

      const { moduleName, sourceType, accessPath } = moduleAccess;

      if (id?.type === "Identifier") {
        const isDirectModuleImport = accessPath.length === 0;

        addIdentifierBinding({
          importMap,
          id,
          moduleName,
          sourceType,
          importKind: isDirectModuleImport ? "require" : "require-member",
          importedName: isDirectModuleImport ? "*" : accessPath.join("."),
          accessPath,
        });

        return;
      }

      if (id?.type === "ObjectPattern") {
        addObjectPatternBindings({
          importMap,
          pattern: id,
          moduleName,
          sourceType,
          importKind: "destructured-require",
          accessPathPrefix: accessPath,
        });
      }
    },
  });

  return importMap;
}