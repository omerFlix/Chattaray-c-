const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const net = require('net');
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
const ADULT_BLOCKLIST_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts';
const ADULT_BLOCKLIST_REFRESH_MS = 24 * 60 * 60 * 1000;
const ADULT_BLOCKLIST_MAX_BYTES = 12 * 1024 * 1024;
const adBlockDomains = new Set([
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'adnxs.com',
  'adsrvr.org'
]);
let adultBlockDomains = new Set();
let adultProtectionEnabled = true;
let adultBlocklistUpdatedAt = null;

function adultProtectionPaths() {
  const userData = app.getPath('userData');
  return {
    settings: path.join(userData, 'security-settings.json'),
    cache: path.join(userData, 'adult-sites-hosts.txt')
  };
}

function getAdultProtectionStatus() {
  return {
    enabled: adultProtectionEnabled,
    domainCount: adultBlockDomains.size,
    updatedAt: adultBlocklistUpdatedAt
  };
}

function loadAdultProtectionSettings() {
  try {
    const config = JSON.parse(fs.readFileSync(adultProtectionPaths().settings, 'utf8'));
    adultProtectionEnabled = config.adultProtection !== false;
  } catch {
    adultProtectionEnabled = true;
  }
}

function saveAdultProtectionSettings() {
  try {
    const { settings } = adultProtectionPaths();
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ adultProtection: adultProtectionEnabled }, null, 2));
  } catch (error) {
    console.warn('Could not save adult protection settings:', error.message);
  }
}

function resolveChromeExtensionName(manifest, extensionPath) {
  const rawName = typeof manifest.name === 'string' ? manifest.name : '';
  const messageName = rawName.match(/^__MSG_(.+)__$/i);
  if (!messageName) return rawName || path.basename(extensionPath);

  const locales = [manifest.default_locale, 'en'].filter(Boolean);
  for (const locale of locales) {
    if (!/^[a-z0-9_-]+$/i.test(locale)) continue;
    try {
      const messages = JSON.parse(fs.readFileSync(path.join(extensionPath, '_locales', locale, 'messages.json'), 'utf8'));
      const entry = messages[messageName[1].toLowerCase()];
      if (entry && typeof entry.message === 'string') return entry.message;
    } catch {}
  }
  return rawName;
}

const chromeExtensionCandidates = new Map();

