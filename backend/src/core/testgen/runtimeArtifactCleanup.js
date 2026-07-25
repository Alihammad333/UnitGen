// src/core/testgen/runtimeArtifactCleanup.js

import fs from "fs";
import path from "path";

const PROTECTED_ROOT_NAMES = new Set([
  "src",
  "tests",
  "node_modules",
  "benchmark_packages",
  "output",
  "results",
  "coverage-results",
  "scripts",
  "package.json",
  "package-lock.json",
  "jest.config.cjs",
  "jest.config_backup.js",
  "babel.config.cjs",
  ".env",
  ".gitignore",
]);

function looksLikeGeneratedArgumentFile(name) {
  const extension = path.extname(name);

  // Bare values such as arg1, test, default, or parameter can become files
  // when a generated test passes them to a path-taking API.
  if (!extension && /^[A-Za-z0-9_$-]+$/.test(name)) return true;

  // UnitGen-owned file harness names may contain data and therefore are not
  // restricted to zero-byte files.
  return /^unitgen-temp(?:[-_.].*)?$/i.test(name);
}

export function createRuntimeArtifactSnapshot(rootDir = process.cwd()) {
  const safeRoot = path.resolve(rootDir);

  try {
    return new Set(fs.readdirSync(safeRoot));
  } catch {
    return new Set();
  }
}

export function cleanupRuntimeArtifacts(
  rootDir = process.cwd(),
  { baselineNames = null } = {}
) {
  const safeRoot = path.resolve(rootDir);
  const baseline = baselineNames instanceof Set ? baselineNames : null;

  // Without a run snapshot, ownership cannot be proven. Do nothing.
  if (!baseline) return [];

  let names = [];
  try {
    names = fs.readdirSync(safeRoot);
  } catch {
    return [];
  }

  const removed = [];

  for (const name of names) {
    if (baseline.has(name) || PROTECTED_ROOT_NAMES.has(name)) continue;
    if (!looksLikeGeneratedArgumentFile(name)) continue;

    const fullPath = path.resolve(safeRoot, name);
    if (path.dirname(fullPath) !== safeRoot) continue;

    try {
      const stat = fs.statSync(fullPath);

      // Never remove directories or anything that existed before this run.
      if (!stat.isFile()) continue;

      fs.rmSync(fullPath, { force: true });
      removed.push(name);
    } catch {
      // Cleanup must never break generation or coverage measurement.
    }
  }

  return removed;
}