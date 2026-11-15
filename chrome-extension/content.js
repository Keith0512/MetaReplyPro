console.log("Meta Auto Reply Extension: Content script loaded.");

// ============================================================
// SHARED STATE
// ============================================================
let activeBatch = null;
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

async function saveBoundProductId(postKey, productId) {
  const previousMapping = postProductMapping;
  const result = await chrome.runtime.sendMessage({ action: 'savePostProductBinding', postKey, productId });
  if (!result?.ok) throw new Error(result?.error || '無法取得儲存結果。');
  if (postProductMapping === previousMapping) applyPostProductMapping(result.mapping);
}

function applyPostProductMapping(mapping) {
  postProductMapping = mapping || {};
  updateBindButtonStates();
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

function ownsFocus(editor) {
  const focused = document.activeElement;
  return focused === editor || (focused && editor.contains(focused));
}

function editorText(editor) {
  return editor.value ?? (editor.innerText || editor.textContent || '');
}

function normalizeMessage(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function pasteText(element, text) {
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', text);
  element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
}

async function simulateTyping(element, text, canUse, pasteWholeMessage) {
  if (!canUse()) return;
  element.focus();
  await sleep(100);

  const canType = () => canUse() && ownsFocus(element);
  if (!canType()) return;
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
    const proto = element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(element, text);
    } else {
      element.value = text;
    }
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    if (canType()) element.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  if (pasteWholeMessage) {
    pasteText(element, text);
    return;
  }

  // 按行分開插入，用 Shift+Enter 換行
  // （直接插入含 \n 的文字，Messenger 的 Lexical 編輯器不會正確處理）
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (!canType()) return;
    const line = lines[i];

    if (line.length > 0) {
      let success = false;
      try {
        success = document.execCommand('insertText', false, line);
      } catch (e) {}

      // 只有在 execCommand 明確失敗時才用 paste 備用，避免重複插入
      if (!success && canType()) {
        pasteText(element, line);
        await sleep(80);
      }
    }

    // 每個 \n 改用 Shift+Enter 換行（純 Enter 在 Messenger 會直接送出）
    if (i < lines.length - 1 && canType()) {
      element.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true,
        key: 'Enter', keyCode: 13, shiftKey: true
      }));
      if (canType()) {
        element.dispatchEvent(new KeyboardEvent('keyup', {
          bubbles: true, cancelable: true,
          key: 'Enter', keyCode: 13, shiftKey: true
        }));
      }
      await sleep(80);
    }
  }
  
  // 觸發 input 事件讓 React/Lexical 等框架能更新內部 state
  if (canType()) element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
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
function dispatchClick(el, canUse) {
  for (const type of ['mousedown', 'mouseup', 'click']) {
    if (!el.isConnected || !canUse()) return false;
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return true;
}

function dispatchEnter(editor, canUse) {
  if (!canUse() || !ownsFocus(editor)) return false;
  const params = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
  for (const type of ['keydown', 'keypress', 'keyup']) {
    if (!canUse() || !ownsFocus(editor)) break;
    editor.dispatchEvent(new KeyboardEvent(type, params));
  }
  return true;
}

const EDITABLE_SELECTOR = '[contenteditable="true"], textarea, input[type="text"]';
const CHAT_SELECTOR = 'dialog, [role="dialog"], [role="complementary"]';
const MESSAGE_ROW_SELECTOR = '[role="row"], [role="listitem"], [data-message-id]';
const OUTGOING_DATA_SELECTOR = '[data-message-direction="outgoing"], [data-message-author="self"]';
const OUTGOING_LABEL = /^(?:you sent|(?:你|您)(?:已)?(?:傳送了|發送了))(?=$|[\s:：])/i;

function isVisible(node) {
  return node.isConnected && node.getClientRects().length > 0;
}

function visibleEditors() {
  return Array.from(document.querySelectorAll(EDITABLE_SELECTOR)).filter(isVisible);
}

async function openEditor(block, button, canUse, recipient = null) {
  const previousEditors = new Set(visibleEditors());
  const previousFocus = document.activeElement;
  const control = button.closest('[aria-controls]');
  const controls = control?.getAttribute('aria-controls');
  const canClick = () => canUse() && block.contains(button);
  if (!dispatchClick(button, canClick)) return null;

  for (let attempt = 0; attempt < 16 && canUse(); attempt++) {
    const controlled = controls ? document.getElementById(controls) : null;
    const editors = visibleEditors();
    if (recipient) {
      const candidates = new Map();
      for (const editor of editors) {
        const panel = editor.closest(CHAT_SELECTOR);
        if (!panel || panel.contains(block)) continue;
        if (controls ? !controlled?.contains(editor) : !matchesRecipient(panel, recipient)) continue;
        if (!candidates.has(panel)) candidates.set(panel, []);
        if (!previousEditors.has(editor)) candidates.get(panel).push(editor);
      }
      if (candidates.size > 1) return null;
      const [matchingEditors = []] = candidates.values();
      const editor = matchingEditors.find(ownsFocus) || (matchingEditors.length === 1 ? matchingEditors[0] : null);
      if (editor) return { editor, control, controlled, controls };
    } else {
      const candidates = editors.filter(editor => (block.contains(editor) || controlled?.contains(editor)) &&
        (!previousEditors.has(editor) || (document.activeElement !== previousFocus && ownsFocus(editor))));
      const editor = candidates.find(ownsFocus) || (candidates.length === 1 ? candidates[0] : null);
      if (editor) return { editor, control, controlled, controls };
    }
    await sleep(400);
  }
  return null;
}

function conversationHeading(panel) {
  return panel.querySelector('[role="heading"], h1, h2, h3') || panel.querySelector('header');
}

function matchesRecipient(panel, recipient) {
  const recipientId = panel.getAttribute('data-recipient-id');
  if (recipient.id && recipientId) return recipient.id === recipientId;
  if (!recipient.name || recipient.name === '未知用戶') return false;
  const name = normalizeMessage(recipient.name).toLowerCase();
  const explicitName = panel.getAttribute('data-recipient-name');
  if (explicitName) return normalizeMessage(explicitName).toLowerCase() === name;
  const labelId = panel.getAttribute('aria-labelledby');
  const explicitLabels = [
    panel.getAttribute('aria-label'),
    labelId ? document.getElementById(labelId)?.innerText : '',
    conversationHeading(panel)?.innerText
  ];
  return explicitLabels.some(label => {
    const text = normalizeMessage(label || '').toLowerCase();
    return [name, `chat with ${name}`, `send message to ${name}`, `與${name}的對話`, `傳送訊息給${name}`].includes(text);
  });
}

function conversationIdentity(panel) {
  return JSON.stringify([
    panel.getAttribute('data-thread-id'), panel.getAttribute('data-conversation-id'),
    panel.getAttribute('data-recipient-id'), panel.getAttribute('data-recipient-name'),
    panel.getAttribute('aria-label'), panel.getAttribute('aria-labelledby'), conversationHeading(panel)?.innerText
  ]);
}

function messageTimestamp(row) {
  const value = row.querySelector('time[datetime]')?.getAttribute('datetime') || '';
  return /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? Date.parse(value) : NaN;
}

function conversationMessages(panel, editor, message) {
  const rows = new Map();
  for (const marker of panel.querySelectorAll(`${MESSAGE_ROW_SELECTOR}, [aria-label], ${OUTGOING_DATA_SELECTOR}`)) {
    const label = marker.getAttribute('aria-label') || '';
    const isOutgoing = OUTGOING_LABEL.test(label) || marker.matches(OUTGOING_DATA_SELECTOR);
    if (!isOutgoing && !marker.matches(MESSAGE_ROW_SELECTOR)) continue;
    const row = marker.closest(MESSAGE_ROW_SELECTOR) || marker;
    if (row === panel || !panel.contains(row) || row.contains(editor) || editor.contains(row) ||
        row.closest(CHAT_SELECTOR) !== panel || !row.getClientRects().length) continue;
    if (!rows.has(row)) rows.set(row, { row, id: row.getAttribute('data-message-id') || row.id, matches: false });
    if (!isOutgoing) continue;

    const messageParts = [
      label.replace(OUTGOING_LABEL, '').replace(/^\s*[:：]\s*/, ''),
      row.innerText || '',
      ...Array.from(row.querySelectorAll('[dir="auto"]'), part => part.innerText || '')
    ];
    if (messageParts.some(part => normalizeMessage(part) === message)) rows.get(row).matches = true;
  }
  return Array.from(rows.values());
}

function hasNewOutgoingMessage(previous, current, submittedAt) {
  if (!previous.length) return current.some(record => {
    if (!record.matches) return false;
    const timestamp = messageTimestamp(record.row);
    return timestamp >= submittedAt && timestamp <= Date.now();
  });
  const sameRecord = (a, b) => a.id && b.id ? a.id === b.id : a.row === b.row;
  const lastRecord = previous.at(-1);
  const oldEnd = current.findIndex(record => sameRecord(lastRecord, record));
  if (oldEnd === -1) return false;
  return current.slice(oldEnd + 1).some(record =>
    record.matches && !previous.some(prior => sameRecord(prior, record))
  );
}

function findChatButton(panel, labels) {
  return Array.from(panel.querySelectorAll('[role="button"], button')).find(button =>
    isVisible(button) && button.closest(CHAT_SELECTOR) === panel &&
    (labels.includes(button.getAttribute('aria-label')) || labels.includes(button.innerText?.trim()) ||
      Array.from(button.querySelectorAll('[aria-label]')).some(icon => labels.includes(icon.getAttribute('aria-label'))))
  );
}

async function prepareMessage(editor, message, canUse, pasteWholeMessage = false) {
  if (!canUse() || normalizeMessage(editorText(editor))) return false;
  await simulateTyping(editor, message, canUse, pasteWholeMessage);
  await sleep(800);
  return canUse() && ownsFocus(editor) && normalizeMessage(editorText(editor)) === normalizeMessage(message);
}

async function processBatchComment(block, product, batch, result, platform) {
  const canUseBlock = () => canContinueBatch(batch) && block.isConnected;
  if (!canUseBlock()) return;
  const settings = getSettings();
  const publicMessage = getRandomItem(settings.publicReplies);
  const replyButton = findButtonByText(block, ['回覆', 'Reply']);
  if (replyButton && publicMessage) {
    const opened = await openEditor(block, replyButton, canUseBlock);
    if (opened) {
      const { editor, control, controlled, controls } = opened;
      const insideBlock = block.contains(editor);
      const canUseReply = () => canUseBlock() && isVisible(editor) &&
        (insideBlock ? block.contains(editor) : block.contains(control) &&
          control.getAttribute('aria-controls') === controls &&
          document.getElementById(controls) === controlled && controlled.contains(editor));
      const sameReply = () => canUseReply() && normalizeMessage(editorText(editor)) === normalizeMessage(publicMessage);
      if (await prepareMessage(editor, publicMessage, canUseReply) && dispatchEnter(editor, sameReply)) {
        result.publicReply = true;
        await sleep(3000);
      }
    }
  }

  if (!canUseBlock()) return;
  const dmButton = findButtonByText(block, ['發送訊息', 'Send message']);
  if (!dmButton) return;
  const recipient = { name: result.name, id: block.getAttribute('data-user-id') };
  const opened = await openEditor(block, dmButton, canUseBlock, recipient);
  if (!opened || !canUseBlock()) return;

  const { editor, control, controlled, controls } = opened;
  const panel = editor.closest(CHAT_SELECTOR);
  if (!panel) return;
  const identity = conversationIdentity(panel);
  const canUseDm = () => canUseBlock() && isVisible(editor) &&
    editor.closest(CHAT_SELECTOR) === panel && conversationIdentity(panel) === identity &&
    (controls ? block.contains(control) && control.getAttribute('aria-controls') === controls &&
      document.getElementById(controls) === controlled && controlled.contains(editor) : matchesRecipient(panel, recipient));
  const message = buildDmMessage(getRandomItem(settings.dmPrefixes), product.link, getRandomItem(settings.dmSuffixes));
  if (!message || !await prepareMessage(editor, message, canUseDm, platform === 'instagram')) return;

  const normalized = normalizeMessage(message);
  const previousMessages = conversationMessages(panel, editor, normalized);
  const sendButton = findChatButton(panel, ['發送訊息', '傳送', 'Send', '發送']);
  const sameDraft = () => canUseDm() && normalizeMessage(editorText(editor)) === normalized;
  const submittedAt = Date.now();
  const dispatched = sendButton
    ? dispatchClick(sendButton, () => sameDraft() && panel.contains(sendButton) &&
      (ownsFocus(editor) || ownsFocus(sendButton)))
    : dispatchEnter(editor, sameDraft);
  if (!dispatched) return;
  result.dm = 'unconfirmed';

  const waitSeconds = platform === 'instagram' && Number.isFinite(settings.igDmWaitTime)
    ? Math.max(1, settings.igDmWaitTime)
    : 10;
  for (let elapsed = 0; elapsed < waitSeconds && canUseDm(); elapsed++) {
    await sleep(1000);
    if (canUseDm() && !normalizeMessage(editorText(editor)) &&
        hasNewOutgoingMessage(previousMessages, conversationMessages(panel, editor, normalized), submittedAt)) {
      result.dm = 'confirmed';
      break;
    }
  }

  if (!canUseDm()) return;
  const closeButton = findChatButton(panel, ['關閉', 'Close']);
  if (closeButton) dispatchClick(closeButton, () => canUseDm() && panel.contains(closeButton));
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

  processComment(block, product, batch, result) {
    return processBatchComment(block, product, batch, result, 'facebook');
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
    const actionSelector = '[role="button"], button, a';
    const isSendAction = el => {
      const text = el.innerText ? el.innerText.trim().toLowerCase() : '';
      return text === '發送訊息' || text === 'send message';
    };
    const matches = Array.from(document.querySelectorAll(`${actionSelector}, span, div`)).filter(isSendAction);
    const sendBtns = new Set(matches.flatMap(el => {
      const action = el.closest(actionSelector);
      if (action) return [action];
      const nestedActions = Array.from(el.querySelectorAll(actionSelector)).filter(isSendAction);
      return nestedActions.length ? nestedActions : [el];
    }));

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

  processComment(block, product, batch, result) {
    return processBatchComment(block, product, batch, result, 'instagram');
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
  const scanButtons = () => {
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

        const bindBtn = document.createElement('button');
        bindBtn.type = 'button';
        bindBtn.className = 'meta-bind-product-btn';
        bindBtn.dataset.postTitle = postTitle;
        bindBtn.textContent = isBound ? '✅ 已綁定商品' : '🔗 綁定商品';
        bindBtn.style.cssText = `
          background-color: ${isBound ? '#6B7280' : '#10B981'};
          color: white;
          border: none;
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
  };
  let scanTimer = null;
  scanButtons();
  const observer = new MutationObserver(() => {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanButtons();
    }, 200);
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
  const saveButton = dialog.querySelector('#binding-save');
  saveButton.addEventListener('click', async () => {
    if (saveButton.disabled) return;
    if (getPostKey() !== postTitle) {
      alert('貼文已切換，請重新開啟綁定視窗。');
      dialog.remove();
      return;
    }
    const selectedId = dialog.querySelector('#binding-select').value;
    saveButton.disabled = true;
    try {
      await saveBoundProductId(postTitle, selectedId || null);
    } catch (error) {
      alert('儲存失敗：' + error.message);
      return;
    } finally {
      saveButton.disabled = false;
    }
    alert(selectedId ? '綁定成功！下次開啟自動回覆時將自動選擇此商品。' : '已解除綁定。');
    dialog.remove();
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
  btn.setAttribute('aria-controls', 'meta-auto-reply-dropdown');
  btn.setAttribute('aria-expanded', 'false');

  const dropdown = document.createElement('div');
  dropdown.id = 'meta-auto-reply-dropdown';
  dropdown.className = 'meta-auto-reply-dropdown';

  updateDropdownContent(dropdown, btn);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (activeBatch) {
      activeBatch.stopReason ||= 'operator';
      btn.innerHTML = '🛑 停止中...';
      btn.style.backgroundColor = '#EF4444';
      return;
    }

    const isVisible = dropdown.style.display === 'block';
    dropdown.style.display = isVisible ? 'none' : 'block';
    btn.setAttribute('aria-expanded', String(!isVisible));

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
    if (!wrapper.contains(e.target)) {
      dropdown.style.display = 'none';
      btn.setAttribute('aria-expanded', 'false');
    }
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
    mainBtn.setAttribute('aria-expanded', 'false');
    startAutomation(platform);
  });
}

// ============================================================
// MAIN AUTOMATION CONTROLLER
// ============================================================
function canContinueBatch(batch) {
  if (activeBatch !== batch || batch.stopReason) return false;
  if (window.location.href === batch.url) return true;
  batch.stopReason = 'navigation';
  return false;
}

async function startAutomation(platform) {
  if (activeBatch || !selectedProduct) return;
  // Keep the explicitly selected product fixed throughout this batch.
  const product = { ...selectedProduct };
  const batch = { url: window.location.href, stopReason: null };
  activeBatch = batch;

  const settings = getSettings();
  const module = platform === 'instagram' ? IG : FB;

  const btns = document.querySelectorAll('.meta-auto-reply-btn');
  btns.forEach(btn => {
    btn.innerHTML = '⏳ 執行中 · 停止';
    btn.style.backgroundColor = '#9CA3AF';
  });

  try {
    const commentBlocks = module.findCommentBlocks();

    if (commentBlocks.length === 0) {
      alert('畫面上找不到可以回覆的留言！請確認您已展開留言列表。');
      return;
    }

    const outcomes = [];
    for (let i = 0; i < commentBlocks.length; i++) {
      if (!canContinueBatch(batch)) break;
      btns.forEach(btn => btn.innerHTML = '⏳ 執行中 · 停止');

      const block = commentBlocks[i];
      const name = module.extractUserName(block);
      const outcome = { name, index: i + 1, publicReply: false, dm: 'not-sent' };
      outcomes.push(outcome);
      try {
        await module.processComment(block, product, batch, outcome);
      } catch (error) {
        console.error('[META AutoReply] Automation error:', error);
        batch.stopReason ||= 'error';
      }

      if (i < commentBlocks.length - 1 && canContinueBatch(batch)) {
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
          if (!canContinueBatch(batch)) break;
          btns.forEach(b => b.innerHTML = `⏳ 冷卻中 (${j}s) · 停止`);
          await sleep(1000);
        }
      }
    }

    canContinueBatch(batch);
    const title = {
      operator: '已停止批次',
      navigation: '頁面已切換，批次已停止',
      error: '執行時發生錯誤，批次已停止'
    }[batch.stopReason] || '批次執行完畢';
    const publicReplies = outcomes.filter(outcome => outcome.publicReply).length;
    const confirmedDms = outcomes.filter(outcome => outcome.dm === 'confirmed').length;
    const unconfirmedDms = outcomes.filter(outcome => outcome.dm === 'unconfirmed').length;
    const unsentDms = outcomes.length - confirmedDms - unconfirmedDms;
    const pending = outcomes
      .filter(outcome => outcome.dm !== 'confirmed')
      .map(outcome => {
        const status = outcome.dm === 'unconfirmed' ? '待核對' : '未送出';
        return `${outcome.index}. ${outcome.name}（${status}）`;
      });
    const summary = [
      title,
      `公開回覆已提交 ${publicReplies} 則`,
      `私訊畫面已確認 ${confirmedDms} 則、待核對 ${unconfirmedDms} 則、未送出 ${unsentDms} 則`,
      `未開始處理 ${commentBlocks.length - outcomes.length} 則`,
      ...pending
    ];
    alert(summary.join('\n'));
  } catch (error) {
    console.error('[META AutoReply] Automation error:', error);
    alert('執行過程中發生錯誤：' + error.message);
  } finally {
    activeBatch = null;
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

  const initialMapping = postProductMapping;
  chrome.storage.sync.get(['settings', 'products', 'postProductMapping', 'showFloatingButton'], (result) => {
    if (!result) return;
    if (result.settings) currentSettings = result.settings;
    if (result.products) currentProducts = result.products;
    if (postProductMapping === initialMapping) applyPostProductMapping(result.postProductMapping);
    showFloatingButton = result.showFloatingButton !== false;
    applyFloatingButtonVisibility();
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
      if (changes.settings) currentSettings = changes.settings.newValue;
      if (changes.products) currentProducts = changes.products.newValue;
      if (changes.postProductMapping) {
        applyPostProductMapping(changes.postProductMapping.newValue);
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
