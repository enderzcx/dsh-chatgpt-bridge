/**
 * Shared harness for the direct-operation tests.
 *
 * Every test works inside a fresh temporary root so "inside root" and "outside
 * root" are real filesystem facts, not mocked path strings. Roots live under
 * the OS cache directory rather than /tmp, because macOS resolves /tmp to
 * /private/tmp and the credential denylist is checked against canonical paths.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDirectOpsPolicy } from '../../lib/direct/policy.js';

/** Canonical-scratch base: /tmp is a symlink on macOS, which breaks rule matching. */
export const SCRATCH_BASE = join(
  process.env.HOME ?? tmpdir(),
  'Library',
  'Caches',
  'dsh-chatgpt-bridge-tests',
);

/** @typedef {import('../../lib/direct/policy.js').DirectOpsConfigInput} DirectOpsConfigInput */

/**
 * @typedef {object} TestSandbox
 * @property {string} base    directory holding the trusted root
 * @property {string} root    the trusted root itself
 * @property {string} outside sibling directory outside every trusted root
 * @property {() => Promise<void>} cleanup
 */

/** @returns {Promise<TestSandbox>} */
export async function makeSandbox() {
  await mkdir(SCRATCH_BASE, { recursive: true });
  const base = await mkdtemp(join(SCRATCH_BASE, 'case-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  return {
    base,
    root,
    outside,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

/**
 * @param {TestSandbox} sandbox
 * @param {Partial<DirectOpsConfigInput>} [overrides]
 * @param {object} [execOverrides]
 */
export function policyFor(sandbox, overrides = {}, execOverrides = {}) {
  return resolveDirectOpsPolicy({
    enabled: true,
    allowWrites: true,
    roots: [sandbox.root],
    writableRoots: [sandbox.root],
    ...overrides,
    exec: {
      enabled: false,
      allowedCommands: [],
      cwdRoots: [sandbox.root],
      // network / filesystem / sandbox are intentionally NOT defaulted here, so
      // tests exercise the library's own fail-closed defaults.
      envPassthrough: ['PATH', 'HOME', 'LANG'],
      pathEntries: [],
      ...execOverrides,
    },
  });
}

/** @param {TestSandbox} sandbox */
export function readOnlyPolicy(sandbox) {
  return policyFor(sandbox, { allowWrites: false, writableRoots: [] });
}

/** True when this host has a usable OS sandbox (macOS sandbox-exec). */
export async function sandboxAvailable() {
  const { sandboxExecAvailable } = await import('../../lib/direct/policy.js');
  return sandboxExecAvailable();
}

/** @param {string} path @param {string} content */
export async function writeFixture(path, content) {
  await writeFile(path, content, 'utf8');
}

/** @param {string} target @param {string} linkPath */
export async function makeSymlink(target, linkPath) {
  await symlink(target, linkPath);
}
