/*
Renders mock plan entries into Jest mock code strings.

This renderer supports both:
1. Old/simple mock plan:
   { module, type, targets[] }

2. New/rich mock plan:
   {
     module,
     normalizedModule,
     type,
     imports,
     members,
     memberChains,
     globals,
     targets,
     usages
   }

Important:
- Internal relative/local modules are not mocked.
- Module mocks are rendered as jest.mock(...) for now because the current
  test template already knows how to place/convert mocks in the generated harness.
- Global setup code is rendered directly and must be placed before the source
  module import by the test template.
*/

function isRelativeOrLocalModule(moduleName) {
  if (!moduleName) return false;

  return (
    moduleName.startsWith("./") ||
    moduleName.startsWith("../") ||
    moduleName.startsWith("/") ||
    moduleName.startsWith("file:")
  );
}

function normalizeModuleName(moduleName) {
  return String(moduleName || "").replace(/^node:/, "");
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueArray(values) {
  return Array.from(new Set(safeArray(values).filter(Boolean)));
}

function isValidIdentifier(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(name || ""));
}

function propertyKey(name) {
  const s = String(name || "");

  if (isValidIdentifier(s)) return s;

  return JSON.stringify(s);
}

function moduleLiteral(moduleName) {
  return JSON.stringify(String(moduleName || ""));
}

function chainKey(chain) {
  return safeArray(chain).filter(Boolean).join(".");
}

function getEntryModuleName(entry) {
  return entry?.module || entry?.normalizedModule || "";
}

function getEntryNormalizedModule(entry) {
  return entry?.normalizedModule || normalizeModuleName(getEntryModuleName(entry));
}

function getEntryMembers(entry) {
  const members = [
    ...safeArray(entry?.members),
    ...safeArray(entry?.targets),
  ];

  const moduleName = getEntryModuleName(entry);
  const normalizedModule = getEntryNormalizedModule(entry);

  return uniqueArray(
    members
      .map(String)
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => x !== moduleName)
      .filter((x) => x !== normalizedModule)
      .filter((x) => x !== "default")
      .filter((x) => x !== "*")
  );
}

function getEntryMemberChains(entry) {
  const chains = [];

  for (const chain of safeArray(entry?.memberChains)) {
    if (Array.isArray(chain)) {
      const clean = chain.map(String).filter(Boolean);
      if (clean.length > 0) chains.push(clean);
      continue;
    }

    if (typeof chain === "string") {
      const clean = chain.split(".").map((x) => x.trim()).filter(Boolean);
      if (clean.length > 0) chains.push(clean);
    }
  }

  const seen = new Set();
  const out = [];

  for (const chain of chains) {
    const key = chainKey(chain);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    out.push(chain);
  }

  return out;
}

function getImportedNames(entry) {
  const names = [];

  for (const item of safeArray(entry?.imports)) {
    const importedName = String(item?.importedName || "").trim();
    const importKind = String(item?.importKind || "").trim();

    if (!importedName || importedName === "*" || importedName === "default") {
      continue;
    }

    if (
      [
        "named",
        "destructured-require",
        "destructured-dynamic-import",
        "destructured-rest",
      ].includes(importKind)
    ) {
      names.push(importedName);
    }
  }

  return uniqueArray(names);
}

function isPromiseLikeMember(memberName) {
  const lower = String(memberName || "").toLowerCase();

  return (
    lower.includes("async") ||
    lower.includes("promise") ||
    lower.includes("fetch") ||
    lower.includes("request") ||
    lower.includes("get") ||
    lower.includes("post") ||
    lower.includes("put") ||
    lower.includes("patch") ||
    lower.includes("delete") ||
    lower.includes("readfile") ||
    lower.includes("writefile") ||
    lower.includes("ensure") ||
    lower.includes("connect") ||
    lower.includes("query") ||
    lower.includes("find") ||
    lower.includes("save")
  );
}

