"use strict";

// JDY 模块使用的 BLE 服务和特征值 UUID。
const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";
const TARGET_DEVICE_NAME = "JDY-31-SPP";

const $ = (id) => document.getElementById(id);
const ui = {
  connectionState: $("connectionState"), connectionText: $("connectionText"),
  themeToggleButton: $("themeToggleButton"),
  connectButton: $("connectButton"), reconnectButton: $("reconnectButton"), disconnectButton: $("disconnectButton"),
  rememberedDeviceLine: $("rememberedDeviceLine"), rememberedDeviceName: $("rememberedDeviceName"),
  deviceName: $("deviceName"), message: $("message"),
  distanceGauge: $("distanceGauge"), distanceValue: $("distanceValue"), distanceUnit: $("distanceUnit"),
  obstacleState: $("obstacleState"), obstacleChinese: $("obstacleChinese"), obstacleValue: $("obstacleValue"),
  speedSlider: $("speedSlider"), speedReadout: $("speedReadout"), speedPresets: $("speedPresets"),
  gearContextValue: $("gearContextValue"), voltageContextValue: $("voltageContextValue"),
  voltagePresets: $("voltagePresets"), voltageReadout: $("voltageReadout"),
  sensorOnButton: $("sensorOnButton"), sensorOffButton: $("sensorOffButton"),
  crossroadToggleButton: $("crossroadToggleButton"),
  obstacleOnButton: $("obstacleOnButton"), obstacleOffButton: $("obstacleOffButton"),
  l1Value: $("l1Value"), l2Value: $("l2Value"), r1Value: $("r1Value"), r2Value: $("r2Value"),
  errorValue: $("errorValue"), mlValue: $("mlValue"), mrValue: $("mrValue"), pidModeValue: $("pidModeValue"),
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
const BLE_CHUNK_GAP_MS = 15;
const PARAMETER_REPLY_TIMEOUT_MS = 4500;
const PARAMETER_TIMEOUT_RETRY_COUNT = 1;
const GEAR_REPLY_TIMEOUT_MS = 800;
const REMEMBERED_DEVICE_KEY = "smartCarRememberedBluetoothDevice";
const RECONNECT_DELAY_MS = 2000;
const RECONNECT_MAX_ATTEMPTS = 3;
const THEME_STORAGE_KEY = "smartCarControllerTheme";
const sensorHistory = [];
const diagnosticLogs = [];
let chartPaused = false;
let chartPausedAt = 0;
let chartDrawPending = false;
let activeExport = null;
let chartDrag = null;
let userRequestedDisconnect = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let connectionInProgress = false;
let suppressDisconnectEvent = false;
const pendingParameterRequests = new Map();
let confirmedGear = 0;
let pendingGearParameterRead = 0;
let pendingGearReadTimer = null;
let confirmedVoltageLevel = 80;
let pendingVoltageLevel = 0;
let pendingVoltageTimer = null;

function waitMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const parameterDefinitions = {
  PID_DEADBAND: { label: "循迹误差死区", unit: "", min: 0, max: 500, step: 10, defaultValue: 180 },
  PID_DIVISOR: { label: "P 控制除数", unit: "", min: 20, max: 500, step: 5, defaultValue: 180 },
  PID_LIMIT: { label: "最大差速修正", unit: "%", min: 0, max: 60, step: 1, defaultValue: 12 },
  PID_D_GAIN: { label: "D 平滑强度", unit: "", min: 0, max: 30, step: 1, defaultValue: 4 },
  APPROACH_PID_DIVISOR: { label: "接近阶段 P 除数", unit: "", min: 100, max: 1200, step: 10, defaultValue: 500 },
  APPROACH_PID_D_GAIN: { label: "接近阶段 D 强度", unit: "", min: 0, max: 20, step: 1, defaultValue: 2 },
  APPROACH_PID_LIMIT: { label: "接近阶段最大差速", unit: "%", min: 0, max: 20, step: 1, defaultValue: 5 },
  CROSS_APPROACH_ERROR: { label: "接近误差阈值", unit: "", min: 100, max: 3000, step: 50, defaultValue: 900 },
  CROSS_OUTER_MIN: { label: "入口侧外传感器下限", unit: "", min: 0, max: 4095, step: 25, defaultValue: 350 },
  CROSS_DUAL_PEAK_MIN: { label: "十字双峰下限", unit: "", min: 0, max: 4095, step: 50, defaultValue: 1700 },
  CROSS_OPPOSITE_INNER_MAX: { label: "右入口 L1 上限", unit: "", min: 0, max: 4095, step: 25, defaultValue: 500 },
  CROSS_SIDE_SUM_MIN: { label: "入口侧和值下限", unit: "", min: 100, max: 8190, step: 50, defaultValue: 2000 },
  CROSS_EXIT_ERROR: { label: "退出误差上限", unit: "", min: 0, max: 3000, step: 50, defaultValue: 500 },
  CROSS_EXIT_SUM: { label: "退出左右和值上限", unit: "", min: 100, max: 8190, step: 50, defaultValue: 1200 },
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
  voltageLevel: 80,
  sensorEnabled: true,
  crossroadEnabled: false,
  obstacleEnabled: true,
  distance: "--",
  obstacle: "--",
  l1: "--", l2: "--", r1: "--", r2: "--",
  error: "--", ml: "--", mr: "--", ld: "--", rd: "--", ls: "--", rs: "--",
  crossroad: "等待数据", crossroadCode: "--", crossroadPhase: "NORMAL", crossroadDirection: "NONE",
  pidMode: "--"
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
  ui.reconnectButton.disabled = connected || connectionInProgress;
  ui.disconnectButton.disabled = !connected;
  document.querySelectorAll(".control-button, #speedSlider, #speedPresets button, #voltagePresets button")
    .forEach((element) => { element.disabled = !connected; });
  document.querySelectorAll(".parameter-action")
    .forEach((element) => { element.disabled = !connected; });
  ui.parameterSyncState.textContent = connected ? "等待读取" : "等待连接";
  ui.parameterSyncState.className = "parameter-sync-state";
  document.body.classList.toggle("is-connected", connected);
}

function applyTheme(theme) {
  const value = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = value;
  ui.themeToggleButton.setAttribute("aria-pressed", value === "light" ? "true" : "false");
  ui.themeToggleButton.setAttribute("aria-label", value === "light" ? "切换深色控制主题" : "切换浅色报告主题");
  ui.themeToggleButton.innerHTML = value === "light" ? '<span aria-hidden="true">☾</span><b>深色</b>' : '<span aria-hidden="true">☀</span><b>浅色</b>';
  try { localStorage.setItem(THEME_STORAGE_KEY, value); } catch (_) {}
  scheduleChartDraw();
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
}

function getRememberedDeviceRecord() {
  try {
    const value = JSON.parse(localStorage.getItem(REMEMBERED_DEVICE_KEY) || "null");
    return value && value.id && value.name === TARGET_DEVICE_NAME ? value : null;
  } catch (_) {
    return null;
  }
}

function updateRememberedDeviceUi() {
  const remembered = getRememberedDeviceRecord();
  ui.rememberedDeviceLine.hidden = !remembered;
  ui.reconnectButton.hidden = !remembered;
  ui.rememberedDeviceName.textContent = remembered?.name || "未命名设备";
  return remembered;
}

function rememberBluetoothDevice(device) {
  try {
    localStorage.setItem(REMEMBERED_DEVICE_KEY, JSON.stringify({
      id: device.id,
      name: device.name || "未命名设备",
      connectedAt: new Date().toISOString()
    }));
  } catch (error) {
    addLog("无法保存上次设备：" + error.message, "error");
  }
  updateRememberedDeviceUi();
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

async function connectDevice(device, source = "manual") {
  if (!device || connectionInProgress) return false;
  if (device.name !== TARGET_DEVICE_NAME) {
    setMessage(`已拒绝其他设备，只允许连接 ${TARGET_DEVICE_NAME}`, true);
    addLog(`设备名称不匹配：${device.name || "未命名设备"}`, "error");
    return false;
  }
  connectionInProgress = true;
  ui.reconnectButton.disabled = true;
  bluetoothDevice = device;
  bluetoothDevice.addEventListener("gattserverdisconnected", handleDisconnected);

  try {
    setMessage(`${source === "automatic" ? "正在自动连接" : "正在连接"} ${device.name || "蓝牙设备"}…`);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    uartCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

    if (uartCharacteristic.properties.notify || uartCharacteristic.properties.indicate) {
      await uartCharacteristic.startNotifications();
      uartCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
    } else {
      addLog("FFE1 不支持通知，只能发送命令", "error");
    }

    ui.deviceName.textContent = device.name || "未命名设备";
    diagnosticState.deviceName = device.name || "未命名设备";
    userRequestedDisconnect = false;
    reconnectAttempt = 0;
    rememberBluetoothDevice(device);
    setConnected(true);
    setMessage(source === "automatic" ? "已自动连接上次设备" : "连接成功，可以控制小车");
    addLog("已连接 " + (device.name || "未命名设备"));
    setTimeout(requestParameters, 150);
    return true;
  } catch (error) {
    uartCharacteristic = null;
    if (device.gatt?.connected) {
      suppressDisconnectEvent = true;
      device.gatt.disconnect();
      setTimeout(() => { suppressDisconnectEvent = false; }, 0);
    }
    setConnected(false);
    setMessage("连接失败：" + error.message, true);
    addLog(error.message, "error");
    return false;
  } finally {
    connectionInProgress = false;
    ui.reconnectButton.disabled = diagnosticState.connected;
  }
}

async function findRememberedBluetoothDevice() {
  const remembered = getRememberedDeviceRecord();
  if (!remembered || !navigator.bluetooth?.getDevices) return null;
  const devices = await navigator.bluetooth.getDevices();
  return devices.find((device) => device.id === remembered.id) || null;
}

async function reconnectRememberedDevice(automatic = false) {
  const remembered = updateRememberedDeviceUi();
  if (!remembered) return false;

  // 页面尚未刷新时，优先复用已经取得授权的设备对象。
  // Bluefy 不支持 getDevices()，但断线后仍可通过这个对象直接重连。
  if (bluetoothDevice && bluetoothDevice.id === remembered.id) {
    return connectDevice(bluetoothDevice, automatic ? "automatic" : "remembered");
  }

  if (!navigator.bluetooth?.getDevices) {
    // 自动恢复不能主动弹出设备选择框；浏览器要求必须由用户点击触发。
    if (automatic) {
      setMessage("浏览器不能自动恢复设备，请点击“重连上次设备”");
      return false;
    }

    // 用户亲自点击了“重连上次设备”，可以安全地打开 Bluefy 的设备列表。
    setMessage("正在重新选择上次设备…");
    await connectBluetooth();
    return false;
  }
  try {
    const device = await findRememberedBluetoothDevice();
    if (!device) {
      if (automatic) {
        setMessage("上次设备权限已失效，请点击“重连上次设备”");
        return false;
      }

      setMessage("上次设备权限已失效，正在打开设备列表…");
      await connectBluetooth();
      return false;
    }
    return connectDevice(device, automatic ? "automatic" : "remembered");
  } catch (error) {
    setMessage("恢复上次设备失败：" + error.message, true);
    addLog(error.message, "error");
    return false;
  }
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    setMessage("当前浏览器不支持网页蓝牙。苹果手机请使用 Bluefy 打开本页。", true);
    addLog("浏览器不支持 Web Bluetooth", "error");
    return;
  }

  try {
    userRequestedDisconnect = false;
    clearTimeout(reconnectTimer);
    setMessage("正在打开蓝牙设备列表…");
    const selectedDevice = await navigator.bluetooth.requestDevice({
      filters: [{ name: TARGET_DEVICE_NAME }],
      optionalServices: [SERVICE_UUID]
    });
    await connectDevice(selectedDevice, "manual");
  } catch (error) {
    if (error.name === "NotFoundError") {
      setMessage("已取消选择蓝牙设备");
      return;
    }
    setMessage("连接失败：" + error.message, true);
    addLog(error.message, "error");
  }
}

function disconnectBluetooth() {
  userRequestedDisconnect = true;
  clearTimeout(reconnectTimer);
  if (bluetoothDevice && bluetoothDevice.gatt && bluetoothDevice.gatt.connected) {
    bluetoothDevice.gatt.disconnect();
  } else {
    handleDisconnected();
  }
}

function handleDisconnected(event) {
  if (event?.target && bluetoothDevice && event.target !== bluetoothDevice) return;
  if (suppressDisconnectEvent) return;
  uartCharacteristic = null;
  receiveBuffer = "";
  clearTimeout(pendingGearReadTimer);
  pendingGearReadTimer = null;
  pendingGearParameterRead = 0;
  pendingParameterRequests.forEach((pending) => { clearTimeout(pending.timer); pending.resolve(false); });
  pendingParameterRequests.clear();
  setConnected(false);
  if (userRequestedDisconnect) {
    setMessage("蓝牙已断开");
    addLog("蓝牙已主动断开", "error");
    return;
  }
  setMessage("蓝牙意外断开，2秒后自动重连…", true);
  addLog("蓝牙已断开", "error");
  scheduleAutomaticReconnect();
}

function scheduleAutomaticReconnect() {
  if (userRequestedDisconnect || reconnectAttempt >= RECONNECT_MAX_ATTEMPTS || !bluetoothDevice) {
    if (!userRequestedDisconnect && reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      setMessage("自动重连失败，请点击“重连上次设备”或重新选择", true);
    }
    return;
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    reconnectAttempt += 1;
    setMessage(`正在自动重连（${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS}）…`);
    const connected = await connectDevice(bluetoothDevice, "automatic");
    if (!connected) scheduleAutomaticReconnect();
  }, RECONNECT_DELAY_MS);
}

