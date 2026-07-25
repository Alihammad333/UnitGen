import { classifyModule } from "./moduleClassifier.js";

/*
Builds a per-function mock plan.

This version supports both the old/simple dependency format and the new rich
dependency format produced by dependencyDetector.js.

Input:
  - functions: Step 1 array of function records
  - importMap: rich import map
  - usage: legacy functionName -> [localNamesUsed]
  - memberUsage: legacy functionName -> ["axios.get", "fs.promises.readFile"]
  - dependencies: functionName -> [moduleNamesUsed]
  - dependencyUsage: rich functionName -> [usage records]

Output:
  mockPlan: {
    functionName: [
      {
        module: "axios",
        normalizedModule: "axios",
        type: "external",
        imports: [
          {
            localName: "axios",
            importKind: "default",
            importedName: "default",
            sourceType: "esm",
            accessPath: []
          }
        ],
        members: ["get"],
        memberChains: [["get"], ["create", "get"]],
        globals: [],
        targets: ["axios", "get"],      // legacy-compatible field
        usages: [...]
      }
    ]
  }
*/

function normalizeModuleName(moduleName) {
  return String(moduleName || "").replace(/^node:/, "");
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueArray(values) {
  return Array.from(new Set(safeArray(values).filter(Boolean)));
}

function chainKey(chain) {
  return safeArray(chain).filter(Boolean).join(".");
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

function classifyPlanModule(moduleName, normalizedModuleName) {
  const mod = String(moduleName || normalizedModuleName || "");

  if (mod.startsWith("global:")) return "global";

  return classifyModule(mod);
}

function createEmptyModulePlan(moduleName) {
  const normalizedModule = normalizeModuleName(moduleName);

  return {
    module: moduleName,
    normalizedModule,
    type: classifyPlanModule(moduleName, normalizedModule),

    imports: [],
    members: [],
    memberChains: [],
    globals: [],
    targets: [],

    usages: [],

    _importKeys: new Set(),
    _memberSet: new Set(),
    _chainSet: new Set(),
    _globalSet: new Set(),
    _targetSet: new Set(),
    _usageKeys: new Set(),
  };
}

function getPlanKey(moduleName, normalizedModuleName) {
  const mod = normalizedModuleName || normalizeModuleName(moduleName);
  return mod || moduleName;
}

function ensureModulePlan(modulePlans, moduleName, normalizedModuleName = null) {
  const normalized = normalizedModuleName || normalizeModuleName(moduleName);
  const key = getPlanKey(moduleName, normalized);

  if (!modulePlans.has(key)) {
    modulePlans.set(key, createEmptyModulePlan(moduleName || normalized));
  }

  const plan = modulePlans.get(key);

  /*
   * Keep the original import source if available.
   * Example:
   *   module: "node:fs"
   *   normalizedModule: "fs"
   */
  if (!plan.module && moduleName) plan.module = moduleName;
  if (!plan.normalizedModule && normalized) plan.normalizedModule = normalized;

  if (plan.type !== "global") {
    plan.type = classifyPlanModule(plan.module, plan.normalizedModule);
  }

  return plan;
}

function addImportToPlan(plan, importInfo) {
  if (!plan || !importInfo?.localName) return;

  const item = {
    localName: importInfo.localName,
    importKind: importInfo.importKind || "unknown",
    importedName: importInfo.importedName || "*",
    sourceType: importInfo.sourceType || "unknown",
    accessPath: safeArray(importInfo.accessPath),
  };

  const key = [
    item.localName,
    item.importKind,
    item.importedName,
    item.sourceType,
    chainKey(item.accessPath),
  ].join("|");

  if (plan._importKeys.has(key)) return;

  plan._importKeys.add(key);
  plan.imports.push(item);

  addTargetToPlan(plan, item.localName);
}

function addTargetToPlan(plan, target) {
  const value = String(target || "").trim();
  if (!value) return;

  if (plan._targetSet.has(value)) return;

  plan._targetSet.add(value);
  plan.targets.push(value);
}

function addMemberToPlan(plan, member) {
  const value = String(member || "").trim();
  if (!value || value === "*") return;

  if (plan._memberSet.has(value)) return;

  plan._memberSet.add(value);
  plan.members.push(value);
  addTargetToPlan(plan, value);
}

function addMemberChainToPlan(plan, chain) {
  const clean = safeArray(chain).map(String).filter(Boolean);
  if (clean.length === 0) return;

  const key = chainKey(clean);
  if (!key || plan._chainSet.has(key)) return;

  plan._chainSet.add(key);
  plan.memberChains.push(clean);

  /*
   * Also expose the final callable/property as a legacy target.
   * Example:
   *   ["promises", "readFile"] -> "readFile"
   */
  addTargetToPlan(plan, clean[clean.length - 1]);

  /*
   * Also expose first member for factories like axios.create().get().
   */
  if (clean.length > 1) {
    addMemberToPlan(plan, clean[0]);
  }
}

function addGlobalToPlan(plan, globalName, accessPath = []) {
  const cleanPath = safeArray(accessPath).map(String).filter(Boolean);
  const key = [globalName, ...cleanPath].join(".");

  if (!key || plan._globalSet.has(key)) return;

  plan._globalSet.add(key);
  plan.globals.push({
    name: globalName,
    accessPath: cleanPath,
  });

  addTargetToPlan(plan, globalName);

  if (cleanPath.length > 0) {
    addMemberChainToPlan(plan, cleanPath);
  } else {
    addMemberToPlan(plan, globalName);
  }
}

function usageKey(usage) {
  return [
    usage?.moduleName,
    usage?.normalizedModuleName,
    usage?.localName,
    usage?.importKind,
    usage?.importedName,
    chainKey(usage?.accessPath),
    usage?.usage,
    usage?.usageKind,
  ].join("|");
}

function addUsageToPlan(plan, usage) {
  if (!plan || !usage) return;

  const key = usageKey(usage);
  if (plan._usageKeys.has(key)) return;

  plan._usageKeys.add(key);
  plan.usages.push(usage);
}

function addImportedNameAsMockTarget(plan, importInfo) {
  if (!plan || !importInfo) return;

  const importedName = String(importInfo.importedName || "").trim();
  const importKind = String(importInfo.importKind || "");

  if (!importedName || importedName === "*" || importedName === "default") return;

  /*
   * Named/destructured imports should become mockable members.
   * Examples:
   *   import { readFileSync } from "fs"
   *   const { readFileSync: read } = require("fs")
   */
  if (
    [
      "named",
      "destructured-require",
      "destructured-dynamic-import",
      "destructured-rest",
    ].includes(importKind)
  ) {
    if (importedName.includes(".")) {
      addMemberChainToPlan(plan, importedName.split("."));
    } else {
      addMemberToPlan(plan, importedName);
    }
  }
}

function addRichUsageRecord(modulePlans, record) {
  if (!record?.moduleName) return;

  const moduleName = record.moduleName;
  const normalizedModuleName =
    record.normalizedModuleName || normalizeModuleName(moduleName);

  const plan = ensureModulePlan(modulePlans, moduleName, normalizedModuleName);

  addUsageToPlan(plan, record);

  if (record.importKind === "global" || record.sourceType === "global") {
    addGlobalToPlan(plan, record.localName, record.accessPath);
    return;
  }

  const importInfo = {
    localName: record.localName,
    moduleName: record.moduleName,
    normalizedModuleName,
    importKind: record.importKind,
    importedName: record.importedName,
    sourceType: record.sourceType,
    accessPath: safeArray(record.accessPath),
  };

  addImportToPlan(plan, importInfo);
  addImportedNameAsMockTarget(plan, importInfo);

  const accessPath = safeArray(record.accessPath);
  const importedName = String(importInfo.importedName || "").trim();
  const isNamedLikeImport = [
    "named",
    "destructured-require",
    "destructured-dynamic-import",
    "destructured-rest",
  ].includes(importInfo.importKind);

  if (
    isNamedLikeImport &&
    importedName &&
    !["*", "default"].includes(importedName) &&
    accessPath.length > 0
  ) {
    addMemberChainToPlan(plan, [importedName, ...accessPath]);
  } else if (accessPath.length === 1) {
    addMemberToPlan(plan, accessPath[0]);
  } else if (accessPath.length > 1) {
    addMemberChainToPlan(plan, accessPath);
  }

  /*
   * For direct calls of named/destructured imports, the importedName is the
   * actual module member that must be mocked.
   *
   * Example:
   *   import { request } from "undici";
   *   request(url);
   */
  if (
    accessPath.length === 0 &&
    ["direct-call", "reference"].includes(record.usageKind)
  ) {
    addImportedNameAsMockTarget(plan, importInfo);
  }
}

function addLegacyUsage({
  modulePlans,
  importMap,
  localName,
}) {
  const importInfo = getImportInfo(importMap, localName);
  if (!importInfo?.moduleName) return;

  const plan = ensureModulePlan(
    modulePlans,
    importInfo.moduleName,
    importInfo.normalizedModuleName
  );

  addImportToPlan(plan, importInfo);
  addImportedNameAsMockTarget(plan, importInfo);
}

function addLegacyMemberUsage({
  modulePlans,
  importMap,
  fullMemberUsage,
}) {
  const parts = String(fullMemberUsage || "").split(".").filter(Boolean);
  if (parts.length < 2) return;

  const [localName, ...memberPath] = parts;
  const importInfo = getImportInfo(importMap, localName);
  if (!importInfo?.moduleName) return;

  const plan = ensureModulePlan(
    modulePlans,
    importInfo.moduleName,
    importInfo.normalizedModuleName
  );

  addImportToPlan(plan, importInfo);

  if (memberPath.length === 1) {
    addMemberToPlan(plan, memberPath[0]);
  }

  if (memberPath.length > 1) {
    addMemberChainToPlan(plan, memberPath);
  }
}

function ensureDependencyModules({
  modulePlans,
  dependencies,
}) {
  for (const moduleName of safeArray(dependencies)) {
    if (!moduleName) continue;

    ensureModulePlan(
      modulePlans,
      moduleName,
      normalizeModuleName(moduleName)
    );
  }
}

function cleanupPlanEntry(entry) {
  const cleaned = {
    module: entry.module,
    normalizedModule: entry.normalizedModule || normalizeModuleName(entry.module),
    type: entry.type || classifyPlanModule(entry.module, entry.normalizedModule),

    imports: entry.imports || [],
    members: uniqueArray(entry.members),
    memberChains: safeArray(entry.memberChains),
    globals: entry.globals || [],
    targets: uniqueArray(entry.targets),

    usages: entry.usages || [],
  };

  /*
   * Make global plans easier for the renderer:
   * global:fetch should always expose fetch as a member/target.
   */
  if (cleaned.type === "global") {
    const globalName = String(cleaned.module || "").replace(/^global:/, "");

    if (globalName) {
      cleaned.members = uniqueArray([...cleaned.members, globalName]);
      cleaned.targets = uniqueArray([...cleaned.targets, globalName]);

      if (cleaned.globals.length === 0) {
        cleaned.globals.push({
          name: globalName,
          accessPath: [],
        });
      }
    }
  }

  return cleaned;
}

/*
Builds a per-function mock plan.

Backwards compatible input:
  buildMockPlan({ functions, importMap, usage, memberUsage, dependencies })

New richer input:
  buildMockPlan({
    functions,
    importMap,
    usage,
    memberUsage,
    dependencies,
    dependencyUsage
  })
*/
export function buildMockPlan({
  functions = [],
  importMap = {},
  usage = {},
  memberUsage = {},
  dependencies = {},
  dependencyUsage = {},
}) {
  const mockPlan = {};

  for (const fn of functions || []) {
    const fnName = fn.name;

    const modulePlans = new Map();

    const richRecords = safeArray(dependencyUsage?.[fnName]);

    if (richRecords.length > 0) {
      for (const record of richRecords) {
        addRichUsageRecord(modulePlans, record);
      }
    } else {
      /*
       * Legacy fallback. This keeps the current pipeline working even before
       * every caller is migrated to dependencyUsage.
       */
      const fnUsageNames = safeArray(usage?.[fnName]);
      const fnMemberUsage = safeArray(memberUsage?.[fnName]);

      for (const localName of fnUsageNames) {
        addLegacyUsage({
          modulePlans,
          importMap,
          localName,
        });
      }

      for (const fullMemberUsage of fnMemberUsage) {
        addLegacyMemberUsage({
          modulePlans,
          importMap,
          fullMemberUsage,
        });
      }
    }

    ensureDependencyModules({
      modulePlans,
      dependencies: dependencies?.[fnName],
    });

    mockPlan[fnName] = Array.from(modulePlans.values()).map(cleanupPlanEntry);
  }

  return mockPlan;
}