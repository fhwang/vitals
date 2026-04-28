import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RootsState } from './roots.js';

describe('RootsState', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vitals-roots-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts a path inside an advertised root', async () => {
    const root = join(tmpDir, 'allowed');
    await mkdir(root);
    const filePath = join(root, 'file.xml');
    await writeFile(filePath, 'x', 'utf8');

    const state = new RootsState();
    await state.setRoots([`file://${root}`]);

    const real = await state.validatePath(filePath);
    expect(real).toBe(await realpath(filePath));
  });

  it('rejects a path outside any root', async () => {
    const root = join(tmpDir, 'allowed');
    const outside = join(tmpDir, 'other');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'leak.xml'), 'x', 'utf8');

    const state = new RootsState();
    await state.setRoots([`file://${root}`]);

    await expect(state.validatePath(join(outside, 'leak.xml'))).rejects.toThrow(
      /not inside any advertised root/,
    );
  });

  it('rejects a sibling path that shares a prefix but is not a child', async () => {
    // root /tmp/.../foo must not match /tmp/.../foobar
    const root = join(tmpDir, 'foo');
    const sibling = join(tmpDir, 'foobar');
    await mkdir(root);
    await mkdir(sibling);
    const sneaky = join(sibling, 'leak.xml');
    await writeFile(sneaky, 'x', 'utf8');

    const state = new RootsState();
    await state.setRoots([`file://${root}`]);

    await expect(state.validatePath(sneaky)).rejects.toThrow(/not inside any advertised root/);
  });

  it('rejects a symlink that escapes the root', async () => {
    const root = join(tmpDir, 'allowed');
    const outside = join(tmpDir, 'secret');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.xml'), 'x', 'utf8');
    // create a symlink inside root pointing outside
    const escapeLink = join(root, 'escape.xml');
    await symlink(join(outside, 'secret.xml'), escapeLink);

    const state = new RootsState();
    await state.setRoots([`file://${root}`]);

    await expect(state.validatePath(escapeLink)).rejects.toThrow(/not inside any advertised root/);
  });

  it('rejects when no roots have been advertised', async () => {
    const filePath = join(tmpDir, 'file.xml');
    await writeFile(filePath, 'x', 'utf8');
    const state = new RootsState();
    await expect(state.validatePath(filePath)).rejects.toThrow(/not inside any advertised root/);
  });
});
