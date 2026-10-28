const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const initSqlJs = require('sql.js');

let sqlPromise = null;
function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs();
  }
  return sqlPromise;
}

class ChromeImporter {
  static getChromeUserDataDirs() {
    const dirs = [];
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const chromeDir = path.join(localAppData, 'Google', 'Chrome', 'User Data');
      if (fs.existsSync(chromeDir)) {
        dirs.push({ name: 'Google Chrome', path: chromeDir });
      }
      const edgeDir = path.join(localAppData, 'Microsoft', 'Edge', 'User Data');
      if (fs.existsSync(edgeDir)) {
        dirs.push({ name: 'Microsoft Edge', path: edgeDir });
      }
      const braveDir = path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data');
      if (fs.existsSync(braveDir)) {
        dirs.push({ name: 'Brave Browser', path: braveDir });
      }
    } else if (process.platform === 'linux') {
      const chromeDir = path.join(os.homedir(), '.config', 'google-chrome');
      if (fs.existsSync(chromeDir)) {
        dirs.push({ name: 'Google Chrome', path: chromeDir });
      }
      const chromiumDir = path.join(os.homedir(), '.config', 'chromium');
      if (fs.existsSync(chromiumDir)) {
        dirs.push({ name: 'Chromium', path: chromiumDir });
      }
    }
    return dirs;
  }

  static getProfiles(browserUserDataDir) {
    if (!browserUserDataDir || !fs.existsSync(browserUserDataDir)) return [];

    let profileNames = [];
    try {
      profileNames = fs.readdirSync(browserUserDataDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
        .map(d => d.name)
        .sort((a, b) => a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b));
    } catch {
      return [];
    }

    const profiles = [];
    for (const pName of profileNames) {
      const profilePath = path.join(browserUserDataDir, pName);
      let displayName = pName === 'Default' ? 'Varsayılan Profil' : pName;
      let email = '';
      let hasBookmarks = fs.existsSync(path.join(profilePath, 'Bookmarks'));
      let hasHistory = fs.existsSync(path.join(profilePath, 'History'));
      let hasLogins = fs.existsSync(path.join(profilePath, 'Login Data'));

      const prefPath = path.join(profilePath, 'Preferences');
      if (fs.existsSync(prefPath)) {
        try {
          const pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
          if (pref.profile && pref.profile.name) displayName = pref.profile.name;
          if (pref.account_info && pref.account_info[0] && pref.account_info[0].email) {
            email = pref.account_info[0].email;
          }
        } catch {}
      }

      profiles.push({
        id: pName,
        name: displayName,
        email: email,
        path: profilePath,
        hasBookmarks,
        hasHistory,
        hasLogins
      });
    }

    return profiles;
  }

  static getWindowsMasterKey(browserUserDataDir) {
    if (process.platform !== 'win32') return null;

    const localStatePath = path.join(browserUserDataDir, 'Local State');
    if (!fs.existsSync(localStatePath)) return null;

    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
      const encKeyB64 = localState?.os_crypt?.encrypted_key;
      if (!encKeyB64) return null;

      const encBytes = Buffer.from(encKeyB64, 'base64');
      const rawEncKey = encBytes.subarray(5); // strip DPAPI prefix

      const tempDir = path.join(os.tmpdir(), 'chattarayici-dpapi');
      fs.mkdirSync(tempDir, { recursive: true });
      const tempEncPath = path.join(tempDir, `enc_${Date.now()}.bin`);
      const tempDecPath = path.join(tempDir, `dec_${Date.now()}.bin`);
      fs.writeFileSync(tempEncPath, rawEncKey);

      const psScript = `
        Add-Type -AssemblyName System.Security;
        $bytes = [System.IO.File]::ReadAllBytes('${tempEncPath.replace(/\\/g, '/')}');
        $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
        [System.IO.File]::WriteAllBytes('${tempDecPath.replace(/\\/g, '/')}', $dec);
      `.replace(/\r?\n/g, ' ');

      execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, {
        windowsHide: true,
        stdio: 'ignore'
      });

      if (fs.existsSync(tempDecPath)) {
        const masterKey = fs.readFileSync(tempDecPath);
        try { fs.unlinkSync(tempEncPath); } catch {}
        try { fs.unlinkSync(tempDecPath); } catch {}
        return masterKey;
      }
    } catch (e) {
      console.warn('Could not extract Windows DPAPI master key:', e.message);
    }
    return null;
  }

  static importBookmarks(profilePath) {
    const bookmarks = [];
    const bookmarksPath = path.join(profilePath, 'Bookmarks');
    if (!fs.existsSync(bookmarksPath)) return bookmarks;

    try {
      const data = JSON.parse(fs.readFileSync(bookmarksPath, 'utf8'));
      function traverse(node) {
        if (!node) return;
        if (node.type === 'url' && node.url && (node.url.startsWith('http://') || node.url.startsWith('https://'))) {
          bookmarks.push({
            title: node.name || node.url,
            url: node.url,
            dateAdded: node.date_added ? parseInt(node.date_added) : Date.now()
          });
        }
        if (node.children && Array.isArray(node.children)) {
          for (const child of node.children) {
            traverse(child);
          }
        }
      }

      if (data.roots) {
        if (data.roots.bookmark_bar) traverse(data.roots.bookmark_bar);
        if (data.roots.other) traverse(data.roots.other);
        if (data.roots.synced) traverse(data.roots.synced);
      }
    } catch (e) {
      console.warn('Could not read Chrome bookmarks:', e.message);
    }

    return bookmarks;
  }

  static async importHistory(profilePath, limit = 500) {
    const historyEntries = [];
    const historyPath = path.join(profilePath, 'History');
    if (!fs.existsSync(historyPath)) return historyEntries;

    const tempDir = path.join(os.tmpdir(), 'chattarayici-history');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempDbPath = path.join(tempDir, `hist_${Date.now()}.db`);

    try {
      fs.copyFileSync(historyPath, tempDbPath);
      const dbBuffer = fs.readFileSync(tempDbPath);
      const SQL = await getSql();
      const db = new SQL.Database(dbBuffer);
      const result = db.exec(`SELECT url, title, visit_count, last_visit_time FROM urls WHERE url LIKE 'http%' ORDER BY last_visit_time DESC LIMIT ${limit}`);

      if (result.length > 0 && result[0].values) {
        for (const row of result[0].values) {
          const url = row[0];
          const title = row[1] || url;
          const visitCount = row[2] || 1;
          // Chrome timestamps are microseconds since Jan 1, 1601 UTC
          const chromeTime = row[3];
          let timestamp = Date.now();
          if (typeof chromeTime === 'number' && chromeTime > 0) {
            timestamp = Math.floor((chromeTime - 11644473600000000) / 1000);
            if (timestamp < 0 || isNaN(timestamp)) timestamp = Date.now();
          }

          historyEntries.push({
            url,
            title,
            visitCount,
            timestamp,
            date: new Date(timestamp).toLocaleDateString('tr-TR'),
            time: new Date(timestamp).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
          });
        }
      }
      db.close();
    } catch (e) {
      console.warn('Could not read Chrome history:', e.message);
    } finally {
      try { fs.unlinkSync(tempDbPath); } catch {}
    }

    return historyEntries;
  }

  static async importPasswords(profilePath, masterKey = null) {
    const passwords = [];
    const loginDataPath = path.join(profilePath, 'Login Data');
    if (!fs.existsSync(loginDataPath)) return passwords;

    const tempDir = path.join(os.tmpdir(), 'chattarayici-logins');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempDbPath = path.join(tempDir, `login_${Date.now()}.db`);

    try {
      fs.copyFileSync(loginDataPath, tempDbPath);
      const dbBuffer = fs.readFileSync(tempDbPath);
      const SQL = await getSql();
      const db = new SQL.Database(dbBuffer);
      const result = db.exec("SELECT origin_url, action_url, username_value, password_value, date_created FROM logins WHERE username_value != ''");

      if (result.length > 0 && result[0].values) {
        for (const row of result[0].values) {
          const originUrl = row[0] || row[1] || '';
          const username = row[2] || '';
          const passBlob = row[3];
          let decryptedPassword = '';

          if (passBlob && passBlob.length > 0) {
            if (masterKey && passBlob.length > 15) {
              const prefix = Buffer.from(passBlob.subarray(0, 3)).toString('ascii');
              if (prefix === 'v10' || prefix === 'v11') {
                const iv = Buffer.from(passBlob.subarray(3, 15));
                const ciphertext = Buffer.from(passBlob.subarray(15, passBlob.length - 16));
                const tag = Buffer.from(passBlob.subarray(passBlob.length - 16));
                try {
                  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
                  decipher.setAuthTag(tag);
                  decryptedPassword = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
                } catch {}
              }
            } else if (process.platform === 'linux') {
              // Linux Chrome fallback encryption
              try {
                const key = crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
                const iv = Buffer.alloc(16, ' ');
                const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
                decryptedPassword = Buffer.concat([decipher.update(Buffer.from(passBlob.subarray(3))), decipher.final()]).toString('utf8');
              } catch {}
            }
          }

          if (username) {
            let siteName = originUrl;
            try {
              siteName = new URL(originUrl).hostname.replace(/^www\./, '');
            } catch {}

            passwords.push({
              id: crypto.randomUUID(),
              url: originUrl,
              name: siteName,
              username: username,
              password: decryptedPassword,
              createdAt: Date.now()
            });
          }
        }
      }
      db.close();
    } catch (e) {
      console.warn('Could not read Chrome passwords:', e.message);
    } finally {
      try { fs.unlinkSync(tempDbPath); } catch {}
    }

    return passwords;
  }

  static importSettings(profilePath) {
    const settings = {
      searchEngine: 'https://www.google.com/search?q=',
      homepage: 'about:newtab',
      downloadPath: ''
    };

    const prefPath = path.join(profilePath, 'Preferences');
    if (!fs.existsSync(prefPath)) return settings;

    try {
      const pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
      if (pref.download && pref.download.default_directory) {
        settings.downloadPath = pref.download.default_directory;
      }
      if (pref.homepage) {
        settings.homepage = pref.homepage;
      }
      if (pref.default_search_provider_data && pref.default_search_provider_data.template_url_data) {
        const url = pref.default_search_provider_data.template_url_data.url;
        if (url && url.includes('{searchTerms}')) {
          settings.searchEngine = url.replace('{searchTerms}', '');
        }
      }
    } catch (e) {
      console.warn('Could not read Chrome settings:', e.message);
    }

    return settings;
  }

  static parsePasswordsCsv(csvText) {
    const passwords = [];
    if (!csvText || typeof csvText !== 'string') return passwords;

    const lines = csvText.split(/\r?\n/);
    if (lines.length < 2) return passwords;

    // Detect column indexes from header
    const header = lines[0].toLowerCase();
    const cols = header.split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
    let nameIdx = cols.indexOf('name');
    let urlIdx = cols.indexOf('url');
    let userIdx = cols.indexOf('username');
    let passIdx = cols.indexOf('password');

    // Default fallbacks if header matches standard Chrome export: name,url,username,password
    if (urlIdx === -1) urlIdx = 1;
    if (userIdx === -1) userIdx = 2;
    if (passIdx === -1) passIdx = 3;
    if (nameIdx === -1) nameIdx = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Handle CSV comma splitting respecting quotes
      const values = [];
      let inQuote = false;
      let currentVal = '';
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '"' || char === "'") {
          inQuote = !inQuote;
        } else if (char === ',' && !inQuote) {
          values.push(currentVal.trim().replace(/^["']|["']$/g, ''));
          currentVal = '';
        } else {
          currentVal += char;
        }
      }
      values.push(currentVal.trim().replace(/^["']|["']$/g, ''));

      const url = values[urlIdx] || values[nameIdx] || '';
      const username = values[userIdx] || '';
      const password = values[passIdx] || '';
      let name = values[nameIdx] || url;
      try {
        if (url) name = new URL(url).hostname.replace(/^www\./, '');
      } catch {}

      if (username || password) {
        passwords.push({
          id: crypto.randomUUID(),
          url,
          name: name || url || 'Bilinmeyen Site',
          username,
          password,
          createdAt: Date.now()
        });
      }
    }

    return passwords;
  }

  static parseBookmarksHtml(htmlText) {
    const bookmarks = [];
    if (!htmlText || typeof htmlText !== 'string') return bookmarks;

    const regex = /<A\s+HREF=["']([^"']+)["'][^>]*>(.*?)<\/A>/gi;
    let match;
    while ((match = regex.exec(htmlText)) !== null) {
      const url = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        bookmarks.push({
          title: title || url,
          url: url,
          dateAdded: Date.now()
        });
      }
    }
    return bookmarks;
  }
}

module.exports = ChromeImporter;
