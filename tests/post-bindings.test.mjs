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
      runtime: {
        sendMessage: async ({ postKey, productId }) => {
          if (!postKey?.startsWith('v2:')) return { ok: false };
          mapping = { ...mapping };
          if (productId === null) delete mapping[postKey];
          else mapping[postKey] = productId;
          return { ok: true, mapping };
        }
      },
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

test('same title prefix cannot overwrite distinct posts; exact unbinding preserves neighbors', async () => {
  const h = harness({ 'ABCDEFGHIJKLMNOPQRST-商品甲': 'old-A', 'ABCDEFGHIJKLMNOPQRST-商品乙': 'old-B' });
  h.navigate(postUrl('200000000000'));
  const a = h.run('getPostKey()');
  await h.run('saveBoundProductId(getPostKey(), "A")');
  h.navigate(postUrl('200000000001'));
  const b = h.run('getPostKey()');
  assert.equal(a.slice(0, 20), b.slice(0, 20));
  await h.run('saveBoundProductId(getPostKey(), "B")');
  assert.equal(h.run('getBoundProductId(getPostKey())'), 'B');
  h.navigate(postUrl('200000000000'));
  assert.equal(h.run('getBoundProductId(getPostKey())'), 'A');
  await h.run('saveBoundProductId(getPostKey(), null)');
  assert.equal(h.run('getBoundProductId(getPostKey())'), null);
  h.navigate(postUrl('200000000001'));
  assert.equal(h.run('getBoundProductId(getPostKey())'), 'B');
  assert.equal(h.run('postProductMapping["ABCDEFGHIJKLMNOPQRST-商品甲"]'), 'old-A');
  assert.equal(h.run('postProductMapping["ABCDEFGHIJKLMNOPQRST-商品乙"]'), 'old-B');
});

test('account and platform namespace bindings independently', async () => {
  const h = harness();
  for (const [account, platform, product] of [['100', 'facebook', 'A'], ['101', 'facebook', 'B'], ['100', 'instagram', 'C']]) {
    h.navigate(postUrl('200', account, platform));
    assert.equal(h.run('getBoundProductId(getPostKey())'), null);
    await h.run(`saveBoundProductId(getPostKey(), ${JSON.stringify(product)})`);
  }
  h.navigate(postUrl());
  assert.equal(h.run('getBoundProductId(getPostKey())'), 'A');
});

test('legacy keys are retained without lookup or implicit migration, including reload', async () => {
  const mapping = { 'ABCDEFGHIJKLMNOPQRST-商品甲': 'A', IG_POST_200: 'B', [postUrl()]: 'C' };
  const h = harness(mapping);
  for (const key of Object.keys(mapping)) {
    assert.equal(h.run(`getBoundProductId(${JSON.stringify(key)})`), null);
    await assert.rejects(h.run(`saveBoundProductId(${JSON.stringify(key)}, null)`));
  }
  assert.equal(h.run('getBoundProductId(getPostKey())'), null);
  await h.run('saveBoundProductId(getPostKey(), "confirmed")');
  const stored = JSON.parse(h.run('JSON.stringify(postProductMapping)'));
  for (const key of Object.keys(mapping)) assert.equal(stored[key], mapping[key]);
  assert.equal(harness(stored).run('getBoundProductId(getPostKey())'), 'confirmed');
});

