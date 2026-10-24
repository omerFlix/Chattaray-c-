const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class CentralUpdater {
  constructor(options = {}) {
    this.appRoot = options.appRoot || __dirname;
    this.configPath = options.configPath || path.join(this.appRoot, 'update-config.json');

    // Default configuration: central GitHub repo
    this.config = {
      githubRepo: 'omerFlix/Chattaray-c-', // GitHub kullanıcı/repo adı
      branch: 'main',
      autoCheck: false,
      checkIntervalMinutes: 10
    };

    this.loadConfig();
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
      if (!silent && this.onStatus) this.onStatus('Merkezi güncelleme kontrol ediliyor...');

      const rawBase = 'https://raw.githubusercontent.com/' + repo + '/' + branch;
      const remotePkgStr = await this.httpGetText(rawBase + '/package.json');
      const remotePkg = JSON.parse(remotePkgStr);

      const localPkgPath = path.join(this.appRoot, 'package.json');
      let localPkg = { version: '1.0.0' };
      if (fs.existsSync(localPkgPath)) {
        localPkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf-8'));
      }

      const remoteVersion = remotePkg.version || '1.0.0';
      const localVersion = localPkg.version || '1.0.0';
      const updateAvailable = remoteVersion !== localVersion;

      if (!silent && this.onStatus) {
        this.onStatus(updateAvailable
          ? 'Depoda ' + remoteVersion + ' sürümü var. Güncellemeyi yayınlanan kurulum dosyasından yükleyin.'
          : 'Uygulamanız güncel (' + localVersion + ').');
      }

      // This tool only checks versions. It must never overwrite the running app's source files.
      return updateAvailable;
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
