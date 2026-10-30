import { TILE_NAMES, tileIndex } from '../mahjong.js';
import { canonicalCode, isRedFive } from './tile_converter.js';
import { DEMO_PAIPU_DATA, fetchPaipuOnline, parsePaipuInput, parsePaipuJson } from './paipu_service.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const SEAT_WINDS = ['1z', '2z', '3z', '4z'];
const SEAT_NAMES = ['东家', '南家', '西家', '北家'];

function tileImg(code, extraClass = '') {
  const norm = canonicalCode(code);
  const isRed = isRedFive(code);
  return `
    <div class="paipu-hand-tile ${extraClass}">
      <img src="./public/assets/tiles/${norm}.png" alt="${code}" />
      ${isRed ? '<span class="red-five-badge">赤</span>' : ''}
    </div>
  `;
}

function miniTileImg(code, extraClass = '') {
  const norm = canonicalCode(code);
  const isRed = isRedFive(code);
  return `
    <div class="river-tile ${extraClass}">
      <img src="./public/assets/tiles/${norm}.png" alt="${code}" />
      ${isRed ? '<span class="red-five-badge">赤</span>' : ''}
    </div>
  `;
}

export class PaipuReplayerUI {
  constructor({ onForkToWorkbench, onSwitchMode }) {
    this.onForkToWorkbench = onForkToWorkbench;
    this.onSwitchMode = onSwitchMode;

    this.match = null;
    this.currentRoundIndex = 0;
    this.currentStepIndex = 0;
    this.perspectivePlayer = 0;
    this.isPlaying = false;
    this.playTimer = null;
    this.playSpeed = 1000;

    this._bindEvents();
  }

  loadMatch(match, defaultPerspective = 0) {
    this.match = match;
    this.currentRoundIndex = 0;
    this.currentStepIndex = 0;
    this.perspectivePlayer = defaultPerspective;
    this.pause();

    // Set title and info
    $('#paipu-match-title').textContent = this.match.metadata.title || '雀魂对局复盘';
    const ruleDisp = this.match.metadata.rule?.disp || '四人南喰赤';
    $('#paipu-match-info').textContent = `${ruleDisp} · 共 ${this.match.roundCount} 局`;

    // Populate round select
    const roundSelect = $('#paipu-round-select');
    roundSelect.innerHTML = this.match.rounds.map((r, i) => (
      `<option value="${i}">${r.roundName} (${r.honba}本场 · ${r.riichiSticks}立直棒)</option>`
    )).join('');
    roundSelect.value = '0';

    const ec = $('#paipu-error-container'); if (ec) ec.innerHTML = '';
    $('#paipu-player').classList.remove('hidden');

    this._renderPlayersHeader();
    this.renderStep();
  }

