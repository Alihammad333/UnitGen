/**
 * LLM PROMPT CONTRACT:
 * The model MUST return ONLY JSON describing Jest test case fragments.
 * It must NOT write imports, mocks, wrappers, or rewrite the generated harness.
 *
 * Goal:
 * Generate multiple useful, deterministic candidate test fragments.
 *
 * Important:
 * UnitGen will:
 * - normalize act/assert
 * - sanitize unsafe cases
 * - runtime-validate each candidate with Jest
 * - keep only passing candidates
 * - use fallback invariant tests if needed
 * - repair/enhance assertions later
 *
 * Quality-context support:
 * - usageSnippets from README/docs/examples/tests
 * - docComment from JSDoc / nearby source comments
 */

import { formatUsageSnippetsForPrompt } from "../context/usageSnippetMiner.js";
import { formatDocCommentForPrompt } from "../context/docCommentExtractor.js";

const MAX_REQUESTED_CANDIDATES = 8;
const MIN_REQUESTED_CANDIDATES = 6;

function safeString(value) {
  return String(value || "");
}

function trimLongText(text, maxChars = 2500) {
  const s = safeString(text).trim();

  if (s.length <= maxChars) return s;

  return `${s.slice(0, maxChars).trim()}\n...truncated`;
}

function extractVisibleOptionKeys(functionCode = "") {
  const source = safeString(functionCode);
  const keys = [];
  const add = (key) => {
    if (!key || key.startsWith("_")) return;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return;
    if (!keys.includes(key)) keys.push(key);
  };

  const objectPatternRe = /\(\s*\{([^)]{1,300})\}\s*(?:=\s*\{\})?\s*\)/g;
  let objectMatch;
  while ((objectMatch = objectPatternRe.exec(source))) {
    const body = objectMatch[1] || "";
    for (const part of body.split(",")) {
      const cleaned = part
        .trim()
        .replace(/^\.\.\./, "")
        .replace(/=.*/, "")
        .replace(/:.*/, "")
        .trim();
      add(cleaned);
    }
  }

  const propRe = /\b(?:options|opts|config|settings)\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let propMatch;
  while ((propMatch = propRe.exec(source))) {
    add(propMatch[1]);
  }

  return keys.slice(0, 8);
}

function buildVisibleOptionGuidance(functionCode = "") {
  const keys = extractVisibleOptionKeys(functionCode);
  if (keys.length === 0) return "";

  return `Visible options/object keys from source: ${keys.join(", ")}. If testing an options object, include the required visible keys with deterministic safe values; for url use a simple http/https URL and for dest/path/filename use a small local-looking path.`;
}
function buildParamUsageHints(params = []) {
  const p = Array.isArray(params) ? params : [];
  if (p.length === 0) return "This function takes no parameters.";

  const hints = p.map((raw) => {
    const name = String(raw || "arg");
    const lower = name.toLowerCase();

    if (
      lower.endsWith("arr") ||
      lower.endsWith("array") ||
      lower.includes("list") ||
      lower.includes("items") ||
      lower.includes("values") ||
      lower.includes("data") ||
      lower.includes("points") ||
      lower.includes("numbers") ||
      lower.includes("records")
    ) {
      return `- ${name}: declare a small deterministic array in arrange, for example [1, 2, 3] or ["a", "b"] depending on the function.`;
    }

    if (
      lower.includes("obj") ||
      lower.includes("object") ||
      lower.includes("payload")
    ) {
      return `- ${name}: declare a small plain object in arrange with only fields clearly needed by the function source, doc comment, or usage snippet.`;
    }

    if (
      lower.includes("options") ||
      lower.includes("opts") ||
      lower.includes("config") ||
      lower.includes("settings")
    ) {
      return `- ${name}: prefer an empty object {}. Only add object keys if those exact keys clearly appear in the function code, doc comment, or usage snippet. Do not invent option/config fields.`;
    }

    if (
      lower.includes("id") ||
      lower === "n" ||
      lower.includes("count") ||
      lower.includes("size") ||
      lower.includes("length") ||
      lower.includes("index") ||
      lower.includes("limit") ||
      lower.includes("offset")
    ) {
      return `- ${name}: use a simple deterministic number like 1, 2, or 3 unless the function code, doc comment, or usage snippet clearly expects a string identifier.`;
    }

    if (
      lower.includes("prob") ||
      lower.includes("alpha") ||
      lower.includes("ratio") ||
      lower.includes("rate") ||
      lower === "p"
    ) {
      return `- ${name}: use a simple deterministic decimal like 0.5.`;
    }

    if (
      lower.includes("name") ||
      lower.includes("text") ||
      lower.includes("message") ||
      lower.includes("title") ||
      lower.includes("label") ||
      lower.includes("key") ||
      lower.includes("type") ||
      lower.includes("path") ||
      lower.includes("url") ||
      lower.includes("country") ||
      lower.includes("timezone") ||
      lower.includes("code") ||
      lower.includes("email") ||
      lower.includes("token")
    ) {
      return `- ${name}: use a concrete simple string like "sample" unless the function code, doc comment, or usage snippet clearly shows a safer example value.`;
    }

    if (
      lower.startsWith("is") ||
      lower.startsWith("has") ||
      lower.startsWith("can") ||
      lower.startsWith("should") ||
      lower.includes("flag") ||
      lower.includes("enabled") ||
      lower.includes("active")
    ) {
      return `- ${name}: use a boolean like true or false.`;
    }

    if (
      lower.includes("cb") ||
      lower.includes("callback") ||
      lower.includes("fn") ||
      lower.includes("handler") ||
      lower.includes("predicate") ||
      lower.includes("comparator") ||
      lower.includes("mapper") ||
      lower.includes("reducer") ||
      lower.includes("randomsource") ||
      lower.includes("distributiontype") ||
      lower.includes("kernel") ||
      lower.includes("bandwidthmethod")
    ) {
      return `- ${name}: declare a simple function literal in arrange, for example const ${name} = () => 0; or const ${name} = (x) => x;.`;
    }

    if (
      lower.includes("api") ||
      lower.includes("client") ||
      lower.includes("service") ||
      lower.includes("store") ||
      lower.includes("db") ||
      lower.includes("database")
    ) {
      return `- ${name}: declare a small mock-like plain object in arrange with only methods or fields clearly used by the function source.`;
    }

    return `- ${name}: declare a simple deterministic value in arrange or use a small literal directly.`;
  });

  return hints.join("\n");
}