async function sendCommand(command) {
  if (!uartCharacteristic || !bluetoothDevice?.gatt?.connected) {
    setMessage("请先连接蓝牙设备", true);
    return false;
  }

  try {
    /* 单字节车辆控制统一加 ! 帧头，避免调试文字中的 S/N/T 被芯片误当命令。 */
    const framedCommand = /^[FBSTNOXQC1-9]$/i.test(String(command)) ? `!${String(command).toUpperCase()}\n` : String(command);
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
      if (offset + BLE_CHUNK_SIZE < data.length) await waitMilliseconds(BLE_CHUNK_GAP_MS);
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

  if (valid && values.CROSS_EXIT_SUM >= values.CROSS_SIDE_SUM_MIN) {
    valid = false;
    getParameterInput("CROSS_SIDE_SUM_MIN").classList.add("invalid");
    getParameterInput("CROSS_EXIT_SUM").classList.add("invalid");
    if (showErrors) {
      setParameterRowState("CROSS_SIDE_SUM_MIN", "入口侧和值必须大于退出和值", "error");
      setParameterRowState("CROSS_EXIT_SUM", "退出和值必须小于入口侧和值", "error");
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
  if (key === "VOLTAGE_LEVEL") {
    if (value < 75 || value > 81) return;
    confirmedVoltageLevel = value;
    diagnosticState.voltageLevel = value;
    selectVoltageLevel(value);
    if (pendingVoltageTimer) clearTimeout(pendingVoltageTimer);
    pendingVoltageTimer = null;
    pendingVoltageLevel = 0;
    return;
  }
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
  if (key === "VOLTAGE_LEVEL") {
    if (pendingVoltageTimer) clearTimeout(pendingVoltageTimer);
    pendingVoltageTimer = null;
    pendingVoltageLevel = 0;
    selectVoltageLevel(confirmedVoltageLevel);
    ui.parameterSyncState.textContent = "电压档切换失败";
    ui.parameterSyncState.className = "parameter-sync-state error";
    setMessage(labels[reason] || reason, true);
    return;
  }
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

async function sendParameterOnce(key, value) {
  if (pendingParameterRequests.has(key)) return false;
  setParameterRowState(key, "正在写入…", "pending");
  return new Promise(async (resolve) => {
    const timer = setTimeout(() => {
      pendingParameterRequests.delete(key);
      setParameterRowState(key, "等待芯片回复超时", "error");
      resolve("timeout");
    }, PARAMETER_REPLY_TIMEOUT_MS);
    pendingParameterRequests.set(key, { resolve, timer });
    const sent = await sendCommand(`@SET ${key} ${value}\n`);
    if (!sent) {
      clearTimeout(timer);
      pendingParameterRequests.delete(key);
      setParameterRowState(key, "发送失败", "error");
      resolve("send-failed");
    }
  });
}

/* 只有“等待回复超时”才自动重试；芯片明确拒绝或蓝牙写入失败时不重复发送。 */
async function sendParameterAndWait(key, value) {
  for (let attempt = 0; attempt <= PARAMETER_TIMEOUT_RETRY_COUNT; attempt += 1) {
    const result = await sendParameterOnce(key, value);
    if (result === true) return true;
    if (result !== "timeout" || attempt >= PARAMETER_TIMEOUT_RETRY_COUNT) return false;
    setParameterRowState(key, "首次超时，正在自动重试…", "pending");
    await waitMilliseconds(120);
  }
  return false;
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
    "APPROACH_PID_DIVISOR", "APPROACH_PID_D_GAIN", "APPROACH_PID_LIMIT",
    "CROSS_APPROACH_ERROR", "CROSS_OUTER_MIN", "CROSS_DUAL_PEAK_MIN", "CROSS_OPPOSITE_INNER_MAX",
    "CROSS_EXIT_ERROR", "CROSS_SEQUENCE_MS"];
  if (result.values.CROSS_SIDE_SUM_MIN <= confirmedParameters.CROSS_EXIT_SUM) order.push("CROSS_EXIT_SUM", "CROSS_SIDE_SUM_MIN");
  else order.push("CROSS_SIDE_SUM_MIN", "CROSS_EXIT_SUM");
  if (result.values.CROSS_MAX_MS <= confirmedParameters.CROSS_MIN_MS) order.push("CROSS_MIN_MS", "CROSS_MAX_MS");
  else order.push("CROSS_MAX_MS", "CROSS_MIN_MS");

  let allSucceeded = true;
  for (const key of order) {
    if (!await sendParameterAndWait(key, result.values[key])) { allSucceeded = false; break; }
  }
  ui.applyAllParametersButton.disabled = !diagnosticState.connected;
  ui.parameterSyncState.textContent = allSucceeded ? "全部参数已生效" : "部分参数未生效";
  ui.parameterSyncState.className = `parameter-sync-state ${allSucceeded ? "synced" : "error"}`;
  setMessage(allSucceeded ? "14 个参数已全部写入芯片" : "写入中断，请检查红色提示", !allSucceeded);
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
    const voltageText = `${(confirmedVoltageLevel / 10).toFixed(1)}V`;
    ui.parameterSyncState.textContent = confirmedGear > 0 ? `已同步 · ${voltageText} · ${confirmedGear}档` : `已同步 · ${voltageText}`;
    ui.parameterSyncState.className = "parameter-sync-state synced";
    ui.speedPresets.querySelectorAll("button").forEach((button) => button.classList.remove("pending"));
  }

  const speedMatch = line.match(/\bSPEED\s*=\s*(\d+)%/i);
  const gearMatch = line.match(/\bGEAR\s*=\s*([1-9])\b/i);
  if (gearMatch) {
    confirmedGear = Number(gearMatch[1]);
    selectSpeed(confirmedGear);
    ui.speedPresets.querySelectorAll("button").forEach((button) => button.classList.remove("pending"));
    if (pendingGearParameterRead === confirmedGear) {
      pendingGearParameterRead = 0;
      clearTimeout(pendingGearReadTimer);
      pendingGearReadTimer = null;
      /* 给上一条 BLE 写入留出结束时间，避免 iOS 报 GATT operation in progress。 */
      setTimeout(requestParameters, 50);
    }
  } else if (speedMatch) {
    selectSpeed(Math.round(Number(speedMatch[1]) / 10));
  }

  const crossroadEnableMatch = line.match(/\bCE\s*=\s*([01])\b/i);
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
    const pidModeMatch = line.match(/\bPID_MODE\s*=\s*(NORMAL|APPROACH)/i);
    if (ldMatch) { ui.ldValue.textContent = ldMatch[1]; diagnosticState.ld = Number(ldMatch[1]); }
    if (rdMatch) { ui.rdValue.textContent = rdMatch[1]; diagnosticState.rd = Number(rdMatch[1]); }
    if (lsMatch) { ui.lsValue.textContent = lsMatch[1]; diagnosticState.ls = Number(lsMatch[1]); }
    if (rsMatch) { ui.rsValue.textContent = rsMatch[1]; diagnosticState.rs = Number(rsMatch[1]); }
    if (pidModeMatch) {
      diagnosticState.pidMode = pidModeMatch[1].toUpperCase();
      ui.pidModeValue.textContent = diagnosticState.pidMode === "APPROACH" ? "弱 PD" : "普通 PD";
    }
    if (phaseMatch) updateCrossroad(phaseMatch[1].toUpperCase(), directionMatch ? directionMatch[1].toUpperCase() : diagnosticState.crossroadDirection);
    else if (crossMatch) updateCrossroad(crossMatch[1] === "1" ? "CROSS" : "NORMAL");
    updateDeviation(values[4]);
    recordSensorSample({
      time: Date.now(), l1: values[0], l2: values[1], r1: values[2], r2: values[3], error: values[4],
      ld: ldMatch ? Number(ldMatch[1]) : "", rd: rdMatch ? Number(rdMatch[1]) : "",
      ls: lsMatch ? Number(lsMatch[1]) : "", rs: rsMatch ? Number(rsMatch[1]) : "",
      cross: crossMatch ? Number(crossMatch[1]) : "", phase: phaseMatch ? phaseMatch[1].toUpperCase() : "",
      direction: directionMatch ? directionMatch[1].toUpperCase() : "",
      pidMode: pidModeMatch ? pidModeMatch[1].toUpperCase() : "",
      ce: crossroadEnableMatch ? Number(crossroadEnableMatch[1]) : (diagnosticState.crossroadEnabled ? 1 : 0)
    });
  }

  const distanceMatch = line.match(/DIST\s*=\s*(OUT|\d+)\s*(?:CM)?/i);
  const obstacleMatch = line.match(/(?:OBSTACLE\s*=\s*|OBSTACLE\s+)(CLEAR|SLOW|STOP)/i);
  const avoidanceMatch = line.match(/(?:AVOID\s*=\s*|OBSTACLE\s+)(ON|OFF)\b/i);
  const sensorModeMatch = line.match(/SENSOR\s*(?:=|\s)\s*(ON|OFF)\b/i);
  const crossroadDetectMatch = line.match(/CROSS\s+DETECT\s+(ON|OFF)\b/i);
  if (distanceMatch) updateDistance(distanceMatch[1]);
  if (obstacleMatch) updateObstacle(obstacleMatch[1].toUpperCase());
  if (avoidanceMatch) selectMode(ui.obstacleOnButton, ui.obstacleOffButton, avoidanceMatch[1].toUpperCase() === "ON");
  if (sensorModeMatch) selectMode(ui.sensorOnButton, ui.sensorOffButton, sensorModeMatch[1].toUpperCase() === "ON");
  if (crossroadEnableMatch) setCrossroadDetection(crossroadEnableMatch[1] === "1");
  if (crossroadDetectMatch) setCrossroadDetection(crossroadDetectMatch[1].toUpperCase() === "ON");

  const approachEvent = line.match(/CROSSROAD\s+APPROACH\s+(RIGHT(?:_FIRST)?|LEFT(?:_FIRST)?)/i);
  if (approachEvent) {
    const side = approachEvent[1].toUpperCase().startsWith("RIGHT") ? "RIGHT_FIRST" : "LEFT_FIRST";
    updateCrossroad("APPROACH", side);
  }
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
    TIMEOUT: { text: "十字路口超时保护", code: "TIMEOUT", className: "timeout" },
    DISABLED: { text: "十字检测已关闭", code: "OFF", className: "normal" }
  };
  const selected = states[state] || states.NORMAL;
  ui.crossroadState.className = `crossroad-state ${selected.className}`;
  ui.crossroadValue.textContent = selected.text;
  diagnosticState.crossroad = selected.text;
  diagnosticState.crossroadCode = selected.code;
  diagnosticState.crossroadPhase = state === "TIMEOUT" ? "TIMEOUT" : state;
  diagnosticState.crossroadDirection = state === "NORMAL" || state === "TIMEOUT" ? "NONE" : direction;
}