function mockFunctionExpression(memberName, moduleName = "") {
  const member = String(memberName || "");
  const lower = member.toLowerCase();
  const normalizedModule = normalizeModuleName(moduleName);

  if (normalizedModule === "path") {
    if (member === "join" || member === "resolve") {
      return "jest.fn((...parts) => parts.filter(Boolean).join('/'))";
    }

    if (member === "dirname") {
      return "jest.fn((p) => String(p).split('/').slice(0, -1).join('/') || '.')";
    }

    if (member === "basename") {
      return "jest.fn((p) => String(p).split('/').pop())";
    }

    if (member === "extname") {
      return `jest.fn((p) => {
        const base = String(p).split("/").pop() || "";
        const i = base.lastIndexOf(".");
        return i >= 0 ? base.slice(i) : "";
      })`;
    }

    return "jest.fn((...parts) => parts.filter(Boolean).join('/'))";
  }

  if (normalizedModule === "fs" || normalizedModule === "fs/promises") {
    if (lower.includes("exists")) return "jest.fn(() => true)";
    if (lower === "access" || lower === "accesssync") {
      if (normalizedModule === "fs/promises") {
        return "jest.fn().mockResolvedValue(undefined)";
      }

      return `jest.fn((...args) => {
        const cb = args.find((x) => typeof x === "function");
        if (cb) cb(null);
        return undefined;
      })`;
    }
    if (lower === "createwritestream") {
      return `jest.fn(() => ({
        on: jest.fn(function (event, handler) {
          if (event === "close" && typeof handler === "function") handler();
          return this;
        }),
        once: jest.fn(function (event, handler) {
          if (event === "close" && typeof handler === "function") handler();
          return this;
        }),
        emit: jest.fn(),
        addListener: jest.fn(function () { return this; }),
        removeListener: jest.fn(function () { return this; }),
        off: jest.fn(function () { return this; }),
        listenerCount: jest.fn(() => 0),
        write: jest.fn(() => true),
        end: jest.fn()
      }))`;
    }
    if (lower === "createreadstream") {
      return `jest.fn(() => ({
        on: jest.fn(function () { return this; }),
        once: jest.fn(function () { return this; }),
        pipe: jest.fn((destination) => destination)
      }))`;
    }
    if (lower.includes("readfilesync")) return "jest.fn(() => 'dummy file')";

    if (lower.includes("readfile")) {
      if (normalizedModule === "fs/promises") {
        return "jest.fn().mockResolvedValue('dummy file')";
      }

      return `jest.fn((...args) => {
        const cb = args.find((x) => typeof x === "function");
        if (cb) cb(null, "dummy file");
        return undefined;
      })`;
    }

    if (lower.includes("writefilesync")) return "jest.fn(() => undefined)";

    if (lower.includes("writefile")) {
      if (normalizedModule === "fs/promises") {
        return "jest.fn().mockResolvedValue(undefined)";
      }

      return `jest.fn((...args) => {
        const cb = args.find((x) => typeof x === "function");
        if (cb) cb(null);
        return undefined;
      })`;
    }

    if (lower.includes("mkdir") || lower.includes("ensure")) {
      return normalizedModule === "fs/promises"
        ? "jest.fn().mockResolvedValue(undefined)"
        : "jest.fn(() => undefined)";
    }

    if (lower.includes("stat")) {
      if (normalizedModule === "fs/promises") {
        return "jest.fn().mockResolvedValue({ isFile: () => true, isDirectory: () => false })";
      }

      if (lower.endsWith("sync")) {
        return "jest.fn(() => ({ isFile: () => true, isDirectory: () => false }))";
      }

      return `jest.fn((...args) => {
        const value = { isFile: () => true, isDirectory: () => false };
        const cb = args.find((x) => typeof x === "function");
        if (cb) cb(null, value);
        return value;
      })`;
    }

    if (lower.includes("readdir")) {
      if (normalizedModule === "fs/promises") {
        return "jest.fn().mockResolvedValue([])";
      }

      if (lower.endsWith("sync")) {
        return "jest.fn(() => [])";
      }

      return `jest.fn((...args) => {
        const cb = args.find((x) => typeof x === "function");
        if (cb) cb(null, []);
        return [];
      })`;
    }

    return "jest.fn(() => undefined)";
  }

  if (normalizedModule === "axios") {
    if (
      ["get", "post", "put", "patch", "delete", "request", "head", "options"].includes(
        lower
      )
    ) {
      return "jest.fn().mockResolvedValue({ data: {}, status: 200, headers: {} })";
    }

    if (lower === "create") {
      return "jest.fn(() => api)";
    }
  }

  if (isPromiseLikeMember(member)) {
    return "jest.fn().mockResolvedValue({ data: {}, status: 200 })";
  }

  return "jest.fn()";
}

