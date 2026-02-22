# Institutional PnL Analytics Platform

Production-style real-time Profit & Loss analytics dashboard inspired by top-tier sell-side and buy-side control towers.

## Capabilities

- Real-time multi-asset PnL engine across **6,200 instruments** and **28,000 positions**.
- Live metrics: realized, unrealized, daily, cumulative PnL; gross/net exposure.
- Streaming risk diagnostics: VaR(95), leverage, Sharpe proxy, volatility, drawdown, concentration, win-rate.
- Interactive filters by **asset class**, **desk**, **trader**, and **timeframe**.
- Institutional visualization layer:
  - dark terminal-grade UI
  - animated performance curve
  - desk x asset PnL heatmap
  - top winners/losers
  - drill-down instrument analytics table
- Low-latency WebSocket fanout with per-client filter subscriptions.

## Architecture

### Backend

- `src/engine/universe.js`
  - generates synthetic institutional universe with realistic cross-asset dynamics
- `src/engine/marketDataStream.js`
  - high-frequency market update batches
- `src/engine/pnlEngine.js`
  - incremental PnL/risk computation
  - trade simulation
  - filtered analytics snapshots
- `src/engine/historyStore.js`
  - rolling time-series store for live performance curves
- `src/server/httpServer.js`
  - APIs (`/api/meta`, `/api/snapshot`, `/api/health`) + static serving
- `src/server/wsHub.js`
  - direct WebSocket upgrade, frame parsing, cached multi-client snapshot broadcast

### Frontend

- `public/index.html`
  - multi-panel institutional dashboard layout
- `public/styles.css`
  - Bloomberg/TradingView style dark theme with accent hierarchy
- `public/app.js`
  - WebSocket client, filter subscriptions, live rendering pipeline, animated canvas chart

## Run

```bash
npm start
```

Then open [http://localhost:8080](http://localhost:8080).

## Notes on scale and extensibility

- The data/compute paths are modular for replacing synthetic feed with Kafka/FIX/market gateways.
- Current in-memory design can be upgraded to sharded workers + external cache/message bus for horizontal scaling.
- Snapshot contract is version-friendly and supports additional filters/dimensions without UI rewrites.
