import path from "path";
import { classifyFailure } from "./failureClassifier.js";

function normalizeTestFilePath(filePath) {
  if (!filePath) return "";

  const raw = String(filePath).trim();

  if (path.isAbsolute(raw)) {
    return path.normalize(raw);
  }

  return path.normalize(raw);
}

function buildFailureFingerprint(testName, errorType, failureType, filePath) {
  return [
    String(testName || "UNKNOWN_TEST"),
    String(errorType || "UNKNOWN_ERROR"),
    String(failureType || "UNKNOWN"),
    String(filePath || "UNKNOWN_FILE"),
  ].join("::");
}

function collectSuiteLevelFailureMessages(suite) {
  const messages = [];

  if (suite?.message) {
    messages.push(String(suite.message));
  }

  if (Array.isArray(suite?.failureMessage)) {
    messages.push(...suite.failureMessage.map(String));
  }

  if (typeof suite?.testExecError === "string") {
    messages.push(suite.testExecError);
  } else if (suite?.testExecError?.message) {
    messages.push(String(suite.testExecError.message));
  }

  return messages.join("\n").trim();
}

function extractFailures(jestJson = {}) {
  const failures = [];
  const suites = Array.isArray(jestJson.testResults) ? jestJson.testResults : [];

  for (const suite of suites) {
    const normalizedFilePath = normalizeTestFilePath(suite.name);

    // Handle suite-level runtime/load failures
    const suiteLevelMessage = collectSuiteLevelFailureMessages(suite);
    if (
      suiteLevelMessage &&
      (!Array.isArray(suite.assertionResults) || suite.assertionResults.length === 0)
    ) {
      const classification = classifyFailure(suiteLevelMessage);

      failures.push({
        testName: "SUITE_LOAD_ERROR",
        filePath: normalizedFilePath,
        errorMessage: suiteLevelMessage,
        errorType: classification.errorType,
        failureType: classification.failureType,
        fingerprint: buildFailureFingerprint(
          "SUITE_LOAD_ERROR",
          classification.errorType,
          classification.failureType,
          normalizedFilePath
        ),
      });
    }

    const testCases = Array.isArray(suite.assertionResults)
      ? suite.assertionResults
      : [];

    for (const testCase of testCases) {
      if (testCase.status !== "failed") continue;

      const failureMessages = Array.isArray(testCase.failureMessages)
        ? testCase.failureMessages
        : [];

      const cleanedError = failureMessages.join("\n").trim();
      const classification = classifyFailure(cleanedError);

      failures.push({
        testName: testCase.fullName || testCase.title || "UNKNOWN_TEST",
        filePath: normalizedFilePath,
        errorMessage: cleanedError,
        errorType: classification.errorType,
        failureType: classification.failureType,
        fingerprint: buildFailureFingerprint(
          testCase.fullName || testCase.title || "UNKNOWN_TEST",
          classification.errorType,
          classification.failureType,
          normalizedFilePath
        ),
      });
    }
  }

  return failures;
}

export {
  extractFailures,
  normalizeTestFilePath,
  buildFailureFingerprint,
};