test('identity ignores tracking, preserves long IDs, and rejects missing or ambiguous IDs/routes', async () => {
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
    await assert.rejects(h.run('saveBoundProductId(getPostKey(), "A")'));
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
    FB.extractUserName = () => '甲';
    FB.processComment = async (_block, product) => {
      selectedProduct.link = 'https://shop.example/B';
      links.push(product.link);
      return true;
    };
  `);
  await h.run('startAutomation("facebook", {})');
  assert.deepEqual(Array.from(h.context.links), ['https://shop.example/A', 'https://shop.example/A']);
});

const dmText = 'prefix\nhttps://shop.example/A\nsuffix';

function batchFixture(platform, { openDm = true, sendByClick = false, panelRecipient = '甲' } = {}) {
  const h = harness();
  const { document } = h.context;
  const submitted = [];
  const rows = [];
  const module = platform === 'facebook' ? 'FB' : 'IG';
  let waiting;
  let floatClick;
  let onSendMouseDown;
  let destination = panelRecipient;

  h.navigate(postUrl('200', '100', platform));
  h.context.window.HTMLTextAreaElement = class {};
  h.context.MouseEvent = h.context.KeyboardEvent = class {
    constructor(type, options) { Object.assign(this, options, { type }); }
  };

  function node(options = {}) {
    return {
      children: [],
      isConnected: true,
      getAttribute: () => null,
      contains(other) { return this === other; },
      closest: () => null,
      matches: () => false,
      getClientRects: () => [{}],
      querySelector: () => null,
      querySelectorAll: () => [],
      ...options
    };
  }
  const panel = node({
    getAttribute: attr => attr === 'data-thread-id' ? destination : null,
    contains: other => [dm, send, ...rows].includes(other),
    querySelector: selector => selector.includes('heading') ? { innerText: destination } : null,
    querySelectorAll: selector => selector.includes('[role="row"]') ? rows : sendByClick ? [send] : []
  });

  function editor(kind) {
    return node({
      visible: false,
      tagName: 'TEXTAREA',
      value: '',
      focus() { document.activeElement = this; },
      getClientRects() { return this.visible ? [{}] : []; },
      dispatchEvent(event) {
        if (event.type !== 'keydown' || event.key !== 'Enter') return;
        submitted.push({ kind, text: this.value });
        this.value = '';
      }
    });
  }
  const reply = editor('reply');
  const dm = editor('dm');
  dm.closest = () => panel;

  const button = (label, onClick) => node({
    innerText: label,
    dispatchEvent(event) { if (event.type === 'click') onClick(); }
  });
  const replyAction = button('Reply', () => {
    reply.visible = true;
    reply.focus();
  });
  const dmAction = button('Send message', () => {
    if (!openDm) return;
    dm.visible = true;
    dm.focus();
  });
  const send = node({
    innerText: 'Send',
    closest: () => panel,
    dispatchEvent(event) {
      if (event.type === 'mousedown') onSendMouseDown?.();
      if (event.type !== 'click') return;
      submitted.push({ kind: 'dm', text: dm.value });
      dm.value = '';
    }
  });
  const block = node({
    contains: other => [reply, replyAction, dmAction].includes(other),
    querySelectorAll: () => [replyAction, dmAction]
  });
  const floatingButton = { ...element(), addEventListener: (_event, click) => { floatClick = click; } };
  const start = element();
  const scan = element();
  const dropdown = {
    ...element(),
    querySelector: selector => selector.includes('start') ? start : scan,
    querySelectorAll: () => []
  };
  const created = [{ ...element(), appendChild() {} }, floatingButton, dropdown];
  document.createElement = () => created.shift();
  document.addEventListener = () => {};
  document.body = { appendChild() {} };
  document.querySelectorAll = selector => selector.includes('contenteditable') ? [reply, dm] : [floatingButton];
  h.context.block = block;
  h.context.wait = async ms => { if (waiting) await waiting(ms); };
  h.run(`
    injectFloatingButton();
    sleep = wait;
    currentSettings = { publicReplies: ['reply'], dmPrefixes: ['prefix'], dmSuffixes: ['suffix'], igDmWaitTime: 3 };
    selectedProduct = { id: 'A', link: 'https://shop.example/A' };
    ${module}.findCommentBlocks = () => [block];
    ${module}.extractUserName = () => '甲';
  `);

  function message(id, { outgoing = true, text = dmText, datetime } = {}) {
    const row = node({
      id,
      innerText: text,
      closest: selector => selector.includes('[role="row"]') ? row : panel,
      getAttribute: attr => attr === 'aria-label' && outgoing ? 'You sent' : null,
      querySelector: selector => selector === 'time[datetime]' && datetime ? { getAttribute: () => datetime } : null,
      matches: selector => selector.includes('[role="row"]')
    });
    return row;
  }

  return {
    ...h, rows, submitted, dm, reply, block,
    message,
    start: () => h.run(`startAutomation('${platform}')`),
    stop: () => floatClick({ preventDefault() {}, stopPropagation() {} }),
    onSleep: callback => { waiting = callback; },
    onSendMouseDown: callback => { onSendMouseDown = callback; },
    changeDestination: name => { destination = name; }
  };
}

for (const platform of ['facebook', 'instagram']) {
  test(`${platform} records public replies and missing private composers independently`, async () => {
    const h = batchFixture(platform, { openDm: false });
    await h.start();
    assert.deepEqual(h.submitted, [{ kind: 'reply', text: 'reply' }]);
    assert.match(h.alerts.at(-1), /公開回覆已提交 1 則/);
    assert.match(h.alerts.at(-1), /私訊畫面已確認 0 則、待核對 0 則、未送出 1 則/);
    assert.match(h.alerts.at(-1), /甲（未送出）/);
  });

  test(`${platform} stop during DM typing locks out an overlapping batch`, async () => {
    const h = batchFixture(platform, { sendByClick: platform === 'facebook' });
    let resume;
    const paused = new Promise(resolve => {
      h.onSleep(ms => {
        if (ms === 800 && h.dm.visible && !resume) {
          return new Promise(finish => { resume = finish; resolve(); });
        }
      });
    });
    const first = h.start();
    await paused;
    h.stop();
    await h.start();
    assert.equal(h.alerts.length, 0);
    assert.equal(h.run('activeBatch.stopReason'), 'operator');
    resume();
    await first;
    assert.deepEqual(h.submitted, [{ kind: 'reply', text: 'reply' }]);
    assert.match(h.alerts.at(-1), /已停止批次/);
    assert.equal(h.run('activeBatch'), null);
  });
}

test('historical, prepended, and incoming content cannot confirm a DM or trigger another send', async () => {
  const h = batchFixture('instagram');
  h.rows.push(h.message('old'));
  h.onSleep(ms => {
    if (ms === 1000 && h.rows.length === 1) {
      h.rows.splice(0, 1, h.message('older'), h.message('old'), h.message('incoming', { outgoing: false }));
    }
  });
  await h.start();
  assert.deepEqual(h.submitted, [{ kind: 'reply', text: 'reply' }, { kind: 'dm', text: dmText }]);
  assert.match(h.alerts.at(-1), /私訊畫面已確認 0 則、待核對 1 則、未送出 0 則/);
  assert.match(h.alerts.at(-1), /甲（待核對）/);
});

test('a delayed, newly appended outgoing copy confirms only the single dispatched DM', async () => {
  const h = batchFixture('instagram');
  h.rows.push(h.message('old'));
  let waits = 0;
  h.onSleep(ms => {
    if (ms === 1000 && ++waits === 3) h.rows.push(h.message('new'));
  });
  await h.start();
  assert.deepEqual(h.submitted, [{ kind: 'reply', text: 'reply' }, { kind: 'dm', text: dmText }]);
  assert.match(h.alerts.at(-1), /私訊畫面已確認 1 則、待核對 0 則、未送出 0 則/);
});

test('an outgoing message confirms the Facebook click path in the same conversation', async () => {
  const h = batchFixture('facebook', { sendByClick: true });
  h.rows.push(h.message('old'));
  h.onSleep(ms => {
    if (ms === 1000) h.rows.push(h.message('new'));
  });
  await h.start();
  assert.deepEqual(h.submitted, [{ kind: 'reply', text: 'reply' }, { kind: 'dm', text: dmText }]);
  assert.match(h.alerts.at(-1), /私訊畫面已確認 1 則、待核對 0 則、未送出 0 則/);
});

test('an unrelated newly opened panel cannot capture the private reply', async () => {
  const h = batchFixture('instagram', { panelRecipient: '乙' });
  await h.start();
  assert.equal(h.dm.visible, true);
  assert.deepEqual(h.submitted, [{ kind: 'reply', text: 'reply' }]);
  assert.equal(h.dm.value, '');
  assert.match(h.alerts.at(-1), /甲（未送出）/);
});

test('an initially empty history needs a current timestamp to confirm a newly displayed DM', async () => {
  const h = batchFixture('instagram');
  let waits = 0;
  h.onSleep(ms => {
    if (ms !== 1000) return;
    if (++waits === 1) h.rows.push(h.message('old', { datetime: '2025-01-01T00:00:00Z' }));
    if (waits === 2) h.rows.push(h.message('undated'));
  });
  await h.start();
  assert.equal(waits, 3);
  assert.match(h.alerts.at(-1), /私訊畫面已確認 0 則、待核對 1 則、未送出 0 則/);

  const fresh = batchFixture('instagram');
  fresh.onSleep(ms => {
    if (ms === 1000) fresh.rows.push(fresh.message('new', { datetime: new Date().toISOString() }));
  });
  await fresh.start();
  assert.equal(fresh.submitted.filter(entry => entry.kind === 'dm').length, 1);
  assert.match(fresh.alerts.at(-1), /私訊畫面已確認 1 則、待核對 0 則、未送出 0 則/);
});

test('Instagram discovery counts a nested action, its label, and its wrapper once', () => {
  const h = harness();
  const parent = parentElement => ({ parentElement, querySelector: () => null });
  const outer = parent(null);
  const block = parent(outer);
  const body = parent(block);
  const wrapper = { ...parent(body), innerText: 'Send message', closest: () => null };
  const button = { ...parent(wrapper), innerText: 'Send message', closest: () => button };
  const label = { ...parent(button), innerText: 'Send message', closest: () => button };
  wrapper.querySelectorAll = () => [button];
  h.context.document.querySelectorAll = () => [wrapper, button, label];
  assert.deepEqual(Array.from(h.run('IG.findCommentBlocks()')), [block]);
});

test('stopping during confirmation leaves an already dispatched DM pending verification', async () => {
  const h = batchFixture('instagram');
  h.onSleep(ms => {
    if (ms === 1000) h.stop();
  });
  await h.start();
  assert.deepEqual(h.submitted, [{ kind: 'reply', text: 'reply' }, { kind: 'dm', text: dmText }]);
  assert.match(h.alerts.at(-1), /已停止批次/);
  assert.match(h.alerts.at(-1), /私訊畫面已確認 0 則、待核對 1 則、未送出 0 則/);
});

test('a changed page or conversation blocks send, including between mouse down and click', async () => {
  const navigation = batchFixture('instagram');
  navigation.onSleep(ms => {
    if (ms === 800 && navigation.dm.visible) navigation.navigate(postUrl('201', '100', 'instagram'));
  });
  await navigation.start();
  assert.deepEqual(navigation.submitted, [{ kind: 'reply', text: 'reply' }]);
  assert.match(navigation.alerts.at(-1), /頁面已切換/);

  const recipient = batchFixture('facebook', { sendByClick: true });
  recipient.onSendMouseDown(() => recipient.changeDestination('乙'));
  await recipient.start();
  assert.deepEqual(recipient.submitted, [{ kind: 'reply', text: 'reply' }]);
  assert.match(recipient.alerts.at(-1), /私訊畫面已確認 0 則、待核對 0 則、未送出 1 則/);
});
