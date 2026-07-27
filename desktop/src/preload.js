const { contextBridge, ipcRenderer } = require("electron");

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("electronAPI", {
  "dialog:openPath": (mode = "directory") =>
    ipcRenderer.invoke("dialog:openPath", mode),
  "unitgen:run": (targetPath, envVars) =>
    ipcRenderer.invoke("unitgen:run", targetPath, envVars),
  "unitgen:stop": () => ipcRenderer.invoke("unitgen:stop"),
  "unitgen:onLog": (callback) => on("unitgen:log", callback),
  "unitgen:onEvent": (callback) => on("unitgen:event", callback),
  "unitgen:onDone": (callback) => on("unitgen:done", callback),
  "settings:save": (data) => ipcRenderer.invoke("settings:save", data),
  "settings:load": () => ipcRenderer.invoke("settings:load"),
  "unitgen:downloadTests": () => ipcRenderer.invoke("unitgen:downloadTests"),
  "ollama:checkConnection": (host) =>
    ipcRenderer.invoke("ollama:checkConnection", host),
  "shell:openExternal": (url) => ipcRenderer.invoke("shell:openExternal", url),

  openPath: () => ipcRenderer.invoke("dialog:openPath", "directory"),
  openFile: () => ipcRenderer.invoke("dialog:openPath", "file"),
  openDirectory: () => ipcRenderer.invoke("dialog:openPath", "directory"),
  runUnitGen: (targetPath, envVars) =>
    ipcRenderer.invoke("unitgen:run", targetPath, envVars),
  stopUnitGen: () => ipcRenderer.invoke("unitgen:stop"),
  onLog: (callback) => on("unitgen:log", callback),
  onEvent: (callback) => on("unitgen:event", callback),
  onDone: (callback) => on("unitgen:done", callback),
  saveSettings: (data) => ipcRenderer.invoke("settings:save", data),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  downloadTests: () => ipcRenderer.invoke("unitgen:downloadTests"),
  checkOllamaConnection: (host) =>
    ipcRenderer.invoke("ollama:checkConnection", host),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url)
});
