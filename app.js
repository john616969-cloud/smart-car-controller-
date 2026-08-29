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
  ldValue: $("ldValue"), rdValue: $("rdValue"), lsValue: $("lsValue"), rsValue: $("rsValue"),
  crossroadState: $("crossroadState"), crossroadValue: $("crossroadValue"),
  deviationValue: $("deviationValue"), deviationDirection: $("deviationDirection"), deviationNeedle: $("deviationNeedle"),
  sensorChart: $("sensorChart"), chartSampleCount: $("chartSampleCount"),
  pauseChartButton: $("pauseChartButton"), returnLiveButton: $("returnLiveButton"), clearChartButton: $("clearChartButton"),
  chartRangeLabel: $("chartRangeLabel"), chartViewStatus: $("chartViewStatus"),
  exportCsvButton: $("exportCsvButton"), exportPngButton: $("exportPngButton"),
  exportReportButton: $("exportReportButton"), exportModal: $("exportModal"),
  exportModalTitle: $("exportModalTitle"), exportHelp: $("exportHelp"),
  exportImage: $("exportImage"), exportText: $("exportText"),
  shareExportButton: $("shareExportButton"), copyExportButton: $("copyExportButton"),
  downloadExportButton: $("downloadExportButton"), parameterSyncState: $("parameterSyncState"),
  readParametersButton: $("readParametersButton"), applyAllParametersButton: $("applyAllParametersButton"),
  exportParametersButton: $("exportParametersButton"),
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
const BLE_CHUNK_SIZE = 20;
const sensorHistory = [];
const diagnosticLogs = [];
let chartPaused = false;
let chartPausedAt = 0;
let chartDrawPending = false;
let activeExport = null;
let chartDrag = null;
const pendingParameterRequests = new Map();

const parameterDefinitions = {
  PID_DEADBAND: { label: "循迹误差死区", unit: "", min: 0, max: 500, step: 10, defaultValue: 180 },
  PID_DIVISOR: { label: "P 控制除数", unit: "", min: 20, max: 500, step: 5, defaultValue: 180 },
  PID_LIMIT: { label: "最大差速修正", unit: "%", min: 0, max: 60, step: 1, defaultValue: 12 },
  PID_D_GAIN: { label: "D 平滑强度", unit: "", min: 0, max: 30, step: 1, defaultValue: 4 },
  CROSS_APPROACH_ERROR: { label: "接近误差阈值", unit: "", min: 100, max: 3000, step: 50, defaultValue: 900 },
  CROSS_CENTER_SUM: { label: "路口中心和值", unit: "", min: 500, max: 7000, step: 50, defaultValue: 2700 },
  CROSS_LEAVE_ERROR: { label: "离开反向误差", unit: "", min: 100, max: 3000, step: 50, defaultValue: 900 },
  CROSS_RECOVER_SUM: { label: "恢复赛道和值", unit: "", min: 500, max: 7000, step: 50, defaultValue: 2500 },
  CROSS_SEQUENCE_MS: { label: "入口序列时间", unit: "ms", min: 100, max: 3000, step: 100, defaultValue: 1000 },
  CROSS_MIN_MS: { label: "最短直行时间", unit: "ms", min: 0, max: 2000, step: 50, defaultValue: 300 },
  CROSS_MAX_MS: { label: "最长直行时间", unit: "ms", min: 300, max: 5000, step: 100, defaultValue: 2200 }
};
const confirmedParameters = Object.fromEntries(
  Object.entries(parameterDefinitions).map(([key, definition]) => [key, definition.defaultValue])
);

const diagnosticState = {
  connected: false,
  deviceName: "--",
  speed: 30,
  sensorEnabled: false,
  obstacleEnabled: true,
  distance: "--",
  obstacle: "--",
  l1: "--", l2: "--", r1: "--", r2: "--",
  error: "--", ml: "--", mr: "--", ld: "--", rd: "--", ls: "--", rs: "--",
  crossroad: "等待数据", crossroadCode: "--", crossroadPhase: "NORMAL", crossroadDirection: "NONE"
};

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
  diagnosticState.connected = connected;
  ui.connectionState.classList.toggle("connected", connected);
  ui.connectionText.textContent = connected ? "已连接" : "未连接";
  ui.connectButton.disabled = connected;
  ui.disconnectButton.disabled = !connected;
  document.querySelectorAll(".control-button, #speedSlider, #speedPresets button")
    .forEach((element) => { element.disabled = !connected; });
  document.querySelectorAll(".parameter-action")
    .forEach((element) => { element.disabled = !connected; });
  ui.parameterSyncState.textContent = connected ? "等待读取" : "等待连接";
  ui.parameterSyncState.className = "parameter-sync-state";
}

