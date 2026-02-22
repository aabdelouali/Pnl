export function createAggregate(label = "") {
  return {
    label,
    realized: 0,
    unrealized: 0,
    daily: 0,
    cumulative: 0,
    grossExposure: 0,
    netExposure: 0,
    positions: 0
  };
}

export function applyDelta(aggregate, delta) {
  aggregate.realized += delta.realized;
  aggregate.unrealized += delta.unrealized;
  aggregate.daily += delta.daily;
  aggregate.cumulative += delta.cumulative;
  aggregate.grossExposure += delta.grossExposure;
  aggregate.netExposure += delta.netExposure;
}

export function standardDeviation(values) {
  if (!values.length) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => {
    const diff = value - mean;
    return sum + diff * diff;
  }, 0) / values.length;
  return Math.sqrt(variance);
}

export function calculateMaxDrawdown(curve) {
  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdown = 0;
  for (const point of curve) {
    if (point.cumulative > peak) {
      peak = point.cumulative;
    }
    if (peak !== Number.NEGATIVE_INFINITY) {
      const drawdown = peak - point.cumulative;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }
  return maxDrawdown;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