function setCrossroadDetection(enabled) {
  diagnosticState.crossroadEnabled = Boolean(enabled);
  ui.crossroadToggleButton.dataset.command = enabled ? "C" : "Q";
  ui.crossroadToggleButton.innerHTML = enabled ? "关闭十字检测 <b>C</b>" : "开启十字检测 <b>Q</b>";
  ui.crossroadToggleButton.classList.toggle("selected", enabled);
  ui.crossroadToggleButton.setAttribute("aria-pressed", enabled ? "true" : "false");
  if (!enabled) updateCrossroad("DISABLED");
  else if (diagnosticState.crossroadPhase === "DISABLED") updateCrossroad("NORMAL");
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

function drawSensorChart(forceLight = false) {
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

  const light = forceLight || document.documentElement.dataset.theme === "light";
  const chartColors = light ? {
    background: "#ffffff", grid: "rgba(67,91,116,.18)", gridSoft: "rgba(67,91,116,.11)", text: "#64748b"
  } : {
    background: "#030a12", grid: "rgba(80,116,150,.23)", gridSoft: "rgba(80,116,150,.16)", text: "#667b91"
  };
  ctx.fillStyle = chartColors.background;
  ctx.fillRect(0, 0, width, height);
  ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";

  [0, 1024, 2048, 3072, 4095].forEach((value) => {
    const y = plot.top + plotHeight - (value / 4095) * plotHeight;
    ctx.strokeStyle = chartColors.grid;
    ctx.beginPath(); ctx.moveTo(plot.left, y); ctx.lineTo(width - plot.right, y); ctx.stroke();
    ctx.fillStyle = chartColors.text;
    ctx.textAlign = "right";
    ctx.fillText(String(value), plot.left - 6, y);
  });

  [0, 1, 2, 3, 4].forEach((tick, index) => {
    const x = plot.left + (index / 4) * plotWidth;
    const tickTime = windowStart + (tick / 4) * CHART_WINDOW_MS;
    ctx.strokeStyle = chartColors.gridSoft;
    ctx.beginPath(); ctx.moveTo(x, plot.top); ctx.lineTo(x, height - plot.bottom); ctx.stroke();
    ctx.fillStyle = chartColors.text;
    ctx.textAlign = index === 0 ? "left" : index === 4 ? "right" : "center";
    ctx.fillText(new Date(tickTime).toLocaleTimeString("zh-CN", { hour12: false, minute: "2-digit", second: "2-digit" }), x, height - 12);
  });

  const visible = sensorHistory.filter((point) => point.time >= windowStart && point.time <= windowEnd);
  const enabledSeries = new Set(
    [...document.querySelectorAll('.series-chip input:checked')].map((input) => input.dataset.series)
  );

  if (!visible.length) {
    ctx.fillStyle = chartColors.text;
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
  const rows = ["时间,相对秒,L1,L2,R1,R2,ERROR,LD,RD,LS,RS,CROSS,CE,PHASE,DIR,PID_MODE"];
  sensorHistory.forEach((point) => {
    rows.push([
      new Date(point.time).toISOString(), ((point.time - firstTime) / 1000).toFixed(3),
      point.l1, point.l2, point.r1, point.r2, point.error, point.ld, point.rd,
      point.ls, point.rs, point.cross, point.ce, point.phase, point.direction, point.pidMode
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
    drawSensorChart(true);
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
    scheduleChartDraw();
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
    `当前电压档=${(diagnosticState.voltageLevel / 10).toFixed(1)}V`,
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
    `CE=${diagnosticState.crossroadEnabled ? 1 : 0}`,
    `PHASE=${diagnosticState.crossroadPhase}`, `DIR=${diagnosticState.crossroadDirection}`,
    `PID_MODE=${diagnosticState.pidMode}`,
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
    `电压档=${(diagnosticState.voltageLevel / 10).toFixed(1)}V`,
    `循迹传感器=${diagnosticState.sensorEnabled ? "ON" : "OFF"}`,
    `十字检测=${diagnosticState.crossroadEnabled ? "ON" : "OFF"}`,
    `自动避障=${diagnosticState.obstacleEnabled ? "ON" : "OFF"}`,
    `距离=${diagnosticState.distance}${/^\d+$/.test(String(diagnosticState.distance)) ? "cm" : ""}`,
    `障碍状态=${diagnosticState.obstacle}`,
    `十字路口=${diagnosticState.crossroad}`,
    `十字阶段=${diagnosticState.crossroadPhase}`,
    `入口方向=${diagnosticState.crossroadDirection}`,
    `PID模式=${diagnosticState.pidMode}`,
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
    "时间,相对秒,L1,L2,R1,R2,ERROR,LD,RD,LS,RS,CROSS,CE,PHASE,DIR,PID_MODE"
  ];

  const firstTime = sensorHistory.length ? sensorHistory[0].time : 0;
  sensorHistory.forEach((point) => {
    lines.push([
      new Date(point.time).toISOString(), ((point.time - firstTime) / 1000).toFixed(3),
      point.l1, point.l2, point.r1, point.r2, point.error, point.ld, point.rd,
      point.ls, point.rs, point.cross, point.ce, point.phase, point.direction, point.pidMode
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
  ui.speedReadout.textContent = `当前 ${value} 档`;
  ui.gearContextValue.textContent = `${value} 档`;
  diagnosticState.speed = value * 10;
  ui.speedPresets.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.speed) === value);
  });
}

function selectVoltageLevel(level) {
  const value = Math.max(75, Math.min(81, Number(level)));
  ui.voltageReadout.textContent = `${(value / 10).toFixed(1)}V`;
  ui.voltageContextValue.textContent = `${(value / 10).toFixed(1)}V`;
  ui.voltagePresets.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.voltage) === value);
  });
}

/* 电压由芯片确认后才记为成功；芯片随后会主动返回当前组合的全部参数。 */
async function selectAndSendVoltage(level) {
  const value = Math.max(75, Math.min(81, Number(level)));
  const previous = confirmedVoltageLevel;
  if (value === confirmedVoltageLevel && pendingVoltageLevel === 0) return;
  if (pendingVoltageTimer) clearTimeout(pendingVoltageTimer);
  pendingVoltageLevel = value;
  selectVoltageLevel(value);
  ui.parameterSyncState.textContent = `正在切换到 ${(value / 10).toFixed(1)}V…`;
  ui.parameterSyncState.className = "parameter-sync-state";
  if (!(await sendCommand(`@SET VOLTAGE_LEVEL ${value}\n`))) {
    pendingVoltageLevel = 0;
    selectVoltageLevel(previous);
    return;
  }
  pendingVoltageTimer = setTimeout(() => {
    pendingVoltageTimer = null;
    pendingVoltageLevel = 0;
    selectVoltageLevel(confirmedVoltageLevel);
    ui.parameterSyncState.textContent = "电压档切换超时";
    ui.parameterSyncState.className = "parameter-sync-state error";
  }, PARAMETER_REPLY_TIMEOUT_MS);
}

/* 换挡后等待芯片返回 GEAR 确认，再读取该档独立 PD；超时后执行一次兜底读取。 */
async function selectAndSendSpeed(speed) {
  const gear = Math.max(1, Math.min(9, Number(speed)));
  selectSpeed(gear);
  clearTimeout(pendingGearReadTimer);
  pendingGearReadTimer = null;
  pendingGearParameterRead = gear;
  ui.speedPresets.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("pending", Number(button.dataset.speed) === gear);
  });
  ui.parameterSyncState.textContent = `正在切换到 ${gear} 档…`;
  ui.parameterSyncState.className = "parameter-sync-state";
  if (await sendCommand(String(gear))) {
    pendingGearReadTimer = setTimeout(() => {
      if (pendingGearParameterRead !== gear) return;
      pendingGearParameterRead = 0;
      pendingGearReadTimer = null;
      requestParameters();
    }, GEAR_REPLY_TIMEOUT_MS);
  } else {
    pendingGearParameterRead = 0;
    ui.speedPresets.querySelectorAll("button").forEach((button) => button.classList.remove("pending"));
  }
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
ui.reconnectButton.addEventListener("click", () => reconnectRememberedDevice(false));
ui.disconnectButton.addEventListener("click", disconnectBluetooth);
ui.themeToggleButton.addEventListener("click", toggleTheme);

