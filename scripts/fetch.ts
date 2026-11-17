import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LORCANAJSON_BASE = 'https://lorcanajson.org/files/current/en';
const LORCAST_API = 'https://api.lorcast.com/v0';

export interface FetchResult {
  allCards: unknown;
  lorcastBySet: Record<string, unknown[]>;
  checksums: { file: string; ok: boolean }[];
  lorcastFetched: boolean;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} GET ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function cached(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function downloadIfMissing(url: string, dest: string): Promise<string> {
  const existing = await cached(dest);
  if (existing !== null) return existing;
  await download(url, dest);
  return (await cached(dest)) as string;
}

export async function verifyMd5(file: string, expectedMd5Url: string): Promise<boolean> {
  const res = await fetch(expectedMd5Url);
  if (!res.ok) return false;
  const expected = (await res.text()).trim().split(/\s+/)[0]?.toLowerCase();
  if (!expected) return false;
  const actual = createHash('md5').update(await readFile(file)).digest('hex');
  return actual === expected;
}

export async function fetchAll(cacheDir: string, opts: { skipLorcast?: boolean } = {}): Promise<FetchResult> {
  await mkdir(cacheDir, { recursive: true });
  const allCardsPath = path.join(cacheDir, 'allCards.json');

  await downloadIfMissing(`${LORCANAJSON_BASE}/allCards.json`, allCardsPath);
  const checksumOk = await verifyMd5(allCardsPath, `${LORCANAJSON_BASE}/allCards.json.md5`);
  const allCards = JSON.parse(await readFile(allCardsPath, 'utf8'));

  const lorcastBySet: Record<string, unknown[]> = {};
  let lorcastFetched = false;
  if (!opts.skipLorcast) {
    try {
      const setsRes = await fetch(`${LORCAST_API}/sets`);
      if (setsRes.ok) {
        const sets = (await setsRes.json()) as { results?: { code?: string }[] };
        for (const set of sets.results ?? []) {
          const code = set.code;
          if (!code || !/^\d+$/.test(code)) continue;
          const cardsRes = await fetch(`${LORCAST_API}/sets/${code}/cards`);
          if (!cardsRes.ok) continue;
          const body: unknown = await cardsRes.json();
          const list = Array.isArray(body) ? body : ((body as { results?: unknown[] }).results ?? []);
          lorcastBySet[code] = list;
          lorcastFetched = true;
        }
      }
    } catch {
      // Spec: Lorcast unavailable → still produce a complete snapshot
      lorcastFetched = false;
    }
  }

  return { allCards, lorcastBySet, checksums: [{ file: 'allCards.json', ok: checksumOk }], lorcastFetched };
}

export async function saveCache(cacheDir: string, data: FetchResult): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, 'fetched.json'), JSON.stringify(data));
}

export async function loadCache(cacheDir: string): Promise<FetchResult> {
  const raw = await readFile(path.join(cacheDir, 'fetched.json'), 'utf8');
  return JSON.parse(raw) as FetchResult;
}
