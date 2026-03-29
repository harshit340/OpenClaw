const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

let mainWindow;
let serverProcess;

const isDev = !app.isPackaged;
const SERVER_PORT = 8891;

app.setName("Bolofy");

function startServer() {
  let serverPath = path.join(__dirname, "..", "server", "index.js");
  let rootNodeModules = path.join(__dirname, "..", "node_modules");
  let serverNodeModules = path.join(__dirname, "..", "server", "node_modules");

  if (!isDev) {
    serverPath = serverPath.replace("app.asar", "app.asar.unpacked");
    rootNodeModules = rootNodeModules.replace("app.asar", "app.asar.unpacked");
    serverNodeModules = serverNodeModules.replace("app.asar", "app.asar.unpacked");
  }

  const nodePath = [serverNodeModules, rootNodeModules].join(path.delimiter);

  console.log("[main] starting server:", serverPath);
  console.log("[main] NODE_PATH:", nodePath);

  serverProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: SERVER_PORT,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: nodePath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (data) => {
    console.log(`[server] ${data.toString().trim()}`);
  });

  serverProcess.stderr.on("data", (data) => {
    console.error(`[server] ${data.toString().trim()}`);
  });

  serverProcess.on("close", (code) => {
    console.log(`Server exited with code ${code}`);
  });
}

function waitForServer(retries = 30) {
  return new Promise((resolve, reject) => {
    const check = (attempt) => {
      http
        .get(`http://127.0.0.1:${SERVER_PORT}/api/health`, (res) => {
          if (res.statusCode === 200) resolve();
          else if (attempt < retries) setTimeout(() => check(attempt + 1), 500);
          else reject(new Error("Server health check failed"));
        })
        .on("error", () => {
          if (attempt < retries) setTimeout(() => check(attempt + 1), 500);
          else reject(new Error("Server not reachable"));
        });
    };
    check(0);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Bolofy",
    icon: path.join(__dirname, "..", "resources", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Show loading screen first
  mainWindow.loadFile(path.join(__dirname, "loading.html"));

  return mainWindow;
}

async function loadApp() {
  if (isDev) {
    mainWindow.loadURL("http://localhost:5174");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "client", "dist", "index.html"));
  }
}

ipcMain.handle("pick-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select config.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const fs = require("fs");
  const content = fs.readFileSync(result.filePaths[0], "utf-8");
  return JSON.parse(content);
});

app.whenReady().then(async () => {
  // Set dock icon on macOS
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(path.join(__dirname, "..", "resources", "icon.png"));
  }

  createWindow();
  startServer();

  try {
    await waitForServer();
    console.log("Server is ready");
    await loadApp();
  } catch (err) {
    console.error("Failed to start server:", err);
    dialog.showErrorBox("Startup Error", "Failed to start the backend server.");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
