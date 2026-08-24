import {
  TILE_CODES, TILE_NAMES, analyzeHand, countsToTiles, parseMeld,
  parseTileState, parseTiles, tileIndex, tileStateToNotation,
} from './mahjong.js';
import {
  LOW_CONFIDENCE_THRESHOLD, RecognitionApiClient, RecognitionApiError,
  addDraftTile, allDraftTiles, codesToTileState, draftDiagnostics,
  recognitionTileOptions, removeDraftTile, replaceDraftTile, tileAssetCode,
  tileNameForCode,
} from './recognition.js';

const state = {
  hand: Array(34).fill(0),
  redFives: Array(34).fill(0),
  strategy: 'balanced',
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const RIVER_POSITIONS = ['self', 'right', 'opposite', 'left'];
const OPPONENT_POSITIONS = ['right', 'opposite', 'left'];
const RECOGNITION_BROWSER_TIMEOUT_MS = 50_000;
const recognitionClient = new RecognitionApiClient();
let recognitionHealthRetryTimer = 0;
const recognitionState = {
  draft: null,
  file: null,
  previewUrl: '',
  controller: null,
};
const recognitionZoneLabels = {
  hand: '自家手牌',
  'rivers.self': '自家牌河',
  'rivers.right': '下家牌河',
  'rivers.opposite': '对家牌河',
  'rivers.left': '上家牌河',
};
const recognitionOptions = recognitionTileOptions();

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function setRecognitionNotice(message = '', kind = '') {
  const element = $('#recognition-error');
  element.textContent = message;
  element.classList.toggle('success', kind === 'success');
}

function setRecognitionProgress(visible, title = '', copy = '') {
  $('#recognition-progress').classList.toggle('hidden', !visible);
  if (title) $('#recognition-progress-title').textContent = title;
  if (copy) $('#recognition-progress-copy').textContent = copy;
}

function setHealthState(kind, label) {
  const button = $('#recognition-health');
  button.className = `service-status ${kind}`;
  button.querySelector('span').textContent = label;
}

async function checkRecognitionHealth({ retry = true } = {}) {
  window.clearTimeout(recognitionHealthRetryTimer);
  recognitionHealthRetryTimer = 0;
  if (window.location.protocol === 'file:') {
    setHealthState('offline', '请通过 npm run dev 打开页面');
    return;
  }
  setHealthState('checking', '正在检查本地服务');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4000);
  try {
    const result = await recognitionClient.health(controller.signal);
    const device = result.model && result.model.device ? ` · ${result.model.device}` : '';
    setHealthState('online', `本地服务已连接${device}`);
  } catch {
    if (retry) {
      setHealthState('checking', '识别服务正在启动 · 自动重试');
      recognitionHealthRetryTimer = window.setTimeout(
        () => checkRecognitionHealth({ retry: false }),
        1500,
      );
    } else {
      setHealthState('offline', '本地服务未连接 · 点击重试');
    }
  } finally {
    window.clearTimeout(timer);
  }
}

function releaseRecognitionPreview() {
  if (recognitionState.previewUrl) URL.revokeObjectURL(recognitionState.previewUrl);
  recognitionState.previewUrl = '';
}

function clearRecognitionResult({ keepNotice = false } = {}) {
  if (recognitionState.controller) recognitionState.controller.abort();
  recognitionState.controller = null;
  recognitionState.draft = null;
  recognitionState.file = null;
  releaseRecognitionPreview();
  $('#recognition-review').classList.add('hidden');
  $('#recognition-review').setAttribute('aria-hidden', 'true');
  $('#screenshot-file').value = '';
  setRecognitionProgress(false);
  if (!keepNotice) setRecognitionNotice();
}

function recognitionErrorMessage(error) {
  if (error instanceof RecognitionApiError) {
    return `${error.message}${error.requestId ? `（请求 ${error.requestId}）` : ''}`;
  }
  if (error instanceof TypeError) return '无法连接本地识别服务，请先运行 python -m backend.serve';
  return error && error.message ? error.message : '截图识别失败，请稍后重试';
}

