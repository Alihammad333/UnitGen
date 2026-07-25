const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";

const isDev = !app.isPackaged;
const backendPath = isDev
  ? path.join(__dirname, "../../backend")
  : path.join(process.resourcesPath, "backend");

let mainWindow = null;
let activeChild = null;

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function defaultSettings() {
  return {
    apiKey: "",
    provider: "openai",
    openai: {
      model: "gpt-3.5-turbo"
    },
    ollama: {
      host: DEFAULT_OLLAMA_HOST,
      model: "qwen2.5:1.5b"
    },
    advanced: {
      UNITGEN_REPAIR_CANDIDATES_PER_FUNCTION: 1,
      UNITGEN_DYNAMIC_API_MAX_DEPTH: 4,
      UNITGEN_DYNAMIC_API_MAX_APIS: 120,
      UNITGEN_MOCK_TOP_LEVEL_EXTERNALS: true
    },
    model: "gpt-3.5-turbo",
    advancedVars: {
      UNITGEN_REPAIR_CANDIDATES_PER_FUNCTION: 1,
      UNITGEN_DYNAMIC_API_MAX_DEPTH: 4,
      UNITGEN_DYNAMIC_API_MAX_APIS: 120,
      UNITGEN_MOCK_TOP_LEVEL_EXTERNALS: true
    }
  };
}

function readSettingsFile() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function decryptApiKey(record = {}) {
  if (!record.apiKeyEncrypted) return "";

  try {
    const buffer = Buffer.from(record.apiKeyEncrypted, "base64");
    return safeStorage.decryptString(buffer);
  } catch {
    return "";
  }
}

function normalizeProvider(provider) {
  const value = String(provider || "openai").toLowerCase();
  return value === "ollama" ? "ollama" : "openai";
}

function normalizeOllamaHost(host = DEFAULT_OLLAMA_HOST) {
  return String(host || DEFAULT_OLLAMA_HOST).trim().replace(/\/+$/, "");
}

function loadSettings() {
  const stored = readSettingsFile();
  const defaults = defaultSettings();
  const provider = normalizeProvider(stored.provider);
  const openai = {
    ...defaults.openai,
    ...(stored.openai || {}),
    model: stored.openai?.model || stored.model || defaults.openai.model
  };
  const ollama = {
    ...defaults.ollama,
    ...(stored.ollama || {}),
    host: normalizeOllamaHost(stored.ollama?.host || defaults.ollama.host),
    model: stored.ollama?.model || defaults.ollama.model
  };
  const advanced = {
    ...defaults.advanced,
    ...(stored.advanced || stored.advancedVars || {})
  };

  return {
    ...defaults,
    provider,
    openai,
    ollama,
    advanced,
    apiKey: decryptApiKey(stored),
    model: openai.model,
    advancedVars: advanced
  };
}

