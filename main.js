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

  // App restart (updates)
  ipcMain.on('app-restart', () => {
    app.relaunch();
    app.exit(0);
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
