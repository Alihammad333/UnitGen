import traverseModule from "@babel/traverse";
import { parseSource } from "./parseFile.js";

const traverse = traverseModule.default;

const IGNORED_METHOD_NAMES = new Set([
  "constructor",
  "__proto__",
  "prototype",
]);

function safeString(value) {
  return String(value || "");
}

function nodeCode(code, node) {
  if (!code || !node || typeof node.start !== "number" || typeof node.end !== "number") {
    return "";
  }

  return code.slice(node.start, node.end);
}

function getIdentifierName(node) {
  if (!node) return null;

  if (node.type === "Identifier") return node.name;

  if (node.type === "StringLiteral") return node.value;

  if (node.type === "NumericLiteral") return String(node.value);

  if (node.type === "PrivateName" && node.id?.name) {
    return node.id.name;
  }

  return null;
}

function getParamName(param, index = 0) {
  if (!param) return `arg${index + 1}`;

  if (param.type === "Identifier") return param.name;

  if (param.type === "AssignmentPattern") {
    return getParamName(param.left, index);
  }

  if (param.type === "RestElement") {
    return getParamName(param.argument, index);
  }

  if (param.type === "ObjectPattern") {
    return `obj${index + 1}`;
  }

  if (param.type === "ArrayPattern") {
    return `arr${index + 1}`;
  }

  return `arg${index + 1}`;
}

function getParamNames(params = []) {
  return (params || []).map((p, index) => getParamName(p, index));
}

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
    if (["resolve", "reject", "all", "allSettled", "any", "race"].includes(propertyName)) return true;
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

function isAsyncNode(node) {
  return Boolean(node?.async || nodeContainsPromiseSemantics(node));
}

function uniqueBy(items = [], keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(item);
  }

  return out;
}

function normalizeMethodRecord(method) {
  return {
    name: method.name,
    params: method.params || [],
    isAsync: Boolean(method.isAsync),
    kind: method.kind || "prototype",
    code: method.code || "",
    sourceType: method.sourceType || "unknown",
    accessPath: method.accessPath || [],
  };
}

function createEmptyClassRecord({
  className,
  constructorParams = [],
  constructorCode = "",
  classCode = "",
  isExported = false,
  isDefault = false,
  exportKind = "unknown",
  sourceType = "unknown",
}) {
  return {
    className,
    constructorParams,
    constructorCode,
    classCode,
    isExported: Boolean(isExported),
    isDefault: Boolean(isDefault),
    exportKind,
    sourceType,
    methods: [],
    staticMethods: [],
    prototypeMethods: [],
  };
}

function mergeClassRecord(existing, incoming) {
  if (!existing) return incoming;

  existing.constructorParams =
    existing.constructorParams?.length > 0
      ? existing.constructorParams
      : incoming.constructorParams || [];

  existing.constructorCode =
    existing.constructorCode || incoming.constructorCode || "";

  existing.classCode = existing.classCode || incoming.classCode || "";

  existing.isExported = existing.isExported || incoming.isExported;
  existing.isDefault = existing.isDefault || incoming.isDefault;

  if (existing.exportKind === "unknown" && incoming.exportKind !== "unknown") {
    existing.exportKind = incoming.exportKind;
  }

  if (existing.sourceType === "unknown" && incoming.sourceType !== "unknown") {
    existing.sourceType = incoming.sourceType;
  }

  existing.methods.push(...(incoming.methods || []));
  existing.staticMethods.push(...(incoming.staticMethods || []));
  existing.prototypeMethods.push(...(incoming.prototypeMethods || []));

  existing.methods = uniqueBy(existing.methods.map(normalizeMethodRecord), (m) =>
    `${m.kind}:${m.name}:${m.params.join(",")}`
  );

  existing.staticMethods = uniqueBy(
    existing.staticMethods.map(normalizeMethodRecord),
    (m) => `${m.kind}:${m.name}:${m.params.join(",")}`
  );

  existing.prototypeMethods = uniqueBy(
    existing.prototypeMethods.map(normalizeMethodRecord),
    (m) => `${m.kind}:${m.name}:${m.params.join(",")}`
  );

  return existing;
}

