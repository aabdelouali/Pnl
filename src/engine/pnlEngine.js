import { performance } from "node:perf_hooks";
import { HistoryStore } from "./historyStore.js";
import { Random } from "../utils/random.js";
import {
  applyDelta,
  calculateMaxDrawdown,
  clamp,
  createAggregate,
  standardDeviation
} from "../utils/metrics.js";

const ALL = "ALL";

function toCompactCurve(curve, maxPoints = 220) {
  if (curve.length <= maxPoints) {
    return curve;
  }
  const sampled = [];
  const stride = (curve.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round(i * stride);
    sampled.push(curve[index]);
  }
  return sampled;
}

function sortedAggregateArray(map, limit = 16) {
  return [...map.values()]
    .sort((a, b) => Math.abs(b.cumulative) - Math.abs(a.cumulative))
    .slice(0, limit);
}

function accumulate(map, key, position) {
  const aggregate = map.get(key) || createAggregate(key);
  aggregate.positions += 1;
  aggregate.realized += position.realizedTotal;
  aggregate.unrealized += position.unrealizedPnl;
  aggregate.daily += position.dailyPnl;
  aggregate.cumulative += position.cumulativePnl;
  aggregate.grossExposure += position.grossExposure;
  aggregate.netExposure += position.netExposure;
  map.set(key, aggregate);
}

function safeNumber(value) {
  if (Number.isFinite(value)) {
    return value;
  }
  return 0;
}

function normalizeFilterValue(value, allowedValues) {
  if (!value || value === ALL) {
    return ALL;
  }
  return allowedValues.includes(value) ? value : ALL;
}

export class PnlEngine {
  constructor(universe, config) {
    this.config = config;
    this.instruments = universe.instruments;
    this.positions = universe.positions;
    this.taxonomy = universe.taxonomy;

    this.random = new Random(config.seed + 7012);
    this.history = new HistoryStore(config.historyWindowPoints);

    this.positionsByInstrument = Array.from({ length: this.instruments.length }, () => []);
    this.tripleAggregates = new Map();
    this.totals = createAggregate("GLOBAL");

    this.stats = {
      startedAt: Date.now(),
      processedMarketUpdates: 0,
      processedTrades: 0,
      lastMarketComputeMs: 0,
      lastTradeComputeMs: 0,
      lastPublishAt: Date.now()
    };

    this.initializeState();
  }

  initializeState() {
    for (const position of this.positions) {
      const instrument = this.instruments[position.instrumentId];
      this.positionsByInstrument[position.instrumentId].push(position.id);

      position.currentPrice = instrument.price;
      this.recomputePositionMetrics(position, instrument);

      this.totals.positions += 1;
      this.totals.realized += position.realizedTotal;
      this.totals.unrealized += position.unrealizedPnl;
      this.totals.daily += position.dailyPnl;
      this.totals.cumulative += position.cumulativePnl;
      this.totals.grossExposure += position.grossExposure;
      this.totals.netExposure += position.netExposure;

      const tripleAggregate = this.tripleAggregates.get(position.tripleKey) || createAggregate(position.tripleKey);
      tripleAggregate.positions += 1;
      tripleAggregate.realized += position.realizedTotal;
      tripleAggregate.unrealized += position.unrealizedPnl;
      tripleAggregate.daily += position.dailyPnl;
      tripleAggregate.cumulative += position.cumulativePnl;
      tripleAggregate.grossExposure += position.grossExposure;
      tripleAggregate.netExposure += position.netExposure;
      this.tripleAggregates.set(position.tripleKey, tripleAggregate);
    }
  }

  recomputePositionMetrics(position, instrument) {
    const markPrice = instrument.price;
    position.currentPrice = markPrice;
    position.unrealizedPnl = (markPrice - position.avgPrice) * position.quantity;
    position.dailyPnl = (markPrice - instrument.prevClose) * position.quantity + position.realizedToday;
    position.cumulativePnl = position.realizedTotal + position.unrealizedPnl;
    position.grossExposure = Math.abs(position.quantity * markPrice);
    position.netExposure = position.quantity * markPrice;
  }