function buildCandidateMixGuidance({ params = [] }) {
  const hasParams = Array.isArray(params) && params.length > 0;

  const lines = [
    `Generate ${MIN_REQUESTED_CANDIDATES} to ${MAX_REQUESTED_CANDIDATES} candidate test cases.`,
    "At least 2 candidates MUST be safe invariant tests.",
    "Safe invariant tests should check result shape, type, defined/null behavior, array/object structure, property existence, or broad valid output.",
    "At least 1 candidate should test normal/default behavior.",
  ];

  if (hasParams) {
    lines.push(
      "At least 1 candidate should test simple parameterized behavior using deterministic variables declared in arrange."
    );
  }

  lines.push(
    "If usage snippets are available, prefer input values and call patterns from those snippets.",
    "When snippets, comments, or source code show multiple distinct valid behaviors, spread candidates across those behaviors instead of repeating the same input shape.",
    "For rule-heavy, conditional, parser, formatter, converter, validator, matcher, or string-transform functions, include branch-oriented examples for different documented/source-obvious rules when safe expected values are clear.",
    "If doc comments are available, use them to understand parameter meaning and return shape.",
    "Only include an error/throwing test when the function code or doc comment clearly shows throwing behavior for that input.",
    "Prefer several small candidates over one large or complex candidate.",
    "It is acceptable that some candidates are broad invariants; UnitGen will runtime-validate and keep only useful passing tests."
  );

  return lines.join("\n");
}

