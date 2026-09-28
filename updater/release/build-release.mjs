import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  publicKeyFromRecord,
  publicKeyRecord,
  rsaSigningOptions,
} from './key-utils.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = new Map();
const flags = new Set();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === '--allow-dirty') {
    flags.add(arg);
  } else if (arg.startsWith('--')) {
    args.set(arg, process.argv[++index]);
  }
}

function git(...gitArgs) {
  const result = spawnSync('git', gitArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${gitArgs.join(' ')} 執行失敗`);
  }
  return result.stdout.trim();
}

const privateKeyPath = resolve(
  args.get('--private-key') ??
    process.env.METAREPLYPRO_SIGNING_KEY ??
    '',
);
if (!privateKeyPath || !existsSync(privateKeyPath)) {
  throw new Error('請用 --private-key 或 METAREPLYPRO_SIGNING_KEY 指定簽章私鑰');
}
const privateRelative = relative(repoRoot, privateKeyPath);
if (!privateRelative.startsWith('..') && !isAbsolute(privateRelative)) {
  throw new Error('簽章私鑰不可存放在 repository 內');
}

const trustedKeyPath = resolve(
  args.get('--public-key') ?? join(repoRoot, 'updater/trusted-update-key.json'),
);
const trustedPemPath = resolve(
  args.get('--public-key-pem') ?? join(repoRoot, 'updater/trusted-update-key.pem'),
);
const trustedKey = JSON.parse(readFileSync(trustedKeyPath, 'utf8'));
const privateKey = createPrivateKey(readFileSync(privateKeyPath));
const derivedKey = publicKeyRecord(createPublicKey(privateKey));
if (
  derivedKey.keyId !== trustedKey.keyId ||
  derivedKey.algorithm !== trustedKey.algorithm ||
  derivedKey.rsaKeyValue !== trustedKey.rsaKeyValue
) {
  throw new Error('私鑰與 repository 內的 trusted-update-key.json 不相符');
}
const publicKey = publicKeyFromRecord(trustedKey);
const expectedPublicPem = publicKey.export({ type: 'spki', format: 'pem' });
if (
  !existsSync(trustedPemPath) ||
  readFileSync(trustedPemPath, 'utf8').trim() !== expectedPublicPem.trim()
) {
  throw new Error('trusted-update-key.pem 與 trusted-update-key.json 不相符');
}

if (!flags.has('--allow-dirty') && git('status', '--porcelain')) {
  throw new Error('工作目錄有未提交變更；正式 release 必須從乾淨 commit 建置');
}
if (
  !flags.has('--allow-dirty') &&
  (args.has('--commit') || args.has('--tag'))
) {
  throw new Error('--commit 與 --tag 覆寫只允許測試搭配 --allow-dirty 使用');
}

const extensionManifest = JSON.parse(
  readFileSync(join(repoRoot, 'chrome-extension/manifest.json'), 'utf8'),
);
const version = extensionManifest.version;
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
  throw new Error(`無效的擴充功能版本：${version}`);
}

const commit = args.get('--commit') ?? git('rev-parse', 'HEAD');
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error(`無效的 commit SHA：${commit}`);
}

const tag = args.get('--tag') ?? `v${version}`;
const outputRoot = resolve(args.get('--output') ?? join(repoRoot, 'release'));
const outputDir = join(outputRoot, tag);
if (existsSync(outputDir)) {
  throw new Error(`輸出目錄已存在，拒絕覆寫：${outputDir}`);
}
mkdirSync(outputDir, { recursive: true });

const tempDir = mkdtempSync(join(tmpdir(), 'MetaReplyProRelease-'));
try {
  const rootName = `MetaReplyPro-v${version}`;
  const packageRoot = join(tempDir, rootName);
  mkdirSync(join(packageRoot, 'updater'), { recursive: true });
  cpSync(join(repoRoot, 'chrome-extension'), join(packageRoot, 'chrome-extension'), {
    recursive: true,
  });

  const updaterFiles = [
    'install.ps1',
    'setup.ps1',
    'update.ps1',
    'update-host.ps1',
    'update-host.bat',
    'disable-auto-update.ps1',
    'trusted-update-key.json',
    'install-macos.sh',
    'update-macos.sh',
    'native-host-macos.sh',
    'trusted-update-key.pem',
  ];
  for (const file of updaterFiles) {
    let source = join(repoRoot, 'updater', file);
    if (file === 'trusted-update-key.json') source = trustedKeyPath;
    if (file === 'trusted-update-key.pem') source = trustedPemPath;
    cpSync(source, join(packageRoot, 'updater', file));
  }

  writeFileSync(
    join(packageRoot, 'release-info.json'),
    `${JSON.stringify({ schemaVersion: 1, version, commit }, null, 2)}\n`,
  );

  const assetName = `${rootName}.zip`;
  const assetPath = join(outputDir, assetName);
  const archiveTool = process.platform === 'win32' ? 'tar' : 'zip';
  const archiveArgs = process.platform === 'win32'
    ? ['-a', '-cf', assetPath, rootName]
    : ['-q', '-X', '-r', assetPath, rootName];
  const zipResult = spawnSync(archiveTool, archiveArgs, {
    cwd: tempDir,
    encoding: 'utf8',
  });
  if (zipResult.status !== 0) {
    throw new Error(zipResult.stderr.trim() || `建立 release ZIP 失敗；請確認系統已安裝 ${archiveTool}`);
  }

  const assetBytes = readFileSync(assetPath);
  const manifest = {
    schemaVersion: 1,
    keyId: trustedKey.keyId,
    version,
    commit,
    assetName,
    assetUrl: `https://github.com/Keith0512/MetaReplyPro/releases/download/${tag}/${assetName}`,
    assetSha256: createHash('sha256').update(assetBytes).digest('hex'),
    publishedAt: new Date().toISOString(),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = sign('RSA-SHA256', manifestBytes, {
    key: privateKey,
    ...rsaSigningOptions,
  });
  if (
    !verify('RSA-SHA256', manifestBytes, {
      key: publicKey,
      ...rsaSigningOptions,
    }, signature)
  ) {
    throw new Error('release manifest 簽章自我驗證失敗');
  }

  writeFileSync(join(outputDir, 'update-manifest.json'), manifestBytes);
  writeFileSync(
    join(outputDir, 'update-manifest.json.sig'),
    `${signature.toString('base64')}\n`,
  );

  console.log(`Release：${tag}`);
  console.log(`Commit：${commit}`);
  console.log(`Asset：${basename(assetPath)}`);
  console.log(`SHA-256：${manifest.assetSha256}`);
  console.log(`輸出：${outputDir}`);
} catch (error) {
  rmSync(outputDir, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
