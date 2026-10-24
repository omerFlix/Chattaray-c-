chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_STATS') {
    chrome.storage.local.get(['protectionStats'], (res) => {
      sendResponse(res.protectionStats || { trackers: 0, ads: 0, downloads: 0 });
    });
    return true; 
  }
});