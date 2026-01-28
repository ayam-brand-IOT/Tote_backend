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
  iceDispensed: document.getElementById('iceDispensed'),
  waterDispensed: document.getElementById('waterDispensed'),
  lastUpdate: document.getElementById('lastUpdate'),
  weightValue: document.getElementById('weightValue'),
  weightTimestamp: document.getElementById('weightTimestamp'),
  scanBtn: document.getElementById('scanBtn'),
  messageDiv: document.getElementById('message'),
  eventList: document.getElementById('eventList'),
  clearLogBtn: document.getElementById('clearLogBtn'),
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
    showMessage('Tote ' + data.toteId + ' validated!', 'success');
    logEvent('success', 'Tote ' + data.toteId + ' validated');
  }
  if (data.type === 'tote_created') {
    showMessage('Tote ' + data.toteId + ' created', 'success');
    logEvent('success', 'Tote ' + data.toteId + ' created: ' + data.tote_kg + 'kg');
  }
  if (data.type === 'error') {
    showMessage('ERROR: ' + data.message, 'error');
    logEvent('error', 'ESP32 Error: ' + data.message);
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

function updateToteState(stateName, toteId) {
  dom.stateName.textContent = stateName;
  dom.toteId.textContent = toteId || '--';
  dom.lastUpdate.textContent = formatTime(new Date());
  const icons = {'IDLE': '⏳', 'WAITING_TOTE_ID': '🔍', 'DISPENSING_ICE': '🧊', 'ADDING_WATER': '💧', 'COMPLETED': '✅', 'ERROR': '❌'};
  dom.stateIcon.textContent = icons[stateName] || '⏳';
  if (stateName !== 'IDLE') {
    dom.toteStateCard.classList.add('active');
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

logEvent('info', 'Application started');
connectWebSocket();

window.addEventListener('beforeunload', function() {
  stopQRScanner();
  stopESP32HeartbeatMonitoring();
  if (state.ws) state.ws.close();
});
