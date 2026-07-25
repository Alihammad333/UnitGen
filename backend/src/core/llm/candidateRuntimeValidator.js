/**
 * candidateRuntimeValidator.js
 *
 * Purpose:
 * Runtime-validates LLM-generated candidate tests before final injection.
 *
 * Flow:
 * LLM candidate
 *   -> sanitizer in llmFillTests.js
 *   -> temporary injection into generated Jest file
 *   -> run only that test file
 *   -> keep runtime-passing candidates
 *   -> expose only genuinely repairable runtime-failing LLM candidates
 *
 * Important design rules:
 * - Do not permanently write failing candidates here.
 * - Always restore the original template after each validation attempt.
 * - Validate syntax before running Jest.
 * - Run only the current test file, not the whole suite.
 * - Support accumulated validation so multiple passing candidates are stable together.
 * - Do not loosen sanitizer rules here.
 * - Do not decide final repair-candidate injection here; only expose safe metadata.
 */

import fs from "fs";
import { parse } from "@babel/parser";

const UNITGEN_LLM_MARKER = "/*__UNITGEN_LLM_TESTS__*/";
export const UNITGEN_REPAIR_CANDIDATE_MARKER = "__UNITGEN_REPAIR_CANDIDATE__";

function parseJavaScriptModule(code) {
  parse(String(code || ""), {
    sourceType: "module",
    plugins: [
      "topLevelAwait",
      "dynamicImport",
      "importMeta",
      "classProperties",
      "objectRestSpread",
      "optionalChaining",
      "nullishCoalescingOperator",
    ],
  });
}

