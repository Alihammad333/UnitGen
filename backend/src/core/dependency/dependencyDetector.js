import traverseModule from "@babel/traverse";
import { parseSource } from "../parser/parseFile.js";
import { buildImportMap, normalizeModuleName } from "./importMapBuilder.js";

const traverse = traverseModule.default;

const MAX_TRANSITIVE_DEP_DEPTH = 3;

const GLOBAL_DEPENDENCIES = new Map([
  ["fetch", "global:fetch"],
  ["process", "global:process"],
  ["Buffer", "global:Buffer"],
  ["URL", "global:URL"],
  ["URLSearchParams", "global:URLSearchParams"],
]);

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function uniqueArray(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getPropertyName(node) {
  if (!node) return null;

  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "NumericLiteral") return String(node.value);
  if (node.type === "PrivateName" && node.id?.name) return node.id.name;

  return null;
}

function getNodeSourceKey(node) {
  if (!node) return "";

  return `${node.start ?? "?"}:${node.end ?? "?"}:${node.type ?? "?"}`;
}

function isNonComputedMemberProperty(path) {
  const parent = path.parentPath?.node;

  return (
    parent?.type === "MemberExpression" &&
    parent.property === path.node &&
    parent.computed === false
  );
}

function isObjectPropertyKey(path) {
  const parent = path.parentPath?.node;

  return (
    parent?.type === "ObjectProperty" &&
    parent.key === path.node &&
    parent.computed === false
  );
}

function isObjectMethodKey(path) {
  const parent = path.parentPath?.node;

  return (
    parent?.type === "ObjectMethod" &&
    parent.key === path.node &&
    parent.computed === false
  );
}

function isClassMethodKey(path) {
  const parent = path.parentPath?.node;

  return (
    (parent?.type === "ClassMethod" || parent?.type === "ClassPrivateMethod") &&
    parent.key === path.node &&
    parent.computed === false
  );
}

function shouldIgnoreIdentifierReference(path) {
  return (
    isNonComputedMemberProperty(path) ||
    isObjectPropertyKey(path) ||
    isObjectMethodKey(path) ||
    isClassMethodKey(path)
  );
}

/**
 * Converts:
 *   axios.get              -> { rootName: "axios", accessPath: ["get"] }
 *   fs.promises.readFile   -> { rootName: "fs", accessPath: ["promises", "readFile"] }
 *   axios.create().get     -> { rootName: "axios", accessPath: ["create", "get"], hasCallInChain: true }
 *   process.env.API_KEY    -> { rootName: "process", accessPath: ["env", "API_KEY"] }
 */
function extractAccessChain(node) {
  if (!node) return null;

  if (node.type === "Identifier") {
    return {
      rootName: node.name,
      accessPath: [],
      hasCallInChain: false,
    };
  }

  if (node.type === "ThisExpression") {
    return {
      rootName: "this",
      accessPath: [],
      hasCallInChain: false,
    };
  }

  if (node.type === "Super") {
    return {
      rootName: "super",
      accessPath: [],
      hasCallInChain: false,
    };
  }

  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    const base = extractAccessChain(node.object);
    if (!base) return null;

    const propName = getPropertyName(node.property);
    if (!propName) return base;

    return {
      rootName: base.rootName,
      accessPath: [...base.accessPath, propName],
      hasCallInChain: base.hasCallInChain,
    };
  }

  if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
    const base = extractAccessChain(node.callee);
    if (!base) return null;

    return {
      rootName: base.rootName,
      accessPath: base.accessPath,
      hasCallInChain: true,
    };
  }

  if (node.type === "AwaitExpression") {
    return extractAccessChain(node.argument);
  }

  if (node.type === "TSNonNullExpression") {
    return extractAccessChain(node.expression);
  }

  return null;
}

function buildUsageString(
  rootName,
  accessPath = [],
  usageKind = "reference",
  hasCallInChain = false
) {
  const chain = [rootName, ...safeArray(accessPath)].filter(Boolean);

  if (chain.length === 0) return "";

  if (usageKind === "direct-call") {
    return `${rootName}()`;
  }

  if (usageKind === "constructor-call") {
    return `new ${chain.join(".")}()`;
  }

  if (hasCallInChain && accessPath.length > 1) {
    const [first, ...rest] = accessPath;
    return `${rootName}.${first}().${rest.join(".")}`;
  }

  return chain.join(".");
}