function tileOptionMarkup(selectedCode) {
  return recognitionOptions.map(({ code, name }) => (
    `<option value="${code}"${code === selectedCode ? ' selected' : ''}>${name}</option>`
  )).join('');
}

function recognitionTileMarkup(tile, zone) {
  const lowConfidence = !tile.edited && tile.confidence < LOW_CONFIDENCE_THRESHOLD;
  const badge = tile.edited
    ? '<span class="recognition-tile-badge edited">已校对</span>'
    : `<span class="recognition-tile-badge${lowConfidence ? ' low' : ''}">${Math.round(tile.confidence * 100)}%</span>`;
  return `<article class="recognition-tile${lowConfidence ? ' low-confidence' : ''}${tile.edited ? ' manually-edited' : ''}" data-id="${tile.id}" data-zone="${zone}">
    <div class="recognition-tile-face">
      <img src="./public/assets/tiles/${tileAssetCode(tile.code)}.png" alt="${tileNameForCode(tile.code)}" draggable="false" />
      ${tile.code.startsWith('0') ? '<b class="red-five-badge">赤</b>' : ''}${badge}
    </div>
    <select data-recognition-action="replace" aria-label="修改识别牌">${tileOptionMarkup(tile.code)}</select>
    <button type="button" data-recognition-action="remove" aria-label="删除这张牌">删除</button>
  </article>`;
}

function recognitionZoneMarkup(zone, tiles) {
  return `<section class="recognition-zone" data-zone="${zone}">
    <header><h4>${recognitionZoneLabels[zone]}</h4><span>${tiles.length} 张</span></header>
    <div class="recognition-tile-list">${tiles.length
      ? tiles.map((tile) => recognitionTileMarkup(tile, zone)).join('')
      : '<p class="empty-zone">未识别到牌</p>'}</div>
    <div class="recognition-add-row">
      <select data-add-code aria-label="选择要补充的麻将牌">${tileOptionMarkup('1m')}</select>
      <button type="button" class="secondary-button" data-recognition-action="add">补充一张</button>
    </div>
  </section>`;
}

function overlayMarkup(tile, draft) {
  if (!tile.bbox) return '';
  const [x, y, width, height] = tile.bbox;
  const left = Math.max(0, Math.min(100, (x / draft.image.width) * 100));
  const top = Math.max(0, Math.min(100, (y / draft.image.height) * 100));
  const boxWidth = Math.max(0, Math.min(100 - left, (width / draft.image.width) * 100));
  const boxHeight = Math.max(0, Math.min(100 - top, (height / draft.image.height) * 100));
  const low = !tile.edited && tile.confidence < LOW_CONFIDENCE_THRESHOLD;
  return `<span class="recognition-box${low ? ' low' : ''}${tile.edited ? ' edited' : ''}" style="left:${left}%;top:${top}%;width:${boxWidth}%;height:${boxHeight}%" title="${tileNameForCode(tile.code)} ${Math.round(tile.confidence * 100)}%"><b>${tile.code}</b></span>`;
}

function renderRecognitionReview() {
  const draft = recognitionState.draft;
  if (!draft) return;
  const diagnostics = draftDiagnostics(draft);
  const allTiles = allDraftTiles(draft);
  $('#recognition-review').classList.remove('hidden');
  $('#recognition-review').setAttribute('aria-hidden', 'false');
  $('#recognition-preview').innerHTML = `<img src="${recognitionState.previewUrl}" alt="待校对的雀魂截图" />${allTiles.map((tile) => overlayMarkup(tile, draft)).join('')}`;
  $('#recognition-metrics').innerHTML = `<span><b>${diagnostics.handCount}</b> 手牌</span><span><b>${diagnostics.totalCount}</b> 可见牌</span><span class="${diagnostics.lowConfidenceCount ? 'attention' : ''}"><b>${diagnostics.lowConfidenceCount}</b> 低置信度</span>`;

  const localWarnings = [];
  if (![13, 14].includes(diagnostics.handCount)) {
    localWarnings.push(`识别到 ${diagnostics.handCount} 张手牌；如有副露，请先在下方填写副露后再导入。`);
  }
  if (diagnostics.impossibleCodes.length) {
    localWarnings.push(`可见数量超过四张：${diagnostics.impossibleCodes.map(({ code, count }) => `${tileNameForCode(code)} ${count}张`).join('、')}`);
  }
  const warnings = [...draft.warnings, ...localWarnings];
  $('#recognition-diagnostics').innerHTML = warnings.length
    ? `<div class="diagnostic-warning"><b>需要检查</b><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>`
    : '<div class="diagnostic-ok"><b>未发现明显异常</b><span>仍建议逐张核对后再导入。</span></div>';

  $('#recognition-zones').innerHTML = [
    recognitionZoneMarkup('hand', draft.hand),
    recognitionZoneMarkup('rivers.self', draft.rivers.self),
    recognitionZoneMarkup('rivers.right', draft.rivers.right),
    recognitionZoneMarkup('rivers.opposite', draft.rivers.opposite),
    recognitionZoneMarkup('rivers.left', draft.rivers.left),
  ].join('');
}

