const steps = [
  {
    name: "Source code analyzed",
    description: "Project structure parsed and entry points identified.",
    patterns: ["input", "processing", "source", "analyzed", "parsed", "entry"]
  },
  {
    name: "Dependencies detected & mocks prepared",
    description: "External API, DB, file system and env calls identified.",
    patterns: ["dependency", "mock", "import", "external"]
  },
  {
    name: "LLM tests generated",
    description: "Initial unit tests created for selected functions.",
    patterns: ["llm", "generated", "writing", "test"]
  },
  {
    name: "Jest run tests",
    description: "Tests executed and results captured.",
    patterns: ["jest", "running tests", "test report"]
  },
  {
    name: "Failed tests repaired",
    description: "Failures classified and repair loop executed.",
    patterns: ["repair", "failure", "classified"]
  },
  {
    name: "Assertion quality enhanced",
    description: "Weak assertions strengthened intelligently.",
    patterns: ["assertion", "enhancer", "enhanced"]
  },
  {
    name: "Final test suite ready",
    description: "All tests packaged for download.",
    patterns: ["final", "done", "ready", "report"]
  }
];

const state = {
  selectedPath: "",
  settings: null,
  running: false,
  currentStep: -1,
  completedSuccessfully: false
};

const els = {};
let scrollTimeout;
let lastOllamaConnection = null;

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  renderTimeline();
  bindUi();
  bindIpc();

  state.settings = await window.electronAPI.loadSettings();
  applySettingsToForm(state.settings);
  updateProviderUi();
  updateProviderStatusPill();

  if (getActiveProvider() === "openai" && !state.settings.apiKey) {
    openSettings(true);
  } else if (getActiveProvider() === "ollama") {
    checkOllamaConnection({ quiet: true });
  }

  updateStartState();
});