function methodRecordFromClassMethod(code, methodNode, ownerClassName) {
  const name = getIdentifierName(methodNode.key);
  if (!name || IGNORED_METHOD_NAMES.has(name)) return null;

  const kind = methodNode.static ? "static" : "prototype";
  const params = getParamNames(methodNode.params || []);

  return normalizeMethodRecord({
    name,
    params,
    isAsync: isAsyncNode(methodNode),
    kind,
    code: nodeCode(code, methodNode),
    sourceType: "class-method",
    accessPath:
      kind === "static"
        ? [ownerClassName, name]
        : [ownerClassName, "prototype", name],
  });
}

function extractConstructorFromClass(code, classNode) {
  for (const bodyItem of classNode.body?.body || []) {
    if (
      bodyItem.type === "ClassMethod" &&
      bodyItem.kind === "constructor"
    ) {
      return {
        constructorParams: getParamNames(bodyItem.params || []),
        constructorCode: nodeCode(code, bodyItem),
      };
    }
  }

  return {
    constructorParams: [],
    constructorCode: "",
  };
}

function recordClassDeclaration({
  classes,
  code,
  classNode,
  className,
  isExported = false,
  isDefault = false,
  exportKind = "unknown",
  sourceType = "class-declaration",
}) {
  if (!className) return;

  const { constructorParams, constructorCode } = extractConstructorFromClass(
    code,
    classNode
  );

  const record = createEmptyClassRecord({
    className,
    constructorParams,
    constructorCode,
    classCode: nodeCode(code, classNode),
    isExported,
    isDefault,
    exportKind,
    sourceType,
  });

  for (const bodyItem of classNode.body?.body || []) {
    if (bodyItem.type !== "ClassMethod" && bodyItem.type !== "ClassPrivateMethod") {
      continue;
    }

    const method = methodRecordFromClassMethod(code, bodyItem, className);
    if (!method) continue;

    record.methods.push(method);

    if (method.kind === "static") {
      record.staticMethods.push(method);
    } else {
      record.prototypeMethods.push(method);
    }
  }

  classes.set(className, mergeClassRecord(classes.get(className), record));
}

function getAssignedFunctionInfo(code, rightNode) {
  if (!rightNode) return null;

  if (
    rightNode.type === "FunctionExpression" ||
    rightNode.type === "ArrowFunctionExpression"
  ) {
    return {
      params: getParamNames(rightNode.params || []),
      isAsync: isAsyncNode(rightNode),
      code: nodeCode(code, rightNode),
    };
  }

  if (rightNode.type === "Identifier") {
    return {
      params: [],
      isAsync: false,
      code: rightNode.name,
      referencedIdentifier: rightNode.name,
    };
  }

  return null;
}

function isClassLikeConstructorName(name) {
  if (!name) return false;
  return /^[A-Z]/.test(name);
}

function functionLooksConstructor(path) {
  const node = path.node;
  const name = node.id?.name || "";

  if (!isClassLikeConstructorName(name)) return false;

  let usesThis = false;

  path.traverse({
    ThisExpression(innerPath) {
      usesThis = true;
      innerPath.stop();
    },
  });

  return usesThis;
}

function recordFunctionConstructor({
  classes,
  code,
  functionNode,
  className,
  isExported = false,
  isDefault = false,
  exportKind = "unknown",
  sourceType = "function-constructor",
}) {
  if (!className) return;

  const record = createEmptyClassRecord({
    className,
    constructorParams: getParamNames(functionNode.params || []),
    constructorCode: nodeCode(code, functionNode),
    classCode: nodeCode(code, functionNode),
    isExported,
    isDefault,
    exportKind,
    sourceType,
  });

  classes.set(className, mergeClassRecord(classes.get(className), record));
}

function recordPrototypeMethod({
  classes,
  code,
  className,
  methodName,
  rightNode,
  sourceType = "prototype-assignment",
}) {
  if (!className || !methodName) return;
  if (IGNORED_METHOD_NAMES.has(methodName)) return;

  const info = getAssignedFunctionInfo(code, rightNode);
  if (!info) return;

  const existing =
    classes.get(className) ||
    createEmptyClassRecord({
      className,
      sourceType: "inferred-prototype-class",
    });

  const method = normalizeMethodRecord({
    name: methodName,
    params: info.params,
    isAsync: info.isAsync,
    kind: "prototype",
    code: info.code,
    sourceType,
    accessPath: [className, "prototype", methodName],
  });

  existing.methods.push(method);
  existing.prototypeMethods.push(method);

  classes.set(className, mergeClassRecord(classes.get(className), existing));
}

