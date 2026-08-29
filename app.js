"use strict";

// JDY 模块使用的 BLE 服务和特征值 UUID。
const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";

const $ = (id) => document.getElementById(id);
const ui = {
  connectionState: $("connectionState"), connectionText: $("connectionText"),
  connectButton: $("connectButton"), disconnectButton: $("disconnectButton"),
  deviceName: $("deviceName"), message: $("message"),
  distanceGauge: $("distanceGauge"), distanceValue: $("distanceValue"), distanceUnit: $("distanceUnit"),
  obstacleState: $("obstacleState"), obstacleChinese: $("obstacleChinese"), obstacleValue: $("obstacleValue"),
  speedSlider: $("speedSlider"), speedReadout: $("speedReadout"), speedPresets: $("speedPresets"),
  sensorOnButton: $("sensorOnButton"), sensorOffButton: $("sensorOffButton"),
  obstacleOnButton: $("obstacleOnButton"), obstacleOffButton: $("obstacleOffButton"),
  l1Value: $("l1Value"), l2Value: $("l2Value"), r1Value: $("r1Value"), r2Value: $("r2Value"),
  errorValue: $("errorValue"), mlValue: $("mlValue"), mrValue: $("mrValue"),
  deviationValue: $("deviationValue"), deviationDirection: $("deviationDirection"), deviationNeedle: $("deviationNeedle"),
  sensorChart: $("sensorChart"), chartSampleCount: $("chartSampleCount"),
  pauseChartButton: $("pauseChartButton"), clearChartButton: $("clearChartButton"),
  exportCsvButton: $("exportCsvButton"), exportPngButton: $("exportPngButton"),
  aliveIndicator: $("aliveIndicator"), logWindow: $("logWindow"), clearLogButton: $("clearLogButton")
};

let bluetoothDevice = null;
let uartCharacteristic = null;
let receiveBuffer = "";
let aliveTimer = null;
const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();
const DEVIATION_LIMIT = 4000;
const DEVIATION_CENTER_BAND = 100;
const CHART_WINDOW_MS = 60 * 1000;
const CHART_HISTORY_MS = 30 * 60 * 1000;
const sensorHistory = [];
let chartPaused = false;
let chartPausedAt = 0;
let chartDrawPending = false;

const chartSeries = {
  l1: { label: "L1", color: "#23d8ef" },
  l2: { label: "L2", color: "#35e26f" },
  r1: { label: "R1", color: "#ffc247" },
  r2: { label: "R2", color: "#ff6480" }
};

function setMessage(text, isError = false) {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", isError);
}

function setConnected(connected) {
  ui.connectionState.classList.toggle("connected", connected);
  ui.connectionText.textContent = connected ? "已连接" : "未连接";
  ui.connectButton.disabled = connected;
  ui.disconnectButton.disabled = !connected;
  document.querySelectorAll(".control-button, #speedSlider, #speedPresets button")
    .forEach((element) => { element.disabled = !connected; });
}

function addLog(text, kind = "rx") {
  const placeholder = ui.logWindow.querySelector(".muted");
  if (placeholder) placeholder.remove();

  const line = document.createElement("p");
  line.className = kind === "tx" ? "tx" : kind === "error" ? "error-line" : "";
  const prefix = kind === "tx" ? "TX › " : kind === "error" ? "ERR › " : "RX › ";
  line.textContent = prefix + text;
  ui.logWindow.appendChild(line);

  while (ui.logWindow.children.length > 80) ui.logWindow.firstElementChild.remove();
  ui.logWindow.scrollTop = ui.logWindow.scrollHeight;
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    setMessage("当前浏览器不支持网页蓝牙。苹果手机请使用 Bluefy 打开本页。", true);
    addLog("浏览器不支持 Web Bluetooth", "error");
    return;
  }

  try {
    setMessage("正在打开蓝牙设备列表…");
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID]
    });
    bluetoothDevice.addEventListener("gattserverdisconnected", handleDisconnected);

    setMessage("正在连接 " + (bluetoothDevice.name || "蓝牙设备") + "…");
    const server = await bluetoothDevice.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    uartCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

    if (uartCharacteristic.properties.notify || uartCharacteristic.properties.indicate) {
      await uartCharacteristic.startNotifications();
      uartCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
    } else {
      addLog("FFE1 不支持通知，只能发送命令", "error");
    }

    ui.deviceName.textContent = bluetoothDevice.name || "未命名设备";
    setConnected(true);
    setMessage("连接成功，可以控制小车");
    addLog("已连接 " + (bluetoothDevice.name || "未命名设备"));
  } catch (error) {
    if (error.name === "NotFoundError") {
      setMessage("已取消选择蓝牙设备");
      return;
    }
    uartCharacteristic = null;
    setConnected(false);
    setMessage("连接失败：" + error.message, true);
    addLog(error.message, "error");
  }
}

