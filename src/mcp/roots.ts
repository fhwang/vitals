import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PathOutsideRootsError } from '../records/index.js';

export class RootsState {
  private rootRealPaths: ReadonlySet<string> = new Set();

  async setRoots(uris: readonly string[]): Promise<void> {
    const resolved = await Promise.all(uris.map((uri) => realpath(fileURLToPath(uri))));
    this.rootRealPaths = new Set(resolved);
  }

  async validatePath(absolutePath: string): Promise<string> {
    let real: string;
    try {
      real = await realpath(absolutePath);
    } catch {
      throw new PathOutsideRootsError(absolutePath);
    }
    for (const root of this.rootRealPaths) {
      if (real === root || real.startsWith(root + sep)) return real;
    }
    throw new PathOutsideRootsError(absolutePath);
  }
}
