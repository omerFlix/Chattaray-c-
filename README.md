# 🌐 ChatTarayıcı

Chromium (Electron) tabanlı, eklenti destekli modern web tarayıcısı.

---

## 📥 İndir & Kur (Windows & PARDUS-ETAP)

Hiçbir şey yüklemeye gerek yok! İşletim sisteminize uygun olanı indirip hemen kullanabilirsiniz:

### 🪟 Windows (.exe)
👉 **[⬇️ Windows Setup'ı İndir](https://github.com/omerFlix/Chattaray-c-/releases/latest)** *(Çift tıklayın, masaüstünüze kısayol eklenir ve anında açılır)*

### 🐧 PARDUS-ETAP / Debian (.deb)
👉 **[⬇️ Pardus ETAP (.deb) Paketini İndir](https://github.com/omerFlix/Chattaray-c-/releases/latest)**
- **Kurulum**: İndirdiğiniz `.deb` dosyasına çift tıklayıp **Pardus Paket Kurucu** ile "Paket Kur" butonuna basın veya terminalden şu komutu girin:
  ```bash
  sudo dpkg -i chat-tarayici_*_amd64.deb
  ```
- **Akıllı Tahta Desteği**: Dokunmatik ekran (touch events), jestle kaydırma ve MEB Fatih okul ağı sertifikaları tam uyumludur.

---

## ✨ Özellikler & İyileştirmeler

- 🔄 **Google Chrome Verilerini İçe Aktarma**: Google Chrome, Edge ve Brave üzerindeki yer işaretleri, kayıtlı şifreler, tarama geçmişi ve arama motoru ayarlarını tek tıkla ChatTarayıcı'ya taşıyın.
- 🔑 **Chrome Tarzı Şifre Yöneticisi**: Kayıtlı şifreleri görüntüleme, arama, kopyalama, silme; Google Chrome'dan doğrudan veya `passwords.csv` dosyasından içe ve dışa aktarma.
- ⚡ **Otomatik Şifre Doldurma & Kaydetme**: Web sitelerine giriş yaparken kayıtlı hesapları otomatik doldurur; yeni giriş yapıldığında Chrome'daki gibi *"Bu sitenin şifresi kaydedilsin mi?"* bildirim balonu açar.
- ⚙️ **Google Chrome Tarzı Ayarlar Ekranı**: Arama motoru seçimi (Google, Yandex, Bing, DuckDuckGo), açılış sayfası, indirme konumu ve gizlilik seçeneklerini barındıran modern ayarlar arayüzü.
- 🔖 **Yer İşaretleri Çubuğu**: Chrome'daki gibi `Ctrl+Shift+B` kısayoluyla tek tuşla açılıp kapanabilen hızlı erişim çubuğu.
- 🚀 **Chromium Motoru & Hızlı Gezinti**: Standart Chrome User-Agent sayesinde Google, Cloudflare, EBA, YouTube gibi sitelerde engelleme ve donma yaşanmaz.
- 🏫 **Pardus ETAP & Okul Ağı Uyumu**: MEB Fatih okul ağındaki sertifika filtrelemeleri nedeniyle sitelerin açılmama sorunu çözülmüştür; akıllı tahta dokunmatik ekranları tam desteklenir.
- ⚡ **Kilitlenme ve Donma Önleyici Mimari**:
  - Sekmeler arası geçişte Chromium GPU render düşmesi (`display: none` sorunu) giderildi.
  - Ağ isteklerinde askıda kalmayı engelleyen garantili callback yapısı eklendi.
  - Yanıt vermeyen veya çöken sekmeler için otomatik kurtarma ve bilgilendirici "Yeniden Dene" hata ekranı eklendi.
- 🧩 **Eklenti Desteği**: Manifest dosyası, içerik betiği ve açılır pencere içeren eklentileri klasörden veya ZIP dosyasından yükle.
- 🛍️ **Eklenti Mağazası**: Resmî Chrome Web Store sayfalarını aç; Chrome'a kurduğun eklentileri uygulamaya aktarmayı dene.
- 🛡️ **Aile / +18 Koruması**: Bilinen yetişkin içerik alan adlarını sekmelerde ve gizli sekmelerde engeller; ayarlardan açılıp kapatılabilir.
- 🔄 **Otomatik Güncelleme**: Windows ve Pardus ETAP (Linux) sürümlerini GitHub Releases üzerinden denetler.
- 🔊 **Ses Güçlendirici (%600)**: Sekme bazlı ses artırma, bas ve konuşma netliği modu.
- 🛡️ **Yerleşik Reklam Engelleyici**: Reklamları ve izleyicileri engeller.
- 📑 **Çoklu Sekme & Gizli Mod**: Sekmeler arası hızlı geçiş, klavye kısayolları.
- 🔖 **Yer İşaretleri & Geçmiş**: Sayfaları kaydet ve geçmişi yönet.

---

## 💻 Geliştiriciler İçin (Derleme & Paketleme)

```bash
# Bağımlılıkları yükle
npm install

# Tarayıcıyı başlat
npm start

# Windows Setup .exe üret
npm run dist:setup

# Pardus ETAP / Debian .deb paketi üret
npm run dist:deb

# Linux tar.gz arşivi üret
npm run dist:linux
```
