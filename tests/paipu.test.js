import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalCode,
  decodeTenhouMeld,
  isRedFive,
  normalizeTileCode,
  tenhouIdToTileCode,
} from '../src/paipu/tile_converter.js';
import { parseTenhouJson } from '../src/paipu/tenhou_parser.js';
import { parseMjai } from '../src/paipu/mjai_parser.js';
import { GameReplayer } from '../src/paipu/game_replayer.js';
import { extractMajsoulUrlInfo } from '../src/paipu/majsoul_parser.js';
import { DEMO_PAIPU_DATA, PaipuMatch, parsePaipuJson } from '../src/paipu/paipu_service.js';

test('天凤牌 ID 与标准牌代码转换 (包含赤五)', () => {
  assert.equal(tenhouIdToTileCode(0), '1m');
  assert.equal(tenhouIdToTileCode(16), '0m'); // 赤五万
  assert.equal(tenhouIdToTileCode(17), '5m');
  assert.equal(tenhouIdToTileCode(52), '0p'); // 赤五筒
  assert.equal(tenhouIdToTileCode(88), '0s'); // 赤五索
  assert.equal(tenhouIdToTileCode(108), '1z'); // 东
  assert.equal(tenhouIdToTileCode(135), '7z'); // 中

  assert.equal(normalizeTileCode('5mr'), '0m');
  assert.equal(normalizeTileCode('0p'), '0p');
  assert.equal(normalizeTileCode('E'), '1z');
  assert.equal(normalizeTileCode('16'), '0m');
  assert.equal(canonicalCode('0m'), '5m');
  assert.equal(isRedFive('0m'), true);
  assert.equal(isRedFive('5m'), false);
});

test('解析天凤副露编码', () => {
  // Chi decode
  const chiMeld = decodeTenhouMeld(13319);
  assert.ok(chiMeld);
  assert.equal(chiMeld.type, 'sequence');
  assert.equal(chiMeld.open, true);
});

test('解析标准天凤牌谱 JSON 格式', () => {
  const parsed = parseTenhouJson(DEMO_PAIPU_DATA);
  assert.equal(parsed.metadata.players.length, 4);
  assert.equal(parsed.rounds.length, 2);

  const r1 = parsed.rounds[0];
  assert.equal(r1.roundName, '东 1 局');
  assert.equal(r1.oya, 0);
  assert.ok(r1.events.length > 5);

  const initEv = r1.events[0];
  assert.equal(initEv.type, 'init');
  assert.equal(initEv.doraIndicators[0], '9m');
});

test('解析 MJAI 事件流', () => {
  const mjaiEvents = [
    { type: 'start_game', names: ['P0', 'P1', 'P2', 'P3'] },
    {
      type: 'start_kyoku',
      bakaze: 'E',
      kyoku: 1,
      honba: 0,
      dora_marker: '1m',
      scores: [25000, 25000, 25000, 25000],
      tehais: [
        ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p'],
        ['1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '1z', '2z', '3z', '4z'],
        [],
        [],
      ],
    },
    { type: 'tsumo', actor: 0, pai: '5mr' },
    { type: 'dahai', actor: 0, pai: '4p', tsumogiri: false },
    { type: 'tsumo', actor: 1, pai: '7z' },
    { type: 'dahai', actor: 1, pai: '7z', tsumogiri: true },
    { type: 'hora', actor: 0, target: 0, deltas: [4000, -2000, -1000, -1000] },
    { type: 'end_kyoku' },
  ];

  const parsed = parseMjai(mjaiEvents);
  assert.equal(parsed.metadata.players[0], 'P0');
  assert.equal(parsed.rounds.length, 1);
  assert.equal(parsed.rounds[0].roundName, '东 1 局');
  assert.equal(parsed.rounds[0].events.length, 6);
});

test('雀魂对局 URL 与 UUID 解析', () => {
  const url1 = 'https://game.maj-soul.com/1/?paipu=210815-6da08e40-2605-42fb-a5e3-f8aa5940362a_a111703554';
  const info1 = extractMajsoulUrlInfo(url1);
  assert.ok(info1);
  assert.equal(info1.uuid, '210815-6da08e40-2605-42fb-a5e3-f8aa5940362a');
  assert.equal(info1.viewerId, '111703554');

  const url2 = '210815-6da08e40-2605-42fb-a5e3-f8aa5940362a';
  const info2 = extractMajsoulUrlInfo(url2);
  assert.ok(info2);
  assert.equal(info2.uuid, '210815-6da08e40-2605-42fb-a5e3-f8aa5940362a');

  assert.equal(extractMajsoulUrlInfo('not a valid url'), null);
});

test('复盘引擎模拟手牌流转与切牌建议对比', () => {
  const match = parsePaipuJson(DEMO_PAIPU_DATA);
  assert.equal(match.roundCount, 2);

  const r1 = match.getRound(0);
  const replayer = r1.replayer;
  assert.ok(replayer.totalSteps > 5);

  // Step 0: Init
  const step0 = replayer.getStep(0);
  assert.equal(step0.actionType, 'init');
  assert.equal(step0.state.hands[0].tiles.length, 13);

  // Step 1: Player 0 draws 0p (red 5p)
  const step1 = replayer.getStep(1);
  assert.equal(step1.actionType, 'tsumo');
  assert.equal(step1.actor, 0);
  assert.equal(step1.isDiscardDecision, true);
  assert.equal(step1.state.hands[0].tiles.length, 14);
  assert.equal(step1.actualDiscard, '7z');

  // Verify advisor evaluation at step 1
  const adv = replayer.getAdvisorForStep(1);
  assert.ok(adv);
  assert.ok(adv.analysis);
  assert.equal(adv.analysis.drawState, true);
  assert.ok(adv.analysis.suggestions.length > 0);
  assert.ok(adv.comparison);
  assert.equal(adv.comparison.actualDiscard, '7z');
  // AI recommends discarding 7z (or 5z), comparison provides ukeireDiff and match
  assert.ok(['7z', '5z'].includes(adv.comparison.bestDiscard));

  // Step 2: Player 0 discards 7z
  const step2 = replayer.getStep(2);
  assert.equal(step2.actionType, 'dahai');
  assert.equal(step2.actor, 0);
  assert.equal(step2.state.hands[0].tiles.length, 13);
  assert.equal(step2.state.rivers[0].discards[0].code, '7z');
});
