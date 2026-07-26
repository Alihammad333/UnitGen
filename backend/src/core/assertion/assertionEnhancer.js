// src/core/assertion/assertionEnhancer.js

import fs from "fs";
import path from "path";
import generatorModule from "@babel/generator";

import { parseSource } from "../parser/parseFile.js";
import { validateSyntax } from "../validation/validateSyntax.js";
import { runJest } from "../runner/jestRunner.js";

import { detectAssertions } from "./assertionDetector.js";
import { transformAssertions } from "./assertionTransformer.js";
import {
  observeRuntimeValue,
  isUsefulObservedValue,
  summarizeObservedValueForLog,
} from "./runtimeValueObserver.js";

import { emitEvent } from "../report/eventEmitter.js";
import { recordRepairedAssertion } from "../report/finalReportWriter.js";

const generate = generatorModule.default;

const FAILURE_REPAIR_MATCHER_PRIORITY = new Set([
  "toBeNull",
  "toBeUndefined",
  "toEqual",
  "toStrictEqual",
  "toBeCloseTo",
  "toBe",
  "toThrow",
  "toThrowError",
]);

const RUNTIME_OBSERVABLE_MATCHERS = new Set([
  "toBeDefined",
  "toBeTruthy",
  "toBeFalsy",
  "toBeNull",
  "toBeUndefined",
  "toEqual",
  "toStrictEqual",
  "toBeCloseTo",
  "toBe",
]);

const STABLE_ASSERTION_MAX_ATTEMPTS = Number(
  process.env.UNITGEN_STABLE_ASSERTION_MAX_ATTEMPTS || 80
);
const STABLE_ASSERTION_MAX_REJECTIONS_WITHOUT_ACCEPTANCE = Number(
  process.env.UNITGEN_STABLE_ASSERTION_MAX_REJECTIONS_WITHOUT_ACCEPTANCE || 30
);
const STABLE_ASSERTION_MAX_RUNTIME_MS = Number(
  process.env.UNITGEN_STABLE_ASSERTION_MAX_RUNTIME_MS || 10 * 60 * 1000
);

function createStableAssertionBudget() {
  return {
    startedAt: Date.now(),
    attempts: 0,
    accepted: 0,
    rejected: 0,
  };
}

function getStableBudgetStopReason(budget) {
  if (!budget) return "";

  if (budget.environmentFailure) {
    return "Jest environment failure detected";
  }

  if (
    STABLE_ASSERTION_MAX_RUNTIME_MS > 0 &&
    Date.now() - budget.startedAt >= STABLE_ASSERTION_MAX_RUNTIME_MS
  ) {
    return `stable assertion runtime budget reached (${STABLE_ASSERTION_MAX_RUNTIME_MS}ms)`;
  }

  if (
    STABLE_ASSERTION_MAX_ATTEMPTS > 0 &&
    budget.attempts >= STABLE_ASSERTION_MAX_ATTEMPTS
  ) {
    return `stable assertion attempt budget reached (${STABLE_ASSERTION_MAX_ATTEMPTS})`;
  }

  if (
    STABLE_ASSERTION_MAX_REJECTIONS_WITHOUT_ACCEPTANCE > 0 &&
    budget.accepted === 0 &&
    budget.rejected >= STABLE_ASSERTION_MAX_REJECTIONS_WITHOUT_ACCEPTANCE
  ) {
    return `stable assertion low-yield stop: ${budget.rejected} rejected, 0 accepted`;
  }

  return "";
}