  applyPositionDelta(position, delta) {
    applyDelta(this.totals, delta);
    const tripleAggregate = this.tripleAggregates.get(position.tripleKey);
    if (tripleAggregate) {
      applyDelta(tripleAggregate, delta);
    }
  }

  applyMarketBatch(updates, now = Date.now()) {
    const started = performance.now();

    const deduplicated = new Map();
    for (const update of updates) {
      deduplicated.set(update.instrumentId, update.price);
    }

    for (const [instrumentId, rawPrice] of deduplicated.entries()) {
      const instrument = this.instruments[instrumentId];
      if (!instrument) {
        continue;
      }

      instrument.lastPrice = instrument.price;
      instrument.price = Math.max(rawPrice, 0.01);

      const linkedPositions = this.positionsByInstrument[instrumentId];
      for (const positionId of linkedPositions) {
        const position = this.positions[positionId];

        const previousUnrealized = position.unrealizedPnl;
        const previousDaily = position.dailyPnl;
        const previousCumulative = position.cumulativePnl;
        const previousGross = position.grossExposure;
        const previousNet = position.netExposure;

        this.recomputePositionMetrics(position, instrument);

        const delta = {
          realized: 0,
          unrealized: position.unrealizedPnl - previousUnrealized,
          daily: position.dailyPnl - previousDaily,
          cumulative: position.cumulativePnl - previousCumulative,
          grossExposure: position.grossExposure - previousGross,
          netExposure: position.netExposure - previousNet
        };

        this.applyPositionDelta(position, delta);
      }
    }

    this.stats.processedMarketUpdates += updates.length;
    this.stats.lastMarketComputeMs = performance.now() - started;
    this.stats.lastPublishAt = now;
  }

  simulateTrades(count, now = Date.now()) {
    const started = performance.now();

    for (let i = 0; i < count; i += 1) {
      const positionId = this.random.int(0, this.positions.length);
      const position = this.positions[positionId];
      const instrument = this.instruments[position.instrumentId];

      const absQuantity = Math.max(1, Math.abs(position.quantity));
      const sizeCap = Math.max(1, Math.floor(absQuantity * 0.12));
      let quantityDelta = this.random.int(-sizeCap, sizeCap + 1);

      if (quantityDelta === 0) {
        quantityDelta = this.random.next() > 0.5 ? 1 : -1;
      }

      const tradePrice = Math.max(
        0.01,
        instrument.price * (1 + this.random.gaussian(0, Math.max(instrument.volatility * 0.08, 0.0001)))
      );

      this.applyTradeToPosition(position, quantityDelta, tradePrice, instrument);
    }

    this.stats.processedTrades += count;
    this.stats.lastTradeComputeMs = performance.now() - started;
    this.stats.lastPublishAt = now;
  }

  applyTradeToPosition(position, quantityDelta, tradePrice, instrument) {
    if (!quantityDelta) {
      return;
    }

    const previousRealized = position.realizedTotal;
    const previousUnrealized = position.unrealizedPnl;
    const previousDaily = position.dailyPnl;
    const previousCumulative = position.cumulativePnl;
    const previousGross = position.grossExposure;
    const previousNet = position.netExposure;

    const q0 = position.quantity;
    const a0 = position.avgPrice;
    let q1 = q0 + quantityDelta;
    let realizedChange = 0;

    if (q0 === 0 || Math.sign(q0) === Math.sign(quantityDelta)) {
      if (q1 !== 0) {
        position.avgPrice = ((q0 * a0) + (quantityDelta * tradePrice)) / q1;
      } else {
        position.avgPrice = tradePrice;
      }
    } else {
      const closedAmount = Math.min(Math.abs(q0), Math.abs(quantityDelta));
      if (q0 > 0 && quantityDelta < 0) {
        realizedChange = closedAmount * (tradePrice - a0);
      } else if (q0 < 0 && quantityDelta > 0) {
        realizedChange = closedAmount * (a0 - tradePrice);
      }

      if (q1 === 0 || Math.sign(q1) !== Math.sign(q0)) {
        position.avgPrice = tradePrice;
      }
    }

    if (!Number.isFinite(q1)) {
      q1 = 0;
    }

    position.quantity = q1;
    position.realizedTotal += realizedChange;
    position.realizedToday += realizedChange;

    this.recomputePositionMetrics(position, instrument);

    const delta = {
      realized: position.realizedTotal - previousRealized,
      unrealized: position.unrealizedPnl - previousUnrealized,
      daily: position.dailyPnl - previousDaily,
      cumulative: position.cumulativePnl - previousCumulative,
      grossExposure: position.grossExposure - previousGross,
      netExposure: position.netExposure - previousNet
    };

    this.applyPositionDelta(position, delta);
  }