function cacheElements() {
  Object.assign(els, {
    dropZone: document.getElementById("dropZone"),
    dropTitle: document.getElementById("dropTitle"),
    dropSubtitle: document.getElementById("dropSubtitle"),
    browseBtn: document.getElementById("browseBtn"),
    startBtn: document.getElementById("startBtn"),
    startText: document.getElementById("startText"),
    stopBtn: document.getElementById("stopBtn"),
    downloadBtn: document.getElementById("downloadBtn"),
    activityWrap: document.querySelector(".activity-wrap"),
    activityBody: document.getElementById("activityBody"),
    timeline: document.getElementById("timeline"),
    dependenciesList: document.getElementById("dependenciesList"),
    repairList: document.getElementById("repairList"),
    assertionList: document.getElementById("assertionList"),
    settingsBtn: document.getElementById("settingsBtn"),
    providerStatusPill: document.getElementById("providerStatusPill"),
    settingsOverlay: document.getElementById("settingsOverlay"),
    closeSettingsBtn: document.getElementById("closeSettingsBtn"),
    apiWarning: document.getElementById("apiWarning"),
    apiKeyInput: document.getElementById("apiKeyInput"),
    toggleKeyBtn: document.getElementById("toggleKeyBtn"),
    modelInput: document.getElementById("modelInput"),
    providerSelect: document.getElementById("providerSelect"),
    openaiSettings: document.getElementById("openaiSettings"),
    ollamaSettings: document.getElementById("ollamaSettings"),
    ollamaHostInput: document.getElementById("ollamaHostInput"),
    ollamaModelInput: document.getElementById("ollamaModelInput"),
    ollamaModels: document.getElementById("ollamaModels"),
    checkOllamaBtn: document.getElementById("checkOllamaBtn"),
    ollamaConnectionStatus: document.getElementById("ollamaConnectionStatus"),
    downloadOllamaBtn: document.getElementById("downloadOllamaBtn"),
    advancedToggle: document.getElementById("advancedToggle"),
    advancedChevron: document.getElementById("advancedChevron"),
    advancedPanel: document.getElementById("advancedPanel"),
    repairCandidatesInput: document.getElementById("repairCandidatesInput"),
    dynamicDepthInput: document.getElementById("dynamicDepthInput"),
    dynamicApisInput: document.getElementById("dynamicApisInput"),
    mockExternalsInput: document.getElementById("mockExternalsInput"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn")
  });
}

function bindUi() {
  els.dropZone.addEventListener("click", pickPath);
  els.browseBtn.addEventListener("click", pickPath);

  els.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.dropZone.classList.add("drag-over");
  });

  els.dropZone.addEventListener("dragleave", () => {
    els.dropZone.classList.remove("drag-over");
  });

  els.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("drag-over");
    const file = event.dataTransfer.files[0];
    if (file?.path) setSelectedPath(file.path);
  });

  els.startBtn.addEventListener("click", startRun);
  els.stopBtn.addEventListener("click", stopRun);
  els.downloadBtn.addEventListener("click", downloadTests);

  els.settingsBtn.addEventListener("click", () => openSettings(false));
  els.closeSettingsBtn.addEventListener("click", closeSettings);
  els.settingsOverlay.addEventListener("click", (event) => {
    if (event.target === els.settingsOverlay) closeSettings();
  });

  els.toggleKeyBtn.addEventListener("click", () => {
    const isHidden = els.apiKeyInput.type === "password";
    els.apiKeyInput.type = isHidden ? "text" : "password";
    els.toggleKeyBtn.textContent = isHidden ? "🚫👁" : "👁";
    els.toggleKeyBtn.setAttribute(
      "aria-label",
      isHidden ? "Hide API key" : "Show API key"
    );
  });

  els.providerSelect.addEventListener("change", () => {
    lastOllamaConnection = null;
    updateProviderUi();
    updateProviderStatusPill();
    updateStartState();
  });

  els.apiKeyInput.addEventListener("input", () => {
    updateProviderUi();
    updateProviderStatusPill();
    updateStartState();
  });

  els.ollamaHostInput.addEventListener("input", () => {
    lastOllamaConnection = null;
    els.ollamaConnectionStatus.textContent = "Not checked";
    els.ollamaConnectionStatus.className = "connection-status muted";
    updateProviderStatusPill();
  });

  els.checkOllamaBtn.addEventListener("click", () => {
    checkOllamaConnection({ quiet: false });
  });

  els.downloadOllamaBtn.addEventListener("click", () => {
    window.electronAPI.openExternal("https://ollama.com");
  });

  els.advancedToggle.addEventListener("click", () => {
    els.advancedPanel.classList.toggle("hidden");
    els.advancedChevron.classList.toggle("open");
  });

  els.saveSettingsBtn.addEventListener("click", saveSettings);

  [
    els.apiKeyInput,
    els.modelInput,
    els.ollamaHostInput,
    els.ollamaModelInput,
    els.repairCandidatesInput,
    els.dynamicDepthInput,
    els.dynamicApisInput
  ].forEach((inputEl) => {
    if (inputEl) {
      inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          saveSettings();
        }
      });
    }
  });
}

function bindIpc() {
  window.electronAPI.onLog(({ line, timestamp }) => {
    if (line.includes("__UNITGEN_EVENT__")) return;
    addActivityRow(line, timestamp);
    advanceTimelineFromEvent(line);
  });

  window.electronAPI.onEvent(({ event }) => {
    advanceTimelineFromEvent(event);
  });

  window.electronAPI.onDone(({ exitCode, report }) => {
    state.running = false;
    setRunningUi(false);

    if (exitCode === 0) {
      state.completedSuccessfully = true;
      markAllStepsCompleted();
    } else {
      markCurrentStepFailed();
    }

    if (report) {
      populateReportCards(report);
      els.downloadBtn.disabled = exitCode !== 0;
    }

    updateStartState();
  });
}

async function pickPath() {
  const selected = await window.electronAPI.openPath();
  if (selected) setSelectedPath(selected);
}

function setSelectedPath(nextPath) {
  state.selectedPath = nextPath;
  els.dropTitle.textContent = nextPath;
  els.dropTitle.title = nextPath;
  els.dropTitle.classList.add("path");
  els.dropSubtitle.textContent = "Selected target path";
  updateStartState();
}

