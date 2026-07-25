import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publicKeyRecord } from '../release/key-utils.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const testRoot = mkdtempSync(join(tmpdir(), 'MetaReplyProMacTest-'));
const installDir = join(testRoot, 'install');
const nativeHostDir = join(testRoot, 'NativeMessagingHosts');
let failed = false;

function assert(condition, name, detail = '') {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail ? `：${detail}` : ''}`);
    failed = true;
  }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const trustedKey = publicKeyRecord(publicKey);
const trustedJsonPath = join(testRoot, 'trusted-update-key.json');
const trustedPemPath = join(testRoot, 'trusted-update-key.pem');
writeFileSync(trustedJsonPath, `${JSON.stringify(trustedKey, null, 2)}\n`);
writeFileSync(
  trustedPemPath,
  publicKey.export({ type: 'spki', format: 'pem' }),
);

function makePackage({
  name,
  releaseVersion,
  packageVersion = releaseVersion,
  releaseCommit = '1111111111111111111111111111111111111111',
  packageCommit = releaseCommit,
  hashOverride = '',
}) {
  const fixtureDir = join(testRoot, name);
  const rootName = `MetaReplyPro-v${releaseVersion}`;
  const packageRoot = join(fixtureDir, rootName);
  const extensionDir = join(packageRoot, 'chrome-extension');
  const updaterDir = join(packageRoot, 'updater');
  mkdirSync(extensionDir, { recursive: true });
  mkdirSync(updaterDir, { recursive: true });

  writeFileSync(
    join(extensionDir, 'manifest.json'),
    `${JSON.stringify({ manifest_version: 3, name: 'test', version: packageVersion }, null, 2)}\n`,
  );
  writeFileSync(join(extensionDir, 'content.js'), `content-${name}\n`);
  writeFileSync(
    join(packageRoot, 'release-info.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      version: packageVersion,
      commit: packageCommit,
    }, null, 2)}\n`,
  );

  for (const file of [
    'install-macos.sh',
    'update-macos.sh',
    'native-host-macos.sh',
  ]) {
    cpSync(join(repoRoot, 'updater', file), join(updaterDir, file));
    chmodSync(join(updaterDir, file), 0o755);
  }
  cpSync(trustedJsonPath, join(updaterDir, 'trusted-update-key.json'));
  cpSync(trustedPemPath, join(updaterDir, 'trusted-update-key.pem'));

  const assetName = `${rootName}.zip`;
  const assetPath = join(fixtureDir, assetName);
  const zipped = run('/usr/bin/zip', ['-q', '-X', '-r', assetPath, rootName], {
    cwd: fixtureDir,
  });
  if (zipped.status !== 0) {
    throw new Error(zipped.stderr || '建立 macOS 測試 ZIP 失敗');
  }

  const assetSha256 =
    hashOverride ||
    createHash('sha256').update(readFileSync(assetPath)).digest('hex');
  const manifest = {
    schemaVersion: 1,
    keyId: trustedKey.keyId,
    version: releaseVersion,
    commit: releaseCommit,
    assetName,
    assetUrl: assetPath,
    assetSha256,
    publishedAt: '2026-07-25T00:00:00.000Z',
  };
  const manifestPath = join(fixtureDir, 'update-manifest.json');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signaturePath = `${manifestPath}.sig`;
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(
    signaturePath,
    `${sign('RSA-SHA256', manifestBytes, privateKey).toString('base64')}\n`,
  );

  return {
    packageRoot,
    assetPath,
    manifestPath,
    signaturePath,
  };
}

function runUpdate(fixture) {
  return run('/bin/zsh', [
    join(installDir, 'update-macos.sh'),
    '--install-dir',
    installDir,
    '--manifest',
    fixture.manifestPath,
    '--signature',
    fixture.signaturePath,
    '--public-key',
    join(installDir, 'trusted-update-key.pem'),
    '--allow-local-sources',
  ]);
}