function getImportInfo(importMap, localName) {
  const info = importMap?.[localName];

  if (!info) return null;

  if (typeof info === "string") {
    return {
      localName,
      moduleName: info,
      normalizedModuleName: normalizeModuleName(info),
      importKind: "unknown",
      importedName: "*",
      sourceType: "unknown",
      accessPath: [],
    };
  }

  return {
    localName: info.localName || localName,
    moduleName: info.moduleName,
    normalizedModuleName:
      info.normalizedModuleName || normalizeModuleName(info.moduleName),
    importKind: info.importKind || "unknown",
    importedName: info.importedName || "*",
    sourceType: info.sourceType || "unknown",
    accessPath: safeArray(info.accessPath),
  };
}

function createImportedUsageRecord({
  importInfo,
  accessPath = [],
  usageKind,
  hasCallInChain = false,
  transitive = false,
  via = [],
}) {
  if (!importInfo) return null;

  const baseAccessPath = safeArray(importInfo.accessPath);
  let finalAccessPath = safeArray(accessPath);

  /*
   * For named imports:
   *   import { readFileSync } from "fs";
   *   readFileSync()
   *
   * The function usage itself has no member access path.
   * The importedName already tells mock planning which member is needed.
   */
  if (
    finalAccessPath.length === 0 &&
    ["named", "destructured-require", "destructured-dynamic-import"].includes(
      importInfo.importKind
    )
  ) {
    finalAccessPath = [];
  }

  /*
   * For require-member:
   *   const fsPromises = require("fs").promises;
   *   fsPromises.readFile()
   *
   * accessPath should become:
   *   ["promises", "readFile"]
   */
  if (
    baseAccessPath.length > 0 &&
    !["named", "destructured-require", "destructured-dynamic-import"].includes(
      importInfo.importKind
    )
  ) {
    finalAccessPath = [...baseAccessPath, ...finalAccessPath];
  }

  return {
    moduleName: importInfo.moduleName,
    normalizedModuleName: importInfo.normalizedModuleName,
    localName: importInfo.localName,
    importKind: importInfo.importKind,
    importedName: importInfo.importedName,
    sourceType: importInfo.sourceType,
    accessPath: finalAccessPath,
    usage: buildUsageString(
      importInfo.localName,
      accessPath,
      usageKind,
      hasCallInChain
    ),
    usageKind,
    transitive: !!transitive,
    via: safeArray(via),
  };
}

function createGlobalUsageRecord({
  globalName,
  moduleName,
  accessPath = [],
  usageKind,
  hasCallInChain = false,
  transitive = false,
  via = [],
}) {
  return {
    moduleName,
    normalizedModuleName: moduleName,
    localName: globalName,
    importKind: "global",
    importedName: globalName,
    sourceType: "global",
    accessPath: safeArray(accessPath),
    usage: buildUsageString(globalName, accessPath, usageKind, hasCallInChain),
    usageKind,
    transitive: !!transitive,
    via: safeArray(via),
  };
}

function getRecordKey(record) {
  return [
    record.moduleName,
    record.normalizedModuleName,
    record.localName,
    record.importKind,
    record.importedName,
    safeArray(record.accessPath).join("."),
    record.usage,
    record.usageKind,
    record.transitive ? "transitive" : "direct",
    safeArray(record.via).join(">"),
  ].join("|");
}

function addUsageRecord(records, seen, record) {
  if (!record?.moduleName || !record?.localName) return;

  const key = getRecordKey(record);
  if (seen.has(key)) return;

  seen.add(key);
  records.push(record);
}

function mergeUsageRecords(recordLists = []) {
  const records = [];
  const seen = new Set();

  for (const list of recordLists || []) {
    for (const record of list || []) {
      addUsageRecord(records, seen, record);
    }
  }

  return records;
}

function getDirectCallName(path) {
  const callee = path.node.callee;

  if (callee?.type === "Identifier") return callee.name;

  return null;
}

function isFunctionLikeNode(node) {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "ObjectMethod" ||
    node?.type === "ClassMethod" ||
    node?.type === "ClassPrivateMethod"
  );
}

function isInlineCallbackPath(path) {
  const parent = path.parentPath?.node;

  if (
    parent?.type !== "CallExpression" &&
    parent?.type !== "OptionalCallExpression" &&
    parent?.type !== "NewExpression"
  ) {
    return false;
  }

  return safeArray(parent.arguments).includes(path.node);
}