function updateStartState() {
  const provider = getActiveProvider();
  const hasRequiredProviderSettings =
    provider === "ollama" || Boolean(state.settings?.apiKey);
  const canStart = Boolean(
    state.selectedPath && hasRequiredProviderSettings && !state.running
  );
  els.startBtn.disabled = !canStart;
}

async function startRun() {
  if (!state.selectedPath || state.running) return;

  resetForRun();
  state.running = true;
  setRunningUi(true);
  setStepState(0, "active");

  try {
    await window.electronAPI.runUnitGen(state.selectedPath, collectEnvVars());
  } catch (error) {
    state.running = false;
    setRunningUi(false);
    markCurrentStepFailed();
    addActivityRow(error.message || String(error), nowTimestamp());
  }
}

async function stopRun() {
  await window.electronAPI.stopUnitGen();
  addActivityRow("Stop requested", nowTimestamp());
}

async function downloadTests() {
  try {
    const destination = await window.electronAPI.downloadTests();
    if (destination) {
      addActivityRow(`Downloaded test suite to ${destination}`, nowTimestamp());
    }
  } catch (error) {
    addActivityRow(error.message || String(error), nowTimestamp());
  }
}

function setRunningUi(isRunning) {
  els.startBtn.classList.toggle("running", isRunning);
  els.startText.textContent = isRunning ? "Running..." : "Start UnitGen";
  els.stopBtn.classList.toggle("hidden", !isRunning);
  const provider = getActiveProvider();
  const hasRequiredProviderSettings =
    provider === "ollama" || Boolean(state.settings?.apiKey);
  els.startBtn.disabled =
    isRunning || !state.selectedPath || !hasRequiredProviderSettings;
}

function resetForRun() {
  state.currentStep = -1;
  state.completedSuccessfully = false;
  els.downloadBtn.disabled = true;
  clearActivity();
  renderTimeline();
  resetReportCards();
}

function renderTimeline() {
  els.timeline.innerHTML = steps
    .map((step, index) => {
      return `
        <li class="timeline-item pending" data-step="${index}">
          <span class="status-dot"></span>
          <span>
            <span class="step-name">${escapeHtml(step.name)}</span>
            <span class="step-description">${escapeHtml(step.description)}</span>
          </span>
        </li>
      `;
    })
    .join("");
}

function setStepState(index, nextState) {
  const item = els.timeline.querySelector(`[data-step="${index}"]`);
  if (!item) return;

  item.classList.remove("pending", "active", "completed", "failed");
  item.classList.add(nextState);

  if (nextState === "active") state.currentStep = index;
}

function advanceTimelineFromEvent(eventText = "") {
  const lower = eventText.toLowerCase();
  const matchedIndex = steps.findIndex((step) =>
    step.patterns.some((pattern) => lower.includes(pattern))
  );

  if (matchedIndex < 0) return;

  for (let i = 0; i < matchedIndex; i++) {
    setStepState(i, "completed");
  }

  setStepState(matchedIndex, "active");
}

function markAllStepsCompleted() {
  steps.forEach((_step, index) => setStepState(index, "completed"));
}

function markCurrentStepFailed() {
  const index = Math.max(0, state.currentStep);
  setStepState(index, "failed");
}

function addActivityRow(line, timestamp) {
  const parsed = parseActivityLine(line);
  const empty = els.activityBody.querySelector(".empty-row");
  if (empty) empty.remove();

  const row = document.createElement("tr");
  row.innerHTML = `
    <td>${escapeHtml(timestamp)}</td>
    <td title="${escapeAttr(parsed.action)}">${escapeHtml(parsed.action)}</td>
    <td><span class="badge ${parsed.className}">${escapeHtml(parsed.status)}</span></td>
  `;

  els.activityBody.appendChild(row);
  scheduleScroll(els.activityWrap);
}

function scheduleScroll(container) {
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, 300);
}