function recordStaticMethod({
  classes,
  code,
  className,
  methodName,
  rightNode,
  sourceType = "static-assignment",
}) {
  if (!className || !methodName) return;
  if (IGNORED_METHOD_NAMES.has(methodName)) return;

  const info = getAssignedFunctionInfo(code, rightNode);
  if (!info) return;

  const existing =
    classes.get(className) ||
    createEmptyClassRecord({
      className,
      sourceType: "inferred-static-class",
    });

  const method = normalizeMethodRecord({
    name: methodName,
    params: info.params,
    isAsync: info.isAsync,
    kind: "static",
    code: info.code,
    sourceType,
    accessPath: [className, methodName],
  });

  existing.methods.push(method);
  existing.staticMethods.push(method);

  classes.set(className, mergeClassRecord(classes.get(className), existing));
}

function unwrapExpressionStatement(node) {
  if (!node) return null;
  if (node.type === "ExpressionStatement") return node.expression;
  return node;
}

function getMemberChain(node) {
  const chain = [];

  let current = node;

  while (current) {
    if (current.type === "Identifier") {
      chain.unshift(current.name);
      break;
    }

    if (current.type === "ThisExpression") {
      chain.unshift("this");
      break;
    }

    if (current.type === "MemberExpression") {
      const propName = getIdentifierName(current.property);
      if (!propName) return [];

      chain.unshift(propName);
      current = current.object;
      continue;
    }

    return [];
  }

  return chain;
}

function parsePrototypeAssignment(leftNode) {
  const chain = getMemberChain(leftNode);

  if (chain.length < 3) return null;

  const prototypeIndex = chain.indexOf("prototype");
  if (prototypeIndex <= 0) return null;

  const className = chain[prototypeIndex - 1];
  const methodName = chain[prototypeIndex + 1];

  if (!className || !methodName) return null;

  return {
    className,
    methodName,
  };
}

function parseWholePrototypeObjectAssignment(leftNode) {
  const chain = getMemberChain(leftNode);

  if (chain.length !== 2) return null;

  const [className, propertyName] = chain;

  if (!className || propertyName !== "prototype") return null;
  if (!isClassLikeConstructorName(className)) return null;

  return { className };
}

function parseStaticAssignment(leftNode) {
  const chain = getMemberChain(leftNode);

  if (chain.length !== 2) return null;

  const [className, methodName] = chain;

  if (!className || !methodName) return null;
  if (!isClassLikeConstructorName(className)) return null;
  if (methodName === "prototype") return null;

  return {
    className,
    methodName,
  };
}

function recordPrototypeObjectLiteralMethods({
  classes,
  code,
  className,
  objectNode,
}) {
  if (!className) return;
  if (!objectNode || objectNode.type !== "ObjectExpression") return;

  for (const prop of objectNode.properties || []) {
    if (prop.type === "SpreadElement") continue;

    if (prop.type !== "ObjectProperty" && prop.type !== "ObjectMethod") {
      continue;
    }

    const methodName = getIdentifierName(prop.key);
    if (!methodName || IGNORED_METHOD_NAMES.has(methodName)) continue;

    if (prop.type === "ObjectMethod") {
      const existing =
        classes.get(className) ||
        createEmptyClassRecord({
          className,
          sourceType: "inferred-prototype-object-class",
        });

      const method = normalizeMethodRecord({
        name: methodName,
        params: getParamNames(prop.params || []),
        isAsync: isAsyncNode(prop),
        kind: "prototype",
        code: nodeCode(code, prop),
        sourceType: "prototype-object-method",
        accessPath: [className, "prototype", methodName],
      });

      existing.methods.push(method);
      existing.prototypeMethods.push(method);

      classes.set(className, mergeClassRecord(classes.get(className), existing));
      continue;
    }

    recordPrototypeMethod({
      classes,
      code,
      className,
      methodName,
      rightNode: prop.value,
      sourceType: "prototype-object-property",
    });
  }
}

