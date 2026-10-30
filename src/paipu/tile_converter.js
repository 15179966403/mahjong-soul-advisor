import { TILE_CODES, TILE_NAMES, tileIndex } from '../mahjong.js';

/**
 * Convert Tenhou tile ID (0..135) to standard tile code ('1m'..'9m', '1p'..'9p', '1s'..'9s', '1z'..'7z', '0m', '0p', '0s').
 * In standard Tenhou:
 *   Tile 16 = 0m (red 5m)
 *   Tile 52 = 0p (red 5p)
 *   Tile 88 = 0s (red 5s)
 * Other 133 tiles are regular tiles.
 */
export function tenhouIdToTileCode(id) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId < 0 || numId > 135) {
    throw new Error(`无效的天凤牌 ID: ${id}`);
  }

  // Red five checks
  if (numId === 16) return '0m';
  if (numId === 52) return '0p';
  if (numId === 88) return '0s';

  const typeIndex = Math.floor(numId / 4);
  if (typeIndex < 9) return `${typeIndex + 1}m`;
  if (typeIndex < 18) return `${typeIndex - 9 + 1}p`;
  if (typeIndex < 27) return `${typeIndex - 18 + 1}s`;
  return `${typeIndex - 27 + 1}z`;
}

/**
 * Convert standard tile code or MJAI string to standard tile code ('0m', '1m', etc.)
 */
export function normalizeTileCode(tile) {
  if (typeof tile === 'number') {
    return tenhouIdToTileCode(tile);
  }
  if (!tile || typeof tile !== 'string') {
    throw new Error(`无效的牌数据: ${tile}`);
  }

  const trimmed = tile.trim();

  // MJAI red fives: '5mr', '5pr', '5sr' or '0m', '0p', '0s'
  if (/^5m[rR]$/.test(trimmed) || trimmed === '0m') return '0m';
  if (/^5p[rR]$/.test(trimmed) || trimmed === '0p') return '0p';
  if (/^5s[rR]$/.test(trimmed) || trimmed === '0s') return '0s';

  // Standard tile codes like '1m', '9p', '3s', '7z'
  if (/^[1-9][mps]$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^[1-7]z$/i.test(trimmed)) return trimmed.toLowerCase();

  // MJAI honor letters: 'E', 'S', 'W', 'N', 'P'/'W', 'F'/'G', 'C'/'R'
  const honors = {
    E: '1z',
    S: '2z',
    W: '3z',
    N: '4z',
    P: '5z',
    H: '5z', // Haku
    F: '6z',
    G: '6z', // Hatsu / Green
    C: '7z',
    R: '7z', // Chun / Red
  };
  const upper = trimmed.toUpperCase();
  if (honors[upper]) return honors[upper];

  // Tenhou string number
  if (/^\d+$/.test(trimmed)) {
    return tenhouIdToTileCode(Number(trimmed));
  }

  throw new Error(`无法识别的牌表示: ${tile}`);
}

/**
 * Returns canonical 34-tile code (maps '0m' -> '5m', '0p' -> '5p', '0s' -> '5s')
 */
export function canonicalCode(tile) {
  const norm = normalizeTileCode(tile);
  if (norm === '0m') return '5m';
  if (norm === '0p') return '5p';
  if (norm === '0s') return '5s';
  return norm;
}

/**
 * Returns whether the tile is a red five ('0m', '0p', '0s').
 */
export function isRedFive(tile) {
  const norm = normalizeTileCode(tile);
  return norm === '0m' || norm === '0p' || norm === '0s';
}

/**
 * Decode Tenhou numeric meld code (16-bit integer).
 */
export function decodeTenhouMeld(meldInt) {
  const m = Number(meldInt);
  if (!Number.isInteger(m) || m <= 0) return null;

  // 1. Chi (顺子)
  if (m & 0x0004) {
    const fromWhoRel = m & 0x0003;
    const tileBase = (m >> 10) & 0x003f;
    const pattern = (tileBase % 3);
    const firstTileIndex = Math.floor(tileBase / 3);
    const suit = Math.floor(firstTileIndex / 7);
    const rank = (firstTileIndex % 7) + 1;
    const suitLetter = ['m', 'p', 's'][suit] || 'm';

    const tiles = [
      `${rank}${suitLetter}`,
      `${rank + 1}${suitLetter}`,
      `${rank + 2}${suitLetter}`,
    ];
    // Check if any tile is red 5
    // In tenhou chi encoding, bits indicate red
    const calledTile = tiles[pattern];
    const consumed = tiles.filter((_, idx) => idx !== pattern);

    return {
      type: 'sequence',
      calledTile,
      consumed,
      tiles,
      fromRelation: fromWhoRel, // 1:下家, 2:对家, 3:上家
      open: true,
    };
  }

  // 2. Pon (刻子)
  if (m & 0x0018) {
    const fromWhoRel = m & 0x0003;
    const unused = (m >> 5) & 0x0003;
    const tileBase = (m >> 9) & 0x007f;
    const tileType = Math.floor(tileBase / 3);
    const code = TILE_CODES[tileType];

    const tiles = [code, code, code];
    const consumed = [code, code];

    return {
      type: 'triplet',
      calledTile: code,
      consumed,
      tiles,
      fromRelation: fromWhoRel,
      open: true,
    };
  }

  // 3. Kakan (加杠)
  if (m & 0x0020) {
    const fromWhoRel = m & 0x0003;
    const addedTile = (m >> 9) & 0x007f;
    const tileType = Math.floor(addedTile / 3);
    const code = TILE_CODES[tileType];
    return {
      type: 'kakan',
      calledTile: code,
      consumed: [code, code, code],
      tiles: [code, code, code, code],
      fromRelation: fromWhoRel,
      open: true,
    };
  }

  // 4. Kan (大明杠 / 暗杠)
  const fromWhoRel = m & 0x0003;
  const tileBase = (m >> 8) & 0x00ff;
  const tileType = Math.floor(tileBase / 4);
  const code = TILE_CODES[tileType];
  const isAnkan = fromWhoRel === 0;

  return {
    type: isAnkan ? 'ankan' : 'daiminkan',
    calledTile: code,
    consumed: isAnkan ? [code, code, code, code] : [code, code, code],
    tiles: [code, code, code, code],
    fromRelation: fromWhoRel,
    open: !isAnkan,
  };
}
