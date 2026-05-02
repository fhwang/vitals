export function checkNodeVersion(versionNode: string, version: string): string | null {
  const REQUIRED_MAJOR = 24;
  const actualMajor = Number.parseInt(versionNode, 10);
  if (actualMajor === REQUIRED_MAJOR) return null;
  return [
    `vitals requires Node ${REQUIRED_MAJOR}.x, but this process is using Node ${version}.`,
    `If you use nvm: 'cd' to the vitals repo (or worktree) and run 'nvm use'.`,
    `Otherwise: install Node ${REQUIRED_MAJOR} and ensure 'node' resolves to it on PATH.`,
    '',
  ].join('\n');
}

const message = checkNodeVersion(process.versions.node, process.version);
if (message !== null) {
  process.stderr.write(message);
  process.exit(1);
}
