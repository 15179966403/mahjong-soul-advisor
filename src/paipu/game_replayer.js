import {
  analyzeHand,
  TILE_CODES,
  TILE_NAMES,
  tileIndex,
} from '../mahjong.js';
import { canonicalCode, isRedFive, normalizeTileCode } from './tile_converter.js';

export function sortTiles(tiles) {
  return [...tiles].sort((a, b) => {
    const idxA = tileIndex(a);
    const idxB = tileIndex(b);
    if (idxA !== idxB) return idxA - idxB;
    if (a.startsWith('0')) return -1;
    if (b.startsWith('0')) return 1;
    return 0;
  });
}

function buildHandState(tiles) {
  const counts = Array(34).fill(0);
  const redFives = Array(34).fill(0);
  for (const t of tiles) {
    const idx = tileIndex(t);
    if (idx >= 0 && idx < 34) {
      counts[idx] += 1;
      if (isRedFive(t)) {
        redFives[idx] += 1;
      }
    }
  }
  return { counts, redFives };
}

function cloneHand(hand) {
  return {
    tiles: [...hand.tiles],
    counts: [...hand.counts],
    redFives: [...hand.redFives],
    tsumoTile: hand.tsumoTile,
    tileTotal: hand.tileTotal,
  };
}

function cloneState(state) {
  return {
    hands: state.hands.map(cloneHand),
    rivers: state.rivers.map(r => ({
      discards: r.discards.map(d => ({ ...d })),
    })),
    melds: state.melds.map(mList => mList.map(m => ({ ...m, tiles: [...m.tiles] }))),
    doraIndicators: [...state.doraIndicators],
    riichi: [...state.riichi],
    scores: [...state.scores],
    honba: state.honba,
    riichiSticks: state.riichiSticks,
    roundWind: state.roundWind,
    seatWinds: [...state.seatWinds],
  };
}

/**
 * GameReplayer takes a round definition and precomputes step-by-step game snapshots and advice.
 */
export class GameReplayer {
  constructor(round, playerNames = ['玩家 1', '玩家 2', '玩家 3', '玩家 4']) {
    this.round = round;
    this.playerNames = playerNames;
    this.steps = [];
    this.decisionStepIndices = [];
    this._advisorCache = new Map();
    this._simulate();
  }

  get totalSteps() {
    return this.steps.length;
  }

  getStep(index) {
    if (index < 0 || index >= this.steps.length) return null;
    return this.steps[index];
  }

  /**
   * Run or retrieve cached advisor analysis for a specific step.
   */
  getAdvisorForStep(stepIndex, strategy = 'balanced') {
    const step = this.getStep(stepIndex);
    if (!step || !step.isDiscardDecision || step.actor === null) return null;

    const cacheKey = `${stepIndex}_${strategy}`;
    if (this._advisorCache.has(cacheKey)) {
      return this._advisorCache.get(cacheKey);
    }

    const actor = step.actor;
    const state = step.state;
    const hand = state.hands[actor];

    // Build opponents relative to perspective actor
    const right = (actor + 1) % 4;
    const opp = (actor + 2) % 4;
    const left = (actor + 3) % 4;

    const selfDiscards = state.rivers[actor].discards.map(d => tileIndex(d.code)).filter(i => i >= 0);
    const discards = [
      state.rivers[right].discards.map(d => tileIndex(d.code)).filter(i => i >= 0),
      state.rivers[opp].discards.map(d => tileIndex(d.code)).filter(i => i >= 0),
      state.rivers[left].discards.map(d => tileIndex(d.code)).filter(i => i >= 0),
    ];
    const riichi = [
      state.riichi[right],
      state.riichi[opp],
      state.riichi[left],
    ];

    const openMelds = (state.melds[actor] || []).map(m => ({
      type: m.type === 'kan' || m.type === 'daiminkan' || m.type === 'ankan' || m.type === 'kakan' ? 'triplet' : m.type,
      tile: tileIndex(m.baseTile || m.tiles[0]),
      open: m.open !== false,
    }));

    const doraIndicators = state.doraIndicators.map(tileIndex).filter(i => i >= 0);

    let analysis = null;
    try {
      analysis = analyzeHand({
        concealed: [...hand.counts],
        openMelds,
        selfDiscards,
        discards,
        riichi,
        doraIndicators,
        redFives: [...hand.redFives],
        strategy,
        context: {
          seatWind: tileIndex(state.seatWinds[actor]),
          roundWind: tileIndex(state.roundWind),
        },
      });
    } catch (err) {
      // In case of unexpected rule violation in replay
      analysis = null;
    }

    let comparison = null;
    if (analysis && analysis.suggestions && analysis.suggestions.length > 0) {
      const bestSuggestion = analysis.suggestions[0];
      const bestDiscardCode = TILE_CODES[bestSuggestion.discard];

      const actualCode = step.actualDiscard ? normalizeTileCode(step.actualDiscard) : null;
      const actualIdx = actualCode ? tileIndex(actualCode) : -1;
      const actualSuggestion = actualIdx >= 0 ? analysis.suggestions.find(s => s.discard === actualIdx) : null;

      const isMatch = Boolean(actualCode && (canonicalCode(actualCode) === bestDiscardCode));
      const ukeireDiff = actualSuggestion ? (bestSuggestion.ukeire - actualSuggestion.ukeire) : (bestSuggestion.ukeire);
      const shantenDiff = actualSuggestion ? (actualSuggestion.nextShanten - bestSuggestion.nextShanten) : 0;
      const dangerDiff = actualSuggestion ? (actualSuggestion.danger - bestSuggestion.danger) : 0;

      comparison = {
        bestDiscard: bestDiscardCode,
        actualDiscard: actualCode,
        isMatch,
        bestSuggestion,
        actualSuggestion,
        ukeireDiff,
        shantenDiff,
        dangerDiff,
      };
    }

    const result = {
      analysis,
      comparison,
    };
    this._advisorCache.set(cacheKey, result);
    return result;
  }

