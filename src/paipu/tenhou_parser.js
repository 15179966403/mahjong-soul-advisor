import {
  decodeTenhouMeld,
  normalizeTileCode,
  tenhouIdToTileCode,
} from './tile_converter.js';

const ROUND_NAMES = [
  '东 1 局', '东 2 局', '东 3 局', '东 4 局',
  '南 1 局', '南 2 局', '南 3 局', '南 4 局',
  '西 1 局', '西 2 局', '西 3 局', '西 4 局',
  '北 1 局', '北 2 局', '北 3 局', '北 4 局',
];

/**
 * Parse a meld action token from Tenhou log (string or number or object).
 */
export function parseTenhouCallToken(token, calledTile = null, fromPlayer = null) {
  if (!token) return null;

  if (typeof token === 'object') {
    return {
      type: token.type || 'chi',
      calledTile: normalizeTileCode(token.tile || token.pai || calledTile),
      consumed: (token.consumed || []).map(normalizeTileCode),
      fromPlayer: token.target ?? fromPlayer,
      tiles: (token.tiles || []).map(normalizeTileCode),
    };
  }

  const str = String(token).trim();

  // "r" or "r<tile>" is riichi, not meld
  if (/^r/i.test(str)) return null;

  // Pattern: "c<consumed>-<called>" or "p<consumed>-<called>"
  if (/^[cpka]/i.test(str)) {
    const kindChar = str[0].toLowerCase();
    const typeMap = { c: 'chi', p: 'pon', k: 'daiminkan', a: 'ankan' };
    const type = typeMap[kindChar] || 'chi';

    // If has format like "c12-3" or "p55-5" or "c123"
    const rest = str.slice(1);
    let called = calledTile;
    let consumed = [];

    if (rest.includes('-')) {
      const parts = rest.split('-');
      consumed = parts[0].split('').map(normalizeTileCode);
      called = normalizeTileCode(parts[1]);
    } else {
      // Numbers or codes
      const matches = rest.match(/(\d+[mps]?|\d+)/g) || [];
      const parsedTiles = matches.map(m => {
        try {
          return normalizeTileCode(m);
        } catch {
          return null;
        }
      }).filter(Boolean);

      if (parsedTiles.length >= 3) {
        called = calledTile || parsedTiles[0];
        consumed = parsedTiles.slice(1);
      }
    }

    return {
      type,
      calledTile: called,
      consumed,
      tiles: called ? [called, ...consumed] : consumed,
      fromPlayer,
    };
  }

  // Integer or "m<digits>" Tenhou binary meld
  const num = str.startsWith('m') ? Number(str.slice(1)) : Number(str);
  if (Number.isInteger(num) && num > 135) {
    const decoded = decodeTenhouMeld(num);
    if (decoded) {
      return {
        type: decoded.type,
        calledTile: decoded.calledTile,
        consumed: decoded.consumed,
        tiles: decoded.tiles,
        fromPlayer: fromPlayer ?? (decoded.fromRelation ? (4 - decoded.fromRelation) % 4 : null),
      };
    }
  }

  return null;
}

/**
 * Determine if an action item represents a call (Chi / Pon / Kan).
 */
function isCallAction(item) {
  if (!item) return false;
  if (typeof item === 'object' && item.type && ['chi', 'pon', 'kan', 'ankan', 'daiminkan', 'kakan'].includes(item.type)) {
    return true;
  }
  const str = String(item).trim();
  if (/^r/i.test(str)) return false;
  if (/^[cpka]/i.test(str)) return true;
  const num = Number(str.startsWith('m') ? str.slice(1) : str);
  return Number.isInteger(num) && num > 135;
}

/**
 * Interleave 4 players' action arrays from classic Tenhou log format into sequential events.
 */