async function recognizeScreenshot(file) {
  if (!file) return;
  if (recognitionState.controller) recognitionState.controller.abort();
  const controller = new AbortController();
  recognitionState.controller = controller;
  recognitionState.file = file;
  releaseRecognitionPreview();
  recognitionState.previewUrl = URL.createObjectURL(file);
  recognitionState.draft = null;
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RECOGNITION_BROWSER_TIMEOUT_MS);
  $('#recognition-review').classList.add('hidden');
  setRecognitionNotice();
  setRecognitionProgress(true, '正在识别截图', '牌桌定位、切割与分类可能需要几秒');
  try {
    const draft = await recognitionClient.recognize(
      file,
      controller.signal,
    );
    if (recognitionState.controller !== controller) return;
    recognitionState.draft = draft;
    setHealthState('online', '本地服务已连接');
    renderRecognitionReview();
    const diagnostics = draftDiagnostics(recognitionState.draft);
    setRecognitionNotice(
      diagnostics.lowConfidenceCount
        ? `识别完成，有 ${diagnostics.lowConfidenceCount} 张低置信度牌需要检查。`
        : '识别完成，请核对后再导入。',
      diagnostics.lowConfidenceCount ? '' : 'success',
    );
    $('#recognition-review').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    if (timedOut) {
      setRecognitionNotice('截图识别超过 50 秒，请确认本地服务仍在运行后重试。');
      setHealthState('offline', '识别请求超时 · 点击检查服务');
    } else if (error.name !== 'AbortError') {
      setRecognitionNotice(recognitionErrorMessage(error));
      if (error instanceof TypeError) setHealthState('offline', '本地服务未连接 · 点击重试');
    }
  } finally {
    window.clearTimeout(timeout);
    if (recognitionState.controller === controller) {
      recognitionState.controller = null;
      setRecognitionProgress(false);
      $('#screenshot-file').value = '';
    }
  }
}

function expectedHandCounts() {
  const meldTokens = $('#melds').value.trim() ? $('#melds').value.trim().split(/\s+/) : [];
  meldTokens.forEach(parseMeld);
  return [13 - meldTokens.length * 3, 14 - meldTokens.length * 3];
}

