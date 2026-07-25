import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import coverageLib from "istanbul-lib-coverage";
import { cleanupRuntimeArtifacts, createRuntimeArtifactSnapshot } from "../src/core/testgen/runtimeArtifactCleanup.js";
const { createCoverageMap } = coverageLib;

const backendRoot = process.cwd();
const jestBin = path.resolve(backendRoot, "node_modules", "jest", "bin", "jest.js");

const runtimeArtifactBaseline = createRuntimeArtifactSnapshot(backendRoot);
process.on("exit", () =>
  cleanupRuntimeArtifacts(backendRoot, { baselineNames: runtimeArtifactBaseline })
);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function safeRm(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeForJest(filePath) {
  return path.relative(backendRoot, path.resolve(filePath)).split(path.sep).join(path.posix.sep);
}

function listGeneratedTests(testDir) {
  if (!fs.existsSync(testDir)) return [];
  return fs.readdirSync(testDir)
    .filter((file) => file.endsWith(".test.js"))
    .map((file) => path.join(testDir, file))
    .sort();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function escapeRegex(text) {
  return String(text || "").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function runJest({ testFiles, outputFile, coverageDir, testNamePattern }) {
  const args = [
    "--experimental-vm-modules",
    jestBin,
    "--runInBand",
    "--json",
    `--outputFile=${outputFile}`,
    "--colors=false",
  ];

  if (coverageDir) {
    args.push(
      "--coverage",
      `--coverageDirectory=${coverageDir}`,
      "--coverageReporters=json",
      "--coverageReporters=json-summary",
      "--coveragePathIgnorePatterns=tests/generated",
      "--coveragePathIgnorePatterns=node_modules",
      "--coveragePathIgnorePatterns=dist/test",
      "--coveragePathIgnorePatterns=coverage"
    );
  }

  if (testNamePattern) {
    args.push(`--testNamePattern=^${escapeRegex(testNamePattern)}$`);
  }

  args.push("--runTestsByPath", ...testFiles.map(normalizeForJest));

  const proc = spawnSync(process.execPath, args, {
    cwd: backendRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      FORCE_COLOR: "0",
    },
  });

  const result = fs.existsSync(outputFile) ? readJson(outputFile) : null;
  return { proc, result };
}

function getAssertions(jestJson) {
  const rows = [];
  for (const suite of jestJson?.testResults || []) {
    for (const assertion of suite.assertionResults || []) {
      rows.push({
        filePath: suite.name,
        title: assertion.title || "",
        fullName: assertion.fullName || assertion.title || "",
        status: assertion.status || "unknown",
      });
    }
  }
  return rows;
}

function loadCoverageFinal(coverageDir) {
  const file = path.join(coverageDir, "coverage-final.json");
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function isPackageOwnedCoverageFile(filePath, packageRoot) {
  const relative = path.relative(packageRoot, path.resolve(filePath));
  if (relative === "" || relative === ".") return true;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }

  const segments = relative.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  return !segments.includes("node_modules");
}

function mergeCoverageInto(map, coverageJson, { packageRoot, excludedFiles } = {}) {
  if (!coverageJson) return;

  const packageCoverage = {};
  for (const [filePath, fileCoverage] of Object.entries(coverageJson)) {
    if (packageRoot && !isPackageOwnedCoverageFile(filePath, packageRoot)) {
      excludedFiles?.add(path.resolve(filePath));
      continue;
    }
    packageCoverage[filePath] = fileCoverage;
  }

  map.merge(packageCoverage);
}

function writeCoverageSummary(outDir, coverageMap) {
  const summary = coverageMap.getCoverageSummary().toJSON();
  fs.writeFileSync(
    path.join(outDir, "coverage-summary.json"),
    JSON.stringify({ total: summary }, null, 2)
  );
  fs.writeFileSync(
    path.join(outDir, "coverage-final.json"),
    JSON.stringify(coverageMap.toJSON(), null, 2)
  );
  return summary;
}

function copyIfExists(src, dest) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

function printSummary(report) {
  console.log("\n================ UnitGen Coverage Summary ================");
  console.log(`Package            : ${report.packageName}`);
  console.log(`Generated test files: ${report.generatedTestFiles}`);
  console.log(`Total tests         : ${report.totalTests}`);
  console.log(`Passing tests       : ${report.passingTests}`);
  console.log(`Failed tests        : ${report.failedTests}`);
  console.log(`Coverage mode       : ${report.coverageMode}`);
  console.log(`Statement coverage  : ${report.coverage.total.statements.pct}%`);
  console.log(`Branch coverage     : ${report.coverage.total.branches.pct}%`);
  console.log("==========================================================\n");
}

function normalizePackageName(raw) {
  const normalized = String(raw || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^benchmark_packages\//, "")
    .replace(/\/$/, "");

  return normalized;
}

const args = parseArgs(process.argv);
const packageName = normalizePackageName(args.package || args._[0]);

if (!packageName) {
  console.error("Usage: node scripts/measure-unitgen-coverage.js --package <package-name-or-folder> [--testDir tests/generated] [--outDir coverage-results/<package>]");
  process.exit(2);
}

if (!fs.existsSync(jestBin)) {
  console.error(`Jest binary not found: ${jestBin}`);
  process.exit(2);
}

const packageRoot = path.resolve(backendRoot, "benchmark_packages", packageName);
if (!fs.existsSync(packageRoot)) {
  console.error(`Benchmark package not found: ${packageRoot}`);
  process.exit(2);
}

const testDir = path.resolve(backendRoot, args.testDir || path.join("tests", "generated"));
const outDir = path.resolve(backendRoot, args.outDir || path.join("coverage-results", packageName));
const tmpDir = path.join(outDir, ".tmp");

safeRm(outDir);
ensureDir(outDir);
ensureDir(tmpDir);

const testFiles = listGeneratedTests(testDir);
if (testFiles.length === 0) {
  console.error(`No generated test files found in ${testDir}`);
  process.exit(1);
}

const baselineJsonPath = path.join(tmpDir, "jest-baseline.json");
const baseline = runJest({ testFiles, outputFile: baselineJsonPath });

if (!baseline.result) {
  console.error("Jest did not produce a baseline JSON result.");
  console.error(baseline.proc.stderr || baseline.proc.stdout || "");
  process.exit(1);
}

const assertions = getAssertions(baseline.result);
const passingAssertions = assertions.filter((row) => row.status === "passed");
const failedAssertions = assertions.filter((row) => row.status === "failed");

let coverageSummary;
let coverageMode;
const mergedCoverage = createCoverageMap({});
const excludedCoverageFiles = new Set();

if (failedAssertions.length === 0) {
  coverageMode = "all-tests-pass-single-coverage-run";
  const coverageDir = path.join(tmpDir, "coverage-all");
  const coverageJsonPath = path.join(tmpDir, "jest-coverage-all.json");
  const coverageRun = runJest({ testFiles, outputFile: coverageJsonPath, coverageDir });

  if (!coverageRun.result || Number(coverageRun.result.numFailedTests || 0) > 0) {
    console.error("Coverage run did not complete cleanly even though baseline passed.");
    console.error(coverageRun.proc.stderr || coverageRun.proc.stdout || "");
    process.exit(1);
  }

  const coverageJson = loadCoverageFinal(coverageDir);
  mergeCoverageInto(mergedCoverage, coverageJson, { packageRoot, excludedFiles: excludedCoverageFiles });
  copyIfExists(path.join(coverageDir, "coverage-summary.json"), path.join(outDir, "jest-coverage-summary.raw.json"));
} else {
  coverageMode = "passing-tests-only-isolated-coverage-runs";
  let index = 0;
  for (const assertion of passingAssertions) {
    index += 1;
    const coverageDir = path.join(tmpDir, `coverage-${index}`);
    const outputFile = path.join(tmpDir, `jest-${index}.json`);
    const coverageRun = runJest({
      testFiles: [assertion.filePath],
      outputFile,
      coverageDir,
      testNamePattern: assertion.fullName,
    });

    if (!coverageRun.result || Number(coverageRun.result.numFailedTests || 0) > 0) {
      continue;
    }

    mergeCoverageInto(mergedCoverage, loadCoverageFinal(coverageDir), {
      packageRoot,
      excludedFiles: excludedCoverageFiles,
    });
  }
}

coverageSummary = writeCoverageSummary(outDir, mergedCoverage);

const report = {
  generatedAt: new Date().toISOString(),
  packageName,
  packageRoot,
  testDir,
  generatedTestFiles: testFiles.length,
  totalTests: Number(baseline.result.numTotalTests || assertions.length || 0),
  passingTests: passingAssertions.length,
  failedTests: failedAssertions.length,
  coverageMode,
  coverage: {
    total: coverageSummary,
  },
  includedCoverageFiles: mergedCoverage.files().map((filePath) =>
    path.relative(packageRoot, filePath)
  ),
  excludedCoverageFiles: [...excludedCoverageFiles].map((filePath) =>
    path.relative(packageRoot, filePath)
  ),
  failedTestNames: failedAssertions.map((row) => ({
    file: path.relative(backendRoot, row.filePath),
    name: row.fullName,
  })),
};

fs.writeFileSync(path.join(outDir, "unitgen-coverage-report.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(outDir, "jest-baseline.json"), JSON.stringify(baseline.result, null, 2));
safeRm(tmpDir);
printSummary(report);