function interleaveClassicTenhouActions({
  seed,
  oya,
  haipai,
  actions,
  doraIndicators,
  result,
}) {
  const events = [];
  const roundIdx = seed[0] || 0;
  const roundWind = Math.floor(roundIdx / 4) === 1 ? '2z' : '1z'; // 0: East, 1: South

  // Initialize INIT event
  events.push({
    type: 'init',
    roundIndex: roundIdx,
    roundName: ROUND_NAMES[roundIdx] || `局 ${roundIdx + 1}`,
    honba: seed[1] || 0,
    riichiSticks: seed[2] || 0,
    oya,
    roundWind,
    scores: [25000, 25000, 25000, 25000],
    doraIndicators: doraIndicators.slice(0, 1).map(normalizeTileCode),
    hands: haipai.map(h => h.map(normalizeTileCode)),
  });

  const ptrs = [0, 0, 0, 0];
  const maxActions = Math.max(...actions.map(a => a.length));
  let currentActor = oya;
  let doraIdx = 1;
  let lastDiscard = null;
  let safetyCounter = 0;
  const maxSteps = maxActions * 8 + 100;

  // Check if dealer begins with 14 tiles
  let needsDraw = haipai[oya].length < 14;

  while (safetyCounter++ < maxSteps) {
    // Check if round finished
    const allExhausted = ptrs.every((ptr, p) => ptr >= actions[p].length);
    if (allExhausted) break;

    // 1. Draw phase (if actor needs to draw)
    if (needsDraw) {
      if (ptrs[currentActor] >= actions[currentActor].length) {
        break;
      }
      const rawDraw = actions[currentActor][ptrs[currentActor]];

      // Check if rawDraw is actually a call or end
      if (isCallAction(rawDraw)) {
        // Unexpected call at draw phase, advance
        ptrs[currentActor] += 1;
        continue;
      }

      const drawTile = normalizeTileCode(rawDraw);
      ptrs[currentActor] += 1;

      events.push({
        type: 'tsumo',
        actor: currentActor,
        tile: drawTile,
      });
      needsDraw = false;
    }

    // 2. Discard phase for currentActor
    if (ptrs[currentActor] >= actions[currentActor].length) {
      break;
    }

    let rawItem = actions[currentActor][ptrs[currentActor]];
    let isRiichi = false;

    // Check for Riichi declaration
    if (String(rawItem).startsWith('r')) {
      events.push({
        type: 'reach',
        actor: currentActor,
      });
      isRiichi = true;
      ptrs[currentActor] += 1;

      if (ptrs[currentActor] >= actions[currentActor].length) break;
      rawItem = actions[currentActor][ptrs[currentActor]];
    }

    // Check if action is Ankan or Kakan during player's turn
    if (isCallAction(rawItem)) {
      const callData = parseTenhouCallToken(rawItem, null, currentActor);
      ptrs[currentActor] += 1;
      if (callData) {
        events.push({
          type: 'call',
          actor: currentActor,
          callType: callData.type,
          tile: callData.calledTile,
          consumed: callData.consumed,
          tiles: callData.tiles,
          target: currentActor,
        });

        // After kan, new dora indicator might be revealed
        if (doraIdx < doraIndicators.length) {
          events.push({
            type: 'dora',
            tile: normalizeTileCode(doraIndicators[doraIdx]),
          });
          doraIdx += 1;
        }

        // Kan requires drawing rinshan tile
        needsDraw = true;
        continue;
      }
    }

    // Normal Discard
    const discardTile = normalizeTileCode(rawItem);
    ptrs[currentActor] += 1;

    // Determine tsumogiri: if previous event was tsumo with the same tile
    const lastEvent = events[events.length - 1];
    const tsumogiri = lastEvent && lastEvent.type === 'tsumo' && lastEvent.actor === currentActor && lastEvent.tile === discardTile;

    events.push({
      type: 'dahai',
      actor: currentActor,
      tile: discardTile,
      tsumogiri,
      isRiichi,
    });

    if (isRiichi) {
      events.push({
        type: 'reach_accepted',
        actor: currentActor,
      });
    }

    lastDiscard = {
      actor: currentActor,
      tile: discardTile,
    };

    // 3. Check if any OTHER player calls this discard
    let caller = null;
    let callToken = null;

    for (let p = 0; p < 4; p += 1) {
      if (p === currentActor) continue;
      const nextPAction = actions[p][ptrs[p]];
      if (isCallAction(nextPAction)) {
        caller = p;
        callToken = nextPAction;
        break;
      }
    }

    if (caller !== null && callToken !== null) {
      // Caller consumes the discarded tile
      const callData = parseTenhouCallToken(callToken, lastDiscard.tile, currentActor);
      ptrs[caller] += 1;

      events.push({
        type: 'call',
        actor: caller,
        callType: callData ? callData.type : 'chi',
        tile: lastDiscard.tile,
        consumed: callData ? callData.consumed : [],
        tiles: callData ? callData.tiles : [lastDiscard.tile],
        target: currentActor,
      });

      // If daiminkan, new dora indicator may be revealed
      if (callData && callData.type === 'daiminkan' && doraIdx < doraIndicators.length) {
        events.push({
          type: 'dora',
          tile: normalizeTileCode(doraIndicators[doraIdx]),
        });
        doraIdx += 1;
      }

      // Next turn belongs to caller, who now needs to discard (NO draw needed)
      currentActor = caller;
      needsDraw = false;
    } else {
      // Normal flow: pass turn to next player in clockwise order (下家)
      currentActor = (currentActor + 1) % 4;
      needsDraw = true;
    }
  }

  // Final outcome (和了 / 流局)
  if (result && Array.isArray(result) && result.length >= 1) {
    const outcomeType = result[0];
    const scoreDeltas = result[1] || [0, 0, 0, 0];

    if (outcomeType === '和了') {
      const details = result[2] || [];
      const winner = details[0] ?? currentActor;
      const payer = details[1] ?? (lastDiscard ? lastDiscard.actor : winner);
      const isTsumo = winner === payer;

      events.push({
        type: 'hora',
        actor: winner,
        target: payer,
        isTsumo,
        deltaScores: scoreDeltas,
        details,
      });
    } else {
      events.push({
        type: 'ryukyoku',
        reason: outcomeType,
        deltaScores: scoreDeltas,
      });
    }
  }

  return events;
}

