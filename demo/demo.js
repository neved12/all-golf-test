/* ALL:GOLF 10단계 — 투자자·골프장 제휴 시연 허브 스크립트
   - 정적 배포(GitHub Pages)에서는 서버 요청을 전혀 보내지 않는다(다른 화면과 같은 규칙).
   - 서버 모드에서는 공개 상태 조회(/api/demo/stage10)와, 관리자 인증이 필요한
     시연 데이터 준비·초기화(/api/demo/stage10/stage, /reset)만 호출한다.
   - 초기화·준비는 확인 문구 + (초기화는) 체크박스를 모두 채워야 버튼이 열린다. */
(function () {
  'use strict';

  const api = window.ALL_GOLF_API || null;
  const simulator = window.ALL_GOLF_SIMULATOR || null;
  const courses = Array.isArray(window.ALL_GOLF_COURSES) ? window.ALL_GOLF_COURSES : [];
  const demoMap = window.ALL_GOLF_DEMO_COURSES && typeof window.ALL_GOLF_DEMO_COURSES === 'object' ? window.ALL_GOLF_DEMO_COURSES : {};

  const CHECK_KEY = 'allGolfStage10Checklist';
  const LOCAL_KEYS = [
    'allGolfReservations', 'allGolfOperationsV1', 'allGolfPartners', 'allGolfPartnerTeeTimes',
    'allGolfPartnershipStatusV1', 'allGolfPartnerApplicationsV1', 'allGolfRecentSearches',
    'allGolfRecentViews', 'allGolfFavorites', 'allGolfWaitlist'
  ];
  const CONFIRM_STAGE = 'STAGE-STAGE10-DEMO';
  const CONFIRM_RESET = 'RESET-STAGE10-DEMO';

  const GUIDE = {
    investor: {
      title: '투자자 시연 모드',
      summary: '전국 509곳 데이터 → 시연 예약 68곳의 재고 차감 → 본사 통계·정산 → 수익 흐름 순서로 보여 줍니다.',
      steps: [
        { id: 'invest-1', title: '전국 509곳 데이터 확인', where: '본사 관리자 › 전국 골프장', href: '../admin/', detail: '시연 예약 가능 68곳과 정보 제공 441곳이 구분되어 표시됩니다. 가격·티타임은 정보 제공 골프장에 표시하지 않습니다.' },
        { id: 'invest-2', title: '제휴 골프장 티타임 확인', where: '사용자 앱 › 예약', href: '../?page=list', detail: '시연 데이터를 준비하면 우정힐스·세종에머슨·프린세스 3곳에 오늘부터 7일 치 티타임이 열립니다.' },
        { id: 'invest-3', title: '예약으로 재고 차감', where: '사용자 앱 › 예약 확인', href: '../?page=list', detail: '예약 1건 = 1팀. 같은 티타임의 잔여 팀이 모든 화면에서 즉시 줄어듭니다.' },
        { id: 'invest-4', title: '취소와 재고 복구', where: '사용자 앱 › 내 예약', href: '../?page=my', detail: '취소하면 환불 규정으로 금액을 계산하고 잔여 팀을 되돌립니다(실제 환불 없음).' },
        { id: 'invest-5', title: '본사 운영 통계', where: '본사 관리자 › 운영 통계·제휴 성과', href: '../admin/', detail: '기간별 예약 건수·GMV·취소·노쇼·1·2·3부 분포를 골프장별로 봅니다. 예약 접수일 기준입니다.' },
        { id: 'invest-6', title: '정산·수수료 흐름', where: '본사 관리자 › 정산·수수료 관리', href: '../admin/', detail: '정산 기준액 → 플랫폼 수수료 → 정산 예정액과 DRAFT→PENDING→CONFIRMED→PAID 전이를 보여 줍니다.' },
        { id: 'invest-7', title: '수익 흐름 시뮬레이션', where: '이 페이지 › 사업성 시뮬레이터', href: '#simulator', detail: '제휴 규모·예약량·수수료율 가정으로 월·연 수수료 매출을 계산합니다(가정 기반 시연 계산치).' }
      ]
    },
    partner: {
      title: '골프장 제휴 시연 모드',
      summary: '제휴 신청 → 본사 승인 → 담당자 로그인 → 티타임·특가 등록 → 예약·취소 → 정산서 확인 순서입니다.',
      steps: [
        { id: 'partner-1', title: '제휴 신청 접수', where: '사용자 앱 › 혜택 › 제휴 신청', href: '../?page=benefits', detail: '골프장 정보와 담당자를 입력하면 접수번호가 발급됩니다.' },
        { id: 'partner-2', title: '본사 승인', where: '본사 관리자 › 제휴 신청 관리', href: '../admin/', detail: '승인하면 제휴 골프장 목록에 들어가고 담당자 계정을 발급할 수 있습니다.' },
        { id: 'partner-3', title: '담당자 로그인', where: '골프장 관리자', href: '../partner/', detail: '시연 데이터 준비 시 계정 3개가 만들어집니다. 비밀번호는 allgolf-partner-2026 (시연용).' },
        { id: 'partner-4', title: '티타임·특가 등록', where: '골프장 관리자 › 티타임 관리', href: '../partner/', detail: '날짜·시간·부·정원·그린피를 서버 DB에 저장하면 고객 앱에 반영됩니다.' },
        { id: 'partner-5', title: '예약·취소 처리', where: '골프장 관리자 › 예약 관리', href: '../partner/', detail: '자기 골프장 예약만 조회·처리됩니다. 다른 골프장 데이터는 서버가 403으로 막습니다.' },
        { id: 'partner-6', title: '정산서 확인', where: '골프장 관리자 › 정산 내역', href: '../partner/', detail: '수수료율·정산 기준액·지급 예정액을 확인합니다(실제 이체 없음).' }
      ]
    }
  };

  const state = {
    mode: 'investor',
    simInput: simulator ? simulator.defaultInput() : {},
    simResult: null,
    status: null,
    adminReady: false,
    loading: false,
    lastAction: ''
  };

  const $ = selector => document.querySelector(selector);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  function toast(message) {
    const box = $('#toast');
    if (!box) return;
    box.textContent = message;
    box.classList.add('show');
    setTimeout(() => box.classList.remove('show'), 2600);
  }

  function readChecklist() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CHECK_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }
  function writeChecklist(value) {
    try { localStorage.setItem(CHECK_KEY, JSON.stringify(value)); } catch { /* 저장 불가 환경 */ }
  }

  /* --- 카탈로그 요약 -------------------------------------------------------- */
  function catalogSummary() {
    const total = courses.length;
    const partner = Object.keys(demoMap).filter(id => demoMap[id] && demoMap[id].generatedDemo === false).length;
    return { total, partner, infoOnly: Math.max(0, total - partner) };
  }

  function renderCatalog() {
    const { total, partner, infoOnly } = catalogSummary();
    const set = (id, value) => { const node = $(id); if (node) node.textContent = value; };
    set('#kpi-total', total ? `${total}곳` : '—');
    set('#kpi-partner', partner ? `${partner}곳` : '—');
    set('#kpi-info', infoOnly ? `${infoOnly}곳` : '—');
    const note = $('#state-note');
    if (note) note.textContent = total
      ? `골프장 마스터 ${total}곳 = 시연 예약 ${partner}곳 + 정보 제공 ${infoOnly}곳 (공개자료 병합 목록, 가격·티타임은 시연 예약 골프장만)`
      : '골프장 데이터를 읽지 못했습니다. 페이지를 새로고침해 주세요.';
  }

  /* --- 모드 가이드 ---------------------------------------------------------- */
  function stepHtml(step, index, checklist) {
    const done = Boolean(checklist[step.id]);
    return `<article class="step ${done ? 'done' : ''}" data-step="${step.id}">
      <span class="step-no">${done ? '✓' : index + 1}</span>
      <div class="step-main">
        <h3>${esc(step.title)}</h3>
        <div class="step-where">${esc(step.where)}</div>
        <p>${esc(step.detail)}</p>
      </div>
      <div class="step-actions">
        <a class="step-link" href="${esc(step.href)}" target="_blank" rel="noopener">바로가기 ↗</a>
        <label class="step-check"><input type="checkbox" data-check="${step.id}" ${done ? 'checked' : ''}> 확인</label>
      </div>
    </article>`;
  }

  function renderMode() {
    const guide = GUIDE[state.mode] || GUIDE.investor;
    const checklist = readChecklist();
    const body = $('#mode-body');
    if (body) body.innerHTML = `<p class="tiny">${esc(guide.summary)}</p>${guide.steps.map((step, index) => stepHtml(step, index, checklist)).join('')}`;
    updateProgress();
    bindSteps();
    document.querySelectorAll('.mode-btn').forEach(button => {
      const active = button.dataset.mode === state.mode;
      button.classList.toggle('active', active);
      if (button.setAttribute) button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function updateProgress() {
    const guide = GUIDE[state.mode] || GUIDE.investor;
    const checklist = readChecklist();
    const done = guide.steps.filter(step => checklist[step.id]).length;
    const node = $('#mode-progress');
    if (node) node.textContent = `${done} / ${guide.steps.length} 단계 완료 · ${guide.title}`;
    guide.steps.forEach(step => {
      const article = document.querySelector(`[data-step="${step.id}"]`);
      if (article && article.classList) article.classList.toggle('done', Boolean(checklist[step.id]));
    });
  }

  function bindSteps() {
    document.querySelectorAll('[data-check]').forEach(input => {
      input.onchange = event => {
        const target = event && event.target ? event.target : input;
        const key = target.dataset ? (target.dataset.check || input.getAttribute('data-check')) : input.getAttribute('data-check');
        const checklist = readChecklist();
        if (target.checked) checklist[key] = true; else delete checklist[key];
        writeChecklist(checklist);
        updateProgress();
      };
    });
  }

  /* --- 사업성 시뮬레이터 ---------------------------------------------------- */
  function renderSimulatorInputs() {
    const host = $('#sim-inputs');
    if (!host || !simulator) return;
    host.innerHTML = simulator.FIELDS.map(field => `<label class="field">${esc(field.label)} (${esc(field.unit)})
      <input type="number" id="sim-${field.key}" data-sim="${field.key}" min="${field.min}" max="${field.max}" step="${field.step}" value="${state.simInput[field.key]}">
      <span class="hint-inline">${field.min} ~ ${field.max}${esc(field.unit)}</span>
    </label>`).join('');
    host.querySelectorAll('[data-sim]').forEach(input => {
      input.oninput = input.onchange = event => {
        const node = event && event.target ? event.target : input;
        const key = node.dataset ? node.dataset.sim : input.getAttribute('data-sim');
        state.simInput[key] = node.value;
        renderSimulatorResults();
      };
    });
  }

  function renderPresets() {
    const host = $('#sim-presets');
    if (!host || !simulator) return;
    host.innerHTML = simulator.PRESETS.map(preset => `<button type="button" class="preset" data-preset="${preset.key}" title="${esc(preset.note)}">${esc(preset.label)}</button>`).join('');
    host.querySelectorAll('[data-preset]').forEach(button => {
      button.onclick = () => applyPreset(button.dataset.preset || button.getAttribute('data-preset'));
    });
  }

  function applyPreset(key) {
    if (!simulator) return;
    state.simInput = simulator.preset(key);
    simulator.FIELDS.forEach(field => {
      const input = $(`#sim-${field.key}`);
      if (input) input.value = state.simInput[field.key];
    });
    renderSimulatorResults();
    toast(`${key === 'base' ? '기본' : key === 'growth' ? '성장' : '보수적'} 가정을 적용했습니다.`);
  }

  function renderSimulatorResults() {
    if (!simulator) return;
    const result = simulator.compute(state.simInput);
    state.simResult = result;
    const values = result.values;
    const set = (id, text) => { const node = $(id); if (node) node.textContent = text; };
    set('#sim-fee-month', simulator.formatWon(values.monthlyFee));
    set('#sim-fee-month-note', `월 GMV의 ${result.input.commissionPercent}% · 연 ${simulator.formatWon(values.annualFee)}`);
    set('#sim-teams-month', `${simulator.formatNumber(values.teamsPerMonth)}팀`);
    set('#sim-gmv-month', simulator.formatWon(values.monthlyGmv));
    set('#sim-fee-year', simulator.formatWon(values.annualFee));
    set('#sim-per-course', simulator.formatWon(values.perCourseMonthlyFee));
    const warnings = $('#sim-warnings');
    if (warnings) {
      warnings.hidden = result.warnings.length === 0;
      warnings.textContent = result.warnings.join(' ');
    }
    const summary = $('#sim-summary');
    if (summary) summary.value = simulator.summaryText(result);
    const disclaimer = $('#sim-disclaimer');
    if (disclaimer) disclaimer.textContent = result.disclaimer;
    return result;
  }

  function copySummary() {
    const summary = $('#sim-summary');
    const text = summary ? summary.value : (state.simResult ? simulator.summaryText(state.simResult) : '');
    const status = $('#sim-copy-status');
    const done = message => { if (status) status.textContent = message; };
    if (!text) { done('복사할 내용이 없습니다.'); return Promise.resolve(false); }
    const fallback = () => {
      if (summary && typeof summary.select === 'function') { try { summary.select(); } catch { /* noop */ } }
      done('자동 복사가 지원되지 않아 내용을 선택했습니다. 직접 복사해 주세요.');
      return false;
    };
    const clipboard = navigator && navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      return clipboard.writeText(text).then(() => {
        done('결과 요약을 클립보드에 복사했습니다.');
        toast('결과 요약을 복사했습니다.');
        return true;
      }).catch(fallback);
    }
    return Promise.resolve(fallback());
  }

  /* --- 데이터 상태 ---------------------------------------------------------- */
  function serverMode() {
    return Boolean(api && api.state && api.state.mode === 'server');
  }

  function renderModeChip() {
    const chip = $('#mode-chip');
    if (!chip) return;
    const server = serverMode();
    chip.textContent = server ? '서버 연동' : (api && api.state && api.state.connecting ? '서버 확인 중' : '정적 시연');
    chip.classList.toggle('server', server);
    chip.classList.toggle('static', !server);
  }

  function setStateField(id, value) {
    const node = $(id);
    if (node) node.textContent = value;
  }

  function renderStatus() {
    setStateField('#state-mode', serverMode() ? '서버 연동' : '정적 시연');
    const health = api && api.health ? api.health() : null;
    const db = health && health.db ? health.db : null;
    const status = state.status;
    setStateField('#state-courses', db ? `${db.approvedCourses}곳` : '—');
    setStateField('#state-tees', db ? `${db.teeTimes}건` : '—');
    setStateField('#state-reservations', db ? `${db.reservations}건` : '—');
    setStateField('#state-settlements', db ? `${db.settlements}건` : '—');
    setStateField('#state-batch', status && status.staged ? `${status.demoTotal}건` : '준비 안 됨');
    const note = $('#state-note');
    if (note) {
      if (!serverMode()) {
        note.textContent = '정적 시연 모드입니다. 서버 DB가 없어 예약·정산은 이 브라우저 안에서만 동작하고, 서버 요청은 보내지 않습니다.';
      } else if (status && status.staged) {
        note.textContent = `10단계 시연 배치 ${status.batch} · 준비 ${String(status.stagedAt || '').slice(0, 16).replace('T', ' ')} · 시연 ${status.demoTotal}건 / 일반 데이터 ${status.protectedTotal}건(보존)`;
      } else {
        note.textContent = '아직 10단계 시연 데이터를 준비하지 않았습니다. 아래 “시연 데이터 준비”로 만들 수 있습니다.';
      }
    }
  }

  async function loadStatus() {
    if (!serverMode()) { renderStatus(); return null; }
    const result = await api.request('/api/demo/stage10', { timeoutMs: 6000 });
    if (result && result.ok) {
      state.status = result.data;
    } else {
      state.status = null;
    }
    renderStatus();
    return state.status;
  }

  async function refreshHealth() {
    if (!api) return;
    if (typeof api.refreshHealth === 'function') await api.refreshHealth();
  }

  /* --- 관리자 확인 ---------------------------------------------------------- */
  async function adminLogin() {
    if (!serverMode()) { showResetResult('정적 시연 모드에서는 서버 관리자 로그인이 필요하지 않습니다.', true); return false; }
    const field = $('#admin-password');
    const password = field ? String(field.value || '') : '';
    if (!password) { setAdminState('비밀번호를 입력하세요', false); return false; }
    setAdminState('확인 중…', false);
    const result = await api.request('/api/admin/login', { method: 'POST', body: { password }, timeoutMs: 6000 });
    if (result && result.ok && result.data && result.data.token) {
      api.setToken(result.data.token);
      state.adminReady = true;
      setAdminState(`확인됨 · ${result.data.admin && result.data.admin.email ? result.data.admin.email : '관리자'}`, true);
      if (field) field.value = '';
      return true;
    }
    api.clearToken();
    state.adminReady = false;
    setAdminState(`확인 실패: ${result && result.error ? result.error.message : '로그인할 수 없습니다.'}`, false);
    return false;
  }

  function setAdminState(message, ok) {
    const node = $('#admin-state');
    if (node) node.textContent = message;
    if (node && node.classList) node.classList.toggle('ok', Boolean(ok));
  }

  async function ensureAdmin() {
    if (!serverMode()) return true;
    if (state.adminReady && api.getToken()) return true;
    return adminLogin();
  }

  /* --- 준비/초기화 ---------------------------------------------------------- */
  function showResetResult(message, error) {
    const box = $('#reset-result');
    if (!box) return;
    box.hidden = false;
    box.classList.toggle('error', Boolean(error));
    box.textContent = message;
  }

  function updateGuards() {
    const stageField = $('#stage-confirm');
    const resetField = $('#reset-confirm');
    const guard = $('#reset-guard');
    const stageButton = $('#btn-stage');
    const resetButton = $('#btn-reset');
    const server = serverMode();
    if (stageButton) stageButton.disabled = !server || !stageField || String(stageField.value || '') !== CONFIRM_STAGE || state.loading;
    if (resetButton) resetButton.disabled = !resetField || String(resetField.value || '') !== CONFIRM_RESET || !guard || !guard.checked || state.loading;
  }

  async function stageDemo() {
    if (!serverMode()) {
      showResetResult('정적 시연 모드에는 서버 DB가 없습니다. 로컬 PC에서 npm start 후 이 화면을 열면 시연 데이터를 만들 수 있습니다.', true);
      return null;
    }
    const stageField = $('#stage-confirm');
    if (!stageField || String(stageField.value || '') !== CONFIRM_STAGE) {
      showResetResult(`확인 문구 ${CONFIRM_STAGE} 를 정확히 입력해야 준비할 수 있습니다.`, true);
      return null;
    }
    if (!(await ensureAdmin())) { showResetResult('본사 관리자 비밀번호 확인이 필요합니다.', true); return null; }
    state.loading = true; updateGuards();
    showResetResult('시연 데이터를 준비하는 중…', false);
    const result = await api.request('/api/demo/stage10/stage', {
      method: 'POST', body: { confirm: CONFIRM_STAGE }, token: api.getToken(), timeoutMs: 20000
    });
    state.loading = false; updateGuards();
    if (!result || !result.ok) {
      showResetResult(`준비 실패: ${result && result.error ? result.error.message : '알 수 없는 오류'}`, true);
      return null;
    }
    const created = result.data.created || {};
    showResetResult(`시연 데이터를 준비했습니다. 배치 ${result.data.batch} · 티타임 ${created.teeTimes}건 · 예약 ${created.reservations}건 · 정산서 ${created.settlements}건 · 담당자 계정 ${created.partnerAccounts}개(비밀번호 allgolf-partner-2026)`, false);
    toast('시연 데이터를 준비했습니다.');
    await refreshHealth();
    await loadStatus();
    return result.data;
  }

  async function resetDemo() {
    const resetFieldForCheck = $('#reset-confirm');
    const guardForCheck = $('#reset-guard');
    if (!resetFieldForCheck || String(resetFieldForCheck.value || '') !== CONFIRM_RESET || !guardForCheck || !guardForCheck.checked) {
      showResetResult('확인 문구와 확인 체크가 모두 필요합니다.', true);
      return null;
    }
    if (!serverMode()) {
      let removed = 0;
      LOCAL_KEYS.forEach(key => {
        try { if (localStorage.getItem(key) != null) { localStorage.removeItem(key); removed += 1; } } catch { /* noop */ }
      });
      try { localStorage.removeItem(CHECK_KEY); } catch { /* noop */ }
      showResetResult(`이 브라우저의 시연 데이터 ${removed}종을 비웠습니다. (서버 데이터는 건드리지 않았습니다)`, false);
      toast('브라우저 시연 데이터를 비웠습니다.');
      return { local: removed };
    }
    if (!(await ensureAdmin())) { showResetResult('본사 관리자 비밀번호 확인이 필요합니다.', true); return null; }
    state.loading = true; updateGuards();
    showResetResult('시연 데이터를 초기화하는 중…', false);
    const result = await api.request('/api/demo/stage10/reset', {
      method: 'POST', body: { confirm: CONFIRM_RESET }, token: api.getToken(), timeoutMs: 20000
    });
    state.loading = false; updateGuards();
    if (!result || !result.ok) {
      showResetResult(`초기화 실패: ${result && result.error ? result.error.message : '알 수 없는 오류'}`, true);
      return null;
    }
    const removed = result.data.removed || {};
    const totalRemoved = Object.keys(removed).reduce((sum, key) => sum + Number(removed[key] || 0), 0);
    const preserved = result.data.preserved || {};
    const preservedTotal = Object.keys(preserved).reduce((sum, key) => sum + Number(preserved[key] || 0), 0);
    showResetResult(`초기 시연 상태로 되돌렸습니다. 시연 데이터 ${totalRemoved}건 삭제 · 일반 데이터 ${preservedTotal}건 보존(태그 없는 레코드는 그대로).`, false);
    toast('시연 데이터를 초기화했습니다.');
    await refreshHealth();
    await loadStatus();
    return result.data;
  }

  /* --- 바인딩 --------------------------------------------------------------- */
  function bind() {
    document.querySelectorAll('.mode-btn').forEach(button => {
      button.onclick = () => {
        state.mode = button.dataset.mode || button.getAttribute('data-mode') || 'investor';
        renderMode();
      };
    });
    document.querySelectorAll('[data-focus]').forEach(link => {
      link.onclick = () => {
        state.mode = link.dataset.focus || 'investor';
        renderMode();
      };
    });
    const resetChecklist = $('#checklist-reset');
    if (resetChecklist) resetChecklist.onclick = () => {
      writeChecklist({});
      renderMode();
      toast('체크리스트를 초기화했습니다.');
    };
    const refresh = $('#state-refresh');
    if (refresh) refresh.onclick = async () => { await refreshHealth(); await loadStatus(); toast('데이터 상태를 새로고침했습니다.'); };
    const copy = $('#sim-copy');
    if (copy) copy.onclick = () => { copySummary(); };
    const login = $('#admin-login');
    if (login) login.onclick = () => { adminLogin(); };
    const stage = $('#btn-stage');
    if (stage) stage.onclick = () => { stageDemo(); };
    const reset = $('#btn-reset');
    if (reset) reset.onclick = () => { resetDemo(); };
    ['#stage-confirm', '#reset-confirm'].forEach(selector => {
      const field = $(selector);
      if (field) field.oninput = field.onchange = () => updateGuards();
    });
    const guard = $('#reset-guard');
    if (guard) guard.onchange = () => updateGuards();
    updateGuards();
  }

  async function start() {
    renderCatalog();
    renderPresets();
    renderSimulatorInputs();
    renderSimulatorResults();
    renderMode();
    bind();
    renderModeChip();
    renderStatus();
    if (api && typeof api.init === 'function') {
      api.onModeChange(() => { renderModeChip(); renderStatus(); });
      await api.init();
      renderModeChip();
      await refreshHealth();
      await loadStatus();
    }
  }

  window.ALL_GOLF_STAGE10_HUB = {
    state,
    GUIDE,
    start,
    renderMode,
    renderSimulatorResults,
    copySummary,
    adminLogin,
    stageDemo,
    resetDemo,
    loadStatus,
    updateGuards,
    catalogSummary,
    CONFIRM_STAGE,
    CONFIRM_RESET
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