function scanChromeInstalledExtensions() {
  chromeExtensionCandidates.clear();
  if (process.platform !== 'win32') return [];

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const chromeUserData = path.join(localAppData, 'Google', 'Chrome', 'User Data');
  let profiles = [];
  try {
    profiles = fs.readdirSync(chromeUserData, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
      .map(entry => entry.name)
      .sort((a, b) => a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b));
  } catch {
    return [];
  }

  const found = [];
  for (const profileName of profiles) {
    const profilePath = path.join(chromeUserData, profileName);
    const extensionsPath = path.join(profilePath, 'Extensions');
    let extensionFolders = [];
    try {
      extensionFolders = fs.readdirSync(extensionsPath, { withFileTypes: true }).filter(entry => entry.isDirectory());
    } catch {
      continue;
    }

    let enabledStates = {};
    try {
      const preferences = JSON.parse(fs.readFileSync(path.join(profilePath, 'Preferences'), 'utf8'));
      enabledStates = preferences.extensions?.settings || {};
    } catch {}

    for (const extensionFolder of extensionFolders) {
      const extensionId = extensionFolder.name;
      if (!/^[a-p]{32}$/.test(extensionId) || chromeExtensionCandidates.has(extensionId)) continue;
      const extensionPath = path.join(extensionsPath, extensionId);
      let versions = [];
      try {
        versions = fs.readdirSync(extensionPath, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => {
            const folderPath = path.join(extensionPath, entry.name);
            try {
              const manifest = JSON.parse(fs.readFileSync(path.join(folderPath, 'manifest.json'), 'utf8'));
              return { folderPath, manifest };
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .sort((a, b) => String(b.manifest.version || '').localeCompare(String(a.manifest.version || ''), undefined, { numeric: true }));
      } catch {
        continue;
      }

      const latest = versions[0];
      if (!latest) continue;
      const enabledEntry = enabledStates[extensionId];
      const candidate = {
        id: extensionId,
        name: resolveChromeExtensionName(latest.manifest, latest.folderPath),
        version: String(latest.manifest.version || '—'),
        enabled: !enabledEntry || enabledEntry.state !== 0,
        profile: profileName,
        path: latest.folderPath
      };
      chromeExtensionCandidates.set(extensionId, candidate.path);
      found.push(candidate);
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

ipcMain.handle('extensions-chrome-list', () => scanChromeInstalledExtensions().map(({ path: _path, ...extension }) => extension));
ipcMain.handle('extensions-chrome-path', (_event, extensionId) => {
  if (typeof extensionId !== 'string') return null;
  const extensionPath = chromeExtensionCandidates.get(extensionId);
  return extensionPath && fs.existsSync(path.join(extensionPath, 'manifest.json')) ? extensionPath : null;
});

function parseAdultBlocklist(contents) {
  const domains = new Set();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    for (const rawDomain of parts.slice(1)) {
      const domain = rawDomain.toLowerCase().replace(/\.$/, '');
      if (net.isIP(domain) || domain === 'localhost' || domain === 'localhost.localdomain' || domain.endsWith('.localhost') || domain.endsWith('.local')) continue;
      if (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
        domains.add(domain);
      }
    }
  }
  return domains;
}

function readAdultBlocklist(filePath) {
  try {
    const contents = fs.readFileSync(filePath, 'utf8');
    const domains = parseAdultBlocklist(contents);
    return domains.size >= 10000 ? { domains, contents } : null;
  } catch {
    return null;
  }
}

function downloadAdultBlocklist(url = ADULT_BLOCKLIST_URL, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'ChatTarayici/1.0' }, timeout: 20000 }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirectsLeft > 0) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url);
        if (nextUrl.protocol !== 'https:') return reject(new Error('Blocklist yönlendirmesi HTTPS değil.'));
        return resolve(downloadAdultBlocklist(nextUrl.href, redirectsLeft - 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Blocklist HTTP ${response.statusCode}`));
      }

      const chunks = [];
      let byteLength = 0;
      response.on('data', (chunk) => {
        byteLength += chunk.length;
        if (byteLength > ADULT_BLOCKLIST_MAX_BYTES) {
          request.destroy(new Error('Blocklist boyut sınırını aştı.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Blocklist bağlantısı zaman aşımına uğradı.')));
    request.on('error', reject);
  });
}

async function refreshAdultBlocklist() {
  try {
    const contents = await downloadAdultBlocklist();
    const domains = parseAdultBlocklist(contents);
    if (domains.size < 10000) throw new Error('Blocklist beklenenden az alan adı içeriyor.');

    const { cache } = adultProtectionPaths();
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, contents);
    adultBlockDomains = domains;
    adultBlocklistUpdatedAt = new Date().toISOString();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('adult-protection-status', getAdultProtectionStatus());
    }
  } catch (error) {
    console.warn('Could not refresh adult blocklist:', error.message);
  }
}

function matchesBlockedDomain(hostname, domains) {
  let current = hostname.toLowerCase().replace(/\.$/, '');
  while (current) {
    if (domains.has(current)) return true;
    const dot = current.indexOf('.');
    if (dot < 0) break;
    current = current.slice(dot + 1);
  }
  return false;
}

function shouldBlockAd(url) {
  try {
    const parsed = new URL(url);
    if (matchesBlockedDomain(parsed.hostname, adBlockDomains)) return true;
    const host = parsed.hostname.toLowerCase();
    return (host === 'facebook.com' || host.endsWith('.facebook.com')) && parsed.pathname.startsWith('/tr');
  } catch {
    return false;
  }
}

function setupContentBlocking(targetSession) {
  targetSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      let adultBlocked = false;
      try {
        const hostname = new URL(details.url).hostname;
        adultBlocked = adultProtectionEnabled && matchesBlockedDomain(hostname, adultBlockDomains);
      } catch {}

      const adBlocked = shouldBlockAd(details.url);
      if (adultBlocked && details.resourceType === 'mainFrame' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('adult-site-blocked', {
          webContentsId: details.webContentsId,
          url: details.url
        });
      }
      callback({ cancel: adultBlocked || adBlocked });
    }
  );
}

function initializeContentProtection() {
  loadAdultProtectionSettings();
  const paths = adultProtectionPaths();
  const cached = readAdultBlocklist(paths.cache);
  const bundled = readAdultBlocklist(path.join(__dirname, 'data', 'adult-sites-hosts.txt'));
  const selected = cached || bundled;
  if (selected) {
    adultBlockDomains = selected.domains;
    try {
      adultBlocklistUpdatedAt = fs.statSync(cached ? paths.cache : path.join(__dirname, 'data', 'adult-sites-hosts.txt')).mtime.toISOString();
    } catch {}
    if (!cached && bundled) {
      try {
        fs.mkdirSync(path.dirname(paths.cache), { recursive: true });
        fs.writeFileSync(paths.cache, bundled.contents);
      } catch (error) {
        console.warn('Could not cache bundled adult blocklist:', error.message);
      }
    }
  }

  try {
    setupContentBlocking(session.defaultSession);
  } catch (error) {
    console.warn('Could not initialize content filtering:', error.message);
  }
  try {
    setupContentBlocking(session.fromPartition('incognito'));
  } catch (error) {
    console.warn('Could not initialize private-session filtering:', error.message);
  }

  let cacheIsStale = !cached;
  if (cached) {
    try {
      cacheIsStale = Date.now() - fs.statSync(paths.cache).mtimeMs > ADULT_BLOCKLIST_REFRESH_MS;
    } catch {
      cacheIsStale = true;
    }
  }
  const shouldRefresh = !cached || cacheIsStale;
  if (shouldRefresh) refreshAdultBlocklist();
  const refreshTimer = setInterval(() => refreshAdultBlocklist(), ADULT_BLOCKLIST_REFRESH_MS);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

ipcMain.on('adult-protection-get', (event) => {
  event.returnValue = getAdultProtectionStatus();
});

ipcMain.handle('adult-protection-set', (_event, enabled) => {
  adultProtectionEnabled = Boolean(enabled);
  saveAdultProtectionSettings();
  return getAdultProtectionStatus();
});

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

app.whenReady().then(() => {
  initializeContentProtection();
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
