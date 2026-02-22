const dom = {
  assetFilter: document.getElementById("assetFilter"),
  deskFilter: document.getElementById("deskFilter"),
  traderFilter: document.getElementById("traderFilter"),
  timeframeFilter: document.getElementById("timeframeFilter"),
  streamStatus: document.getElementById("streamStatus"),
  latencyValue: document.getElementById("latencyValue"),
  serverTime: document.getElementById("serverTime"),
  throughput: document.getElementById("throughput"),
  metaInstruments: document.getElementById("metaInstruments"),
  metaPositions: document.getElementById("metaPositions"),
  metaTradesPerSec: document.getElementById("metaTradesPerSec"),
  metaCompute: document.getElementById("metaCompute"),
  riskGrid: document.getElementById("riskGrid"),
  heatmap: document.getElementById("heatmap"),
  winnersList: document.getElementById("winnersList"),
  losersList: document.getElementById("losersList"),
  drilldownBody: document.getElementById("drilldownBody"),
  instrumentSearch: document.getElementById("instrumentSearch"),
  instrumentDetails: document.getElementById("instrumentDetails"),
  summaryCards: document.getElementById("summaryCards"),
  curveCanvas: document.getElementById("curveCanvas")
};

const metricElements = {
  realized: document.querySelector("[data-metric='realized']"),
  unrealized: document.querySelector("[data-metric='unrealized']"),
  daily: document.querySelector("[data-metric='daily']"),
  cumulative: document.querySelector("[data-metric='cumulative']"),
  grossExposure: document.querySelector("[data-metric='grossExposure']"),
  netExposure: document.querySelector("[data-metric='netExposure']")
};

const state = {
  filters: {
    assetClass: "ALL",
    desk: "ALL",
    trader: "ALL",
    timeframe: "15m"
  },
  previousMetrics: {},
  socket: null,
  reconnectTimer: null,
  latestSnapshot: null,
  rowLookup: new Map(),
  chart: {
    values: [],
    target: [],
    timestamps: [],
    ctx: dom.curveCanvas.getContext("2d")
  }
};

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 2
});

function formatSignedCurrency(value) {
  const abs = Math.abs(value);
  const compact = new Intl.NumberFormat("en-US", {
    notation: abs >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: abs >= 1_000_000 ? 2 : 0
  }).format(abs);
  return `${value >= 0 ? "+" : "-"}$${compact}`;
}

function formatCurrency(value) {
  const abs = Math.abs(value);
  const compact = new Intl.NumberFormat("en-US", {
    notation: abs >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: abs >= 1_000_000 ? 2 : 0
  }).format(abs);
  return `$${compact}`;
}

function setConnectionStatus(status, isLive) {
  dom.streamStatus.textContent = status;
  dom.streamStatus.classList.toggle("status-live", isLive);
}

function populateSelect(select, values) {
  select.innerHTML = "";
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
}

async function bootstrapFilters() {
  try {
    const response = await fetch("/api/meta", { cache: "no-store" });
    const meta = await response.json();

    populateSelect(dom.assetFilter, meta.filters.assetClasses);
    populateSelect(dom.deskFilter, meta.filters.desks);
    populateSelect(dom.traderFilter, meta.filters.traders);
    populateSelect(dom.timeframeFilter, meta.timeframes);

    dom.assetFilter.value = state.filters.assetClass;
    dom.deskFilter.value = state.filters.desk;
    dom.traderFilter.value = state.filters.trader;
    dom.timeframeFilter.value = state.filters.timeframe;

    renderEngineStats(meta.stats);
  } catch {
    setConnectionStatus("META ERROR", false);
  }
}

function bindFilterEvents() {
  const handler = () => {
    state.filters = {
      assetClass: dom.assetFilter.value,
      desk: dom.deskFilter.value,
      trader: dom.traderFilter.value,
      timeframe: dom.timeframeFilter.value
    };
    sendSubscription();
  };

  dom.assetFilter.addEventListener("change", handler);
  dom.deskFilter.addEventListener("change", handler);
  dom.traderFilter.addEventListener("change", handler);
  dom.timeframeFilter.addEventListener("change", handler);

  dom.instrumentSearch.addEventListener("input", () => {
    renderDrilldownRows(state.latestSnapshot?.drilldown || []);
  });

  dom.drilldownBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-symbol]");
    if (!row) {
      return;
    }

    const symbol = row.dataset.symbol;
    const data = state.rowLookup.get(symbol);
    if (!data) {
      return;
    }

    dom.instrumentDetails.innerHTML = [
      `<strong>${data.symbol}</strong>`,
      `<span class="${getValueClass(data.daily)}">Daily ${formatSignedCurrency(data.daily)}</span>`,
      `<span class="${getValueClass(data.cumulative)}">Cumulative ${formatSignedCurrency(data.cumulative)}</span>`,
      `<span>Notional ${formatCurrency(data.notional)}</span>`,
      `<span>Open Qty ${numberFormatter.format(data.quantity)}</span>`
    ].join(" | ");
  });
}