function disconnectBluetooth() {
  if (bluetoothDevice && bluetoothDevice.gatt && bluetoothDevice.gatt.connected) {
    bluetoothDevice.gatt.disconnect();
  } else {
    handleDisconnected();
  }
}

function handleDisconnected() {
  uartCharacteristic = null;
  receiveBuffer = "";
  setConnected(false);
  setMessage("蓝牙已断开");
  addLog("蓝牙已断开", "error");
}

async function sendCommand(command) {
  if (!uartCharacteristic || !bluetoothDevice?.gatt?.connected) {
    setMessage("请先连接蓝牙设备", true);
    return false;
  }

  try {
    const data = encoder.encode(command);
    if (uartCharacteristic.properties.write && uartCharacteristic.writeValueWithResponse) {
      await uartCharacteristic.writeValueWithResponse(data);
    } else if (uartCharacteristic.properties.writeWithoutResponse && uartCharacteristic.writeValueWithoutResponse) {
      await uartCharacteristic.writeValueWithoutResponse(data);
    } else if (uartCharacteristic.writeValue) {
      await uartCharacteristic.writeValue(data);
    } else {
      throw new Error("FFE1 不支持写入");
    }
    addLog(command, "tx");
    setMessage("命令 " + command + " 已发送");
    return true;
  } catch (error) {
    setMessage("发送失败：" + error.message, true);
    addLog(error.message, "error");
    return false;
  }
}

function handleNotification(event) {
  receiveBuffer += decoder.decode(event.target.value, { stream: true });
  receiveBuffer = receiveBuffer.replace(/\r/g, "");

  const lines = receiveBuffer.split("\n");
  receiveBuffer = lines.pop() || "";
  lines.map((line) => line.trim()).filter(Boolean).forEach(processLine);

  // 防止模块长期不发换行符时缓存无限增长。
  if (receiveBuffer.length > 500) {
    processLine(receiveBuffer.trim());
    receiveBuffer = "";
  }
}

function processLine(line) {
  if (!line) return;
  addLog(line);

  const sensorMatch = line.match(/L1\s*=\s*(\d+).*?L2\s*=\s*(\d+).*?R1\s*=\s*(\d+).*?R2\s*=\s*(\d+).*?ERROR\s*=\s*(-?\d+).*?ML\s*=\s*(\d+).*?MR\s*=\s*(\d+)/i);
  if (sensorMatch) {
    const values = sensorMatch.slice(1).map(Number);
    [ui.l1Value.textContent, ui.l2Value.textContent, ui.r1Value.textContent, ui.r2Value.textContent,
      ui.errorValue.textContent, ui.mlValue.textContent, ui.mrValue.textContent] = values.map(String);
    updateDeviation(values[4]);
    recordSensorSample({
      time: Date.now(), l1: values[0], l2: values[1], r1: values[2], r2: values[3], error: values[4]
    });
  }

  const distanceMatch = line.match(/DIST\s*=\s*(OUT|\d+)\s*(?:CM)?/i);
  const obstacleMatch = line.match(/(?:OBSTACLE\s*=\s*|OBSTACLE\s+)(CLEAR|SLOW|STOP)/i);
  const avoidanceMatch = line.match(/(?:AVOID\s*=\s*|OBSTACLE\s+)(ON|OFF)\b/i);
  const sensorModeMatch = line.match(/SENSOR\s+(ON|OFF)\b/i);
  if (distanceMatch) updateDistance(distanceMatch[1]);
  if (obstacleMatch) updateObstacle(obstacleMatch[1].toUpperCase());
  if (avoidanceMatch) selectMode(ui.obstacleOnButton, ui.obstacleOffButton, avoidanceMatch[1].toUpperCase() === "ON");
  if (sensorModeMatch) selectMode(ui.sensorOnButton, ui.sensorOffButton, sensorModeMatch[1].toUpperCase() === "ON");

  if (/CAR\s+ALIVE/i.test(line)) markAlive();
}

function updateDistance(value) {
  const isOut = String(value).toUpperCase() === "OUT";
  ui.distanceValue.textContent = isOut ? "OUT" : value;
  ui.distanceUnit.textContent = isOut ? "" : "cm";
  const numeric = isOut ? 100 : Math.max(0, Math.min(Number(value), 100));
  ui.distanceGauge.style.setProperty("--progress", `${numeric * 3.6}deg`);
}

