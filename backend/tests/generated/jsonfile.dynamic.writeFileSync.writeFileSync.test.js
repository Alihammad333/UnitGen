import { createRequire } from "module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const pkg = require("../../benchmark_packages/jsonfile");
const __unitgen_target__ = pkg.writeFileSync;

describe("writeFileSync", () => {
  test("should be exported as a function", () => {
    expect(typeof __unitgen_target__).toBe("function");
  });

  /*__UNITGEN_LLM_TESTS__*/
});
