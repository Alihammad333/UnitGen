import fs from "fs";
import path from "path";

function getOutputDir() {
  return process.env.UNITGEN_OUTPUT_DIR
    ? path.resolve(process.env.UNITGEN_OUTPUT_DIR, "tests", "generated")
    : path.resolve("tests", "generated");
}

export function writeGeneratedTest(fnName, content) {
  const outDir = getOutputDir();
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outFile = path.join(outDir, `${fnName}.test.js`);
  fs.writeFileSync(outFile, content, "utf8");

  return outFile;
}

export function writeGeneratedMock(fnName, content) {
  const outDir = getOutputDir();
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outFile = path.join(outDir, `${fnName}.mocks.js`);
  fs.writeFileSync(outFile, content, "utf8");

  return outFile;
}