function parseActivityLine(line = "") {
  const lower = line.toLowerCase();
  const fileMatch = line.match(/([A-Za-z0-9._/-]+\.test\.js|[A-Za-z0-9._/-]+\.js)/);

  if (lower.includes("generating tests for") || lower.includes("writing test") || lower.includes("generated:")) {
    return {
      action: fileMatch?.[1] || truncate(line),
      status: "Generating",
      className: "generating"
    };
  }

  if (lower.includes("running jest") || lower.includes("jest")) {
    return { action: "Jest Run", status: "Running", className: "running" };
  }

  if (lower.includes("repair attempt") || lower.includes("repair")) {
    return { action: "Repair", status: "Repairing", className: "repairing" };
  }

  if (lower.includes("assertion")) {
    return {
      action: "Assertion Enhancement",
      status: "Enhanced",
      className: "enhanced"
    };
  }

  if (lower.includes("passed") || line.includes("✓") || lower.includes(" pass ")) {
    return {
      action: fileMatch?.[1] || truncate(line),
      status: "Passed",
      className: "passed"
    };
  }

  if (lower.includes("failed") || line.includes("✗") || lower.includes(" fail ")) {
    return {
      action: fileMatch?.[1] || truncate(line),
      status: "Failed",
      className: "failed"
    };
  }

  return { action: truncate(line, 72, "..."), status: "Log", className: "log" };
}

function clearActivity() {
  els.activityBody.innerHTML = `
    <tr class="empty-row">
      <td colspan="3">No activity yet.</td>
    </tr>
  `;
}

function populateReportCards(report) {
  populateDependencies(report);
  populateRepairs(report);
  populateAssertions(report);
}

function populateDependencies(report) {
  const contexts = collectContexts(report);
  const dependencyCards = Array.isArray(report.desktop?.dependencies)
    ? report.desktop.dependencies.map((item) => ({
        category: classifyDependency(item.moduleName, item.call),
        file: compactPath(item.file || "generated test"),
        call: item.call || item.moduleName,
        mock: item.mock || buildMockSnippet(item.moduleName, item.call)
      }))
    : [];

  for (const ctx of contexts) {
    const dependencies = Array.isArray(ctx.dependencies) ? ctx.dependencies : [];
    const usage = Array.isArray(ctx.dependencyUsage) ? ctx.dependencyUsage : [];

    for (const item of [...usage, ...dependencies]) {
      const moduleName = item.normalizedModuleName || item.moduleName || item.module || item;
      if (!moduleName) continue;
      const call = item.usage || item.localName || moduleName;
      dependencyCards.push({
        category: classifyDependency(moduleName, call),
        file: compactPath(ctx.sourceFile || ctx.testFilePath || "unknown"),
        call,
        mock: buildMockSnippet(moduleName, call)
      });
    }
  }

  if (!dependencyCards.length) {
    setPlaceholder(els.dependenciesList, "No dependencies detected yet.");
    return;
  }

  els.dependenciesList.classList.remove("placeholder");
  els.dependenciesList.innerHTML = dependencyCards.slice(0, 20).map(renderDependencyCard).join("");
}

function populateRepairs(report) {
  const failedTests = Array.isArray(report.failedTests) ? report.failedTests : [];

  if (!failedTests.length) {
    setPlaceholder(els.repairList, "No failed tests were reported for the final run.");
    return;
  }

  els.repairList.classList.remove("placeholder");
  els.repairList.innerHTML = failedTests.slice(0, 20).map((failure) => {
    const message = failure.failureMessage || failure.message || failure.errorMessage || "Failure details unavailable.";
    const type = classifyFailure(message);
    return `
      <article class="info-card">
        <div class="card-top">
          <span class="card-path">${escapeHtml(compactPath(failure.filePath || failure.testFile || "test file"))}</span>
          <span class="failure-pill ${type.className}">${escapeHtml(type.label)}</span>
        </div>
        <span class="small-label">Before:</span>
        <pre class="code-block">${escapeHtml(extractAssertion(message) || message)}</pre>
        <span class="small-label">After (LLM suggestion):</span>
        <pre class="code-block">${escapeHtml(failure.repairedAssertion || "No repaired assertion recorded in final report.")}</pre>
      </article>
    `;
  }).join("");
}

