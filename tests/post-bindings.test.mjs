import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../chrome-extension/content.js', import.meta.url), 'utf8');
const postUrl = (post = '200', account = '100', platform = 'facebook') =>
  `https://business.facebook.com/latest/inbox/${platform}?asset_id=${account}&selected_item_id=${post}`;

function harness(mapping = {}) {
  const alerts = [];
  const context = vm.createContext({
    URL, console: { log() {}, error() {} }, setTimeout() {},
    window: { location: new URL(postUrl()) },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    chrome: {
      storage: {
        sync: { get: (_keys, cb) => cb({ postProductMapping: mapping }) },
        onChanged: { addListener() {} },
      },
    },
    alert: message => alerts.push(message),
    KeyboardEvent: class {}, Event: class {},
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run('sleep = async () => {}; escapeHtml = value => String(value ?? "");');
  return { context, run, alerts, navigate: url => { context.window.location = new URL(url); } };
}

test('same title prefix cannot overwrite distinct posts; exact unbinding preserves neighbors', () => {
  const h = harness({ 'ABCDEFGHIJKLMNOPQRST-商品甲': 'old-A', 'ABCDEFGHIJKLMNOPQRST-商品乙': 'old-B' });
  h.navigate(postUrl('200000000000'));
  const a = h.run('getPostKey()');
  h.run('setBoundProductId(getPostKey(), "A")');
  h.navigate(postUrl('200000000001'));
  const b = h.run('getPostKey()');
  assert.equal(a.slice(0, 20), b.slice(0, 20));
  h.run('setBoundProductId(getPostKey(), "B")');
  assert.equal(h.run('getBoundProductId(getPostKey())'), 'B');
  h.navigate(postUrl('200000000000'));
  assert.equal(h.run('getBoundProductId(getPostKey())'), 'A');
  h.run('deleteBoundProductId(getPostKey())');
  assert.equal(h.run('getBoundProductId(getPostKey())'), null);
  h.navigate(postUrl('200000000001'));
  assert.equal(h.run('getBoundProductId(getPostKey())'), 'B');
  assert.equal(h.run('postProductMapping["ABCDEFGHIJKLMNOPQRST-商品甲"]'), 'old-A');
  assert.equal(h.run('postProductMapping["ABCDEFGHIJKLMNOPQRST-商品乙"]'), 'old-B');
});

test('account and platform namespace bindings independently', () => {
  const h = harness();
  for (const [account, platform, product] of [['100', 'facebook', 'A'], ['101', 'facebook', 'B'], ['100', 'instagram', 'C']]) {
    h.navigate(postUrl('200', account, platform));
    assert.equal(h.run('getBoundProductId(getPostKey())'), null);
    h.run(`setBoundProductId(getPostKey(), ${JSON.stringify(product)})`);
  }
  h.navigate(postUrl());
  assert.equal(h.run('getBoundProductId(getPostKey())'), 'A');
});

test('legacy keys are retained without lookup or implicit migration, including reload', () => {
  const mapping = { 'ABCDEFGHIJKLMNOPQRST-商品甲': 'A', IG_POST_200: 'B', [postUrl()]: 'C' };
  const h = harness(mapping);
  for (const key of Object.keys(mapping)) {
    assert.equal(h.run(`getBoundProductId(${JSON.stringify(key)})`), null);
    h.run(`deleteBoundProductId(${JSON.stringify(key)})`);
  }
  assert.equal(h.run('getBoundProductId(getPostKey())'), null);
  h.run('setBoundProductId(getPostKey(), "confirmed")');
  const stored = JSON.parse(h.run('JSON.stringify(postProductMapping)'));
  for (const key of Object.keys(mapping)) assert.equal(stored[key], mapping[key]);
  assert.equal(harness(stored).run('getBoundProductId(getPostKey())'), 'confirmed');
});

test('identity ignores tracking, preserves long IDs, and rejects missing or ambiguous IDs/routes', () => {
  const h = harness();
  const key = h.run('getPostKey()');
  h.navigate(`${postUrl()}&tracking=changed`);
  assert.equal(h.run('getPostKey()'), key);
  h.navigate(postUrl('12345678901234567890_98765432109876543210'));
  assert.equal(h.run('getPostKey()'), 'v2:facebook:100:12345678901234567890_98765432109876543210');
  for (const url of [
    'https://business.facebook.com/latest/inbox/facebook?asset_id=100',
    'https://business.facebook.com/latest/inbox/facebook?selected_item_id=200',
    `${postUrl()}&selected_item_id=201`, `${postUrl()}&asset_id=101`,
    postUrl(''), postUrl('undefined'), postUrl('200', ''),
    postUrl().replace('/facebook?', '/messenger?'),
    postUrl().replace('business.facebook.com', 'www.facebook.com'),
  ]) {
    h.navigate(url);
    assert.equal(h.run('getPostKey()'), null, url);
    h.run('setBoundProductId(getPostKey(), "A")');
    assert.equal(h.run('Object.keys(postProductMapping).length'), 0);
  }
});

function element() {
  return {
    style: {}, handlers: {}, attributes: {},
    addEventListener(event, fn) { this.handlers[event] = fn; },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

test('binding observer batches repeated page mutations into one scan', () => {
  const h = harness();
  let notify;
  let scans = 0;
  const timers = [];
  h.context.MutationObserver = class {
    constructor(callback) { notify = callback; }
    observe() {}
  };
  h.context.document.body = {};
  h.context.document.querySelectorAll = () => { scans++; return []; };
  h.context.setTimeout = callback => timers.push(callback);
  h.run('setupPostBindingObserver()');
  assert.equal(scans, 1);
  for (let i = 0; i < 50; i++) notify([]);
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(scans, 2);
});

test('binding dialog refuses unidentified pages and stale saves after navigation', () => {
  const h = harness();
  h.context.anchor = { dataset: {}, getBoundingClientRect: () => ({ bottom: 0, left: 0 }) };
  h.navigate('https://business.facebook.com/latest/inbox/facebook');
  h.run('showBindingDialog(anchor)');
  assert.match(h.alerts.at(-1), /無法取得/);
  h.navigate(postUrl());
  const nodes = Object.fromEntries(['#binding-cancel', '#binding-save', '#binding-select'].map(key => [key, element()]));
  const dialog = { style: {}, remove() {}, querySelector: key => nodes[key] };
  h.context.document.createElement = () => dialog;
  h.context.document.body = { appendChild() {} };
  h.run('showBindingDialog(anchor)');
  h.navigate(postUrl('201'));
  nodes['#binding-select'].value = 'A';
  nodes['#binding-save'].handlers.click();
  assert.match(h.alerts.at(-1), /已切換/);
  assert.equal(h.run('Object.keys(postProductMapping).length'), 0);
});

test('opening the floating menu automatically selects only the exact post binding', () => {
  const h = harness({ 'v2:facebook:100:200': 'A', 'v2:facebook:100:201': 'B', 'old title': 'B' });
  const nodes = Object.fromEntries(['#meta-auto-reply-start', '#meta-auto-reply-scan'].map(key => [key, element()]));
  const wrapper = { ...element(), appendChild() {}, contains: () => false };
  const button = element();
  const dropdown = { ...element(), querySelector: key => nodes[key], querySelectorAll: () => [] };
  const created = [wrapper, button, dropdown];
  h.context.document.createElement = () => created.shift();
  h.context.document.addEventListener = () => {};
  h.context.document.body = { appendChild() {} };
  h.run('currentProducts = [{ id: "A", name: "A", link: "A" }, { id: "B", name: "B", link: "B" }]; injectFloatingButton();');
  const click = () => button.handlers.click({ preventDefault() {}, stopPropagation() {} });
  click();
  assert.equal(h.run('selectedProduct.id'), 'A');
  assert.equal(button.attributes['aria-expanded'], 'true');
  click();
  assert.equal(button.attributes['aria-expanded'], 'false');
  h.navigate(postUrl('201'));
  click();
  assert.equal(h.run('selectedProduct.id'), 'B');
  click();
  h.navigate(postUrl('202'));
  click();
  assert.equal(h.run('selectedProduct'), null);
});

test('selection UI requires manual choice without ID; navigation invalidates old selection', () => {
  const h = harness();
  const nodes = Object.fromEntries(['#meta-auto-reply-start', '#meta-auto-reply-scan'].map(key => [key, element()]));
  h.context.dropdown = { style: {}, querySelector: key => nodes[key], querySelectorAll: () => [] };
  h.run('currentProducts = [{ id: "A", link: "https://shop.example/A" }]; selectedProduct = currentProducts[0]; updateDropdownContent(dropdown, {});');
  h.navigate(postUrl('201'));
  nodes['#meta-auto-reply-start'].handlers.click();
  assert.equal(h.run('selectedProduct'), null);
  assert.match(h.alerts.at(-1), /已切換/);
  h.navigate('https://business.facebook.com/latest/inbox/facebook');
  h.run('updateDropdownContent(dropdown, {})');
  assert.match(h.context.dropdown.innerHTML, /請手動確認商品/);
  nodes['#meta-auto-reply-start'].handlers.click();
  assert.match(h.alerts.at(-1), /請先選擇商品/);
});

test('batch snapshots selected product even when the shared selection changes', async () => {
  const h = harness();
  h.run(`
    currentSettings = { fbMinDelay: 1, fbMaxDelay: 1 };
    selectedProduct = { id: 'A', link: 'https://shop.example/A' };
    globalThis.links = [];
    FB.findCommentBlocks = () => [{}, {}];
    FB.processComment = async (_block, product) => {
      selectedProduct.link = 'https://shop.example/B';
      links.push(product.link);
      return true;
    };
  `);
  await h.run('startAutomation("facebook", {})');
  assert.deepEqual(Array.from(h.context.links), ['https://shop.example/A', 'https://shop.example/A']);
});

for (const platform of ['FB', 'IG']) {
  test(`${platform} actual message path uses the passed product, not another selected product`, async () => {
    const h = harness();
    h.run(`
      globalThis.messages = [];
      currentSettings = { publicReplies: ['reply'], dmPrefixes: ['prefix'], dmSuffixes: ['suffix'], igDmRetries: 0, igDmWaitTime: 1 };
      selectedProduct = { id: 'B', link: 'https://shop.example/B' };
      globalThis.input = {
        tagName: 'TEXTAREA', value: '', focus() {},
        getAttribute: () => null, closest: () => null, querySelector: () => null,
        dispatchEvent() { if (this.value) messages.push(this.value); }
      };
      window.HTMLTextAreaElement = class {};
      document.activeElement = input;
      document.innerText = 'https://shop.example/A';
      findButtonByText = () => ({ closest: () => null });
      dispatchClick = () => {};
      waitForElement = async () => input;
      simulateTyping = async (_input, message) => messages.push(message);
    `);
    assert.equal(await h.run(`${platform}.processComment({}, { id: 'A', link: 'https://shop.example/A' })`), true);
    assert.ok(h.context.messages.includes('prefix\nhttps://shop.example/A\nsuffix'));
    assert.ok(h.context.messages.every(message => !message.includes('https://shop.example/B')));
  });
}
