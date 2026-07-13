// 「顯示機器人」開關：控制內容腳本注入的右下角浮動按鈕
// 存於 chrome.storage.sync 的 showFloatingButton（未設定視為 true）
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('show-bot-toggle');

  chrome.storage.sync.get('showFloatingButton', ({ showFloatingButton }) => {
    toggle.checked = showFloatingButton !== false;
  });

  toggle.addEventListener('change', () => {
    chrome.storage.sync.set({ showFloatingButton: toggle.checked });
  });
});
