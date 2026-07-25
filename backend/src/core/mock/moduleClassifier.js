import { builtinModules } from "node:module";

/*
Classifies dependency modules for UnitGen mock planning/rendering.

Supported categories:
- "builtin"  -> Node.js built-in modules, including node:fs and fs/promises
- "external" -> npm packages like axios, lodash, undici
- "local"    -> relative/local project modules like ./utils.js or ../lib/api.js
- "global"   -> virtual global dependencies like global:fetch and global:process

Examples:
- classifyModule("fs")                 -> "builtin"
- classifyModule("node:fs")            -> "builtin"
- classifyModule("fs/promises")        -> "builtin"
- classifyModule("node:fs/promises")   -> "builtin"
- classifyModule("path")               -> "builtin"
- classifyModule("node:path")          -> "builtin"
- classifyModule("global:fetch")       -> "global"
- classifyModule("global:process")     -> "global"
- classifyModule("./utils.js")         -> "local"
- classifyModule("../helpers/math.js") -> "local"
- classifyModule("axios")              -> "external"
*/

const EXTRA_BUILTIN_SUBPATHS = new Set([
  "fs/promises",
  "timers/promises",
  "stream/promises",
  "stream/consumers",
  "dns/promises",
  "readline/promises",
]);

function normalizeModuleName(moduleName) {
  return String(moduleName || "").trim().replace(/^node:/, "");
}

function isLocalModule(moduleName) {
  const name = String(moduleName || "").trim();

  return (
    name.startsWith("./") ||
    name.startsWith("../") ||
    name.startsWith("/") ||
    name.startsWith("file:")
  );
}

function isGlobalModule(moduleName) {
  return String(moduleName || "").trim().startsWith("global:");
}

function isBuiltinModule(moduleName) {
  const normalized = normalizeModuleName(moduleName);

  if (!normalized) return false;

  if (builtinModules.includes(normalized)) return true;
  if (EXTRA_BUILTIN_SUBPATHS.has(normalized)) return true;

  const root = normalized.split("/")[0];

  /*
   * Handles builtin subpaths conservatively.
   * Examples:
   * - fs/promises       -> fs root is builtin
   * - node:fs/promises  -> fs root is builtin
   */
  return builtinModules.includes(root);
}

export function classifyModule(moduleName) {
  const name = String(moduleName || "").trim();

  if (!name) return "external";

  if (isGlobalModule(name)) return "global";
  if (isLocalModule(name)) return "local";
  if (isBuiltinModule(name)) return "builtin";

  return "external";
}

export function normalizeClassifiedModuleName(moduleName) {
  return normalizeModuleName(moduleName);
}