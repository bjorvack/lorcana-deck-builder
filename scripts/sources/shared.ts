import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\u2019]/g, "'")
    .replace(/[\u2010\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

export interface CardIndex {
  id: number;
  fullName: string;
  setCode: string;
  collectorNumber: string;
}

export async function readEventCache<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** atomic persist: a crash cannot leave a truncated event cache */
export async function writeEventCache(
  file: string,
  data: unknown,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

/** Retry-After is delay-seconds; HTTP-dates and malformed values use the fallback. */
export function retryAfterMs(res: Response, fallbackMs: number): number {
  const value = res.headers.get('Retry-After')?.trim();
  if (!value || !/^\d+$/.test(value)) return fallbackMs;
  const ms = Number(value) * 1000;
  return Number.isFinite(ms) ? ms : fallbackMs;
}
