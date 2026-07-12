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
