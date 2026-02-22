export const CONFIG = {
  seed: 742391,
  instrumentCount: 6200,
  positionCount: 28000,
  marketUpdateBatchSize: 1500,
  marketTickIntervalMs: 90,
  tradeBurstSize: 60,
  tradeIntervalMs: 240,
  publishIntervalMs: 300,
  historyIntervalMs: 1000,
  historyWindowPoints: 3600,
  baseCapital: 1_250_000_000,
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 8080)
  },
  timeframes: {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000
  }
};