function sendSubscription() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  state.socket.send(
    JSON.stringify({
      type: "subscribe",
      filters: state.filters
    })
  );
}

function connectSocket() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  setConnectionStatus("CONNECTING", false);

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  state.socket = socket;

  socket.addEventListener("open", () => {
    setConnectionStatus("LIVE", true);
    sendSubscription();
  });

  socket.addEventListener("close", () => {
    setConnectionStatus("RECONNECTING", false);
    state.reconnectTimer = setTimeout(connectSocket, 1200);
  });

  socket.addEventListener("error", () => {
    setConnectionStatus("DEGRADED", false);
  });

  socket.addEventListener("message", (event) => {
    const message = safeParse(event.data);
    if (!message) {
      return;
    }

    if (message.type === "snapshot") {
      renderSnapshot(message.payload);
    }

    if (message.type === "connection" && message.meta?.stats) {
      renderEngineStats(message.meta.stats);
    }
  });
}

function safeParse(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function getValueClass(value) {
  if (value > 0) {
    return "positive";
  }
  if (value < 0) {
    return "negative";
  }
  return "neutral";
}

function pulseMetricCard(key) {
  const card = metricElements[key]?.closest(".metric-card");
  if (!card) {
    return;
  }
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
}

function renderSummary(summary) {
  for (const key of Object.keys(metricElements)) {
    const value = summary[key] || 0;
    const element = metricElements[key];
    const previous = state.previousMetrics[key];

    element.textContent =
      key === "grossExposure" ? formatCurrency(value) : formatSignedCurrency(value);

    element.classList.remove("positive", "negative", "neutral");
    element.classList.add(getValueClass(value));

    if (previous !== undefined) {
      const delta = Math.abs(value - previous);
      if (delta > Math.max(5000, Math.abs(previous) * 0.005)) {
        pulseMetricCard(key);
      }
    }

    state.previousMetrics[key] = value;
  }
}

function renderRisk(risk, summary) {
  const rows = [
    {
      label: "VaR (95%)",
      value: formatCurrency(risk.var95),
      ratio: Math.min(risk.var95 / Math.max(summary.grossExposure * 0.14, 1), 1)
    },
    {
      label: "Leverage",
      value: `${risk.leverage.toFixed(2)}x`,
      ratio: Math.min(risk.leverage / 4, 1)
    },
    {
      label: "Sharpe",
      value: risk.sharpe.toFixed(2),
      ratio: Math.min(Math.abs(risk.sharpe) / 4, 1)
    },
    {
      label: "Volatility",
      value: percentFormatter.format(risk.volatility),
      ratio: Math.min(risk.volatility / 0.4, 1)
    },
    {
      label: "Max Drawdown",
      value: formatCurrency(risk.maxDrawdown),
      ratio: Math.min(risk.maxDrawdown / Math.max(summary.grossExposure * 0.09, 1), 1)
    },
    {
      label: "Concentration",
      value: percentFormatter.format(risk.concentration),
      ratio: Math.min(risk.concentration, 1)
    },
    {
      label: "Win Rate",
      value: percentFormatter.format(risk.winRate),
      ratio: Math.min(risk.winRate, 1)
    }
  ];

  dom.riskGrid.innerHTML = rows
    .map(
      (row) => `
      <div class="risk-item">
        <div class="row">
          <span class="label">${row.label}</span>
          <span class="value">${row.value}</span>
        </div>
        <div class="risk-bar"><span style="width:${Math.round(row.ratio * 100)}%"></span></div>
      </div>
    `
    )
    .join("");
}

function renderContributors(contributors) {
  const renderList = (list, element) => {
    element.innerHTML = list
      .map(
        (item) => `
      <li>
        <span>${item.symbol}</span>
        <strong class="${getValueClass(item.daily)}">${formatSignedCurrency(item.daily)}</strong>
      </li>
    `
      )
      .join("");
  };

  renderList(contributors.winners || [], dom.winnersList);
  renderList(contributors.losers || [], dom.losersList);
}

function renderHeatmap(heatmap) {
  const rows = heatmap.rows || [];
  const columns = heatmap.columns || [];
  const cells = heatmap.cells || [];

  dom.heatmap.style.setProperty("--cols", String(columns.length));

  const map = new Map();
  let maxAbs = 0;
  for (const cell of cells) {
    map.set(`${cell.desk}|${cell.assetClass}`, cell.daily);
    maxAbs = Math.max(maxAbs, Math.abs(cell.daily));
  }

  const blocks = [];
  const header = [`<div class="hm-label"></div>`]
    .concat(columns.map((column) => `<div class="hm-col-label">${column}</div>`))
    .join("");
  blocks.push(`<div class="heatmap-row">${header}</div>`);

  for (const desk of rows) {
    const cellsHtml = [`<div class="hm-label">${desk}</div>`];

    for (const assetClass of columns) {
      const value = map.get(`${desk}|${assetClass}`) || 0;
      const intensity = maxAbs > 0 ? Math.abs(value) / maxAbs : 0;
      const hue = value >= 0 ? 154 : 349;
      const lightness = 20 + intensity * 34;
      const alpha = 0.28 + intensity * 0.62;
      const background = `hsla(${hue}, 74%, ${lightness}%, ${alpha})`;

      cellsHtml.push(
        `<div class="hm-cell ${getValueClass(value)}" style="background:${background}" title="${desk} ${assetClass}: ${formatSignedCurrency(
          value
        )}">${formatSignedCurrency(value)}</div>`
      );
    }

    blocks.push(`<div class="heatmap-row">${cellsHtml.join("")}</div>`);
  }

  dom.heatmap.innerHTML = blocks.join("");
}

function renderDrilldownRows(rows) {
  const search = dom.instrumentSearch.value.trim().toUpperCase();
  const visibleRows = rows.filter((row) => row.symbol.includes(search));

  state.rowLookup = new Map(visibleRows.map((row) => [row.symbol, row]));

  dom.drilldownBody.innerHTML = visibleRows
    .slice(0, 40)
    .map(
      (row) => `
      <tr data-symbol="${row.symbol}">
        <td>${row.symbol}</td>
        <td>${row.assetClass}</td>
        <td>${numberFormatter.format(row.quantity)}</td>
        <td class="${getValueClass(row.daily)}">${formatSignedCurrency(row.daily)}</td>
        <td class="${getValueClass(row.cumulative)}">${formatSignedCurrency(row.cumulative)}</td>
        <td>${formatCurrency(row.notional)}</td>
      </tr>
    `
    )
    .join("");

  if (!visibleRows.length) {
    dom.instrumentDetails.textContent = "No instruments match current search and filters.";
  }
}

function normalizeCurve(curve, points = 180) {
  if (!curve || curve.length === 0) {
    return { values: [], timestamps: [] };
  }

  if (curve.length === 1) {
    return {
      values: Array(points).fill(curve[0].cumulative),
      timestamps: Array(points).fill(curve[0].timestamp)
    };
  }

  const values = [];
  const timestamps = [];

  for (let i = 0; i < points; i += 1) {
    const position = (i / (points - 1)) * (curve.length - 1);
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(Math.ceil(position), curve.length - 1);
    const blend = position - leftIndex;

    const leftPoint = curve[leftIndex];
    const rightPoint = curve[rightIndex];

    values.push(leftPoint.cumulative + (rightPoint.cumulative - leftPoint.cumulative) * blend);
    timestamps.push(leftPoint.timestamp + (rightPoint.timestamp - leftPoint.timestamp) * blend);
  }

  return { values, timestamps };
}

function resizeCanvas() {
  const canvas = dom.curveCanvas;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  const width = Math.floor(rect.width * dpr);
  const height = Math.floor(rect.height * dpr);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function renderCurve() {
  const { ctx, values, timestamps } = state.chart;
  const canvas = dom.curveCanvas;

  if (!ctx) {
    return;
  }

  resizeCanvas();

  const width = canvas.width;
  const height = canvas.height;
  const leftPad = 54;
  const rightPad = 18;
  const topPad = 20;
  const bottomPad = 30;

  ctx.clearRect(0, 0, width, height);

  if (!values.length) {
    ctx.fillStyle = "rgba(142, 163, 204, 0.6)";
    ctx.font = `${12 * (window.devicePixelRatio || 1)}px IBM Plex Mono, monospace`;
    ctx.fillText("Waiting for stream...", 26, 28);
    return;
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const spread = Math.max(maxValue - minValue, 1);
  const floor = minValue - spread * 0.12;
  const ceiling = maxValue + spread * 0.12;

  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;

  const xAt = (index) => leftPad + (index / (values.length - 1)) * plotWidth;
  const yAt = (value) => topPad + ((ceiling - value) / (ceiling - floor)) * plotHeight;

  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(130, 160, 214, 0.2)";
  for (let i = 0; i < 5; i += 1) {
    const y = topPad + (i / 4) * plotHeight;
    ctx.beginPath();
    ctx.moveTo(leftPad, y);
    ctx.lineTo(width - rightPad, y);
    ctx.stroke();
  }

  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(130, 160, 214, 0.18)";
  ctx.beginPath();
  ctx.moveTo(leftPad, topPad);
  ctx.lineTo(leftPad, height - bottomPad);
  ctx.lineTo(width - rightPad, height - bottomPad);
  ctx.stroke();

  const area = new Path2D();
  values.forEach((value, index) => {
    const x = xAt(index);
    const y = yAt(value);
    if (index === 0) {
      area.moveTo(x, y);
    } else {
      area.lineTo(x, y);
    }
  });
  area.lineTo(xAt(values.length - 1), height - bottomPad);
  area.lineTo(xAt(0), height - bottomPad);
  area.closePath();

  const fillGradient = ctx.createLinearGradient(0, topPad, 0, height - bottomPad);
  fillGradient.addColorStop(0, "rgba(53, 204, 255, 0.35)");
  fillGradient.addColorStop(1, "rgba(53, 204, 255, 0.02)");
  ctx.fillStyle = fillGradient;
  ctx.fill(area);

  const line = new Path2D();
  values.forEach((value, index) => {
    const x = xAt(index);
    const y = yAt(value);
    if (index === 0) {
      line.moveTo(x, y);
    } else {
      line.lineTo(x, y);
    }
  });

  ctx.strokeStyle = "#35ccff";
  ctx.shadowColor = "rgba(53, 204, 255, 0.8)";
  ctx.shadowBlur = 10;
  ctx.lineWidth = 2.2;
  ctx.stroke(line);
  ctx.shadowBlur = 0;

  const latestX = xAt(values.length - 1);
  const latestY = yAt(values[values.length - 1]);
  ctx.fillStyle = "#7df5ff";
  ctx.beginPath();
  ctx.arc(latestX, latestY, 3.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = `${11 * (window.devicePixelRatio || 1)}px IBM Plex Mono, monospace`;
  ctx.fillStyle = "rgba(195, 214, 247, 0.9)";
  ctx.fillText(formatSignedCurrency(maxValue), 8, topPad + 6);
  ctx.fillText(formatSignedCurrency(minValue), 8, height - bottomPad);

  if (timestamps.length >= 2) {
    const leftLabel = new Date(timestamps[0]).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit"
    });

    const rightLabel = new Date(timestamps[timestamps.length - 1]).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit"
    });

    ctx.fillStyle = "rgba(140, 164, 211, 0.8)";
    ctx.fillText(leftLabel, leftPad, height - 8);

    const rightWidth = ctx.measureText(rightLabel).width;
    ctx.fillText(rightLabel, width - rightPad - rightWidth, height - 8);
  }
}