function addLog(text, kind = "rx") {
  diagnosticLogs.push({ time: Date.now(), kind, text: String(text) });
  while (diagnosticLogs.length > 80) diagnosticLogs.shift();

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
    diagnosticState.deviceName = bluetoothDevice.name || "未命名设备";
    setConnected(true);
    setMessage("连接成功，可以控制小车");
    addLog("已连接 " + (bluetoothDevice.name || "未命名设备"));
    setTimeout(requestParameters, 150);
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
  pendingParameterRequests.forEach((pending) => { clearTimeout(pending.timer); pending.resolve(false); });
  pendingParameterRequests.clear();
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
    /* 单字节车辆控制统一加 ! 帧头，避免调试文字中的 S/N/T 被芯片误当命令。 */
    const framedCommand = /^[FBSTNOX1-9]$/i.test(String(command)) ? `!${String(command).toUpperCase()}\n` : String(command);
    const data = encoder.encode(framedCommand);
    for (let offset = 0; offset < data.length; offset += BLE_CHUNK_SIZE) {
      const chunk = data.slice(offset, offset + BLE_CHUNK_SIZE);
      if (uartCharacteristic.properties.write && uartCharacteristic.writeValueWithResponse) {
        await uartCharacteristic.writeValueWithResponse(chunk);
      } else if (uartCharacteristic.properties.writeWithoutResponse && uartCharacteristic.writeValueWithoutResponse) {
        await uartCharacteristic.writeValueWithoutResponse(chunk);
      } else if (uartCharacteristic.writeValue) {
        await uartCharacteristic.writeValue(chunk);
      } else {
        throw new Error("FFE1 不支持写入");
      }
    }
    const displayCommand = String(command).trim();
    addLog(displayCommand, "tx");
    setMessage("命令 " + displayCommand + " 已发送");
    return true;
  } catch (error) {
    setMessage("发送失败：" + error.message, true);
    addLog(error.message, "error");
    return false;
  }
}

function getParameterInput(key) {
  return document.querySelector(`.parameter-input[data-key="${key}"]`);
}

function setParameterRowState(key, text, kind = "") {
  const row = document.querySelector(`.parameter-row[data-parameter="${key}"]`);
  if (!row) return;
  const state = row.querySelector(".parameter-item-state");
  state.textContent = text;
  state.className = `parameter-item-state ${kind}`.trim();
}

function validateParameterValues(showErrors = true) {
  const values = {};
  let valid = true;
  Object.entries(parameterDefinitions).forEach(([key, definition]) => {
    const input = getParameterInput(key);
    const value = Number(input.value);
    const itemValid = Number.isInteger(value) && value >= definition.min && value <= definition.max;
    input.classList.toggle("invalid", !itemValid);
    if (!itemValid) {
      valid = false;
      if (showErrors) setParameterRowState(key, `范围应为 ${definition.min}～${definition.max}`, "error");
    }
    values[key] = value;
  });

  if (valid && values.CROSS_RECOVER_SUM >= values.CROSS_CENTER_SUM) {
    valid = false;
    getParameterInput("CROSS_CENTER_SUM").classList.add("invalid");
    getParameterInput("CROSS_RECOVER_SUM").classList.add("invalid");
    if (showErrors) {
      setParameterRowState("CROSS_CENTER_SUM", "中心和值必须大于恢复和值", "error");
      setParameterRowState("CROSS_RECOVER_SUM", "恢复和值必须小于中心和值", "error");
    }
  }
  if (valid && values.CROSS_MAX_MS <= values.CROSS_MIN_MS) {
    valid = false;
    getParameterInput("CROSS_MIN_MS").classList.add("invalid");
    getParameterInput("CROSS_MAX_MS").classList.add("invalid");
    if (showErrors) {
      setParameterRowState("CROSS_MIN_MS", "最短时间必须小于最长时间", "error");
      setParameterRowState("CROSS_MAX_MS", "最长时间必须大于最短时间", "error");
    }
  }
  return { valid, values };
}

function handleParameterValue(key, value) {
  if (!parameterDefinitions[key]) return;
  confirmedParameters[key] = value;
  const input = getParameterInput(key);
  input.value = String(value);
  input.classList.remove("invalid");
  setParameterRowState(key, "已与芯片同步", "success");
  const pending = pendingParameterRequests.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    pendingParameterRequests.delete(key);
    pending.resolve(true);
  }
}

