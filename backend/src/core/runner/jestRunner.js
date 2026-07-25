import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

function getGeneratedTestFiles() {
  const dir = path.resolve("tests", "generated");

  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join(dir, f));
}

function getJestBin() {
  return path.resolve("node_modules", "jest", "bin", "jest.js");
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore cleanup errors.
  }
}

function makeEmptyResult(extra = {}) {
  return {
    success: false,
    numTotalTestSuites: 0,
    numFailedTestSuites: 0,
    numPassedTestSuites: 0,
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    testResults: [],
    ...extra,
  };
}

function normalizeTestPath(filePath) {
  return path
    .relative(process.cwd(), path.resolve(filePath))
    .split(path.sep)
    .join(path.posix.sep);
}

function getResultFilePath(label = "all") {
  const safeLabel = String(label || "all").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.resolve(
    "tests",
    "generated",
    `.jest-results.${process.pid}.${safeLabel}.json`
  );
}

function buildJestArgs({ testFiles, resultsPath }) {
  const relativeTests = testFiles.map((file) => normalizeTestPath(file));

  return [
    "--experimental-vm-modules",
    getJestBin(),
    "--runInBand",
    "--json",
    `--outputFile=${resultsPath}`,
    "--colors=false",
    "--runTestsByPath",
    ...relativeTests,
  ];
}

function runJestInternal({
  testFiles,
  resultLabel = "all",
  logFailure = true,
} = {}) {
  const files = Array.isArray(testFiles) ? testFiles.filter(Boolean) : [];
  const resultsPath = getResultFilePath(resultLabel);

  safeUnlink(resultsPath);

  if (files.length === 0) {
    return makeEmptyResult({
      success: true,
      noTestsFound: true,
    });
  }

  const jestBin = getJestBin();

  if (!fs.existsSync(jestBin)) {
    const message = `Jest binary not found: ${jestBin}`;

    if (logFailure) {
      console.log(`❌ ${message}`);
    }

    return makeEmptyResult({
      success: false,
      runnerError: {
        status: 1,
        stdout: "",
        stderr: message,
      },
    });
  }

  const args = buildJestArgs({
    testFiles: files,
    resultsPath,
  });

  const proc = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      FORCE_COLOR: "0",
    },
  });

  const parsed = safeReadJson(resultsPath);

  /*
   * Important:
   * Jest exits with non-zero status when tests fail, but still writes JSON.
   * In that case we must return the parsed JSON, not treat it as runner failure.
   */
  if (parsed) {
    safeUnlink(resultsPath);
    return {
      ...parsed,
      runnerStatus: proc.status,
      runnerSignal: proc.signal,
      runnerStdout: proc.stdout || "",
      runnerStderr: proc.stderr || "",
    };
  }

  safeUnlink(resultsPath);

  if (logFailure) {
    console.log("❌ Jest did not produce a JSON result file.");
    console.log("---- Jest stdout ----");
    console.log(proc.stdout || "(empty)");
    console.log("---- Jest stderr ----");
    console.log(proc.stderr || "(empty)");
  }

  return makeEmptyResult({
    success: false,
    runnerError: {
      status: proc.status,
      signal: proc.signal,
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  });
}

export async function runJest() {
  const generatedTests = getGeneratedTestFiles();

  return runJestInternal({
    testFiles: generatedTests,
    resultLabel: "all",
    logFailure: true,
  });
}

/**
 * Runs Jest for exactly one generated test file.
 *
 * Used by candidateRuntimeValidator.js to validate LLM candidate tests before
 * final injection.
 *
 * Important:
 * - This does not run the full suite.
 * - It returns Jest JSON if Jest produced it, even when the test failed.
 * - It keeps logging quiet by default because candidate validation may run many
 *   times per function.
 */
export async function runJestForFile(testFilePath, options = {}) {
  const absPath = path.resolve(testFilePath);
  const logFailure = options.logFailure === true;

  if (!fs.existsSync(absPath)) {
    return makeEmptyResult({
      success: false,
      runnerError: {
        status: 1,
        stdout: "",
        stderr: `Test file not found: ${absPath}`,
      },
    });
  }

  const label = path.basename(absPath, ".test.js");

  return runJestInternal({
    testFiles: [absPath],
    resultLabel: label,
    logFailure,
  });
}