function insertChain(root, chain, moduleName) {
  if (!Array.isArray(chain) || chain.length === 0) return;

  let current = root;

  for (let i = 0; i < chain.length; i++) {
    const part = String(chain[i] || "").trim();
    if (!part) continue;

    const isLast = i === chain.length - 1;

    if (isLast) {
      if (!current[part]) {
        current[part] = {
          __kind: "raw",
          value: mockFunctionExpression(part, moduleName),
        };
      }
      continue;
    }

    if (!current[part] || current[part].__kind === "raw") {
      current[part] = {};
    }

    current = current[part];
  }
}

function raw(value) {
  return {
    __kind: "raw",
    value,
  };
}

function renderObjectLiteralFromTree(tree, indent = 2) {
  const pad = " ".repeat(indent);
  const childPad = " ".repeat(indent + 2);

  const entries = Object.entries(tree || {});
  if (entries.length === 0) return "{}";

  const lines = ["{"];

  for (const [key, value] of entries) {
    if (value?.__kind === "raw") {
      lines.push(`${childPad}${propertyKey(key)}: ${value.value},`);
    } else {
      lines.push(
        `${childPad}${propertyKey(key)}: ${renderObjectLiteralFromTree(
          value,
          indent + 2
        )},`
      );
    }
  }

  lines.push(`${pad}}`);
  return lines.join("\n");
}

function buildGenericApiObject({ moduleName, members = [], memberChains = [] }) {
  const tree = {};
  const normalizedModule = normalizeModuleName(moduleName);

  const defaultMembers = [
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "request",
    "create",
  ];

  for (const member of uniqueArray([...defaultMembers, ...members])) {
    if (!member || member.includes(".")) continue;
    tree[member] = raw(mockFunctionExpression(member, normalizedModule));
  }

  for (const chain of memberChains) {
    insertChain(tree, chain, normalizedModule);
  }

  return renderObjectLiteralFromTree(tree, 4);
}

function renderFsMock(entry) {
  const moduleName = getEntryModuleName(entry);
  const normalizedModule = getEntryNormalizedModule(entry);

  if (normalizedModule === "fs/promises") {
    const members = uniqueArray([
      "readFile",
      "writeFile",
      "mkdir",
      "readdir",
      "stat",
      "access",
      "unlink",
      "rm",
      "copyFile",
      ...getEntryMembers(entry),
      ...getImportedNames(entry),
    ]);

    const tree = {};
    for (const member of members) {
      tree[member] = raw(mockFunctionExpression(member, "fs/promises"));
    }

    const objectLiteral = renderObjectLiteralFromTree(tree, 4);

    return `jest.mock(${moduleLiteral(moduleName)}, () => {
  const api = ${objectLiteral};

  return {
    __esModule: true,
    ...api,
    default: api
  };
});`;
  }

  const members = uniqueArray([
    "readFileSync",
    "writeFileSync",
    "existsSync",
    "mkdirSync",
    "rmSync",
    "unlinkSync",
    "readdirSync",
    "statSync",
    "readFile",
    "writeFile",
    "readdir",
    "stat",
    "lstat",
    ...getEntryMembers(entry),
    ...getImportedNames(entry),
  ]);

  const topLevelTree = {};
  for (const member of members) {
    topLevelTree[member] = raw(mockFunctionExpression(member, "fs"));
  }

  const chains = getEntryMemberChains(entry);
  for (const chain of chains) {
    insertChain(topLevelTree, chain, "fs");
  }

  if (topLevelTree.constants && !topLevelTree.constants.__kind) {
    for (const constantName of Object.keys(topLevelTree.constants)) {
      topLevelTree.constants[constantName] = raw("0");
    }
  }

  if (!topLevelTree.promises) {
    topLevelTree.promises = {};
  }

  const promiseMembers = [
    "readFile",
    "writeFile",
    "mkdir",
    "readdir",
    "stat",
    "access",
    "unlink",
    "rm",
    "copyFile",
  ];

  for (const member of promiseMembers) {
    topLevelTree.promises[member] = raw(
      mockFunctionExpression(member, "fs/promises")
    );
  }

  const objectLiteral = renderObjectLiteralFromTree(topLevelTree, 4);

  return `jest.mock(${moduleLiteral(moduleName)}, () => {
  const api = ${objectLiteral};

  return {
    __esModule: true,
    ...api,
    default: api
  };
});`;
}

