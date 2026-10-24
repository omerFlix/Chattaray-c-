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
      githubRepo: 'omerFlix/Chattaray-c-' // GitHub kullanıcı/repo adı
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
    const repo = (this.config.githubRepo || '').trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/$/, '');
    if (!repo) {
      if (!silent && this.onError) {
        this.onError('GitHub repository adı ayarlanmamış!');
      }
      return false;
    }

    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      if (!silent && this.onError) this.onError('GitHub deposunu kullanici/repo biçiminde girin.');
      return false;
    }

    try {
      if (!silent && this.onStatus) this.onStatus('Merkezi güncelleme kontrol ediliyor...');

      // A source-control package.json change is not a published app build.
      // Only compare against an actual GitHub Release to avoid false updates.
      const releaseText = await this.httpGetText('https://api.github.com/repos/' + repo + '/releases/latest');
      const release = JSON.parse(releaseText);

      const localPkgPath = path.join(this.appRoot, 'package.json');
      let localPkg = { version: '1.0.0' };
      if (fs.existsSync(localPkgPath)) {
        localPkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf-8'));
      }

      const remoteVersion = String(release.tag_name || '').replace(/^v/i, '').trim();
      if (!remoteVersion) throw new Error('GitHub sürüm etiketi bulunamadı.');
      const localVersion = localPkg.version || '1.0.0';
      const updateAvailable = remoteVersion !== localVersion;

      if (!silent && this.onStatus) {
        this.onStatus(updateAvailable
          ? 'GitHub Releases bölümünde v' + remoteVersion + ' yayınlanmış. Kurulum dosyasını buradan indirin: ' + (release.html_url || 'https://github.com/' + repo + '/releases/latest')
          : 'Yayınlanmış kurulum sürümünüz güncel (v' + localVersion + ').');
      }

      // This tool only checks published releases. It never overwrites app files.
      return updateAvailable;
    } catch (e) {
      if (e.statusCode === 404) {
        if (!silent && this.onStatus) {
          this.onStatus('Bu depoda yayımlanmış bir GitHub Release yok. package.json değişikliği kurulum güncellemesi sayılmaz.');
        }
        return false;
      }
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
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Cache-Control': 'no-cache, no-store'
        },
        timeout: 10000
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.httpGetText(res.headers.location).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          const error = new Error(`HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          reject(error);
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
