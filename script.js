'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const authEndpoint = '/.netlify/functions/auth';
  const topicRoot = 'sinchai-sarthi/';
  const defaults = {soil: {min: 40, max: 60}, temperature: {min: 15, max: 25}, humidity: {min: 50, max: 70}};
  const sensorDefinitions = {
    soil: {label: 'Soil moisture', unit: '%', min: 0, max: 100},
    temperature: {label: 'Temperature', unit: '°C', min: -50, max: 80},
    humidity: {label: 'Humidity', unit: '%', min: 0, max: 100}
  };
  const sectionDefinitions = {
    overview: ['Overview', 'Your farm at a glance.', 'Stay in tune with your crops, water, and sunshine.'],
    settings: ['Settings', 'Every crop has a comfort zone.', 'Set the ideal conditions for your field.'],
    sensors: ['Sensor Readings', 'Listen to your field.', 'Your latest readings, compared with your ideal ranges.'],
    npk: ['NPK Nutrients', 'Healthy soil. Stronger roots.', 'Nitrogen, phosphorus, and potassium insights.'],
    solar: ['Solar Panel Control', 'Make the most of the sunshine.', 'Send movement and angle commands to your solar panel.'],
    controls: ['Valve / Motor Control', 'Give every drop a purpose.', 'Manage irrigation with care, directly from your dashboard.'],
    history: ['History', 'A little perspective goes a long way.', 'Follow your field’s conditions over time.'],
    notifications: ['Notifications', 'The updates that matter.', 'Keep an eye on changes that need your attention.']
  };
  const state = {
    active: false, section: 'overview', client: null, mqttState: 'DISCONNECTED', telemetry: null,
    lastTelemetry: 0, mainStatus: null, freshness: 'OFFLINE', ranges: loadRanges(), history: loadHistory(),
    notifications: [], alerts: {}, toastTimer: null, sessionTimer: null, pendingCommands: new Set()
  };

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
  }

  function icon(name) {
    return `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;
  }

  function readStorage(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }

  function validRange(key, range) {
    const limits = key === 'temperature' ? [-50, 80] : [0, 100];
    return range && finite(range.min) && finite(range.max) && range.min < range.max && range.min >= limits[0] && range.max <= limits[1];
  }

  function loadRanges() {
    const saved = readStorage('ss-ideal-ranges');
    return Object.fromEntries(Object.entries(defaults).map(([key, range]) => [key, validRange(key, saved?.[key]) ? {min: saved[key].min, max: saved[key].max} : {...range}]));
  }

  function loadHistory() {
    const saved = readStorage('ss-reading-history');
    if (!Array.isArray(saved)) return [];
    return saved.filter(point => point && finite(point.time) && point.time > 0 && point.time <= Date.now() && ['soil', 'temperature', 'humidity'].every(key => point[key] === null || finite(point[key])))
      .sort((first, second) => first.time - second.time)
      .filter((point, index, points) => index === 0 || point.time - points[index - 1].time >= 30000).slice(-300);
  }

  function showScreen(screen) {
    for (const name of ['welcome', 'login', 'dashboard']) byId(name).hidden = name !== screen;
    window.scrollTo(0, 0);
  }

  function updateClock() {
    const now = new Date();
    byId('welcomeTime').textContent = now.toLocaleTimeString('en-IN', {timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true});
    byId('welcomeDate').textContent = now.toLocaleDateString('en-IN', {timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'});
    byId('dashboardDate').textContent = now.toLocaleDateString('en-IN', {timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'});
  }

  function weatherDescription(code) {
    if (code === 0) return 'Clear skies';
    if ([1, 2, 3].includes(code)) return 'Partly cloudy / overcast';
    if ([45, 48].includes(code)) return 'Foggy conditions';
    if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain / showers';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
    if ([95, 96, 99].includes(code)) return 'Thunderstorms';
    return 'Conditions unavailable';
  }

  async function updateWeather() {
    try {
      const response = await fetch('https://api.open-meteo.com/v1/forecast?latitude=26.91&longitude=75.79&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=Asia%2FKolkata', {signal: AbortSignal.timeout(10000), cache: 'no-store'});
      if (!response.ok) throw new Error('Weather unavailable');
      const weather = (await response.json()).current;
      if (!weather) throw new Error('Weather unavailable');
      byId('weatherTemp').textContent = finite(weather.temperature_2m) ? `${weather.temperature_2m.toFixed(1)}°C` : 'N/A';
      byId('weatherHumidity').textContent = finite(weather.relative_humidity_2m) ? `${weather.relative_humidity_2m}%` : 'N/A';
      byId('weatherWind').textContent = finite(weather.wind_speed_10m) ? `${weather.wind_speed_10m} km/h` : 'N/A';
      byId('weatherDescription').textContent = weatherDescription(weather.weather_code);
      byId('weatherUpdated').textContent = `Open-Meteo · Updated ${new Date().toLocaleTimeString('en-IN', {timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit'})} IST`;
    } catch {
      for (const id of ['weatherTemp', 'weatherHumidity', 'weatherWind']) byId(id).textContent = 'N/A';
      byId('weatherDescription').textContent = 'Weather unavailable. Retrying shortly.';
      byId('weatherUpdated').textContent = 'Open-Meteo could not be reached. No forecast is being shown.';
    }
  }

  async function authRequest(action, options = {}) {
    return fetch(`${authEndpoint}?a=${action}`, {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000), ...options});
  }

  async function getCredentials() {
    const response = await authRequest('creds');
    if (response.status === 401) return null;
    if (!response.ok) throw new Error('Unable to verify your session. Please try again.');
    return response.json();
  }

  function enterDashboard(credentials) {
    state.active = true;
    showScreen('dashboard');
    selectSection('overview');
    renderReadings();
    connectMqtt(credentials);
    clearInterval(state.sessionTimer);
    state.sessionTimer = setInterval(async () => {
      try {
        if (!await getCredentials()) {
          stopDashboard();
          showScreen('login');
          byId('loginError').textContent = 'Your session expired. Please sign in again.';
        }
      } catch {}
    }, 60000);
  }

  function discardPendingCommands(client) {
    for (const messageId of state.pendingCommands) client.removeOutgoingMessage(messageId);
    state.pendingCommands.clear();
  }

  function stopDashboard() {
    state.active = false;
    clearInterval(state.sessionTimer);
    clearTimeout(state.toastTimer);
    byId('toast').hidden = true;
    const client = state.client;
    state.client = null;
    if (client) {
      discardPendingCommands(client);
      client.end(true);
    }
    state.telemetry = null;
    state.lastTelemetry = 0;
    state.mainStatus = null;
    state.notifications = [];
    state.alerts = {};
    state.mqttState = 'DISCONNECTED';
    state.freshness = 'OFFLINE';
    closeSidebar();
    renderReadings();
    renderNotifications();
  }

  function setMqttState(value) {
    state.mqttState = value;
    updateFreshness();
    renderReadings();
  }

  function connectMqtt(credentials) {
    if (!window.mqtt) {
      setMqttState('ERROR');
      toast('MQTT library unavailable. Check your internet connection and reload.', true);
      return;
    }
    try {
      const url = new URL(credentials.url);
      if (url.protocol !== 'wss:' || !credentials.username || !credentials.password) throw new Error('Invalid configuration');
    } catch {
      setMqttState('ERROR');
      toast('MQTT is not configured yet. Complete the three MQTT web-account values in the Function.', true);
      return;
    }
    setMqttState('DISCONNECTED');
    try {
      const client = window.mqtt.connect(credentials.url, {
        username: credentials.username, password: credentials.password,
        clientId: `ss-web-${crypto.randomUUID()}`, reconnectPeriod: 4000, connectTimeout: 10000,
        clean: true, queueQoSZero: false, resubscribe: false
      });
      state.client = client;
      const current = () => state.client === client && state.active;
      client.on('connect', () => {
        if (!current()) return;
        setMqttState('CONNECTED');
        client.subscribe([`${topicRoot}main/#`, `${topicRoot}transmitter/#`, `${topicRoot}status/#`], {qos: 1}, (error, granted) => {
          if (!current()) return;
          if (error || granted?.some(subscription => subscription.qos === 128)) {
            setMqttState('ERROR');
            toast('Broker subscription failed. Check the web account topic permissions.', true);
          }
        });
      });
      client.on('reconnect', () => { if (current()) setMqttState('RECONNECTING'); });
      client.on('offline', () => { if (current()) setMqttState('DISCONNECTED'); });
      client.on('close', () => {
        if (!current()) return;
        discardPendingCommands(client);
        setMqttState('DISCONNECTED');
      });
      client.on('error', () => {
        if (!current()) return;
        setMqttState('ERROR');
        toast('MQTT connection error. Check broker availability and web-account permissions.', true);
      });
      client.on('packetsend', packet => {
        if (current() && packet.cmd === 'publish' && packet.topic.startsWith(`${topicRoot}commands/`)) state.pendingCommands.add(packet.messageId);
      });
      client.on('packetreceive', packet => {
        if (packet.cmd === 'puback') state.pendingCommands.delete(packet.messageId);
      });
      client.on('message', (topic, payload, packet) => {
        if (!current()) return;
        if (topic === `${topicRoot}status/main`) {
          const status = payload.toString().trim().toLowerCase();
          if (status === 'online' || status === 'offline') {
            state.mainStatus = status;
            updateFreshness();
            evaluateAlerts();
            renderReadings();
          }
          return;
        }
        if (topic !== `${topicRoot}main/telemetry`) return;
        try {
          const telemetry = JSON.parse(payload.toString());
          if (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)) return;
          if (!['soil', 'temperature', 'humidity', 'device', 'ts', 'espnow', 'pump', 'valve', 'rain', 'flow', 'total', 'solar', 'wifi', 'rssi', 'npk'].some(key => Object.hasOwn(telemetry, key))) return;
          state.telemetry = telemetry;
          if (packet?.retain) {
            const deviceTime = parseDeviceTime(telemetry.ts);
            state.lastTelemetry = Number.isFinite(deviceTime) ? Math.min(Date.now(), deviceTime) : 0;
          } else {
            state.lastTelemetry = Date.now();
          }
          updateFreshness();
          if (state.freshness === 'LIVE') {
            recordHistory();
            evaluateAlerts();
          }
          renderReadings();
        } catch {}
      });
    } catch {
      setMqttState('ERROR');
      toast('MQTT connection could not be started.', true);
    }
  }

  function parseDeviceTime(value) {
    if (typeof value !== 'string') return NaN;
    const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}+05:30`;
    return Date.parse(timestamp);
  }

  function updateFreshness() {
    const age = state.lastTelemetry ? Date.now() - state.lastTelemetry : Infinity;
    const next = state.mainStatus === 'offline' || state.mqttState !== 'CONNECTED' || age >= 45000 ? 'OFFLINE' : age >= 15000 ? 'STALE DATA' : 'LIVE';
    state.freshness = next;
    byId('liveBadge').textContent = next;
    byId('liveBadge').className = `badge ${next === 'LIVE' ? 'live' : next === 'STALE DATA' ? 'stale' : 'offline'}`;
    byId('dataNotice').hidden = next === 'LIVE';
    byId('dataNotice').textContent = !state.telemetry ? 'Waiting for your device. No live readings received yet.' : next === 'STALE DATA' ? 'Telemetry is delayed. Dimmed values are old readings, not live data.' : 'Your device or browser connection is offline. Dimmed values are old readings, not live data.';
    if (state.active && (state.lastTelemetry || state.mainStatus === 'offline')) setAlert('offline', next === 'OFFLINE' || state.telemetry?.wifi === false, 'ESP32 offline — check the device and its connection.');
  }

  function numeric(value, unit = '') {
    return finite(value) ? `${Number(value.toFixed(2))}${unit ? ` ${unit}` : ''}` : 'N/A';
  }

  function booleanLabel(value, yes, no) {
    return value === true ? yes : value === false ? no : 'N/A';
  }

  function readings() {
    const data = state.telemetry || {};
    return {
      soil: numeric(data.soil, '%'), temperature: numeric(data.temperature, '°C'), humidity: numeric(data.humidity, '%'),
      rain: data.rain === 'RAIN' ? 'RAIN DETECTED' : data.rain === 'NO_RAIN' ? 'NO RAIN' : 'N/A',
      valve: data.valve === 'ON' ? 'OPEN' : data.valve === 'OFF' ? 'CLOSED' : 'N/A',
      pump: ['ON', 'OFF'].includes(data.pump) ? data.pump : 'N/A',
      flow: data.flow == null ? 'NOT CALIBRATED' : numeric(data.flow, 'L/min'), total: numeric(data.total, 'L'),
      vertical: numeric(data.solar?.v_cmd, '°'), horizontal: numeric(data.solar?.h_cmd, '°'),
      verticalMove: ['UP', 'DOWN', 'STOP'].includes(data.solar?.v_move) ? data.solar.v_move : 'N/A',
      horizontalMove: ['LEFT', 'RIGHT', 'STOP'].includes(data.solar?.h_move) ? data.solar.h_move : 'N/A',
      transmitter: booleanLabel(data.espnow, 'CONNECTED', 'DISCONNECTED'), wifi: booleanLabel(data.wifi, 'CONNECTED', 'DISCONNECTED'),
      rssi: numeric(data.rssi, 'dBm'), mqtt: state.mqttState,
      rtc: typeof data.ts === 'string' && data.ts ? data.ts.replace('T', ' ') : 'N/A',
      last: state.lastTelemetry ? new Date(state.lastTelemetry).toLocaleTimeString('en-IN', {hour12: true, timeZone: 'Asia/Kolkata'}) + ' IST' : 'N/A',
      device: typeof data.device === 'string' && data.device ? data.device : 'N/A',
      nitrogen: numeric(data.npk?.n), phosphorus: numeric(data.npk?.p), potassium: numeric(data.npk?.k)
    };
  }

  function applyReading(element, key, value) {
    const old = Boolean(state.telemetry) && state.freshness !== 'LIVE' && key !== 'mqtt';
    element.textContent = value;
    element.classList.toggle('reading-old', old);
    if (old) {
      const marker = document.createElement('span');
      marker.className = 'old-label';
      marker.textContent = '(old)';
      element.append(' ', marker);
    }
  }

  function renderReadings() {
    const values = readings();
    document.querySelectorAll('[data-reading]').forEach(element => applyReading(element, element.dataset.reading, values[element.dataset.reading]));
    for (const key of Object.keys(sensorDefinitions)) {
      const value = state.telemetry?.[key];
      const range = state.ranges[key];
      const status = !finite(value) ? 'N/A' : value < range.min ? 'LOW' : value > range.max ? 'HIGH' : 'OK';
      const statusElement = byId(`sensor-status-${key}`);
      statusElement.textContent = status + (state.telemetry && state.freshness !== 'LIVE' ? ' (old)' : '');
      statusElement.className = `sensor-status ${status === 'N/A' ? 'na' : status.toLowerCase()}`;
      statusElement.classList.toggle('reading-old', Boolean(state.telemetry) && state.freshness !== 'LIVE');
      byId(`ideal-${key}`).textContent = `${range.min}–${range.max} ${sensorDefinitions[key].unit}`;
      byId(`metric-note-${key}`).textContent = `Ideal range ${range.min}–${range.max} ${sensorDefinitions[key].unit}`;
    }
  }

  function buildCards(target, cards) {
    byId(target).innerHTML = cards.map(([key, label, symbol, note, compact]) => `<article class="card metric-card${compact ? ' compact' : ''}"><div class="metric-header"><h3>${label}</h3><span class="icon-tile${symbol === 'sun' ? ' amber' : ''}">${icon(symbol)}</span></div><div class="metric-value" data-reading="${key}">N/A</div><p id="metric-note-${key}">${note}</p></article>`).join('');
  }

  function buildDashboard() {
    buildCards('environmentCards', [
      ['soil', 'Soil moisture', 'leaf', 'Ideal range 40–60 %'], ['temperature', 'Temperature', 'sun', 'Ideal range 15–25 °C'],
      ['humidity', 'Humidity', 'drop', 'Ideal range 50–70 %'], ['rain', 'Rain detection', 'drop', 'Rain sensor status', true]
    ]);
    buildCards('resourceCards', [
      ['valve', 'Water valve', 'drop', 'Reported valve state'], ['pump', 'Motor / pump', 'settings', 'Reported motor state'],
      ['flow', 'Water flow', 'drop', 'Calibrated readings only', true], ['total', 'Total water', 'drop', 'Measured cumulative use'],
      ['vertical', 'Solar up / down', 'sun', 'Commanded servo angle'], ['horizontal', 'Solar left / right', 'sun', 'Commanded servo angle']
    ]);
    buildCards('connectionCards', [
      ['transmitter', 'Transmitter · ESP-NOW', 'signal', 'Wireless field sensor link', true], ['wifi', 'ESP32 Wi-Fi', 'signal', 'Device-reported connection', true],
      ['rssi', 'Wi-Fi signal · RSSI', 'signal', 'Device signal strength', true], ['mqtt', 'Browser MQTT', 'signal', 'Your browser connection', true],
      ['rtc', 'Device RTC time', 'clock', 'Device-reported time', true], ['last', 'Last update', 'clock', 'Latest telemetry · IST', true],
      ['device', 'Device ID', 'grid', 'Connected field controller', true]
    ]);
    buildCards('npkCards', [['nitrogen', 'Nitrogen · N', 'leaf', 'Sensor not implemented'], ['phosphorus', 'Phosphorus · P', 'leaf', 'Sensor not implemented'], ['potassium', 'Potassium · K', 'leaf', 'Sensor not implemented']]);
    byId('rangeInputs').innerHTML = Object.entries(sensorDefinitions).map(([key, definition]) => `<div class="range-row"><label for="${key}-min">${definition.label} (${definition.unit})</label><input type="number" id="${key}-min" aria-label="${definition.label} minimum" min="${definition.min}" max="${definition.max}" step="0.1" required value="${state.ranges[key].min}"><input type="number" id="${key}-max" aria-label="${definition.label} maximum" min="${definition.min}" max="${definition.max}" step="0.1" required value="${state.ranges[key].max}"></div>`).join('');
    byId('sensorRows').innerHTML = Object.entries(sensorDefinitions).map(([key, definition]) => `<tr><td>${definition.label}</td><td data-reading="${key}">N/A</td><td id="ideal-${key}"></td><td><span id="sensor-status-${key}" class="sensor-status na">N/A</span></td></tr>`).join('');
    document.querySelectorAll('[data-axis]').forEach(container => {
      container.innerHTML = [0, 45, 90, 135, 180].map(angle => `<button data-command="solar/${container.dataset.axis}" data-payload="${angle}" aria-label="Set ${container.dataset.axis} commanded angle to ${angle} degrees">${angle}°</button>`).join('');
    });
    renderReadings();
    renderHistory();
    renderNotifications();
  }

  function selectSection(section) {
    if (!sectionDefinitions[section]) return;
    state.section = section;
    const [label, title, subtitle] = sectionDefinitions[section];
    byId('breadcrumb').textContent = label;
    byId('sectionTitle').textContent = title;
    byId('sectionSubtitle').textContent = subtitle;
    document.querySelectorAll('.dashboard-section').forEach(element => { element.hidden = element.id !== `section-${section}`; });
    document.querySelectorAll('[data-section]').forEach(button => {
      button.classList.toggle('active', button.dataset.section === section);
      if (button.dataset.section === section) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (section === 'history') renderHistory();
    if (section === 'notifications') markNotificationsRead();
    closeSidebar();
  }

  function closeSidebar() {
    byId('sidebar').classList.remove('open');
    byId('sidebar').inert = window.matchMedia('(max-width: 760px)').matches;
    byId('sidebarBackdrop').hidden = true;
    byId('menuButton').setAttribute('aria-expanded', 'false');
  }

  function toast(message, error = false) {
    clearTimeout(state.toastTimer);
    byId('toast').textContent = message;
    byId('toast').className = `toast${error ? ' error-toast' : ''}`;
    byId('toast').hidden = false;
    state.toastTimer = setTimeout(() => { byId('toast').hidden = true; }, 6500);
  }

  function publishCommand(command, payload) {
    const client = state.client;
    if (!state.active || !client?.connected || state.mqttState !== 'CONNECTED') {
      toast('Not connected - command NOT sent', true);
      return;
    }
    const allowed = {pump: ['ON', 'OFF'], valve: ['ON', 'OFF'], 'solar/vertical': ['UP', 'DOWN', 'STOP'], 'solar/horizontal': ['LEFT', 'RIGHT', 'STOP']};
    const normalized = String(payload).toUpperCase();
    const angle = /^\d{1,3}$/.test(normalized) && Number(normalized) >= 0 && Number(normalized) <= 180;
    if (!allowed[command] || !(allowed[command].includes(normalized) || command.startsWith('solar/') && angle)) {
      toast('Invalid command - command NOT sent', true);
      return;
    }
    if (command === 'pump' && normalized === 'ON' && (state.freshness !== 'LIVE' || state.telemetry?.valve !== 'ON')) {
      toast('Valve must be open for motor to start. A LIVE open-valve reading is required - command NOT sent.', true);
      return;
    }
    client.publish(`${topicRoot}commands/${command}`, normalized, {qos: 1, retain: false}, error => {
      if (!state.active || state.client !== client) return;
      toast(error ? 'Command not acknowledged. It will not be queued or replayed.' : `Broker acknowledged ${normalized}. Waiting for device telemetry to confirm.`, Boolean(error));
    });
    toast(`Sending ${normalized}… Waiting for broker acknowledgement.`);
  }

  function recordHistory() {
    if (!state.active || state.freshness !== 'LIVE') return;
    const now = Date.now();
    const last = state.history.at(-1);
    if (last && now - last.time < 30000) return;
    const point = {time: now};
    for (const key of Object.keys(sensorDefinitions)) point[key] = finite(state.telemetry?.[key]) ? state.telemetry[key] : null;
    state.history.push(point);
    state.history = state.history.slice(-300);
    if (!writeStorage('ss-reading-history', state.history)) byId('historyStorage').textContent = 'Browser storage is unavailable. History records only while this dashboard remains open.';
    if (state.section === 'history') renderHistory();
  }

  function renderHistory() {
    const key = byId('historySensor').value;
    const definition = sensorDefinitions[key];
    const points = state.history;
    const available = points.filter(point => finite(point[key]));
    if (!available.length) {
      byId('historyChart').innerHTML = `<div class="chart-empty">${icon('chart')}Your story starts with the first reading.<br>Keep the dashboard open and connect your device.</div>`;
      return;
    }
    const width = 800, height = 270, left = 60, right = 25, top = 20, bottom = 42;
    const values = available.map(point => point[key]);
    const minimum = Math.floor(Math.min(...values) - 2);
    const maximum = Math.ceil(Math.max(...values) + 2);
    const firstTime = points[0].time;
    const timeSpan = Math.max(30000, points.at(-1).time - firstTime);
    const xPosition = time => left + (time - firstTime) / timeSpan * (width - left - right);
    const yPosition = value => top + (maximum - value) / (maximum - minimum) * (height - top - bottom);
    const grid = Array.from({length: 5}, (_, index) => {
      const value = minimum + (maximum - minimum) * index / 4;
      const position = yPosition(value);
      return `<line x1="${left}" y1="${position}" x2="${width - right}" y2="${position}" stroke="#e7eee0"/><text x="${left - 12}" y="${position + 4}" text-anchor="end" fill="#8b9a7d" font-size="11">${value.toFixed(1)}</text>`;
    }).join('');
    let path = '', continuation = false;
    for (const point of points) {
      if (!finite(point[key])) { continuation = false; continue; }
      path += `${continuation ? 'L' : 'M'}${xPosition(point.time).toFixed(2)},${yPosition(point[key]).toFixed(2)} `;
      continuation = true;
    }
    const labels = [points[0], points.at(-1)].map((point, index) => `<text x="${index ? width - right : left}" y="${height - 12}" text-anchor="${index ? 'end' : 'start'}" fill="#8b9a7d" font-size="11">${escapeHtml(new Date(point.time).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}))} IST</text>`).join('');
    const dots = available.map(point => `<circle cx="${xPosition(point.time)}" cy="${yPosition(point[key])}" r="${available.length === 1 ? 4 : 2}" fill="#2e7d32"><title>${escapeHtml(numeric(point[key], definition.unit))}</title></circle>`).join('');
    byId('historyChart').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${definition.label} history in ${definition.unit}, ${available.length} available readings"><title>${definition.label} (${definition.unit})</title>${grid}<path d="${path}" fill="none" stroke="#2e7d32" stroke-width="2.5" stroke-linejoin="round"/>${dots}${labels}</svg>`;
  }

  function setAlert(key, condition, message) {
    if (condition === null) return;
    if (condition && state.alerts[key] !== true) {
      state.notifications.unshift({message, time: Date.now(), read: state.section === 'notifications'});
      state.notifications = state.notifications.slice(0, 30);
      renderNotifications();
    }
    state.alerts[key] = condition;
  }

  function evaluateAlerts() {
    const data = state.telemetry;
    if (!data) return;
    if (state.freshness === 'LIVE') {
      setAlert('soil', finite(data.soil) ? data.soil < state.ranges.soil.min : null, 'Soil moisture is below your ideal minimum.');
      setAlert('temperature', finite(data.temperature) ? data.temperature > state.ranges.temperature.max : null, 'Temperature is above your ideal maximum.');
      setAlert('rain', ['RAIN', 'NO_RAIN'].includes(data.rain) ? data.rain === 'RAIN' : null, 'Rain detected in your field.');
      setAlert('transmitter', typeof data.espnow === 'boolean' ? !data.espnow : null, 'Transmitter disconnected — check the ESP-NOW sensor link.');
    }
    setAlert('offline', state.freshness === 'OFFLINE' || data.wifi === false, 'ESP32 offline — check the device and its connection.');
  }

  function renderNotifications() {
    const unread = state.notifications.filter(notification => !notification.read).length;
    byId('unreadCount').textContent = String(unread);
    byId('unreadCount').hidden = unread === 0;
    byId('notificationList').innerHTML = state.notifications.length ? state.notifications.map(notification => `<li${notification.read ? ' class="read"' : ''}>${icon('bell')}<b>${escapeHtml(notification.message)}</b><time datetime="${new Date(notification.time).toISOString()}">${escapeHtml(new Date(notification.time).toLocaleTimeString('en-IN', {timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit'}))} IST</time></li>`).join('') : '<li class="empty-notification">All quiet in the field. New alerts appear here as conditions change.</li>';
  }

  function markNotificationsRead() {
    state.notifications.forEach(notification => { notification.read = true; });
    renderNotifications();
  }

  byId('startDashboard').addEventListener('click', async () => {
    const button = byId('startDashboard');
    button.disabled = true;
    try {
      const credentials = await getCredentials();
      if (credentials) enterDashboard(credentials);
      else { showScreen('login'); byId('username').focus(); }
    } catch {
      showScreen('login');
      byId('loginError').textContent = 'Unable to check your session. Please try signing in.';
    } finally { button.disabled = false; }
  });
  byId('backWelcome').addEventListener('click', () => showScreen('welcome'));
  byId('loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    byId('loginError').textContent = '';
    byId('loginButton').disabled = true;
    try {
      const response = await authRequest('login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: byId('username').value, password: byId('password').value})});
      byId('password').value = '';
      if (!response.ok) {
        byId('loginError').textContent = response.status === 429 ? 'Too many attempts. Please try again in 15 minutes.' : response.status === 401 ? 'Invalid username or password.' : 'Sign-in is unavailable. Please try again.';
        return;
      }
      const credentials = await getCredentials();
      if (!credentials) throw new Error('Session unavailable');
      enterDashboard(credentials);
    } catch {
      byId('password').value = '';
      byId('loginError').textContent = 'Unable to sign in. Check your connection and allow cookies.';
    } finally { byId('loginButton').disabled = false; }
  });
  byId('logout').addEventListener('click', async () => {
    byId('logout').disabled = true;
    try {
      const response = await authRequest('logout', {method: 'POST'});
      if (!response.ok) throw new Error('Logout unavailable');
      stopDashboard();
      showScreen('welcome');
    } catch { toast('Logout could not be completed. Check your connection and try again.', true); }
    finally { byId('logout').disabled = false; }
  });
  document.querySelectorAll('[data-section]').forEach(button => button.addEventListener('click', () => selectSection(button.dataset.section)));
  byId('menuButton').addEventListener('click', () => {
    const opened = byId('sidebar').classList.toggle('open');
    byId('sidebar').inert = !opened;
    byId('sidebarBackdrop').hidden = !opened;
    byId('menuButton').setAttribute('aria-expanded', String(opened));
  });
  byId('sidebarBackdrop').addEventListener('click', closeSidebar);
  window.matchMedia('(max-width: 760px)').addEventListener('change', closeSidebar);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar(); });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-command]');
    if (button) publishCommand(button.dataset.command, button.dataset.payload);
  });
  byId('settingsForm').addEventListener('submit', event => {
    event.preventDefault();
    const ranges = Object.fromEntries(Object.keys(sensorDefinitions).map(key => [key, {min: Number(byId(`${key}-min`).value), max: Number(byId(`${key}-max`).value)}]));
    if (!Object.entries(ranges).every(([key, range]) => validRange(key, range))) {
      byId('settingsMessage').textContent = 'Each minimum must be below its maximum, within the sensor limits.';
      byId('settingsMessage').className = 'error';
      return;
    }
    state.ranges = ranges;
    const saved = writeStorage('ss-ideal-ranges', ranges);
    byId('settingsMessage').textContent = saved ? 'Your ideal ranges are saved in this browser.' : 'Browser storage is unavailable. Ranges apply only until you close this page.';
    byId('settingsMessage').className = saved ? 'muted' : 'error';
    renderReadings();
    evaluateAlerts();
  });
  byId('historySensor').addEventListener('change', renderHistory);
  byId('markRead').addEventListener('click', markNotificationsRead);
  buildDashboard();
  closeSidebar();
  updateClock();
  updateWeather();
  const heroImage = new Image();
  heroImage.onload = () => {
    byId('hero').style.backgroundImage = 'linear-gradient(100deg, rgba(15,61,46,.96), rgba(15,61,46,.45)), url("hero.jpg")';
    document.querySelector('.farm-scene').hidden = true;
  };
  heroImage.src = 'hero.jpg';
  setInterval(updateClock, 1000);
  setInterval(updateWeather, 300000);
  setInterval(() => { if (state.active) { updateFreshness(); renderReadings(); } }, 1000);
  document.addEventListener('visibilitychange', () => {
    updateClock();
    if (state.active) { updateFreshness(); renderReadings(); }
  });
})();
