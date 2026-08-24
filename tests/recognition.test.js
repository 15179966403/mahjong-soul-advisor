import test from 'node:test';
import assert from 'node:assert/strict';

import {
  codesToTileState,
  draftDiagnostics,
  normalizeRecognitionResult,
} from '../src/recognition.js';
import { tileIndex } from '../src/mahjong.js';

function tile(code, confidence = 0.9, sideways = false) {
  return { code, confidence, bbox: [10, 20, 30, 40], sideways };
}

test('识别响应保留四家牌河和赤五身份', () => {
  const draft = normalizeRecognitionResult({
    schemaVersion: 1,
    image: { width: 1920, height: 1080 },
    hand: [tile('0m')],
    rivers: {
      self: [tile('1m')],
      right: [tile('2m', 0.9, true)],
      opposite: [tile('3m')],
      left: [tile('4m')],
    },
    context: {
      riichi: { self: false, right: true, opposite: false, left: false },
      doraIndicators: [tile('7z')],
      selfWind: '2z',
      roundWind: '1z',
      roundWindConfidence: 0.84,
    },
    warnings: [],
  });

  assert.deepEqual(
    Object.fromEntries(Object.entries(draft.rivers).map(([position, tiles]) => (
      [position, tiles.map((item) => item.code)]
    ))),
    { self: ['1m'], right: ['2m'], opposite: ['3m'], left: ['4m'] },
  );
  const handState = codesToTileState(draft.hand.map((item) => item.code));
  assert.equal(handState.counts[tileIndex('5m')], 1);
  assert.equal(handState.redFives[tileIndex('5m')], 1);
  assert.equal(draft.rivers.right[0].sideways, true);
  assert.deepEqual(draft.context.doraIndicators.map((item) => item.code), ['7z']);
  assert.equal(draft.context.selfWind, '2z');
  assert.equal(draft.context.roundWind, '1z');
  assert.equal(draft.context.roundWindConfidence, 0.84);
  assert.deepEqual(
    draft.context.riichi,
    { self: false, right: true, opposite: false, left: false },
  );
});

test('校对诊断跨手牌和四家牌河检查可见牌上限', () => {
  const draft = normalizeRecognitionResult({
    schemaVersion: 1,
    image: { width: 1920, height: 1080 },
    hand: [tile('5p'), tile('0p')],
    rivers: {
      self: [tile('5p')],
      right: [tile('0p')],
      opposite: [tile('5p')],
      left: [],
    },
    warnings: [],
  });
  assert.deepEqual(draftDiagnostics(draft).impossibleCodes, [{ code: '5p', count: 5 }]);
});
