import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const lookupRoot = path.resolve(import.meta.dirname, '../../data/dictionary/lookup/pinyin/t/TL');

async function readLookupMap(): Promise<Record<string, string[]>> {
  const raw = await readFile(path.resolve(lookupRoot, '../TL.json'), 'utf8');
  return JSON.parse(raw) as Record<string, string[]>;
}

describe('Taiwanese whole-word lookup artifacts', () => {
  it('indexes an unseparated multi-syllable TL reading', async () => {
    await expect(readLookupMap()).resolves.toMatchObject({ binatsai: expect.arrayContaining(['明仔載']) });
  });

  it('normalizes hyphenated and unhyphenated lookup to the same key', async () => {
    await expect(readLookupMap()).resolves.toMatchObject({ singlip: expect.arrayContaining(['成立']) });
  });

  it('never joins across slash-delimited alternative readings', async () => {
    await expect(readLookupMap()).resolves.not.toHaveProperty('tshihjih');
  });
});
