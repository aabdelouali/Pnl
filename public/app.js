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
    ctx: dom.curveCanvas.getContext("2d"),
    viewport: null,
    hover: {
      active: false,
      index: -1,
      x: 0,
      y: 0
    }
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
  dom.streamStatus.classList.toggle("status-down", !isLive);
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

function metricTrendClass(value, key) {
  if (key === "grossExposure") {
    return "flat";
  }
  if (value > 0) {
    return "up";
  }
  if (value < 0) {
    return "down";
  }
  return "flat";
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

    const card = element.closest(".metric-card");
    if (card) {
      card.classList.remove("up", "down", "flat");
      card.classList.add(metricTrendClass(value, key));
    }

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
    .map((row) => {
      const barColor =
        row.ratio >= 0.72 ? "var(--negative)" : row.ratio >= 0.45 ? "var(--warning)" : "var(--positive)";

      return `
      <div class="risk-item"> 
        <div class="row">
          <span class="label">${row.label}</span>
          <span class="value">${row.value}</span>
        </div>
        <div class="risk-bar"><span style="width:${Math.round(row.ratio * 100)}%; background:${barColor}"></span></div>
      </div>
    `;
    })
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
      const alpha = 0.16 + intensity * 0.72;
      const background =
        value >= 0 ? `rgba(0, 230, 118, ${alpha})` : `rgba(255, 77, 87, ${alpha})`;
      const borderColor =
        value >= 0
          ? `rgba(0, 230, 118, ${Math.min(0.9, 0.28 + intensity * 0.58)})`
          : `rgba(255, 77, 87, ${Math.min(0.9, 0.28 + intensity * 0.58)})`;

      cellsHtml.push(
        `<div class="hm-cell ${getValueClass(value)}" style="background:${background}; border-color:${borderColor}" title="${desk} ${assetClass}: ${formatSignedCurrency(
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

function setCurveHoverFromPointer(event) {
  const { viewport, values } = state.chart;

  if (!viewport || !values.length) {
    return;
  }

  const rect = dom.curveCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const x = (event.clientX - rect.left) * dpr;
  const y = (event.clientY - rect.top) * dpr;

  if (
    x < viewport.leftPad ||
    x > viewport.width - viewport.rightPad ||
    y < viewport.topPad ||
    y > viewport.height - viewport.bottomPad
  ) {
    state.chart.hover.active = false;
    state.chart.hover.index = -1;
    return;
  }

  const ratio = (x - viewport.leftPad) / Math.max(viewport.plotWidth, 1);
  const rawIndex = Math.round(ratio * (values.length - 1));
  const index = Math.min(values.length - 1, Math.max(0, rawIndex));

  const pointX =
    viewport.leftPad +
    (index / Math.max(values.length - 1, 1)) * viewport.plotWidth;
  const pointY =
    viewport.topPad +
    ((viewport.ceiling - values[index]) / Math.max(viewport.ceiling - viewport.floor, 1e-9)) *
      viewport.plotHeight;

  state.chart.hover.active = true;
  state.chart.hover.index = index;
  state.chart.hover.x = pointX;
  state.chart.hover.y = pointY;
}

function clearCurveHover() {
  state.chart.hover.active = false;
  state.chart.hover.index = -1;
}

function bindCurveHoverEvents() {
  dom.curveCanvas.addEventListener("pointermove", setCurveHoverFromPointer);
  dom.curveCanvas.addEventListener("pointerleave", clearCurveHover);
  dom.curveCanvas.addEventListener("pointercancel", clearCurveHover);
}

function drawRoundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
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
  const dpr = window.devicePixelRatio || 1;
  const leftPad = 54;
  const rightPad = 18;
  const topPad = 20;
  const bottomPad = 30;

  ctx.clearRect(0, 0, width, height);

  if (!values.length) {
    state.chart.viewport = null;
    state.chart.hover.active = false;
    state.chart.hover.index = -1;

    ctx.fillStyle = "rgba(173, 188, 177, 0.65)";
    ctx.font = `${12 * dpr}px IBM Plex Mono, monospace`;
    ctx.fillText("Waiting for stream...", 26, 28);
    return;
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const spread = Math.max(maxValue - minValue, 1);
  const floor = minValue - spread * 0.12;
  const ceiling = maxValue + spread * 0.12;

  const isPositiveCurve = values[values.length - 1] >= values[0];
  const lineColor = isPositiveCurve ? "#00e676" : "#ff4d57";
  const glowColor = isPositiveCurve ? "rgba(0, 230, 118, 0.75)" : "rgba(255, 77, 87, 0.75)";
  const fillTop = isPositiveCurve ? "rgba(0, 230, 118, 0.3)" : "rgba(255, 77, 87, 0.3)";
  const fillBottom = isPositiveCurve ? "rgba(0, 230, 118, 0.03)" : "rgba(255, 77, 87, 0.03)";

  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;

  state.chart.viewport = {
    width,
    height,
    leftPad,
    rightPad,
    topPad,
    bottomPad,
    plotWidth,
    plotHeight,
    floor,
    ceiling
  };

  const xAt = (index) => leftPad + (index / Math.max(values.length - 1, 1)) * plotWidth;
  const yAt = (value) => topPad + ((ceiling - value) / Math.max(ceiling - floor, 1e-9)) * plotHeight;

  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(103, 117, 108, 0.25)";
  for (let i = 0; i < 5; i += 1) {
    const y = topPad + (i / 4) * plotHeight;
    ctx.beginPath();
    ctx.moveTo(leftPad, y);
    ctx.lineTo(width - rightPad, y);
    ctx.stroke();
  }

  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(97, 111, 102, 0.3)";
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
  fillGradient.addColorStop(0, fillTop);
  fillGradient.addColorStop(1, fillBottom);
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

  ctx.strokeStyle = lineColor;
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 10;
  ctx.lineWidth = 2.2;
  ctx.stroke(line);
  ctx.shadowBlur = 0;

  const latestX = xAt(values.length - 1);
  const latestY = yAt(values[values.length - 1]);
  ctx.fillStyle = lineColor;
  ctx.beginPath();
  ctx.arc(latestX, latestY, 3.8, 0, Math.PI * 2);
  ctx.fill();

  const hover = state.chart.hover;
  if (hover.active && hover.index >= 0 && hover.index < values.length) {
    const hoverValue = values[hover.index];
    const hoverTime = timestamps[hover.index];
    const hoverColor = hoverValue >= 0 ? "#00e676" : "#ff4d57";

    ctx.save();

    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(172, 188, 177, 0.45)";
    ctx.beginPath();
    ctx.moveTo(hover.x, topPad);
    ctx.lineTo(hover.x, height - bottomPad);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = hoverColor;
    ctx.beginPath();
    ctx.arc(hover.x, hover.y, 4.2, 0, Math.PI * 2);
    ctx.fill();

    const valueText = formatSignedCurrency(hoverValue);
    const timeText = Number.isFinite(hoverTime)
      ? new Date(hoverTime).toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        })
      : "--:--:--";

    const fontSize = 11 * dpr;
    const lineHeight = 14 * dpr;
    const paddingX = 10 * dpr;
    const paddingY = 8 * dpr;

    ctx.font = `${fontSize}px IBM Plex Mono, monospace`;
    const textWidth = Math.max(ctx.measureText(valueText).width, ctx.measureText(timeText).width);
    const boxWidth = textWidth + paddingX * 2;
    const boxHeight = lineHeight * 2 + paddingY * 2 - 2 * dpr;

    let boxX = hover.x + 12 * dpr;
    let boxY = hover.y - boxHeight - 10 * dpr;

    if (boxX + boxWidth > width - rightPad) {
      boxX = hover.x - boxWidth - 12 * dpr;
    }
    if (boxX < leftPad) {
      boxX = leftPad + 2 * dpr;
    }
    if (boxY < topPad + 2 * dpr) {
      boxY = hover.y + 10 * dpr;
    }
    if (boxY + boxHeight > height - bottomPad) {
      boxY = height - bottomPad - boxHeight - 2 * dpr;
    }

    drawRoundedRectPath(ctx, boxX, boxY, boxWidth, boxHeight, 8 * dpr);
    ctx.fillStyle = "rgba(1, 3, 2, 0.95)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = hoverColor;
    ctx.stroke();

    ctx.fillStyle = hoverColor;
    ctx.fillText(valueText, boxX + paddingX, boxY + paddingY + lineHeight - 3 * dpr);
    ctx.fillStyle = "rgba(194, 206, 198, 0.95)";
    ctx.fillText(timeText, boxX + paddingX, boxY + paddingY + lineHeight * 2 - 3 * dpr);

    ctx.restore();
  }

  ctx.font = `${11 * dpr}px IBM Plex Mono, monospace`;
  ctx.fillStyle = "rgba(201, 214, 204, 0.92)";
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

    ctx.fillStyle = "rgba(151, 166, 156, 0.84)";
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
  bindCurveHoverEvents();
  connectSocket();
  animateCurve();
  window.addEventListener("resize", renderCurve);
}

start();