document.querySelectorAll(".page-tab").forEach((button) => {
  button.addEventListener("click", () => selectPage(button.dataset.pageTarget));
});

document.querySelectorAll(".parameter-group").forEach((group) => {
  group.addEventListener("toggle", () => {
    if (!group.open) return;
    document.querySelectorAll(".parameter-group").forEach((otherGroup) => {
      if (otherGroup !== group) otherGroup.open = false;
    });
  });
});

document.querySelectorAll(".control-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const command = button.dataset.command;
    const sent = await sendCommand(command);
    if (!sent) return;
    if (button === ui.sensorOnButton || button === ui.sensorOffButton) {
      selectMode(ui.sensorOnButton, ui.sensorOffButton, button === ui.sensorOnButton);
    }
    if (button === ui.obstacleOnButton || button === ui.obstacleOffButton) {
      selectMode(ui.obstacleOnButton, ui.obstacleOffButton, button === ui.obstacleOnButton);
    }
    if (button === ui.crossroadToggleButton) {
      setCrossroadDetection(String(command).toUpperCase() === "Q");
    }
  });
});

ui.speedSlider.addEventListener("input", () => selectSpeed(ui.speedSlider.value));
ui.speedSlider.addEventListener("change", () => selectAndSendSpeed(ui.speedSlider.value));
ui.speedPresets.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => {
    selectAndSendSpeed(button.dataset.speed);
  });
});
ui.voltagePresets.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => selectAndSendVoltage(button.dataset.voltage));
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

let initialTheme = "dark";
try { initialTheme = localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark"; } catch (_) {}
applyTheme(initialTheme);
setConnected(false);
const rememberedDeviceOnLoad = updateRememberedDeviceUi();
selectSpeed(3);
selectVoltageLevel(80);
selectMode(ui.sensorOnButton, ui.sensorOffButton, true);
setCrossroadDetection(false);
selectMode(ui.obstacleOnButton, ui.obstacleOffButton, true);
updateCrossroad("DISABLED");
updateChartControls();
scheduleChartDraw();
if (rememberedDeviceOnLoad) {
  setMessage(`正在准备自动连接上次设备：${rememberedDeviceOnLoad.name || "未命名设备"}`);
  setTimeout(() => reconnectRememberedDevice(true), 300);
}
