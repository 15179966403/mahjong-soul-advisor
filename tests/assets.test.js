import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const tileDir = path.resolve('public/assets/tiles');
const codes = [
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}m`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}p`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}s`),
  ...Array.from({ length: 7 }, (_, i) => `${i + 1}z`),
];

test('34 种麻将牌图片、纹样源文件与实体牌胚均存在', async () => {
  await access(path.join(tileDir, 'tile-base-v1.png'));
  for (const code of codes) {
    await access(path.join(tileDir, `${code}.png`));
    const svg = await readFile(path.join(tileDir, `${code}.svg`), 'utf8');
    assert.match(svg, new RegExp(`title-${code}`));
  }
});
