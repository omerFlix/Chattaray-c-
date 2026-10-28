const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version || '1.0.0';
const packageName = 'chat-tarayici';
const arch = 'amd64';
const debFileName = `${packageName}_${version}_${arch}.deb`;

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const linuxUnpacked = path.join(distDir, 'linux-unpacked');
const stagingDir = path.join(distDir, 'deb-staging');

console.log(`📦 [Pardus/Debian] ${packageName} v${version} debian paketi hazırlanıyor...`);

// 1. Linux unpacked klasörünün var olduğunu kontrol et veya üret
if (!fs.existsSync(linuxUnpacked) || !fs.existsSync(path.join(linuxUnpacked, 'chat-tarayici'))) {
  console.log('⚙️ linux-unpacked bulunamadı, electron-builder ile derleniyor...');
  execSync('npx electron-builder --linux dir', { cwd: projectRoot, stdio: 'inherit' });
}

// 2. Temiz staging dizini oluştur
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });

const controlDir = path.join(stagingDir, 'control');
const dataDir = path.join(stagingDir, 'data');
fs.mkdirSync(controlDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

// 3. debian-binary oluştur
const debianBinaryContent = Buffer.from('2.0\n', 'utf8');

// 4. data yapısını hazırla:
// /opt/chat-tarayici/...
const optAppDir = path.join(dataDir, 'opt', packageName);
fs.mkdirSync(optAppDir, { recursive: true });
console.log('📁 Uygulama dosyaları /opt/chat-tarayici konumuna kopyalanıyor...');
fs.cpSync(linuxUnpacked, optAppDir, { recursive: true });

// /usr/bin/chat-tarayici
const usrBinDir = path.join(dataDir, 'usr', 'bin');
fs.mkdirSync(usrBinDir, { recursive: true });
const launcherScript = `#!/bin/sh\nexec /opt/${packageName}/chat-tarayici --no-sandbox "$@"\n`;
fs.writeFileSync(path.join(usrBinDir, packageName), launcherScript, { mode: 0o755 });

// /usr/share/applications/chat-tarayici.desktop
const desktopDir = path.join(dataDir, 'usr', 'share', 'applications');
fs.mkdirSync(desktopDir, { recursive: true });
const desktopContent = `[Desktop Entry]
Name=ChatTarayici
Comment=ChatTarayıcı - Modern Web Tarayıcısı (Pardus ETAP Uyumlu)
GenericName=Web Tarayıcısı
Exec=/opt/${packageName}/chat-tarayici --no-sandbox %U
Icon=${packageName}
Type=Application
StartupNotify=true
Categories=Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml_xml;x-scheme-handler/http;x-scheme-handler/https;
Terminal=false
`;
fs.writeFileSync(path.join(desktopDir, `${packageName}.desktop`), desktopContent, 'utf8');

// /usr/share/pixmaps/chat-tarayici.png ve hicolor icons
const pixmapsDir = path.join(dataDir, 'usr', 'share', 'pixmaps');
fs.mkdirSync(pixmapsDir, { recursive: true });
const iconSource = path.join(projectRoot, 'icon.png');
if (fs.existsSync(iconSource)) {
  fs.copyFileSync(iconSource, path.join(pixmapsDir, `${packageName}.png`));
  const hicolorDir = path.join(dataDir, 'usr', 'share', 'icons', 'hicolor', '128x128', 'apps');
  fs.mkdirSync(hicolorDir, { recursive: true });
  fs.copyFileSync(iconSource, path.join(hicolorDir, `${packageName}.png`));
}

// Toplam kurulu boyutu hesapla (KB)
function getDirectorySize(dirPath) {
  let size = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) size += getDirectorySize(full);
    else if (entry.isFile()) size += fs.statSync(full).size;
  }
  return size;
}
const installedSizeKb = Math.ceil(getDirectorySize(dataDir) / 1024);

// 5. control dosyası oluştur
const controlContent = `Package: ${packageName}
Version: ${version}
Section: web
Priority: optional
Architecture: ${arch}
Installed-Size: ${installedSizeKb}
Maintainer: omerFlix <omerflix@example.com>
Depends: libnotify4, libnss3, libxss1, libasound2, libsecret-1-0, xdg-utils
Description: ChatTarayıcı - Modern Web Tarayıcısı
 ChatTarayıcı - Pardus ETAP ve Linux için Eklenti Destekli Modern Web Tarayıcısı.
 Okul akıllı tahtaları (Pardus ETAP) ve masaüstü sistemlerde hızlı, güvenli web gezintisi.
`;
fs.writeFileSync(path.join(controlDir, 'control'), controlContent, 'utf8');

// 6. tar.gz paketlerini oluştur
const controlTarGz = path.join(stagingDir, 'control.tar.gz');
const dataTarGz = path.join(stagingDir, 'data.tar.gz');

console.log('📦 control.tar.gz ve data.tar.gz arşivleniyor...');
execSync(`tar.exe -czf "${controlTarGz}" -C "${controlDir}" .`);
execSync(`tar.exe -czf "${dataTarGz}" -C "${dataDir}" .`);

const controlBuffer = fs.readFileSync(controlTarGz);
const dataBuffer = fs.readFileSync(dataTarGz);

// 7. AR (Debian) arşiv başlığı oluşturucu
function createArHeader(name, size, mode = 0o100644) {
  const buf = Buffer.alloc(60, 0x20);
  buf.write(name.padEnd(16, ' '), 0, 16, 'ascii');
  buf.write(String(Math.floor(Date.now() / 1000)).padEnd(12, ' '), 16, 12, 'ascii');
  buf.write('0'.padEnd(6, ' '), 28, 6, 'ascii');
  buf.write('0'.padEnd(6, ' '), 34, 6, 'ascii');
  buf.write(mode.toString(8).padEnd(8, ' '), 40, 8, 'ascii');
  buf.write(String(size).padEnd(10, ' '), 48, 10, 'ascii');
  buf[58] = 0x60;
  buf[59] = 0x0a;
  return buf;
}

function padOdd(buf) {
  return buf.length % 2 === 1 ? Buffer.concat([buf, Buffer.from('\n')]) : buf;
}

const finalDebPath = path.join(distDir, debFileName);
const arMagic = Buffer.from('!<arch>\n', 'ascii');

const debianBinaryHeader = createArHeader('debian-binary', debianBinaryContent.length);
const controlHeader = createArHeader('control.tar.gz', controlBuffer.length);
const dataHeader = createArHeader('data.tar.gz', dataBuffer.length);

const debFile = fs.createWriteStream(finalDebPath);
debFile.write(arMagic);

debFile.write(debianBinaryHeader);
debFile.write(padOdd(debianBinaryContent));

debFile.write(controlHeader);
debFile.write(padOdd(controlBuffer));

debFile.write(dataHeader);
debFile.write(padOdd(dataBuffer));

debFile.end(() => {
  const debStats = fs.statSync(finalDebPath);
  console.log(`✅ [BAŞARILI] Pardus ETAP / Debian paketi oluşturuldu:`);
  console.log(`   📄 Dosya: ${finalDebPath}`);
  console.log(`   📊 Boyut: ${(debStats.size / (1024 * 1024)).toFixed(2)} MB`);

  // staging temizliği
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {}
});
