# 🌐 ChatTarayıcı

Chromium (Electron) tabanlı, eklenti destekli modern web tarayıcısı.

---

## 📥 İndir & Kur (Windows Setup - Node/npm GEREKMEZ)

Arkadaşlarınızın hiçbir şey yüklemesine gerek yok! Doğrudan indirip çift tıklayarak kurabilirler:

👉 **[⬇️ ChatTarayici'nin son sürümünü indir](https://github.com/omerFlix/Chattaray-c-/releases/latest)**

*(İndirip çift tıklayın, masaüstünüze kısayol eklenir ve tarayıcı anında açılır!)*

---

## ✨ Özellikler

- 🚀 **Chromium Motoru**: Gerçek web sitelerini yüksek hızda gezin.
- 🧩 **Eklenti Desteği**: Manifest dosyası, içerik betiği ve açılır pencere içeren eklentileri klasörden veya ZIP dosyasından yükle.
- 🛍️ **Eklenti Mağazası**: Resmî Chrome Web Store sayfalarını aç; Chrome'a kurduğun eklentileri uygulamaya aktarmayı dene. Electron `.crx` paketlerini doğrudan kurmaz ve tüm Chrome API'lerini desteklemez.
- 🛡️ **Aile / +18 Koruması**: Bilinen yetişkin içerik alan adlarını sekmelerde ve gizli sekmelerde engeller; ayarlardan açılıp kapatılabilir.
- 🔄 **Otomatik Güncelleme**: Açılışta yayımlanmış GitHub Releases sürümünü denetler; yeni sürüm varsa Windows Setup dosyasını indirip başlatır.
- 🛡️ **Yerleşik Reklam Engelleyici**: Reklamları ve izleyicileri engeller.
- 📑 **Çoklu Sekme & Gizli Mod**: Sekmeler arası hızlı geçiş, klavye kısayolları.
- 🔖 **Yer İşaretleri & Geçmiş**: Sayfaları kaydet ve geçmişi yönet.

Yetişkin içerik alan adı listesi [StevenBlack/hosts porn-only](https://github.com/StevenBlack/hosts/tree/master/alternates/porn-only) kaynağından alınır, kullanıcı verilerinde önbelleğe yazılır ve günlük olarak güncellenir. Kaynak lisansı `data/LICENSE.txt` dosyasındadır.

---

## 💻 Geliştiriciler İçin (Kaynak Koddan Çalıştırma)

```bash
# Bağımlılıkları yükle
npm install

# Tarayıcıyı başlat
npm start

# Yeniden Setup .exe üret
npm run dist:setup
```