function safeErrorMessage(error, maxLength = 900) {
  const message =
    typeof error === "string"
      ? error
      : error?.message || error?.stderr || error?.stdout || String(error || "");

  return String(message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function hasTemplateMarker(template) {
  return String(template || "").includes(UNITGEN_LLM_MARKER);
}

function buildCandidateFileContent({
  template,
  candidate,
  acceptedCases = [],
  buildTestBlocks,
  isAsync = false,
}) {
  if (!hasTemplateMarker(template)) {
    throw new Error("Template marker not found during candidate validation.");
  }

  if (typeof buildTestBlocks !== "function") {
    throw new Error("buildTestBlocks function is required for candidate validation.");
  }

  const casesToTest = [...(acceptedCases || []), candidate].filter(Boolean);

  const injected = buildTestBlocks({
    isAsync,
    cases: casesToTest,
  });

  return String(template).replace(UNITGEN_LLM_MARKER, injected);
}

function getFailureCountFromResult(result) {
  if (!result || typeof result !== "object") return 1;

  const directFailed =
    Number(result.numFailedTests || 0) +
    Number(result.numFailedTestSuites || 0) +
    Number(result.numRuntimeErrorTestSuites || 0) +
    Number(result.failedTests || 0) +
    Number(result.failedSuites || 0);

  if (Number.isFinite(directFailed) && directFailed > 0) {
    return directFailed;
  }

  if (Array.isArray(result.testResults)) {
    let failed = 0;

    for (const suite of result.testResults) {
      failed += Number(suite.numFailingTests || 0);
      failed += Number(suite.numRuntimeErrorTestSuites || 0);

      if (suite.status === "failed" && Number(suite.numFailingTests || 0) === 0) {
        failed += 1;
      }

      if (suite.failureMessage && Number(suite.numFailingTests || 0) === 0) {
        failed += 1;
      }
    }

    return failed;
  }

  if (result.success === false) return 1;
  if (result.ok === false) return 1;

  return 0;
}

function doesJestResultPass(result) {
  if (!result) return false;

  if (typeof result === "boolean") return result;

  if (result.success === true) return true;
  if (result.ok === true) return true;

  return getFailureCountFromResult(result) === 0;
}

function extractRuntimeError(result, maxLength = 1200) {
  if (!result) return "Jest returned no result.";

  if (typeof result === "string") return safeErrorMessage(result, maxLength);

  if (result.error) return safeErrorMessage(result.error, maxLength);
  if (result.message) return safeErrorMessage(result.message, maxLength);
  if (result.stderr) return safeErrorMessage(result.stderr, maxLength);
  if (result.stdout && !doesJestResultPass(result)) {
    return safeErrorMessage(result.stdout, maxLength);
  }

  if (Array.isArray(result.testResults)) {
    const messages = [];

    for (const suite of result.testResults) {
      if (suite.failureMessage) {
        messages.push(suite.failureMessage);
      }

      if (suite.message) {
        messages.push(suite.message);
      }

      for (const assertion of suite.assertionResults || []) {
        if (assertion.status === "failed") {
          messages.push(assertion.failureMessages?.join("\n") || assertion.title);
        }
      }
    }

    if (messages.length > 0) {
      return safeErrorMessage(messages.join("\n"), maxLength);
    }
  }

  if (!doesJestResultPass(result)) {
    try {
      return safeErrorMessage(JSON.stringify(result), maxLength);
    } catch {
      return "Jest candidate validation failed.";
    }
  }

  return "";
}

function extractFailedAssertionTitles(result) {
  const titles = [];

  if (!result || !Array.isArray(result.testResults)) return titles;

  for (const suite of result.testResults) {
    for (const assertion of suite.assertionResults || []) {
      if (assertion.status === "failed" && assertion.title) {
        titles.push(assertion.title);
      }
    }
  }

  return [...new Set(titles)];
}

/* ======================================================
   STRICT FAILURE CLASSIFICATION
====================================================== */

function hasNonRepairableRuntimeSignal(errorMessage = "") {
  const error = String(errorMessage || "").toLowerCase();

  return (
    error.includes("typeerror") ||
    error.includes("referenceerror") ||
    error.includes("rangeerror") ||
    error.includes("syntaxerror") ||
    error.includes("is not a function") ||
    error.includes("is not defined") ||
    error.includes("cannot read properties") ||
    error.includes("cannot read property") ||
    error.includes("cannot find module") ||
    error.includes("module not found") ||
    error.includes("err_module_not_found") ||
    error.includes("bad geo point arguments") ||
    error.includes("invalid input argument") ||
    error.includes("must provide either") ||
    error.includes("enoent") ||
    error.includes("eacces") ||
    error.includes("eperm") ||
    error.includes("timed out") ||
    error.includes("exceeded timeout")
  );
}

function isJestExpectationFailure(errorMessage = "") {
  const error = String(errorMessage || "");

  return (
    /expect\(received\)/i.test(error) ||
    /Expected:/i.test(error) ||
    /Received:/i.test(error) ||
    /Expected\s+-/i.test(error) ||
    /Received\s+\+/i.test(error) ||
    /Object\.is equality/i.test(error) ||
    /deep equality/i.test(error) ||
    /toEqual|toStrictEqual|toBeCloseTo|toBeNull|toBeUndefined|toBeTruthy|toBeFalsy|toBe\(/i.test(error) ||
    /AssertionError/i.test(error)
  );
}

function classifyAssertionOracleFailure(errorMessage = "") {
  const error = String(errorMessage || "");

  if (/toBeCloseTo|Expected precision|Received difference/i.test(error)) {
    return "NUMERIC_ORACLE_FAILURE";
  }

  if (/toEqual|toStrictEqual|deep equality|Expected\s+-|Received\s+\+/i.test(error)) {
    return "DEEP_EQUALITY_ORACLE_FAILURE";
  }

  // Jest throw failures can also mention a resolved value such as "undefined".
  // Classify the matcher first so speculative throw oracles are not treated as
  // repairable value-oracle failures.
  if (/toThrow|did not throw|received function did not throw/i.test(error)) {
    return "THROW_ORACLE_FAILURE";
  }

  if (/toBeNull|to be null|null/i.test(error) && /Received/i.test(error)) {
    return "NULL_ORACLE_FAILURE";
  }

  if (/toBeUndefined|undefined/i.test(error) && /Received/i.test(error)) {
    return "UNDEFINED_ORACLE_FAILURE";
  }

  if (
    /Expected:\s*(true|false)/i.test(error) ||
    /Received:\s*(true|false)/i.test(error) ||
    /toBeTruthy|toBeFalsy/i.test(error)
  ) {
    return "BOOLEAN_ORACLE_FAILURE";
  }

  if (/Object\.is equality|toBe\(/i.test(error)) {
    return "VALUE_ORACLE_FAILURE";
  }


  if (isJestExpectationFailure(error)) {
    return "ASSERTION_ORACLE_FAILURE";
  }

  return "";
}

function classifyRuntimeFailure(errorMessage = "", jestResult = null) {
  const error = String(errorMessage || "");

  if (hasNonRepairableRuntimeSignal(error)) {
    if (/typeerror|is not a function|cannot read propert/i.test(error)) {
      return "NON_REPAIRABLE_TYPE_ERROR";
    }

    if (/referenceerror|is not defined/i.test(error)) {
      return "NON_REPAIRABLE_REFERENCE_ERROR";
    }

    if (/rangeerror|bad .* arguments|invalid input argument|must provide either/i.test(error)) {
      return "NON_REPAIRABLE_INPUT_ERROR";
    }

    if (/cannot find module|module not found|err_module_not_found/i.test(error)) {
      return "NON_REPAIRABLE_MODULE_ERROR";
    }

    if (/enoent|eacces|eperm|file|directory|path/i.test(error)) {
      return "NON_REPAIRABLE_FILESYSTEM_ERROR";
    }

    if (/timeout|timed out|exceeded timeout/i.test(error)) {
      return "NON_REPAIRABLE_TIMEOUT";
    }

    if (/syntaxerror|unexpected token|unexpected end of input/i.test(error)) {
      return "NON_REPAIRABLE_RUNTIME_SYNTAX_ERROR";
    }

    return "NON_REPAIRABLE_RUNTIME_ERROR";
  }

  const oracleFailureType = classifyAssertionOracleFailure(error);
  if (oracleFailureType) {
    return oracleFailureType;
  }

  if (jestResult && getFailureCountFromResult(jestResult) > 0) {
    return "NON_REPAIRABLE_UNKNOWN_RUNTIME_FAILURE";
  }

  return "UNKNOWN_RUNTIME_FAILURE";
}

function isRepairableRuntimeFailure(failureType, errorMessage = "") {
  if (hasNonRepairableRuntimeSignal(errorMessage)) {
    return false;
  }

  return [
    "NUMERIC_ORACLE_FAILURE",
    "DEEP_EQUALITY_ORACLE_FAILURE",
    "NULL_ORACLE_FAILURE",
    "UNDEFINED_ORACLE_FAILURE",
    "BOOLEAN_ORACLE_FAILURE",
    "VALUE_ORACLE_FAILURE",
    "ASSERTION_ORACLE_FAILURE",
  ].includes(failureType);
}

function getCandidateTitle(candidate, fallback = "LLM runtime-failing candidate") {
  const explicitTitle =
    candidate?.title ||
    candidate?.name ||
    candidate?.testName ||
    candidate?.description ||
    "";

  if (explicitTitle) return String(explicitTitle).trim();

  const assertCode = String(candidate?.assert || "");
  const actCode = String(candidate?.act || "");

  if (assertCode.includes("toThrow")) return "Repair candidate - throw expectation";
  if (assertCode.includes("toBeCloseTo")) return "Repair candidate - numeric expectation";
  if (assertCode.includes("toEqual") || assertCode.includes("toStrictEqual")) {
    return "Repair candidate - equality expectation";
  }
  if (assertCode.includes("toBe")) return "Repair candidate - value expectation";
  if (actCode) return "Repair candidate - runtime behavior";

  return fallback;
}

function buildRepairCandidateRecord({
  candidate,
  reason,
  error,
  jestResult,
  source = "llm",
}) {
  const failureType = classifyRuntimeFailure(error, jestResult);
  const failedAssertionTitles = extractFailedAssertionTitles(jestResult);
  const repairable =
    reason === "RUNTIME_FAILED" &&
    isRepairableRuntimeFailure(failureType, error);

  return {
    candidate,
    source,
    reason,
    runtimeReason: reason,
    failureType,
    repairable,
    marker: UNITGEN_REPAIR_CANDIDATE_MARKER,
    title: getCandidateTitle(candidate, failedAssertionTitles[0]),
    failedAssertionTitles,
    error: safeErrorMessage(error, 1600),
    arrange: candidate?.arrange || "",
    act: candidate?.act || "",
    assert: candidate?.assert || "",
    isRuntimeFailingCandidate: reason === "RUNTIME_FAILED",
  };
}

function createEmptyRuntimeStats() {
  return {
    attempted: 0,
    passed: 0,
    failed: 0,
    syntaxFailed: 0,
    runnerFailed: 0,
    skipped: 0,
    runtimeFailedCandidates: 0,
    repairableRuntimeCandidates: 0,
    nonRepairableRuntimeCandidates: 0,
    reasons: {},
    failureTypes: {},
  };
}

function addRuntimeReason(stats, reason, failureType = "", errorMessage = "") {
  if (!stats || !reason) return;

  stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;

  if (failureType) {
    stats.failureTypes[failureType] = (stats.failureTypes[failureType] || 0) + 1;
  }

  if (reason === "RUNTIME_PASSED") {
    stats.passed += 1;
    return;
  }

  if (reason === "SYNTAX_FAILED") {
    stats.syntaxFailed += 1;
    stats.failed += 1;
    return;
  }

  if (reason === "RUNNER_FAILED") {
    stats.runnerFailed += 1;
    stats.failed += 1;
    return;
  }

  if (reason === "SKIPPED_MAX_REACHED") {
    stats.skipped += 1;
    return;
  }

  if (reason === "RUNTIME_FAILED") {
    stats.runtimeFailedCandidates += 1;

    if (isRepairableRuntimeFailure(failureType, errorMessage)) {
      stats.repairableRuntimeCandidates += 1;
    } else {
      stats.nonRepairableRuntimeCandidates += 1;
    }
  }

  stats.failed += 1;
}

const DEFAULT_RUNTIME_CONFIRMATION_RUNS = Math.max(
  1,
  Number(process.env.UNITGEN_RUNTIME_CONFIRMATION_RUNS || 1)
);
const NONDETERMINISTIC_RUNTIME_CONFIRMATION_RUNS = Math.max(
  DEFAULT_RUNTIME_CONFIRMATION_RUNS,
  Number(process.env.UNITGEN_NONDETERMINISTIC_RUNTIME_CONFIRMATION_RUNS || 5)
);

function candidateLooksNondeterministic(candidate = "") {
  const code = String(candidate || "");

  return /\b(Math\.random|random|randomInteger|chance|Date\.now|performance\.now|setTimeout|setInterval)\b/i.test(code) ||
    /\bnew\s+Date\s*\(/i.test(code);
}

function getRuntimeConfirmationRuns(candidate = "") {
  return candidateLooksNondeterministic(candidate)
    ? NONDETERMINISTIC_RUNTIME_CONFIRMATION_RUNS
    : DEFAULT_RUNTIME_CONFIRMATION_RUNS;
}

export async function validateLlmCandidate({
  ctx,
  template,
  candidate,
  acceptedCases = [],
  buildTestBlocks,
  runJestForFile,
  isAsync = false,
}) {
  const testFilePath = ctx?.testFilePath;

  if (!testFilePath) {
    return {
      ok: false,
      reason: "MISSING_TEST_FILE_PATH",
      candidate,
      error: "ctx.testFilePath is missing.",
      jestResult: null,
      failureType: "VALIDATION_SETUP_ERROR",
      repairCandidate: null,
    };
  }

  if (!hasTemplateMarker(template)) {
    return {
      ok: false,
      reason: "MISSING_TEMPLATE_MARKER",
      candidate,
      error: "Template marker not found.",
      jestResult: null,
      failureType: "VALIDATION_SETUP_ERROR",
      repairCandidate: null,
    };
  }

  if (!candidate) {
    return {
      ok: false,
      reason: "MISSING_CANDIDATE",
      candidate,
      error: "Candidate is missing.",
      jestResult: null,
      failureType: "VALIDATION_SETUP_ERROR",
      repairCandidate: null,
    };
  }

  if (typeof runJestForFile !== "function") {
    return {
      ok: false,
      reason: "MISSING_RUNNER",
      candidate,
      error: "runJestForFile function is missing.",
      jestResult: null,
      failureType: "VALIDATION_SETUP_ERROR",
      repairCandidate: null,
    };
  }

  let candidateContent = "";

  try {
    candidateContent = buildCandidateFileContent({
      template,
      candidate,
      acceptedCases,
      buildTestBlocks,
      isAsync,
    });

    parseJavaScriptModule(candidateContent);
  } catch (error) {
    return {
      ok: false,
      reason: "SYNTAX_FAILED",
      candidate,
      error: safeErrorMessage(error),
      jestResult: null,
      failureType: "SYNTAX_FAILED",
      repairCandidate: null,
    };
  }

  try {
    fs.writeFileSync(testFilePath, candidateContent, "utf8");

    const confirmationRuns = getRuntimeConfirmationRuns(candidate);
    let lastPassingResult = null;

    for (let runIndex = 0; runIndex < confirmationRuns; runIndex += 1) {
      const jestResult = await runJestForFile(testFilePath);

      if (doesJestResultPass(jestResult)) {
        lastPassingResult = jestResult;
        continue;
      }

      const error = extractRuntimeError(jestResult);
      const reason = runIndex === 0 ? "RUNTIME_FAILED" : "RUNTIME_FLAKY";
      const repairCandidate =
        reason === "RUNTIME_FAILED"
          ? buildRepairCandidateRecord({
              candidate,
              reason,
              error,
              jestResult,
              source: "llm",
            })
          : null;

      return {
        ok: false,
        reason,
        candidate,
        error,
        jestResult,
        failureType:
          repairCandidate?.failureType ||
          (reason === "RUNTIME_FLAKY" ? "NONDETERMINISTIC_RUNTIME_FAILURE" : ""),
        repairCandidate,
      };
    }

    return {
      ok: true,
      reason: "RUNTIME_PASSED",
      candidate,
      error: "",
      jestResult: lastPassingResult,
      failureType: "",
      repairCandidate: null,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "RUNNER_FAILED",
      candidate,
      error: safeErrorMessage(error),
      jestResult: null,
      failureType: "RUNNER_FAILED",
      repairCandidate: null,
    };
  } finally {
    try {
      fs.writeFileSync(testFilePath, template, "utf8");
    } catch {
      // Do not throw from cleanup.
    }
  }
}

export async function selectRuntimePassingCases({
  ctx,
  template,
  candidates = [],
  buildTestBlocks,
  runJestForFile,
  isAsync = false,
  maxPassing = 3,
}) {
  const passingCases = [];
  const failedCandidates = [];
  const repairCandidates = [];
  const stats = createEmptyRuntimeStats();

  const safeCandidates = Array.isArray(candidates) ? candidates : [];

  for (const candidate of safeCandidates) {
    if (passingCases.length >= maxPassing) {
      stats.attempted += 1;
      addRuntimeReason(stats, "SKIPPED_MAX_REACHED");
      continue;
    }

    stats.attempted += 1;

    const result = await validateLlmCandidate({
      ctx,
      template,
      candidate,
      acceptedCases: passingCases,
      buildTestBlocks,
      runJestForFile,
      isAsync,
    });

    addRuntimeReason(stats, result.reason, result.failureType, result.error);

    if (result.ok) {
      passingCases.push(candidate);
    } else {
      const failedCandidate = {
        candidate,
        reason: result.reason,
        error: result.error || "",
        failureType: result.failureType || "",
        repairable: Boolean(result.repairCandidate?.repairable),
        repairCandidate: result.repairCandidate || null,
      };

      failedCandidates.push(failedCandidate);

      if (result.repairCandidate?.repairable) {
        repairCandidates.push(result.repairCandidate);
      }
    }
  }

  return {
    passingCases,
    failedCandidates,
    repairCandidates,
    stats,
  };
}

export function buildFinalInjectedContent({
  template,
  cases = [],
  buildTestBlocks,
  isAsync = false,
}) {
  if (!hasTemplateMarker(template)) {
    throw new Error("Template marker not found while building final injected content.");
  }

  const injected = buildTestBlocks({
    isAsync,
    cases: Array.isArray(cases) ? cases : [],
  });

  return String(template).replace(UNITGEN_LLM_MARKER, injected);
}

export function summarizeRuntimeValidation(stats = {}) {
  const reasons = stats.reasons || {};
  const failureTypes = stats.failureTypes || {};

  const reasonEntries = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  const failureTypeEntries = Object.entries(failureTypes).sort((a, b) => b[1] - a[1]);

  return {
    attempted: stats.attempted || 0,
    passed: stats.passed || 0,
    failed: stats.failed || 0,
    syntaxFailed: stats.syntaxFailed || 0,
    runnerFailed: stats.runnerFailed || 0,
    skipped: stats.skipped || 0,
    runtimeFailedCandidates: stats.runtimeFailedCandidates || 0,
    repairableRuntimeCandidates: stats.repairableRuntimeCandidates || 0,
    nonRepairableRuntimeCandidates: stats.nonRepairableRuntimeCandidates || 0,
    reasons: Object.fromEntries(reasonEntries),
    failureTypes: Object.fromEntries(failureTypeEntries),
  };
}