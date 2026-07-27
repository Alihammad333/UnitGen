// src/core/testgen/generatedTestPreflight.js

import fs from "fs";
import path from "path";
import {
  runJest,
  runJestForFile,
} from "../runner/jestRunner.js";
import { removeRepairCandidateBlocks } from "../repair/repairLoop.js";

function getJestJson(result) {
  if (!result) return null;

  if (result?.json && typeof result.json === "object") {
    return result.json;
  }

  if (
    typeof result === "object" &&
    (
      "numTotalTests" in result ||
      "testResults" in result ||
      "numFailedTests" in result ||
      "numFailedTestSuites" in result ||
      "numRuntimeErrorTestSuites" in result
    )
  ) {
    return result;
  }

  return null;
}

function deleteFileSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // never crash pipeline during cleanup
  }
}

function fileHasRepairCandidate(filePath) {
  try {
    const code = fs.readFileSync(filePath, "utf8");

    return (
      code.includes("[repair-candidate]") ||
      code.includes("__UNITGEN_REPAIR_CANDIDATE__")
    );
  } catch {
    return false;
  }
}

async function salvagePassingTestsByRemovingRepairCandidates(testFilePath) {
  let originalCode = null;

  try {
    originalCode = fs.readFileSync(testFilePath, "utf8");
    const { code: cleanedCode, removed } =
      removeRepairCandidateBlocks(originalCode);

    if (removed <= 0 || cleanedCode === originalCode) return null;

    fs.writeFileSync(testFilePath, cleanedCode, "utf8");
    const result = await runJestForFile(testFilePath);

    if (!isUnrecoverableJestResult(result) && getFailureCount(result) === 0) {
      console.log(
        `⚠️ Removed ${removed} failing repair candidate(s) but preserved passing tests in dynamic file: ${testFilePath}`
      );
      return result;
    }

    fs.writeFileSync(testFilePath, originalCode, "utf8");
    return null;
  } catch {
    if (originalCode !== null) {
      try {
        fs.writeFileSync(testFilePath, originalCode, "utf8");
      } catch {
        // Preserve the normal preflight fallback if rollback is unavailable.
      }
    }
    return null;
  }
}

function collectRunnerText(result) {
  const chunks = [];

  if (!result) return "";

  if (result.runnerStdout) chunks.push(result.runnerStdout);
  if (result.runnerStderr) chunks.push(result.runnerStderr);

  if (result.runnerError?.stdout) chunks.push(result.runnerError.stdout);
  if (result.runnerError?.stderr) chunks.push(result.runnerError.stderr);

  if (result.stdout) chunks.push(result.stdout);
  if (result.stderr) chunks.push(result.stderr);
  if (result.output) chunks.push(result.output);
  if (result.message) chunks.push(result.message);
  if (result.error) chunks.push(String(result.error));

  return chunks.join("\n");
}

function hasFatalProcessCrash(result) {
  const text = collectRunnerText(result).toLowerCase();

  return (
    text.includes("triggeruncaughtexception") ||
    text.includes("uncaught exception") ||
    text.includes("unhandledrejection") ||
    text.includes("unhandled rejection") ||
    text.includes("node:internal/process/promises") ||
    text.includes("node:internal/process/task_queues") ||
    text.includes("bad file descriptor") ||
    text.includes("ebadf") ||
    text.includes("eisdir") ||
    text.includes("emfile") ||
    text.includes("enotdir") ||
    Boolean(result?.runnerSignal)
  );
}

function getFailureCount(result) {
  const json = getJestJson(result);
  if (!json) return 1;

  return (
    Number(json.numFailedTests || 0) +
    Number(json.numFailedTestSuites || 0) +
    Number(json.numRuntimeErrorTestSuites || 0)
  );
}

function isSyntheticNoJsonResult(result) {
  return (
    result?.runnerError &&
    Number(result.numTotalTests || 0) === 0 &&
    Number(result.numTotalTestSuites || 0) === 0
  );
}

export function isUnrecoverableJestResult(result) {
  const json = getJestJson(result);

  if (!json) return true;
  if (isSyntheticNoJsonResult(result)) return true;
  if (hasFatalProcessCrash(result)) return true;

  const totalTests = Number(json.numTotalTests || 0);
  const totalSuites = Number(json.numTotalTestSuites || 0);
  const runtimeSuites = Number(json.numRuntimeErrorTestSuites || 0);

  if (totalTests === 0 && totalSuites === 0) return true;
  if (totalTests === 0 && runtimeSuites > 0) return true;

  return false;
}

function groupContextsByFile(contexts = []) {
  const map = new Map();

  for (const ctx of contexts || []) {
    if (!ctx?.testFilePath) continue;

    if (!map.has(ctx.testFilePath)) {
      map.set(ctx.testFilePath, []);
    }

    map.get(ctx.testFilePath).push(ctx);
  }

  return map;
}

function isDynamicApiFile(fileContexts = []) {
  return fileContexts.some((ctx) => ctx?.isDynamicApi);
}

function removeFileAndContexts({
  testFilePath,
  fileContexts,
  safeContexts,
}) {
  deleteFileSafe(testFilePath);

  return safeContexts.filter(
    (ctx) => !fileContexts.includes(ctx)
  );
}

