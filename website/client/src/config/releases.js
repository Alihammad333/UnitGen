const BASE = import.meta.env.VITE_GITHUB_RELEASES_BASE_URL
  || "https://github.com/Alihammad333/UnitGen/releases/download";

export const VERSION = "v1.0.0";

// Extract raw version (e.g., "1.0.0" from "v1.0.0")
const RAW_VERSION = VERSION.replace(/^v/, "");

export const DOWNLOAD_URLS = {
  windows: `${BASE}/${VERSION}/UnitGen-Setup-${RAW_VERSION}.exe`,
  mac:     `${BASE}/${VERSION}/UnitGen-${RAW_VERSION}-arm64.dmg`,
  linux:   `${BASE}/${VERSION}/UnitGen-${RAW_VERSION}-amd64.snap`,
};