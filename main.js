const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

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
      if (!fs.existsSync(destination)) {
        try {
          fs.cpSync(source, destination, { recursive: true, errorOnExist: false, force: false });
        } catch (e) {
          console.warn('Could not copy bundled extension:', entry.name, e);
        }
      }
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
  event.returnValue = prepareExtensionsDirectory();
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
  createWindow();
  setupAdBlocker();

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
