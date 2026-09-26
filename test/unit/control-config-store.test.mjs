import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigStore, UnknownSchemaVersionError, defaultRuntimeConfig, mergeRuntimeConfig } from '../../lib/control/config-store.js';

const tmp = mkdtempSync(join(process.cwd(), '.ctrl-config-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('config-store: default config when no file', () => {
  const store = new ConfigStore(tmp);
  const cfg = store.load();
  assert.equal(cfg.schemaVersion, 1);
  assert.equal(cfg.tunnel.autoStart, false);
  assert.deepEqual(cfg.tunnel.proxy, { enabled: false });
});

test('config-store: save and load round-trip', () => {
  const store = new ConfigStore(tmp);
  const cfg = { ...defaultRuntimeConfig(), tunnel: { ...defaultRuntimeConfig().tunnel, tunnelId: 'tunnel_abc', autoStart: true } };
  store.save(cfg);
  const loaded = store.load();
  assert.equal(loaded.tunnel.tunnelId, 'tunnel_abc');
  assert.equal(loaded.tunnel.autoStart, true);
});

test('config-store: atomic write leaves no partial file (write tmp then rename)', () => {
  const store = new ConfigStore(tmp);
  store.save({ ...defaultRuntimeConfig(), tunnel: { ...defaultRuntimeConfig().tunnel, tunnelId: 'tunnel_atomic' } });
  const entries = readFileSync(join(tmp, 'chatgpt-bridge', 'runtime-config.json'), 'utf8');
  assert.ok(entries.includes('tunnel_atomic'));
  const leftovers = readdirSync(join(tmp, 'chatgpt-bridge')).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('config-store: corrupt JSON throws', () => {
  const dir = join(tmp, 'corrupt');
  const store = new ConfigStore(dir);
  mkdirSync(join(dir, 'chatgpt-bridge'), { recursive: true });
  writeFileSync(join(dir, 'chatgpt-bridge', 'runtime-config.json'), '{ not json', 'utf8');
  assert.throws(() => store.load(), /not valid JSON/);
});

test('config-store: unknown schemaVersion throws typed error', () => {
  const dir = join(tmp, 'unknown');
  const store = new ConfigStore(dir);
  mkdirSync(join(dir, 'chatgpt-bridge'), { recursive: true });
  writeFileSync(join(dir, 'chatgpt-bridge', 'runtime-config.json'), JSON.stringify({ schemaVersion: 99 }), 'utf8');
  assert.throws(() => store.load(), UnknownSchemaVersionError);
});

test('config-store: update mutates and persists', () => {
  const store = new ConfigStore(tmp);
  const next = store.update((cfg) => ({ ...cfg, tunnel: { ...cfg.tunnel, tunnelId: 'tunnel_updated' } }));
  assert.equal(next.tunnel.tunnelId, 'tunnel_updated');
  assert.equal(store.load().tunnel.tunnelId, 'tunnel_updated');
});

test('config-store: mergeRuntimeConfig clears executable and controlPlaneBaseUrl on empty string or undefined', () => {
  const base = {
    ...defaultRuntimeConfig(),
    tunnel: { ...defaultRuntimeConfig().tunnel, executable: '/path/to/bin', tunnelId: 't1' },
    openai: { controlPlaneBaseUrl: 'https://custom.openai.com' },
  };
  const patch = {
    tunnel: { executable: '' },
    openai: { controlPlaneBaseUrl: '' },
  };
  const merged = mergeRuntimeConfig(base, patch);
  assert.equal(merged.tunnel.executable, undefined);
  assert.equal(merged.openai.controlPlaneBaseUrl, undefined);
  assert.equal(merged.tunnel.tunnelId, 't1');
});
