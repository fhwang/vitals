import { describe, expect, it } from 'vitest';

import { checkNodeVersion } from './preflight.js';

describe('checkNodeVersion', () => {
  it('returns null when the major matches', () => {
    expect(checkNodeVersion('24.1.0', 'v24.1.0')).toBeNull();
    expect(checkNodeVersion('24.99.0', 'v24.99.0')).toBeNull();
  });

  it('returns a guidance message naming both required and actual versions', () => {
    const msg = checkNodeVersion('22.22.1', 'v22.22.1');
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/vitals requires Node 24/);
    expect(msg).toMatch(/v22\.22\.1/);
    expect(msg).toMatch(/nvm use/);
  });

  it('treats unparsable input as a mismatch (fail-loud)', () => {
    expect(checkNodeVersion('', 'unknown')).not.toBeNull();
    expect(checkNodeVersion('abc', 'unknown')).not.toBeNull();
  });
});
