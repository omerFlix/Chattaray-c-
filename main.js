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

  // Seed the writable user directory with bundled extensions once. Existing user
  // copies and their settings are preserved across installs and app updates.
  const bundledDir = path.join(__dirname, 'extensions');
  const bundledExtensionIds = [];
  if (fs.existsSync(bundledDir) && path.resolve(bundledDir) !== path.resolve(writableDir)) {
    for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      bundledExtensionIds.push(entry.name);
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

    // Carry forward the old extension enablement file and record all bundled
    // extensions as known, so previously disabled extensions stay disabled.
    const bundledState = path.join(bundledDir, '.enabled.json');
    const writableState = path.join(writableDir, '.enabled.json');
    if (fs.existsSync(bundledState) && !fs.existsSync(writableState)) {
      try {
        const oldState = JSON.parse(fs.readFileSync(bundledState, 'utf-8'));
        fs.writeFileSync(writableState, JSON.stringify({
          enabled: Array.isArray(oldState.enabled) ? oldState.enabled : [],
          known: Array.isArray(oldState.known) ? oldState.known : bundledExtensionIds
        }, null, 2));
      } catch (e) {
        console.warn('Could not migrate extension settings:', e);
      }
    }
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
