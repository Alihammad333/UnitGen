// src/functionExtractor.js
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default;

function getFunctionName(node, fallback = "anonymous") {
  if (!node) return fallback;
  if (node.id?.name) return node.id.name;
  return fallback;
}

function getParams(node) {
  return (node.params || []).map((param, index) => {
    if (param.type === "Identifier") return param.name;

    if (
      param.type === "AssignmentPattern" &&
      param.left?.type === "Identifier"
    ) {
      return param.left.name;
    }

    if (
      param.type === "AssignmentPattern" &&
      param.left?.type === "ObjectPattern"
    ) {
      return "options";
    }

    if (param.type === "ObjectPattern") {
      return "options";
    }

    if (
      param.type === "RestElement" &&
      param.argument?.type === "Identifier"
    ) {
      return param.argument.name;
    }

    return `arg${index + 1}`;
  });
}

function getConstructorParams(classNode) {
  for (const member of classNode.body?.body || []) {
    if (member.kind === "constructor") {
      return getParams(member);
    }
  }

  return [];
}

const PROMISE_STATIC_METHODS = new Set([
  "resolve",
  "reject",
  "all",
  "allSettled",
  "any",
  "race",
]);

function nodeContainsPromiseSemantics(node, seen = new Set()) {
  if (!node || typeof node !== "object") return false;
  if (seen.has(node)) return false;
  seen.add(node);

  if (node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Promise") {
    return true;
  }

  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "Promise"
  ) {
    const propertyName = node.callee.computed
      ? node.callee.property?.value
      : node.callee.property?.name;
    if (PROMISE_STATIC_METHODS.has(propertyName)) return true;
  }

  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments"].includes(key)) continue;
    if (Array.isArray(value)) {
      if (value.some((child) => nodeContainsPromiseSemantics(child, seen))) return true;
    } else if (value && typeof value === "object") {
      if (nodeContainsPromiseSemantics(value, seen)) return true;
    }
  }

  return false;
}

function isAsyncFunction(node) {
  return Boolean(node?.async || nodeContainsPromiseSemantics(node));
}

function looksLikeClassName(name) {
  return /^[A-Z][A-Za-z0-9_]*$/.test(String(name || ""));
}

function buildFunctionRecord({
  name,
  params,
  code,
  isAsync = false,
  isExported = false,
  isDefault = false,
  isClassLike = false,
}) {
  return {
    name,
    params,
    code,
    isAsync,
    isExported,
    isDefault,
    isClassLike,
  };
}

function normalizeAstRoot(inputAst) {
  if (!inputAst) {
    throw new Error("extractFunctions received empty AST input.");
  }

  if (inputAst.type === "File" || inputAst.type === "Program") {
    return inputAst;
  }

  if (inputAst.ast) {
    if (inputAst.ast.type === "File" || inputAst.ast.type === "Program") {
      return inputAst.ast;
    }
  }

  if (inputAst.program && inputAst.program.type === "Program") {
    return inputAst.program;
  }

  throw new Error(
    `Unsupported AST root received by extractFunctions. Keys: ${Object.keys(
      inputAst
    ).join(", ")}`
  );
}

function isModuleExports(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "Identifier" &&
    node.object.name === "module" &&
    node.property?.type === "Identifier" &&
    node.property.name === "exports"
  );
}

function isExportsMember(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "Identifier" &&
    node.object.name === "exports" &&
    node.property?.type === "Identifier"
  );
}

function isModuleExportsMember(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    isModuleExports(node.object) &&
    node.property?.type === "Identifier"
  );
}

function collectNamesFromObjectExpression(
  objExpr,
  exportedNames,
  defaultExportNames
) {
  if (!objExpr || objExpr.type !== "ObjectExpression") return;

  for (const prop of objExpr.properties || []) {
    if (prop.type !== "ObjectProperty") continue;

    const key =
      prop.key?.type === "Identifier"
        ? prop.key.name
        : prop.key?.type === "StringLiteral"
        ? prop.key.value
        : null;

    if (!key) continue;

    if (key === "default") {
      if (prop.value?.type === "Identifier") {
        exportedNames.add(prop.value.name);
        defaultExportNames.add(prop.value.name);
      }
      continue;
    }

    if (prop.value?.type === "Identifier") {
      exportedNames.add(prop.value.name);
    } else {
      exportedNames.add(key);
    }
  }
}