function handleParameterError(key, reason) {
  const labels = { RANGE: "数值超出范围", RELATION: "与另一参数关系不正确", FORMAT: "命令格式错误", UNKNOWN: "参数名未知" };
  const targetKey = parameterDefinitions[key] ? key : pendingParameterRequests.keys().next().value;
  const pending = targetKey ? pendingParameterRequests.get(targetKey) : null;
  if (targetKey && parameterDefinitions[targetKey]) {
    getParameterInput(targetKey).value = String(confirmedParameters[targetKey]);
    setParameterRowState(targetKey, labels[reason] || reason, "error");
  }
  ui.parameterSyncState.textContent = "芯片拒绝了参数";
  ui.parameterSyncState.className = "parameter-sync-state error";
  if (pending) {
    clearTimeout(pending.timer);
    pendingParameterRequests.delete(targetKey);
    pending.resolve(false);
  }
}

async function requestParameters() {
  if (!diagnosticState.connected) return;
  ui.parameterSyncState.textContent = "正在读取…";
  ui.parameterSyncState.className = "parameter-sync-state";
  await sendCommand("@GET PARAMS\n");
}

async function sendParameterAndWait(key, value) {
  if (pendingParameterRequests.has(key)) return false;
  setParameterRowState(key, "正在写入…", "pending");
  return new Promise(async (resolve) => {
    const timer = setTimeout(() => {
      pendingParameterRequests.delete(key);
      setParameterRowState(key, "等待芯片回复超时", "error");
      resolve(false);
    }, 2200);
    pendingParameterRequests.set(key, { resolve, timer });
    const sent = await sendCommand(`@SET ${key} ${value}\n`);
    if (!sent) {
      clearTimeout(timer);
      pendingParameterRequests.delete(key);
      setParameterRowState(key, "发送失败", "error");
      resolve(false);
    }
  });
}

async function applyParameter(key) {
  const result = validateParameterValues(true);
  if (!result.valid) {
    setMessage("请先修正红色参数", true);
    return false;
  }
  const success = await sendParameterAndWait(key, result.values[key]);
  if (success) setMessage(`${parameterDefinitions[key].label} 已生效`);
  return success;
}