function collectImportedAliasRoots(node, importedNames, roots = new Set()) {
  if (!node) return roots;

  if (node.type === "Identifier" && importedNames.has(node.name)) {
    roots.add(node.name);
    return roots;
  }

  if (node.type === "ConditionalExpression" || node.type === "LogicalExpression") {
    collectImportedAliasRoots(
      node.type === "ConditionalExpression" ? node.consequent : node.left,
      importedNames,
      roots
    );
    collectImportedAliasRoots(
      node.type === "ConditionalExpression" ? node.alternate : node.right,
      importedNames,
      roots
    );
  }

  return roots;
}
function detectDependencyUsageInsideFunction(functionPath, importMap) {
  const records = [];
  const seen = new Set();
  const importedNames = new Set(Object.keys(importMap || {}));
  const localImportAliases = new Map();

  function addImportedChainRecords(chain, usageKind, hasCallInChain = false) {
    if (!chain?.rootName) return;

    const rootNames = importedNames.has(chain.rootName)
      ? [chain.rootName]
      : safeArray(localImportAliases.get(chain.rootName));

    for (const rootName of rootNames) {
      const importInfo = getImportInfo(importMap, rootName);

      addUsageRecord(
        records,
        seen,
        createImportedUsageRecord({
          importInfo,
          accessPath: chain.accessPath,
          usageKind,
          hasCallInChain,
        })
      );
    }
  }

  functionPath.traverse({
    Function(innerPath) {
      /*
       * Do not count dependencies used only inside nested functions as direct
       * dependencies of the outer target. Those nested functions are handled
       * through transitive helper expansion when called.
       */
      if (
        innerPath.node !== functionPath.node &&
        !isInlineCallbackPath(innerPath)
      ) {
        innerPath.skip();
      }
    },

    VariableDeclarator(innerPath) {
      const id = innerPath.node.id;
      if (id?.type !== "Identifier") return;

      const roots = Array.from(
        collectImportedAliasRoots(innerPath.node.init, importedNames)
      );

      if (roots.length > 0) {
        localImportAliases.set(id.name, roots);
      }
    },
    CallExpression(innerPath) {
      const directCallName = getDirectCallName(innerPath);

      if (directCallName && importedNames.has(directCallName)) {
        const importInfo = getImportInfo(importMap, directCallName);

        addUsageRecord(
          records,
          seen,
          createImportedUsageRecord({
            importInfo,
            accessPath: [],
            usageKind: "direct-call",
          })
        );
      }

      if (directCallName && GLOBAL_DEPENDENCIES.has(directCallName)) {
        addUsageRecord(
          records,
          seen,
          createGlobalUsageRecord({
            globalName: directCallName,
            moduleName: GLOBAL_DEPENDENCIES.get(directCallName),
            accessPath: [],
            usageKind: "global-call",
          })
        );
      }

      const chain = extractAccessChain(innerPath.node.callee);

      addImportedChainRecords(
        chain,
        chain?.accessPath?.length > 1 || chain?.hasCallInChain
          ? "member-chain-call"
          : "member-call",
        chain?.hasCallInChain
      );

      if (chain?.rootName && GLOBAL_DEPENDENCIES.has(chain.rootName)) {
        addUsageRecord(
          records,
          seen,
          createGlobalUsageRecord({
            globalName: chain.rootName,
            moduleName: GLOBAL_DEPENDENCIES.get(chain.rootName),
            accessPath: chain.accessPath,
            usageKind:
              chain.accessPath.length > 0 ? "global-member-call" : "global-call",
            hasCallInChain: chain.hasCallInChain,
          })
        );
      }
    },

    OptionalCallExpression(innerPath) {
      const chain = extractAccessChain(innerPath.node.callee);

      addImportedChainRecords(
        chain,
        chain?.accessPath?.length > 1 || chain?.hasCallInChain
          ? "member-chain-call"
          : "member-call",
        chain?.hasCallInChain
      );

      if (chain?.rootName && GLOBAL_DEPENDENCIES.has(chain.rootName)) {
        addUsageRecord(
          records,
          seen,
          createGlobalUsageRecord({
            globalName: chain.rootName,
            moduleName: GLOBAL_DEPENDENCIES.get(chain.rootName),
            accessPath: chain.accessPath,
            usageKind:
              chain.accessPath.length > 0 ? "global-member-call" : "global-call",
            hasCallInChain: chain.hasCallInChain,
          })
        );
      }
    },

    NewExpression(innerPath) {
      const chain = extractAccessChain(innerPath.node.callee);

      if (chain?.rootName && importedNames.has(chain.rootName)) {
        const importInfo = getImportInfo(importMap, chain.rootName);

        addUsageRecord(
          records,
          seen,
          createImportedUsageRecord({
            importInfo,
            accessPath: chain.accessPath,
            usageKind: "constructor-call",
            hasCallInChain: chain.hasCallInChain,
          })
        );
      }

      if (chain?.rootName && GLOBAL_DEPENDENCIES.has(chain.rootName)) {
        addUsageRecord(
          records,
          seen,
          createGlobalUsageRecord({
            globalName: chain.rootName,
            moduleName: GLOBAL_DEPENDENCIES.get(chain.rootName),
            accessPath: chain.accessPath,
            usageKind: "global-constructor-call",
            hasCallInChain: chain.hasCallInChain,
          })
        );
      }
    },

    MemberExpression(innerPath) {
      const chain = extractAccessChain(innerPath.node);
      if (!chain?.rootName) return;

      if (importedNames.has(chain.rootName)) {
        const importInfo = getImportInfo(importMap, chain.rootName);

        addUsageRecord(
          records,
          seen,
          createImportedUsageRecord({
            importInfo,
            accessPath: chain.accessPath,
            usageKind: chain.accessPath.length > 1 ? "member-chain" : "member",
            hasCallInChain: chain.hasCallInChain,
          })
        );
      }

      if (GLOBAL_DEPENDENCIES.has(chain.rootName)) {
        addUsageRecord(
          records,
          seen,
          createGlobalUsageRecord({
            globalName: chain.rootName,
            moduleName: GLOBAL_DEPENDENCIES.get(chain.rootName),
            accessPath: chain.accessPath,
            usageKind:
              chain.accessPath.length > 1
                ? "global-member-chain"
                : "global-member",
            hasCallInChain: chain.hasCallInChain,
          })
        );
      }
    },

    OptionalMemberExpression(innerPath) {
      const chain = extractAccessChain(innerPath.node);
      if (!chain?.rootName) return;

      if (importedNames.has(chain.rootName)) {
        const importInfo = getImportInfo(importMap, chain.rootName);

        addUsageRecord(
          records,
          seen,
          createImportedUsageRecord({
            importInfo,
            accessPath: chain.accessPath,
            usageKind:
              chain.accessPath.length > 1 ? "member-chain" : "member",
            hasCallInChain: chain.hasCallInChain,
          })
        );
      }

      if (GLOBAL_DEPENDENCIES.has(chain.rootName)) {
        addUsageRecord(
          records,
          seen,
          createGlobalUsageRecord({
            globalName: chain.rootName,
            moduleName: GLOBAL_DEPENDENCIES.get(chain.rootName),
            accessPath: chain.accessPath,
            usageKind:
              chain.accessPath.length > 1
                ? "global-member-chain"
                : "global-member",
            hasCallInChain: chain.hasCallInChain,
          })
        );
      }
    },

    ReferencedIdentifier(innerPath) {
      if (shouldIgnoreIdentifierReference(innerPath)) return;

      const idName = innerPath.node.name;

      if (importedNames.has(idName)) {
        const importInfo = getImportInfo(importMap, idName);

        addUsageRecord(
          records,
          seen,
          createImportedUsageRecord({
            importInfo,
            accessPath: [],
            usageKind: "reference",
          })
        );
      }

      if (GLOBAL_DEPENDENCIES.has(idName)) {
        addUsageRecord(
          records,
          seen,
          createGlobalUsageRecord({
            globalName: idName,
            moduleName: GLOBAL_DEPENDENCIES.get(idName),
            accessPath: [],
            usageKind: "global-reference",
          })
        );
      }
    },
  });

  return records;
}