function isDynamicApiExportSmokeTest(filePath) {
  const fileName = path.basename(filePath);

  if (!fileName.includes(".dynamic.")) {
    return false;
  }

  let code = "";
  try {
    code = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }

  const hasExportSmokeAssertion =
    code.includes("__unitgen_target__") &&
    code.includes('expect(typeof __unitgen_target__).toBe("function")') &&
    code.includes("should be exported as a function");

  const executableTestCount = (
    code.match(/\b(?:test|it)\s*\(/g) || []
  ).length;

  // Dynamic files evolve from smoke checks into behavior suites after LLM and
  // fallback injection. Skip only genuine one-test smoke files so behavior
  // assertions remain eligible for strengthening.
  return hasExportSmokeAssertion && executableTestCount <= 1;
}

/* ======================================================
   JEST RESULT NORMALIZATION
====================================================== */
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

function getRunMetrics(result) {
  const json = getJestJson(result) || {};

  return {
    totalTests: Number(json.numTotalTests || 0),
    passedTests: Number(json.numPassedTests || 0),
    failedTests: Number(json.numFailedTests || 0),
    totalSuites: Number(json.numTotalTestSuites || 0),
    passedSuites: Number(json.numPassedTestSuites || 0),
    failedSuites:
      Number(json.numFailedTestSuites || 0) +
      Number(json.numRuntimeErrorTestSuites || 0),
  };
}

function getFailureScore(result) {
  const m = getRunMetrics(result);
  return m.failedTests + m.failedSuites;
}

function isStableRun(result) {
  const m = getRunMetrics(result);
  return m.totalTests > 0 && m.failedTests === 0 && m.failedSuites === 0;
}

function normalizeFilePath(filePath = "") {
  return path.resolve(String(filePath || ""));
}

function normalizeText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function compactText(text = "", max = 450) {
  return normalizeText(text).slice(0, max);
}

function normalizeForLooseMatch(text = "") {
  return normalizeText(text).replace(/\s+/g, "").toLowerCase();
}

/* ======================================================
   FAILED TEST EXTRACTION
====================================================== */
function getFailedFileMap(result) {
  const json = getJestJson(result);
  const map = new Map();

  if (!json?.testResults) return map;

  for (const suite of json.testResults || []) {
    const suiteName = normalizeFilePath(suite?.name || "");
    if (!suiteName) continue;

    const failedAssertions = (suite.assertionResults || []).filter(
      (a) => a.status === "failed"
    );

    const suiteFailed =
      suite.status === "failed" ||
      Number(suite.numFailingTests || 0) > 0 ||
      Number(suite.numRuntimeErrorTestSuites || 0) > 0 ||
      failedAssertions.length > 0 ||
      Boolean(suite.failureMessage || suite.message);

    if (!suiteFailed) continue;

    map.set(suiteName, {
      filePath: suiteName,
      message: suite.failureMessage || suite.message || "",
      failedTests: failedAssertions.map((a) => ({
        title: a.title || "",
        fullName: a.fullName || a.title || "",
        failureMessages: Array.isArray(a.failureMessages)
          ? a.failureMessages
          : [],
      })),
    });
  }

  return map;
}

function getFailedTestsForFile(result, filePath) {
  const failedMap = getFailedFileMap(result);
  const info = failedMap.get(normalizeFilePath(filePath));
  return info?.failedTests || [];
}

function getFailedTestNamesForFile(result, filePath) {
  const failedTests = getFailedTestsForFile(result, filePath);
  const names = new Set();

  for (const failed of failedTests) {
    if (failed.title) names.add(failed.title);
    if (failed.fullName) names.add(failed.fullName);
  }

  return names;
}

function getFailureContextForFile(result, filePath) {
  const failedMap = getFailedFileMap(result);
  const normalized = normalizeFilePath(filePath);
  const info = failedMap.get(normalized);

  if (!info) return "";

  const chunks = [];

  if (info.message) chunks.push(info.message);

  for (const failed of info.failedTests || []) {
    chunks.push(failed.fullName || failed.title || "");
    chunks.push((failed.failureMessages || []).join("\n"));
  }

  return chunks.filter(Boolean).join("\n");
}

function namesLooselyMatch(a = "", b = "") {
  const x = String(a || "");
  const y = String(b || "");

  if (!x || !y) return false;

  return x === y || x.includes(y) || y.includes(x);
}

function getTargetCandidateNames(target = {}) {
  return [
    target?.testName,
    ...(target?.candidateTestNames || []),
  ]
    .filter(Boolean)
    .map((x) => String(x));
}

function findFailedTestMatchingTarget(failedTests = [], target = {}) {
  const targetNames = getTargetCandidateNames(target);

  if (targetNames.length === 0) return null;

  for (const failed of failedTests) {
    const failedNames = [failed.title, failed.fullName].filter(Boolean);

    for (const failedName of failedNames) {
      for (const targetName of targetNames) {
        if (namesLooselyMatch(failedName, targetName)) {
          return failed;
        }
      }
    }
  }

  return null;
}

function getFailureMessageText(failed = {}) {
  return normalizeText((failed.failureMessages || []).join("\n"));
}

function didTargetFailedTestPass(prevResult, nextResult, filePath, target) {
  const prevFailedTests = getFailedTestsForFile(prevResult, filePath);
  const nextFailedTests = getFailedTestsForFile(nextResult, filePath);

  const prevMatched = findFailedTestMatchingTarget(prevFailedTests, target);
  if (!prevMatched) return false;

  const stillFailed = nextFailedTests.some((failed) => {
    return (
      namesLooselyMatch(failed.title, prevMatched.title) ||
      namesLooselyMatch(failed.fullName, prevMatched.fullName)
    );
  });

  return !stillFailed;
}

function targetSourceRemovedOrChanged(prevCode = "", nextCode = "", target = {}) {
  const source = normalizeText(target?.source || "");
  if (!source || source.length < 8) return false;

  const prevNormalized = normalizeText(prevCode);
  const nextNormalized = normalizeText(nextCode);

  if (prevNormalized.includes(source) && !nextNormalized.includes(source)) {
    return true;
  }

  const looseSource = normalizeForLooseMatch(source);
  const prevLoose = normalizeForLooseMatch(prevCode);
  const nextLoose = normalizeForLooseMatch(nextCode);

  if (
    looseSource.length >= 8 &&
    prevLoose.includes(looseSource) &&
    !nextLoose.includes(looseSource)
  ) {
    return true;
  }

  return false;
}

function targetLikelyAppearsInFailureMessage(target = {}, failed = {}) {
  const message = normalizeText(getFailureMessageText(failed));
  const matcher = normalizeText(target?.matcher || "");
  const source = normalizeText(target?.source || "");

  if (!message) return false;
  if (source && message.includes(source)) return true;
  if (matcher && message.toLowerCase().includes(matcher.toLowerCase())) return true;

  const looseMessage = normalizeForLooseMatch(message);
  const looseSource = normalizeForLooseMatch(source);

  return looseSource.length >= 8 && looseMessage.includes(looseSource);
}

function didSameTestMoveToDifferentAssertion({
  prev,
  next,
  filePath,
  target,
}) {
  const prevFailedTests = getFailedTestsForFile(prev, filePath);
  const nextFailedTests = getFailedTestsForFile(next, filePath);

  const prevMatched = findFailedTestMatchingTarget(prevFailedTests, target);
  if (!prevMatched) return false;

  const nextMatched = nextFailedTests.find((failed) => {
    return (
      namesLooselyMatch(failed.title, prevMatched.title) ||
      namesLooselyMatch(failed.fullName, prevMatched.fullName)
    );
  });

  if (!nextMatched) return false;

  const prevMessage = compactText(getFailureMessageText(prevMatched), 1200);
  const nextMessage = compactText(getFailureMessageText(nextMatched), 1200);

  if (!prevMessage || !nextMessage) return false;
  if (prevMessage === nextMessage) return false;

  const sourceChanged = targetSourceRemovedOrChanged(
    prev.codeSnapshot || "",
    next.codeSnapshot || "",
    target
  );

  if (!sourceChanged) return false;

  const previousFailureTouchedTarget = targetLikelyAppearsInFailureMessage(
    target,
    prevMatched
  );

  if (previousFailureTouchedTarget || target?.isRepairCandidateTest) {
    console.log(
      "✨ Failed-test repair accepted: target assertion changed and same test moved to a different failure."
    );
    return true;
  }

  return false;
}

/* ======================================================
   PASSING REGRESSION CHECK
====================================================== */
function getPassingTestTitles(result) {
  const json = getJestJson(result);
  if (!json?.testResults) return [];

  return json.testResults
    .flatMap((suite) => suite.assertionResults || [])
    .filter((t) => t.status === "passed")
    .map((t) => t.fullName || t.title)
    .filter(Boolean);
}

function hasPassingRegression(prevResult, nextResult) {
  const prevPassing = getPassingTestTitles(prevResult);
  const nextPassing = getPassingTestTitles(nextResult);

  return prevPassing.some((title) => !nextPassing.includes(title));
}

/* ======================================================
   LEARNING DATABASE
====================================================== */
const learningDB = {};

function updateLearning(detection, prevResult, nextResult, accepted) {
  const detections = Array.isArray(detection) ? detection : [detection];

  const prevFails = getFailureScore(prevResult);
  const nextFails = getFailureScore(nextResult);

  for (const d of detections) {
    if (!d?.matcher) continue;

    if (!learningDB[d.matcher]) {
      learningDB[d.matcher] = { success: 0, failures: 0 };
    }

    if (accepted || nextFails < prevFails) {
      learningDB[d.matcher].success += 1;
    } else if (nextFails > prevFails) {
      learningDB[d.matcher].failures += 1;
    } else {
      if (prevFails === 0) {
        learningDB[d.matcher].failures += 0.2;
      } else {
        learningDB[d.matcher].failures += 0.1;
      }
    }
  }

  console.log(
    "📚 Learning DB State Updated:",
    JSON.stringify(learningDB, null, 2)
  );
}

/* ======================================================
   RECURSIVE FILE DISCOVERY
====================================================== */
function getTestFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      results = results.concat(getTestFiles(filePath));
    } else if (file.endsWith(".test.js")) {
      results.push(filePath);
    }
  }

  return results;
}