function populateAssertions(report) {
  const contexts = collectContexts(report);
  const assertionItems = Array.isArray(report.desktop?.assertionQuality)
    ? report.desktop.assertionQuality.map((item) => ({
        file: compactPath(item.file || "test file"),
        original: item.original || "Weak assertion",
        suggested: item.suggested || "Stronger assertion"
      }))
    : [];

  assertionItems.push(...contexts
    .filter((ctx) => Array.isArray(ctx.assertionQuality) && ctx.assertionQuality.length)
    .flatMap((ctx) =>
      ctx.assertionQuality.map((item) => ({
        file: compactPath(ctx.testFilePath || ctx.sourceFile || "test file"),
        original: item.original || item.before || "Weak assertion",
        suggested: item.suggested || item.after || "Stronger assertion"
      }))
    ));

  if (!assertionItems.length) {
    setPlaceholder(els.assertionList, "Weak assertions will be listed here.");
    return;
  }

  els.assertionList.classList.remove("placeholder");
  els.assertionList.innerHTML = assertionItems.slice(0, 20).map((item) => `
    <article class="info-card">
      <div class="card-top">
        <span class="card-path">${escapeHtml(item.file)}</span>
        <span class="failure-pill weak">Weak Assertion</span>
      </div>
      <span class="small-label">Original:</span>
      <pre class="code-block">${escapeHtml(item.original)}</pre>
      <span class="small-label">Suggested:</span>
      <pre class="code-block">${escapeHtml(item.suggested)}</pre>
    </article>
  `).join("");
}

function renderDependencyCard(item) {
  return `
    <article class="info-card">
      <div class="card-top">
        <span class="category-pill ${item.category.className}">${escapeHtml(item.category.label)}</span>
        <span class="card-path">${escapeHtml(item.file)}</span>
      </div>
      <pre class="code-block">${escapeHtml(item.call)}</pre>
      <span class="small-label">Generated mock (Sinon):</span>
      <pre class="code-block">${escapeHtml(item.mock)}</pre>
    </article>
  `;
}

function resetReportCards() {
  setPlaceholder(els.dependenciesList, "No dependencies detected yet.");
  setPlaceholder(els.repairList, "When tests fail, they will be classified and repaired here.");
  setPlaceholder(els.assertionList, "Weak assertions will be listed here.");
}

function setPlaceholder(element, text) {
  element.classList.add("placeholder");
  element.innerHTML = escapeHtml(text);
}

function collectContexts(report) {
  if (Array.isArray(report.llmContexts)) return report.llmContexts;
  if (Array.isArray(report.contexts)) return report.contexts;
  if (Array.isArray(report.project?.llmContexts)) return report.project.llmContexts;
  return [];
}

function classifyDependency(moduleName = "", call = "") {
  const text = `${moduleName} ${call}`.toLowerCase();
  if (/(^|[/\s])(fs|path|os)([/\s.]|$)|readfile|writefile|exists/.test(text)) {
    return { label: "FILE SYSTEM", className: "fs" };
  }
  if (/axios|fetch|http|https|request|got|superagent|undici/.test(text)) {
    return { label: "HTTP", className: "http" };
  }
  if (/mongo|mongoose|mysql|postgres|pg|redis|sqlite|db|database/.test(text)) {
    return { label: "DB", className: "db" };
  }
  if (/process\.env|env/.test(text)) {
    return { label: "ENV", className: "env" };
  }
  return { label: "Unknown", className: "unknown" };
}

function buildMockSnippet(moduleName = "", call = "") {
  const category = classifyDependency(moduleName, call).label;
  const root = String(moduleName).split(/[/.]/)[0] || "dependency";

  if (category === "FILE SYSTEM") {
    return "sinon.stub(fs, 'readFileSync').returns('mock-content');";
  }
  if (category === "HTTP") {
    return "sinon.stub(apiClient, 'get').resolves({ data: {} });";
  }
  if (category === "DB") {
    return "sinon.stub(repository, 'find').resolves([]);";
  }
  if (category === "ENV") {
    return "sinon.stub(process, 'env').value({ UNITGEN_TEST: 'true' });";
  }
  return `sinon.stub(${sanitizeIdentifier(root)}, 'method').returns({});`;
}