  renderStep() {
    if (!this.match) return;
    const round = this.match.getRound(this.currentRoundIndex);
    if (!round) return;

    const replayer = round.replayer;
    const step = replayer.getStep(this.currentStepIndex);
    if (!step) return;

    const state = step.state;

    // 1. Controls & Slider
    const slider = $('#paipu-step-slider');
    slider.max = String(Math.max(0, replayer.totalSteps - 1));
    slider.value = String(this.currentStepIndex);

    $('#paipu-step-badge').textContent = `第 ${this.currentStepIndex + 1} / ${replayer.totalSteps} 步 · 第 ${step.turnNumber} 巡`;
    $('#paipu-step-desc').textContent = step.description;

    // 2. Table Context Bar
    $('#paipu-field-round').textContent = round.roundName;
    $('#paipu-field-honba').textContent = `${state.honba} 本场 · ${state.riichiSticks} 供托`;
    const perspectiveSeatWind = state.seatWinds[this.perspectivePlayer];
    const seatWindName = { '1z': '东家', '2z': '南家', '3z': '西家', '4z': '北家' }[perspectiveSeatWind] || '东家';
    $('#paipu-field-seatwind').textContent = seatWindName;

    $('#paipu-field-dora').innerHTML = state.doraIndicators.map(code => (
      `<img class="mini-dora" src="./public/assets/tiles/${canonicalCode(code)}.png" alt="${code}" />`
    )).join('');

    // 3. Player Header Update
    this._updatePlayerScores(state, step.actor);

    // 4. Perspective Hand
    const hand = state.hands[this.perspectivePlayer];
    const isPerspectiveTurn = step.actor === this.perspectivePlayer;
    const hasTsumoGap = Boolean(isPerspectiveTurn && hand.tsumoTile && hand.tileTotal === 14);

    let handHtml = '';
    if (hasTsumoGap) {
      // Separate freshly drawn tsumo tile
      const normalTiles = [...hand.tiles];
      const tsumoCode = hand.tsumoTile;
      const tsumoIdx = normalTiles.findIndex(t => t === tsumoCode);
      if (tsumoIdx >= 0) normalTiles.splice(tsumoIdx, 1);

      handHtml = normalTiles.map(t => tileImg(t)).join('') + tileImg(tsumoCode, 'tsumo-gap');
    } else {
      handHtml = hand.tiles.map(t => tileImg(t)).join('');
    }

    $('#paipu-hand-display').innerHTML = handHtml || '<span class="muted">手牌为空</span>';
    $('#paipu-hand-title').textContent = `${replayer.playerNames[this.perspectivePlayer]} 的手牌 (${seatWindName})`;
    $('#paipu-hand-count').textContent = `${hand.tileTotal} 张`;

    // 5. Four Rivers (Relative to perspectivePlayer)
    this._renderRivers(state, replayer.playerNames);

    // 6. Open Melds
    this._renderMelds(state, replayer.playerNames);

    // 7. Advisor Analysis & Comparison
    this._renderAdvisorComparison(replayer, step);
  }

  nextStep() {
    if (!this.match) return;
    const round = this.match.getRound(this.currentRoundIndex);
    if (!round) return;

    if (this.currentStepIndex < round.replayer.totalSteps - 1) {
      this.currentStepIndex += 1;
      this.renderStep();
    } else {
      this.pause();
    }
  }

  prevStep() {
    if (!this.match) return;
    if (this.currentStepIndex > 0) {
      this.currentStepIndex -= 1;
      this.renderStep();
    }
  }

  firstStep() {
    this.currentStepIndex = 0;
    this.renderStep();
  }

  lastStep() {
    if (!this.match) return;
    const round = this.match.getRound(this.currentRoundIndex);
    if (!round) return;
    this.currentStepIndex = round.replayer.totalSteps - 1;
    this.renderStep();
  }

  nextDecision() {
    if (!this.match) return;
    const round = this.match.getRound(this.currentRoundIndex);
    if (!round) return;

    const replayer = round.replayer;
    const nextIdx = replayer.decisionStepIndices.find(idx => (
      idx > this.currentStepIndex && replayer.getStep(idx).actor === this.perspectivePlayer
    ));

    if (nextIdx !== undefined) {
      this.currentStepIndex = nextIdx;
      this.renderStep();
    }
  }

  prevDecision() {
    if (!this.match) return;
    const round = this.match.getRound(this.currentRoundIndex);
    if (!round) return;

    const replayer = round.replayer;
    const prevIndices = replayer.decisionStepIndices.filter(idx => (
      idx < this.currentStepIndex && replayer.getStep(idx).actor === this.perspectivePlayer
    ));

    if (prevIndices.length > 0) {
      this.currentStepIndex = prevIndices[prevIndices.length - 1];
      this.renderStep();
    }
  }

  togglePlay() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  play() {
    if (!this.match) return;
    this.isPlaying = true;
    $('#paipu-btn-play').textContent = '❚❚ 暂停';
    $('#paipu-btn-play').classList.add('playing');
    window.clearInterval(this.playTimer);
    this.playTimer = window.setInterval(() => {
      this.nextStep();
    }, this.playSpeed);
  }

  pause() {
    this.isPlaying = false;
    $('#paipu-btn-play').textContent = '▶ 播放';
    $('#paipu-btn-play').classList.remove('playing');
    window.clearInterval(this.playTimer);
    this.playTimer = null;
  }

  setSpeed(ms) {
    this.playSpeed = Number(ms) || 1000;
    if (this.isPlaying) {
      this.play();
    }
  }

  setRound(index) {
    const idx = Number(index);
    if (isNaN(idx) || idx === this.currentRoundIndex) return;
    this.currentRoundIndex = idx;
    this.currentStepIndex = 0;
    this.pause();
    this.renderStep();
  }

