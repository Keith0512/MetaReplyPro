console.log("Meta Auto Reply Extension: Content script loaded.");

// ============================================================
// SHARED STATE
// ============================================================
let isRunning = false;
let currentSettings = null;
let currentProducts = [];
let selectedProduct = null;
let postProductMapping = {};
let showFloatingButton = true; // popup 的「顯示機器人」開關，未設定視為 true

const DEFAULT_SETTINGS = {
  fbMinDelay: 15,
  fbMaxDelay: 60,
  igMinDelay: 30,
  igMaxDelay: 60,
  publicReplies: ["哈囉！已經將詳細資訊私訊給您囉，請查看收件匣！"],
  dmPrefixes: ["您好！這是您詢問的商品連結："],
  dmSuffixes: ["如果有任何問題歡迎隨時詢問喔！"]
};

// ============================================================
// Versioned exact bindings. Legacy title keys are retained, never auto-applied.
// ============================================================
function getBoundProductId(postTitle) {
  if (!isStablePostKey(postTitle)) return null;
  return Object.hasOwn(postProductMapping || {}, postTitle) ? postProductMapping[postTitle] : null;
}

function setBoundProductId(postTitle, productId) {
  if (!isStablePostKey(postTitle)) return;
  postProductMapping ||= {};
  postProductMapping[postTitle] = productId;
}

function deleteBoundProductId(postTitle) {
  if (!isStablePostKey(postTitle) || !postProductMapping) return;
  delete postProductMapping[postTitle];
}

function isStablePostKey(key) {
  return typeof key === 'string' && /^v2:(facebook|instagram):[0-9]+:[0-9]+(?:_[0-9]+)?$/.test(key);
}

// ============================================================
// SHARED UTILITIES
// ============================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function simulateTyping(element, text) {
  element.focus();
  await sleep(100);

  // 按行分開插入，用 Shift+Enter 換行
  // （直接插入含 \n 的文字，Messenger 的 Lexical 編輯器不會正確處理）
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.length > 0) {
      let success = false;
      try {
        success = document.execCommand('insertText', false, line);
      } catch (e) {}

      // 只有在 execCommand 明確失敗時才用 paste 備用，避免重複插入
      if (!success) {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', line);
        element.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true
        }));
        await sleep(80);
      }
    }

    // 每個 \n 改用 Shift+Enter 換行（純 Enter 在 Messenger 會直接送出）
    if (i < lines.length - 1) {
      element.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true,
        key: 'Enter', keyCode: 13, shiftKey: true
      }));
      element.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true, cancelable: true,
        key: 'Enter', keyCode: 13, shiftKey: true
      }));
      await sleep(80);
    }
  }
  
  // 觸發 input 事件讓 React/Lexical 等框架能更新內部 state
  element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str || '')));
  return div.innerHTML;
}

function getSettings() {
  return currentSettings || DEFAULT_SETTINGS;
}

function getRandomItem(arr) {
  if (!arr || arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildDmMessage(prefix, link, suffix) {
  return [prefix, link, suffix].filter(Boolean).join('\n').trim();
}

// 找到容器內最深層（葉節點優先）符合文字的元素
function findButtonByText(container, texts) {
  const all = Array.from(container.querySelectorAll('*'));
  // 優先找葉節點（沒有子元素的節點），避免選到父容器
  const leaf = all.find(el =>
    el.children.length === 0 && texts.includes(el.innerText?.trim())
  );
  if (leaf) return leaf;
  // 備用：找任何符合文字的元素
  return all.find(el => texts.includes(el.innerText?.trim())) || null;
}

// 觸發完整的滑鼠點擊事件（避免 React 合成事件無法觸發的問題）
function dispatchClick(el) {
  ['mousedown', 'mouseup', 'click'].forEach(type => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  });
}

// 等待直到找到符合 selector 的元素，最多 retries 次，每次間隔 intervalMs
async function waitForElement(selector, retries = 8, intervalMs = 500) {
  for (let i = 0; i < retries; i++) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(intervalMs);
  }
  return null;
}

// ============================================================
// PLATFORM DETECTION
// ============================================================
function getPlatform() {
  const path = window.location.pathname.toLowerCase();
  // Meta Business Suite: URL path 含 /inbox/instagram 或 /inbox/facebook
  if (path.includes('/inbox/instagram')) return 'instagram';
  if (path.includes('/inbox/facebook')) return 'facebook';
  // 直接進入 instagram.com
  if (window.location.hostname.includes('instagram.com')) return 'instagram';
  return 'facebook';
}

