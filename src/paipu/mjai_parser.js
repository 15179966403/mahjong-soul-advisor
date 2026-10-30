import { normalizeTileCode } from './tile_converter.js';

const ROUND_WIND_MAP = {
  E: '1z',
  S: '2z',
  W: '3z',
  N: '4z',
  '1z': '1z',
  '2z': '2z',
};

const ROUND_NAMES = [
  '东 1 局', '东 2 局', '东 3 局', '东 4 局',
  '南 1 局', '南 2 局', '南 3 局', '南 4 局',
  '西 1 局', '西 2 局', '西 3 局', '西 4 局',
];

/**
 * Parse MJAI event stream (array of objects or newline-delimited JSON string).
 */
export function parseMjai(input) {
  let rawEvents = [];
  if (Array.isArray(input)) {
    rawEvents = input;
  } else if (typeof input === 'string') {
    const lines = input.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        rawEvents.push(JSON.parse(line));
      } catch (err) {
        // Skip unparseable lines
      }
    }
  } else if (typeof input === 'object' && input !== null) {
    if (Array.isArray(input.events)) rawEvents = input.events;
    else if (Array.isArray(input.records)) rawEvents = input.records;
    else if (Array.isArray(input.actions)) rawEvents = input.actions;
  }

  if (rawEvents.length === 0) {
    throw new Error('未能在输入中解析出任何 MJAI 事件');
  }

  const metadata = {
    title: 'MJAI 对局',
    players: ['玩家 1', '玩家 2', '玩家 3', '玩家 4'],
    rule: {},
  };

  const rounds = [];
  let currentRound = null;
  let currentEvents = [];

  for (const ev of rawEvents) {
    if (!ev || !ev.type) continue;

    if (ev.type === 'start_game') {
      if (Array.isArray(ev.names)) {
        metadata.players = ev.names.map((name, i) => name || `玩家 ${i + 1}`);
      }
      continue;
    }

    if (ev.type === 'start_kyoku') {
      if (currentRound) {
        rounds.push({
          ...currentRound,
          events: currentEvents,
        });
      }

      const bakaze = ROUND_WIND_MAP[ev.bakaze] || '1z';
      const kyoku = Number(ev.kyoku) || 1;
      const roundIdx = (bakaze === '2z' ? 4 : 0) + (kyoku - 1);
      const oya = ev.oya !== undefined ? Number(ev.oya) : ((kyoku - 1) % 4);

      const initialHands = Array.isArray(ev.tehais)
        ? ev.tehais.map(h => (Array.isArray(h) ? h.filter(t => t !== '?').map(normalizeTileCode) : []))
        : [[], [], [], []];

      const initialDora = ev.dora_marker ? [normalizeTileCode(ev.dora_marker)] : [];

      currentRound = {
        roundIndex: roundIdx,
        roundName: ROUND_NAMES[roundIdx] || `${bakaze === '2z' ? '南' : '东'} ${kyoku} 局`,
        honba: Number(ev.honba) || 0,
        riichiSticks: Number(ev.kyotaku ?? ev.kyoutaku) || 0,
        oya,
        scores: Array.isArray(ev.scores) ? [...ev.scores] : [25000, 25000, 25000, 25000],
      };

      currentEvents = [{
        type: 'init',
        roundIndex: roundIdx,
        roundName: currentRound.roundName,
        honba: currentRound.honba,
        riichiSticks: currentRound.riichiSticks,
        oya,
        roundWind: bakaze,
        scores: [...currentRound.scores],
        doraIndicators: initialDora,
        hands: initialHands,
      }];
      continue;
    }

    if (!currentRound) continue;

    switch (ev.type) {
      case 'tsumo': {
        if (ev.pai && ev.pai !== '?') {
          currentEvents.push({
            type: 'tsumo',
            actor: Number(ev.actor),
            tile: normalizeTileCode(ev.pai),
          });
        }
        break;
      }

      case 'dahai': {
        currentEvents.push({
          type: 'dahai',
          actor: Number(ev.actor),
          tile: normalizeTileCode(ev.pai),
          tsumogiri: Boolean(ev.tsumogiri),
          isRiichi: false,
        });
        break;
      }

      case 'chi':
      case 'pon':
      case 'daiminkan': {
        const calledTile = normalizeTileCode(ev.pai);
        const consumed = (ev.consumed || []).map(normalizeTileCode);
        currentEvents.push({
          type: 'call',
          actor: Number(ev.actor),
          callType: ev.type,
          tile: calledTile,
          consumed,
          tiles: [calledTile, ...consumed],
          target: Number(ev.target),
        });
        break;
      }

      case 'ankan': {
        const consumed = (ev.consumed || []).map(normalizeTileCode);
        currentEvents.push({
          type: 'call',
          actor: Number(ev.actor),
          callType: 'ankan',
          tile: consumed[0] || null,
          consumed,
          tiles: consumed,
          target: Number(ev.actor),
        });
        break;
      }

      case 'kakan': {
        const addedTile = normalizeTileCode(ev.pai);
        const consumed = (ev.consumed || []).map(normalizeTileCode);
        currentEvents.push({
          type: 'call',
          actor: Number(ev.actor),
          callType: 'kakan',
          tile: addedTile,
          consumed,
          tiles: [addedTile, ...consumed],
          target: Number(ev.actor),
        });
        break;
      }

      case 'dora': {
        if (ev.dora_marker) {
          currentEvents.push({
            type: 'dora',
            tile: normalizeTileCode(ev.dora_marker),
          });
        }
        break;
      }

      case 'reach': {
        currentEvents.push({
          type: 'reach',
          actor: Number(ev.actor),
        });
        break;
      }

      case 'reach_accepted': {
        currentEvents.push({
          type: 'reach_accepted',
          actor: Number(ev.actor),
        });
        break;
      }

      case 'hora': {
        currentEvents.push({
          type: 'hora',
          actor: Number(ev.actor),
          target: Number(ev.target),
          isTsumo: Number(ev.actor) === Number(ev.target),
          deltaScores: ev.deltas || [0, 0, 0, 0],
          details: ev,
        });
        break;
      }

      case 'ryukyoku': {
        currentEvents.push({
          type: 'ryukyoku',
          reason: ev.reason || '流局',
          deltaScores: ev.deltas || [0, 0, 0, 0],
        });
        break;
      }

      case 'end_kyoku': {
        // Round ends
        break;
      }
    }
  }

  if (currentRound && currentEvents.length > 0) {
    rounds.push({
      ...currentRound,
      events: currentEvents,
    });
  }

  if (rounds.length === 0) {
    throw new Error('未能在 MJAI 数据中提取到任何有效局次');
  }

  return { metadata, rounds };
}