  captureHistory(now = Date.now()) {
    this.history.capture(now, this.totals, this.tripleAggregates);
  }

  getMeta() {
    return {
      filters: {
        assetClasses: [ALL, ...this.taxonomy.assetClasses],
        desks: [ALL, ...this.taxonomy.desks],
        traders: [ALL, ...this.taxonomy.traders]
      },
      timeframes: Object.keys(this.config.timeframes),
      stats: this.getSystemStats()
    };
  }

  matchesFilters(position, filters) {
    if (filters.assetClass !== ALL && position.assetClass !== filters.assetClass) {
      return false;
    }
    if (filters.desk !== ALL && position.desk !== filters.desk) {
      return false;
    }
    if (filters.trader !== ALL && position.trader !== filters.trader) {
      return false;
    }
    return true;
  }

  getSystemStats() {
    const seconds = Math.max((Date.now() - this.stats.startedAt) / 1000, 1);
    return {
      instruments: this.instruments.length,
      positions: this.positions.length,
      updatesPerSecond: this.stats.processedMarketUpdates / seconds,
      tradesPerSecond: this.stats.processedTrades / seconds,
      lastMarketComputeMs: this.stats.lastMarketComputeMs,
      lastTradeComputeMs: this.stats.lastTradeComputeMs
    };
  }