function applyRecognitionDraft() {
  const draft = recognitionState.draft;
  if (!draft) return;
  setRecognitionNotice();
  try {
    const diagnostics = draftDiagnostics(draft);
    if (diagnostics.impossibleCodes.length) {
      throw new Error('存在可见数量超过四张的牌，请先完成校对');
    }
    const expected = expectedHandCounts();
    if (!expected.includes(draft.hand.length)) {
      throw new Error(`当前副露数量需要 ${expected[0]} 或 ${expected[1]} 张暗手，识别草稿为 ${draft.hand.length} 张`);
    }
    const hasExistingInput = state.hand.some(Boolean)
      || $$('[data-river]').some((input) => input.value.trim());
    if (hasExistingInput && !window.confirm('确认用识别草稿替换当前手牌和四家牌河吗？')) return;

    const handState = codesToTileState(draft.hand.map((tile) => tile.code));
    state.hand = handState.counts;
    state.redFives = handState.redFives;
    for (const position of RIVER_POSITIONS) {
      $(`[data-river="${position}"]`).value = draft.rivers[position]
        .map((tile) => tile.code)
        .join(' ');
    }
    renderHand();
    $('#results').classList.add('hidden');
    clearRecognitionResult({ keepNotice: true });
    setRecognitionNotice('识别结果已导入。请补充副露、宝牌和立直状态后开始分析。', 'success');
    $('.hand-stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    setRecognitionNotice(error.message);
  }
}

function tileFace(index, removable = false, red = false) {
  const code = TILE_CODES[index];
  const name = `${red ? '赤' : ''}${TILE_NAMES[index]}`;
  return `<button class="tile${removable ? ' removable' : ''}" data-tile="${index}" data-red="${red ? '1' : '0'}" title="${name}" aria-label="${removable ? '移除' : '添加'}${name}">
    <img src="./public/assets/tiles/${code}.png" alt="" draggable="false" />${red ? '<b class="red-five-badge">赤</b>' : ''}${removable ? '<i aria-hidden="true">×</i>' : ''}
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
  const tiles = state.hand.flatMap((count, index) => {
    const redCount = state.redFives[index] || 0;
    return [
      ...Array(redCount).fill({ index, red: true }),
      ...Array(count - redCount).fill({ index, red: false }),
    ];
  });
  $('#hand-count').textContent = `${tiles.length} 张`;
  $('#selected-hand').classList.toggle('empty', !tiles.length);
  $('#selected-hand').innerHTML = tiles.length
    ? tiles.map((tile) => tileFace(tile.index, true, tile.red)).join('')
    : '<p>点击下方牌面添加手牌</p>';
  $('#hand-notation').value = tileStateToNotation(state.hand, state.redFives);
  $$('#selected-hand .tile').forEach((button) => button.addEventListener('click', () => (
    removeTile(Number(button.dataset.tile), button.dataset.red === '1')
  )));
}

function addTile(index) {
  const currentTotal = state.hand.reduce((a, b) => a + b, 0);
  if (state.hand[index] >= 4 || currentTotal >= 14) return;
  state.hand[index] += 1;
  renderHand();
}

function removeTile(index, red = false) {
  if (state.hand[index]) {
    state.hand[index] -= 1;
    if (red && state.redFives[index]) state.redFives[index] -= 1;
  }
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
  const selfDiscards = parseLooseTiles($('[data-river="self"]').value);
  const discards = OPPONENT_POSITIONS.map((position) => (
    parseLooseTiles($(`[data-river="${position}"]`).value)
  ));
  const riichi = OPPONENT_POSITIONS.map((position) => (
    $(`[data-riichi="${position}"]`).checked
  ));
  return {
    concealed: [...state.hand], redFives: [...state.redFives], openMelds,
    doraIndicators, selfDiscards, discards, riichi,
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
  if (item.redFiveLoss) parts.push('会损失赤五');
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
    ? `<div class="suggestions"><div class="section-head"><div><span>DISCARD RANKING</span><h2>切牌建议</h2></div><p>综合牌效、宝牌与${threatCount ? '放铳风险' : '当前攻守策略'}排序</p></div>${result.suggestions.slice(0, 6).map((item, index) => `<article class="suggestion ${index === 0 ? 'best' : ''}"><div class="rank">${String(index + 1).padStart(2, '0')}</div><div class="discard-face">${tileFace(item.discard, false, item.redFiveLoss > 0)}</div><div class="suggest-main"><h3>切 ${item.redFiveLoss ? '赤' : ''}${TILE_NAMES[item.discard]} ${index === 0 ? '<span>推荐</span>' : ''}</h3><p>${suggestionReason(item, index)}</p><div>${tileStrip(item.waits.slice(0, 12))}</div></div><div class="stats"><div><b>${shantenLabel(item.nextShanten)}</b><span>切后进度</span></div><div><b>${item.ukeire}</b><span>有效枚数</span></div><div class="${item.danger > 35 ? 'danger' : ''}"><b>${threatCount ? Math.round(item.danger) : '—'}</b><span>危险指数</span></div></div></article>`).join('')}</div>`
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
  try {
    const parsed = parseTileState($('#hand-notation').value);
    state.hand = parsed.counts;
    state.redFives = parsed.redFives;
    $('#error').textContent = '';
    renderHand();
  }
  catch (error) { $('#error').textContent = error.message; }
});

$('#load-demo').addEventListener('click', () => {
  state.hand = parseTiles('235677m345p23789s');
  state.redFives = Array(34).fill(0);
  $('#dora').value = '4m';
  $('#melds').value = '';
  const demoRivers = {
    self: '3m 7p', right: '1m 9p 1z', opposite: '4m 6p 9s 2z', left: '2p 8s 5z',
  };
  RIVER_POSITIONS.forEach((position) => { $(`[data-river="${position}"]`).value = demoRivers[position]; });
  OPPONENT_POSITIONS.forEach((position, index) => { $(`[data-riichi="${position}"]`).checked = index === 1; });
  renderHand();
  analyze();
});

$$('[data-strategy]').forEach((button) => button.addEventListener('click', () => {
  state.strategy = button.dataset.strategy;
  $$('[data-strategy]').forEach((item) => item.classList.toggle('active', item === button));
}));
$('#analyze').addEventListener('click', analyze);

$('#recognition-health').addEventListener('click', () => checkRecognitionHealth());
$('#choose-screenshot').addEventListener('click', (event) => {
  event.stopPropagation();
  $('#screenshot-file').click();
});
$('#screenshot-file').addEventListener('change', (event) => {
  recognizeScreenshot(event.target.files[0]);
});

const dropzone = $('#screenshot-dropzone');
dropzone.addEventListener('click', (event) => {
  if (event.target.closest('button, input')) return;
  $('#screenshot-file').click();
});
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    $('#screenshot-file').click();
  }
});
for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
  });
}
dropzone.addEventListener('drop', (event) => {
  const file = [...event.dataTransfer.files].find((item) => item.type.startsWith('image/'));
  if (file) recognizeScreenshot(file);
  else setRecognitionNotice('拖入的内容不是支持的截图文件');
});

document.addEventListener('paste', (event) => {
  const item = [...(event.clipboardData ? event.clipboardData.items : [])]
    .find((entry) => entry.type.startsWith('image/'));
  if (!item) return;
  event.preventDefault();
  recognizeScreenshot(item.getAsFile());
});

$('#cancel-recognition').addEventListener('click', () => {
  if (recognitionState.controller) recognitionState.controller.abort();
  clearRecognitionResult({ keepNotice: true });
  setRecognitionNotice('已取消本次截图识别。');
});
$('#discard-recognition').addEventListener('click', () => clearRecognitionResult());
$('#apply-recognition').addEventListener('click', applyRecognitionDraft);

$('#recognition-zones').addEventListener('change', (event) => {
  const select = event.target.closest('[data-recognition-action="replace"]');
  if (!select || !recognitionState.draft) return;
  const tile = select.closest('[data-id]');
  replaceDraftTile(recognitionState.draft, tile.dataset.zone, tile.dataset.id, select.value);
  renderRecognitionReview();
});

$('#recognition-zones').addEventListener('click', (event) => {
  const button = event.target.closest('[data-recognition-action]');
  if (!button || !recognitionState.draft) return;
  const action = button.dataset.recognitionAction;
  const zoneElement = button.closest('[data-zone]');
  const zone = zoneElement.dataset.zone;
  if (action === 'remove') {
    const tile = button.closest('[data-id]');
    removeDraftTile(recognitionState.draft, zone, tile.dataset.id);
  } else if (action === 'add') {
    const select = zoneElement.querySelector('[data-add-code]');
    addDraftTile(recognitionState.draft, zone, select.value);
  }
  renderRecognitionReview();
});

window.addEventListener('beforeunload', releaseRecognitionPreview);

renderPicker();
renderHand();
checkRecognitionHealth();