function animateCurve() {
  const current = state.chart.values;
  const target = state.chart.target;

  if (target.length) {
    if (current.length !== target.length) {
      state.chart.values = [...target];
    } else {
      for (let i = 0; i < target.length; i += 1) {
        current[i] += (target[i] - current[i]) * 0.16;
      }
    }
  }

  renderCurve();
  window.requestAnimationFrame(animateCurve);
}

function renderEngineStats(system) {
  if (!system) {
    return;
  }

  dom.metaInstruments.textContent = numberFormatter.format(system.instruments || 0);
  dom.metaPositions.textContent = numberFormatter.format(system.positions || 0);
  dom.metaTradesPerSec.textContent = (system.tradesPerSecond || 0).toFixed(1);
  dom.metaCompute.textContent = `${(system.lastMarketComputeMs || 0).toFixed(1)} ms`;
  dom.throughput.textContent = `${(system.updatesPerSecond || 0).toFixed(0)} upd/s`;
}

function renderSnapshot(snapshot) {
  state.latestSnapshot = snapshot;

  const latency = Math.max(0, Date.now() - snapshot.timestamp);
  dom.latencyValue.textContent = `${latency} ms`;
  dom.serverTime.textContent = new Date(snapshot.timestamp).toLocaleTimeString("en-US", {
    hour12: false
  });

  renderSummary(snapshot.summary);
  renderRisk(snapshot.risk, snapshot.summary);
  renderHeatmap(snapshot.heatmap);
  renderContributors(snapshot.contributors);
  renderDrilldownRows(snapshot.drilldown || []);
  renderEngineStats(snapshot.system);

  const normalized = normalizeCurve(snapshot.curve, 180);
  state.chart.target = normalized.values;
  state.chart.timestamps = normalized.timestamps;
}

function start() {
  bootstrapFilters();
  bindFilterEvents();
  connectSocket();
  animateCurve();
  window.addEventListener("resize", renderCurve);
}

start();
