function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str || '')));
  return div.innerHTML;
}

function escapeAttribute(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function validProductLink(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  let settings = {
    fbMinDelay: 15,
    fbMaxDelay: 60,
    igMinDelay: 30,
    igMaxDelay: 60,
    igDmWaitTime: 10,
    igDmRetries: 3,
    publicReplies: [],
    dmPrefixes: [],
    dmSuffixes: []
  };
  let products = [];
  let postProductMapping = {};
  let saveQueue = Promise.resolve();
  let editingProductId = null;
  const saveStatus = document.getElementById('save-status');

  const elements = {
    productName: document.getElementById('product-name'),
    productLink: document.getElementById('product-link'),
    addProductBtn: document.getElementById('add-product-btn'),
    productList: document.getElementById('product-list'),

    publicReplyInput: document.getElementById('public-reply-input'),
    addPublicReplyBtn: document.getElementById('add-public-reply-btn'),
    publicReplyList: document.getElementById('public-reply-list'),

    dmPrefixInput: document.getElementById('dm-prefix-input'),
    addDmPrefixBtn: document.getElementById('add-dm-prefix-btn'),
    dmPrefixList: document.getElementById('dm-prefix-list'),

    dmSuffixInput: document.getElementById('dm-suffix-input'),
    addDmSuffixBtn: document.getElementById('add-dm-suffix-btn'),
    dmSuffixList: document.getElementById('dm-suffix-list'),

    fbMinDelay: document.getElementById('fb-min-delay'),
    fbMaxDelay: document.getElementById('fb-max-delay'),
    igMinDelay: document.getElementById('ig-min-delay'),
    igMaxDelay: document.getElementById('ig-max-delay'),
    igDmWaitTime: document.getElementById('ig-dm-wait-time'),
    igDmRetries: document.getElementById('ig-dm-retries'),
    
    bindingList: document.getElementById('binding-list')
  };

  // --- 分頁切換功能 ---
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  function activateTab(btn) {
    tabBtns.forEach(b => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
      b.tabIndex = active ? 0 : -1;
    });
    tabPanes.forEach(p => {
      const active = p.id === btn.dataset.target;
      p.classList.toggle('active', active);
      p.hidden = !active;
    });
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn));
    btn.addEventListener('keydown', (e) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const index = Array.from(tabBtns).indexOf(btn);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabBtns.length - 1
        : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabBtns.length) % tabBtns.length;
      activateTab(tabBtns[next]);
      tabBtns[next].focus();
    });
  });

  // 讀取 Chrome Storage 資料
  chrome.storage.sync.get(['settings', 'products', 'postProductMapping'], (data) => {
    if (data.settings) {
      settings = Object.assign({}, settings, data.settings);
      
      // 舊版相容：將原本的 minDelay, maxDelay 轉為 fb/ig
      if (settings.minDelay !== undefined) {
        settings.fbMinDelay = settings.minDelay;
        settings.igMinDelay = Math.max(30, settings.minDelay); // IG 建議 30 起跳
        delete settings.minDelay;
      }
      if (settings.maxDelay !== undefined) {
        settings.fbMaxDelay = settings.maxDelay;
        settings.igMaxDelay = Math.max(60, settings.maxDelay);
        delete settings.maxDelay;
      }
      
      // 確保設定存在
      if (settings.fbMinDelay === undefined) settings.fbMinDelay = 15;
      if (settings.fbMaxDelay === undefined) settings.fbMaxDelay = 60;
      if (settings.igMinDelay === undefined) settings.igMinDelay = 30;
      if (settings.igMaxDelay === undefined) settings.igMaxDelay = 60;
      if (settings.igDmWaitTime === undefined) settings.igDmWaitTime = 10;
      if (settings.igDmRetries === undefined) settings.igDmRetries = 3;
    }
    if (data.products) products = data.products;
    if (data.postProductMapping) postProductMapping = data.postProductMapping;
    renderAll();
  });

  function showSaveStatus(message, error = false) {
    saveStatus.textContent = message;
    saveStatus.classList.toggle('error', error);
  }

  // 循序儲存，避免連續操作以較舊的資料覆蓋較新的資料。
  function saveData(change, onSaved) {
    const operation = saveQueue.then(async () => {
      let next;
      try {
        const current = {
          settings: structuredClone(settings),
          products: structuredClone(products),
          postProductMapping: structuredClone(postProductMapping)
        };
        next = structuredClone(current);
        change(next);
        const changed = Object.fromEntries(Object.keys(next)
          .filter(key => JSON.stringify(next[key]) !== JSON.stringify(current[key]))
          .map(key => [key, next[key]]));
        if (Object.keys(changed).length) await chrome.storage.sync.set(changed);
      } catch (err) {
        showSaveStatus('儲存失敗，變更尚未套用。請重試；若持續失敗，請檢查 Chrome 同步容量或先匯出備份。', true);
        return false;
      }
      settings = next.settings;
      products = next.products;
      postProductMapping = next.postProductMapping;
      renderAll();
      if (onSaved) onSaved();
      showSaveStatus('已儲存並同步至 Chrome。');
      return true;
    });
    saveQueue = operation.then(() => {});
    return operation;
  }

  // 渲染畫面
  function renderAll() {
    // 渲染商品列表
    elements.productList.innerHTML = '';
    products.forEach(p => {
      const li = document.createElement('li');
      const link = validProductLink(p.link)
        ? `<a href="${escapeAttribute(p.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.link)}</a>`
        : `<span>連結格式錯誤：${escapeHtml(p.link)}</span>`;
      li.innerHTML = `
        <div>
          <strong>${escapeHtml(p.name)}</strong>
          ${link}
        </div>
        <div class="action-buttons">
          <button class="edit-btn" data-id="${escapeAttribute(p.id)}" data-type="product">編輯</button>
          <button class="delete-btn" data-id="${escapeAttribute(p.id)}" data-type="product">刪除</button>
        </div>
      `;
      elements.productList.appendChild(li);
    });

    // 渲染公開回覆
    elements.publicReplyList.innerHTML = '';
    settings.publicReplies.forEach((r, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(r)}</span> <div class="action-buttons"><button class="edit-btn" data-index="${i}" data-type="public">編輯</button><button class="delete-btn" data-index="${i}" data-type="public">刪除</button></div>`;
      elements.publicReplyList.appendChild(li);
    });

    // 渲染私訊開頭
    elements.dmPrefixList.innerHTML = '';
    settings.dmPrefixes.forEach((r, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(r)} <span style="color:#64748b;font-size:12px;">[商品連結]</span></span> <div class="action-buttons"><button class="edit-btn" data-index="${i}" data-type="dm">編輯</button><button class="delete-btn" data-index="${i}" data-type="dm">刪除</button></div>`;
      elements.dmPrefixList.appendChild(li);
    });

    // 渲染私訊結尾
    elements.dmSuffixList.innerHTML = '';
    (settings.dmSuffixes || []).forEach((r, i) => {
      const li = document.createElement('li');
      // 將換行符號轉換為 <br> 以在 HTML 中正確顯示
      const formattedText = escapeHtml(r).replace(/\n/g, '<br>');
      li.innerHTML = `<span><span style="color:#64748b;font-size:12px;display:block;margin-bottom:4px;">[商品連結]</span> ${formattedText}</span> <div class="action-buttons"><button class="edit-btn" data-index="${i}" data-type="dm-suffix">編輯</button><button class="delete-btn" data-index="${i}" data-type="dm-suffix">刪除</button></div>`;
      elements.dmSuffixList.appendChild(li);
    });

    // 渲染延遲時間
    elements.fbMinDelay.value = settings.fbMinDelay;
    elements.fbMaxDelay.value = settings.fbMaxDelay;
    elements.igMinDelay.value = settings.igMinDelay;
    elements.igMaxDelay.value = settings.igMaxDelay;
    elements.igDmWaitTime.value = settings.igDmWaitTime;
    elements.igDmRetries.value = settings.igDmRetries;

    // 渲染綁定清單
    if (elements.bindingList) {
      elements.bindingList.innerHTML = '';
      if (Object.keys(postProductMapping).length === 0) {
        const li = document.createElement('li');
        li.style.justifyContent = 'center';
        li.style.color = '#64748b';
        li.textContent = '目前沒有貼文綁定。請到 Meta 貼文使用「綁定商品」，或先在一般設定新增商品。';
        elements.bindingList.appendChild(li);
      } else {
        for (const [postTitle, productId] of Object.entries(postProductMapping)) {
          const product = products.find(p => p.id === productId);
          const productName = product ? product.name : '未知商品 (已被刪除)';
          const productLink = product ? product.link : '#';
          
          const li = document.createElement('li');
          li.style.alignItems = 'flex-start';
          li.innerHTML = `
            <div style="flex:1;">
              <strong style="color: #4f46e5;font-size:13px;margin-bottom:6px;display:block;word-break:break-all;">${escapeHtml(postTitle)}</strong>
              ${!/^v2:(facebook|instagram):[0-9]+:[0-9]+(?:_[0-9]+)?$/.test(postTitle) ? '<div style="color:#b45309;font-size:12px;">舊版紀錄（不再自動套用）：請到原貼文核對商品並重新綁定。</div>' : ''}
              <div style="font-size: 14px;color: #334155;margin-bottom:2px;">對應商品：${escapeHtml(productName)}</div>
              ${validProductLink(productLink) ? `<a href="${escapeAttribute(productLink)}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:#475569;text-decoration:none;">${escapeHtml(productLink)}</a>` : ''}
            </div>
            <div class="action-buttons" style="margin-left: 12px; align-self: center;">
              <button class="delete-btn" data-posttitle="${escapeAttribute(postTitle)}" data-type="binding">解除綁定</button>
            </div>
          `;
          elements.bindingList.appendChild(li);
        }
      }
    }
  }

  // --- 事件監聽器 ---

  const cancelProductBtn = document.getElementById('cancel-product-btn');
  function resetProductEditor() {
    editingProductId = null;
    elements.productName.value = '';
    elements.productLink.value = '';
    elements.addProductBtn.textContent = '新增';
    cancelProductBtn.hidden = true;
  }
  cancelProductBtn.addEventListener('click', resetProductEditor);
  elements.addProductBtn.addEventListener('click', async () => {
    const name = elements.productName.value.trim();
    const link = elements.productLink.value.trim();
    if (!name) {
      elements.productName.setCustomValidity('請輸入商品名稱。');
      elements.productName.reportValidity();
      return;
    }
    if (!validProductLink(link)) {
      elements.productLink.setCustomValidity('請輸入 http 或 https 商品連結。');
      elements.productLink.reportValidity();
      return;
    }
    const editId = editingProductId;
    elements.addProductBtn.disabled = true;
    await saveData(draft => {
      if (editId) {
        const product = draft.products.find(p => p.id === editId);
        if (!product) throw new Error('商品已不存在');
        product.name = name;
        product.link = link;
      } else {
        draft.products.push({ id: Date.now().toString(), name, link });
      }
    }, resetProductEditor);
    elements.addProductBtn.disabled = false;
  });
  [elements.productName, elements.productLink].forEach(input => {
    input.addEventListener('input', () => input.setCustomValidity(''));
  });

  const templateEditors = {
    public: { input: elements.publicReplyInput, button: elements.addPublicReplyBtn, cancel: document.getElementById('cancel-public-reply-btn'), key: 'publicReplies', index: null },
    dm: { input: elements.dmPrefixInput, button: elements.addDmPrefixBtn, cancel: document.getElementById('cancel-dm-prefix-btn'), key: 'dmPrefixes', index: null },
    'dm-suffix': { input: elements.dmSuffixInput, button: elements.addDmSuffixBtn, cancel: document.getElementById('cancel-dm-suffix-btn'), key: 'dmSuffixes', index: null }
  };
  Object.values(templateEditors).forEach(editor => {
    const reset = () => {
      editor.index = null;
      editor.input.value = '';
      editor.button.textContent = '新增';
      editor.cancel.hidden = true;
    };
    editor.cancel.addEventListener('click', reset);
    editor.input.addEventListener('input', () => editor.input.setCustomValidity(''));
    editor.button.addEventListener('click', async () => {
      const value = editor.input.value.trim();
      if (!value) {
        editor.input.setCustomValidity('請輸入回覆內容。');
        editor.input.reportValidity();
        return;
      }
      const editIndex = editor.index;
      editor.button.disabled = true;
      await saveData(draft => {
        const list = draft.settings[editor.key];
        if (editIndex === null) list.push(value);
        else if (editIndex < list.length) list[editIndex] = value;
        else throw new Error('範本已不存在');
      }, reset);
      editor.button.disabled = false;
    });
  });

  const delayFields = [
    ['fbMinDelay', elements.fbMinDelay, 1], ['fbMaxDelay', elements.fbMaxDelay, 1],
    ['igMinDelay', elements.igMinDelay, 1], ['igMaxDelay', elements.igMaxDelay, 1],
    ['igDmWaitTime', elements.igDmWaitTime, 1], ['igDmRetries', elements.igDmRetries, 0]
  ];
  delayFields.forEach(([key, input, minimum]) => {
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('change', () => {
      const value = Number(input.value);
      const candidate = { ...settings, [key]: value };
      let message = '';
      if (!input.value.trim() || !Number.isInteger(value) || value < minimum) message = `請輸入不小於 ${minimum} 的整數。`;
      else if (candidate.fbMinDelay > candidate.fbMaxDelay || candidate.igMinDelay > candidate.igMaxDelay) {
        message = '最小延遲不可大於最大延遲。';
      }
      if (message) {
        input.setCustomValidity(message);
        input.reportValidity();
        showSaveStatus(message, true);
        return;
      }
      saveData(draft => { draft.settings[key] = value; });
    });
  });

  // 編輯保留原項目；只有按「儲存」後才寫入新值。
  document.body.addEventListener('click', (e) => {
    if (e.target.classList.contains('delete-btn')) {
      const id = e.target.dataset.id;
      const index = Number(e.target.dataset.index);
      const type = e.target.dataset.type;
      const postTitle = e.target.dataset.posttitle;
      const product = products.find(p => p.id === id);
      const linkedCount = id ? Object.values(postProductMapping).filter(value => value === id).length : 0;
      const warning = linkedCount ? `，並解除 ${linkedCount} 筆貼文綁定` : '';
      if (!confirm(`確定要刪除${product ? `「${product.name}」` : '這筆資料'}${warning}？此動作無法復原。`)) return;
      saveData(draft => {
        if (type === 'product') {
          draft.products = draft.products.filter(p => p.id !== id);
          for (const [key, value] of Object.entries(draft.postProductMapping)) {
            if (value === id) delete draft.postProductMapping[key];
          }
        } else if (type === 'binding') delete draft.postProductMapping[postTitle];
        else draft.settings[templateEditors[type].key].splice(index, 1);
      });
    } else if (e.target.classList.contains('edit-btn')) {
      const id = e.target.dataset.id;
      const index = Number(e.target.dataset.index);
      const type = e.target.dataset.type;
      if (type === 'product') {
        const product = products.find(p => p.id === id);
        if (!product) return;
        editingProductId = id;
        elements.productName.value = product.name;
        elements.productLink.value = product.link;
        elements.addProductBtn.textContent = '儲存';
        cancelProductBtn.hidden = false;
        elements.productName.focus();
      } else {
        const editor = templateEditors[type];
        editor.index = index;
        editor.input.value = settings[editor.key][index];
        editor.button.textContent = '儲存';
        editor.cancel.hidden = false;
        editor.input.focus();
      }
    }
  });

  // --- 簡易 CSV 解析器 ---
  function parseCsvRow(text) {
    const result = [];
    let insideQuote = false;
    let currentParam = '';
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            if (insideQuote && text[i+1] === '"') {
                currentParam += '"';
                i++;
            } else {
                insideQuote = !insideQuote;
            }
        } else if (char === ',' && !insideQuote) {
            result.push(currentParam);
            currentParam = '';
        } else {
            currentParam += char;
        }
    }
    if (insideQuote) throw new Error('CSV 引號未關閉。');
    result.push(currentParam);
    return result;
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validateBackup(data) {
    if (!isRecord(data) || !['settings', 'products', 'postProductMapping'].some(key => Object.hasOwn(data, key))) {
      throw new Error('檔案沒有可匯入的設定。');
    }
    if (Object.hasOwn(data, 'settings') && !isRecord(data.settings)) throw new Error('回覆設定格式錯誤。');
    const nextSettings = Object.hasOwn(data, 'settings') ? { ...settings, ...data.settings } : settings;
    const nextProducts = Object.hasOwn(data, 'products') ? data.products : products;
    const nextMapping = Object.hasOwn(data, 'postProductMapping') ? data.postProductMapping : postProductMapping;
    if (!isRecord(nextSettings)) throw new Error('回覆設定格式錯誤。');
    for (const key of ['publicReplies', 'dmPrefixes', 'dmSuffixes']) {
      if (!Array.isArray(nextSettings[key]) || !nextSettings[key].every(value => typeof value === 'string' && value.trim())) {
        throw new Error('回覆範本格式錯誤。');
      }
    }
    for (const key of ['fbMinDelay', 'fbMaxDelay', 'igMinDelay', 'igMaxDelay', 'igDmWaitTime', 'igDmRetries']) {
      const minimum = key === 'igDmRetries' ? 0 : 1;
      if (!Number.isInteger(nextSettings[key]) || nextSettings[key] < minimum) throw new Error('延遲或重試次數格式錯誤。');
    }
    if (nextSettings.fbMinDelay > nextSettings.fbMaxDelay || nextSettings.igMinDelay > nextSettings.igMaxDelay) {
      throw new Error('最小延遲不可大於最大延遲。');
    }
    if (!Array.isArray(nextProducts) || !nextProducts.every(p =>
      isRecord(p) && typeof p.id === 'string' && p.id && typeof p.name === 'string' && p.name.trim() &&
      typeof p.link === 'string' && validProductLink(p.link))) {
      throw new Error('商品資料或連結格式錯誤。');
    }
    const ids = new Set(nextProducts.map(p => p.id));
    if (ids.size !== nextProducts.length) throw new Error('商品 ID 重複。');
    if ((Object.hasOwn(data, 'products') || Object.hasOwn(data, 'postProductMapping')) &&
      (!isRecord(nextMapping) || !Object.entries(nextMapping).every(([key, id]) =>
        key && !['__proto__', 'constructor', 'prototype'].includes(key) && typeof id === 'string' && ids.has(id)))) {
      throw new Error('貼文綁定包含不存在的商品。');
    }
    return { settings: nextSettings, products: nextProducts, postProductMapping: nextMapping };
  }

  // --- 匯出與匯入功能 ---
  const exportBtn = document.getElementById('export-btn');
  const importBtn = document.getElementById('import-btn');
  const importFile = document.getElementById('import-file');

  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const dataToExport = { settings, products, postProductMapping };
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(dataToExport, null, 2));
      const downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href", dataStr);
      downloadAnchorNode.setAttribute("download", "meta-autoreply-settings.json");
      document.body.appendChild(downloadAnchorNode); // required for firefox
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
    });
  }

  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => {
      importFile.click();
    });

    importFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const importedData = JSON.parse(event.target.result);
          await saveQueue;
          const next = validateBackup(importedData);
          const sections = [
            Object.hasOwn(importedData, 'settings') && '回覆與延遲設定',
            Object.hasOwn(importedData, 'products') && `${next.products.length} 筆商品`,
            Object.hasOwn(importedData, 'postProductMapping') && `${Object.keys(next.postProductMapping).length} 筆貼文綁定`
          ].filter(Boolean);
          if (!confirm(`匯入將取代目前的${sections.join('、')}。確定繼續？`)) return;
          const saved = await saveData(draft => Object.assign(draft, next));
          if (saved) alert('設定匯入成功！');
        } catch (err) {
          alert(`匯入失敗：${err.message}`);
        } finally {
          importFile.value = '';
        }
      };
      reader.onerror = () => { alert('匯入失敗：無法讀取檔案。'); importFile.value = ''; };
      reader.readAsText(file);
    });
  }

  // --- CSV 貼文綁定匯出與匯入功能 ---
  const exportBindingCsvBtn = document.getElementById('export-binding-csv-btn');
  const importBindingCsvBtn = document.getElementById('import-binding-csv-btn');
  const importBindingCsvFile = document.getElementById('import-binding-csv-file');

  if (exportBindingCsvBtn) {
    exportBindingCsvBtn.addEventListener('click', () => {
      // 加入 \uFEFF BOM 標籤讓 Excel 能夠正確解析 UTF-8
      let csvContent = "\uFEFF貼文識別,商品ID\n";
      for (const [postTitle, productId] of Object.entries(postProductMapping)) {
        const safeTitle = `"${postTitle.replace(/"/g, '""')}"`;
        const safeId = `"${productId.replace(/"/g, '""')}"`;
        csvContent += `${safeTitle},${safeId}\n`;
      }

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", "meta-autoreply-bindings.csv");
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    });
  }

  if (importBindingCsvBtn && importBindingCsvFile) {
    importBindingCsvBtn.addEventListener('click', () => {
      importBindingCsvFile.click();
    });

    importBindingCsvFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          await saveQueue;
          const csvText = event.target.result;
          const lines = csvText.split(/\r?\n/);
          if (lines[0].replace(/^\uFEFF/, '') !== '貼文識別,商品ID') throw new Error('標題列不符。');
          const imported = [];
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const row = parseCsvRow(line);
            if (row.length !== 2 || !row[0] || ['__proto__', 'constructor', 'prototype'].includes(row[0]) || !products.some(p => p.id === row[1])) {
              throw new Error(`第 ${i + 1} 行格式錯誤或商品 ID 不存在。`);
            }
            imported.push(row);
          }
          if (!imported.length) throw new Error('檔案沒有可匯入的貼文綁定。');
          const replacements = imported.filter(([key]) => Object.hasOwn(postProductMapping, key)).length;
          if (!confirm(`將匯入 ${imported.length} 筆貼文綁定，其中 ${replacements} 筆會覆寫現有綁定。確定繼續？`)) return;
          const saved = await saveData(draft => {
            for (const [key, id] of imported) draft.postProductMapping[key] = id;
          });
          if (saved) alert(`綁定匯入成功！共匯入或更新了 ${imported.length} 筆綁定紀錄。`);
        } catch (err) {
          alert(`匯入失敗：${err.message}`);
        } finally {
          importBindingCsvFile.value = '';
        }
      };
      reader.onerror = () => { alert('匯入失敗：無法讀取檔案。'); importBindingCsvFile.value = ''; };
      reader.readAsText(file);
    });
  }

  // 監聽來自其他分頁 (例如 content script) 的 storage 變更
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
      let changed = false;
      if (changes.settings) {
        settings = changes.settings.newValue || {};
        changed = true;
      }
      if (changes.products) {
        products = changes.products.newValue || [];
        changed = true;
      }
      if (changes.postProductMapping) {
        postProductMapping = changes.postProductMapping.newValue || {};
        changed = true;
      }
      if (changed) {
        renderAll();
      }
    }
  });
});