function saveSettings(data = {}) {
  const existing = readSettingsFile();
  const defaults = defaultSettings();
  const provider = normalizeProvider(data.provider || existing.provider);
  const settings = {
    provider,
    openai: {
      ...defaults.openai,
      ...(existing.openai || {}),
      ...(data.openai || {})
    },
    ollama: {
      ...defaults.ollama,
      ...(existing.ollama || {}),
      ...(data.ollama || {})
    },
    advanced: {
      ...defaults.advanced,
      ...(existing.advanced || existing.advancedVars || {}),
      ...(data.advanced || data.advancedVars || {})
    }
  };

  settings.ollama.host = normalizeOllamaHost(settings.ollama.host);

  if (typeof data.apiKey === "string" && data.apiKey.trim()) {
    const encrypted = safeStorage.encryptString(data.apiKey.trim());
    settings.apiKeyEncrypted = encrypted.toString("base64");
  } else if (data.apiKey === "") {
    delete settings.apiKeyEncrypted;
  }

  delete settings.apiKey;
  delete settings.model;
  delete settings.advancedVars;
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    resizable: true,
    backgroundColor: "#f9fafb",
    icon: path.join(__dirname, "../build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function timestamp() {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function splitLines(buffer, chunk, onLine) {
  const text = buffer + String(chunk || "");
  const lines = text.split(/\r?\n/);
  const nextBuffer = lines.pop() || "";

  for (const line of lines) {
    if (line.trim()) onLine(line);
  }

  return nextBuffer;
}

function parseBackendLine(line) {
  const time = timestamp();
  const eventMarker = "__UNITGEN_EVENT__";
  const markerIndex = line.indexOf(eventMarker);

  if (markerIndex >= 0) {
    const event = line.slice(markerIndex + eventMarker.length).trim();
    send("unitgen:event", { event, timestamp: time });
    return;
  }

  send("unitgen:log", { line, timestamp: time });
}

function readFinalReport() {
  try {
    const reportPath = path.join(backendPath, "output", "final-report.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    return augmentReportForDesktop(report);
  } catch {
    return null;
  }
}

function readGeneratedTestFiles() {
  const generatedDir = path.join(backendPath, "tests", "generated");
  if (!fs.existsSync(generatedDir)) return [];

  return fs
    .readdirSync(generatedDir)
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => {
      const filePath = path.join(generatedDir, name);
      let source = "";

      try {
        source = fs.readFileSync(filePath, "utf8");
      } catch {
        source = "";
      }

      return { fileName: name, filePath, source };
    });
}

function extractDesktopDependencies(testFiles = []) {
  const dependencies = [];

  for (const file of testFiles) {
    const mockRegex = /jest\.(?:mock|unstable_mockModule)\(\s*["']([^"']+)["'][\s\S]*?\n\s*\}\);/g;
    let match;

    while ((match = mockRegex.exec(file.source))) {
      const moduleName = match[1];
      dependencies.push({
        moduleName,
        file: file.filePath,
        call: moduleName,
        mock: match[0].slice(0, 1200)
      });
    }

    if (file.source.includes("globalThis.fetch")) {
      dependencies.push({
        moduleName: "global:fetch",
        file: file.filePath,
        call: "globalThis.fetch(...)",
        mock: "globalThis.fetch = jest.fn().mockResolvedValue({ data: {} });"
      });
    }

    if (file.source.includes("process.env")) {
      dependencies.push({
        moduleName: "global:process.env",
        file: file.filePath,
        call: "process.env",
        mock: "process.env = { ...process.env, UNITGEN_TEST: 'true' };"
      });
    }
  }

  return dependencies.slice(0, 40);
}

function extractDesktopAssertionQuality(testFiles = []) {
  const weakMatchers = [
    "toBeDefined",
    "toBeTruthy",
    "toBeFalsy",
    "toEqual(expect.anything())"
  ];
  const items = [];

  for (const file of testFiles) {
    const lines = file.source.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("expect(")) continue;
      if (!weakMatchers.some((matcher) => trimmed.includes(matcher))) continue;

      items.push({
        file: file.filePath,
        original: trimmed,
        suggested: "Prefer an exact value, shape, type, or range assertion based on the observed result."
      });
    }
  }

  return items.slice(0, 40);
}

function augmentReportForDesktop(report) {
  const testFiles = readGeneratedTestFiles();

  return {
    ...report,
    desktop: {
      generatedTests: testFiles.map((file) => ({
        fileName: file.fileName,
        filePath: file.filePath
      })),
      dependencies: extractDesktopDependencies(testFiles),
      assertionQuality: extractDesktopAssertionQuality(testFiles)
    }
  };
}

function normalizeAdvancedEnv(advancedVars = {}) {
  const env = {};

  if (advancedVars.UNITGEN_REPAIR_CANDIDATES_PER_FUNCTION !== undefined) {
    env.UNITGEN_REPAIR_CANDIDATES_PER_FUNCTION = String(
      advancedVars.UNITGEN_REPAIR_CANDIDATES_PER_FUNCTION
    );
  }

  if (advancedVars.UNITGEN_DYNAMIC_API_MAX_DEPTH !== undefined) {
    env.UNITGEN_DYNAMIC_API_MAX_DEPTH = String(
      advancedVars.UNITGEN_DYNAMIC_API_MAX_DEPTH
    );
  }

  if (advancedVars.UNITGEN_DYNAMIC_API_MAX_APIS !== undefined) {
    env.UNITGEN_DYNAMIC_API_MAX_APIS = String(
      advancedVars.UNITGEN_DYNAMIC_API_MAX_APIS
    );
  }

  if (advancedVars.UNITGEN_MOCK_TOP_LEVEL_EXTERNALS !== undefined) {
    env.UNITGEN_MOCK_TOP_LEVEL_EXTERNALS =
      advancedVars.UNITGEN_MOCK_TOP_LEVEL_EXTERNALS ? "true" : "false";
  }

  return env;
}