// Only bind a selected comment thread with a complete account/post identity.
// Unknown routes or missing IDs require manual product selection.
function getPostKey() {
  try {
    const url = new URL(window.location.href);
    const route = url.pathname.match(/^\/(?:latest\/)?inbox\/(facebook|instagram)\/?$/);
    if (url.hostname !== 'business.facebook.com' || !route) return null;
    const accounts = url.searchParams.getAll('asset_id');
    const posts = url.searchParams.getAll('selected_item_id');
    if (accounts.length !== 1 || posts.length !== 1) return null;
    const key = `v2:${route[1]}:${accounts[0]}:${posts[0]}`;
    return isStablePostKey(key) ? key : null;
  } catch (e) {}
  return null;
}

// 向下相容舊版呼叫
function getCurrentPostTitle() {
  return getPostKey();
}

function getPostTitleFromContainer(_container) {
  return getPostKey();
}

// ============================================================
// ============================================================
// FACEBOOK MODULE
// ============================================================
// ============================================================
const FB = {

  findCommentBlocks() {
    const sendBtns = Array.from(document.querySelectorAll(
      'div[role="button"], span, a, button, div'
    )).filter(el => {
      const text = el.innerText ? el.innerText.trim() : '';
      return text === '發送訊息' || text === 'Send message';
    });

    const blocks = [];
    const processed = new Set();
    sendBtns.forEach(btn => {
      const block = btn.closest('div[role="article"]');
      if (block && !processed.has(block)) {
        processed.add(block);
        blocks.push(block);
      }
    });
    return blocks;
  },

  extractUserName(block) {
    let name = '未知用戶';
    const nameElements = block.querySelectorAll('span[dir="auto"], a, span');
    const skipTexts = ['回覆', '發送訊息', 'send message', 'message', '隱藏', '讚', 'see chat', 'reply'];
    // 時間戳記正則：1分鐘、2小時、3天、1週、2個月、剛剛 等
    const isTimestamp = (t) => /^\d+(秒|分鐘?|小時|天|週|個月|年)前?$/.test(t) || t === '剛剛' || t === 'Just now';
    for (const el of nameElements) {
      const text = el.innerText ? el.innerText.trim() : '';
      if (
        text && text.length > 0 && text.length < 30 &&
        !skipTexts.includes(text.toLowerCase()) &&
        !isTimestamp(text) &&
        !text.includes('個讚') &&
        !/^\d+$/.test(text)
      ) {
        const isName = el.closest('a') !== null || el.tagName === 'A';
        if (isName || name === '未知用戶') {
          name = text;
          if (isName) break;
        }
      }
    }
    return name;
  },

  async processComment(block, product) {
    console.log('[FB] Processing comment...');
    const settings = getSettings();

    // 找葉節點，避免選到父容器
    const replyBtn = findButtonByText(block, ['回覆', 'Reply']);
    const sendMsgBtn = findButtonByText(block, ['發送訊息', 'Send message']);

    console.log('[FB] replyBtn:', replyBtn, '| sendMsgBtn:', sendMsgBtn);

    if (!replyBtn || !sendMsgBtn) {
      console.log('[FB] 找不到回覆或發送訊息按鈕，跳過此留言。');
      return false;
    }

    // Step 1: 公開留言回覆
    dispatchClick(replyBtn);
    await sleep(2500);

    // 優先用 activeElement：點擊回覆後瀏覽器會 focus 到回覆框
    let commentInput = null;
    for (let i = 0; i < 10; i++) {
      const active = document.activeElement;
      if (active && (
        active.getAttribute('contenteditable') === 'true' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'INPUT' ||
        active.closest('[contenteditable="true"]')
      )) {
        commentInput = active.closest('[contenteditable="true"]') || active;
        console.log('[FB] 透過 activeElement 找到回覆框:', active.tagName);
        break;
      }
      await sleep(300);
    }

    if (!commentInput) {
      // 等待輸入框出現（多種 selector 兼容）
      commentInput = await waitForElement(
        'div[aria-label="回覆留言"], div[aria-label="Reply to comment"], ' +
        '[role="textbox"][contenteditable="true"]'
      );
    }

    if (commentInput) {
      console.log('[FB] 找到回覆輸入框，開始輸入...');
      const msg = getRandomItem(settings.publicReplies);
      // 確保點擊 contenteditable 區域
      const editableArea = commentInput.querySelector('p') || commentInput;
      await simulateTyping(editableArea, msg);
      await sleep(1000);
      const textbox = editableArea.closest('[role="textbox"]') || editableArea;
      
      // 確保完整的 Enter 事件觸發 (Lexical 等新版編輯器需要精確事件)
      const enterEventParams = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
      textbox.dispatchEvent(new KeyboardEvent('keydown', enterEventParams));
      textbox.dispatchEvent(new KeyboardEvent('keypress', enterEventParams));
      textbox.dispatchEvent(new KeyboardEvent('keyup', enterEventParams));
      
      await sleep(3000);
    } else {
      console.log('[FB] 回覆輸入框未出現，跳過公開回覆。');
    }

    // Step 2: 私訊商品連結
    // 重新從 block 找 sendMsgBtn（DOM 可能因回覆操作而更新）
    const freshSendMsgBtn = findButtonByText(block, ['發送訊息', 'Send message']);
    if (!freshSendMsgBtn) {
      console.log('[FB] 重新找不到發送訊息按鈕。');
      return !!commentInput;
    }
    dispatchClick(freshSendMsgBtn);
    await sleep(3000);

    // 等待對話框出現
    const dmInput = await waitForElement(
      'div[role="dialog"] [contenteditable="true"], ' +
      'div[role="dialog"] div[role="textbox"] p'
    );

    if (dmInput) {
      console.log('[FB] 找到私訊輸入框，開始輸入...');
      const prefix = getRandomItem(settings.dmPrefixes);
      const suffix = getRandomItem(settings.dmSuffixes || []);
      const link = product ? product.link : '';
      const fullMsg = buildDmMessage(prefix, link, suffix);

      await simulateTyping(dmInput, fullMsg);
      await sleep(1000);

      const sendBtn = findButtonByText(
        document.querySelector('div[role="dialog"]') || document,
        ['發送訊息', '傳送', 'Send']
      );
      if (sendBtn) {
        dispatchClick(sendBtn);
      } else {
        const enterEventParams = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
        dmInput.dispatchEvent(new KeyboardEvent('keydown', enterEventParams));
        dmInput.dispatchEvent(new KeyboardEvent('keypress', enterEventParams));
        dmInput.dispatchEvent(new KeyboardEvent('keyup', enterEventParams));
      }

      await sleep(3000);

      const closeBtn =
        document.querySelector('div[role="dialog"] [aria-label="關閉"]') ||
        document.querySelector('div[role="dialog"] [aria-label="Close"]');
      if (closeBtn) dispatchClick(closeBtn);
      await sleep(1000);
    } else {
      console.log('[FB] 私訊對話框未出現。');
    }

    return true;
  }

};

