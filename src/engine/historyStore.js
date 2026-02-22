function parseTripleKey(key) {
  const [desk, trader, assetClass] = key.split("|");
  return { desk, trader, assetClass };
}

export class HistoryStore {
  constructor(capacity) {
    this.capacity = capacity;
    this.head = 0;
    this.size = 0;
    this.version = 0;

    this.timestamps = new Float64Array(capacity);
    this.globalCumulative = new Float64Array(capacity);
    this.globalDaily = new Float64Array(capacity);

    this.tripleSeries = new Map();
    this.keyParts = new Map();
    this.curveCache = new Map();
  }

  ensureSeries(key) {
    if (this.tripleSeries.has(key)) {
      return;
    }

    this.tripleSeries.set(key, {
      cumulative: new Float64Array(this.capacity),
      daily: new Float64Array(this.capacity)
    });

    this.keyParts.set(key, parseTripleKey(key));
  }

  capture(timestamp, totals, tripleAggregates) {
    const index = this.head;

    this.timestamps[index] = timestamp;
    this.globalCumulative[index] = totals.cumulative;
    this.globalDaily[index] = totals.daily;

    for (const key of tripleAggregates.keys()) {
      this.ensureSeries(key);
    }

    for (const [key, series] of this.tripleSeries.entries()) {
      const aggregate = tripleAggregates.get(key);
      series.cumulative[index] = aggregate ? aggregate.cumulative : 0;
      series.daily[index] = aggregate ? aggregate.daily : 0;
    }

    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size += 1;
    }

    this.version += 1;
    this.curveCache.clear();
  }

  resolveMatchingKeys(filters) {
    const assetClass = filters.assetClass || "ALL";
    const desk = filters.desk || "ALL";
    const trader = filters.trader || "ALL";

    const assetAll = assetClass === "ALL";
    const deskAll = desk === "ALL";
    const traderAll = trader === "ALL";

    if (assetAll && deskAll && traderAll) {
      return null;
    }

    const matches = [];
    for (const [key, parts] of this.keyParts.entries()) {
      if (!assetAll && parts.assetClass !== assetClass) {
        continue;
      }
      if (!deskAll && parts.desk !== desk) {
        continue;
      }
      if (!traderAll && parts.trader !== trader) {
        continue;
      }
      matches.push(key);
    }

    return matches;
  }

  getCurve(filters, timeframeMs, now = Date.now()) {
    if (this.size === 0) {
      return [];
    }

    const assetClass = filters.assetClass || "ALL";
    const desk = filters.desk || "ALL";
    const trader = filters.trader || "ALL";

    const cacheKey = `${assetClass}|${desk}|${trader}|${timeframeMs}|${this.version}`;
    const cached = this.curveCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const cutoff = now - timeframeMs;
    const matchingKeys = this.resolveMatchingKeys(filters);
    const curve = [];

    for (let i = 0; i < this.size; i += 1) {
      const index = (this.head - this.size + i + this.capacity) % this.capacity;
      const timestamp = this.timestamps[index];
      if (timestamp < cutoff) {
        continue;
      }

      let cumulative = 0;
      let daily = 0;

      if (matchingKeys === null) {
        cumulative = this.globalCumulative[index];
        daily = this.globalDaily[index];
      } else {
        for (const key of matchingKeys) {
          const series = this.tripleSeries.get(key);
          if (!series) {
            continue;
          }
          cumulative += series.cumulative[index];
          daily += series.daily[index];
        }
      }

      curve.push({ timestamp, cumulative, daily });
    }

    this.curveCache.set(cacheKey, curve);
    return curve;
  }
}
