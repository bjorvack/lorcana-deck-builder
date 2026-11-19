import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAll } from './fetch';

const ALL_CARDS_URL = 'https://lorcanajson.org/files/current/en/allCards.json';
const tempDirs: string[] = [];

async function tempCacheDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ldb-fetch-'));
  tempDirs.push(dir);
  return dir;
}

function md5(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('fetch resilience', () => {
  it('re-downloads a stale cached snapshot when the published md5 changes', async () => {
    const dir = await tempCacheDir();
    const allCardsPath = path.join(dir, 'allCards.json');
    const fresh = JSON.stringify({ metadata: {}, sets: {}, cards: ['fresh'] });
    await writeFile(allCardsPath, JSON.stringify({ cards: ['stale'] }));

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${ALL_CARDS_URL}.md5`)
        return new Response(`${md5(fresh)}\n`, { status: 200 });
      if (url === ALL_CARDS_URL) return new Response(fresh, { status: 200 });
      throw new Error(`unexpected GET ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAll(dir, { skipLorcast: true });

    expect(result.allCards).toEqual(JSON.parse(fresh));
    expect(result.checksums).toEqual([{ file: 'allCards.json', ok: true }]);
    expect(await readFile(allCardsPath, 'utf8')).toBe(fresh);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === ALL_CARDS_URL),
    ).toHaveLength(1);
  });

  it('fails clearly when a freshly re-downloaded snapshot still mismatches', async () => {
    const dir = await tempCacheDir();
    await writeFile(path.join(dir, 'allCards.json'), '{"cards":["stale"]}');
    const fresh = JSON.stringify({ metadata: {}, sets: {}, cards: ['fresh'] });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${ALL_CARDS_URL}.md5`)
        return new Response(`${md5('different content')}\n`, { status: 200 });
      if (url === ALL_CARDS_URL) return new Response(fresh, { status: 200 });
      throw new Error(`unexpected GET ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAll(dir, { skipLorcast: true })).rejects.toThrow(
      'MD5 verification failed for allCards.json',
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === ALL_CARDS_URL),
    ).toHaveLength(1);
  });

  it('treats an md5 endpoint failure as a reason to refresh the cache', async () => {
    const dir = await tempCacheDir();
    const fresh = JSON.stringify({ metadata: {}, sets: {}, cards: [] });
    await writeFile(path.join(dir, 'allCards.json'), fresh);
    let md5Requests = 0;

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${ALL_CARDS_URL}.md5`) {
        md5Requests++;
        return md5Requests === 1
          ? new Response('unavailable', { status: 503 })
          : new Response(`${md5(fresh)}\n`, { status: 200 });
      }
      if (url === ALL_CARDS_URL) return new Response(fresh, { status: 200 });
      throw new Error(`unexpected GET ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAll(dir, { skipLorcast: true });

    expect(result.checksums[0]?.ok).toBe(true);
    expect(md5Requests).toBe(2);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === ALL_CARDS_URL),
    ).toHaveLength(1);
  });
});
