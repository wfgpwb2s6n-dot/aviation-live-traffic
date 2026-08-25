const DEFAULT_CENTER = { lat: 45.0781, lon: -83.5603 }; // Alpena / KAPN area
const POLL_MS = 10000;

const map = L.map("map", {
  zoomControl: true,
  attributionControl: true
}).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lon], 7);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const ui = {
  range: document.querySelector("#rangeSelect"),
  labels: document.querySelector("#labelSelect"),
  trails: document.querySelector("#trailToggle"),
  recenter: document.querySelector("#recenterBtn"),
  count: document.querySelector("#aircraftCount"),
  rangeHud: document.querySelector("#rangeHud"),
  updated: document.querySelector("#updatedHud"),
  statusText: document.querySelector("#statusText"),
  statusDot: document.querySelector("#statusDot"),
  detailCard: document.querySelector("#detailCard"),
  detailClose: document.querySelector("#detailClose"),
  detailTitle: document.querySelector("#detailTitle"),
  detailReg: document.querySelector("#detailReg"),
  detailType: document.querySelector("#detailType"),
  detailAlt: document.querySelector("#detailAlt"),
  detailGs: document.querySelector("#detailGs"),
  detailTrack: document.querySelector("#detailTrack"),
  detailVr: document.querySelector("#detailVr")
};

const markers = new Map();
const trails = new Map();
let selectedHex = null;
let pollTimer = null;
let isFetching = false;

function fmtAltitude(v) {
  if (v === "ground") return "GROUND";
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n).toLocaleString()} ft` : "—";
}

function fmtNumber(v, suffix = "", decimals = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(decimals)}${suffix}`;
}

function aircraftTitle(a) {
  return a.callsign || a.registration || a.hex?.toUpperCase() || "UNKNOWN";
}

function labelText(a) {
  switch (ui.labels.value) {
    case "altitude":
      return fmtAltitude(a.altitudeBaro).replace(" ft", "");
    case "both":
      return `${aircraftTitle(a)} · ${fmtAltitude(a.altitudeBaro).replace(" ft", "")}`;
    case "none":
      return "";
    default:
      return aircraftTitle(a);
  }
}

function iconFor(a) {
  const track = Number.isFinite(Number(a.track)) ? Number(a.track) : 0;
  const label = labelText(a);
  return L.divIcon({
    className: "",
    html: `
      <div class="aircraft-marker" style="transform:rotate(${track}deg)">
        <div class="aircraft-glyph">✈</div>
        ${label ? `<div class="aircraft-label" style="transform:rotate(${-track}deg)">${escapeHtml(label)}</div>` : ""}
      </div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showDetails(a) {
  selectedHex = a.hex || null;
  ui.detailTitle.textContent = aircraftTitle(a);
  ui.detailReg.textContent = a.registration || "—";
  ui.detailType.textContent = a.aircraftType || "—";
  ui.detailAlt.textContent = fmtAltitude(a.altitudeBaro ?? a.altitudeGeom);
  ui.detailGs.textContent = fmtNumber(a.groundSpeed, " kt", 0);
  ui.detailTrack.textContent = fmtNumber(a.track, "°", 0);
  ui.detailVr.textContent = fmtNumber(a.verticalRate, " fpm", 0);
  ui.detailCard.hidden = false;
}

function updateTrails(a) {
  if (!a.hex) return;
  const key = a.hex;
  const points = trails.get(key) || [];
  points.push([a.lat, a.lon]);
  while (points.length > 20) points.shift();
  trails.set(key, points);
}

function renderTrail(a) {
  if (!a.hex || !ui.trails.checked) return;
  const markerState = markers.get(a.hex);
  if (!markerState) return;

  const points = trails.get(a.hex) || [];
  if (points.length < 2) return;

  if (!markerState.trail) {
    markerState.trail = L.polyline(points, {
      weight: 2,
      opacity: 0.45
    }).addTo(map);
  } else {
    markerState.trail.setLatLngs(points);
  }
}

function clearTrailLines() {
  for (const state of markers.values()) {
    if (state.trail) {
      map.removeLayer(state.trail);
      state.trail = null;
    }
  }
}

function renderAircraft(list) {
  const alive = new Set();

  for (const a of list) {
    if (!a.hex || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
    alive.add(a.hex);
    updateTrails(a);

    let state = markers.get(a.hex);
    if (!state) {
      const marker = L.marker([a.lat, a.lon], { icon: iconFor(a), keyboard: true })
        .addTo(map)
        .on("click", () => showDetails(state.data));
      state = { marker, data: a, trail: null };
      markers.set(a.hex, state);
    } else {
      state.data = a;
      state.marker.setLatLng([a.lat, a.lon]);
      state.marker.setIcon(iconFor(a));
    }

    renderTrail(a);

    if (selectedHex === a.hex && !ui.detailCard.hidden) {
      showDetails(a);
    }
  }

  for (const [hex, state] of markers) {
    if (!alive.has(hex)) {
      map.removeLayer(state.marker);
      if (state.trail) map.removeLayer(state.trail);
      markers.delete(hex);
    }
  }

  ui.count.textContent = String(list.length);
}

function setStatus(kind, text) {
  ui.statusDot.className = `status-dot ${kind || ""}`.trim();
  ui.statusText.textContent = text;
}

function fitRange(radiusNm) {
  const meters = radiusNm * 1852;
  const bounds = L.latLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lon).toBounds(meters * 2);
  map.fitBounds(bounds, { padding: [28, 28] });
}

async function fetchTraffic() {
  if (isFetching) return;
  isFetching = true;
  setStatus("", "Updating…");

  const radius = Number(ui.range.value) || 100;
  ui.rangeHud.textContent = String(radius);

  try {
    const url = `/api/traffic?lat=${DEFAULT_CENTER.lat}&lon=${DEFAULT_CENTER.lon}&radius=${radius}`;
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    }

    renderAircraft(Array.isArray(data.aircraft) ? data.aircraft : []);
    const when = new Date(data.generatedAt);
    ui.updated.textContent = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    setStatus("good", data.cached ? "Live · cached" : "Live");
  } catch (error) {
    console.error(error);
    setStatus("bad", "Feed unavailable");
  } finally {
    isFetching = false;
  }
}

function restartPolling() {
  clearInterval(pollTimer);
  fetchTraffic();
  pollTimer = setInterval(fetchTraffic, POLL_MS);
}

ui.range.addEventListener("change", () => {
  fitRange(Number(ui.range.value));
  restartPolling();
});

ui.labels.addEventListener("change", () => {
  for (const state of markers.values()) {
    state.marker.setIcon(iconFor(state.data));
  }
});

ui.trails.addEventListener("change", () => {
  if (!ui.trails.checked) clearTrailLines();
  else {
    for (const state of markers.values()) renderTrail(state.data);
  }
});

ui.recenter.addEventListener("click", () => fitRange(Number(ui.range.value)));
ui.detailClose.addEventListener("click", () => {
  ui.detailCard.hidden = true;
  selectedHex = null;
});

fitRange(100);
restartPolling();

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(pollTimer);
  } else {
    restartPolling();
  }
});