  getSnapshot(rawFilters = {}) {
    const filters = {
      assetClass: normalizeFilterValue(rawFilters.assetClass, this.taxonomy.assetClasses),
      desk: normalizeFilterValue(rawFilters.desk, this.taxonomy.desks),
      trader: normalizeFilterValue(rawFilters.trader, this.taxonomy.traders),
      timeframe: this.config.timeframes[rawFilters.timeframe] ? rawFilters.timeframe : "15m"
    };

    const summary = createAggregate("FILTERED");
    const byAsset = new Map();
    const byDesk = new Map();
    const byTrader = new Map();
    const byPortfolio = new Map();
    const byStrategy = new Map();

    const deskAssetContribution = new Map();
    const instrumentsAggregate = new Map();

    const exposures = [];
    const filteredInstrumentSet = new Set();

    let positiveDailyCount = 0;
    let varianceAccumulator = 0;

    for (const position of this.positions) {
      if (!this.matchesFilters(position, filters)) {
        continue;
      }

      summary.positions += 1;
      summary.realized += position.realizedTotal;
      summary.unrealized += position.unrealizedPnl;
      summary.daily += position.dailyPnl;
      summary.cumulative += position.cumulativePnl;
      summary.grossExposure += position.grossExposure;
      summary.netExposure += position.netExposure;

      if (position.dailyPnl >= 0) {
        positiveDailyCount += 1;
      }

      const absExposure = Math.abs(position.netExposure);
      exposures.push(absExposure);
      varianceAccumulator += (absExposure * position.instrumentVolatility) ** 2;
      filteredInstrumentSet.add(position.instrumentId);

      accumulate(byAsset, position.assetClass, position);
      accumulate(byDesk, position.desk, position);
      accumulate(byTrader, position.trader, position);
      accumulate(byPortfolio, position.portfolio, position);
      accumulate(byStrategy, position.strategy, position);

      const heatmapKey = `${position.desk}|${position.assetClass}`;
      deskAssetContribution.set(
        heatmapKey,
        (deskAssetContribution.get(heatmapKey) || 0) + position.dailyPnl
      );

      const instrumentAggregate = instrumentsAggregate.get(position.instrumentId) || {
        symbol: position.symbol,
        assetClass: position.assetClass,
        quantity: 0,
        positions: 0,
        daily: 0,
        cumulative: 0,
        notional: 0,
        mark: position.currentPrice
      };

      instrumentAggregate.quantity += position.quantity;
      instrumentAggregate.positions += 1;
      instrumentAggregate.daily += position.dailyPnl;
      instrumentAggregate.cumulative += position.cumulativePnl;
      instrumentAggregate.notional += position.grossExposure;
      instrumentAggregate.mark = position.currentPrice;
      instrumentsAggregate.set(position.instrumentId, instrumentAggregate);
    }

    const timeframeMs = this.config.timeframes[filters.timeframe];
    const now = Date.now();
    const fullCurve = this.history.getCurve(filters, timeframeMs, now);
    const curve = toCompactCurve(fullCurve, 240);

    const curveReturns = [];
    for (let i = 1; i < curve.length; i += 1) {
      const diff = curve[i].cumulative - curve[i - 1].cumulative;
      curveReturns.push(diff / this.config.baseCapital);
    }

    const returnStd = standardDeviation(curveReturns);
    const returnMean = curveReturns.length
      ? curveReturns.reduce((sum, value) => sum + value, 0) / curveReturns.length
      : 0;

    const maxDrawdown = calculateMaxDrawdown(curve);
    const leverage = summary.grossExposure / Math.max(this.config.baseCapital + summary.cumulative, 1);
    const var95 = 1.65 * Math.sqrt(varianceAccumulator);

    exposures.sort((a, b) => b - a);
    const topTenExposure = exposures.slice(0, 10).reduce((sum, value) => sum + value, 0);
    const concentration = summary.grossExposure > 0 ? topTenExposure / summary.grossExposure : 0;

    const instrumentRows = [...instrumentsAggregate.values()].sort(
      (a, b) => Math.abs(b.daily) - Math.abs(a.daily)
    );

    const winners = [...instrumentRows]
      .sort((a, b) => b.daily - a.daily)
      .slice(0, 8);
    const losers = [...instrumentRows]
      .sort((a, b) => a.daily - b.daily)
      .slice(0, 8);

    const visibleDesks = filters.desk === ALL ? this.taxonomy.desks : [filters.desk];
    const visibleAssets = filters.assetClass === ALL ? this.taxonomy.assetClasses : [filters.assetClass];

    const heatmapCells = [];
    for (const desk of visibleDesks) {
      for (const assetClass of visibleAssets) {
        const key = `${desk}|${assetClass}`;
        heatmapCells.push({
          desk,
          assetClass,
          daily: deskAssetContribution.get(key) || 0
        });
      }
    }

    const dailyWinRate = summary.positions > 0 ? positiveDailyCount / summary.positions : 0;

    return {
      timestamp: now,
      filters,
      summary: {
        realized: safeNumber(summary.realized),
        unrealized: safeNumber(summary.unrealized),
        daily: safeNumber(summary.daily),
        cumulative: safeNumber(summary.cumulative),
        grossExposure: safeNumber(summary.grossExposure),
        netExposure: safeNumber(summary.netExposure),
        positionCount: summary.positions,
        instrumentCount: filteredInstrumentSet.size
      },
      risk: {
        var95: safeNumber(var95),
        leverage: safeNumber(leverage),
        sharpe: safeNumber(returnStd > 0 ? (returnMean / returnStd) * Math.sqrt(252) : 0),
        volatility: safeNumber(returnStd * Math.sqrt(252)),
        maxDrawdown: safeNumber(maxDrawdown),
        concentration: safeNumber(clamp(concentration, 0, 1)),
        winRate: safeNumber(clamp(dailyWinRate, 0, 1))
      },
      breakdowns: {
        assets: sortedAggregateArray(byAsset, 12),
        desks: sortedAggregateArray(byDesk, 12),
        traders: sortedAggregateArray(byTrader, 16),
        portfolios: sortedAggregateArray(byPortfolio, 8),
        strategies: sortedAggregateArray(byStrategy, 10)
      },
      heatmap: {
        rows: visibleDesks,
        columns: visibleAssets,
        cells: heatmapCells
      },
      curve,
      contributors: {
        winners,
        losers
      },
      drilldown: instrumentRows.slice(0, 40),
      system: this.getSystemStats()
    };
  }
}