function renderPathMock(entry) {
  const moduleName = getEntryModuleName(entry);

  const members = uniqueArray([
    "join",
    "resolve",
    "dirname",
    "basename",
    "extname",
    "normalize",
    "relative",
    ...getEntryMembers(entry),
    ...getImportedNames(entry),
  ]);

  const tree = {};

  for (const member of members) {
    tree[member] = raw(mockFunctionExpression(member, "path"));
  }

  const objectLiteral = renderObjectLiteralFromTree(tree, 4);

  return `jest.mock(${moduleLiteral(moduleName)}, () => {
  const api = ${objectLiteral};

  return {
    __esModule: true,
    ...api,
    default: api
  };
});`;
}

function renderOsMock(entry) {
  const moduleName = getEntryModuleName(entry);

  const members = uniqueArray([
    "platform",
    "homedir",
    "tmpdir",
    "hostname",
    "cpus",
    "userInfo",
    ...getEntryMembers(entry),
    ...getImportedNames(entry),
  ]);

  const tree = {};

  for (const member of members) {
    const lower = String(member).toLowerCase();

    if (lower === "platform") tree[member] = raw("jest.fn(() => 'linux')");
    else if (lower === "homedir") tree[member] = raw("jest.fn(() => '/home/unitgen')");
    else if (lower === "tmpdir") tree[member] = raw("jest.fn(() => '/tmp')");
    else if (lower === "hostname") tree[member] = raw("jest.fn(() => 'unitgen-host')");
    else if (lower === "cpus") tree[member] = raw("jest.fn(() => [])");
    else if (lower === "userinfo") {
      tree[member] = raw("jest.fn(() => ({ username: 'unitgen' }))");
    } else {
      tree[member] = raw("jest.fn()");
    }
  }

  const objectLiteral = renderObjectLiteralFromTree(tree, 4);

  return `jest.mock(${moduleLiteral(moduleName)}, () => {
  const api = ${objectLiteral};

  return {
    __esModule: true,
    ...api,
    default: api
  };
});`;
}

function renderCryptoMock(entry) {
  const moduleName = getEntryModuleName(entry);

  const members = uniqueArray([
    "randomUUID",
    "randomBytes",
    "createHash",
    ...getEntryMembers(entry),
    ...getImportedNames(entry),
  ]);

  const tree = {};

  for (const member of members) {
    const lower = String(member).toLowerCase();

    if (lower === "randomuuid") {
      tree[member] = raw("jest.fn(() => '00000000-0000-4000-8000-000000000000')");
    } else if (lower === "randombytes") {
      tree[member] = raw("jest.fn(() => Buffer.from('unitgen'))");
    } else if (lower === "createhash") {
      tree[member] = raw(`jest.fn(() => ({
        update: jest.fn(() => ({
          digest: jest.fn(() => 'unitgen-hash')
        }))
      }))`);
    } else {
      tree[member] = raw("jest.fn()");
    }
  }

  const objectLiteral = renderObjectLiteralFromTree(tree, 4);

  return `jest.mock(${moduleLiteral(moduleName)}, () => {
  const api = ${objectLiteral};

  return {
    __esModule: true,
    ...api,
    default: api
  };
});`;
}

