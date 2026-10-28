const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

class CentralUpdater {
  constructor(options = {}) {
    this.appRoot = options.appRoot || __dirname;
    this.configPath = options.configPath || path.join(this.appRoot, 'update-config.json');
    this.appVersion = options.appVersion || this.readLocalVersion();
    this.isPackaged = Boolean(options.isPackaged);
    this.downloadDir = options.downloadDir || os.tmpdir();
    this.onError = options.onError || null;
    this.onStatus = options.onStatus || null;
    this.onInstall = options.onInstall || null;
    this.updateInProgress = false;

    this.config = { githubRepo: 'omerFlix/Chattaray-c-' };
    this.loadConfig();
  }

  readLocalVersion() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.appRoot, 'package.json'), 'utf-8')).version || '1.0.0';
    } catch {
      return '1.0.0';
    }
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
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.error('Failed to save update config:', e);
    }
  }

  async checkForUpdates(silent = false, installAutomatically = true) {
    if (this.updateInProgress) return false;

    const repo = (this.config.githubRepo || '').trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/$/, '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      if (!silent && this.onError) this.onError('GitHub deposunu kullanici/repo biçiminde girin.');
      return false;
    }
    this.updateInProgress = true;

    try {
      if (!silent && this.onStatus) this.onStatus('GitHub sürümü denetleniyor...');

      const releaseText = await this.httpGetText(`https://api.github.com/repos/${repo}/releases/latest`);
      const release = JSON.parse(releaseText);
      const remoteVersion = String(release.tag_name || '').replace(/^v/i, '').trim();
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(remoteVersion)) {
        throw new Error('GitHub Release sürüm etiketi okunamadı.');
      }

      const comparison = CentralUpdater.compareVersions(remoteVersion, this.appVersion);
      if (comparison <= 0) {
        if (!silent && this.onStatus) this.onStatus(`Uygulama güncel (v${this.appVersion}).`);
        return false;
      }

      if (this.onStatus) this.onStatus(`GitHub'da v${remoteVersion} bulundu; kurulum indiriliyor...`);
      if (!installAutomatically || !this.isPackaged) {
        if (!silent && this.onStatus) {
          this.onStatus(`Yeni v${remoteVersion} bulundu. Kurulum dosyası: ${release.html_url || `https://github.com/${repo}/releases/latest`}`);
        }
        return true;
      }

      let installerAsset = null;
      if (process.platform === 'win32') {
        installerAsset = Array.isArray(release.assets)
          ? release.assets.find(asset => /setup.*\.exe$/i.test(asset.name || '') || /\.exe$/i.test(asset.name || ''))
          : null;
        if (!installerAsset || !installerAsset.browser_download_url) {
          throw new Error('GitHub Release içinde Windows Setup .exe dosyası bulunamadı.');
        }
      } else if (process.platform === 'linux') {
        installerAsset = Array.isArray(release.assets)
          ? release.assets.find(asset => /\.deb$/i.test(asset.name || '') || /\.AppImage$/i.test(asset.name || '') || /\.tar\.gz$/i.test(asset.name || ''))
          : null;
        if (!installerAsset || !installerAsset.browser_download_url) {
          throw new Error('GitHub Release içinde Linux (.deb / .AppImage) paketi bulunamadı.');
        }
      } else {
        throw new Error('Bu işletim sistemi için otomatik güncelleme desteklenmiyor.');
      }

      const installerPath = await this.downloadInstaller(installerAsset, remoteVersion);
      if (!this.onInstall) throw new Error('Güncelleme kurulumunu başlatacak işlem ayarlanmamış.');

      if (this.onStatus) this.onStatus(`v${remoteVersion} indirildi. Güncelleme kurulumu başlatılıyor...`);
      await this.onInstall(installerPath);
      return true;
    } catch (e) {
      if (e.statusCode === 404) {
        if (!silent && this.onStatus) this.onStatus('GitHub deposunda henüz yayımlanmış bir kurulum sürümü yok.');
      } else if (!silent && this.onError) {
        this.onError(`GitHub güncellemesi alınamadı: ${e.message}`);
      }
      return false;
    } finally {
      this.updateInProgress = false;
    }
  }

  async downloadInstaller(asset, version) {
    const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, '_');
    const installerPath = path.join(this.downloadDir, `ChatTarayici-Setup-${safeVersion}-${process.pid}.exe`);
    const partialPath = `${installerPath}.part`;
    fs.mkdirSync(this.downloadDir, { recursive: true });

    try {
      await this.downloadFile(asset.browser_download_url, partialPath, asset.digest || null);
      fs.renameSync(partialPath, installerPath);
      return installerPath;
    } catch (e) {
      try { fs.rmSync(partialPath, { force: true }); } catch {}
      throw e;
    }
  }

  downloadFile(url, destination, expectedDigest) {
    return new Promise((resolve, reject) => {
      const requestUrl = (target, redirects = 0) => {
        let parsed;
        try {
          parsed = new URL(target);
        } catch {
          reject(new Error('GitHub indirme adresi geçersiz.'));
          return;
        }

        if (parsed.protocol !== 'https:') {
          reject(new Error('Güncelleme yalnızca HTTPS üzerinden indirilebilir.'));
          return;
        }

        const request = https.get(parsed, {
          headers: { 'User-Agent': 'ChatTarayici-Updater' },
          timeout: 60000
        }, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            if (redirects >= 5) {
              reject(new Error('GitHub indirmesi çok fazla yönlendirme yaptı.'));
              return;
            }
            requestUrl(new URL(response.headers.location, parsed).href, redirects + 1);
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`Kurulum indirilemedi (HTTP ${response.statusCode}).`));
            return;
          }

          const digest = crypto.createHash('sha256');
          const output = fs.createWriteStream(destination);
          response.on('data', chunk => digest.update(chunk));
          response.on('error', reject);
          output.on('error', reject);
          output.on('finish', () => {
            output.close(() => {
              const actualDigest = `sha256:${digest.digest('hex')}`;
              if (expectedDigest && actualDigest.toLowerCase() !== String(expectedDigest).toLowerCase()) {
                try { fs.rmSync(destination, { force: true }); } catch {}
                reject(new Error('İndirilen kurulum dosyasının SHA-256 doğrulaması başarısız.'));
                return;
              }
              resolve(destination);
            });
          });
          response.pipe(output);
        });

        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error('Kurulum indirme zaman aşımına uğradı.')));
      };

      requestUrl(url);
    });
  }

  httpGetText(url) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, {
        headers: {
          'User-Agent': 'ChatTarayici-Updater',
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Cache-Control': 'no-cache, no-store'
        },
        timeout: 15000
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          this.httpGetText(response.headers.location).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          const error = new Error(`HTTP ${response.statusCode}`);
          error.statusCode = response.statusCode;
          response.resume();
          reject(error);
          return;
        }

        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve(data));
        response.on('error', reject);
      });

      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('Zaman aşımı (Timeout)')));
    });
  }

  static compareVersions(left, right) {
    const parse = (value) => {
      const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/i.exec(String(value).trim());
      if (!match) throw new Error(`Geçersiz uygulama sürümü: ${value}`);
      return {
        core: match.slice(1, 4).map(part => Number.parseInt(part, 10)),
        prerelease: match[4] ? match[4].split('.') : []
      };
    };

    const leftVersion = parse(left);
    const rightVersion = parse(right);
    for (let index = 0; index < 3; index += 1) {
      if (leftVersion.core[index] > rightVersion.core[index]) return 1;
      if (leftVersion.core[index] < rightVersion.core[index]) return -1;
    }

    if (!leftVersion.prerelease.length && !rightVersion.prerelease.length) return 0;
    if (!leftVersion.prerelease.length) return 1;
    if (!rightVersion.prerelease.length) return -1;

    const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
    for (let index = 0; index < length; index += 1) {
      const leftPart = leftVersion.prerelease[index];
      const rightPart = rightVersion.prerelease[index];
      if (leftPart === undefined) return -1;
      if (rightPart === undefined) return 1;
      if (leftPart === rightPart) continue;

      const leftIsNumber = /^\d+$/.test(leftPart);
      const rightIsNumber = /^\d+$/.test(rightPart);
      if (leftIsNumber && rightIsNumber) {
        return Number(leftPart) > Number(rightPart) ? 1 : -1;
      }
      if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1;
      return leftPart > rightPart ? 1 : -1;
    }
    return 0;
  }
}

module.exports = CentralUpdater;