function collectCalledLocalNames(functionPath) {
  const called = new Set();

  functionPath.traverse({
    Function(innerPath) {
      if (
        innerPath.node !== functionPath.node &&
        !isInlineCallbackPath(innerPath)
      ) {
        innerPath.skip();
      }
    },

    
    CallExpression(innerPath) {
      const callee = innerPath.node.callee;

      if (callee?.type === "Identifier") {
        called.add(callee.name);
        return;
      }

      const chain = extractAccessChain(callee);
      if (!chain) return;

      const last = safeArray(chain.accessPath).at(-1);

      if (chain.rootName === "this" && last) {
        called.add(last);
      }

      if (chain.rootName === "super" && last) {
        called.add(last);
      }

      if (last) {
        called.add(last);
      }

      if (chain.rootName) {
        called.add(chain.rootName);
      }
    },

    OptionalCallExpression(innerPath) {
      const chain = extractAccessChain(innerPath.node.callee);
      if (!chain) return;

      const last = safeArray(chain.accessPath).at(-1);

      if (chain.rootName === "this" && last) {
        called.add(last);
      }

      if (last) {
        called.add(last);
      }

      if (chain.rootName) {
        called.add(chain.rootName);
      }
    },

    NewExpression(innerPath) {
      const callee = innerPath.node.callee;

      if (callee?.type === "Identifier") {
        called.add(callee.name);
        return;
      }

      const chain = extractAccessChain(callee);
      if (!chain) return;

      const last = safeArray(chain.accessPath).at(-1);
      if (last) called.add(last);
      if (chain.rootName) called.add(chain.rootName);
    },
  });

  return Array.from(called).filter(Boolean);
}

