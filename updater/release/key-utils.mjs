import { createHash, createPublicKey, constants } from 'node:crypto';

function fromBase64Url(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + padding, 'base64');
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function publicKeyRecord(publicKeyLike) {
  const publicKey =
    publicKeyLike?.type === 'public'
      ? publicKeyLike
      : createPublicKey(publicKeyLike);
  const jwk = publicKey.export({ format: 'jwk' });
  const modulus = fromBase64Url(jwk.n).toString('base64');
  const exponent = fromBase64Url(jwk.e).toString('base64');
  const der = publicKey.export({ type: 'spki', format: 'der' });

  return {
    schemaVersion: 1,
    keyId: `sha256:${createHash('sha256').update(der).digest('hex')}`,
    algorithm: 'RSASSA-PKCS1-v1_5-SHA256',
    rsaKeyValue: `<RSAKeyValue><Modulus>${modulus}</Modulus><Exponent>${exponent}</Exponent></RSAKeyValue>`,
  };
}

export function publicKeyFromRecord(record) {
  if (
    record?.schemaVersion !== 1 ||
    record?.algorithm !== 'RSASSA-PKCS1-v1_5-SHA256' ||
    typeof record?.rsaKeyValue !== 'string'
  ) {
    throw new Error('不支援的公開金鑰格式');
  }

  const modulus = record.rsaKeyValue.match(/<Modulus>([^<]+)<\/Modulus>/)?.[1];
  const exponent = record.rsaKeyValue.match(/<Exponent>([^<]+)<\/Exponent>/)?.[1];
  if (!modulus || !exponent) {
    throw new Error('公開金鑰缺少 Modulus 或 Exponent');
  }

  const key = createPublicKey({
    key: {
      kty: 'RSA',
      n: toBase64Url(Buffer.from(modulus, 'base64')),
      e: toBase64Url(Buffer.from(exponent, 'base64')),
    },
    format: 'jwk',
  });
  const actual = publicKeyRecord(key);
  if (actual.keyId !== record.keyId) {
    throw new Error('公開金鑰 keyId 不符');
  }
  return key;
}

export const rsaSigningOptions = {
  padding: constants.RSA_PKCS1_PADDING,
};
