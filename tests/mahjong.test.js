import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeHand, calculateShanten, detectYaku, doraTile,
  parseMeld, parseTiles, tileIndex,
} from '../src/mahjong.js';

test('解析紧凑牌谱与红五', () => {
  const counts = parseTiles('123m 405p 789s 12344z');
  assert.equal(counts.reduce((a, b) => a + b, 0), 14);
  assert.equal(counts[tileIndex('5p')], 2);
  assert.throws(() => parseTiles('11111m'), /超过 4 张/);
});

test('标准型、七对子、国士向听', () => {
  assert.equal(calculateShanten(parseTiles('123m123p123s111z22z')), -1);
  assert.equal(calculateShanten(parseTiles('1122m3344p5566s77z')), -1);
  assert.equal(calculateShanten(parseTiles('19m19p19s1234567z1m')), -1);
  assert.equal(calculateShanten(parseTiles('123m123p123s11z45m')), 0);
});

test('听牌时列出和牌张', () => {
  const concealed = parseTiles('123m123p123s11z45m');
  const result = analyzeHand({ concealed, openMelds: [], discards: [[], [], []], riichi: [] });
  assert.equal(result.shanten, 0);
  assert.deepEqual(result.winning.map((x) => x.tile), [tileIndex('3m'), tileIndex('6m')]);
});

test('14 张时给出保持听牌的切牌建议', () => {
  const concealed = parseTiles('123m123p123s11z456m');
  const result = analyzeHand({ concealed, openMelds: [], discards: [[], [], []], riichi: [] });
  assert.equal(result.drawState, true);
  assert.equal(result.suggestions[0].nextShanten <= 0, true);
});

test('识别主要役种和宝牌顺序', () => {
  const yaku = detectYaku(parseTiles('234m234p234s678s55p'));
  assert.ok(yaku.includes('断幺九'));
  assert.ok(yaku.includes('三色同顺'));
  assert.equal(doraTile(tileIndex('9m')), tileIndex('1m'));
  assert.equal(doraTile(tileIndex('4z')), tileIndex('1z'));
  assert.equal(doraTile(tileIndex('7z')), tileIndex('5z'));
});

test('解析副露', () => {
  assert.deepEqual(parseMeld('123m'), { type: 'sequence', tile: 0, open: true });
  assert.deepEqual(parseMeld('777z'), { type: 'triplet', tile: 33, open: true });
  assert.throws(() => parseMeld('135m'), /顺子或刻子/);
});
