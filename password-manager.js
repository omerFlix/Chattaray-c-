const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class PasswordManager {
  constructor(storagePath) {
    this.storagePath = storagePath;
    this.passwords = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.passwords = Array.isArray(parsed) ? parsed : [];
      } else {
        this.passwords = [];
      }
    } catch (e) {
      console.warn('Failed to load passwords:', e.message);
      this.passwords = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.passwords, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.warn('Failed to save passwords:', e.message);
      return false;
    }
  }

  getAll() {
    return this.passwords;
  }

  add(entry) {
    if (!entry || !entry.username) return null;

    let siteName = entry.name;
    if (!siteName && entry.url) {
      try {
        siteName = new URL(entry.url).hostname.replace(/^www\./, '');
      } catch {
        siteName = entry.url;
      }
    }

    // Check if entry for same origin + username already exists
    const existingIndex = this.passwords.findIndex(
      p => (p.url === entry.url || this.normalizeDomain(p.url) === this.normalizeDomain(entry.url)) &&
           p.username.toLowerCase() === entry.username.toLowerCase()
    );

    const record = {
      id: entry.id || crypto.randomUUID(),
      url: entry.url || '',
      name: siteName || 'Web Sitesi',
      username: entry.username,
      password: entry.password || '',
      createdAt: entry.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    if (existingIndex >= 0) {
      record.id = this.passwords[existingIndex].id;
      record.createdAt = this.passwords[existingIndex].createdAt;
      this.passwords[existingIndex] = record;
    } else {
      this.passwords.unshift(record);
    }

    this.save();
    return record;
  }

  delete(id) {
    const beforeCount = this.passwords.length;
    this.passwords = this.passwords.filter(p => p.id !== id);
    if (this.passwords.length !== beforeCount) {
      this.save();
      return true;
    }
    return false;
  }

  normalizeDomain(urlStr) {
    if (!urlStr) return '';
    try {
      return new URL(urlStr).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return urlStr.toLowerCase();
    }
  }

  findByUrl(targetUrl) {
    if (!targetUrl) return [];
    const domain = this.normalizeDomain(targetUrl);
    if (!domain) return [];

    return this.passwords.filter(p => {
      const pDomain = this.normalizeDomain(p.url);
      return pDomain && (pDomain === domain || domain.endsWith('.' + pDomain) || pDomain.endsWith('.' + domain));
    });
  }

  importBatch(entries) {
    let added = 0;
    let updated = 0;

    for (const entry of entries) {
      if (!entry.username && !entry.password) continue;
      const domain = this.normalizeDomain(entry.url);
      const existing = this.passwords.find(
        p => this.normalizeDomain(p.url) === domain &&
             p.username.toLowerCase() === (entry.username || '').toLowerCase()
      );

      if (existing) {
        if (entry.password) {
          existing.password = entry.password;
          existing.updatedAt = Date.now();
          updated++;
        }
      } else {
        let siteName = entry.name;
        if (!siteName && entry.url) {
          try {
            siteName = new URL(entry.url).hostname.replace(/^www\./, '');
          } catch {
            siteName = entry.url;
          }
        }
        this.passwords.push({
          id: entry.id || crypto.randomUUID(),
          url: entry.url || '',
          name: siteName || 'Web Sitesi',
          username: entry.username || '',
          password: entry.password || '',
          createdAt: entry.createdAt || Date.now(),
          updatedAt: Date.now()
        });
        added++;
      }
    }

    if (added > 0 || updated > 0) {
      this.save();
    }

    return { added, updated, total: this.passwords.length };
  }

  exportCsv() {
    const header = 'name,url,username,password';
    const rows = this.passwords.map(p => {
      const name = `"${(p.name || '').replace(/"/g, '""')}"`;
      const url = `"${(p.url || '').replace(/"/g, '""')}"`;
      const username = `"${(p.username || '').replace(/"/g, '""')}"`;
      const password = `"${(p.password || '').replace(/"/g, '""')}"`;
      return `${name},${url},${username},${password}`;
    });
    return [header, ...rows].join('\r\n');
  }
}

module.exports = PasswordManager;