// ============================================================
// ============================================================
// INSTAGRAM MODULE
// ============================================================
// ============================================================
const IG = {

  findCommentBlocks() {
    // IG Business Suite 的按鈕文字：「Send message」= 可私訊，「Message」= 已私訊（跳過）
    const sendBtns = Array.from(document.querySelectorAll(
      'div[role="button"], span, a, button, div'
    )).filter(el => {
      const text = el.innerText ? el.innerText.trim().toLowerCase() : '';
      return text === '發送訊息' || text === 'send message';
    });

    const blocks = [];
    const processed = new Set();
    sendBtns.forEach(btn => {
      let block = null;
      let current = btn.parentElement;
      for (let i = 0; i < 6; i++) {
        if (current && current.querySelector('img')) {
          block = current;
          break;
        }
        current = current?.parentElement;
      }
      if (!block) block = btn.parentElement?.parentElement?.parentElement;
      if (block && !processed.has(block)) {
        processed.add(block);
        blocks.push(block);
      }
    });
    return blocks;
  },

  extractUserName(block) {
    let name = '未知用戶';
    const nameElements = block.querySelectorAll('span[dir="auto"], a, span');
    const skipTexts = ['回覆', '發送訊息', 'send message', 'message', '隱藏', '讚', 'reply', 'see chat'];
    const isTimestamp = (t) => /^\d+(秒|分鐘?|小時|天|週|個月|年)前?$/.test(t) || t === '剛剛' || t === 'Just now';
    for (const el of nameElements) {
      const text = el.innerText ? el.innerText.trim() : '';
      if (
        text && text.length > 0 && text.length < 30 &&
        !skipTexts.includes(text.toLowerCase()) &&
        !isTimestamp(text) &&
        !text.includes('個讚') &&
        !/^\d+$/.test(text)
      ) {
        const isName = el.closest('a') !== null || el.tagName === 'A';
        if (isName || name === '未知用戶') {
          name = text;
          if (isName) break;
        }
      }
    }
    return name;
  },

  async processComment(block, product) {
    console.log('[IG] Processing comment...');
    const settings = getSettings();

    const replyBtn = findButtonByText(block, ['回覆', 'Reply']);
    const sendMsgBtn = findButtonByText(block, ['發送訊息', 'Send message']);

    console.log('[IG] replyBtn:', replyBtn, '| sendMsgBtn:', sendMsgBtn);

    if (!replyBtn || !sendMsgBtn) {
      console.log('[IG] 找不到回覆或發送訊息按鈕，跳過此留言。');
      return false;
    }

    // Step 1: 公開留言回覆

    // ★ 必須在點擊前記錄（IG 的回覆框是既有元素被 focus，不是新增節點）
    const editablesBeforeReply = new Set([
      ...document.querySelectorAll('[contenteditable="true"]'),
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('input[type="text"]')
    ]);

    dispatchClick(replyBtn);
    await sleep(2500);

    // 優先用 activeElement：點擊回覆後瀏覽器會 focus 到回覆框
    let commentInput = null;
    for (let i = 0; i < 10; i++) {
      const active = document.activeElement;
      if (active && (
        active.getAttribute('contenteditable') === 'true' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'INPUT'
      )) {
        commentInput = active;
        console.log('[IG] 透過 activeElement 找到回覆框:', active.tagName, active.placeholder || '');
        break;
      }
      // 備用：找新出現的輸入元素
      const newEl = [...document.querySelectorAll('[contenteditable="true"]'), ...document.querySelectorAll('textarea')]
        .find(el => !editablesBeforeReply.has(el));
      if (newEl) {
        commentInput = newEl;
        console.log('[IG] 找到新出現的回覆框:', newEl.tagName);
        break;
      }
      await sleep(400);
    }

    if (commentInput) {
      console.log('[IG] 開始輸入公開回覆...');
      const msg = getRandomItem(settings.publicReplies);
      commentInput.focus();
      await sleep(200);
      await simulateTyping(commentInput, msg);
      await sleep(1000);
      // IG 回覆框按 Enter 直接送出
      const enterEventParams = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
      commentInput.dispatchEvent(new KeyboardEvent('keydown', enterEventParams));
      commentInput.dispatchEvent(new KeyboardEvent('keypress', enterEventParams));
      commentInput.dispatchEvent(new KeyboardEvent('keyup', enterEventParams));
      await sleep(3000);
    } else {
      console.log('[IG] 回覆輸入框未出現，跳過公開回覆。');
    }

    // Step 2: 私訊商品連結
    const freshSendMsgBtn = findButtonByText(block, ['發送訊息', 'Send message']);
    if (!freshSendMsgBtn) {
      console.log('[IG] 重新找不到發送訊息按鈕。');
      return !!commentInput;
    }

    // ★ 在點擊前記錄現有輸入元素
    const editablesBeforeDm = new Set([
      ...document.querySelectorAll('[contenteditable="true"]'),
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('input[type="text"]')
    ]);

    dispatchClick(freshSendMsgBtn);
    await sleep(3500);

    // 優先用 activeElement，其次找新出現的元素
    let dmInput = null;
    for (let i = 0; i < 12; i++) {
      const active = document.activeElement;
      if (active && (
        active.getAttribute('contenteditable') === 'true' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'INPUT'
      ) && !editablesBeforeDm.has(active)) {
        dmInput = active;
        console.log('[IG] 透過 activeElement 找到私訊框:', active.tagName);
        break;
      }
      const newEl = [
        ...document.querySelectorAll('[contenteditable="true"]'),
        ...document.querySelectorAll('textarea'),
        ...document.querySelectorAll('input[type="text"]')
      ].find(el => !editablesBeforeDm.has(el));
      if (newEl) {
        dmInput = newEl;
        console.log('[IG] 找到新出現的私訊框:', newEl.tagName);
        break;
      }
      await sleep(400);
    }

    if (dmInput) {
      console.log('[IG] 開始輸入私訊...');
      const prefix = getRandomItem(settings.dmPrefixes);
      const suffix = getRandomItem(settings.dmSuffixes || []);
      const link = product ? product.link : '';
      const fullMsg = buildDmMessage(prefix, link, suffix);

      const maxRetries = typeof settings.igDmRetries === 'number' ? settings.igDmRetries : 3;
      const waitTimeSecs = typeof settings.igDmWaitTime === 'number' ? settings.igDmWaitTime : 10;
      let dmSentSuccessfully = false;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          console.log(`[IG] 尚未看到私訊出現，進行第 ${attempt} 次重試...`);
        }

        dmInput.focus();
        await sleep(200);

        if (dmInput.tagName === 'TEXTAREA' || dmInput.tagName === 'INPUT') {
          const proto = dmInput.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(dmInput, fullMsg);
          } else {
            dmInput.value = fullMsg;
          }
          dmInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          dmInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        } else {
          const dt = new DataTransfer();
          dt.setData('text/plain', fullMsg);
          dmInput.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true
          }));
        }
        await sleep(800);

        const dmContainer = dmInput.closest('[role="dialog"], [role="complementary"], main') || document;
        const sendBtn = findButtonByText(dmContainer, ['傳送', 'Send', '發送']);
        if (sendBtn) {
          dispatchClick(sendBtn.closest('[role="button"], button') || sendBtn);
        } else {
          const enterEventParams = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
          dmInput.dispatchEvent(new KeyboardEvent('keydown', enterEventParams));
          dmInput.dispatchEvent(new KeyboardEvent('keypress', enterEventParams));
          dmInput.dispatchEvent(new KeyboardEvent('keyup', enterEventParams));
        }

        // 開始等待與檢查畫面
        let found = false;
        for (let wait = 0; wait < waitTimeSecs; wait++) {
          await sleep(1000);
          const checkContainer = dmInput.closest('[role="dialog"], [role="complementary"], main') || document;
          const textContent = checkContainer.innerText || checkContainer.textContent || '';
          
          if ((prefix && textContent.includes(prefix)) || (link && textContent.includes(link))) {
            found = true;
            break;
          }
        }

        if (found) {
          console.log('[IG] 成功確認私訊已出現在畫面中！');
          dmSentSuccessfully = true;
          break;
        }
      }

      if (!dmSentSuccessfully) {
        console.log(`[IG] 經過 ${maxRetries} 次重試仍未確認到私訊內容。這可能是因為載入過慢或對方設定限制。`);
      }

      await sleep(1500);

      // 關閉對話框（若有）
      const closeBtn =
        document.querySelector('svg[aria-label="關閉"]')?.closest('div[role="button"]') ||
        document.querySelector('[aria-label="關閉"]') ||
        document.querySelector('[aria-label="Close"]');
      if (closeBtn) dispatchClick(closeBtn);
      await sleep(1000);
    } else {
      console.log('[IG] 私訊對話框未出現。');
    }

    return true;
  }

};

