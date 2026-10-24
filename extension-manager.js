const fs = require('fs');
const path = require('path');

class ExtensionManager {
  constructor(extensionsDir) {
    this.extensionsDir = extensionsDir;
    this.extensions = new Map();
    this.enabledExtensions = new Set();

    // Create extensions dir if not exists
    if (!fs.existsSync(this.extensionsDir)) {
      fs.mkdirSync(this.extensionsDir, { recursive: true });
    }

    // Load enabled state
    this.stateFile = path.join(this.extensionsDir, '.enabled.json');
    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        this.enabledExtensions = new Set(data.enabled || []);
      }
    } catch (e) {
      console.error('Failed to load extension state:', e);
    }
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({
        enabled: Array.from(this.enabledExtensions)
      }, null, 2));
    } catch (e) {
      console.error('Failed to save extension state:', e);
    }
  }

  // Scan extensions directory and load all manifests
  scanExtensions() {
    this.extensions.clear();

    if (!fs.existsSync(this.extensionsDir)) return [];

    const dirs = fs.readdirSync(this.extensionsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));

    for (const dir of dirs) {
      const extPath = path.join(this.extensionsDir, dir.name);
      const manifestPath = path.join(extPath, 'manifest.json');

      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          const popupRelPath = this.findPopupPath(extPath, manifest);
          const iconRelPath = this.findIconPath(extPath, manifest);

          // By default, if not explicitly disabled, enable newly installed extensions
          if (!fs.existsSync(this.stateFile)) {
            this.enabledExtensions.add(dir.name);
          }

          const ext = {
            id: dir.name,
            path: extPath,
            manifest: manifest,
            popupFile: popupRelPath,
            iconFile: iconRelPath,
            enabled: this.enabledExtensions.size === 0 ? true : this.enabledExtensions.has(dir.name)
          };

          if (this.enabledExtensions.size === 0) {
            this.enabledExtensions.add(dir.name);
          }

          this.extensions.set(dir.name, ext);
        } catch (e) {
          console.error(`Failed to load extension ${dir.name}:`, e);
        }
      }
    }

    this.saveState();
    return this.getExtensionList();
  }

  findPopupPath(extPath, manifest) {
    // 1. Direct popup field
    if (manifest.popup && fs.existsSync(path.join(extPath, manifest.popup))) {
      return manifest.popup;
    }
    // 2. Chrome Manifest V3: action.default_popup
    if (manifest.action && manifest.action.default_popup && fs.existsSync(path.join(extPath, manifest.action.default_popup))) {
      return manifest.action.default_popup;
    }
    // 3. Chrome Manifest V2: browser_action.default_popup
    if (manifest.browser_action && manifest.browser_action.default_popup && fs.existsSync(path.join(extPath, manifest.browser_action.default_popup))) {
      return manifest.browser_action.default_popup;
    }
    // 4. page_action.default_popup
    if (manifest.page_action && manifest.page_action.default_popup && fs.existsSync(path.join(extPath, manifest.page_action.default_popup))) {
      return manifest.page_action.default_popup;
    }
    // 5. options page
    if (manifest.options_page && fs.existsSync(path.join(extPath, manifest.options_page))) {
      return manifest.options_page;
    }
    if (manifest.options_ui && manifest.options_ui.page && fs.existsSync(path.join(extPath, manifest.options_ui.page))) {
      return manifest.options_ui.page;
    }
    // 6. Common HTML names
    if (fs.existsSync(path.join(extPath, 'popup.html'))) return 'popup.html';
    if (fs.existsSync(path.join(extPath, 'index.html'))) return 'index.html';
    return null;
  }

  findIconPath(extPath, manifest) {
    if (typeof manifest.icon === 'string' && fs.existsSync(path.join(extPath, manifest.icon))) {
      return manifest.icon;
    }
    if (manifest.icons && typeof manifest.icons === 'object') {
      const sizes = ['128', '48', '32', '16'];
      for (const s of sizes) {
        if (manifest.icons[s] && fs.existsSync(path.join(extPath, manifest.icons[s]))) {
          return manifest.icons[s];
        }
      }
      const anyVal = Object.values(manifest.icons)[0];
      if (anyVal && fs.existsSync(path.join(extPath, anyVal))) return anyVal;
    }
    if (manifest.action && manifest.action.default_icon) {
      const iconVal = typeof manifest.action.default_icon === 'string' ? manifest.action.default_icon : Object.values(manifest.action.default_icon)[0];
      if (iconVal && fs.existsSync(path.join(extPath, iconVal))) return iconVal;
    }
    if (manifest.browser_action && manifest.browser_action.default_icon) {
      const iconVal = typeof manifest.browser_action.default_icon === 'string' ? manifest.browser_action.default_icon : Object.values(manifest.browser_action.default_icon)[0];
      if (iconVal && fs.existsSync(path.join(extPath, iconVal))) return iconVal;
    }
    for (const name of ['icon.png', 'icon.svg', 'logo.png', 'icon-128.png', 'icon-48.png', 'icon-16.png']) {
      if (fs.existsSync(path.join(extPath, name))) return name;
    }
    return null;
  }

  getExtensionList() {
    return Array.from(this.extensions.values()).map(ext => ({
      id: ext.id,
      name: ext.manifest.name || ext.id,
      version: ext.manifest.version || '1.0.0',
      description: ext.manifest.description || '',
      author: ext.manifest.author || 'Bilinmiyor',
      icon: ext.iconFile ? path.join(ext.path, ext.iconFile).replace(/\\/g, '/') : null,
      enabled: ext.enabled,
      hasPopup: true, // Her eklentinin artık açılabilir bir paneli var!
      hasCustomPopup: !!ext.popupFile,
      hasContentScript: !!(ext.manifest.content_scripts && ext.manifest.content_scripts.length > 0),
      hasBackground: !!(ext.manifest.background),
      path: ext.path
    }));
  }

  enableExtension(extId) {
    const ext = this.extensions.get(extId);
    if (!ext) return false;

    ext.enabled = true;
    this.enabledExtensions.add(extId);
    this.saveState();
    return true;
  }

  disableExtension(extId) {
    const ext = this.extensions.get(extId);
    if (!ext) return false;

    ext.enabled = false;
    this.enabledExtensions.delete(extId);
    this.saveState();
    return true;
  }

  removeExtension(extId) {
    const ext = this.extensions.get(extId);
    if (!ext) return false;

    try {
      fs.rmSync(ext.path, { recursive: true, force: true });
    } catch (e) {
      console.error(`Failed to delete extension ${extId}:`, e);
      return false;
    }

    this.extensions.delete(extId);
    this.enabledExtensions.delete(extId);
    this.saveState();
    return true;
  }

  installFromFolder(sourcePath) {
    const manifestPath = path.join(sourcePath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('manifest.json bulunamadı! Lütfen manifest.json içeren geçerli bir eklenti klasörü seçin.');
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const extId = (manifest.id || manifest.name || path.basename(sourcePath)).toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    const targetPath = path.join(this.extensionsDir, extId);

    // Copy folder
    this.copyFolderSync(sourcePath, targetPath);

    // Enable by default
    this.enabledExtensions.add(extId);
    this.saveState();

    // Reload
    this.scanExtensions();
    return extId;
  }

  async installFromZip(zipPath) {
    const extract = require('extract-zip');
    const tempDir = path.join(this.extensionsDir, '.temp-install');

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      await extract(zipPath, { dir: tempDir });

      const manifestPath = this.findManifest(tempDir);
      if (!manifestPath) {
        throw new Error('ZIP içinde manifest.json bulunamadı!');
      }

      const extRoot = path.dirname(manifestPath);
      return this.installFromFolder(extRoot);
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  findManifest(dir) {
    const manifestPath = path.join(dir, 'manifest.json');
    if (fs.existsSync(manifestPath)) return manifestPath;

    const subdirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const subdir of subdirs) {
      const result = this.findManifest(path.join(dir, subdir.name));
      if (result) return result;
    }
    return null;
  }

  copyFolderSync(src, dest) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyFolderSync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  // Get content scripts for injection into webviews
  getContentScripts(url) {
    const scripts = [];

    for (const [id, ext] of this.extensions) {
      if (!ext.enabled) continue;
      if (!ext.manifest.content_scripts) continue;

      for (const cs of ext.manifest.content_scripts) {
        if (this.matchesPattern(url, cs.matches || ['*'])) {
          const entry = {
            extensionId: id,
            js: [],
            css: [],
            runAt: cs.run_at || 'document_idle'
          };

          if (cs.js) {
            for (const jsFile of cs.js) {
              const filePath = path.join(ext.path, jsFile);
              if (fs.existsSync(filePath)) {
                entry.js.push(fs.readFileSync(filePath, 'utf-8'));
              }
            }
          }

          if (cs.css) {
            for (const cssFile of cs.css) {
              const filePath = path.join(ext.path, cssFile);
              if (fs.existsSync(filePath)) {
                entry.css.push(fs.readFileSync(filePath, 'utf-8'));
              }
            }
          }

          if (entry.js.length > 0 || entry.css.length > 0) {
            scripts.push(entry);
          }
        }
      }
    }

    return scripts;
  }

  // Get popup HTML content for any extension (custom or auto-generated dashboard)
  getPopupContent(extId) {
    const ext = this.extensions.get(extId);
    if (!ext) return null;

    if (ext.popupFile) {
      const popupPath = path.join(ext.path, ext.popupFile);
      if (fs.existsSync(popupPath)) {
        let html = fs.readFileSync(popupPath, 'utf-8');
        return {
          html: html,
          basePath: ext.path,
          name: ext.manifest.name || ext.id
        };
      }
    }

    // Default beautiful extension dashboard if no popup.html exists
    const name = ext.manifest.name || ext.id;
    const desc = ext.manifest.description || 'Bu eklenti web siteleri üzerinde çalışır.';
    const ver = ext.manifest.version || '1.0.0';

    const defaultHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1a1a2e;
            color: #e8e8f0;
            margin: 0;
            padding: 16px;
            font-size: 13px;
          }
          .header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 12px;
          }
          .title {
            font-weight: 600;
            font-size: 14px;
            color: #a855f7;
          }
          .tag {
            background: rgba(108, 99, 255, 0.2);
            color: #6c63ff;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 11px;
          }
          .desc {
            color: #9ca3af;
            line-height: 1.4;
            margin-bottom: 14px;
          }
          .status {
            background: rgba(52, 211, 153, 0.15);
            color: #34d399;
            padding: 8px 12px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 500;
            margin-bottom: 12px;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <span class="title">${name}</span>
          <span class="tag">v${ver}</span>
        </div>
        <p class="desc">${desc}</p>
        <div class="status">
          <span>●</span>
          <span>Eklenti Aktif ve Çalışıyor</span>
        </div>
      </body>
      </html>
    `;

    return {
      html: defaultHtml,
      basePath: ext.path,
      name: name
    };
  }

  matchesPattern(url, patterns) {
    for (const pattern of patterns) {
      if (pattern === '*' || pattern === '<all_urls>') return true;

      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');

      try {
        if (new RegExp(regexStr).test(url)) return true;
      } catch {
        continue;
      }
    }
    return false;
  }
}

module.exports = ExtensionManager;
