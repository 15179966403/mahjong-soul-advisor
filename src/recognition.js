import { TILE_CODES, TILE_NAMES, tileIndex } from './mahjong.js';

export const RECOGNITION_API_BASE = 'http://127.0.0.1:8765';
export const LOW_CONFIDENCE_THRESHOLD = 0.65;
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const RIVER_POSITIONS = ['self', 'right', 'opposite', 'left'];

const RED_FIVES = ['0m', '0p', '0s'];
const VALID_CODES = new Set([...TILE_CODES, ...RED_FIVES]);
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXTENSION_MEDIA_TYPES = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

let nextTileId = 1;

export class RecognitionApiError extends Error {
  constructor(code, message, status = 0, requestId = '') {
    super(message);
    this.name = 'RecognitionApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export function canonicalTileCode(code) {
  if (/^0[mps]$/.test(code)) return `5${code[1]}`;
  return code;
}

export function tileAssetCode(code) {
  return canonicalTileCode(code);
}

export function tileNameForCode(code) {
  const index = tileIndex(code);
  if (index < 0) return code;
  return `${code.startsWith('0') ? '赤' : ''}${TILE_NAMES[index]}`;
}

export function recognitionTileOptions() {
  return [...TILE_CODES, ...RED_FIVES].map((code) => ({
    code,
    name: tileNameForCode(code),
  }));
}

function normalizeBbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  if (numbers[2] <= 0 || numbers[3] <= 0) return null;
  return numbers;
}

function normalizeTile(tile, zone) {
  if (!tile || !VALID_CODES.has(tile.code)) {
    throw new RecognitionApiError('INVALID_RESPONSE', '识别服务返回了无效的麻将牌');
  }
  const confidence = Number(tile.confidence);
  return {
    id: `recognized-${nextTileId++}`,
    zone,
    code: tile.code,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    bbox: normalizeBbox(tile.bbox),
    status: tile.status || null,
    recognition: tile.recognition || null,
    sideways: tile.sideways === true,
    edited: false,
    added: false,
  };
}

export function normalizeRecognitionResult(payload) {
  if (!payload || payload.schemaVersion !== 1 || !payload.image) {
    throw new RecognitionApiError('INVALID_RESPONSE', '识别服务返回的数据结构无效');
  }
  const width = Number(payload.image.width);
  const height = Number(payload.image.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RecognitionApiError('INVALID_RESPONSE', '识别服务返回了无效的图片尺寸');
  }
  if (!Array.isArray(payload.hand)) {
    throw new RecognitionApiError('INVALID_RESPONSE', '识别服务没有返回手牌数组');
  }

  const rivers = {};
  for (const position of RIVER_POSITIONS) {
    const tiles = payload.rivers && Array.isArray(payload.rivers[position])
      ? payload.rivers[position]
      : [];
    rivers[position] = tiles.map((tile) => normalizeTile(tile, `rivers.${position}`));
  }
  const riichi = Object.fromEntries(RIVER_POSITIONS.map((position) => (
    [position, payload.context?.riichi?.[position] === true]
  )));
  const doraIndicators = Array.isArray(payload.context?.doraIndicators)
    ? payload.context.doraIndicators.map(
      (tile) => normalizeTile(tile, 'context.doraIndicators'),
    )
    : [];
  const selfWind = ['1z', '2z', '3z', '4z'].includes(payload.context?.selfWind)
    ? payload.context.selfWind
    : null;
  const roundWind = ['1z', '2z'].includes(payload.context?.roundWind)
    ? payload.context.roundWind
    : null;
  const rawRoundWindConfidence = Number(payload.context?.roundWindConfidence);
  const roundWindConfidence = Number.isFinite(rawRoundWindConfidence)
    ? Math.max(0, Math.min(1, rawRoundWindConfidence))
    : 0;

  return {
    schemaVersion: 1,
    image: { width, height },
    table: payload.table || null,
    hand: payload.hand.map((tile) => normalizeTile(tile, 'hand')),
    rivers,
    context: {
      riichi,
      doraIndicators,
      selfWind,
      roundWind,
      roundWindConfidence,
    },
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
  };
}

export function getDraftZone(draft, zone) {
  if (zone === 'hand') return draft.hand;
  if (zone === 'context.doraIndicators') return draft.context.doraIndicators;
  const match = /^rivers\.(self|right|opposite|left)$/.exec(zone);
  if (!match) throw new Error(`未知识别区域：${zone}`);
  return draft.rivers[match[1]];
}

