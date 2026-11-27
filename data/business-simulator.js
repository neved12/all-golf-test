/* ALL:GOLF 10단계 — 사업성 시뮬레이터 계산 엔진
   - 브라우저(시연 허브)와 Node 테스트가 같은 계산식을 쓰도록 한 파일에 둔다.
   - 실제 실적이 아니라 "가정 기반 시연 계산치"다. 취소·환불·세금·운영비는 반영하지 않는다.
   - 모든 결과는 입력값(가정)과 계산식이 그대로 보이도록 함께 돌려준다. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ALL_GOLF_SIMULATOR = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const DISCLAIMER = '이 계산은 실제 실적이 아닌 가정 기반 시연 계산치입니다. 취소·환불·세금·운영비·결제 수수료는 반영하지 않았고, 실제 플랫폼 수수료율은 골프장별 별도 계약이 필요합니다.';

  const FIELDS = [
    { key: 'partnerCourses', label: '제휴 골프장 수', unit: '곳', min: 1, max: 2000, step: 1, defaultValue: 68, integer: true },
    { key: 'teamsPerCoursePerDay', label: '골프장당 일평균 예약 팀', unit: '팀', min: 0, max: 50, step: 0.1, defaultValue: 3 },
    { key: 'avgTicket', label: '평균 예약 거래액(1팀)', unit: '원', min: 0, max: 10000000, step: 10000, defaultValue: 320000, integer: true },
    { key: 'commissionPercent', label: '플랫폼 수수료율', unit: '%', min: 0, max: 30, step: 0.1, defaultValue: 8 },
    { key: 'monthlyDays', label: '월 영업일수', unit: '일', min: 1, max: 31, step: 1, defaultValue: 26, integer: true }
  ];

  const FIELD_BY_KEY = Object.fromEntries(FIELDS.map(field => [field.key, field]));

  const PRESETS = [
    {
      key: 'conservative',
      label: '보수적',
      note: '제휴 30곳 · 하루 2팀 · 수수료 8%',
      input: { partnerCourses: 30, teamsPerCoursePerDay: 2, avgTicket: 300000, commissionPercent: 8, monthlyDays: 26 }
    },
    {
      key: 'base',
      label: '기본',
      note: '제휴 68곳 · 하루 3팀 · 수수료 8%',
      input: { partnerCourses: 68, teamsPerCoursePerDay: 3, avgTicket: 320000, commissionPercent: 8, monthlyDays: 26 }
    },
    {
      key: 'growth',
      label: '성장',
      note: '제휴 150곳 · 하루 4팀 · 수수료 9%',
      input: { partnerCourses: 150, teamsPerCoursePerDay: 4, avgTicket: 350000, commissionPercent: 9, monthlyDays: 26 }
    }
  ];

  function defaultInput() {
    const input = {};
    FIELDS.forEach(field => { input[field.key] = field.defaultValue; });
    return input;
  }

  function formatWon(value) {
    const number = Math.round(Number(value) || 0);
    return `${number.toLocaleString('ko-KR')}원`;
  }

  function formatNumber(value) {
    return Math.round(Number(value) || 0).toLocaleString('ko-KR');
  }

  /* 입력값 검증: 범위를 벗어난 값은 경계로 맞추되 경고를 남긴다(화면에서 이유를 보여 준다). */
  function sanitize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const input = {};
    const warnings = [];
    FIELDS.forEach(field => {
      let value = Number(source[field.key]);
      if (source[field.key] === '' || source[field.key] == null || !Number.isFinite(value)) {
        input[field.key] = field.defaultValue;
        if (source[field.key] !== '' && source[field.key] != null) warnings.push(`${field.label}: 숫자로 읽을 수 없어 기본값 ${field.defaultValue}${field.unit}을(를) 사용했습니다.`);
        return;
      }
      if (value < field.min) {
        warnings.push(`${field.label}: 최소 ${field.min}${field.unit}보다 작아 ${field.min}${field.unit}으로 계산했습니다.`);
        value = field.min;
      }
      if (value > field.max) {
        warnings.push(`${field.label}: 최대 ${field.max}${field.unit}보다 커서 ${field.max}${field.unit}으로 계산했습니다.`);
        value = field.max;
      }
      input[field.key] = field.integer ? Math.round(value) : Math.round(value * 10) / 10;
    });
    return { input, warnings };
  }

  /* 핵심 계산. 반올림 기준을 고정해 화면·테스트·복사 문구가 항상 같은 값을 쓴다. */
  function compute(raw) {
    const { input, warnings } = sanitize(raw);
    const teamsPerMonth = Math.round(input.partnerCourses * input.teamsPerCoursePerDay * input.monthlyDays);
    const monthlyGmv = Math.round(teamsPerMonth * input.avgTicket);
    const monthlyFee = Math.round(monthlyGmv * input.commissionPercent / 100);
    const values = {
      teamsPerMonth,
      annualTeams: teamsPerMonth * 12,
      monthlyGmv,
      annualGmv: monthlyGmv * 12,
      monthlyFee,
      annualFee: monthlyFee * 12,
      perCourseMonthlyFee: input.partnerCourses > 0 ? Math.round(monthlyFee / input.partnerCourses) : 0,
      perCourseMonthlyTeams: input.partnerCourses > 0 ? Math.round(teamsPerMonth / input.partnerCourses * 10) / 10 : 0,
      effectiveDailyTeams: input.partnerCourses > 0 ? Math.round(teamsPerMonth / (input.monthlyDays || 1) * 10) / 10 : 0
    };
    return {
      ok: true,
      input,
      values,
      warnings,
      formula: {
        teamsPerMonth: '제휴 골프장 수 × 골프장당 일평균 예약 팀 × 월 영업일수',
        monthlyGmv: '월 예약 팀 수 × 평균 예약 거래액',
        monthlyFee: '월 GMV × 수수료율(%)',
        annualFee: '월 플랫폼 수수료 × 12'
      },
      disclaimer: DISCLAIMER,
      basis: 'assumption'
    };
  }

  function preset(key) {
    const found = PRESETS.find(item => item.key === String(key));
    return found ? { ...found.input } : defaultInput();
  }

  /* 결과 요약 복사용 문구. 숫자·가정·면책을 한 번에 담는다. */
  function summaryLines(result) {
    const target = result && result.values ? result : compute(result);
    const input = target.input;
    const values = target.values;
    return [
      '[ALL:GOLF 사업성 시뮬레이션 · 가정 기반 시연 계산치]',
      `· 가정: 제휴 골프장 ${formatNumber(input.partnerCourses)}곳, 골프장당 일평균 ${input.teamsPerCoursePerDay}팀, 평균 예약 거래액 ${formatWon(input.avgTicket)}, 수수료율 ${input.commissionPercent}%, 월 영업일수 ${input.monthlyDays}일`,
      `· 월 예약 팀 수: ${formatNumber(values.teamsPerMonth)}팀`,
      `· 월 GMV: ${formatWon(values.monthlyGmv)}`,
      `· 월 플랫폼 수수료 매출: ${formatWon(values.monthlyFee)}`,
      `· 연 플랫폼 수수료 매출: ${formatWon(values.annualFee)}`,
      `· 골프장 1곳당 월 수수료(평균): ${formatWon(values.perCourseMonthlyFee)}`,
      `· 계산식: 팀 수 = 골프장 × 일평균 팀 × 영업일수 / GMV = 팀 수 × 거래액 / 수수료 = GMV × 수수료율`,
      `· ${target.disclaimer || DISCLAIMER}`
    ];
  }

  function summaryText(result) {
    return summaryLines(result).join('\n');
  }

  return {
    DISCLAIMER,
    FIELDS,
    FIELD_BY_KEY,
    PRESETS,
    defaultInput,
    sanitize,
    compute,
    preset,
    summaryLines,
    summaryText,
    formatWon,
    formatNumber
  };
});
