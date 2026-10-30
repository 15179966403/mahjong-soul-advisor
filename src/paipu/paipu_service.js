import { GameReplayer } from './game_replayer.js';
import { extractMajsoulUrlInfo, parseMajsoulExport } from './majsoul_parser.js';
import { parseMjai } from './mjai_parser.js';
import { parseTenhouJson } from './tenhou_parser.js';

export const RECOGNITION_API_BASE = 'http://127.0.0.1:8765';

/**
 * High-level unified Paipu Match structure.
 */
export class PaipuMatch {
  constructor(metadata, rounds) {
    this.metadata = metadata;
    this.rounds = rounds.map(r => ({
      ...r,
      replayer: new GameReplayer(r, metadata.players),
    }));
  }

  get roundCount() {
    return this.rounds.length;
  }

  getRound(index) {
    if (index < 0 || index >= this.rounds.length) return null;
    return this.rounds[index];
  }
}

/**
 * Built-in authentic demonstration match with real decisions, red 5s, riichi, and advice comparison.
 */
export const DEMO_PAIPU_DATA = {
  title: ['雀魂·玉之间半庄战 (示例复盘)', '2026-10-30 14:00'],
  name: ['一姬 (自家)', '南彦 (下家)', '猫粮打工仔 (对家)', '天江衣 (上家)'],
  rule: { disp: '段位 雀魂四人南喰赤', aka: 1 },
  log: [
    // Round 1: 东 1 局 0本场
    [
      [0, 0, 0, 1, 2, 32], // seed: 东1局, 0本场, 0供托, dora: 32 (9m) -> Dora is 1m!
      [25000, 25000, 25000, 25000],
      [32], // dora 9m
      [12], // ura dora
      // Player 0 (East, Dealer): 123m 456p 789s 11z 5z 7z (13 tiles, waiting for 1st draw)
      [0, 1, 2, 48, 49, 50, 96, 97, 98, 108, 109, 124, 132],
      // Player 0 actions:
      // draw 0p (id 52), discard 7z (132); draw 9s (99), discard 5z (124) -> tenpai!; draw 1z (110) -> tsumo!
      [52, 132, 99, 124, 110],

      // Player 1 (South):
      [4, 5, 6, 40, 41, 42, 72, 73, 74, 112, 113, 120, 128],
      // Player 1 actions: draw 1m (3), discard 7z (128); draw 2m (7), discard 4z (120)
      [3, 128, 7, 120],

      // Player 2 (West):
      [8, 9, 10, 44, 45, 46, 76, 77, 78, 116, 117, 121, 129],
      // Player 2 actions: draw 3m (11), discard 7z (129); draw 4m (15), discard 4z (121)
      [11, 129, 15, 121],

      // Player 3 (North):
      [12, 13, 14, 56, 57, 58, 80, 81, 82, 118, 119, 122, 130],
      // Player 3 actions: draw 5m (16 = 0m red!), discard 7z (130); draw 6m (20), discard 4z (122)
      [16, 130, 20, 122],

      // Result: 和了 (Tsumo win for Player 0)
      ['和了', [6000, -2000, -2000, -2000], [0, 0, 0, '门前清自摸和(1番)', '役牌：自风(1番)', '赤宝牌(1番)']],
    ],

    // Round 2: 东 2 局 0本场 (South dealer with Riichi scenario)
    [
      [1, 0, 0, 3, 4, 17], // seed: 东2局, 0本场, 0供托, dora: 17 (5m)
      [31000, 23000, 23000, 23000],
      [17], // dora 5m
      [21],
      // Player 0 (South seat now): 234m 567p 123s 456s 2z
      [4, 5, 6, 53, 54, 55, 72, 73, 74, 84, 85, 86, 112],
      // Player 0 actions:
      // draws 8s (92), discards 2z (112); draws 9p (68), discards 9p (68); draws 3m (7), discards 3m (7)
      [92, 112, 68, 68, 7, 7],

      // Player 1 (Dealer):
      [0, 1, 2, 36, 37, 38, 96, 97, 98, 108, 108, 116, 117],
      // Player 1 actions: draw 1m (3), discard 3z (116); draw 2m (7), riichi with 3z (117)!
      [3, 116, 'r', 117, 99, 99],

      // Player 2:
      [8, 9, 10, 44, 45, 46, 76, 77, 78, 120, 121, 124, 125],
      [12, 120, 13, 121, 14, 124],

      // Player 3:
      [16, 17, 18, 60, 61, 62, 80, 81, 82, 128, 129, 132, 133],
      [24, 128, 25, 129, 26, 132],

      // Result: 流局 (Exhaustive draw)
      ['流局', [1000, 1500, -1500, -1000]],
    ],
  ],
};

