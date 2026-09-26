import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SecretStore } from '../../lib/control/secret-store.js';

const tmp = mkdtempSync(join(process.cwd(), '.ctrl-secret-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('secret-store: write, configured, replace', () => {
  const store = new SecretStore(tmp);
  assert.equal(store.runtimeApiKeyConfigured(), false);
  const ref = store.writeRuntimeApiKey('sk-test-1234567890');
  assert.ok(ref.startsWith('file:'));
  assert.equal(store.runtimeApiKeyConfigured(), true);
  const stored = readFileSync(store.runtimeApiKeyPath, 'utf8').trim();
  assert.equal(stored, 'sk-test-1234567890');
  store.writeRuntimeApiKey('sk-replaced-abcdefghijk');
  assert.equal(readFileSync(store.runtimeApiKeyPath, 'utf8').trim(), 'sk-replaced-abcdefghijk');
});

test('secret-store: empty value rejected', () => {
  const store = new SecretStore(tmp);
  assert.throws(() => store.writeRuntimeApiKey('   '), /runtime-api-key-empty/);
});

test('secret-store: clear removes file and configured flag', () => {
  const store = new SecretStore(tmp);
  store.writeRuntimeApiKey('sk-test-1234567890');
  store.clearRuntimeApiKey();
  assert.equal(store.runtimeApiKeyConfigured(), false);
  assert.equal(existsSync(store.runtimeApiKeyPath), false);
});

test('secret-store: mcp authorization content is full Bearer header', () => {
  const store = new SecretStore(tmp);
  const ref = store.ensureMcpAuthorization('bridge-token-123');
  assert.equal(ref, 'file:' + store.mcpAuthorizationPath);
  assert.equal(readFileSync(store.mcpAuthorizationPath, 'utf8').trim(), 'Bearer bridge-token-123');
});

test('secret-store: readRuntimeApiKey returns value only transiently', () => {
  const store = new SecretStore(tmp);
  assert.equal(store.readRuntimeApiKey(), undefined);
  store.writeRuntimeApiKey('sk-transient-123456');
  assert.equal(store.readRuntimeApiKey(), 'sk-transient-123456');
});
