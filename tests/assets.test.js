import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const tileDir = path.resolve('public/assets/tiles');
const codes = [
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}m`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}p`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}s`),
  ...Array.from({ length: 7 }, (_, i) => `${i + 1}z`),
];

test('34 种麻将牌均为独立的透明 PNG 实体牌图片', async () => {
  const files = (await readdir(tileDir)).sort();
  assert.deepEqual(files, codes.map((code) => `${code}.png`).sort());

  for (const code of codes) {
    const png = await readFile(path.join(tileDir, `${code}.png`));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');

    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const colorType = png[25];
    assert.ok(width <= 384 && height <= 384, `${code} 尺寸应适合网页加载`);
    assert.ok(colorType === 4 || colorType === 6, `${code} 应带透明通道`);
  }
});