async function applyAllParameters() {
  const result = validateParameterValues(true);
  if (!result.valid) {
    setMessage("请先修正红色参数", true);
    return;
  }
  ui.applyAllParametersButton.disabled = true;
  ui.parameterSyncState.textContent = "正在依次写入…";
  ui.parameterSyncState.className = "parameter-sync-state";

  const order = ["PID_DEADBAND", "PID_DIVISOR", "PID_LIMIT", "PID_D_GAIN",
    "CROSS_APPROACH_ERROR", "CROSS_LEAVE_ERROR", "CROSS_SEQUENCE_MS"];
  if (result.values.CROSS_CENTER_SUM <= confirmedParameters.CROSS_RECOVER_SUM) order.push("CROSS_RECOVER_SUM", "CROSS_CENTER_SUM");
  else order.push("CROSS_CENTER_SUM", "CROSS_RECOVER_SUM");
  if (result.values.CROSS_MAX_MS <= confirmedParameters.CROSS_MIN_MS) order.push("CROSS_MIN_MS", "CROSS_MAX_MS");
  else order.push("CROSS_MAX_MS", "CROSS_MIN_MS");

  let allSucceeded = true;
  for (const key of order) {
    if (!await sendParameterAndWait(key, result.values[key])) { allSucceeded = false; break; }
  }
  ui.applyAllParametersButton.disabled = !diagnosticState.connected;
  ui.parameterSyncState.textContent = allSucceeded ? "全部参数已生效" : "部分参数未生效";
  ui.parameterSyncState.className = `parameter-sync-state ${allSucceeded ? "synced" : "error"}`;
  setMessage(allSucceeded ? "11 个参数已全部写入芯片" : "写入中断，请检查红色提示", !allSucceeded);
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

  const parameterValueMatch = line.match(/^PARAM\s+([A-Z0-9_]+)\s*=\s*(\d+)(?:\s+OK)?$/i);
  const parameterErrorMatch = line.match(/^PARAM\s+([A-Z0-9_]+)\s+ERROR\s+([A-Z]+)$/i);
  if (parameterValueMatch) handleParameterValue(parameterValueMatch[1].toUpperCase(), Number(parameterValueMatch[2]));
  if (parameterErrorMatch) handleParameterError(parameterErrorMatch[1].toUpperCase(), parameterErrorMatch[2].toUpperCase());
  if (/^PARAMS\s+END$/i.test(line)) {
    ui.parameterSyncState.textContent = "已与芯片同步";
    ui.parameterSyncState.className = "parameter-sync-state synced";
  }

  const sensorMatch = line.match(/L1\s*=\s*(\d+).*?L2\s*=\s*(\d+).*?R1\s*=\s*(\d+).*?R2\s*=\s*(\d+).*?ERROR\s*=\s*(-?\d+).*?ML\s*=\s*(\d+).*?MR\s*=\s*(\d+)/i);
  if (sensorMatch) {
    const values = sensorMatch.slice(1).map(Number);
    [ui.l1Value.textContent, ui.l2Value.textContent, ui.r1Value.textContent, ui.r2Value.textContent,
      ui.errorValue.textContent, ui.mlValue.textContent, ui.mrValue.textContent] = values.map(String);
    [diagnosticState.l1, diagnosticState.l2, diagnosticState.r1, diagnosticState.r2,
      diagnosticState.error, diagnosticState.ml, diagnosticState.mr] = values;
    const ldMatch = line.match(/\bLD\s*=\s*(-?\d+)/i);
    const rdMatch = line.match(/\bRD\s*=\s*(-?\d+)/i);
    const lsMatch = line.match(/\bLS\s*=\s*(\d+)/i);
    const rsMatch = line.match(/\bRS\s*=\s*(\d+)/i);
    const crossMatch = line.match(/\bCROSS\s*=\s*([01])/i);
    const phaseMatch = line.match(/\bPHASE\s*=\s*(NORMAL|APPROACH|CROSS|LEAVING)/i);
    const directionMatch = line.match(/\bDIR\s*=\s*(NONE|RIGHT_FIRST|LEFT_FIRST)/i);
    if (ldMatch) { ui.ldValue.textContent = ldMatch[1]; diagnosticState.ld = Number(ldMatch[1]); }
    if (rdMatch) { ui.rdValue.textContent = rdMatch[1]; diagnosticState.rd = Number(rdMatch[1]); }
    if (lsMatch) { ui.lsValue.textContent = lsMatch[1]; diagnosticState.ls = Number(lsMatch[1]); }
    if (rsMatch) { ui.rsValue.textContent = rsMatch[1]; diagnosticState.rs = Number(rsMatch[1]); }
    if (phaseMatch) updateCrossroad(phaseMatch[1].toUpperCase(), directionMatch ? directionMatch[1].toUpperCase() : diagnosticState.crossroadDirection);
    else if (crossMatch) updateCrossroad(crossMatch[1] === "1" ? "CROSS" : "NORMAL");
    updateDeviation(values[4]);
    recordSensorSample({
      time: Date.now(), l1: values[0], l2: values[1], r1: values[2], r2: values[3], error: values[4],
      ld: ldMatch ? Number(ldMatch[1]) : "", rd: rdMatch ? Number(rdMatch[1]) : "",
      ls: lsMatch ? Number(lsMatch[1]) : "", rs: rsMatch ? Number(rsMatch[1]) : "",
      cross: crossMatch ? Number(crossMatch[1]) : "", phase: phaseMatch ? phaseMatch[1].toUpperCase() : "",
      direction: directionMatch ? directionMatch[1].toUpperCase() : ""
    });
  }

  const distanceMatch = line.match(/DIST\s*=\s*(OUT|\d+)\s*(?:CM)?/i);
  const obstacleMatch = line.match(/(?:OBSTACLE\s*=\s*|OBSTACLE\s+)(CLEAR|SLOW|STOP)/i);
  const avoidanceMatch = line.match(/(?:AVOID\s*=\s*|OBSTACLE\s+)(ON|OFF)\b/i);
  const sensorModeMatch = line.match(/SENSOR\s*(?:=|\s)\s*(ON|OFF)\b/i);
  if (distanceMatch) updateDistance(distanceMatch[1]);
  if (obstacleMatch) updateObstacle(obstacleMatch[1].toUpperCase());
  if (avoidanceMatch) selectMode(ui.obstacleOnButton, ui.obstacleOffButton, avoidanceMatch[1].toUpperCase() === "ON");
  if (sensorModeMatch) selectMode(ui.sensorOnButton, ui.sensorOffButton, sensorModeMatch[1].toUpperCase() === "ON");

  const approachEvent = line.match(/CROSSROAD\s+APPROACH\s+(RIGHT_FIRST|LEFT_FIRST)/i);
  if (approachEvent) updateCrossroad("APPROACH", approachEvent[1].toUpperCase());
  else if (/CROSSROAD\s+ENTER/i.test(line)) updateCrossroad("CROSS", diagnosticState.crossroadDirection);
  else if (/CROSSROAD\s+LEAVING/i.test(line)) updateCrossroad("LEAVING", diagnosticState.crossroadDirection);
  else if (/CROSSROAD\s+TIMEOUT/i.test(line)) updateCrossroad("TIMEOUT");
  else if (/CROSSROAD\s+EXIT/i.test(line)) updateCrossroad("NORMAL");
  else if (/CROSSROAD\s+CANCEL/i.test(line)) updateCrossroad("NORMAL");

  if (/CAR\s+ALIVE/i.test(line)) markAlive();
}

