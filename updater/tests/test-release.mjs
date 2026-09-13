import {
  createHash,
  generateKeyPairSync,
} from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publicKeyRecord } from '../release/key-utils.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const tempDir = mkdtempSync(join(tmpdir(), 'MetaReplyProReleaseTest-'));
let failed = false;

function assert(condition, name) {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}`);
    failed = true;
  }
}

function runNode(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

try {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const privateKeyPath = join(tempDir, 'test-private.pem');
  const publicKeyPath = join(tempDir, 'test-public.json');
  const publicPemPath = join(tempDir, 'test-public.pem');
  writeFileSync(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  writeFileSync(
    publicKeyPath,
    `${JSON.stringify(publicKeyRecord(publicKey), null, 2)}\n`,
  );
  writeFileSync(
    publicPemPath,
    publicKey.export({ type: 'spki', format: 'pem' }),
  );

  const outputRoot = join(tempDir, 'output');
  const build = runNode('updater/release/build-release.mjs', [
    '--private-key',
    privateKeyPath,
    '--public-key',
    publicKeyPath,
    '--public-key-pem',
    publicPemPath,
    '--output',
    outputRoot,
    '--tag',
    'test-v1.5.1',
    '--commit',
    '1111111111111111111111111111111111111111',
    '--allow-dirty',
  ]);
  assert(build.status === 0, '可建立已簽章的固定 release');
  if (build.status !== 0) {
    console.error(build.stderr);
    process.exitCode = 1;
  } else {
    const releaseDir = join(outputRoot, 'test-v1.5.1');
    const manifestPath = join(releaseDir, 'update-manifest.json');
    const signaturePath = `${manifestPath}.sig`;
    const assetPath = join(releaseDir, JSON.parse(readFileSync(manifestPath, 'utf8')).assetName);

    const verified = runNode('updater/release/verify-release.mjs', [
      '--manifest',
      manifestPath,
      '--public-key',
      publicKeyPath,
    ]);
    assert(verified.status === 0, '正確簽章與 SHA-256 可通過驗證');

    const originalManifest = readFileSync(manifestPath);
    const originalSignature = readFileSync(signaturePath);
    writeFileSync(signaturePath, `${Buffer.alloc(256).toString('base64')}\n`);
    const wrongSignature = runNode('updater/release/verify-release.mjs', [
      '--manifest',
      manifestPath,
      '--signature',
      signaturePath,
      '--asset',
      assetPath,
      '--public-key',
      publicKeyPath,
    ]);
    assert(wrongSignature.status !== 0, '錯誤簽章會被拒絕');
    writeFileSync(signaturePath, originalSignature);

    writeFileSync(manifestPath, Buffer.concat([originalManifest, Buffer.from(' ')]));
    const badSignature = runNode('updater/release/verify-release.mjs', [
      '--manifest',
      manifestPath,
      '--signature',
      signaturePath,
      '--asset',
      assetPath,
      '--public-key',
      publicKeyPath,
    ]);
    assert(badSignature.status !== 0, 'manifest 被竄改時拒絕驗證');
    writeFileSync(manifestPath, originalManifest);

    const originalAsset = readFileSync(assetPath);
    const listing = spawnSync('/usr/bin/unzip', ['-Z1', assetPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert(
      listing.status === 0 &&
        listing.stdout.includes('/updater/install-macos.sh') &&
        listing.stdout.includes('/updater/update-macos.sh') &&
        listing.stdout.includes('/updater/native-host-macos.sh') &&
        listing.stdout.includes('/updater/trusted-update-key.pem'),
      'release ZIP 包含完整 macOS 安裝與更新元件',
    );
    writeFileSync(assetPath, Buffer.concat([originalAsset, Buffer.from('tampered')]));
    const badHash = runNode('updater/release/verify-release.mjs', [
      '--manifest',
      manifestPath,
      '--signature',
      signaturePath,
      '--asset',
      assetPath,
      '--public-key',
      publicKeyPath,
    ]);
    assert(badHash.status !== 0, 'release ZIP 被竄改時拒絕驗證');
    writeFileSync(assetPath, originalAsset);

    const manifest = JSON.parse(originalManifest);
    assert(
      createHash('sha256').update(originalAsset).digest('hex') ===
        manifest.assetSha256,
      'manifest 綁定 release ZIP 的 SHA-256',
    );
    assert(
      manifest.commit === '1111111111111111111111111111111111111111',
      'manifest 綁定不可變 commit SHA',
    );
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('\n全部通過');
}
