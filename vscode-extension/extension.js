const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

function activate(context) {
  const disposable = vscode.commands.registerCommand("unitgen.openDashboard", () => {
    const panel = vscode.window.createWebviewPanel(
      "unitgenDashboard",
      "UnitGen Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, "media"))
        ]
      }
    );

    panel.webview.html = getWebviewContent(panel.webview, context.extensionPath);

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "browseProject") {
        const result = await vscode.window.showOpenDialog({
          canSelectMany: false,
          canSelectFiles: true,
          canSelectFolders: true,
          openLabel: "Select Folder or JavaScript File",
          filters: {
            "JavaScript Files": ["js"]
          }
        });

        if (result && result.length > 0) {
          const selectedUri = result[0];
          const selectedPath = selectedUri.fsPath;

          let inputType = "folder";
          try {
            const stat = fs.statSync(selectedPath);
            if (stat.isFile()) {
              inputType = "file";
            }
          } catch (_) {
            inputType = "folder";
          }

          panel.webview.postMessage({
            type: "projectSelected",
            inputType,
            inputValue: selectedPath
          });
        }
      }

      if (message.type === "startPipeline") {
        const { inputType, inputValue } = message;

        if (!inputValue) {
          vscode.window.showWarningMessage(
            "Please select a folder/file or enter an npm package first."
          );
          panel.webview.postMessage({
            type: "log",
            message: "No input selected."
          });
          return;
        }

        try {
          await runBackendPipeline({
            extensionPath: context.extensionPath,
            selectedInputType: inputType,
            selectedInputValue: inputValue,
            panel
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "log",
            message: `Pipeline completed with some failing tests: ${error.message}`
          });

          panel.webview.postMessage({
            type: "pipelineState",
            state: "finished"
          });

          vscode.window.showErrorMessage(`UnitGen failed: ${error.message}`);
        }
      }

      if (message.type === "downloadTestSuite") {
        try {
          const backendRoot = path.resolve(context.extensionPath, "..", "backend");
          const generatedTestsDir = path.join(backendRoot, "tests", "generated");

          if (!fs.existsSync(generatedTestsDir)) {
            vscode.window.showWarningMessage("Generated test suite not found yet.");
            return;
          }

          const targetUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: false,
            canSelectFolders: true,
            openLabel: "Select Destination Folder"
          });

          if (!targetUri || targetUri.length === 0) {
            return;
          }

          const destinationRoot = targetUri[0].fsPath;
          const destinationDir = path.join(destinationRoot, "unitgen-test-suite");

          if (fs.existsSync(destinationDir)) {
            fs.rmSync(destinationDir, { recursive: true, force: true });
          }

          fs.cpSync(generatedTestsDir, destinationDir, { recursive: true });

          vscode.window.showInformationMessage(
            `Test suite exported to: ${destinationDir}`
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Could not export test suite: ${error.message}`
          );
        }
      }
    });
  });

  context.subscriptions.push(disposable);
}

async function runBackendPipeline({ extensionPath, selectedInputType, selectedInputValue, panel }) {
  const backendRoot = path.resolve(extensionPath, "..", "backend");

  const packageJsonPath = path.join(backendRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Backend package.json not found at: ${backendRoot}`);
  }

  panel.webview.postMessage({
    type: "log",
    message: `Starting UnitGen pipeline for (${selectedInputType}): ${selectedInputValue}`
  });

  panel.webview.postMessage({
    type: "pipelineState",
    state: "running"
  });

  await new Promise((resolve, reject) => {
    let child;

    if (process.platform === "win32") {
      child = spawn(
        "cmd.exe",
        ["/c", "npm", "start", "--", selectedInputValue],
        {
          cwd: backendRoot,
          windowsHide: true
        }
      );
    } else {
      child = spawn(
        "npm",
        ["start", "--", selectedInputValue],
        {
          cwd: backendRoot
        }
      );
    }

  child.stdout.on("data", (data) => {
    const text = data.toString();
    const lines = text.split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      if (line.startsWith("__UNITGEN_EVENT__")) {
        try {
          const event = JSON.parse(line.replace("__UNITGEN_EVENT__", ""));

          panel.webview.postMessage({
            type: "pipelineEvent",
            event,
          });
        } catch (err) {
          panel.webview.postMessage({
            type: "log",
            message: `Invalid UnitGen event: ${err.message}`,
          });
          
          console.error("Error parsing event:", err);

        }

        continue;
      }

      panel.webview.postMessage({
        type: "log",
        message: line,
      });
    }
  });
    child.stderr.on("data", (data) => {
      const text = data.toString();
      const lines = text.split(/\r?\n/).filter(Boolean);

      for (const line of lines) {
        panel.webview.postMessage({
          type: "log",
          message: `[stderr] ${line}`
        });
      }
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Backend exited with code ${code}`));
      }
    });
  });

  panel.webview.postMessage({
    type: "log",
    message: "Pipeline finished with exit code 0"
  });

  const reportPath = path.join(backendRoot, "output", "final-report.json");

  if (fs.existsSync(reportPath)) {
    try {
      const raw = fs.readFileSync(reportPath, "utf8");
      const reportData = JSON.parse(raw);

      panel.webview.postMessage({
        type: "finalReport",
        report: reportData
      });
    } catch (err) {
      panel.webview.postMessage({
        type: "log",
        message: `Could not parse final-report.json: ${err.message}`
      });
    }
  } else {
    panel.webview.postMessage({
      type: "log",
      message: "final-report.json not found after run."
    });
  }

  panel.webview.postMessage({
    type: "pipelineState",
    state: "finished"
  });
}

function getWebviewContent(webview, extensionPath) {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, "media", "main.js"))
  );

  const styleUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, "media", "styles.css"))
  );

  const logoUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, "media", "unitgen-logo.png"))
  );

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>UnitGen – Automated Unit Test Generation & Repair</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
</head>

<body>
  <div class="app">

    <header class="topbar">
      <div class="brand">
        <div class="brand-logo">
          <img src="${logoUri}" alt="UnitGen Logo" class="brand-logo-img" />
        </div>

        <div class="brand-text">
          <h1>UnitGen</h1>
          <p>Automated Unit Test Generation, Repair &amp; Quality Enhancement for JavaScript/Node.js</p>
        </div>
      </div>

      <div class="topbar-actions">
        <span class="pill pill-soft">VS Code Extension UI</span>
        <span class="pill pill-outline">JS • Node.js</span>
        <span class="pill pill-outline">v1.0 • FYP</span>
      </div>
    </header>

    <main class="layout">

      <section class="column column-main">

        <section class="card card-upload">
          <div class="card-header">
            <div>
              <h2>Source Code Input</h2>
              <p>Provide a JavaScript/Node.js project folder, a .js file, or an npm package to start automated unit test generation.</p>
            </div>
          </div>

          <div class="upload-row">
            <div class="upload-dropzone" id="browseProjectCard">
              <div class="upload-icon">⬆</div>
              <div class="upload-text">
                <p class="upload-title">Select project folder or JavaScript file</p>
                <p class="upload-subtitle" id="selectedProject">or click to browse from your computer</p>
              </div>
            </div>

            <div class="upload-actions">
              <button class="btn btn-secondary" id="browseBtn">Browse Files</button>

              <p class="hint">
                Accepted:
                <code class="inline-code">Node.js project folder</code>,
                <code class="inline-code">.js file</code>,
                or <code class="inline-code">npm package</code>.
              </p>

              <button class="btn btn-primary primary-run" id="startBtn">Start UnitGen</button>

              <button class="btn btn-disabled" id="downloadBtn" disabled>Download Test Suite</button>
            </div>
          </div>

          <div class="timeline">
            <h3 class="timeline-title">Processing Timeline</h3>

            <ul class="timeline-list" id="timelineList">
              <li class="timeline-item">
                <span class="dot dot-idle" data-step="0"></span>
                <div class="timeline-text">
                  <p class="timeline-label">Source code analyzed</p>
                  <p class="timeline-sub">Project structure parsed and entry points identified.</p>
                </div>
              </li>

              <li class="timeline-item">
                <span class="dot dot-idle" data-step="1"></span>
                <div class="timeline-text">
                  <p class="timeline-label">Dependencies detected &amp; mocks prepared</p>
                  <p class="timeline-sub">External API, DB, file system and env calls identified.</p>
                </div>
              </li>

              <li class="timeline-item">
                <span class="dot dot-idle" data-step="2"></span>
                <div class="timeline-text">
                  <p class="timeline-label">LLM tests generated</p>
                  <p class="timeline-sub">Initial unit tests created for selected functions.</p>
                </div>
              </li>

              <li class="timeline-item">
                <span class="dot dot-idle" data-step="3"></span>
                <div class="timeline-text">
                  <p class="timeline-label">Jest run tests</p>
                  <p class="timeline-sub">Tests executed and results captured.</p>
                </div>
              </li>

              <li class="timeline-item">
                <span class="dot dot-idle" data-step="4"></span>
                <div class="timeline-text">
                  <p class="timeline-label">Failed tests repaired</p>
                  <p class="timeline-sub">Failures classified and repair loop executed.</p>
                </div>
              </li>

              <li class="timeline-item">
                <span class="dot dot-idle" data-step="5"></span>
                <div class="timeline-text">
                  <p class="timeline-label">Assertion quality enhanced</p>
                  <p class="timeline-sub">Weak assertions strengthened intelligently.</p>
                </div>
              </li>

              <li class="timeline-item">
                <span class="dot dot-idle" data-step="6"></span>
                <div class="timeline-text">
                  <p class="timeline-label">Final test suite ready</p>
                  <p class="timeline-sub">All tests packaged for download.</p>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <section class="card card-tests">
          <div class="card-header">
            <div>
              <h2>Generated Test Activity</h2>
              <p>CLI-style logs of generated, repaired, and improved tests.</p>
            </div>
            <span class="pill pill-soft">Preview Only</span>
          </div>

          <div class="table-wrapper">
            <table class="tests-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Test / Action</th>
                  <th>Status</th>
                </tr>
              </thead>

              <tbody id="activityBody">
                <tr class="placeholder-row" id="activityPlaceholder">
                  <td colspan="3">
                    No activity yet. After running UnitGen, logs will appear like:<br /><br />
                    <code>[02.10.2025 22:52:15.773] test_0.js (generated for add(a,b)) : failed</code><br />
                    <code>[02.10.2025 22:52:20.540] test_0.js (repaired assertion) : passed</code>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </section>

      <aside class="column column-side">

        <section class="card">
          <div class="card-header">
            <div>
              <h2>Dependencies &amp; Mocks</h2>
              <p>External calls detected in your project and their generated mock templates.</p>
            </div>
          </div>

          <div class="panel-body" id="dependencyPanel">
            <p class="panel-placeholder">
              No dependencies detected yet.
            </p>

            <div class="dep-item example">
              <div class="dep-header">
                <span class="dep-kind">File system</span>
                <span class="dep-location">/src/utils/fs.js:24</span>
              </div>
              <p class="dep-signature"><code>fs.readFileSync(path, 'utf8')</code></p>
              <p class="dep-label">Generated mock (Sinon):</p>
              <pre class="code-snippet"><code>sinon.stub(fs, 'readFileSync').returns('mock-content');</code></pre>
            </div>

            <div class="dep-item example">
              <div class="dep-header">
                <span class="dep-kind">HTTP</span>
                <span class="dep-location">/src/api/client.js:10</span>
              </div>
              <p class="dep-signature"><code>axios.get('https://api.example.com/data')</code></p>
              <p class="dep-label">Generated mock (Nock):</p>
              <pre class="code-snippet"><code>nock('https://api.example.com')
  .get('/data')
  .reply(200, { ok: true });</code></pre>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-header">
            <div>
              <h2>Failure Classification &amp; Repair</h2>
              <p>How UnitGen classifies failing tests and applies the repair loop.</p>
            </div>
          </div>

          <div class="panel-body" id="repairPanel">
            <p class="panel-placeholder">
              When tests fail, they will be classified and repaired here.
            </p>

            <div class="repair-item example">
              <div class="repair-header">
                <span class="repair-test">test_3.js</span>
                <span class="repair-status">Assertion failure</span>
              </div>
              <div class="repair-body">
                <p class="repair-label">Before:</p>
                <pre class="code-snippet"><code>expect(result).toBe(true);</code></pre>

                <p class="repair-label">After (LLM suggestion):</p>
                <pre class="code-snippet"><code>expect(calculateTotal(2, 3)).toBe(5);</code></pre>
              </div>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-header">
            <div>
              <h2>Assertion Quality</h2>
              <p>Weak assertions flagged and stronger alternatives suggested.</p>
            </div>
          </div>

          <div class="panel-body" id="assertionPanel">
            <p class="panel-placeholder">
              Weak assertions will be listed here.
            </p>

            <div class="assert-item example">
              <div class="assert-header">
                <span class="assert-test">test_assertions.js</span>
                <span class="assert-tag">Weak assertion</span>
              </div>

              <p class="assert-label">Original:</p>
              <pre class="code-snippet"><code>expect(true).toBe(true);</code></pre>

              <p class="assert-label">Suggested:</p>
              <pre class="code-snippet"><code>expect(add(2, 3)).toBe(5);</code></pre>
            </div>
          </div>
        </section>

      </aside>

    </main>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>
  `;
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};