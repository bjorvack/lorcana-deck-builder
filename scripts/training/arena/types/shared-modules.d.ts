// Typecheck shim for `@tcg/shared/*` subpaths (see lorcana-engine.d.ts).

export function createRecordCardCatalog<T>(
  name: string,
  byId: Record<string, T>,
): unknown;