function buildHigherOrderFunctionGuidance(functionCode = "") {
  const source = safeString(functionCode);
  const returnedFunctionCount = (source.match(/\breturn\s+function\b/g) || []).length;
  if (returnedFunctionCount === 0) {
    return "(function does not visibly return another function)";
  }

  const guidance = [
    "The source visibly returns another function, so include at least one candidate that exercises observable behavior beyond checking typeof result.",
    "Use only call layers and callback signatures that are directly visible in the source.",
    "Usage snippets may show a package namespace or public alias, but the act field must call the exact function name shown in the Function name field above; reuse the snippet behavior, not its package variable name.",
    "For a returned callback-shaped function, invoke it with small deterministic arguments and capture callback output in local variables before asserting it.",
    "If the factory returns a function that itself accepts another function, provide a tiny deterministic function matching the visible signature, invoke the next returned function, and assert its callback result or side effect.",
    "Keep the interaction synchronous unless the source clearly uses Promise or async behavior, and avoid loops or unbounded producers.",
  ];
  if (returnedFunctionCount > 1) {
    guidance.push("The source contains nested returned functions; a useful candidate should traverse the visible returned-function layers instead of invoking only the outer factory.");
  }
  return guidance.join("\n");
}
function buildGeneralTestingGuidance({ fnName, isAsync, params = [] }) {
  const paramList = (params || []).join(", ");

  return [
    "Generate practical Jest test case fragments that can be injected into an existing test harness.",
    "Prefer simple deterministic inputs so the expected result is easy to justify.",
    "Prefer meaningful assertions that check observable behavior, not internal implementation details.",
    "Prefer result-centered assertions. Most assertions should directly reference result or values derived from result.",
    "Safe exact assertions are allowed when the expected value is clear from simple inputs, directly obvious from function source, documented by comments, or shown in usage snippets.",
    "If exact behavior is not obvious, use a safe invariant assertion instead of guessing.",
    "For numeric/math/statistical functions, exact numeric assertions are allowed for simple deterministic inputs; use toBeCloseTo for decimal or floating-point results.",
    "For arrays, objects, and strings, toEqual, toStrictEqual, toBe, toHaveLength, toContain, and toHaveProperty are allowed only when the expected value is simple and clearly derived from the input, function behavior, doc comment, or usage snippet.",
    "Do not compare result to a fabricated full object, fabricated full array, or invented domain dataset.",
    "For no-argument functions that return collections/maps, prefer structural assertions like result defined, typeof result, Object.keys(result).length, Array.isArray(result), or result has a known property only if obvious.",
    "For lookup functions, prefer assertions that allow null/undefined when the input may not exist, unless the snippet/doc/source clearly proves a valid known input.",
    "For random, mutating, ordering, clustering, matrix, or shape-sensitive functions, prefer invariant assertions such as defined result, array type, length, containment, property existence, or safe structural checks instead of brittle full-output equality.",
    "For functions that mutate an input object or array, it is acceptable to assert the changed input state when the mutation is clear.",
    "For functions that return another function, assert that the result is a function, or invoke the returned function only if the behavior is obvious from the source.",
    "For callback-style parameters, declare a simple function literal in arrange and assert the returned value or callback effect only when it is clear.",
    "For options/config/settings parameters, do not invent fields. Use {} unless exact option keys appear in the function code, doc comment, or usage snippet.",
    "For async functions, do not use .resolves or .rejects in the assert field. The tool will create an async test and await the call automatically.",
    "For expected error behavior, use toThrow or toThrowError in the assert field. The tool will normalize the function call into the correct throw assertion.",
    `The act field should express only the function call intent, for example: ${fnName}(${paramList})`,
    "Do not create tests for empty, null, undefined, or invalid inputs unless the assertion explicitly expects an error.",
  ].join("\n");
}

function buildAssertionGuidance() {
  return [
    "Good safe assertion examples:",
    "- expect(result).toBeDefined();",
    "- expect(result == null || typeof result === \"object\").toBe(true);",
    "- expect(Array.isArray(result)).toBe(true);",
    "- expect(Object.keys(result).length).toBeGreaterThan(0);",
    "- expect(typeof result).toBe(\"string\");",
    "- expect(typeof result).toBe(\"number\");",
    "- expect(result).toHaveProperty(\"name\");",
    "- expect(result.length).toBeGreaterThan(0);",
    "",
    "Risky assertion examples to avoid unless directly proven by source/simple input/doc/comment/snippet:",
    "- expect(result).toEqual({ large: \"invented object\" });",
    "- expect(result).toStrictEqual([\"invented\", \"dataset\"]);",
    "- expect(result).toContain(\"invented domain value\");",
    "- expect(result).toHaveProperty(\"key\", { full: \"object\" });",
    "- expect(mockFn).toHaveBeenCalledWith(...);",
  ].join("\n");
}

function buildDocCommentSection(docComment) {
  const formatted = formatDocCommentForPrompt(docComment, 1500);

  if (!formatted || formatted.includes("No doc comment was found")) {
    return "No doc comment was found for this function.";
  }

  return trimLongText(formatted, 1500);
}

function buildUsageSnippetSection(usageSnippets = []) {
  const formatted = formatUsageSnippetsForPrompt(usageSnippets, 5);

  if (!formatted || formatted.includes("No usage snippets were found")) {
    return "No usage snippets were found for this function.";
  }

  return trimLongText(formatted, 2200);
}

