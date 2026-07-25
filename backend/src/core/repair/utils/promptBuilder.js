// src/core/repair/utils/promptBuilder.js

/* ======================================================
   SAFE TEXT HELPERS
====================================================== */

function safeText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeWhitespaceOneLine(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function formatList(items = []) {
  return Array.isArray(items) && items.length > 0
    ? items.filter(Boolean).join(", ")
    : "(none)";
}

/* ======================================================
   FAILURE HISTORY
====================================================== */

function buildHistoryText(history = []) {
  if (!Array.isArray(history) || history.length === 0) {
    return "No previous attempts.";
  }

  return history
    .map((h) => {
      const attempt = h?.attempt ?? "?";
      const testName = h?.testName || "unknown test";
      const message = normalizeWhitespaceOneLine(h?.message || "");

      return `Attempt ${attempt}: [${testName}] ${message}`;
    })
    .join("\n");
}

/* ======================================================
   MOCK HANDLING
====================================================== */

function buildMockContext({ jestMocks, mockEntries }) {
  if (jestMocks && String(jestMocks).trim()) {
    return `
MOCK SETUP PRESENT IN TEST FILE — DO NOT MODIFY OR REMOVE:
${jestMocks}
    `.trim();
  }

  if (Array.isArray(mockEntries) && mockEntries.length > 0) {
    return mockEntries
      .map((entry) => {
        const mod = entry?.module || entry?.source || "unknown-module";

        if (mod === "fs") {
          return "- fs is mocked; do not use real file-system access.";
        }

        if (mod === "path") {
          return "- path is mocked; do not rely on real machine-specific paths.";
        }

        if (mod === "axios" || mod === "node-fetch" || mod === "fetch") {
          return `- ${mod} is mocked; do not use real network access.`;
        }

        return `- ${mod} is mocked; use only existing mock setup.`;
      })
      .join("\n");
  }

  return "No external dependencies are used, or no mock metadata was provided.";
}

/* ======================================================
   FAILURE FORMATTER
====================================================== */

function formatFailures(failures = []) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return "No failure details provided.";
  }

  return failures
    .map((f, index) => {
      const testName = f?.testName || `failure-${index + 1}`;
      const type = f?.failureType || f?.errorType || "UNKNOWN_FAILURE";
      const expected = f?.expected !== undefined ? String(f.expected) : "";
      const received = f?.received !== undefined ? String(f.received) : "";
      const message = safeText(f?.errorMessage || f?.message || f?.stack, "");

      return [
        `Failure ${index + 1}`,
        `Test: ${testName}`,
        `Type: ${type}`,
        expected ? `Expected: ${expected}` : "",
        received ? `Received: ${received}` : "",
        `Message:\n${message || "No message available."}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/* ======================================================
   IDENTIFIER RULES
====================================================== */

function buildAllowedIdentifierText({ allowedIdentifiers, context }) {
  const identifiers = new Set();

  if (Array.isArray(allowedIdentifiers)) {
    for (const id of allowedIdentifiers) {
      if (id) identifiers.add(id);
    }
  } else if (allowedIdentifiers instanceof Set) {
    for (const id of allowedIdentifiers) {
      if (id) identifiers.add(id);
    }
  }

  if (context?.fnName) identifiers.add(context.fnName);
  if (context?.displayName) identifiers.add(context.displayName);
  if (context?.fullName) identifiers.add(context.fullName);
  if (context?.ownerClassName) identifiers.add(context.ownerClassName);
  if (context?.methodName) identifiers.add(context.methodName);

  identifiers.add("result");
  identifiers.add("instance");
  identifiers.add("expect");
  identifiers.add("jest");
  identifiers.add("Array");
  identifiers.add("Object");
  identifiers.add("Math");
  identifiers.add("Number");
  identifiers.add("String");
  identifiers.add("Boolean");
  identifiers.add("Date");
  identifiers.add("Promise");
  identifiers.add("JSON");

  return Array.from(identifiers).filter(Boolean).sort().join(", ");
}

/* ======================================================
   CONTEXT HELPERS
====================================================== */

function buildTargetName(context = {}) {
  if (context.isClassMethod && context.ownerClassName && context.methodName) {
    if (context.methodKind === "static") {
      return `${context.ownerClassName}.${context.methodName}`;
    }

    if (context.methodKind === "constructor") {
      return context.ownerClassName;
    }

    return `${context.ownerClassName}.${context.methodName}`;
  }

  return context.displayName || context.fullName || context.fnName || "functionUnderTest";
}

function buildActExample(context = {}) {
  const fnName = context.fnName || "functionUnderTest";

  if (context.isClassMethod && context.ownerClassName && context.methodName) {
    if (context.methodKind === "static") {
      return `${context.isAsync ? "const result = await " : "const result = "}${context.ownerClassName}.${context.methodName}(...);`;
    }

    if (context.methodKind === "constructor") {
      return `const result = new ${context.ownerClassName}(...);`;
    }

    return `${context.isAsync ? "const result = await " : "const result = "}instance.${context.methodName}(...);`;
  }

  return `${context.isAsync ? "const result = await " : "const result = "}${fnName}(...);`;
}

/* ======================================================
   MAIN REPAIR PROMPT
====================================================== */

export function buildRepairPrompt({
  originalCode,
  failures,
  context,
  attempt,
  history = [],
  allowedIdentifiers = [],
}) {
  const {
    fnName,
    isAsync,
    functionCode,
    jestMocks,
    mockEntries,
    ownerClassName,
    methodName,
    methodKind,
    params,
    isClassLike,
    isClassMethod,
    constructorParams,
  } = context || {};

  const targetName = buildTargetName(context || {});
  const actExample = buildActExample(context || {});
  const historyText = buildHistoryText(history);
  const mockContext = buildMockContext({ jestMocks, mockEntries });
  const failureDetails = formatFailures(failures);
  const allowedIdentifierText = buildAllowedIdentifierText({
    allowedIdentifiers,
    context,
  });

  return `
You are a strict JavaScript/Jest unit test repair assistant.

Your job is to repair failing Jest test cases without breaking the generated test file.

You must return ONLY JSON test-case fragments.
The repair engine will insert those fragments into the existing test file.
Do not return the full file.

--------------------------------------------------
TARGET UNDER TEST
--------------------------------------------------
Target: ${targetName}
Function name: ${fnName || "(unknown)"}
Async: ${isAsync ? "yes" : "no"}
Parameters: ${formatList(params || [])}
Class-like target: ${isClassLike ? "yes" : "no"}
Class method: ${isClassMethod ? "yes" : "no"}
Owner class: ${ownerClassName || "(none)"}
Method name: ${methodName || "(none)"}
Method kind: ${methodKind || "(function/unknown)"}
Constructor parameters: ${formatList(constructorParams || [])}
Repair attempt: ${attempt}

--------------------------------------------------
AVAILABLE IDENTIFIERS YOU MAY USE
--------------------------------------------------
${allowedIdentifierText || "(none provided)"}

Important:
- You may use only the identifiers listed above.
- You may also use variables that you declare inside "arrange".
- Do not use any other variable, helper, class, function, import, or module.

--------------------------------------------------
CURRENT TEST FILE
--------------------------------------------------
${originalCode || "(not available)"}

--------------------------------------------------
CURRENT FAILURES
--------------------------------------------------
${failureDetails}

--------------------------------------------------
FAILURE HISTORY — DO NOT REPEAT THESE MISTAKES
--------------------------------------------------
${historyText}

--------------------------------------------------
SOURCE FUNCTION / CLASS CONTEXT
--------------------------------------------------
${functionCode || "N/A"}

--------------------------------------------------
MOCKED ENVIRONMENT
--------------------------------------------------
${mockContext}

--------------------------------------------------
STRICT REPAIR RULES
--------------------------------------------------

1. Scope:
   - Repair only the failing tests.
   - Do not modify passing tests.
   - Keep the same testing intent when possible.
   - The output must contain only repaired cases for failed tests.

2. Output:
   - Return ONLY JSON inside <JSON>...</JSON>.
   - Do not include markdown.
   - Do not include explanations.
   - Do not include comments inside JSON.
   - Do not include trailing commas.
   - Do not include undefined values.
   - Do not include functions as JSON values.

3. Forbidden code:
   - No import statements.
   - No export statements.
   - No require().
   - No describe().
   - No test().
   - No it().
   - No beforeEach(), afterEach(), beforeAll(), or afterAll().
   - No jest.mock() or jest.unstable_mockModule().
   - No sinon, vi.mock, or external mocking library.

4. Identifier safety:
   - Do not invent undeclared variables.
   - Do not invent helper functions.
   - Do not invent classes.
   - Do not invent imports.
   - If you need a value, declare it in arrange.
   - Do not reference raw parameter names unless you declare them in arrange first.

5. Act rule:
   - Normal repaired cases must have exactly one act line:
     ${actExample}
   - Do not declare result in arrange.
   - Do not declare result in assert.
   - The act field should contain the result assignment only.

6. Assertion rule:
   - Assertions must be centered on result.
   - Prefer stable, meaningful assertions.
   - If exact expected value is clear from simple deterministic input, use exact assertion.
   - If exact expected value is uncertain, use safe structural assertions.

7. Deep equality repair:
   - If a large toEqual/toStrictEqual expected object or array failed, do not copy the received object.
   - Prefer:
     expect(result).toBeDefined();
     expect(typeof result).toBe("object");
     expect(Array.isArray(result)).toBe(true);
     expect(result).toHaveProperty("key");
     expect(Object.keys(result).length).toBeGreaterThan(0);

8. Numeric repair:
   - If toBeCloseTo or exact numeric value failed and exact value is uncertain, prefer:
     expect(typeof result).toBe("number");
     expect(Number.isFinite(result)).toBe(true);

9. Null/undefined repair:
   - If expected null/undefined failed because received a real value, prefer:
     expect(result).not.toBeNull();
     expect(result).not.toBeUndefined();

10. Throw repair:
   - For sync throw:
     expect(() => ${fnName || "functionUnderTest"}(...)).toThrow();
   - For async rejection:
     await expect(${fnName || "functionUnderTest"}(...)).rejects.toThrow();

11. Class/prototype method repair:
   - Do not call prototype methods as Class.method().
   - If method kind is prototype, arrange must create an instance first:
     const instance = new ${ownerClassName || "ClassName"}(...);
     ${isAsync ? "const result = await instance.methodName(...);" : "const result = instance.methodName(...);"}
   - If method kind is static, call:
     ${ownerClassName || "ClassName"}.${methodName || "methodName"}(...)

12. Mock safety:
   - Do not remove or modify mocks.
   - Do not access real fs/path/network/database.
   - Use only existing mocked environment.

--------------------------------------------------
OUTPUT FORMAT
--------------------------------------------------

<JSON>
[
  {
    "title": "same or clearer failing test title",
    "arrange": "declare variables needed by this repaired test",
    "act": "${actExample}",
    "assert": "expect(result).toBeDefined();"
  }
]
</JSON>

Return only the JSON block.
`.trim();
}

/* ======================================================
   HELPER: Extract Assertion Line
====================================================== */

export function extractAssertionLine(msg) {
  if (!msg) return "Unknown assertion";

  const lines = String(msg || "").split("\n");

  for (const line of lines) {
    if (line.includes("expect(")) return line.trim();
  }

  return "Unknown assertion";
}