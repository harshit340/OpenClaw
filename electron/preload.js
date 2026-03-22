const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  pickFile: () => ipcRenderer.invoke("pick-file"),
  platform: process.platform,
});
