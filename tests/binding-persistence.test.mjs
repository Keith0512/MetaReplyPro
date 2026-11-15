import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const background = readFileSync(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
const content = readFileSync(new URL('../chrome-extension/content.js', import.meta.url), 'utf8');
const mappingBytes = mapping => Buffer.byteLength('postProductMapping' + JSON.stringify(mapping));
const key = post => `v2:facebook:100:${post}`;

function element() {
  return {
    style: {}, handlers: {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    appendChild() {}, setAttribute() {}, contains: () => false, remove() {}
  };
}

function extension(mapping) {
  const stored = {
    postProductMapping: structuredClone(mapping),
    products: ['A', 'new-id'].map(id => ({ id, name: id, link: 'https://example.com/' + id }))
  };
  const onChanged = [];
  const lockQueues = new Map();
  let messageHandler;
  let rejectNextWrite = false;
  const storage = {
    sync: {
      get: (_keys, callback) => {
        const snapshot = structuredClone(stored);
        if (callback) callback(snapshot);
        else return Promise.resolve(snapshot);
      },
      set: async ({ postProductMapping }) => {
        if (rejectNextWrite) {
          rejectNextWrite = false;
          throw new Error('同步寫入頻率超過上限');
        }
        if (mappingBytes(postProductMapping) > 8192) throw new Error('超出同步項目大小上限');
        stored.postProductMapping = structuredClone(postProductMapping);
        for (const listener of onChanged) {
          listener({ postProductMapping: { newValue: structuredClone(postProductMapping) } }, 'sync');
        }
      }
    },
    onChanged: { addListener: listener => onChanged.push(listener) }
  };
  const console = { log() {}, error() {} };
  vm.runInNewContext(background, {
    console,
    navigator: { locks: { request(name, work) {
      const operation = (lockQueues.get(name) || Promise.resolve()).then(work);
      lockQueues.set(name, operation.catch(() => {}));
      return operation;
    } } },
    chrome: {
      storage,
      runtime: {
        onInstalled: { addListener() {} }, onStartup: { addListener() {} },
        onMessage: { addListener: listener => { messageHandler = listener; } }
      },
      alarms: { onAlarm: { addListener() {} } }
    }
  });

  const sendMessage = message => new Promise(resolve => messageHandler(message, {}, value => resolve(structuredClone(value))));
  return {
    stored, sendMessage,
    rejectWrite() { rejectNextWrite = true; },
    tab(post) {
      const alerts = [];
      const created = [];
      const document = {
        body: element(), querySelector: () => null, querySelectorAll: () => [],
        createElement: () => created.shift(), addEventListener() {}
      };
      const context = vm.createContext({
        URL, console, document, setTimeout() {},
        window: { location: new URL(`https://business.facebook.com/latest/inbox/facebook?asset_id=100&selected_item_id=${post}`) },
        alert: message => alerts.push(message), chrome: { storage, runtime: { sendMessage } },
        anchor: { getBoundingClientRect: () => ({ bottom: 0, left: 0 }) }
      });
      const run = code => vm.runInContext(code, context);
      run(content);
      run('escapeHtml = value => String(value ?? "");');
      let floatingButton;
      return {
        alerts,
        save(productId) {
          const nodes = { '#binding-save': element(), '#binding-select': { value: productId }, '#binding-cancel': element() };
          created.push({ ...element(), querySelector: selector => nodes[selector] });
          run('showBindingDialog(anchor)');
          return nodes['#binding-save'].handlers.click();
        },
        menuSelection() {
          if (!floatingButton) {
            const nodes = { '#meta-auto-reply-start': element(), '#meta-auto-reply-scan': element() };
            floatingButton = element();
            created.push(element(), floatingButton, { ...element(), querySelector: selector => nodes[selector], querySelectorAll: () => [] });
            run('injectFloatingButton()');
          }
          const click = () => floatingButton.handlers.click({ preventDefault() {}, stopPropagation() {} });
          click();
          const selection = run('selectedProduct?.id ?? null');
          click();
          return selection;
        }
      };
    }
  };
}

test('oversized replacement preserves the saved binding and old entries in both storage and the menu', async () => {
  const mapping = { [key(200)]: 'A' };
  const legacyTitle = '舊' + 'x'.repeat(8190 - mappingBytes({ ...mapping, '舊': 'A' }));
  mapping[legacyTitle] = 'A';
  const app = extension(mapping);
  const tab = app.tab(200);
  const pending = tab.save('new-id');
  assert.equal(tab.menuSelection(), 'A');
  await pending;
  assert.match(tab.alerts.at(-1), /儲存失敗.*上限/);
  assert.equal(tab.menuSelection(), 'A');
  assert.deepEqual(app.stored.postProductMapping, mapping);
});

test('a rejected unbind leaves the menu selection intact and a retry updates both tabs', async () => {
  const app = extension({ [key(200)]: 'A', '舊貼文': 'A' });
  const tab = app.tab(200);
  const otherTab = app.tab(200);
  app.rejectWrite();
  await tab.save('');
  assert.match(tab.alerts.at(-1), /儲存失敗/);
  assert.equal(tab.menuSelection(), 'A');
  assert.equal(otherTab.menuSelection(), 'A');
  await tab.save('');
  assert.match(tab.alerts.at(-1), /已解除綁定/);
  assert.equal(tab.menuSelection(), null);
  assert.equal(otherTab.menuSelection(), null);
  assert.deepEqual(app.stored.postProductMapping, { '舊貼文': 'A' });
});

test('simultaneous binding writes merge against storage and only stable keys with existing products are accepted', async () => {
  const app = extension({ [key(200)]: 'A', '舊貼文': 'A' });
  const first = app.tab(200);
  const second = app.tab(201);
  await Promise.all([first.save(''), second.save('new-id')]);
  assert.equal(first.menuSelection(), null);
  assert.equal(second.menuSelection(), 'new-id');
  assert.deepEqual(app.stored.postProductMapping, { [key(201)]: 'new-id', '舊貼文': 'A' });

  const save = (postKey, productId) => app.sendMessage({ action: 'savePostProductBinding', postKey, productId });
  assert.equal((await save('舊貼文', null)).ok, false);
  assert.equal((await save(key(201), 'deleted')).ok, false);
  assert.equal(second.menuSelection(), 'new-id');
  assert.deepEqual(app.stored.postProductMapping, { [key(201)]: 'new-id', '舊貼文': 'A' });
});
