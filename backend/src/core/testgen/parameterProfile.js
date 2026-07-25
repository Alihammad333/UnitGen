import traverseModule from "@babel/traverse";
import { parseSource } from "../parser/parseFile.js";

const traverse = traverseModule.default;

function normalizeParamName(raw) {
  return String(raw || "").trim();
}

function createEmptyProfile(name) {
  return {
    name,
    kind: "literal",
    methods: [],
    properties: [],
    isCallbackLike: false,
    isOptionsLike: false,
    isArrayLike: false,
    isNumberLike: false,
    isProbabilityLike: false,
    isIndexLike: false,
    isCountLike: false,
    isMatrixLike: false,
    isFunctionLike: false,
  };
}

function ensureProfileCollections(profile) {
  if (!profile || typeof profile !== "object") return null;

  if (!Array.isArray(profile.methods)) profile.methods = [];
  if (!Array.isArray(profile.properties)) profile.properties = [];

  return profile;
}

function uniqSorted(arr) {
  return Array.from(new Set(Array.isArray(arr) ? arr : [])).sort();
}

function finalizeProfile(profile) {
  const safeProfile = ensureProfileCollections(profile) || createEmptyProfile("");

  const methods = uniqSorted(safeProfile.methods);
  const properties = uniqSorted(safeProfile.properties);

  let kind = "literal";

  if (safeProfile.isCallbackLike || safeProfile.isFunctionLike) {
    kind = "callback";
  } else if (
    safeProfile.isArrayLike ||
    safeProfile.isMatrixLike
  ) {
    kind = "array";
  } else if (
    methods.length > 0 ||
    properties.length > 0 ||
    safeProfile.isOptionsLike
  ) {
    kind = "object";
  }

  return {
    name: safeProfile.name,
    kind,
    methods,
    properties,
    isCallbackLike: safeProfile.isCallbackLike,
    isOptionsLike: safeProfile.isOptionsLike,
    isArrayLike: safeProfile.isArrayLike,
    isNumberLike: safeProfile.isNumberLike,
    isProbabilityLike: safeProfile.isProbabilityLike,
    isIndexLike: safeProfile.isIndexLike,
    isCountLike: safeProfile.isCountLike,
    isMatrixLike: safeProfile.isMatrixLike,
    isFunctionLike: safeProfile.isFunctionLike,
  };
}

function markPropertyUse(profile, propName) {
  const safeProfile = ensureProfileCollections(profile);
  if (!safeProfile || !propName) return;

  if (!safeProfile.properties.includes(propName)) {
    safeProfile.properties.push(propName);
  }
}

function markMethodUse(profile, methodName) {
  const safeProfile = ensureProfileCollections(profile);
  if (!safeProfile || !methodName) return;

  if (!safeProfile.methods.includes(methodName)) {
    safeProfile.methods.push(methodName);
  }
}

function markNameHeuristics(profile) {
  const lower = String(profile.name || "").toLowerCase();

  if (
    lower === "x" ||
    lower === "y" ||
    lower === "xs" ||
    lower === "ys" ||
    lower.endsWith("arr") ||
    lower.endsWith("array") ||
    lower.endsWith("list") ||
    lower.endsWith("values") ||
    lower.endsWith("points") ||
    lower.endsWith("samples") ||
    lower.endsWith("labels") ||
    lower.endsWith("data")
  ) {
    profile.isArrayLike = true;
  }

  if (
    lower.endsWith("matrix") ||
    lower.endsWith("matrices")
  ) {
    profile.isArrayLike = true;
    profile.isMatrixLike = true;
  }

  if (
    lower === "p" ||
    lower.includes("prob") ||
    lower.includes("probability") ||
    lower.includes("alpha") ||
    lower.includes("quantile")
  ) {
    profile.isNumberLike = true;
    profile.isProbabilityLike = true;
  }

  if (
    lower === "n" ||
    lower.endsWith("n") ||
    lower.includes("count") ||
    lower.includes("size") ||
    lower.includes("length") ||
    lower.includes("classes") ||
    lower.includes("bins")
  ) {
    profile.isNumberLike = true;
    profile.isCountLike = true;
  }

  if (
    lower.includes("index") ||
    lower === "i" ||
    lower === "j" ||
    lower === "k"
  ) {
    profile.isNumberLike = true;
    profile.isIndexLike = true;
  }

  if (
    lower.includes("callback") ||
    lower.endsWith("cb") ||
    lower.includes("handler") ||
    lower.endsWith("fn") ||
    lower === "func"
  ) {
    profile.isCallbackLike = true;
    profile.isFunctionLike = true;
  }
}

