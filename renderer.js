const { ipcRenderer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const APP_VERSION = require('./package.json').version;
const ExtensionManager = require('./extension-manager');
const CentralUpdater = require('./updater');

// ===== State Management =====
let tabs = [];
let activeTabId = null;
let tabIdCounter = 0;
let bookmarks = loadStoredArray('bookmarks');
let history = loadStoredArray('browsingHistory').filter(entry => isHistoryWebUrl(entry.url));
const historyPageTabIds = new Set();
let zoomLevels = {};
const audioBoostDefaults = {
  level: Number(localStorage.getItem('audioBoostLevel') || 100),
  bass: localStorage.getItem('audioBassBoost') === 'true',
  voice: localStorage.getItem('audioVoiceBoost') === 'true'
};
if (!Number.isFinite(audioBoostDefaults.level)) audioBoostDefaults.level = 100;
audioBoostDefaults.level = Math.min(600, Math.max(100, audioBoostDefaults.level));
const audioBoostSettingsByTab = new Map();
let audioBoostApplyTimer = null;

const DEFAULT_HOME = 'about:newtab';
const SEARCH_ENGINE = 'https://www.google.com/search?q=';

// ===== Extensions & Central Updater =====
const extensionsDir = ipcRenderer.sendSync('extensions-get-directory');
const extensionManager = new ExtensionManager(extensionsDir);
const extensionRuntimeInfo = ipcRenderer.sendSync('extensions-get-runtime-info') || {};
const nativeExtensionUrls = new Map(extensionRuntimeInfo.loaded || []);
const extensionRuntimeErrors = new Map(extensionRuntimeInfo.errors || []);
const pendingNativeExtensionLoads = new Set();
let activePopupExtensionId = null;
let extensionPopupBridgePollTimer = null;
let adultProtectionState = ipcRenderer.sendSync('adult-protection-get') || { enabled: true, domainCount: 0, updatedAt: null };
const blockedPageByWebview = new WeakMap();

const updater = new CentralUpdater({
  appRoot: __dirname,
  configPath: path.join(path.dirname(extensionsDir), 'update-config.json')
});

ipcRenderer.on('github-update-status', (_event, status) => {
  if (!status || !status.message) return;
  setUpdateStatus(status.message, Boolean(status.isError));
  setStatusText(status.message);
});

ipcRenderer.on('adult-protection-status', (_event, status) => {
  adultProtectionState = status || adultProtectionState;
  renderAdultProtectionSettings();
});

ipcRenderer.on('adult-site-blocked', (_event, details) => {
  if (!details || !details.url || typeof details.webContentsId !== 'number') return;
  document.querySelectorAll('#webview-container webview').forEach((webview) => {
    try {
      if (webview.getWebContentsId() === details.webContentsId) {
        showAdultBlockedPage(webview, details.url);
      }
    } catch {}
  });
});

// ===== Window Controls =====
function windowAction(action) {
  ipcRenderer.send(`window-${action}`);
}

ipcRenderer.on('window-maximized', (event, isMaximized) => {
  const icon = document.querySelector('#btn-maximize i');
  if (icon) {
    icon.className = isMaximized ? 'far fa-clone' : 'far fa-square';
  }
});

// ===== Tab Management =====
function createNewTab(url = null, incognito = false) {
  const tabId = `tab-${++tabIdCounter}`;
  audioBoostSettingsByTab.set(tabId, { ...audioBoostDefaults });

  const tab = {
    id: tabId,
    url: url || DEFAULT_HOME,
    title: 'Yeni Sekme',
    favicon: null,
    incognito: incognito,
    canGoBack: false,
    canGoForward: false
  };

  tabs.push(tab);

  // Tab DOM Element
  const tabEl = document.createElement('div');
  tabEl.className = `tab${incognito ? ' incognito' : ''}`;
  tabEl.id = tabId;
  tabEl.onclick = (e) => {
    if (!e.target.closest('.tab-close')) {
      switchTab(tabId);
    }
  };
  tabEl.onmousedown = (e) => {
    if (e.button === 1) { // Middle click closes tab
      e.preventDefault();
      closeTab(tabId);
    }
  };

  tabEl.innerHTML = `
    <div class="tab-favicon-default"><i class="fas fa-globe"></i></div>
    <span class="tab-title">Yeni Sekme</span>
    <button class="tab-close" onclick="closeTab('${tabId}')"><i class="fas fa-xmark"></i></button>
  `;

  document.getElementById('tabs-container').appendChild(tabEl);

  // Create webview
  if (url && url !== DEFAULT_HOME) {
    createWebview(tabId, url, incognito);
  }

  switchTab(tabId);
  closeMenu();
  return tabId;
}

function createWebview(tabId, url, incognito = false) {
  const container = document.getElementById('webview-container');

  const existing = container.querySelector(`webview[data-tab="${tabId}"]`);
  if (existing) existing.remove();

  const webview = document.createElement('webview');
  webview.setAttribute('data-tab', tabId);
  webview.setAttribute('autosize', 'on');
  if (incognito) {
    webview.setAttribute('partition', 'incognito');
  }

  webview.setAttribute('allowpopups', '');
  webview.setAttribute('disableblinkfeatures', 'AutomationControlled');

  container.appendChild(webview);

  // Webview lifecycle events
  webview.addEventListener('did-start-loading', () => {
    showLoading(true);
    updateRefreshButton(true);
  });

  webview.addEventListener('did-stop-loading', () => {
    showLoading(false);
    updateRefreshButton(false);
  });

  // Inject content scripts safely ONLY after finish-load
  webview.addEventListener('did-finish-load', () => {
    injectExtensionScripts(webview);
    applyAudioBoost(webview);
  });

  webview.addEventListener('will-navigate', (e) => {
    if (isHistoryWebUrl(e.url)) {
      historyPageTabIds.delete(tabId);
    }
  });

  webview.addEventListener('did-navigate', (e) => {
    if (e.url.startsWith('about:blank#clear-history')) {
      clearBrowsingHistory(false);
      historyPageTabIds.add(tabId);
      webview.loadURL(getHistoryPageUrl()).catch(() => {});
      return;
    }
    if (isHistoryPageUrl(e.url)) historyPageTabIds.add(tabId);
    const blockedPage = blockedPageByWebview.get(webview);
    if (blockedPage && e.url === blockedPage.pageUrl) {
      updateTabInfo(tabId, { url: blockedPage.url, title: 'Erişim engellendi' });
      if (tabId === activeTabId) {
        updateUrlBar(blockedPage.url);
        updateNavButtons(tabId);
      }
      return;
    }
    updateTabInfo(tabId, { url: e.url });
    if (tabId === activeTabId) {
      updateUrlBar(e.url);
      updateNavButtons(tabId);
    }
    if (!incognito) {
      addToHistory(e.url, getTabTitle(tabId));
    }
  });

  webview.addEventListener('did-navigate-in-page', (e) => {
    if (e.isMainFrame) {
      updateTabInfo(tabId, { url: e.url });
      if (tabId === activeTabId) {
        updateUrlBar(e.url);
        updateNavButtons(tabId);
      }
    }
  });

  webview.addEventListener('page-title-updated', (e) => {
    updateTabInfo(tabId, { title: e.title });
    if (!incognito) {
      updateHistoryTitle(webview.getURL(), e.title);
    }
  });

  webview.addEventListener('page-favicon-updated', (e) => {
    if (e.favicons && e.favicons.length > 0) {
      updateTabFavicon(tabId, e.favicons[0]);
    }
  });

  webview.addEventListener('did-fail-load', (e) => {
    if (e.errorCode !== -3) { // -3 is aborted, ignore
      showLoading(false);
      setStatusText(`Hata: ${e.errorDescription}`);
    }
  });

  webview.addEventListener('new-window', (e) => {
    createNewTab(e.url);
  });

  webview.addEventListener('update-target-url', (e) => {
    setStatusText(e.url || '');
  });

  // Attach listeners before navigation so the first page load can receive extensions.
  webview.setAttribute('src', url);
  return webview;
}

// ===== SAFE EXTENSION INJECTION =====
function injectExtensionScripts(webview) {
  try {
    const currentUrl = webview.getURL();
    // Only inject on real HTTP/HTTPS websites, avoid about:, data:, chrome:, etc.
    if (!currentUrl || (!currentUrl.startsWith('http://') && !currentUrl.startsWith('https://'))) {
      return;
    }

    const scriptEntries = extensionManager.getContentScripts(currentUrl);
    for (const entry of scriptEntries) {
      // Electron's native extension loader handles these content scripts and APIs.
      if (nativeExtensionUrls.has(entry.extensionId)) continue;

      // Safe CSS injection
      for (const css of entry.css) {
        if (css && css.trim()) {
          webview.insertCSS(css).catch(() => {});
        }
      }
      // Safe JS injection wrapped in try/catch to avoid guest view manager crashes
      for (const js of entry.js) {
        if (js && js.trim()) {
          const safeWrapper = `(function() { try { ${js} } catch(e) { console.warn('Eklenti çalıştırma:', e); } })();`;
          webview.executeJavaScript(safeWrapper).catch(() => {});
        }
      }
    }
  } catch (err) {
    // Suppress injection errors
  }
}

function getAudioBoostSettings(tabId) {
  return { ...(audioBoostSettingsByTab.get(tabId) || audioBoostDefaults) };
}

function getAudioBoostScript(settings) {
  const payload = JSON.stringify({
    gain: settings.level / 100,
    bass: settings.bass,
    voice: settings.voice
  });
  return `(() => {
    const settings = ${payload};
    let state = window.__chatTarayiciAudioBoostState;
    if (!state) {
      state = window.__chatTarayiciAudioBoostState = { context: null, items: new Map(), observer: null, settings };
      state.scan = () => {
        const enabled = state.settings.gain > 1 || state.settings.bass || state.settings.voice;
        if (!enabled && state.items.size === 0) return { attached: 0, skipped: 0 };
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return { attached: 0, skipped: 0 };
        if (state.context && state.context.state === 'suspended') state.context.resume().catch(() => {});
        const elements = document.querySelectorAll('audio, video');
        let skipped = 0;
        for (const media of elements) {
          let nodes = state.items.get(media);
          if (!nodes) {
            if (!enabled) continue;
            const sourceUrl = media.currentSrc || media.src;
            if (!sourceUrl) continue;
            let parsedUrl;
            try { parsedUrl = new URL(sourceUrl, location.href); } catch { continue; }
            const hasCorsMode = Boolean(media.crossOrigin) || media.hasAttribute('crossorigin');
            if (parsedUrl.origin !== location.origin && !hasCorsMode) { skipped++; continue; }
            try {
              state.context = state.context || new AudioContextClass();
              if (state.context.state === 'suspended') state.context.resume().catch(() => {});
              const source = state.context.createMediaElementSource(media);
              const bass = state.context.createBiquadFilter();
              bass.type = 'lowshelf';
              bass.frequency.value = 140;
              const voice = state.context.createBiquadFilter();
              voice.type = 'peaking';
              voice.frequency.value = 2800;
              voice.Q.value = 0.9;
              const gain = state.context.createGain();
              const limiter = state.context.createDynamicsCompressor();
              limiter.threshold.value = -4;
              limiter.knee.value = 8;
              limiter.ratio.value = 4;
              limiter.attack.value = 0.004;
              limiter.release.value = 0.22;
              source.connect(bass);
              bass.connect(voice);
              voice.connect(gain);
              gain.connect(limiter);
              limiter.connect(state.context.destination);
              nodes = { source, bass, voice, gain, limiter };
              state.items.set(media, nodes);
              media.addEventListener('play', () => state.context && state.context.resume().catch(() => {}));
            } catch {
              skipped++;
              continue;
            }
          }
          nodes.bass.gain.setTargetAtTime(state.settings.bass ? 5 : 0, state.context.currentTime, 0.08);
          nodes.voice.gain.setTargetAtTime(state.settings.voice ? 4 : 0, state.context.currentTime, 0.08);
          nodes.gain.gain.setTargetAtTime(state.settings.gain, state.context.currentTime, 0.08);
        }
        for (const [media, nodes] of state.items) {
          if (!media.isConnected) {
            try { nodes.source.disconnect(); } catch {}
            try { nodes.bass.disconnect(); } catch {}
            try { nodes.voice.disconnect(); } catch {}
            try { nodes.gain.disconnect(); } catch {}
            try { nodes.limiter.disconnect(); } catch {}
            state.items.delete(media);
          }
        }
        return { attached: state.items.size, skipped };
      };
      state.observer = new MutationObserver(() => {
        clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(() => state.scan(), 120);
      });
      if (document.documentElement) state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'crossorigin'] });
      document.addEventListener('play', () => state.scan(), true);
      document.addEventListener('loadedmetadata', () => state.scan(), true);
    }
    state.settings = settings;
    return state.scan();
  })()`;
}

function applyAudioBoost(webview) {
  if (!webview) return Promise.resolve(null);
  const tabId = webview.getAttribute('data-tab');
  const settings = getAudioBoostSettings(tabId);
  return webview.executeJavaScript(getAudioBoostScript(settings), true).then(result => {
    const note = document.getElementById('audio-boost-note');
    if (note && webview === getActiveWebview() && (settings.level > 100 || settings.bass || settings.voice)) {
      if (result && result.attached === 0 && result.skipped > 0) {
        note.textContent = 'Bu sitenin medya kaynağı ses yükseltmeye izin vermiyor. Normal ses oynatımı etkilenmez.';
      } else if (result && result.attached === 0) {
        note.textContent = 'Sayfada bir video veya ses oynatılınca yükseltme uygulanır.';
      } else {
        note.textContent = 'Ses çok açıldığında bozulma olabilir.';
      }
    }
    return result;
  }).catch(() => null);
}

function applyAudioBoostToActiveTab() {
  if (audioBoostApplyTimer) clearTimeout(audioBoostApplyTimer);
  audioBoostApplyTimer = setTimeout(() => applyAudioBoost(getActiveWebview()), 80);
}

function syncAudioBoostControls() {
  const slider = document.getElementById('audio-boost-level');
  const value = document.getElementById('audio-boost-value');
  const bass = document.getElementById('audio-bass-boost');
  const voice = document.getElementById('audio-voice-boost');
  const button = document.getElementById('audio-boost-btn');
  const note = document.getElementById('audio-boost-note');
  const settings = getAudioBoostSettings(activeTabId);
  const enabled = settings.level > 100 || settings.bass || settings.voice;
  if (slider) slider.value = String(settings.level);
  if (value) value.textContent = `${settings.level}%`;
  if (bass) bass.classList.toggle('active', settings.bass);
  if (voice) voice.classList.toggle('active', settings.voice);
  if (button) button.classList.toggle('active', enabled);
  if (note && !enabled) note.textContent = 'Ses çok açıldığında bozulma olabilir. Bazı sitelerin medya güvenliği yükseltmeyi engelleyebilir.';
}

function toggleAudioBoostPanel() {
  closeMenu();
  closeExtensionsDropdown();
  const panel = document.getElementById('audio-boost-popover');
  const button = document.getElementById('audio-boost-btn');
  if (!panel) return;
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  if (button) button.setAttribute('aria-expanded', String(opening));
  syncAudioBoostControls();
}

function closeAudioBoostPanel() {
  const panel = document.getElementById('audio-boost-popover');
  const button = document.getElementById('audio-boost-btn');
  if (panel) panel.classList.add('hidden');
  if (button) button.setAttribute('aria-expanded', 'false');
}

function setAudioBoostLevel(value) {
  const nextValue = Number(value);
  if (!Number.isFinite(nextValue)) return;
  updateAudioBoostSettings({ level: Math.min(600, Math.max(100, nextValue)) });
}

function toggleAudioBassBoost() {
  updateAudioBoostSettings({ bass: !getAudioBoostSettings(activeTabId).bass });
}

function toggleAudioVoiceBoost() {
  updateAudioBoostSettings({ voice: !getAudioBoostSettings(activeTabId).voice });
}

function updateAudioBoostSettings(changes) {
  const settings = { ...getAudioBoostSettings(activeTabId), ...changes };
  if (activeTabId) audioBoostSettingsByTab.set(activeTabId, settings);
  const activeTab = tabs.find(tab => tab.id === activeTabId);
  if (!activeTab || !activeTab.incognito) {
    Object.assign(audioBoostDefaults, settings);
    localStorage.setItem('audioBoostLevel', String(audioBoostDefaults.level));
    localStorage.setItem('audioBassBoost', String(audioBoostDefaults.bass));
    localStorage.setItem('audioVoiceBoost', String(audioBoostDefaults.voice));
  }
  syncAudioBoostControls();
  applyAudioBoostToActiveTab();
}

function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('#webview-container webview').forEach(w => w.classList.remove('active'));

  const tabEl = document.getElementById(tabId);
  if (tabEl) tabEl.classList.add('active');

  const webview = document.querySelector(`webview[data-tab="${tabId}"]`);
  const ntpPage = document.getElementById('new-tab-page');
  const tab = tabs.find(t => t.id === tabId);

  if (webview) {
    webview.classList.add('active');
    ntpPage.classList.add('hidden');
    updateUrlBar(tab ? tab.url : '');
    updateNavButtons(tabId);
  } else {
    ntpPage.classList.remove('hidden');
    document.querySelectorAll('#webview-container webview').forEach(w => w.classList.remove('active'));
    document.getElementById('url-input').value = '';
    updateSecurityIcon('');
    setTimeout(() => {
      const searchInput = document.getElementById('ntp-search-input');
      if (searchInput) searchInput.focus();
    }, 100);
  }

  activeTabId = tabId;
  syncAudioBoostControls();
  if (webview) applyAudioBoost(webview);
  updateZoomDisplay(tabId);

  if (tabEl) {
    tabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
}

function closeTab(tabId) {
  const index = tabs.findIndex(t => t.id === tabId);
  if (index === -1) return;

  const tabEl = document.getElementById(tabId);
  if (tabEl) tabEl.remove();

  const webview = document.querySelector(`webview[data-tab="${tabId}"]`);
  if (webview) webview.remove();
  historyPageTabIds.delete(tabId);
  audioBoostSettingsByTab.delete(tabId);

  tabs.splice(index, 1);

  if (tabs.length === 0) {
    createNewTab();
    return;
  }

  if (activeTabId === tabId) {
    const newIndex = Math.min(index, tabs.length - 1);
    switchTab(tabs[newIndex].id);
  }
}

function updateTabInfo(tabId, info) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  if (info.url) tab.url = info.url;
  if (info.title) {
    tab.title = info.title;
    const titleEl = document.querySelector(`#${tabId} .tab-title`);
    if (titleEl) titleEl.textContent = info.title;
    if (tabId === activeTabId) {
      document.title = `${info.title} - ChatTarayıcı`;
    }
  }
}