// --- 版本與更新 ---
// 版本資訊只由本機顯示；遠端 release 必須交給原生更新器驗證簽章，
// 避免擴充功能直接信任未驗證的 GitHub manifest。
document.addEventListener('DOMContentLoaded', () => {
  const versionEl = document.getElementById('current-version');
  const statusEl = document.getElementById('update-status');
  const checkBtn = document.getElementById('check-update-btn');

  versionEl.textContent = chrome.runtime.getManifest().version;

  checkBtn.addEventListener('click', () => {
    statusEl.textContent = '「立即更新」會先驗證正式版本的簽章與檔案雜湊；若已是最新版，不會替換檔案。';
  });

  // 「立即更新」透過 Native Messaging 呼叫本機的 update-host（由安裝腳本註冊），
  // host 執行目前作業系統的安全更新器後回報結果，這裡再重新載入擴充功能套用新版。
  const runUpdateBtn = document.getElementById('run-update-btn');
  runUpdateBtn.addEventListener('click', () => {
    statusEl.textContent = '正在下載並驗證安全更新，請稍候…';
    runUpdateBtn.disabled = true;
    chrome.runtime.sendNativeMessage('com.metareplypro.updater', { action: 'update' }, (resp) => {
      runUpdateBtn.disabled = false;
      if (chrome.runtime.lastError) {
        statusEl.textContent = '無法啟動安全更新程式：請用對應 Windows／macOS 的正式安裝包重新安裝；Windows 也可使用桌面的更新捷徑。';
        return;
      }
      if (resp && resp.ok && resp.updated) {
        statusEl.textContent = `更新完成（${resp.before} → ${resp.after}），3 秒後套用新版；套用後請重新整理此頁。`;
        setTimeout(() => chrome.runtime.reload(), 3000);
      } else if (resp && resp.ok) {
        statusEl.textContent = `已是最新版（${resp.after || resp.before}）。`;
      } else {
        statusEl.textContent = (resp && resp.message) ? `更新失敗：${resp.message}` : '更新失敗（release 不可用、簽章無效或網路問題）。';
      }
    });
  });
});
