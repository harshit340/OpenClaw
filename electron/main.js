const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const { fork } = require("child_process");
const http = require("http");

let mainWindow = null;
let serverProcess = null;
const SERVER_PORT = 8891;

function startExpressServer() {
  return new Promise((resolve) => {
    const serverPath = path.join(__dirname, "../server/index.js");
    console.log("[electron] forking server at:", serverPath);

    serverProcess = fork(serverPath, [], {
      env: { ...process.env, PORT: String(SERVER_PORT) },
      stdio: "pipe",
    });

    serverProcess.stdout?.on("data", (data) => {
      const msg = data.toString().trim();
      console.log("[server]", msg);
      if (msg.includes(`running on port ${SERVER_PORT}`)) {
        console.log("[electron] server started signal received ✓");
        resolve();
      }
    });

    serverProcess.stderr?.on("data", (data) => {
      console.error("[server error]", data.toString().trim());
    });

    serverProcess.on("error", (err) => {
      console.error("[server fork error]", err.message);
      resolve();
    });

    serverProcess.on("exit", (code) => {
      console.log("[server] process exited with code:", code);
    });

    setTimeout(() => {
      console.log("[electron] server start timeout — proceeding anyway");
      resolve();
    }, 8000);
  });
}

function waitForServer(port, maxWaitMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    console.log(`[electron] polling http://localhost:${port}/api/health ...`);

    const interval = setInterval(() => {
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        if (res.statusCode < 500) {
          clearInterval(interval);
          console.log("[electron] server health check passed ✓");
          resolve();
        }
      });

      req.on("error", () => {
        if (Date.now() - start > maxWaitMs) {
          clearInterval(interval);
          reject(new Error(`Server did not respond within ${maxWaitMs}ms`));
        }
      });

      req.setTimeout(1000, () => {
        req.destroy();
        if (Date.now() - start > maxWaitMs) {
          clearInterval(interval);
          reject(new Error("Server poll timed out"));
        }
      });
    }, 500);
  });
}

async function findVitePort() {
  const ports = [5173, 5174, 5175];
  const maxWait = 30000;
  const start = Date.now();

  console.log("[electron] waiting for Vite to start...");

  while (Date.now() - start < maxWait) {
    for (const port of ports) {
      const ok = await new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}`, (res) => {
          resolve(res.statusCode < 500);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(500, () => { req.destroy(); resolve(false); });
      });

      if (ok) {
        console.log("[electron] found Vite on port:", port);
        return port;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("[electron] Vite not found after 30s, defaulting to 5173");
  return 5173;
}

async function createWindow(vitePort) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    show: false,
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  const isDev = !app.isPackaged;

  if (isDev) {
    console.log("[electron] loading Vite at port:", vitePort);
    mainWindow.loadURL(`http://localhost:${vitePort}`);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);
  }
}

app.whenReady().then(async () => {
  const [vitePort] = await Promise.all([
    findVitePort(),
    startExpressServer().then(async () => {
      try {
        await waitForServer(SERVER_PORT, 15000);
      } catch (err) {
        console.error("[electron] WARNING: server may not be ready:", err.message);
      }
    }),
  ]);

  await createWindow(vitePort);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(vitePort);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});