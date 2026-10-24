const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class CentralUpdater {
  constructor(options = {}) {
    this.appRoot = options.appRoot || __dirname;
    this.configPath = path.join(this.appRoot, 'update-config.json');

    // Default configuration: central GitHub repo
    this.config = {
      githubRepo: 'omerFlix/Chattaray-c-', // GitHub kullanıcı/repo adı
      branch: 'main',
      autoCheck: true,
      checkIntervalMinutes: 10
    };

    this.loadConfig();
    this.timer = null;

    this.onUpdateAvailable = options.onUpdateAvailable || null;
    this.onUpdateApplied = options.onUpdateApplied || null;
    this.onError = options.onError || null;
    this.onStatus = options.onStatus || null;
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        this.config = { ...this.config, ...data };
      } else {
        this.saveConfig();
      }
    } catch (e) {
      console.error('Failed to load update config:', e);
    }
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.error('Failed to save update config:', e);
    }
  }

  // Start background auto-updater for anyone using this app
  startAutoUpdate() {
    this.stopAutoUpdate();
    if (!this.config.autoCheck) return;

    const intervalMs = Math.max(2, this.config.checkIntervalMinutes || 10) * 60 * 1000;
    this.timer = setInterval(() => {
      this.checkForUpdates(true);
    }, intervalMs);

    // Check automatically 5 seconds after startup
    setTimeout(() => {
      this.checkForUpdates(true);
    }, 5000);
  }

  stopAutoUpdate() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Central update check from GitHub
  async checkForUpdates(silent = false) {
    const repo = (this.config.githubRepo || '').trim().replace('https://github.com/', '').replace(/\/$/, '');
    if (!repo) {
      if (!silent && this.onError) {
        this.onError('GitHub repository adı ayarlanmamış!');
      }
      return false;
    }

    const branch = this.config.branch || 'main';

    try {
      if (this.onStatus) this.onStatus('Merkezi güncelleme kontrol ediliyor...');

      const rawBase = `https://raw.githubusercontent.com/${repo}/${branch}`;
      const coreFiles = [
        'renderer.js',
        'styles.css',
        'index.html',
        'main.js',
        'extension-manager.js',
        'updater.js',
        'package.json'
      ];

      // Test reachable by fetching package.json first
      const remotePkgStr = await this.httpGetText(`${rawBase}/package.json`);
      const remotePkg = JSON.parse(remotePkgStr);

      const localPkgPath = path.join(this.appRoot, 'package.json');
      let localPkg = { version: '1.0.0' };
      if (fs.existsSync(localPkgPath)) {
        localPkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf-8'));
      }

      const updatedFiles = [];

      for (const file of coreFiles) {
        try {
          const remoteContent = await this.httpGetText(`${rawBase}/${file}`);
          const localPath = path.join(this.appRoot, file);
          let localContent = '';
          if (fs.existsSync(localPath)) {
            localContent = fs.readFileSync(localPath, 'utf-8');
          }

          // If content differs, update file
          if (remoteContent !== localContent) {
            fs.writeFileSync(localPath, remoteContent, 'utf-8');
            updatedFiles.push(file);
          }
        } catch (fileErr) {
          // File might not exist in repo, ignore
        }
      }

      if (updatedFiles.length > 0) {
        if (this.onUpdateApplied) {
          this.onUpdateApplied({
            version: remotePkg.version || '1.0.0',
            updatedFiles
          });
        }
        return true;
      } else {
        if (!silent && this.onStatus) {
          this.onStatus('Uygulamanız en son sürümde, güncel! ✅');
        }
        return false;
      }
    } catch (e) {
      if (!silent && this.onError) {
        this.onError(`Güncelleme denetlenemedi: ${e.message}`);
      }
      return false;
    }
  }

  httpGetText(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https://') ? https : http;

      const req = client.get(url, {
        headers: {
          'User-Agent': 'ChatTarayici-Updater',
          'Cache-Control': 'no-cache, no-store'
        },
        timeout: 10000
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.httpGetText(res.headers.location).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Zaman aşımı (Timeout)'));
      });
    });
  }
}

module.exports = CentralUpdater;