function updateTabFavicon(tabId, faviconUrl) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  tab.favicon = faviconUrl;
  const tabEl = document.getElementById(tabId);
  if (!tabEl) return;

  const existingFavicon = tabEl.querySelector('.tab-favicon, .tab-favicon-default');
  if (existingFavicon) {
    const img = document.createElement('img');
    img.className = 'tab-favicon';
    img.src = faviconUrl;
    img.onerror = () => {
      img.replaceWith(createDefaultFavicon());
    };
    existingFavicon.replaceWith(img);
  }
}

function createDefaultFavicon() {
  const div = document.createElement('div');
  div.className = 'tab-favicon-default';
  div.innerHTML = '<i class="fas fa-globe"></i>';
  return div;
}

function getTabTitle(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  return tab ? tab.title : 'Yeni Sekme';
}

// ===== Navigation =====
function navigateTo(input, internalPage = null) {
  if (!input || !input.trim()) return;

  input = input.trim();
  let url = input;

  if (!input.includes('.') && !input.startsWith('http') && !input.startsWith('about:') && !input.startsWith('data:')) {
    url = SEARCH_ENGINE + encodeURIComponent(input);
  } else if (!input.startsWith('http://') && !input.startsWith('https://') && !input.startsWith('about:') && !input.startsWith('data:')) {
    url = 'https://' + input;
  }

  if (!activeTabId) {
    createNewTab(url);
    return;
  }

  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;
  if (internalPage === 'history') historyPageTabIds.add(activeTabId);
  else historyPageTabIds.delete(activeTabId);

  document.getElementById('new-tab-page').classList.add('hidden');

  let webview = document.querySelector(`webview[data-tab="${activeTabId}"]`);
  if (!webview) {
    webview = createWebview(activeTabId, url, tab.incognito);
    webview.classList.add('active');
  } else {
    blockedPageByWebview.delete(webview);
    webview.loadURL(url);
  }

  tab.url = url;
  updateUrlBar(url);
  closeMenu();
}

function searchFromNTP(query) {
  if (!query || !query.trim()) return;
  navigateTo(query);
}

