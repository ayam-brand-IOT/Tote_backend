// Configuration
const CONFIG = {
  reconnectBaseDelay: 1000,
  reconnectMaxDelay: 30000,
  reconnectMultiplier: 1.5,
  esp32TimeoutMs: 15000,  // 15 seconds timeout
  heartbeatCheckInterval: 3000,  // Check every 3 seconds
  station: window.STATION || 'all',  // 'inbound', 'outbound', or 'all'
};

// State
const state = {
  ws: null,
  reconnectAttempts: 0,
  reconnectTimeout: null,
  esp32Connected: false,
  esp32LastSeen: null,
  esp32HeartbeatTimer: null,
};

// DOM Elements
const dom = {
  wsDot: document.getElementById('wsDot'),
  wsStatusText: document.getElementById('wsStatusText'),
  esp32Dot: document.getElementById('esp32Dot'),
  esp32StatusText: document.getElementById('esp32StatusText'),
  toteStateCard: document.getElementById('toteStateCard'),
  stateIcon: document.getElementById('stateIcon'),
  stateName: document.getElementById('stateName'),
  toteId: document.getElementById('toteId'),
  fishWeight: document.getElementById('fishWeight'),
  iceDispensed: document.getElementById('iceDispensed'),
  waterDispensed: document.getElementById('waterDispensed'),
  lastUpdate: document.getElementById('lastUpdate'),
  weightValue: document.getElementById('weightValue'),
  weightTimestamp: document.getElementById('weightTimestamp'),
  scanBtn: document.getElementById('scanBtn'),
  messageDiv: document.getElementById('message'),
  eventList: document.getElementById('eventList'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  historyBody: document.getElementById('historyBody'),
  historyRefreshBtn: document.getElementById('historyRefreshBtn'),
  qrModal: document.getElementById('qrModal'),
  qrVideo: document.getElementById('qr-video'),
  modalClose: document.getElementById('closeModal'),
  modalStatus: document.getElementById('modalStatus'),
};

// QR Scanner
let videoStream = null;
let qrScanInterval = null;


// WebSocket
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname;
  const wsUrl = window.location.protocol === 'https:' ?  protocol + '//' + host + '/ws' : protocol + '//' + host + ':3001';
  
  updateWSStatus('connecting', 'Connecting...');
  logEvent('info', 'Connecting...');
  
  state.ws = new WebSocket(wsUrl);
  
  state.ws.onopen = function() {
    state.reconnectAttempts = 0;
    updateWSStatus('connected', 'Connected');
    logEvent('success', 'Connected');
    startESP32HeartbeatMonitoring();
  };
  
  state.ws.onmessage = function(event) {
    try {
      const message = JSON.parse(event.data);
      handleWebSocketMessage(message);
    } catch (error) {
      logEvent('error', 'Parse error: ' + error.message);
    }
  };
  
  state.ws.onerror = function() {
    logEvent('error', 'WebSocket error');
  };
  
  state.ws.onclose = function() {
    updateWSStatus('disconnected', 'Disconnected');
    updateESP32Status('unknown', 'Waiting...');
    logEvent('warning', 'Disconnected');
    stopESP32HeartbeatMonitoring();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (state.reconnectTimeout) clearTimeout(state.reconnectTimeout);
  const delay = Math.min(CONFIG.reconnectBaseDelay * Math.pow(CONFIG.reconnectMultiplier, state.reconnectAttempts), CONFIG.reconnectMaxDelay);
  state.reconnectAttempts++;
  updateWSStatus('reconnecting', 'Reconnecting in ' + Math.ceil(delay / 1000) + 's...');
  state.reconnectTimeout = setTimeout(connectWebSocket, delay);
}

function handleWebSocketMessage(message) {
  // Filter messages by station if specified
  if (CONFIG.station !== 'all' && message.station && message.station !== CONFIG.station) {
    return; // Ignore messages from other stations
  }
  
  if (message.type === 'update' && message.data) {
    handleInnerData(message.data);
    if (message.esp32Connected) markESP32Alive();
  } else {
    handleInnerData(message);
  }
}

function handleInnerData(data) {
  markESP32Alive();
  if (data.state) updateToteState(data.state, data.toteId || data.tote_id);
  if (data.weight !== undefined) updateWeight(data.weight);
  if (data.type === 'ice_dispensed') {
    updateIceDispensed(data.ice_kg);
    logEvent('success', 'Ice dispensed: ' + data.ice_kg.toFixed(2) + ' kg');
  }
  if (data.type === 'water_dispensed') {
    updateWaterDispensed(data.water_kg);
    logEvent('success', 'Water dispensed: ' + data.water_kg.toFixed(2) + ' kg');
  }
  if (data.type === 'tote_validated') {
    showToast('Tote ' + data.toteId + ' encontrado', 'success');
    logEvent('success', 'Tote ' + data.toteId + ' validated');
  }
  if (data.type === 'tote_completed') {
    const fishKgLabel = data.fish_kg !== undefined ? data.fish_kg + ' kg' : '-- kg';
    showToast('Tote ' + data.toteId + ' — Fish: ' + fishKgLabel, 'success');
    logEvent('success', 'Tote ' + data.toteId + ' completed outbound — fish_kg: ' + fishKgLabel);
    if (dom.fishWeight) dom.fishWeight.textContent = fishKgLabel;
    fetchHistory();
  }
  if (data.type === 'tote_created') {
    showToast('Tote ' + data.toteId + ' guardado — ' + data.tote_kg + ' kg', 'success');
    logEvent('success', 'Tote ' + data.toteId + ' created: ' + data.tote_kg + 'kg');
    fetchHistory();
  }
  if (data.type === 'error') {
    showToast(data.message, 'error');
    logEvent('error', 'ESP32 Error: ' + data.message);
  }
  if (data.type === 'settings_current') {
    populateSettingsPanel(data);
  }
}

function startESP32HeartbeatMonitoring() {
  stopESP32HeartbeatMonitoring();
  state.esp32HeartbeatTimer = setInterval(function() {
    if (!state.esp32LastSeen) {
      updateESP32Status('unknown', 'Waiting...');
      return;
    }
    const timeSinceLastSeen = Date.now() - state.esp32LastSeen;
    if (timeSinceLastSeen > CONFIG.esp32TimeoutMs) {
      if (state.esp32Connected) {
        state.esp32Connected = false;
        updateESP32Status('offline', 'Offline');
        logEvent('error', 'ESP32 timeout');
      }
    } else if (!state.esp32Connected) {
      state.esp32Connected = true;
      updateESP32Status('online', 'Connected');
      logEvent('success', 'ESP32 connected');
    }
  }, CONFIG.heartbeatCheckInterval);
}

function stopESP32HeartbeatMonitoring() {
  if (state.esp32HeartbeatTimer) {
    clearInterval(state.esp32HeartbeatTimer);
    state.esp32HeartbeatTimer = null;
  }
}

function markESP32Alive() {
  const wasOffline = !state.esp32Connected;
  state.esp32LastSeen = Date.now();
  state.esp32Connected = true;
  if (wasOffline) {
    updateESP32Status('online', 'Connected');
    logEvent('success', 'ESP32 online');
    // Auto-fetch current settings whenever the ESP32 comes online
    requestSettings();
  } else {
    updateESP32Status('online', 'Connected');
  }
}

function updateWSStatus(status, text) {
  if (!dom.wsStatusText) return;
  dom.wsStatusText.textContent = text;
  dom.wsDot.className = 'status-dot ' + (status === 'connected' ? 'online' : status === 'disconnected' ? 'offline' : 'warning');
}

function updateESP32Status(status, text) {
  if (!dom.esp32StatusText) return;
  dom.esp32StatusText.textContent = text;
  dom.esp32Dot.className = 'status-dot ' + (status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'warning');
}

let previousToteState = 'IDLE';

function updateToteState(stateName, toteId) {
  // Reset values when a NEW cycle starts (leaving IDLE → first active state)
  if (previousToteState === 'IDLE' && stateName !== 'IDLE') {
    dom.toteId.textContent = '--';
    dom.iceDispensed.textContent = '-- kg';
    dom.waterDispensed.textContent = '-- kg';
    if (dom.fishWeight) dom.fishWeight.textContent = '-- kg';
  }
  previousToteState = stateName;

  const STATE_LABELS = {
    'IDLE': 'Idle — ready', 'WAITING_TOTE_ID': 'Waiting for tote',
    'DISPENSING_ICE': 'Dispensing ice', 'ADDING_WATER': 'Adding water',
    'COMPLETED': 'Completed', 'ERROR': 'Error',
  };
  dom.stateName.textContent = STATE_LABELS[stateName] || stateName;
  dom.lastUpdate.textContent = formatTime(new Date());
  const svg = (p) => `<svg class="ic-state" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const icons = {
    'IDLE':            svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    'WAITING_TOTE_ID': svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    'DISPENSING_ICE':  svg('<line x1="2" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="22"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/>'),
    'ADDING_WATER':    svg('<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>'),
    'COMPLETED':       svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>'),
    'ERROR':           svg('<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>'),
  };
  dom.stateIcon.innerHTML = icons[stateName] || icons['IDLE'];
  if (stateName !== 'IDLE') {
    dom.toteStateCard.classList.add('active');
    dom.toteId.textContent = toteId || '--';
  } else {
    dom.toteStateCard.classList.remove('active');
  }
  logEvent('info', 'State: ' + stateName + (toteId ? ' (' + toteId + ')' : ''));
}

function updateWeight(weight) {
  dom.weightValue.textContent = weight.toFixed(2);
  dom.weightTimestamp.textContent = 'Updated ' + formatTime(new Date());
}

function updateIceDispensed(ice_kg) {
  dom.iceDispensed.textContent = ice_kg.toFixed(2) + ' kg';
}

function updateWaterDispensed(water_kg) {
  dom.waterDispensed.textContent = water_kg.toFixed(2) + ' kg';
}

function showMessage(text, type) {
  dom.messageDiv.className = 'message ' + type;
  dom.messageDiv.textContent = text;
  dom.messageDiv.style.display = 'block';
  setTimeout(function() { dom.messageDiv.style.display = 'none'; }, 5000);
}

function showToast(text, type) {
  type = type || 'info';
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = text;
  document.body.appendChild(toast);
  // Trigger entrance animation
  requestAnimationFrame(function() {
    requestAnimationFrame(function() { toast.classList.add('toast-visible'); });
  });
  // Auto-dismiss after 4 seconds
  setTimeout(function() {
    toast.classList.remove('toast-visible');
    toast.classList.add('toast-hiding');
    setTimeout(function() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 400);
  }, 4000);
}

function logEvent(type, message) {
  const item = document.createElement('div');
  item.className = 'event-item ' + type;
  const time = document.createElement('span');
  time.className = 'event-time';
  time.textContent = formatTime(new Date());
  const msg = document.createElement('span');
  msg.className = 'event-message';
  msg.textContent = message;
  item.appendChild(time);
  item.appendChild(msg);
  dom.eventList.insertBefore(item, dom.eventList.firstChild);
  while (dom.eventList.children.length > 50) {
    dom.eventList.removeChild(dom.eventList.lastChild);
  }
}

function startQRScanner() {
  dom.qrModal.classList.add('active');
  dom.modalStatus.textContent = 'Initializing camera...';
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(function(stream) {
      videoStream = stream;
      dom.qrVideo.srcObject = stream;
      dom.modalStatus.textContent = 'Position QR code in frame';
      qrScanInterval = setInterval(scanQRCode, 250);
    })
    .catch(function() {
      dom.modalStatus.textContent = 'Camera access denied';
      showMessage('Cannot access camera', 'error');
    });
}

function stopQRScanner() {
  if (videoStream) {
    videoStream.getTracks().forEach(function(track) { track.stop(); });
    videoStream = null;
  }
  if (qrScanInterval) {
    clearInterval(qrScanInterval);
    qrScanInterval = null;
  }
  dom.qrModal.classList.remove('active');
}

function scanQRCode() {
  if (dom.qrVideo.readyState !== dom.qrVideo.HAVE_ENOUGH_DATA) return;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.width = dom.qrVideo.videoWidth;
  canvas.height = dom.qrVideo.videoHeight;
  context.drawImage(dom.qrVideo, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height);
  if (code) {
    dom.modalStatus.textContent = 'Scanned: ' + code.data;
    sendQRScanned(code.data);
    setTimeout(stopQRScanner, 1000);
  }
}

function sendQRScanned(toteId) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showMessage('WebSocket not connected', 'error');
    logEvent('error', 'Cannot send QR - not connected');
    return;
  }
  state.ws.send(JSON.stringify({ 
    type: 'qr_scanned', 
    toteId: toteId,
    station: CONFIG.station  // Include station identifier
  }));
  showMessage('QR sent: ' + toteId, 'success');
  logEvent('info', 'QR scanned: ' + toteId);
}

function sendSettings(iceKg, waterKg, minW) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showMessage('Not connected — cannot save settings', 'error');
    return;
  }
  state.ws.send(JSON.stringify({
    type: 'update_settings',
    station: CONFIG.station,
    ice_kg:   parseFloat(iceKg),
    water_kg: parseFloat(waterKg),
    min_w:    parseFloat(minW)
  }));
  logEvent('info', 'Settings sent to ESP32');
}

function requestSettings() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showMessage('Not connected — cannot load settings', 'error');
    return;
  }
  state.ws.send(JSON.stringify({ type: 'get_settings', station: CONFIG.station }));
  logEvent('info', 'Requesting current settings from ESP32');
}

function populateSettingsPanel(data) {
  const iceInput   = document.getElementById('cfg-ice-kg');
  const waterInput = document.getElementById('cfg-water-kg');
  const minInput   = document.getElementById('cfg-min-w');
  const feedbackEl = document.getElementById('cfg-feedback');
  if (iceInput   && data.ice_kg   !== undefined) iceInput.value   = parseFloat(data.ice_kg).toFixed(1);
  if (waterInput && data.water_kg !== undefined) waterInput.value = parseFloat(data.water_kg).toFixed(1);
  if (minInput   && data.min_w    !== undefined) minInput.value   = parseFloat(data.min_w).toFixed(1);
  if (feedbackEl) {
    feedbackEl.textContent = 'Confirmed by ESP32';
    feedbackEl.className = 'cfg-feedback cfg-ok';
    setTimeout(function() { feedbackEl.textContent = ''; feedbackEl.className = 'cfg-feedback'; }, 3000);
  }
  logEvent('success', 'Settings confirmed: ice=' + (data.ice_kg !== undefined ? parseFloat(data.ice_kg).toFixed(1) : '--') + ' water=' + (data.water_kg !== undefined ? parseFloat(data.water_kg).toFixed(1) : '--') + ' min=' + (data.min_w !== undefined ? parseFloat(data.min_w).toFixed(1) : '--') + ' kg');
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

dom.scanBtn.addEventListener('click', function() {
  if (!state.esp32Connected) {
    showMessage('ESP32 not connected', 'error');
    return;
  }
  startQRScanner();
});

dom.modalClose.addEventListener('click', stopQRScanner);
dom.clearLogBtn.addEventListener('click', function() {
  if (confirm('Clear log?')) {
    dom.eventList.innerHTML = '';
    logEvent('info', 'Log cleared');
  }
});

dom.qrModal.addEventListener('click', function(e) {
  if (e.target === dom.qrModal) stopQRScanner();
});

// ==================== Settings panel ====================
const cfgSaveBtn = document.getElementById('cfg-save');
const cfgLoadBtn = document.getElementById('cfg-load');
if (cfgSaveBtn) {
  cfgSaveBtn.addEventListener('click', function() {
    const ice   = document.getElementById('cfg-ice-kg').value;
    const water = document.getElementById('cfg-water-kg').value;
    const minW  = document.getElementById('cfg-min-w').value;
    if (!ice || !water || !minW) { showMessage('Fill all settings fields', 'error'); return; }
    sendSettings(ice, water, minW);
    const feedbackEl = document.getElementById('cfg-feedback');
    if (feedbackEl) {
      feedbackEl.textContent = 'Saving…';
      feedbackEl.className = 'cfg-feedback cfg-pending';
    }
  });
}
if (cfgLoadBtn) {
  cfgLoadBtn.addEventListener('click', function() {
    requestSettings();
    const feedbackEl = document.getElementById('cfg-feedback');
    if (feedbackEl) {
      feedbackEl.textContent = 'Loading…';
      feedbackEl.className = 'cfg-feedback cfg-pending';
    }
  });
}
// =========================================================

logEvent('info', 'Application started');
connectWebSocket();
fetchHistory();

// Auto-refresh history every 60 seconds
setInterval(fetchHistory, 60000);

if (dom.historyRefreshBtn) {
  dom.historyRefreshBtn.addEventListener('click', fetchHistory);
}

window.addEventListener('beforeunload', function() {
  stopQRScanner();
  stopESP32HeartbeatMonitoring();
  if (state.ws) state.ws.close();
});

// ==================== History ====================
async function fetchHistory() {
  if (!dom.historyBody) return;
  try {
    const res = await fetch('/api/totes');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const totes = data.totes || [];
    if (CONFIG.station === 'inbound') {
      renderHistoryInbound(totes);
    } else if (CONFIG.station === 'outbound') {
      renderHistoryOutbound(totes);
    }
  } catch (err) {
    if (dom.historyBody) {
      dom.historyBody.innerHTML = '<tr><td colspan="7" class="history-empty">Error loading history</td></tr>';
    }
  }
}

function fmtKg(v) {
  if (v === null || v === undefined) return '—';
  return parseFloat(v).toFixed(2);
}

function fmtHistoryDate(str) {
  if (!str) return '—';
  const d = new Date(str);
  return d.toLocaleDateString('es-MX', { month: '2-digit', day: '2-digit' }) +
    ' ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function statusBadge(status) {
  return '<span class="history-status ' + (status || 'empty') + '">' + (status || 'empty') + '</span>';
}

function renderHistoryInbound(allTotes) {
  // Show last 15 totes (all statuses) ordered by most recent
  const rows = allTotes.slice(0, 15);
  if (!rows.length) {
    dom.historyBody.innerHTML = '<tr><td colspan="6" class="history-empty">No totes yet</td></tr>';
    return;
  }
  dom.historyBody.innerHTML = rows.map(function(t) {
    return '<tr>' +
      '<td class="history-tote-id">' + (t.tote_id || '—') + '</td>' +
      '<td>' + fmtKg(t.tote_kg) + '</td>' +
      '<td>' + fmtKg(t.ice_kg) + '</td>' +
      '<td>' + fmtKg(t.water_kg) + '</td>' +
      '<td>' + statusBadge(t.status) + '</td>' +
      '<td>' + fmtHistoryDate(t.created_at) + '</td>' +
      '</tr>';
  }).join('');
}

function renderHistoryOutbound(allTotes) {
  // Show totes that went through outbound (have fish_kg set)
  const rows = allTotes.filter(function(t) {
    return t.fish_kg !== null && t.fish_kg !== undefined;
  }).slice(0, 15);
  if (!rows.length) {
    dom.historyBody.innerHTML = '<tr><td colspan="7" class="history-empty">No outbound totes yet</td></tr>';
    return;
  }
  dom.historyBody.innerHTML = rows.map(function(t) {
    return '<tr>' +
      '<td class="history-tote-id">' + (t.tote_id || '—') + '</td>' +
      '<td>' + fmtKg(t.fish_kg) + '</td>' +
      '<td>' + fmtKg(t.ice_out_kg) + '</td>' +
      '<td>' + fmtKg(t.water_out_kg) + '</td>' +
      '<td>' + (t.temp_out !== null && t.temp_out !== undefined ? parseFloat(t.temp_out).toFixed(1) : '—') + '</td>' +
      '<td>' + statusBadge(t.status) + '</td>' +
      '<td>' + fmtHistoryDate(t.created_at) + '</td>' +
      '</tr>';
  }).join('');
}