  _simulate() {
    const events = this.round.events || [];
    if (events.length === 0) return;

    const initEv = events[0];
    const oya = initEv.oya !== undefined ? initEv.oya : (this.round.oya || 0);
    const roundWind = initEv.roundWind || '1z';

    const seatWinds = Array(4).fill(0).map((_, p) => {
      const rel = (p - oya + 4) % 4;
      return ['1z', '2z', '3z', '4z'][rel];
    });

    const hands = (initEv.hands || [[], [], [], []]).map(tiles => {
      const sorted = sortTiles(tiles);
      const { counts, redFives } = buildHandState(sorted);
      return {
        tiles: sorted,
        counts,
        redFives,
        tsumoTile: null,
        tileTotal: sorted.length,
      };
    });

    const currentState = {
      hands,
      rivers: Array(4).fill(0).map(() => ({ discards: [] })),
      melds: Array(4).fill(0).map(() => []),
      doraIndicators: [...(initEv.doraIndicators || [])],
      riichi: [false, false, false, false],
      scores: [...(initEv.scores || [25000, 25000, 25000, 25000])],
      honba: initEv.honba || 0,
      riichiSticks: initEv.riichiSticks || 0,
      roundWind,
      seatWinds,
    };

    // Initial step (Step 0: Game Start)
    this.steps.push({
      stepIndex: 0,
      turnNumber: 1,
      actionType: 'init',
      actor: oya,
      actorName: this.playerNames[oya],
      description: `${this.round.roundName} 开始，配牌完成`,
      isDiscardDecision: currentState.hands[oya].tileTotal === 14,
      actualDiscard: null,
      state: cloneState(currentState),
    });

    let currentTurn = 1;
    let pendingDecisionStepIndex = currentState.hands[oya].tileTotal === 14 ? 0 : null;

    for (let i = 1; i < events.length; i += 1) {
      const ev = events[i];
      let description = '';
      let isDiscardDecision = false;
      let actor = ev.actor !== undefined ? ev.actor : null;

      switch (ev.type) {
        case 'tsumo': {
          const t = ev.tile;
          const h = currentState.hands[ev.actor];
          h.tiles.push(t);
          h.tsumoTile = t;
          h.tileTotal = h.tiles.length;
          const idx = tileIndex(t);
          if (idx >= 0) {
            h.counts[idx] += 1;
            if (isRedFive(t)) h.redFives[idx] += 1;
          }

          description = `${this._seatLabel(ev.actor)} [${this.playerNames[ev.actor]}] 摸入 ${TILE_NAMES[idx] || t}`;
          isDiscardDecision = true;
          break;
        }

        case 'dahai': {
          const t = ev.tile;
          const h = currentState.hands[ev.actor];

          // Link actual discard back to previous decision step
          if (pendingDecisionStepIndex !== null && this.steps[pendingDecisionStepIndex]) {
            this.steps[pendingDecisionStepIndex].actualDiscard = t;
            pendingDecisionStepIndex = null;
          }

          // Remove tile from hand
          const removeIdx = h.tiles.findIndex(x => normalizeTileCode(x) === normalizeTileCode(t));
          if (removeIdx >= 0) {
            h.tiles.splice(removeIdx, 1);
          } else {
            // Fallback: remove by index
            const cIdx = tileIndex(t);
            const fallbackIdx = h.tiles.findIndex(x => tileIndex(x) === cIdx);
            if (fallbackIdx >= 0) h.tiles.splice(fallbackIdx, 1);
          }

          const idx = tileIndex(t);
          if (idx >= 0 && h.counts[idx] > 0) {
            h.counts[idx] -= 1;
            if (isRedFive(t) && h.redFives[idx] > 0) h.redFives[idx] -= 1;
          }

          h.tiles = sortTiles(h.tiles);
          h.tsumoTile = null;
          h.tileTotal = h.tiles.length;

          // Add to river
          currentState.rivers[ev.actor].discards.push({
            code: t,
            tsumogiri: Boolean(ev.tsumogiri),
            isRiichi: Boolean(ev.isRiichi),
            isCalled: false,
          });

          if (ev.actor === oya) {
            currentTurn += 1;
          }

          const cutTypeStr = ev.tsumogiri ? '摸切' : '手出';
          const riichiStr = ev.isRiichi ? ' (立直打牌)' : '';
          description = `${this._seatLabel(ev.actor)} [${this.playerNames[ev.actor]}] ${cutTypeStr} ${TILE_NAMES[idx] || t}${riichiStr}`;
          break;
        }

        case 'call': {
          const target = ev.target;
          if (target !== null && target !== undefined && target !== ev.actor) {
            const targetRiver = currentState.rivers[target].discards;
            if (targetRiver.length > 0) {
              targetRiver[targetRiver.length - 1].isCalled = true;
            }
          }

          const h = currentState.hands[ev.actor];
          for (const c of ev.consumed || []) {
            const removeIdx = h.tiles.findIndex(x => normalizeTileCode(x) === normalizeTileCode(c));
            if (removeIdx >= 0) h.tiles.splice(removeIdx, 1);
            const cIdx = tileIndex(c);
            if (cIdx >= 0 && h.counts[cIdx] > 0) {
              h.counts[cIdx] -= 1;
              if (isRedFive(c) && h.redFives[cIdx] > 0) h.redFives[cIdx] -= 1;
            }
          }
          h.tiles = sortTiles(h.tiles);
          h.tsumoTile = null;
          h.tileTotal = h.tiles.length;

          const callNames = { chi: '吃', pon: '碰', daiminkan: '明杠', ankan: '暗杠', kakan: '加杠' };
          const callTypeName = callNames[ev.callType] || '副露';

          currentState.melds[ev.actor].push({
            type: ev.callType,
            baseTile: ev.tile,
            tiles: ev.tiles || [ev.tile, ...(ev.consumed || [])],
            open: ev.callType !== 'ankan',
            fromPlayer: target,
          });

          description = `${this._seatLabel(ev.actor)} [${this.playerNames[ev.actor]}] ${callTypeName} ${ev.tile ? (TILE_NAMES[tileIndex(ev.tile)] || ev.tile) : ''}`;
          // After chi or pon, player holds 14-3*m and must discard without drawing
          if (ev.callType === 'chi' || ev.callType === 'pon') {
            isDiscardDecision = true;
          }
          break;
        }

        case 'reach': {
          description = `${this._seatLabel(ev.actor)} [${this.playerNames[ev.actor]}] 宣告立直!`;
          break;
        }

        case 'reach_accepted': {
          currentState.riichi[ev.actor] = true;
          currentState.scores[ev.actor] -= 1000;
          currentState.riichiSticks += 1;
          description = `${this._seatLabel(ev.actor)} [${this.playerNames[ev.actor]}] 立直成立 (-1000点)`;
          break;
        }

        case 'dora': {
          currentState.doraIndicators.push(ev.tile);
          description = `翻开新宝牌指示牌: ${TILE_NAMES[tileIndex(ev.tile)] || ev.tile}`;
          break;
        }

        case 'hora': {
          const winner = ev.actor;
          const payer = ev.target;
          const isTsumo = ev.isTsumo || winner === payer;
          const winTypeStr = isTsumo ? '自摸和了' : `荣和 (放铳: ${this._seatLabel(payer)} [${this.playerNames[payer]}])`;
          description = `和牌! ${this._seatLabel(winner)} [${this.playerNames[winner]}] ${winTypeStr}`;
          if (Array.isArray(ev.deltaScores)) {
            for (let p = 0; p < 4; p += 1) {
              currentState.scores[p] += (ev.deltaScores[p] || 0);
            }
          }
          break;
        }

        case 'ryukyoku': {
          description = `局终流局 (${ev.reason || '荒牌流局'})`;
          if (Array.isArray(ev.deltaScores)) {
            for (let p = 0; p < 4; p += 1) {
              currentState.scores[p] += (ev.deltaScores[p] || 0);
            }
          }
          break;
        }

        default:
          description = ev.type;
          break;
      }

      const stepIndex = this.steps.length;
      const newStep = {
        stepIndex,
        turnNumber: currentTurn,
        actionType: ev.type,
        actor,
        actorName: actor !== null ? this.playerNames[actor] : '',
        description,
        isDiscardDecision,
        actualDiscard: null,
        state: cloneState(currentState),
      };

      this.steps.push(newStep);

      if (isDiscardDecision) {
        this.decisionStepIndices.push(stepIndex);
        pendingDecisionStepIndex = stepIndex;
      }
    }
  }

  _seatLabel(playerIndex) {
    const winds = ['东家', '南家', '西家', '北家'];
    return winds[playerIndex] || `玩家${playerIndex + 1}`;
  }
}