function renderBuiltinMock(entry) {
  const normalizedModule = getEntryNormalizedModule(entry);

  if (normalizedModule === "fs" || normalizedModule === "fs/promises") {
    return renderFsMock(entry);
  }

  if (normalizedModule === "path") {
    return renderPathMock(entry);
  }

  if (normalizedModule === "os") {
    return renderOsMock(entry);
  }

  if (normalizedModule === "crypto") {
    return renderCryptoMock(entry);
  }

  const moduleName = getEntryModuleName(entry);
  const members = uniqueArray([
    ...getEntryMembers(entry),
    ...getImportedNames(entry),
  ]);

  const chains = getEntryMemberChains(entry);
  const tree = {};

  for (const member of members) {
    tree[member] = raw(mockFunctionExpression(member, normalizedModule));
  }

  for (const chain of chains) {
    insertChain(tree, chain, normalizedModule);
  }

  const objectLiteral = renderObjectLiteralFromTree(tree, 4);

  return `jest.mock(${moduleLiteral(moduleName)}, () => {
  const api = ${objectLiteral};

  return {
    __esModule: true,
    ...api,
    default: api
  };
});`;
}

function renderAxiosMock(entry) {
  const moduleName = getEntryModuleName(entry);

  const members = uniqueArray([
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "request",
    "head",
    "options",
    "create",
    ...getEntryMembers(entry),
    ...getImportedNames(entry),
  ]);

  const chains = getEntryMemberChains(entry);
  const objectLiteral = buildGenericApiObject({
    moduleName: "axios",
    members,
    memberChains: chains,
  });

  return `jest.mock(${moduleLiteral(moduleName)}, () => {
  const api = ${objectLiteral};

  return {
    __esModule: true,
    ...api,
    default: api
  };
}, { virtual: true });`;
}

function renderHttpStyleMock(entry) {
  const moduleName = getEntryModuleName(entry);
  const members = uniqueArray([
    "http",
    "https",
    ...getEntryMembers(entry),
    ...getImportedNames(entry),
  ]);

  const lines = members
    .filter((member) => member === "http" || member === "https")
    .map((member) => `    ${propertyKey(member)}: makeClient(),`);

  return `jest.mock(${moduleLiteral(moduleName)}, () => {
  const makeClient = () => ({
    get: jest.fn((url, options, callback) => {
      const cb = typeof options === "function" ? options : callback;
      const output = {
        on: jest.fn(function () { return this; }),
        once: jest.fn(function (event, handler) {
          if (event === "close" && typeof handler === "function") handler();
          return this;
        })
      };
      const response = {
        statusCode: 200,
        resume: jest.fn(),
        pipe: jest.fn(() => output)
      };
      if (typeof cb === "function") cb(response);
      return {
        on: jest.fn(function () { return this; })
      };
    })
  });
  const api = {
${lines.join("\n")}
  };

  return {
    __esModule: true,
    ...api,
    default: api
  };
}, { virtual: true });`;
}
function renderArchiveFactoryMock(entry) {
  const moduleName = getEntryModuleName(entry);

  return `jest.mock(${moduleLiteral(moduleName)}, () => {
  const createArchive = jest.fn(() => ({
    pipe: jest.fn(function () { return this; }),
    directory: jest.fn(function () { return this; }),
    file: jest.fn(function () { return this; }),
    append: jest.fn(function () { return this; }),
    finalize: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(function () { return this; }),
    once: jest.fn(function () { return this; })
  }));

  createArchive.default = createArchive;
  createArchive.__esModule = true;
  return createArchive;
}, { virtual: true });`;
}
function renderExternalMock(entry) {
  const moduleName = getEntryModuleName(entry);
  const normalizedModule = getEntryNormalizedModule(entry);

  if (normalizedModule === "axios") {
    return renderAxiosMock(entry);
  }

  if (
    normalizedModule === "archiver" ||
    normalizedModule.includes("archive") ||
    normalizedModule.includes("compress")
  ) {
    return renderArchiveFactoryMock(entry);
  }
  const importedNames = getImportedNames(entry).map((name) =>
    String(name || "").toLowerCase()
  );

  if (
    normalizedModule === "follow-redirects" ||
    (importedNames.includes("http") && importedNames.includes("https"))
  ) {
    return renderHttpStyleMock(entry);
  }

  const members = uniqueArray([
    ...getEntryMembers(entry),
    ...getImportedNames(entry),
  ]);

  const chains = getEntryMemberChains(entry);

  const objectLiteral = buildGenericApiObject({
    moduleName,
    members,
    memberChains: chains,
  });

  return `jest.mock(${moduleLiteral(moduleName)}, () => {
  const api = ${objectLiteral};

  return {
    __esModule: true,
    ...api,
    default: api
  };
}, { virtual: true });`;
}

