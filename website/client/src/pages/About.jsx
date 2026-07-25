import React from "react";

const About = () => {
  return (
    <div className="container section-padding" style={{ maxWidth: "850px" }}>
      {/* Section 1 - Intro */}
      <section className="prose-section">
        <h1 className="prose-title" style={{ fontSize: "2.2rem", marginBottom: "20px" }}>
          What is UnitGen?
        </h1>
        <p style={{ fontSize: "1.1rem", color: "var(--text-grey)", marginBottom: "16px" }}>
          UnitGen is an LLM-powered desktop application designed to automate, verify, and enhance Jest unit tests for JavaScript and Node.js projects.
        </p>
        <p style={{ marginBottom: "16px" }}>
          Unlike traditional test generators that dump static, unverified code templates and exit, UnitGen integrates execution directly inside its test generation pipeline. It actively executes the generated tests, catches syntax and import crashes, runs an adaptive healing loop, and upgrades simple structural assertions into value-based runtime checks.
        </p>
        <p>
          By supporting both cloud-based <strong>OpenAI GPT</strong> models and locally deployed <strong>Ollama</strong> instances, developers can choose between fast API compilation or fully offline, private inference where your source code never leaves your local workspace.
        </p>
      </section>

      {/* Section 2 - The Problems It Solves */}
      <section className="prose-section">
        <h2 className="prose-title" style={{ fontSize: "1.8rem", marginBottom: "24px" }}>
          The Problem It Solves
        </h2>
        <div className="prose-card-grid" style={{ gridTemplateColumns: "1fr", gap: "24px" }}>
          {/* Card 1 */}
          <div className="prose-card" style={{ borderLeft: "4px solid var(--color-4)" }}>
            <h3 className="prose-card-title" style={{ fontSize: "1.2rem", fontWeight: 700 }}>
              Problem 1: Tests that fail on imports & environment mocks
            </h3>
            <p className="prose-card-text" style={{ marginTop: "8px", fontSize: "0.95rem" }}>
              <strong>The Issue:</strong> Typical LLM-written tests fail immediately because they don't mock database connections, third-party REST APIs, or local file systems.
            </p>
            <p className="prose-card-text" style={{ marginTop: "8px", fontSize: "0.95rem" }}>
              <strong>The Solution:</strong> UnitGen scans source imports, detects system queries, and automatically injects stubbed Sinon mocks so that the tests execute securely without complex configuration.
            </p>
          </div>

          {/* Card 2 */}
          <div className="prose-card" style={{ borderLeft: "4px solid var(--color-4)" }}>
            <h3 className="prose-card-title" style={{ fontSize: "1.2rem", fontWeight: 700 }}>
              Problem 2: Weak structural check assertions
            </h3>
            <p className="prose-card-text" style={{ marginTop: "8px", fontSize: "0.95rem" }}>
              <strong>The Issue:</strong> AI code generators often write safe but useless assertions like <code>expect(res).toBeDefined()</code>, which passes even if functions return buggy values.
            </p>
            <p className="prose-card-text" style={{ marginTop: "8px", fontSize: "0.95rem" }}>
              <strong>The Solution:</strong> UnitGen runs a dynamic assertion upgrades system. It executes the function under strict sandbox observation and swaps structural checks with explicit value-based assertions.
            </p>
          </div>

          {/* Card 3 */}
          <div className="prose-card" style={{ borderLeft: "4px solid var(--color-4)" }}>
            <h3 className="prose-card-title" style={{ fontSize: "1.2rem", fontWeight: 700 }}>
              Problem 3: Abandoned failing assertions
            </h3>
            <p className="prose-card-text" style={{ marginTop: "8px", fontSize: "0.95rem" }}>
              <strong>The Issue:</strong> Generators leave developers to manually fix syntax, formatting, and minor logic bugs inside generated test suites.
            </p>
            <p className="prose-card-text" style={{ marginTop: "8px", fontSize: "0.95rem" }}>
              <strong>The Solution:</strong> UnitGen features an LLM-guided adaptive repair loop. If a test fails Jest execution, the pipeline feeds the stack trace and code back into the LLM to heal it (up to 3 sequential attempts).
            </p>
          </div>
        </div>
      </section>

      {/* Section 3 - Background Project Details */}
      <section className="prose-section" style={{ marginBottom: 0 }}>
        <h2 className="prose-title" style={{ fontSize: "1.8rem" }}>
          Background
        </h2>
        <p style={{ marginTop: "12px" }}>
          UnitGen was created as a Final Year Project exploring advanced agentic workflows inside test execution environments. It investigates how local inference pipelines and self-healing compilers can augment developer velocity. The platform is open source, free to use, and welcoming developer contributions.
        </p>
      </section>
    </div>
  );
};

export default About;