/* ======================================================
   TARGET HELPERS
====================================================== */
function targetAppearsInFailure(target, failureContext = "") {
  const context = normalizeText(failureContext);
  const source = normalizeText(target?.source || "");
  const matcher = normalizeText(target?.matcher || "");

  if (!context) return false;

  if (source && context.includes(source)) return true;
  if (matcher && context.toLowerCase().includes(matcher.toLowerCase())) return true;

  const compactSource = source.replace(/\s+/g, "");
  const compactContext = context.replace(/\s+/g, "");

  return compactSource.length > 10 && compactContext.includes(compactSource);
}

function targetBelongsToFailedTest(target, failedTestNames = new Set()) {
  if (!target?.testName || failedTestNames.size === 0) return false;

  const targetName = String(target.testName);

  for (const failed of failedTestNames) {
    if (
      failed === targetName ||
      failed.includes(targetName) ||
      targetName.includes(failed)
    ) {
      return true;
    }
  }

  return false;
}

function isWeakOrInvalidTarget(target = {}) {
  return target.type === "WEAK" || target.type === "INVALID";
}

function isOracleFailureTarget(target = {}) {
  return FAILURE_REPAIR_MATCHER_PRIORITY.has(target.matcher);
}

function isActionableTarget(
  target = {},
  {
    mode = "stable",
    failedTestNames = new Set(),
    failureContext = "",
  } = {}
) {
  if (!target?.matcher) return false;

  if (mode !== "failed") {
    return isWeakOrInvalidTarget(target);
  }

  if (isWeakOrInvalidTarget(target)) return true;

  if (
    isOracleFailureTarget(target) &&
    (
      targetBelongsToFailedTest(target, failedTestNames) ||
      targetAppearsInFailure(target, failureContext) ||
      target.isRepairCandidateTest
    )
  ) {
    return true;
  }

  if (
    RUNTIME_OBSERVABLE_MATCHERS.has(target.matcher) &&
    (
      targetBelongsToFailedTest(target, failedTestNames) ||
      targetAppearsInFailure(target, failureContext)
    )
  ) {
    return true;
  }

  return false;
}