export function extractFunctions(astInput, sourceCode) {
  const ast = normalizeAstRoot(astInput);

  const functions = [];
  const exportedNames = new Set();
  const defaultExportNames = new Set();
  const exportedDeclarationNodes = new Set();

  // PASS 1: collect all export information first
  traverse(ast, {
    ExportNamedDeclaration(path) {
      const decl = path.node.declaration;

      if (decl) {
        exportedDeclarationNodes.add(decl);

        if (
          (decl.type === "FunctionDeclaration" ||
            decl.type === "ClassDeclaration") &&
          decl.id?.name
        ) {
          exportedNames.add(decl.id.name);
        }

        if (decl.type === "VariableDeclaration") {
          for (const d of decl.declarations || []) {
            if (d.id?.type === "Identifier") {
              exportedNames.add(d.id.name);
            }
          }
        }
      }

      for (const spec of path.node.specifiers || []) {
        if (spec.local?.name) {
          exportedNames.add(spec.local.name);
        }
      }
    },

    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      if (!decl) return;

      exportedDeclarationNodes.add(decl);

      if (decl.type === "FunctionDeclaration") {
        if (decl.id?.name) {
          exportedNames.add(decl.id.name);
          defaultExportNames.add(decl.id.name);
        } else {
          const code = sourceCode.slice(decl.start, decl.end);
          functions.push(
            buildFunctionRecord({
              name: "defaultExport",
              params: getParams(decl),
              code,
              isAsync: isAsyncFunction(decl),
              isExported: true,
              isDefault: true,
              isClassLike: false,
            })
          );
        }
      } else if (decl.type === "ClassDeclaration") {
        if (decl.id?.name) {
          exportedNames.add(decl.id.name);
          defaultExportNames.add(decl.id.name);
        } else {
          const code = sourceCode.slice(decl.start, decl.end);
          functions.push(
            buildFunctionRecord({
              name: "defaultExport",
              params: getConstructorParams(decl),
              code,
              isAsync: false,
              isExported: true,
              isDefault: true,
              isClassLike: true,
            })
          );
        }
      } else if (decl.type === "Identifier") {
        exportedNames.add(decl.name);
        defaultExportNames.add(decl.name);
      }
    },

    AssignmentExpression(path) {
      const left = path.node.left;
      const right = path.node.right;
      // In bundled output, dependency wrappers commonly declare local
      // parameters named `exports` or `module`. Assignments through those
      // bindings are private to the embedded module, not exports of the file
      // currently being analyzed.
      const hasLocalExportsBinding = Boolean(path.scope.getBinding("exports"));
      const hasLocalModuleBinding = Boolean(path.scope.getBinding("module"));

      if (isExportsMember(left) && !hasLocalExportsBinding) {
        const exportedKey = left.property.name;
        if (right?.type === "Identifier") {
          exportedNames.add(right.name);
          if (exportedKey === "default") {
            defaultExportNames.add(right.name);
          }
        } else if (
          right?.type === "FunctionExpression" ||
          right?.type === "ArrowFunctionExpression"
        ) {
          const name = right.id?.name || exportedKey;
          const code = sourceCode.slice(right.start, right.end);
          exportedNames.add(name);
          functions.push(
            buildFunctionRecord({
              name,
              params: getParams(right),
              code,
              isAsync: isAsyncFunction(right),
              isExported: true,
              isDefault: exportedKey === "default",
              isClassLike: false,
            })
          );
        } else if (right?.type === "ClassExpression") {
          const name = right.id?.name || exportedKey;
          const code = sourceCode.slice(right.start, right.end);
          exportedNames.add(name);
          functions.push(
            buildFunctionRecord({
              name,
              params: getConstructorParams(right),
              code,
              isAsync: false,
              isExported: true,
              isDefault: exportedKey === "default",
              isClassLike: true,
            })
          );
        } else {
          exportedNames.add(exportedKey);
        }
        return;
      }

      if (isModuleExportsMember(left) && !hasLocalModuleBinding) {
        const exportedKey = left.property.name;
        if (right?.type === "Identifier") {
          exportedNames.add(right.name);
          if (exportedKey === "default") {
            defaultExportNames.add(right.name);
          }
        } else if (
          right?.type === "FunctionExpression" ||
          right?.type === "ArrowFunctionExpression"
        ) {
          const name = right.id?.name || exportedKey;
          const code = sourceCode.slice(right.start, right.end);
          exportedNames.add(name);
          functions.push(
            buildFunctionRecord({
              name,
              params: getParams(right),
              code,
              isAsync: isAsyncFunction(right),
              isExported: true,
              isDefault: exportedKey === "default",
              isClassLike: false,
            })
          );
        } else if (right?.type === "ClassExpression") {
          const name = right.id?.name || exportedKey;
          const code = sourceCode.slice(right.start, right.end);
          exportedNames.add(name);
          functions.push(
            buildFunctionRecord({
              name,
              params: getConstructorParams(right),
              code,
              isAsync: false,
              isExported: true,
              isDefault: exportedKey === "default",
              isClassLike: true,
            })
          );
        } else {
          exportedNames.add(exportedKey);
        }
        return;
      }

      if (isModuleExports(left) && !hasLocalModuleBinding) {
        if (right?.type === "Identifier") {
          exportedNames.add(right.name);
          defaultExportNames.add(right.name);
          return;
        }

        if (right?.type === "ObjectExpression") {
          collectNamesFromObjectExpression(
            right,
            exportedNames,
            defaultExportNames
          );
          return;
        }

        if (
          right?.type === "FunctionExpression" ||
          right?.type === "ArrowFunctionExpression"
        ) {
          const code = sourceCode.slice(right.start, right.end);
          functions.push(
            buildFunctionRecord({
              name: "defaultExport",
              params: getParams(right),
              code,
              isAsync: isAsyncFunction(right),
              isExported: true,
              isDefault: true,
              isClassLike: false,
            })
          );
        }

        if (right?.type === "ClassExpression") {
          const code = sourceCode.slice(right.start, right.end);
          functions.push(
            buildFunctionRecord({
              name: right.id?.name || "defaultExport",
              params: getConstructorParams(right),
              code,
              isAsync: false,
              isExported: true,
              isDefault: true,
              isClassLike: true,
            })
          );
        }
      }
    },
  });

  // PASS 2: collect functions/classes after exports are known
  traverse(ast, {
    FunctionDeclaration(path) {
      const node = path.node;
      const name = getFunctionName(node);
      const code = sourceCode.slice(node.start, node.end);

      const isExported =
        exportedNames.has(name) || exportedDeclarationNodes.has(node);

      const isDefault = defaultExportNames.has(name);
      const isClassLike = looksLikeClassName(name);

      functions.push(
        buildFunctionRecord({
          name,
          params: getParams(node),
          code,
          isAsync: isAsyncFunction(node),
          isExported,
          isDefault,
          isClassLike,
        })
      );
    },

    ClassDeclaration(path) {
      const node = path.node;
      const name = getFunctionName(node);
      const code = sourceCode.slice(node.start, node.end);

      const isExported =
        exportedNames.has(name) || exportedDeclarationNodes.has(node);

      const isDefault = defaultExportNames.has(name);

      functions.push(
        buildFunctionRecord({
          name,
          params: getConstructorParams(node),
          code,
          isAsync: false,
          isExported,
          isDefault,
          isClassLike: true,
        })
      );
    },

    VariableDeclaration(path) {
      for (const decl of path.node.declarations || []) {
        if (decl.id?.type !== "Identifier") continue;
        if (!decl.init) continue;

        const init = decl.init;

        const isFn =
          init.type === "ArrowFunctionExpression" ||
          init.type === "FunctionExpression";

        const isClass = init.type === "ClassExpression";

        if (!isFn && !isClass) continue;

        const name = decl.id.name;
        const code = sourceCode.slice(init.start, init.end);

        const isExported =
          exportedNames.has(name) || exportedDeclarationNodes.has(path.node);

        const isDefault = defaultExportNames.has(name);

        functions.push(
          buildFunctionRecord({
            name,
            params: isClass ? getConstructorParams(init) : getParams(init),
            code,
            isAsync: isFn ? isAsyncFunction(init) : false,
            isExported,
            isDefault,
            isClassLike: isClass || looksLikeClassName(name),
          })
        );
      }
    },
  });

  const seen = new Set();
  return functions.filter((fn) => {
    const key = `${fn.name}::${fn.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
