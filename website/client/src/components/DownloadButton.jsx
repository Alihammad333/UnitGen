import React, { useState, useEffect } from "react";
import { DOWNLOAD_URLS, VERSION } from "../config/releases";

// Programmatic anchor download — triggers browser's native download bar
// without navigating away or opening a new tab (VS Code download experience)
function triggerDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.setAttribute("download", ""); // hint to browser: save file, don't navigate
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const DownloadButton = ({ size = "large", onDownloadTriggered }) => {
  const [detectedOs, setDetectedOs] = useState("unknown");
  const [activeOs, setActiveOs] = useState("unknown");
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    const ua = window.navigator.userAgent.toLowerCase();
    let os = "unknown";
    if (ua.includes("win")) os = "windows";
    else if (ua.includes("mac")) os = "mac";
    else if (ua.includes("linux")) os = "linux";
    setDetectedOs(os);
    setActiveOs(os);
  }, []);

  // Returns the default label for the current activeOs
  const getDefaultLabel = (os) => {
    switch (os) {
      case "windows": return "Download for Windows (.exe)";
      case "mac": return "Download for Mac (.dmg)";
      case "linux": return "Download for Linux (.snap)";
      default: return "Download";
    }
  };

  const handleDownload = async (osType) => {
    if (osType === "unknown" || isDownloading) return;

    // 1. Immediately disable the button and show feedback
    setIsDownloading(true);

    // 2. Record analytics — fire and forget, never block the download
    try {
      await fetch(`/api/download/${osType}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: VERSION }),
      });
    } catch (err) {
      // Silently ignore analytics failures
      console.warn("Analytics tracker failed silently.", err.message);
    }

    // 3. Call optional parent callback to refresh stats counters
    if (onDownloadTriggered) {
      onDownloadTriggered();
    }

    // 4. Trigger the direct file download — stays on current page
    triggerDownload(DOWNLOAD_URLS[osType]);

    // 5. Re-enable button after 3 seconds
    setTimeout(() => {
      setIsDownloading(false);
    }, 3000);
  };

  const isSmall = size === "small";
  const buttonLabel = isDownloading
    ? "Starting download..."
    : getDefaultLabel(activeOs);

  return (
    <div className="btn-download-wrapper">
      {/* If OS is unknown, render a manual switcher dropdown */}
      {activeOs === "unknown" && (
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <select
            value={activeOs}
            onChange={(e) => setActiveOs(e.target.value)}
            style={{
              padding: "8px 12px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              fontFamily: "inherit",
              color: "var(--text-dark)",
              fontWeight: 500,
            }}
          >
            <option value="unknown">Select Operating System</option>
            <option value="windows">Windows</option>
            <option value="mac">macOS</option>
            <option value="linux">Linux</option>
          </select>
        </div>
      )}

      {/* Version Tag Indicator */}
      <div 
        className="version-tag-badge"
        style={{
          fontSize: isSmall ? "0.75rem" : "0.85rem",
          fontWeight: "600",
          color: "var(--color-2)",
          backgroundColor: "var(--color-9)",
          border: "1px solid var(--border)",
          padding: "4px 14px",
          borderRadius: "20px",
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          marginBottom: "6px"
        }}
      >
        <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#10b981", display: "inline-block" }}></span>
        Latest Release Tag: <strong>{VERSION}</strong>
      </div>

      {/* Primary Download trigger button */}
      <button
        onClick={() => handleDownload(activeOs)}
        className="btn-download"
        disabled={activeOs === "unknown" || isDownloading}
        style={{
          padding: isSmall ? "10px 24px" : "16px 40px",
          fontSize: isSmall ? "14px" : "16px",
          opacity: (activeOs === "unknown" || isDownloading) ? 0.6 : 1,
          cursor: (activeOs === "unknown" || isDownloading) ? "not-allowed" : "pointer",
        }}
      >
        {buttonLabel}
      </button>

      {/* Alternative download selectors */}
      <div className="download-link-group" style={{ fontSize: isSmall ? "0.8rem" : "0.85rem" }}>
        <span>Also available for:</span>
        <button className="download-link" onClick={() => handleDownload("windows")} disabled={isDownloading}>Windows</button>
        <span>&middot;</span>
        <button className="download-link" onClick={() => handleDownload("mac")} disabled={isDownloading}>Mac</button>
        <span>&middot;</span>
        <button className="download-link" onClick={() => handleDownload("linux")} disabled={isDownloading}>Linux</button>
      </div>

      {/* Platform specific details / warnings */}
      {activeOs === "windows" && (
        <p className="download-warning-note">
          <strong>Unsigned Warning:</strong> If Windows SmartScreen displays a warning, click <strong>"More info"</strong> and then select <strong>"Run anyway"</strong> to proceed with the installation.
        </p>
      )}
      {activeOs === "mac" && (
        <p className="download-warning-note">
          <strong>Gatekeeper Warning:</strong> To run the app, right-click (or Control-click) the application icon, choose <strong>"Open"</strong> from the menu, and click <strong>"Open"</strong> in the popup; alternatively, go to <strong>System Settings &rsaquo; Privacy &amp; Security</strong> and click <strong>"Open Anyway"</strong>.
        </p>
      )}
      {activeOs === "linux" && (
        <p className="download-warning-note">
          <strong>Snap Setup:</strong> Install the downloaded <code>.snap</code> package via terminal: <code>sudo snap install --dangerous unitgen_1.0.0_amd64.snap</code>. Note: this build is designed specifically for Ubuntu.
        </p>
      )}
    </div>
  );
};

export default DownloadButton;
