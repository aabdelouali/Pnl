import { EventEmitter } from "node:events";
import { Random } from "../utils/random.js";

export class MarketDataStream extends EventEmitter {
  constructor(instruments, config) {
    super();
    this.instruments = instruments;
    this.config = config;
    this.random = new Random(config.seed + 191);
    this.timer = null;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      const updates = this.generateMarketBatch();
      this.emit("market", updates);
    }, this.config.marketTickIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  generateMarketBatch() {
    const updates = new Array(this.config.marketUpdateBatchSize);

    for (let i = 0; i < this.config.marketUpdateBatchSize; i += 1) {
      const instrumentId = this.random.int(0, this.instruments.length);
      const instrument = this.instruments[instrumentId];
      const microShock = this.random.gaussian(0, instrument.volatility * 0.18);
      const drift = this.random.gaussian(0, instrument.volatility * 0.04);
      const nextPrice = Math.max(0.01, instrument.price * (1 + microShock + drift));

      updates[i] = {
        instrumentId,
        price: nextPrice
      };
    }

    return updates;
  }
}
