import fs from "fs";
import path from "path";

function unwrapJestJson(data) {
  if (!data || typeof data !== "object") {
    return {};
  }

  // Case 1: index.js passes wrapper object
  if (data.jestResults) {
    return data.jestResults?.json || data.jestResults;
  }

  // Case 2: direct Jest JSON passed
  return data.json || data;
}

function getProjectMeta(data) {
  if (!data || typeof data !== "object") {
    return {};
  }

  return {
    input: data.input ?? null,
    processedFiles: data.processedFiles ?? null,
    skippedFiles: data.skippedFiles ?? null,
    generatedTestFiles: data.generatedTestFiles ?? null,
  };
}

function deriveCountsFromAssertions(testResults = []) {
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  for (const suite of testResults) {
    const assertions = Array.isArray(suite?.assertionResults)
      ? suite.assertionResults
      : [];

    for (const assertion of assertions) {
      totalTests += 1;

      if (assertion.status === "passed") {
        passedTests += 1;
      }

      if (assertion.status === "failed") {
        failedTests += 1;
      }
    }
  }

  return {
    totalTests,
    passedTests,
    failedTests,
  };
}

export function buildFinalReport(data) {
  const jestJson = unwrapJestJson(data);
  const projectMeta = getProjectMeta(data);

  const testResults = Array.isArray(jestJson?.testResults)
    ? jestJson.testResults
    : [];

  const derived = deriveCountsFromAssertions(testResults);

  const totalTests =
    jestJson?.numTotalTests ??
    jestJson?.numTotalTestCases ??
    derived.totalTests ??
    0;

  const passedTests =
    jestJson?.numPassedTests ??
    derived.passedTests ??
    0;

  const failedTestsCount =
    jestJson?.numFailedTests ??
    derived.failedTests ??
    0;

  const totalSuites =
    jestJson?.numTotalTestSuites ??
    testResults.length ??
    0;

  const passedSuites =
    jestJson?.numPassedTestSuites ??
    testResults.filter((suite) => suite.status === "passed").length ??
    0;

  const failedSuites =
    jestJson?.numFailedTestSuites ??
    testResults.filter((suite) => suite.status === "failed").length ??
    0;

  const failedTests = [];
  const passedTestDetails = [];

  for (const suite of testResults) {
    const testFile = suite?.name ?? "";

    const assertions = Array.isArray(suite?.assertionResults)
      ? suite.assertionResults
      : [];

    for (const assertion of assertions) {
      const testName = assertion?.fullName ?? assertion?.title ?? "Unnamed test";

      if (assertion?.status === "passed") {
        passedTestDetails.push({
          testFile,
          testName,
          status: "passed",
        });
      }

      if (assertion?.status === "failed") {
        const messages = Array.isArray(assertion?.failureMessages)
          ? assertion.failureMessages
          : [];

        const errorMessage = messages.length
          ? String(messages[0]).split("\n").slice(0, 8).join("\n")
          : "Unknown test failure";

        failedTests.push({
          testFile,
          testName,
          status: "failed",
          errorMessage,
        });
      }
    }

    if (suite?.status === "failed" && suite?.message) {
      failedTests.push({
        testFile,
        testName: "Suite runtime error",
        status: "failed",
        errorMessage: String(suite.message).split("\n").slice(0, 8).join("\n"),
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),

    project: projectMeta,

    summary: {
      totalSuites,
      passedSuites,
      failedSuites,
      totalTests,
      passedTests,
      failedTests: failedTestsCount,
      success: Boolean(jestJson?.success),
    },

    passedTests: passedTestDetails,

    failedTests,

    runner: {
      status: jestJson?.runnerStatus ?? null,
      signal: jestJson?.runnerSignal ?? null,
      stderr: jestJson?.runnerStderr ?? "",
    },
  };
}

function getOutputDir() {
  return process.env.UNITGEN_OUTPUT_DIR
    ? path.resolve(process.env.UNITGEN_OUTPUT_DIR, "output")
    : path.resolve("output");
}

export function writeFinalReport(data, outPath = "output/final-report.json") {
  const report = buildFinalReport(data);
  const baseDir = getOutputDir();
  const absOut = path.join(baseDir, "final-report.json");
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, JSON.stringify(report, null, 2), "utf8");

  return absOut;
}