function updateNtpClock() {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 5 ? 'İyi geceler' : hour < 12 ? 'Günaydın' : hour < 18 ? 'İyi günler' : 'İyi akşamlar';
  const greetingEl = document.getElementById('ntp-greeting');
  const dateEl = document.getElementById('ntp-date');
  const clockEl = document.getElementById('ntp-clock');

  if (greetingEl) greetingEl.textContent = greeting;
  if (dateEl) {
    dateEl.textContent = new Intl.DateTimeFormat('tr-TR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    }).format(now);
  }
  if (clockEl) {
    clockEl.textContent = new Intl.DateTimeFormat('tr-TR', {
      hour: '2-digit', minute: '2-digit'
    }).format(now);
  }
}

function renderNtpRecents() {
  const grid = document.getElementById('ntp-recent-grid');
  const empty = document.getElementById('ntp-recent-empty');
  if (!grid || !empty) return;

  const recentSites = [];
  const seenHosts = new Set();
  const newestFirst = [...history].sort((a, b) => (Number(b.visitedAt) || 0) - (Number(a.visitedAt) || 0));
  for (const entry of newestFirst) {
    const safeUrl = safeWebUrl(entry.url);
    if (!safeUrl) continue;
    let parsed;
    try { parsed = new URL(safeUrl); } catch { continue; }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    recentSites.push({ url: safeUrl, host, title: entry.title || host });
    if (recentSites.length >= 4) break;
  }

  grid.replaceChildren();
  for (const site of recentSites) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'ntp-recent-card';
    card.setAttribute('aria-label', `${site.title} — ${site.host} adresini aç`);
    card.onclick = () => navigateTo(site.url);

    let hue = 0;
    for (const char of site.host) hue = (hue * 31 + char.charCodeAt(0)) % 360;
    card.style.setProperty('--site-hue', String(hue));

    const favicon = document.createElement('span');
    favicon.className = 'ntp-recent-favicon';
    favicon.setAttribute('aria-hidden', 'true');
    favicon.textContent = site.host.charAt(0);

    const copy = document.createElement('span');
    copy.className = 'ntp-recent-copy';
    const title = document.createElement('strong');
    title.textContent = site.title;
    const host = document.createElement('span');
    host.textContent = site.host;
    copy.append(title, host);

    const openIcon = document.createElement('i');
    openIcon.className = 'fas fa-arrow-up-right-from-square ntp-recent-open';
    openIcon.setAttribute('aria-hidden', 'true');
    card.append(favicon, copy, openIcon);
    grid.appendChild(card);
  }

  const hasRecentSites = recentSites.length > 0;
  grid.classList.toggle('hidden', !hasRecentSites);
  empty.classList.toggle('hidden', hasRecentSites);
}

function goBack() {
  const webview = getActiveWebview();
  if (webview && webview.canGoBack()) {
    webview.goBack();
  }
}

function goForward() {
  const webview = getActiveWebview();
  if (webview && webview.canGoForward()) {
    webview.goForward();
  }
}

function refreshPage() {
  const webview = getActiveWebview();
  if (webview) {
    if (webview.isLoading()) {
      webview.stop();
    } else {
      webview.reload();
    }
  }
}

function goHome() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;

  const webview = document.querySelector(`webview[data-tab="${activeTabId}"]`);
  if (webview) {
    webview.classList.remove('active');
  }

  document.getElementById('new-tab-page').classList.remove('hidden');
  document.getElementById('url-input').value = '';
  tab.url = DEFAULT_HOME;
  tab.title = 'Yeni Sekme';

  const titleEl = document.querySelector(`#${activeTabId} .tab-title`);
  if (titleEl) titleEl.textContent = 'Yeni Sekme';

  setTimeout(() => {
    const searchInput = document.getElementById('ntp-search-input');
    if (searchInput) searchInput.focus();
  }, 100);
}

function getActiveWebview() {
  if (!activeTabId) return null;
  return document.querySelector(`webview[data-tab="${activeTabId}"]`);
}

// ===== URL Bar Updates =====
function updateUrlBar(url) {
  const input = document.getElementById('url-input');
  if (url && url !== DEFAULT_HOME && !url.startsWith('data:')) {
    input.value = url;
  } else {
    input.value = '';
  }
  updateSecurityIcon(url);
}

function updateSecurityIcon(url) {
  const icon = document.getElementById('lock-icon');
  const container = document.getElementById('security-icon');

  if (!url || url === DEFAULT_HOME) {
    icon.className = 'fas fa-search';
    container.classList.remove('insecure');
  } else if (url.startsWith('https://')) {
    icon.className = 'fas fa-lock';
    container.classList.remove('insecure');
  } else {
    icon.className = 'fas fa-lock-open';
    container.classList.add('insecure');
  }
}

function updateNavButtons(tabId) {
  const webview = document.querySelector(`webview[data-tab="${tabId}"]`);
  if (!webview) return;

  setTimeout(() => {
    document.getElementById('btn-back').disabled = !webview.canGoBack();
    document.getElementById('btn-forward').disabled = !webview.canGoForward();
  }, 100);
}

function updateRefreshButton(isLoading) {
  const icon = document.querySelector('#btn-refresh i');
  if (icon) {
    icon.className = isLoading ? 'fas fa-xmark' : 'fas fa-rotate-right';
  }
}

// ===== Loading Bar & Status =====
function showLoading(show) {
  const bar = document.getElementById('loading-bar');
  if (bar) {
    if (show) bar.classList.remove('hidden');
    else bar.classList.add('hidden');
  }
}

function setStatusText(text) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = text;
}

// ===== Zoom =====
function zoomIn() {
  const webview = getActiveWebview();
  if (!webview) return;
  const level = (zoomLevels[activeTabId] || 1) + 0.1;
  zoomLevels[activeTabId] = Math.min(level, 3);
  webview.setZoomFactor(zoomLevels[activeTabId]);
  updateZoomDisplay(activeTabId);
  closeMenu();
}

function zoomOut() {
  const webview = getActiveWebview();
  if (!webview) return;
  const level = (zoomLevels[activeTabId] || 1) - 0.1;
  zoomLevels[activeTabId] = Math.max(level, 0.3);
  webview.setZoomFactor(zoomLevels[activeTabId]);
  updateZoomDisplay(activeTabId);
  closeMenu();
}

function resetZoom() {
  const webview = getActiveWebview();
  if (!webview) return;
  zoomLevels[activeTabId] = 1;
  webview.setZoomFactor(1);
  updateZoomDisplay(activeTabId);
  closeMenu();
}

function updateZoomDisplay(tabId) {
  const level = zoomLevels[tabId] || 1;
  const el = document.getElementById('zoom-level');
  if (el) el.textContent = `%${Math.round(level * 100)}`;
}

// ===== Bookmarks =====
function toggleBookmark() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.url === DEFAULT_HOME) return;

  const existingIndex = bookmarks.findIndex(b => b.url === tab.url);
  const icon = document.getElementById('bookmark-icon');

  if (existingIndex >= 0) {
    bookmarks.splice(existingIndex, 1);
    icon.className = 'far fa-star';
  } else {
    bookmarks.push({
      title: tab.title,
      url: tab.url,
      favicon: tab.favicon,
      addedAt: Date.now()
    });
    icon.className = 'fas fa-star';
    icon.style.color = '#fbbf24';
    setTimeout(() => { icon.style.color = ''; }, 500);
  }

  localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
  renderBookmarks();
}

function renderBookmarks() {
  const list = document.getElementById('bookmarks-list');
  if (!list) return;
  list.innerHTML = '';

  bookmarks.forEach((bm, index) => {
    const item = document.createElement('div');
    item.className = 'bookmark-item';
    if (isSafeNavigationUrl(bm.url)) {
      item.onclick = () => navigateTo(bm.url);
    }
    item.oncontextmenu = (e) => {
      e.preventDefault();
      if (confirm(`"${bm.title}" yer işaretini silmek istiyor musun?`)) {
        bookmarks.splice(index, 1);
        localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
        renderBookmarks();
      }
    };

    const faviconUrl = safeFaviconUrl(bm.favicon);
    if (faviconUrl) {
      const favicon = document.createElement('img');
      favicon.src = faviconUrl;
      favicon.alt = '';
      favicon.onerror = () => favicon.replaceWith(document.createTextNode('🔖'));
      item.appendChild(favicon);
    } else {
      item.appendChild(document.createTextNode('🔖'));
    }

    const title = document.createElement('span');
    title.textContent = typeof bm.title === 'string' && bm.title ? bm.title : bm.url;
    item.appendChild(title);
    list.appendChild(item);
  });

  const tab = tabs.find(t => t.id === activeTabId);
  const icon = document.getElementById('bookmark-icon');
  if (icon) {
    if (tab && bookmarks.some(b => b.url === tab.url)) {
      icon.className = 'fas fa-star';
    } else {
      icon.className = 'far fa-star';
    }
  }
}

function showBookmarksManager() {
  closeMenu();
  let content = '<h2>Yer İşaretleri</h2><ul>';
  bookmarks.forEach(bm => {
    const title = escapeHtml(typeof bm.title === 'string' && bm.title ? bm.title : bm.url);
    const url = safeWebUrl(bm.url);
    content += `<li>${url ? `<a href="${escapeHtml(url)}">${title}</a>` : title}</li>`;
  });
  content += '</ul>';

  const webview = getActiveWebview();
  if (webview) {
    const html = `<html><head><meta charset="utf-8"><style>
        body { font-family: Inter, sans-serif; background: #0f0f1a; color: #e8e8f0; padding: 40px; }
        h2 { color: #6c63ff; margin-bottom: 20px; }
        ul { list-style: none; padding: 0; }
        li { padding: 12px 16px; border-bottom: 1px solid rgba(108,99,255,0.15); }
        a { color: #a855f7; text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style></head><body>${content}</body></html>`;
    webview.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }
}

// ===== History =====
function isHistoryWebUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isHistoryPageUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('data:text/html;charset=utf-8,')) return false;
  try {
    const html = decodeURIComponent(url.slice(url.indexOf(',') + 1));
    return html.includes('Tarayıcı Geçmişi') && html.includes('Geçmişi temizle');
  } catch {
    return false;
  }
}

function addToHistory(url, title) {
  if (!isHistoryWebUrl(url)) return;
  history.unshift({
    url,
    title: title || url,
    visitedAt: Date.now()
  });

  if (history.length > 500) history = history.slice(0, 500);
  localStorage.setItem('browsingHistory', JSON.stringify(history));
  renderNtpRecents();
}

function updateHistoryTitle(url, title) {
  if (!isHistoryWebUrl(url)) return;
  const entry = history.find(h => h.url === url);
  if (entry) entry.title = title;
  localStorage.setItem('browsingHistory', JSON.stringify(history));
  renderNtpRecents();
}