/* ======================================================
   ASSERTION QUALITY HELPERS
====================================================== */
function getOptimizationTargetsFromCode(code, options = {}) {
  try {
    const ast = parseSource(code);
    const detections = detectAssertions(ast, learningDB) || [];

    return detections.filter((d) => isActionableTarget(d, options));
  } catch {
    return [];
  }
}

function getAssertionQualityScore(code) {
  const targets = getOptimizationTargetsFromCode(code, { mode: "stable" });

  let score = 0;

  for (const target of targets) {
    if (target.type === "INVALID") {
      score += 3;
    } else if (target.type === "WEAK") {
      score += 1;
    } else {
      score += 0.5;
    }
  }

  return {
    score,
    targetCount: targets.length,
  };
}

/* ======================================================
   RUNTIME OBSERVATION SUPPORT
====================================================== */
function shouldObserveTarget(target = {}, mode = "stable") {
  if (!target?.matcher) return false;

  if (!RUNTIME_OBSERVABLE_MATCHERS.has(target.matcher)) return false;
  if (target.isAsyncChain) return false;
  if (target.matcher === "toThrow" || target.matcher === "toThrowError") return false;

  if (mode === "failed") {
    return (
      isWeakOrInvalidTarget(target) ||
      isOracleFailureTarget(target)
    );
  }

  return isWeakOrInvalidTarget(target);
}