/**
 * Parse a Tenhou JSON payload into a list of normalized round events.
 */
export function parseTenhouJson(jsonObj) {
  if (!jsonObj) throw new Error('牌谱 JSON 为空');

  const metadata = {
    title: Array.isArray(jsonObj.title) ? jsonObj.title.join(' ') : (jsonObj.title || '雀魂/天凤对局'),
    players: Array.isArray(jsonObj.name) ? jsonObj.name : ['玩家 1', '玩家 2', '玩家 3', '玩家 4'],
    rule: jsonObj.rule || {},
  };

  const rounds = [];

  // Format 1: Classic 16-element log array
  if (Array.isArray(jsonObj.log)) {
    for (let r = 0; r < jsonObj.log.length; r += 1) {
      const roundLog = jsonObj.log[r];
      if (!Array.isArray(roundLog) || roundLog.length < 12) continue;

      const seed = roundLog[0] || [r, 0, 0];
      const scores = roundLog[1] || [25000, 25000, 25000, 25000];
      const doraIndicators = roundLog[2] || [];
      const oya = (seed[0] || 0) % 4;

      const haipai = [
        roundLog[4] || [],
        roundLog[6] || [],
        roundLog[8] || [],
        roundLog[10] || [],
      ];

      const actions = [
        roundLog[5] || [],
        roundLog[7] || [],
        roundLog[9] || [],
        roundLog[11] || [],
      ];

      const result = roundLog[12] || null;

      const events = interleaveClassicTenhouActions({
        seed,
        oya,
        haipai,
        actions,
        doraIndicators,
        result,
      });

      // Update initial scores in the first init event
      if (events[0] && events[0].type === 'init') {
        events[0].scores = [...scores];
      }

      rounds.push({
        roundIndex: r,
        roundName: ROUND_NAMES[seed[0] || r] || `第 ${r + 1} 局`,
        honba: seed[1] || 0,
        riichiSticks: seed[2] || 0,
        oya,
        events,
      });
    }
  }

  if (rounds.length === 0) {
    throw new Error('未能在天凤牌谱中解析到任何有效对局回合');
  }

  return { metadata, rounds };
}