// ============================================================
// POST BINDING OBSERVER
// ============================================================
function updateBindButtonStates() {
  document.querySelectorAll('.meta-bind-product-btn').forEach(btn => {
    const postTitle = btn.dataset.postTitle;
    const isBound = postTitle && getBoundProductId(postTitle);
    if (isBound) {
      btn.textContent = '✅ 已綁定商品';
      btn.style.backgroundColor = '#6B7280';
    } else {
      btn.textContent = '🔗 綁定商品';
      btn.style.backgroundColor = '#10B981';
    }
  });
}

function setupPostBindingObserver() {
  const observer = new MutationObserver(() => {
    const boostTexts = ['加強推廣', '無法加強推廣', 'Boost post', "Can't boost", 'Boost'];
    const boostBtns = Array.from(document.querySelectorAll('div[role="button"], button'))
      .filter(b => boostTexts.includes(b.innerText?.trim()));

    for (const btn of boostBtns) {
      const container = btn.parentElement;
      if (!container) continue;

      const postTitle = getPostTitleFromContainer(container) || '';
      const existing = container.querySelector('.meta-bind-product-btn');

      // 若現有按鈕的 key 與目前貼文不同（FB SPA 切換時 DOM 被複用），先移除
      if (existing) {
        if (existing.dataset.postTitle !== postTitle) {
          existing.remove();
        } else {
          continue; // 同一篇貼文，保留現有按鈕
        }
      }

      {
        const isBound = getBoundProductId(postTitle);

        const bindBtn = document.createElement('div');
        bindBtn.className = 'meta-bind-product-btn';
        bindBtn.dataset.postTitle = postTitle;
        bindBtn.textContent = isBound ? '✅ 已綁定商品' : '🔗 綁定商品';
        bindBtn.style.cssText = `
          background-color: ${isBound ? '#6B7280' : '#10B981'};
          color: white;
          padding: 0 12px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          margin-right: 8px;
          height: 36px;
        `;
        bindBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showBindingDialog(bindBtn);
        });
        container.insertBefore(bindBtn, btn);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function showBindingDialog(anchorElement) {
  const oldDialog = document.querySelector('.meta-binding-dialog');
  if (oldDialog) oldDialog.remove();

  const postTitle = getPostKey();
  if (!postTitle) {
    alert('無法取得完整的粉專與貼文 ID，無法儲存綁定。請在自動回覆選單手動選擇商品。');
    return;
  }
  const dialog = document.createElement('div');
  dialog.className = 'meta-binding-dialog';
  dialog.style.cssText = `
    position: absolute;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);
    padding: 16px;
    z-index: 10000;
    width: 300px;
  `;

  const rect = anchorElement.getBoundingClientRect();
  dialog.style.top = `${rect.bottom + window.scrollY + 8}px`;
  dialog.style.left = `${rect.left + window.scrollX}px`;

  const shortTitle = escapeHtml(postTitle.length > 20 ? postTitle.substring(0, 20) + '...' : postTitle);
  const optionsHtml = currentProducts.map(p =>
    `<option value="${escapeHtml(p.id)}" ${getBoundProductId(postTitle) === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
  ).join('');

  dialog.innerHTML = `
    <div style="margin-bottom:12px;font-weight:bold;color:#111827;">設定此貼文對應的商品</div>
    <div style="margin-bottom:12px;font-size:12px;color:#6B7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
      貼文識別：${shortTitle}
    </div>
    <select id="binding-select" style="width:100%;padding:8px;border-radius:4px;border:1px solid #D1D5DB;margin-bottom:12px;">
      <option value="">-- 請選擇商品 --</option>
      ${optionsHtml}
    </select>
    <div style="display:flex;justify-content:flex-end;gap:8px;">
      <button id="binding-cancel" style="padding:6px 12px;border-radius:4px;border:1px solid #D1D5DB;background:white;cursor:pointer;">取消</button>
      <button id="binding-save" style="padding:6px 12px;border-radius:4px;border:none;background:#4F46E5;color:white;cursor:pointer;">儲存綁定</button>
    </div>
  `;

  document.body.appendChild(dialog);

  dialog.querySelector('#binding-cancel').addEventListener('click', () => dialog.remove());
  dialog.querySelector('#binding-save').addEventListener('click', () => {
    if (getPostKey() !== postTitle) {
      alert('貼文已切換，請重新開啟綁定視窗。');
      dialog.remove();
      return;
    }
    const selectedId = dialog.querySelector('#binding-select').value;
    if (selectedId) {
      setBoundProductId(postTitle, selectedId);
      chrome.storage.sync.set({ postProductMapping }, () => {
        if (chrome.runtime.lastError) {
          alert('儲存失敗：' + chrome.runtime.lastError.message);
          return;
        }
        alert('綁定成功！下次開啟自動回覆時將自動選擇此商品。');
        dialog.remove();
        updateBindButtonStates();
      });
    } else {
      deleteBoundProductId(postTitle);
      chrome.storage.sync.set({ postProductMapping }, () => {
        if (chrome.runtime.lastError) {
          alert('儲存失敗：' + chrome.runtime.lastError.message);
          return;
        }
        alert('已解除綁定。');
        dialog.remove();
        updateBindButtonStates();
      });
    }
  });

  setTimeout(() => {
    const closeHandler = (e) => {
      if (!dialog.contains(e.target) && e.target !== anchorElement) {
        dialog.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 100);
}

// ============================================================
// FLOATING BUTTON UI
// ============================================================
function injectFloatingButton() {
  const wrapper = document.createElement('div');
  wrapper.className = 'meta-auto-reply-wrapper';

  const btn = document.createElement('button');
  btn.className = 'meta-auto-reply-btn';
  btn.innerHTML = '🤖 自動回覆';

  const dropdown = document.createElement('div');
  dropdown.className = 'meta-auto-reply-dropdown';

  updateDropdownContent(dropdown, btn);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (isRunning) {
      isRunning = false;
      btn.innerHTML = '🛑 停止中...';
      btn.style.backgroundColor = '#EF4444';
      return;
    }

    const isVisible = dropdown.style.display === 'block';
    dropdown.style.display = isVisible ? 'none' : 'block';

    if (!isVisible) {
      const postTitle = getCurrentPostTitle();
      const boundProductId = getBoundProductId(postTitle);
      selectedProduct = boundProductId
        ? (currentProducts.find(p => p.id === boundProductId) || null)
        : null;
      updateDropdownContent(dropdown, btn);
    }
  });

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) dropdown.style.display = 'none';
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(dropdown);
  document.body.appendChild(wrapper);
}

function applyFloatingButtonVisibility() {
  const wrapper = document.querySelector('.meta-auto-reply-wrapper');
  if (wrapper) wrapper.style.display = showFloatingButton ? '' : 'none';
}

function updateDropdownContent(dropdown, mainBtn) {
  const platform = getPlatform();
  const postTitle = getCurrentPostTitle();
  const selectionUrl = window.location.href;
  const boundProductId = getBoundProductId(postTitle);

  const platformLabel = platform === 'instagram' ? 'Instagram 留言' : 'Facebook 留言';
  const platformColor = platform === 'instagram' ? '#E1306C' : '#1877F2';

  const productsHtml = currentProducts.length === 0
    ? '<p style="text-align:center;color:#6b7280;font-size:12px;">請至設定頁面新增商品</p>'
    : currentProducts.map(p => `
        <label class="product-label">
          <input type="radio" name="meta-product-select" value="${escapeHtml(p.id)}" ${selectedProduct && selectedProduct.id === p.id ? 'checked' : ''}>
          <div class="product-info">
            <div class="product-name">${escapeHtml(p.name)}</div>
            <div class="product-link">${escapeHtml(p.link)}</div>
          </div>
        </label>
      `).join('');

  dropdown.innerHTML = `
    <div class="dropdown-header">
      <h3 style="color:${platformColor};">📌 ${platformLabel}</h3>
      <p>選擇商品後，系統將自動公開回覆並私訊連結</p>
      ${!postTitle ? '<p>無法識別貼文，請手動確認商品；本次選擇不會儲存為綁定。</p>' : ''}
      ${Object.keys(postProductMapping || {}).some(key => !isStablePostKey(key)) ? '<p>舊版綁定已保留但不再自動套用，請核對商品並重新綁定。</p>' : ''}
      ${boundProductId ? '<div style="margin-top:4px;font-size:11px;color:#10B981;font-weight:bold;">✨ 已自動載入此貼文綁定的商品</div>' : ''}
    </div>
    <div class="dropdown-list">${productsHtml}</div>
    <div class="dropdown-actions">
      <button id="meta-auto-reply-scan" class="btn-scan">掃描留言</button>
      <button id="meta-auto-reply-start" class="btn-start">開始執行</button>
    </div>
    <div id="scan-result" style="margin-top:10px;font-size:13px;text-align:center;font-weight:bold;"></div>
  `;

  dropdown.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      selectedProduct = currentProducts.find(p => p.id === e.target.value) || null;
    });
  });

  dropdown.querySelector('#meta-auto-reply-scan').addEventListener('click', () => {
    const module = platform === 'instagram' ? IG : FB;
    const commentBlocks = module.findCommentBlocks();
    const targetNames = commentBlocks.map(block => module.extractUserName(block));
    const resultDiv = dropdown.querySelector('#scan-result');

    if (targetNames.length > 0) {
      const listHtml = targetNames.map((n, i) =>
        `<div style="padding:2px 0;border-bottom:1px solid #E5E7EB;">${i + 1}. ${escapeHtml(n)}</div>`
      ).join('');
      resultDiv.innerHTML = `
        <div style="color:#10B981;">掃描完成：共找到 ${targetNames.length} 則可回覆的留言！</div>
        <div style="margin-top:8px;max-height:120px;overflow-y:auto;text-align:left;background:#F3F4F6;padding:8px;border-radius:4px;font-weight:normal;font-size:12px;color:#374151;">
          ${listHtml}
        </div>
      `;
    } else {
      resultDiv.innerHTML = `<div style="color:#EF4444;">掃描完成：目前沒有需要回覆的留言。</div>`;
    }
  });

  dropdown.querySelector('#meta-auto-reply-start').addEventListener('click', () => {
    if (getPostKey() !== postTitle || window.location.href !== selectionUrl) {
      selectedProduct = null;
      updateDropdownContent(dropdown, mainBtn);
      alert('貼文或頁面已切換，請重新確認商品。');
      return;
    }
    if (!selectedProduct) {
      alert('請先選擇商品！');
      return;
    }
    dropdown.style.display = 'none';
    startAutomation(platform, mainBtn);
  });
}

// ============================================================
// MAIN AUTOMATION CONTROLLER
// ============================================================
async function startAutomation(platform, mainBtn) {
  if (isRunning || !selectedProduct) return;
  // Keep the explicitly selected product fixed throughout this batch.
  const product = { ...selectedProduct };
  isRunning = true;

  const settings = getSettings();
  const module = platform === 'instagram' ? IG : FB;

  const btns = document.querySelectorAll('.meta-auto-reply-btn');
  btns.forEach(btn => {
    btn.innerHTML = '⏳ 執行中...';
    btn.style.backgroundColor = '#9CA3AF';
    btn.style.cursor = 'not-allowed';
  });

  try {
    const commentBlocks = module.findCommentBlocks();

    if (commentBlocks.length === 0) {
      alert('畫面上找不到可以回覆的留言！請確認您已展開留言列表。');
      return;
    }

    let processedCount = 0;
    for (let i = 0; i < commentBlocks.length; i++) {
      if (!isRunning) break;

      const success = await module.processComment(commentBlocks[i], product);
      if (success) processedCount++;

      if (i < commentBlocks.length - 1 && isRunning) {
        const platform = getPlatform();
        const minDelay = platform === 'instagram' ? 
                         (settings.igMinDelay || 30) : 
                         (settings.fbMinDelay || settings.minDelay || 15);
        const maxDelay = platform === 'instagram' ? 
                         (settings.igMaxDelay || 60) : 
                         (settings.fbMaxDelay || settings.maxDelay || 60);

        const delay = Math.floor(
          Math.random() * (maxDelay - minDelay + 1) + minDelay
        );
        for (let j = delay; j > 0; j--) {
          if (!isRunning) break;
          btns.forEach(b => b.innerHTML = `⏳ 冷卻中 (${j}s)...`);
          await sleep(1000);
        }
      }
    }

    alert(`執行完畢！共處理了 ${processedCount} 則留言。`);
  } catch (error) {
    console.error('[META AutoReply] Automation error:', error);
    alert('執行過程中發生錯誤：' + error.message);
  } finally {
    isRunning = false;
    btns.forEach(btn => {
      btn.innerHTML = '🤖 自動回覆';
      btn.style.backgroundColor = '#4F46E5';
      btn.style.cursor = 'pointer';
    });
  }
}

// ============================================================
// INIT
// ============================================================
function init() {
  const platform = getPlatform();
  console.log(`[META AutoReply] Platform detected: [${platform}]`);

  chrome.storage.sync.get(['settings', 'products', 'postProductMapping', 'showFloatingButton'], (result) => {
    if (result.settings) currentSettings = result.settings;
    if (result.products) currentProducts = result.products;
    if (result.postProductMapping) postProductMapping = result.postProductMapping;
    showFloatingButton = result.showFloatingButton !== false;
    applyFloatingButtonVisibility();
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
      if (changes.settings) currentSettings = changes.settings.newValue;
      if (changes.products) currentProducts = changes.products.newValue;
      if (changes.postProductMapping) {
        postProductMapping = changes.postProductMapping.newValue;
        updateBindButtonStates();
      }
      if (changes.showFloatingButton) {
        showFloatingButton = changes.showFloatingButton.newValue !== false;
        applyFloatingButtonVisibility();
      }
    }
  });

  setTimeout(() => {
    if (!document.querySelector('.meta-auto-reply-wrapper')) {
      injectFloatingButton();
    }
    applyFloatingButtonVisibility();
    setupPostBindingObserver();
  }, 1000);
}

init();