async function observeTargetIfUseful({ filePath, target, mode, failureContext }) {
  if (!shouldObserveTarget(target, mode)) {
    return target;
  }

  try {
    const observation = await observeRuntimeValue({
      filePath,
      target: {
        ...target,
        failureContext,
      },
    });

    if (!observation?.ok || !isUsefulObservedValue(observation.observedValue)) {
      console.log(
        `ℹ️ Runtime observation skipped for ${target.matcher}: ${observation?.reason || "not useful"}`
      );
      return target;
    }

    console.log(
      `🔬 Runtime observed for ${target.matcher}: ${summarizeObservedValueForLog(
        observation.observedValue
      )}`
    );

    return {
      ...target,
      observedValue: observation.observedValue,
      observedValues: observation.observedValues || [],
      observableExpressionSource: observation.observableExpressionSource || target.receivedSource,
      runtimeObserved: true,
    };
  } catch (err) {
    console.log(
      `ℹ️ Runtime observation failed for ${target.matcher}: ${err?.message || "unknown"}`
    );
    return target;
  }
}

/* ======================================================
   ACCEPTANCE RULES
====================================================== */
function hasBasicRegression(prev, next) {
  const prevJson = getJestJson(prev);
  const nextJson = getJestJson(next);

  if (!prevJson || !nextJson) return true;

  const prevMetrics = getRunMetrics(prev);
  const nextMetrics = getRunMetrics(next);

  if (prevMetrics.totalTests > 0 && nextMetrics.totalTests === 0) {
    console.log("⚠️ Regression detected (All collected tests disappeared).");
    return true;
  }

  if (nextMetrics.totalTests < prevMetrics.totalTests) {
    console.log("⚠️ Regression detected (Collected tests decreased).");
    return true;
  }

  if (nextMetrics.failedSuites > prevMetrics.failedSuites) {
    console.log("⚠️ Regression detected (Failed suites increased).");
    return true;
  }

  if (nextMetrics.failedTests > prevMetrics.failedTests) {
    console.log("⚠️ Regression detected (Failed tests increased).");
    return true;
  }

  if (hasPassingRegression(prev, next)) {
    console.log("⚠️ Regression detected (Previously passing test failed).");
    return true;
  }

  return false;
}

function acceptFailedAssertionRepair({ prev, next, filePath, target }) {
  if (hasBasicRegression(prev, next)) return false;

  const prevMetrics = getRunMetrics(prev);
  const nextMetrics = getRunMetrics(next);

  if (nextMetrics.failedSuites < prevMetrics.failedSuites) {
    console.log("✨ Failed-test repair accepted: failed suites decreased.");
    return true;
  }

  if (nextMetrics.failedTests < prevMetrics.failedTests) {
    console.log("✨ Failed-test repair accepted: failed tests decreased.");
    return true;
  }

  if (didTargetFailedTestPass(prev, next, filePath, target)) {
    console.log("✨ Failed-test repair accepted: targeted failed test now passes.");
    return true;
  }

  if (
    didSameTestMoveToDifferentAssertion({
      prev,
      next,
      filePath,
      target,
    })
  ) {
    return true;
  }

  return false;
}

function acceptStableStrengthening({ prev, next }) {
  if (hasBasicRegression(prev, next)) return false;

  const prevMetrics = getRunMetrics(prev);
  const nextMetrics = getRunMetrics(next);

  if (prevMetrics.failedTests > 0 || prevMetrics.failedSuites > 0) {
    return false;
  }

  if (nextMetrics.failedTests > 0 || nextMetrics.failedSuites > 0) {
    return false;
  }

  const prevQuality = getAssertionQualityScore(prev.codeSnapshot || "");
  const nextQuality = getAssertionQualityScore(next.codeSnapshot || "");

  if (nextQuality.score < prevQuality.score) {
    console.log("✨ Stable strengthening accepted: assertion quality score improved.");
    return true;
  }

  if (nextQuality.targetCount < prevQuality.targetCount) {
    console.log("✨ Stable strengthening accepted: weak/invalid assertion count decreased.");
    return true;
  }

  return false;
}

/* ======================================================
   FILE ORDERING
====================================================== */
function orderTestFilesForMode(testFiles, baselineResult) {
  const failedMap = getFailedFileMap(baselineResult);

  const failed = [];
  const passing = [];

  for (const filePath of testFiles) {
    const normalized = normalizeFilePath(filePath);

    if (failedMap.has(normalized)) {
      failed.push(filePath);
    } else {
      passing.push(filePath);
    }
  }

  return {
    failedFiles: failed,
    passingFiles: passing,
  };
}

