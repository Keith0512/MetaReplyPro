console.log("Meta Auto Reply Extension: Background service worker loaded.");

chrome.runtime.onInstalled.addListener(() => {
  // 初始化預設設定
  chrome.storage.sync.get(['settings', 'products'], (result) => {
    if (!result.settings) {
      chrome.storage.sync.set({
        settings: {
          fbMinDelay: 15,
          fbMaxDelay: 60,
          igMinDelay: 30,
          igMaxDelay: 60,
          publicReplies: [
            "哈囉！已經將詳細資訊私訊給您囉，請查看收件匣！",
            "您好，商品連結已經發送到您的私訊了，謝謝支持！",
            "收到！已經把資訊傳到您的訊息中囉～",
            "哈囉，請檢查一下陌生訊息或收件匣，已經發送給您了！"
          ],
          dmPrefixes: [
            "您好！這是您詢問的商品連結：",
            "哈囉～感謝您的留言，為您附上專屬連結：",
            "親愛的顧客您好，這是您感興趣的商品資訊："
          ],
          dmSuffixes: [
            "如果有任何問題歡迎隨時詢問喔！\n我們的官方客服為 @hikertribe",
            "祝您有美好的一天！"
          ]
        }
      });
    }
    if (!result.products) {
      chrome.storage.sync.set({
        products: [
          { id: '1', name: '地堡充氣帳篷', link: 'https://example.com/tent' },
          { id: '2', name: '露營折疊桌', link: 'https://example.com/table' }
        ]
      });
    }
  });
});

// ---- 未封裝版自動更新 ----
// 未封裝擴充功能的檔案是即時從磁碟讀取的：原生更新器換完新版檔案後，
// 磁碟上 manifest.json 的版本會與記憶體中執行的版本不同，此時重新載入即可套用新版。
const UPDATE_CHECK_ALARM = "update-check";

function scheduleUpdateCheck() {
  chrome.alarms.create(UPDATE_CHECK_ALARM, { periodInMinutes: 5 });
}
chrome.runtime.onInstalled.addListener(scheduleUpdateCheck);
chrome.runtime.onStartup.addListener(scheduleUpdateCheck);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== UPDATE_CHECK_ALARM) return;
  try {
    const response = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    const diskManifest = await response.json();
    if (diskManifest.version !== chrome.runtime.getManifest().version) {
      console.log(`Meta Auto Reply: 偵測到新版 ${diskManifest.version}，重新載入`);
      chrome.runtime.reload();
    }
  } catch (e) {
    // 更新腳本可能正在覆蓋檔案，略過本次檢查，下次 alarm 再試
  }
});