function getClassNameFromClassMethodPath(path) {
  const classPath = path.findParent(
    (p) => p.node?.type === "ClassDeclaration" || p.node?.type === "ClassExpression"
  );

  const classNode = classPath?.node;

  if (classNode?.id?.name) return classNode.id.name;

  const parent = classPath?.parentPath?.node;

  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return parent.id.name;
  }

  if (parent?.type === "AssignmentExpression") {
    const left = parent.left;

    if (left?.type === "Identifier") return left.name;

    if (left?.type === "MemberExpression") {
      return getPropertyName(left.property);
    }
  }

  return "";
}

function memberExpressionToParts(node) {
  if (!node) return [];

  if (node.type === "Identifier") return [node.name];

  if (node.type === "ThisExpression") return ["this"];

  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    return [
      ...memberExpressionToParts(node.object),
      getPropertyName(node.property),
    ].filter(Boolean);
  }

  return [];
}

function getMemberAssignmentAliases(left) {
  const aliases = [];

  if (!left) return aliases;

  if (left.type === "Identifier") {
    aliases.push(left.name);
    return aliases;
  }

  if (left.type !== "MemberExpression" && left.type !== "OptionalMemberExpression") {
    return aliases;
  }

  const parts = memberExpressionToParts(left);
  const propertyName = parts.at(-1);

  if (parts.join(".") === "module.exports") {
    aliases.push("defaultExport");
  }

  if (propertyName) aliases.push(propertyName);

  if (parts.length >= 2) {
    aliases.push(parts.join("."));
  }

  /*
   * Patterns:
   *   ClassName.prototype.method = function () {}
   *   exports.ClassName.prototype.method = function () {}
   */
  const protoIndex = parts.indexOf("prototype");
  if (protoIndex > 0 && parts[protoIndex + 1]) {
    const className = parts[protoIndex - 1];
    const methodName = parts[protoIndex + 1];

    aliases.push(`${className}.prototype.${methodName}`);
    aliases.push(`${className}.${methodName}`);
    aliases.push(methodName);
  }

  /*
   * Pattern:
   *   ClassName.staticMethod = function () {}
   */
  if (
    parts.length >= 2 &&
    !parts.includes("prototype") &&
    !["exports", "module"].includes(parts[0])
  ) {
    const owner = parts.at(-2);
    const method = parts.at(-1);

    aliases.push(`${owner}.${method}`);
    aliases.push(method);
  }

  return uniqueArray(aliases);
}

function getObjectAssignOwnerAliases(objectExpressionPath, keyName) {
  const aliases = [];
  const callPath = objectExpressionPath.parentPath;

  if (callPath?.node?.type !== "CallExpression") return aliases;

  const calleeParts = memberExpressionToParts(callPath.node.callee);
  if (calleeParts.join(".") !== "Object.assign") return aliases;

  const args = callPath.node.arguments || [];
  const firstArg = args[0];

  if (!firstArg) return aliases;

  const parts = memberExpressionToParts(firstArg);

  const protoIndex = parts.indexOf("prototype");

  if (protoIndex > 0) {
    const className = parts[protoIndex - 1];

    aliases.push(`${className}.prototype.${keyName}`);
    aliases.push(`${className}.${keyName}`);
    aliases.push(keyName);
    return uniqueArray(aliases);
  }

  const owner = parts.at(-1);

  if (owner) {
    aliases.push(`${owner}.${keyName}`);
    aliases.push(keyName);
  }

  return uniqueArray(aliases);
}