/* ======================================================
   TARGET PRIORITIZATION
====================================================== */
function getTargetPriority(target, { failureContext = "", failedTestNames = new Set(), mode }) {
  let priority = 0;

  if (mode === "failed") {
    if (targetAppearsInFailure(target, failureContext)) priority -= 120;
    if (targetBelongsToFailedTest(target, failedTestNames)) priority -= 100;
    if (isOracleFailureTarget(target)) priority -= 80;
    if (target.isRepairCandidateTest) priority -= 50;
    if (target.runtimeObserved) priority -= 45;
    if (target.type === "INVALID") priority -= 20;
  } else {
    if (target.runtimeObserved) priority -= 50;
    if (target.type === "INVALID") priority -= 40;
    if (target.confidence === "HIGH") priority -= 20;
    if (target.isRepairCandidateTest) priority += 30;
  }

  if (!target.runtimeObserved && target.matcher === "toBeDefined") priority += 8;
  if (!target.runtimeObserved && (target.matcher === "toBeTruthy" || target.matcher === "toBeFalsy")) {
    priority += 5;
  }

  return priority;
}

function sortTargets(targets, options) {
  return [...targets].sort(
    (a, b) => getTargetPriority(a, options) - getTargetPriority(b, options)
  );
}

function filterTargetsForFailedMode(targets, failedTestNames, failureContext) {
  return targets.filter((target) =>
    isActionableTarget(target, {
      mode: "failed",
      failedTestNames,
      failureContext,
    })
  );
}

/* ======================================================
   SINGLE ASSERTION TRANSFORM ATTEMPT
====================================================== */
function findTargetInFreshAst(freshTargets, originalTarget) {
  if (!originalTarget) return null;

  const originalSource = normalizeText(originalTarget.source || "");
  const originalMatcher = originalTarget.matcher || "";
  const originalTestName = originalTarget.testName || "";

  let candidates = freshTargets;

  if (originalTestName) {
    const sameTest = candidates.filter((target) => {
      const name = String(target.testName || "");
      return (
        name === originalTestName ||
        name.includes(originalTestName) ||
        originalTestName.includes(name)
      );
    });

    if (sameTest.length > 0) candidates = sameTest;
  }

  if (originalSource) {
    const sameSource = candidates.find(
      (target) => normalizeText(target.source || "") === originalSource
    );

    if (sameSource) return sameSource;
  }

  const sameMatcher = candidates.find(
    (target) => target.matcher === originalMatcher
  );

  if (sameMatcher) return sameMatcher;

  return candidates[0] || null;
}

async function trySingleAssertionTransform({
  filePath,
  target,
  currentResult,
  configPath,
  failureContext,
  mode,
  stableBudget,
}) {
  const fileName = path.basename(filePath);
  const originalCode = fs.readFileSync(filePath, "utf8");
  const failedTestNames = getFailedTestNamesForFile(currentResult, filePath);

  let ast;
  let freshTargets;

  try {
    ast = parseSource(originalCode);
    freshTargets = getOptimizationTargetsFromCode(originalCode, {
      mode,
      failedTestNames,
      failureContext,
    });
  } catch (err) {
    console.log(`⚠️ AST Parse Error for ${fileName}: ${err.message}`);
    return {
      accepted: false,
      result: currentResult,
    };
  }

  let freshTarget = findTargetInFreshAst(freshTargets, target);

  if (!freshTarget) {
    return {
      accepted: false,
      result: currentResult,
    };
  }

  freshTarget = await observeTargetIfUseful({
    filePath,
    target: freshTarget,
    mode,
    failureContext,
  });

  try {
    const optimizedAST = transformAssertions(
      ast,
      [freshTarget],
      failureContext,
      learningDB
    );

    const optimizedCode = generate(optimizedAST).code;

    if (!optimizedCode || optimizedCode === originalCode) {
      console.log("ℹ️ No meaningful single-assertion change proposed.");
      return {
        accepted: false,
        result: currentResult,
      };
    }

    if (!validateSyntax(optimizedCode)) {
      console.log("⚠️ Single-assertion proposal failed syntax validation.");
      return {
        accepted: false,
        result: currentResult,
      };
    }


    fs.writeFileSync(filePath, optimizedCode);

    const runResult = await runJest({ configPath });
    const runJson = getJestJson(runResult);

    if (!runJson) {
      console.log("⚠️ Jest environment crash. Immediate rollback.");
      fs.writeFileSync(filePath, originalCode);
      if (stableBudget) stableBudget.environmentFailure = true;
      return {
        accepted: false,
        result: currentResult,
      };
    }

    const beforeFailed = getFailureScore(currentResult);
    const afterFailed = getFailureScore(runResult);

    console.log(
      `📊 Single Target [${fileName} :: ${freshTarget.matcher}${freshTarget.runtimeObserved ? " + observed" : ""}] -> Before: ${beforeFailed} | After: ${afterFailed}`
    );

    const accepted =
      mode === "failed"
        ? acceptFailedAssertionRepair({
            prev: { ...currentResult, codeSnapshot: originalCode },
            next: { ...runResult, codeSnapshot: optimizedCode },
            filePath,
            target: freshTarget,
          })
        : acceptStableStrengthening({
            prev: { ...currentResult, codeSnapshot: originalCode },
            next: { ...runResult, codeSnapshot: optimizedCode },
          });

    updateLearning(freshTarget, currentResult, runResult, accepted);

    if (accepted) {
      console.log(`✅ Success: Single assertion committed in ${fileName}`);

      const suggested = freshTarget.runtimeObserved
        ? "Runtime-observed assertion strengthened safely"
        : mode === "failed"
          ? "Single failed assertion improved safely"
          : "Single assertion strengthened safely";

      emitEvent("assertion_enhanced", {
        testFile: fileName,
        issue:
          mode === "failed"
            ? "Failed assertion repaired/enhanced"
            : "Assertion enhanced",
        original: freshTarget.source || freshTarget.matcher || "Weak assertion",
        suggested,
        status: "committed",
      });

      recordRepairedAssertion(
        filePath,
        freshTarget.testName || "",
        suggested
      );

      return {
        accepted: true,
        result: runResult,
      };
    }

    console.log(`⚠️ Single assertion rejected. Reverting ${fileName}`);

    emitEvent("assertion_rejected", {
      testFile: fileName,
      issue: "Assertion rejected",
      original: freshTarget.source || freshTarget.matcher || "Weak assertion",
      suggested:
        mode === "failed"
          ? "Rejected because targeted failed test did not improve"
          : "Rejected because assertion quality did not improve safely",
      status: "reverted",
    });

    fs.writeFileSync(filePath, originalCode);

    return {
      accepted: false,
      result: currentResult,
    };
  } catch (err) {
    console.log(`❌ Critical single-assertion enhancer error: ${err.message}`);
    fs.writeFileSync(filePath, originalCode);

    return {
      accepted: false,
      result: currentResult,
    };
  }
}

