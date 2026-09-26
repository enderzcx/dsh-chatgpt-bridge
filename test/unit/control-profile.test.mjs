import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ProfileGenerator, buildProfileYaml } from '../../lib/control/profile-generator.js';

const tmp = mkdtempSync(join(process.cwd(), '.ctrl-profile-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const input = {
  controlPlaneBaseUrl: 'https://api.openai.com',
  tunnelId: 'tunnel_test123',
  runtimeApiKeyRef: 'file:C:/Users/t/.dsh/chatgpt-bridge/secrets/runtime-api-key',
  mcpAuthorizationRef: 'file:C:/Users/t/.dsh/chatgpt-bridge/secrets/mcp-authorization',
  bridgeUrl: 'http://127.0.0.1:3456/mcp',
  healthListenAddr: '127.0.0.1:0',
  healthUrlFile: 'C:/Users/t/.dsh/chatgpt-bridge/tunnel-health.url',
  logFile: 'C:/Users/t/.dsh/chatgpt-bridge/logs/tunnel-client.ndjson',
  logLevel: 'info',
};

test('profile: buildProfileYaml uses file refs and never literals', () => {
  const yaml = buildProfileYaml(input);
  assert.ok(yaml.includes('config_version: 1'));
  assert.ok(yaml.includes('api_key: "file:C:/Users/t/.dsh/chatgpt-bridge/secrets/runtime-api-key"'));
  assert.ok(yaml.includes('Authorization: "file:C:/Users/t/.dsh/chatgpt-bridge/secrets/mcp-authorization"'));
  assert.ok(yaml.includes('url: "http://127.0.0.1:3456/mcp"'));
  assert.ok(yaml.includes('listen_addr: "127.0.0.1:0"'));
  assert.ok(!yaml.includes('sk-'), 'no secret literal in profile');
});

test('profile: generator writes file and escapes backslashes', () => {
  const gen = new ProfileGenerator(tmp);
  const path = gen.write('chatgpt-bridge', input);
  assert.equal(path, join(tmp, 'chatgpt-bridge.yaml'));
  const raw = readFileSync(path, 'utf8');
  assert.ok(raw.includes('C:/Users/t/.dsh'), 'forward slashes kept');
  // Windows backslash paths must be escaped in the emitted YAML.
  const win = buildProfileYaml({ ...input, healthUrlFile: 'C:\\Users\\t\\x.url', mcpAuthorizationRef: 'file:C:\\x\\a' });
  assert.ok(win.includes('\\\\'), 'backslashes are escaped');
});

test('profile: profileName sanitized in path', () => {
  const gen = new ProfileGenerator(tmp);
  const path = gen.profilePath('bad/name!');
  assert.equal(path, join(tmp, 'bad_name_.yaml'));
});