function updateCrossroad(state, direction = "NONE") {
  const directionText = direction === "RIGHT_FIRST" ? "右侧先变化" : direction === "LEFT_FIRST" ? "左侧先变化" : "";
  const states = {
    NORMAL: { text: "正常循迹", code: 0, className: "normal" },
    APPROACH: { text: `接近十字路口${directionText ? " · " + directionText : ""}`, code: 0, className: "approach" },
    CROSS: { text: `十字路口直行${directionText ? " · " + directionText : ""}`, code: 1, className: "active" },
    LEAVING: { text: `正在离开十字路口${directionText ? " · " + directionText : ""}`, code: 1, className: "active" },
    TIMEOUT: { text: "十字路口超时保护", code: "TIMEOUT", className: "timeout" }
  };
  const selected = states[state] || states.NORMAL;
  ui.crossroadState.className = `crossroad-state ${selected.className}`;
  ui.crossroadValue.textContent = selected.text;
  diagnosticState.crossroad = selected.text;
  diagnosticState.crossroadCode = selected.code;
  diagnosticState.crossroadPhase = state === "TIMEOUT" ? "TIMEOUT" : state;
  diagnosticState.crossroadDirection = state === "NORMAL" || state === "TIMEOUT" ? "NONE" : direction;
}

function updateDistance(value) {
  const isOut = String(value).toUpperCase() === "OUT";
  ui.distanceValue.textContent = isOut ? "OUT" : value;
  ui.distanceUnit.textContent = isOut ? "" : "cm";
  diagnosticState.distance = isOut ? "OUT" : String(value);
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
  diagnosticState.obstacle = state;
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
  ui.returnLiveButton.disabled = !chartPaused;
  updateChartViewLabels();
}

function clampChartEnd(value) {
  if (!sensorHistory.length) return Date.now();
  const first = sensorHistory[0].time;
  const last = sensorHistory[sensorHistory.length - 1].time;
  const earliestEnd = Math.min(last, first + CHART_WINDOW_MS);
  return Math.max(earliestEnd, Math.min(last, value));
}

function updateChartViewLabels() {
  if (!chartPaused) {
    ui.chartRangeLabel.textContent = "实时 · 最近 60 秒";
    ui.chartViewStatus.textContent = "在曲线上左右滑动，可查看最近30分钟的历史波形。";
    ui.pauseChartButton.textContent = "暂停";
    return;
  }
  chartPausedAt = clampChartEnd(chartPausedAt);
  const delaySeconds = sensorHistory.length ? Math.max(0, Math.round((sensorHistory[sensorHistory.length - 1].time - chartPausedAt) / 1000)) : 0;
  const startText = new Date(chartPausedAt - CHART_WINDOW_MS).toLocaleTimeString("zh-CN", { hour12: false });
  const endText = new Date(chartPausedAt).toLocaleTimeString("zh-CN", { hour12: false });
  ui.chartRangeLabel.textContent = `历史 · ${startText}—${endText}`;
  ui.chartViewStatus.textContent = delaySeconds > 0 ? `正在查看历史，距最新数据约 ${delaySeconds} 秒。` : "画面已暂停，新数据仍在后台保存。";
  ui.pauseChartButton.textContent = "继续";
}

