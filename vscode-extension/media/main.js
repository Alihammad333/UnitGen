const vscode = acquireVsCodeApi();

const browseBtn = document.getElementById("browseBtn");
const startBtn = document.getElementById("startBtn");
const downloadBtn = document.getElementById("downloadBtn");
const browseProjectCard = document.getElementById("browseProjectCard");
const selectedProject = document.getElementById("selectedProject");
const activityBody = document.getElementById("activityBody");
const npmPackageInput = document.getElementById("npmPackageInput");
const dependencyPanel = document.getElementById("dependencyPanel");
const repairPanel = document.getElementById("repairPanel");
const assertionPanel = document.getElementById("assertionPanel");

let currentInputType = "";
let currentInputValue = "";

// Track which timeline steps have been marked as completed
let completedSteps = {
  sourceCodeAnalyzed: false,
  dependenciesDetected: false,
  llmTestsGenerated: false,
  jestRunTests: false,
  testsRepaired: false,
  assertionEnhanced: false,
  finalReady: false
};

function resetTimeline() {
  const dots = document.querySelectorAll(".timeline-item .dot");
  dots.forEach(dot => {
    dot.classList.remove("dot-completed", "dot-active");
    dot.classList.add("dot-idle");
  });
  
  // Reset tracking variables
  completedSteps = {
    sourceCodeAnalyzed: false,
    dependenciesDetected: false,
    llmTestsGenerated: false,
    jestRunTests: false,
    testsRepaired: false,
    assertionEnhanced: false,
    finalReady: false
  };
}

function resetSidePanels() {
  dependencyPanel.innerHTML = `<p class="panel-placeholder">Waiting for dependency and mock events...</p>`;
  repairPanel.innerHTML = `<p class="panel-placeholder">Waiting for failure classification and repair events...</p>`;
  assertionPanel.innerHTML = `<p class="panel-placeholder">Waiting for assertion quality events...</p>`;
}

function clearActivity() {
  activityBody.innerHTML = `
    <tr class="placeholder-row" id="activityPlaceholder">
      <td colspan="3">
        No activity yet. After running UnitGen, logs will appear like:<br /><br />
        <code>[02.10.2025 22:52:15.773] test_0.js (generated for add(a,b)) : failed</code><br />
        <code>[02.10.2025 22:52:20.540] test_0.js (repaired assertion) : passed</code>
      </td>
    </tr>
  `;
}

function appendActivity(message, status = "info") {
  const placeholder = document.getElementById("activityPlaceholder");
  if (placeholder) placeholder.remove();

  const row = document.createElement("tr");

  const ts = document.createElement("td");
  ts.textContent = new Date().toLocaleTimeString();

  const action = document.createElement("td");
  action.textContent = message;

  const stat = document.createElement("td");
  stat.textContent = status;

  row.appendChild(ts);
  row.appendChild(action);
  row.appendChild(stat);

  activityBody.appendChild(row);
}

function requestBrowse() {
  vscode.postMessage({ type: "browseProject" });
}

browseBtn.addEventListener("click", requestBrowse);
browseProjectCard.addEventListener("click", requestBrowse);

startBtn.addEventListener("click", () => {
  const npmValue = npmPackageInput ? npmPackageInput.value.trim() : "";

  if (npmValue) {
    currentInputType = "npm";
    currentInputValue = npmValue;
    selectedProject.textContent = npmValue;
  }

  // fresh run => clear previous activity
  clearActivity();
  resetSidePanels();
  resetTimeline();

  vscode.postMessage({
    type: "startPipeline",
    inputType: currentInputType,
    inputValue: currentInputValue
  });
});

downloadBtn.addEventListener("click", () => {
  vscode.postMessage({
    type: "downloadTestSuite"
  });
});

window.addEventListener("message", (event) => {
  const message = event.data;

  if (message.type === "pipelineEvent") {
    console.log("Pipeline event received in webview:", message.event);
    handlePipelineEvent(message.event);
    return;
  }

  if (message.type === "projectSelected") {
    currentInputType = message.inputType;
    currentInputValue = message.inputValue;

    selectedProject.textContent = message.inputValue;

    if (npmPackageInput) {
      npmPackageInput.value = "";
    }

    clearActivity();

    appendActivity(
      `Input selected (${message.inputType}): ${message.inputValue}`,
      "selected"
    );

    return;
  }

  if (message.type === "log") {
    appendActivity(message.message, "log");
    return;
  }

  if (message.type === "pipelineState") {
    if (message.state === "running") {
      startBtn.disabled = true;
      startBtn.textContent = "Running...";
      downloadBtn.disabled = true;
      downloadBtn.classList.add("btn-disabled");
      
      // Mark first step as active when pipeline starts
      if (!completedSteps.sourceCodeAnalyzed) {
        markTimelineStepActive(0);
      }
    }

    if (message.state === "finished") {
      startBtn.disabled = false;
      startBtn.textContent = "Start UnitGen";
      downloadBtn.disabled = false;
      downloadBtn.classList.remove("btn-disabled");
      
      // Mark final step when pipeline finishes
      if (!completedSteps.finalReady) {
        markTimelineStepCompleted(6);
        completedSteps.finalReady = true;
      }
    }

    return;
  }

  if (message.type === "finalReport") {
    appendActivity("Final report received from backend.", "done");
    console.log("Final report:", message.report);
    return;
  }
});

