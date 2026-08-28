(function () {
  const config = window.ALL_GOLF_PRICING_CONFIG;
  const provider = window.ALL_GOLF_REALTIME_PROVIDER;
  const round = value => Math.round(value / config.roundingUnit) * config.roundingUnit;
  const add = (items, rule) => rule && rule.rate !== 0 && items.push({ code: rule.label, label: rule.label, rate: rule.rate });

  function calculate({ course, tee, dateIso }) {
    const availability = provider.getAvailability(course.id, tee.time, tee.remaining);
    const weather = provider.getWeather(course.id, dateIso);
    const adjustments = [];
    if (availability.occupancyRate >= config.occupancy.high.threshold) add(adjustments, config.occupancy.high);
    else if (availability.occupancyRate <= config.occupancy.low.threshold) add(adjustments, config.occupancy.low);
    if (availability.hoursUntilTee <= config.urgency.lastMinute.hours) add(adjustments, config.urgency.lastMinute);
    else if (availability.hoursUntilTee <= config.urgency.soon.hours) add(adjustments, config.urgency.soon);
    add(adjustments, config.weather[weather.condition]);
    const selectedDate = new Date(`${dateIso}T00:00:00`);
    if ([0, 6].includes(selectedDate.getDay())) add(adjustments, config.weekend);
    const rawRate = adjustments.reduce((sum, item) => sum + item.rate, 0);
    const appliedRate = Math.max(config.limits.minRate, Math.min(config.limits.maxRate, rawRate));
    const basePrice = tee.basePrice || tee.price;
    return {
      basePrice, finalPrice: round(basePrice * (1 + appliedRate)), rawRate, appliedRate,
      adjustments, availability, weather, configVersion: config.version,
      calculatedAt: new Date().toISOString(), source: provider.mode
    };
  }

  function lock(input) {
    const result = calculate(input);
    const lockedAt = new Date();
    return { ...result, quoteId: `PQ-${lockedAt.getTime()}-${input.course.id}-${input.tee.time.replace(':', '')}`, lockedAt: lockedAt.toISOString(), expiresAt: new Date(lockedAt.getTime() + config.quoteTtlMinutes * 60000).toISOString() };
  }
  window.ALL_GOLF_PRICING = { calculate, lock, config };
})();