function getHistoryPageUrl() {
  let content = '<h2>Tarayıcı Geçmişi</h2><ul>';
  history.slice(0, 100).forEach(h => {
    const date = new Date(h.visitedAt).toLocaleString('tr-TR');
    const title = escapeHtml(typeof h.title === 'string' && h.title ? h.title : h.url);
    const url = safeWebUrl(h.url);
    content += `<li>${url ? `<a href="${escapeHtml(url)}">${title}</a>` : `<span>${title}</span>`}<span class="date">${escapeHtml(date)}</span></li>`;
  });
  content += '</ul>';
  if (!history.length) content = '<h2>Tarayıcı Geçmişi</h2><p class="empty">Henüz kayıtlı geçmiş yok.</p>';

  const html = `<html><head><meta charset="utf-8"><style>
      body { font-family: Inter, sans-serif; background: #0f0f1a; color: #e8e8f0; padding: 40px; max-width: 800px; margin: 0 auto; }
      .heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:20px; }
      h2 { color: #6c63ff; margin: 0; font-size: 24px; }
      ul { list-style: none; padding: 0; }
      li { padding: 12px 16px; border-bottom: 1px solid rgba(108,99,255,0.15); display: flex; justify-content: space-between; align-items: center; }
      a { color: #a855f7; text-decoration: none; flex: 1; }
      a:hover { text-decoration: underline; }
      .date { color: #6b7280; font-size: 12px; flex-shrink: 0; margin-left: 16px; }
      .clear { color:#fff; background:#d94b61; border:0; border-radius:8px; padding:9px 13px; font-size:12px; cursor:pointer; text-decoration:none; }
      .empty { color:#9ca3af; padding:20px 0; }
    </style></head><body><div class="heading">${content.startsWith('<h2>') ? content.slice(0, content.indexOf('</h2>') + 5) : ''}<a class="clear" href="about:blank#clear-history">Geçmişi temizle</a></div>${content.startsWith('<h2>') ? content.slice(content.indexOf('</h2>') + 5) : content}</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showHistory() {
  closeMenu();
  navigateTo(getHistoryPageUrl(), 'history');
}

function clearBrowsingHistory(refreshHistoryTabs = true) {
  if (!confirm('Tarayıcı geçmişini tamamen silmek istiyor musun?')) return;
  history = [];
  localStorage.setItem('browsingHistory', '[]');
  renderNtpRecents();
  if (refreshHistoryTabs) {
    for (const tabId of historyPageTabIds) {
      const webview = document.querySelector(`webview[data-tab="${tabId}"]`);
      if (webview) webview.loadURL(getHistoryPageUrl()).catch(() => {});
    }
  }
  closeMenu();
  setStatusText('Tarayıcı geçmişi temizlendi');
}

// ===== Developer Tools =====
function toggleDevTools() {
  const webview = getActiveWebview();
  if (webview) {
    if (webview.isDevToolsOpened()) {
      webview.closeDevTools();
    } else {
      webview.openDevTools();
    }
  }
  closeMenu();
}

// ===== Settings =====
function showSettings() {
  closeMenu();
  navigateTo(`data:text/html;charset=utf-8,
    <html><head><style>
      body { font-family: Inter, sans-serif; background: #0f0f1a; color: #e8e8f0; padding: 40px; max-width: 600px; margin: 0 auto; }
      h2 { color: #6c63ff; margin-bottom: 30px; }
      .setting { padding: 16px 0; border-bottom: 1px solid rgba(108,99,255,0.15); }
      .setting label { display: block; font-weight: 500; margin-bottom: 4px; }
      .setting p { color: #6b7280; font-size: 13px; }
      .version { margin-top: 40px; color: #6b7280; font-size: 12px; text-align: center; }
    </style></head><body>
      <h2>⚙️ Ayarlar</h2>
      <div class="setting"><label>Sürüm</label><p>ChatTarayıcı v${APP_VERSION}</p></div>
      <div class="setting"><label>Motor</label><p>Chromium (Electron)</p></div>
      <div class="setting"><label>Eklenti Desteği</label><p>Chrome eklentileri kısmen desteklenir; Chrome Web Store'daki her eklenti çalışmayabilir.</p></div>
      <div class="setting"><label>Güncelleme</label><p>Uygulama açılışta GitHub'dan yeni sürümü kontrol eder ve varsa kurulumunu başlatır.</p></div>
      <div class="setting"><label>Reklam Engelleyici</label><p>Aktif ✅</p></div>
      <div class="setting"><label>Yetişkin İçerik Koruması</label><p>${adultProtectionState.enabled ? 'Açık ✅' : 'Kapalı'} · Ayarlar menüsünden yönetebilirsin.</p></div>
      <div class="version">ChatTarayıcı — Modern, hızlı ve tam donanımlı tarayıcınız</div>
    </body></html>
  `);
}

function showAdultBlockedPage(webview, blockedUrl) {
  let hostname = blockedUrl;
  try { hostname = new URL(blockedUrl).hostname; } catch {}
  const safeHost = escapeHtml(hostname);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Erişim engellendi</title><style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#e8eaf6;font:16px Inter,Segoe UI,sans-serif;padding:24px}.card{max-width:560px;padding:38px;border:1px solid #29314c;border-radius:20px;background:#141b2e;box-shadow:0 24px 80px #0008;text-align:center}.icon{font-size:44px;color:#a78bfa}.tag{display:inline-block;margin:20px 0 8px;padding:6px 11px;border-radius:999px;background:#30234a;color:#d8b4fe;font-size:12px;font-weight:700;letter-spacing:.06em}h1{font-size:25px;margin:8px 0 12px}p{color:#aab2ca;line-height:1.65;margin:10px 0}.domain{color:#f1f3ff;overflow-wrap:anywhere;font-weight:600}.hint{font-size:13px;margin-top:24px}
  </style></head><body><main class="card"><div class="icon">🛡️</div><div class="tag">AİLE KORUMASI</div><h1>Bu site engellendi</h1><p class="domain">${safeHost}</p><p>Bu adres, yetişkin içerik koruma listesindeki alan adları arasında.</p><p class="hint">Bu korumayı Ayarlar menüsündeki “Güvenlik ve +18 Koruması” bölümünden yönetebilirsin.</p></main></body></html>`;
  const pageUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  blockedPageByWebview.set(webview, { url: blockedUrl, pageUrl });
  webview.loadURL(pageUrl);
  setStatusText(`+18 koruması engelledi: ${hostname}`);
}

function openAdultProtectionSettings() {
  closeMenu();
  const modal = document.getElementById('security-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  renderAdultProtectionSettings();
}

function closeAdultProtectionSettings() {
  const modal = document.getElementById('security-modal');
  if (modal) modal.classList.add('hidden');
}

function renderAdultProtectionSettings() {
  const checkbox = document.getElementById('adult-protection-toggle');
  const status = document.getElementById('adult-protection-status-text');
  const updated = document.getElementById('adult-protection-updated');
  if (checkbox) checkbox.checked = Boolean(adultProtectionState.enabled);
  if (status) {
    const count = Number(adultProtectionState.domainCount) || 0;
    status.textContent = adultProtectionState.enabled
      ? `Açık · ${count.toLocaleString('tr-TR')} alan adı listede`
      : 'Kapalı';
  }
  if (updated) {
    updated.textContent = adultProtectionState.updatedAt
      ? `Liste güncellemesi: ${new Date(adultProtectionState.updatedAt).toLocaleString('tr-TR')}`
      : 'Liste henüz yükleniyor.';
  }
}

async function setAdultProtectionEnabled(enabled) {
  const checkbox = document.getElementById('adult-protection-toggle');
  if (checkbox) checkbox.disabled = true;
  try {
    adultProtectionState = await ipcRenderer.invoke('adult-protection-set', enabled);
    renderAdultProtectionSettings();
    setStatusText(enabled ? '+18 koruması açıldı' : '+18 koruması kapatıldı');
  } catch (error) {
    if (checkbox) checkbox.checked = !enabled;
    alert(`Koruma ayarı kaydedilemedi: ${error.message}`);
  } finally {
    if (checkbox) checkbox.disabled = false;
  }
}

const chromeStoreCatalog = [
  {
    id: 'aapbdbdomjkkjkaonfhkkikfgjllcleb',
    name: 'Google Translate',
    publisher: 'Google',
    category: 'Eğitim',
    description: 'Seçilen metinleri tarayıcıdan çevirmeyi kolaylaştırır.',
    icon: 'fa-language'
  },
  {
    id: 'mnjggcdmjocbbbhaepdhchncahnbgone',
    name: 'SponsorBlock',
    publisher: 'ajay.app',
    category: 'YouTube',
    description: 'YouTube videolarındaki toplulukça işaretlenmiş sponsorluk bölümlerini atlar.',
    icon: 'fa-forward-step'
  }
];
const installingStoreExtensionIds = new Set();

function openExtensionStore() {
  closeMenu();
  closeExtensionsDropdown();
  const modal = document.getElementById('extension-store-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const search = document.getElementById('chrome-store-search');
  if (search) search.value = '';
  renderExtensionStore();
  document.getElementById('chrome-import-list').classList.add('hidden');
}

function closeExtensionStore() {
  const modal = document.getElementById('extension-store-modal');
  if (modal) modal.classList.add('hidden');
}

function searchChromeStore() {
  const input = document.getElementById('chrome-store-search');
  const query = input ? input.value.trim() : '';
  renderExtensionStore(query);
}

async function installStoreExtension(extension, button) {
  if (!extension || installingStoreExtensionIds.has(extension.id)) return;
  extensionManager.scanExtensions();
  if (extensionManager.extensions.has(extension.id)) {
    setStatusText(`“${extension.name}” zaten yüklü`);
    return;
  }

  installingStoreExtensionIds.add(extension.id);
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> İndiriliyor…';
  }
  setStatusText(`“${extension.name}” indiriliyor…`);

  let download = null;
  try {
    download = await ipcRenderer.invoke('extension-store-download', extension.id);
    const extensionId = extensionManager.installFromFolder(download.sourcePath, extension.id);
    const runtime = await loadNativeExtensionForUi(extensionId);
    renderExtensionsList();
    reloadOpenWebviews();
    if (runtime && runtime.ok) {
      setStatusText(`“${extension.name}” uygulamaya kuruldu`);
    } else {
      alert(`“${extension.name}” kuruldu. Ancak Electron bu eklentinin kullandığı bazı Chrome özelliklerini desteklemiyor olabilir.\n\n${runtime?.error || 'Eklenti temel modda kullanılabilir.'}`);
    }
  } catch (error) {
    alert(`“${extension.name}” kurulamadı: ${error.message}`);
    setStatusText('Eklenti kurulamadı');
  } finally {
    if (download?.token) {
      try { await ipcRenderer.invoke('extension-store-download-cleanup', download.token); } catch {}
    }
    installingStoreExtensionIds.delete(extension.id);
    const input = document.getElementById('chrome-store-search');
    renderExtensionStore(input ? input.value.trim() : '');
  }
}

async function showChromeImports() {
  const section = document.getElementById('chrome-import-list');
  if (!section) return;
  section.classList.remove('hidden');
  section.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'store-import-empty';
  loading.textContent = 'Chrome profilleri taranıyor…';
  section.appendChild(loading);

  try {
    extensionManager.scanExtensions();
    const extensions = await ipcRenderer.invoke('extensions-chrome-list');
    const importable = extensions.filter(extension => !extensionManager.extensions.has(extension.id));
    section.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = 'Chrome’da yüklü eklentiler';
    section.appendChild(heading);
    if (!importable.length) {
      const empty = document.createElement('p');
      empty.className = 'store-import-empty';
      empty.textContent = extensions.length
        ? 'Chrome’da görünen eklentiler zaten ChatTarayıcı’ya aktarılmış.'
        : 'Chrome profili bulunamadı veya aktarılabilecek eklenti yok. Önce bir eklentiyi Chrome Web Store’dan Chrome’a kur.';
      section.appendChild(empty);
      return;
    }

    importable.forEach(extension => {
      const row = document.createElement('div');
      row.className = 'store-import-row';
      const details = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = extension.name;
      const meta = document.createElement('span');
      meta.textContent = `v${extension.version} · ${extension.profile}${extension.enabled ? '' : ' · Chrome’da kapalı'}`;
      details.append(name, meta);
      const button = document.createElement('button');
      button.className = 'btn-secondary';
      button.textContent = 'Aktar';
      button.onclick = () => importChromeExtension(extension);
      row.append(details, button);
      section.appendChild(row);
    });
  } catch (error) {
    section.replaceChildren();
    const message = document.createElement('p');
    message.className = 'store-import-empty';
    message.textContent = `Chrome eklentileri okunamadı: ${error.message}`;
    section.appendChild(message);
  }
}

async function importChromeExtension(extension) {
  try {
    const sourcePath = await ipcRenderer.invoke('extensions-chrome-path', extension.id);
    if (!sourcePath) throw new Error('Chrome’daki eklenti klasörü bulunamadı. Chrome’u kapatıp tekrar dene.');
    const extensionId = extensionManager.installFromFolder(sourcePath, extension.id);
    const runtime = await loadNativeExtensionForUi(extensionId);
    renderExtensionsList();
    reloadOpenWebviews();
    const search = document.getElementById('chrome-store-search');
    renderExtensionStore(search ? search.value.trim() : '');
    await showChromeImports();
    if (runtime && runtime.ok) {
      setStatusText(`“${extension.name}” Chrome’dan aktarıldı`);
    } else {
      alert(`“${extension.name}” aktarıldı. Ancak Electron bu eklentinin kullandığı Chrome API’lerini desteklemeyebilir.\n\n${runtime?.error || 'Eklenti temel modda kullanılabilir.'}`);
    }
  } catch (error) {
    alert(`Chrome eklentisi aktarılamadı: ${error.message}`);
  }
}

function renderExtensionStore(query = '') {
  const grid = document.getElementById('extension-store-grid');
  if (!grid) return;
  extensionManager.scanExtensions();
  grid.replaceChildren();

  const normalizedQuery = query.toLocaleLowerCase('tr-TR');
  const extensions = chromeStoreCatalog.filter(extension =>
    `${extension.name} ${extension.publisher} ${extension.category} ${extension.description}`
      .toLocaleLowerCase('tr-TR').includes(normalizedQuery)
  );
  const headingCount = document.getElementById('extension-store-count');
  if (headingCount) headingCount.textContent = `${extensions.length} eklenti`;

  if (!extensions.length) {
    const empty = document.createElement('p');
    empty.className = 'store-import-empty';
    empty.textContent = 'Bu aramada mağazada eşleşen eklenti yok. Chrome’dan aktar seçeneğiyle Chrome profiline kurulu eklentileri ekleyebilirsin.';
    grid.appendChild(empty);
    return;
  }

  extensions.forEach(extension => {
    const card = document.createElement('article');
    card.className = 'store-card';
    const icon = document.createElement('div');
    icon.className = 'store-card-icon';
    icon.innerHTML = `<i class="fas ${extension.icon}"></i>`;
    const category = document.createElement('span');
    category.className = 'store-card-category';
    category.textContent = extension.category;
    const name = document.createElement('h3');
    name.textContent = extension.name;
    const publisher = document.createElement('p');
    publisher.className = 'store-card-publisher';
    publisher.textContent = extension.publisher;
    const description = document.createElement('p');
    description.className = 'store-card-description';
    description.textContent = extension.description;
    const button = document.createElement('button');
    button.className = 'btn-secondary';
    const installed = extensionManager.extensions.has(extension.id);
    const runtimeError = extensionRuntimeErrors.get(extension.id);
    button.disabled = installed || installingStoreExtensionIds.has(extension.id);
    button.title = runtimeError || '';
    button.innerHTML = runtimeError
      ? '<i class="fas fa-triangle-exclamation"></i> Kuruldu · uyumsuz olabilir'
      : installed
      ? '<i class="fas fa-check"></i> Yüklü'
      : installingStoreExtensionIds.has(extension.id)
        ? '<i class="fas fa-circle-notch fa-spin"></i> İndiriliyor…'
        : '<i class="fas fa-download"></i> Uygulamaya kur';
    button.onclick = () => installStoreExtension(extension, button);
    card.append(icon, category, name, publisher, description, button);
    grid.appendChild(card);
  });
}

// ===== Menu =====
function toggleMenu() {
  const menu = document.getElementById('dropdown-menu');
  menu.classList.toggle('hidden');
}

function closeMenu() {
  const menu = document.getElementById('dropdown-menu');
  if (menu) menu.classList.add('hidden');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#dropdown-menu') && !e.target.closest('#menu-btn')) {
    closeMenu();
  }
  if (!e.target.closest('#extensions-dropdown') && !e.target.closest('#extensions-btn')) {
    closeExtensionsDropdown();
  }
  if (!e.target.closest('#audio-boost-container')) {
    closeAudioBoostPanel();
  }
  if (!e.target.closest('#extension-popup-container') && !e.target.closest('.ext-toolbar-icon') && !e.target.closest('.btn-popup-open') && !e.target.closest('.ext-dropdown-item')) {
    closeExtensionPopup();
  }
});

// ==========================================
// 🧩 EKLENTİ HIZLI MENÜSÜ & YÖNETİMİ
// ==========================================
function toggleExtensionsDropdown() {
  closeMenu();
  closeExtensionPopup();
  const dropdown = document.getElementById('extensions-dropdown');
  if (!dropdown) return;
  dropdown.classList.toggle('hidden');

  if (!dropdown.classList.contains('hidden')) {
    renderExtensionsDropdown();
  }
}

function closeExtensionsDropdown() {
  const dropdown = document.getElementById('extensions-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
}

function renderExtensionsDropdown() {
  const list = document.getElementById('ext-dropdown-list');
  if (!list) return;

  const exts = extensionManager.scanExtensions();
  ensureEnabledNativeExtensions(exts);
  list.innerHTML = '';

  if (exts.length === 0) {
    list.innerHTML = `
      <div style="padding:16px; text-align:center; color:#6b7280; font-size:12px;">
        Henüz yüklü eklenti yok.<br>Aşağıdaki butondan eklenti klasörünüzü ekleyebilirsiniz.
      </div>
    `;
    return;
  }

  exts.forEach(ext => {
    const item = document.createElement('div');
    item.className = 'ext-dropdown-item';
    item.onclick = () => {
      openExtensionPopup(ext.id);
    };

    const iconHtml = ext.icon && fs.existsSync(ext.icon)
      ? `<img src="${pathToFileURL(ext.icon).href}">`
      : `<i class="fas fa-puzzle-piece"></i>`;

    item.innerHTML = `
      <div class="ext-dropdown-main">
        <div class="ext-dropdown-icon">${iconHtml}</div>
        <div class="ext-dropdown-name">${escapeHtml(ext.name)}</div>
      </div>
      <span class="ext-dropdown-action">Aç</span>
    `;
    list.appendChild(item);
  });
}

function toggleExtensionsModal() {
  closeMenu();
  closeExtensionsDropdown();
  const modal = document.getElementById('extensions-modal');
  modal.classList.toggle('hidden');
  if (!modal.classList.contains('hidden')) {
    renderExtensionsList();
  }
}

function renderExtensionsList() {
  const list = document.getElementById('extensions-list');
  if (!list) return;

  const exts = extensionManager.scanExtensions();
  ensureEnabledNativeExtensions(exts);
  list.innerHTML = '';

  if (exts.length === 0) {
    list.innerHTML = `
      <div style="text-align:center; padding:30px; color:#6b7280;">
        <i class="fas fa-box-open" style="font-size:36px; margin-bottom:10px; display:block;"></i>
        Henüz yüklü eklenti yok.<br>Yukarıdaki butonlardan kendi eklentinizi ekleyebilirsiniz!
      </div>
    `;
    updateActiveExtensionsBar([]);
    return;
  }

  exts.forEach(ext => {
    const card = document.createElement('div');
    card.className = 'extension-card';
    const runtimeError = extensionRuntimeErrors.get(ext.id);
    const runtimeNote = runtimeError
      ? `<small style="display:block; margin-top:5px; color:var(--danger-color);">Chrome API yükleme uyarısı: ${escapeHtml(runtimeError)}. İçerik betiği desteği yine denenir.</small>`
      : '';

    const iconHtml = ext.icon && fs.existsSync(ext.icon)
      ? `<img src="${pathToFileURL(ext.icon).href}">`
      : `<i class="fas fa-puzzle-piece"></i>`;

    card.innerHTML = `
      <div class="extension-info">
        <div class="extension-avatar">
          ${iconHtml}
        </div>
        <div class="extension-meta">
          <h4>${escapeHtml(ext.name)} <span class="version-tag">v${escapeHtml(ext.version)}</span></h4>
          <p>${escapeHtml(ext.description || 'Açıklama belirtilmemiş.')}</p>
          ${runtimeNote}
        </div>
      </div>
      <div class="extension-controls">
        <button class="btn-primary btn-popup-open" onclick="openExtensionPopup('${ext.id}')" title="Eklentiyi Aç">
          <i class="fas fa-window-restore"></i> Aç
        </button>
        <label class="switch" title="${ext.enabled ? 'Eklentiyi Devre Dışı Bırak' : 'Eklentiyi Etkinleştir'}">
          <input type="checkbox" ${ext.enabled ? 'checked' : ''} onchange="toggleExtensionState('${ext.id}', this.checked)">
          <span class="slider"></span>
        </label>
        <button class="btn-danger" onclick="deleteExtension('${ext.id}')" title="Eklentiyi Sil">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `;
    list.appendChild(card);
  });

  updateActiveExtensionsBar(exts);
}

function updateActiveExtensionsBar(exts) {
  const bar = document.getElementById('active-extensions-bar');
  if (!bar) return;
  bar.innerHTML = '';

  exts.filter(e => e.enabled).forEach(ext => {
    const btn = document.createElement('button');
    btn.className = 'ext-toolbar-icon';
    btn.title = `${ext.name} (Eklentiyi Aç)`;
    btn.onclick = () => openExtensionPopup(ext.id);

    if (ext.icon && fs.existsSync(ext.icon)) {
      btn.innerHTML = `<img src="${pathToFileURL(ext.icon).href}" style="width:18px; height:18px; border-radius:3px;">`;
    } else {
      btn.innerHTML = `<i class="fas fa-puzzle-piece"></i>`;
    }
    bar.appendChild(btn);
  });
}

async function loadNativeExtensionForUi(extId) {
  const result = await ipcRenderer.invoke('extension-load-native', extId);
  if (result && result.ok) {
    nativeExtensionUrls.set(extId, { id: result.id, url: result.url });
    extensionRuntimeErrors.delete(extId);
  } else {
    nativeExtensionUrls.delete(extId);
    extensionRuntimeErrors.set(extId, result?.error || 'Eklenti başlatılamadı.');
  }
  return result;
}

function ensureEnabledNativeExtensions(exts) {
  for (const ext of exts) {
    if (!ext.enabled || nativeExtensionUrls.has(ext.id) || extensionRuntimeErrors.has(ext.id) || pendingNativeExtensionLoads.has(ext.id)) continue;

    pendingNativeExtensionLoads.add(ext.id);
    loadNativeExtensionForUi(ext.id).then((result) => {
      if (result && result.ok) reloadOpenWebviews();
      if (document.getElementById('extensions-modal') && !document.getElementById('extensions-modal').classList.contains('hidden')) {
        renderExtensionsList();
      }
    }).catch((error) => {
      extensionRuntimeErrors.set(ext.id, error.message || 'Eklenti başlatılamadı.');
    }).finally(() => {
      pendingNativeExtensionLoads.delete(ext.id);
    });
  }
}

async function unloadNativeExtensionForUi(extId) {
  const result = await ipcRenderer.invoke('extension-unload-native', extId);
  nativeExtensionUrls.delete(extId);
  extensionRuntimeErrors.delete(extId);
  return result;
}

function reloadOpenWebviews() {
  document.querySelectorAll('#webview-container webview').forEach((webview) => {
    try {
      if (webview.getURL && /^https?:\/\//i.test(webview.getURL())) webview.reload();
    } catch {}
  });
}

async function installExtensionFromFolder() {
  try {
    const folderPath = await ipcRenderer.invoke('dialog-open-directory');
    if (!folderPath) return;

    setStatusText('Eklenti yükleniyor...');
    const extId = extensionManager.installFromFolder(folderPath);
    const runtime = await loadNativeExtensionForUi(extId);
    renderExtensionsList();
    reloadOpenWebviews();
    if (runtime && runtime.ok) {
      alert(`🎉 "${extId}" eklentisi yüklendi ve etkinleştirildi.`);
      setStatusText(`"${extId}" eklentisi etkinleştirildi`);
    } else {
      const fallbackMessage = runtime?.error || 'Electron bu eklentinin istediği Chrome API desteğini sağlayamadı.';
      alert(`"${extId}" eklentisi eklendi; temel içerik betiği desteği kullanılacak.\n\nEklenti API uyarısı: ${fallbackMessage}`);
      setStatusText(`"${extId}" eklentisi temel modda etkin; ayrıntı için eklenti kartına bak`);
    }
  } catch (err) {
    alert(`Eklenti yüklenemedi: ${err.message}`);
    setStatusText(`Hata: ${err.message}`);
  }
}

async function installExtensionFromZip() {
  try {
    const zipPath = await ipcRenderer.invoke('dialog-open-zip');
    if (!zipPath) return;

    setStatusText('ZIP eklentisi açılıyor...');
    const extId = await extensionManager.installFromZip(zipPath);
    const runtime = await loadNativeExtensionForUi(extId);
    renderExtensionsList();
    reloadOpenWebviews();
    if (runtime && runtime.ok) {
      alert(`🎉 "${extId}" eklentisi ZIP dosyasından yüklendi ve etkinleştirildi.`);
      setStatusText(`"${extId}" eklentisi etkinleştirildi`);
    } else {
      const fallbackMessage = runtime?.error || 'Electron bu eklentinin istediği Chrome API desteğini sağlayamadı.';
      alert(`"${extId}" eklentisi eklendi; temel içerik betiği desteği kullanılacak.\n\nEklenti API uyarısı: ${fallbackMessage}`);
      setStatusText(`"${extId}" eklentisi temel modda etkin; ayrıntı için eklenti kartına bak`);
    }
  } catch (err) {
    alert(`ZIP eklenti kurulum hatası: ${err.message}`);
    setStatusText(`Hata: ${err.message}`);
  }
}

function openExtensionsFolder() {
  shell.openPath(extensionManager.extensionsDir);
}

async function toggleExtensionState(extId, isEnabled) {
  let runtime = null;
  if (isEnabled) {
    extensionManager.enableExtension(extId);
    runtime = await loadNativeExtensionForUi(extId);
  } else {
    extensionManager.disableExtension(extId);
    await unloadNativeExtensionForUi(extId);
  }
  renderExtensionsList();
  reloadOpenWebviews();
  if (isEnabled && runtime && !runtime.ok) {
    setStatusText(`Eklenti temel modda çalışıyor: ${runtime.error}`);
  }
}

async function deleteExtension(extId) {
  if (confirm(`"${extId}" eklentisini tamamen silmek istediğine emin misin?`)) {
    if (activePopupExtensionId === extId) {
      closeExtensionPopup();
      const frame = document.getElementById('extension-popup-frame');
      if (frame) frame.src = 'about:blank';
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const unloadResult = await unloadNativeExtensionForUi(extId);
    if (unloadResult && !unloadResult.ok) {
      alert(`"${extId}" eklentisi çalışırken kaldırılamadı: ${unloadResult.error || 'Eklenti kapatılamadı.'}`);
      return;
    }

    const removed = extensionManager.removeExtension(extId);
    if (!removed) {
      alert(`"${extId}" eklentisi silinemedi. Uygulama klasörüne erişim engellenmiş olabilir.`);
      return;
    }
    renderExtensionsList();
    reloadOpenWebviews();
    const storeSearch = document.getElementById('chrome-store-search');
    renderExtensionStore(storeSearch ? storeSearch.value.trim() : '');
    setStatusText(`"${extId}" eklentisi silindi`);
  }
}

// ===== EXTENSION POPUP FLYOUT =====
function popupUsesParentMessaging(ext, html) {
  if (!ext || !html) return false;

  let scriptText = html;
  const extensionRoot = path.resolve(ext.path);
  const scriptSrcPattern = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi;
  for (const match of html.matchAll(scriptSrcPattern)) {
    const source = match[2].split(/[?#]/, 1)[0];
    if (!source || /^(?:[a-z]+:)?\/\//i.test(source) || source.startsWith('data:')) continue;

    try {
      const scriptPath = path.resolve(extensionRoot, decodeURIComponent(source));
      const relativePath = path.relative(extensionRoot, scriptPath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || !fs.existsSync(scriptPath)) continue;
      scriptText += `\n${fs.readFileSync(scriptPath, 'utf-8')}`;
    } catch {}
  }

  return /(?:window\s*\.\s*)?parent\s*\.\s*postMessage\s*\(/.test(scriptText);
}

function installPopupExtensionCompatibility(extensionId, extensionRootUrl) {
  const pending = new Map();
  let requestCounter = 0;
  const listeners = new Set();

  const onMessage = {
    addListener(listener) { if (typeof listener === 'function') listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); }
  };

  function sendHostRequest(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${++requestCounter}`;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({
        channel: 'chattarayici-extension-bridge',
        extensionId,
        id,
        type,
        payload
      }, '*');
      window.setTimeout(() => {
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        request.reject(new Error('Tarayıcı uygulaması yanıt vermedi.'));
      }, 15000);
    });
  }

  function withCallback(promise, callback, fallbackValue) {
    if (typeof callback === 'function') {
      promise.then(value => callback(value), error => {
        window.chrome.runtime.lastError = { message: error.message };
        try { callback(fallbackValue); } finally { window.chrome.runtime.lastError = null; }
      });
    }
    return promise;
  }

  function emitMessage(message, sender = {}, callback) {
    return new Promise(resolve => {
      let settled = false;
      let asyncResponseExpected = false;
      const finish = response => {
        if (settled) return;
        settled = true;
        if (typeof callback === 'function') callback(response);
        resolve(response);
      };
      for (const listener of [...listeners]) {
        try {
          const result = listener(message, sender, finish);
          if (result === true) asyncResponseExpected = true;
          else if (result !== undefined) finish(result);
        } catch (error) {
          console.warn('Eklenti mesajı işlenemedi:', error);
        }
      }
      window.setTimeout(() => {
        if (!settled && !asyncResponseExpected) finish(undefined);
      }, 0);
      window.setTimeout(() => finish(undefined), 15000);
    });
  }

  const chromeApi = window.chrome || (window.chrome = {});
  chromeApi.runtime = chromeApi.runtime || {};
  chromeApi.runtime.id = extensionId;
  chromeApi.runtime.lastError = null;
  chromeApi.runtime.onMessage = onMessage;
  chromeApi.runtime.getURL = relativePath => new URL(String(relativePath || ''), extensionRootUrl).href;
  chromeApi.runtime.sendMessage = (message, optionsOrCallback, callback) => {
    const responseCallback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    return emitMessage(message, { id: extensionId, url: location.href }, responseCallback);
  };

  chromeApi.storage = chromeApi.storage || {};
  chromeApi.storage.local = {
    get(keys, callback) {
      return withCallback(sendHostRequest('storage-get', { keys }), callback, {});
    },
    set(items, callback) {
      return withCallback(sendHostRequest('storage-set', { items: items || {} }), callback, undefined);
    },
    remove(keys, callback) {
      return withCallback(sendHostRequest('storage-remove', { keys }), callback, undefined);
    },
    clear(callback) {
      return withCallback(sendHostRequest('storage-clear'), callback, undefined);
    }
  };

  chromeApi.tabs = chromeApi.tabs || {};
  chromeApi.tabs.query = (queryInfo = {}, callback) => withCallback(
    sendHostRequest('tabs-query', { queryInfo }), callback, []
  );
  chromeApi.tabs.executeScript = (tabId, details = {}, callback) => withCallback(
    sendHostRequest('execute-script', { tabId, details }), callback, []
  );

  chromeApi.scripting = chromeApi.scripting || {};
  chromeApi.scripting.executeScript = details => {
    const requestDetails = { ...(details || {}) };
    if (typeof requestDetails.func === 'function') requestDetails.func = requestDetails.func.toString();
    return sendHostRequest('execute-script', {
      tabId: requestDetails?.target?.tabId,
      details: requestDetails
    }).then(result => [{ frameId: 0, result }]);
  };
  chromeApi.scripting.insertCSS = details => sendHostRequest('insert-css', {
    tabId: details?.target?.tabId,
    details
  });

  window.addEventListener('message', event => {
    if (event.source !== window.parent || !event.data || event.data.extensionId !== extensionId) return;
    if (event.data.channel === 'chattarayici-extension-bridge-response') {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if (event.data.error) request.reject(new Error(event.data.error));
      else request.resolve(event.data.result);
    } else if (event.data.channel === 'chattarayici-extension-runtime-message') {
      emitMessage(event.data.message, event.data.sender || {});
    }
  });
}

function inlineLocalPopupScripts(html, ext, popupDirectory) {
  return html.replace(/<script\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>\s*<\/script\s*>/gis,
    (tag, beforeSrc, _quote, source, afterSrc) => {
      if (/^(?:[a-z]+:)?\/\//i.test(source) || /^(?:data:|blob:|chrome-extension:)/i.test(source)) return tag;
      try {
        const cleanSource = decodeURIComponent(source.split(/[?#]/, 1)[0]);
        const scriptPath = cleanSource.startsWith('/')
          ? path.resolve(ext.path, cleanSource.replace(/^\/+/, ''))
          : path.resolve(popupDirectory, cleanSource);
        const relativePath = path.relative(ext.path, scriptPath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || !fs.existsSync(scriptPath)) return tag;
        const attributes = `${beforeSrc}${afterSrc}`;
        const script = fs.readFileSync(scriptPath, 'utf8').replace(/<\/script/gi, '<\\/script');
        return `<script${attributes}>${script}</script>`;
      } catch {
        return tag;
      }
    });
}

function getPopupCompatibilityHtml(ext, popupInfo) {
  const popupFilePath = path.resolve(ext.path, ext.popupFile);
  const popupDirectory = path.dirname(popupFilePath);
  const baseHref = pathToFileURL(`${popupDirectory}${path.sep}`).href;
  const extensionRootUrl = pathToFileURL(`${path.resolve(ext.path)}${path.sep}`).href;
  const bridgeScript = `(${installPopupExtensionCompatibility.toString()})(${JSON.stringify(ext.id)}, ${JSON.stringify(extensionRootUrl)});`
    .replace(/<\/script/gi, '<\\/script');
  const baseTag = `<base href="${escapeHtml(baseHref)}">`;
  const bridgeTag = `<script>${bridgeScript}</script>`;
  let html = popupInfo.html || '<!doctype html><html><head></head><body></body></html>';

  // A copied extension page may bring a Chrome-only CSP that blocks the app's bridge.
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*(["'])?content-security-policy\1?[^>]*>/gi, '');
  html = inlineLocalPopupScripts(html, ext, popupDirectory);
  const backgroundScript = ext.manifest?.background?.service_worker;
  if (backgroundScript) {
    const workerPath = path.resolve(ext.path, backgroundScript);
    const relativeWorker = path.relative(ext.path, workerPath);
    if (!relativeWorker.startsWith('..') && !path.isAbsolute(relativeWorker) && fs.existsSync(workerPath)) {
      const type = ext.manifest.background.type === 'module' ? ' type="module"' : '';
      const workerSource = fs.readFileSync(workerPath, 'utf8').replace(/<\/script/gi, '<\\/script');
      const workerTag = `<script${type}>${workerSource}</script>`;
      html = html.replace(/<head\b[^>]*>/i, match => `${match}${baseTag}${bridgeTag}${workerTag}`);
      if (!/<head\b/i.test(popupInfo.html)) html = `<!doctype html><html><head>${baseTag}${bridgeTag}${workerTag}</head><body>${html}</body></html>`;
    }
  }

  if (!/<head\b/i.test(html)) {
    return `<!doctype html><html><head>${baseTag}${bridgeTag}</head><body>${html}</body></html>`;
  }
  if (!html.includes(baseTag)) {
    html = html.replace(/<head\b[^>]*>/i, match => `${match}${baseTag}${bridgeTag}`);
  }
  return html;
}

function getCompatibilityTabInfo() {
  if (!activeTabId) return null;
  const tab = tabs.find(entry => entry.id === activeTabId);
  const webview = getActiveWebview();
  if (!tab || !webview || tab.incognito) return null;

  let url = tab.url;
  let title = tab.title;
  try { url = webview.getURL() || url; } catch {}
  try { title = webview.getTitle() || title; } catch {}
  if (!/^https?:\/\//i.test(url || '')) return null;

  const numericId = Number(String(activeTabId).replace(/^tab-/, ''));
  if (!Number.isSafeInteger(numericId)) return null;
  return { id: numericId, url, title: title || url, active: true, currentWindow: true, windowId: 1 };
}

function matchExtensionQuery(value, pattern) {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some(candidate => {
    try {
      const escaped = String(candidate).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      const regex = new RegExp(`^${escaped}$`);
      return regex.test(value || '');
    } catch { return false; }
  });
}

function getExtensionStorageKeys(extId) {
  return `chattarayici.extension.${encodeURIComponent(extId)}.`;
}

async function handleExtensionPopupBridgeMessage(event) {
  const frame = document.getElementById('extension-popup-frame');
  const data = event.data;
  if (!frame || event.source !== frame.contentWindow || !data || data.channel !== 'chattarayici-extension-bridge') return false;
  if (data.extensionId !== activePopupExtensionId || !data.id) return false;

  const ext = extensionManager.extensions.get(data.extensionId);
  const respond = (result, error = '') => event.source.postMessage({
    channel: 'chattarayici-extension-bridge-response',
    extensionId: data.extensionId,
    id: data.id,
    result,
    error
  }, '*');
  if (!ext || !ext.enabled) {
    respond(null, 'Eklenti etkin değil.');
    return true;
  }

  try {
    const payload = data.payload || {};
    if (data.type === 'tabs-query') {
      const tab = getCompatibilityTabInfo();
      const query = payload.queryInfo || {};
      if (!tab || query.active === false || query.currentWindow === false) return respond([]), true;
      if (query.url && !matchExtensionQuery(tab.url, query.url)) return respond([]), true;
      if (query.title && !matchExtensionQuery(tab.title, query.title)) return respond([]), true;
      respond([tab]);
      return true;
    }

    const storagePrefix = getExtensionStorageKeys(data.extensionId);
    if (data.type === 'storage-get') {
      const keys = payload.keys;
      const result = {};
      if (keys == null) {
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (key?.startsWith(storagePrefix)) {
            try { result[key.slice(storagePrefix.length)] = JSON.parse(localStorage.getItem(key)); } catch {}
          }
        }
      } else {
        const requested = typeof keys === 'string' ? [keys]
          : Array.isArray(keys) ? keys
            : Object.keys(keys);
        for (const key of requested) {
          const stored = localStorage.getItem(`${storagePrefix}${key}`);
          if (stored !== null) {
            try { result[key] = JSON.parse(stored); } catch { result[key] = stored; }
          } else if (!Array.isArray(keys) && keys && typeof keys === 'object') {
            result[key] = keys[key];
          }
        }
      }
      respond(result);
      return true;
    }
    if (data.type === 'storage-set') {
      for (const [key, value] of Object.entries(payload.items || {})) localStorage.setItem(`${storagePrefix}${key}`, JSON.stringify(value));
      respond(undefined);
      return true;
    }
    if (data.type === 'storage-remove' || data.type === 'storage-clear') {
      const keys = data.type === 'storage-clear' ? null : (Array.isArray(payload.keys) ? payload.keys : [payload.keys]);
      if (keys === null) {
        for (let index = localStorage.length - 1; index >= 0; index--) {
          const key = localStorage.key(index);
          if (key?.startsWith(storagePrefix)) localStorage.removeItem(key);
        }
      } else {
        for (const key of keys.filter(value => typeof value === 'string')) localStorage.removeItem(`${storagePrefix}${key}`);
      }
      respond(undefined);
      return true;
    }

    const tab = getCompatibilityTabInfo();
    const webview = getActiveWebview();
    const requestedTabId = payload.tabId ?? payload.details?.target?.tabId;
    if (!tab || !webview) throw new Error('Önce normal bir web sayfası aç. Gizli sekmelerde eklenti çalıştırma kapalı.');
    if (requestedTabId != null && Number(requestedTabId) !== tab.id) throw new Error('Eklenti için etkin sekme değişti; paneli yeniden aç.');

    if (data.type === 'execute-script') {
      const details = payload.details || {};
      let injectedCode = '';
      if (typeof details.func === 'function' || typeof details.func === 'string') {
        const funcSource = typeof details.func === 'string' ? details.func : details.func;
        const args = JSON.stringify(Array.isArray(details.args) ? details.args : []);
        injectedCode = `(${funcSource})(...${args})`;
      } else if (typeof details.code === 'string') {
        injectedCode = details.code;
      } else if (Array.isArray(details.files) && details.files.length) {
        const pieces = details.files.map(file => {
          const filePath = path.resolve(ext.path, file);
          const relativeFile = path.relative(ext.path, filePath);
          if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile) || !fs.existsSync(filePath)) throw new Error(`Eklenti dosyası bulunamadı: ${file}`);
          return fs.readFileSync(filePath, 'utf8');
        });
        injectedCode = pieces.join('\n;\n');
      } else {
        throw new Error('Bu eklenti betik biçimi desteklenmiyor.');
      }

      const runtimePrelude = `(() => { const root=window.chrome||(window.chrome={}); const runtime=root.runtime||(root.runtime={}); const prior=runtime.sendMessage; runtime.sendMessage=(message,...args)=>{ (window.__chattarayiciExtensionMessages||(window.__chattarayiciExtensionMessages=[])).push({extensionId:${JSON.stringify(data.extensionId)},message}); if(typeof prior==='function') return prior.call(runtime,message,...args); }; })();`;
      const result = await webview.executeJavaScript(`${runtimePrelude}\n${injectedCode}`, true);
      respond(result === undefined ? null : result);
      return true;
    }
    if (data.type === 'insert-css') {
      const details = payload.details || {};
      let css = details.css || '';
      if (!css && details.files?.length) {
        css = details.files.map(file => {
          const filePath = path.resolve(ext.path, file);
          const relativeFile = path.relative(ext.path, filePath);
          if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile) || !fs.existsSync(filePath)) throw new Error(`Eklenti dosyası bulunamadı: ${file}`);
          return fs.readFileSync(filePath, 'utf8');
        }).join('\n');
      }
      await webview.insertCSS(css);
      respond(undefined);
      return true;
    }
  } catch (error) {
    respond(null, error?.message || String(error));
    return true;
  }
  respond(null, `Desteklenmeyen eklenti isteği: ${data.type}`);
  return true;
}

function startExtensionPopupBridgePolling(extensionId) {
  if (extensionPopupBridgePollTimer) clearInterval(extensionPopupBridgePollTimer);
  let polling = false;
  extensionPopupBridgePollTimer = setInterval(async () => {
    if (polling || activePopupExtensionId !== extensionId) return;
    const webview = getActiveWebview();
    const frame = document.getElementById('extension-popup-frame');
    if (!webview || !frame || frame.classList.contains('hidden')) return;
    polling = true;
    try {
      const messages = await webview.executeJavaScript(`(() => { const queue=window.__chattarayiciExtensionMessages||[]; window.__chattarayiciExtensionMessages=[]; return queue; })()`);
      if (Array.isArray(messages)) {
        for (const entry of messages) {
          if (entry?.extensionId === extensionId) frame.contentWindow.postMessage({
            channel: 'chattarayici-extension-runtime-message',
            extensionId,
            message: entry.message,
            sender: { tab: getCompatibilityTabInfo() }
          }, '*');
        }
      }
    } catch {} finally {
      polling = false;
    }
  }, 120);
}

function openExtensionPopup(extId) {
  closeExtensionsDropdown();
  const container = document.getElementById('extension-popup-container');
  const frame = document.getElementById('extension-popup-frame');
  const nativeFrame = document.getElementById('extension-popup-webview');
  const title = document.getElementById('extension-popup-title');

  const popupInfo = extensionManager.getPopupContent(extId);
  if (!popupInfo) return;

  const ext = extensionManager.extensions.get(extId);
  const nativeInfo = nativeExtensionUrls.get(extId);
  activePopupExtensionId = extId;
  title.textContent = ext ? (ext.manifest.name || ext.id) : 'Eklenti';
  frame.removeAttribute('srcdoc');
  frame.src = 'about:blank';
  frame.classList.add('hidden');
  nativeFrame.src = 'about:blank';
  nativeFrame.classList.add('hidden');

  const needsCompatibilityBridge = Boolean(ext?.manifest?.manifest_version === 3 && ext.manifest?.background?.service_worker);
  if (ext && ext.popupFile) {
    if (needsCompatibilityBridge) {
      frame.classList.remove('hidden');
      frame.srcdoc = getPopupCompatibilityHtml(ext, popupInfo);
      startExtensionPopupBridgePolling(extId);
    } else if (nativeInfo && nativeInfo.url && !popupUsesParentMessaging(ext, popupInfo.html)) {
      const popupUrl = new URL(ext.popupFile, nativeInfo.url.endsWith('/') ? nativeInfo.url : `${nativeInfo.url}/`);
      popupUrl.searchParams.set('enabled', String(!!ext.enabled));
      nativeFrame.classList.remove('hidden');
      nativeFrame.src = popupUrl.href;
    } else {
      const popupUrl = pathToFileURL(path.join(ext.path, ext.popupFile));
      popupUrl.searchParams.set('enabled', String(!!ext.enabled));
      frame.classList.remove('hidden');
      frame.src = popupUrl.href;
    }
  } else {
    const encodedHtml = encodeURIComponent(popupInfo.html);
    frame.classList.remove('hidden');
    frame.src = `data:text/html;charset=utf-8,${encodedHtml}`;
  }

  container.classList.remove('hidden');
}

function closeExtensionPopup() {
  const container = document.getElementById('extension-popup-container');
  const frame = document.getElementById('extension-popup-frame');
  const nativeFrame = document.getElementById('extension-popup-webview');
  if (container) container.classList.add('hidden');
  if (frame) frame.src = 'about:blank';
  if (frame) frame.removeAttribute('srcdoc');
  if (nativeFrame) {
    nativeFrame.src = 'about:blank';
    nativeFrame.classList.add('hidden');
  }
  if (extensionPopupBridgePollTimer) {
    clearInterval(extensionPopupBridgePollTimer);
    extensionPopupBridgePollTimer = null;
  }
  activePopupExtensionId = null;
}

window.addEventListener('message', (event) => {
  if (event.data?.channel === 'chattarayici-extension-bridge') {
    handleExtensionPopupBridgeMessage(event);
    return;
  }
  const frame = document.getElementById('extension-popup-frame');
  if (!frame || event.source !== frame.contentWindow || !activePopupExtensionId) return;
  if (!event.data || (event.data.type !== 'toggle-extension' && event.data.type !== 'toggle-adblock-extension')) return;
  toggleExtensionState(activePopupExtensionId, Boolean(event.data.enabled));
});

// ==========================================
// 🔄 MERKEZİ OTOMATİK GÜNCELLEME (GITHUB)
// ==========================================
function toggleUpdatesModal() {
  closeMenu();
  const modal = document.getElementById('updates-modal');
  modal.classList.toggle('hidden');

  if (!modal.classList.contains('hidden')) {
    document.getElementById('github-repo-input').value = updater.config.githubRepo || '';
  }
}

async function checkCentralUpdateNow() {
  const repo = document.getElementById('github-repo-input').value.trim();

  if (!repo) {
    alert('Lütfen GitHub Repository bilgisini girin! (Örn: omerFlix/Chattaray-c-)');
    return;
  }

  updater.config.githubRepo = repo;
  updater.saveConfig();

  setUpdateStatus('GitHub üzerinden en son güncellemeler denetleniyor...', false);
  await ipcRenderer.invoke('github-update-check', { repo, silent: false });
}

function saveCentralUpdateSettings() {
  updater.config.githubRepo = document.getElementById('github-repo-input').value.trim();
  updater.saveConfig();
  alert('Güncelleme ayarları kaydedildi!');
}

function setUpdateStatus(msg, isError) {
  const box = document.getElementById('update-status-box');
  const text = document.getElementById('update-status-message');
  if (box && text) {
    box.classList.remove('hidden');
    text.textContent = msg;
    box.style.borderColor = isError ? 'var(--danger-color)' : 'var(--accent-primary)';
    box.style.color = isError ? 'var(--danger-color)' : 'var(--text-primary)';
  }
}

// ===== Utility Escape HTML =====
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function loadStoredArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value)
      ? value.filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.url === 'string')
      : [];
  } catch {
    return [];
  }
}

function safeWebUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function safeFaviconUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'file:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function isSafeNavigationUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'file:'].includes(url.protocol) || /^about:(blank|newtab)$/i.test(value);
  } catch {
    return false;
  }
}

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
  const focusedShortcut = e.target?.closest?.('.shortcut-item');
  if (focusedShortcut && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    focusedShortcut.click();
    return;
  }

  // Ctrl+T - New tab
  if (e.ctrlKey && e.key === 't') {
    e.preventDefault();
    createNewTab();
  }

  // Ctrl+W - Close tab
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
  }

  // Ctrl+L - Focus URL bar
  if (e.ctrlKey && e.key === 'l') {
    e.preventDefault();
    const urlIn = document.getElementById('url-input');
    urlIn.focus();
    urlIn.select();
  }

  // F5 or Ctrl+R - Refresh
  if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
    e.preventDefault();
    refreshPage();
  }

  // Alt+Left - Back
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    goBack();
  }

  // Alt+Right - Forward
  if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    goForward();
  }

  // Ctrl+Plus - Zoom in
  if (e.ctrlKey && (e.key === '+' || e.key === '=')) {
    e.preventDefault();
    zoomIn();
  }

  // Ctrl+Minus - Zoom out
  if (e.ctrlKey && e.key === '-') {
    e.preventDefault();
    zoomOut();
  }

  // Ctrl+0 - Reset zoom
  if (e.ctrlKey && e.key === '0') {
    e.preventDefault();
    resetZoom();
  }

  // Ctrl+Shift+I or F12 - Dev tools
  if ((e.ctrlKey && e.shiftKey && e.key === 'I') || e.key === 'F12') {
    e.preventDefault();
    toggleDevTools();
  }

  // Ctrl+Tab - Next tab
  if (e.ctrlKey && !e.shiftKey && e.key === 'Tab' && tabs.length > 1) {
    e.preventDefault();
    const currentIndex = tabs.findIndex(t => t.id === activeTabId);
    const nextIndex = (currentIndex + 1) % tabs.length;
    switchTab(tabs[nextIndex].id);
  }

  // Ctrl+Shift+Tab - Previous tab
  if (e.ctrlKey && e.shiftKey && e.key === 'Tab' && tabs.length > 1) {
    e.preventDefault();
    const currentIndex = tabs.findIndex(t => t.id === activeTabId);
    const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    switchTab(tabs[prevIndex].id);
  }

  // Ctrl+D - Bookmark
  if (e.ctrlKey && e.key === 'd') {
    e.preventDefault();
    toggleBookmark();
  }

  // Ctrl+H - History
  if (e.ctrlKey && e.key === 'h') {
    e.preventDefault();
    showHistory();
  }

  // Escape - Close modals
  if (e.key === 'Escape') {
    document.getElementById('extensions-modal').classList.add('hidden');
    document.getElementById('updates-modal').classList.add('hidden');
    closeExtensionStore();
    closeAdultProtectionSettings();
    closeExtensionPopup();
    closeMenu();
    closeAudioBoostPanel();
  }
});

// URL input auto-select
const urlIn = document.getElementById('url-input');
urlIn.addEventListener('focus', () => {
  urlIn.select();
});

// ===== Initialize =====
function init() {
  renderBookmarks();
  syncAudioBoostControls();
  updateNtpClock();
  renderNtpRecents();
  setInterval(updateNtpClock, 60_000);
  createNewTab();

  const exts = extensionManager.scanExtensions();
  updateActiveExtensionsBar(exts);

}

init();

window.addEventListener('load', () => {
  setTimeout(() => {
    ipcRenderer.invoke('github-update-check', {
      repo: updater.config.githubRepo,
      silent: true
    }).catch((e) => console.warn('GitHub update check failed:', e));
  }, 1500);
});