function getObjectFunctionAliases(path, keyName) {
  const aliases = [keyName].filter(Boolean);

  const objectExpressionPath = path.parentPath;

  if (objectExpressionPath?.node?.type === "ObjectExpression") {
    aliases.push(...getObjectAssignOwnerAliases(objectExpressionPath, keyName));
  }

  return uniqueArray(aliases);
}

function addFunctionEntry(entries, aliasMap, entry) {
  if (!entry?.path || !entry.aliases?.length) return;

  const cleanAliases = uniqueArray(entry.aliases.map(safeString));

  if (!cleanAliases.length) return;

  const normalizedEntry = {
    ...entry,
    key: entry.key || cleanAliases[0],
    aliases: cleanAliases,
  };

  entries.push(normalizedEntry);

  for (const alias of cleanAliases) {
    if (!aliasMap.has(alias)) {
      aliasMap.set(alias, []);
    }

    aliasMap.get(alias).push(normalizedEntry);
  }
}

function collectFunctionEntries(ast) {
  const entries = [];
  const aliasMap = new Map();

  traverse(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id?.name;
      if (!name) return;

      addFunctionEntry(entries, aliasMap, {
        key: name,
        name,
        aliases: [name],
        path,
        nodeKey: getNodeSourceKey(path.node),
        kind: "function-declaration",
      });
    },

    VariableDeclarator(path) {
      const id = path.node.id;
      const init = path.node.init;

      if (id?.type !== "Identifier") return;
      if (!isFunctionLikeNode(init)) return;

      addFunctionEntry(entries, aliasMap, {
        key: id.name,
        name: id.name,
        aliases: [id.name],
        path: path.get("init"),
        nodeKey: getNodeSourceKey(init),
        kind: "variable-function",
      });
    },

    AssignmentExpression(path) {
      const left = path.node.left;
      const right = path.node.right;

      if (!isFunctionLikeNode(right)) return;

      const aliases = getMemberAssignmentAliases(left);
      if (!aliases.length) return;

      addFunctionEntry(entries, aliasMap, {
        key: aliases[0],
        name: aliases[0],
        aliases,
        path: path.get("right"),
        nodeKey: getNodeSourceKey(right),
        kind: "assignment-function",
      });
    },

    ObjectProperty(path) {
      const value = path.node.value;

      if (!isFunctionLikeNode(value)) return;

      const keyName = getPropertyName(path.node.key);
      if (!keyName) return;

      const aliases = getObjectFunctionAliases(path, keyName);

      addFunctionEntry(entries, aliasMap, {
        key: aliases[0] || keyName,
        name: keyName,
        aliases,
        path: path.get("value"),
        nodeKey: getNodeSourceKey(value),
        kind: "object-property-function",
      });
    },

    ObjectMethod(path) {
      const keyName = getPropertyName(path.node.key);
      if (!keyName) return;

      const aliases = getObjectFunctionAliases(path, keyName);

      addFunctionEntry(entries, aliasMap, {
        key: aliases[0] || keyName,
        name: keyName,
        aliases,
        path,
        nodeKey: getNodeSourceKey(path.node),
        kind: "object-method",
      });
    },

    ClassMethod(path) {
      const methodName = getPropertyName(path.node.key);
      if (!methodName) return;
      if (methodName === "constructor") return;

      const className = getClassNameFromClassMethodPath(path);
      const aliases = [methodName];

      if (className) {
        if (path.node.static) {
          aliases.unshift(`${className}.${methodName}`);
        } else {
          aliases.unshift(`${className}.prototype.${methodName}`);
          aliases.push(`${className}.${methodName}`);
        }
      }

      addFunctionEntry(entries, aliasMap, {
        key: aliases[0] || methodName,
        name: methodName,
        aliases,
        path,
        nodeKey: getNodeSourceKey(path.node),
        kind: path.node.static ? "class-static-method" : "class-prototype-method",
      });
    },

    ClassPrivateMethod(path) {
      const methodName = getPropertyName(path.node.key);
      if (!methodName) return;
      if (methodName === "constructor") return;

      const className = getClassNameFromClassMethodPath(path);
      const aliases = [methodName];

      if (className) {
        if (path.node.static) {
          aliases.unshift(`${className}.${methodName}`);
        } else {
          aliases.unshift(`${className}.prototype.${methodName}`);
          aliases.push(`${className}.${methodName}`);
        }
      }

      addFunctionEntry(entries, aliasMap, {
        key: aliases[0] || methodName,
        name: methodName,
        aliases,
        path,
        nodeKey: getNodeSourceKey(path.node),
        kind: path.node.static
          ? "class-private-static-method"
          : "class-private-prototype-method",
      });
    },
  });

  return { entries, aliasMap };
}