function renderGlobalFetchMock() {
  return `globalThis.fetch = jest.fn().mockResolvedValue({
  ok: true,
  status: 200,
  headers: {
    get: jest.fn(() => null)
  },
  json: async () => ({}),
  text: async () => "",
  arrayBuffer: async () => new ArrayBuffer(0),
  blob: async () => ({})
});`;
}

function renderGlobalProcessMock() {
  return `const __unitgenOriginalEnv = process.env;

process.env = {
  ...__unitgenOriginalEnv,
  NODE_ENV: "test",
  UNITGEN_TEST: "true"
};

afterAll(() => {
  process.env = __unitgenOriginalEnv;
});`;
}

function renderGlobalBufferMock() {
  return "";
}

function renderGlobalURLMock() {
  return "";
}

function renderGlobalMock(entry) {
  const moduleName = getEntryModuleName(entry);
  const normalized = getEntryNormalizedModule(entry);

  const globalName = String(moduleName || normalized || "").replace(/^global:/, "");

  if (globalName === "fetch") return renderGlobalFetchMock();
  if (globalName === "process") return renderGlobalProcessMock();
  if (globalName === "Buffer") return renderGlobalBufferMock();
  if (globalName === "URL") return renderGlobalURLMock();
  if (globalName === "URLSearchParams") return renderGlobalURLMock();

  if (!globalName) return "";

  return `globalThis[${JSON.stringify(globalName)}] = globalThis[${JSON.stringify(
    globalName
  )}] || jest.fn();`;
}

function shouldSkipEntry(entry) {
  const moduleName = getEntryModuleName(entry);

  if (!moduleName) return true;
  if (isRelativeOrLocalModule(moduleName)) return true;

  return false;
}

function renderEntry(entry) {
  if (shouldSkipEntry(entry)) return "";

  const type = entry?.type;
  const moduleName = getEntryModuleName(entry);

  if (type === "global" || String(moduleName).startsWith("global:")) {
    return renderGlobalMock(entry);
  }

  if (type === "builtin") {
    return renderBuiltinMock(entry);
  }

  return renderExternalMock(entry);
}

function dedupeCodeBlocks(blocks) {
  const seen = new Set();
  const out = [];

  for (const block of blocks || []) {
    const code = String(block || "").trim();
    if (!code) continue;

    if (seen.has(code)) continue;

    seen.add(code);
    out.push(code);
  }

  return out;
}

function shouldPreserveCommonJsMock(entry) {
  const imports = Array.isArray(entry?.imports) ? entry.imports : [];
  return imports.length > 0 && imports.every((item) => item?.sourceType === "cjs");
}

function markCommonJsMock(code) {
  return String(code || "").replace(
    /\bjest\.mock\s*\(/,
    "jest.mock(/*__UNITGEN_CJS_MOCK__*/ "
  );
}
export function renderJestMocksForFunction(mockEntries) {
  if (!mockEntries || mockEntries.length === 0) return "";

  const blocks = [];

  for (const entry of mockEntries) {
    let code = renderEntry(entry);
    if (code && shouldPreserveCommonJsMock(entry)) {
      code = markCommonJsMock(code);
    }
    if (code) blocks.push(code);
  }

  return dedupeCodeBlocks(blocks).join("\n\n");
}

/*
Renders Jest mocks for the full mockPlan:
{ fnName -> [entries] }  => { fnName -> "jest.mock(...)" }
*/
export function renderJestMocks(mockPlan) {
  const out = {};

  for (const [fnName, entries] of Object.entries(mockPlan || {})) {
    out[fnName] = renderJestMocksForFunction(entries);
  }

  return out;
}