function recordObjectAssignPrototypeMethods({ classes, code, callNode }) {
  if (
    callNode.callee?.type !== "MemberExpression" ||
    getMemberChain(callNode.callee).join(".") !== "Object.assign"
  ) {
    return;
  }

  const [target, source] = callNode.arguments || [];
  if (!target || !source) return;

  const targetInfo = parsePrototypeAssignment(target);
  if (!targetInfo?.className) return;

  if (source.type !== "ObjectExpression") return;

  for (const prop of source.properties || []) {
    if (prop.type !== "ObjectProperty" && prop.type !== "ObjectMethod") {
      continue;
    }

    const methodName = getIdentifierName(prop.key);
    if (!methodName || IGNORED_METHOD_NAMES.has(methodName)) continue;

    if (prop.type === "ObjectMethod") {
      const method = normalizeMethodRecord({
        name: methodName,
        params: getParamNames(prop.params || []),
        isAsync: isAsyncNode(prop),
        kind: "prototype",
        code: nodeCode(code, prop),
        sourceType: "object-assign-prototype-method",
        accessPath: [targetInfo.className, "prototype", methodName],
      });

      const existing =
        classes.get(targetInfo.className) ||
        createEmptyClassRecord({
          className: targetInfo.className,
          sourceType: "inferred-object-assign-class",
        });

      existing.methods.push(method);
      existing.prototypeMethods.push(method);
      classes.set(
        targetInfo.className,
        mergeClassRecord(classes.get(targetInfo.className), existing)
      );

      continue;
    }

    const info = getAssignedFunctionInfo(code, prop.value);
    if (!info) continue;

    recordPrototypeMethod({
      classes,
      code,
      className: targetInfo.className,
      methodName,
      rightNode: prop.value,
      sourceType: "object-assign-prototype-property",
    });
  }
}

function collectExportedNames(ast) {
  const exported = new Map();

  traverse(ast, {
    ExportNamedDeclaration(path) {
      const node = path.node;

      if (node.declaration) {
        if (node.declaration.type === "ClassDeclaration") {
          const name = node.declaration.id?.name;
          if (name) {
            exported.set(name, {
              isDefault: false,
              exportKind: "named-class-declaration",
            });
          }
        }

        if (node.declaration.type === "FunctionDeclaration") {
          const name = node.declaration.id?.name;
          if (name) {
            exported.set(name, {
              isDefault: false,
              exportKind: "named-function-declaration",
            });
          }
        }

        if (node.declaration.type === "VariableDeclaration") {
          for (const decl of node.declaration.declarations || []) {
            if (decl.id?.type === "Identifier") {
              exported.set(decl.id.name, {
                isDefault: false,
                exportKind: "named-variable-declaration",
              });
            }
          }
        }
      }

      for (const spec of node.specifiers || []) {
        const localName = spec.local?.name;
        const exportedName = spec.exported?.name || spec.exported?.value;

        if (localName) {
          exported.set(localName, {
            isDefault: exportedName === "default",
            exportKind: "named-export-specifier",
          });
        }
      }
    },

    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;

      if (decl?.type === "Identifier") {
        exported.set(decl.name, {
          isDefault: true,
          exportKind: "default-identifier",
        });
      }

      if (decl?.type === "ClassDeclaration" && decl.id?.name) {
        exported.set(decl.id.name, {
          isDefault: true,
          exportKind: "default-class-declaration",
        });
      }

      if (decl?.type === "FunctionDeclaration" && decl.id?.name) {
        exported.set(decl.id.name, {
          isDefault: true,
          exportKind: "default-function-declaration",
        });
      }
    },

    AssignmentExpression(path) {
      const left = path.node.left;
      const right = path.node.right;

      const leftChain = getMemberChain(left).join(".");
      const hasLocalExportsBinding = Boolean(path.scope.getBinding("exports"));
      const hasLocalModuleBinding = Boolean(path.scope.getBinding("module"));

      if (leftChain === "module.exports" && !hasLocalModuleBinding) {
        if (right.type === "Identifier") {
          exported.set(right.name, {
            isDefault: true,
            exportKind: "commonjs-module-exports-identifier",
          });
        }

        if (right.type === "FunctionExpression" || right.type === "ClassExpression") {
          const name = right.id?.name || "default";
          exported.set(name, {
            isDefault: true,
            exportKind: "commonjs-module-exports-expression",
          });
        }

        if (right.type === "ObjectExpression") {
          for (const prop of right.properties || []) {
            if (prop.type !== "ObjectProperty" && prop.type !== "ObjectMethod") {
              continue;
            }

            const exportedName = getIdentifierName(prop.key);

            if (prop.type === "ObjectMethod") {
              if (exportedName) {
                exported.set(exportedName, {
                  isDefault: false,
                  exportKind: "commonjs-object-method-export",
                });
              }
              continue;
            }

            const localName =
              prop.value?.type === "Identifier"
                ? prop.value.name
                : exportedName;

            if (localName) {
              exported.set(localName, {
                isDefault: false,
                exportKind: "commonjs-object-export",
                exportedName,
              });
            }
          }
        }
      }

      if (
        (leftChain.startsWith("module.exports.") && !hasLocalModuleBinding) ||
        (leftChain.startsWith("exports.") && !hasLocalExportsBinding)
      ) {
        const chain = getMemberChain(left);
        const exportedName = chain[chain.length - 1];

        if (right.type === "Identifier") {
          exported.set(right.name, {
            isDefault: false,
            exportKind: "commonjs-property-export",
            exportedName,
          });
        } else if (exportedName) {
          exported.set(exportedName, {
            isDefault: false,
            exportKind: "commonjs-property-export",
            exportedName,
          });
        }
      }
    },
  });

  return exported;
}

