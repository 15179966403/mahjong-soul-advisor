import {
  TILE_CODES, TILE_NAMES, analyzeHand, countsToNotation, countsToTiles,
  parseMeld, parseTiles, tileIndex,
} from './mahjong.js';

const state = { hand: Array(34).fill(0), strategy: 'balanced' };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function tileFace(index, removable = false) {
  const code = TILE_CODES[index];
  return `<button class="tile${removable ? ' removable' : ''}" data-tile="${index}" title="${TILE_NAMES[index]}" aria-label="${removable ? '移除' : '添加'}${TILE_NAMES[index]}">
    <img src="./public/assets/tiles/${code}.png" alt="" draggable="false" />${removable ? '<i aria-hidden="true">×</i>' : ''}
  </button>`;
}

function renderPicker() {
  const groups = [
    { label: '万子', range: [0, 9] }, { label: '筒子', range: [9, 18] },
    { label: '索子', range: [18, 27] }, { label: '字牌', range: [27, 34] },
  ];
  $('#tile-picker').innerHTML = groups.map(({ label, range }) => `<div class="tile-row"><span>${label}</span><div>${Array.from({ length: range[1] - range[0] }, (_, i) => tileFace(range[0] + i)).join('')}</div></div>`).join('');
  $$('#tile-picker .tile').forEach((button) => button.addEventListener('click', () => addTile(Number(button.dataset.tile))));
}

function renderHand() {
  const tiles = countsToTiles(state.hand);
  $('#hand-count').textContent = `${tiles.length} 张`;
  $('#selected-hand').classList.toggle('empty', !tiles.length);
  $('#selected-hand').innerHTML = tiles.length ? tiles.map((tile) => tileFace(tile, true)).join('') : '<p>点击下方牌面添加手牌</p>';
  $('#hand-notation').value = countsToNotation(state.hand);
  $$('#selected-hand .tile').forEach((button) => button.addEventListener('click', () => removeTile(Number(button.dataset.tile))));
}

function addTile(index) {
  const currentTotal = state.hand.reduce((a, b) => a + b, 0);
  if (state.hand[index] >= 4 || currentTotal >= 14) return;
  state.hand[index] += 1;
  renderHand();
}

function removeTile(index) {
  if (state.hand[index]) state.hand[index] -= 1;
  renderHand();
}

function parseLooseTiles(input) {
  if (!input.trim()) return [];
  const compact = input.trim().split(/\s+/).map((token) => {
    if (/^[0-9]+[mpsz]$/.test(token)) return token;
    return token;
  }).join('');
  return countsToTiles(parseTiles(compact));
}

function getInput() {
  const meldTokens = $('#melds').value.trim() ? $('#melds').value.trim().split(/\s+/) : [];
  const openMelds = meldTokens.map(parseMeld);
  const expected = [13 - openMelds.length * 3, 14 - openMelds.length * 3];
  const total = state.hand.reduce((a, b) => a + b, 0);
  if (!expected.includes(total)) throw new Error(`有 ${openMelds.length} 组副露时，请录入 ${expected[0]} 张（等待摸牌）或 ${expected[1]} 张（轮到切牌）；当前为 ${total} 张`);
  const doraIndicators = parseLooseTiles($('#dora').value);
  const discards = $$('[data-river]').map((input) => parseLooseTiles(input.value));
  const riichi = $$('[data-riichi]').map((input) => input.checked);
  return {
    concealed: [...state.hand], openMelds, doraIndicators, discards, riichi,
    strategy: state.strategy,
    context: {
      roundWind: tileIndex($('#round-wind').value),
      seatWind: tileIndex($('#seat-wind').value),
    },
  };
}

function shantenLabel(value) {
  if (value < 0) return '已和牌';
  if (value === 0) return '听牌';
  return `${value} 向听`;
}

function tileStrip(items, withCount = true) {
  if (!items.length) return '<span class="muted">暂无</span>';
  return `<div class="compact-tiles">${items.map((item) => `<div>${tileFace(item.tile)}${withCount ? `<span>${item.remaining} 枚</span>` : ''}</div>`).join('')}</div>`;
}

function suggestionReason(item, index) {
  const parts = [`切后${shantenLabel(item.nextShanten)}`, `${item.ukeire} 枚有效牌`];
  if (item.safety !== '无人立直') parts.push(item.safety);
  if (item.doraLoss) parts.push('会损失宝牌');
  if (index === 0) parts.push('综合得分最高');
  return parts.join(' · ');
}

