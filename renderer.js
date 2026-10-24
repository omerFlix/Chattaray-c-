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
let bookmarks = JSON.parse(localStorage.getItem('bookmarks') || '[]');
let history = JSON.parse(localStorage.getItem('browsingHistory') || '[]');
let zoomLevels = {};

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

const updater = new CentralUpdater({
  appRoot: __dirname,
  configPath: path.join(path.dirname(extensionsDir), 'update-config.json')
});

ipcRenderer.on('github-update-status', (_event, status) => {
  if (!status || !status.message) return;
  setUpdateStatus(status.message, Boolean(status.isError));
  setStatusText(status.message);
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
    webview.setAttribute('partition', `persist:incognito-${tabId}`);
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
  });

  webview.addEventListener('did-navigate', (e) => {
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
function navigateTo(input) {
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

  document.getElementById('new-tab-page').classList.add('hidden');

  let webview = document.querySelector(`webview[data-tab="${activeTabId}"]`);
  if (!webview) {
    webview = createWebview(activeTabId, url, tab.incognito);
    webview.classList.add('active');
  } else {
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
    item.onclick = () => navigateTo(bm.url);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      if (confirm(`"${bm.title}" yer işaretini silmek istiyor musun?`)) {
        bookmarks.splice(index, 1);
        localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
        renderBookmarks();
      }
    };

    const favicon = bm.favicon
      ? `<img src="${bm.favicon}" onerror="this.replaceWith(document.createTextNode('🔖'))">`
      : '🔖';

    item.innerHTML = `${typeof favicon === 'string' && favicon.startsWith('<') ? favicon : `<span>${favicon}</span>`} <span>${bm.title}</span>`;
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
    content += `<li><a href="${bm.url}">${bm.title}</a></li>`;
  });
  content += '</ul>';

  const webview = getActiveWebview();
  if (webview) {
    webview.loadURL(`data:text/html;charset=utf-8,
      <html><head><style>
        body { font-family: Inter, sans-serif; background: #0f0f1a; color: #e8e8f0; padding: 40px; }
        h2 { color: #6c63ff; margin-bottom: 20px; }
        ul { list-style: none; padding: 0; }
        li { padding: 12px 16px; border-bottom: 1px solid rgba(108,99,255,0.15); }
        a { color: #a855f7; text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style></head><body>${content}</body></html>
    `);
  }
}

// ===== History =====
function addToHistory(url, title) {
  history.unshift({
    url,
    title: title || url,
    visitedAt: Date.now()
  });

  if (history.length > 500) history = history.slice(0, 500);
  localStorage.setItem('browsingHistory', JSON.stringify(history));
}

function updateHistoryTitle(url, title) {
  const entry = history.find(h => h.url === url);
  if (entry) entry.title = title;
  localStorage.setItem('browsingHistory', JSON.stringify(history));
}

function showHistory() {
  closeMenu();
  let content = '<h2>Tarayıcı Geçmişi</h2><ul>';
  history.slice(0, 100).forEach(h => {
    const date = new Date(h.visitedAt).toLocaleString('tr-TR');
    content += `<li><a href="${h.url}">${h.title}</a><span class="date">${date}</span></li>`;
  });
  content += '</ul>';

  navigateTo(`data:text/html;charset=utf-8,
    <html><head><style>
      body { font-family: Inter, sans-serif; background: #0f0f1a; color: #e8e8f0; padding: 40px; max-width: 800px; margin: 0 auto; }
      h2 { color: #6c63ff; margin-bottom: 20px; font-size: 24px; }
      ul { list-style: none; padding: 0; }
      li { padding: 12px 16px; border-bottom: 1px solid rgba(108,99,255,0.15); display: flex; justify-content: space-between; align-items: center; }
      a { color: #a855f7; text-decoration: none; flex: 1; }
      a:hover { text-decoration: underline; }
      .date { color: #6b7280; font-size: 12px; flex-shrink: 0; margin-left: 16px; }
    </style></head><body>${content}</body></html>
  `);
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
      <div class="setting"><label>Eklenti Desteği</label><p>Aktif ✅ (Chrome Manifest Uyumlu)</p></div>
      <div class="setting"><label>Güncelleme</label><p>Uygulama açılışta GitHub'dan yeni sürümü kontrol eder ve varsa kurulumunu başlatır.</p></div>
      <div class="setting"><label>Reklam Engelleyici</label><p>Aktif ✅</p></div>
      <div class="version">ChatTarayıcı — Modern, hızlı ve tam donanımlı tarayıcınız</div>
    </body></html>
  `);
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
  frame.src = 'about:blank';
  frame.classList.add('hidden');
  nativeFrame.src = 'about:blank';
  nativeFrame.classList.add('hidden');

  if (ext && ext.popupFile) {
    if (nativeInfo && nativeInfo.url && !popupUsesParentMessaging(ext, popupInfo.html)) {
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
  if (nativeFrame) {
    nativeFrame.src = 'about:blank';
    nativeFrame.classList.add('hidden');
  }
  activePopupExtensionId = null;
}

window.addEventListener('message', (event) => {
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

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
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
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const currentIndex = tabs.findIndex(t => t.id === activeTabId);
    const nextIndex = (currentIndex + 1) % tabs.length;
    switchTab(tabs[nextIndex].id);
  }

  // Ctrl+Shift+Tab - Previous tab
  if (e.ctrlKey && e.shiftKey && e.key === 'Tab') {
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
    closeExtensionPopup();
    closeMenu();
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
  updateNtpClock();
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