/* ======================================================
   FILE PROCESSORS
====================================================== */
async function processFileTargets({
  filePath,
  currentResult,
  configPath,
  mode,
  failureData,
  stableBudget,
}) {
  const fileName = path.basename(filePath);
  const code = fs.readFileSync(filePath, "utf8");

  let ast;

  try {
    ast = parseSource(code);
  } catch (err) {
    console.log(`⚠️ AST Parse Error for ${fileName}: ${err.message}`);
    return currentResult;
  }

  const failureContext = getFailureContextForFile(currentResult, filePath) || failureData || "";
  const failedTestNames = getFailedTestNamesForFile(currentResult, filePath);

  let detections = detectAssertions(ast, learningDB);

  if (!detections || detections.length === 0) {
    console.log("ℹ️ No assertions detected in file.");
    return currentResult;
  }

  let targets = detections.filter((d) =>
    isActionableTarget(d, {
      mode,
      failedTestNames,
      failureContext,
    })
  );

  if (mode === "failed") {
    targets = filterTargetsForFailedMode(targets, failedTestNames, failureContext);
  }

  targets = sortTargets(targets, {
    failureContext,
    failedTestNames,
    mode,
  });

  if (targets.length === 0) {
    console.log("ℹ️ No actionable assertion targets after mode filtering.");
    return currentResult;
  }

  console.log(`🧠 Identified ${targets.length} single-assertion target(s).`);

  for (const target of targets) {
    emitEvent("assertion_detected", {
      testFile: fileName,
      issue:
        isOracleFailureTarget(target) && mode === "failed"
          ? "Failed oracle assertion"
          : target.type === "INVALID"
            ? "Invalid assertion"
            : "Weak assertion",
      original: target.source || target.matcher || "Assertion target detected",
      suggested:
        mode === "failed"
          ? "Single failed assertion repair will be attempted"
          : "Single assertion strengthening will be attempted",
      status: "detected",
    });
  }

  let result = currentResult;

  for (const target of targets) {
    if (mode === "stable") {
      const stopReason = getStableBudgetStopReason(stableBudget);
      if (stopReason) {
        console.log(`ℹ️ Assertion strengthening stopped: ${stopReason}.`);
        break;
      }
    }

    const beforeScore = getFailureScore(result);

    if (mode === "stable" && stableBudget) {
      stableBudget.attempts += 1;
    }

    const attempt = await trySingleAssertionTransform({
      filePath,
      target,
      currentResult: result,
      configPath,
      failureContext,
      mode,
      stableBudget,
    });

    result = attempt.result;

    if (mode === "stable" && stableBudget?.environmentFailure) {
      console.log("ℹ️ Assertion strengthening stopped after Jest environment failure.");
      break;
    }
    if (mode === "stable" && stableBudget) {
      if (attempt.accepted) {
        stableBudget.accepted += 1;
      } else {
        stableBudget.rejected += 1;
      }
    }

    if (mode === "failed" && attempt.accepted) {
      const afterScore = getFailureScore(result);

      if (afterScore < beforeScore) {
        console.log(
          `✅ Failed assertion repair improved global failures for ${fileName}.`
        );
      }

      if (isStableRun(result)) {
        console.log("🎉 Assertion repair made the suite stable.");
        break;
      }
    }
  }

  return result;
}