function extractCrashHints(result) {
  const text = collectRunnerText(result).toLowerCase();
  const hints = new Set();

  const syscallMatch = text.match(/syscall:\s*['"]([^'"]+)['"]/i);
  if (syscallMatch?.[1]) {
    hints.add(syscallMatch[1].toLowerCase());
  }

  const commonFsNames = [
    "appendfile",
    "chown",
    "chmod",
    "close",
    "copyfile",
    "cp",
    "fdatasync",
    "fstat",
    "fsync",
    "ftruncate",
    "futimes",
    "lchown",
    "lchmod",
    "link",
    "lstat",
    "lutimes",
    "mkdir",
    "mkdtemp",
    "open",
    "opendir",
    "readdir",
    "read",
    "readfile",
    "readlink",
    "realpath",
    "rename",
    "rm",
    "rmdir",
    "stat",
    "statfs",
    "symlink",
    "truncate",
    "unlink",
    "utimes",
    "watch",
    "watchfile",
    "write",
    "writefile",
    "writev",
  ];

  for (const name of commonFsNames) {
    if (text.includes(name)) {
      hints.add(name);
    }
  }

  return Array.from(hints);
}

function fileNameMatchesCrashHints(testFilePath, hints = []) {
  const base = path.basename(testFilePath).toLowerCase();

  return hints.some((hint) => {
    const h = String(hint || "").toLowerCase();
    return h && base.includes(h);
  });
}

async function runFullSuiteSafetyPass({
  safeContexts,
  perFileResults,
  maxRounds = 3,
}) {
  let currentContexts = [...safeContexts];

  for (let round = 1; round <= maxRounds; round++) {
    const result = await runJest();

    if (!isUnrecoverableJestResult(result)) {
      return currentContexts;
    }

    console.log(
      `⚠️ Full-suite preflight found unrecoverable Jest crash. Cleanup round ${round}/${maxRounds}.`
    );

    const grouped = groupContextsByFile(currentContexts);
    const crashHints = extractCrashHints(result);

    let removedAny = false;

    for (const [testFilePath, fileContexts] of grouped.entries()) {
      if (!isDynamicApiFile(fileContexts)) continue;
      if (!fileNameMatchesCrashHints(testFilePath, crashHints)) continue;

      console.log(`⚠️ Removing crash-linked dynamic test file: ${testFilePath}`);

      currentContexts = removeFileAndContexts({
        testFilePath,
        fileContexts,
        safeContexts: currentContexts,
      });

      removedAny = true;
    }

    if (removedAny) continue;

    for (const [testFilePath, fileContexts] of grouped.entries()) {
      if (!isDynamicApiFile(fileContexts)) continue;

      const individualResult = perFileResults.get(testFilePath);
      if (!individualResult) continue;

      if (getFailureCount(individualResult) > 0) {
        const salvagedResult =
          await salvagePassingTestsByRemovingRepairCandidates(testFilePath);

        if (salvagedResult) {
          perFileResults.set(testFilePath, salvagedResult);
          removedAny = true;
          continue;
        }

        console.log(
          `⚠️ Removing failing dynamic test file after suite crash: ${testFilePath}`
        );

        currentContexts = removeFileAndContexts({
          testFilePath,
          fileContexts,
          safeContexts: currentContexts,
        });

        removedAny = true;
      }
    }

    if (!removedAny) {
      console.log("⚠️ Could not isolate crashing generated test file automatically.");
      return currentContexts;
    }
  }

  return currentContexts;
}

export async function preflightGeneratedTestFilesAfterLLM(contexts = []) {
  const safeContexts = [];
  const seenFiles = groupContextsByFile(contexts);
  const perFileResults = new Map();

  let keptFiles = 0;
  let removedFiles = 0;

  console.log("\n🛡️ Running post-LLM generated test preflight...\n");

  for (const [testFilePath, fileContexts] of seenFiles.entries()) {
    if (!fs.existsSync(testFilePath)) {
      removedFiles++;
      continue;
    }

    try {
      const result = await runJestForFile(testFilePath);
      perFileResults.set(testFilePath, result);

      if (isUnrecoverableJestResult(result)) {
        console.log(`⚠️ Removing unrecoverable generated test file: ${testFilePath}`);
        deleteFileSafe(testFilePath);
        removedFiles++;
        continue;
      }

      if (getFailureCount(result) > 0 && !fileHasRepairCandidate(testFilePath)) {
        console.log(
          `⚠️ Removing failed prototype-only generated test file: ${testFilePath}`
        );
        deleteFileSafe(testFilePath);
        removedFiles++;
        continue;
      }

      safeContexts.push(...fileContexts);
      keptFiles++;
      console.log(`✅ Post-LLM preflight kept: ${testFilePath}`);
    } catch (err) {
      console.log(
        `⚠️ Removing crashed generated test file: ${testFilePath} (${err?.message || err})`
      );
      deleteFileSafe(testFilePath);
      removedFiles++;
    }
  }

  const finalContexts = await runFullSuiteSafetyPass({
    safeContexts,
    perFileResults,
  });

  const finalFiles = countUniqueTestFiles(finalContexts);
  const removedBySuitePass = keptFiles - finalFiles;

  console.log(
    `\n🛡️ Post-LLM preflight completed. Kept ${finalFiles} file(s), removed ${
      removedFiles + Math.max(0, removedBySuitePass)
    } unsafe file(s).\n`
  );

  return finalContexts;
}

export function countUniqueTestFiles(contexts = []) {
  return new Set(
    (contexts || [])
      .map((ctx) => ctx?.testFilePath)
      .filter(Boolean)
  ).size;
}