/**
 * Sniff format and parse game input into a PaipuMatch.
 */
export function parsePaipuInput(input) {
  if (!input) throw new Error('请输入或上传牌谱数据');

  // Check if string is a Majsoul replay URL
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.includes('paipu=')) {
      const urlInfo = extractMajsoulUrlInfo(trimmed);
      if (urlInfo) {
        throw new Error(
          `检测到雀魂牌谱链接 (UUID: ${urlInfo.uuid})。\n请点击“在线获取”或使用下方上传功能导入导出的牌谱 JSON 文件。`
        );
      }
    }

    // Try parsing as JSON
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const json = JSON.parse(trimmed);
        return parsePaipuJson(json);
      } catch (err) {
        // Maybe MJAI lines
        return parseMjaiLines(trimmed);
      }
    }

    // Attempt MJAI JSON Lines
    return parseMjaiLines(trimmed);
  }

  // Already parsed object
  return parsePaipuJson(input);
}

function parseMjaiLines(text) {
  const { metadata, rounds } = parseMjai(text);
  return new PaipuMatch(metadata, rounds);
}

export function parsePaipuJson(jsonObj) {
  // Format 1: Tenhou JSON
  if (jsonObj.log && Array.isArray(jsonObj.log)) {
    const { metadata, rounds } = parseTenhouJson(jsonObj);
    return new PaipuMatch(metadata, rounds);
  }

  // Format 2: MJAI array or stream
  if (Array.isArray(jsonObj) || jsonObj.events || jsonObj.records) {
    const { metadata, rounds } = parseMjai(jsonObj);
    return new PaipuMatch(metadata, rounds);
  }

  // Format 3: General Majsoul export
  const { metadata, rounds } = parseMajsoulExport(jsonObj);
  return new PaipuMatch(metadata, rounds);
}

/**
 * Attempt to fetch game record online via backend proxy or public endpoint.
 */
export async function fetchPaipuOnline(urlOrUuid) {
  const urlInfo = extractMajsoulUrlInfo(urlOrUuid);
  const uuid = urlInfo ? urlInfo.uuid : urlOrUuid.trim();

  // Call local backend proxy
  try {
    const resp = await fetch(`${RECOGNITION_API_BASE}/api/paipu/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid, rawUrl: urlOrUuid }),
    });

    if (resp.ok) {
      const data = await resp.json();
      return parsePaipuJson(data);
    }

    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `服务器返回错误 (${resp.status})`);
  } catch (err) {
    // If backend proxy failed or unavailable, try direct public Amae-koromo endpoint
    try {
      const directResp = await fetch(`https://api.amae-koromo.com/api/v2/pl4/games/${uuid}`, {
        mode: 'cors',
      });
      if (directResp.ok) {
        const directData = await directResp.json();
        return parsePaipuJson(directData);
      }
    } catch {
      // Direct CORS or network failed
    }

    throw new Error(
      `未能在线拉取牌谱 (UUID: ${uuid})。\n原因：${err.message || '公开数据库中未找到或网络受限'}。\n\n建议方法：请在雀魂网页端使用插件（如“雀魂牌谱分析器”或“Tampermonkey 牌谱导出脚本”）将牌谱导出为 .json 文件后在此处上传。`
    );
  }
}