function updateObstacle(state) {
  const labels = {
    CLEAR: { chinese: "安全", symbol: "✓" },
    SLOW: { chinese: "减速", symbol: "!" },
    STOP: { chinese: "停车", symbol: "■" }
  };
  const selected = labels[state] || { chinese: "未知", symbol: "?" };
  ui.obstacleState.className = "obstacle-state " + state.toLowerCase();
  ui.obstacleState.querySelector(".shield").textContent = selected.symbol;
  ui.obstacleChinese.textContent = selected.chinese;
  ui.obstacleValue.textContent = state;
}

function updateDeviation(error) {
  const numeric = Number(error);
  if (!Number.isFinite(numeric)) return;
  const limited = Math.max(-DEVIATION_LIMIT, Math.min(DEVIATION_LIMIT, numeric));
  const percent = ((limited + DEVIATION_LIMIT) / (DEVIATION_LIMIT * 2)) * 100;
  ui.deviationNeedle.style.left = `${percent}%`;
  ui.deviationNeedle.classList.remove("waiting");
  ui.deviationValue.textContent = numeric > 0 ? `+${numeric}` : String(numeric);
  if (Math.abs(numeric) <= DEVIATION_CENTER_BAND) {
    ui.deviationDirection.textContent = "居中";
    ui.deviationValue.style.color = "var(--green)";
  } else if (numeric < 0) {
    ui.deviationDirection.textContent = "偏左";
    ui.deviationValue.style.color = "var(--cyan)";
  } else {
    ui.deviationDirection.textContent = "偏右";
    ui.deviationValue.style.color = "var(--amber)";
  }
}

function recordSensorSample(sample) {
  sensorHistory.push(sample);
  const oldestAllowed = sample.time - CHART_HISTORY_MS;
  while (sensorHistory.length && sensorHistory[0].time < oldestAllowed) sensorHistory.shift();
  updateChartControls();
  scheduleChartDraw();
}

function updateChartControls() {
  const hasData = sensorHistory.length > 0;
  ui.chartSampleCount.textContent = `${sensorHistory.length} 点`;
  ui.exportCsvButton.disabled = !hasData;
  ui.exportPngButton.disabled = !hasData;
}

function scheduleChartDraw() {
  if (chartDrawPending) return;
  chartDrawPending = true;
  requestAnimationFrame(() => {
    chartDrawPending = false;
    drawSensorChart();
  });
}

