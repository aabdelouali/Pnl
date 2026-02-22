import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import { MarketDataStream } from "./engine/marketDataStream.js";
import { PnlEngine } from "./engine/pnlEngine.js";
import { createUniverse } from "./engine/universe.js";
import { createHttpServer } from "./server/httpServer.js";
import { WebSocketHub } from "./server/wsHub.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");

const universe = createUniverse(CONFIG);
const pnlEngine = new PnlEngine(universe, CONFIG);
pnlEngine.captureHistory(Date.now());

const marketDataStream = new MarketDataStream(pnlEngine.instruments, CONFIG);
marketDataStream.on("market", (updates) => {
  pnlEngine.applyMarketBatch(updates, Date.now());
});

const tradeTimer = setInterval(() => {
  pnlEngine.simulateTrades(CONFIG.tradeBurstSize, Date.now());
}, CONFIG.tradeIntervalMs);

const historyTimer = setInterval(() => {
  pnlEngine.captureHistory(Date.now());
}, CONFIG.historyIntervalMs);

const server = createHttpServer({ engine: pnlEngine, publicDir });
const wsHub = new WebSocketHub({
  engine: pnlEngine,
  publishIntervalMs: CONFIG.publishIntervalMs
});

wsHub.attach(server);

server.listen(CONFIG.server.port, CONFIG.server.host, () => {
  marketDataStream.start();
  wsHub.start();

  // eslint-disable-next-line no-console
  console.log(
    `[PnL] Live analytics server listening on http://${CONFIG.server.host}:${CONFIG.server.port} | instruments=${pnlEngine.instruments.length} positions=${pnlEngine.positions.length}`
  );
});

function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`\n[PnL] Received ${signal}. Shutting down cleanly...`);
  clearInterval(tradeTimer);
  clearInterval(historyTimer);
  marketDataStream.stop();
  wsHub.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