  setPerspective(playerIndex) {
    this.perspectivePlayer = Number(playerIndex) || 0;
    this._renderPlayersHeader();
    this.renderStep();
  }

  forkCurrentState() {
    if (!this.match) return;
    const round = this.match.getRound(this.currentRoundIndex);
    if (!round) return;

    const step = round.replayer.getStep(this.currentStepIndex);
    if (!step) return;

    const state = step.state;
    const actor = this.perspectivePlayer;
    const hand = state.hands[actor];

    // Relative opponents
    const right = (actor + 1) % 4;
    const opp = (actor + 2) % 4;
    const left = (actor + 3) % 4;

    const snapshot = {
      handCounts: [...hand.counts],
      redFives: [...hand.redFives],
      selfRiver: state.rivers[actor].discards.map(d => d.code).join(' '),
      rightRiver: state.rivers[right].discards.map(d => d.code).join(' '),
      oppositeRiver: state.rivers[opp].discards.map(d => d.code).join(' '),
      leftRiver: state.rivers[left].discards.map(d => d.code).join(' '),
      riichi: {
        right: state.riichi[right],
        opposite: state.riichi[opp],
        left: state.riichi[left],
      },
      dora: state.doraIndicators.join(' '),
      roundWind: state.roundWind,
      seatWind: state.seatWinds[actor],
      melds: (state.melds[actor] || []).map(m => m.tiles.join('')).join(' '),
    };

    if (this.onForkToWorkbench) {
      this.onForkToWorkbench(snapshot);
    }
  }

  _renderPlayersHeader() {
    const round = this.match.getRound(this.currentRoundIndex);
    const step = round ? round.replayer.getStep(this.currentStepIndex) : null;
    const state = step ? step.state : null;

    const container = $('#paipu-players');
    container.innerHTML = this.match.metadata.players.map((name, p) => {
      const isPerspective = p === this.perspectivePlayer;
      const seatWind = state ? state.seatWinds[p] : SEAT_WINDS[p];
      const windLabel = { '1z': '东', '2z': '南', '3z': '西', '4z': '北' }[seatWind] || '东';
      const score = state ? state.scores[p] : 25000;
      const isRiichi = state && state.riichi[p];

      return `
        <div class="player-card ${isPerspective ? 'active-perspective' : ''}" data-player="${p}">
          <div class="p-seat">
            <span>${windLabel}家 · 座位 ${p + 1}</span>
            ${isPerspective ? '<span class="p-tag">当前视角</span>' : ''}
            ${isRiichi ? '<span class="riichi-tag">立直</span>' : ''}
          </div>
          <div class="p-name" title="${name}">${name}</div>
          <div class="p-score">${score} 点</div>
        </div>
      `;
    }).join('');

    $$('#paipu-players .player-card').forEach(card => {
      card.addEventListener('click', () => {
        this.setPerspective(Number(card.dataset.player));
      });
    });
  }

  _updatePlayerScores(state, actingActor) {
    $$('#paipu-players .player-card').forEach(card => {
      const p = Number(card.dataset.player);
      const isPerspective = p === this.perspectivePlayer;
      card.classList.toggle('active-perspective', isPerspective);
      const scoreEl = card.querySelector('.p-score');
      if (scoreEl) scoreEl.textContent = `${state.scores[p]} 点`;
      const seatEl = card.querySelector('.p-seat');
      if (seatEl) {
        const seatWind = state.seatWinds[p];
        const windLabel = { '1z': '东', '2z': '南', '3z': '西', '4z': '北' }[seatWind] || '东';
        const isRiichi = state.riichi[p];
        const isActing = p === actingActor;
        seatEl.innerHTML = `
          <span>${windLabel}家 · ${nameShort(p + 1)}</span>
          ${isPerspective ? '<span class="p-tag">视角</span>' : ''}
          ${isRiichi ? '<span class="riichi-tag">立直</span>' : ''}
          ${isActing ? '<span class="acting-tag" style="color:var(--gold);font-size:9px;">[行动]</span>' : ''}
        `;
      }
    });
  }

