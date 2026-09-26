/**
 * Genuine self-signed X.509 certificate (v3, basicConstraints C A, subjectKey
 * identifier, SHA-256 RSA signature) for hermetic TLS tests. Produces PEM
 * certificate + PEM PKCS8 private key that node:https can serve.
 *
 * DER construction is kept deliberately small and explicit (no external ASN.1
 * library) and was validated against OpenSSL (openssl x509 -text -noout) and
 * node:tls during development.
 */

import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let x = n;
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x = Math.floor(x / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function asn1(tag, buf) {
  return Buffer.concat([Buffer.from([tag]), derLen(buf.length), buf]);
}

function seq(...parts) {
  return asn1(0x30, Buffer.concat(parts));
}

function encodeOid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let x = parts[i];
    const octets = [x & 0x7f];
    x = Math.floor(x / 128);
    while (x > 0) {
      octets.unshift((x & 0x7f) | 0x80);
      x = Math.floor(x / 128);
    }
    bytes.push(...octets);
  }
  return asn1(0x06, Buffer.from(bytes));
}

function integerBytes(bigint) {
  if (bigint === BigInt(0)) return Buffer.from([0x00]);
  const bytes = [];
  let x = bigint;
  while (x > BigInt(0)) {
    bytes.unshift(Number(x & BigInt(0xff)));
    x >>= BigInt(8);
  }
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return Buffer.from(bytes);
}

function utcTime(date) {
  const s = date.toISOString();
  const yyyy = (Number(s.slice(0, 4)) % 100).toString().padStart(2, '0');
  return Buffer.from(
    yyyy + s.slice(5, 7) + s.slice(8, 10) + s.slice(11, 13) + s.slice(14, 16) + s.slice(17, 19) + 'Z',
  );
}

function dnSequence(cn) {
  // RDNSequence = SEQUENCE OF RelativeDistinguishedName; each RDN is a SET OF
  // AttributeTypeAndValue (SEQUENCE { type, value }). Missing SET breaks
  // OpenSSL with "wrong tag" - kept explicit here.
  return seq(
    asn1(0x31, seq(encodeOid('2.5.4.6'), asn1(0x13, Buffer.from('US', 'ascii')))), // PrintableString
    asn1(0x31, seq(encodeOid('2.5.4.3'), asn1(0x13, Buffer.from(cn, 'ascii')))), // PrintableString
  );
}

function bitStringSignature(signatureDer) {
  return asn1(0x03, Buffer.concat([Buffer.from([0x00]), signatureDer]));
}

/**
 * Generate a self-signed certificate and private key.
 * @returns {{ key: string, cert: string, keyDer: Buffer, certDer: Buffer }}
 */
export function selfSignedCert(cn = 'dsh-chatgpt-bridge-test.local') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubSpki = publicKey.export({ type: 'spki', format: 'der' });
  const ski = createHash('sha1').update(pubSpki).digest();

  const now = Date.now();
  const notBefore = new Date(now - 24 * 3600 * 1000);
  const notAfter = new Date(now + 365 * 24 * 3600 * 1000);
  const serial = BigInt('0x' + randomBytes(16).toString('hex'));

  const sigAlg = seq(encodeOid('1.2.840.113549.1.1.11'), asn1(0x05, Buffer.alloc(0))); // sha256WithRSAEncryption + NULL

  const tbsCertificate = seq(
    asn1(0xa0, Buffer.from([0x02, 0x01, 0x02])), // version v3
    asn1(0x02, integerBytes(serial)),
    sigAlg,
    dnSequence(cn),
    seq(asn1(0x17, utcTime(notBefore)), asn1(0x17, utcTime(notAfter))),
    dnSequence(cn),
    pubSpki,
    asn1(
      0xa3,
      seq(
        // basicConstraints (critical, CA:TRUE)
        seq(encodeOid('2.5.29.19'), asn1(0x01, Buffer.from([0xff])), asn1(0x04, seq(asn1(0x01, Buffer.from([0xff]))))),
        // subjectKeyIdentifier
        seq(encodeOid('2.5.29.14'), asn1(0x04, asn1(0x04, ski))),
      ),
    ),
  );

  const signature = sign('sha256', tbsCertificate, privateKey);
  const certDer = seq(tbsCertificate, sigAlg, bitStringSignature(signature));

  const certPem =
    '-----BEGIN CERTIFICATE-----\n' +
    certDer.toString('base64').match(/.{1,64}/g).join('\n') +
    '\n-----END CERTIFICATE-----\n';

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: certPem,
    keyDer: privateKey.export({ type: 'pkcs8', format: 'der' }),
    certDer,
  };
}
