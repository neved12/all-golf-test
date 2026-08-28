// 운영 단계에서는 관리자 화면/서버 설정값으로 이 객체만 교체하면 됩니다.
window.ALL_GOLF_PRICING_CONFIG = {
  version: '2026-08-28-v1',
  limits: { minRate: -0.30, maxRate: 0.25 },
  roundingUnit: 1000,
  quoteTtlMinutes: 15,
  occupancy: {
    high: { threshold: 0.80, rate: 0.10, label: '예약률 높음' },
    low: { threshold: 0.35, rate: -0.05, label: '여유 티타임' }
  },
  urgency: {
    lastMinute: { hours: 24, rate: -0.15, label: '임박 특가' },
    soon: { hours: 72, rate: -0.07, label: '티오프 임박 할인' }
  },
  weather: {
    rain: { rate: -0.10, label: '비 예보' },
    heavyRain: { rate: -0.15, label: '강한 비 예보' },
    clear: { rate: 0.05, label: '쾌청 수요' },
    cloudy: { rate: 0, label: '흐림' }
  },
  weekend: { rate: 0.05, label: '주말 수요' }
};