function drawSensorChart() {
  const canvas = ui.sensorChart;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(rect.width * dpr);
  const pixelHeight = Math.round(rect.height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  const plot = { left: 43, right: 12, top: 15, bottom: 28 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const windowEnd = chartPaused ? chartPausedAt : Date.now();
  const windowStart = windowEnd - CHART_WINDOW_MS;

  ctx.fillStyle = "#030a12";
  ctx.fillRect(0, 0, width, height);
  ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";

  [0, 1024, 2048, 3072, 4095].forEach((value) => {
    const y = plot.top + plotHeight - (value / 4095) * plotHeight;
    ctx.strokeStyle = "rgba(80,116,150,.23)";
    ctx.beginPath(); ctx.moveTo(plot.left, y); ctx.lineTo(width - plot.right, y); ctx.stroke();
    ctx.fillStyle = "#667b91";
    ctx.textAlign = "right";
    ctx.fillText(String(value), plot.left - 6, y);
  });

  [60, 45, 30, 15, 0].forEach((secondsAgo, index) => {
    const x = plot.left + (index / 4) * plotWidth;
    ctx.strokeStyle = "rgba(80,116,150,.16)";
    ctx.beginPath(); ctx.moveTo(x, plot.top); ctx.lineTo(x, height - plot.bottom); ctx.stroke();
    ctx.fillStyle = "#667b91";
    ctx.textAlign = index === 0 ? "left" : index === 4 ? "right" : "center";
    ctx.fillText(secondsAgo === 0 ? "现在" : `-${secondsAgo}s`, x, height - 12);
  });

  const visible = sensorHistory.filter((point) => point.time >= windowStart && point.time <= windowEnd);
  const enabledSeries = new Set(
    [...document.querySelectorAll('.series-chip input:checked')].map((input) => input.dataset.series)
  );

  if (!visible.length) {
    ctx.fillStyle = "#65798f";
    ctx.font = "13px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("等待传感器数据", plot.left + plotWidth / 2, plot.top + plotHeight / 2);
    return;
  }

  Object.entries(chartSeries).forEach(([key, series]) => {
    if (!enabledSeries.has(key)) return;
    ctx.beginPath();
    visible.forEach((point, index) => {
      const x = plot.left + ((point.time - windowStart) / CHART_WINDOW_MS) * plotWidth;
      const y = plot.top + plotHeight - (point[key] / 4095) * plotHeight;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  });
}

function formatFileTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSensorCsv() {
  if (!sensorHistory.length) return;
  const firstTime = sensorHistory[0].time;
  const rows = ["时间,相对秒,L1,L2,R1,R2,ERROR"];
  sensorHistory.forEach((point) => {
    rows.push([
      new Date(point.time).toISOString(), ((point.time - firstTime) / 1000).toFixed(3),
      point.l1, point.l2, point.r1, point.r2, point.error
    ].join(","));
  });
  const blob = new Blob(["\uFEFF" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `smart-car-sensors-${formatFileTimestamp()}.csv`);
  setMessage(`已导出 ${sensorHistory.length} 条传感器数据`);
}

function exportSensorPng() {
  if (!sensorHistory.length) return;
  drawSensorChart();
  const filename = `smart-car-chart-${formatFileTimestamp()}.png`;
  if (ui.sensorChart.toBlob) {
    ui.sensorChart.toBlob((blob) => {
      if (blob) downloadBlob(blob, filename);
    }, "image/png");
  } else {
    const anchor = document.createElement("a");
    anchor.href = ui.sensorChart.toDataURL("image/png");
    anchor.download = filename;
    anchor.click();
  }
  setMessage("曲线图片已导出");
}

function markAlive() {
  ui.aliveIndicator.textContent = "通信正常";
  ui.aliveIndicator.classList.add("alive");
  clearTimeout(aliveTimer);
  aliveTimer = setTimeout(() => {
    ui.aliveIndicator.textContent = "等待心跳";
    ui.aliveIndicator.classList.remove("alive");
  }, 3500);
}

function selectSpeed(speed) {
  const value = Math.max(1, Math.min(9, Number(speed)));
  ui.speedSlider.value = String(value);
  ui.speedReadout.textContent = `${value * 10}%`;
  ui.speedPresets.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.speed) === value);
  });
}

function selectMode(onButton, offButton, enabled) {
  onButton.classList.toggle("selected", enabled);
  offButton.classList.toggle("selected", !enabled);
}

ui.connectButton.addEventListener("click", connectBluetooth);
ui.disconnectButton.addEventListener("click", disconnectBluetooth);

document.querySelectorAll(".control-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const sent = await sendCommand(button.dataset.command);
    if (!sent) return;
    if (button === ui.sensorOnButton || button === ui.sensorOffButton) {
      selectMode(ui.sensorOnButton, ui.sensorOffButton, button === ui.sensorOnButton);
    }
    if (button === ui.obstacleOnButton || button === ui.obstacleOffButton) {
      selectMode(ui.obstacleOnButton, ui.obstacleOffButton, button === ui.obstacleOnButton);
    }
  });
});

ui.speedSlider.addEventListener("input", () => selectSpeed(ui.speedSlider.value));
ui.speedSlider.addEventListener("change", () => sendCommand(ui.speedSlider.value));
ui.speedPresets.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => {
    selectSpeed(button.dataset.speed);
    sendCommand(button.dataset.speed);
  });
});

ui.clearLogButton.addEventListener("click", () => {
  ui.logWindow.innerHTML = '<p class="muted">日志已清空</p>';
});

document.querySelectorAll(".series-chip input").forEach((input) => {
  input.addEventListener("change", scheduleChartDraw);
});
ui.pauseChartButton.addEventListener("click", () => {
  chartPaused = !chartPaused;
  if (chartPaused) chartPausedAt = Date.now();
  ui.pauseChartButton.textContent = chartPaused ? "继续" : "暂停";
  scheduleChartDraw();
});
ui.clearChartButton.addEventListener("click", () => {
  sensorHistory.length = 0;
  if (chartPaused) chartPausedAt = Date.now();
  updateChartControls();
  scheduleChartDraw();
  setMessage("传感器曲线已清空");
});
ui.exportCsvButton.addEventListener("click", exportSensorCsv);
ui.exportPngButton.addEventListener("click", exportSensorPng);
window.addEventListener("resize", scheduleChartDraw);
setInterval(() => { if (!chartPaused) scheduleChartDraw(); }, 1000);

setConnected(false);
selectSpeed(3);
selectMode(ui.sensorOnButton, ui.sensorOffButton, false);
selectMode(ui.obstacleOnButton, ui.obstacleOffButton, true);
updateChartControls();
scheduleChartDraw();