function classifyFailure(message = "") {
  const lower = message.toLowerCase();
  if (lower.includes("syntax") || lower.includes("unexpected token")) {
    return { label: "Syntax Error", className: "syntax" };
  }
  if (lower.includes("cannot find module") || lower.includes("import") || lower.includes("export")) {
    return { label: "Import Error", className: "import" };
  }
  if (lower.includes("timeout") || lower.includes("exceeded")) {
    return { label: "Timeout", className: "timeout" };
  }
  return { label: "Assertion Failure", className: "assertion" };
}

function extractAssertion(message = "") {
  const match = message.match(/expect\([^;\n]+[;\n]?/);
  return match?.[0] || "";
}

function openSettings(showWarning) {
  els.apiWarning.classList.toggle(
    "hidden",
    !(showWarning && getActiveProvider() === "openai")
  );
  els.settingsOverlay.classList.remove("hidden");
  if (getActiveProvider() === "openai") {
    els.apiKeyInput.focus();
  } else {
    els.ollamaHostInput.focus();
  }
}

function closeSettings() {
  els.settingsOverlay.classList.add("hidden");
}

function applySettingsToForm(settings = {}) {
  const provider = normalizeProvider(settings.provider);
  els.apiKeyInput.value = settings.apiKey || "";
  els.providerSelect.value = provider;
  els.modelInput.value =
    settings.openai?.model || settings.model || "gpt-3.5-turbo";
  els.ollamaHostInput.value =
    settings.ollama?.host || "http://localhost:11434";
  els.ollamaModelInput.value =
    settings.ollama?.model || "qwen2.5:1.5b";

  const advanced = settings.advanced || settings.advancedVars || {};
  els.repairCandidatesInput.value = advanced.UNITGEN_REPAIR_CANDIDATES_PER_FUNCTION ?? 1;
  els.dynamicDepthInput.value = advanced.UNITGEN_DYNAMIC_API_MAX_DEPTH ?? 4;
  els.dynamicApisInput.value = advanced.UNITGEN_DYNAMIC_API_MAX_APIS ?? 120;
  els.mockExternalsInput.checked = advanced.UNITGEN_MOCK_TOP_LEVEL_EXTERNALS !== false;
}

async function saveSettings() {
  const saveBtn = els.saveSettingsBtn;
  const originalText = saveBtn ? saveBtn.textContent : "Save Settings";

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
  }

  try {
    const provider = getActiveProvider();
    const data = {
      provider,
      apiKey: els.apiKeyInput.value.trim(),
      openai: {
        model: els.modelInput.value.trim() || "gpt-3.5-turbo"
      },
      ollama: {
        host: normalizeOllamaHost(els.ollamaHostInput.value),
        model: els.ollamaModelInput.value.trim() || "qwen2.5:1.5b"
      },
      advanced: collectAdvancedVars()
    };

    state.settings = await window.electronAPI.saveSettings(data);
    applySettingsToForm(state.settings);
    updateProviderUi();
    updateProviderStatusPill();
    closeSettings();
    updateStartState();

    if (provider === "ollama") {
      checkOllamaConnection({ quiet: true });
    }
  } catch (error) {
    console.error("Failed to save settings:", error);
    alert(`Error saving settings: ${error.message || String(error)}`);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = originalText;
    }
  }
}

function collectEnvVars() {
  const provider = getActiveProvider();
  return {
    provider,
    openai: {
      model: els.modelInput.value.trim() || "gpt-3.5-turbo"
    },
    ollama: {
      host: normalizeOllamaHost(els.ollamaHostInput.value),
      model: els.ollamaModelInput.value.trim() || "qwen2.5:1.5b"
    },
    advanced: collectAdvancedVars()
  };
}

