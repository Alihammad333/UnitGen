// src/core/validation/validateSyntax.js

import * as babelParser from "@babel/parser";

export function validateSyntax(code) {

  /* ======================================================
      BASIC VALIDATION
  ====================================================== */

  if (!code || typeof code !== "string") {
    return false;
  }

  const trimmed = code.trim();

  if (trimmed.length === 0) {
    return false;
  }

  /* ======================================================
      🔥 CRITICAL STRING SAFETY
  ====================================================== */

  /*
   * Quote/newline validity is decided by Babel below. Character-count and
   * quote-before-newline heuristics reject valid generated JavaScript after
   * Babel reformats multiline calls and strings.
   */

  // ❌ Dangerous "in" bug inside toThrow
  if (
    code.includes("toThrow('") &&
    code.includes(" in ")
  ) {
    return false;
  }

  /* ======================================================
      🔥 ASYNC MATCHER SAFETY (NEW CRITICAL FIX)
  ====================================================== */

  // ❌ BLOCK: await call().rejects (Invalid Syntax)
  const brokenAsyncMatcher = /await\s+(?!expect\s*\()[^;\n]+?\)\s*\.\s*(rejects|resolves)\b/i;
  
  if (brokenAsyncMatcher.test(code)) {
    console.log("⚠️ Validation Failed: Missing 'expect' in async matcher.");
    return false;
  }

  /* ======================================================
      🔥 EXPECT STRUCTURE VALIDATION
  ====================================================== */

  // ❌ Unbalanced parentheses in expect calls
  const openParens = (code.match(/\(/g) || []).length;
  const closeParens = (code.match(/\)/g) || []).length;

  if (code.includes("expect(") && openParens !== closeParens) {
    return false;
  }

  // ❌ Broken matcher chain like: expect(x).toBe
  if (/expect\([^)]*\)\s*\.\s*$/.test(code)) {
    return false;
  }

  /* ======================================================
      🔥 LLM GARBAGE FILTER
  ====================================================== */

  if (
    code.startsWith("Here is") ||
    code.startsWith("Fixed code") ||
    code.startsWith("```") ||
    code.includes("```")
  ) {
    return false;
  }

  /* ======================================================
      🔥 TEST STRUCTURE CHECK
  ====================================================== */

  const hasTestStructure =
    code.includes("test(") ||
    code.includes("it(") ||
    code.includes("describe(");

  if (!hasTestStructure) {
    return false;
  }

  /* ======================================================
      🔥 EXTRA SAFETY
  ====================================================== */

  if (trimmed.length < 20) return false;
  if (trimmed.length > 50000) return false;

  const expectCount = (code.match(/expect\(/g) || []).length;
  if (expectCount > 100) return false;

  /* ======================================================
      🔥 FINAL: BABEL PARSE (SOURCE OF TRUTH)
  ====================================================== */

  try {
    babelParser.parse(code, {
      sourceType: "module",
      plugins: [
        "jsx",
        "asyncGenerators",
        "classProperties",
        "dynamicImport",
        "optionalChaining",
        "nullishCoalescingOperator",
        "topLevelAwait",
        "objectRestSpread"
      ]
    });
    return true;
  } catch (err) {
    // 🔥 GENUINE SOLUTION: Stop guessing why it failed.
    // This logs the exact syntax error message and line number to your console.
    console.log(`❌ Syntax Error: ${err.message} at line ${err.loc?.line}`);
    
    const lines = code.split('\n');
    if (err.loc?.line) {
      console.log(`👉 Error Line: ${lines[err.loc.line - 1]}`);
    }
    return false;
  }
}
/* ======================================================
    🔥 STRICT TEST VALIDATION (FOR LLM OUTPUT ONLY)
====================================================== */
export function isRunnableTest(code) {
  if (!code || typeof code !== "string") return false;

  const trimmed = code.trim();

  /* ==========================================
      MUST HAVE TEST STRUCTURE
  ========================================== */
  const hasTest =
    trimmed.includes("test(") ||
    trimmed.includes("it(") ||
    trimmed.includes("describe(");

  if (!hasTest) return false;

  /* ==========================================
      PREVENT PARTIAL / GARBAGE OUTPUT
  ========================================== */
  if (trimmed.length < 80) {
    console.log("⚠️ Runnable check failed: code too small.");
    return false;
  }

  /* ==========================================
      DELEGATE TO EXISTING VALIDATION
  ========================================== */
  return validateSyntax(trimmed);
}