function removePlaceholder(panel) {
  const placeholder = panel.querySelector(".panel-placeholder");
  if (placeholder) placeholder.remove();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function markTimelineStepActive(stepIndex) {
  const dot = document.querySelector(`.timeline-item .dot[data-step="${stepIndex}"]`);
  if (dot) {
    dot.classList.remove("dot-idle", "dot-completed");
    dot.classList.add("dot-active");
  }
}

function markTimelineStepCompleted(stepIndex) {
  const dot = document.querySelector(`.timeline-item .dot[data-step="${stepIndex}"]`);
  if (dot) {
    dot.classList.remove("dot-idle", "dot-active");
    dot.classList.add("dot-completed");
  }
}

function addDependencyCard(event) {
  console.log("Adding dependency card:", event);  // Log the event data
  const panel = document.getElementById("dependencyPanel");  
  removePlaceholder(dependencyPanel);

  const div = document.createElement("div");
  div.className = "dep-item";

  div.innerHTML = `
    <div class="dep-header">
      <span class="dep-kind">${escapeHtml(event.mockType || event.typeLabel || event.module || "Dependency")}</span>
      <span class="dep-location">${escapeHtml(event.file || "")}</span>
    </div>
    <p class="dep-signature"><code>${escapeHtml(event.usage || event.module || "")}</code></p>
    <p class="dep-label">Generated mock:</p>
    <pre class="code-snippet"><code>${escapeHtml(event.mockCode || "Mock prepared")}</code></pre>
  `;

  dependencyPanel.appendChild(div);
}

function addRepairCard(event) {
  console.log("Adding repair card:", event);  // Log the event data
  const panel = document.getElementById("repairPanel");  
  removePlaceholder(repairPanel);

  const div = document.createElement("div");
  div.className = "repair-item";

  div.innerHTML = `
    <div class="repair-header">
      <span class="repair-test">${escapeHtml(event.testFile || "test file")}</span>
      <span class="repair-status">${escapeHtml(event.failureType || event.status || "Failure")}</span>
    </div>
    <div class="repair-body">
      <p class="repair-label">Before:</p>
      <pre class="code-snippet"><code>${escapeHtml(event.before || event.errorMessage || "Failure detected")}</code></pre>

      <p class="repair-label">After / Strategy:</p>
      <pre class="code-snippet"><code>${escapeHtml(event.after || event.repairStrategy || event.status || "Repair attempted")}</code></pre>
    </div>
  `;

  repairPanel.appendChild(div);
}

function addAssertionCard(event) {
  console.log("Adding assertion card:", event);  // Log the event data
  const panel = document.getElementById("assertionPanel");  
  removePlaceholder(assertionPanel);

  const div = document.createElement("div");
  div.className = "assert-item";

  div.innerHTML = `
    <div class="assert-header">
      <span class="assert-test">${escapeHtml(event.testFile || "test file")}</span>
      <span class="assert-tag">${escapeHtml(event.issue || event.status || "Assertion")}</span>
    </div>

    <p class="assert-label">Original:</p>
    <pre class="code-snippet"><code>${escapeHtml(event.original || "Weak assertion detected")}</code></pre>

    <p class="assert-label">Suggested:</p>
    <pre class="code-snippet"><code>${escapeHtml(event.suggested || event.after || "Strengthened assertion suggested")}</code></pre>
  `;

  assertionPanel.appendChild(div);
}

function handlePipelineEvent(event) {

  console.log("Handling event:", event);  // Log the event

  appendActivity(`[event] ${event.type}`, "event");

  // Mark "Source code analyzed" step as completed when pipeline starts
  if (!completedSteps.sourceCodeAnalyzed && event.type === "analysis_started") {
    markTimelineStepCompleted(0);
    completedSteps.sourceCodeAnalyzed = true;
  }

  // Mark "Dependencies detected & mocks prepared" step — active first, then completed on data arrival
  if (!completedSteps.dependenciesDetected && (event.type === "mock_generated" || event.type === "dependency_found" || (event.type === "stage_started" && event.stage === "dependency"))) {
    // Mark prev step done, this step active
    if (!completedSteps.sourceCodeAnalyzed) { markTimelineStepCompleted(0); completedSteps.sourceCodeAnalyzed = true; }
    markTimelineStepActive(1);
    completedSteps.dependenciesDetected = true;
    
    setTimeout(() => {
      markTimelineStepCompleted(1);
      const hasPlaceholder = dependencyPanel.querySelector(".panel-placeholder");
      if (hasPlaceholder) {
        dependencyPanel.innerHTML = `<p class="panel-placeholder">✅ No external dependencies or mocks required. Your functions are self-contained.</p>`;
      }
    }, 1200);
  }
  
  if (event.type === "mock_generated" || event.type === "dependency_found") {
    addDependencyCard(event);
  }

  // Mark "LLM tests generated" step
  if (!completedSteps.llmTestsGenerated && (event.type === "test_generated" || (event.type === "stage_started" && event.stage === "llm_generation"))) {
    markTimelineStepActive(2);
    setTimeout(() => { markTimelineStepCompleted(2); }, 1000);
    completedSteps.llmTestsGenerated = true;
  }

  // Mark "Jest run tests" step
  if (!completedSteps.jestRunTests && event.type === "stage_started" && event.stage === "jest_initial_run") {
    markTimelineStepActive(3);
    setTimeout(() => { markTimelineStepCompleted(3); }, 1000);
    completedSteps.jestRunTests = true;
  }

  // Mark "Failed tests repaired" step
  if (!completedSteps.testsRepaired && (event.type === "repair_attempted" || event.type === "repair_accepted" || (event.type === "stage_started" && event.stage === "repair"))) {
    markTimelineStepActive(4);
    completedSteps.testsRepaired = true;
    
    setTimeout(() => {
      markTimelineStepCompleted(4);
      const hasPlaceholder = repairPanel.querySelector(".panel-placeholder");
      if (hasPlaceholder) {
        repairPanel.innerHTML = `<p class="panel-placeholder">✅ No test failures detected. All initial tests passed on first run!</p>`;
      }
    }, 1200);
  }

  if (
    event.type === "failure_classified" ||
    event.type === "repair_attempted" ||
    event.type === "repair_accepted" ||
    event.type === "repair_rejected" ||
    event.type === "repair_not_required"
  ) {
    addRepairCard(event);
  }

  // Mark "Assertion quality enhanced" step
  if (!completedSteps.assertionEnhanced && (event.type === "assertion_enhanced" || (event.type === "stage_started" && event.stage === "assertion_quality"))) {
    markTimelineStepActive(5);
    completedSteps.assertionEnhanced = true;
    
    setTimeout(() => {
      markTimelineStepCompleted(5);
      const hasPlaceholder = assertionPanel.querySelector(".panel-placeholder");
      if (hasPlaceholder) {
        assertionPanel.innerHTML = `<p class="panel-placeholder">✅ No weak assertions detected. All assertions are strong and meaningful.</p>`;
      }
    }, 1200);
  }

  if (
    event.type === "assertion_detected" ||
    event.type === "assertion_enhanced" ||
    event.type === "assertion_rejected"
  ) {
    addAssertionCard(event);
  }

  // Mark "Final test suite ready" step
  if (!completedSteps.finalReady && event.type === "pipeline_completed") {
    markTimelineStepCompleted(6);
    completedSteps.finalReady = true;
    
    // Show "no detected" messages for stages that completed but had no events
    showCompletionMessages();
  }
}

function showCompletionMessages() {
  // Check if dependencies panel still has placeholder (no deps detected)
  const depPlaceholder = dependencyPanel.querySelector(".panel-placeholder");
  if (completedSteps.dependenciesDetected && depPlaceholder) {
    dependencyPanel.innerHTML = `<p class="panel-placeholder">✅ No external dependencies or mocks required. Your functions are self-contained.</p>`;
  }

  // Check if repair panel still has placeholder (no failures)
  const repairPlaceholder = repairPanel.querySelector(".panel-placeholder");
  if (completedSteps.testsRepaired && repairPlaceholder) {
    repairPanel.innerHTML = `<p class="panel-placeholder">✅ No test failures detected. All initial tests passed on first run!</p>`;
  }

  // Check if assertion panel still has placeholder (no weak assertions)
  const assertPlaceholder = assertionPanel.querySelector(".panel-placeholder");
  if (completedSteps.assertionEnhanced && assertPlaceholder) {
    assertionPanel.innerHTML = `<p class="panel-placeholder">✅ No weak assertions detected. All assertions are strong and meaningful.</p>`;
  }
}