  _renderRivers(state, playerNames) {
    const p = this.perspectivePlayer;
    const positions = [
      { key: 'self', player: p, label: '自家牌河', nameEl: '#paipu-river-name-self', listEl: '#paipu-river-tiles-self', riichiEl: '#paipu-river-riichi-self' },
      { key: 'right', player: (p + 1) % 4, label: '下家牌河', nameEl: '#paipu-river-name-right', listEl: '#paipu-river-tiles-right', riichiEl: '#paipu-river-riichi-right' },
      { key: 'opposite', player: (p + 2) % 4, label: '对家牌河', nameEl: '#paipu-river-name-opposite', listEl: '#paipu-river-tiles-opposite', riichiEl: '#paipu-river-riichi-opposite' },
      { key: 'left', player: (p + 3) % 4, label: '上家牌河', nameEl: '#paipu-river-name-left', listEl: '#paipu-river-tiles-left', riichiEl: '#paipu-river-riichi-left' },
    ];

    for (const pos of positions) {
      const name = playerNames[pos.player] || `玩家${pos.player + 1}`;
      $(pos.nameEl).textContent = `${pos.label} [${name}]`;
      const isRiichi = state.riichi[pos.player];
      $(pos.riichiEl).innerHTML = isRiichi ? '<span class="riichi-tag">已立直</span>' : '';

      const discards = state.rivers[pos.player].discards;
      $(pos.listEl).innerHTML = discards.map(d => {
        let cls = '';
        if (d.tsumogiri) cls += ' tsumogiri';
        if (d.isRiichi) cls += ' riichi';
        if (d.isCalled) cls += ' called';
        return miniTileImg(d.code, cls);
      }).join('');
    }
  }

  _renderMelds(state, playerNames) {
    const grid = $('#paipu-melds-grid');
    grid.innerHTML = playerNames.map((name, p) => {
      const melds = state.melds[p] || [];
      const meldHtml = melds.length
        ? melds.map(m => `
            <div class="meld-group" title="${m.type}">
              ${m.tiles.map(t => `<img class="meld-tile" src="./public/assets/tiles/${canonicalCode(t)}.png" alt="${t}" />`).join('')}
            </div>
          `).join('')
        : '<span class="muted" style="font-size:10px;">门前清 (无副露)</span>';

      return `
        <div class="meld-player">
          <b>${SEAT_NAMES[p]} [${name}]</b>
          <div>${meldHtml}</div>
        </div>
      `;
    }).join('');
  }