function buildContextUsageRules({ hasDocComment, hasUsageSnippets }) {
  const lines = [];

  if (hasDocComment) {
    lines.push(
      "Use the doc comment as semantic guidance for parameter meaning, return type, valid inputs, and error behavior."
    );
  }

  if (hasUsageSnippets) {
    lines.push(
      "Use usage snippets as preferred examples for realistic input values and call patterns."
    );
    lines.push(
      "Do not copy whole usage snippets into arrange. Extract only the small variables needed for this function call."
    );
    lines.push(
      "If a snippet shows a valid literal input, prefer that literal over a generic placeholder like \"sample\"."
    );
    lines.push(
      "If snippets show several different input/output examples, choose diverse examples that exercise different observable behaviors."
    );
  }

  if (!hasDocComment && !hasUsageSnippets) {
    lines.push(
      "No external usage/doc context is available, so rely only on function code and safe invariants."
    );
  }

  lines.push(
    "Use module-level source context only to understand public observable behavior, such as constants, rule tables, registrations, top-level configuration, and exported helper relationships that affect this function.",
    "When module-level source shows literal valid inputs or rule-table entries, prefer those exact literals for branch-oriented examples instead of inventing new domain values.",
    "For rule tables or registration lists, diversify across different rule forms when visible: exact string rules, regular-expression/predicate rules, default/fallback behavior, and simple exception branches inside rule callbacks.",
    "If a visible rule callback has a small if/else branch with literal inputs, include one safe example for each branch when the expected result is clear.",
    "Never assert undocumented internal implementation details.",
    "Never invent domain-specific expected data that is not present in source, docs, usage snippets, or module-level source context."
  );

  return lines.join("\n");
}

function buildFileApiPromptGuidance(fnName = "", params = []) {
  const lowerFn = String(fnName || "").toLowerCase();

  const hasFileParam = (params || []).some((p) => {
    const name = String(typeof p === "string" ? p : p?.name || "").toLowerCase();
    return (
      name.includes("file") ||
      name.includes("path") ||
      name.includes("filename")
    );
  });

  if (!hasFileParam) return "";

  if (lowerFn.includes("read")) {
    return `
FILE API SPECIAL RULES:
- This is a file-read API, so real temporary file setup is allowed inside arrange.
- Do not use mocks, jest.fn(), mock assertions, require(), import, describe(), test(), or it().
- Create a real temp file in arrange using fs.writeFileSync.
- Use only variables declared in arrange.
- Do not expect fake values like "mocked file content".
- Prefer broad result assertions.

Good candidate shape:
arrange: "const file = './unitgen-temp.json';\\nfs.writeFileSync(file, '{\\"name\\":\\"unitgen\\",\\"ok\\":true}', 'utf8');\\nconst options = { encoding: 'utf8' };"
act: "readFileSync(file, options)"
assert: "expect(result).toBeDefined();\\nexpect(typeof result === 'object' || typeof result === 'string').toBe(true);"
`;
  }

  if (lowerFn.includes("write")) {
    return `
FILE API SPECIAL RULES:
- This is a file-write API, so real temporary output file setup is allowed inside arrange.
- Do not use mocks, jest.fn(), mock assertions, require(), import, describe(), test(), or it().
- Use a real temp output path.
- Declare real data/content/json input in arrange.
- Use only variables declared in arrange.
- Write APIs often return undefined, so use broad result assertions.

Good candidate shape:
arrange: "const file = './unitgen-temp-output.json';\\nconst data = { name: 'unitgen', ok: true };\\nconst options = {};"
act: "writeFileSync(file, data, options)"
assert: "expect(result === undefined || result !== undefined).toBe(true);"
`;
  }

  return "";
}

