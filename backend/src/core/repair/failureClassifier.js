function classifyFailure(errorText = "") {
  const raw = String(errorText || "");
  const text = raw.toLowerCase();

  // Syntax / parse errors
  if (
    text.includes("syntaxerror") ||
    text.includes("unexpected token") ||
    text.includes("unexpected identifier") ||
    text.includes("unexpected end of input") ||
    text.includes("missing )") ||
    text.includes("missing ]") ||
    text.includes("missing }")
  ) {
    return {
      errorType: "SYNTAX_ERROR",
      failureType: "SYNTAX",
    };
  }

  // Reference / undefined variable errors
  if (
    text.includes("referenceerror") ||
    text.includes("is not defined")
  ) {
    return {
      errorType: "REFERENCE_ERROR",
      failureType: "REFERENCE",
    };
  }

  // Import / module resolution errors
  if (
    text.includes("cannot find module") ||
    text.includes("module not found") ||
    text.includes("cannot resolve module") ||
    text.includes("err_module_not_found")
  ) {
    return {
      errorType: "IMPORT_ERROR",
      failureType: "IMPORT",
    };
  }

  // Timeout / async completion failures
  if (
    text.includes("timeout") ||
    text.includes("exceeded timeout") ||
    text.includes("async callback was not invoked")
  ) {
    return {
      errorType: "TIMEOUT_ERROR",
      failureType: "TIMEOUT",
    };
  }

  if (
    text.includes(".rejects") ||
    text.includes(".resolves") ||
    text.includes("rejected promise") ||
    text.includes("received promise rejected instead of resolved") ||
    text.includes("received promise resolved instead of rejected")
  ) {
    return {
      errorType: "ASYNC_ERROR",
      failureType: "ASYNC",
    };
  }

  // Type errors
  if (
    text.includes("typeerror") ||
    text.includes("cannot read properties of undefined") ||
    text.includes("cannot read properties of null") ||
    text.includes("cannot read property") ||
    text.includes("is not a function")
  ) {
    return {
      errorType: "TYPE_ERROR",
      failureType: "TYPE",
    };
  }

  /*
   * Assertion / expectation failures
   *
   * Important:
   * This must run BEFORE runtime-throw classification because Jest assertion
   * messages often start with "Error: expect(received)...".
   * If runtime throw checks run first, normal oracle failures become
   * RUNTIME_THROW incorrectly.
   */
  if (
    text.includes("expect(received)") ||
    text.includes("expected:") ||
    text.includes("received:") ||
    text.includes("expected -") ||
    text.includes("received +") ||
    text.includes("assertionerror") ||
    text.includes("object.is equality") ||
    text.includes("deep equality") ||
    text.includes("expect(") ||
    text.includes("tobe") ||
    text.includes("toequal") ||
    text.includes("tostrictequal") ||
    text.includes("tobecloseto") ||
    text.includes("tocontain") ||
    text.includes("tohaveproperty") ||
    text.includes("tohavebeen") ||
    text.includes("tothrow") ||
    text.includes("did not throw") ||
    text.includes("received function did not throw")
  ) {
    return {
      errorType: "ASSERTION_ERROR",
      failureType: "ASSERTION",
    };
  }

  // Explicit runtime throws from the function under test
  if (
    text.includes("error:") ||
    text.includes("thrown:") ||
    text.includes("uncaught") ||
    text.includes("division by zero")
  ) {
    return {
      errorType: "UNEXPECTED_THROW",
      failureType: "RUNTIME_THROW",
    };
  }

  return {
    errorType: "UNKNOWN_ERROR",
    failureType: "UNKNOWN",
  };
}

export { classifyFailure };