  _renderAdvisorComparison(replayer, step) {
    const comparisonContent = $('#paipu-comparison-content');
    const suggestionsList = $('#paipu-suggestions-list');

    if (!step.isDiscardDecision) {
      comparisonContent.innerHTML = `
        <div class="muted" style="padding:16px 0; font-size:12px; line-height:1.7;">
          当前步骤：<strong>${step.description}</strong><br />
          非切牌决策点。请点击下一步或使用“下一打”跳转至切牌点。
        </div>
      `;
      suggestionsList.innerHTML = '<span class="muted" style="font-size:11px;">无切牌排序（非出牌阶段）</span>';
      return;
    }

    if (step.actor !== this.perspectivePlayer) {
      comparisonContent.innerHTML = `
        <div class="muted" style="padding:16px 0; font-size:12px; line-height:1.7;">
          当前轮到 <strong>${step.actorName}</strong> 切牌决策。<br />
          实际打出：<strong>${step.actualDiscard || '尚未切出'}</strong>。<br />
          <small>提示：点击上方对应的玩家卡片即可切换到该视角查看切牌建议。</small>
        </div>
      `;
      suggestionsList.innerHTML = '<span class="muted" style="font-size:11px;">非当前视角出牌</span>';
      return;
    }

    // Perspective player discard decision!
    const adv = replayer.getAdvisorForStep(step.stepIndex);
    if (!adv || !adv.comparison) {
      comparisonContent.innerHTML = '<div class="muted" style="padding:14px 0;">牌理引擎未能生成此步的切牌建议。</div>';
      suggestionsList.innerHTML = '';
      return;
    }

    const { bestDiscard, actualDiscard, isMatch, bestSuggestion, actualSuggestion, ukeireDiff, shantenDiff } = adv.comparison;

    let diffText = '';
    if (isMatch) {
      diffText = '✓ 与 AI 牌理推荐完全一致，综合牌效与安全度最佳。';
    } else {
      const parts = [];
      if (shantenDiff > 0) parts.push(`切后向听后退 ${shantenDiff} 向听`);
      if (ukeireDiff > 0) parts.push(`有效牌进张减少 ${ukeireDiff} 枚`);
      diffText = parts.length ? `! 存在更佳打法：${parts.join('，')}。` : '与首选推荐在牌效上相近，可参考安全度与役种。';
    }

    comparisonContent.innerHTML = `
      <div class="decision-box">
        <div class="decision-comparison">
          <div class="compare-col ${isMatch ? 'match' : 'mismatch'}">
            <span class="compare-title">实际切牌</span>
            <div class="compare-tile">
              <img src="./public/assets/tiles/${canonicalCode(actualDiscard || bestDiscard)}.png" alt="${actualDiscard}" />
            </div>
            <span class="status-pill ${isMatch ? 'green' : 'amber'}">
              ${isMatch ? '✓ 最佳切牌' : '! 次优选择'}
            </span>
          </div>

          <div class="compare-col match">
            <span class="compare-title">AI 推荐切牌</span>
            <div class="compare-tile">
              <img src="./public/assets/tiles/${canonicalCode(bestDiscard)}.png" alt="${bestDiscard}" />
            </div>
            <span class="status-pill green">
              ${bestSuggestion.ukeire} 枚进张
            </span>
          </div>
        </div>
        <div class="diff-note">${diffText}</div>
      </div>
    `;

    // Render suggestions table
    const topSuggestions = adv.analysis.suggestions.slice(0, 5);
    suggestionsList.innerHTML = topSuggestions.map((item, idx) => {
      const tileCode = canonicalCode(TILE_CODES[item.discard]);
      const tileName = TILE_NAMES[item.discard];
      return `
        <div class="suggestion-mini ${idx === 0 ? 'best' : ''}">
          <span style="font-size:11px;font-weight:700;color:var(--gold);">#${idx + 1}</span>
          <div class="tile"><img src="./public/assets/tiles/${tileCode}.png" alt="${tileName}" /></div>
          <div class="mini-main">
            <h4>切 ${tileName}</h4>
            <p>${item.safety !== '无人立直' ? item.safety : '切后' + item.nextShanten + '向听'}</p>
          </div>
          <div class="mini-stats">
            <b>${item.ukeire} 枚</b>
            <span>有效进张</span>
          </div>
        </div>
      `;
    }).join('');
  }