export function replaceDraftTile(draft, zone, id, code) {
  if (!VALID_CODES.has(code)) throw new Error(`无效牌：${code}`);
  const tile = getDraftZone(draft, zone).find((item) => item.id === id);
  if (!tile) return false;
  tile.code = code;
  tile.edited = true;
  return true;
}

export function removeDraftTile(draft, zone, id) {
  const tiles = getDraftZone(draft, zone);
  const index = tiles.findIndex((item) => item.id === id);
  if (index < 0) return false;
  tiles.splice(index, 1);
  return true;
}

export function addDraftTile(draft, zone, code) {
  if (!VALID_CODES.has(code)) throw new Error(`无效牌：${code}`);
  getDraftZone(draft, zone).push({
    id: `manual-${nextTileId++}`,
    zone,
    code,
    confidence: 1,
    bbox: null,
    status: null,
    recognition: null,
    sideways: false,
    edited: true,
    added: true,
  });
}

export function allDraftTiles(draft) {
  return [
    ...draft.hand,
    ...draft.context.doraIndicators,
    ...RIVER_POSITIONS.flatMap((position) => draft.rivers[position]),
  ];
}

export function draftDiagnostics(draft) {
  const allTiles = allDraftTiles(draft);
  const visibleCounts = new Map();
  for (const tile of allTiles) {
    const code = canonicalTileCode(tile.code);
    visibleCounts.set(code, (visibleCounts.get(code) || 0) + 1);
  }
  const impossibleCodes = [...visibleCounts.entries()]
    .filter(([, count]) => count > 4)
    .map(([code, count]) => ({ code, count }));
  return {
    handCount: draft.hand.length,
    totalCount: allTiles.length,
    lowConfidenceCount: allTiles.filter(
      (tile) => !tile.edited && tile.confidence < LOW_CONFIDENCE_THRESHOLD,
    ).length,
    editedCount: allTiles.filter((tile) => tile.edited).length,
    impossibleCodes,
  };
}

export function codesToCounts(codes) {
  return codesToTileState(codes).counts;
}

export function codesToTileState(codes) {
  const counts = Array(34).fill(0);
  const redFives = Array(34).fill(0);
  for (const code of codes) {
    const index = tileIndex(code);
    if (index < 0) throw new Error(`无效牌：${code}`);
    counts[index] += 1;
    if (counts[index] > 4) throw new Error(`${TILE_NAMES[index]}超过 4 张`);
    if (code.startsWith('0')) redFives[index] += 1;
  }
  return { counts, redFives };
}

export function inferMediaType(file) {
  if (MEDIA_TYPES.has(file.type)) return file.type;
  const name = String(file.name || '').toLowerCase();
  const extension = Object.keys(EXTENSION_MEDIA_TYPES).find((item) => name.endsWith(item));
  return extension ? EXTENSION_MEDIA_TYPES[extension] : '';
}

async function parseResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new RecognitionApiError(
      'INVALID_RESPONSE',
      '本地识别服务返回了无法解析的内容',
      response.status,
      response.headers.get('X-Request-ID') || '',
    );
  }
  if (!response.ok) {
    const error = payload && payload.error ? payload.error : {};
    throw new RecognitionApiError(
      error.code || 'API_REQUEST_FAILED',
      error.message || `识别请求失败（HTTP ${response.status}）`,
      response.status,
      error.requestId || response.headers.get('X-Request-ID') || '',
    );
  }
  return payload;
}

export class RecognitionApiClient {
  constructor(baseUrl = RECOGNITION_API_BASE) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async health(signal) {
    const response = await fetch(`${this.baseUrl}/api/health`, {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    return parseResponse(response);
  }

  async recognize(file, signal) {
    const mediaType = inferMediaType(file);
    if (!mediaType) {
      throw new RecognitionApiError(
        'UNSUPPORTED_MEDIA_TYPE',
        '请选择 PNG、JPEG 或 WebP 截图',
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new RecognitionApiError('IMAGE_FILE_TOO_LARGE', '截图不能超过 12 MB');
    }
    const response = await fetch(`${this.baseUrl}/api/recognize`, {
      method: 'POST',
      headers: { 'Content-Type': mediaType },
      body: file,
      cache: 'no-store',
      signal,
    });
    return normalizeRecognitionResult(await parseResponse(response));
  }
}
