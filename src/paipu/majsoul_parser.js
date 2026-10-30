import { parseMjai } from './mjai_parser.js';
import { parseTenhouJson } from './tenhou_parser.js';

/**
 * Extract UUID and viewer ID from Majsoul replay URL or string.
 */
export function extractMajsoulUrlInfo(input) {
  if (typeof input !== 'string') return null;
  const str = input.trim();

  // Pattern: https://.../?paipu=210815-6da08e40-2605-42fb-a5e3-f8aa5940362a_a111703554
  const paipuMatch = str.match(/paipu=([0-9a-fA-F-]+)(?:_a(\d+))?/i)
    || str.match(/([0-9]{6}-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:_a(\d+))?/i);

  if (paipuMatch) {
    return {
      uuid: paipuMatch[1],
      viewerId: paipuMatch[2] || null,
      rawUrl: str,
    };
  }

  // Pure UUID
  if (/^[0-9a-fA-F-]+$/.test(str) && str.length >= 32) {
    return {
      uuid: str,
      viewerId: null,
      rawUrl: str,
    };
  }

  return null;
}

/**
 * Normalizes Majsoul exported JSON payload into unified game structure.
 */
export function parseMajsoulExport(payload) {
  if (!payload) throw new Error('雀魂牌谱数据为空');

  let data = payload;
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch (err) {
      // Maybe MJAI lines
      return parseMjai(payload);
    }
  }

  // 1. If it's standard Tenhou JSON with "log" array
  if (data.log && Array.isArray(data.log)) {
    return parseTenhouJson(data);
  }

  // 2. If it's MJAI event array or stream
  if (Array.isArray(data) && data[0] && (data[0].type === 'start_game' || data[0].type === 'start_kyoku')) {
    return parseMjai(data);
  }

  // 3. If it has nested mjai structure
  if (data.mjai || data.events) {
    return parseMjai(data.mjai || data.events);
  }

  // 4. If it's Amae-koromo game record structure
  if (data.data && Array.isArray(data.data.rounds)) {
    // Amae-koromo format
    const rounds = data.data.rounds.map((rd, i) => ({
      roundIndex: i,
      roundName: rd.name || `第 ${i + 1} 局`,
      honba: rd.honba || 0,
      riichiSticks: rd.riichi || 0,
      oya: rd.oya || 0,
      events: rd.events || [],
    }));
    return {
      metadata: {
        title: data.data.title || '雀魂对局',
        players: (data.data.accounts || []).map(a => a.nickname || '玩家'),
        rule: data.data.config || {},
      },
      rounds,
    };
  }

  throw new Error('未识别的雀魂牌谱 JSON 格式。支持天凤格式、MJAI 格式或雀魂插件导出的标准 JSON。');
}
