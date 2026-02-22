import { Random } from "../utils/random.js";

const ASSET_CLASSES = ["Equities", "FX", "Rates", "Commodities", "Crypto"];

const DESKS = ["Macro", "Delta One", "Systematic", "Volatility"];

const STRATEGIES = [
  "StatArb",
  "Carry",
  "Trend",
  "RelativeValue",
  "EventDriven",
  "Dispersion",
  "MarketMaking",
  "VolArb",
  "Basis",
  "CrossAssetRV"
];

const PORTFOLIOS = [
  "P-MACRO-CORE",
  "P-MACRO-TACT",
  "P-DELTA-NEUTRAL",
  "P-EQ-LS",
  "P-FX-CARRY",
  "P-VOL-OPP",
  "P-RATES-RV",
  "P-COMM-SPREAD"
];

const TRADERS = [
  { name: "A. Chen", desk: "Delta One" },
  { name: "M. Patel", desk: "Delta One" },
  { name: "J. Rivera", desk: "Delta One" },
  { name: "T. Wilson", desk: "Delta One" },
  { name: "L. Moreau", desk: "Macro" },
  { name: "S. Ibrahim", desk: "Macro" },
  { name: "K. Nakamura", desk: "Macro" },
  { name: "N. Ferreira", desk: "Macro" },
  { name: "R. Singh", desk: "Systematic" },
  { name: "P. Johnson", desk: "Systematic" },
  { name: "E. Park", desk: "Systematic" },
  { name: "D. Rossi", desk: "Systematic" },
  { name: "B. Laurent", desk: "Volatility" },
  { name: "C. Morgan", desk: "Volatility" },
  { name: "I. Haddad", desk: "Volatility" },
  { name: "O. Garcia", desk: "Volatility" }
];

function toAssetPrefix(assetClass) {
  switch (assetClass) {
    case "Equities":
      return "EQ";
    case "FX":
      return "FX";
    case "Rates":
      return "IR";
    case "Commodities":
      return "CM";
    case "Crypto":
      return "CR";
    default:
      return "OT";
  }
}

function priceSeedByAsset(assetClass, random) {
  switch (assetClass) {
    case "Equities":
      return random.float(18, 450);
    case "FX":
      return random.float(0.6, 1.9);
    case "Rates":
      return random.float(80, 140);
    case "Commodities":
      return random.float(35, 180);
    case "Crypto":
      return random.float(200, 68000);
    default:
      return random.float(10, 100);
  }
}

function volatilityByAsset(assetClass, random) {
  switch (assetClass) {
    case "Equities":
      return random.float(0.003, 0.025);
    case "FX":
      return random.float(0.0015, 0.01);
    case "Rates":
      return random.float(0.001, 0.008);
    case "Commodities":
      return random.float(0.002, 0.02);
    case "Crypto":
      return random.float(0.01, 0.08);
    default:
      return random.float(0.002, 0.02);
  }
}

function quantityByAsset(assetClass, random) {
  switch (assetClass) {
    case "Equities":
      return random.int(500, 12000);
    case "FX":
      return random.int(60_000, 2_400_000);
    case "Rates":
      return random.int(80, 2800);
    case "Commodities":
      return random.int(250, 18_000);
    case "Crypto":
      return random.int(2, 350);
    default:
      return random.int(100, 5000);
  }
}

function normalizeNumber(number, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}

export function createUniverse(config) {
  const random = new Random(config.seed);
  const instruments = [];
  const positions = [];

  for (let i = 0; i < config.instrumentCount; i += 1) {
    const assetClass = random.pick(ASSET_CLASSES);
    const base = priceSeedByAsset(assetClass, random);
    const prevClose = base * (1 + random.gaussian(0, 0.01));
    const price = prevClose * (1 + random.gaussian(0, 0.006));
    const symbol = `${toAssetPrefix(assetClass)}-${String(i + 1).padStart(5, "0")}`;

    instruments.push({
      id: i,
      symbol,
      assetClass,
      volatility: volatilityByAsset(assetClass, random),
      price: normalizeNumber(Math.max(price, 0.05), 5),
      prevClose: normalizeNumber(Math.max(prevClose, 0.05), 5),
      lastPrice: normalizeNumber(Math.max(price, 0.05), 5)
    });
  }

  for (let i = 0; i < config.positionCount; i += 1) {
    const instrument = instruments[random.int(0, instruments.length)];
    const trader = random.pick(TRADERS);
    const quantityMagnitude = quantityByAsset(instrument.assetClass, random);
    const signedQuantity = random.next() < 0.5 ? quantityMagnitude : -quantityMagnitude;
    const avgPrice = instrument.price * (1 + random.gaussian(0, 0.03));

    positions.push({
      id: i,
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      assetClass: instrument.assetClass,
      desk: trader.desk,
      trader: trader.name,
      strategy: random.pick(STRATEGIES),
      portfolio: random.pick(PORTFOLIOS),
      quantity: signedQuantity,
      avgPrice: normalizeNumber(Math.max(avgPrice, 0.01), 5),
      realizedTotal: normalizeNumber(random.gaussian(0, 160_000), 2),
      realizedToday: normalizeNumber(random.gaussian(0, 38_000), 2),
      instrumentVolatility: instrument.volatility,
      currentPrice: instrument.price,
      unrealizedPnl: 0,
      dailyPnl: 0,
      cumulativePnl: 0,
      grossExposure: 0,
      netExposure: 0,
      tripleKey: `${trader.desk}|${trader.name}|${instrument.assetClass}`
    });
  }

  return {
    instruments,
    positions,
    taxonomy: {
      assetClasses: ASSET_CLASSES,
      desks: DESKS,
      traders: TRADERS.map((trader) => trader.name),
      strategies: STRATEGIES,
      portfolios: PORTFOLIOS
    }
  };
}