function collectAdvancedVars() {
  return {
    UNITGEN_REPAIR_CANDIDATES_PER_FUNCTION: Number(els.repairCandidatesInput.value || 1),
    UNITGEN_DYNAMIC_API_MAX_DEPTH: Number(els.dynamicDepthInput.value || 4),
    UNITGEN_DYNAMIC_API_MAX_APIS: Number(els.dynamicApisInput.value || 120),
    UNITGEN_MOCK_TOP_LEVEL_EXTERNALS: els.mockExternalsInput.checked
  };
}

function normalizeProvider(provider) {
  return String(provider || "openai").toLowerCase() === "ollama"
    ? "ollama"
    : "openai";
}

function getActiveProvider() {
  return normalizeProvider(els.providerSelect?.value || state.settings?.provider);
}

function normalizeOllamaHost(host = "http://localhost:11434") {
  return String(host || "http://localhost:11434").trim().replace(/\/+$/, "");
}

function updateProviderUi() {
  const provider = getActiveProvider();
  const isOllama = provider === "ollama";

  els.openaiSettings.classList.toggle("hidden", isOllama);
  els.ollamaSettings.classList.toggle("hidden", !isOllama);
  els.apiWarning.classList.toggle(
    "hidden",
    !(provider === "openai" && !els.apiKeyInput.value.trim())
  );
}

function updateProviderStatusPill() {
  const provider = getActiveProvider();
  els.providerStatusPill.classList.remove("success", "warning", "error");

  if (provider === "ollama") {
    if (lastOllamaConnection?.ok) {
      els.providerStatusPill.textContent = "Ollama ✓";
      els.providerStatusPill.classList.add("success");
    } else {
      els.providerStatusPill.textContent = "Ollama Offline";
      els.providerStatusPill.classList.add("error");
    }
    return;
  }

  if (state.settings?.apiKey || els.apiKeyInput.value.trim()) {
    els.providerStatusPill.textContent = "OpenAI ✓";
    els.providerStatusPill.classList.add("success");
  } else {
    els.providerStatusPill.textContent = "No API Key";
    els.providerStatusPill.classList.add("warning");
  }
}

function populateOllamaModels(models = []) {
  els.ollamaModels.innerHTML = models
    .map((model) => `<option value="${escapeAttr(model)}"></option>`)
    .join("");

  if (!els.ollamaModelInput.value.trim() && models.length > 0) {
    els.ollamaModelInput.value = models[0];
  }
}

async function checkOllamaConnection({ quiet = false } = {}) {
  const host = normalizeOllamaHost(els.ollamaHostInput.value);
  els.ollamaHostInput.value = host;

  if (!quiet) {
    els.ollamaConnectionStatus.textContent = "Checking...";
    els.ollamaConnectionStatus.className = "connection-status muted";
  }

  try {
    const result = await window.electronAPI.checkOllamaConnection(host);
    lastOllamaConnection = result;

    if (result.ok) {
      const count = Array.isArray(result.models) ? result.models.length : 0;
      populateOllamaModels(result.models || []);
      els.ollamaConnectionStatus.textContent = `✓ Connected — ${count} model(s) available`;
      els.ollamaConnectionStatus.className = "connection-status success";
    } else {
      els.ollamaConnectionStatus.textContent = "✗ Could not connect. Is Ollama running?";
      els.ollamaConnectionStatus.className = "connection-status error";
    }
  } catch {
    lastOllamaConnection = { ok: false, models: null, error: "Request failed" };
    els.ollamaConnectionStatus.textContent = "✗ Could not connect. Is Ollama running?";
    els.ollamaConnectionStatus.className = "connection-status error";
  }

  updateProviderStatusPill();
}

function nowTimestamp() {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function truncate(text, max = 96, suffix = "…") {
  const s = String(text || "").trim();
  return s.length > max ? `${s.slice(0, max - suffix.length)}${suffix}` : s;
}

function compactPath(filePath = "") {
  const value = String(filePath || "");
  return value.length > 54 ? `…${value.slice(-53)}` : value;
}

function sanitizeIdentifier(value = "dependency") {
  const clean = String(value).replace(/[^A-Za-z0-9_$]/g, "") || "dependency";
  return /^[A-Za-z_$]/.test(clean) ? clean : `dependency${clean}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