function normalizeClassRecord(record, exportedNames) {
  const exportInfo = exportedNames.get(record.className);

  // These records come from methods explicitly declared by the package, not
  // from walking the inherited Object prototype. Keep legitimate overrides
  // such as toString() and valueOf(); filtering them here silently removes
  // public API behavior from test generation.
  const methods = uniqueBy(record.methods.map(normalizeMethodRecord), (m) =>
    `${m.kind}:${m.name}:${m.params.join(",")}`
  );

  const staticMethods = methods.filter((m) => m.kind === "static");
  const prototypeMethods = methods.filter((m) => m.kind === "prototype");

  return {
    ...record,
    isExported: Boolean(record.isExported || exportInfo),
    isDefault: Boolean(record.isDefault || exportInfo?.isDefault),
    exportKind: exportInfo?.exportKind || record.exportKind || "unknown",
    methods,
    staticMethods,
    prototypeMethods,
    methodCount: methods.length,
  };
}

/**
 * Main API.
 *
 * Input:
 *   code: source code string
 *
 * Output:
 *   [
 *     {
 *       className,
 *       constructorParams,
 *       constructorCode,
 *       classCode,
 *       isExported,
 *       isDefault,
 *       exportKind,
 *       methods,
 *       staticMethods,
 *       prototypeMethods,
 *       methodCount
 *     }
 *   ]
 */
