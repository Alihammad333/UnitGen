import React, { useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Link } from "react-router-dom";
import brandIcon from "./assets/icon.png";

// Page imports
import Home from "./pages/Home";
import About from "./pages/About";
import HowToUse from "./pages/HowToUse";

// Simple 404 Component
const NotFound = () => (
  <div style={{
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "70vh",
    textAlign: "center",
    padding: "0 24px"
  }}>
    <h1 style={{ fontSize: "3rem", color: "var(--color-1)", marginBottom: "16px" }}>404</h1>
    <h2 style={{ fontSize: "1.5rem", color: "var(--text-dark)", marginBottom: "12px" }}>Page Not Found</h2>
    <p style={{ color: "var(--text-grey)", marginBottom: "32px", maxWidth: "400px" }}>
      The page you are looking for doesn't exist or has been moved.
    </p>
    <Link to="/" className="btn-download">
      Back to Home
    </Link>
  </div>
);

// Navbar Navigation Header component
const Header = () => {
  const [isOpen, setIsOpen] = useState(false);

  const toggleMenu = () => setIsOpen(!isOpen);
  const closeMenu = () => setIsOpen(false);

  return (
    <header className="navbar">
      <div className="container nav-container">
        <Link to="/" className="nav-logo" onClick={closeMenu}>
          <img src={brandIcon} alt="UnitGen Logo" className="nav-logo-icon" />
          <span className="nav-logo-text">UnitGen</span>
        </Link>

        {/* Desktop Links */}
        <nav className="nav-links">
          <NavLink to="/" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`} end>
            Home
          </NavLink>
          <NavLink to="/about" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            About
          </NavLink>
          <NavLink to="/how-to-use" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            How to Use
          </NavLink>
        </nav>

        {/* Mobile Hamburger toggle button */}
        <button
          className="hamburger"
          onClick={toggleMenu}
          aria-label="Toggle navigation menu"
          aria-expanded={isOpen}
        >
          <span style={{ transform: isOpen ? "rotate(45deg) translate(5px, 6px)" : "none" }}></span>
          <span style={{ opacity: isOpen ? 0 : 1 }}></span>
          <span style={{ transform: isOpen ? "rotate(-45deg) translate(5px, -6px)" : "none" }}></span>
        </button>

        {/* Mobile Dropdown Menu drawer */}
        <div className={`nav-mobile-menu ${isOpen ? "open" : ""}`}>
          <NavLink
            to="/"
            className={({ isActive }) => `nav-mobile-link ${isActive ? "active" : ""}`}
            onClick={closeMenu}
            end
          >
            Home
          </NavLink>
          <NavLink
            to="/about"
            className={({ isActive }) => `nav-mobile-link ${isActive ? "active" : ""}`}
            onClick={closeMenu}
          >
            About
          </NavLink>
          <NavLink
            to="/how-to-use"
            className={({ isActive }) => `nav-mobile-link ${isActive ? "active" : ""}`}
            onClick={closeMenu}
          >
            How to Use
          </NavLink>
        </div>
      </div>
    </header>
  );
};

// Main App Component with router configuration
const App = () => {
  return (
    <BrowserRouter>
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <Header />

        {/* Main Content Area */}
        <main style={{ flex: 1 }}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/about" element={<About />} />
            <Route path="/how-to-use" element={<HowToUse />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>

        {/* Sticky Global Footer */}
        <footer className="footer">
          <div className="container">
            <p className="footer-text">
              UnitGen &copy; 2026 &mdash; A Unified Framework for Verification & Improvement of LLM-Based Automated Unit Test Generation
            </p>
          </div>
        </footer>
      </div>
    </BrowserRouter>
  );
};

export default App;