function renderResults(result, input) {
  const totalEffective = result.effective.reduce((sum, item) => sum + item.remaining, 0);
  const threatCount = input.riichi.filter(Boolean).length;
  const winContent = result.winning.length
    ? `<div class="result-card wide"><div class="card-label">和牌张与可成立役种</div>${result.winning.map((item) => `<div class="winning-row"><div>${tileFace(item.tile)}<b>剩余约 ${item.remaining} 枚</b></div><p>${item.yaku.length ? item.yaku.map((y) => `<span class="yaku">${y}</span>`).join('') : '<span class="warning-tag">当前未识别到确定役，和牌前请确认役种</span>'}</p></div>`).join('')}</div>`
    : `<div class="result-card wide"><div class="card-label">有效牌</div>${tileStrip(result.effective)}<p class="card-note">摸到以上牌会降低向听数；枚数已扣除手牌、副露和已录入牌河中的可见牌。</p></div>`;

  const suggestions = result.drawState
    ? `<div class="suggestions"><div class="section-head"><div><span>DISCARD RANKING</span><h2>切牌建议</h2></div><p>综合牌效、宝牌与${threatCount ? '放铳风险' : '当前攻守策略'}排序</p></div>${result.suggestions.slice(0, 6).map((item, index) => `<article class="suggestion ${index === 0 ? 'best' : ''}"><div class="rank">${String(index + 1).padStart(2, '0')}</div><div class="discard-face">${tileFace(item.discard)}</div><div class="suggest-main"><h3>切 ${TILE_NAMES[item.discard]} ${index === 0 ? '<span>推荐</span>' : ''}</h3><p>${suggestionReason(item, index)}</p><div>${tileStrip(item.waits.slice(0, 12))}</div></div><div class="stats"><div><b>${shantenLabel(item.nextShanten)}</b><span>切后进度</span></div><div><b>${item.ukeire}</b><span>有效枚数</span></div><div class="${item.danger > 35 ? 'danger' : ''}"><b>${threatCount ? Math.round(item.danger) : '—'}</b><span>危险指数</span></div></div></article>`).join('')}</div>`
    : `<div class="waiting-note"><b>当前是 ${13 - input.openMelds.length * 3} 张等待摸牌状态</b><span>上方展示有效牌；摸牌后再分析即可获得逐张切牌排序。</span></div>`;

  $('#results').innerHTML = `<div class="result-summary"><div><span>CURRENT SHANTEN</span><strong>${shantenLabel(result.shanten)}</strong></div><div><span>EFFECTIVE TILES</span><strong>${totalEffective}<small> 枚</small></strong></div><div><span>OPEN MELDS</span><strong>${input.openMelds.length}<small> 组</small></strong></div><div><span>RIICHI THREATS</span><strong>${threatCount}<small> 家</small></strong></div></div><div class="result-grid">${winContent}</div>${suggestions}`;
  $('#results').classList.remove('hidden');
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function analyze() {
  $('#error').textContent = '';
  try {
    const input = getInput();
    const result = analyzeHand(input);
    renderResults(result, input);
  } catch (error) {
    $('#error').textContent = error.message;
  }
}

$('#apply-notation').addEventListener('click', () => {
  try { state.hand = parseTiles($('#hand-notation').value); $('#error').textContent = ''; renderHand(); }
  catch (error) { $('#error').textContent = error.message; }
});

$('#load-demo').addEventListener('click', () => {
  state.hand = parseTiles('235677m345p23789s');
  $('#dora').value = '4m';
  $('#melds').value = '';
  $$('[data-river]').forEach((input, i) => { input.value = ['1m 9p 1z', '4m 6p 9s 2z', '2p 8s 5z'][i]; });
  $$('[data-riichi]').forEach((input, i) => { input.checked = i === 1; });
  renderHand();
  analyze();
});

$$('[data-strategy]').forEach((button) => button.addEventListener('click', () => {
  state.strategy = button.dataset.strategy;
  $$('[data-strategy]').forEach((item) => item.classList.toggle('active', item === button));
}));
$('#analyze').addEventListener('click', analyze);

renderPicker();
renderHand();