function getTargetAliases(fn = {}) {
  const aliases = new Set();

  const add = (value) => {
    const v = safeString(value);
    if (v) aliases.add(v);
  };

  add(fn.targetKey);
  add(fn.displayName);
  add(fn.name);
  add(fn.fnName);
  add(fn.methodName);

  if (fn.ownerClassName && fn.methodName) {
    add(`${fn.ownerClassName}.${fn.methodName}`);
    add(`${fn.ownerClassName}.prototype.${fn.methodName}`);
  }

  for (const alias of safeArray(fn.dependencyAliases)) {
    add(alias);
  }

  return Array.from(aliases);
}

function getTargetKey(fn = {}) {
  return (
    safeString(fn.targetKey) ||
    safeString(fn.displayName) ||
    safeString(fn.name) ||
    safeString(fn.fnName) ||
    safeString(fn.methodName)
  );
}

function pickBestFunctionEntryForTarget(fn, aliasMap) {
  const aliases = getTargetAliases(fn);

  for (const alias of aliases) {
    const matches = aliasMap.get(alias) || [];
    if (matches.length === 1) return matches[0];

    if (matches.length > 1) {
      /*
       * Prefer class-qualified aliases over simple method names.
       */
      const exact = matches.find((entry) => entry.key === alias);
      if (exact) return exact;

      const classQualified = matches.find((entry) =>
        entry.aliases.some((x) => x.includes(".prototype.") || x.includes("."))
      );

      if (classQualified) return classQualified;

      return matches[0];
    }
  }

  return null;
}

function cloneAsTransitiveRecord(record, via = []) {
  if (!record) return null;

  return {
    ...record,
    transitive: true,
    via: uniqueArray([...(record.via || []), ...safeArray(via)]),
    usageKind: record.usageKind?.startsWith("transitive-")
      ? record.usageKind
      : `transitive-${record.usageKind || "usage"}`,
  };
}

function expandDependencyRecords({
  entry,
  importMap,
  aliasMap,
  directRecordCache,
  callCache,
  visited = new Set(),
  depth = 0,
  via = [],
}) {
  if (!entry || depth > MAX_TRANSITIVE_DEP_DEPTH) return [];

  const entryVisitKey = entry.nodeKey || entry.key;
  if (!entryVisitKey || visited.has(entryVisitKey)) return [];

  const nextVisited = new Set(visited);
  nextVisited.add(entryVisitKey);

  const directRecords = directRecordCache.get(entryVisitKey) || [];
  const records = [...directRecords];

  const calledNames = callCache.get(entryVisitKey) || [];

  for (const calledName of calledNames) {
    const helperEntries = aliasMap.get(calledName) || [];

    for (const helperEntry of helperEntries) {
      if (!helperEntry || helperEntry === entry) continue;

      const helperVisitKey = helperEntry.nodeKey || helperEntry.key;
      if (!helperVisitKey || nextVisited.has(helperVisitKey)) continue;

      const helperRecords = expandDependencyRecords({
        entry: helperEntry,
        importMap,
        aliasMap,
        directRecordCache,
        callCache,
        visited: nextVisited,
        depth: depth + 1,
        via: [...via, helperEntry.key || calledName],
      });

      for (const record of helperRecords) {
        if (depth === 0) {
          records.push(cloneAsTransitiveRecord(record, [
            helperEntry.key || calledName,
          ]));
        } else {
          records.push(
            cloneAsTransitiveRecord(record, [
              ...via,
              helperEntry.key || calledName,
            ])
          );
        }
      }
    }
  }

  return mergeUsageRecords([records]);
}