function frameMessage(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function parseFramedMessage(buffer) {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32LE(0);
  if (buffer.length !== length + 4) return null;
  return JSON.parse(buffer.subarray(4).toString('utf8'));
}

try {
  const initial = makePackage({
    name: 'initial',
    releaseVersion: '1.5.0',
  });
  const installed = run('/bin/zsh', [
    join(repoRoot, 'updater/install-macos.sh'),
    '--source-dir',
    initial.packageRoot,
    '--install-dir',
    installDir,
    '--native-host-dir',
    nativeHostDir,
  ]);
  assert(installed.status === 0, 'macOS 安裝器可從固定 release 安裝', installed.stderr);
  assert(
    json(join(installDir, 'chrome-extension/manifest.json')).version === '1.5.0',
    '安裝正確的擴充功能版本',
  );
  assert(
    (statSync(join(installDir, 'native-host-macos.sh')).mode & 0o111) !== 0,
    'Native Messaging host 具有執行權限',
  );
  const hostManifest = json(
    join(nativeHostDir, 'com.metareplypro.updater.json'),
  );
  assert(
    realpathSync(hostManifest.path) ===
      realpathSync(join(installDir, 'native-host-macos.sh')),
    'Chrome host manifest 使用 macOS 絕對路徑',
  );
  assert(
    hostManifest.allowed_origins?.[0] ===
      'chrome-extension://gnekicgafkpbmafejjcbaagcpfnmfjbh/',
    'Chrome host manifest 只允許固定擴充功能 ID',
  );

  const good = makePackage({
    name: 'good',
    releaseVersion: '1.5.1',
  });
  const goodUpdate = runUpdate(good);
  assert(goodUpdate.status === 0, '有效簽章與 SHA-256 時允許更新', goodUpdate.stderr);
  assert(
    json(join(installDir, 'chrome-extension/manifest.json')).version === '1.5.1',
    '安全更新至 1.5.1',
  );
  assert(
    readFileSync(join(installDir, 'chrome-extension/content.js'), 'utf8').trim() ===
      'content-good',
    '套用已驗證的 macOS 程式檔案',
  );
  assert(
    existsSync(join(installDir, 'chrome-extension.backup/manifest.json')),
    '更新後保留上一版備份',
  );

  writeFileSync(join(installDir, 'chrome-extension/content.js'), 'marker\n');
  const sameVersion = runUpdate(good);
  assert(sameVersion.status === 0, '相同版本安全結束', sameVersion.stderr);
  assert(
    readFileSync(join(installDir, 'chrome-extension/content.js'), 'utf8').trim() ===
      'marker',
    '相同版本不覆蓋本機檔案',
  );

  const badSignature = makePackage({
    name: 'bad-signature',
    releaseVersion: '1.5.2',
  });
  writeFileSync(
    badSignature.signaturePath,
    `${Buffer.alloc(256).toString('base64')}\n`,
  );
  const rejectedSignature = runUpdate(badSignature);
  assert(rejectedSignature.status !== 0, '錯誤簽章會被拒絕');
  assert(
    readFileSync(join(installDir, 'chrome-extension/content.js'), 'utf8').trim() ===
      'marker',
    '簽章錯誤時保留舊版',
  );

  const badHash = makePackage({
    name: 'bad-hash',
    releaseVersion: '1.5.2',
    hashOverride: '0'.repeat(64),
  });
  const rejectedHash = runUpdate(badHash);
  assert(rejectedHash.status !== 0, 'ZIP 的 SHA-256 不符時拒絕更新');

  const badVersion = makePackage({
    name: 'bad-version',
    releaseVersion: '1.5.2',
    packageVersion: '9.9.9',
  });
  const rejectedVersion = runUpdate(badVersion);
  assert(rejectedVersion.status !== 0, 'ZIP 版本與簽章 manifest 不一致時拒絕更新');

  const badCommit = makePackage({
    name: 'bad-commit',
    releaseVersion: '1.5.2',
    releaseCommit: '2222222222222222222222222222222222222222',
    packageCommit: '3333333333333333333333333333333333333333',
  });
  const rejectedCommit = runUpdate(badCommit);
  assert(rejectedCommit.status !== 0, 'ZIP commit 與簽章 manifest 不一致時拒絕更新');
  assert(existsSync(join(installDir, 'update.log')), '安全檢查寫入 macOS update.log');

  const protocolDir = join(testRoot, 'protocol');
  mkdirSync(join(protocolDir, 'chrome-extension'), { recursive: true });
  cpSync(
    join(repoRoot, 'updater/native-host-macos.sh'),
    join(protocolDir, 'native-host-macos.sh'),
  );
  chmodSync(join(protocolDir, 'native-host-macos.sh'), 0o755);
  writeFileSync(
    join(protocolDir, 'chrome-extension/manifest.json'),
    '{"version":"1.5.0"}\n',
  );
  writeFileSync(
    join(protocolDir, 'update-macos.sh'),
    `#!/bin/zsh
/usr/bin/plutil -replace version -string 1.5.1 "${join(protocolDir, 'chrome-extension/manifest.json')}"
`,
  );
  chmodSync(join(protocolDir, 'update-macos.sh'), 0o755);

  const hostResult = run(
    '/bin/zsh',
    [join(protocolDir, 'native-host-macos.sh')],
    {
      input: frameMessage({ action: 'update' }),
      encoding: null,
    },
  );
  const hostResponse = parseFramedMessage(hostResult.stdout);
  assert(
    hostResult.status === 0 &&
      hostResponse?.ok === true &&
      hostResponse?.updated === true &&
      hostResponse?.before === '1.5.0' &&
      hostResponse?.after === '1.5.1',
    'macOS Native Messaging 可執行更新並回覆正確框架',
  );

  const unsupportedResult = run(
    '/bin/zsh',
    [join(protocolDir, 'native-host-macos.sh')],
    {
      input: frameMessage({ action: 'delete' }),
      encoding: null,
    },
  );
  const unsupportedResponse = parseFramedMessage(unsupportedResult.stdout);
  assert(
    unsupportedResponse?.ok === false &&
      unsupportedResponse?.message === '不支援的更新動作',
    'Native Messaging 拒絕非更新動作',
  );
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('\n全部通過');
}
