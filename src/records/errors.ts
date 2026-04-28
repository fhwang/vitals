export class RecordParseError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string, options?: ErrorOptions) {
    super(`parse failed for ${kind}: ${message}`, options);
    this.name = 'RecordParseError';
    this.kind = kind;
  }
}

export class UnsupportedKindError extends Error {
  readonly kind: string;
  readonly supportedKinds: readonly string[];
  constructor(kind: string, supportedKinds: readonly string[]) {
    super(`unsupported kind: ${kind} (supported: ${supportedKinds.join(', ')})`);
    this.name = 'UnsupportedKindError';
    this.kind = kind;
    this.supportedKinds = supportedKinds;
  }
}

export class PathOutsideRootsError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`path is not inside any advertised root: ${path}`);
    this.name = 'PathOutsideRootsError';
    this.path = path;
  }
}

export class FileNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`file not found: ${path}`);
    this.name = 'FileNotFoundError';
    this.path = path;
  }
}
