function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str || '')));
  return div.innerHTML;
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

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // 移除目前所有的 active 狀態
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      // 加入 active 到點擊的 tab 與對應的 pane
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');
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

  // 儲存資料到 Chrome Storage
  function saveData() {
    chrome.storage.sync.set({ settings, products, postProductMapping });
  }

  // 渲染畫面
  function renderAll() {
    // 渲染商品列表
    elements.productList.innerHTML = '';
    products.forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div>
          <strong>${p.name}</strong>
          <a href="${p.link}" target="_blank">${p.link}</a>
        </div>
        <div class="action-buttons">
          <button class="edit-btn" data-id="${p.id}" data-type="product">編輯</button>
          <button class="delete-btn" data-id="${p.id}">刪除</button>
        </div>
      `;
      elements.productList.appendChild(li);
    });

    // 渲染公開回覆
    elements.publicReplyList.innerHTML = '';
    settings.publicReplies.forEach((r, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${r}</span> <div class="action-buttons"><button class="edit-btn" data-index="${i}" data-type="public">編輯</button><button class="delete-btn" data-index="${i}" data-type="public">刪除</button></div>`;
      elements.publicReplyList.appendChild(li);
    });

    // 渲染私訊開頭
    elements.dmPrefixList.innerHTML = '';
    settings.dmPrefixes.forEach((r, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${r} <span style="color:#94a3b8;font-size:12px;">[商品連結]</span></span> <div class="action-buttons"><button class="edit-btn" data-index="${i}" data-type="dm">編輯</button><button class="delete-btn" data-index="${i}" data-type="dm">刪除</button></div>`;
      elements.dmPrefixList.appendChild(li);
    });

    // 渲染私訊結尾
    elements.dmSuffixList.innerHTML = '';
    (settings.dmSuffixes || []).forEach((r, i) => {
      const li = document.createElement('li');
      // 將換行符號轉換為 <br> 以在 HTML 中正確顯示
      const formattedText = r.replace(/\n/g, '<br>');
      li.innerHTML = `<span><span style="color:#94a3b8;font-size:12px;display:block;margin-bottom:4px;">[商品連結]</span> ${formattedText}</span> <div class="action-buttons"><button class="edit-btn" data-index="${i}" data-type="dm-suffix">編輯</button><button class="delete-btn" data-index="${i}" data-type="dm-suffix">刪除</button></div>`;
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
        li.innerHTML = '目前還沒有任何貼文綁定紀錄。';
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
              <div style="font-size: 14px;color: #334155;margin-bottom:2px;">對應商品：${escapeHtml(productName)}</div>
              <a href="${escapeHtml(productLink)}" target="_blank" style="font-size:12px;color:#64748b;text-decoration:none;">${escapeHtml(productLink)}</a>
            </div>
            <div class="action-buttons" style="margin-left: 12px; align-self: center;">
              <button class="delete-btn" data-posttitle="${escapeHtml(postTitle)}" data-type="binding">解除綁定</button>
            </div>
          `;
          elements.bindingList.appendChild(li);
        }
      }
    }
  }

  // --- 事件監聽器 ---

  elements.addProductBtn.addEventListener('click', () => {
    if (elements.productName.value && elements.productLink.value) {
      products.push({
        id: Date.now().toString(),
        name: elements.productName.value,
        link: elements.productLink.value
      });
      elements.productName.value = '';
      elements.productLink.value = '';
      saveData();
      renderAll();
    }
  });

  elements.addPublicReplyBtn.addEventListener('click', () => {
    if (elements.publicReplyInput.value) {
      settings.publicReplies.push(elements.publicReplyInput.value);
      elements.publicReplyInput.value = '';
      saveData();
      renderAll();
    }
  });

  elements.addDmPrefixBtn.addEventListener('click', () => {
    if (elements.dmPrefixInput.value) {
      settings.dmPrefixes.push(elements.dmPrefixInput.value);
      elements.dmPrefixInput.value = '';
      saveData();
      renderAll();
    }
  });

  elements.addDmSuffixBtn.addEventListener('click', () => {
    if (elements.dmSuffixInput.value) {
      if (!settings.dmSuffixes) settings.dmSuffixes = [];
      settings.dmSuffixes.push(elements.dmSuffixInput.value);
      elements.dmSuffixInput.value = '';
      saveData();
      renderAll();
    }
  });

  elements.fbMinDelay.addEventListener('change', (e) => {
    settings.fbMinDelay = parseInt(e.target.value) || 15;
    saveData();
  });

  elements.fbMaxDelay.addEventListener('change', (e) => {
    settings.fbMaxDelay = parseInt(e.target.value) || 60;
    saveData();
  });

  elements.igMinDelay.addEventListener('change', (e) => {
    settings.igMinDelay = parseInt(e.target.value) || 30;
    saveData();
  });

  elements.igMaxDelay.addEventListener('change', (e) => {
    settings.igMaxDelay = parseInt(e.target.value) || 60;
    saveData();
  });

  elements.igDmWaitTime.addEventListener('change', (e) => {
    settings.igDmWaitTime = parseInt(e.target.value) || 10;
    saveData();
  });

  elements.igDmRetries.addEventListener('change', (e) => {
    settings.igDmRetries = parseInt(e.target.value) || 0;
    // Allow 0 retries, so use an explicit check if needed, but parseInt(e.target.value) 
    // will be 0 when '0' is entered. e.target.value === '0' check is safer.
    if (e.target.value === '0' || e.target.value === 0) {
      settings.igDmRetries = 0;
    }
    saveData();
  });

  // 使用事件委派處理刪除與編輯按鈕
  document.body.addEventListener('click', (e) => {
    if (e.target.classList.contains('delete-btn')) {
      const id = e.target.getAttribute('data-id');
      const index = e.target.getAttribute('data-index');
      const type = e.target.getAttribute('data-type');

      if (id) {
        products = products.filter(p => p.id !== id);
      } else if (type === 'public') {
        settings.publicReplies.splice(index, 1);
      } else if (type === 'dm') {
        settings.dmPrefixes.splice(index, 1);
      } else if (type === 'dm-suffix') {
        settings.dmSuffixes.splice(index, 1);
      } else if (type === 'binding') {
        const postTitle = e.target.getAttribute('data-posttitle');
        // Because escapeHtml might alter some characters unnecessarily if we match directly? 
        // No, it was encoded, but the DOM stores original if we use attribute usually, but we injected with escapeHtml.
        // Actually, we should just find matching key. We can unescape HTML manually, or search values.
        // Let's iterate and safely match.
        // But data-posttitle will have escaped entity inside it maybe?
        const decodedTitle = document.createElement('textarea');
        decodedTitle.innerHTML = postTitle;
        const rawTitle = decodedTitle.value;
        if (postProductMapping[rawTitle]) {
          delete postProductMapping[rawTitle];
        } else if (postProductMapping[postTitle]) {
          // Fallback if not escaped
          delete postProductMapping[postTitle];
        } else {
           // Trying to find it by value search
           const matchKey = Object.keys(postProductMapping).find(k => escapeHtml(k) === postTitle);
           if (matchKey) delete postProductMapping[matchKey];
        }
      }
      saveData();
      renderAll();
    } else if (e.target.classList.contains('edit-btn')) {
      const id = e.target.getAttribute('data-id');
      const index = e.target.getAttribute('data-index');
      const type = e.target.getAttribute('data-type');

      if (type === 'product') {
        const p = products.find(p => p.id === id);
        if (p) {
          elements.productName.value = p.name;
          elements.productLink.value = p.link;
          products = products.filter(p => p.id !== id);
          elements.productName.focus();
        }
      } else if (type === 'public') {
        elements.publicReplyInput.value = settings.publicReplies[index];
        settings.publicReplies.splice(index, 1);
        elements.publicReplyInput.focus();
      } else if (type === 'dm') {
        elements.dmPrefixInput.value = settings.dmPrefixes[index];
        settings.dmPrefixes.splice(index, 1);
        elements.dmPrefixInput.focus();
      } else if (type === 'dm-suffix') {
        elements.dmSuffixInput.value = settings.dmSuffixes[index];
        settings.dmSuffixes.splice(index, 1);
        elements.dmSuffixInput.focus();
      }
      saveData();
      renderAll();
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
    result.push(currentParam);
    return result;
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
      reader.onload = (event) => {
        try {
          const importedData = JSON.parse(event.target.result);
          if (importedData.settings) settings = importedData.settings;
          if (importedData.products) products = importedData.products;
          if (importedData.postProductMapping) postProductMapping = importedData.postProductMapping;
          saveData();
          renderAll();
          alert('設定匯入成功！');
        } catch (err) {
          alert('匯入失敗：檔案格式錯誤');
        }
        // 重置 input 以便下次可以選擇同一個檔案
        importFile.value = '';
      };
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
      reader.onload = (event) => {
        try {
          const csvText = event.target.result;
          const lines = csvText.split(/\r?\n/);
          
          let importedCount = 0;
          // 略過第一行 Header
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const row = parseCsvRow(line);
            if (row.length >= 2) {
              const postTitle = row[0];
              const productId = row[1];
              if (postTitle && productId) {
                postProductMapping[postTitle] = productId;
                importedCount++;
              }
            }
          }
          
          saveData();
          renderAll();
          alert(`綁定匯入成功！共匯入或更新了 ${importedCount} 筆綁定紀錄。`);
        } catch (err) {
          console.error(err);
          alert('匯入失敗：CSV 檔案格式錯誤');
        }
        importBindingCsvFile.value = '';
      };
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
