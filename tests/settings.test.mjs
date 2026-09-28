import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../chrome-extension/settings.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../chrome-extension/settings.html', import.meta.url), 'utf8');

function element(id = '') {
  const handlers = {};
  const classes = new Set();
  const node = {
    id, handlers, children: [], dataset: {}, style: {}, value: '', hidden: false, _html: '',
    classList: {
      contains: name => classes.has(name),
      toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }
    },
    addEventListener(name, handler) { handlers[name] = handler; },
    appendChild(child) {
      if (child.text !== undefined) {
        this._html += child.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      } else this.children.push(child);
    },
    setAttribute(name, value) { this[name] = value; },
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { this.reported = true; },
    focus() { this.focused = true; }
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return this._html || ''; },
    set(value) { this._html = value; this.children = []; }
  });
  return node;
}

function harness(seed = {}) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const nodes = Object.fromEntries(ids.map(id => [id, element(id)]));
  nodes['general-tab'].dataset.target = 'tab-general';
  nodes['bindings-tab'].dataset.target = 'tab-bindings';
  const body = element('body');
  const ready = [];
  const alerts = [];
  const confirmations = [];
  const reads = [];
  const writes = [];
  let failNext = false;
  const document = {
    body,
    getElementById: id => nodes[id],
    querySelectorAll: selector => selector === '.tab-btn'
      ? [nodes['general-tab'], nodes['bindings-tab']]
      : [nodes['tab-general'], nodes['tab-bindings']],
    createElement: tag => element(tag),
    createTextNode: text => ({ text }),
    addEventListener: (_name, handler) => ready.push(handler)
  };
  const context = vm.createContext({
    document, URL, structuredClone, console,
    alert: text => alerts.push(text),
    confirm: text => { confirmations.push(text); return true; },
    FileReader: class {
      readAsText(file) { reads.push(this.onload({ target: { result: file.content } })); }
    },
    chrome: {
      storage: {
        sync: {
          get: (_keys, callback) => callback(structuredClone(seed)),
          set: async value => {
            if (failNext) { failNext = false; throw new Error('quota'); }
            writes.push(structuredClone(value));
          }
        },
        onChanged: { addListener() {} }
      },
      runtime: { getManifest: () => ({ version: '1.5.2' }), sendNativeMessage() {} }
    }
  });
  vm.runInContext(source, context);
  ready.forEach(handler => handler());
  return {
    nodes, body, alerts, confirmations, writes,
    failSave() { failNext = true; },
    click(id) { return nodes[id].handlers.click({ target: nodes[id] }); },
    bodyClick(type, dataset, action) {
      const target = { dataset, classList: { contains: name => name === action } };
      return body.handlers.click({ target });
    },
    async importJson(content) {
      nodes['import-file'].files = [{ content }];
      nodes['import-file'].handlers.change({ target: nodes['import-file'] });
      await Promise.all(reads.splice(0));
    }
  };
}

test('editing and cancelling keeps the stored product and binding until save', async () => {
  const h = harness({
    products: [{ id: 'A', name: '舊商品', link: 'https://example.com/old' }],
    postProductMapping: { 'v2:facebook:1:2': 'A' }
  });
  h.bodyClick('product', { type: 'product', id: 'A' }, 'edit-btn');
  assert.equal(h.writes.length, 0);
  assert.equal(h.nodes['product-name'].value, '舊商品');
  h.click('cancel-product-btn');
  assert.equal(h.writes.length, 0);
  h.bodyClick('product', { type: 'product', id: 'A' }, 'edit-btn');
  h.nodes['product-name'].value = '新商品';
  await h.click('add-product-btn');
  assert.equal(h.writes.at(-1).products[0].name, '新商品');
  assert.equal(h.writes.at(-1).postProductMapping, undefined);
});

test('failed save preserves input and does not show an unsaved product', async () => {
  const h = harness();
  h.nodes['product-name'].value = '帳篷';
  h.nodes['product-link'].value = 'https://example.com/tent';
  h.failSave();
  await h.click('add-product-btn');
  assert.equal(h.writes.length, 0);
  assert.equal(h.nodes['product-name'].value, '帳篷');
  assert.equal(h.nodes['product-list'].children.length, 0);
  assert.match(h.nodes['save-status'].textContent, /儲存失敗/);
  await h.click('add-product-btn');
  assert.equal(h.writes.length, 1);
  assert.equal(h.nodes['product-name'].value, '');
});

test('deleting a product also removes its bindings in the same save', async () => {
  const h = harness({
    products: [{ id: 'A', name: '帳篷', link: 'https://example.com/a' }],
    postProductMapping: { 'v2:facebook:1:2': 'A' }
  });
  h.bodyClick('product', { type: 'product', id: 'A' }, 'delete-btn');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.writes.at(-1).products, []);
  assert.deepEqual(h.writes.at(-1).postProductMapping, {});
  assert.equal(h.nodes['product-list'].children.length, 0);
});

test('import validates data before saving and escapes displayed product text', async () => {
  const h = harness();
  await h.importJson(JSON.stringify({ products: [{ id: 'A', name: '<img src=x>', link: 'https://example.com/a' }] }));
  assert.equal(h.writes.length, 1);
  assert.match(h.nodes['product-list'].children[0].innerHTML, /&lt;img src=x&gt;/);
  assert.match(h.confirmations[0], /1 筆商品/);
  await h.importJson(JSON.stringify({ settings: { publicReplies: '不是陣列' } }));
  assert.equal(h.writes.length, 1);
  assert.match(h.alerts.at(-1), /回覆範本格式錯誤/);
});

test('settings-only import works with an older dangling binding', async () => {
  const h = harness({ postProductMapping: { 'v2:facebook:1:2': 'missing' } });
  await h.importJson(JSON.stringify({ settings: { fbMaxDelay: 80 } }));
  assert.equal(h.writes.at(-1).settings.fbMaxDelay, 80);
  assert.equal(h.writes.at(-1).postProductMapping, undefined);
});

test('invalid delay range is rejected and tab selection has accessible state', () => {
  const h = harness();
  h.nodes['fb-min-delay'].value = '90';
  h.nodes['fb-min-delay'].handlers.change({ target: h.nodes['fb-min-delay'] });
  assert.equal(h.writes.length, 0);
  assert.equal(h.nodes['fb-min-delay'].reported, true);
  h.click('bindings-tab');
  assert.equal(h.nodes['bindings-tab']['aria-selected'], 'true');
  assert.equal(h.nodes['tab-general'].hidden, true);
});