async function runFailedAssertionRepairMode({
  failedFiles,
  currentResult,
  configPath,
  failureData,
}) {
  let result = currentResult;

  for (const filePath of failedFiles) {
    if (isStableRun(result)) break;

    const fileName = path.basename(filePath);
    console.log(`\n🔍 Analyzing File: ${fileName}`);
    console.log("🩹 Mode: failed-test assertion repair");

    result = await processFileTargets({
      filePath,
      currentResult: result,
      configPath,
      mode: "failed",
      failureData,
    });
  }

  return result;
}

async function runStableAssertionStrengtheningMode({
  testFiles,
  currentResult,
  configPath,
  failureData,
}) {
  let result = currentResult;
  const stableBudget = createStableAssertionBudget();

  for (const filePath of testFiles) {
    const stopReason = getStableBudgetStopReason(stableBudget);
    if (stopReason) {
      console.log(`ℹ️ Assertion strengthening stopped: ${stopReason}.`);
      break;
    }

    if (!isStableRun(result)) {
      console.log(
        "⚠️ Suite became unstable during strengthening. Stopping stable-mode scan."
      );
      break;
    }

    const fileName = path.basename(filePath);

    if (isDynamicApiExportSmokeTest(filePath)) {
      console.log(
        `ℹ️ Skipping dynamic API export smoke test during assertion strengthening: ${fileName}`
      );
      continue;
    }
    console.log(`\n🔍 Analyzing File: ${fileName}`);
    console.log("🛡️ Mode: stable assertion strengthening");

    result = await processFileTargets({
      filePath,
      currentResult: result,
      configPath,
      mode: "stable",
      failureData,
      stableBudget,
    });
  }

  return result;
}

/* ======================================================
   MAIN ENGINE
====================================================== */
export async function runAssertionEnhancer({
  testDir = "tests/generated",
  configPath,
  failureData,
}) {
  console.log("\n🚀 [Assertion Engine] Initializing Enhancement Cycle...");

  const testFiles = getTestFiles(testDir);

  if (!testFiles.length) {
    console.log("⚠️ No test files identified.");
    return;
  }

  const baseline = await runJest({ configPath });
  const baselineJson = getJestJson(baseline);

  if (!baselineJson || Number(baselineJson.numTotalTests || 0) === 0) {
    console.log(
      "⚠️ Baseline Jest run did not collect tests. Assertion enhancement skipped."
    );
    return baseline;
  }

  const { failedFiles } = orderTestFilesForMode(testFiles, baseline);
  let currentResult = baseline;

  if (!isStableRun(currentResult)) {
    console.log(
      "⚠️ Baseline has failing tests. Running failed-test assertion repair mode only..."
    );

    if (failedFiles.length === 0) {
      console.log("⚠️ No actionable failing test files found for assertion repair.");
    } else {
      currentResult = await runFailedAssertionRepairMode({
        failedFiles,
        currentResult,
        configPath,
        failureData,
      });
    }
  }

  if (isStableRun(currentResult)) {
    console.log(
      "✅ Jest suite is stable. Running normal assertion strengthening mode."
    );

    currentResult = await runStableAssertionStrengtheningMode({
      testFiles,
      currentResult,
      configPath,
      failureData,
    });
  } else {
    console.log(
      "ℹ️ Suite still has failing tests after assertion repair. Passing files were not modified."
    );
  }

  console.log("\n🎯 [Assertion Engine] Cycle Completed Successfully.\n");
  return currentResult;
}