export function buildOllamaPrompt({
  fnName,
  isAsync,
  params,
  functionCode,
  harnessNotes = "",
  usageSnippets = [],
  docComment = null,
  moduleContext = "",
}) {
  const safeParams = Array.isArray(params) ? params : [];
  const paramHints = buildParamUsageHints(safeParams);
  const visibleOptionGuidance = buildVisibleOptionGuidance(functionCode);
  const candidateMixGuidance = buildCandidateMixGuidance({ params: safeParams });
  const testingGuidance = buildGeneralTestingGuidance({
    fnName,
    isAsync,
    params: safeParams,
  });
  const assertionGuidance = buildAssertionGuidance();
  const fileApiGuidance = buildFileApiPromptGuidance(fnName, safeParams);
  const higherOrderGuidance = buildHigherOrderFunctionGuidance(functionCode);

  const docCommentContext = buildDocCommentSection(docComment);
  const usageSnippetContext = buildUsageSnippetSection(usageSnippets);
  const moduleSourceContext = moduleContext
    ? trimLongText(moduleContext, 4200)
    : "No module-level source context was provided.";

  const hasDocComment =
    Boolean(docComment?.comment) ||
    Boolean(docComment?.leadingComment) ||
    Boolean(docComment?.jsDoc?.description) ||
    Boolean(docComment?.jsDoc?.params?.length) ||
    Boolean(docComment?.jsDoc?.returns);

  const hasUsageSnippets =
    Array.isArray(usageSnippets) && usageSnippets.length > 0;

  const contextUsageRules = buildContextUsageRules({
    hasDocComment,
    hasUsageSnippets,
  });

  return `
You are generating Jest test case fragments for a JavaScript function.

Function name: ${fnName}
Async: ${isAsync}
Params: ${JSON.stringify(safeParams)}

Function code:
${functionCode}

Doc/comment context:
${docCommentContext}

Usage snippet context:
${usageSnippetContext}


Module-level source context:
${moduleSourceContext}

How to use the extra context:
${contextUsageRules}

Parameter guidance:
${paramHints}
${visibleOptionGuidance ? `\n${visibleOptionGuidance}` : ""}

File API guidance:
${fileApiGuidance || "(not a file API)"}

Higher-order function guidance:
${higherOrderGuidance}

Candidate mix requirements:
${candidateMixGuidance}

General testing guidance:
${testingGuidance}

Assertion guidance:
${assertionGuidance}

Harness notes (read-only, already handled by the tool):
${harnessNotes || "(none)"}

OUTPUT FORMAT Ã¢â‚¬â€ MUST FOLLOW EXACTLY:
- Return ONLY a JSON array of test cases.
- Wrap the JSON array between these tags exactly:
<JSON>
[ ... ]
</JSON>
- Do NOT include any explanation, markdown, comments, or text before or after the JSON block.
- Do NOT use backticks.
- All JSON values MUST be valid JSON strings using double quotes.
- Escape newlines inside JSON strings as \\n.

Required schema:
<JSON>
[
  {
    "title": "short meaningful test title",
    "arrange": "const a = 1;\\nconst b = 2;",
    "act": "${fnName}(${safeParams.join(", ") || ""})",
    "assert": "expect(result).toBe(3);"
  }
]
</JSON>

Field rules:
- "title": short readable title explaining the behavior being tested.
- "arrange": declare only variables needed by the function call or assertion.
- "act": contain ONLY the function call intent, not "const result =".
- "assert": contain one or more Jest expect statements using result or values declared in arrange.

Hard restrictions:
- Do NOT write import statements.
- Do NOT write export statements.
- Do NOT write require().
- Do NOT write jest.mock or jest.unstable_mockModule.
- Do NOT write describe(), test(), or it().
- Do NOT access real network, real databases, or real environment variables.
- Do NOT access real filesystem except when FILE API SPECIAL RULES are provided above; then fs.writeFileSync may be used only inside arrange for temporary test files.- Do NOT reference helper variables, internal source variables, private helpers, or undeclared identifiers.
- Do NOT redeclare const result.
- Do NOT use .rejects or .resolves.
- Do NOT use toHaveBeenCalled, toHaveBeenCalledTimes, toHaveBeenCalledWith, toHaveBeenLastCalledWith, or toHaveBeenNthCalledWith.
- Do NOT include placeholders such as TODO, your code here, or example only.

Quality requirements:
- Provide ${MIN_REQUESTED_CANDIDATES} to ${MAX_REQUESTED_CANDIDATES} candidate test cases.
- Each test case should be small, deterministic, and independent.
- At least 2 test cases should be safe invariant tests.
- At least 1 test case should cover normal/default behavior.
- ${safeParams.length > 0 ? "At least 1 test case should cover simple parameterized behavior." : "For no-argument functions, focus on safe result shape/type/structure assertions."}
- Use concrete literals or variables declared in arrange for all required parameters.
- Use meaningful assertions where possible.
- Prefer realistic values from usage snippets or doc comments when available.
- If multiple realistic examples are available, avoid producing near-duplicate tests for the same simple/default path.
- If only a safe invariant is possible, use a safe invariant assertion rather than fabricating an exact expected value.
- Avoid huge arrays, huge objects, deeply nested structures, or brittle fabricated expected values.
- Avoid arbitrary non-empty options/config objects unless the exact keys appear in the function code, doc comment, or usage snippet.
- Prefer tests that are likely to execute successfully in isolation.

Now output ONLY the <JSON> ... </JSON> block:
`.trim();
}