  _bindEvents() {
    // Round select
    $('#paipu-round-select').addEventListener('change', (e) => {
      this.setRound(e.target.value);
    });

    // Speed select
    $('#paipu-speed-select').addEventListener('change', (e) => {
      this.setSpeed(e.target.value);
    });

    // Slider
    $('#paipu-step-slider').addEventListener('input', (e) => {
      this.currentStepIndex = Number(e.target.value);
      this.renderStep();
    });

    // Step buttons
    $('#paipu-btn-first').addEventListener('click', () => this.firstStep());
    $('#paipu-btn-prev').addEventListener('click', () => this.prevStep());
    $('#paipu-btn-next').addEventListener('click', () => this.nextStep());
    $('#paipu-btn-last').addEventListener('click', () => this.lastStep());
    $('#paipu-btn-play').addEventListener('click', () => this.togglePlay());
    $('#paipu-btn-prev-dec').addEventListener('click', () => this.prevDecision());
    $('#paipu-btn-next-dec').addEventListener('click', () => this.nextDecision());

    // Fork to workbench
    $('#paipu-fork-btn').addEventListener('click', () => this.forkCurrentState());

    // Demo button
    $('#paipu-demo-btn').addEventListener('click', () => {
      try {
        const match = parsePaipuJson(DEMO_PAIPU_DATA);
        this.loadMatch(match);
      } catch (err) {
        $('#paipu-error').textContent = err.message;
      }
    });

    // File input button
    $('#paipu-choose-file-btn').addEventListener('click', () => {
      $('#paipu-file-input').click();
    });

    $('#paipu-file-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const match = parsePaipuInput(evt.target.result);
          this.loadMatch(match);
        } catch (err) {
          $('#paipu-error').textContent = `牌谱解析失败：${err.message}`;
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    // Paste drawer toggle & apply
    $('#paipu-toggle-paste-btn').addEventListener('click', () => {
      $('#paipu-paste-drawer').classList.toggle('hidden');
    });

    $('#paipu-apply-paste-btn').addEventListener('click', () => {
      const text = $('#paipu-paste-textarea').value.trim();
      if (!text) {
        $('#paipu-error').textContent = '请先粘贴牌谱内容';
        return;
      }
      try {
        const match = parsePaipuInput(text);
        this.loadMatch(match);
        $('#paipu-paste-drawer').classList.add('hidden');
      } catch (err) {
        $('#paipu-error').textContent = `解析错误：${err.message}`;
      }
    });

    // Fetch URL online button
    $('#paipu-fetch-btn').addEventListener('click', async () => {
      const url = $('#paipu-url-input').value.trim();
      const errContainer = $('#paipu-error-container');
      if (errContainer) errContainer.innerHTML = '';
      if (!url) {
        if (errContainer) {
          errContainer.innerHTML = `
            <div class="paipu-error-card">
              <h4>请输入有效链接</h4>
              <p>请粘贴形如 <code>https://game.maj-soul.com/1/?paipu=...</code> 的雀魂对局分享链接或 UUID。</p>
            </div>
          `;
        }
        return;
      }

      if (errContainer) {
        errContainer.innerHTML = `
          <div class="paipu-error-card" style="border-left-color: var(--gold); background: #fcfbf6; border-color: #e5dec9;">
            <h4 style="color: var(--green);">正在查询牌谱……</h4>
            <p>正在尝试通过公开镜像检索该对局，请稍候。</p>
          </div>
        `;
      }

      try {
        const match = await fetchPaipuOnline(url);
        if (errContainer) errContainer.innerHTML = '';
        this.loadMatch(match);
      } catch (err) {
        if (errContainer) {
          errContainer.innerHTML = `
            <div class="paipu-error-card">
              <h4>未能直接在线获取该雀魂对局</h4>
              <p>
                <strong>技术说明：</strong>《雀魂》官方未开放免登录 HTTP 下载接口，牌谱数据基于加密 WebSocket + Protobuf 协议流式传输，必须携带游戏账号客户端凭证；公开镜像库因防刷限制或未收录亦无法直接抓取。<br />
                <strong>推荐解决方案（与 Mortal / NAGA 相同）：</strong>在 Chrome / Edge 中使用「雀魂牌谱分析器」插件或油猴脚本，在雀魂中将该牌谱一键导出为 <code>.json</code> 文件（Tenhou / MJAI 格式），然后直接上传即可。
              </p>
              <div class="paipu-error-actions">
                <button class="secondary-button" id="paipu-err-upload" type="button">📁 上传导出的 .json 文件</button>
                <button class="secondary-button" id="paipu-err-paste" type="button">📋 粘贴 JSON 内容</button>
                <button class="secondary-button" id="paipu-err-demo" type="button">▶ 体验内置示例对局</button>
              </div>
            </div>
          `;

          document.getElementById('paipu-err-upload')?.addEventListener('click', () => $('#paipu-file-input').click());
          document.getElementById('paipu-err-paste')?.addEventListener('click', () => {
            $('#paipu-paste-drawer').classList.remove('hidden');
            $('#paipu-paste-textarea').focus();
          });
          document.getElementById('paipu-err-demo')?.addEventListener('click', () => {
            const demo = parsePaipuJson(DEMO_PAIPU_DATA);
            this.loadMatch(demo);
          });
        }
      }
    });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      const paipuWorkspace = $('#paipu-workspace');
      if (!paipuWorkspace || paipuWorkspace.classList.contains('hidden') || !this.match) return;

      // Ignore if typing in text inputs
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          this.prevStep();
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.nextStep();
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.prevDecision();
          break;
        case 'ArrowDown':
          e.preventDefault();
          this.nextDecision();
          break;
        case ' ':
          e.preventDefault();
          this.togglePlay();
          break;
      }
    });
  }
}

function nameShort(num) {
  return `玩家${num}`;
}