export function analyzeClassExports(code) {
  const source = safeString(code);
  if (!source.trim()) return [];

  let ast;
  try {
    ast = parseSource(source);
  } catch {
    return [];
  }

  const exportedNames = collectExportedNames(ast);
  const classes = new Map();

  traverse(ast, {
    ClassDeclaration(path) {
      const name = path.node.id?.name;
      if (!name) return;

      const exportInfo = exportedNames.get(name);

      const parent = path.parentPath?.node;
      const parentExportNamed = parent?.type === "ExportNamedDeclaration";
      const parentExportDefault = parent?.type === "ExportDefaultDeclaration";

      recordClassDeclaration({
        classes,
        code: source,
        classNode: path.node,
        className: name,
        isExported: Boolean(exportInfo || parentExportNamed || parentExportDefault),
        isDefault: Boolean(exportInfo?.isDefault || parentExportDefault),
        exportKind:
          exportInfo?.exportKind ||
          (parentExportDefault
            ? "default-class-declaration"
            : parentExportNamed
              ? "named-class-declaration"
              : "local-class-declaration"),
        sourceType: "class-declaration",
      });
    },

    ClassExpression(path) {
      const parent = path.parentPath?.node;

      let className = path.node.id?.name;

      if (!className && parent?.type === "VariableDeclarator") {
        className = parent.id?.type === "Identifier" ? parent.id.name : null;
      }

      if (!className && parent?.type === "AssignmentExpression") {
        const leftChain = getMemberChain(parent.left);
        className = leftChain[leftChain.length - 1];
      }

      if (!className) return;

      const exportInfo = exportedNames.get(className);

      recordClassDeclaration({
        classes,
        code: source,
        classNode: path.node,
        className,
        isExported: Boolean(exportInfo),
        isDefault: Boolean(exportInfo?.isDefault),
        exportKind: exportInfo?.exportKind || "class-expression",
        sourceType: "class-expression",
      });
    },

    FunctionDeclaration(path) {
      const name = path.node.id?.name;
      if (!name) return;

      if (!functionLooksConstructor(path)) return;

      const exportInfo = exportedNames.get(name);
      const parent = path.parentPath?.node;
      const parentExportNamed = parent?.type === "ExportNamedDeclaration";
      const parentExportDefault = parent?.type === "ExportDefaultDeclaration";

      recordFunctionConstructor({
        classes,
        code: source,
        functionNode: path.node,
        className: name,
        isExported: Boolean(exportInfo || parentExportNamed || parentExportDefault),
        isDefault: Boolean(exportInfo?.isDefault || parentExportDefault),
        exportKind:
          exportInfo?.exportKind ||
          (parentExportDefault
            ? "default-function-constructor"
            : parentExportNamed
              ? "named-function-constructor"
              : "local-function-constructor"),
        sourceType: "function-constructor",
      });
    },

    VariableDeclarator(path) {
      const id = path.node.id;
      const init = path.node.init;

      if (!id || id.type !== "Identifier" || !init) return;

      const className = id.name;
      const exportInfo = exportedNames.get(className);

      if (init.type === "ClassExpression") {
        recordClassDeclaration({
          classes,
          code: source,
          classNode: init,
          className,
          isExported: Boolean(exportInfo),
          isDefault: Boolean(exportInfo?.isDefault),
          exportKind: exportInfo?.exportKind || "class-expression-variable",
          sourceType: "class-expression-variable",
        });
        return;
      }

      if (
        (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression") &&
        isClassLikeConstructorName(className)
      ) {
        /*
         * Function expressions assigned to UpperCase variables are treated as
         * constructor-like only when their body uses this.*. Arrow functions
         * cannot be constructors, but old libraries rarely use them for classes.
         */
        let usesThis = false;

        path.get("init").traverse({
          ThisExpression(innerPath) {
            usesThis = true;
            innerPath.stop();
          },
        });

        if (!usesThis) return;

        recordFunctionConstructor({
          classes,
          code: source,
          functionNode: init,
          className,
          isExported: Boolean(exportInfo),
          isDefault: Boolean(exportInfo?.isDefault),
          exportKind: exportInfo?.exportKind || "function-constructor-variable",
          sourceType: "function-constructor-variable",
        });
      }
    },

    AssignmentExpression(path) {
      const left = path.node.left;
      const right = path.node.right;

      const wholePrototypeInfo = parseWholePrototypeObjectAssignment(left);
      if (wholePrototypeInfo && right?.type === "ObjectExpression") {
        recordPrototypeObjectLiteralMethods({
          classes,
          code: source,
          className: wholePrototypeInfo.className,
          objectNode: right,
        });
        return;
      }

      const prototypeInfo = parsePrototypeAssignment(left);
      if (prototypeInfo) {
        recordPrototypeMethod({
          classes,
          code: source,
          className: prototypeInfo.className,
          methodName: prototypeInfo.methodName,
          rightNode: right,
          sourceType: "prototype-assignment",
        });
        return;
      }

      const staticInfo = parseStaticAssignment(left);
      if (staticInfo) {
        recordStaticMethod({
          classes,
          code: source,
          className: staticInfo.className,
          methodName: staticInfo.methodName,
          rightNode: right,
          sourceType: "static-assignment",
        });
      }
    },

    CallExpression(path) {
      recordObjectAssignPrototypeMethods({
        classes,
        code: source,
        callNode: path.node,
      });
    },
  });

  const records = Array.from(classes.values()).map((record) =>
    normalizeClassRecord(record, exportedNames)
  );

  /*
   * Keep:
   * - exported classes/constructors
   * - inferred classes with discovered prototype/static methods
   *
   * This allows packages where module.exports = Constructor appears after
   * prototype methods or where export detection is imperfect.
   */
  return records
    .filter((record) => record.isExported || record.methodCount > 0)
    .sort((a, b) => {
      if (a.isExported !== b.isExported) return a.isExported ? -1 : 1;
      return a.className.localeCompare(b.className);
    });
}

export function findClassExportByName(classRecords = [], className = "") {
  return (classRecords || []).find((record) => record.className === className) || null;
}

export function getClassMethodTargets(classRecord, options = {}) {
  const {
    includePrototype = true,
    includeStatic = true,
    maxMethods = 12,
  } = options;

  if (!classRecord) return [];

  const targets = [];

  if (includePrototype) {
    for (const method of classRecord.prototypeMethods || []) {
      targets.push({
        ownerClassName: classRecord.className,
        methodName: method.name,
        methodKind: "prototype",
        params: method.params || [],
        isAsync: Boolean(method.isAsync),
        functionCode: method.code || "",
        classCode: classRecord.classCode || "",
        constructorParams: classRecord.constructorParams || [],
        constructorCode: classRecord.constructorCode || "",
        accessPath: method.accessPath || [
          classRecord.className,
          "prototype",
          method.name,
        ],
      });
    }
  }

  if (includeStatic) {
    for (const method of classRecord.staticMethods || []) {
      targets.push({
        ownerClassName: classRecord.className,
        methodName: method.name,
        methodKind: "static",
        params: method.params || [],
        isAsync: Boolean(method.isAsync),
        functionCode: method.code || "",
        classCode: classRecord.classCode || "",
        constructorParams: classRecord.constructorParams || [],
        constructorCode: classRecord.constructorCode || "",
        accessPath: method.accessPath || [classRecord.className, method.name],
      });
    }
  }

  return targets.slice(0, maxMethods);
}

export function summarizeClassExports(classRecords = []) {
  const records = Array.isArray(classRecords) ? classRecords : [];

  return {
    classCount: records.length,
    exportedClassCount: records.filter((r) => r.isExported).length,
    totalMethodCount: records.reduce((sum, r) => sum + (r.methodCount || 0), 0),
    perClass: Object.fromEntries(
      records.map((record) => [
        record.className,
        {
          isExported: record.isExported,
          isDefault: record.isDefault,
          exportKind: record.exportKind,
          constructorParams: record.constructorParams || [],
          prototypeMethods: (record.prototypeMethods || []).map((m) => m.name),
          staticMethods: (record.staticMethods || []).map((m) => m.name),
          methodCount: record.methodCount || 0,
        },
      ])
    ),
  };
}

export function formatClassExportSummary(classRecords = []) {
  const summary = summarizeClassExports(classRecords);

  if (!summary.classCount) {
    return "No class-like exports or prototype methods detected.";
  }

  const lines = [
    `Detected ${summary.classCount} class-like record(s), ${summary.exportedClassCount} exported, ${summary.totalMethodCount} method(s).`,
  ];

  for (const [className, info] of Object.entries(summary.perClass)) {
    const parts = [];

    if (info.constructorParams.length) {
      parts.push(`constructor(${info.constructorParams.join(", ")})`);
    } else {
      parts.push("constructor()");
    }

    if (info.prototypeMethods.length) {
      parts.push(`prototype: ${info.prototypeMethods.join(", ")}`);
    }

    if (info.staticMethods.length) {
      parts.push(`static: ${info.staticMethods.join(", ")}`);
    }

    lines.push(
      `- ${className}${info.isExported ? " [exported]" : ""}: ${parts.join("; ")}`
    );
  }

  return lines.join("\n");
}
