const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const CentralUpdater = require('./updater');

// Isolate cache and userData outside OneDrive to prevent Windows lock (0x5 Access Denied)
const cleanUserData = path.join(os.homedir(), '.chattarayici-data');
try {
  if (!fs.existsSync(cleanUserData)) {
    fs.mkdirSync(cleanUserData, { recursive: true });
  }
  app.setPath('userData', cleanUserData);
} catch (e) {
  console.warn('Could not set custom userData path:', e);
}

// Disable problematic disk caches on Windows
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('no-sandbox');

let mainWindow;
let extensionsDirectory = null;
let githubUpdater = null;
const nativeExtensions = new Map();
const extensionLoadErrors = new Map();

function prepareExtensionsDirectory() {
  const writableDir = path.join(app.getPath('userData'), 'extensions');
  fs.mkdirSync(writableDir, { recursive: true });

  const bundledDir = path.join(__dirname, 'extensions');
  const writableState = path.join(writableDir, '.enabled.json');
  const bundledState = path.join(bundledDir, '.enabled.json');
  const permanentlyRemovedIds = ['karanlik-mod'];
  const bundledExtensionIds = fs.existsSync(bundledDir)
    ? fs.readdirSync(bundledDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
    : [];

  let state = { enabled: [], known: [], removed: [] };
  const hasWritableState = fs.existsSync(writableState);
  try {
    if (hasWritableState) {
      state = JSON.parse(fs.readFileSync(writableState, 'utf-8'));
    } else if (fs.existsSync(bundledState)) {
      state = JSON.parse(fs.readFileSync(bundledState, 'utf-8'));
      state.known = Array.isArray(state.known) ? state.known : bundledExtensionIds;
    }
  } catch (e) {
    console.warn('Could not read extension settings:', e);
    state = { enabled: [], known: [], removed: [] };
  }

  state.enabled = Array.isArray(state.enabled) ? state.enabled : [];
  state.known = Array.isArray(state.known) ? state.known : [];
  state.removed = Array.isArray(state.removed) ? state.removed : [];

  // Keep explicitly deleted bundled extensions deleted across app updates.
  for (const extId of permanentlyRemovedIds) {
    const removedPath = path.join(writableDir, extId);
    try {
      fs.rmSync(removedPath, { recursive: true, force: true });
    } catch (e) {
      console.warn('Could not remove retired extension:', extId, e);
    }
    state.enabled = state.enabled.filter(id => id !== extId);
    if (!state.known.includes(extId)) state.known.push(extId);
    if (!state.removed.includes(extId)) state.removed.push(extId);
  }

  if (fs.existsSync(bundledDir) && path.resolve(bundledDir) !== path.resolve(writableDir)) {
    const removedIds = new Set(state.removed);
    for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || removedIds.has(entry.name)) continue;
      const source = path.join(bundledDir, entry.name);
      const destination = path.join(writableDir, entry.name);
      if (!fs.existsSync(path.join(destination, 'manifest.json'))) {
        try {
          fs.rmSync(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          fs.cpSync(source, destination, { recursive: true, errorOnExist: false, force: false });
        } catch (e) {
          console.warn('Could not copy bundled extension:', entry.name, e);
        }
      }
    }
  }

  // Match ExtensionManager's first-scan behavior before the native extensions
  // are loaded. Without this, the first scan can enable an extension only
  // after Electron has already decided which extensions to load at startup.
  const removedIds = new Set(state.removed);
  for (const entry of fs.readdirSync(writableDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || removedIds.has(entry.name)) continue;
    if (!fs.existsSync(path.join(writableDir, entry.name, 'manifest.json'))) continue;

    if (!state.known.includes(entry.name)) {
      state.known.push(entry.name);
      if (!state.enabled.includes(entry.name)) state.enabled.push(entry.name);
    }
  }

  try {
    fs.writeFileSync(writableState, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('Could not save extension settings:', e);
  }

  return writableDir;
}

ipcMain.on('extensions-get-directory', (event) => {
  extensionsDirectory = extensionsDirectory || prepareExtensionsDirectory();
  event.returnValue = extensionsDirectory;
});

function getSafeExtensionPath(extId) {
  extensionsDirectory = extensionsDirectory || prepareExtensionsDirectory();
  if (typeof extId !== 'string' || !extId.trim()) throw new Error('Eklenti kimliği geçersiz.');

  const resolvedPath = path.resolve(extensionsDirectory, extId);
  const relativePath = path.relative(extensionsDirectory, resolvedPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Eklenti yolu geçersiz.');
  }
  return resolvedPath;
}

async function loadNativeExtension(extId) {
  const existing = nativeExtensions.get(extId);
  if (existing) return { ok: true, id: existing.id, url: existing.url };

  const extensionPath = getSafeExtensionPath(extId);
  if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
    throw new Error('Eklenti klasöründe manifest.json bulunamadı.');
  }

  try {
    const loaded = await session.defaultSession.loadExtension(extensionPath, { allowFileAccess: true });
    nativeExtensions.set(extId, loaded);
    extensionLoadErrors.delete(extId);
    return { ok: true, id: loaded.id, url: loaded.url };
  } catch (e) {
    extensionLoadErrors.set(extId, e.message);
    throw e;
  }
}

