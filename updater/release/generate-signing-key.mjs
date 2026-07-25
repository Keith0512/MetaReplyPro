import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKeyRecord } from './key-utils.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const privateKeyArg = args.get('--private-key');
const publicKeyArg = args.get('--public-key') ?? resolve(repoRoot, 'updater/trusted-update-key.json');
if (!privateKeyArg || !isAbsolute(privateKeyArg)) {
  throw new Error('請以 --private-key 指定 repository 外的絕對路徑');
}

const privateKeyPath = resolve(privateKeyArg);
const publicKeyPath = resolve(publicKeyArg);
const privateRelative = relative(repoRoot, privateKeyPath);
if (!privateRelative.startsWith('..') && !isAbsolute(privateRelative)) {
  throw new Error('私鑰不可存放在 repository 內');
}
if (existsSync(privateKeyPath) || existsSync(publicKeyPath)) {
  throw new Error('目標金鑰已存在；為避免覆寫，請先確認金鑰輪替流程');
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicExponent: 0x10001,
});
mkdirSync(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
writeFileSync(
  privateKeyPath,
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
  { mode: 0o600, flag: 'wx' },
);
chmodSync(privateKeyPath, 0o600);
writeFileSync(
  publicKeyPath,
  `${JSON.stringify(publicKeyRecord(publicKey), null, 2)}\n`,
  { flag: 'wx' },
);

console.log(`公開金鑰：${publicKeyPath}`);
console.log(`私鑰：${privateKeyPath}（請離線備份，絕對不要加入 Git）`);
