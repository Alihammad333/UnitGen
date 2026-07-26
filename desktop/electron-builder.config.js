module.exports = {
  appId: "com.unitgen.app",
  productName: "UnitGen",
  asar: true,

  // Explicitly disable all code signing — no certificate needed
  forceCodeSigning: false,

  directories: {
    output: "dist",
    buildResources: "assets"
  },

  // Include the backend folder as an extra resource
  extraResources: [
    {
      from: "../backend",
      to: "backend",
      filter: ["**/*", "!node_modules/**", "!output/**", "!results/**"]
    },
    {
      from: "../backend/node_modules",
      to: "backend/node_modules",
      filter: ["**/*", "!.cache/**"]
    }
  ],

  // ── WINDOWS ──
  // Produces a standard .exe NSIS installer.
  // Windows SmartScreen will warn — user clicks "More info" → "Run anyway".
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "assets/icon.ico",
    artifactName: "UnitGen-Setup-${version}.${ext}"
  },
  nsis: {
    oneClick: false,                          // show install wizard, not silent install
    allowToChangeInstallationDirectory: true, // let user pick install folder
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "UnitGen",
    installerHeaderIcon: "assets/icon.ico",
    uninstallDisplayName: "UnitGen"
  },

  // ── MAC ──
  // Produces a .dmg installer.
  // Mac Gatekeeper will warn — user goes to System Settings → Privacy & Security
  // → "Open Anyway", or right-clicks the app and selects Open.
  mac: {
    target: [{ target: "dmg", arch: ["x64", "arm64"] }],
    icon: "assets/icon.icns",
    identity: null,        // disable code signing
    hardenedRuntime: false,
    gatekeeperAssess: false,
    artifactName: "UnitGen-${version}-${arch}.${ext}"
  },
  dmg: {
    title: "UnitGen Installer",
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" }
    ]
  },

  // ── LINUX ──
  // Produces a Snap package.
  linux: {
    target: [{ target: "snap", arch: ["x64"] }],
    icon: "assets/icon.png",
    category: "Development",
    artifactName: "UnitGen-${version}-amd64.${ext}"
  },
  snap: {
    grade: "stable",
    confinement: "classic"
  }
}