function unloadNativeExtension(extId) {
  const loaded = nativeExtensions.get(extId);
  if (loaded) {
    session.defaultSession.removeExtension(loaded.id);
    nativeExtensions.delete(extId);
  }
  extensionLoadErrors.delete(extId);
  return true;
}

async function loadEnabledNativeExtensions() {
  extensionsDirectory = prepareExtensionsDirectory();
  const statePath = path.join(extensionsDirectory, '.enabled.json');
  let enabledIds = new Set();
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    enabledIds = new Set(Array.isArray(state.enabled) ? state.enabled : []);
  } catch (e) {
    console.warn('Could not read enabled extension list:', e);
  }

  for (const entry of fs.readdirSync(extensionsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !enabledIds.has(entry.name)) continue;
    try {
      await loadNativeExtension(entry.name);
    } catch (e) {
      console.warn(`Could not load extension ${entry.name} with Electron:`, e.message);
    }
  }
}

ipcMain.on('extensions-get-runtime-info', (event) => {
  event.returnValue = {
    loaded: Array.from(nativeExtensions.entries()).map(([extId, ext]) => [extId, { id: ext.id, url: ext.url }]),
    errors: Array.from(extensionLoadErrors.entries())
  };
});

ipcMain.handle('extension-load-native', async (_event, extId) => {
  try {
    return await loadNativeExtension(extId);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('extension-unload-native', (_event, extId) => {
  try {
    return { ok: unloadNativeExtension(extId) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function sendUpdaterStatus(message, isError = false) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('github-update-status', { message, isError });
  }
}

function startUpdateInstaller(installerPath) {
  return new Promise((resolve, reject) => {
    const installer = spawn(installerPath, [], {
      detached: true,
      stdio: 'ignore'
    });
    installer.once('error', reject);
    installer.once('spawn', () => {
      installer.unref();
      setTimeout(() => app.quit(), 800);
      resolve();
    });
  });
}

function createGithubUpdater() {
  githubUpdater = new CentralUpdater({
    appRoot: app.getAppPath(),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    configPath: path.join(app.getPath('userData'), 'update-config.json'),
    onStatus: (message) => sendUpdaterStatus(message, false),
    onError: (message) => sendUpdaterStatus(message, true),
    onInstall: startUpdateInstaller
  });
}

ipcMain.handle('github-update-check', async (_event, options = {}) => {
  if (!githubUpdater) createGithubUpdater();
  if (options.repo) {
    githubUpdater.config.githubRepo = options.repo;
    githubUpdater.saveConfig();
  }
  return githubUpdater.checkForUpdates(Boolean(options.silent), true);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f0f1a',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile('index.html');

  // Window control events
  ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
  });

  ipcMain.on('window-is-maximized', (event) => {
    event.returnValue = mainWindow ? mainWindow.isMaximized() : false;
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-maximized', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-maximized', false);
  });

  // Open directory dialog for extensions
  ipcMain.handle('dialog-open-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Eklenti Klasörü Seç',
      properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Open zip file dialog for extensions
  ipcMain.handle('dialog-open-zip', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Eklenti ZIP Dosyası Seç',
      filters: [{ name: 'ZIP Dosyaları', extensions: ['zip'] }],
      properties: ['openFile']
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

// Ad blocker - block common ad domains
function setupAdBlocker() {
  const adDomains = [
    '*://*.doubleclick.net/*',
    '*://*.googlesyndication.com/*',
    '*://*.googleadservices.com/*',
    '*://*.google-analytics.com/*',
    '*://*.adnxs.com/*',
    '*://*.adsrvr.org/*',
    '*://*.facebook.com/tr*',
  ];

  try {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: adDomains },
      (details, callback) => {
        callback({ cancel: true });
      }
    );
  } catch (e) {
    console.warn('Ad blocker setup warning:', e);
  }
}

app.whenReady().then(() => {
  setupAdBlocker();
  loadEnabledNativeExtensions().then(() => {
    createWindow();
    if (!githubUpdater) createGithubUpdater();
  }).catch((e) => {
    console.error('Could not initialize extensions:', e);
    createWindow();
    if (!githubUpdater) createGithubUpdater();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
