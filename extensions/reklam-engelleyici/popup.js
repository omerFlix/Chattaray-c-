const toggle = document.getElementById('adblockToggle');
const shield = document.getElementById('shield');
const statusLabel = document.getElementById('status-label');
const stateText = document.getElementById('state-text');

const requestedState = new URLSearchParams(window.location.search).get('enabled');
const isEnabled = requestedState !== 'false';
toggle.checked = isEnabled;
updateUI(isEnabled);

toggle.addEventListener('change', () => {
  const active = toggle.checked;
  updateUI(active);

  try {
    window.parent.postMessage({ type: 'toggle-extension', enabled: active }, '*');
  } catch {}
});

function updateUI(active) {
  if (active) {
    shield.className = 'shield-icon';
    statusLabel.textContent = 'Korumalı ve Güvenli';
    stateText.textContent = 'Şu an Aktif';
  } else {
    shield.className = 'shield-icon off';
    statusLabel.textContent = 'Koruma Devre Dışı';
    stateText.textContent = 'Kapalı';
  }
}