function returnChartToLive() {
  chartPaused = false;
  chartPausedAt = 0;
  updateChartControls();
  scheduleChartDraw();
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
  const windowEnd = chartPaused ? clampChartEnd(chartPausedAt) : Date.now();
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

  [0, 1, 2, 3, 4].forEach((tick, index) => {
    const x = plot.left + (index / 4) * plotWidth;
    const tickTime = windowStart + (tick / 4) * CHART_WINDOW_MS;
    ctx.strokeStyle = "rgba(80,116,150,.16)";
    ctx.beginPath(); ctx.moveTo(x, plot.top); ctx.lineTo(x, height - plot.bottom); ctx.stroke();
    ctx.fillStyle = "#667b91";
    ctx.textAlign = index === 0 ? "left" : index === 4 ? "right" : "center";
    ctx.fillText(new Date(tickTime).toLocaleTimeString("zh-CN", { hour12: false, minute: "2-digit", second: "2-digit" }), x, height - 12);
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
  const rows = ["时间,相对秒,L1,L2,R1,R2,ERROR,LD,RD,LS,RS,CROSS,PHASE,DIR"];
  sensorHistory.forEach((point) => {
    rows.push([
      new Date(point.time).toISOString(), ((point.time - firstTime) / 1000).toFixed(3),
      point.l1, point.l2, point.r1, point.r2, point.error, point.ld, point.rd,
      point.ls, point.rs, point.cross, point.phase, point.direction
    ].join(","));
  });
  const blob = new Blob(["\uFEFF" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `smart-car-sensors-${formatFileTimestamp()}.csv`);
  setMessage(`已导出 ${sensorHistory.length} 条传感器数据`);
}

function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(",");
  const mime = (parts[0].match(/data:([^;]+)/) || [])[1] || "application/octet-stream";
  const bytes = atob(parts[1]);
  const array = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) array[index] = bytes.charCodeAt(index);
  return new Blob([array], { type: mime });
}

function openExportModal(config) {
  activeExport = config;
  ui.exportModalTitle.textContent = config.title;
  ui.exportHelp.textContent = config.help;
  ui.exportImage.hidden = config.kind !== "image";
  ui.exportText.hidden = config.kind !== "text";
  ui.copyExportButton.hidden = config.kind !== "text";
  if (config.kind === "image") ui.exportImage.src = config.dataUrl;
  else ui.exportText.value = config.text;
  ui.exportModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeExportModal() {
  ui.exportModal.hidden = true;
  document.body.classList.remove("modal-open");
  ui.exportImage.removeAttribute("src");
  activeExport = null;
}

function openSensorImage() {
  if (!sensorHistory.length) return;
  try {
    drawSensorChart();
    const dataUrl = ui.sensorChart.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/png")) throw new Error("图片格式生成失败");
    openExportModal({
      kind: "image",
      title: "曲线图片",
      help: "苹果手机：长按下面的图片，然后选择保存到照片；也可以尝试系统分享。",
      filename: `smart-car-chart-${formatFileTimestamp()}.png`,
      blob: dataUrlToBlob(dataUrl),
      dataUrl
    });
  } catch (error) {
    setMessage("曲线图片生成失败：" + error.message, true);
    addLog("曲线图片生成失败：" + error.message, "error");
  }
}

function buildParameterReport() {
  const lines = [
    "SMART CAR RUNTIME PARAMETERS",
    "智能车手机端运行参数",
    "========================================",
    `导出时间=${new Date().toISOString()}`,
    `连接状态=${diagnosticState.connected ? "已连接" : "未连接"}`,
    `BLE设备=${diagnosticState.deviceName}`,
    "说明=参数只在本次上电期间有效，芯片复位后恢复源码默认值",
    "",
    "[运行参数]"
  ];
  Object.entries(parameterDefinitions).forEach(([key, definition]) => {
    lines.push(`${key}=${confirmedParameters[key]}${definition.unit ? " " + definition.unit : ""}  # ${definition.label}`);
  });
  lines.push(
    "", "[当前反馈]",
    `L1=${diagnosticState.l1}`, `L2=${diagnosticState.l2}`,
    `R1=${diagnosticState.r1}`, `R2=${diagnosticState.r2}`,
    `ERROR=${diagnosticState.error}`, `LD=${diagnosticState.ld}`, `RD=${diagnosticState.rd}`,
    `LS=${diagnosticState.ls}`, `RS=${diagnosticState.rs}`,
    `CROSS=${diagnosticState.crossroadCode} (${diagnosticState.crossroad})`,
    `PHASE=${diagnosticState.crossroadPhase}`, `DIR=${diagnosticState.crossroadDirection}`,
    `距离=${diagnosticState.distance}`, `障碍状态=${diagnosticState.obstacle}`,
    "", "END OF PARAMETERS"
  );
  return lines.join("\r\n");
}

function openParameterReport() {
  const text = buildParameterReport();
  openExportModal({
    kind: "text",
    title: "运行参数导出",
    help: "可直接系统分享给调试人员，也可以复制全部文本。导出的是芯片最后确认的参数值。",
    filename: `smart-car-parameters-${formatFileTimestamp()}.txt`,
    blob: new Blob(["\uFEFF" + text], { type: "text/plain;charset=utf-8" }),
    text
  });
}

function buildDiagnosticReport() {
  const lines = [
    "SMART CAR DIAGNOSTIC REPORT",
    "智能车完整调试报告",
    "========================================",
    "",
    "[基本信息]",
    `导出时间=${new Date().toISOString()}`,
    `页面地址=${location.href}`,
    `浏览器=${navigator.userAgent}`,
    `BLE设备=${diagnosticState.deviceName}`,
    `连接状态=${diagnosticState.connected ? "已连接" : "未连接"}`,
    "服务/特征=FFE0/FFE1",
    "",
    "[当前控制状态]",
    `速度=${diagnosticState.speed}%`,
    `循迹传感器=${diagnosticState.sensorEnabled ? "ON" : "OFF"}`,
    `自动避障=${diagnosticState.obstacleEnabled ? "ON" : "OFF"}`,
    `距离=${diagnosticState.distance}${/^\d+$/.test(String(diagnosticState.distance)) ? "cm" : ""}`,
    `障碍状态=${diagnosticState.obstacle}`,
    `十字路口=${diagnosticState.crossroad}`,
    `十字阶段=${diagnosticState.crossroadPhase}`,
    `入口方向=${diagnosticState.crossroadDirection}`,
    "",
    "[当前传感器与电机]",
    `L1=${diagnosticState.l1}`,
    `L2=${diagnosticState.l2}`,
    `R1=${diagnosticState.r1}`,
    `R2=${diagnosticState.r2}`,
    `ERROR=${diagnosticState.error}`,
    `LD=${diagnosticState.ld}`,
    `RD=${diagnosticState.rd}`,
    `LS=${diagnosticState.ls}`,
    `RS=${diagnosticState.rs}`,
    `ML=${diagnosticState.ml}`,
    `MR=${diagnosticState.mr}`,
    "",
    "[当前运行参数]",
    ...Object.entries(parameterDefinitions).map(([key, definition]) => `${key}=${confirmedParameters[key]}${definition.unit ? " " + definition.unit : ""}`),
    "",
    `[传感器历史数据，共${sensorHistory.length}条]`,
    "时间,相对秒,L1,L2,R1,R2,ERROR,LD,RD,LS,RS,CROSS,PHASE,DIR"
  ];

  const firstTime = sensorHistory.length ? sensorHistory[0].time : 0;
  sensorHistory.forEach((point) => {
    lines.push([
      new Date(point.time).toISOString(), ((point.time - firstTime) / 1000).toFixed(3),
      point.l1, point.l2, point.r1, point.r2, point.error, point.ld, point.rd,
      point.ls, point.rs, point.cross, point.phase, point.direction
    ].join(","));
  });

  lines.push("", `[最近通信日志，共${diagnosticLogs.length}条]`, "时间,方向,内容");
  diagnosticLogs.forEach((entry) => {
    lines.push(`${new Date(entry.time).toISOString()},${entry.kind.toUpperCase()},${entry.text.replace(/[\r\n]+/g, " ")}`);
  });
  lines.push("", "END OF REPORT");
  return lines.join("\r\n");
}

function openDiagnosticReport() {
  const text = buildDiagnosticReport();
  openExportModal({
    kind: "text",
    title: "完整调试报告",
    help: "建议点击“系统分享”直接发送文件；如果分享不可用，就点“复制全部”后粘贴给我。",
    filename: `smart-car-diagnostic-${formatFileTimestamp()}.txt`,
    blob: new Blob(["\uFEFF" + text], { type: "text/plain;charset=utf-8" }),
    text
  });
}

async function shareActiveExport() {
  if (!activeExport) return;
  let fileShareError = null;
  try {
    if (!navigator.share) throw new Error("当前浏览器没有系统分享功能");

    try {
      const file = new File([activeExport.blob], activeExport.filename, { type: activeExport.blob.type });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ title: activeExport.title, files: [file] });
        return;
      }
    } catch (error) {
      if (error.name === "AbortError") return;
      fileShareError = error;
    }

    if (activeExport.kind === "text") {
      await navigator.share({ title: activeExport.title, text: activeExport.text });
      return;
    }
    throw fileShareError || new Error("当前浏览器不能分享图片文件，请长按图片保存");
  } catch (error) {
    if (error.name === "AbortError") return;
    setMessage(error.message, true);
    addLog("分享失败：" + error.message, "error");
  }
}

