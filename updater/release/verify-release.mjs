import { createHash, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { publicKeyFromRecord, rsaSigningOptions } from './key-utils.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const manifestPath = resolve(args.get('--manifest') ?? '');
const signaturePath = resolve(
  args.get('--signature') ?? `${manifestPath}.sig`,
);
const publicKeyPath = resolve(
  args.get('--public-key') ??
    new URL('../trusted-update-key.json', import.meta.url).pathname,
);
if (!existsSync(manifestPath) || !existsSync(signaturePath)) {
  throw new Error('找不到 release manifest 或簽章檔');
}

const manifestBytes = readFileSync(manifestPath);
const signature = Buffer.from(readFileSync(signaturePath, 'utf8').trim(), 'base64');
const trustedKey = JSON.parse(readFileSync(publicKeyPath, 'utf8'));
const publicKey = publicKeyFromRecord(trustedKey);
if (
  !verify('RSA-SHA256', manifestBytes, {
    key: publicKey,
    ...rsaSigningOptions,
  }, signature)
) {
  throw new Error('release manifest 簽章無效');
}

const manifest = JSON.parse(manifestBytes);
if (
  manifest.schemaVersion !== 1 ||
  manifest.keyId !== trustedKey.keyId ||
  !/^[0-9a-f]{40}$/.test(manifest.commit) ||
  !/^[0-9a-f]{64}$/.test(manifest.assetSha256)
) {
  throw new Error('release manifest 欄位無效');
}
const assetPath = resolve(
  args.get('--asset') ?? join(dirname(manifestPath), manifest.assetName),
);
const actualHash = createHash('sha256').update(readFileSync(assetPath)).digest('hex');
if (actualHash !== manifest.assetSha256) {
  throw new Error('release asset SHA-256 不符');
}

console.log(`驗證成功：MetaReplyPro ${manifest.version}`);
console.log(`Commit：${manifest.commit}`);
console.log(`SHA-256：${actualHash}`);