export function analyzeFunctionParameterProfiles(functionCode, params = []) {
  const normalizedParams = (Array.isArray(params) ? params : [])
    .map(normalizeParamName)
    .filter(Boolean);

  const profiles = Object.fromEntries(
    normalizedParams.map((name) => {
      const profile = createEmptyProfile(name);
      markNameHeuristics(profile);
      return [name, profile];
    })
  );

  if (!functionCode || normalizedParams.length === 0) {
    return profiles;
  }

  let ast;
  try {
    ast = parseSource(functionCode);
  } catch {
    return profiles;
  }

  traverse(ast, {
    MemberExpression(path) {
      const obj = path.node.object;
      const prop = path.node.property;

      if (obj?.type !== "Identifier") return;
      if (!(obj.name in profiles)) return;

      const profile = ensureProfileCollections(profiles[obj.name]);
      if (!profile) return;

      const parent = path.parentPath?.node;

      const propName =
        !path.node.computed && prop?.type === "Identifier"
          ? prop.name
          : null;

      if (propName) {
        if (
          [
            "length",
            "map",
            "filter",
            "reduce",
            "slice",
            "sort",
            "concat",
            "push",
            "pop",
            "shift",
            "unshift",
            "every",
            "some",
            "forEach",
            "includes",
            "indexOf",
          ].includes(propName)
        ) {
          profile.isArrayLike = true;
        }

        if (
          [
            "toFixed",
            "toPrecision",
            "valueOf",
          ].includes(propName)
        ) {
          profile.isNumberLike = true;
        }
      }

      if (
        parent?.type === "CallExpression" &&
        parent.callee === path.node &&
        propName
      ) {
        markMethodUse(profile, propName);
        return;
      }

      if (propName) {
        markPropertyUse(profile, propName);
      }
    },

    CallExpression(path) {
      const callee = path.node.callee;

      if (callee?.type === "Identifier" && callee.name in profiles) {
        const profile = ensureProfileCollections(profiles[callee.name]);
        if (profile) {
          profile.isCallbackLike = true;
          profile.isFunctionLike = true;
        }
      }

      for (const arg of path.node.arguments || []) {
        if (arg?.type === "Identifier" && arg.name in profiles) {
          const name = arg.name;
          const profile = ensureProfileCollections(profiles[name]);
          if (!profile) continue;

          const calleeNode = path.node.callee;

          if (calleeNode?.type === "Identifier") {
            const calleeName = calleeNode.name.toLowerCase();

            if (
              calleeName.includes("sort") ||
              calleeName.includes("quantile") ||
              calleeName.includes("median") ||
              calleeName.includes("mean") ||
              calleeName.includes("variance") ||
              calleeName.includes("deviation") ||
              calleeName.includes("sample") ||
              calleeName.includes("shuffle") ||
              calleeName.includes("mode")
            ) {
              profile.isArrayLike = true;
            }
          }
        }
      }
    },

    BinaryExpression(path) {
      const { left, right } = path.node;

      for (const side of [left, right]) {
        if (side?.type === "Identifier" && side.name in profiles) {
          const profile = ensureProfileCollections(profiles[side.name]);
          if (profile) {
            profile.isNumberLike = true;
          }
        }
      }
    },

    UnaryExpression(path) {
      const arg = path.node.argument;
      if (arg?.type === "Identifier" && arg.name in profiles) {
        const profile = ensureProfileCollections(profiles[arg.name]);
        if (profile) {
          profile.isNumberLike = true;
        }
      }
    },

    UpdateExpression(path) {
      const arg = path.node.argument;
      if (arg?.type === "Identifier" && arg.name in profiles) {
        const profile = ensureProfileCollections(profiles[arg.name]);
        if (profile) {
          profile.isNumberLike = true;
          profile.isIndexLike = true;
        }
      }
    },

    ArrayPattern(path) {
      const parent = path.parentPath?.node;
      if (
        parent?.type !== "FunctionDeclaration" &&
        parent?.type !== "FunctionExpression" &&
        parent?.type !== "ArrowFunctionExpression"
      ) {
        return;
      }

      for (const element of path.node.elements || []) {
        if (element?.type === "Identifier" && element.name in profiles) {
          const profile = ensureProfileCollections(profiles[element.name]);
          if (profile) {
            profile.isArrayLike = true;
          }
        }
      }
    },

    ObjectPattern(path) {
      const parent = path.parentPath?.node;

      if (
        parent?.type !== "FunctionDeclaration" &&
        parent?.type !== "FunctionExpression" &&
        parent?.type !== "ArrowFunctionExpression"
      ) {
        return;
      }

      for (const prop of path.node.properties || []) {
        const valueName =
          prop?.value?.type === "Identifier" ? prop.value.name : null;

        if (!valueName || !(valueName in profiles)) continue;

        const profile = ensureProfileCollections(profiles[valueName]);
        if (profile) {
          profile.isOptionsLike = true;
        }
      }
    },

    VariableDeclarator(path) {
      const init = path.node.init;
      const id = path.node.id;

      if (init?.type === "Identifier" && init.name in profiles) {
        const profile = ensureProfileCollections(profiles[init.name]);
        if (profile) {
          profile.isOptionsLike = true;
        }
      }

      if (
        id?.type === "Identifier" &&
        id.name in profiles &&
        init?.type === "ArrayExpression"
      ) {
        const profile = ensureProfileCollections(profiles[id.name]);
        if (profile) {
          profile.isArrayLike = true;
        }
      }
    },

    ForStatement(path) {
      const test = path.node.test;
      if (!test) return;

      traverse(test, {
        Identifier(innerPath) {
          const name = innerPath.node.name;
          if (name in profiles) {
            const profile = ensureProfileCollections(profiles[name]);
            if (profile) {
              profile.isNumberLike = true;
              profile.isIndexLike = true;
            }
          }
        },
      }, path.scope, path);
    },

    IfStatement(path) {
      const test = path.node.test;
      if (!test) return;

      traverse(test, {
        Identifier(innerPath) {
          const name = innerPath.node.name;
          if (name in profiles) {
            const profile = ensureProfileCollections(profiles[name]);
            if (profile) {
              profile.isNumberLike = true;
            }
          }
        },
      }, path.scope, path);
    },
  });

  return Object.fromEntries(
    Object.entries(profiles).map(([name, profile]) => [
      name,
      finalizeProfile(profile),
    ])
  );
}