async function copyActiveText() {
  if (!activeExport || activeExport.kind !== "text") return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(activeExport.text);
    } else {
      ui.exportText.focus();
      ui.exportText.select();
      if (!document.execCommand("copy")) throw new Error("自动复制失败");
    }
    setMessage("调试报告已复制，可以直接粘贴发送");
  } catch (error) {
    setMessage("复制失败，请在报告文本中长按并选择复制", true);
  }
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
  diagnosticState.speed = value * 10;
  ui.speedPresets.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.speed) === value);
  });
}

function selectMode(onButton, offButton, enabled) {
  onButton.classList.toggle("selected", enabled);
  offButton.classList.toggle("selected", !enabled);
  if (onButton === ui.sensorOnButton) diagnosticState.sensorEnabled = enabled;
  if (onButton === ui.obstacleOnButton) diagnosticState.obstacleEnabled = enabled;
}

/* 四个主页面只切换显示内容；蓝牙连接和顶部急停始终保留。 */
function selectPage(pageName) {
  document.querySelectorAll(".page-tab").forEach((button) => {
    const selected = button.dataset.pageTarget === pageName;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  document.querySelectorAll(".page-card").forEach((card) => {
    card.hidden = card.dataset.page !== pageName;
  });
  if (pageName === "sensor") scheduleChartDraw();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

ui.connectButton.addEventListener("click", connectBluetooth);
ui.disconnectButton.addEventListener("click", disconnectBluetooth);

document.querySelectorAll(".page-tab").forEach((button) => {
  button.addEventListener("click", () => selectPage(button.dataset.pageTarget));
});

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

document.querySelectorAll("[data-param-delta]").forEach((button) => {
  button.addEventListener("click", () => {
    const row = button.closest(".parameter-row");
    const input = row.querySelector(".parameter-input");
    const definition = parameterDefinitions[input.dataset.key];
    const direction = Number(button.dataset.paramDelta);
    const current = Number.isFinite(Number(input.value)) ? Number(input.value) : definition.defaultValue;
    input.value = String(Math.max(definition.min, Math.min(definition.max, current + direction * definition.step)));
    input.classList.remove("invalid");
    setParameterRowState(input.dataset.key, "已修改，尚未应用", "pending");
    validateParameterValues(false);
  });
});

document.querySelectorAll(".parameter-input").forEach((input) => {
  input.addEventListener("input", () => {
    input.classList.remove("invalid");
    setParameterRowState(input.dataset.key, "已修改，尚未应用", "pending");
  });
});

document.querySelectorAll(".parameter-apply").forEach((button) => {
  button.addEventListener("click", () => applyParameter(button.closest(".parameter-row").dataset.parameter));
});
ui.readParametersButton.addEventListener("click", requestParameters);
ui.applyAllParametersButton.addEventListener("click", applyAllParameters);
ui.exportParametersButton.addEventListener("click", openParameterReport);

ui.clearLogButton.addEventListener("click", () => {
  diagnosticLogs.length = 0;
  ui.logWindow.innerHTML = '<p class="muted">日志已清空</p>';
});

document.querySelectorAll(".series-chip input").forEach((input) => {
  input.addEventListener("change", scheduleChartDraw);
});
ui.pauseChartButton.addEventListener("click", () => {
  if (chartPaused) {
    returnChartToLive();
    return;
  }
  chartPaused = true;
  chartPausedAt = sensorHistory.length ? sensorHistory[sensorHistory.length - 1].time : Date.now();
  updateChartControls();
  scheduleChartDraw();
});
ui.returnLiveButton.addEventListener("click", returnChartToLive);

ui.sensorChart.addEventListener("pointerdown", (event) => {
  if (!sensorHistory.length) return;
  chartPaused = true;
  chartPausedAt = chartPausedAt || sensorHistory[sensorHistory.length - 1].time;
  chartDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, end: clampChartEnd(chartPausedAt) };
  ui.sensorChart.setPointerCapture?.(event.pointerId);
  ui.sensorChart.classList.add("dragging");
  updateChartControls();
});
ui.sensorChart.addEventListener("pointermove", (event) => {
  if (!chartDrag || chartDrag.id !== event.pointerId) return;
  const deltaX = event.clientX - chartDrag.x;
  const deltaY = event.clientY - chartDrag.y;
  if (Math.abs(deltaX) > Math.abs(deltaY) && event.cancelable) event.preventDefault();
  const width = Math.max(1, ui.sensorChart.getBoundingClientRect().width - 55);
  chartPausedAt = clampChartEnd(chartDrag.end - (deltaX / width) * CHART_WINDOW_MS);
  updateChartControls();
  scheduleChartDraw();
});
function finishChartDrag(event) {
  if (!chartDrag || chartDrag.id !== event.pointerId) return;
  ui.sensorChart.releasePointerCapture?.(event.pointerId);
  ui.sensorChart.classList.remove("dragging");
  chartDrag = null;
}
ui.sensorChart.addEventListener("pointerup", finishChartDrag);
ui.sensorChart.addEventListener("pointercancel", finishChartDrag);
ui.clearChartButton.addEventListener("click", () => {
  sensorHistory.length = 0;
  returnChartToLive();
  updateChartControls();
  scheduleChartDraw();
  setMessage("传感器曲线已清空");
});
ui.exportCsvButton.addEventListener("click", exportSensorCsv);
ui.exportPngButton.addEventListener("click", openSensorImage);
ui.exportReportButton.addEventListener("click", openDiagnosticReport);
ui.shareExportButton.addEventListener("click", shareActiveExport);
ui.copyExportButton.addEventListener("click", copyActiveText);
ui.downloadExportButton.addEventListener("click", () => {
  if (activeExport) downloadBlob(activeExport.blob, activeExport.filename);
});
document.querySelectorAll("[data-close-export]").forEach((button) => {
  button.addEventListener("click", closeExportModal);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !ui.exportModal.hidden) closeExportModal();
});
window.addEventListener("resize", scheduleChartDraw);
setInterval(() => { if (!chartPaused) scheduleChartDraw(); }, 1000);

setConnected(false);
selectSpeed(3);
selectMode(ui.sensorOnButton, ui.sensorOffButton, false);
selectMode(ui.obstacleOnButton, ui.obstacleOffButton, true);
updateCrossroad("NORMAL");
updateChartControls();
scheduleChartDraw();