function toLegacyUsage(records) {
  const names = new Set();

  for (const record of records || []) {
    if (
      record?.sourceType !== "global" &&
      record?.importKind !== "global" &&
      record?.localName
    ) {
      names.add(record.localName);
    }
  }

  return Array.from(names);
}

function toLegacyMemberUsage(records) {
  const members = new Set();

  for (const record of records || []) {
    if (
      record?.sourceType === "global" ||
      record?.importKind === "global" ||
      !record?.localName
    ) {
      continue;
    }

    const accessPath = safeArray(record.accessPath);

    if (accessPath.length > 0) {
      members.add(`${record.localName}.${accessPath.join(".")}`);
    }
  }

  return Array.from(members);
}

/**
 * For each function/target, find which imported/global dependencies are used inside it.
 *
 * Supports:
 * - normal function declarations
 * - variable-assigned functions
 * - assignment functions
 * - object methods/properties
 * - class prototype methods
 * - class static methods
 * - Object.assign(Class.prototype, { method() {} })
 * - transitive helper calls up to MAX_TRANSITIVE_DEP_DEPTH
 *
 * Return shape:
 * {
 *   importMap: rich import map,
 *   usage: legacy targetKey -> [localNames],
 *   memberUsage: legacy targetKey -> ["axios.get"],
 *   dependencyUsage: rich targetKey -> [usage records]
 * }
 */
export function detectImportedIdentifierUsage(code, functions = []) {
  const importMap = buildImportMap(code);
  const usage = {};
  const memberUsage = {};
  const dependencyUsage = {};

  let ast;
  try {
    ast = parseSource(code);
  } catch {
    for (const fn of functions || []) {
      const key = getTargetKey(fn);
      usage[key] = [];
      memberUsage[key] = [];
      dependencyUsage[key] = [];
    }

    return { importMap, usage, memberUsage, dependencyUsage };
  }

  const { entries, aliasMap } = collectFunctionEntries(ast);

  const directRecordCache = new Map();
  const callCache = new Map();

  for (const entry of entries) {
    const entryKey = entry.nodeKey || entry.key;
    if (!entryKey) continue;

    directRecordCache.set(
      entryKey,
      detectDependencyUsageInsideFunction(entry.path, importMap)
    );

    callCache.set(entryKey, collectCalledLocalNames(entry.path));
  }

  for (const fn of functions || []) {
    const key = getTargetKey(fn);
    if (!key) continue;

    const entry = pickBestFunctionEntryForTarget(fn, aliasMap);

    if (!entry) {
      usage[key] = [];
      memberUsage[key] = [];
      dependencyUsage[key] = [];
      continue;
    }

    const records = expandDependencyRecords({
      entry,
      importMap,
      aliasMap,
      directRecordCache,
      callCache,
      visited: new Set(),
      depth: 0,
      via: [],
    });

    dependencyUsage[key] = records;
    usage[key] = toLegacyUsage(records);
    memberUsage[key] = toLegacyMemberUsage(records);
  }

  for (const fn of functions || []) {
    const key = getTargetKey(fn);
    if (!usage[key]) usage[key] = [];
    if (!memberUsage[key]) memberUsage[key] = [];
    if (!dependencyUsage[key]) dependencyUsage[key] = [];
  }

  return { importMap, usage, memberUsage, dependencyUsage };
}

/**
 * Converts identifier/rich usage into module dependencies.
 *
 * Supports both:
 * - old usage: functionName -> [localName]
 * - new rich usage: functionName -> [usage records]
 */
export function convertUsageToModuleDependencies(importMap, usage) {
  const dependencies = {};

  for (const [fnName, usedItems] of Object.entries(usage || {})) {
    const modules = new Set();

    for (const item of usedItems || []) {
      if (typeof item === "string") {
        const info = getImportInfo(importMap, item);
        if (info?.moduleName) {
          modules.add(info.normalizedModuleName || normalizeModuleName(info.moduleName));
        }
        continue;
      }

      if (item?.normalizedModuleName) {
        modules.add(item.normalizedModuleName);
        continue;
      }

      if (item?.moduleName) {
        modules.add(normalizeModuleName(item.moduleName));
      }
    }

    dependencies[fnName] = Array.from(modules);
  }

  return dependencies;
}