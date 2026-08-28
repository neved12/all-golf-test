(function () {
  // 실제 API 연동 시 getAvailability/getWeather 두 함수의 내부만 교체합니다.
  const availability = {
    woojeong: {
      '07:18': { totalTeams: 10, remainingTeams: 1, hoursUntilTee: 120 },
      '07:25': { totalTeams: 10, remainingTeams: 2, hoursUntilTee: 22 },
      '08:03': { totalTeams: 10, remainingTeams: 5, hoursUntilTee: 50 },
      '13:12': { totalTeams: 10, remainingTeams: 7, hoursUntilTee: 18 }
    },
    emerson: {
      '06:42': { totalTeams: 12, remainingTeams: 2, hoursUntilTee: 96 },
      '07:21': { totalTeams: 12, remainingTeams: 1, hoursUntilTee: 20 },
      '08:14': { totalTeams: 12, remainingTeams: 6, hoursUntilTee: 60 },
      '14:32': { totalTeams: 12, remainingTeams: 1, hoursUntilTee: 12 }
    },
    princess: {
      '07:12': { totalTeams: 8, remainingTeams: 2, hoursUntilTee: 110 },
      '08:24': { totalTeams: 8, remainingTeams: 3, hoursUntilTee: 68 },
      '11:06': { totalTeams: 8, remainingTeams: 1, hoursUntilTee: 30 },
      '15:18': { totalTeams: 8, remainingTeams: 5, hoursUntilTee: 16 }
    }
  };
  const weather = {
    woojeong: { condition: 'rain', label: '비', temperature: 24 },
    emerson: { condition: 'clear', label: '맑음', temperature: 28 },
    princess: { condition: 'cloudy', label: '흐림', temperature: 25 }
  };
  window.ALL_GOLF_REALTIME_PROVIDER = {
    mode: 'mock',
    getAvailability(courseId, time, fallbackRemaining) {
      const value = availability[courseId]?.[time] || { totalTeams: 10, remainingTeams: fallbackRemaining || 3, hoursUntilTee: 96 };
      return { ...value, occupancyRate: (value.totalTeams - value.remainingTeams) / value.totalTeams, updatedAt: new Date().toISOString() };
    },
    getWeather(courseId) {
      return { ...(weather[courseId] || weather.princess), updatedAt: new Date().toISOString() };
    }
  };
})();
