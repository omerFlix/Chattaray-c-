// Kalkan Reklam Engelleyici - YouTube & Web Sayfası Temizleyici
(function() {
  function cleanupAds() {
    try {
      // 1. YouTube Video Reklam Atlayıcı
      const skipBtn = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .videoAdUiSkipButton');
      if (skipBtn) {
        skipBtn.click();
      }

      // 2. Geçilemeyen videolarda videoyu sonuna sar
      const video = document.querySelector('video');
      const isAdPlaying = document.querySelector('.ad-showing, .ad-interrupting, .ytp-ad-player-overlay');
      if (video && isAdPlaying && isFinite(video.duration)) {
        video.currentTime = video.duration;
      }

      // 3. YouTube afiş kapatma butonları
      const overlayClose = document.querySelector('.ytp-ad-overlay-close-button');
      if (overlayClose) {
        overlayClose.click();
      }

      // 4. Genel sayfa reklam bloklarını DOM'dan kaldır
      const adSelectors = '.adsbygoogle, ytd-ad-slot-renderer, #player-ads, .ad-banner, [id*="google_ads"]';
      document.querySelectorAll(adSelectors).forEach(el => {
        el.style.display = 'none';
      });
    } catch (e) {
      // ignore
    }
  }

  // Sayfa yüklendikçe ve video oynadıkça düzenli çalıştır
  setInterval(cleanupAds, 350);
})();
