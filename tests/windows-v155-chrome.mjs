import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const phase = process.argv[2];
assert.ok(phase === 'before' || phase === 'after', 'Expected before or after');
const expectedVersion = phase === 'before' ? '1.5.4' : '1.5.5';
const repo = 'Keith0512/MetaReplyPro';
const extensionId = 'gnekicgafkpbmafejjcbaagcpfnmfjbh';
const { LOCALAPPDATA, METAREPLY_TEST_CHROME, METAREPLY_TEST_ROOT, METAREPLY_TEST_MANIFEST_SHA } = process.env;
const releaseVersion = process.env.METAREPLY_TEST_PUBLIC_LATEST;
assert.ok(LOCALAPPDATA && METAREPLY_TEST_CHROME && METAREPLY_TEST_ROOT, 'Expected the Windows smoke test environment');
assert.ok(releaseVersion === '1.5.4' || releaseVersion === '1.5.5', 'Expected public latest 1.5.4 or 1.5.5');
if (phase === 'after') assert.match(METAREPLY_TEST_MANIFEST_SHA || '', /^[a-f0-9]{64}$/);
const canUpdate = expectedVersion === '1.5.4' && releaseVersion === '1.5.5';

const extensionDir = join(LOCALAPPDATA, 'MetaReplyPro', 'chrome-extension');
const profile = join(METAREPLY_TEST_ROOT, 'chrome-profile');
const portFile = join(profile, 'DevToolsActivePort');
const releaseUrl = `https://github.com/${repo}/releases/tag/v${releaseVersion}`;
const sentinel = { windowsV155Smoke: 'saved by Chrome on v1.5.4' };

async function waitFor(read, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Opening the Chrome DevTools socket timed out')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Could not connect to the Chrome DevTools socket'));
    }, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Chrome DevTools connection closed'));
    }
    pending.clear();
  });
  return {
    close: () => socket.close(),
    call(method, params = {}, sessionId, timeout = 5_000) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome DevTools call timed out: ${method}`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    }
  };
}

const releaseResponse = await fetch(`https://api.github.com/repos/${repo}/releases/tags/v${releaseVersion}`, {
  headers: { Accept: 'application/vnd.github+json' },
  signal: AbortSignal.timeout(20_000)
});
assert.ok(releaseResponse.ok, `Could not read official release notes (HTTP ${releaseResponse.status})`);
const release = await releaseResponse.json();
assert.equal(release.tag_name, `v${releaseVersion}`);
assert.equal(release.html_url, releaseUrl);
const expectedNotes = (release.body || '').trim();
assert.ok(expectedNotes, 'The official release has no notes');

await mkdir(profile, { recursive: true });
await rm(portFile, { force: true });
const chrome = spawn(METAREPLY_TEST_CHROME, [
  '--headless=new',
  '--enable-logging=stderr',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let startupError;
chrome.on('error', error => { startupError = error; });
let stderr = '';
chrome.stderr.setEncoding('utf8');
chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4_000); });
let stopped = false;
chrome.on('exit', () => { stopped = true; });
let cdp;
let testComplete = false;

try {
  const endpoint = await waitFor(async () => {
    if (startupError) throw startupError;
    if (stopped) throw new Error(`Chrome exited before startup with status ${chrome.exitCode}`);
    const contents = await readFile(portFile, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    const [port, path] = contents.trim().split(/\r?\n/);
    return /^\d+$/.test(port) && path?.startsWith('/devtools/browser/') ? `ws://127.0.0.1:${port}${path}` : null;
  }, 'the Chrome DevTools port');
  cdp = await connect(endpoint);
  const browser = await cdp.call('Browser.getVersion');
  console.log(`Chrome DevTools browser: ${browser.product}`);
  const url = `chrome-extension://${extensionId}/settings.html`;
  const { targetId } = await cdp.call('Target.createTarget', { url });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });

  async function page(expression, timeout) {
    const response = await cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId, timeout);
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  }

  const version = await waitFor(async () => {
    const text = await page(`document.getElementById('current-version')?.textContent`);
    return /^\d+\.\d+\.\d+$/.test(text || '') ? text : null;
  }, 'the settings version');
  assert.equal(version, expectedVersion);
  assert.deepEqual(await page(`({ id: chrome.runtime.id, version: chrome.runtime.getManifest().version, url: location.href })`), {
    id: extensionId, version: expectedVersion, url
  });

  if (phase === 'before') {
    await page(`chrome.storage.local.set(${JSON.stringify(sentinel)})`);
  }
  assert.deepEqual(await page("chrome.storage.local.get('windowsV155Smoke')"), sentinel);
  await page("document.getElementById('check-update-btn').click()");
  const preview = await waitFor(() => page(`(() => {
    const element = id => document.getElementById(id);
    if (element('check-update-btn').disabled || element('update-preview').hidden) return null;
    return {
      title: element('update-preview-title').textContent,
      notes: element('update-preview-notes').textContent,
      link: element('update-preview-link').href,
      confirmHidden: element('confirm-update-btn').hidden,
      status: element('update-status').textContent
    };
  })()`), 'the live GitHub release preview');
  assert.equal(preview.title, `MetaReplyPro v${releaseVersion}`, preview.status);
  assert.equal(preview.notes, expectedNotes);
  assert.equal(preview.link, releaseUrl);
  assert.equal(preview.confirmHidden, !canUpdate);
  assert.equal(preview.status, canUpdate
    ? `請先閱讀 v${releaseVersion} 的更新內容，再決定是否安裝。`
    : `目前已是最新版（${expectedVersion}）。`);
  console.log(`Settings UI on v${version} showed the exact v${releaseVersion} release notes, with confirmation ${preview.confirmHidden ? 'hidden' : 'available'}.`);

  if (phase === 'after') {
    const result = await page(`new Promise(resolve => chrome.runtime.sendNativeMessage(
      'com.metareplypro.updater.pinned', { action: 'preview', version: '${releaseVersion}' },
      response => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : response)
    ))`, 90_000);
    assert.deepEqual(result, { ok: true, version: releaseVersion, manifestSha256: METAREPLY_TEST_MANIFEST_SHA });
    console.log(`Chrome native messaging verified the official v${releaseVersion} manifest digest.`);
  }
  testComplete = true;
} catch (error) {
  if (stderr) console.error(stderr);
  throw error;
} finally {
  if (cdp) {
    await cdp.call('Browser.close').catch(() => {});
    cdp.close();
  }
  if (!stopped && !startupError) {
    try {
      await waitFor(() => stopped, 'Chrome to close and flush the test profile', 10_000);
    } catch (error) {
      chrome.kill();
      if (testComplete) throw error;
    }
  }
}
