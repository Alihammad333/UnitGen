import React, { useState, useEffect } from "react";
import DownloadButton from "../components/DownloadButton";
import img1 from "../assets/1.png";
import img2 from "../assets/2.png";
import img3 from "../assets/3.png";
import img4 from "../assets/4.png";
import img5 from "../assets/5.png";
import img6 from "../assets/6.png";

const Home = () => {
  const [stats, setStats] = useState(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [statsError, setStatsError] = useState(false);

  // Fetch download count from backend API on mount
  const fetchStats = async () => {
    try {
      setLoadingStats(true);
      const res = await fetch("/api/stats");
      if (!res.ok) throw new Error("Stats API failed");
      const data = await res.json();
      setStats(data);
      setStatsError(false);
    } catch (err) {
      console.warn("Could not retrieve download statistics.", err.message);
      setStatsError(true);
    } finally {
      setLoadingStats(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  return (
    <div className="container">
      {/* SECTION 1 - HERO */}
      <section className="section-padding" style={{ textAlign: "center", maxWidth: "800px", margin: "0 auto" }}>
        <h1 style={{ fontSize: "2.8rem", lineHeight: "1.2", marginBottom: "20px", color: "var(--color-1)" }}>
          Automated Unit Test Generation <br />
          <span style={{ color: "var(--color-3)" }}>for JavaScript & Node.js</span>
        </h1>
        <p style={{ fontSize: "1.2rem", color: "var(--text-grey)", marginBottom: "40px", lineHeight: "1.5" }}>
          UnitGen uses LLMs to generate, repair, and improve your Jest test suites automatically. Just point it at your code.
        </p>

        {/* Dynamic OS-detecting Download Button */}
        <DownloadButton size="large" onDownloadTriggered={fetchStats} />

        {/* Stats counter underneath download button */}
        {!statsError && (
          <div style={{ marginTop: "16px", minHeight: "24px", fontSize: "0.95rem", color: "var(--text-grey)" }}>
            {loadingStats ? (
              <span className="counter-skeleton"></span>
            ) : (
              stats && <span>&darr; {stats.total} total downloads</span>
            )}
          </div>
        )}
      </section>

      {/* SECTION 2 - FEATURE CARDS */}
      <section className="section-padding" style={{ borderTop: "1px solid var(--border)" }}>
        <div style={{ textAlign: "center", marginBottom: "48px" }}>
          <h2 style={{ fontSize: "2rem", color: "var(--color-1)" }}>Powerful AI-Driven Features</h2>
          <p style={{ color: "var(--text-grey)", marginTop: "8px" }}>
            Everything you need to ship fully covered, secure, and self-healing test pipelines.
          </p>
        </div>

        <div className="features-grid">
          {/* Card 1 - Smart Test Generation */}
          <div className="feature-card bento-span-2">
            <div className="feature-icon">
              <img src={img1} alt="Smart Test Generation" />
            </div>
            <div className="feature-info">
              <h3 className="feature-title">Smart Test Generation</h3>
              <p className="feature-desc">
                Automatically generates Jest unit tests for your JavaScript functions using GPT-3.5 or any Ollama local model.
              </p>
            </div>
          </div>

          {/* Card 2 - Dependency Mocking */}
          <div className="feature-card">
            <div className="feature-icon">
              <img src={img2} alt="Automatic Dependency Mocking" />
            </div>
            <div className="feature-info">
              <h3 className="feature-title">Automatic Dependency Mocking</h3>
              <p className="feature-desc">
                Detects external calls to APIs, databases, and the file system and generates Sinon mocks automatically &mdash; no manual setup.
              </p>
            </div>
          </div>

          {/* Card 3 - Adaptive Repair Loop */}
          <div className="feature-card">
            <div className="feature-icon">
              <img src={img3} alt="Adaptive Repair Loop" />
            </div>
            <div className="feature-info">
              <h3 className="feature-title">Adaptive Repair Loop</h3>
              <p className="feature-desc">
                When tests fail, UnitGen classifies the failure and runs up to 3 LLM-guided repair attempts to fix them automatically.
              </p>
            </div>
          </div>

          {/* Card 4 - Assertion Strengthening */}
          <div className="feature-card bento-span-2">
            <div className="feature-icon">
              <img src={img4} alt="Assertion Quality Enhancement" />
            </div>
            <div className="feature-info">
              <h3 className="feature-title">Assertion Quality Enhancement</h3>
              <p className="feature-desc">
                Detects weak assertions like toBeDefined() and upgrades them to meaningful value-based checks using runtime observation.
              </p>
            </div>
          </div>

          {/* Card 5 - OpenAI + Ollama */}
          <div className="feature-card bento-span-2">
            <div className="feature-icon">
              <img src={img5} alt="OpenAI & Ollama Support" />
            </div>
            <div className="feature-info">
              <h3 className="feature-title">OpenAI & Ollama Support</h3>
              <p className="feature-desc">
                Works with OpenAI GPT models or any locally running Ollama model. Your code never leaves your machine with Ollama.
              </p>
            </div>
          </div>

          {/* Card 6 - Detailed Reports */}
          <div className="feature-card">
            <div className="feature-icon">
              <img src={img6} alt="Detailed JSON Reports" />
            </div>
            <div className="feature-info">
              <h3 className="feature-title">Detailed JSON Reports</h3>
              <p className="feature-desc">
                Every run produces a structured final-report.json with test counts, pass/fail results, and assertion quality data.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 3 - HOW IT WORKS */}
      <section className="section-padding" style={{ borderTop: "1px solid var(--border)", marginBottom: "40px" }}>
        <h2 style={{ fontSize: "2rem", color: "var(--color-1)", textAlign: "center" }}>
          How It Works
        </h2>
        
        <div className="flow-steps">
          {/* Step 1 */}
          <div className="flow-step">
            <div className="flow-circle">1</div>
            <h4 className="flow-title">Point at your code</h4>
            <p className="flow-desc">Select a .js file or project folder</p>
          </div>
          
          <div className="flow-arrow">&rarr;</div>

          {/* Step 2 */}
          <div className="flow-step">
            <div className="flow-circle">2</div>
            <h4 className="flow-title">Configure & Run</h4>
            <p className="flow-desc">Set your API key or Ollama model and click Start</p>
          </div>

          <div className="flow-arrow">&rarr;</div>

          {/* Step 3 */}
          <div className="flow-step">
            <div className="flow-circle">3</div>
            <h4 className="flow-title">Automatic Processing</h4>
            <p className="flow-desc">UnitGen scans, generates, repairs, and enhances your tests</p>
          </div>

          <div className="flow-arrow">&rarr;</div>

          {/* Step 4 */}
          <div className="flow-step">
            <div className="flow-circle">4</div>
            <h4 className="flow-title">Download Test Suite</h4>
            <p className="flow-desc">Get your ready-to-use Jest test files</p>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Home;
