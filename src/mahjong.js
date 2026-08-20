export const TILE_CODES = [
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}m`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}p`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}s`),
  ...Array.from({ length: 7 }, (_, i) => `${i + 1}z`),
];

export const TILE_NAMES = [
  ...'一二三四五六七八九'.split('').map((n) => `${n}万`),
  ...'一二三四五六七八九'.split('').map((n) => `${n}筒`),
  ...'一二三四五六七八九'.split('').map((n) => `${n}索`),
  '东', '南', '西', '北', '白', '发', '中',
];

const YAOCHU = new Set([0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]);

export function tileIndex(code) {
  const match = /^([0-9])([mpsz])$/i.exec(code.trim());
  if (!match) return -1;
  let rank = Number(match[1]);
  const suit = match[2].toLowerCase();
  if (rank === 0 && suit !== 'z') rank = 5;
  const offset = { m: 0, p: 9, s: 18, z: 27 }[suit];
  const limit = suit === 'z' ? 7 : 9;
  return rank >= 1 && rank <= limit ? offset + rank - 1 : -1;
}

export function parseTiles(input = '') {
  const counts = Array(34).fill(0);
  const normalized = input.toLowerCase().replace(/[\s,，、|]/g, '');
  let digits = '';
  for (const char of normalized) {
    if (/\d/.test(char)) {
      digits += char;
      continue;
    }
    if (/[mpsz]/.test(char) && digits) {
      for (const digit of digits) {
        const index = tileIndex(`${digit}${char}`);
        if (index < 0) throw new Error(`无效牌：${digit}${char}`);
        counts[index] += 1;
        if (counts[index] > 4) throw new Error(`${TILE_NAMES[index]}超过 4 张`);
      }
      digits = '';
      continue;
    }
    throw new Error(`无法识别字符：${char}`);
  }
  if (digits) throw new Error(`数字 ${digits} 后缺少花色 m/p/s/z`);
  return counts;
}

export function countsToTiles(counts) {
  return counts.flatMap((count, index) => Array(count).fill(index));
}

export function countsToNotation(counts) {
  let result = '';
  for (let suit = 0; suit < 4; suit += 1) {
    const start = suit * 9;
    const size = suit === 3 ? 7 : 9;
    let digits = '';
    for (let i = 0; i < size; i += 1) digits += String(i + 1).repeat(counts[start + i] || 0);
    if (digits) result += `${digits}${'mpsz'[suit]}`;
  }
  return result;
}

function standardShanten(input, fixedMelds = 0) {
  const counts = [...input];
  let best = 8;
  const memo = new Map();

  function walk(start, melds, pair, taatsu) {
    while (start < 34 && counts[start] === 0) start += 1;
    if (start === 34) {
      const totalMelds = fixedMelds + melds;
      const usableTaatsu = Math.min(taatsu, Math.max(0, 4 - totalMelds));
      best = Math.min(best, 8 - totalMelds * 2 - usableTaatsu - pair);
      return;
    }

    const key = `${start}|${melds}|${pair}|${taatsu}|${counts.slice(start).join('')}`;
    if (memo.has(key)) return;
    memo.set(key, true);

    const suitPos = start % 9;
    if (counts[start] >= 3) {
      counts[start] -= 3;
      walk(start, melds + 1, pair, taatsu);
      counts[start] += 3;
    }
    if (start < 27 && suitPos <= 6 && counts[start + 1] && counts[start + 2]) {
      counts[start] -= 1; counts[start + 1] -= 1; counts[start + 2] -= 1;
      walk(start, melds + 1, pair, taatsu);
      counts[start] += 1; counts[start + 1] += 1; counts[start + 2] += 1;
    }
    if (counts[start] >= 2) {
      counts[start] -= 2;
      if (!pair) walk(start, melds, 1, taatsu);
      walk(start, melds, pair, taatsu + 1);
      counts[start] += 2;
    }
    if (start < 27 && suitPos <= 7 && counts[start + 1]) {
      counts[start] -= 1; counts[start + 1] -= 1;
      walk(start, melds, pair, taatsu + 1);
      counts[start] += 1; counts[start + 1] += 1;
    }
    if (start < 27 && suitPos <= 6 && counts[start + 2]) {
      counts[start] -= 1; counts[start + 2] -= 1;
      walk(start, melds, pair, taatsu + 1);
      counts[start] += 1; counts[start + 2] += 1;
    }
    counts[start] -= 1;
    walk(start, melds, pair, taatsu);
    counts[start] += 1;
  }

  walk(0, 0, 0, 0);
  return best;
}

export function calculateShanten(counts, fixedMelds = 0) {
  let value = standardShanten(counts, fixedMelds);
  if (fixedMelds === 0) {
    const pairs = counts.filter((count) => count >= 2).length;
    const unique = counts.filter(Boolean).length;
    value = Math.min(value, 6 - pairs + Math.max(0, 7 - unique));
    const uniqueYaochu = [...YAOCHU].filter((i) => counts[i]).length;
    const hasPair = [...YAOCHU].some((i) => counts[i] >= 2) ? 1 : 0;
    value = Math.min(value, 13 - uniqueYaochu - hasPair);
  }
  return value;
}

export function effectiveTiles(counts, fixedMelds = 0, visible = counts) {
  const current = calculateShanten(counts, fixedMelds);
  const tiles = [];
  for (let i = 0; i < 34; i += 1) {
    if ((visible[i] || 0) >= 4 || counts[i] >= 4) continue;
    counts[i] += 1;
    const next = calculateShanten(counts, fixedMelds);
    counts[i] -= 1;
    if (next < current) tiles.push({
      tile: i,
      remaining: Math.max(0, 4 - (visible[i] || 0)),
      nextShanten: next,
    });
  }
  return tiles;
}

function enumerateClosedGroups(counts, groups, needed, output) {
  let first = counts.findIndex(Boolean);
  if (first < 0) {
    if (groups.length === needed) output.push([...groups]);
    return;
  }
  if (groups.length >= needed) return;
  if (counts[first] >= 3) {
    counts[first] -= 3;
    groups.push({ type: 'triplet', tile: first, open: false });
    enumerateClosedGroups(counts, groups, needed, output);
    groups.pop(); counts[first] += 3;
  }
  if (first < 27 && first % 9 <= 6 && counts[first + 1] && counts[first + 2]) {
    counts[first] -= 1; counts[first + 1] -= 1; counts[first + 2] -= 1;
    groups.push({ type: 'sequence', tile: first, open: false });
    enumerateClosedGroups(counts, groups, needed, output);
    groups.pop(); counts[first] += 1; counts[first + 1] += 1; counts[first + 2] += 1;
  }
}

export function completeDecompositions(counts, openMelds = []) {
  const results = [];
  for (let pair = 0; pair < 34; pair += 1) {
    if (counts[pair] < 2) continue;
    const rest = [...counts];
    rest[pair] -= 2;
    const path = [];
    const groupings = [];
    enumerateClosedGroups(rest, path, 4 - openMelds.length, groupings);
    for (const closedGroups of groupings) {
      results.push({ pair, groups: [...openMelds, ...closedGroups] });
    }
  }
  return results;
}

function isChiitoi(counts) {
  return counts.reduce((sum, n) => sum + n, 0) === 14 && counts.filter((n) => n === 2).length === 7;
}

function isKokushi(counts) {
  return [...YAOCHU].every((i) => counts[i] >= 1) && [...YAOCHU].some((i) => counts[i] >= 2);
}

function groupTiles(group) {
  return group.type === 'sequence' ? [group.tile, group.tile + 1, group.tile + 2] : [group.tile, group.tile, group.tile];
}

export function detectYaku(counts, openMelds = [], context = {}) {
  const allCounts = [...counts];
  for (const meld of openMelds) for (const tile of groupTiles(meld)) allCounts[tile] += 1;
  const allTiles = countsToTiles(allCounts);
  const closed = openMelds.length === 0;
  const yaku = new Set();
  if (isKokushi(allCounts) && closed) yaku.add('国士无双');
  if (isChiitoi(allCounts) && closed) yaku.add('七对子');
  if (allTiles.every((i) => !YAOCHU.has(i))) yaku.add('断幺九');
  const suits = new Set(allTiles.filter((i) => i < 27).map((i) => Math.floor(i / 9)));
  const hasHonor = allTiles.some((i) => i >= 27);
  if (suits.size === 1) yaku.add(hasHonor ? '混一色' : '清一色');
  if (allTiles.every((i) => YAOCHU.has(i))) yaku.add('混老头');
  if (closed && context.riichi) yaku.add('立直');
  if (context.tsumo && closed) yaku.add('门前清自摸和');

  const decomps = completeDecompositions(counts, openMelds);
  for (const { pair, groups } of decomps) {
    const triplets = groups.filter((g) => g.type === 'triplet');
    const sequences = groups.filter((g) => g.type === 'sequence');
    if (triplets.length === 4) yaku.add('对对和');
    const valueTiles = new Set([31, 32, 33, context.seatWind ?? -1, context.roundWind ?? -1]);
    for (const group of triplets) {
      if (group.tile === 31) yaku.add('役牌：白');
      if (group.tile === 32) yaku.add('役牌：发');
      if (group.tile === 33) yaku.add('役牌：中');
      if (group.tile === context.seatWind) yaku.add('役牌：自风');
      if (group.tile === context.roundWind) yaku.add('役牌：场风');
    }
    if (closed && sequences.length === 4 && !valueTiles.has(pair)) yaku.add('平和（需两面听）');
    if (closed) {
      const seqKeys = sequences.map((g) => g.tile);
      if (seqKeys.some((tile, i) => seqKeys.indexOf(tile) !== i)) yaku.add('一杯口');
    }
    for (let rank = 0; rank <= 6; rank += 1) {
      if ([0, 9, 18].every((base) => sequences.some((g) => g.tile === base + rank))) yaku.add('三色同顺');
    }
    for (const base of [0, 9, 18]) {
      if ([base, base + 3, base + 6].every((tile) => sequences.some((g) => g.tile === tile))) yaku.add('一气通贯');
    }
    const everyGroupHasYaochu = groups.every((g) => groupTiles(g).some((i) => YAOCHU.has(i))) && YAOCHU.has(pair);
    if (everyGroupHasYaochu) yaku.add(hasHonor ? '混全带幺九' : '纯全带幺九');
  }
  return [...yaku];
}

export function doraTile(indicator) {
  if (indicator < 0 || indicator > 33) return -1;
  if (indicator < 27) return Math.floor(indicator / 9) * 9 + ((indicator % 9 + 1) % 9);
  if (indicator <= 30) return 27 + ((indicator - 27 + 1) % 4);
  return 31 + ((indicator - 31 + 1) % 3);
}

function dangerForOpponent(tile, discards, visible) {
  if (discards.includes(tile)) return { score: 0, label: '现物' };
  if (tile >= 27) {
    const seen = visible[tile] || 0;
    if (seen >= 3) return { score: 3, label: '字牌仅余一张' };
    if (seen === 2) return { score: 15, label: '字牌已见两张' };
    return { score: 48, label: '生张字牌' };
  }
  const rank = tile % 9;
  const base = tile - rank;
  const suji = [rank - 3, rank + 3].some((r) => r >= 0 && r < 9 && discards.includes(base + r));
  const terminalFactor = rank === 0 || rank === 8 ? -12 : (rank === 1 || rank === 7 ? -5 : 0);
  return { score: Math.max(8, 48 + terminalFactor - (suji ? 22 : 0)), label: suji ? '筋' : '无明显安全信息' };
}

export function analyzeHand({ concealed, openMelds = [], discards = [], riichi = [], doraIndicators = [], strategy = 'balanced', context = {} }) {
  const fixedMelds = openMelds.length;
  const openCounts = Array(34).fill(0);
  for (const meld of openMelds) for (const tile of groupTiles(meld)) openCounts[tile] += 1;
  const visible = concealed.map((n, i) => n + openCounts[i] + discards.reduce((sum, river) => sum + river.filter((t) => t === i).length, 0));
  const shanten = calculateShanten(concealed, fixedMelds);
  const tileTotal = concealed.reduce((a, b) => a + b, 0);
  const drawState = tileTotal === 14 - fixedMelds * 3;
  const effective = effectiveTiles(concealed, fixedMelds, visible);
  const dora = doraIndicators.map(doraTile).filter((i) => i >= 0);
  const suggestions = [];

  if (drawState) {
    for (let discard = 0; discard < 34; discard += 1) {
      if (!concealed[discard]) continue;
      concealed[discard] -= 1;
      const nextShanten = calculateShanten(concealed, fixedMelds);
      const waits = effectiveTiles(concealed, fixedMelds, visible);
      concealed[discard] += 1;
      const ukeire = waits.reduce((sum, item) => sum + item.remaining, 0);
      const threats = discards.map((river, i) => riichi[i] ? dangerForOpponent(discard, river, visible) : null).filter(Boolean);
      const danger = threats.length ? Math.max(...threats.map((item) => item.score)) : 0;
      const safety = threats.length ? threats.map((item) => item.label).join(' / ') : '无人立直';
      const doraLoss = dora.filter((tile) => tile === discard).length;
      const redFiveLoss = 0;
      const weights = strategy === 'defense' ? { danger: 2.4, ukeire: 1.2 } : strategy === 'attack' ? { danger: 0.45, ukeire: 2.2 } : { danger: 1.1, ukeire: 1.7 };
      const score = -nextShanten * 1000 + ukeire * weights.ukeire - danger * weights.danger - doraLoss * 26 - redFiveLoss;
      suggestions.push({ discard, nextShanten, waits, ukeire, danger, safety, doraLoss, score });
    }
    suggestions.sort((a, b) => b.score - a.score || a.danger - b.danger || b.ukeire - a.ukeire);
  }

  const winning = shanten === 0 ? effective.map((item) => {
    concealed[item.tile] += 1;
    const yaku = detectYaku(concealed, openMelds, context);
    concealed[item.tile] -= 1;
    return { ...item, yaku };
  }) : [];

  return { shanten, effective, suggestions, winning, visible, drawState };
}

export function parseMeld(input) {
  const counts = parseTiles(input);
  const tiles = countsToTiles(counts);
  if (tiles.length !== 3) throw new Error('每组副露请填写 3 张牌');
  if (tiles[0] === tiles[1] && tiles[1] === tiles[2]) return { type: 'triplet', tile: tiles[0], open: true };
  if (tiles[0] < 27 && tiles[0] + 1 === tiles[1] && tiles[1] + 1 === tiles[2] && Math.floor(tiles[0] / 9) === Math.floor(tiles[2] / 9)) {
    return { type: 'sequence', tile: tiles[0], open: true };
  }
  throw new Error('副露必须是顺子或刻子，例如 123m / 777z');
}
