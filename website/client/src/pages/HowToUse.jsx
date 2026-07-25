import React, { useState } from "react";
import DownloadButton from "../components/DownloadButton";

const HowToUse = () => {
  // Tab states
  const [installTab, setInstallTab] = useState("windows");
  const [providerTab, setProviderTab] = useState("openai");

  return (
    <div className="container section-padding" style={{ maxWidth: "900px" }}>
      <header style={{ textAlign: "center", marginBottom: "56px" }}>
        <h1 style={{ fontSize: "2.5rem", color: "var(--color-1)", marginBottom: "12px" }}>
          How to Use UnitGen
        </h1>
        <p style={{ fontSize: "1.2rem", color: "var(--text-grey)" }}>
          Get up and running in under 5 minutes.
        </p>
      </header>

      {/* Section 1 - Installation */}
      <section className="prose-section">
        <h2 className="prose-title">1. Download & Install</h2>
        
        {/* Render smaller version of download trigger widget */}
        <div style={{ display: "flex", justifyContent: "center", margin: "24px 0" }}>
          <DownloadButton size="small" />
        </div>

        {/* OS installation instructions switcher tab menu */}
        <div className="tab-headers">
          <button 
            className={`tab-header ${installTab === "windows" ? "active" : ""}`}
            onClick={() => setInstallTab("windows")}
          >
            Windows
          </button>
          <button 
            className={`tab-header ${installTab === "mac" ? "active" : ""}`}
            onClick={() => setInstallTab("mac")}
          >
            macOS
          </button>
          <button 
            className={`tab-header ${installTab === "linux" ? "active" : ""}`}
            onClick={() => setInstallTab("linux")}
          >
            Linux
          </button>
        </div>

        <div className="tab-contents">
          {/* Windows Pane */}
          <div className={`tab-pane ${installTab === "windows" ? "active" : ""}`}>
            <ol style={{ paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <li>Run the downloaded <code>.exe</code> installer package.</li>
              <li>If SmartScreen warns <em>&quot;Windows protected your PC&quot;</em>, click <strong>More info</strong> &rarr; <strong>Run anyway</strong>.</li>
              <li>Follow the installer instructions. UnitGen will appear in your Start Menu and Desktop.</li>
            </ol>
          </div>

          {/* Mac Pane */}
          <div className={`tab-pane ${installTab === "mac" ? "active" : ""}`}>
            <ol style={{ paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <li>Open the downloaded <code>.dmg</code> disk image file.</li>
              <li>Drag the <strong>UnitGen</strong> app icon into your <strong>Applications</strong> directory folder.</li>
              <li>
                On your very first launch, if Gatekeeper warns that the developer is unidentified:
                <br />
                Right-click the app icon &rarr; select <strong>Open</strong> &rarr; click <strong>Open</strong> in the system warning dialog.
              </li>
              <li>Alternatively, go to <strong>System Settings</strong> &rarr; <strong>Privacy & Security</strong> &rarr; scroll to click <strong>Open Anyway</strong>.</li>
            </ol>
          </div>

          {/* Linux Pane */}
          <div className={`tab-pane ${installTab === "linux" ? "active" : ""}`}>
            <p style={{ marginBottom: "12px", fontStyle: "italic", color: "var(--text-grey)" }}>
              &#9888; Note: The Linux build is distributed as a Snap package (supported specifically on Ubuntu).
            </p>
            <ol style={{ paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <li>
                Install the downloaded <code>.snap</code> package using the terminal:
                <pre><code>sudo snap install --dangerous unitgen_1.0.0_amd64.snap</code></pre>
              </li>
              <li>
                Once installed, launch it directly from your Ubuntu applications menu or via terminal:
                <pre><code>snap run unitgen</code></pre>
              </li>
              <li>
                If you encounter sandboxing issues on launch, run it with:
                <pre><code>snap run unitgen --no-sandbox</code></pre>
              </li>
            </ol>
          </div>
        </div>
      </section>

      {/* Section 2 - Setup Config */}
      <section className="prose-section">
        <h2 className="prose-title">2. Configure Your AI Provider</h2>
        
        {/* OpenAI / Ollama switcher tab menu */}
        <div className="tab-headers">
          <button 
            className={`tab-header ${providerTab === "openai" ? "active" : ""}`}
            onClick={() => setProviderTab("openai")}
          >
            OpenAI (Cloud)
          </button>
          <button 
            className={`tab-header ${providerTab === "ollama" ? "active" : ""}`}
            onClick={() => setProviderTab("ollama")}
          >
            Ollama (100% Local & Free)
          </button>
        </div>

        <div className="tab-contents">
          {/* OpenAI Setup */}
          <div className={`tab-pane ${providerTab === "openai" ? "active" : ""}`}>
            <ol style={{ paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <li>Open the app and click the <strong>⚙ Settings Gear Icon</strong> in the top-right corner.</li>
              <li>Choose <strong>OpenAI</strong> as the target AI service provider.</li>
              <li>Input your custom OpenAI API Key (create keys under <a href="https://platform.openai.com" target="_blank" rel="noreferrer" style={{color:"var(--color-3)", textDecoration:"underline"}}>platform.openai.com</a>).</li>
              <li>Select your model: <code>gpt-3.5-turbo</code> is highly recommended for low cost and fast speeds.</li>
              <li>Click <strong>Save Settings</strong>.</li>
            </ol>
          </div>

          {/* Ollama Setup */}
          <div className={`tab-pane ${providerTab === "ollama" ? "active" : ""}`}>
            <ol style={{ paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <li>Download and install Ollama from <a href="https://ollama.com" target="_blank" rel="noreferrer" style={{color:"var(--color-3)", textDecoration:"underline"}}>ollama.com</a>.</li>
              <li>
                Download your chosen target model locally using your shell:
                <pre><code>ollama pull qwen2.5:1.5b</code></pre>
              </li>
              <li>Confirm the Ollama engine background service is running.</li>
              <li>Inside the UnitGen Settings panel, select <strong>Ollama (Local)</strong> as your provider.</li>
              <li>Click <strong>Check Connection</strong> to verify backend integration connectivity.</li>
              <li>Choose your local model from the drop-down list.</li>
              <li>Click <strong>Save Settings</strong>.</li>
            </ol>
            <p style={{ marginTop: "16px", fontStyle: "italic", color: "var(--text-grey)", fontSize: "0.9rem" }}>
              💡 <strong>Privacy Note:</strong> When configured with Ollama, all testing compiles 100% offline. None of your source files ever leave your machine.
            </p>
          </div>
        </div>
      </section>

      {/* Section 3 - Running */}
      <section className="prose-section">
        <h2 className="prose-title">3. Generate Tests</h2>
        <ol style={{ paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <li>Navigate to the <strong>Source Code Input</strong> dashboard panel.</li>
          <li>Click <strong>Browse Files</strong> or simply drag and drop a <code>.js</code> file or entire project directories.</li>
          <li>Press the primary <strong>Start UnitGen</strong> trigger button.</li>
          <li>Monitor the real-time compilation log states inside the <strong>Processing Timeline</strong>.</li>
          <li>Analyze progress rows directly as new files map to the <strong>Generated Test Activity Log</strong>.</li>
        </ol>
      </section>

      {/* Section 4 - Understanding the Output */}
      <section className="prose-section">
        <h2 className="prose-title">4. Understanding the Results</h2>
        <div className="prose-card-grid">
          {/* Card 1 */}
          <div className="prose-card">
            <h3 className="prose-card-title">Dependencies & Mocks</h3>
            <p className="prose-card-text">
              Provides detailed breakdowns of external system paths found (fs write, database queries, rest endpoints) and outlines the mock stub assets Sinon generated.
            </p>
          </div>

          {/* Card 2 */}
          <div className="prose-card">
            <h3 className="prose-card-title">Failures & Repairs</h3>
            <p className="prose-card-text">
              Indexes failing tests during execution, mapping the error categories (assertion error, syntax error, import error) alongside raw correction logs returned from LLM healing.
            </p>
          </div>

          {/* Card 3 */}
          <div className="prose-card">
            <h3 className="prose-card-title">Assertion Quality</h3>
            <p className="prose-card-text">
              Audits weak assertion points (e.g., checks expecting standard defined definitions) and lists values UnitGen observes at runtime to harden logic checks.
            </p>
          </div>
        </div>
      </section>

      {/* Section 5 - Downloader */}
      <section className="prose-section" style={{ marginBottom: 0 }}>
        <h2 className="prose-title">5. Download Your Test Suite</h2>
        <p style={{ marginBottom: "16px" }}>
          Once the processing phases conclude successfully, press the primary <strong>Download Test Suite</strong> button to output the completed test specifications to your desktop. These are ready-to-run, standard Jest code blocks &mdash; drop them inside your local test suite folders and run <code>npm test</code>.
        </p>
        <p>
          A comprehensive execution report named <code>final-report.json</code> is saved under your local app's <code>backend/output/</code> directory, recording diagnostic times, test statistics, and detailed self-healing feedback details.
        </p>
      </section>
    </div>
  );
};

export default HowToUse;
