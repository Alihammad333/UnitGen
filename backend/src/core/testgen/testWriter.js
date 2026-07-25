// src/core/testgen/testWriter.js
import fs from "fs";
import path from "path";

/**
 * Writes test content into tests/generated/<fnName>.test.js
 * Creates directory if missing.
 *
 * ✅ FIX: return ABSOLUTE outFile path so it matches Jest JSON paths on Windows.
 * Variable names kept as requested: outDir, outFile.
 */
export function writeGeneratedTest(fnName, content) {
  const outDir = path.resolve("tests", "generated");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outFile = path.join(outDir, `${fnName}.test.js`);
  fs.writeFileSync(outFile, content, "utf8");

  return outFile;
}