function buildProviderEnv(settings = {}, envVars = {}) {
  const provider = normalizeProvider(envVars.provider || settings.provider);

  if (provider === "ollama") {
    const host = normalizeOllamaHost(
      envVars.ollama?.host || settings.ollama?.host || DEFAULT_OLLAMA_HOST
    );
    const model =
      envVars.ollama?.model || settings.ollama?.model || "qwen2.5:1.5b";

    return {
      OPENAI_API_KEY: "ollama",
      OPENAI_BASE_URL: `${host}/v1`,
      OPENAI_MODEL: model
    };
  }

  return {
    OPENAI_API_KEY: settings.apiKey,
    OPENAI_BASE_URL,
    OPENAI_MODEL:
      envVars.openai?.model ||
      envVars.model ||
      settings.openai?.model ||
      "gpt-3.5-turbo"
  };
}

async function checkOllamaConnection(host) {
  const cleanHost = normalizeOllamaHost(host);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${cleanHost}/api/tags`, {
      method: "GET",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const models = Array.isArray(data.models)
      ? data.models
          .map((model) => model?.name || model?.model)
          .filter(Boolean)
      : [];

    return { ok: true, models, error: null };
  } catch (error) {
    return {
      ok: false,
      models: null,
      error: error?.message || "Could not connect"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Source folder does not exist: ${source}`);
  }

  fs.mkdirSync(destination, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

ipcMain.handle("dialog:openPath", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select JavaScript file or Node.js project folder",
    properties: ["openFile", "openDirectory"],
    filters: [
      { name: "JavaScript", extensions: ["js", "mjs", "cjs"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("settings:load", async () => loadSettings());

ipcMain.handle("settings:save", async (_event, data) => {
  saveSettings(data);
  return loadSettings();
});

ipcMain.handle("ollama:checkConnection", async (_event, host) =>
  checkOllamaConnection(host)
);

ipcMain.handle("shell:openExternal", async (_event, url) => {
  await shell.openExternal(url);
  return true;
});

ipcMain.handle("unitgen:run", async (_event, targetPath, envVars = {}) => {
  if (activeChild) {
    throw new Error("UnitGen is already running.");
  }

  if (!targetPath) {
    throw new Error("No target path selected.");
  }

  const settings = loadSettings();
  const provider = normalizeProvider(envVars.provider || settings.provider);
  if (provider === "openai" && !settings.apiKey) {
    throw new Error("OpenAI API key is missing.");
  }
  const providerEnv = buildProviderEnv(settings, envVars);

  let stdoutBuffer = "";
  let stderrBuffer = "";

  activeChild = spawn("node", ["src/index.js", targetPath], {
    cwd: backendPath,
    env: {
      ...process.env,
      ...providerEnv,
      ...normalizeAdvancedEnv(
        envVars.advanced || envVars.advancedVars || settings.advanced
      )
    },
    windowsHide: true
  });

  activeChild.stdout.on("data", (chunk) => {
    stdoutBuffer = splitLines(stdoutBuffer, chunk, parseBackendLine);
  });

  activeChild.stderr.on("data", (chunk) => {
    stderrBuffer = splitLines(stderrBuffer, chunk, (line) => {
      send("unitgen:log", { line, timestamp: timestamp() });
    });
  });

  activeChild.on("error", (error) => {
    send("unitgen:log", {
      line: `Failed to start backend: ${error.message}`,
      timestamp: timestamp()
    });
  });

  activeChild.on("close", (exitCode) => {
    if (stdoutBuffer.trim()) parseBackendLine(stdoutBuffer.trim());
    if (stderrBuffer.trim()) {
      send("unitgen:log", { line: stderrBuffer.trim(), timestamp: timestamp() });
    }

    const report = readFinalReport();
    activeChild = null;
    send("unitgen:done", { exitCode, report });
  });
});

ipcMain.handle("unitgen:stop", async () => {
  if (!activeChild) return false;

  activeChild.kill("SIGTERM");

  setTimeout(() => {
    if (activeChild) activeChild.kill("SIGKILL");
  }, 2500);

  return true;
});

ipcMain.handle("unitgen:downloadTests", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose folder for generated test suite",
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || !result.filePaths.length) return null;

  const source = path.join(backendPath, "tests", "generated");
  const destination = path.join(result.filePaths[0], "unitgen-generated-tests");
  copyDirectory(source, destination);

  return destination;
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (activeChild) activeChild.kill("SIGTERM");
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
