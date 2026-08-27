const CENTER = { lat: 45.0781, lon: -83.5603 };
const FRESH_TTL = 15;
const STALE_TTL = 300;
const POINT_RADIUS_LIMIT_NM = 249;

const POINT_SOURCES = [
  {
    name: "theairtraffic",
    minSpacingMs: 100,
    urls: (lat, lon, radius) => [
      `https://api.theairtraffic.com/v2/point/${lat}/${lon}/${radius}`,
      `https://api.theairtraffic.com/api/v2/point/${lat}/${lon}/${radius}`
    ],
    rows: data => Array.isArray(data.ac) ? data.ac : (Array.isArray(data.aircraft) ? data.aircraft : [])
  },
  {
    name: "airplanes.live",
    minSpacingMs: 1000,
    urls: (lat, lon, radius) => [
      `https://api.airplanes.live/v2/point/${lat}/${lon}/${radius}`
    ],
    rows: data => Array.isArray(data.ac) ? data.ac : []
  },
  {
    name: "adsb.lol",
    minSpacingMs: 1000,
    urls: (lat, lon, radius) => [
      `https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`
    ],
    rows: data => Array.isArray(data.ac) ? data.ac : []
  },
  {
    name: "adsb.fi",
    minSpacingMs: 1000,
    urls: (lat, lon, radius) => [
      `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${radius}`,
      `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${radius}`
    ],
    rows: data => Array.isArray(data.aircraft) ? data.aircraft : (Array.isArray(data.ac) ? data.ac : [])
  }
];

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function normalize(a) {
  const lat = Number(a.lat);
  const lon = Number(a.lon);
  return {
    hex: a.hex ?? null,
    flight: typeof a.flight === "string" ? a.flight.trim() : null,
    r: a.r ?? null,
    t: a.t ?? null,
    desc: a.desc ?? null,
    ownOp: a.ownOp ?? null,
    year: a.year ?? null,
    dbFlags: a.dbFlags ?? null,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    alt_baro: a.alt_baro ?? a.altitude ?? null,
    alt_geom: a.alt_geom ?? null,
    gs: a.gs ?? a.speed ?? null,
    track: a.track ?? null,
    baro_rate: a.baro_rate ?? a.vert_rate ?? a.geom_rate ?? null,
    squawk: a.squawk ?? null,
    emergency: a.emergency ?? null,
    category: a.category ?? null,
    seen: a.seen ?? null,
    seen_pos: a.seen_pos ?? null
  };
}

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent": "Mozilla/5.0 AteFlight/7.1"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function distanceNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toRad = d => d * Math.PI / 180;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const h = Math.sin(dp / 2) ** 2 +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function parseBbox(value, fallback = null) {
  const parts = String(value || "").split(",").map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return fallback;
  let [south, west, north, east] = parts;
  south = Math.max(-89.5, Math.min(89.5, south));
  north = Math.max(-89.5, Math.min(89.5, north));
  west = Math.max(-180, Math.min(180, west));
  east = Math.max(-180, Math.min(180, east));
  if (north < south) [south, north] = [north, south];
  return [south, west, north, east];
}

function roundedBbox(bbox, step = 0.25) {
  return bbox.map(value => Math.round(value / step) * step);
}

function bboxKey(bbox, step = 0.25) {
  return roundedBbox(bbox, step).map(value => value.toFixed(2)).join("_");
}

function withinBbox(lat, lon, bbox) {
  if (!bbox) return false;
  const [south, west, north, east] = bbox;
  const latitudeMatch = lat >= south && lat <= north;
  const longitudeMatch = west <= east
    ? lon >= west && lon <= east
    : lon >= west || lon <= east;
  return latitudeMatch && longitudeMatch;
}

function aircraftPositionAge(a) {
  const p = Number(a && a.seen_pos);
  if (Number.isFinite(p)) return Math.max(0, p);
  const s = Number(a && a.seen);
  return Number.isFinite(s) ? Math.max(0, s) : null;
}

function epochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e14) return Math.round(n / 1000);
  if (n > 1e12) return Math.round(n);
  if (n > 1e9) return Math.round(n * 1000);
  return null;
}

function sourceTimestampMs(data) {
  return epochMs(data && (data.now ?? data.ctime ?? data.time ?? data.timestamp)) || Date.now();
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function positionAgeSummary(aircraft) {
  const ages = aircraft
    .map(aircraftPositionAge)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    count: ages.length,
    freshest: ages.length ? ages[0] : null,
    median: percentile(ages, 0.5),
    p95: percentile(ages, 0.95),
    oldest: ages.length ? ages[ages.length - 1] : null
  };
}

function feedState(snapshotAgeSec, positionMedianSec, stale = false) {
  if (stale) return "holding";
  if (snapshotAgeSec > 120 || (Number.isFinite(positionMedianSec) && positionMedianSec > 120)) return "stale";
  if (snapshotAgeSec > 35 || (Number.isFinite(positionMedianSec) && positionMedianSec > 45)) return "delayed";
  return "live";
}

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

async function fetchJsonText(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent": "Mozilla/5.0 AteFlight/7.1 regional-traffic"
      },
      cf: { cacheEverything: true, cacheTtl: 10 },
      signal: controller.signal
    });
    const type = response.headers.get("content-type") || "";
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > 8_000_000) throw new Error(`response too large (${length} bytes)`);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}${text ? ` · ${text.replace(/\\s+/g, " ").slice(0, 100)}` : ""}`);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`non-JSON ${type || "response"}: ${text.replace(/\\s+/g, " ").slice(0, 120)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function bboxDimensionsNm(bbox) {
  if (!bbox) return { width: 0, height: 0, midLat: 0 };
  const [south, west, north, east] = bbox;
  const midLat = (south + north) / 2;
  const lonSpan = west <= east ? east - west : (180 - west) + (east + 180);
  return {
    width: Math.max(0, lonSpan * 60 * Math.max(0.15, Math.cos(midLat * Math.PI / 180))),
    height: Math.max(0, (north - south) * 60),
    midLat
  };
}

function buildTrafficTiles(bbox, lat, lon, radius, expanded) {
  if (!bbox || radius <= POINT_RADIUS_LIMIT_NM) {
    return [{ lat, lon, radius: Math.min(POINT_RADIUS_LIMIT_NM, Math.max(10, radius)) }];
  }

  const [south, west, north, east] = bbox;
  const dims = bboxDimensionsNm(bbox);
  const cols = Math.min(expanded ? 3 : 2, Math.max(1, Math.ceil(dims.width / 390)));
  const rows = Math.min(expanded ? 3 : 2, Math.max(1, Math.ceil(dims.height / 390)));
  const lonSpan = west <= east ? east - west : (180 - west) + (east + 180);
  const tiles = [];

  function lonAt(fraction) {
    let value = west + lonSpan * fraction;
    while (value > 180) value -= 360;
    return value;
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tileLat = south + (north - south) * ((r + 0.5) / rows);
      const tileLon = lonAt((c + 0.5) / cols);
      const cellHeight = dims.height / rows;
      const cellWidth = dims.width / cols;
      const tileRadius = Math.min(POINT_RADIUS_LIMIT_NM, Math.max(40, Math.ceil(Math.hypot(cellHeight, cellWidth) * 0.58 + 18)));
      tiles.push({ lat: tileLat, lon: tileLon, radius: tileRadius });
    }
  }

  // Keep broad views bounded. The response explicitly reports whether the
  // viewport exceeded the selected tiling envelope.
  return tiles.slice(0, expanded ? 9 : 4);
}

async function fetchPointTile(source, tile) {
  const errors = [];
  for (const url of source.urls(tile.lat.toFixed(5), tile.lon.toFixed(5), Math.round(tile.radius))) {
    try {
      const data = await fetchJsonText(url, 7000);
      return {
        data,
        rows: source.rows(data),
        url,
        sourceTimestampMs: sourceTimestampMs(data)
      };
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join(" | ") || "tile failed");
}

async function queryPointSource(source, tiles) {
  const merged = new Map();
  const errors = [];
  const urls = [];
  let successfulTiles = 0;
  let latestSourceTime = 0;

  // Sequential requests keep the public APIs below their burst limits. Most
  // normal AteFlight views are one tile; only very broad views use more.
  for (let i = 0; i < tiles.length; i++) {
    if (i && source.minSpacingMs) await sleep(source.minSpacingMs);
    try {
      const result = await fetchPointTile(source, tiles[i]);
      successfulTiles++;
      urls.push(result.url);
      latestSourceTime = Math.max(latestSourceTime, result.sourceTimestampMs || 0);
      for (const raw of result.rows) {
        const a = normalize(raw);
        if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
        const key = a.hex || `${a.lat.toFixed(5)}:${a.lon.toFixed(5)}:${a.flight || ""}`;
        const previous = merged.get(key);
        if (!previous || (aircraftPositionAge(a) ?? 999999) < (aircraftPositionAge(previous) ?? 999999)) merged.set(key, a);
      }
    } catch (error) {
      errors.push(`tile ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!successfulTiles) throw new Error(errors.join(" | ") || "all tiles failed");
  return {
    source: source.name,
    aircraft: [...merged.values()],
    successfulTiles,
    requestedTiles: tiles.length,
    errors,
    urls,
    sourceTimestampMs: latestSourceTime || Date.now()
  };
}

function bboxForPoint(lat, lon, radiusNm) {
  const latDelta = radiusNm / 60;
  const lonDelta = radiusNm / (60 * Math.max(0.15, Math.cos(lat * Math.PI / 180)));
  return [Math.max(-89, lat - latDelta), Math.max(-180, lon - lonDelta), Math.min(89, lat + latDelta), Math.min(180, lon + lonDelta)];
}

function normalizeOpenSkyState(row, snapshotSec) {
  if (!Array.isArray(row) || row.length < 12) return null;
  const lon = Number(row[5]), lat = Number(row[6]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const timePosition = Number(row[3]), lastContact = Number(row[4]);
  const metersToFeet = value => Number.isFinite(Number(value)) ? Number(value) * 3.28084 : null;
  const metersPerSecondToKnots = value => Number.isFinite(Number(value)) ? Number(value) * 1.94384 : null;
  const metersPerSecondToFpm = value => Number.isFinite(Number(value)) ? Number(value) * 196.8504 : null;
  return {
    hex: String(row[0] || "").toLowerCase() || null,
    flight: typeof row[1] === "string" ? row[1].trim() : null,
    r: null,
    t: null,
    desc: null,
    ownOp: String(row[2] || "") || null,
    year: null,
    dbFlags: null,
    lat, lon,
    alt_baro: row[8] ? "ground" : metersToFeet(row[7]),
    alt_geom: metersToFeet(row[13]),
    gs: metersPerSecondToKnots(row[9]),
    track: Number.isFinite(Number(row[10])) ? Number(row[10]) : null,
    baro_rate: metersPerSecondToFpm(row[11]),
    squawk: row[14] || null,
    emergency: null,
    category: null,
    seen: Number.isFinite(lastContact) ? Math.max(0, snapshotSec - lastContact) : null,
    seen_pos: Number.isFinite(timePosition) ? Math.max(0, snapshotSec - timePosition) : null
  };
}

async function queryOpenSky(bbox, lat, lon, radius) {
  const bounds = bbox || bboxForPoint(lat, lon, radius);
  const [south, west, north, east] = bounds;
  if (west > east) throw new Error("anti-meridian OpenSky query not supported");
  const url = `https://opensky-network.org/api/states/all?lamin=${south.toFixed(4)}&lomin=${west.toFixed(4)}&lamax=${north.toFixed(4)}&lomax=${east.toFixed(4)}`;
  const data = await fetchJsonText(url, 8000);
  const snapshotSec = Number(data.time) || Math.floor(Date.now() / 1000);
  const aircraft = (Array.isArray(data.states) ? data.states : []).map(row => normalizeOpenSkyState(row, snapshotSec)).filter(Boolean);
  return {
    source: "opensky",
    aircraft,
    successfulTiles: 1,
    requestedTiles: 1,
    errors: [],
    urls: [url],
    sourceTimestampMs: snapshotSec * 1000
  };
}

function filterTrafficScope(aircraft, bbox, lat, lon, radius) {
  return aircraft.filter(a => {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return false;
    return bbox ? withinBbox(a.lat, a.lon, bbox) : distanceNm(lat, lon, a.lat, a.lon) <= radius;
  });
}

async function traffic(request, ctx) {
  const u = new URL(request.url);
  const lat = clampNumber(u.searchParams.get("lat"), -90, 90, CENTER.lat);
  const lon = clampNumber(u.searchParams.get("lon"), -180, 180, CENTER.lon);
  const radius = Math.round(clampNumber(u.searchParams.get("radius"), 5, 1600, 100));
  const bbox = u.searchParams.has("bbox") ? parseBbox(u.searchParams.get("bbox"), null) : null;
  const zoom = clampNumber(u.searchParams.get("zoom"), 0, 24, 7);
  const coverageMode = u.searchParams.get("coverage") === "expanded" ? "expanded" : "fast";
  const expanded = coverageMode === "expanded";
  const scopeKey = bbox ? `bbox/${bboxKey(bbox, 0.20)}` : `point/${lat.toFixed(3)}/${lon.toFixed(3)}/${radius}`;

  const cache = caches.default;
  const freshKey = new Request(`${u.origin}/__traffic_cache/v66/${coverageMode}/${scopeKey}/fresh`);
  const staleKey = new Request(`${u.origin}/__traffic_cache/v66/${coverageMode}/${scopeKey}/stale`);

  const fresh = await cache.match(freshKey);
  if (fresh) {
    const payload = await fresh.json();
    payload.cached = true;
    payload.servedAt = new Date().toISOString();
    return json(payload);
  }

  const tiles = buildTrafficTiles(bbox, lat, lon, radius, expanded);
  const sourceStats = [];
  const errors = [];
  let result = null;

  for (const source of POINT_SOURCES) {
    try {
      const candidate = await queryPointSource(source, tiles);
      sourceStats.push({
        source: candidate.source,
        ok: true,
        count: candidate.aircraft.length,
        successfulTiles: candidate.successfulTiles,
        requestedTiles: candidate.requestedTiles,
        errors: candidate.errors
      });
      result = candidate;
      break;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${source.name}: ${detail}`);
      sourceStats.push({ source: source.name, ok: false, count: 0, error: detail });
    }
  }

  // One official bbox request is a final server-side fallback. It is not the
  // default because anonymous OpenSky access can be quota- or egress-limited.
  if (!result) {
    try {
      result = await queryOpenSky(bbox, lat, lon, radius);
      sourceStats.push({ source: "opensky", ok: true, count: result.aircraft.length, successfulTiles: 1, requestedTiles: 1 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`opensky: ${detail}`);
      sourceStats.push({ source: "opensky", ok: false, count: 0, error: detail });
    }
  }

  if (result) {
    let aircraft = filterTrafficScope(result.aircraft, bbox, lat, lon, radius);
    aircraft.sort((a, b) => (aircraftPositionAge(a) ?? 999999) - (aircraftPositionAge(b) ?? 999999));
    const maxTargets = zoom < 4.5 ? 8500 : zoom < 6 ? 7000 : 5000;
    const uncappedTotal = aircraft.length;
    aircraft = aircraft.slice(0, maxTargets);

    const receivedAtMs = Date.now();
    const sourceTimeMs = result.sourceTimestampMs || receivedAtMs;
    const snapshotAgeSec = Math.max(0, (receivedAtMs - sourceTimeMs) / 1000);
    const positionAgeSec = positionAgeSummary(aircraft);
    const dims = bboxDimensionsNm(bbox);
    const requestedEnvelopeNm = Math.max(dims.width, dims.height);
    const tileEnvelopeNm = Math.max(...tiles.map(t => t.radius * 2), 0) * Math.max(1, Math.sqrt(tiles.length));
    const coverageLimited = !!bbox && requestedEnvelopeNm > tileEnvelopeNm * 1.12;

    const payload = {
      source: result.source,
      coverageMode,
      generatedAt: new Date(sourceTimeMs).toISOString(),
      sourceTimestamp: new Date(sourceTimeMs).toISOString(),
      receivedAt: new Date(receivedAtMs).toISOString(),
      servedAt: new Date(receivedAtMs).toISOString(),
      snapshotAgeSec,
      positionAgeSec,
      feedState: feedState(snapshotAgeSec, positionAgeSec.median, false),
      center: { lat, lon, radiusNm: radius },
      bbox,
      total: aircraft.length,
      uncappedTotal,
      sourceCount: 1,
      attemptedSourceCount: sourceStats.length,
      sourceStats,
      partial: result.successfulTiles < result.requestedTiles,
      coverageLimited,
      errors: [...errors, ...(result.errors || [])],
      aircraft,
      stale: false,
      cached: false
    };

    const freshResponse = new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${FRESH_TTL}` }
    });
    const staleResponse = new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${STALE_TTL}` }
    });
    ctx.waitUntil(cache.put(freshKey, freshResponse));
    ctx.waitUntil(cache.put(staleKey, staleResponse));
    return json(payload);
  }

  const stale = await cache.match(staleKey);
  if (stale) {
    const payload = await stale.json();
    const now = Date.now();
    const sourceTime = epochMs(Date.parse(payload.sourceTimestamp || payload.generatedAt)) || now;
    payload.stale = true;
    payload.cached = true;
    payload.feedState = "holding";
    payload.servedAt = new Date(now).toISOString();
    payload.snapshotAgeSec = Math.max(0, (now - sourceTime) / 1000);
    payload.errors = [...(payload.errors || []), ...errors];
    return json(payload);
  }

  return json({
    error: "No regional ADS-B source is reachable",
    coverageMode,
    errors,
    sourceStats,
    generatedAt: new Date().toISOString()
  }, 502);
}

const WX_FRESH_TTL = 120;
const WX_STALE_TTL = 1200;
const WX_BBOX = "40.5,-90.2,49.7,-76.9";

async function fetchAviationWeatherJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "accept": "application/json, application/geo+json",
        "user-agent": "AteFlight/7.1 weather-display contact=local-home-display"
      },
      signal: controller.signal
    });
    if (response.status === 204) return [];
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function aviationWeather(request, ctx) {
  const u = new URL(request.url);
  const cache = caches.default;
  const freshKey = new Request(`${u.origin}/__weather_cache/v3/fresh`);
  const staleKey = new Request(`${u.origin}/__weather_cache/v3/stale`);

  const fresh = await cache.match(freshKey);
  if (fresh) {
    const payload = await fresh.json();
    payload.cached = true;
    return json(payload);
  }

  const base = "https://aviationweather.gov/api/data";
  const urls = {
    metars: `${base}/metar?bbox=${encodeURIComponent(WX_BBOX)}&format=json&hours=2`,
    pireps: `${base}/pirep?bbox=${encodeURIComponent(WX_BBOX)}&format=json&age=3`,
    gairmets: `${base}/gairmet?format=geojson&fore=0`,
    sigmets: `${base}/airsigmet?format=geojson`
  };

  const names = Object.keys(urls);
  const settled = await Promise.allSettled(
    names.map(name => fetchAviationWeatherJson(urls[name]))
  );

  const payload = {
    source: "NOAA/NWS AviationWeather.gov",
    generatedAt: new Date().toISOString(),
    cached: false,
    stale: false,
    metars: [],
    pireps: [],
    gairmets: { type: "FeatureCollection", features: [] },
    sigmets: { type: "FeatureCollection", features: [] },
    errors: []
  };

  settled.forEach((result, index) => {
    const name = names[index];
    if (result.status === "fulfilled") {
      payload[name] = result.value;
    } else {
      payload.errors.push(`${name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });

  const gotAnything =
    (Array.isArray(payload.metars) && payload.metars.length >= 0) ||
    (Array.isArray(payload.pireps) && payload.pireps.length >= 0) ||
    (payload.gairmets && Array.isArray(payload.gairmets.features)) ||
    (payload.sigmets && Array.isArray(payload.sigmets.features));

  if (gotAnything && settled.some(r => r.status === "fulfilled")) {
    const freshResponse = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${WX_FRESH_TTL}`
      }
    });
    const staleResponse = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${WX_STALE_TTL}`
      }
    });
    ctx.waitUntil(cache.put(freshKey, freshResponse));
    ctx.waitUntil(cache.put(staleKey, staleResponse));
    return json(payload);
  }

  const stale = await cache.match(staleKey);
  if (stale) {
    const old = await stale.json();
    old.stale = true;
    old.cached = true;
    old.errors = [...(old.errors || []), ...(payload.errors || [])];
    return json(old);
  }

  return json({
    error: "Aviation weather layers are temporarily unavailable",
    errors: payload.errors,
    generatedAt: new Date().toISOString()
  }, 502);
}


const TRACE_FRESH_TTL = 90;
const TRACE_STALE_TTL = 900;
const ROUTE_TTL = 21600;

const TRACE_SOURCES = [
  { name: "theairtraffic", base: "https://globe.theairtraffic.com" },
  { name: "hpradar", base: "https://skylink.hpradar.com" }
];

function simplifyTracePoints(points, maxPoints = 1800) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

function decodeTraceObject(obj) {
  if (!obj || !Array.isArray(obj.trace)) return [];
  const base = Number(obj.timestamp);
  if (!Number.isFinite(base)) return [];
  const out = [];
  for (const row of obj.trace) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const dt = Number(row[0]);
    const lat = Number(row[1]);
    const lon = Number(row[2]);
    if (!Number.isFinite(dt) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      t: base + dt,
      lat,
      lon,
      alt: row[3] ?? null,
      gs: row[4] ?? null,
      track: row[5] ?? null,
      flags: Number(row[6]) || 0,
      vr: row[7] ?? null
    });
  }
  return out;
}

function currentLeg(points) {
  if (!points.length) return [];

  let flagStart = 0;
  let takeoffStart = 0;
  let gapStart = 0;

  for (let i = 0; i < points.length; i++) {
    if ((points[i].flags & 2) !== 0) flagStart = i;

    if (i > 0) {
      const previous = points[i - 1];
      const current = points[i];

      // readsb writes "ground" into the trace altitude when available.
      // Prefer the latest actual ground -> airborne transition.
      if (previous.alt === "ground" && current.alt !== "ground") {
        takeoffStart = Math.max(0, i - 1);
      }

      // Only use a large coverage gap as a fallback when readsb did not
      // supply a leg/takeoff marker. This prevents an old parked aircraft
      // trace from appearing as a 10+ hour "flight".
      if ((current.t - previous.t) > 45 * 60) {
        gapStart = i;
      }
    }
  }

  let start = Math.max(flagStart, takeoffStart);
  if (start === 0 && gapStart > 0) start = gapStart;

  const leg = points.slice(start);
  return leg.length >= 2 ? leg : points;
}

async function fetchTraceJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent": "AteFlight/7.1 selected-flight-trace"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function selectedTrace(request, ctx) {
  const u = new URL(request.url);
  const hex = String(u.searchParams.get("hex") || "").trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) {
    return json({ error: "Invalid ICAO hex" }, 400);
  }

  const cache = caches.default;
  const freshKey = new Request(`${u.origin}/__trace_cache/${hex}/fresh`);
  const staleKey = new Request(`${u.origin}/__trace_cache/${hex}/stale`);

  const cached = await cache.match(freshKey);
  if (cached) {
    const payload = await cached.json();
    payload.cached = true;
    return json(payload);
  }

  const suffix = hex.slice(-2);
  const errors = [];

  for (const source of TRACE_SOURCES) {
    try {
      const urls = [
        `${source.base}/data/traces/${suffix}/trace_full_${hex}.json`,
        `${source.base}/data/traces/${suffix}/trace_recent_${hex}.json`
      ];
      const settled = await Promise.allSettled(urls.map(fetchTraceJson));
      let points = [];
      for (const r of settled) {
        if (r.status === "fulfilled") points.push(...decodeTraceObject(r.value));
      }
      if (!points.length) {
        const reasons = settled.map(r => r.status === "rejected" ? String(r.reason) : "empty").join(", ");
        throw new Error(reasons);
      }

      points.sort((a, b) => a.t - b.t);
      const dedup = [];
      let lastKey = "";
      for (const p of points) {
        const key = `${Math.round(p.t * 10)}:${p.lat.toFixed(5)}:${p.lon.toFixed(5)}`;
        if (key === lastKey) continue;
        lastKey = key;
        dedup.push(p);
      }

      const leg = currentLeg(dedup);
      const simplified = simplifyTracePoints(leg);

      const payload = {
        source: source.name,
        hex,
        generatedAt: new Date().toISOString(),
        originalPointCount: leg.length,
        pointCount: simplified.length,
        startTime: simplified.length ? simplified[0].t : null,
        endTime: simplified.length ? simplified[simplified.length - 1].t : null,
        points: simplified,
        stale: false,
        cached: false
      };

      const freshResponse = new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${TRACE_FRESH_TTL}` }
      });
      const staleResponse = new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${TRACE_STALE_TTL}` }
      });
      ctx.waitUntil(cache.put(freshKey, freshResponse));
      ctx.waitUntil(cache.put(staleKey, staleResponse));
      return json(payload);
    } catch (error) {
      errors.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const stale = await cache.match(staleKey);
  if (stale) {
    const payload = await stale.json();
    payload.stale = true;
    payload.cached = true;
    payload.errors = errors;
    return json(payload);
  }

  return json({
    error: "Full flight trace unavailable",
    hex,
    errors,
    generatedAt: new Date().toISOString()
  }, 502);
}

async function routeLookup(request, ctx) {
  const u = new URL(request.url);
  const callsign = String(u.searchParams.get("callsign") || "").trim().toUpperCase();
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));

  if (!/^[A-Z0-9]{2,12}$/.test(callsign)) {
    return json({ route: null, error: "No route-capable callsign" }, 200);
  }

  const cache = caches.default;
  const key = new Request(`${u.origin}/__route_cache/v2/${encodeURIComponent(callsign)}`);
  const cached = await cache.match(key);
  if (cached) {
    const payload = await cached.json();
    payload.cached = true;
    return json(payload);
  }

  const normalizeAirport = a => a ? ({
    icao: a.icao || null,
    iata: a.iata || null,
    name: a.name || null,
    location: a.location || null,
    countryiso2: a.countryiso2 || null,
    lat: Number.isFinite(Number(a.lat)) ? Number(a.lat) : null,
    lon: Number.isFinite(Number(a.lon)) ? Number(a.lon) : null
  }) : null;

  let staticError = null;

  // Primary route source: hourly VRS standing data, one static JSON per callsign.
  // Example path: /routes/IT/ITY110.json
  try {
    const prefix = callsign.slice(0, 2);
    const staticUrl = `https://vrs-standing-data.adsb.lol/routes/${encodeURIComponent(prefix)}/${encodeURIComponent(callsign)}.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    let response;
    try {
      response = await fetch(staticUrl, {
        headers: {
          "accept": "application/json",
          "user-agent": "AteFlight/7.1 static-route-lookup"
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      const item = await response.json();
      const airports = item && Array.isArray(item._airports) ? item._airports : [];

      const payload = {
        callsign,
        source: "VRS standing data via adsb.lol",
        cached: false,
        route: item ? {
          airportCodes: item.airport_codes || null,
          iataCodes: item._airport_codes_iata || null,
          plausible: true,
          origin: normalizeAirport(airports[0]),
          destination: normalizeAirport(airports.length ? airports[airports.length - 1] : null),
          airports: airports.map(normalizeAirport)
        } : null,
        generatedAt: new Date().toISOString()
      };

      const responseToCache = new Response(JSON.stringify(payload), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${ROUTE_TTL}`
        }
      });
      ctx.waitUntil(cache.put(key, responseToCache));
      return json(payload);
    }

    staticError = `static route HTTP ${response.status}`;
  } catch (error) {
    staticError = error instanceof Error ? error.message : String(error);
  }

  // Fallback only: the tar1090 routeset endpoint. This path is deliberately
  // low-frequency and cached because the live API may rate-limit datacenter IPs.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    let response;
    try {
      response = await fetch("https://api.adsb.lol/api/0/routeset", {
        method: "POST",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "user-agent": "AteFlight/7.1 fallback-route-lookup"
        },
        body: JSON.stringify({
          planes: [{
            callsign,
            lat: Number.isFinite(lat) ? lat : 0,
            lng: Number.isFinite(lon) ? lon : 0
          }]
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const raw = await response.json();
    const item = Array.isArray(raw) && raw.length ? raw[0] : null;
    const airports = item && Array.isArray(item._airports) ? item._airports : [];

    const payload = {
      callsign,
      source: "adsb.lol routeset fallback",
      cached: false,
      route: item ? {
        airportCodes: item.airport_codes || null,
        iataCodes: item._airport_codes_iata || null,
        plausible: item.plausible ?? null,
        origin: normalizeAirport(airports[0]),
        destination: normalizeAirport(airports.length ? airports[airports.length - 1] : null),
        airports: airports.map(normalizeAirport)
      } : null,
      generatedAt: new Date().toISOString()
    };

    const responseToCache = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${ROUTE_TTL}`
      }
    });
    ctx.waitUntil(cache.put(key, responseToCache));
    return json(payload);
  } catch (error) {
    return json({
      callsign,
      source: "route lookup unavailable",
      route: null,
      error: [
        staticError,
        error instanceof Error ? error.message : String(error)
      ].filter(Boolean).join(" | "),
      generatedAt: new Date().toISOString()
    }, 200);
  }
}


const AIRPORT_FRESH_TTL = 12 * 60 * 60;
const AIRPORT_STALE_TTL = 48 * 60 * 60;

const AIRPORT_REGIONS = [
  "https://ourairports.com/countries/US/MI/airports.csv",
  "https://ourairports.com/countries/US/WI/airports.csv",
  "https://ourairports.com/countries/US/OH/airports.csv",
  "https://ourairports.com/countries/US/IN/airports.csv",
  "https://ourairports.com/countries/CA/ON/airports.csv"
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function compactAirportRows(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];

  const headers = rows[0];
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const value = (row, key) => idx[key] == null ? "" : (row[idx[key]] ?? "");

  const airports = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const type = value(row, "type");
    if (!row.length || type === "closed" || type === "balloonport") continue;

    const lat = Number(value(row, "latitude_deg"));
    const lon = Number(value(row, "longitude_deg"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // Keep the regional catalogue useful without turning every hospital pad
    // into a map target.
    if (type === "heliport") continue;

    const ident = value(row, "ident");
    if (!ident) continue;

    airports.push({
      id: value(row, "id") || null,
      ident,
      type,
      name: value(row, "name") || ident,
      lat,
      lon,
      elevationFt: Number(value(row, "elevation_ft")) || null,
      municipality: value(row, "municipality") || null,
      region: value(row, "iso_region") || null,
      scheduled: value(row, "scheduled_service") === "yes",
      gps: value(row, "gps_code") || null,
      icao: value(row, "icao_code") || value(row, "gps_code") || null,
      iata: value(row, "iata_code") || null,
      local: value(row, "local_code") || null
    });
  }

  return airports;
}

async function fetchAirportRegion(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      headers: {
        "accept": "text/csv,text/plain",
        "user-agent": "AteFlight/7.1 airport-catalog"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return compactAirportRows(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

async function airportCatalog(request, ctx) {
  const u = new URL(request.url);
  const cache = caches.default;
  const freshKey = new Request(`${u.origin}/__airport_catalog/v1/fresh`);
  const staleKey = new Request(`${u.origin}/__airport_catalog/v1/stale`);

  const fresh = await cache.match(freshKey);
  if (fresh) {
    const payload = await fresh.json();
    payload.cached = true;
    return json(payload);
  }

  const settled = await Promise.allSettled(AIRPORT_REGIONS.map(fetchAirportRegion));
  const merged = new Map();
  const errors = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const airport of result.value) merged.set(airport.ident, airport);
    } else {
      errors.push(`${AIRPORT_REGIONS[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });

  if (merged.size) {
    const airports = [...merged.values()].filter(a =>
      distanceNm(CENTER.lat, CENTER.lon, a.lat, a.lon) <= 390
    );

    const payload = {
      source: "OurAirports public-domain regional CSV",
      generatedAt: new Date().toISOString(),
      cached: false,
      stale: false,
      airports,
      errors
    };

    const freshResponse = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${AIRPORT_FRESH_TTL}`
      }
    });
    const staleResponse = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${AIRPORT_STALE_TTL}`
      }
    });

    ctx.waitUntil(cache.put(freshKey, freshResponse));
    ctx.waitUntil(cache.put(staleKey, staleResponse));
    return json(payload);
  }

  const stale = await cache.match(staleKey);
  if (stale) {
    const payload = await stale.json();
    payload.stale = true;
    payload.cached = true;
    payload.errors = errors;
    return json(payload);
  }

  return json({
    error: "Airport catalogue unavailable",
    errors,
    generatedAt: new Date().toISOString()
  }, 502);
}


const AIRPORT_DETAIL_TTL = 24 * 60 * 60;

async function fetchTextWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "accept": "text/csv,text/plain",
        "user-agent": "AteFlight/7.1 airport-detail"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function rowsToObjects(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).filter(r => r.length).map(row => {
    const o = {};
    headers.forEach((h, i) => o[h] = row[i] ?? "");
    return o;
  });
}

async function fetchJsonWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent": "AteFlight/7.1 airport-detail"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function csvRowsForAirport(csvText, airportIds) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];

  const headers = rows[0];
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const identIndex = idx.airport_ident;
  const refIndex = idx.airport_ref;
  const wanted = new Set(airportIds.filter(Boolean).map(id => String(id).trim().toUpperCase()));
  const output = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.length) continue;
    const ident = identIndex == null ? "" : String(row[identIndex] || "").trim().toUpperCase();
    const ref = refIndex == null ? "" : String(row[refIndex] || "").trim().toUpperCase();
    if (!wanted.has(ident) && !wanted.has(ref)) continue;
    const object = {};
    headers.forEach((header, index) => object[header] = row[index] ?? "");
    output.push(object);
  }

  return output;
}

function airportIdCandidates(ident, localIdent, icaoIdent) {
  const set = new Set();
  [ident, localIdent, icaoIdent].filter(Boolean).forEach(v => set.add(String(v).trim().toUpperCase()));
  for (const value of [...set]) {
    if (/^K[A-Z0-9]{3}$/.test(value)) set.add(value.slice(1));
  }
  return [...set];
}

async function faaRunwaysForAirport(ids) {
  const localIds = ids.flatMap(id => /^K[A-Z0-9]{3}$/.test(id) ? [id, id.slice(1)] : [id]);
  const unique = [...new Set(localIds)];
  const where = unique.map(id => `ARPT_ID='${id.replace(/'/g, "''")}'`).join(" OR ");
  const params = new URLSearchParams({
    where,
    outFields: "ARPT_ID,ARPT_NAME,RWY_ID,LAT1_DECIMAL,LONG1_DECIMAL,LAT2_DECIMAL,LONG2_DECIMAL,RWY_LEN,RWY_WIDTH,SURFACE_TYPE_CODE,COND,RWY_LGT_CODE,GROSS_WT_SW,GROSS_WT_DW,GROSS_WT_DTW,GROSS_WT_DDTW,EFF_DATE",
    returnGeometry: "false",
    f: "json"
  });
  const url = `https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/Runways_View/FeatureServer/0/query?${params.toString()}`;
  const raw = await fetchJsonWithTimeout(url, 10000);
  if (raw.error) throw new Error(raw.error.message || "FAA runway query failed");
  const features = Array.isArray(raw.features) ? raw.features : [];
  return features.map(f => {
    const a = f.attributes || {};
    const parts = String(a.RWY_ID || "").split(/[-/]/).filter(Boolean);
    return {
      id: a.RWY_ID || null,
      lengthFt: Number(a.RWY_LEN) || null,
      widthFt: Number(a.RWY_WIDTH) || null,
      surface: a.SURFACE_TYPE_CODE || null,
      condition: a.COND || null,
      lighted: !!a.RWY_LGT_CODE && !/NONE|N\/A|^0$/i.test(String(a.RWY_LGT_CODE)),
      lighting: a.RWY_LGT_CODE || null,
      closed: /CLOSED|CLSD|FAILED/i.test(String(a.COND || "")),
      leIdent: parts[0] || null,
      leLat: Number.isFinite(Number(a.LAT1_DECIMAL)) ? Number(a.LAT1_DECIMAL) : null,
      leLon: Number.isFinite(Number(a.LONG1_DECIMAL)) ? Number(a.LONG1_DECIMAL) : null,
      leHeading: null,
      heIdent: parts[1] || null,
      heLat: Number.isFinite(Number(a.LAT2_DECIMAL)) ? Number(a.LAT2_DECIMAL) : null,
      heLon: Number.isFinite(Number(a.LONG2_DECIMAL)) ? Number(a.LONG2_DECIMAL) : null,
      heHeading: null,
      grossWtSingle: Number(a.GROSS_WT_SW) || null,
      grossWtDual: Number(a.GROSS_WT_DW) || null,
      grossWtDualTandem: Number(a.GROSS_WT_DTW) || null,
      grossWtDoubleDualTandem: Number(a.GROSS_WT_DDTW) || null,
      effectiveDate: a.EFF_DATE || null,
      source: "FAA/DOT NTAD Runways FeatureServer"
    };
  });
}

async function ourAirportsFrequencies(ids) {
  const url = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/refs/heads/main/airport-frequencies.csv";
  const text = await fetchTextWithTimeout(url, 10000);
  return csvRowsForAirport(text, ids).map(r => ({
    type: r.type || null,
    description: r.description || null,
    frequencyMhz: r.frequency_mhz || null,
    source: "OurAirports daily airport-frequencies.csv"
  }));
}

async function ourAirportsRunways(ids) {
  const url = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/refs/heads/main/runways.csv";
  const text = await fetchTextWithTimeout(url, 12000);
  return csvRowsForAirport(text, ids).map(r => ({
    id: r.id || null,
    lengthFt: Number(r.length_ft) || null,
    widthFt: Number(r.width_ft) || null,
    surface: r.surface || null,
    condition: null,
    lighted: r.lighted === "1",
    lighting: r.lighted === "1" ? "LIGHTED" : null,
    closed: r.closed === "1",
    leIdent: r.le_ident || null,
    leLat: Number.isFinite(Number(r.le_latitude_deg)) ? Number(r.le_latitude_deg) : null,
    leLon: Number.isFinite(Number(r.le_longitude_deg)) ? Number(r.le_longitude_deg) : null,
    leHeading: Number.isFinite(Number(r.le_heading_degT)) ? Number(r.le_heading_degT) : null,
    heIdent: r.he_ident || null,
    heLat: Number.isFinite(Number(r.he_latitude_deg)) ? Number(r.he_latitude_deg) : null,
    heLon: Number.isFinite(Number(r.he_longitude_deg)) ? Number(r.he_longitude_deg) : null,
    heHeading: Number.isFinite(Number(r.he_heading_degT)) ? Number(r.he_heading_degT) : null,
    source: "OurAirports daily runways.csv"
  }));
}

function deriveHeadings(runways) {
  function brg(lat1, lon1, lat2, lon2) {
    if (![lat1,lon1,lat2,lon2].every(Number.isFinite)) return null;
    const r = d => d * Math.PI / 180;
    const D = x => x * 180 / Math.PI;
    const p1 = r(lat1), p2 = r(lat2), dl = r(lon2 - lon1);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (D(Math.atan2(y, x)) + 360) % 360;
  }
  return runways.map(r => {
    const h1 = Number.isFinite(Number(r.leHeading)) ? Number(r.leHeading) : brg(r.leLat,r.leLon,r.heLat,r.heLon);
    const h2 = Number.isFinite(Number(r.heHeading)) ? Number(r.heHeading) : brg(r.heLat,r.heLon,r.leLat,r.leLon);
    return { ...r, leHeading: h1, heHeading: h2 };
  });
}

function decodeBasicHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(value) {
  return decodeBasicHtml(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function htmlCells(rowHtml) {
  return [...String(rowHtml || "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map(m => stripHtml(m[1]))
    .filter(Boolean);
}

function parseOurAirportsFrequencyHtml(html) {
  const output = [];
  const seen = new Set();
  const rows = String(html || "").match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const cells = htmlCells(row);
    const freqIndex = cells.findIndex(v => /^\d{2,3}(?:\.\d{1,3})?\s*(?:MHz)?$/i.test(v));
    if (freqIndex < 0) continue;
    const frequencyMhz = cells[freqIndex].replace(/\s*MHz$/i, "").trim();
    const type = (cells[0] || "FREQ").trim();
    const description = cells.filter((_, i) => i !== freqIndex && i !== 0).join(" · ").trim();
    const key = `${type}|${frequencyMhz}|${description}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push({ type, description: description || null, frequencyMhz, source: "OurAirports airport page" });
    }
  }

  if (output.length) return output;

  // Fail-soft text parser for layout changes on the site.
  const lines = stripHtml(html).split("\n").map(v => v.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\d{2,3}(?:\.\d{1,3})?)\s*MHz$/i);
    if (!match) continue;
    const type = (lines[i - 1] || "FREQ").slice(0, 24);
    const next = lines[i + 1] || "";
    const nextIsType = /^(?:A\/D|APP|DEP|APP\/DEP|ATIS|AWOS|ASOS|CTAF|GND|RDO|TWR|UNIC|UNICOM|CLEARANCE|CLNC|FSS|MULTICOM|CENTER|ARTCC)$/i.test(next) && /^\d{2,3}(?:\.\d{1,3})?\s*(?:MHz)?$/i.test(lines[i + 2] || "");
    const description = nextIsType || /^(?:Facility data|Create an account|See a problem|Name|Location)$/i.test(next) ? "" : next.slice(0, 80);
    const key = `${type}|${match[1]}|${description}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push({ type, description: description || null, frequencyMhz: match[1], source: "OurAirports airport page" });
    }
  }
  return output;
}

function parseOurAirportsRunwayHtml(html) {
  const lines = stripHtml(html).split("\n").map(v => v.trim()).filter(Boolean);
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    const ident = lines[i].match(/^(\d{1,2}[LRC]?)\s*[-\/]\s*(\d{1,2}[LRC]?)$/i);
    if (!ident) continue;
    let lengthFt = null, widthFt = null, surface = null, lighted = false, closed = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
      if (j > i + 1 && /^(\d{1,2}[LRC]?)\s*[-\/]\s*(\d{1,2}[LRC]?)$/i.test(lines[j])) break;
      const dims = lines[j].match(/([\d,]+)\s*x\s*([\d,]+)\s*ft/i);
      if (dims) {
        lengthFt = Number(dims[1].replace(/,/g, "")) || null;
        widthFt = Number(dims[2].replace(/,/g, "")) || null;
      }
      const surf = lines[j].match(/Surface\s+(?:paved\s+)?(?:\(([^)]+)\)|([^,.;]+))/i);
      if (surf) surface = (surf[1] || surf[2] || "").trim();
      if (/lighted/i.test(lines[j]) && !/not lighted/i.test(lines[j])) lighted = true;
      if (/closed/i.test(lines[j])) closed = true;
      if (j > i + 1 && /Facility data/i.test(lines[j])) break;
    }
    output.push({
      id: `${ident[1].toUpperCase()}/${ident[2].toUpperCase()}`,
      lengthFt, widthFt, surface, condition: null, lighted, lighting: lighted ? "LIGHTED" : null, closed,
      leIdent: ident[1].toUpperCase(), leLat: null, leLon: null, leHeading: null,
      heIdent: ident[2].toUpperCase(), heLat: null, heLon: null, heHeading: null,
      source: "OurAirports airport page"
    });
  }
  return output;
}

async function ourAirportsAirportPage(icao, section) {
  const code = String(icao || "").trim();
  if (!code) return [];
  const url = `https://ourairports.com/airports/${encodeURIComponent(code)}/${section}.html`;
  const html = await fetchTextWithTimeout(url, 9000);
  return section === "runways" ? parseOurAirportsRunwayHtml(html) : parseOurAirportsFrequencyHtml(html);
}

async function airportDetail(request, ctx) {
  const u = new URL(request.url);
  const ident = String(u.searchParams.get("ident") || "").trim().toUpperCase();
  const localIdent = String(u.searchParams.get("local") || "").trim().toUpperCase();
  const icaoIdent = String(u.searchParams.get("icao") || "").trim().toUpperCase();
  const airportRef = String(u.searchParams.get("ref") || "").trim();

  if (!ident && !localIdent && !icaoIdent) return json({ error: "Missing airport identity" }, 400);

  const ids = airportIdCandidates(ident, localIdent, icaoIdent);
  const pageCode = icaoIdent || ident || localIdent;
  const cache = caches.default;
  const cacheId = ids.slice().sort().join("-");
  const key = new Request(`${u.origin}/__airport_detail/v63/${encodeURIComponent(cacheId)}`);

  const cached = await cache.match(key);
  if (cached) {
    const payload = await cached.json();
    payload.cached = true;
    return json(payload);
  }

  const diagnostics = [];
  let runways = [];
  let frequencies = [];
  let runwaySource = null;
  let frequencySource = null;

  // Runway loop 1: official FAA/DOT NASR-derived feature service.
  try {
    runways = deriveHeadings(await faaRunwaysForAirport(ids));
    diagnostics.push({ source: "FAA/DOT Runways FeatureServer", ok: true, count: runways.length });
    if (runways.length) runwaySource = "FAA/DOT NTAD Runways";
  } catch (error) {
    diagnostics.push({ source: "FAA/DOT Runways FeatureServer", ok: false, error: String(error.message || error) });
  }

  // Runway loop 2: small per-airport OurAirports HTML page.
  if (!runways.length) {
    try {
      runways = deriveHeadings(await ourAirportsAirportPage(pageCode, "runways"));
      diagnostics.push({ source: "OurAirports airport runway page", ok: true, count: runways.length });
      if (runways.length) runwaySource = "OurAirports airport runway page";
    } catch (error) {
      diagnostics.push({ source: "OurAirports airport runway page", ok: false, error: String(error.message || error) });
    }
  }

  // Runway loop 3: daily global CSV as last resort.
  if (!runways.length) {
    try {
      runways = deriveHeadings(await ourAirportsRunways(ids));
      diagnostics.push({ source: "OurAirports runways.csv", ok: true, count: runways.length });
      if (runways.length) runwaySource = "OurAirports daily runways.csv";
    } catch (error) {
      diagnostics.push({ source: "OurAirports runways.csv", ok: false, error: String(error.message || error) });
    }
  }

  // Comms loop 1: small per-airport page, avoiding a huge global CSV download.
  try {
    frequencies = await ourAirportsAirportPage(pageCode, "frequencies");
    diagnostics.push({ source: "OurAirports airport frequency page", ok: true, count: frequencies.length });
    if (frequencies.length) frequencySource = "OurAirports airport frequency page";
  } catch (error) {
    diagnostics.push({ source: "OurAirports airport frequency page", ok: false, error: String(error.message || error) });
  }

  // Comms loop 2: daily global CSV fallback.
  if (!frequencies.length) {
    try {
      frequencies = await ourAirportsFrequencies(ids);
      diagnostics.push({ source: "OurAirports airport-frequencies.csv", ok: true, count: frequencies.length });
      if (frequencies.length) frequencySource = "OurAirports daily airport-frequencies.csv";
    } catch (error) {
      diagnostics.push({ source: "OurAirports airport-frequencies.csv", ok: false, error: String(error.message || error) });
    }
  }

  const payload = {
    source: "Airport detail source loop",
    ident: ident || null,
    localIdent: localIdent || null,
    icaoIdent: icaoIdent || null,
    airportRef: airportRef || null,
    generatedAt: new Date().toISOString(),
    cached: false,
    runways,
    frequencies,
    runwaySource,
    frequencySource,
    diagnostics,
    status: {
      runways: runways.length ? "ready" : "unavailable",
      frequencies: frequencies.length ? "ready" : "unavailable"
    }
  };

  const responseToCache = new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${runways.length || frequencies.length ? 21600 : 300}`
    }
  });
  ctx.waitUntil(cache.put(key, responseToCache));
  return json(payload);
}


const PROCEDURE_TTL = 6 * 60 * 60;

function xmlTag(record, tag) {
  const m = record.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() : "";
}

async function fetchTextUrl(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "AteFlight/7.1 FAA-dTPP" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function absoluteFaaUrl(href) {
  const value = decodeBasicHtml(String(href || "").trim());
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (/^\/d-tpp\//i.test(value)) return `https://aeronav.faa.gov${value}`;
  if (value.startsWith("/")) return `https://www.faa.gov${value}`;
  return `https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/search/results/${value}`;
}

function parseFaaProcedureSearchHtml(html) {
  const procedures = [];
  const seen = new Set();
  const rows = String(html || "").match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  const knownCodes = new Set(["APD","IAP","DP","ODP","STAR","MIN","HOT","AHS"]);

  for (const row of rows) {
    const cells = htmlCells(row);
    const rowText = stripHtml(row);
    const code = cells.find(v => knownCodes.has(String(v).trim().toUpperCase())) ||
      rowText.split(/\s+/).find(v => knownCodes.has(String(v).trim().toUpperCase()));
    const anchors = [...row.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map(m => ({ href: absoluteFaaUrl(m[1]), text: stripHtml(m[2]).replace(/\s*\(PDF\)\s*$/i, "").trim() }))
      .filter(a => a.href && a.text && !/^compare$/i.test(a.text));
    const chart = anchors.find(a => /\.pdf(?:$|\?)/i.test(a.href) || /aeronav\.faa\.gov/i.test(a.href));
    if (!code || !chart) continue;
    const key = `${code}|${chart.text}|${chart.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    procedures.push({ code: String(code).toUpperCase(), name: chart.text, pdfName: chart.href.split("/").pop(), amendment: null, amendmentDate: null, url: chart.href });
  }
  return procedures;
}

async function airportProcedures(request, ctx) {
  const u = new URL(request.url);
  const icao = String(u.searchParams.get("ident") || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(icao)) return json({ error: "Invalid airport identifier" }, 400);

  const cache = caches.default;
  const key = new Request(`${u.origin}/__dtpp/v63/${icao}`);
  const cached = await cache.match(key);
  if (cached) {
    const payload = await cached.json();
    payload.cached = true;
    return json(payload);
  }

  const localIdent = icao.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;
  const searchUrl = `https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/search/results/?ident=${encodeURIComponent(localIdent)}`;
  const diagnostics = [];
  let procedures = [];
  let cycle = null;

  try {
    const searchHtml = await fetchTextUrl(searchUrl, 12000);
    procedures = parseFaaProcedureSearchHtml(searchHtml);
    const cycleMatch = searchHtml.match(/(?:cycle=|\/d-tpp\/)(\d{4})/i);
    cycle = cycleMatch ? cycleMatch[1] : null;
    diagnostics.push({ source: "FAA d-TPP search results", ok: true, count: procedures.length });

    // Metafile fallback if the FAA changes the search-result markup.
    if (!procedures.length) {
      let xmlUrl = null;
      const hrefMatch = searchHtml.match(/href=["']([^"']*\/d-tpp\/(\d{4})\/xml_data\/d-TPP_Metafile\.xml[^"']*)["']/i);
      if (hrefMatch) {
        cycle = hrefMatch[2];
        xmlUrl = hrefMatch[1].startsWith("http") ? hrefMatch[1] : `https://aeronav.faa.gov${hrefMatch[1]}`;
      }
      if (!cycle) cycle = "2608";
      if (!xmlUrl) xmlUrl = `https://aeronav.faa.gov/d-tpp/${cycle}/xml_data/d-TPP_Metafile.xml`;
      const xml = await fetchTextUrl(xmlUrl, 18000);
      const escaped = icao.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const airportRegex = new RegExp(`<airport_name\\b[^>]*icao_ident=["']${escaped}["'][^>]*>([\\s\\S]*?)</airport_name>`, "i");
      const airportMatch = xml.match(airportRegex);
      if (airportMatch) {
        const records = airportMatch[1].match(/<record>[\s\S]*?<\/record>/gi) || [];
        procedures = records.map(record => {
          const pdfName = xmlTag(record, "pdf_name");
          return {
            code: xmlTag(record, "chart_code"),
            name: xmlTag(record, "chart_name"),
            pdfName,
            amendment: xmlTag(record, "amdtnum") || null,
            amendmentDate: xmlTag(record, "amdtdate") || null,
            url: pdfName ? `https://aeronav.faa.gov/d-tpp/${cycle}/${pdfName}` : null
          };
        }).filter(p => p.name && p.pdfName);
      }
      diagnostics.push({ source: "FAA d-TPP metafile fallback", ok: true, count: procedures.length });
    }
  } catch (error) {
    diagnostics.push({ source: "FAA d-TPP", ok: false, error: String(error.message || error) });
  }

  const order = { APD: 0, IAP: 1, DP: 2, ODP: 3, STAR: 4, MIN: 5, HOT: 6, AHS: 7 };
  procedures.sort((a, b) => (order[a.code] ?? 20) - (order[b.code] ?? 20) || a.name.localeCompare(b.name));

  const payload = {
    source: procedures.length ? "FAA Digital Terminal Procedures Publication" : "FAA d-TPP unavailable",
    ident: icao,
    cycle,
    generatedAt: new Date().toISOString(),
    cached: false,
    procedures,
    diagnostics,
    status: procedures.length ? "ready" : "unavailable"
  };

  const responseToCache = new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${procedures.length ? 21600 : 300}`
    }
  });
  ctx.waitUntil(cache.put(key, responseToCache));
  return json(payload);
}


const GEO_V65_FRESH_TTL = 6 * 60 * 60;
const GEO_V65_STALE_TTL = 24 * 60 * 60;
const WEATHER_V65_FRESH_TTL = 120;
const WEATHER_V65_STALE_TTL = 1200;

let geoV65Memory = {
  airports: { at: 0, rows: null },
  navaids: { at: 0, rows: null }
};

async function fetchCsvV65(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "accept": "text/csv,text/plain",
        "user-agent": "AteFlight/7.1 viewport-catalog"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function northAmericaAirportRow(a) {
  const region = String(a && a.region || "").toUpperCase();
  return region.startsWith("US-") || region.startsWith("CA-") || region.startsWith("MX-");
}

async function loadNorthAmericaAirportsV65() {
  const now = Date.now();
  if (geoV65Memory.airports.rows && now - geoV65Memory.airports.at < GEO_V65_FRESH_TTL * 1000) {
    return geoV65Memory.airports.rows;
  }

  const countryUrls = [
    "https://ourairports.com/countries/US/airports.csv",
    "https://ourairports.com/countries/CA/airports.csv",
    "https://ourairports.com/countries/MX/airports.csv"
  ];

  const settled = await Promise.allSettled(countryUrls.map(url => fetchCsvV65(url, 16000)));
  const merged = new Map();
  const errors = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const airport of compactAirportRows(result.value)) {
        merged.set(`${airport.region || ""}:${airport.ident}`, airport);
      }
    } else {
      errors.push(`${countryUrls[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });

  // Fail-soft global fallback. It is only used when every regional feed failed.
  if (!merged.size) {
    try {
      const globalText = await fetchCsvV65(
        "https://davidmegginson.github.io/ourairports-data/airports.csv",
        22000
      );
      for (const airport of compactAirportRows(globalText)) {
        if (northAmericaAirportRow(airport)) {
          merged.set(`${airport.region || ""}:${airport.ident}`, airport);
        }
      }
    } catch (error) {
      errors.push(`global airports.csv: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!merged.size) throw new Error(errors.join(" | ") || "No airport catalogue rows");
  const rows = [...merged.values()];
  geoV65Memory.airports = { at: now, rows };
  return rows;
}

function compactNavaidRowsV65(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];
  const headers = rows[0];
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const value = (row, key) => idx[key] == null ? "" : (row[idx[key]] ?? "");
  const out = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.length) continue;
    const lat = Number(value(row, "latitude_deg"));
    const lon = Number(value(row, "longitude_deg"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const country = value(row, "iso_country");
    if (!["US", "CA", "MX"].includes(country)) continue;
    const type = value(row, "type");
    if (!type) continue;

    out.push({
      id: value(row, "id") || null,
      ident: value(row, "ident") || null,
      name: value(row, "name") || value(row, "ident") || null,
      type,
      frequencyKhz: Number(value(row, "frequency_khz")) || null,
      lat,
      lon,
      elevationFt: Number(value(row, "elevation_ft")) || null,
      country,
      region: value(row, "iso_region") || null,
      dmeFrequencyKhz: Number(value(row, "dme_frequency_khz")) || null,
      dmeChannel: value(row, "dme_channel") || null,
      magneticVariation: Number(value(row, "magnetic_variation_deg")) || null,
      power: value(row, "power") || null,
      associatedAirport: value(row, "associated_airport") || null
    });
  }
  return out;
}

async function loadNorthAmericaNavaidsV65() {
  const now = Date.now();
  if (geoV65Memory.navaids.rows && now - geoV65Memory.navaids.at < GEO_V65_FRESH_TTL * 1000) {
    return geoV65Memory.navaids.rows;
  }

  const text = await fetchCsvV65(
    "https://davidmegginson.github.io/ourairports-data/navaids.csv",
    18000
  );
  const rows = compactNavaidRowsV65(text);
  if (!rows.length) throw new Error("No navaid catalogue rows");
  geoV65Memory.navaids = { at: now, rows };
  return rows;
}

function airportPriorityV65(a) {
  if (a.scheduled || a.type === "large_airport") return 0;
  if (a.type === "medium_airport") return 1;
  if (a.type === "small_airport") return 2;
  return 3;
}

function airportVisibleAtZoomV65(a, zoom) {
  const priority = airportPriorityV65(a);
  if (zoom < 4.5) return priority === 0;
  if (zoom < 5.75) return priority <= 1;
  // Small reporting airports must be available by normal regional zoom so
  // airport METAR colors do not disappear from the product.
  if (zoom < 8.5) return priority <= 2;
  return true;
}

function navaidVisibleAtZoomV65(navaid, zoom) {
  const type = String(navaid.type || "").toUpperCase();
  const major = /(VOR|VORTAC|VOR-DME|TACAN)/.test(type);
  if (zoom < 5.5) return major && String(navaid.power || "").toUpperCase() !== "LOW";
  if (zoom < 8.25) return major || type.includes("NDB");
  return true;
}

async function airportCatalogV65(request, ctx) {
  const u = new URL(request.url);
  const bbox = parseBbox(u.searchParams.get("bbox"), [24, -125, 50, -66]);
  const zoom = clampNumber(u.searchParams.get("zoom"), 2, 16, 8);
  const zoomBucket = Math.floor(zoom * 2) / 2;
  const keyText = `${bboxKey(bbox)}_z${zoomBucket.toFixed(1)}`;
  const cache = caches.default;
  const freshKey = new Request(`${u.origin}/__airport_catalog/v65/${keyText}/fresh`);
  const staleKey = new Request(`${u.origin}/__airport_catalog/v65/${keyText}/stale`);

  const cached = await cache.match(freshKey);
  if (cached) {
    const payload = await cached.json();
    payload.cached = true;
    return json(payload);
  }

  try {
    const all = await loadNorthAmericaAirportsV65();
    const airports = all
      .filter(a => withinBbox(a.lat, a.lon, bbox) && airportVisibleAtZoomV65(a, zoom))
      .sort((a, b) => airportPriorityV65(a) - airportPriorityV65(b) || String(a.ident).localeCompare(String(b.ident)))
      .slice(0, zoom < 5 ? 550 : zoom < 7 ? 1500 : 3500);

    const payload = {
      source: "OurAirports North America viewport catalogue",
      bbox,
      zoom,
      generatedAt: new Date().toISOString(),
      cached: false,
      stale: false,
      total: airports.length,
      airports
    };

    const fresh = new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${GEO_V65_FRESH_TTL}` }
    });
    const stale = new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${GEO_V65_STALE_TTL}` }
    });
    ctx.waitUntil(cache.put(freshKey, fresh));
    ctx.waitUntil(cache.put(staleKey, stale));
    return json(payload);
  } catch (error) {
    const stale = await cache.match(staleKey);
    if (stale) {
      const payload = await stale.json();
      payload.stale = true;
      payload.cached = true;
      payload.warning = error instanceof Error ? error.message : String(error);
      return json(payload);
    }
    return json({
      error: "Airport catalogue unavailable",
      detail: error instanceof Error ? error.message : String(error),
      bbox
    }, 502);
  }
}

async function navaidCatalogV65(request, ctx) {
  const u = new URL(request.url);
  const bbox = parseBbox(u.searchParams.get("bbox"), [24, -125, 50, -66]);
  const zoom = clampNumber(u.searchParams.get("zoom"), 2, 16, 8);
  const zoomBucket = Math.floor(zoom * 2) / 2;
  const keyText = `${bboxKey(bbox)}_z${zoomBucket.toFixed(1)}`;
  const cache = caches.default;
  const freshKey = new Request(`${u.origin}/__navaid_catalog/v65/${keyText}/fresh`);
  const staleKey = new Request(`${u.origin}/__navaid_catalog/v65/${keyText}/stale`);

  const cached = await cache.match(freshKey);
  if (cached) {
    const payload = await cached.json();
    payload.cached = true;
    return json(payload);
  }

  try {
    const all = await loadNorthAmericaNavaidsV65();
    const navaids = all
      .filter(n => withinBbox(n.lat, n.lon, bbox) && navaidVisibleAtZoomV65(n, zoom))
      .slice(0, zoom < 6 ? 650 : zoom < 8.5 ? 1300 : 2200);

    const payload = {
      source: "OurAirports current navaid catalogue",
      bbox,
      zoom,
      generatedAt: new Date().toISOString(),
      cached: false,
      stale: false,
      total: navaids.length,
      navaids
    };

    const fresh = new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${GEO_V65_FRESH_TTL}` }
    });
    const stale = new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${GEO_V65_STALE_TTL}` }
    });
    ctx.waitUntil(cache.put(freshKey, fresh));
    ctx.waitUntil(cache.put(staleKey, stale));
    return json(payload);
  } catch (error) {
    const stale = await cache.match(staleKey);
    if (stale) {
      const payload = await stale.json();
      payload.stale = true;
      payload.cached = true;
      payload.warning = error instanceof Error ? error.message : String(error);
      return json(payload);
    }
    return json({
      error: "Navaid catalogue unavailable",
      detail: error instanceof Error ? error.message : String(error),
      bbox
    }, 502);
  }
}

function weatherBboxForApiV65(input) {
  const bbox = [...input];
  const centerLat = (bbox[0] + bbox[2]) / 2;
  const centerLon = (bbox[1] + bbox[3]) / 2;
  const maxLatSpan = 20;
  const maxLonSpan = 28;
  const latSpan = Math.min(maxLatSpan, Math.max(1, bbox[2] - bbox[0]));
  const lonSpan = Math.min(maxLonSpan, Math.max(1, Math.abs(bbox[3] - bbox[1])));
  return [
    centerLat - latSpan / 2,
    centerLon - lonSpan / 2,
    centerLat + latSpan / 2,
    centerLon + lonSpan / 2
  ].map(value => Number(value.toFixed(2)));
}

async function aviationWeatherV65(request, ctx) {
  const u = new URL(request.url);
  const requested = parseBbox(u.searchParams.get("bbox"), [24, -125, 50, -66]);
  const bbox = weatherBboxForApiV65(requested);
  const bboxString = bbox.join(",");
  const keyText = bboxKey(bbox, 0.5);
  const cache = caches.default;
  const freshKey = new Request(`${u.origin}/__weather_cache/v65/${keyText}/fresh`);
  const staleKey = new Request(`${u.origin}/__weather_cache/v65/${keyText}/stale`);

  const cached = await cache.match(freshKey);
  if (cached) {
    const payload = await cached.json();
    payload.cached = true;
    return json(payload);
  }

  const base = "https://aviationweather.gov/api/data";
  const urls = {
    metars: `${base}/metar?bbox=${encodeURIComponent(bboxString)}&format=json&hours=2`,
    tafs: `${base}/taf?bbox=${encodeURIComponent(bboxString)}&format=json`,
    pireps: `${base}/pirep?bbox=${encodeURIComponent(bboxString)}&format=json&age=3`,
    gairmets: `${base}/gairmet?format=geojson&fore=0`,
    sigmets: `${base}/airsigmet?format=geojson`,
    cwas: `${base}/cwa?format=geojson`,
    tcf: `${base}/tcf?format=geojson`
  };

  const names = Object.keys(urls);
  const settled = await Promise.allSettled(
    names.map(name => fetchAviationWeatherJson(urls[name], 12000))
  );

  const payload = {
    source: "NOAA/NWS AviationWeather.gov",
    requestedBbox: requested,
    bbox,
    generatedAt: new Date().toISOString(),
    cached: false,
    stale: false,
    metars: [],
    tafs: [],
    pireps: [],
    gairmets: { type: "FeatureCollection", features: [] },
    sigmets: { type: "FeatureCollection", features: [] },
    cwas: { type: "FeatureCollection", features: [] },
    tcf: { type: "FeatureCollection", features: [] },
    errors: []
  };

  settled.forEach((result, index) => {
    const name = names[index];
    if (result.status === "fulfilled") payload[name] = result.value;
    else payload.errors.push(`${name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });

  if (settled.some(result => result.status === "fulfilled")) {
    const fresh = new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${WEATHER_V65_FRESH_TTL}` }
    });
    const stale = new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${WEATHER_V65_STALE_TTL}` }
    });
    ctx.waitUntil(cache.put(freshKey, fresh));
    ctx.waitUntil(cache.put(staleKey, stale));
    return json(payload);
  }

  const stale = await cache.match(staleKey);
  if (stale) {
    const oldPayload = await stale.json();
    oldPayload.stale = true;
    oldPayload.cached = true;
    oldPayload.errors = [...(oldPayload.errors || []), ...(payload.errors || [])];
    return json(oldPayload);
  }

  return json({
    error: "Aviation weather layers unavailable",
    errors: payload.errors,
    bbox
  }, 502);
}



const WIND_V68_FRESH_TTL = 60 * 60;
const WIND_V68_STALE_TTL = 6 * 60 * 60;
const NDFD_CONFIG_TTL = 6 * 60 * 60;
const NDFD_SERVICE_V68 = "https://nowcoast.noaa.gov/arcgis/rest/services/nowcoast/forecast_meteoceanhydro_sfc_ndfd_time/MapServer";

function windRegionsForPoint(lat, lon) {
  const primary = lon < -117 ? (lat > 40 ? "sfo" : "lax")
    : lon < -104 ? "slc"
    : lon < -91 ? (lat < 36 ? "dfw" : "chi")
    : lon < -79 ? (lat < 35 ? "mia" : "chi")
    : (lat < 35 ? "mia" : "bos");
  return [...new Set([primary, "chi", "dfw", "slc", "sfo", "bos", "mia", "lax"])]
}

async function fetchAviationTextV68(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "accept": "text/plain",
        "user-agent": "AteFlight/7.1 winds-aloft"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeFbWindV68(token, altitudeFt) {
  const value = String(token || "").trim().toUpperCase();
  if (!value || value === "////" || value === "9999") return null;
  const match = value.match(/^(\d{4})([+-]?\d{2,3})?$/);
  if (!match) return null;
  let directionCode = Number(match[1].slice(0, 2));
  let speed = Number(match[1].slice(2, 4));
  if (!Number.isFinite(directionCode) || !Number.isFinite(speed)) return null;
  if (directionCode === 99 && speed === 0) return { dir: 0, speed: 0, tempC: null, calm: true };
  if (directionCode >= 51) {
    directionCode -= 50;
    speed += 100;
  }
  let tempC = null;
  if (match[2]) {
    const rawTemp = match[2];
    const numeric = Number(rawTemp);
    if (Number.isFinite(numeric)) {
      tempC = altitudeFt >= 24000 && !rawTemp.startsWith("+") && !rawTemp.startsWith("-")
        ? -Math.abs(numeric)
        : numeric;
    }
  }
  return { dir: (directionCode * 10) % 360, speed, tempC, calm: false };
}

function parseFbWindsV68(text, region) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const headerIndex = lines.findIndex(line => /^\s*FT\s+3000\b/i.test(line));
  if (headerIndex < 0) return { region, levels: [], stations: [], rawHeader: null };
  const headers = lines[headerIndex].trim().split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
  const stations = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*[A-Z0-9]{3}\s+/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const id = parts.shift();
    if (!id || parts.length < 2) continue;
    const winds = {};
    headers.forEach((level, index) => {
      const decoded = decodeFbWindV68(parts[index], level);
      if (decoded) winds[String(level)] = decoded;
    });
    if (Object.keys(winds).length) stations.push({ id, winds });
  }
  const based = lines.find(line => /DATA BASED ON/i.test(line)) || "";
  const valid = lines.find(line => /VALID .* FOR USE/i.test(line)) || "";
  return { region, levels: headers, stations, rawHeader: [based.trim(), valid.trim()].filter(Boolean).join(" · ") };
}

async function windsAloftV68(request, ctx) {
  const u = new URL(request.url);
  const lat = clampNumber(u.searchParams.get("lat"), -90, 90, CENTER.lat);
  const lon = clampNumber(u.searchParams.get("lon"), -180, 180, CENTER.lon);
  const forecast = ["06", "12", "24"].includes(u.searchParams.get("fcst")) ? u.searchParams.get("fcst") : "06";
  const cache = caches.default;
  const regionCandidates = windRegionsForPoint(lat, lon);
  const key = new Request(`${u.origin}/__winds/v68/${regionCandidates[0]}/${forecast}`);
  const staleKey = new Request(`${u.origin}/__winds/v68/${regionCandidates[0]}/${forecast}/stale`);
  const cached = await cache.match(key);
  if (cached) {
    const payload = await cached.json(); payload.cached = true; return json(payload);
  }
  const errors = [];
  for (const region of regionCandidates) {
    try {
      const url = `https://aviationweather.gov/api/data/windtemp?region=${encodeURIComponent(region)}&level=low&fcst=${forecast}`;
      const text = await fetchAviationTextV68(url);
      const parsed = parseFbWindsV68(text, region);
      if (!parsed.stations.length) throw new Error("No decoded wind stations");
      const payload = {
        source: "NOAA/NCEP FB Winds via AviationWeather.gov",
        generatedAt: new Date().toISOString(),
        forecastHours: Number(forecast),
        requestedPoint: { lat, lon },
        cached: false, stale: false,
        ...parsed
      };
      const fresh = new Response(JSON.stringify(payload), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${WIND_V68_FRESH_TTL}` } });
      const stale = new Response(JSON.stringify(payload), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${WIND_V68_STALE_TTL}` } });
      ctx.waitUntil(cache.put(key, fresh)); ctx.waitUntil(cache.put(staleKey, stale));
      return json(payload);
    } catch (error) {
      errors.push(`${region}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const stale = await cache.match(staleKey);
  if (stale) { const payload = await stale.json(); payload.stale = true; payload.cached = true; payload.errors = errors; return json(payload); }
  return json({ error: "Winds aloft unavailable", errors, generatedAt: new Date().toISOString() }, 502);
}

async function weatherMapConfigV68(request, ctx) {
  const u = new URL(request.url);
  const cache = caches.default;
  const key = new Request(`${u.origin}/__weather_map_config/v68`);
  const cached = await cache.match(key);
  if (cached) return json(await cached.json());
  try {
    const response = await fetch(`${NDFD_SERVICE_V68}?f=json`, { headers: { "accept": "application/json", "user-agent": "AteFlight/7.1 weather-map-config" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.json();
    const layers = Array.isArray(raw.layers) ? raw.layers : [];
    function score(name) {
      const n = String(name || "").toLowerCase();
      if (!n.includes("precip")) return -1;
      if (n.includes("1 hour") || n.includes("1-hour") || n.includes("hourly")) return 100;
      if (n.includes("6 hour") || n.includes("6-hour")) return 80;
      if (n.includes("amount")) return 60;
      if (n.includes("probability")) return 40;
      return 20;
    }
    const candidates = layers.map(layer => ({ id: layer.id, name: layer.name, score: score(layer.name) })).filter(x => x.score >= 0).sort((a,b) => b.score-a.score);
    const chosen = candidates[0] || null;
    const payload = {
      source: "NOAA nowCOAST NDFD forecast map service",
      generatedAt: new Date().toISOString(),
      serviceUrl: NDFD_SERVICE_V68,
      precipitationLayer: chosen,
      candidates: candidates.slice(0, 8),
      timeInfo: raw.timeInfo || null
    };
    const cachedResponse = new Response(JSON.stringify(payload), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${NDFD_CONFIG_TTL}` } });
    ctx.waitUntil(cache.put(key, cachedResponse));
    return json(payload);
  } catch (error) {
    return json({ error: "Forecast map configuration unavailable", detail: error instanceof Error ? error.message : String(error), serviceUrl: NDFD_SERVICE_V68 }, 502);
  }
}

const SUA_V67_FRESH_TTL = 6 * 60 * 60;
const SUA_V67_STALE_TTL = 48 * 60 * 60;
const FAA_SUA_LAYER_V67 = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Special_Use_Airspace/FeatureServer/0/query";

async function fetchSuaaGeoJsonV67(bbox) {
  const [south, west, north, east] = bbox;
  const params = new URLSearchParams({
    where: "1=1",
    geometry: `${west},${south},${east},${north}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: [
      "OBJECTID","GLOBAL_ID","NAME","TYPE_CODE","CLASS",
      "UPPER_DESC","UPPER_VAL","UPPER_UOM","UPPER_CODE",
      "LOWER_DESC","LOWER_VAL","LOWER_UOM","LOWER_CODE",
      "LEVEL_CODE","CITY","STATE","COUNTRY","CONT_AGENT",
      "COMM_NAME","SECTOR","ONSHORE","EXCLUSION","TIMESOFUSE",
      "GMTOFFSET","DST_CODE","REMARKS"
    ].join(","),
    returnGeometry: "true",
    resultRecordCount: "2000",
    f: "geojson"
  });
  const response = await fetch(`${FAA_SUA_LAYER_V67}?${params.toString()}`, {
    headers: {
      "accept": "application/geo+json,application/json",
      "user-agent": "AteFlight/7.1 FAA-SUA"
    }
  });
  if (!response.ok) throw new Error(`FAA SUA HTTP ${response.status}`);
  const raw = await response.json();
  if (raw && raw.error) throw new Error(raw.error.message || "FAA SUA query error");
  if (!raw || raw.type !== "FeatureCollection" || !Array.isArray(raw.features)) {
    throw new Error("FAA SUA response was not GeoJSON");
  }
  return raw;
}

async function specialUseAirspaceV67(request, ctx) {
  const u = new URL(request.url);
  const requested = parseBbox(u.searchParams.get("bbox"), [24, -125, 50, -66]);
  const cache = caches.default;
  const keyText = bboxKey(requested, 0.5);
  const freshKey = new Request(`${u.origin}/__sua_cache/v67/${keyText}/fresh`);
  const staleKey = new Request(`${u.origin}/__sua_cache/v67/${keyText}/stale`);

  const cached = await cache.match(freshKey);
  if (cached) {
    const payload = await cached.json();
    payload.cached = true;
    return json(payload);
  }

  try {
    const [south, west, north, east] = requested;
    const boxes = west <= east
      ? [requested]
      : [[south, west, north, 180], [south, -180, north, east]];
    const results = await Promise.all(boxes.map(fetchSuaaGeoJsonV67));
    const seen = new Set();
    const features = [];
    for (const result of results) {
      for (const feature of result.features) {
        const p = feature.properties || {};
        const id = p.GLOBAL_ID || p.OBJECTID || `${p.NAME || "SUA"}:${features.length}`;
        if (seen.has(id)) continue;
        seen.add(id);
        features.push(feature);
      }
    }
    const airspace = { type: "FeatureCollection", features };
    const payload = {
      source: "FAA Aeronautical Information Services · Special Use Airspace",
      generatedAt: new Date().toISOString(),
      cycleUpdated: "2026-07-09",
      cached: false,
      stale: false,
      bbox: requested,
      total: features.length,
      airspace
    };
    const fresh = new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${SUA_V67_FRESH_TTL}` }
    });
    const stale = new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${SUA_V67_STALE_TTL}` }
    });
    ctx.waitUntil(cache.put(freshKey, fresh));
    ctx.waitUntil(cache.put(staleKey, stale));
    return json(payload);
  } catch (error) {
    const stale = await cache.match(staleKey);
    if (stale) {
      const payload = await stale.json();
      payload.stale = true;
      payload.cached = true;
      payload.warning = error instanceof Error ? error.message : String(error);
      return json(payload);
    }
    return json({
      error: "Special use airspace unavailable",
      detail: error instanceof Error ? error.message : String(error),
      bbox: requested
    }, 502);
  }
}

const FEATURE_MANIFEST_V65 = {
  traffic: ["live aircraft", "selected aircraft", "current-leg trace", "route/destination"],
  maps: ["aviation", "VFR sectional", "IFR low", "IFR high", "Michigan aero", "satellite", "dark/liberty"],
  airports: ["viewport airport catalogue", "METAR category", "TAF availability", "runways", "comms", "procedures", "live movements", "preferred runway"],
  weather: ["MRMS radar", "GOES infrared", "lightning", "METAR", "TAF", "PIREP", "SIGMET", "G-AIRMET", "CWA", "TCF"],
  airspace: ["MOA", "restricted", "prohibited", "warning", "alert", "national security area", "full detail inspector"],
  reference: ["navaids", "KAPN home", "range rings"],
  interface: ["desktop inspector", "mobile sheet", "cursor hit testing", "command palette", "data status"]
};

async function responseStatusV65(label, responsePromise, countFields) {
  try {
    const response = await responsePromise;
    const payload = await response.json();
    const count = (countFields || []).reduce((sum, field) => {
      const value = payload && payload[field];
      if (Array.isArray(value)) return sum + value.length;
      if (value && Array.isArray(value.features)) return sum + value.features.length;
      return sum;
    }, 0);
    return {
      label,
      ok: response.ok,
      status: response.status,
      count,
      source: payload && payload.source || null,
      error: response.ok ? null : (payload && (payload.detail || payload.error) || `HTTP ${response.status}`)
    };
  } catch (error) {
    return { label, ok: false, status: 0, count: 0, source: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function systemStatusV65(request, ctx) {
  const u = new URL(request.url);
  const live = u.searchParams.get("live") === "1";
  const base = {
    ok: true,
    version: "7.1",
    manifest: FEATURE_MANIFEST_V65,
    routes: {
      traffic: "/api/traffic",
      airports: "/api/airports",
      navaids: "/api/navaids",
      weather: "/api/weather",
      airspace: "/api/airspace",
      airportDetail: "/api/airport-detail",
      procedures: "/api/procedures",
      trace: "/api/trace",
      route: "/api/route"
    },
    generatedAt: new Date().toISOString()
  };

  if (!live) return json(base);

  const origin = u.origin;
  const bbox = "44,-85,46,-82";
  const checks = await Promise.all([
    responseStatusV65("traffic", traffic(new Request(`${origin}/api/traffic?lat=45.0781&lon=-83.5603&radius=100&bbox=${encodeURIComponent(bbox)}&zoom=7&coverage=fast`), ctx), ["aircraft"]),
    responseStatusV65("airports", airportCatalogV65(new Request(`${origin}/api/airports?bbox=${encodeURIComponent(bbox)}&zoom=7`), ctx), ["airports"]),
    responseStatusV65("navaids", navaidCatalogV65(new Request(`${origin}/api/navaids?bbox=${encodeURIComponent(bbox)}&zoom=7`), ctx), ["navaids"]),
    responseStatusV65("weather", aviationWeatherV65(new Request(`${origin}/api/weather?bbox=${encodeURIComponent(bbox)}`), ctx), ["metars", "tafs", "pireps"]),
    responseStatusV65("airspace", specialUseAirspaceV67(new Request(`${origin}/api/airspace?bbox=${encodeURIComponent(bbox)}`), ctx), ["airspace"])
  ]);

  return json({
    ...base,
    live: true,
    ok: checks.every(check => check.ok),
    checks
  }, checks.every(check => check.ok) ? 200 : 207);
}


const PLAN_V7_TTL = 10 * 60;
const APPROACH_PACK_V7_FALLBACK = {
  schemaVersion: "1.0",
  packId: "ateflight-custom-approaches",
  title: "AteFlight Custom Approach Pack",
  cycle: "UNSET",
  generatedAt: null,
  source: "Local AteFlight assets",
  procedures: []
};

function planV7Number(object, keys) {
  for (const key of keys) {
    const value = Number(object && object[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function planV7Id(object) {
  const candidates = [
    object && object.icaoId,
    object && object.id,
    object && object.ident,
    object && object.fixId,
    object && object.navId,
    object && object.identifier,
    object && object.faaId,
    object && object.iataId
  ].filter(Boolean);
  return candidates.length ? String(candidates[0]).trim().toUpperCase() : "";
}

function planV7Point(object, kind, requestedId) {
  if (!object) return null;
  const lat = planV7Number(object, ["lat", "latitude", "latitudeDeg", "latitude_deg", "latDec", "decLat"]);
  const lon = planV7Number(object, ["lon", "longitude", "longitudeDeg", "longitude_deg", "lonDec", "decLon"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: planV7Id(object) || String(requestedId || "").toUpperCase(),
    requestedId: String(requestedId || "").toUpperCase(),
    kind,
    name: object.name || object.site || object.location || object.facilityName || object.arptName || null,
    type: object.type || object.navType || object.facilityType || kind,
    lat,
    lon,
    raw: object
  };
}

async function planV7FetchJson(endpoint, params, timeoutMs = 9000) {
  const query = new URLSearchParams(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://aviationweather.gov/api/data/${endpoint}?${query.toString()}`, {
      headers: { "accept": "application/json", "user-agent": "AteFlight/7.1 flight-planning" },
      signal: controller.signal
    });
    if (response.status === 204) return [];
    if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) return [];
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } finally { clearTimeout(timer); }
}

function planV7NormalizeId(value) { return String(value || "").trim().toUpperCase(); }
function planV7AirportAliases(value) {
  const id = planV7NormalizeId(value), aliases = new Set([id]);
  if (/^K[A-Z0-9]{3}$/.test(id)) aliases.add(id.slice(1));
  if (/^[A-Z0-9]{3}$/.test(id)) aliases.add(`K${id}`);
  return [...aliases];
}
function planV7FindPoint(records, requestedId, kind) {
  const aliases = new Set(planV7AirportAliases(requestedId));
  for (const record of records || []) {
    const ids = [record&&record.icaoId,record&&record.id,record&&record.ident,record&&record.fixId,record&&record.navId,record&&record.identifier,record&&record.faaId,record&&record.iataId].filter(Boolean).map(planV7NormalizeId);
    if (ids.some(id => aliases.has(id))) {
      const point = planV7Point(record, kind, requestedId); if (point) return point;
    }
  }
  return null;
}
function planV7Tokenize(routeText) {
  return String(routeText || "").toUpperCase().replace(/\.\./g," DCT ").replace(/[,;]/g," ").split(/\s+/).map(t=>t.trim()).filter(Boolean).slice(0,30);
}
function planV7IsAirway(token) { return /^(?:V|J|Q|T|N|A|B|G|R|L|M|W)\d{1,4}$/i.test(token); }
function planV7IsProcedure(token) { return /^[A-Z]{2,6}\d[A-Z0-9]*$/i.test(token) && !planV7IsAirway(token); }
function planV7Bearing(lat1,lon1,lat2,lon2) {
  const r=d=>d*Math.PI/180,D=x=>x*180/Math.PI,p1=r(lat1),p2=r(lat2),dl=r(lon2-lon1);
  const y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return (D(Math.atan2(y,x))+360)%360;
}
function planV7WeatherSummary(record) {
  if (!record) return null;
  const clouds=Array.isArray(record.clouds)?record.clouds:[];
  const ceilings=clouds.filter(l=>["BKN","OVC","VV"].includes(String(l.cover||"").toUpperCase())).map(l=>Number(l.base)).filter(Number.isFinite);
  return {
    id:record.icaoId||record.id||null,category:record.fltCat||null,
    windDirection:Number.isFinite(Number(record.wdir))?Number(record.wdir):null,
    windSpeedKt:Number.isFinite(Number(record.wspd))?Number(record.wspd):null,
    windGustKt:Number.isFinite(Number(record.wgst))?Number(record.wgst):null,
    visibilitySm:Number.isFinite(Number(record.visib))?Number(record.visib):null,
    ceilingFt:ceilings.length?Math.min(...ceilings):null,
    altimeterInHg:Number.isFinite(Number(record.altim))?Number(record.altim):null,
    observationTime:record.obsTime||record.reportTime||null,raw:record.rawOb||record.rawText||null
  };
}
function planV7AltitudeCandidates({rules,course,serviceCeiling,preferredAltitude,distanceNm,cruiseTas,fuelBurn}) {
  const rule=String(rules||"IFR").toUpperCase()==="VFR"?"VFR":"IFR",east=course>=0&&course<180;
  const ceiling=Math.max(6000,Math.min(60000,Number(serviceCeiling)||14000));
  const preferred=Math.max(3000,Math.min(ceiling-500,Number(preferredAltitude)||7500));
  const tas=Math.max(60,Number(cruiseTas)||115),burn=Math.max(0,Number(fuelBurn)||9),out=[];
  const top=rule==="VFR"?Math.min(17500,ceiling-500):ceiling-1000;
  for(let alt=2000;alt<=top;alt+=500){
    const thousands=Math.floor(alt/1000),rem=alt%1000;
    if(rule==="VFR"?rem!==500:rem!==0)continue;
    if((east?thousands%2===1:thousands%2===0)===false||alt<3000)continue;
    const ete=Number.isFinite(distanceNm)&&distanceNm>0?distanceNm/tas:null;
    out.push({altitudeFt:alt,rule,courseBand:east?"000–179":"180–359",serviceCeilingMarginFt:ceiling-alt,
      estimatedTimeMinutes:ete==null?null:Math.round(ete*60),estimatedFuel:ete==null?null:Math.round(ete*burn*10)/10,
      score:Math.abs(alt-preferred)+Math.max(0,2500-(ceiling-alt))*3,status:"UNKNOWN",
      limitation:"Terrain, MEA/MOCA, airspace, icing, turbulence, and ATC assignment are not yet evaluated."});
  }
  out.sort((a,b)=>a.score-b.score); return out.slice(0,5);
}

async function flightPlanV7(request,ctx) {
  if(request.method!=="POST")return json({error:"POST required"},405);
  let body; try{body=await request.json()}catch{return json({error:"Invalid JSON body"},400)}
  const originId=planV7NormalizeId(body.origin),destinationId=planV7NormalizeId(body.destination),routeTokens=planV7Tokenize(body.route);
  const rules=String(body.rules||"IFR").toUpperCase()==="VFR"?"VFR":"IFR",profile=body.aircraft||{};
  if(!originId||!destinationId)return json({error:"Origin and destination are required"},400);
  const cache=caches.default,cacheParts=[originId,destinationId,routeTokens.join("-"),rules,profile.type||"",profile.cruiseTas||"",profile.fuelBurn||"",profile.serviceCeiling||"",body.preferredAltitude||profile.preferredAltitude||"",body.magneticCourse||""];
  const cacheKey=new Request(`${new URL(request.url).origin}/__flight_plan/v70/${encodeURIComponent(cacheParts.join("|")).slice(0,800)}`);
  const cached=await cache.match(cacheKey); if(cached){const payload=await cached.json();payload.cached=true;return json(payload)}
  const errors=[];
  const navTokens=[...new Set(routeTokens.filter(t=>t!=="DCT"&&t!=="DIRECT"&&!planV7IsAirway(t)&&!planV7IsProcedure(t)))];
  const airportIds=[...new Set([...planV7AirportAliases(originId),...planV7AirportAliases(destinationId),...navTokens])].join(","),navIds=navTokens.join(",");
  const reqs=await Promise.allSettled([
    planV7FetchJson("airport",{ids:airportIds,format:"json"}),
    navIds?planV7FetchJson("navaid",{ids:navIds,format:"json"}):Promise.resolve([]),
    navIds?planV7FetchJson("fix",{ids:navIds,format:"json"}):Promise.resolve([]),
    planV7FetchJson("metar",{ids:`${originId},${destinationId}`,format:"json",hours:"3"}),
    planV7FetchJson("taf",{ids:`${originId},${destinationId}`,format:"json"})
  ]);
  const airports=reqs[0].status==="fulfilled"?reqs[0].value:[],navaids=reqs[1].status==="fulfilled"?reqs[1].value:[],fixes=reqs[2].status==="fulfilled"?reqs[2].value:[],metars=reqs[3].status==="fulfilled"?reqs[3].value:[],tafs=reqs[4].status==="fulfilled"?reqs[4].value:[];
  reqs.forEach((r,i)=>{if(r.status==="rejected")errors.push(["airport","navaid","fix","metar","taf"][i]+": "+String(r.reason&&r.reason.message||r.reason))});
  const origin=planV7FindPoint(airports,originId,"airport"),destination=planV7FindPoint(airports,destinationId,"airport");
  const tokenResults=[],ambiguities=[];
  for(const token of routeTokens){
    if(token==="DCT"||token==="DIRECT"){tokenResults.push({token,kind:"connector",connector:"DCT",status:"ACTIVE"});continue}
    if(planV7IsAirway(token)){tokenResults.push({token,kind:"airway",status:"UNKNOWN",reason:"Airway geometry has not yet been expanded from current FAA CIFP/NASR data."});continue}
    if(planV7IsProcedure(token)){tokenResults.push({token,kind:"procedure",status:"UNKNOWN",reason:"Procedure geometry is not inferred from the name. Authoritative CIFP integration is required."});continue}
    const fix=planV7FindPoint(fixes,token,"fix"),nav=planV7FindPoint(navaids,token,"navaid"),apt=planV7FindPoint(airports,token,"airport"),matches=[fix,nav,apt].filter(Boolean);
    let chosen=null;if(token.length===5&&fix)chosen=fix;else if(token.length===3&&nav)chosen=nav;else if(/^K[A-Z0-9]{3}$/.test(token)&&apt)chosen=apt;else chosen=matches[0]||null;
    if(matches.length>1)ambiguities.push({token,options:matches.map(x=>({id:x.id,kind:x.kind,lat:x.lat,lon:x.lon}))});
    tokenResults.push(chosen?{token,kind:chosen.kind,status:matches.length>1?"UNKNOWN":"CONTEXT",point:chosen,ambiguous:matches.length>1}:{token,kind:"unresolved",status:"UNKNOWN",reason:"Identifier was not resolved by AviationWeather.gov airport, navaid, or fix data."});
  }
  const sequence=[]; if(origin)sequence.push({token:originId,point:origin,role:"origin"}); let connector="DCT";
  for(const result of tokenResults){
    if(result.kind==="connector"){connector="DCT";continue}
    if(["airway","procedure","unresolved"].includes(result.kind)){connector=result.token;continue}
    if(result.point){sequence.push({token:result.token,point:result.point,connector});connector="DCT"}
  }
  if(destination)sequence.push({token:destinationId,point:destination,role:"destination",connector});
  const segments=[],gaps=[];let knownDistanceNm=0;
  for(let i=1;i<sequence.length;i++){
    const prev=sequence[i-1],cur=sequence[i],via=cur.connector||"DCT",dist=distanceNm(prev.point.lat,prev.point.lon,cur.point.lat,cur.point.lon);
    if(via==="DCT"){knownDistanceNm+=dist;segments.push({from:prev.token,to:cur.token,distanceNm:Math.round(dist*10)/10,coordinates:[[prev.point.lon,prev.point.lat],[cur.point.lon,cur.point.lat]],authoritative:true,basis:"Resolved direct leg"})}
    else gaps.push({from:prev.token,to:cur.token,via,status:"UNKNOWN",reason:"Connector geometry was not expanded; AteFlight does not invent airway or procedure paths."});
  }
  const directDistanceNm=origin&&destination?distanceNm(origin.lat,origin.lon,destination.lat,destination.lon):null,trueCourse=origin&&destination?planV7Bearing(origin.lat,origin.lon,destination.lat,destination.lon):null;
  const hasMag=Number.isFinite(Number(body.magneticCourse)),courseUsed=hasMag?Number(body.magneticCourse):trueCourse,courseBasis=hasMag?"PILOT-SUPPLIED MAGNETIC COURSE":"TRUE COURSE PROXY — MAGNETIC VARIATION NOT APPLIED";
  const candidates=Number.isFinite(courseUsed)?planV7AltitudeCandidates({rules,course:courseUsed,serviceCeiling:profile.serviceCeiling,preferredAltitude:body.preferredAltitude||profile.preferredAltitude,distanceNm:knownDistanceNm||directDistanceNm,cruiseTas:profile.cruiseTas,fuelBurn:profile.fuelBurn}):[];
  const metarById=new Map(metars.map(x=>[planV7NormalizeId(x.icaoId||x.id),x])),tafById=new Map(tafs.map(x=>[planV7NormalizeId(x.icaoId||x.id),x]));
  const originWeather=planV7WeatherSummary(metarById.get(originId)||metarById.get(origin&&origin.id)),destinationWeather=planV7WeatherSummary(metarById.get(destinationId)||metarById.get(destination&&destination.id));
  const active=[],context=[],unknown=[];
  if(origin&&destination)active.push({id:"mission",title:`${origin.id||originId} → ${destination.id||destinationId}`,consequence:`${Math.round((knownDistanceNm||directDistanceNm||0)*10)/10} NM of resolved geometry`,why:["Origin and destination resolved from AviationWeather.gov navigational data."]});
  else unknown.push({id:"mission",title:"Route endpoints unresolved",consequence:"AteFlight cannot create geographic guidance without authoritative coordinates.",why:["One or both airport identifiers were not returned by the resolver."]});
  if(destinationWeather){const cat=String(destinationWeather.category||"UNKNOWN").toUpperCase(),bucket=["IFR","LIFR"].includes(cat)?active:context;bucket.push({id:"destination-weather",title:`${destination&&destination.id||destinationId} weather · ${cat}`,consequence:[destinationWeather.ceilingFt!=null?`Ceiling ${destinationWeather.ceilingFt.toLocaleString()} ft`:null,destinationWeather.visibilitySm!=null?`Visibility ${destinationWeather.visibilitySm} SM`:null].filter(Boolean).join(" · ")||"Current METAR available",why:["Current destination METAR from AviationWeather.gov.",destinationWeather.raw].filter(Boolean)})}
  else unknown.push({id:"destination-weather",title:"Destination weather unknown",consequence:"No current METAR was returned.",why:["Weather must be treated as unknown, not suppressed."]});
  if(candidates.length)context.push({id:"altitude",title:`${candidates[0].altitudeFt.toLocaleString()} ft preliminary candidate`,consequence:`${rules} directional parity using ${courseBasis.toLowerCase()}`,why:[`Course used: ${Math.round(courseUsed)}°`,`Aircraft service ceiling: ${Number(profile.serviceCeiling||14000).toLocaleString()} ft`,`Terrain, airway MEA/MOCA, icing, turbulence, and ATC assignment remain unevaluated.`]});
  if(gaps.length)unknown.push({id:"route-geometry",title:`${gaps.length} route geometry gap${gaps.length===1?"":"s"}`,consequence:"AteFlight will not display fabricated airway or procedure geometry.",why:gaps.map(g=>`${g.via}: ${g.reason}`)});
  if(ambiguities.length)unknown.push({id:"ambiguity",title:`${ambiguities.length} ambiguous identifier${ambiguities.length===1?"":"s"}`,consequence:"Confirm the intended facility before activation.",why:ambiguities.map(a=>`${a.token}: ${a.options.map(o=>o.kind+" "+o.id).join(", ")}`)});
  unknown.push({id:"terrain-mea",title:rules==="IFR"?"Terrain and IFR minimum altitude evaluation incomplete":"Terrain and obstacle evaluation incomplete",consequence:"Altitude candidates are planning context, not an operational clearance or minimum-safe-altitude determination.",why:["Current route geometry is not yet expanded through FAA CIFP/NASR airway data.","MEA, MOCA, OROCA, obstacle, and terrain clearance have not been calculated."]});
  const payload={ok:!!(origin&&destination),version:"7.1",generatedAt:new Date().toISOString(),cached:false,input:{origin:originId,destination:destinationId,route:routeTokens,rules,magneticCourse:hasMag?Number(body.magneticCourse):null,preferredAltitude:Number(body.preferredAltitude||profile.preferredAltitude)||null,aircraft:profile},origin,destination,tokenResults,route:{segments,gaps,points:sequence.map(x=>({token:x.token,role:x.role||"route",kind:x.point.kind,name:x.point.name,lat:x.point.lat,lon:x.point.lon})),knownDistanceNm:Math.round(knownDistanceNm*10)/10,directDistanceNm:directDistanceNm==null?null:Math.round(directDistanceNm*10)/10,trueCourse:trueCourse==null?null:Math.round(trueCourse),courseUsed:courseUsed==null?null:Math.round(courseUsed),courseBasis,completeness:sequence.length>1?Math.round(segments.length/(segments.length+gaps.length||1)*100):0},altitudeCandidates:candidates,weather:{origin:originWeather,destination:destinationWeather,tafOrigin:tafById.get(originId)||null,tafDestination:tafById.get(destinationId)||null},decisions:{active,context,unknown,suppressed:[]},sources:[{name:"AviationWeather.gov Navigational Data API",role:"Airport, navaid, fix, METAR, and TAF resolution",freshness:"Live service response",authoritative:true},{name:"Aircraft profile",role:"Cruise performance and service-ceiling constraints",freshness:"Pilot-maintained local profile",authoritative:false},{name:rules==="VFR"?"14 CFR 91.159":"14 CFR 91.179",role:"Directional cruising-altitude parity",freshness:"Rule reference",authoritative:true}],errors};
  const response=new Response(JSON.stringify(payload),{headers:{"content-type":"application/json","cache-control":`public, max-age=${PLAN_V7_TTL}`}});ctx.waitUntil(cache.put(cacheKey,response.clone()));return json(payload);
}

async function customApproachPackV7(request,env){
  try{const assetUrl=new URL("/custom-approaches/manifest.json",request.url),response=await env.ASSETS.fetch(new Request(assetUrl,{headers:{accept:"application/json"}}));if(!response.ok)throw new Error(`Asset HTTP ${response.status}`);const manifest=JSON.parse(await response.text());return json({...APPROACH_PACK_V7_FALLBACK,...manifest,procedures:Array.isArray(manifest.procedures)?manifest.procedures:[]})}
  catch(error){return json({...APPROACH_PACK_V7_FALLBACK,warning:error instanceof Error?error.message:String(error)})}
}

const PAGE = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"theme-color\" content=\"#071019\">\n<title>AteFlight \u2014 Flight Story</title>\n<link rel=\"stylesheet\" href=\"https://unpkg.com/maplibre-gl@6.1.0/dist/maplibre-gl.css\">\n<style>\n:root{\n  color-scheme:dark;\n  --bg:#070b10;\n  --chrome:#0b1118;\n  --surface:#0e151d;\n  --surface-2:#121c26;\n  --surface-3:#17232e;\n  --border:#263541;\n  --border-strong:#344a5a;\n  --text:#f4f7f9;\n  --muted:#8da0ae;\n  --subtle:#657784;\n  --accent:#58c7e8;\n  --accent-soft:#123848;\n  --good:#52d18c;\n  --warning:#f0c35a;\n  --danger:#ef6973;\n  --selected:#ffc857;\n  --vfr:#3ed083;\n  --mvfr:#4b9dff;\n  --ifr:#ef5d63;\n  --lifr:#b66cff;\n  --radius:7px;\n  --shadow:0 18px 50px rgba(0,0,0,.38);\n}\n*{box-sizing:border-box}\nhtml,body{margin:0;width:100%;height:100%;overflow:hidden;overscroll-behavior:none;background:var(--bg);color:var(--text);\n  font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;\n  font-feature-settings:\"tnum\" 1,\"ss01\" 1}\nbutton,input,select{font:inherit}\nbutton{color:inherit}\nbutton:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n.app{height:100vh;height:100svh;height:100dvh;display:grid;grid-template-rows:46px minmax(0,1fr);overflow:hidden}\n.topbar{\n  min-width:0;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:14px;\n  padding:0 10px;border-bottom:1px solid var(--border);background:var(--chrome);z-index:50\n}\n.brand{display:flex;align-items:center;gap:9px;min-width:0}\n.brand-mark{width:27px;height:27px;border:1px solid var(--border-strong);border-radius:6px;display:grid;place-items:center;\n  color:var(--accent);font-size:8px;font-weight:950;letter-spacing:.08em;background:#0c1720}\n.brand-copy strong{display:block;font-size:13px;letter-spacing:.045em;font-weight:900}\n.brand-copy span{display:block;font-size:8.5px;letter-spacing:.11em;color:var(--subtle);font-weight:800;margin-top:2px;line-height:1.25}\n.ops-strip{justify-self:center;display:flex;align-items:center;gap:11px;min-width:0}\n.ops-item{display:flex;align-items:baseline;gap:5px;color:var(--muted);font-size:8.5px;white-space:nowrap}\n.ops-item strong{font-size:10.5px;color:var(--text);font-weight:900}\n.status-dot{width:7px;height:7px;border-radius:50%;background:var(--warning);box-shadow:0 0 0 3px rgba(240,195,90,.08)}\n.status-dot.good{background:var(--good);box-shadow:0 0 0 3px rgba(82,209,140,.08)}\n.status-dot.bad{background:var(--danger);box-shadow:0 0 0 3px rgba(239,105,115,.08)}\n.actions{display:flex;align-items:center;gap:5px}\n.btn{\n  height:31px;border:1px solid var(--border);border-radius:6px;background:var(--surface);\n  color:#c4d0d7;padding:0 10px;font-size:9.5px;font-weight:850;letter-spacing:.025em;cursor:pointer\n}\n.btn:hover{background:var(--surface-2);border-color:var(--border-strong)}\n.btn.active{background:var(--accent-soft);border-color:#2e7891;color:#d8f6ff}\n.btn.icon{width:29px;padding:0;display:grid;place-items:center}\n.btn svg,.rail-btn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}\n.workspace{position:relative;min-width:0;min-height:0;overflow:hidden}\n#map{position:absolute;inset:0}\n.maplibregl-map{font:inherit}\n.maplibregl-canvas{outline:none}\n.maplibregl-ctrl-bottom-left,.maplibregl-ctrl-bottom-right{display:none}\n.rail{\n  position:absolute;z-index:25;left:8px;top:8px;width:42px;display:flex;flex-direction:column;gap:5px\n}\n.rail-btn{\n  width:42px;height:42px;border:1px solid rgba(50,72,86,.9);border-radius:7px;background:rgba(9,17,24,.94);\n  color:#9aadb9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;\n  box-shadow:0 7px 18px rgba(0,0,0,.17)\n}\n.rail-btn span{font-size:6px;font-weight:900;letter-spacing:.07em}\n.rail-btn:hover{color:#d3e1e8;border-color:#476273}\n.rail-btn.active{background:#103044;border-color:#377c96;color:#d9f6ff}\n.side-panel{\n  position:absolute;z-index:30;left:56px;top:8px;bottom:48px;width:min(368px,calc(100vw - 76px));\n  background:rgba(10,17,24,.97);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);\n  display:none;grid-template-rows:auto auto minmax(0,1fr);overflow:hidden\n}\n.side-panel.open{display:grid}\n.panel-head{height:43px;padding:0 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}\n.panel-title strong{display:block;font-size:12px;letter-spacing:.065em}\n.panel-title span{display:block;font-size:8.5px;color:var(--muted);margin-top:3px;line-height:1.3}\n.panel-tabs{height:34px;display:grid;grid-template-columns:repeat(5,1fr);border-bottom:1px solid var(--border);background:#0b141c}\n.panel-tab{\n  border:0;border-right:1px solid var(--border);background:transparent;color:var(--muted);\n  font-size:9px;font-weight:900;letter-spacing:.07em;cursor:pointer\n}\n.panel-tab:last-child{border-right:0}\n.panel-tab.active{color:var(--text);box-shadow:inset 0 -2px 0 var(--accent);background:#0e1b25}\n.panel-scroll{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:10px}\n.panel-section{margin-bottom:14px}\n.section-label{font-size:9px;color:#778f9f;font-weight:900;letter-spacing:.115em;margin-bottom:8px}\n.choice-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}\n.choice{\n  min-height:44px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:#b7c4cc;\n  padding:7px;text-align:left;cursor:pointer\n}\n.choice strong,.choice span{display:block}.choice strong{font-size:10.5px}.choice span{font-size:8.5px;color:var(--muted);margin-top:3px;line-height:1.25}\n.choice.active{border-color:#3d839b;background:#102b39;color:#e2f8ff}\n.row{\n  min-height:41px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;align-items:center;\n  border-bottom:1px solid rgba(38,53,65,.55)\n}\n.row:last-child{border-bottom:0}\n.row-copy strong,.row-copy span{display:block}.row-copy strong{font-size:10px}.row-copy span{font-size:8.25px;color:var(--muted);margin-top:3px;line-height:1.35}\n.switch{position:relative;width:32px;height:18px}\n.switch input{position:absolute;opacity:0;pointer-events:none}\n.switch-track{position:absolute;inset:0;border-radius:20px;background:#172630;border:1px solid #35505f;transition:.12s}\n.switch-track:after{content:\"\";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#8ea0aa;transition:.12s}\n.switch input:checked+.switch-track{background:#0e526a;border-color:#3986a0}\n.switch input:checked+.switch-track:after{transform:translateX(14px);background:#e0f8ff}\n.small-select{height:31px;min-width:98px;border:1px solid var(--border);border-radius:5px;background:#0b151d;color:var(--text);font-size:9px;padding:0 8px}\n.range-input{width:93px;accent-color:var(--accent)}\n.info-panel{\n  position:absolute;z-index:31;right:8px;top:8px;bottom:48px;width:min(392px,42%);\n  background:rgba(8,15,21,.98);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);\n  display:none;grid-template-rows:auto minmax(0,1fr);overflow:hidden\n}\n.info-panel.open{display:grid}\n.info-head{padding:11px 11px 9px;border-bottom:1px solid var(--border)}\n.info-kicker{font-size:8px;letter-spacing:.13em;color:var(--subtle);font-weight:900}\n.info-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}\n.info-title{font-size:22px;font-weight:900;letter-spacing:-.02em;margin-top:2px}\n.info-sub{font-size:10px;color:var(--muted);margin-top:3px;line-height:1.35}\n.info-scroll{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:10px}\n.route-card{\n  border:1px solid var(--border);border-radius:7px;background:#0c151d;padding:9px;margin-bottom:9px\n}\n.route-line{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center}\n.airport{text-align:left}.airport:last-child{text-align:right}\n.airport strong{display:block;font-size:15px}.airport span{display:block;font-size:6.5px;color:var(--muted);margin-top:2px}\n.route-arrow{color:var(--accent);font-size:14px}\n.route-note{margin-top:8px;font-size:8.5px;color:var(--subtle);line-height:1.4}\n.metrics{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-top:2px}\n.metric{border:0;border-bottom:1px solid rgba(38,53,65,.62);background:transparent;padding:10px 6px}\n.metric:nth-last-child(-n+2){border-bottom:0}\n.metric:nth-child(odd){border-right:1px solid rgba(38,53,65,.62)}\n.metric span,.metric strong{display:block}.metric span{font-size:8px;color:var(--muted);letter-spacing:.045em}.metric strong{font-size:12.5px;margin-top:3px}\n.info-section{margin-top:13px}.info-section h4{font-size:8.5px;color:#7f96a5;letter-spacing:.11em;margin:0 0 7px}\n.info-actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}\n.info-action{\n  height:32px;border:1px solid var(--border);border-radius:5px;background:#0d1a24;color:#b9c9d2;\n  padding:0 10px;font-size:9px;font-weight:900;cursor:pointer;transition:background .12s,border-color .12s,color .12s\n}\n.info-action:hover{border-color:var(--border-strong);color:var(--text)}\n.info-action.active,.info-action.primary.active{\n  border-color:#3b8da8;background:#123b4e;color:#e4f9ff;box-shadow:inset 0 -2px 0 #58c7e8\n}\n.info-action:disabled{opacity:.42;cursor:default}\n\n.airport-badge{display:inline-flex;align-items:center;height:20px;border:1px solid var(--border);border-radius:4px;padding:0 6px;font-size:8px;font-weight:900;color:#aebdc6;background:#0c171f}\n.airport-badge.scheduled{border-color:#2d7189;color:#cceef8;background:#0d2b3a}\n.movement-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:10px 0}\n.movement-summary div{border-top:1px solid var(--border);padding:7px 2px 2px}\n.movement-summary strong,.movement-summary span{display:block}\n.movement-summary strong{font-size:14px}.movement-summary span{font-size:7.5px;color:var(--muted);margin-top:2px}\n.movement-board{border-top:1px solid var(--border)}\n.movement-row{width:100%;min-height:43px;border:0;border-bottom:1px solid rgba(38,53,65,.62);background:transparent;color:var(--text);display:grid;grid-template-columns:64px 1fr auto;gap:8px;align-items:center;text-align:left;padding:6px 2px;cursor:pointer}\n.movement-row:hover{background:#0d1a23}\n.movement-status{font-size:7.5px;font-weight:900;letter-spacing:.05em}\n.movement-status.GROUND{color:#59d49a}.movement-status.ARRIVING{color:#64c8ee}.movement-status.DEPARTING{color:#f0c35a}.movement-status.NEARBY{color:#8da0ae}\n.movement-main strong,.movement-main span{display:block}.movement-main strong{font-size:10px}.movement-main span{font-size:8px;color:var(--muted);margin-top:2px}\n.movement-side{text-align:right}.movement-side strong,.movement-side span{display:block}.movement-side strong{font-size:9px}.movement-side span{font-size:7px;color:var(--muted);margin-top:2px}\n\n.loading-line{height:3px;background:#0d1b24;overflow:hidden;margin-top:8px;border-radius:2px}\n.loading-line i{display:block;width:35%;height:100%;background:var(--accent);animation:load 1.1s ease-in-out infinite}\n@keyframes load{0%{transform:translateX(-120%)}100%{transform:translateX(340%)}}\n.bottom-bar{\n  position:absolute;z-index:24;left:56px;right:8px;bottom:8px;height:34px;border:1px solid rgba(52,74,88,.86);\n  border-radius:7px;background:rgba(8,15,21,.93);display:flex;align-items:center;gap:7px;padding:3px 6px;\n  backdrop-filter:blur(8px);box-shadow:0 8px 18px rgba(0,0,0,.14)\n}\n.segment{display:flex;gap:2px}\n.segment button{\n  height:26px;min-width:34px;border:0;border-radius:5px;background:transparent;color:#8699a6;font-size:7px;font-weight:900;cursor:pointer\n}\n.segment button.active{background:#143246;color:#dff8ff}\n.bar-sep{width:1px;height:16px;background:var(--border)}\n.bar-stat{display:flex;align-items:baseline;gap:3px;font-size:6.5px;color:var(--muted);white-space:nowrap}\n.bar-stat strong{font-size:8px;color:var(--text)}\n.bar-spacer{flex:1}\n.map-btn{\n  width:30px;height:26px;border:1px solid var(--border);border-radius:5px;background:#0c171f;color:#a7b6bf;\n  display:grid;place-items:center;cursor:pointer;font-size:10px\n}\n.map-btn:hover{border-color:var(--border-strong);color:var(--text)}\n.toast{\n  position:absolute;z-index:60;left:50%;top:10px;transform:translateX(-50%);max-width:min(680px,calc(100% - 90px));\n  border:1px solid #705f28;border-radius:6px;background:rgba(53,43,16,.96);color:#f3dda0;padding:7px 10px;\n  font-size:7.5px;box-shadow:var(--shadow);display:none\n}\n.toast.bad{border-color:#70313a;background:rgba(54,20,25,.97);color:#ffd8dc}\n.command{\n  width:min(620px,calc(100% - 24px));max-height:min(620px,calc(100vh - 48px));padding:0;\n  border:1px solid var(--border-strong);border-radius:9px;background:#0a1118;color:var(--text);box-shadow:0 28px 80px rgba(0,0,0,.55)\n}\n.command::backdrop{background:rgba(2,6,9,.68);backdrop-filter:blur(2px)}\n.command-head{height:45px;display:flex;align-items:center;border-bottom:1px solid var(--border);padding:0 11px}\n.command-input{width:100%;border:0;background:transparent;color:var(--text);font-size:12px;outline:none}\n.command-list{max-height:520px;overflow:auto;padding:6px}\n.command-group{font-size:6.5px;color:var(--subtle);letter-spacing:.12em;font-weight:900;padding:7px 7px 4px}\n.command-item{\n  width:100%;min-height:38px;border:0;border-radius:6px;background:transparent;color:#c6d2d9;\n  display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 8px;text-align:left;cursor:pointer\n}\n.command-item:hover,.command-item.focused{background:#11212c}\n.command-item strong{display:block;font-size:8px}.command-item span{display:block;font-size:6.5px;color:var(--muted);margin-top:2px}\n.command-key{font-size:6px;color:#778b98;border:1px solid var(--border);border-radius:4px;padding:2px 5px}\n.maplibregl-ctrl.maplibregl-ctrl-group{\n  background:rgba(8,15,21,.94);border:1px solid var(--border);box-shadow:none;border-radius:6px;overflow:hidden\n}\n.maplibregl-ctrl-group button{width:29px;height:29px}\n.maplibregl-ctrl-group button+button{border-top:1px solid var(--border)}\n.maplibregl-ctrl-icon{filter:invert(.8)}\n.maplibregl-popup-content{background:#0a131b;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;box-shadow:var(--shadow)}\n.maplibregl-popup-tip{border-top-color:#0a131b!important}\n.clean .topbar,.clean .rail,.clean .bottom-bar,.clean .side-panel{display:none!important}\n.clean .app{grid-template-rows:minmax(0,1fr)}\n.clean .info-panel{top:8px;bottom:8px}\n.clean .clean-return{display:block}\n.clean-return{display:none;position:absolute;left:8px;top:8px;z-index:70}\n@media(max-width:900px){\n  .brand-copy span{display:none}.ops-strip{display:none}\n  .side-panel{width:310px}\n  .info-panel{width:min(345px,45%)}\n}\n@media(max-width:720px){\n  .app{grid-template-rows:42px minmax(0,1fr)}\n  .topbar{padding:0 6px;gap:6px}.brand-mark{display:none}.brand-copy strong{font-size:10px}\n  .actions .btn:not(.icon){padding:0 6px}\n  .side-panel{left:6px;right:6px;top:auto;bottom:48px;width:auto;height:min(68%,520px)}\n  .info-panel{left:6px;right:6px;top:auto;bottom:48px;width:auto;height:min(56%,450px)}\n  .bottom-bar{left:6px}.rail{left:6px;top:7px}.rail-btn{width:37px;height:37px}\n  .rail-btn span{display:none}\n  .bar-stat.optional{display:none}\n}\n\n/* V5.1 readability / product typography pass */\n.brand-copy strong{font-size:14px}\n.brand-copy span{font-size:9.5px;line-height:1.3}\n.ops-item{font-size:9.5px}\n.ops-item strong{font-size:11.5px}\n.btn{font-size:10.5px;height:32px}\n.rail-btn span{font-size:7.5px}\n.panel-title strong{font-size:13px}\n.panel-title span{font-size:10px;line-height:1.35}\n.panel-tab{font-size:10.5px}\n.panel-scroll{font-size:11px;padding:12px}\n.section-label{font-size:10px;margin-bottom:9px}\n.choice{min-height:52px;padding:9px}\n.choice strong{font-size:11.5px}\n.choice span{font-size:9.5px;line-height:1.35;margin-top:4px}\n.row{min-height:50px}\n.row-copy strong{font-size:11.5px}\n.row-copy span{font-size:9.5px;line-height:1.4;margin-top:3px}\n.small-select{font-size:10.5px;height:32px;min-width:104px}\n.info-kicker{font-size:9.5px}\n.info-title{font-size:26px}\n.info-sub{font-size:11px;line-height:1.4}\n.info-scroll{padding:12px}\n.airport strong{font-size:17px}\n.airport span{font-size:9px;line-height:1.25}\n.route-note{font-size:9.5px;line-height:1.45}\n.metric{padding:11px 8px}\n.metric span{font-size:9px}\n.metric strong{font-size:14px;margin-top:4px}\n.info-section h4{font-size:9.5px;margin-bottom:8px}\n.info-action{height:34px;font-size:10px;padding:0 11px}\n.airport-badge{font-size:9px;height:23px}\n.movement-summary strong{font-size:16px}\n.movement-summary span{font-size:8.5px}\n.movement-row{min-height:49px}\n.movement-status{font-size:8.75px}\n.movement-main strong{font-size:11.5px}\n.movement-main span{font-size:9.5px;line-height:1.3}\n.movement-side strong{font-size:10.5px}\n.movement-side span{font-size:9px}\n.bar-stat{font-size:8px}\n.bar-stat strong{font-size:10px}\n.segment button{font-size:9px}\n.command-input{font-size:13px}\n.command-group{font-size:8.5px}\n.command-item strong{font-size:11px}\n.command-item span{font-size:9.5px;line-height:1.3}\n.command-key{font-size:7.5px}\n.maplibregl-popup-content{font-size:11px;line-height:1.4}\n\n\n.sheet-handle{display:none;height:18px;align-items:center;justify-content:center;touch-action:none;cursor:ns-resize}\n.sheet-handle i{display:block;width:38px;height:4px;border-radius:4px;background:#526673}\n.mobile-peek{display:none;padding:0 12px 10px;border-bottom:1px solid var(--border)}\n.sheet-actions{display:none}\n.airport-runway{padding:10px 0;border-bottom:1px solid rgba(38,53,65,.62)}\n.airport-runway:last-child{border-bottom:0}\n.airport-runway-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline}\n.airport-runway-head strong{font-size:12px}\n.airport-runway-head span{font-size:9px;color:var(--muted)}\n.airport-runway-meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:5px;font-size:9px;color:#afbec7}\n.airport-freq-row{display:grid;grid-template-columns:72px 1fr auto;gap:8px;padding:8px 0;border-bottom:1px solid rgba(38,53,65,.55);align-items:center}\n.airport-freq-row:last-child{border-bottom:0}\n.airport-freq-row strong{font-size:10px}\n.airport-freq-row span{font-size:9px;color:var(--muted)}\n.airport-freq-row em{font-style:normal;font-size:11px;font-weight:900;color:#dce8ed}\n.resource-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px}\n.resource-link{min-height:39px;border:1px solid var(--border);border-radius:6px;background:#0d1a24;color:#c7d5dc;text-decoration:none;display:flex;flex-direction:column;justify-content:center;padding:7px 8px}\n.resource-link strong{font-size:10px}.resource-link span{font-size:8px;color:var(--muted);margin-top:2px}\n.resource-link:hover{border-color:#3b7388;background:#102431}\n@media(max-width:720px){\n  .info-panel{\n    left:6px;right:6px;top:auto;bottom:46px;width:auto;\n    height:var(--sheet-height,168px);max-height:calc(100% - 54px);\n    transition:height .18s cubic-bezier(.2,.7,.2,1);border-radius:10px 10px 7px 7px\n  }\n  .info-panel.sheet-peek{--sheet-height:168px}\n  .info-panel.sheet-half{--sheet-height:43%}\n  .info-panel.sheet-full{--sheet-height:82%}\n  .sheet-handle{display:flex}\n  .sheet-actions{height:38px;display:flex;gap:5px;align-items:center;padding:4px 10px;border-top:1px solid var(--border);background:#0a1219}\n  .sheet-actions button{height:28px;flex:1;border:1px solid var(--border);border-radius:5px;background:#0d1821;color:#93a6b2;font-size:9px;font-weight:900}\n  .sheet-actions button.active{background:#123848;border-color:#3b829a;color:#e3f9ff}\n  .mobile-peek{display:block}\n  .info-panel.sheet-peek .info-scroll{display:none}\n  .info-panel.sheet-peek .info-head{padding-bottom:7px}\n  .info-panel.sheet-peek .info-title{font-size:21px}\n  .info-panel.sheet-peek .info-sub{font-size:10px}\n  .info-panel.sheet-half .mobile-peek,.info-panel.sheet-full .mobile-peek{display:none}\n  .info-panel.sheet-half .info-scroll,.info-panel.sheet-full .info-scroll{display:block}\n  .bottom-bar.sheet-open{display:none}\n}\n\n\n.procedure-list{border-top:1px solid var(--border)}\n.procedure-row{display:grid;grid-template-columns:58px minmax(0,1fr) auto;gap:8px;align-items:center;min-height:45px;border-bottom:1px solid rgba(38,53,65,.6);padding:6px 0}\n.procedure-type{font-size:8.5px;font-weight:900;color:#7fa0b2;letter-spacing:.06em}\n.procedure-copy strong,.procedure-copy span{display:block}.procedure-copy strong{font-size:10.5px}.procedure-copy span{font-size:8.5px;color:var(--muted);margin-top:2px}\n.procedure-view{height:29px;border:1px solid var(--border);border-radius:5px;background:#0e1a23;color:#c8d7de;text-decoration:none;display:flex;align-items:center;padding:0 8px;font-size:8.5px;font-weight:900}\n.procedure-view:hover{border-color:#3c7f96;background:#102d3b;color:#e0f8ff}\n.integration-state{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid rgba(38,53,65,.55)}\n.integration-state strong,.integration-state span{display:block}.integration-state strong{font-size:10px}.integration-state span{font-size:8.5px;color:var(--muted);margin-top:2px}\n.integration-state em{font-style:normal;font-size:8px;font-weight:900;color:#d0a950}\n\n/* V5.4 mobile interaction and runway intelligence */\n.info-panel{grid-template-rows:auto minmax(0,1fr);background:rgba(8,15,21,.985)}\n.info-head{position:relative;z-index:3;background:#081119;min-width:0}\n.info-title{line-height:1.04}\n.info-sub{line-height:1.35;white-space:normal}\n.info-scroll{position:relative;z-index:1;min-height:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;scrollbar-gutter:auto;background:#081119}\n.sheet-actions{background:#081119}\n.airport-tabs{position:sticky;top:-1px;z-index:4;display:flex;gap:3px;overflow-x:auto;scrollbar-width:none;padding:0 0 8px;background:#081119;border-bottom:1px solid var(--border);margin-bottom:10px}\n.airport-tabs::-webkit-scrollbar{display:none}\n.airport-tab{height:31px;flex:0 0 auto;border:1px solid transparent;border-radius:5px;background:transparent;color:#8094a1;padding:0 9px;font-size:9px;font-weight:900;letter-spacing:.035em;cursor:pointer}\n.airport-tab.active{background:#123545;border-color:#377d95;color:#e3f8ff}\n.runway-recommendation{border:1px solid #256b4c;background:#0b231a;border-radius:7px;padding:10px;margin-bottom:10px}\n.runway-recommendation.neutral{border-color:var(--border);background:#0c161e}\n.runway-rec-head{display:flex;align-items:center;justify-content:space-between;gap:10px}\n.runway-rec-title{display:flex;align-items:center;gap:8px;min-width:0}\n.runway-arrow-chip{width:31px;height:31px;border-radius:6px;display:grid;place-items:center;background:#123d29;color:#63df97;font-size:20px;font-weight:950;transform:rotate(var(--arrow-rotation,0deg))}\n.runway-rec-title strong,.runway-rec-title span{display:block}.runway-rec-title strong{font-size:13px;color:#dff9ea}.runway-rec-title span{font-size:9px;color:#91b9a2;margin-top:2px}\n.runway-rec-wind{text-align:right}.runway-rec-wind strong,.runway-rec-wind span{display:block}.runway-rec-wind strong{font-size:12px}.runway-rec-wind span{font-size:8px;color:#91a59a;margin-top:2px}\n.runway-components{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px;border-top:1px solid rgba(78,143,103,.3);padding-top:8px}\n.runway-components div span,.runway-components div strong{display:block}.runway-components div span{font-size:8px;color:#82a18d}.runway-components div strong{font-size:12px;margin-top:2px}\n.runway-caution{font-size:8.5px;line-height:1.4;color:#83a08d;margin-top:8px}\n.runway-card{padding:11px 0;border-bottom:1px solid rgba(38,53,65,.7)}\n.runway-card:last-child{border-bottom:0}\n.runway-card.preferred{background:linear-gradient(90deg,rgba(19,67,43,.36),rgba(19,67,43,0));padding-left:8px;border-left:2px solid #55d18a}\n.runway-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}\n.runway-card-head strong{font-size:13px}.runway-card-head span{font-size:10px;color:var(--muted)}\n.runway-direction-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}\n.runway-direction{border-left:2px solid #314451;padding-left:7px}\n.runway-direction.preferred{border-left-color:#55d18a}\n.runway-direction strong,.runway-direction span{display:block}.runway-direction strong{font-size:11px}.runway-direction span{font-size:8.5px;color:var(--muted);margin-top:2px}\n.runway-preferred-badge{display:inline-flex;align-items:center;height:20px;border-radius:4px;background:#123d29;color:#75e3a5;padding:0 6px;font-size:8px;font-weight:900}\n.airport-summary-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;margin-bottom:10px}\n.airport-summary-cell{border-top:1px solid var(--border);padding:8px 2px 2px}.airport-summary-cell span,.airport-summary-cell strong{display:block}.airport-summary-cell span{font-size:8.5px;color:var(--muted)}.airport-summary-cell strong{font-size:13px;margin-top:3px}\n.info-actions{align-items:stretch}\n@media(max-width:720px){\n  html,body,.app{height:var(--visual-height,100dvh);min-height:var(--visual-height,100dvh)}\n  .info-panel{\n    left:6px;right:6px;top:auto;bottom:max(6px,env(safe-area-inset-bottom));width:auto;\n    height:var(--sheet-height,210px);max-height:calc(var(--visual-height,100dvh) - 50px);\n    grid-template-rows:18px auto auto minmax(0,1fr) 42px;\n    background:#081119;backdrop-filter:none;border-radius:11px;overflow:hidden;contain:layout paint;\n    transition:height .2s cubic-bezier(.2,.72,.2,1),transform .2s ease\n  }\n  .info-panel.sheet-peek{--sheet-height:clamp(204px,25dvh,226px)}\n  .info-panel.sheet-half{--sheet-height:52dvh}\n  .info-panel.sheet-full{--sheet-height:calc(var(--visual-height,100dvh) - 54px)}\n  .sheet-handle{grid-row:1;display:flex;background:#081119}\n  .info-head{grid-row:2;padding:4px 13px 10px;background:#081119;border-bottom:1px solid var(--border)}\n  .mobile-peek{grid-row:3;display:block;padding:8px 13px 10px;background:#081119;border-bottom:1px solid var(--border)}\n  .info-scroll{grid-row:4;padding:12px 14px 18px;background:#081119;touch-action:pan-y}\n  .sheet-actions{grid-row:5;height:42px;display:flex;gap:5px;align-items:center;padding:5px 10px;border-top:1px solid var(--border);background:#081119}\n  .sheet-actions button{height:31px;font-size:9.5px}\n  .info-panel.sheet-peek .info-scroll{display:none!important}\n  .info-panel.sheet-half .mobile-peek,.info-panel.sheet-full .mobile-peek{display:none!important}\n  .info-panel.sheet-half .info-scroll,.info-panel.sheet-full .info-scroll{display:block!important}\n  .info-panel.sheet-peek .info-title{font-size:23px;line-height:1}\n  .info-panel.sheet-peek .info-sub{font-size:10px;margin-top:3px}\n  .info-panel.sheet-peek .info-kicker{font-size:8px}\n  .info-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}\n  .info-action{width:100%;height:35px}\n  .bottom-bar.sheet-open{display:none!important}\n  .airport-tabs{top:-12px;padding-top:2px}\n  .airport-tab{font-size:9.5px;height:33px}\n  .runway-rec-head{align-items:flex-start}.runway-rec-wind strong{font-size:11px}\n}\n\n\n.context-nav{display:none;border-bottom:1px solid var(--border);background:#081119;overflow-x:auto;scrollbar-width:none}\n.context-nav::-webkit-scrollbar{display:none}\n.context-nav.airport{display:flex;padding:5px 8px;gap:4px}\n.context-nav .airport-tab{font-size:10px;height:34px;padding:0 11px}\n@media(max-width:720px){\n  .info-panel{\n    grid-template-rows:18px auto auto auto minmax(0,1fr) 42px;\n  }\n  .context-nav.airport{position:relative;z-index:3;flex:0 0 auto;padding:5px 8px 6px}\n  .context-nav .airport-tab{font-size:10px;height:35px}\n  .info-panel.sheet-peek .context-nav{display:none}\n  .info-panel.sheet-peek{grid-template-rows:18px auto auto minmax(0,0) 0 42px}\n  .info-panel.sheet-half .context-nav.airport,.info-panel.sheet-full .context-nav.airport{display:flex}\n}\n\n\n.identifier-line{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}\n.identifier-chip{display:inline-flex;align-items:center;height:22px;padding:0 7px;border:1px solid var(--border);border-radius:4px;background:#0c171f;color:#aebdc6;font-size:8.5px;font-weight:900}\n.identifier-chip.primary{border-color:#3c839b;background:#102d3b;color:#dff8ff}\n.identifier-chip.navaid{border-color:#7c6b39;background:#261f0d;color:#eed58d}\n.navaid-row{display:grid;grid-template-columns:58px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(38,53,65,.58)}\n.navaid-row:last-child{border-bottom:0}\n.navaid-row strong{font-size:10px}.navaid-row span{font-size:8.5px;color:var(--muted)}\n.navaid-row em{font-style:normal;font-size:10px;font-weight:900;color:#d9e6ec}\n.data-source-note{font-size:8px;color:var(--subtle);line-height:1.4;padding:7px 0}\n.aircraft-class-chip{display:inline-flex;align-items:center;height:20px;border:1px solid var(--border);border-radius:4px;padding:0 6px;background:#0d1821;color:#aebdc6;font-size:8px;font-weight:900;margin-right:5px}\n\n\n/* V6.0 professional aviation chart modes */\n.map-mode-bar{position:absolute;z-index:23;left:50%;top:8px;transform:translateX(-50%);display:flex;gap:2px;padding:3px;border:1px solid rgba(48,70,84,.9);border-radius:8px;background:rgba(7,14,20,.94);box-shadow:0 10px 26px rgba(0,0,0,.24);backdrop-filter:blur(10px)}\n.map-mode-btn{height:31px;border:0;border-radius:5px;background:transparent;color:#91a4b0;padding:0 12px;font-size:9px;font-weight:900;letter-spacing:.045em;cursor:pointer;white-space:nowrap}\n.map-mode-btn:hover{color:#e1edf2;background:#101e28}.map-mode-btn.active{background:#173445;color:#ecfbff;box-shadow:inset 0 -2px 0 #58c7e8}\n.chart-badge{display:none;position:absolute;z-index:22;right:8px;top:48px;min-width:215px;border:1px solid rgba(47,69,83,.9);border-radius:7px;background:rgba(7,14,20,.92);padding:7px 9px;box-shadow:0 8px 22px rgba(0,0,0,.22);backdrop-filter:blur(8px)}\n.chart-badge.open{display:block}.chart-badge strong,.chart-badge span{display:block}.chart-badge strong{font-size:10px;letter-spacing:.055em}.chart-badge span{font-size:8px;color:#8ea2af;margin-top:3px;line-height:1.35}.chart-badge.overzoom{border-color:#8c7130}.chart-badge.overzoom strong{color:#f1ca66}.chart-native-btn{margin-top:6px;height:25px;border:1px solid #304a5a;border-radius:4px;background:#0e1a23;color:#b9cbd4;font-size:7.5px;font-weight:900;padding:0 7px;cursor:pointer}\n.aviation-legend{display:none;position:absolute;z-index:21;right:8px;bottom:48px;border:1px solid rgba(48,69,82,.75);border-radius:6px;background:rgba(7,14,20,.88);padding:6px 8px;color:#95a9b5;font-size:8px;line-height:1.5;backdrop-filter:blur(7px)}\n.aviation-legend.open{display:block}.aviation-legend b{color:#e0ebef}.aviation-legend i{display:inline-block;width:9px;height:9px;margin-right:4px;vertical-align:-1px}\n.layer-note{margin-top:8px;padding:8px;border:1px solid rgba(50,72,86,.65);border-radius:6px;background:#0b151d;color:#8fa3af;font-size:8.5px;line-height:1.45}.layer-note strong{color:#d5e2e8}\n.weather-legend-row{display:flex;gap:9px;flex-wrap:wrap;margin-top:7px;font-size:8px;color:#93a6b2}.weather-legend-row span{white-space:nowrap}\n.weather-legend-row i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}\n.navaid-popup strong{font-size:12px}.navaid-popup span{font-size:9px;color:#9cafba}\n@media(max-width:720px){\n .map-mode-bar{top:7px;left:51px;right:49px;transform:none;overflow-x:auto;justify-content:flex-start;scrollbar-width:none}.map-mode-bar::-webkit-scrollbar{display:none}.map-mode-btn{height:30px;padding:0 10px;font-size:8.5px}\n .chart-badge{top:45px;right:6px;min-width:188px;max-width:calc(100% - 62px)}\n .aviation-legend{display:none!important}\n}\n\n\n.traffic-cluster-label{font-weight:950;letter-spacing:.01em}\n.feed-health{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}\n.feed-health div{border-top:1px solid var(--border);padding:7px 2px 2px}\n.feed-health strong,.feed-health span{display:block}.feed-health strong{font-size:12px}.feed-health span{font-size:8px;color:var(--muted);margin-top:2px}\n.airport-data-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px}\n.airport-data-summary div{border:1px solid var(--border);border-radius:6px;background:#0c161e;padding:8px}\n.airport-data-summary strong,.airport-data-summary span{display:block}.airport-data-summary strong{font-size:14px}.airport-data-summary span{font-size:8px;color:var(--muted);margin-top:2px}\n.detail-mode-badge{position:absolute;left:58px;top:8px;z-index:22;height:25px;border:1px solid rgba(57,83,99,.72);border-radius:5px;background:rgba(8,15,21,.82);display:flex;align-items:center;padding:0 7px;color:#9eb0ba;font-size:8px;font-weight:900;letter-spacing:.05em;pointer-events:none}\n@media(max-width:720px){.detail-mode-badge{left:51px;top:7px;font-size:7.5px}}\n\n\n.traffic-canvas{\n  position:absolute;inset:0;z-index:12;width:100%;height:100%;\n  pointer-events:none;touch-action:none\n}\n\n\n/* AteFlight V6.3 inspector system */\n:root{\n  --af-panel:#081017;--af-panel-2:#0c151d;--af-line:#24343f;--af-line-strong:#385364;\n  --af-text:#f2f6f8;--af-muted:#9babb5;--af-dim:#6e818d;--af-cyan:#59c8e8;--af-green:#58d18e\n}\n.info-panel{\n  width:min(438px,44%);border-radius:4px;border:1px solid var(--af-line-strong);\n  background:var(--af-panel);box-shadow:0 20px 55px rgba(0,0,0,.42);\n  grid-template-rows:auto auto minmax(0,1fr);overflow:hidden\n}\n.info-head{padding:16px 18px 13px;background:var(--af-panel);border-bottom:1px solid var(--af-line);z-index:5}\n.info-kicker{font-size:10px;letter-spacing:.14em;color:#7f95a2}\n.info-title{font-size:29px;line-height:1;font-weight:850;letter-spacing:-.025em}\n.info-sub{font-size:12px;color:#a9b8c1;margin-top:5px;line-height:1.35}\n.info-meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;font-size:10px;color:#7f929e}\n.info-meta b{font-weight:850;color:#dce7ec}\n.context-nav{display:none;background:#0a131a;border-bottom:1px solid var(--af-line);overflow-x:auto;scrollbar-width:none;padding:0 10px}\n.info-panel.airport-mode .context-nav{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0}\n.context-nav .airport-tab{\n  min-width:0;height:43px;border:0;border-radius:0;background:transparent;color:#879aa6;padding:0 4px;\n  font-size:9.5px;font-weight:850;letter-spacing:.025em;border-bottom:2px solid transparent;\n  display:flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;overflow:hidden\n}\n.airport-tab-count{font:800 8px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#617783}\n.context-nav .airport-tab.active .airport-tab-count{color:#72d8ff}\n.context-nav .airport-tab:hover{color:#d9e6ec;background:#0e1a22}\n.context-nav .airport-tab.active{color:#ecfaff;background:transparent;border-bottom-color:var(--af-cyan);box-shadow:none}\n.info-scroll{padding:16px 18px 22px;background:var(--af-panel);font-size:12px;color:var(--af-text)}\n.identifier-line{display:none!important}\n.data-source-note{font-size:10px;color:#7f929e;line-height:1.45;padding:0 0 10px}\n.airport-data-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:0 0 16px;border-top:1px solid var(--af-line);border-bottom:1px solid var(--af-line)}\n.airport-data-summary div{border:0;border-right:1px solid var(--af-line);border-radius:0;background:transparent;padding:10px 8px}\n.airport-data-summary div:last-child{border-right:0}\n.airport-data-summary strong{font-size:17px}.airport-data-summary span{font-size:9px;color:#81949f;margin-top:3px}\n.airport-summary-grid{gap:0;margin-bottom:15px;border-top:1px solid var(--af-line);border-bottom:1px solid var(--af-line)}\n.airport-summary-cell{border-top:0;border-bottom:1px solid var(--af-line);padding:11px 6px}\n.airport-summary-cell:nth-last-child(-n+2){border-bottom:0}\n.airport-summary-cell:nth-child(odd){border-right:1px solid var(--af-line)}\n.airport-summary-cell span{font-size:9px}.airport-summary-cell strong{font-size:15px}\n.info-section{margin-top:17px}.info-section h4{font-size:10px;color:#8da0ab;letter-spacing:.11em;margin:0 0 9px}\n.runway-recommendation{border-radius:4px;padding:12px;margin-bottom:15px}\n.runway-rec-title strong{font-size:14px}.runway-rec-title span{font-size:10px}\n.runway-caution{font-size:10px;line-height:1.5}\n.runway-card{padding:14px 0}.runway-card-head strong{font-size:15px}.runway-card-head span{font-size:11px}\n.runway-direction strong{font-size:12px}.runway-direction span{font-size:10px;line-height:1.35}\n.airport-freq-row{grid-template-columns:80px minmax(0,1fr) auto;padding:11px 0}\n.airport-freq-row strong{font-size:11px}.airport-freq-row span{font-size:10px}.airport-freq-row em{font-size:13px}\n.procedure-row{grid-template-columns:66px minmax(0,1fr) auto;min-height:50px}\n.procedure-type{font-size:9px}.procedure-copy strong{font-size:11px}.procedure-copy span{font-size:9px}.procedure-view{font-size:9px;height:31px}\n.info-actions{position:sticky;bottom:-22px;background:linear-gradient(180deg,rgba(8,16,23,0),var(--af-panel) 26%);padding-top:18px}\n.info-action{height:35px;font-size:10px;border-radius:3px}\n.af-loading{display:grid;gap:8px;padding:8px 0}\n.af-loading i{height:11px;border-radius:2px;background:linear-gradient(90deg,#0d1820,#172832,#0d1820);background-size:200% 100%;animation:afShimmer 1.1s linear infinite}\n.af-loading i:nth-child(2){width:78%}.af-loading i:nth-child(3){width:55%}\n@keyframes afShimmer{to{background-position:-200% 0}}\n.af-empty{padding:13px;border-left:2px solid #536873;background:#0b151c;color:#9fb0ba;font-size:11px;line-height:1.5}\n.af-empty strong{display:block;color:#d7e2e7;margin-bottom:3px;font-size:11px}\n@media(max-width:900px){.info-panel{width:min(420px,48%)}}\n@media(max-width:720px){\n  .info-panel{left:6px;right:6px;width:auto;border-radius:8px 8px 3px 3px;grid-template-rows:18px auto auto auto minmax(0,1fr) 42px}\n  .info-head{padding:5px 14px 11px}.info-title{font-size:24px}.info-sub{font-size:11px}.info-meta{font-size:9px;margin-top:6px}\n  .info-panel.airport-mode.sheet-half .context-nav,.info-panel.airport-mode.sheet-full .context-nav{display:grid!important;grid-template-columns:repeat(5,minmax(0,1fr));padding:0 4px}\n  .info-panel.sheet-peek .context-nav{display:none!important}\n  .context-nav .airport-tab{height:39px;font-size:8.5px;padding:0 2px;gap:2px}.airport-tab-count{font-size:7px}\n  .info-scroll{padding:13px 14px 20px;font-size:12px}\n}\n\n\n.status-grid{display:grid;gap:7px}\n.status-service{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:8px;align-items:center;min-height:43px;border-bottom:1px solid rgba(38,53,65,.58);padding:6px 1px}\n.status-service i{width:8px;height:8px;border-radius:50%;background:#6b7e8b}\n.status-service.ok i{background:var(--good)}\n.status-service.warn i{background:var(--warning)}\n.status-service.bad i{background:var(--danger)}\n.status-service strong,.status-service span{display:block}\n.status-service strong{font-size:10px}.status-service span{font-size:8px;color:var(--muted);margin-top:2px;line-height:1.3}\n.status-service em{font-style:normal;font-size:9px;font-weight:900;color:#d5e1e6}\n.feature-checklist{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:7px}\n.feature-checklist span{font-size:8px;color:#9db0bc;border:1px solid rgba(38,53,65,.7);border-radius:4px;padding:6px}\n\n\n.hazard-list,.airspace-list{border-top:1px solid var(--border);margin-top:8px}\n.layer-detail-row{width:100%;display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:9px;align-items:center;min-height:46px;padding:7px 2px;border:0;border-bottom:1px solid rgba(38,53,65,.58);background:transparent;color:var(--text);text-align:left;cursor:pointer}\n.layer-detail-row:hover{background:#0e1b24}.layer-detail-row i{width:9px;height:9px;border-radius:2px}.layer-detail-row strong,.layer-detail-row span{display:block}.layer-detail-row strong{font-size:10.5px}.layer-detail-row span{font-size:8.5px;color:var(--muted);margin-top:2px;line-height:1.3}.layer-detail-row em{font-style:normal;font-size:8px;color:#89a0ae;white-space:nowrap}\n.detail-hero{border-left:3px solid var(--detail-color,#58c7e8);padding:10px 11px;background:#0b161f;margin-bottom:10px}.detail-hero strong,.detail-hero span{display:block}.detail-hero strong{font-size:14px}.detail-hero span{font-size:9px;color:#a7bac5;margin-top:4px;line-height:1.4}\n.detail-table{border-top:1px solid var(--border)}.detail-table-row{display:grid;grid-template-columns:118px minmax(0,1fr);gap:10px;padding:8px 0;border-bottom:1px solid rgba(38,53,65,.56)}.detail-table-row b{font-size:8px;color:#7f96a4;letter-spacing:.05em}.detail-table-row span{font-size:9.5px;color:#d0dce2;line-height:1.4;word-break:break-word}\n.raw-advisory{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.5;color:#d5e0e5;white-space:pre-wrap;word-break:break-word;padding:10px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}\n.airspace-caution{padding:9px 10px;border:1px solid #705e27;background:#2b230d;color:#ead694;font-size:9px;line-height:1.45;margin-top:10px}\n.layer-count{display:inline-flex;min-width:24px;height:18px;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:4px;background:#0c171f;font-size:8px;color:#b7c6cf;margin-left:5px}\n\n\n.wind-canvas{position:absolute;inset:0;z-index:11;width:100%;height:100%;pointer-events:none;display:none}\n.wind-canvas.on{display:block}\n.radar-timeline{position:absolute;z-index:26;left:50%;bottom:49px;transform:translateX(-50%);width:min(720px,calc(100% - 132px));min-height:54px;border:1px solid rgba(62,88,104,.9);border-radius:7px;background:rgba(7,14,20,.96);display:none;grid-template-columns:34px minmax(0,1fr);gap:8px;align-items:center;padding:6px 9px;box-shadow:0 10px 28px rgba(0,0,0,.28)}\n.radar-timeline.on{display:grid}\n.timeline-play{width:30px;height:30px;border:1px solid var(--border);border-radius:5px;background:#0e1b24;color:#dbeaf0;font-size:11px;cursor:pointer}\n.timeline-main{min-width:0}.timeline-labels{display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:8px;color:var(--muted)}.timeline-labels strong{font-size:8.5px;color:var(--text);letter-spacing:.06em}.timeline-main input{width:100%;accent-color:var(--accent);margin:4px 0 0}.timeline-scale{grid-column:2;display:grid;grid-template-columns:repeat(7,1fr);font-size:7px;color:#708491;text-align:center;margin-top:-5px}.timeline-scale span:nth-child(n+4){color:#d0aa58}\n.weather-altitude{position:absolute;z-index:27;right:8px;top:76px;width:58px;height:290px;border:1px solid rgba(60,88,104,.9);border-radius:7px;background:rgba(7,14,20,.95);display:none;grid-template-rows:auto auto 1fr auto auto;justify-items:center;padding:7px 4px;box-shadow:0 12px 28px rgba(0,0,0,.26)}\n.weather-altitude.on{display:grid}.altitude-title{font-size:7px;letter-spacing:.1em;color:var(--muted);font-weight:900}.weather-altitude strong{font-size:8px;color:#e6f2f6;text-align:center;margin-top:4px}.weather-altitude input{writing-mode:vertical-lr;direction:rtl;width:26px;height:190px;accent-color:var(--accent);margin:5px 0}.weather-altitude span{font-size:7px;color:#708491}\n.weather-focus-note{border-left:3px solid var(--accent);padding:7px 8px;background:#0b1922;color:#9fb2bd;font-size:8.5px;line-height:1.4;margin:8px 0}\n.maplibregl-popup-content .wx-category{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:4px;color:#061019;font-size:9px;font-weight:950;margin-bottom:5px}\n@media(max-width:720px){.radar-timeline{left:6px;right:6px;bottom:47px;transform:none;width:auto}.weather-altitude{right:5px;top:58px;height:250px}.weather-altitude input{height:155px}.info-panel.open~.radar-timeline{display:none}}\n\n\n/* AteFlight V7 \u2014 doctrine-first mission system */\n.mission-topbar{grid-template-columns:210px auto auto 1fr auto;height:58px;padding:0 12px}.app{grid-template-rows:58px minmax(0,1fr)}\n.primary-nav{height:100%;display:flex}.primary-nav button{min-width:66px;border:0;border-left:1px solid var(--border);background:transparent;color:#8499a6;font-size:9px;font-weight:950;letter-spacing:.08em;cursor:pointer}.primary-nav button:last-child{border-right:1px solid var(--border)}.primary-nav button.active{color:#e8f5f9;box-shadow:inset 0 -3px 0 var(--accent);background:#0e1921}\n.mission-badges{display:flex;gap:8px}.flight-badge,.phase-badge{height:28px;display:flex;align-items:center;padding:0 9px;border:1px solid var(--border);font-size:8px;font-weight:900;letter-spacing:.05em}.flight-badge{color:#d7f7ff;border-color:#2d7188;background:#0b2835}.phase-badge{color:#f2d06f;border-color:#6b581c;background:#2a2208}.mission-ops{justify-self:end}.mission-rail{position:absolute;left:0;top:0;bottom:0;width:72px;z-index:24;background:rgba(7,14,20,.97);border-right:1px solid var(--border);display:flex;flex-direction:column}.mission-rail button{height:58px;border:0;border-bottom:1px solid var(--border);background:transparent;color:#77909f;text-align:left;padding:8px 10px;font-size:9px;font-weight:950;letter-spacing:.07em;cursor:pointer}.mission-rail button span{display:block;font-size:7px;color:#486170;margin-bottom:5px}.mission-rail button.active{color:#d9f5ff;background:#0e2634;box-shadow:inset 3px 0 0 var(--accent)}\n.mission-workspace{position:absolute;z-index:29;top:10px;bottom:60px;left:84px;width:430px;background:rgba(6,15,22,.985);border:1px solid #315267;display:none;grid-template-rows:auto minmax(0,1fr);box-shadow:0 18px 50px rgba(0,0,0,.38)}.mission-workspace.open{display:grid}.mission-workspace>header{min-height:74px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:12px 15px}.mission-workspace h2{margin:5px 0 0;font-size:22px}.mission-workspace>header button,.flight-story>header button,.why-dialog header button,.approach-viewer header button{width:36px;height:36px;border:1px solid var(--border);background:#0d1b24;color:#c8d7de;cursor:pointer}.mission-eyebrow{display:block;font-size:8px;color:#7f99a8;font-weight:950;letter-spacing:.14em}.mission-scroll{min-height:0;overflow:auto;padding:15px;overscroll-behavior:contain}.form-section{padding-bottom:16px;border-bottom:1px solid var(--border);margin-bottom:16px}.form-section h3,.library-group h3{margin:0;font-size:10px;letter-spacing:.1em}.form-section p,.library-group p{margin:4px 0 10px;color:#7f94a1;font-size:8px;line-height:1.45}.form-grid{display:grid;gap:10px}.form-grid.two{grid-template-columns:1fr 1fr}.form-grid.three{grid-template-columns:repeat(3,1fr)}.form-section label{display:block;position:relative;font-size:8px;color:#7f99a8;font-weight:900;letter-spacing:.06em;margin:9px 0}.form-section input,.form-section select{width:100%;height:43px;margin-top:5px;background:#0b1b25;border:1px solid #315267;color:#ecf4f7;padding:0 11px;font-size:15px;font-weight:750}.form-section small{position:absolute;right:8px;bottom:10px;color:#4f6978;font-size:7px}.capability-row{display:flex;gap:8px;flex-wrap:wrap}.capability-row label{height:35px;margin:0;border:1px solid #315267;display:flex;align-items:center;gap:8px;padding:0 10px;color:#b9ccd6}.capability-row input{width:auto;height:auto;margin:0}.doctrine-guard{border-left:3px solid #f0b82f;background:#231c05;padding:12px;margin:16px 0}.doctrine-guard strong{display:block;color:#f2cf5d;font-size:8px;letter-spacing:.1em}.doctrine-guard span{display:block;color:#a9975d;font-size:8px;line-height:1.45;margin-top:7px}.planner-actions{display:flex;gap:8px}.planner-actions button{height:40px;border:1px solid #315267;background:#0d1b24;color:#a8bbc6;padding:0 13px;font-size:8px;font-weight:950;cursor:pointer}.planner-actions .primary{background:#58c7e8;color:#061019;border-color:#58c7e8}.planner-actions .quiet{border-color:transparent;background:transparent}.planner-actions button:disabled{opacity:.4}.planner-result{border-top:1px solid var(--border);margin-top:14px;padding-top:12px}.planner-result>p{color:#718995;font-size:8px}.result-summary{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--border)}.result-summary div{padding:9px;border-right:1px solid var(--border)}.result-summary div:last-child{border:0}.result-summary span,.result-summary strong{display:block}.result-summary span{font-size:7px;color:#748c9a}.result-summary strong{font-size:12px;margin-top:3px}.token-strip{display:flex;gap:4px;flex-wrap:wrap;margin:10px 0}.token-chip{padding:5px 7px;border:1px solid var(--border);font-size:8px}.token-chip.ACTIVE{border-color:#2e7a54;color:#6ee4a4}.token-chip.CONTEXT{border-color:#327b91;color:#7eddf8}.token-chip.UNKNOWN{border-color:#7a6224;color:#f0c65f}.altitude-list{border-top:1px solid var(--border)}.altitude-row{display:grid;grid-template-columns:80px 1fr auto;gap:8px;padding:9px 0;border-bottom:1px solid var(--border);align-items:center}.altitude-row strong{font-size:14px}.altitude-row span{font-size:8px;color:#8298a6}.altitude-row em{font-style:normal;font-size:8px;color:#e6bc4f}\n.library-workspace{width:500px}.library-heading{display:flex;justify-content:space-between;gap:15px;align-items:flex-start;border-bottom:1px solid var(--border);padding-bottom:8px}.library-heading>span{font-size:8px;color:#7d95a3}.library-group{margin-bottom:22px}.approach-list{border-top:1px solid var(--border)}.approach-row{min-height:52px;display:grid;grid-template-columns:60px 1fr auto;align-items:center;gap:10px;border-bottom:1px solid var(--border)}.approach-row .type{font-size:8px;color:#64cde9;font-weight:950}.approach-row strong,.approach-row small{display:block}.approach-row strong{font-size:11px}.approach-row small{font-size:8px;color:#8298a6;margin-top:3px}.approach-open{height:28px;border:1px solid #315267;background:#0d1b24;color:#cbe0e8;font-size:8px;font-weight:900}.approach-empty{padding:18px 0;color:#788e9a;font-size:9px;line-height:1.5}.library-counts{display:none}\n.flight-story{position:absolute;z-index:28;right:10px;top:10px;bottom:60px;width:390px;background:rgba(5,14,20,.985);border:1px solid #315267;overflow:auto;transition:width .16s}.flight-story.collapsed{width:48px;overflow:hidden}.flight-story.collapsed>*:not(header){display:none}.flight-story.collapsed header>div{display:none}.flight-story>header{min-height:94px;padding:14px;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)}.flight-story h2{font-size:22px;margin:5px 0 2px}.flight-story>header p{margin:0;color:#78909d;font-size:8px}.story-next{padding:12px 14px;background:#0c2938;border-bottom:1px solid #315267}.story-next span,.story-band>header span{font-size:8px;font-weight:950;letter-spacing:.12em}.story-next span{color:#66d8f4}.story-next strong{display:block;font-size:14px;margin-top:5px}.story-next p{font-size:8px;color:#8fa5b2;margin:3px 0 0}.story-band>header{height:43px;padding:0 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}.story-band.active>header span{color:#56dc92}.story-band.context>header span{color:#66d8f4}.story-band.unknown>header span{color:#f0bd42}.story-band.suppressed>header span{color:#708693}.story-item{min-height:72px;padding:11px 14px;border-bottom:1px solid var(--border);position:relative}.story-item strong{display:block;font-size:11px;padding-right:48px}.story-item p{margin:4px 0 0;color:#8197a4;font-size:8px;line-height:1.4}.story-item button{position:absolute;right:10px;top:12px;height:26px;border:1px solid #356176;background:#0b1a23;color:#8eddf4;font-size:7px;font-weight:950}.story-empty{padding:12px 14px;color:#657c89;font-size:8px}.ledger>button{width:100%;height:42px;border:0;border-bottom:1px solid var(--border);background:#08151d;color:#d6e3e8;display:flex;justify-content:space-between;padding:0 14px;font-size:8px;font-weight:950}.ledger>div{padding:10px 14px}.ledger-row{padding:8px 0;border-bottom:1px solid var(--border)}.ledger-row strong,.ledger-row span{display:block}.ledger-row strong{font-size:9px}.ledger-row span{font-size:8px;color:#7c929f;margin-top:3px}.phase-strip{position:absolute;z-index:27;left:84px;right:400px;bottom:10px;height:42px;display:grid;grid-template-columns:205px repeat(7,1fr);background:rgba(6,14,20,.97);border:1px solid #315267}.phase-strip>span,.phase-strip button{border:0;border-right:1px solid var(--border);background:transparent;color:#6d8492;font-size:7px;font-weight:950}.phase-strip>span{display:flex;align-items:center;padding:0 12px;color:#b8a04c}.phase-strip button.active{color:#dff7ff;background:#0e2a39;box-shadow:inset 0 -3px 0 var(--accent)}\n.why-dialog,.approach-viewer{border:1px solid #315267;background:#071119;color:#edf5f7;padding:0;box-shadow:0 28px 80px rgba(0,0,0,.58)}.why-dialog{width:min(560px,calc(100vw - 30px))}.why-dialog::backdrop,.approach-viewer::backdrop{background:rgba(0,0,0,.72)}.why-dialog header,.approach-viewer header{height:68px;padding:10px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}.why-dialog h3,.approach-viewer h3{margin:4px 0 0}.why-body{padding:15px}.why-evidence{border-left:3px solid #58c7e8;padding:10px;background:#0c1b24;margin:8px 0;font-size:10px;line-height:1.5}.why-unknown{border-left-color:#f0bd42}.approach-viewer{width:min(1100px,calc(100vw - 30px));height:min(90vh,900px)}.approach-viewer iframe{width:100%;height:calc(100% - 68px);border:0;background:white}.mobile-primary-nav{display:none}\nbody.mission-plan .map-mode-bar,body.mission-plan .bottom-bar,body.mission-plan .detail-mode-badge,body.mission-plan .rail,body.mission-library .map-mode-bar,body.mission-library .bottom-bar,body.mission-library .detail-mode-badge,body.mission-library .rail{display:none}body.mission-fly .mission-rail,body.mission-airport .mission-rail,body.mission-weather .mission-rail{display:none}.clean .mission-topbar,.clean .mission-rail,.clean .mission-workspace,.clean .flight-story,.clean .phase-strip,.clean .mobile-primary-nav{display:none!important}\n@media(max-width:1180px){.mission-topbar{grid-template-columns:180px auto 1fr auto}.mission-badges{display:none}.mission-ops .ops-item:nth-child(n+2){display:none}.flight-story{width:340px}.phase-strip{right:350px}.mission-workspace{width:410px}}\n@media(max-width:850px){body.mission-plan .flight-story,body.mission-library .flight-story{display:none!important}.mission-workspace{background:#061018}.mission-topbar{grid-template-columns:160px 1fr auto}.primary-nav{display:none}.mission-ops{display:none}.mission-workspace{left:0;right:0;top:0;bottom:56px;width:auto;border:0}.flight-story{left:8px;right:8px;top:auto;bottom:56px;width:auto;max-height:46%;}.phase-strip{left:0;right:0;bottom:56px;height:38px;grid-template-columns:170px repeat(7,1fr)}.mission-rail{display:none}.mobile-primary-nav{position:absolute;z-index:55;left:0;right:0;bottom:0;height:56px;display:grid;grid-template-columns:repeat(5,1fr);background:#071119;border-top:1px solid #315267}.mobile-primary-nav button{border:0;border-right:1px solid var(--border);background:transparent;color:#758d9b;font-size:8px;font-weight:950}.mobile-primary-nav button.active{color:#dff7ff;box-shadow:inset 0 -3px 0 var(--accent)}.rail{top:54px}.planner-workspace,.library-workspace{z-index:60}.form-grid.three{grid-template-columns:1fr 1fr}.story-next strong{font-size:13px}.topbar .brand-copy span{display:none}.topbar{padding:0 8px}.actions #displayBtn,.actions #commandBtn{display:none}}\n@media(max-width:520px){.app{grid-template-rows:46px minmax(0,1fr)}.mission-topbar{height:46px;grid-template-columns:1fr auto}.topbar .brand-mark{display:none}.brand-copy strong{font-size:13px}.actions .btn{display:none}.actions #refreshBtn,.actions #cleanBtn{display:grid}.mission-workspace{bottom:54px}.mission-workspace>header{min-height:62px}.mission-workspace h2{font-size:20px}.mission-scroll{padding:13px}.form-grid.two,.form-grid.three{grid-template-columns:1fr 1fr}.form-grid.three label:last-child{grid-column:1/-1}.flight-story{max-height:48%;bottom:54px}.phase-strip{display:none}.map-mode-bar{top:8px;left:8px;right:8px}.rail{display:none}.story-band.unknown,.story-band.suppressed{display:none}.story-band.context .story-item:nth-child(n+2){display:none}.approach-row{grid-template-columns:48px 1fr auto}.planner-actions button{padding:0 9px}.result-summary{grid-template-columns:1fr 1fr}.result-summary div:nth-child(3){grid-column:1/-1;border-top:1px solid var(--border)} }\n\n\n/* V7.1 selection hierarchy */\n.selection-stack{position:absolute;z-index:85;min-width:220px;max-width:320px;background:rgba(6,14,20,.98);border:1px solid #355a6e;box-shadow:0 16px 42px rgba(0,0,0,.42)}\n.selection-stack[hidden]{display:none}.selection-stack-toggle{width:100%;height:34px;border:0;background:#102b39;color:#dff7ff;font-size:9px;font-weight:950;letter-spacing:.08em}.selection-stack-list{border-top:1px solid var(--border);max-height:250px;overflow:auto}.selection-option{width:100%;min-height:44px;border:0;border-bottom:1px solid var(--border);background:transparent;color:#d9e6eb;text-align:left;padding:8px 10px;display:grid;grid-template-columns:66px 1fr;gap:8px;cursor:pointer}.selection-option:hover{background:#10212c}.selection-option .kind{font-size:8px;color:#72d8ff;font-weight:950;letter-spacing:.08em}.selection-option strong,.selection-option span{display:block}.selection-option strong{font-size:10px}.selection-option span{font-size:8px;color:#8398a5;margin-top:2px}\n@media(max-width:720px){.selection-stack{left:8px!important;right:8px!important;bottom:64px!important;top:auto!important;max-width:none}.selection-stack-toggle{height:40px}.selection-option{min-height:48px}}\n\n\n/* V7.1 deliberate product chrome */\n.mission-topbar{height:60px;grid-template-columns:185px minmax(360px,1fr) minmax(270px,auto) auto;gap:10px;padding:0 10px}.app{grid-template-rows:60px minmax(0,1fr)}\n.primary-nav{min-width:0}.primary-nav button{position:relative;min-width:68px;padding:0 12px;font-size:9.5px}.library-nav-button{padding-right:18px!important}.nav-badge{position:absolute;right:3px;top:5px;font-style:normal;font-size:6px;line-height:1;color:#8fdcf2;letter-spacing:0}.mission-context{min-width:0;display:grid;grid-template-rows:26px 22px;align-content:center;border-left:1px solid var(--border);padding-left:10px}.mission-context-primary,.mission-context-secondary{display:flex;align-items:center;gap:7px;min-width:0}.mission-context-primary .flight-badge{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mission-context-primary .flight-badge,.mission-context-primary .phase-badge{height:24px}.mission-context-secondary{color:#8196a3;font-size:8px}.feed-state{display:inline-flex;align-items:center;gap:6px;min-width:0}.feed-state strong{max-width:145px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dce8ed;font-size:9px}.context-stat{white-space:nowrap}.context-stat strong{color:#f0f6f8;font-size:9px}.actions{justify-self:end}.mobile-nav-badge{display:block;font-style:normal;font-size:6px;color:#7fd8f3;margin-top:2px}\n.custom-pack-card{border-left:3px solid #58c7e8;background:#0b1c25;padding:10px 11px;margin-top:13px}.custom-pack-card strong,.custom-pack-card span{display:block}.custom-pack-card strong{font-size:10px}.custom-pack-card span{font-size:8px;color:#849aa7;margin-top:4px;line-height:1.4}.custom-pack-card.available{border-left-color:#63db98}.custom-pack-card.missing{border-left-color:#f0bd42}\n@media(max-width:1180px){.mission-topbar{grid-template-columns:165px minmax(330px,1fr) minmax(210px,auto) auto}.mission-context-primary .flight-badge{max-width:135px}.mission-context-secondary .wx-stat{display:none}.actions #commandBtn{display:none}}\n@media(max-width:950px){.mission-topbar{grid-template-columns:150px 1fr auto}.mission-context{display:none}.primary-nav button{min-width:62px;padding:0 8px}}\n@media(max-width:850px){.mission-topbar{grid-template-columns:1fr auto}.primary-nav{display:none}.mission-context{display:none}}\n\n</style>\n</head>\n<body>\n<main id=\"app\" class=\"app\">\n  <header class=\"topbar mission-topbar\">\n    <div class=\"brand\"><div class=\"brand-mark\">AF</div><div class=\"brand-copy\"><strong>AteFlight</strong><span>FLIGHT CONTEXT \u00b7 DECISIONS \u00b7 TRUST</span></div></div>\n    <nav class=\"primary-nav\" aria-label=\"Primary\"><button data-mission=\"fly\" class=\"active\" type=\"button\">FLY</button><button data-mission=\"plan\" type=\"button\">PLAN</button><button data-mission=\"airport\" type=\"button\">AIRPORT</button><button data-mission=\"weather\" type=\"button\">WEATHER</button><button data-mission=\"library\" class=\"library-nav-button\" type=\"button\">LIBRARY<i id=\"customNavBadge\" class=\"nav-badge\">CUSTOM \u2014</i></button></nav>\n    <div class=\"mission-context\" aria-label=\"Flight and data context\">\n      <div class=\"mission-context-primary\"><span id=\"activeFlightBadge\" class=\"flight-badge\">NO ACTIVE FLIGHT</span><span id=\"phaseBadge\" class=\"phase-badge\">PREFLIGHT</span></div>\n      <div class=\"mission-context-secondary\"><span class=\"feed-state\"><span id=\"statusDot\" class=\"status-dot\"></span><strong id=\"statusText\">CONNECTING</strong></span><span class=\"context-stat\"><strong id=\"topAircraft\">\u2014</strong> ACFT</span><span class=\"context-stat\"><strong id=\"topAge\">\u2014</strong> ADS-B</span><span class=\"context-stat wx-stat\"><strong id=\"topWx\">\u2014</strong> WX</span></div>\n    </div>\n    <div class=\"actions\"><button id=\"displayBtn\" class=\"btn\" type=\"button\">DISPLAY</button><button id=\"commandBtn\" class=\"btn\" type=\"button\">SEARCH <span style=\"color:var(--subtle)\">\u2318K</span></button><button id=\"refreshBtn\" class=\"btn icon\" type=\"button\" aria-label=\"Refresh\"><svg viewBox=\"0 0 24 24\"><path d=\"M20 11a8 8 0 1 0-2.3 5.7\"/><path d=\"M20 4v7h-7\"/></svg></button><button id=\"cleanBtn\" class=\"btn icon\" type=\"button\" aria-label=\"Clean view\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5\"/></svg></button></div>\n  </header>\n\n  <section class=\"workspace\">\n    <div id=\"map\"></div><canvas id=\"windCanvas\" class=\"wind-canvas\" aria-label=\"Wind flow\"></canvas><canvas id=\"trafficCanvas\" class=\"traffic-canvas\" aria-label=\"Live aircraft\"></canvas><div id=\"selectionStack\" class=\"selection-stack\" hidden><button id=\"selectionStackToggle\" class=\"selection-stack-toggle\" type=\"button\">ALSO HERE \u00b7 0</button><div id=\"selectionStackList\" class=\"selection-stack-list\" hidden></div></div>\n    <div id=\"mapModeBar\" class=\"map-mode-bar\" aria-label=\"Aviation map mode\">\n      <button class=\"map-mode-btn active\" data-map-mode=\"aviation\" type=\"button\">AVIATION</button>\n      <button class=\"map-mode-btn\" data-map-mode=\"vfr\" type=\"button\">VFR SECTIONAL</button>\n      <button class=\"map-mode-btn\" data-map-mode=\"ifr-low\" type=\"button\">IFR LOW</button>\n      <button class=\"map-mode-btn\" data-map-mode=\"ifr-high\" type=\"button\">IFR HIGH</button>\n    </div>\n    <div id=\"chartBadge\" class=\"chart-badge\"><strong id=\"chartBadgeTitle\">FAA CHART</strong><span id=\"chartBadgeMeta\">FAA Aeronautical Information Services</span><button id=\"nativeZoomBtn\" class=\"chart-native-btn\" type=\"button\">NATIVE DETAIL</button></div>\n    <div id=\"aviationLegend\" class=\"aviation-legend\"><b>AVIATION BASE</b><br><span><i style=\"border:2px solid #58c7e8;border-radius:50%\"></i>Reporting airport</span><br><span><i style=\"background:#d6e0e5;transform:rotate(45deg)\"></i>VOR / VORTAC</span></div>\n\n\n    <nav id=\"missionRail\" class=\"mission-rail\" aria-label=\"Mission workspaces\"><button data-mission=\"fly\" class=\"active\" type=\"button\"><span>01</span>FLY</button><button data-mission=\"plan\" type=\"button\"><span>02</span>PLAN</button><button data-mission=\"airport\" type=\"button\"><span>03</span>AIRPORT</button><button data-mission=\"weather\" type=\"button\"><span>04</span>WEATHER</button><button data-mission=\"library\" type=\"button\"><span>05</span>LIBRARY</button></nav>\n\n    <section id=\"plannerWorkspace\" class=\"mission-workspace planner-workspace\" aria-label=\"Flight planning\">\n      <header><div><span class=\"mission-eyebrow\">FLIGHT PLANNING</span><h2>Build the mission</h2></div><button id=\"plannerClose\" type=\"button\">\u00d7</button></header>\n      <div class=\"mission-scroll\">\n        <section class=\"form-section\"><h3>ROUTE</h3><p>Authoritative points only. Unknown airway geometry is never invented.</p>\n          <div class=\"form-grid two\"><label>ORIGIN<input id=\"planOrigin\" value=\"KAPN\" autocomplete=\"off\"></label><label>DESTINATION<input id=\"planDestination\" placeholder=\"KDTW\" autocomplete=\"off\"></label></div>\n          <label>ROUTE<input id=\"planRoute\" placeholder=\"DCT APN DCT TVC\" autocomplete=\"off\"></label>\n          <div class=\"form-grid three\"><label>RULES<select id=\"planRules\"><option>IFR</option><option>VFR</option></select></label><label>PREFERRED ALT<input id=\"planPreferredAltitude\" type=\"number\" value=\"7000\" step=\"500\"></label><label>MAG COURSE<input id=\"planMagneticCourse\" type=\"number\" min=\"0\" max=\"359\" placeholder=\"Optional\"></label></div>\n        </section>\n        <section class=\"form-section\"><h3>AIRCRAFT PROFILE</h3><p>AteFlight uses the profile instead of asking the same questions every flight.</p>\n          <div class=\"form-grid two\"><label>TYPE<input id=\"profileType\" value=\"C172\"></label><label>APPROACH CAT<select id=\"profileCategory\"><option>A</option><option>B</option><option>C</option><option>D</option><option>E</option></select></label></div>\n          <div class=\"form-grid three\"><label>CRUISE TAS<input id=\"profileTas\" type=\"number\" value=\"115\"><small>KT</small></label><label>FUEL BURN<input id=\"profileFuelBurn\" type=\"number\" value=\"9\" step=\"0.1\"><small>GPH</small></label><label>SERVICE CEILING<input id=\"profileCeiling\" type=\"number\" value=\"14000\" step=\"500\"><small>FT</small></label></div>\n          <div class=\"capability-row\"><label><input id=\"profileRnav\" type=\"checkbox\" checked> RNAV</label><label><input id=\"profileWaas\" type=\"checkbox\" checked> WAAS</label><label><input id=\"profileIfr\" type=\"checkbox\" checked> IFR EQUIPPED</label></div>\n        </section>\n        <aside class=\"doctrine-guard\"><strong>WHAT ATEFLIGHT WILL NOT GUESS</strong><span>Airway geometry, MEA/MOCA, terrain clearance, NOTAM applicability, and ATC clearance remain UNKNOWN until authoritative data is connected and evaluated.</span></aside>\n        <div class=\"planner-actions\"><button id=\"analyzePlanBtn\" class=\"primary\" type=\"button\">ANALYZE FLIGHT</button><button id=\"activatePlanBtn\" type=\"button\" disabled>ACTIVATE FLIGHT</button><button id=\"clearPlanBtn\" class=\"quiet\" type=\"button\">CLEAR</button></div>\n        <div id=\"plannerResult\" class=\"planner-result\"><p>Enter a destination to begin.</p></div>\n      </div>\n    </section>\n\n    <section id=\"libraryWorkspace\" class=\"mission-workspace library-workspace\" aria-label=\"Approach library\"><header><div><span class=\"mission-eyebrow\">APPROACH LIBRARY</span><h2 id=\"libraryTitle\">Destination procedures</h2></div><button id=\"libraryClose\" type=\"button\">\u00d7</button></header><div class=\"mission-scroll\"><section class=\"library-group\"><div class=\"library-heading\"><div><h3>ATEFLIGHT CUSTOM</h3><p>Contextual approach products supplied by the custom chart project.</p></div><span id=\"customPackCycle\">CYCLE UNSET</span></div><div id=\"customApproachList\" class=\"approach-list\"><div class=\"approach-empty\">Select a destination first.</div></div></section><section class=\"library-group\"><div class=\"library-heading\"><div><h3>OFFICIAL FAA d-TPP</h3><p>Authoritative source material remains available for verification.</p></div><span><b id=\"officialProcedureCount\">0</b> CHARTS</span></div><div id=\"officialApproachList\" class=\"approach-list\"><div class=\"approach-empty\">Select a destination first.</div></div></section><div class=\"library-counts\"><span><b id=\"customProcedureCount\">0</b> CUSTOM</span><span><b id=\"officialProcedureCountMirror\">\u2014</b></span></div></div></section>\n\n    <aside id=\"flightStory\" class=\"flight-story\" aria-label=\"Flight Story\"><header><div><span class=\"mission-eyebrow\">FLIGHT STORY</span><h2 id=\"storyTitle\">No active flight</h2><p id=\"storyMeta\">Build a plan to create contextual guidance.</p></div><button id=\"storyCollapse\" type=\"button\">\u2039</button></header><section id=\"storyNext\" class=\"story-next\"><span>NEXT</span><strong>Build or activate a flight</strong><p>AteFlight cannot prioritize the story without a destination.</p></section><section class=\"story-band active\"><header><span>ACTIVE</span><b id=\"storyActiveCount\">0</b></header><div id=\"storyActive\" class=\"story-items\"></div></section><section class=\"story-band context\"><header><span>CONTEXT</span><b id=\"storyContextCount\">0</b></header><div id=\"storyContext\" class=\"story-items\"></div></section><section class=\"story-band unknown\"><header><span>UNKNOWN</span><b id=\"storyUnknownCount\">0</b></header><div id=\"storyUnknown\" class=\"story-items\"></div></section><section class=\"story-band suppressed\"><header><span>SUPPRESSED</span><b id=\"storySuppressedCount\">0</b></header><div id=\"storySuppressed\" class=\"story-items\"></div></section><section class=\"ledger\"><button id=\"ledgerToggle\" type=\"button\"><span>TRUST LEDGER</span><b>SHOW</b></button><div id=\"sourceLedger\" hidden></div></section></aside>\n\n    <nav id=\"phaseStrip\" class=\"phase-strip\" aria-label=\"Phase of flight\"><span id=\"autoPhaseState\">AUTO PHASE UNKNOWN \u00b7 NO OWNSHIP FEED</span><button data-phase=\"preflight\" class=\"active\" type=\"button\">PREFLIGHT</button><button data-phase=\"departure\" type=\"button\">DEPARTURE</button><button data-phase=\"enroute\" type=\"button\">ENROUTE</button><button data-phase=\"arrival\" type=\"button\">ARRIVAL</button><button data-phase=\"approach\" type=\"button\">APPROACH</button><button data-phase=\"missed\" type=\"button\">MISSED</button><button data-phase=\"taxi\" type=\"button\">TAXI</button></nav>\n    <nav class=\"mobile-primary-nav\"><button data-mission=\"fly\" class=\"active\" type=\"button\">FLY</button><button data-mission=\"plan\" type=\"button\">PLAN</button><button data-mission=\"airport\" type=\"button\">AIRPORT</button><button data-mission=\"weather\" type=\"button\">WEATHER</button><button data-mission=\"library\" type=\"button\">LIBRARY<i id=\"customMobileBadge\" class=\"mobile-nav-badge\">\u2014</i></button></nav>\n\n    <div class=\"rail\">\n      <button class=\"rail-btn\" data-open-tab=\"base\" type=\"button\" aria-label=\"Map layers\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"m12 2 9 5-9 5-9-5 9-5Z\"/><path d=\"m3 12 9 5 9-5M3 17l9 5 9-5\"/></svg><span>MAP</span>\n      </button>\n      <button class=\"rail-btn\" data-open-tab=\"weather\" type=\"button\" aria-label=\"Weather layers\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"M17.5 19H7a5 5 0 1 1 1.3-9.8A6 6 0 0 1 20 11a4 4 0 0 1-2.5 8Z\"/></svg><span>WX</span>\n      </button>\n      <button class=\"rail-btn\" data-open-tab=\"airspace\" type=\"button\" aria-label=\"Special use airspace\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"M12 3 21 19H3L12 3Z\"/><path d=\"M12 9v4M12 17h.01\"/></svg><span>SUA</span>\n      </button>\n      <button class=\"rail-btn\" data-open-tab=\"traffic\" type=\"button\" aria-label=\"Traffic layers\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"m12 2 2 7 6 3v2l-6-1-1 6 3 2v1l-4-1-4 1v-1l3-2-1-6-6 1v-2l6-3 2-7Z\"/></svg><span>TRFC</span>\n      </button>\n      <button id=\"homeBtn\" class=\"rail-btn\" type=\"button\" aria-label=\"Return to KAPN\">\n        <svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"7\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><path d=\"M12 2v3M12 19v3M2 12h3M19 12h3\"/></svg><span>KAPN</span>\n      </button>\n    </div>\n    <div id=\"detailModeBadge\" class=\"detail-mode-badge\">AUTO DETAIL \u00b7 REGIONAL</div>\n\n    <aside id=\"sidePanel\" class=\"side-panel\" aria-label=\"Map controls\">\n      <div class=\"panel-head\">\n        <div class=\"panel-title\"><strong>DISPLAY</strong><span id=\"panelSubtitle\">Map and chart presentation</span></div>\n        <button id=\"sideClose\" class=\"btn icon\" type=\"button\" aria-label=\"Close panel\">\u00d7</button>\n      </div>\n      <div class=\"panel-tabs\">\n        <button class=\"panel-tab active\" data-tab=\"base\" type=\"button\">BASE</button>\n        <button class=\"panel-tab\" data-tab=\"weather\" type=\"button\">WEATHER</button>\n        <button class=\"panel-tab\" data-tab=\"airspace\" type=\"button\">AIRSPACE</button>\n        <button class=\"panel-tab\" data-tab=\"traffic\" type=\"button\">TRAFFIC</button>\n        <button class=\"panel-tab\" data-tab=\"status\" type=\"button\">STATUS</button>\n      </div>\n      <div id=\"panelScroll\" class=\"panel-scroll\"></div>\n    </aside>\n\n    <aside id=\"infoPanel\" class=\"info-panel\" aria-label=\"Selected item details\">\n      <div id=\"sheetHandle\" class=\"sheet-handle\" aria-hidden=\"true\"><i></i></div>\n      <div class=\"info-head\">\n        <div id=\"infoKicker\" class=\"info-kicker\">SELECTED AIRCRAFT</div>\n        <div class=\"info-title-row\"><div id=\"infoTitle\" class=\"info-title\">\u2014</div><button id=\"infoClose\" class=\"btn icon\" type=\"button\">\u00d7</button></div>\n        <div id=\"infoSub\" class=\"info-sub\">\u2014</div><div id=\"infoMeta\" class=\"info-meta\"></div>\n        <div id=\"infoLoading\" class=\"loading-line\" style=\"display:none\"><i></i></div>\n      </div>\n      <div id=\"mobilePeek\" class=\"mobile-peek\"></div>\n      <div id=\"contextNav\" class=\"context-nav\"></div>\n      <div id=\"infoScroll\" class=\"info-scroll\"></div>\n      <div id=\"sheetActions\" class=\"sheet-actions\">\n        <button data-sheet=\"peek\" type=\"button\">PEEK</button>\n        <button data-sheet=\"half\" type=\"button\">DETAILS</button>\n        <button data-sheet=\"full\" type=\"button\">FULL</button>\n      </div>\n    </aside>\n\n    <div id=\"radarTimeline\" class=\"radar-timeline\" aria-label=\"Radar and precipitation timeline\">\n      <button id=\"radarTimelinePlay\" class=\"timeline-play\" type=\"button\" aria-label=\"Play weather timeline\">\u25b6</button>\n      <div class=\"timeline-main\"><div class=\"timeline-labels\"><strong id=\"radarTimelineMode\">OBSERVED RADAR</strong><span id=\"radarTimelineLabel\">NOW</span></div><input id=\"radarTimelineSlider\" type=\"range\" min=\"0\" max=\"6\" step=\"1\" value=\"2\"></div>\n      <div class=\"timeline-scale\"><span>-10</span><span>-5</span><span>NOW</span><span>+15</span><span>+30</span><span>+45</span><span>+60</span></div>\n    </div>\n    <aside id=\"weatherAltitude\" class=\"weather-altitude\" aria-label=\"Weather altitude\">\n      <div class=\"altitude-title\">ALTITUDE</div><strong id=\"weatherAltitudeLabel\">9,000 FT</strong>\n      <input id=\"weatherAltitudeSlider\" type=\"range\" min=\"0\" max=\"9\" step=\"1\" value=\"3\" orient=\"vertical\">\n      <span>FL390</span><span>SFC</span>\n    </aside>\n    <div id=\"bottomBar\" class=\"bottom-bar\">\n      <div id=\"rangeSegment\" class=\"segment\">\n        <button data-range=\"25\" type=\"button\">25</button>\n        <button data-range=\"50\" type=\"button\">50</button>\n        <button data-range=\"100\" class=\"active\" type=\"button\">100</button>\n        <button data-range=\"150\" type=\"button\">150</button>\n        <button data-range=\"250\" type=\"button\">250</button>\n      </div>\n      <div class=\"bar-sep\"></div>\n      <div class=\"bar-stat\"><strong id=\"barAircraft\">\u2014</strong><span>ACFT</span></div>\n      <div class=\"bar-stat optional\"><strong id=\"barMetar\">\u2014</strong><span>METAR</span></div>\n      <div class=\"bar-stat optional\"><strong id=\"barPirep\">\u2014</strong><span>PIREP</span></div>\n      <div class=\"bar-stat optional\"><strong id=\"barContext\">REGIONAL</strong><span>DETAIL</span></div>\n      <div class=\"bar-spacer\"></div>\n      <button id=\"zoomOut\" class=\"map-btn\" type=\"button\" aria-label=\"Zoom out\">\u2212</button>\n      <button id=\"zoomIn\" class=\"map-btn\" type=\"button\" aria-label=\"Zoom in\">+</button>\n      <button id=\"fitRange\" class=\"map-btn\" type=\"button\" aria-label=\"Fit selected range\">\u25ce</button>\n    </div>\n\n    <div id=\"toast\" class=\"toast\"></div>\n    <button id=\"cleanReturn\" class=\"btn clean-return\" type=\"button\">SHOW CONTROLS</button>\n  </section>\n</main>\n\n<dialog id=\"commandDialog\" class=\"command\">\n  <div class=\"command-head\"><input id=\"commandInput\" class=\"command-input\" autocomplete=\"off\" placeholder=\"Search aircraft or run a command\u2026\"></div>\n  <div id=\"commandList\" class=\"command-list\"></div>\n</dialog>\n\n<dialog id=\"whyDialog\" class=\"why-dialog\"><header><div><span class=\"mission-eyebrow\">WHY?</span><h3 id=\"whyTitle\">Decision detail</h3></div><button id=\"whyClose\" type=\"button\">\u00d7</button></header><div id=\"whyBody\" class=\"why-body\"></div></dialog>\n<dialog id=\"approachViewer\" class=\"approach-viewer\"><header><div><span class=\"mission-eyebrow\">APPROACH SOURCE</span><h3 id=\"approachViewerTitle\">Approach</h3></div><button id=\"approachViewerClose\" type=\"button\">\u00d7</button></header><iframe id=\"approachViewerFrame\" title=\"Approach chart\"></iframe></dialog>\n\n<script type=\"module\">\nimport * as maplibregl from \"https://unpkg.com/maplibre-gl@6.1.0/dist/maplibre-gl.mjs\";\n\n(function(){\n\"use strict\";\n\nvar CENTER=[-83.5603,45.0781];\nvar TRAFFIC_POLL=20000;\nvar WEATHER_POLL=120000;\nvar MICH_COORDS=[[-91.10252, 47.59131], [-81.83658, 47.59131], [-81.83658, 41.23557], [-91.10252, 41.23557]];\nvar STYLE_URLS={\n  dark:\"https://tiles.openfreemap.org/styles/dark\",\n  light:\"https://tiles.openfreemap.org/styles/positron\",\n  liberty:\"https://tiles.openfreemap.org/styles/liberty\"\n};\nvar state={\n  range:100,base:\"aviation\",chartOpacity:.92,terminalCharts:false,satellite:false,satelliteOpacity:.88,\n  radar:false,radarOpacity:.66,radarLoop:false,radarFrameIndex:2,lightning:false,lightningOpacity:.72,\n  metars:true,tafs:true,pireps:true,sigmets:true,gairmets:true,cwas:false,tcf:false,\n  windFlow:false,icingFocus:false,turbulenceFocus:false,weatherAltitudeIndex:3,\n  sua:true,suaMoa:true,suaRestricted:true,suaProhibited:true,suaWarning:true,suaAlert:true,suaNsa:true,suaOther:false,\n  rings:false,labels:\"full\",trafficFilter:\"all\",altFilter:\"all\",vectors:true,coverageMode:\"fast\",clean:false\n};\nvar traffic=[],trafficMeta={sourceCount:0,attemptedSourceCount:0,sourceStats:[],uncappedTotal:0},weather={metars:[],tafs:[],pireps:[],gairmets:{type:\"FeatureCollection\",features:[]},sigmets:{type:\"FeatureCollection\",features:[]},cwas:{type:\"FeatureCollection\",features:[]},tcf:{type:\"FeatureCollection\",features:[]}},airspace={type:\"FeatureCollection\",features:[]};\nvar dataHealth={\n  traffic:{state:\"loading\",count:0,source:\"\",error:\"\"},\n  airports:{state:\"loading\",count:0,source:\"\",error:\"\"},\n  navaids:{state:\"loading\",count:0,source:\"\",error:\"\"},\n  weather:{state:\"loading\",count:0,source:\"\",error:\"\"},\n  airspace:{state:\"loading\",count:0,source:\"\",error:\"\"}\n};\nvar selected=null,selectedTrace=null,selectedRoute=null,selectedToken=0,selectedOverlay=null;\nvar nearbyNavaids=[];\nvar selectedAirport=null,airportTraffic=[],airportToken=0,airportDetail=null,airportProcedures=null,airportTab=\"overview\",airportLoad={detail:\"idle\",procedures:\"idle\",traffic:\"idle\"},airports=[],navaids=[];\nvar cameraMode=\"free\",cameraProgrammatic=false;\nvar sheetDetent=\"peek\",sheetDragging=false,sheetStartY=0,sheetStartHeight=0;\nvar lastTrafficAt=0,lastWeatherAt=0,trafficBusy=false,weatherBusy=false;\nvar trafficClock={\n  sourceTime:0,receivedAt:0,lastSuccessAt:0,lastAttemptAt:0,\n  positionMedianAtReceipt:null,positionFreshestAtReceipt:null,\n  failures:0,sameSnapshotCount:0,lastSourceTime:0,\n  stalePayload:false,direct:false,error:\"\",state:\"connecting\"\n};\nvar lastTrafficToastAt=0,trafficClearedForStale=false;\nvar trafficSnapshotKeyV71=\"ateflight-traffic-snapshot-v71\";\nvar trafficTimer=null,weatherTimer=null,radarLoopTimer=null,radarFrame=2,trafficViewportTimer=null,referenceViewportTimer=null,lastTrafficViewportKey=\"\",lastReferenceViewportKey=\"\",trafficRequestToken=0,referenceRequestToken=0,trafficCanvasFrame=0,canvasTargets=[];\nvar activePopup=null,weatherMapConfig=null,windsData={stations:[],levels:[]},windCanvasFrame=0,windScreenStations=[],windPhase=0;\nvar selectionStack=$(\"selectionStack\"),selectionStackToggle=$(\"selectionStackToggle\"),selectionStackList=$(\"selectionStackList\");\nvar panelTab=\"base\";\nvar prefsKey=\"ateflight-v71\";\n\nfunction $(id){return document.getElementById(id)}\nfunction updateVisualViewport(){\n  var h=window.visualViewport?window.visualViewport.height:window.innerHeight;\n  document.documentElement.style.setProperty(\"--visual-height\",Math.round(h)+\"px\")\n}\nfunction escapeHtml(s){return String(s==null?\"\":s).replace(/[&<>\"']/g,function(c){return({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#039;\"})[c]})}\n\nasync function fetchApiJson(url,options){\n  var response=await fetch(url,options||{});\n  var contentType=response.headers.get(\"content-type\")||\"\";\n  var text=await response.text();\n  var data={};\n\n  if(text){\n    try{\n      data=JSON.parse(text)\n    }catch(error){\n      var preview=text.replace(/\\s+/g,\" \").trim().slice(0,160);\n      throw new Error(\n        \"AteFlight API returned a non-JSON response (\"+\n        response.status+\n        (contentType?\" \u00b7 \"+contentType:\"\")+\n        \"). \"+preview\n      )\n    }\n  }\n\n  if(!response.ok){\n    var detail=\n      (data&&Array.isArray(data.errors)&&data.errors.length?data.errors.join(\" | \"):\"\")||\n      (data&&data.detail)||\n      (data&&data.error)||\n      (\"HTTP \"+response.status);\n    throw new Error(detail)\n  }\n\n  return{response:response,data:data}\n}\n\nfunction fetchApiResult(url,options){\n  return fetchApiJson(url,options).then(function(result){\n    return{ok:true,data:result.data,status:result.response.status}\n  }).catch(function(error){\n    return{ok:false,data:{error:String(error&&error.message||error)},status:0}\n  })\n}\n\nfunction clamp(v,a,b){return Math.max(a,Math.min(b,v))}\nfunction saveState(){try{localStorage.setItem(prefsKey,JSON.stringify(state))}catch(e){}}\nfunction loadState(){try{var p=JSON.parse(localStorage.getItem(prefsKey)||\"null\");if(p)Object.keys(state).forEach(function(k){if(p[k]!==undefined)state[k]=p[k]})}catch(e){}}\nfunction toast(text,bad){\n  var t=$(\"toast\");if(!text){t.style.display=\"none\";return}\n  t.className=\"toast\"+(bad?\" bad\":\"\");t.textContent=text;t.style.display=\"block\";\n  clearTimeout(toast._timer);toast._timer=setTimeout(function(){t.style.display=\"none\"},4300)\n}\nfunction setStatus(kind,text){\n  $(\"statusDot\").className=\"status-dot\"+(kind?\" \"+kind:\"\");$(\"statusText\").textContent=text\n}\n\nfunction trafficEpochMs(value){\n  if(value==null||value===\"\")return 0;\n  var parsed=typeof value===\"number\"?value:Date.parse(value);\n  if(!Number.isFinite(parsed))parsed=Number(value);\n  if(!Number.isFinite(parsed)||parsed<=0)return 0;\n  if(parsed>1e14)return Math.round(parsed/1000);\n  if(parsed>1e12)return Math.round(parsed);\n  if(parsed>1e9)return Math.round(parsed*1000);\n  return 0\n}\nfunction formatTrafficAge(seconds){\n  if(!Number.isFinite(seconds)||seconds<0)return\"\u2014\";\n  seconds=Math.round(seconds);\n  if(seconds<60)return seconds+\"s\";\n  var minutes=Math.floor(seconds/60),remaining=seconds%60;\n  if(minutes<60)return minutes+\"m \"+remaining+\"s\";\n  var hours=Math.floor(minutes/60);return hours+\"h \"+(minutes%60)+\"m\"\n}\nfunction sourceAgeSeconds(){\n  return trafficClock.sourceTime?Math.max(0,(Date.now()-trafficClock.sourceTime)/1000):Infinity\n}\nfunction positionMedianAgeSeconds(){\n  if(!Number.isFinite(trafficClock.positionMedianAtReceipt))return null;\n  return Math.max(0,trafficClock.positionMedianAtReceipt+(Date.now()-trafficClock.receivedAt)/1000)\n}\nfunction trafficFreshnessState(){\n  if(!trafficClock.lastSuccessAt)return trafficClock.lastAttemptAt?\"offline\":\"connecting\";\n  var sinceSuccess=(Date.now()-trafficClock.lastSuccessAt)/1000,sourceAge=sourceAgeSeconds(),positionAge=positionMedianAgeSeconds();\n  if(sinceSuccess>300)return\"offline\";\n  if(trafficClock.failures>0){\n    if(sinceSuccess<=120)return\"holding\";\n    return sourceAge>300?\"offline\":\"stale\"\n  }\n  if(trafficClock.stalePayload)return\"holding\";\n  if(trafficClock.sameSnapshotCount>=2&&sourceAge>45)return\"stalled\";\n  if(sourceAge>120||(Number.isFinite(positionAge)&&positionAge>120))return\"stale\";\n  if(sourceAge>35||(Number.isFinite(positionAge)&&positionAge>45))return\"delayed\";\n  return\"live\"\n}\nfunction refreshTrafficStatus(){\n  var stateNow=trafficFreshnessState(),source=String(trafficMeta.source||dataHealth.traffic.source||\"ADS-B\").toUpperCase();\n  trafficClock.state=stateNow;\n  if(stateNow===\"live\")setStatus(\"good\",\"LIVE \u00b7 \"+source);\n  else if(stateNow===\"delayed\")setStatus(\"\",\"DELAYED \u00b7 \"+source);\n  else if(stateNow===\"holding\")setStatus(\"\",\"HOLDING \u00b7 \"+source);\n  else if(stateNow===\"stalled\")setStatus(\"bad\",\"STALLED \u00b7 \"+source);\n  else if(stateNow===\"stale\")setStatus(\"bad\",\"STALE \u00b7 \"+source);\n  else if(stateNow===\"offline\")setStatus(\"bad\",\"ADS-B OFFLINE\");\n  else setStatus(\"\",\"CONNECTING\")\n}\nfunction recordTrafficSuccess(d,direct){\n  var now=Date.now(),sourceTime=trafficEpochMs(d.sourceTimestamp||d.generatedAt)||now;\n  trafficClock.sameSnapshotCount=trafficClock.lastSourceTime&&Math.abs(sourceTime-trafficClock.lastSourceTime)<1000?trafficClock.sameSnapshotCount+1:0;\n  trafficClock.lastSourceTime=sourceTime;trafficClock.sourceTime=sourceTime;\n  trafficClock.receivedAt=trafficEpochMs(d.receivedAt)||now;trafficClock.lastSuccessAt=now;trafficClock.lastAttemptAt=now;\n  trafficClock.positionMedianAtReceipt=d.positionAgeSec&&Number.isFinite(Number(d.positionAgeSec.median))?Number(d.positionAgeSec.median):null;\n  trafficClock.positionFreshestAtReceipt=d.positionAgeSec&&Number.isFinite(Number(d.positionAgeSec.freshest))?Number(d.positionAgeSec.freshest):null;\n  trafficClock.failures=0;trafficClock.stalePayload=!!d.stale;trafficClock.direct=!!direct;trafficClock.error=\"\";\n  lastTrafficAt=sourceTime;trafficClearedForStale=false;refreshTrafficStatus()\n}\nfunction recordTrafficFailure(error){\n  trafficClock.lastAttemptAt=Date.now();trafficClock.failures++;trafficClock.error=String(error&&error.message||error);refreshTrafficStatus();\n  if(Date.now()-lastTrafficToastAt>45000){lastTrafficToastAt=Date.now();toast(\"Traffic update failed \u00b7 holding last confirmed positions\",true)}\n}\n\n\nfunction saveTrafficSnapshotV71(d){\n  try{localStorage.setItem(trafficSnapshotKeyV71,JSON.stringify({savedAt:Date.now(),generatedAt:d.generatedAt||d.sourceTimestamp||null,source:d.source||\"ADS-B\",aircraft:(traffic||[]).slice(0,1500),meta:{positionAgeSec:d.positionAgeSec||null}}))}catch(e){}\n}\nfunction restoreTrafficSnapshotV71(){\n  try{var s=JSON.parse(localStorage.getItem(trafficSnapshotKeyV71)||\"null\");if(!s||!Array.isArray(s.aircraft)||Date.now()-Number(s.savedAt)>10*60*1000)return false;traffic=s.aircraft;prepareTrafficProjection(traffic);trafficMeta={source:s.source||\"SAVED ADS-B\",generatedAt:s.generatedAt,positionAgeSec:s.meta&&s.meta.positionAgeSec||null,stale:true};var sourceTime=trafficEpochMs(s.generatedAt)||Number(s.savedAt);trafficClock.sourceTime=sourceTime;trafficClock.receivedAt=Number(s.savedAt);trafficClock.lastSuccessAt=Number(s.savedAt);trafficClock.lastAttemptAt=Date.now();trafficClock.positionMedianAtReceipt=trafficMeta.positionAgeSec&&Number.isFinite(Number(trafficMeta.positionAgeSec.median))?Number(trafficMeta.positionAgeSec.median):null;trafficClock.failures=1;trafficClock.stalePayload=true;trafficClock.error=\"Showing last confirmed traffic while the live feed connects\";lastTrafficAt=sourceTime;dataHealth.traffic={state:\"warning\",count:traffic.length,source:s.source||\"Saved ADS-B\",error:\"Saved snapshot \u00b7 live refresh pending\"};refreshTrafficStatus();return true}catch(e){return false}\n}\n\nfunction aircraftName(a){return(a.flight&&String(a.flight).trim())||a.r||(a.hex?String(a.hex).toUpperCase():\"UNKNOWN\")}\nfunction altitude(a){\n  if(a.alt_baro===\"ground\")return\"GROUND\";\n  var n=Number(a.alt_baro!=null?a.alt_baro:a.alt_geom);return Number.isFinite(n)?Math.round(n).toLocaleString()+\" ft\":\"\u2014\"\n}\nfunction altitudeNumber(a){var n=Number(a.alt_baro!=null?a.alt_baro:a.alt_geom);return Number.isFinite(n)?n:null}\nfunction aircraftAge(a){var n=Number(a.seen_pos!=null?a.seen_pos:a.seen);return Number.isFinite(n)?Math.max(0,n):0}\nfunction isAirline(a){return/^[A-Z]{3}\\d+[A-Z]?$/.test((a.flight||\"\").trim())}\nfunction ceilingFromMetarClouds(m){\n  var clouds=m&&Array.isArray(m.clouds)?m.clouds:[],values=clouds.filter(function(c){return[\"BKN\",\"OVC\",\"VV\"].includes(String(c.cover||\"\").toUpperCase())&&Number.isFinite(Number(c.base))}).map(function(c){return Number(c.base)});return values.length?Math.min.apply(null,values):null\n}\nfunction resolvedFlightCategory(m){\n  var published=String(m&&m.fltCat||\"\").toUpperCase();if([\"VFR\",\"MVFR\",\"IFR\",\"LIFR\"].includes(published))return published;\n  var vis=Number(m&&m.visib),ceil=ceilingFromMetarClouds(m);\n  if((Number.isFinite(vis)&&vis<1)||(Number.isFinite(ceil)&&ceil<500))return\"LIFR\";\n  if((Number.isFinite(vis)&&vis<3)||(Number.isFinite(ceil)&&ceil<1000))return\"IFR\";\n  if((Number.isFinite(vis)&&vis<=5)||(Number.isFinite(ceil)&&ceil<=3000))return\"MVFR\";\n  return\"VFR\"\n}\nfunction flightCategoryColor(cat){\n  cat=String(cat||\"\").toUpperCase();\n  return cat===\"VFR\"?\"#3ed083\":cat===\"MVFR\"?\"#4b9dff\":cat===\"IFR\"?\"#ef5d63\":cat===\"LIFR\"?\"#b66cff\":\"#9aadb9\"\n}\nfunction distanceNm(lat1,lon1,lat2,lon2){\n  var R=3440.065,r=function(x){return x*Math.PI/180},p1=r(lat1),p2=r(lat2),dp=r(lat2-lat1),dl=r(lon2-lon1);\n  var h=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);\n  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)))\n}\nfunction destinationPoint(lon,lat,bearingDeg,distanceNmValue){\n  var R=3440.065,d=distanceNmValue/R,br=bearingDeg*Math.PI/180,p1=lat*Math.PI/180,l1=lon*Math.PI/180;\n  var p2=Math.asin(Math.sin(p1)*Math.cos(d)+Math.cos(p1)*Math.sin(d)*Math.cos(br));\n  var l2=l1+Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(p1),Math.cos(d)-Math.sin(p1)*Math.sin(p2));\n  return[(l2*180/Math.PI+540)%360-180,p2*180/Math.PI]\n}\nfunction rangeBoundsAt(center,nm){\n  var lng=Number(center.lng!=null?center.lng:center[0]),lat=Number(center.lat!=null?center.lat:center[1]);\n  var n=destinationPoint(lng,lat,0,nm),e=destinationPoint(lng,lat,90,nm),s=destinationPoint(lng,lat,180,nm),w=destinationPoint(lng,lat,270,nm);\n  return[[w[0],s[1]],[e[0],n[1]]]\n}\nfunction cameraPadding(extra){\n  var wide=window.innerWidth>900;\n  var left=56,right=16,top=16,bottom=48;\n  if(wide&&$(\"sidePanel\").classList.contains(\"open\"))left=392;if(wide&&plannerWorkspace.classList.contains(\"open\"))left=Math.max(left,530);if(wide&&libraryWorkspace.classList.contains(\"open\"))left=Math.max(left,600);\n  if(wide&&$(\"infoPanel\").classList.contains(\"open\"))right=410;if(wide&&flightStory.style.display!==\"none\"&&!flightStory.classList.contains(\"collapsed\"))right=Math.max(right,410);\n  if(!wide&&$(\"infoPanel\").classList.contains(\"open\"))bottom=Math.max(18,$(\"infoPanel\").getBoundingClientRect().height+12);\n  if(extra){left=Math.max(left,extra.left||0);right=Math.max(right,extra.right||0);top=Math.max(top,extra.top||0);bottom=Math.max(bottom,extra.bottom||0)}\n  return{left:left,right:right,top:top,bottom:bottom}\n}\nfunction fitRange(animate,center){\n  var c=center||map.getCenter();\n  map.fitBounds(rangeBoundsAt(c,state.range),{padding:cameraPadding(),duration:animate===false?0:420,maxZoom:11,linear:true})\n}\nfunction goHome(animate){\n  map.stop();\n  $(\"sidePanel\").classList.remove(\"open\");\n  document.querySelectorAll(\".rail-btn[data-open-tab]\").forEach(function(b){b.classList.remove(\"active\")});\n  $(\"infoPanel\").classList.remove(\"open\",\"airport-mode\");\n  $(\"bottomBar\").classList.remove(\"sheet-open\");\n  var nav=$(\"contextNav\");nav.className=\"context-nav\";nav.innerHTML=\"\";$(\"infoMeta\").innerHTML=\"\";\n  selected=null;selectedTrace=null;selectedRoute=null;selectedOverlay=null;selectedToken++;\n  selectedAirport=null;airportTraffic=[];airportDetail=null;airportProcedures=null;airportToken++;\n  cameraMode=\"kapn\";cameraProgrammatic=true;syncAllSources();\n  map.fitBounds(rangeBoundsAt({lng:CENTER[0],lat:CENTER[1]},state.range),{\n    padding:{left:56,right:16,top:16,bottom:48},duration:animate===false?0:520,maxZoom:11,linear:true\n  });\n  map.once(\"moveend\",function(){cameraProgrammatic=false;lastTrafficViewportKey=\"\";lastReferenceViewportKey=\"\";scheduleViewportLoad(true);toast(\"HOME \u00b7 KAPN\",false)});\n}\nfunction greatCircle(start,end,steps){\n  steps=steps||64;\n  var lon1=start[0]*Math.PI/180,lat1=start[1]*Math.PI/180,lon2=end[0]*Math.PI/180,lat2=end[1]*Math.PI/180;\n  var d=2*Math.asin(Math.sqrt(Math.sin((lat2-lat1)/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin((lon2-lon1)/2)**2));\n  if(!Number.isFinite(d)||d===0)return[start,end];\n  var out=[];\n  for(var i=0;i<=steps;i++){\n    var f=i/steps,A=Math.sin((1-f)*d)/Math.sin(d),B=Math.sin(f*d)/Math.sin(d);\n    var x=A*Math.cos(lat1)*Math.cos(lon1)+B*Math.cos(lat2)*Math.cos(lon2);\n    var y=A*Math.cos(lat1)*Math.sin(lon1)+B*Math.cos(lat2)*Math.sin(lon2);\n    var z=A*Math.sin(lat1)+B*Math.sin(lat2);\n    out.push([Math.atan2(y,x)*180/Math.PI,Math.atan2(z,Math.sqrt(x*x+y*y))*180/Math.PI])\n  }\n  return out\n}\nfunction blankChartStyle(color,name){\n  return{version:8,name:name,metadata:{_altStyle:name},sources:{},layers:[{id:\"background\",type:\"background\",paint:{\"background-color\":color}}]}\n}\nfunction styleForBase(base){\n  if([\"vfr\",\"ifr-low\",\"ifr-high\"].includes(base))return blankChartStyle(\"#e9e7df\",\"FAA Aeronautical Chart\");\n  if(base===\"light\")return STYLE_URLS.light;\n  if(base===\"dark\")return STYLE_URLS.dark;\n  return STYLE_URLS.liberty;\n}\nfunction firstSymbolLayer(){\n  var style=map.getStyle();if(!style||!style.layers)return undefined;\n  var layer=style.layers.find(function(l){return l.type===\"symbol\"});return layer&&layer.id\n}\nfunction addPlaneImage(){\n  if(map.hasImage(\"alt-plane\"))return;\n  var c=document.createElement(\"canvas\");c.width=48;c.height=48;var x=c.getContext(\"2d\");\n  x.translate(24,24);x.fillStyle=\"#f7fbfd\";x.strokeStyle=\"#071019\";x.lineWidth=2;\n  x.beginPath();x.moveTo(0,-17);x.lineTo(4,-4);x.lineTo(17,2);x.lineTo(17,6);x.lineTo(4,4);\n  x.lineTo(3,13);x.lineTo(9,17);x.lineTo(9,20);x.lineTo(0,17);x.lineTo(-9,20);x.lineTo(-9,17);\n  x.lineTo(-3,13);x.lineTo(-4,4);x.lineTo(-17,6);x.lineTo(-17,2);x.lineTo(-4,-4);x.closePath();x.fill();x.stroke();\n  map.addImage(\"alt-plane\",x.getImageData(0,0,48,48));\n\n  function addSvgAircraftIcon(name,svg){\n    if(map.hasImage(name))return;\n    var img=new Image(96,96);\n    img.onload=function(){\n      try{if(!map.hasImage(name))map.addImage(name,img,{pixelRatio:3})}catch(e){}\n    };\n    img.src=\"data:image/svg+xml;charset=utf-8,\"+encodeURIComponent(svg)\n  }\n  function aircraftSvg(body){\n    return'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\" viewBox=\"0 0 64 64\">'+\n      '<g fill=\"#f7fbfd\" stroke=\"#071019\" stroke-width=\"2.4\" stroke-linejoin=\"round\" stroke-linecap=\"round\">'+body+'</g></svg>'\n  }\n  addSvgAircraftIcon(\"plane-light\",aircraftSvg(\n    '<path d=\"M32 6 L36 24 L53 31 L53 35 L36 33 L35 48 L42 54 L42 57 L32 53 L22 57 L22 54 L29 48 L28 33 L11 35 L11 31 L28 24 Z\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-small\",aircraftSvg(\n    '<path d=\"M32 5 L36 23 L55 31 L55 35 L36 33 L35 47 L44 53 L44 57 L32 52 L20 57 L20 53 L29 47 L28 33 L9 35 L9 31 L28 23 Z\"/>'+\n    '<ellipse cx=\"20\" cy=\"33\" rx=\"2.5\" ry=\"4\"/><ellipse cx=\"44\" cy=\"33\" rx=\"2.5\" ry=\"4\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-large\",aircraftSvg(\n    '<path d=\"M32 4 C35 10 37 18 38 25 L57 32 L57 37 L38 34 L37 47 L47 53 L47 57 L32 52 L17 57 L17 53 L27 47 L26 34 L7 37 L7 32 L26 25 C27 18 29 10 32 4 Z\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-heavy\",aircraftSvg(\n    '<path d=\"M32 3 C36 10 39 19 40 26 L59 32 L59 38 L40 35 L39 47 L50 53 L50 58 L32 52 L14 58 L14 53 L25 47 L24 35 L5 38 L5 32 L24 26 C25 19 28 10 32 3 Z\"/>'+\n    '<ellipse cx=\"15\" cy=\"35\" rx=\"3\" ry=\"5\"/><ellipse cx=\"49\" cy=\"35\" rx=\"3\" ry=\"5\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-fast\",aircraftSvg(\n    '<path d=\"M32 4 L38 23 L53 44 L39 39 L37 52 L44 57 L44 60 L32 55 L20 60 L20 57 L27 52 L25 39 L11 44 L26 23 Z\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-rotor\",aircraftSvg(\n    '<path d=\"M28 14 L36 14 L38 39 L35 52 L29 52 L26 39 Z\"/>'+\n    '<path d=\"M10 23 L54 23 M32 7 L32 39 M37 45 L52 51\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-glider\",aircraftSvg(\n    '<path d=\"M32 6 L34 26 L59 31 L59 35 L34 33 L33 51 L39 56 L39 59 L32 56 L25 59 L25 56 L31 51 L30 33 L5 35 L5 31 L30 26 Z\"/>'\n  ));\n\n  if(!map.hasImage(\"preferred-runway-arrow\")){\n    var a=document.createElement(\"canvas\");a.width=68;a.height=38;var g=a.getContext(\"2d\");\n    g.translate(7,19);g.lineJoin=\"round\";g.strokeStyle=\"#061019\";g.lineWidth=6;\n    g.beginPath();g.moveTo(0,-6);g.lineTo(36,-6);g.lineTo(36,-14);g.lineTo(57,0);g.lineTo(36,14);g.lineTo(36,6);g.lineTo(0,6);g.closePath();g.stroke();\n    g.fillStyle=\"#7dffab\";g.fill();g.strokeStyle=\"#f3fff7\";g.lineWidth=2;g.stroke();\n    map.addImage(\"preferred-runway-arrow\",g.getImageData(0,0,68,38),{pixelRatio:2})\n  }\n}\nfunction emptyFC(){return{type:\"FeatureCollection\",features:[]}}\nfunction safeAddSource(id,source){if(!map.getSource(id))map.addSource(id,source)}\nfunction safeAddLayer(layer,before){if(!map.getLayer(layer.id))map.addLayer(layer,before)}\nfunction installLayers(){\n  addPlaneImage();\n  var before=firstSymbolLayer();\n\n  safeAddSource(\"michigan\",{type:\"image\",url:\"/assets/michigan_chart.webp\",coordinates:MICH_COORDS});\n  safeAddLayer({id:\"michigan\",type:\"raster\",source:\"michigan\",paint:{\"raster-opacity\":state.chartOpacity,\"raster-fade-duration\":0}},before);\n\n  safeAddSource(\"satellite\",{type:\"raster\",tiles:[\"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}\"],tileSize:256});\n  safeAddLayer({id:\"satellite\",type:\"raster\",source:\"satellite\",paint:{\"raster-opacity\":state.satelliteOpacity}},before);\n\n\n  safeAddSource(\"faa-vfr\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:8,maxzoom:12});\n  safeAddLayer({id:\"faa-vfr\",type:\"raster\",source:\"faa-vfr\",paint:{\"raster-opacity\":0.0,\"raster-fade-duration\":0,\"raster-resampling\":\"linear\"}},before);\n\n  safeAddSource(\"faa-terminal\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:10,maxzoom:12});\n  safeAddLayer({id:\"faa-terminal\",type:\"raster\",source:\"faa-terminal\",paint:{\"raster-opacity\":0.0,\"raster-fade-duration\":0,\"raster-resampling\":\"linear\"}},before);\n\n  safeAddSource(\"faa-ifr-low\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:7,maxzoom:12});\n  safeAddLayer({id:\"faa-ifr-low\",type:\"raster\",source:\"faa-ifr-low\",paint:{\"raster-opacity\":0,\"raster-fade-duration\":0,\"raster-resampling\":\"linear\"}},before);\n\n  safeAddSource(\"faa-ifr-high\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:3,maxzoom:12});\n  safeAddLayer({id:\"faa-ifr-high\",type:\"raster\",source:\"faa-ifr-high\",paint:{\"raster-opacity\":0,\"raster-fade-duration\":0,\"raster-resampling\":\"linear\"}},before);\n\n  safeAddSource(\"lightning\",{type:\"image\",url:transparentPixel(),coordinates:[[-90,50],[-80,50],[-80,40],[-90,40]]});\n  safeAddLayer({id:\"lightning\",type:\"raster\",source:\"lightning\",paint:{\"raster-opacity\":state.lightningOpacity,\"raster-fade-duration\":0}},before);\n\n  safeAddSource(\"airports\",{type:\"geojson\",data:emptyFC()});\n\n  // Progressive airport detail: only national hubs at continental zoom,\n  // reporting/regional fields at regional zoom, and small fields when close.\n  safeAddLayer({id:\"airport-wx-hub\",type:\"circle\",source:\"airports\",minzoom:3.5,maxzoom:6.0,\n    filter:[\"all\",[\"==\",[\"get\",\"hasMetar\"],true],[\"==\",[\"get\",\"hub\"],true]],paint:{\n      \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],3.5,3,6,4.2],\"circle-color\":[\"get\",\"wxColor\"],\n      \"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.4,\"circle-opacity\":0.96\n  }});\n  safeAddLayer({id:\"airport-hub\",type:\"circle\",source:\"airports\",minzoom:3.5,maxzoom:6.5,\n    filter:[\"all\",[\"==\",[\"get\",\"hub\"],true],[\"==\",[\"get\",\"hasMetar\"],false]],paint:{\n      \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],3.5,2.8,6.5,4.2],\"circle-color\":\"#0a141c\",\n      \"circle-stroke-color\":\"#72d8ff\",\"circle-stroke-width\":1.5\n  }});\n  safeAddLayer({id:\"airport-wx\",type:\"circle\",source:\"airports\",minzoom:6.0,filter:[\"==\",[\"get\",\"hasMetar\"],true],paint:{\n    \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],6,3.5,9,5,12,6.4],\"circle-color\":[\"get\",\"wxColor\"],\n    \"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.55,\"circle-opacity\":0.98\n  }});\n  safeAddLayer({id:\"airport-major\",type:\"circle\",source:\"airports\",minzoom:6.0,\n    filter:[\"all\",[\"==\",[\"get\",\"major\"],true],[\"==\",[\"get\",\"hasMetar\"],false]],paint:{\n      \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],6,3,10,4.8],\"circle-color\":\"#0a141c\",\n      \"circle-stroke-color\":[\"case\",[\"==\",[\"get\",\"scheduled\"],true],\"#58c7e8\",\"#c7d2d8\"],\n      \"circle-stroke-width\":[\"case\",[\"==\",[\"get\",\"scheduled\"],true],1.8,1.2]\n  }});\n  safeAddLayer({id:\"airport-small\",type:\"circle\",source:\"airports\",minzoom:9.25,\n    filter:[\"all\",[\"==\",[\"get\",\"major\"],false],[\"==\",[\"get\",\"hasMetar\"],false]],paint:{\n      \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],9.25,2.2,12,3.6],\"circle-color\":\"#0a141c\",\n      \"circle-stroke-color\":\"#91a4af\",\"circle-stroke-width\":1.0,\"circle-opacity\":0.92\n  }});\n  safeAddLayer({id:\"airport-hub-label\",type:\"symbol\",source:\"airports\",minzoom:4.5,maxzoom:7,\n    filter:[\"==\",[\"get\",\"hub\"],true],layout:{\"text-field\":[\"get\",\"label\"],\"text-size\":9.5,\"text-offset\":[.9,0],\"text-anchor\":\"left\",\"text-optional\":true},\n    paint:{\"text-color\":\"#e3edf2\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.5}});\n  safeAddLayer({id:\"airport-label\",type:\"symbol\",source:\"airports\",minzoom:7,\n    filter:[\"any\",[\"==\",[\"get\",\"major\"],true],[\"==\",[\"get\",\"hasMetar\"],true]],layout:{\n      \"text-field\":[\"get\",\"label\"],\"text-size\":[\"interpolate\",[\"linear\"],[\"zoom\"],7,9.2,10,11.2],\"text-offset\":[.9,0],\"text-anchor\":\"left\",\"text-optional\":true\n    },paint:{\"text-color\":\"#e0eaee\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.45}});\n  safeAddLayer({id:\"airport-small-label\",type:\"symbol\",source:\"airports\",minzoom:11,\n    filter:[\"all\",[\"==\",[\"get\",\"major\"],false],[\"==\",[\"get\",\"hasMetar\"],false]],layout:{\n      \"text-field\":[\"get\",\"label\"],\"text-size\":9.5,\"text-offset\":[.8,0],\"text-anchor\":\"left\",\"text-optional\":true\n    },paint:{\"text-color\":\"#aebfc9\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.2}});\n  safeAddLayer({id:\"airport-wind-arrow\",type:\"symbol\",source:\"airports\",minzoom:7.25,filter:[\"==\",[\"get\",\"windAvailable\"],true],layout:{\n    \"text-field\":\"\u279c\",\"text-size\":[\"interpolate\",[\"linear\"],[\"zoom\"],7.25,16,10,21],\"text-rotate\":[\"get\",\"windTo\"],\n    \"text-rotation-alignment\":\"map\",\"text-offset\":[0,-1.55],\"text-allow-overlap\":false,\"text-ignore-placement\":false\n  },paint:{\"text-color\":[\"get\",\"windColor\"],\"text-halo-color\":\"#061019\",\"text-halo-width\":2.4}});\n  safeAddLayer({id:\"airport-wind-label\",type:\"symbol\",source:\"airports\",minzoom:9.25,filter:[\"==\",[\"get\",\"windAvailable\"],true],layout:{\n    \"text-field\":[\"get\",\"windLabel\"],\"text-size\":9,\"text-offset\":[0,-2.45],\"text-anchor\":\"bottom\",\"text-optional\":true\n  },paint:{\"text-color\":[\"get\",\"windColor\"],\"text-halo-color\":\"#061019\",\"text-halo-width\":1.8}});\n\n  safeAddSource(\"selected-airport\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"selected-airport-halo\",type:\"circle\",source:\"selected-airport\",paint:{\n    \"circle-radius\":11,\"circle-color\":\"rgba(0,0,0,0)\",\"circle-stroke-color\":\"#ffc857\",\"circle-stroke-width\":2.4\n  }});\n  safeAddLayer({id:\"selected-airport-label\",type:\"symbol\",source:\"selected-airport\",layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":11,\"text-offset\":[0,1.25],\"text-anchor\":\"top\",\"text-allow-overlap\":true\n  },paint:{\"text-color\":\"#e5f8ff\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.5}});\n\n  safeAddSource(\"selected-runways\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"selected-runway-shadow\",type:\"line\",source:\"selected-runways\",paint:{\"line-color\":\"#071019\",\"line-width\":8,\"line-opacity\":0.72}});\n  safeAddLayer({id:\"selected-runways\",type:\"line\",source:\"selected-runways\",paint:{\"line-color\":\"#d5dee2\",\"line-width\":4.2,\"line-opacity\":0.95}});\n\n  safeAddSource(\"runway-ends\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"runway-end-labels\",type:\"symbol\",source:\"runway-ends\",layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":10,\"text-allow-overlap\":true\n  },paint:{\"text-color\":\"#eef4f6\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.6}});\n\n  safeAddSource(\"preferred-runway\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"preferred-runway-glow\",type:\"line\",source:\"preferred-runway\",paint:{\"line-color\":\"#59ff9b\",\"line-width\":12,\"line-opacity\":0.24,\"line-blur\":3}});\n  safeAddLayer({id:\"preferred-runway-line\",type:\"line\",source:\"preferred-runway\",paint:{\"line-color\":\"#7dffab\",\"line-width\":6.5,\"line-opacity\":0.98}});\n  safeAddLayer({id:\"preferred-runway-arrow\",type:\"symbol\",source:\"preferred-runway\",layout:{\n    \"symbol-placement\":\"line\",\"symbol-spacing\":58,\"icon-image\":\"preferred-runway-arrow\",\"icon-size\":1.0,\n    \"icon-rotation-alignment\":\"map\",\"icon-keep-upright\":false,\"icon-allow-overlap\":true,\"icon-ignore-placement\":true\n  }});\n\n  safeAddSource(\"airport-traffic\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"airport-ground\",type:\"circle\",source:\"airport-traffic\",filter:[\"==\",[\"get\",\"status\"],\"GROUND\"],paint:{\n    \"circle-radius\":5,\"circle-color\":\"#52d18c\",\"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.5\n  }});\n  safeAddLayer({id:\"airport-traffic-label\",type:\"symbol\",source:\"airport-traffic\",minzoom:9,layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":9.5,\"text-offset\":[1.0,0],\"text-anchor\":\"left\",\"text-optional\":true\n  },paint:{\"text-color\":\"#eef7fa\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.4}});\n\n  safeAddSource(\"goes\",{type:\"raster\",tiles:[\"https://gis.nnvl.noaa.gov/arcgis/rest/services/GOES/GOES_current/ImageServer/tile/{z}/{y}/{x}\"],tileSize:256});\n  safeAddLayer({id:\"goes\",type:\"raster\",source:\"goes\",paint:{\"raster-opacity\":0.28}},before);\n\n  safeAddSource(\"mrms\",{type:\"image\",url:transparentPixel(),coordinates:[[-90,50],[-80,50],[-80,40],[-90,40]]});\n  safeAddLayer({id:\"mrms\",type:\"raster\",source:\"mrms\",paint:{\"raster-opacity\":state.radarOpacity,\"raster-fade-duration\":0}},before);\n\n  safeAddSource(\"advisories\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"advisory-fill\",type:\"fill\",source:\"advisories\",paint:{\"fill-color\":[\"get\",\"color\"],\"fill-opacity\":0.10}});\n  safeAddLayer({id:\"advisory-line\",type:\"line\",source:\"advisories\",paint:{\"line-color\":[\"get\",\"color\"],\"line-width\":1.4,\"line-opacity\":0.85}});\n\n  safeAddSource(\"icing-focus\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"icing-focus-fill\",type:\"fill\",source:\"icing-focus\",paint:{\"fill-color\":\"#58c7e8\",\"fill-opacity\":0.20}});\n  safeAddLayer({id:\"icing-focus-line\",type:\"line\",source:\"icing-focus\",paint:{\"line-color\":\"#74ddff\",\"line-width\":2.1,\"line-opacity\":0.95}});\n  safeAddSource(\"turbulence-focus\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"turbulence-focus-fill\",type:\"fill\",source:\"turbulence-focus\",paint:{\"fill-color\":\"#ef9c4c\",\"fill-opacity\":0.18}});\n  safeAddLayer({id:\"turbulence-focus-line\",type:\"line\",source:\"turbulence-focus\",paint:{\"line-color\":\"#ffb25e\",\"line-width\":2.1,\"line-dasharray\":[3,1.5],\"line-opacity\":0.95}});\n\n  safeAddSource(\"special-use-airspace\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"sua-fill\",type:\"fill\",source:\"special-use-airspace\",paint:{\"fill-color\":[\"get\",\"color\"],\"fill-opacity\":[\"get\",\"fillOpacity\"]}});\n  safeAddLayer({id:\"sua-regulatory-line\",type:\"line\",source:\"special-use-airspace\",filter:[\"in\",[\"get\",\"family\"],[\"literal\",[\"RESTRICTED\",\"PROHIBITED\"]]],paint:{\"line-color\":[\"get\",\"color\"],\"line-width\":1.7,\"line-opacity\":0.92}});\n  safeAddLayer({id:\"sua-moa-line\",type:\"line\",source:\"special-use-airspace\",filter:[\"==\",[\"get\",\"family\"],\"MOA\"],paint:{\"line-color\":[\"get\",\"color\"],\"line-width\":1.6,\"line-dasharray\":[4,2],\"line-opacity\":0.9}});\n  safeAddLayer({id:\"sua-other-line\",type:\"line\",source:\"special-use-airspace\",filter:[\"!\",[\"in\",[\"get\",\"family\"],[\"literal\",[\"RESTRICTED\",\"PROHIBITED\",\"MOA\"]]]],paint:{\"line-color\":[\"get\",\"color\"],\"line-width\":1.35,\"line-dasharray\":[2,2],\"line-opacity\":0.82}});\n  safeAddLayer({id:\"sua-label\",type:\"symbol\",source:\"special-use-airspace\",minzoom:7.5,layout:{\"text-field\":[\"get\",\"name\"],\"text-size\":9,\"text-optional\":true,\"symbol-placement\":\"point\"},paint:{\"text-color\":[\"get\",\"color\"],\"text-halo-color\":\"#071019\",\"text-halo-width\":1.3}});\n\n  safeAddSource(\"selected-overlay\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"selected-overlay-fill\",type:\"fill\",source:\"selected-overlay\",paint:{\"fill-color\":[\"get\",\"color\"],\"fill-opacity\":0.18}});\n  safeAddLayer({id:\"selected-overlay-line\",type:\"line\",source:\"selected-overlay\",paint:{\"line-color\":[\"get\",\"color\"],\"line-width\":3,\"line-opacity\":1}});\n\n  safeAddSource(\"rings\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"rings\",type:\"line\",source:\"rings\",paint:{\"line-color\":\"#91a9b8\",\"line-width\":[\"case\",[\"==\",[\"get\",\"outer\"],true],1.3,0.8],\"line-opacity\":0.42}});\n\n  safeAddSource(\"route\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"route-shadow\",type:\"line\",source:\"route\",paint:{\"line-color\":\"#071019\",\"line-width\":4.5,\"line-opacity\":0.58}});\n  safeAddLayer({id:\"route-line\",type:\"line\",source:\"route\",paint:{\"line-color\":\"#65b9d8\",\"line-width\":1.8,\"line-dasharray\":[3,2],\"line-opacity\":0.82}});\n\n  safeAddSource(\"selected-trace\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"trace-shadow\",type:\"line\",source:\"selected-trace\",paint:{\"line-color\":\"#071019\",\"line-width\":5.5,\"line-opacity\":0.7}});\n  safeAddLayer({id:\"selected-trace\",type:\"line\",source:\"selected-trace\",paint:{\"line-color\":\"#61d1f0\",\"line-width\":2.4,\"line-opacity\":0.92}});\n\n  safeAddSource(\"route-airports\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"route-airport-dot\",type:\"circle\",source:\"route-airports\",paint:{\"circle-radius\":4.5,\"circle-color\":[\"get\",\"color\"],\"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.5}});\n  safeAddLayer({id:\"route-airport-label\",type:\"symbol\",source:\"route-airports\",layout:{\"text-field\":[\"get\",\"label\"],\"text-size\":10,\"text-offset\":[0,1.1],\"text-anchor\":\"top\",\"text-allow-overlap\":true},paint:{\"text-color\":\"#f3f7f9\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.5}});\n\n  safeAddSource(\"navaids\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"navaid-symbol\",type:\"symbol\",source:\"navaids\",minzoom:6.25,filter:[\"==\",[\"get\",\"major\"],true],layout:{\n    \"text-field\":[\"get\",\"symbol\"],\"text-size\":[\"interpolate\",[\"linear\"],[\"zoom\"],6.25,12,9,17],\"text-allow-overlap\":false,\n    \"text-offset\":[\"case\",[\"==\",[\"get\",\"collocated\"],true],[\"literal\",[0,-1.35]],[\"literal\",[0,0]]]\n  },paint:{\"text-color\":[\"get\",\"color\"],\"text-halo-color\":\"#071019\",\"text-halo-width\":1.45}});\n  safeAddLayer({id:\"navaid-label\",type:\"symbol\",source:\"navaids\",minzoom:7.5,filter:[\"==\",[\"get\",\"major\"],true],layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":[\"interpolate\",[\"linear\"],[\"zoom\"],7.5,9,10,11],\n    \"text-offset\":[\"case\",[\"==\",[\"get\",\"collocated\"],true],[\"literal\",[1.1,-1.35]],[\"literal\",[1.2,0]]],\n    \"text-anchor\":\"left\",\"text-optional\":true\n  },paint:{\"text-color\":\"#f1d37a\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.35}});\n  safeAddLayer({id:\"navaid-secondary-symbol\",type:\"symbol\",source:\"navaids\",minzoom:9.25,filter:[\"==\",[\"get\",\"major\"],false],layout:{\n    \"text-field\":[\"get\",\"symbol\"],\"text-size\":12,\"text-allow-overlap\":false,\n    \"text-offset\":[\"case\",[\"==\",[\"get\",\"collocated\"],true],[\"literal\",[0,-1.25]],[\"literal\",[0,0]]]\n  },paint:{\"text-color\":\"#beaa72\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.2}});\n  safeAddLayer({id:\"navaid-secondary-label\",type:\"symbol\",source:\"navaids\",minzoom:10.25,filter:[\"==\",[\"get\",\"major\"],false],layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":9,\n    \"text-offset\":[\"case\",[\"==\",[\"get\",\"collocated\"],true],[\"literal\",[1.0,-1.25]],[\"literal\",[1.1,0]]],\n    \"text-anchor\":\"left\",\"text-optional\":true\n  },paint:{\"text-color\":\"#cbbb87\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.2}});\n\n  safeAddSource(\"tafs\",{type:\"geojson\",data:emptyFC()});\n  return{type:\"FeatureCollection\",features:features}\n}\nfunction selectedAircraftData(){\n  if(!selected||!Number.isFinite(Number(selected.lat))||!Number.isFinite(Number(selected.lon)))return emptyFC();\n  return{type:\"FeatureCollection\",features:[aircraftFeature(selected,true)]}\n}\nfunction vectorData(){\n  var features=[];\n  if(!state.vectors)return{type:\"FeatureCollection\",features:features};\n  traffic.forEach(function(a){\n    if(!matchesTraffic(a)||!Number.isFinite(Number(a.lat))||!Number.isFinite(Number(a.lon)))return;\n    var gs=Number(a.gs),tr=Number(a.track);if(!Number.isFinite(gs)||!Number.isFinite(tr)||gs<20)return;\n    var end=destinationPoint(Number(a.lon),Number(a.lat),tr,gs/60);\n    features.push({type:\"Feature\",properties:{hex:a.hex},geometry:{type:\"LineString\",coordinates:[[Number(a.lon),Number(a.lat)],end]}})\n  });\n  return{type:\"FeatureCollection\",features:features}\n}\n\nvar trafficCanvas=$(\"trafficCanvas\"),trafficCtx=trafficCanvas.getContext(\"2d\",{alpha:true}),canvasHitGrid=new Map(),canvasHitCell=44,cursorCheckFrame=0,pendingCursorPoint=null;\nvar AIRCRAFT_PATHS={\n  \"plane-light\":new Path2D(\"M32 6 L36 24 L53 31 L53 35 L36 33 L35 48 L42 54 L42 57 L32 53 L22 57 L22 54 L29 48 L28 33 L11 35 L11 31 L28 24 Z\"),\n  \"plane-small\":new Path2D(\"M32 5 L36 23 L55 31 L55 35 L36 33 L35 47 L44 53 L44 57 L32 52 L20 57 L20 53 L29 47 L28 33 L9 35 L9 31 L28 23 Z\"),\n  \"plane-large\":new Path2D(\"M32 4 C35 10 37 18 38 25 L57 32 L57 37 L38 34 L37 47 L47 53 L47 57 L32 52 L17 57 L17 53 L27 47 L26 34 L7 37 L7 32 L26 25 C27 18 29 10 32 4 Z\"),\n  \"plane-heavy\":new Path2D(\"M32 3 C36 10 39 19 40 26 L59 32 L59 38 L40 35 L39 47 L50 53 L50 58 L32 52 L14 58 L14 53 L25 47 L24 35 L5 38 L5 32 L24 26 C25 19 28 10 32 3 Z\"),\n  \"plane-fast\":new Path2D(\"M32 4 L38 23 L53 44 L39 39 L37 52 L44 57 L44 60 L32 55 L20 60 L20 57 L27 52 L25 39 L11 44 L26 23 Z\"),\n  \"plane-rotor\":new Path2D(\"M28 14 L36 14 L38 39 L35 52 L29 52 L26 39 Z M10 23 L54 23 M32 7 L32 39 M37 45 L52 51\"),\n  \"plane-glider\":new Path2D(\"M32 6 L34 26 L59 31 L59 35 L34 33 L33 51 L39 56 L39 59 L32 56 L25 59 L25 56 L31 51 L30 33 L5 35 L5 31 L30 26 Z\")\n};\n\nfunction resizeTrafficCanvas(){\n  var rect=map.getContainer().getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2.25);\n  var w=Math.max(1,Math.round(rect.width*dpr)),h=Math.max(1,Math.round(rect.height*dpr));\n  if(trafficCanvas.width!==w||trafficCanvas.height!==h){trafficCanvas.width=w;trafficCanvas.height=h;trafficCanvas.style.width=rect.width+\"px\";trafficCanvas.style.height=rect.height+\"px\"}\n  trafficCtx.setTransform(dpr,0,0,dpr,0,0);return{w:rect.width,h:rect.height,dpr:dpr}\n}\nfunction mercatorNormalized(lon,lat){\n  var x=(Number(lon)+180)/360,rad=clamp(Number(lat),-85.051129,85.051129)*Math.PI/180;\n  var y=(1-Math.log(Math.tan(rad)+1/Math.cos(rad))/Math.PI)/2;return{x:x,y:y}\n}\nfunction prepareTrafficProjection(list){(list||[]).forEach(function(a){var p=mercatorNormalized(a.lon,a.lat);a.__mx=p.x;a.__my=p.y;a.__displayName=aircraftName(a);a.__altLabel=altitude(a).replace(\" ft\",\"\")})}\nfunction scheduleTrafficCanvasRender(){if(map&&map.loaded())map.triggerRepaint()}\nfunction canvasIconSize(z,cls){var base=z<4?5:z<5.5?6.5:z<7?8:z<9?10.5:13;return base*clamp((cls.scale||.5)/.5,.85,1.28)}\nfunction drawWideAircraft(ctx,x,y,track,size,selectedFlag){ctx.save();ctx.translate(x,y);ctx.rotate((Number(track)||0)*Math.PI/180);ctx.beginPath();ctx.moveTo(0,-size);ctx.lineTo(size*.58,size*.72);ctx.lineTo(0,size*.38);ctx.lineTo(-size*.58,size*.72);ctx.closePath();ctx.fillStyle=selectedFlag?\"#ffc857\":\"rgba(244,248,250,.94)\";ctx.strokeStyle=\"#061019\";ctx.lineWidth=1.2;ctx.fill();ctx.stroke();ctx.restore()}\nfunction drawAircraftPath(ctx,x,y,track,size,icon,selectedFlag){var p=AIRCRAFT_PATHS[icon]||AIRCRAFT_PATHS[\"plane-light\"];ctx.save();ctx.translate(x,y);ctx.rotate((Number(track)||0)*Math.PI/180);ctx.scale(size/64,size/64);ctx.translate(-32,-32);ctx.fillStyle=selectedFlag?\"#ffc857\":\"#f7fbfd\";ctx.strokeStyle=\"#061019\";ctx.lineWidth=Math.max(1.6,64/size*1.05);ctx.lineJoin=\"round\";ctx.lineCap=\"round\";ctx.fill(p);ctx.stroke(p);ctx.restore()}\nfunction hitGridAdd(target){\n  var cx=Math.floor(target.x/canvasHitCell),cy=Math.floor(target.y/canvasHitCell),key=cx+\":\"+cy,arr=canvasHitGrid.get(key);\n  if(!arr){arr=[];canvasHitGrid.set(key,arr)}arr.push(target)\n}\nfunction renderTrafficCanvas(){\n  if(!map||!map.loaded())return;\n  var size=resizeTrafficCanvas(),ctx=trafficCtx,z=map.getZoom(),mobile=isMobile(),center=map.getCenter(),centerMerc=mercatorNormalized(center.lng,center.lat),centerScreen=map.project(center),worldSize=512*Math.pow(2,z);\n  ctx.clearRect(0,0,size.w,size.h);canvasTargets=[];canvasHitGrid.clear();\n  var candidates=[],selectedItem=null;\n  traffic.forEach(function(a){\n    if(!matchesTraffic(a)||!Number.isFinite(a.__mx)||!Number.isFinite(a.__my))return;\n    var dx=a.__mx-centerMerc.x;if(dx>0.5)dx-=1;if(dx<-0.5)dx+=1;\n    var x=centerScreen.x+dx*worldSize,y=centerScreen.y+(a.__my-centerMerc.y)*worldSize;\n    if(x<-28||y<-28||x>size.w+28||y>size.h+28)return;\n    var item={a:a,x:x,y:y,selected:!!(selected&&selected.hex===a.hex)};\n    if(item.selected)selectedItem=item;else candidates.push(item)\n  });\n  var maxDraw=mobile?4200:7600;if(candidates.length>maxDraw)candidates=candidates.slice(candidates.length-maxDraw);\n  if(selectedItem)candidates.push(selectedItem);\n  var labelCells=new Set(),showCallsign=z>=6.4,showFull=z>=8.1;\n  ctx.font=(mobile?\"10px\":\"10.5px\")+\" -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\";ctx.textBaseline=\"middle\";\n  candidates.forEach(function(item){\n    var a=item.a,cls=emitterClass(a),iconSize=canvasIconSize(z,cls),selectedFlag=item.selected;\n    if(z<5.2)drawWideAircraft(ctx,item.x,item.y,a.track,iconSize,selectedFlag);else drawAircraftPath(ctx,item.x,item.y,a.track,iconSize,cls.icon,selectedFlag);\n    if(selectedFlag){ctx.beginPath();ctx.arc(item.x,item.y,iconSize*.9,0,Math.PI*2);ctx.strokeStyle=\"#ffc857\";ctx.lineWidth=2;ctx.stroke()}\n    var target={x:item.x,y:item.y,r:Math.max(10,iconSize),a:a};canvasTargets.push(target);hitGridAdd(target);\n    if((showCallsign||selectedFlag)&&state.labels!==\"none\"){\n      var key=Math.floor((item.x+18)/96)+\":\"+Math.floor(item.y/21);\n      if(selectedFlag||!labelCells.has(key)){\n        labelCells.add(key);var line1=a.__displayName||aircraftName(a),line2=showFull&&state.labels===\"full\"?(a.__altLabel||altitude(a).replace(\" ft\",\"\"))+\" \u00b7 \"+(Number.isFinite(Number(a.gs))?Math.round(Number(a.gs))+\"kt\":\"\u2014\"):\"\";\n        ctx.lineWidth=3.5;ctx.strokeStyle=\"#061019\";ctx.fillStyle=selectedFlag?\"#fff3c6\":\"#f4f8fa\";ctx.strokeText(line1,item.x+iconSize*.72+4,item.y-4);ctx.fillText(line1,item.x+iconSize*.72+4,item.y-4);\n        if(line2){ctx.font=(mobile?\"8.5px\":\"9px\")+\" -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\";ctx.fillStyle=\"#a8c0cc\";ctx.strokeText(line2,item.x+iconSize*.72+4,item.y+7);ctx.fillText(line2,item.x+iconSize*.72+4,item.y+7);ctx.font=(mobile?\"10px\":\"10.5px\")+\" -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\"}\n      }\n    }\n  })\n}\nfunction canvasAircraftAt(point){\n  var cx=Math.floor(point.x/canvasHitCell),cy=Math.floor(point.y/canvasHitCell),best=null,bestD=Infinity;\n  for(var x=cx-1;x<=cx+1;x++)for(var y=cy-1;y<=cy+1;y++){\n    var arr=canvasHitGrid.get(x+\":\"+y)||[];arr.forEach(function(t){var dx=t.x-point.x,dy=t.y-point.y,d=Math.sqrt(dx*dx+dy*dy);if(d<=t.r+6&&d<bestD){best=t.a;bestD=d}})\n  }\n  return best\n}\nfunction mapSelectableAt(point){\n  var ids=[\"metar-circle\",\"pirep-circle\",\"navaid-symbol\",\"navaid-secondary-symbol\",\"advisory-fill\",\"icing-focus-fill\",\"turbulence-focus-fill\",\"sua-fill\",\"airport-wx-hub\",\"airport-hub\",\"airport-wx\",\"airport-major\",\"airport-small\",\"airport-hub-label\",\"airport-label\",\"airport-small-label\",\"kapn-label\",\"route-airport-dot\"];\n  var existing=ids.filter(function(id){return map.getLayer(id)});return existing.length?map.queryRenderedFeatures(point,{layers:existing}).length>0:false\n}\nfunction markClickHandled(e){if(e&&e.originalEvent)e.originalEvent.__ateflightHandled=true}\nfunction clickWasHandled(e){return!!(e&&e.originalEvent&&e.originalEvent.__ateflightHandled)}\nfunction prioritizeAircraftClick(e){\n  var a=canvasAircraftAt(e.point);if(!a)return false;markClickHandled(e);selectAircraft(a);return true\n}\nfunction selectCanvasAircraftAt(point){var a=canvasAircraftAt(point);if(a){selectAircraft(a);return true}return false}\nfunction updateMapCursor(point){\n  pendingCursorPoint=point;if(cursorCheckFrame)return;\n  cursorCheckFrame=requestAnimationFrame(function(){\n    cursorCheckFrame=0;if(!pendingCursorPoint||map.isMoving())return;\n    map.getCanvas().style.cursor=(canvasAircraftAt(pendingCursorPoint)||mapSelectableAt(pendingCursorPoint))?\"pointer\":\"\"\n  })\n}\n\nfunction navaidSuppressionRadiusNm(){var z=map.getZoom();return z<6.5?10:z<8.5?4:z<10?1.5:0}\nfunction navaidData(){\n  var z=map.getZoom(),suppress=navaidSuppressionRadiusNm();\n  var airportPoints=airports.filter(function(a){return Number.isFinite(Number(a.lat))&&Number.isFinite(Number(a.lon))});\n  var features=[];\n  navaids.forEach(function(n){\n    if(!Number.isFinite(Number(n.lat))||!Number.isFinite(Number(n.lon)))return;\n    var nearest=null,nearestDistance=Infinity;\n    airportPoints.forEach(function(a){var d=distanceNm(Number(a.lat),Number(a.lon),Number(n.lat),Number(n.lon));if(d<nearestDistance){nearestDistance=d;nearest=a}});\n    var collocated=nearestDistance<=2.5;\n    // Collocated radio aids stay hidden at broad/local scales; at terminal\n    // scale they reappear with an intentional screen offset and amber identity.\n    if(collocated&&z<10)return;\n    if(!collocated&&suppress>0&&nearestDistance<suppress)return;\n    var type=String(n.type||\"\").toUpperCase(),major=/(VOR|VORTAC|VOR-DME|TACAN)/.test(type);\n    var symbol=type.includes(\"NDB\")?\"\u25b3\":type.includes(\"TACAN\")||type.includes(\"VORTAC\")?\"\u2726\":type.includes(\"VOR\")?\"\u25c7\":\"\u25a1\";\n    var freq=Number.isFinite(Number(n.frequencyKhz))?(Number(n.frequencyKhz)>=1000?(Number(n.frequencyKhz)/1000).toFixed(2):String(Math.round(Number(n.frequencyKhz)))):\"\";\n    features.push({type:\"Feature\",properties:{\n      ident:n.ident||\"\",label:\"NAVAID \u00b7 \"+(n.ident||\"\")+(freq?\"  \"+freq:\"\"),name:n.name||\"\",navaidType:type,\n      major:major,symbol:symbol,color:major?\"#f1d37a\":\"#beaa72\",collocated:collocated,\n      airportIdent:nearest&&(nearest.icao||nearest.gps||nearest.ident)||\"\",distanceAirportNm:Number.isFinite(nearestDistance)?nearestDistance:null,\n      raw:JSON.stringify(n)\n    },geometry:{type:\"Point\",coordinates:[Number(n.lon),Number(n.lat)]}})\n  });\n  return{type:\"FeatureCollection\",features:features}\n}\nfunction tafData(){\n  var airportByCode=new Map();airports.forEach(function(a){[a.icao,a.gps,a.ident,a.local].filter(Boolean).forEach(function(v){airportByCode.set(String(v).toUpperCase(),a)})});\n  return{type:\"FeatureCollection\",features:(weather.tafs||[]).map(function(t){\n    var lat=Number(t.lat),lon=Number(t.lon),ap=airportByCode.get(String(t.icaoId||\"\").toUpperCase());\n    if((!Number.isFinite(lat)||!Number.isFinite(lon))&&ap){lat=Number(ap.lat);lon=Number(ap.lon)}\n    if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;\n    return{type:\"Feature\",properties:{id:t.icaoId||\"\",kind:\"TAF_BADGE\",raw:JSON.stringify(t)},geometry:{type:\"Point\",coordinates:[lon,lat]}}\n  }).filter(Boolean)}\n}\nfunction metarData(){\n  var airportCodes=new Set();\n  airports.forEach(function(a){\n    [a.icao,a.gps,a.ident,a.local].filter(Boolean).forEach(function(v){airportCodes.add(String(v).toUpperCase())})\n  });\n  return{\n    type:\"FeatureCollection\",\n    features:(weather.metars||[]).filter(function(m){\n      return Number.isFinite(Number(m.lat))&&Number.isFinite(Number(m.lon))&&!airportCodes.has(String(m.icaoId||\"\").toUpperCase())\n    }).map(function(m){\n      return{\n        type:\"Feature\",\n        properties:{id:m.icaoId||\"\",category:resolvedFlightCategory(m),color:flightCategoryColor(resolvedFlightCategory(m)),raw:JSON.stringify(m)},\n        geometry:{type:\"Point\",coordinates:[Number(m.lon),Number(m.lat)]}\n      }\n    })\n  }\n}\nfunction pirepSeverity(p){\n  var t=[p.tbInt1,p.tbInt2,p.icgInt1,p.icgInt2,p.rawOb,p.rawText].filter(Boolean).join(\" \").toUpperCase();\n  if(t.includes(\"SEV\")||t.includes(\"EXTM\"))return{color:\"#ef6973\",label:\"SEV\"};\n  if(t.includes(\"MOD\"))return{color:\"#ef9c4c\",label:\"MOD\"};\n  if(t.includes(\"LGT\")||t.includes(\"TRC\"))return{color:\"#f0c35a\",label:\"LGT\"};\n  return{color:\"#58c7e8\",label:\"PIREP\"}\n}\nfunction pirepData(){\n  return{type:\"FeatureCollection\",features:(weather.pireps||[]).filter(function(p){return Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))}).map(function(p){\n    var sev=pirepSeverity(p);return{type:\"Feature\",properties:{color:sev.color,label:sev.label,raw:JSON.stringify(p)},geometry:{type:\"Point\",coordinates:[Number(p.lon),Number(p.lat)]}}\n  })}\n}\nfunction advisoryText(f){var p=f&&f.properties||{};return[p.hazard,p.hazardType,p.type,p.product,p.rawAirSigmet,p.rawText,p.raw,p.text].filter(Boolean).join(\" \").toUpperCase()}\nfunction advisoryAltitudeFeet(value){if(value===null||value===undefined||value===\"\")return null;var s=String(value).toUpperCase();if(s===\"SFC\")return 0;var n=Number(value);if(!Number.isFinite(n))return null;return n<=600?n*100:n}\nfunction advisoryIntersectsAltitude(f,alt){var p=f&&f.properties||{},low=advisoryAltitudeFeet(firstValue(p,[\"altitudeLow1\",\"altitudeLow\",\"base\",\"lower\",\"LOWER_VAL\"])),high=advisoryAltitudeFeet(firstValue(p,[\"altitudeHi1\",\"altitudeHigh\",\"top\",\"upper\",\"UPPER_VAL\"]));if(low===null&&high===null)return true;if(low===null)low=0;if(high===null)high=60000;return alt>=low&&alt<=high}\nfunction focusAdvisoryData(kind){\n  var all=[];[weather.gairmets,weather.sigmets].forEach(function(fc){(fc&&Array.isArray(fc.features)?fc.features:[]).forEach(function(f){var text=advisoryText(f),match=kind===\"icing\"?(/ICE|ICING|FZLVL|FREEZ/.test(text)):(/TURB|LLWS|WIND SHEAR/.test(text));if(match&&advisoryIntersectsAltitude(f,weatherAltitudeFt()))all.push(f)})});\n  return{type:\"FeatureCollection\",features:all}\n}\nfunction advisoryData(){\n  var out=[];\n  function push(fc,kind,enabled){\n    if(!enabled)return;\n    (fc&&Array.isArray(fc.features)?fc.features:[]).forEach(function(f,index){\n      var original=Object.assign({},f.properties||{}),p=Object.assign({},original),h=String(p.hazard||p.hazardType||p.type||p.product||kind).toUpperCase();\n      p.kind=kind;p.featureIndex=index;p.raw=JSON.stringify(original);\n      p.color=kind===\"TCF\"?\"#ff4f8a\":kind===\"CWA\"?\"#f0a84c\":kind===\"SIGMET\"||h.includes(\"CONV\")||h.includes(\"TS\")?\"#ef6973\":h.includes(\"ICE\")?\"#58c7e8\":h.includes(\"TURB\")?\"#ef9c4c\":h.includes(\"IFR\")?\"#b66cff\":\"#c7aa54\";\n      out.push({type:\"Feature\",properties:p,geometry:f.geometry})\n    })\n  }\n  push(weather.gairmets,\"G-AIRMET\",state.gairmets);push(weather.sigmets,\"SIGMET\",state.sigmets);push(weather.cwas,\"CWA\",state.cwas);push(weather.tcf,\"TCF\",state.tcf);\n  return{type:\"FeatureCollection\",features:out}\n}\nfunction suaFamily(p){\n  var code=String(p.TYPE_CODE||p.type_code||p.CLASS||p.class||\"\").toUpperCase(),name=String(p.NAME||p.name||\"\").toUpperCase();\n  if(code.includes(\"MOA\")||name.includes(\"MOA\"))return\"MOA\";\n  if(code===\"R\"||code.includes(\"RESTRICT\")||/^R-/.test(name))return\"RESTRICTED\";\n  if(code===\"P\"||code.includes(\"PROHIB\")||/^P-/.test(name))return\"PROHIBITED\";\n  if(code===\"W\"||code.includes(\"WARN\")||/^W-/.test(name))return\"WARNING\";\n  if(code===\"A\"||code.includes(\"ALERT\")||/^A-/.test(name))return\"ALERT\";\n  if(code.includes(\"NSA\")||name.includes(\"NATIONAL SECURITY\"))return\"NSA\";\n  return\"OTHER\"\n}\nfunction suaEnabled(family){\n  return family===\"MOA\"?state.suaMoa:family===\"RESTRICTED\"?state.suaRestricted:family===\"PROHIBITED\"?state.suaProhibited:family===\"WARNING\"?state.suaWarning:family===\"ALERT\"?state.suaAlert:family===\"NSA\"?state.suaNsa:state.suaOther\n}\nfunction parseSuaOffsetHours(value){var s=String(value||\"\").trim();if(!s)return null;var m=s.match(/([+-]?\\d{1,2})(?::?(\\d{2}))?/);if(!m)return null;var h=Number(m[1]),mins=Number(m[2]||0);return h+(h<0?-mins/60:mins/60)}\nfunction suaActivity(p,now){\n  var text=String(p.TIMESOFUSE||\"\").toUpperCase().replace(/\\s+/g,\" \").trim();if(!text)return{state:\"unknown\",label:\"SCHEDULE UNKNOWN\",detail:\"No published time-of-use text\"};\n  if(/H24|CONTINUOUS|24 HRS|24 HOURS/.test(text))return{state:\"scheduled-active\",label:\"SCHEDULED ACTIVE\",detail:text};\n  if(/NOTAM/.test(text))return{state:\"notam-dependent\",label:\"BY NOTAM \u00b7 UNCONFIRMED\",detail:text};\n  var offset=parseSuaOffsetHours(p.GMTOFFSET),d=new Date((now||Date.now())+(Number.isFinite(offset)?offset:0)*3600000),day=d.getUTCDay(),hhmm=d.getUTCHours()*100+d.getUTCMinutes();\n  var dayOk=true;\n  if(/MON\\s*[-\u2013]\\s*FRI|MON THRU FRI/.test(text))dayOk=day>=1&&day<=5;\n  else if(/MON\\s*[-\u2013]\\s*SAT/.test(text))dayOk=day>=1&&day<=6;\n  else if(/SAT\\s*[-\u2013]\\s*SUN/.test(text))dayOk=day===0||day===6;\n  var range=text.match(/\\b(\\d{4})\\s*[-\u2013]\\s*(\\d{4})\\b/),timeOk=true;\n  if(range){var start=Number(range[1]),end=Number(range[2]);timeOk=start<=end?(hhmm>=start&&hhmm<=end):(hhmm>=start||hhmm<=end)}\n  if(/SR|SS|SUNRISE|SUNSET/.test(text)&&!range)return{state:\"schedule-published\",label:\"PUBLISHED SCHEDULE\",detail:text};\n  return dayOk&&timeOk?{state:\"scheduled-active\",label:\"SCHEDULED ACTIVE\",detail:text}:{state:\"outside-schedule\",label:\"OUTSIDE PUBLISHED SCHEDULE\",detail:text}\n}\nfunction suaStyle(family){\n  return family===\"RESTRICTED\"?{color:\"#ef5d63\",fill:.07}:family===\"PROHIBITED\"?{color:\"#ff4f8a\",fill:.09}:family===\"MOA\"?{color:\"#ef9c4c\",fill:.055}:family===\"WARNING\"?{color:\"#e3a34e\",fill:.045}:family===\"ALERT\"?{color:\"#e7d05b\",fill:.04}:family===\"NSA\"?{color:\"#b66cff\",fill:.06}:{color:\"#8ea4b2\",fill:.035}\n}\nfunction suaData(){\n  if(!state.sua)return emptyFC();\n  var source=airspace&&Array.isArray(airspace.features)?airspace.features:[];\n  return{type:\"FeatureCollection\",features:source.filter(function(f){return suaEnabled(suaFamily(f.properties||{}))}).map(function(f,index){\n    var original=Object.assign({},f.properties||{}),family=suaFamily(original),style=suaStyle(family),activity=suaActivity(original,Date.now());\n    var opacity=activity.state===\"scheduled-active\"?Math.max(.20,style.fill*3.2):activity.state===\"notam-dependent\"?Math.max(.13,style.fill*2.2):activity.state===\"schedule-published\"?Math.max(.10,style.fill*1.8):Math.max(.035,style.fill*.75);\n    return{type:\"Feature\",properties:Object.assign({},original,{family:family,color:style.color,fillOpacity:opacity,activityState:activity.state,activityLabel:activity.label,activityDetail:activity.detail,name:original.NAME||original.name||family,raw:JSON.stringify(original),featureIndex:index}),geometry:f.geometry}\n  })}\n}\nfunction selectedOverlayData(){\n  if(!selectedOverlay||!selectedOverlay.feature)return emptyFC();\n  var f=selectedOverlay.feature,p=Object.assign({},f.properties||{});p.color=p.color||selectedOverlay.color||\"#58c7e8\";\n  return{type:\"FeatureCollection\",features:[{type:\"Feature\",properties:p,geometry:f.geometry}]}\n}\n\nfunction runwayHeadingFromIdent(ident){\n  var m=String(ident||\"\").match(/^(\\d{1,2})/);if(!m)return null;\n  var n=Number(m[1]);if(!Number.isFinite(n))return null;return n===36?360:n*10\n}\nfunction runwayCoordinates(r,ap){\n  var le=(Number.isFinite(Number(r.leLon))&&Number.isFinite(Number(r.leLat)))?[Number(r.leLon),Number(r.leLat)]:null;\n  var he=(Number.isFinite(Number(r.heLon))&&Number.isFinite(Number(r.heLat)))?[Number(r.heLon),Number(r.heLat)]:null;\n  if(le&&he)return{le:le,he:he};\n  var lengthNm=(Number(r.lengthFt)||3000)/6076.12,half=lengthNm/2;\n  var lh=Number(r.leHeading)||runwayHeadingFromIdent(r.leIdent)||0;\n  return{le:destinationPoint(Number(ap.lon),Number(ap.lat),(lh+180)%360,half),he:destinationPoint(Number(ap.lon),Number(ap.lat),lh,half)}\n}\nfunction runwayComponent(windDir,windSpeed,heading){\n  if(!Number.isFinite(windDir)||!Number.isFinite(windSpeed)||!Number.isFinite(heading))return null;\n  var diff=(windDir-heading)*Math.PI/180;\n  return{headwind:windSpeed*Math.cos(diff),crosswind:Math.abs(windSpeed*Math.sin(diff))}\n}\nfunction preferredRunwayInfo(ap,metar,runways){\n  if(!ap||!metar||!Array.isArray(runways)||!runways.length)return{available:false,reason:\"NO CURRENT WIND / RUNWAY DATA\"};\n  var windDir=Number(metar.wdir),windSpeed=Number(metar.wspd),gust=Number(metar.wgst);\n  if(!Number.isFinite(windDir)||!Number.isFinite(windSpeed))return{available:false,reason:\"VARIABLE OR UNAVAILABLE WIND\",windSpeed:windSpeed};\n  if(windSpeed<5)return{available:false,reason:\"CALM WIND \u2014 NO WIND-BASED PREFERENCE\",windDir:windDir,windSpeed:windSpeed,gust:Number.isFinite(gust)?gust:null};\n  var best=null;\n  runways.filter(function(r){return!r.closed}).forEach(function(r){\n    [[\"le\",r.leIdent,Number(r.leHeading)||runwayHeadingFromIdent(r.leIdent)],[\"he\",r.heIdent,Number(r.heHeading)||runwayHeadingFromIdent(r.heIdent)]].forEach(function(end){\n      var comp=runwayComponent(windDir,windSpeed,end[2]);if(!comp)return;\n      var candidate={available:true,runway:r,end:end[0],ident:end[1],heading:end[2],headwind:comp.headwind,crosswind:comp.crosswind,windDir:windDir,windSpeed:windSpeed,gust:Number.isFinite(gust)?gust:null};\n      if(!best||candidate.headwind>best.headwind||(Math.abs(candidate.headwind-best.headwind)<.1&&candidate.crosswind<best.crosswind))best=candidate\n    })\n  });\n  return best||{available:false,reason:\"NO OPEN RUNWAY DATA\",windDir:windDir,windSpeed:windSpeed}\n}\nfunction componentText(value){\n  if(!Number.isFinite(value))return\"\u2014\";return value>=0?\"HW \"+Math.round(value)+\" kt\":\"TW \"+Math.round(Math.abs(value))+\" kt\"\n}\nfunction runwayEndComponent(r,end,metar){\n  var h=end===\"le\"?(Number(r.leHeading)||runwayHeadingFromIdent(r.leIdent)):(Number(r.heHeading)||runwayHeadingFromIdent(r.heIdent));\n  return runwayComponent(Number(metar&&metar.wdir),Number(metar&&metar.wspd),h)\n}\nfunction selectedRunwayData(){\n  if(!selectedAirport||!airportDetail||!Array.isArray(airportDetail.runways))return emptyFC();\n  return{type:\"FeatureCollection\",features:airportDetail.runways.filter(function(r){return!r.closed}).map(function(r){var c=runwayCoordinates(r,selectedAirport);return{type:\"Feature\",properties:{label:[r.leIdent,r.heIdent].filter(Boolean).join(\" / \")},geometry:{type:\"LineString\",coordinates:[c.le,c.he]}}})}\n}\nfunction runwayEndData(){\n  if(!selectedAirport||!airportDetail||!Array.isArray(airportDetail.runways))return emptyFC();\n  var f=[];airportDetail.runways.filter(function(r){return!r.closed}).forEach(function(r){var c=runwayCoordinates(r,selectedAirport);if(r.leIdent)f.push({type:\"Feature\",properties:{label:r.leIdent},geometry:{type:\"Point\",coordinates:c.le}});if(r.heIdent)f.push({type:\"Feature\",properties:{label:r.heIdent},geometry:{type:\"Point\",coordinates:c.he}})});return{type:\"FeatureCollection\",features:f}\n}\nfunction preferredRunwayData(){\n  if(!selectedAirport||!airportDetail)return emptyFC();var p=preferredRunwayInfo(selectedAirport,airportMetar(selectedAirport),airportDetail.runways||[]);if(!p.available)return emptyFC();var c=runwayCoordinates(p.runway,selectedAirport),coords=p.end===\"le\"?[c.le,c.he]:[c.he,c.le];return{type:\"FeatureCollection\",features:[{type:\"Feature\",properties:{label:p.ident},geometry:{type:\"LineString\",coordinates:coords}}]}\n}\n\nfunction airportMetarMatch(a){\n  var candidates=[a.icao,a.gps,a.ident,a.local].filter(Boolean).map(function(v){return String(v).toUpperCase()});\n  return(weather.metars||[]).find(function(m){\n    var id=String(m.icaoId||\"\").toUpperCase();\n    return candidates.indexOf(id)>=0\n  })||null\n}\nfunction metarAutomation(m){\n  var raw=String(m&&m.rawOb||\"\").toUpperCase();\n  if(/\\bAO2A?\\b/.test(raw))return\"AO2\";\n  if(/\\bAO1A?\\b/.test(raw))return\"AO1\";\n  return\"\"\n}\nfunction airportData(){\n  return{\n    type:\"FeatureCollection\",\n    features:airports.map(function(a){\n      var hub=!!(a.scheduled||a.type===\"large_airport\"),regional=a.type===\"medium_airport\",major=hub||regional;\n      var m=airportMetarMatch(a);\n      return{\n        type:\"Feature\",\n        properties:{\n          id:a.id||\"\",ident:a.ident,label:a.icao||a.gps||a.ident||a.iata,\n          name:a.name,municipality:a.municipality||\"\",type:a.type,\n          elevationFt:a.elevationFt||0,scheduled:!!a.scheduled,hub:hub,regional:regional,major:major,\n          iata:a.iata||\"\",icao:a.icao||\"\",gps:a.gps||\"\",local:a.local||\"\",\n          hasMetar:!!m,wxColor:m?flightCategoryColor(resolvedFlightCategory(m)):\"#8da0ae\",\n          wxCat:m?resolvedFlightCategory(m):\"\",wxAutomation:m?metarAutomation(m):\"\",\n          wxWind:m&&Number.isFinite(Number(m.wspd))?((m.wdir||\"VRB\")+\"\u00b0 / \"+m.wspd+\" kt\"):\"\",\n          windAvailable:!!(m&&Number.isFinite(Number(m.wdir))&&Number.isFinite(Number(m.wspd))&&Number(m.wspd)>=3),\n          windTo:m&&Number.isFinite(Number(m.wdir))?(Number(m.wdir)+180)%360:0,\n          windLabel:m&&Number.isFinite(Number(m.wspd))?Math.round(Number(m.wspd))+(Number.isFinite(Number(m.wgst))?\"G\"+Math.round(Number(m.wgst)):\"\")+\"KT\":\"\",\n          windColor:m&&Number(m.wspd)>=20?\"#ff6b6f\":m&&Number(m.wspd)>=12?\"#ffd166\":\"#7dffab\",\n          wxRaw:m&&m.rawOb||\"\"\n        },\n        geometry:{type:\"Point\",coordinates:[Number(a.lon),Number(a.lat)]}\n      }\n    })\n  }\n}\nfunction selectedAirportData(){\n  if(!selectedAirport)return emptyFC();\n  return{type:\"FeatureCollection\",features:[{\n    type:\"Feature\",properties:{label:airportCode(selectedAirport)},\n    geometry:{type:\"Point\",coordinates:[selectedAirport.lon,selectedAirport.lat]}\n  }]}\n}\nfunction angleDiff(a,b){\n  var d=Math.abs(((a-b+540)%360)-180);return d\n}\nfunction bearingBetween(lat1,lon1,lat2,lon2){\n  var r=function(x){return x*Math.PI/180},D=function(x){return x*180/Math.PI};\n  var p1=r(lat1),p2=r(lat2),dl=r(lon2-lon1);\n  var y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);\n  return(D(Math.atan2(y,x))+360)%360\n}\nfunction movementFor(a,ap){\n  var lat=Number(a.lat),lon=Number(a.lon),d=distanceNm(ap.lat,ap.lon,lat,lon);\n  var gs=Number(a.gs),vr=Number(a.baro_rate),track=Number(a.track);\n  var ground=a.alt_baro===\"ground\"||(d<2.5&&Number.isFinite(gs)&&gs<45);\n  if(ground)return{status:\"GROUND\",distance:d};\n\n  if(Number.isFinite(track)){\n    var toward=bearingBetween(lat,lon,ap.lat,ap.lon),away=bearingBetween(ap.lat,ap.lon,lat,lon);\n    if(d<=35&&angleDiff(track,toward)<=50&&(vr<-100||d<12))return{status:\"ARRIVING\",distance:d};\n    if(d<=25&&angleDiff(track,away)<=55&&(vr>100||d<8))return{status:\"DEPARTING\",distance:d};\n  }\n  return{status:\"NEARBY\",distance:d}\n}\nfunction airportTrafficData(){\n  if(!selectedAirport)return emptyFC();\n  return{\n    type:\"FeatureCollection\",\n    features:airportTraffic.filter(function(a){return Number.isFinite(Number(a.lat))&&Number.isFinite(Number(a.lon))}).map(function(a){\n      var mv=movementFor(a,selectedAirport);\n      return{\n        type:\"Feature\",\n        properties:{hex:a.hex||\"\",label:aircraftName(a),status:mv.status},\n        geometry:{type:\"Point\",coordinates:[Number(a.lon),Number(a.lat)]}\n      }\n    })\n  }\n}\n\nfunction syncAllSources(){syncMissionMapV7();\n  if(map.getSource(\"rings\"))map.getSource(\"rings\").setData(ringData());\n  scheduleTrafficCanvasRender();\n  if(map.getSource(\"vectors\"))map.getSource(\"vectors\").setData(vectorData());\n  if(map.getSource(\"metars\"))map.getSource(\"metars\").setData(metarData());\n  if(map.getSource(\"pireps\"))map.getSource(\"pireps\").setData(pirepData());\n  if(map.getSource(\"advisories\"))map.getSource(\"advisories\").setData(advisoryData());\n  if(map.getSource(\"icing-focus\"))map.getSource(\"icing-focus\").setData(focusAdvisoryData(\"icing\"));\n  if(map.getSource(\"turbulence-focus\"))map.getSource(\"turbulence-focus\").setData(focusAdvisoryData(\"turbulence\"));\n  if(map.getSource(\"special-use-airspace\"))map.getSource(\"special-use-airspace\").setData(suaData());\n  if(map.getSource(\"selected-overlay\"))map.getSource(\"selected-overlay\").setData(selectedOverlayData());\n  if(map.getSource(\"navaids\"))map.getSource(\"navaids\").setData(navaidData());\n  if(map.getSource(\"tafs\"))map.getSource(\"tafs\").setData(tafData());\n  if(map.getSource(\"airports\"))map.getSource(\"airports\").setData(airportData());\n  if(map.getSource(\"selected-airport\"))map.getSource(\"selected-airport\").setData(selectedAirportData());\n  if(map.getSource(\"airport-traffic\"))map.getSource(\"airport-traffic\").setData(airportTrafficData());\n  if(map.getSource(\"selected-runways\"))map.getSource(\"selected-runways\").setData(selectedRunwayData());\n  if(map.getSource(\"runway-ends\"))map.getSource(\"runway-ends\").setData(runwayEndData());\n  if(map.getSource(\"preferred-runway\"))map.getSource(\"preferred-runway\").setData(preferredRunwayData());\n  syncSelectedSources()\n}\nfunction syncSelectedSources(){\n  if(map.getSource(\"selected-trace\")){\n    var coords=selectedTrace&&Array.isArray(selectedTrace.points)?selectedTrace.points.map(function(p){return[p.lon,p.lat]}):[];\n    map.getSource(\"selected-trace\").setData({type:\"FeatureCollection\",features:coords.length>1?[{type:\"Feature\",properties:{},geometry:{type:\"LineString\",coordinates:coords}}]:[]})\n  }\n  var routeFeatures=[],airportFeatures=[];\n  if(selectedRoute&&selectedRoute.route&&selected&&Number.isFinite(Number(selected.lon))&&Number.isFinite(Number(selected.lat))){\n    var dest=selectedRoute.route.destination,orig=selectedRoute.route.origin;\n    if(dest&&Number.isFinite(dest.lon)&&Number.isFinite(dest.lat)){\n      routeFeatures.push({type:\"Feature\",properties:{},geometry:{type:\"LineString\",coordinates:greatCircle([Number(selected.lon),Number(selected.lat)],[dest.lon,dest.lat],72)}});\n      airportFeatures.push({type:\"Feature\",properties:{label:dest.iata||dest.icao||\"DEST\",color:\"#58c7e8\"},geometry:{type:\"Point\",coordinates:[dest.lon,dest.lat]}})\n    }\n    if(orig&&Number.isFinite(orig.lon)&&Number.isFinite(orig.lat))airportFeatures.push({type:\"Feature\",properties:{label:orig.iata||orig.icao||\"ORIG\",color:\"#8da0ae\"},geometry:{type:\"Point\",coordinates:[orig.lon,orig.lat]}})\n  }\n  if(map.getSource(\"route\"))map.getSource(\"route\").setData({type:\"FeatureCollection\",features:routeFeatures});\n  if(map.getSource(\"route-airports\"))map.getSource(\"route-airports\").setData({type:\"FeatureCollection\",features:airportFeatures})\n}\nvar CHART_META={\n  vfr:{title:\"VFR SECTIONAL\",edition:\"FAA AIS \u00b7 Current 56-day chart\",min:8,max:12},\n  \"ifr-low\":{title:\"IFR LOW ENROUTE\",edition:\"FAA AIS \u00b7 Current 56-day chart\",min:7,max:12},\n  \"ifr-high\":{title:\"IFR HIGH ENROUTE\",edition:\"FAA AIS \u00b7 Current 56-day chart\",min:3,max:12}\n};\nfunction applyMapZoomConstraints(animate){\n  var meta=CHART_META[state.base];\n  if(!meta){map.setMinZoom(2);map.setMaxZoom(18);return}\n  var minDisplay=Math.max(2,meta.min-.2),maxDisplay=meta.max+.25;\n  map.setMinZoom(minDisplay);map.setMaxZoom(maxDisplay);\n  var z=map.getZoom(),target=clamp(z,minDisplay,maxDisplay);\n  if(Math.abs(target-z)>.01)map.easeTo({zoom:target,duration:animate===false?0:260})\n}\nfunction zoomContext(){\n  var z=map.getZoom();\n  if(z<5.25)return\"CONTINENTAL\";\n  if(z<7.25)return\"REGIONAL\";\n  if(z<9.25)return\"LOCAL\";\n  return\"TERMINAL\"\n}\nfunction updateDetailContext(){\n  var label=zoomContext();\n  $(\"barContext\").textContent=label;\n  $(\"detailModeBadge\").textContent=\"AUTO DETAIL \u00b7 \"+label;\n}\nfunction updateMapModeUI(){\n  document.querySelectorAll(\"[data-map-mode]\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.mapMode===state.base)});\n  var badge=$(\"chartBadge\"),meta=CHART_META[state.base],legend=$(\"aviationLegend\");\n  badge.classList.toggle(\"open\",!!meta);legend.classList.toggle(\"open\",state.base===\"aviation\");\n  if(meta){\n    var z=map.getZoom(),over=z>meta.max+.05,under=z<meta.min-.05;\n    badge.classList.toggle(\"overzoom\",over||under);\n    $(\"chartBadgeTitle\").textContent=meta.title+(over?\" \u00b7 OVERZOOM\":under?\" \u00b7 OVERVIEW\":\"\");\n    $(\"chartBadgeMeta\").textContent=meta.edition+\" \u00b7 NATIVE Z\"+meta.min+\"\u2013\"+meta.max+((over||under)?\" \u00b7 CURRENT Z\"+z.toFixed(1):\"\")\n  }\n}\nfunction snapChartNativeZoom(){\n  var meta=CHART_META[state.base];if(!meta)return;\n  var target=clamp(map.getZoom(),meta.min,meta.max);map.easeTo({zoom:target,duration:320})\n}\nfunction setBase(base){\n  state.base=base;saveState();\n  document.querySelectorAll(\"[data-map-mode]\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.mapMode===base)});\n  map.setStyle(styleForBase(base),{diff:false});\n  setTimeout(function(){applyMapZoomConstraints(true)},0)\n}\nfunction afterStyleLoad(){\n  if(map.getStyle())map.getStyle().metadata=Object.assign({},map.getStyle().metadata||{},{_altStyle:styleForBase(state.base)});\n  installLayers();installMissionLayersV7();syncVisibility();syncAllSources();syncMissionMapV7();applyMapZoomConstraints(true);if(state.radar)updateRadarImage();if(state.lightning)updateLightningImage();renderPanel();updateMapModeUI()\n}\nfunction setSourceData(id,data){var s=map.getSource(id);if(s&&s.setData)s.setData(data)}\nfunction selectionLayersV71(){\n  return{\n    airports:[\"airport-wx-hub\",\"airport-hub\",\"airport-wx\",\"airport-major\",\"airport-small\",\"airport-hub-label\",\"airport-label\",\"airport-small-label\",\"kapn-label\"],\n    navaids:[\"navaid-symbol\",\"navaid-secondary-symbol\",\"navaid-label\",\"navaid-secondary-label\"],\n    observations:[\"metar-circle\",\"metar-label\",\"pirep-circle\",\"pirep-label\"],\n    weather:[\"advisory-fill\",\"icing-focus-fill\",\"turbulence-focus-fill\"],\n    airspace:[\"sua-fill\"]\n  }\n}\nfunction selectionBoxV71(point,r){return[[point.x-r,point.y-r],[point.x+r,point.y+r]]}\nfunction canvasAircraftCandidatesV71(point,radius){\n  var cx=Math.floor(point.x/canvasHitCell),cy=Math.floor(point.y/canvasHitCell),cells=Math.ceil(radius/canvasHitCell)+1,found=new Map();\n  for(var x=cx-cells;x<=cx+cells;x++)for(var y=cy-cells;y<=cy+cells;y++){\n    (canvasHitGrid.get(x+\":\"+y)||[]).forEach(function(t){var dx=t.x-point.x,dy=t.y-point.y,d=Math.sqrt(dx*dx+dy*dy);if(d<=radius+t.r){var key=t.a.hex||aircraftName(t.a);if(!found.has(key)||d<found.get(key).distance)found.set(key,{aircraft:t.a,distance:d})}})\n  }\n  return Array.from(found.values()).sort(function(a,b){return a.distance-b.distance})\n}\nfunction airportFromFeatureV71(feature){\n  var p=feature&&feature.properties||{},ident=String(p.ident||p.icao||p.gps||p.label||\"\").toUpperCase();\n  if(String(feature&&feature.layer&&feature.layer.id||\"\")===\"kapn-label\")ident=\"KAPN\";\n  return airports.find(function(a){return[a.ident,a.icao,a.gps,a.iata,a.local].filter(Boolean).some(function(v){return String(v).toUpperCase()===ident})})||null\n}\nfunction navaidPopupV71(feature){\n  try{var n=JSON.parse(feature.properties.raw),freq=Number.isFinite(Number(n.frequencyKhz))?(Number(n.frequencyKhz)>=1000?(Number(n.frequencyKhz)/1000).toFixed(2)+\" MHz\":Math.round(Number(n.frequencyKhz))+\" kHz\"):\"Frequency unavailable\";dismissActivePopup();activePopup=new maplibregl.Popup({closeButton:true,offset:12}).setLngLat(feature.geometry.coordinates).setHTML(\"<div class='navaid-popup'><div style='font-size:8px;color:#f1d37a;font-weight:900;letter-spacing:.1em'>NAVAID</div><strong>\"+escapeHtml(n.ident||\"NAVAID\")+\" \u00b7 \"+escapeHtml(n.type||\"\")+\"</strong><br><span>\"+escapeHtml(n.name||\"\")+\" \u00b7 \"+escapeHtml(freq)+\"</span></div>\").addTo(map);activePopup.on(\"close\",function(){activePopup=null})}catch(e){}\n}\nfunction selectionCandidatesV71(point){\n  var mobile=isMobile(),radius=mobile?24:13,box=selectionBoxV71(point,radius),layers=selectionLayersV71(),candidates=[],seen=new Set();\n  function add(key,rank,kind,label,detail,activate){if(!key||seen.has(key))return;seen.add(key);candidates.push({key:key,rank:rank,kind:kind,label:label,detail:detail||\"\",activate:activate})}\n  var airportLayerIds=layers.airports.filter(function(id){return map.getLayer(id)});\n  if(airportLayerIds.length)map.queryRenderedFeatures(box,{layers:airportLayerIds}).forEach(function(f){var ap=airportFromFeatureV71(f);if(ap)add(\"airport:\"+(ap.id||airportCode(ap)),0,\"AIRPORT\",airportCode(ap),ap.name||\"Airport\",function(){selectAirport(ap)})});\n  canvasAircraftCandidatesV71(point,radius).forEach(function(item){var a=item.aircraft;add(\"aircraft:\"+(a.hex||aircraftName(a)),10,\"AIRCRAFT\",aircraftName(a),[a.r,a.t,altitude(a)].filter(Boolean).join(\" \u00b7 \"),function(){selectAircraft(a)})});\n  var navaidIds=layers.navaids.filter(function(id){return map.getLayer(id)});if(navaidIds.length)map.queryRenderedFeatures(box,{layers:navaidIds}).forEach(function(f){var p=f.properties||{},key=\"navaid:\"+(p.ident||p.label||f.id||JSON.stringify(f.geometry));add(key,20,\"NAVAID\",p.ident||p.label||\"Navaid\",p.navaidType||p.name||\"Radio aid\",function(){navaidPopupV71(f)})});\n  var obsIds=layers.observations.filter(function(id){return map.getLayer(id)});if(obsIds.length)map.queryRenderedFeatures(box,{layers:obsIds}).forEach(function(f){var id=f.layer.id,p=f.properties||{};if(id.indexOf(\"metar\")===0)add(\"metar:\"+(p.id||f.id),30,\"WEATHER\",p.id||\"METAR\",\"Current observation\",function(){try{showMetar(JSON.parse(p.raw))}catch(e){}});else add(\"pirep:\"+(f.id||p.label||JSON.stringify(f.geometry)),31,\"PIREP\",p.label||\"PIREP\",\"Pilot report\",function(){try{showPirep(JSON.parse(p.raw))}catch(e){}})});\n  var wxIds=layers.weather.filter(function(id){return map.getLayer(id)});if(wxIds.length)map.queryRenderedFeatures(box,{layers:wxIds}).forEach(function(f){var p=f.properties||{},kind=p.kind||\"WEATHER\";add(\"wx:\"+kind+\":\"+(p.featureIndex||f.id||JSON.stringify(f.geometry)),40,kind,p.hazard||p.hazardType||p.type||kind,\"Weather advisory\",function(){showAdvisoryFeature(f)})});\n  var suaIds=layers.airspace.filter(function(id){return map.getLayer(id)});if(suaIds.length)map.queryRenderedFeatures(box,{layers:suaIds}).forEach(function(f){var p=f.properties||{};add(\"sua:\"+(p.name||p.NAME||p.featureIndex||f.id),50,\"AIRSPACE\",p.name||p.NAME||p.family||\"Special use airspace\",p.activityLabel||p.family||\"Published airspace\",function(){showSuaFeature(f)})});\n  return candidates.sort(function(a,b){return a.rank-b.rank})\n}\nfunction hideSelectionStackV71(){selectionStack.hidden=true;selectionStackList.hidden=true;selectionStackList.innerHTML=\"\"}\nfunction showSelectionStackV71(candidates,point){\n  var others=candidates.slice(1);if(!others.length){hideSelectionStackV71();return}\n  selectionStack.hidden=false;selectionStackList.hidden=true;selectionStackToggle.textContent=\"ALSO HERE \u00b7 \"+others.length;\n  selectionStack.style.left=Math.min(map.getContainer().clientWidth-330,Math.max(8,point.x+12))+\"px\";selectionStack.style.top=Math.min(map.getContainer().clientHeight-190,Math.max(8,point.y+12))+\"px\";\n  selectionStackList.innerHTML=others.map(function(c,i){return\"<button class='selection-option' data-selection-index='\"+i+\"' type='button'><span class='kind'>\"+escapeHtml(c.kind)+\"</span><span><strong>\"+escapeHtml(c.label)+\"</strong><span>\"+escapeHtml(c.detail)+\"</span></span></button>\"}).join(\"\");\n  selectionStackToggle.onclick=function(e){e.stopPropagation();selectionStackList.hidden=!selectionStackList.hidden};\n  document.querySelectorAll(\"[data-selection-index]\").forEach(function(b){b.onclick=function(e){e.stopPropagation();var c=others[Number(b.dataset.selectionIndex)];hideSelectionStackV71();if(c)c.activate()}})\n}\nfunction resolveMapSelectionV71(e){\n  if(clickWasHandled(e))return;var candidates=selectionCandidatesV71(e.point);\n  if(candidates.length){markClickHandled(e);dismissActivePopup();candidates[0].activate();showSelectionStackV71(candidates,e.point);return}\n  hideSelectionStackV71();dismissActivePopup();if($(\"infoPanel\").classList.contains(\"open\"))closeInfo()\n}\nfunction bindLayerEvents(){\n  if(bindLayerEvents.done)return;bindLayerEvents.done=true;\n  map.on(\"click\",resolveMapSelectionV71);\n  map.on(\"movestart\",hideSelectionStackV71);\n}\n\nvar WEATHER_ALTITUDES=[0,3000,6000,9000,12000,18000,24000,30000,34000,39000];\nfunction weatherAltitudeFt(){return WEATHER_ALTITUDES[clamp(Number(state.weatherAltitudeIndex)||0,0,WEATHER_ALTITUDES.length-1)]}\nfunction weatherAltitudeText(){var v=weatherAltitudeFt();return v===0?\"SFC\":v>=18000?\"FL\"+String(Math.round(v/100)).padStart(3,\"0\"):v.toLocaleString()+\" FT\"}\nfunction updateWeatherAltitudeUi(){if($(\"weatherAltitudeLabel\"))$(\"weatherAltitudeLabel\").textContent=weatherAltitudeText();if($(\"weatherAltitudeSlider\"))$(\"weatherAltitudeSlider\").value=String(state.weatherAltitudeIndex);$(\"weatherAltitude\").classList.toggle(\"on\",state.windFlow||state.icingFocus||state.turbulenceFocus)}\nfunction windStationCoordinates(id){var key=String(id||\"\").toUpperCase(),ap=airports.find(function(a){return[a.iata,a.local,a.ident,a.icao,a.gps].filter(Boolean).some(function(v){var s=String(v).toUpperCase();return s===key||s.slice(-3)===key})});return ap&&Number.isFinite(Number(ap.lat))&&Number.isFinite(Number(ap.lon))?[Number(ap.lon),Number(ap.lat)]:null}\nfunction windSamplesForAltitude(){\n  var alt=weatherAltitudeFt(),samples=[];\n  if(alt===0){(weather.metars||[]).forEach(function(m){var dir=Number(m.wdir),speed=Number(m.wspd);if(Number.isFinite(dir)&&Number.isFinite(speed)&&Number.isFinite(Number(m.lat))&&Number.isFinite(Number(m.lon)))samples.push({lon:Number(m.lon),lat:Number(m.lat),dir:dir,speed:speed})})}\n  else{(windsData.stations||[]).forEach(function(s){var levels=Object.keys(s.winds||{}).map(Number).filter(Number.isFinite);if(!levels.length)return;var nearest=levels.reduce(function(a,b){return Math.abs(b-alt)<Math.abs(a-alt)?b:a}),w=s.winds[String(nearest)],coord=windStationCoordinates(s.id);if(w&&coord)samples.push({lon:coord[0],lat:coord[1],dir:Number(w.dir)||0,speed:Number(w.speed)||0,tempC:w.tempC,level:nearest})})}\n  return samples\n}\nfunction prepareWindScreenStations(){windScreenStations=windSamplesForAltitude().map(function(s){var p=map.project([s.lon,s.lat]);return Object.assign({},s,{x:p.x,y:p.y})}).filter(function(s){return Number.isFinite(s.x)&&Number.isFinite(s.y)})}\nfunction nearestWindAt(x,y){var best=null,bestD=Infinity;windScreenStations.forEach(function(s){var dx=s.x-x,dy=s.y-y,d=dx*dx+dy*dy;if(d<bestD){bestD=d;best=s}});return best}\nvar windCanvas=$(\"windCanvas\"),windCtx=windCanvas.getContext(\"2d\",{alpha:true});\nfunction resizeWindCanvas(){var rect=map.getContainer().getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);var w=Math.max(1,Math.round(rect.width*dpr)),h=Math.max(1,Math.round(rect.height*dpr));if(windCanvas.width!==w||windCanvas.height!==h){windCanvas.width=w;windCanvas.height=h;windCanvas.style.width=rect.width+\"px\";windCanvas.style.height=rect.height+\"px\"}windCtx.setTransform(dpr,0,0,dpr,0,0);return{w:rect.width,h:rect.height}}\nfunction renderWindFlow(){\n  windCanvasFrame=0;if(!state.windFlow){windCtx.clearRect(0,0,windCanvas.width,windCanvas.height);return}\n  var size=resizeWindCanvas();windCtx.clearRect(0,0,size.w,size.h);if(!windScreenStations.length)prepareWindScreenStations();\n  windPhase=(windPhase+.9)%56;windCtx.strokeStyle=\"rgba(117,218,255,.55)\";windCtx.fillStyle=\"rgba(184,240,255,.72)\";windCtx.lineWidth=1.15;\n  var step=isMobile()?78:64;\n  for(var y=34;y<size.h;y+=step)for(var x=34;x<size.w;x+=step){var w=nearestWindAt(x,y);if(!w)continue;var angle=((w.dir+90)%360)*Math.PI/180,len=clamp(8+w.speed*.18,10,28),phase=((x+y+windPhase)%step)/step,ox=Math.cos(angle)*(phase-.5)*step*.55,oy=Math.sin(angle)*(phase-.5)*step*.55;windCtx.beginPath();windCtx.moveTo(x+ox-Math.cos(angle)*len*.45,y+oy-Math.sin(angle)*len*.45);windCtx.lineTo(x+ox+Math.cos(angle)*len*.55,y+oy+Math.sin(angle)*len*.55);windCtx.stroke();windCtx.beginPath();windCtx.arc(x+ox+Math.cos(angle)*len*.55,y+oy+Math.sin(angle)*len*.55,1.4,0,Math.PI*2);windCtx.fill()}\n  windCanvasFrame=requestAnimationFrame(renderWindFlow)\n}\nfunction scheduleWindFlow(){prepareWindScreenStations();if(windCanvasFrame)cancelAnimationFrame(windCanvasFrame);windCanvasFrame=requestAnimationFrame(renderWindFlow)}\nasync function loadWinds(){if(!state.windFlow)return;try{var c=map.getCenter(),result=await fetchApiJson(\"/api/winds?lat=\"+encodeURIComponent(c.lat)+\"&lon=\"+encodeURIComponent(c.lng)+\"&fcst=06\",{cache:\"no-store\"});windsData=result.data||{stations:[],levels:[]};scheduleWindFlow()}catch(e){windsData={stations:[],levels:[]};toast(\"Winds aloft unavailable: \"+String(e.message||e),true)}}\n\nfunction updateArcgisMapImage(sourceId,serviceUrl){\n  var source=map.getSource(sourceId);if(!source)return;\n  var b=map.getBounds(),nw=[b.getWest(),b.getNorth()],ne=[b.getEast(),b.getNorth()],se=[b.getEast(),b.getSouth()],sw=[b.getWest(),b.getSouth()];\n  function merc(lon,lat){var R=6378137,x=R*lon*Math.PI/180,y=R*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));return[x,y]}\n  var p1=merc(b.getWest(),b.getSouth()),p2=merc(b.getEast(),b.getNorth()),box=map.getContainer(),w=Math.min(1400,Math.max(420,box.clientWidth)),h=Math.min(1000,Math.max(320,box.clientHeight));\n  var q=\"bbox=\"+encodeURIComponent([p1[0],p1[1],p2[0],p2[1]].join(\",\"))+\"&bboxSR=3857&imageSR=3857&size=\"+Math.round(w)+\",\"+Math.round(h)+\"&format=png32&transparent=true&f=image\";\n  source.updateImage({url:serviceUrl+\"/export?\"+q,coordinates:[nw,ne,se,sw]})\n}\nfunction updateLightningImage(){\n  if(!state.lightning)return;\n  updateArcgisMapImage(\"lightning\",\"https://nowcoast.noaa.gov/arcgis/rest/services/nowcoast/sat_meteo_emulated_imagery_lightningstrikedensity_goes_time/MapServer\")\n}\nfunction radarTimelineFrames(){return[{offset:-10,kind:\"observed\",label:\"-10 MIN\"},{offset:-5,kind:\"observed\",label:\"-5 MIN\"},{offset:0,kind:\"observed\",label:\"NOW\"},{offset:15,kind:\"forecast\",label:\"+15 MIN\"},{offset:30,kind:\"forecast\",label:\"+30 MIN\"},{offset:45,kind:\"forecast\",label:\"+45 MIN\"},{offset:60,kind:\"forecast\",label:\"+60 MIN\"}]}\nfunction arcgisImageGeometry(){var b=map.getBounds(),nw=[b.getWest(),b.getNorth()],ne=[b.getEast(),b.getNorth()],se=[b.getEast(),b.getSouth()],sw=[b.getWest(),b.getSouth()];function merc(lon,lat){var R=6378137,x=R*lon*Math.PI/180,y=R*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));return[x,y]}var p1=merc(b.getWest(),b.getSouth()),p2=merc(b.getEast(),b.getNorth()),size=map.getContainer(),w=Math.min(1400,Math.max(400,size.clientWidth)),h=Math.min(1000,Math.max(300,size.clientHeight));return{coords:[nw,ne,se,sw],bbox:[p1[0],p1[1],p2[0],p2[1]],w:w,h:h}}\nfunction observedRadarUrl(timeMs){var g=arcgisImageGeometry(),q=\"bbox=\"+encodeURIComponent(g.bbox.join(\",\"))+\"&bboxSR=3857&imageSR=3857&size=\"+Math.round(g.w)+\",\"+Math.round(g.h)+\"&format=png32&transparent=true&f=image\";if(timeMs)q+=\"&time=\"+encodeURIComponent(timeMs);return{url:\"https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer/exportImage?\"+q,coordinates:g.coords}}\nfunction forecastPrecipUrl(timeMs){if(!weatherMapConfig||!weatherMapConfig.precipitationLayer)return null;var g=arcgisImageGeometry(),q=\"bbox=\"+encodeURIComponent(g.bbox.join(\",\"))+\"&bboxSR=3857&imageSR=3857&size=\"+Math.round(g.w)+\",\"+Math.round(g.h)+\"&format=png32&transparent=true&f=image&layers=show:\"+encodeURIComponent(weatherMapConfig.precipitationLayer.id)+\"&time=\"+encodeURIComponent(timeMs);return{url:weatherMapConfig.serviceUrl+\"/export?\"+q,coordinates:g.coords}}\nasync function ensureWeatherMapConfig(){if(weatherMapConfig)return weatherMapConfig;try{var result=await fetchApiJson(\"/api/weather-map-config\",{cache:\"no-store\"});weatherMapConfig=result.data;return weatherMapConfig}catch(e){return null}}\nasync function showRadarTimelineFrame(index){\n  var frames=radarTimelineFrames();index=clamp(Number(index)||0,0,frames.length-1);state.radarFrameIndex=index;radarFrame=index;var frame=frames[index],source=map.getSource(\"mrms\");if(!state.radar||!source)return;\n  $(\"radarTimelineSlider\").value=String(index);$(\"radarTimelineLabel\").textContent=frame.label;$(\"radarTimelineMode\").textContent=frame.kind===\"observed\"?\"OBSERVED MRMS RADAR\":\"NDFD FORECAST PRECIPITATION\";\n  var image;if(frame.kind===\"observed\")image=observedRadarUrl(frame.offset===0?null:Date.now()+frame.offset*60000);else{await ensureWeatherMapConfig();image=forecastPrecipUrl(Date.now()+frame.offset*60000)}\n  if(!image){source.updateImage({url:transparentPixel(),coordinates:[[map.getBounds().getWest(),map.getBounds().getNorth()],[map.getBounds().getEast(),map.getBounds().getNorth()],[map.getBounds().getEast(),map.getBounds().getSouth()],[map.getBounds().getWest(),map.getBounds().getSouth()]]});$(\"radarTimelineMode\").textContent=\"FORECAST PRECIPITATION UNAVAILABLE\";return}\n  source.updateImage(image);saveState()\n}\nfunction updateRadarImage(){if(state.radar)showRadarTimelineFrame(state.radarFrameIndex)}\nfunction setRadarLoop(on){state.radarLoop=!!on;clearInterval(radarLoopTimer);radarLoopTimer=null;$(\"radarTimelinePlay\").textContent=state.radarLoop?\"\u2161\":\"\u25b6\";if(on){radarLoopTimer=setInterval(function(){state.radarFrameIndex=(state.radarFrameIndex+1)%radarTimelineFrames().length;showRadarTimelineFrame(state.radarFrameIndex)},950)}saveState();renderPanel()}\n\n\nfunction healthClass(item){return item.state===\"ok\"?\"ok\":item.state===\"loading\"?\"warn\":\"bad\"}\nfunction healthLabel(item){return item.state===\"loading\"?\"LOADING\":item.state===\"ok\"?String(item.count||0):\"ERROR\"}\nfunction statusServiceHtml(title,item){\n  return\"<div class='status-service \"+healthClass(item)+\"'><i></i><div><strong>\"+escapeHtml(title)+\"</strong><span>\"+escapeHtml(item.error||item.source||\"Waiting for data\")+\"</span></div><em>\"+escapeHtml(healthLabel(item))+\"</em></div>\"\n}\nfunction systemStatusHtml(){\n  var features=[\"Aircraft\",\"Airports\",\"METAR\",\"TAF\",\"Navaids\",\"VFR charts\",\"IFR Low\",\"IFR High\",\"Radar\",\"Satellite\",\"Lightning\",\"PIREPs\",\"Advisories\",\"Special use airspace\",\"Runways\",\"Comms\",\"Procedures\"];\n  return\"<section class='panel-section'><div class='section-label'>LIVE DATA SERVICES</div><div class='status-grid'>\"+\n    statusServiceHtml(\"ADS-B traffic\",dataHealth.traffic)+\n    statusServiceHtml(\"Airport catalogue\",dataHealth.airports)+\n    statusServiceHtml(\"Navaid catalogue\",dataHealth.navaids)+\n    statusServiceHtml(\"Aviation weather\",dataHealth.weather)+\n    statusServiceHtml(\"Special use airspace\",dataHealth.airspace)+\n    \"</div></section><section class='panel-section'><div class='section-label'>EXPECTED PRODUCT FEATURES</div><div class='feature-checklist'>\"+\n    features.map(function(f){return\"<span>\u2713 \"+escapeHtml(f)+\"</span>\"}).join(\"\")+\n    \"</div><div class='layer-note'><strong>Diagnostic endpoint</strong><br><code>/api/status?live=1</code> performs a live KAPN-area smoke test of traffic, airports, navaids and weather.</div></section>\"\n}\n\nfunction featureBoundsSimple(feature){\n  var bounds=null;\n  function visit(value){\n    if(!Array.isArray(value))return;\n    if(value.length>=2&&Number.isFinite(Number(value[0]))&&Number.isFinite(Number(value[1]))){\n      var lon=Number(value[0]),lat=Number(value[1]);\n      if(!bounds)bounds={west:lon,east:lon,south:lat,north:lat};else{bounds.west=Math.min(bounds.west,lon);bounds.east=Math.max(bounds.east,lon);bounds.south=Math.min(bounds.south,lat);bounds.north=Math.max(bounds.north,lat)}\n    }else value.forEach(visit)\n  }\n  visit(feature&&feature.geometry&&feature.geometry.coordinates);return bounds\n}\nfunction featureIntersectsMap(feature){\n  var b=featureBoundsSimple(feature);if(!b)return false;var m=map.getBounds();return!(b.east<m.getWest()||b.west>m.getEast()||b.north<m.getSouth()||b.south>m.getNorth())\n}\nfunction advisorySummary(f){\n  var p=f.properties||{},kind=p.kind||\"ADVISORY\",haz=firstValue(p,[\"hazard\",\"hazardType\",\"type\",\"product\"])||kind;\n  return{title:String(haz).toUpperCase(),sub:kind+\" \u00b7 \"+(formatTimeValue(firstValue(p,[\"validTimeTo\",\"validTo\",\"endTime\"]))||\"ACTIVE\"),color:p.color||\"#c7aa54\"}\n}\nfunction visibleAdvisoryFeatures(){return advisoryData().features.filter(featureIntersectsMap).slice(0,24)}\nfunction visibleAdvisoryListHtml(){\n  var list=visibleAdvisoryFeatures();\n  return'<section class=\"panel-section\" style=\"margin-top:14px\"><div class=\"section-label\">VISIBLE WEATHER HAZARDS <span class=\"layer-count\">'+list.length+'</span></div><div class=\"hazard-list\">'+(list.length?list.map(function(f,i){var s=advisorySummary(f);return'<button class=\"layer-detail-row\" data-advisory-index=\"'+i+'\" type=\"button\"><i style=\"background:'+escapeHtml(s.color)+'\"></i><span><strong>'+escapeHtml(s.title)+'</strong><span>'+escapeHtml(s.sub)+'</span></span><em>DETAILS</em></button>'}).join(''):'<div class=\"route-note\">No enabled weather hazards intersect the current map.</div>')+'</div></section>'\n}\nfunction visibleSuaFeatures(){return suaData().features.filter(featureIntersectsMap).slice(0,40)}\nfunction visibleSuaListHtml(){\n  var list=visibleSuaFeatures();\n  return'<section class=\"panel-section\" style=\"margin-top:14px\"><div class=\"section-label\">VISIBLE SPECIAL USE AIRSPACE <span class=\"layer-count\">'+list.length+'</span></div><div class=\"airspace-list\">'+(list.length?list.map(function(f,i){var p=f.properties||{};return'<button class=\"layer-detail-row\" data-sua-index=\"'+i+'\" type=\"button\"><i style=\"background:'+escapeHtml(p.color||\"#8ea4b2\")+'\"></i><span><strong>'+escapeHtml(p.name||p.family||\"SUA\")+'</strong><span>'+escapeHtml(p.family||\"SPECIAL USE AIRSPACE\")+'</span></span><em>DETAILS</em></button>'}).join(''):'<div class=\"route-note\">No enabled SUA intersects the current map.</div>')+'</div></section>'\n}\n\nfunction renderPanel(){\n  var scroll=$(\"panelScroll\");\n  document.querySelectorAll(\".panel-tab\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.tab===panelTab)});\n  $(\"panelSubtitle\").textContent=panelTab===\"base\"?\"Professional aviation chart modes\":panelTab===\"weather\"?\"NOAA observations and weather hazards\":panelTab===\"airspace\"?\"FAA special use airspace\":panelTab===\"traffic\"?\"Traffic symbology and filtering\":\"Live feature and data-source health\";\n  if(panelTab===\"base\"){\n    scroll.innerHTML='<section class=\"panel-section\"><div class=\"section-label\">PRIMARY AVIATION MAPS</div><div class=\"choice-grid\">'+\n      choice(\"aviation\",\"AVIATION\",\"Airports, navaids and geographic context\")+choice(\"vfr\",\"VFR SECTIONAL\",\"Official FAA sectional \u00b7 chart only\")+choice(\"ifr-low\",\"IFR LOW\",\"FAA low enroute \u00b7 below FL180\")+choice(\"ifr-high\",\"IFR HIGH\",\"FAA high enroute \u00b7 FL180 and above\")+\n      '</div><div class=\"layer-note\"><strong>FAA chart quality</strong><br>Official cached FAA AIS raster tiles are kept inside their native zoom envelope so labels and linework stay crisp.</div></section>'+\n      (state.base===\"vfr\"?row(\"Terminal Area Charts\",\"Optional TAC overlay where published\",toggle(\"terminalCharts\",state.terminalCharts)):\"\")+\n      '<section class=\"panel-section\"><div class=\"section-label\">ALTERNATE BASES</div><div class=\"choice-grid\">'+choice(\"satellite\",\"SATELLITE\",\"Esri World Imagery\")+choice(\"michigan\",\"MICHIGAN AERO\",\"Uploaded 2026 MDOT chart\")+choice(\"liberty\",\"LIBERTY\",\"Full OpenFreeMap vector map\")+choice(\"dark\",\"DARK\",\"Low-light vector map\")+'</div></section>'+\n      row(\"Michigan opacity\",\"Uploaded Michigan raster only\",\"<input id=\\'chartOpacity\\' class=\\'range-input\\' type=\\'range\\' min=\\'25\\' max=\\'100\\' value=\\'\"+Math.round(state.chartOpacity*100)+\"\\'>\")+\n      row(\"Satellite opacity\",\"Esri imagery base\",\"<input id=\\'satOpacity\\' class=\\'range-input\\' type=\\'range\\' min=\\'25\\' max=\\'100\\' value=\\'\"+Math.round(state.satelliteOpacity*100)+\"\\'>\");\n  }else if(panelTab===\"weather\"){\n    scroll.innerHTML='<div class=\"layer-note\"><strong>Polygon selection</strong><br>Aircraft always have click priority. Turn SIGMETs or G-AIRMETs off independently below, or open a visible hazard from the list.</div>'+row(\"NOAA MRMS radar\",\"Current composite base reflectivity\",toggle(\"radar\",state.radar))+\n      row(\"Radar opacity\",\"Overlay intensity\",\"<input id=\\'radarOpacity\\' class=\\'range-input\\' type=\\'range\\' min=\\'20\\' max=\\'100\\' value=\\'\"+Math.round(state.radarOpacity*100)+\"\\'>\")+\n      row(\"Weather timeline\",\"Observed radar -10 min through forecast precipitation +60 min\",toggle(\"radarLoop\",state.radarLoop))+\n      row(\"Clouds \u00b7 GOES infrared\",\"NOAA/NESDIS cloud imagery\",toggle(\"satellite\",state.satellite))+\n      row(\"Wind flow\",\"Animated surface or FB 6-hour forecast winds\",toggle(\"windFlow\",state.windFlow))+\n      row(\"Icing at selected altitude\",\"Highlights icing advisories intersecting the altitude selector\",toggle(\"icingFocus\",state.icingFocus))+\n      row(\"Turbulence at selected altitude\",\"Highlights turbulence advisories intersecting the altitude selector\",toggle(\"turbulenceFocus\",state.turbulenceFocus))+\n      row(\"Lightning density\",\"NOAA nowCOAST GOES / GLM composite\",toggle(\"lightning\",state.lightning))+\n      row(\"Lightning opacity\",\"Strike-density overlay\",\"<input id=\\'lightningOpacity\\' class=\\'range-input\\' type=\\'range\\' min=\\'20\\' max=\\'100\\' value=\\'\"+Math.round(state.lightningOpacity*100)+\"\\'>\")+\n      row(\"Airport METAR colors\",\"VFR / MVFR / IFR / LIFR\",toggle(\"metars\",state.metars))+\n      row(\"PIREPs\",\"Pilot reports\",toggle(\"pireps\",state.pireps))+\n      row(\"SIGMETs\",\"Severe or significant aviation weather\",toggle(\"sigmets\",state.sigmets))+\n      row(\"G-AIRMETs\",\"Graphical icing, turbulence, IFR and surface advisories\",toggle(\"gairmets\",state.gairmets))+\n      row(\"Center Weather Advisories\",\"CWA polygons\",toggle(\"cwas\",state.cwas))+\n      row(\"TFM Convective Forecast\",\"TCF convective polygons\",toggle(\"tcf\",state.tcf))+\n      '<div class=\"weather-legend-row\"><span><i style=\"background:#3ed083\"></i>VFR</span><span><i style=\"background:#4b9dff\"></i>MVFR</span><span><i style=\"background:#ef5d63\"></i>IFR</span><span><i style=\"background:#b66cff\"></i>LIFR</span><span><i style=\"background:#f0a84c\"></i>CWA</span><span><i style=\"background:#ff4f8a\"></i>TCF</span></div>'+visibleAdvisoryListHtml();\n  }else if(panelTab===\"airspace\"){\n    scroll.innerHTML='<div class=\"layer-note\"><strong>FAA published boundaries</strong><br>Toggle each SUA family independently. Aircraft remain the first selectable object when symbols overlap a polygon.</div>'+row(\"Special use airspace\",\"Master visibility for FAA SUA boundaries\",toggle(\"sua\",state.sua))+\n      row(\"Military Operations Areas\",\"Nonregulatory military training airspace\",toggle(\"suaMoa\",state.suaMoa))+\n      row(\"Restricted areas\",\"Regulatory hazardous-activity areas\",toggle(\"suaRestricted\",state.suaRestricted))+\n      row(\"Prohibited areas\",\"Flight prohibited without permission\",toggle(\"suaProhibited\",state.suaProhibited))+\n      row(\"Warning areas\",\"Potentially hazardous activity over water\",toggle(\"suaWarning\",state.suaWarning))+\n      row(\"Alert areas\",\"High-volume or unusual aerial activity\",toggle(\"suaAlert\",state.suaAlert))+\n      row(\"National Security Areas\",\"Requested avoidance for security\",toggle(\"suaNsa\",state.suaNsa))+\n      row(\"Other SUA\",\"Other FAA SUA classifications\",toggle(\"suaOther\",state.suaOther))+visibleSuaListHtml()+\n      '<div class=\"layer-note\"><strong>Current activation</strong><br>FAA boundary data describes the published airspace. Current active/released status must still be obtained from ATC, NOTAMs, or the controlling agency.</div>';\n  }else if(panelTab===\"traffic\"){\n    scroll.innerHTML=row(\"Range rings\",\"Optional home reference\",toggle(\"rings\",state.rings))+\n      row(\"Track vectors\",\"One-minute projection\",toggle(\"vectors\",state.vectors))+\n      row(\"Labels\",\"Collision-managed aircraft labels\",selectHtml(\"labels\",state.labels,[[\"full\",\"FULL\"],[\"callsign\",\"CALLSIGN\"],[\"altitude\",\"ALTITUDE\"],[\"none\",\"NONE\"]]))+\n      row(\"Traffic\",\"Display filter\",selectHtml(\"trafficFilter\",state.trafficFilter,[[\"all\",\"ALL\"],[\"airline\",\"AIRLINE\"],[\"ga\",\"GA\"]]))+\n      row(\"Altitude\",\"Display filter\",selectHtml(\"altFilter\",state.altFilter,[[\"all\",\"ALL\"],[\"low\",\"<5K\"],[\"mid\",\"5\u201315K\"],[\"high\",\">15K\"]]))+\n      row(\"Coverage\",\"Fast is the reliable default; Expanded uses a broader aggregated feed\",selectHtml(\"coverageMode\",state.coverageMode,[[\"fast\",\"FAST\"],[\"expanded\",\"EXPANDED\"]]))+\n      '<section class=\"panel-section\" style=\"margin-top:12px\"><div class=\"section-label\">DISPLAY DENSITY</div><div class=\"row-copy\"><strong>Every target remains an aircraft</strong><span>Wide views use small vector aircraft with labels suppressed. Zooming in progressively reveals callsigns and full labels. No count clusters are used.</span></div></section>'+trafficFeedHealthHtml()\n  }else{\n    scroll.innerHTML=systemStatusHtml()\n  }\n  bindPanelInputs()\n}\nfunction trafficFeedHealthHtml(){\n  var total=trafficMeta.uncappedTotal||traffic.length,source=trafficMeta.source||dataHealth.traffic.source||\"\u2014\",stateNow=trafficFreshnessState();\n  var sourceAge=formatTrafficAge(sourceAgeSeconds()),positionAge=formatTrafficAge(positionMedianAgeSeconds()),lastRx=trafficClock.lastSuccessAt?formatTrafficAge((Date.now()-trafficClock.lastSuccessAt)/1000):\"\u2014\";\n  return\"<section class='panel-section'><div class='section-label'>ADS-B FRESHNESS</div><div class='feed-health'><div><strong>\"+escapeHtml(stateNow.toUpperCase())+\"</strong><span>FEED STATE</span></div><div><strong>\"+escapeHtml(sourceAge)+\"</strong><span>SOURCE SNAPSHOT</span></div><div><strong>\"+escapeHtml(positionAge)+\"</strong><span>MEDIAN POSITION</span></div><div><strong>\"+escapeHtml(lastRx)+\"</strong><span>LAST SUCCESS</span></div><div><strong>\"+escapeHtml(String(source).toUpperCase())+\"</strong><span>ACTIVE SOURCE</span></div><div><strong>\"+Number(total).toLocaleString()+\"</strong><span>VISIBLE TARGETS</span></div></div>\"+(trafficClock.error?\"<div class='route-note'>Last error: \"+escapeHtml(trafficClock.error)+\"</div>\":\"\")+\"</section>\"\n}\nfunction choice(id,title,sub){return\"<button class='choice\"+(state.base===id?\" active\":\"\")+\"' data-base='\"+id+\"' type='button'><strong>\"+title+\"</strong><span>\"+sub+\"</span></button>\"}\nfunction row(title,sub,control){return\"<div class='row'><div class='row-copy'><strong>\"+title+\"</strong><span>\"+sub+\"</span></div>\"+control+\"</div>\"}\nfunction toggle(id,on){return\"<label class='switch'><input data-toggle='\"+id+\"' type='checkbox'\"+(on?\" checked\":\"\")+\"><span class='switch-track'></span></label>\"}\nfunction selectHtml(id,val,opts){return\"<select data-select='\"+id+\"' class='small-select'>\"+opts.map(function(o){return\"<option value='\"+o[0]+\"'\"+(o[0]===val?\" selected\":\"\")+\">\"+o[1]+\"</option>\"}).join(\"\")+\"</select>\"}\nfunction bindPanelInputs(){\n  document.querySelectorAll(\".choice[data-base]\").forEach(function(b){b.onclick=function(){setBase(b.dataset.base)}});\n  document.querySelectorAll(\"[data-toggle]\").forEach(function(i){i.onchange=function(){\n    var k=i.dataset.toggle;state[k]=i.checked;\n    if(k===\"radarLoop\")setRadarLoop(i.checked);\n    else{saveState();syncVisibility();syncAllSources();if(k===\"radar\"&&i.checked){showRadarTimelineFrame(state.radarFrameIndex)}if(k===\"radar\"&&!i.checked)setRadarLoop(false);if(k===\"lightning\"&&i.checked)updateLightningImage();if(k===\"windFlow\"){if(i.checked)loadWinds();else if(windCanvasFrame)cancelAnimationFrame(windCanvasFrame)}if(k===\"icingFocus\"||k===\"turbulenceFocus\"){updateWeatherAltitudeUi();syncAllSources()}}\n  }});\n  document.querySelectorAll(\"[data-select]\").forEach(function(s){s.onchange=function(){\n    state[s.dataset.select]=s.value;saveState();syncAllSources();\n    if(s.dataset.select===\"coverageMode\"){lastTrafficViewportKey=\"\";loadTrafficViewport(true);renderPanel()}\n  }});\n  var c=$(\"chartOpacity\");if(c)c.oninput=function(){state.chartOpacity=Number(c.value)/100;saveState();syncVisibility()};\n  var so=$(\"satOpacity\");if(so)so.oninput=function(){state.satelliteOpacity=Number(so.value)/100;saveState();syncVisibility()};\n  var ro=$(\"radarOpacity\");if(ro)ro.oninput=function(){state.radarOpacity=Number(ro.value)/100;if(map.getLayer(\"mrms\"))map.setPaintProperty(\"mrms\",\"raster-opacity\",state.radarOpacity);saveState()};\n  var lo=$(\"lightningOpacity\");if(lo)lo.oninput=function(){state.lightningOpacity=Number(lo.value)/100;if(map.getLayer(\"lightning\"))map.setPaintProperty(\"lightning\",\"raster-opacity\",state.lightningOpacity);saveState()};\n  document.querySelectorAll(\"[data-advisory-index]\").forEach(function(b){b.onclick=function(){var f=visibleAdvisoryFeatures()[Number(b.dataset.advisoryIndex)];if(f)showAdvisoryFeature(f)}});\n  document.querySelectorAll(\"[data-sua-index]\").forEach(function(b){b.onclick=function(){var f=visibleSuaFeatures()[Number(b.dataset.suaIndex)];if(f)showSuaFeature(f)}})\n}\nfunction openPanel(tab){\n  panelTab=tab||panelTab;$(\"sidePanel\").classList.add(\"open\");document.querySelectorAll(\".rail-btn[data-open-tab]\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.openTab===panelTab)});\n  renderPanel();map.easeTo({padding:cameraPadding(),duration:180})\n}\nfunction closePanel(){\n  $(\"sidePanel\").classList.remove(\"open\");document.querySelectorAll(\".rail-btn[data-open-tab]\").forEach(function(b){b.classList.remove(\"active\")});map.easeTo({padding:cameraPadding(),duration:180})\n}\nfunction metric(label,value){return\"<div class='metric'><span>\"+escapeHtml(label)+\"</span><strong>\"+escapeHtml(value==null?\"\u2014\":value)+\"</strong></div>\"}\nfunction routeCard(){\n  if(!selectedRoute||!selectedRoute.route)return\"<div class='route-card'><div class='route-note'>ROUTE NOT AVAILABLE \u00b7 The destination line is only shown when the callsign can be matched to a route.</div></div>\";\n  var r=selectedRoute.route,o=r.origin,d=r.destination;\n  return\"<div class='route-card'><div class='route-line'><div class='airport'><strong>\"+escapeHtml(o&&(o.iata||o.icao)||\"\u2014\")+\"</strong><span>\"+escapeHtml(o&&(o.location||o.name)||\"Origin\")+\"</span></div><div class='route-arrow'>\u2192</div><div class='airport'><strong>\"+escapeHtml(d&&(d.iata||d.icao)||\"\u2014\")+\"</strong><span>\"+escapeHtml(d&&(d.location||d.name)||\"Destination\")+\"</span></div></div><div class='route-note'>\"+escapeHtml(r.iataCodes||r.airportCodes||\"Route lookup\")+(r.plausible===true?\" \u00b7 PLAUSIBLE ROUTE\":\"\")+\"</div></div>\"\n}\n\nfunction airportCode(ap){return ap.icao||ap.gps||ap.ident||ap.iata}\nfunction airportMetaHtml(ap){\n  var primary=airportCode(ap),items=[];\n  if(primary)items.push(\"<span><b>\"+(ap.icao||ap.gps?\"ICAO\":\"AIRPORT ID\")+\"</b> \"+escapeHtml(primary)+\"</span>\");\n  if(ap.ident&&String(ap.ident).toUpperCase()!==String(primary).toUpperCase())items.push(\"<span><b>FAA LID</b> \"+escapeHtml(ap.ident)+\"</span>\");\n  if(ap.iata&&String(ap.iata).toUpperCase()!==String(primary).toUpperCase())items.push(\"<span><b>IATA</b> \"+escapeHtml(ap.iata)+\"</span>\");\n  return items.join(\"\")\n}\n\n\nfunction renderNavaids(){\n  if(!nearbyNavaids.length)return\"<div class='route-note'>Radio navaid detail is not loaded in this release.</div>\";\n  return nearbyNavaids.map(function(x){\n    var n=x.n,freq=Number.isFinite(Number(n.frequencyMhz))?Number(n.frequencyMhz).toFixed(2):\"\u2014\";\n    return\"<div class='navaid-row'><strong>\"+escapeHtml(n.identifier||\"\")+\"</strong><span>\"+escapeHtml([n.name,n.type,x.d.toFixed(1)+\" NM\"].filter(Boolean).join(\" \u00b7 \"))+\"</span><em>\"+escapeHtml(freq)+\"</em></div>\"\n  }).join(\"\")\n}\nfunction airportMetar(ap){return airportMetarMatch(ap)}\nfunction airportTaf(ap){\n  var candidates=[ap.icao,ap.gps,ap.ident,ap.local].filter(Boolean).map(function(v){return String(v).toUpperCase()});\n  return(weather.tafs||[]).find(function(t){return candidates.indexOf(String(t.icaoId||\"\").toUpperCase())>=0})||null\n}\nfunction movementCounts(){\n  var counts={GROUND:0,ARRIVING:0,DEPARTING:0,NEARBY:0};\n  if(!selectedAirport)return counts;\n  airportTraffic.forEach(function(a){counts[movementFor(a,selectedAirport).status]++});\n  return counts\n}\nfunction resourceLink(url,title,sub){\n  return\"<a class='resource-link' href='\"+escapeHtml(url)+\"' target='_blank' rel='noopener'><strong>\"+escapeHtml(title)+\"</strong><span>\"+escapeHtml(sub)+\"</span></a>\"\n}\nfunction runwayRecommendationHtml(ap,m,runways){\n  var p=preferredRunwayInfo(ap,m,runways||[]);\n  if(!p.available)return\"<div class='runway-recommendation neutral'><div class='runway-rec-title'><div><strong>NO WIND-BASED RUNWAY</strong><span>\"+escapeHtml(p.reason||\"Insufficient data\")+\"</span></div></div><div class='runway-caution'>Runway use may be determined by ATC, traffic flow, NOTAMs, noise programs, runway condition and local procedures.</div></div>\";\n  var gustText=p.gust?\"G\"+Math.round(p.gust):\"\";\n  return\"<div class='runway-recommendation'><div class='runway-rec-head'><div class='runway-rec-title'><div class='runway-arrow-chip' style='--arrow-rotation:\"+Math.round(p.heading-90)+\"deg'>\u279c</div><div><strong>WIND-PREFERRED RWY \"+escapeHtml(p.ident)+\"</strong><span>Best alignment from current METAR wind</span></div></div><div class='runway-rec-wind'><strong>\"+String(Math.round(p.windDir)).padStart(3,\"0\")+\"\u00b0 / \"+Math.round(p.windSpeed)+gustText+\" KT</strong><span>METAR WIND</span></div></div><div class='runway-components'><div><span>HEADWIND COMPONENT</span><strong>\"+Math.round(p.headwind)+\" kt</strong></div><div><span>CROSSWIND COMPONENT</span><strong>\"+Math.round(p.crosswind)+\" kt</strong></div></div><div class='runway-caution'>Wind-derived indication only. ATC runway assignment, traffic, runway condition, NOTAMs, local runway-use programs and aircraft limits take precedence.</div></div>\"\n}\nfunction runwayDirectionHtml(r,end,m,preferred){\n  var ident=end===\"le\"?r.leIdent:r.heIdent,heading=end===\"le\"?(Number(r.leHeading)||runwayHeadingFromIdent(r.leIdent)):(Number(r.heHeading)||runwayHeadingFromIdent(r.heIdent));\n  var comp=runwayEndComponent(r,end,m),isPreferred=preferred&&preferred.available&&preferred.runway.id===r.id&&preferred.end===end;\n  return\"<div class='runway-direction \"+(isPreferred?\"preferred\":\"\")+\"'><strong>RWY \"+escapeHtml(ident||\"\u2014\")+(isPreferred?\" <span class='runway-preferred-badge'>PREFERRED</span>\":\"\")+\"</strong><span>\"+(Number.isFinite(heading)?Math.round(heading)+\"\u00b0 TRUE \u00b7 \":\"\")+(comp?(componentText(comp.headwind)+\" \u00b7 XW \"+Math.round(comp.crosswind)+\" kt\"):\"NO COMPONENT\")+\"</span></div>\"\n}\nfunction renderRunways(runways,m,ap){\n  if(!runways||!runways.length){\n    var err=airportDetail&&Array.isArray(airportDetail.diagnostics)?airportDetail.diagnostics.map(function(d){return d.source+\": \"+(d.ok?d.count+\" records\":d.error)}).join(\" \u00b7 \"):\"No runway records matched this airport.\";\n    return\"<div class='route-note'>\"+escapeHtml(err)+\"</div>\"\n  }\n  var preferred=preferredRunwayInfo(ap,m,runways);\n  return runways.map(function(r){\n    var isPreferred=preferred.available&&preferred.runway.id===r.id;\n    var ident=[r.leIdent,r.heIdent].filter(Boolean).join(\" / \")||\"RUNWAY\";\n    var dims=[r.lengthFt?Number(r.lengthFt).toLocaleString()+\" ft\":null,r.widthFt?r.widthFt+\" ft\":null].filter(Boolean).join(\" \u00d7 \");\n    var extras=[r.condition&&!/GOOD/i.test(String(r.condition))?r.condition:null,r.lighting||null,r.grossWtSingle?(\"SW \"+r.grossWtSingle+\"K\"):null,r.effectiveDate?(\"EFF \"+r.effectiveDate):null].filter(Boolean).join(\" \u00b7 \");\n    return\"<div class='runway-card \"+(isPreferred?\"preferred\":\"\")+\"'><div class='runway-card-head'><strong>\"+escapeHtml(ident)+\"</strong><span>\"+escapeHtml(dims)+\" \u00b7 \"+escapeHtml(r.surface||\"SURFACE N/A\")+\" \u00b7 \"+(r.lighted?\"LIGHTED\":\"UNLIGHTED\")+(extras?\" \u00b7 \"+escapeHtml(extras):\"\")+\"</span></div><div class='runway-direction-grid'>\"+runwayDirectionHtml(r,\"le\",m,preferred)+runwayDirectionHtml(r,\"he\",m,preferred)+\"</div></div>\"\n  }).join(\"\")\n}\nfunction renderFrequencies(freqs){\n  if(!freqs||!freqs.length){\n    var err=airportDetail&&Array.isArray(airportDetail.diagnostics)?airportDetail.diagnostics.map(function(d){return d.source+\": \"+(d.ok?d.count+\" records\":d.error)}).join(\" \u00b7 \"):\"No communication frequency records matched this airport.\";\n    return\"<div class='route-note'>\"+escapeHtml(err)+\"</div>\"\n  }\n  return freqs.map(function(f){return\"<div class='airport-freq-row'><strong>\"+escapeHtml(f.type||\"FREQ\")+\"</strong><span>\"+escapeHtml(f.description||\"\")+\"</span><em>\"+escapeHtml(f.frequencyMhz||\"\u2014\")+\"</em></div>\"}).join(\"\")\n}\n\nfunction procedureLabel(code){\n  return code===\"APD\"?\"DIAGRAM\":code===\"IAP\"?\"APPROACH\":code===\"DP\"?\"DEPARTURE\":code===\"ODP\"?\"ODP\":code===\"STAR\"?\"ARRIVAL\":code===\"MIN\"?\"MINIMUMS\":code===\"HOT\"?\"HOT SPOT\":code||\"CHART\"\n}\nfunction renderProcedures(data){\n  var list=data&&Array.isArray(data.procedures)?data.procedures:[];\n  if(!list.length)return\"<div class='route-note'>No current FAA terminal procedures returned for this airport.</div>\";\n  return\"<div class='procedure-list'>\"+list.map(function(p){\n    return\"<div class='procedure-row'><div class='procedure-type'>\"+escapeHtml(procedureLabel(p.code))+\"</div><div class='procedure-copy'><strong>\"+escapeHtml(p.name)+\"</strong><span>\"+escapeHtml([p.amendment?(\"AMDT \"+p.amendment):null,p.amendmentDate].filter(Boolean).join(\" \u00b7 \"))+\"</span></div><a class='procedure-view' href='\"+escapeHtml(p.url)+\"' target='_blank' rel='noopener'>VIEW</a></div>\"\n  }).join(\"\")+\"</div>\"\n}\n\nfunction loadingRows(){return\"<div class='af-loading'><i></i><i></i><i></i></div>\"}\nfunction airportCount(value,state){return state===\"loading\"?\"\u2026\":state===\"error\"?\"\u2014\":String(value||0)}\nfunction sourceFailureHtml(title,diagnostics){\n  var detail=(diagnostics||[]).map(function(d){return d.source+\": \"+(d.ok?(d.count+\" records\"):(d.error||\"failed\"))}).join(\" \u00b7 \");\n  return\"<div class='af-empty'><strong>\"+escapeHtml(title)+\"</strong>\"+escapeHtml(detail||\"The source returned no records. Retry the airport or refresh the page.\")+\"</div>\"\n}\nfunction airportTabsHtml(){\n  var counts={\n    runways:airportLoad.detail===\"loading\"?\"\u2026\":airportLoad.detail===\"error\"?\"\u2014\":String(airportDetail&&airportDetail.runways?airportDetail.runways.length:0),\n    comms:airportLoad.detail===\"loading\"?\"\u2026\":airportLoad.detail===\"error\"?\"\u2014\":String(airportDetail&&airportDetail.frequencies?airportDetail.frequencies.length:0),\n    procedures:airportLoad.procedures===\"loading\"?\"\u2026\":airportLoad.procedures===\"error\"?\"\u2014\":String(airportProcedures&&airportProcedures.procedures?airportProcedures.procedures.length:0),\n    traffic:airportLoad.traffic===\"loading\"?\"\u2026\":airportLoad.traffic===\"error\"?\"\u2014\":String(airportTraffic.length||0)\n  };\n  var compact=isMobile();\n  return[[\"overview\",compact?\"INFO\":\"OVERVIEW\"],[\"runways\",compact?\"RWYS\":\"RUNWAYS\"],[\"comms\",\"COMMS\"],[\"procedures\",compact?\"PROCS\":\"PROCEDURES\"],[\"traffic\",\"TRAFFIC\"]].map(function(t){\n    var count=t[0]===\"overview\"?\"\":\"<span class='airport-tab-count'>\"+counts[t[0]]+\"</span>\";\n    return\"<button class='airport-tab \"+(airportTab===t[0]?\"active\":\"\")+\"' data-airport-tab='\"+t[0]+\"' type='button'><span>\"+t[1]+\"</span>\"+count+\"</button>\"\n  }).join(\"\")\n}\nfunction airportOverviewHtml(ap,m,detail){\n  var p=preferredRunwayInfo(ap,m,detail.runways||[]),counts=movementCounts();\n  return (detail&&detail.runwaySource?\"<div class='data-source-note'>Runways: \"+escapeHtml(detail.runwaySource)+\" \u00b7 Comms: \"+escapeHtml(detail.frequencySource||\"not available\")+\"</div>\":\"\")+\n    runwayRecommendationHtml(ap,m,detail.runways||[])+\"<div class='airport-data-summary'><div><strong>\"+airportCount((detail.runways||[]).length,airportLoad.detail)+\"</strong><span>RUNWAYS</span></div><div><strong>\"+airportCount((detail.frequencies||[]).length,airportLoad.detail)+\"</strong><span>COMMS</span></div><div><strong>\"+airportCount((airportProcedures&&airportProcedures.procedures?airportProcedures.procedures.length:0),airportLoad.procedures)+\"</strong><span>PROCEDURES</span></div></div><div class='airport-summary-grid'><div class='airport-summary-cell'><span>FIELD ELEVATION</span><strong>\"+(ap.elevationFt?Number(ap.elevationFt).toLocaleString()+\" ft\":\"\u2014\")+\"</strong></div><div class='airport-summary-cell'><span>WEATHER</span><strong>\"+escapeHtml(m&&m.fltCat||\"NO REPORT\")+\"</strong></div><div class='airport-summary-cell'><span>WIND</span><strong>\"+escapeHtml(m&&Number.isFinite(Number(m.wspd))?((m.wdir||\"VRB\")+\"\u00b0 / \"+m.wspd+(m.wgst?\"G\"+m.wgst:\"\")+\" kt\"):\"\u2014\")+\"</strong></div><div class='airport-summary-cell'><span>LIVE MOVEMENTS</span><strong>\"+(counts.GROUND+counts.ARRIVING+counts.DEPARTING)+\"</strong></div></div>\"+(m&&m.rawOb?\"<div class='info-section'><h4>CURRENT METAR</h4><div style='font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.5;color:#d0dde3;padding:9px 0;border-bottom:1px solid var(--border)'>\"+escapeHtml(m.rawOb)+\"</div></div>\":\"\")+(airportTaf(ap)&&airportTaf(ap).rawTAF?\"<div class='info-section'><h4>CURRENT TAF</h4><div style='font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.5;color:#bdd8e5;padding:9px 0;border-bottom:1px solid var(--border)'>\"+escapeHtml(airportTaf(ap).rawTAF)+\"</div></div>\":\"\")+\"<div class='info-section'><h4>DATA STATUS</h4><div class='integration-state'><div><strong>FAA terminal procedures</strong><span>Current d-TPP list is embedded under Procedures.</span></div><em style='color:#67d79a'>CONNECTED</em></div><div class='integration-state'><div><strong>NOTAMs</strong><span>FAA NMS API requires approved access.</span></div><em>NOT CONNECTED</em></div><div class='integration-state'><div><strong>FBO directory</strong><span>No reliable structured current source connected.</span></div><em>NOT CONNECTED</em></div></div>\"\n}\nfunction airportTrafficHtml(){\n  var rows=airportTraffic.map(function(a){return{a:a,mv:movementFor(a,selectedAirport)}}).sort(function(x,y){var order={GROUND:0,ARRIVING:1,DEPARTING:2,NEARBY:3};return order[x.mv.status]-order[y.mv.status]||x.mv.distance-y.mv.distance}).slice(0,24),counts=movementCounts();\n  return\"<div class='movement-summary'><div><strong>\"+counts.GROUND+\"</strong><span>GROUND</span></div><div><strong>\"+counts.ARRIVING+\"</strong><span>ARRIVING</span></div><div><strong>\"+counts.DEPARTING+\"</strong><span>DEPARTING</span></div><div><strong>\"+counts.NEARBY+\"</strong><span>NEARBY</span></div></div><div class='movement-board'>\"+rows.map(function(item){var a=item.a,mv=item.mv;return\"<button class='movement-row' data-aircraft='\"+escapeHtml(a.hex||\"\")+\"' type='button'><span class='movement-status \"+mv.status+\"'>\"+mv.status+\"</span><span class='movement-main'><strong>\"+escapeHtml(aircraftName(a))+\"</strong><span>\"+escapeHtml([a.r,a.t].filter(Boolean).join(\" \u00b7 \"))+\"</span></span><span class='movement-side'><strong>\"+mv.distance.toFixed(1)+\" NM</strong><span>\"+escapeHtml(altitude(a))+\"</span></span></button>\"}).join(\"\")+\"</div><div class='route-note'>Categories are inferred from ADS-B track, groundspeed and vertical rate; this is not a tower or schedule feed.</div>\"\n}\nfunction renderAirportInfo(){\n  if(!selectedAirport)return;\n  $(\"infoKicker\").textContent=\"AIRPORT\";\n  $(\"infoTitle\").textContent=airportCode(selectedAirport);\n  $(\"infoSub\").textContent=[selectedAirport.name,selectedAirport.municipality].filter(Boolean).join(\" \u00b7 \");\n  $(\"infoMeta\").innerHTML=airportMetaHtml(selectedAirport);\n  $(\"infoLoading\").style.display=(airportLoad.detail===\"loading\"||airportLoad.procedures===\"loading\")?\"block\":\"none\";\n  renderMobilePeek();\n\n  var nav=$(\"contextNav\");\n  nav.className=\"context-nav airport\";\n  nav.innerHTML=airportTabsHtml();\n\n  var scroll=$(\"infoScroll\"),oldScroll=scroll.scrollTop,m=airportMetar(selectedAirport);\n  var detail=airportDetail||{runways:[],frequencies:[],diagnostics:[]},content=\"\";\n\n  if(airportTab===\"overview\")content=airportOverviewHtml(selectedAirport,m,detail);\n  if(airportTab===\"runways\")content=airportLoad.detail===\"loading\"?loadingRows():(detail.runways&&detail.runways.length?runwayRecommendationHtml(selectedAirport,m,detail.runways)+renderRunways(detail.runways,m,selectedAirport):sourceFailureHtml(\"RUNWAY DATA UNAVAILABLE\",detail.diagnostics));\n  if(airportTab===\"comms\")content=airportLoad.detail===\"loading\"?loadingRows():(detail.frequencies&&detail.frequencies.length?renderFrequencies(detail.frequencies):sourceFailureHtml(\"COMMUNICATIONS UNAVAILABLE\",detail.diagnostics));\n  if(airportTab===\"procedures\")content=airportLoad.procedures===\"loading\"?loadingRows():(airportProcedures&&airportProcedures.procedures&&airportProcedures.procedures.length?renderProcedures(airportProcedures):sourceFailureHtml(\"FAA PROCEDURES UNAVAILABLE\",airportProcedures&&airportProcedures.diagnostics));\n  if(airportTab===\"traffic\")content=airportLoad.traffic===\"loading\"?loadingRows():airportTrafficHtml();\n\n  scroll.innerHTML=content+\"<div class='info-actions'><button id='fitAirportBtn' class='info-action active' type='button'>CENTER AIRPORT</button><button id='closeAirportBtn' class='info-action' type='button'>CLOSE</button></div>\";\n  requestAnimationFrame(function(){scroll.scrollTop=Math.max(0,Math.min(oldScroll,scroll.scrollHeight-scroll.clientHeight))});\n  nav.querySelectorAll(\"[data-airport-tab]\").forEach(function(b){b.onclick=function(){airportTab=b.dataset.airportTab;scroll.scrollTop=0;renderAirportInfo()}});\n  scroll.querySelectorAll(\".movement-row\").forEach(function(b){b.onclick=function(){var a=airportTraffic.find(function(x){return x.hex===b.dataset.aircraft});if(a)selectAircraft(a)}});\n  var fa=$(\"fitAirportBtn\");if(fa)fa.onclick=fitAirportView;\n  var ca=$(\"closeAirportBtn\");if(ca)ca.onclick=closeInfo\n}\n\nfunction fitAirportView(){\n  if(!selectedAirport)return;\n  var bounds=new maplibregl.LngLatBounds();\n  [0,90,180,270].forEach(function(b){bounds.extend(destinationPoint(selectedAirport.lon,selectedAirport.lat,b,7))});\n  performCamera(\"airport\",function(){map.fitBounds(bounds,{padding:cameraPadding({top:30,bottom:50}),duration:450,maxZoom:13})})\n}\nasync function selectAirport(ap){dismissActivePopup();\n  selected=null;selectedTrace=null;selectedRoute=null;selectedOverlay=null;selectedToken++;\n  selectedAirport=ap;airportTraffic=[];airportDetail=null;airportProcedures=null;airportTab=\"overview\";\n  airportLoad={detail:\"loading\",procedures:\"loading\",traffic:\"loading\"};cameraMode=\"airport\";airportToken++;\n  var token=airportToken;\n  closePanel();\n  $(\"infoPanel\").classList.add(\"open\",\"airport-mode\");\n  $(\"infoScroll\").scrollTop=0;\n  if(isMobile())setSheetDetent(\"half\",false);\n  syncVisibility();syncAllSources();renderAirportInfo();fitAirportView();\n\n  var detailUrl=\"/api/airport-detail?ident=\"+encodeURIComponent(ap.icao||ap.gps||ap.ident||\"\")+\"&local=\"+encodeURIComponent(ap.ident||ap.local||\"\")+\"&icao=\"+encodeURIComponent(ap.icao||ap.gps||\"\")+\"&ref=\"+encodeURIComponent(ap.id||\"\")+\"&_=\"+Date.now();\n  fetch(detailUrl,{cache:\"no-store\"}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(result){\n    if(token!==airportToken)return;\n    airportDetail=result.ok?result.data:{runways:[],frequencies:[],diagnostics:[{source:\"Airport detail\",ok:false,error:result.data&&result.data.error||\"Request failed\"}]};\n    airportLoad.detail=result.ok?\"ready\":\"error\";syncAllSources();renderAirportInfo()\n  }).catch(function(error){if(token!==airportToken)return;airportDetail={runways:[],frequencies:[],diagnostics:[{source:\"Airport detail\",ok:false,error:String(error)}]};airportLoad.detail=\"error\";renderAirportInfo()});\n\n  var procedureIdent=ap.icao||ap.gps||ap.ident;\n  fetch(\"/api/procedures?ident=\"+encodeURIComponent(procedureIdent)+\"&_=\"+Date.now(),{cache:\"no-store\"}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(result){\n    if(token!==airportToken)return;\n    airportProcedures=result.data||{procedures:[]};airportLoad.procedures=result.ok?\"ready\":\"error\";renderAirportInfo()\n  }).catch(function(error){if(token!==airportToken)return;airportProcedures={procedures:[],diagnostics:[{source:\"FAA d-TPP\",ok:false,error:String(error)}]};airportLoad.procedures=\"error\";renderAirportInfo()});\n\n  fetch(\"/api/traffic?lat=\"+encodeURIComponent(ap.lat)+\"&lon=\"+encodeURIComponent(ap.lon)+\"&radius=35&_=\"+Date.now(),{cache:\"no-store\"}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(result){\n    if(token!==airportToken)return;\n    airportTraffic=result.ok&&Array.isArray(result.data.aircraft)?result.data.aircraft:[];airportLoad.traffic=result.ok?\"ready\":\"error\";syncAllSources();renderAirportInfo()\n  }).catch(function(){if(token!==airportToken)return;airportTraffic=[];airportLoad.traffic=\"error\";renderAirportInfo()})\n}\n\n\nfunction isMobile(){return window.matchMedia(\"(max-width:720px)\").matches}\nfunction setSheetDetent(detent,animate){\n  if(![\"peek\",\"half\",\"full\"].includes(detent))detent=\"peek\";\n  sheetDetent=detent;var panel=$(\"infoPanel\");panel.style.height=\"\";\n  panel.classList.remove(\"sheet-peek\",\"sheet-half\",\"sheet-full\");panel.classList.add(\"sheet-\"+detent);\n  document.querySelectorAll(\"[data-sheet]\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.sheet===detent)});\n  $(\"bottomBar\").classList.toggle(\"sheet-open\",panel.classList.contains(\"open\")&&isMobile());\n  if(panel.classList.contains(\"open\")&&isMobile())setTimeout(function(){map.easeTo({padding:cameraPadding(),duration:animate===false?0:190})},30)\n}\nfunction renderMobilePeek(){\n  var box=$(\"mobilePeek\");\n  if(selected){\n    var gs=Number(selected.gs),vr=Number(selected.baro_rate);\n    var routeText=selectedRoute&&selectedRoute.route?escapeHtml(((selectedRoute.route.origin&&(selectedRoute.route.origin.iata||selectedRoute.route.origin.icao))||\"\u2014\")+\" \u2192 \"+((selectedRoute.route.destination&&(selectedRoute.route.destination.iata||selectedRoute.route.destination.icao))||\"\u2014\")):\"ROUTE UNKNOWN\";\n    box.innerHTML=\"<div style='display:grid;grid-template-columns:repeat(3,1fr);gap:10px'><div><span style='font-size:8.5px;color:var(--muted)'>ALTITUDE</span><strong style='display:block;font-size:14px;margin-top:3px'>\"+escapeHtml(altitude(selected))+\"</strong></div><div><span style='font-size:8.5px;color:var(--muted)'>SPEED</span><strong style='display:block;font-size:14px;margin-top:3px'>\"+(Number.isFinite(gs)?Math.round(gs)+\" kt\":\"\u2014\")+\"</strong></div><div><span style='font-size:8.5px;color:var(--muted)'>VERT RATE</span><strong style='display:block;font-size:14px;margin-top:3px'>\"+(Number.isFinite(vr)?Math.round(vr)+\" fpm\":\"\u2014\")+\"</strong></div></div><div style='margin-top:9px;font-size:9.5px;color:#a3b4be'>\"+routeText+(selectedTrace&&selectedTrace.points?\" \u00b7 \"+selectedTrace.originalPointCount+\" track pts\":\"\")+\"</div>\";\n    return\n  }\n  if(selectedAirport){\n    var m=airportMetar(selectedAirport),p=preferredRunwayInfo(selectedAirport,m,airportDetail&&airportDetail.runways||[]);\n    box.innerHTML=\"<div style='display:grid;grid-template-columns:repeat(3,1fr);gap:10px'><div><span style='font-size:8.5px;color:var(--muted)'>WEATHER</span><strong style='display:block;font-size:14px;margin-top:3px'>\"+escapeHtml(m&&m.fltCat||\"NO REPORT\")+\"</strong></div><div><span style='font-size:8.5px;color:var(--muted)'>WIND</span><strong style='display:block;font-size:14px;margin-top:3px'>\"+escapeHtml(m&&Number.isFinite(Number(m.wspd))?((m.wdir||\"VRB\")+\"/\"+m.wspd):\"\u2014\")+\"</strong></div><div><span style='font-size:8.5px;color:var(--muted)'>WIND-PREFERRED</span><strong style='display:block;font-size:14px;margin-top:3px;color:#69de9a'>\"+escapeHtml(p.available?(\"RWY \"+p.ident):\"\u2014\")+\"</strong></div></div>\";\n    return\n  }\n  box.innerHTML=\"\"\n}\nfunction bindSheetGestures(){\n  var handle=$(\"sheetHandle\"),panel=$(\"infoPanel\"),lastY=0,lastT=0,velocity=0;\n  handle.addEventListener(\"pointerdown\",function(e){if(!isMobile())return;sheetDragging=true;sheetStartY=e.clientY;sheetStartHeight=panel.getBoundingClientRect().height;lastY=e.clientY;lastT=performance.now();velocity=0;handle.setPointerCapture(e.pointerId);panel.style.transition=\"none\"});\n  handle.addEventListener(\"pointermove\",function(e){if(!sheetDragging||!isMobile())return;var now=performance.now(),dt=Math.max(1,now-lastT);velocity=(e.clientY-lastY)/dt;lastY=e.clientY;lastT=now;panel.style.height=clamp(sheetStartHeight+(sheetStartY-e.clientY),150,Math.min(window.innerHeight*.9,parseFloat(getComputedStyle(document.documentElement).getPropertyValue(\"--visual-height\"))||window.innerHeight))+\"px\"});\n  function finish(){if(!sheetDragging)return;sheetDragging=false;var h=panel.getBoundingClientRect().height,vh=window.visualViewport?window.visualViewport.height:window.innerHeight;panel.style.height=\"\";panel.style.transition=\"\";var next;if(velocity<-.35)next=sheetDetent===\"peek\"?\"half\":\"full\";else if(velocity>.35)next=sheetDetent===\"full\"?\"half\":\"peek\";else next=h<vh*.34?\"peek\":h<vh*.69?\"half\":\"full\";setSheetDetent(next,true)}\n  handle.addEventListener(\"pointerup\",finish);handle.addEventListener(\"pointercancel\",finish);\n  document.querySelectorAll(\"[data-sheet]\").forEach(function(b){b.onclick=function(){setSheetDetent(b.dataset.sheet,true)}})\n}\n\nfunction centerSelectedAircraft(){\n  if(!selected||!Number.isFinite(Number(selected.lon))||!Number.isFinite(Number(selected.lat)))return;\n  performCamera(\"aircraft\",function(){map.easeTo({center:[Number(selected.lon),Number(selected.lat)],zoom:map.getZoom(),padding:cameraPadding(),duration:280,essential:true})})\n}\n\nfunction renderAircraftInfo(){\n  if(!selected)return;\n  var infoScroll=$(\"infoScroll\"),oldScroll=infoScroll.scrollTop;\n  $(\"infoKicker\").textContent=\"SELECTED AIRCRAFT\";\n  $(\"infoTitle\").textContent=aircraftName(selected);$(\"infoSub\").textContent=[selected.r,selected.t,selected.desc,selected.year].filter(Boolean).join(\" \u00b7 \");$(\"infoMeta\").innerHTML=\"\";\n  var traceText=selectedTrace&&selectedTrace.points?selectedTrace.originalPointCount+\" points \u00b7 \"+formatDuration((selectedTrace.endTime-selectedTrace.startTime)*1000):\"Loading flight history\u2026\";\n  var cls=emitterClass(selected);\n  $(\"infoScroll\").innerHTML=routeCard()+\n    \"<div style='margin-bottom:8px'><span class='aircraft-class-chip'>\"+escapeHtml(cls.label)+\"</span>\"+(selected.category?\"<span class='aircraft-class-chip'>ADS-B \"+escapeHtml(selected.category)+\"</span>\":\"\")+\"</div><div class='metrics'>\"+metric(\"ALTITUDE\",altitude(selected))+metric(\"GROUND SPEED\",Number.isFinite(Number(selected.gs))?Math.round(Number(selected.gs))+\" kt\":\"\u2014\")+\n    metric(\"VERTICAL RATE\",Number.isFinite(Number(selected.baro_rate))?Math.round(Number(selected.baro_rate))+\" fpm\":\"\u2014\")+metric(\"TRACK\",Number.isFinite(Number(selected.track))?Math.round(Number(selected.track))+\"\u00b0\":\"\u2014\")+\n    metric(\"SQUAWK\",selected.squawk||\"\u2014\")+metric(\"POSITION AGE\",Math.round(aircraftAge(selected))+\" sec\")+\"</div>\"+\n    \"<div class='info-section'><h4>FLIGHT TRACK</h4><div class='row-copy'><strong>\"+escapeHtml(traceText)+\"</strong><span>Full current leg is loaded only for this selected aircraft.</span></div></div>\"+\n    \"<div class='info-actions'><button id='currentAircraftBtn' class='info-action \"+(cameraMode===\"aircraft\"?\"active\":\"\")+\"' type='button'>AIRCRAFT</button><button id='fitTrackBtn' class='info-action \"+(cameraMode===\"track\"?\"active\":\"\")+\"' type='button'>FULL TRACK</button><button id='fitRouteBtn' class='info-action \"+(cameraMode===\"route\"?\"active\":\"\")+\"' type='button' \"+(!selectedRoute||!selectedRoute.route?\"disabled\":\"\")+\">ROUTE</button><button id='returnBtn' class='info-action \"+(cameraMode===\"kapn\"?\"active\":\"\")+\"' type='button'>KAPN</button></div>\";\n  renderMobilePeek();\n  var ca=$(\"currentAircraftBtn\");if(ca)ca.onclick=centerSelectedAircraft;\n  var ft=$(\"fitTrackBtn\");if(ft)ft.onclick=fitSelectedTrack;\n  var fr=$(\"fitRouteBtn\");if(fr)fr.onclick=fitSelectedRoute;\n  var rb=$(\"returnBtn\");if(rb)rb.onclick=function(){goHome(true)};\n  requestAnimationFrame(function(){infoScroll.scrollTop=Math.min(oldScroll,Math.max(0,infoScroll.scrollHeight-infoScroll.clientHeight))})\n}\nfunction formatDuration(ms){\n  if(!Number.isFinite(ms)||ms<0)return\"\u2014\";var m=Math.round(ms/60000),h=Math.floor(m/60);m%=60;return(h?h+\"h \":\"\")+m+\"m\"\n}\nasync function selectAircraft(a){dismissActivePopup();\n  selectedAirport=null;airportTraffic=[];airportDetail=null;airportProcedures=null;nearbyNavaids=[];selectedOverlay=null;airportToken++;\n  airportTab=\"overview\";\n  var nav=$(\"contextNav\");nav.className=\"context-nav\";nav.innerHTML=\"\";\n  $(\"infoPanel\").classList.remove(\"airport-mode\");\n  $(\"infoKicker\").textContent=\"SELECTED AIRCRAFT\";\n  cameraMode=\"aircraft\";\n  selected=a;selectedTrace=null;selectedRoute=null;selectedToken++;\n  var token=selectedToken;$(\"infoKicker\").textContent=\"SELECTED AIRCRAFT\";$(\"infoPanel\").classList.add(\"open\");$(\"infoScroll\").scrollTop=0;if(isMobile())setSheetDetent(\"peek\",false);$(\"infoLoading\").style.display=\"block\";\n  closePanel();syncAllSources();renderAircraftInfo();setTimeout(centerSelectedAircraft,30);\n  var callsign=aircraftName(a),tracePromise=fetch(\"/api/trace?hex=\"+encodeURIComponent(a.hex||\"\"),{cache:\"no-store\"}).then(function(r){return r.json()}),\n      routePromise=fetch(\"/api/route?callsign=\"+encodeURIComponent(callsign)+\"&lat=\"+encodeURIComponent(a.lat)+\"&lon=\"+encodeURIComponent(a.lon),{cache:\"no-store\"}).then(function(r){return r.json()});\n  var results=await Promise.allSettled([tracePromise,routePromise]);if(token!==selectedToken)return;\n  if(results[0].status===\"fulfilled\"&&Array.isArray(results[0].value.points))selectedTrace=results[0].value;\n  if(results[1].status===\"fulfilled\")selectedRoute=results[1].value;\n  $(\"infoLoading\").style.display=\"none\";syncSelectedSources();renderAircraftInfo();renderMobilePeek()\n}\nfunction closeInfo(){\n  $(\"infoPanel\").classList.remove(\"open\",\"airport-mode\");\n  var nav=$(\"contextNav\");nav.className=\"context-nav\";nav.innerHTML=\"\";\n  selected=null;selectedTrace=null;selectedRoute=null;selectedOverlay=null;selectedAirport=null;airportTraffic=[];airportDetail=null;airportProcedures=null;\n  selectedToken++;airportToken++;cameraMode=\"free\";\n  $(\"bottomBar\").classList.remove(\"sheet-open\");syncAllSources();map.easeTo({padding:cameraPadding(),duration:180})\n}\nfunction boundsFromCoords(coords){\n  if(!coords||!coords.length)return null;var b=new maplibregl.LngLatBounds();coords.forEach(function(c){if(Number.isFinite(c[0])&&Number.isFinite(c[1]))b.extend(c)});return b\n}\n\nfunction performCamera(mode,fn){\n  cameraMode=mode;\n  cameraProgrammatic=true;\n  if(selected)renderAircraftInfo();\n  fn();\n  map.once(\"moveend\",function(){cameraProgrammatic=false})\n}\nfunction clearCameraModeFromUser(){\n  if(cameraProgrammatic)return;\n  if(cameraMode!==\"free\"){\n    cameraMode=\"free\";\n    if(selected)renderAircraftInfo();\n  }\n}\n\nfunction fitSelectedTrack(){\n  if(!selectedTrace||!selectedTrace.points||selectedTrace.points.length<2)return;\n  var b=boundsFromCoords(selectedTrace.points.map(function(p){return[p.lon,p.lat]}));\n  if(b)performCamera(\"track\",function(){map.fitBounds(b,{padding:cameraPadding({top:35,bottom:55}),duration:500,maxZoom:10})})\n}\nfunction fitSelectedRoute(){\n  var coords=[];if(selectedTrace&&selectedTrace.points)coords=coords.concat(selectedTrace.points.map(function(p){return[p.lon,p.lat]}));\n  if(selectedRoute&&selectedRoute.route&&selectedRoute.route.destination&&Number.isFinite(selectedRoute.route.destination.lon))coords.push([selectedRoute.route.destination.lon,selectedRoute.route.destination.lat]);\n  if(selectedRoute&&selectedRoute.route&&selectedRoute.route.origin&&Number.isFinite(selectedRoute.route.origin.lon))coords.push([selectedRoute.route.origin.lon,selectedRoute.route.origin.lat]);\n  var b=boundsFromCoords(coords);\n  if(b)performCamera(\"route\",function(){map.fitBounds(b,{padding:cameraPadding({top:35,bottom:55}),duration:600,maxZoom:9})})\n}\nfunction dismissActivePopup(){if(activePopup){activePopup.remove();activePopup=null}}\nfunction showMetar(m){\n  dismissActivePopup();var cat=resolvedFlightCategory(m),color=flightCategoryColor(cat),html=\"<div><span class='wx-category' style='background:\"+escapeHtml(color)+\"'>\"+escapeHtml(cat)+\"</span><br><strong style='font-size:12px'>\"+escapeHtml(m.icaoId||\"METAR\")+\"</strong><div style='margin-top:5px;font-size:10px;color:#b3c4cd;line-height:1.45'>\"+escapeHtml(m.rawOb||\"\")+\"</div></div>\";\n  activePopup=new maplibregl.Popup({closeButton:true,offset:10}).setLngLat([Number(m.lon),Number(m.lat)]).setHTML(html).addTo(map);activePopup.on(\"close\",function(){activePopup=null})\n}\nfunction showPirep(p){\n  dismissActivePopup();activePopup=new maplibregl.Popup({closeButton:true,offset:10}).setLngLat([Number(p.lon),Number(p.lat)]).setHTML(\"<strong>PIREP</strong><br><span style='font-size:10px;color:#9dafba'>\"+escapeHtml(p.rawOb||p.rawText||\"Pilot report\")+\"</span>\").addTo(map);activePopup.on(\"close\",function(){activePopup=null})\n}\nfunction firstValue(obj,keys){for(var i=0;i<keys.length;i++){var v=obj&&obj[keys[i]];if(v!==undefined&&v!==null&&v!==\"\")return v}return null}\nfunction formatTimeValue(value){\n  if(value===null||value===undefined||value===\"\")return\"\";var d;\n  if(Number.isFinite(Number(value))){var n=Number(value);d=new Date(n>1e12?n:n*1000)}else d=new Date(value);\n  return Number.isNaN(d.getTime())?String(value):d.toLocaleString([],{month:\"short\",day:\"numeric\",hour:\"2-digit\",minute:\"2-digit\",timeZoneName:\"short\"})\n}\nfunction formatAdvisoryAltitude(p,which){\n  var prefix=which===\"low\"?[\"altitudeLow1\",\"altitudeLow\",\"base\",\"lower\",\"LOWER_DESC\",\"LOWER_VAL\"]:[\"altitudeHi1\",\"altitudeHigh\",\"top\",\"upper\",\"UPPER_DESC\",\"UPPER_VAL\"];\n  var v=firstValue(p,prefix);if(v===null)return\"\u2014\";if(String(v).toUpperCase()===\"SFC\")return\"SFC\";var n=Number(v);return Number.isFinite(n)?(n>=1000?Math.round(n).toLocaleString()+\" ft\":(\"FL\"+String(Math.round(n)).padStart(3,\"0\"))):String(v)\n}\nfunction allPropertiesHtml(p,skip){\n  skip=skip||[];var rows=Object.keys(p||{}).filter(function(k){return skip.indexOf(k)<0&&p[k]!==null&&p[k]!==undefined&&p[k]!==\"\"&&typeof p[k]!==\"object\"}).sort();\n  return'<div class=\"detail-table\">'+rows.map(function(k){return'<div class=\"detail-table-row\"><b>'+escapeHtml(k.replace(/_/g,\" \").toUpperCase())+'</b><span>'+escapeHtml(String(p[k]))+'</span></div>'}).join('')+'</div>'\n}\nfunction geometryBounds(feature){var b=featureBoundsSimple(feature);return b?new maplibregl.LngLatBounds([b.west,b.south],[b.east,b.north]):null}\nfunction fitOverlayFeature(){if(!selectedOverlay||!selectedOverlay.feature)return;var b=geometryBounds(selectedOverlay.feature);if(b)map.fitBounds(b,{padding:cameraPadding({top:30,bottom:55}),duration:480,maxZoom:10})}\nfunction prepareOverlaySelection(kind,feature,color){dismissActivePopup();\n  selected=null;selectedTrace=null;selectedRoute=null;selectedAirport=null;airportTraffic=[];airportDetail=null;airportProcedures=null;selectedToken++;airportToken++;\n  var nav=$(\"contextNav\");nav.className=\"context-nav\";nav.innerHTML=\"\";$(\"infoPanel\").classList.remove(\"airport-mode\");\n  selectedOverlay={kind:kind,feature:feature,color:color};$(\"infoPanel\").classList.add(\"open\");$(\"infoScroll\").scrollTop=0;$(\"infoLoading\").style.display=\"none\";$(\"infoMeta\").innerHTML=\"\";$(\"mobilePeek\").innerHTML=\"\";closePanel();syncAllSources();if(isMobile())setSheetDetent(\"half\",false)\n}\nfunction showAdvisoryFeature(feature){\n  var mapProps=feature.properties||{},p={};try{p=mapProps.raw?JSON.parse(mapProps.raw):Object.assign({},mapProps)}catch(e){p=Object.assign({},mapProps)}\n  var kind=mapProps.kind||p.kind||\"ADVISORY\",haz=firstValue(p,[\"hazard\",\"hazardType\",\"type\",\"product\"])||kind,color=mapProps.color||\"#c7aa54\";\n  prepareOverlaySelection(\"weather\",feature,color);$(\"infoKicker\").textContent=kind;$(\"infoTitle\").textContent=String(haz).toUpperCase();$(\"infoSub\").textContent=firstValue(p,[\"airSigmetId\",\"tag\",\"product\",\"seriesId\",\"firName\"])||\"NOAA/NWS Aviation Weather Center\";\n  var raw=firstValue(p,[\"rawAirSigmet\",\"rawText\",\"rawOb\",\"raw\",\"text\",\"cwaText\"]),issued=formatTimeValue(firstValue(p,[\"issueTime\",\"issuanceTime\",\"creationTime\"])),validFrom=formatTimeValue(firstValue(p,[\"validTimeFrom\",\"validFrom\",\"startTime\",\"validTime\"])),validTo=formatTimeValue(firstValue(p,[\"validTimeTo\",\"validTo\",\"endTime\"])),movement=[firstValue(p,[\"movementDir\",\"moveDir\"]),firstValue(p,[\"movementSpd\",\"moveSpeed\"])].filter(function(v){return v!==null}).join(\"\u00b0 / \");\n  $(\"infoScroll\").innerHTML='<div class=\"detail-hero\" style=\"--detail-color:'+escapeHtml(color)+'\"><strong>'+escapeHtml(kind+' \u00b7 '+String(haz).toUpperCase())+'</strong><span>'+escapeHtml(firstValue(p,[\"severity\",\"dueTo\",\"status\",\"product\"])||\"Operational aviation weather advisory\")+'</span></div><div class=\"metrics\">'+metric(\"ISSUED\",issued||\"\u2014\")+metric(\"VALID FROM\",validFrom||\"\u2014\")+metric(\"VALID TO\",validTo||\"\u2014\")+metric(\"FORECAST\",firstValue(p,[\"forecastHour\",\"fore\"])??\"\u2014\")+metric(\"BASE\",formatAdvisoryAltitude(p,\"low\"))+metric(\"TOP\",formatAdvisoryAltitude(p,\"high\"))+metric(\"MOVEMENT\",movement||\"\u2014\")+metric(\"SOURCE\",\"NOAA AWC\")+'</div>'+(raw?'<div class=\"info-section\"><h4>FULL BULLETIN</h4><div class=\"raw-advisory\">'+escapeHtml(raw)+'</div></div>':'')+'<div class=\"info-section\"><h4>ALL PUBLISHED FIELDS</h4>'+allPropertiesHtml(p,[\"rawAirSigmet\",\"rawText\",\"rawOb\",\"raw\",\"text\",\"cwaText\"])+'</div><div class=\"info-actions\"><button id=\"fitWeatherAreaBtn\" class=\"info-action primary\" type=\"button\">FIT AREA</button><button id=\"closeWeatherDetailBtn\" class=\"info-action\" type=\"button\">CLOSE</button></div>';\n  var fit=$(\"fitWeatherAreaBtn\");if(fit)fit.onclick=fitOverlayFeature;var close=$(\"closeWeatherDetailBtn\");if(close)close.onclick=closeInfo\n}\nfunction formatSuaAltitude(p,prefix){\n  var desc=p[prefix+\"_DESC\"],val=p[prefix+\"_VAL\"],uom=p[prefix+\"_UOM\"],code=p[prefix+\"_CODE\"];\n  return[desc,val,uom,code].filter(function(v){return v!==null&&v!==undefined&&v!==\"\"}).join(\" \")||\"\u2014\"\n}\nfunction showSuaFeature(feature){\n  var mapProps=feature.properties||{},p={};try{p=mapProps.raw?JSON.parse(mapProps.raw):Object.assign({},mapProps)}catch(e){p=Object.assign({},mapProps)}\n  var family=mapProps.family||suaFamily(p),name=p.NAME||mapProps.name||family,color=mapProps.color||suaStyle(family).color,activity=suaActivity(p,Date.now());\n  prepareOverlaySelection(\"airspace\",feature,color);$(\"infoKicker\").textContent=\"SPECIAL USE AIRSPACE\";$(\"infoTitle\").textContent=name;$(\"infoSub\").textContent=family+([p.CITY,p.STATE].filter(Boolean).length?\" \u00b7 \"+[p.CITY,p.STATE].filter(Boolean).join(\", \"):\"\");\n  var regulatory=family===\"RESTRICTED\"||family===\"PROHIBITED\"?\"REGULATORY\":\"NONREGULATORY\";\n  $(\"infoScroll\").innerHTML='<div class=\"detail-hero\" style=\"--detail-color:'+escapeHtml(color)+'\"><strong>'+escapeHtml(family+' \u00b7 '+regulatory+' \u00b7 '+activity.label)+'</strong><span>'+escapeHtml(p.REMARKS||p.EXCLUSION||\"FAA-published special use airspace boundary\")+'</span></div><div class=\"metrics\">'+metric(\"LOWER LIMIT\",formatSuaAltitude(p,\"LOWER\"))+metric(\"UPPER LIMIT\",formatSuaAltitude(p,\"UPPER\"))+metric(\"TIME OF USE\",p.TIMESOFUSE||\"\u2014\")+metric(\"CONTROLLING AGENCY\",p.CONT_AGENT||\"\u2014\")+metric(\"COMMUNICATION\",p.COMM_NAME||\"\u2014\")+metric(\"SECTOR\",p.SECTOR||\"\u2014\")+metric(\"CLASS\",p.CLASS||p.TYPE_CODE||family)+metric(\"ONSHORE\",p.ONSHORE||\"\u2014\")+'</div><div class=\"airspace-caution\"><strong>'+escapeHtml(activity.label)+'</strong><br>'+escapeHtml(activity.detail)+'<br>AteFlight evaluates published schedules only. BY NOTAM activation is not confirmed without an operational NOTAM feed; verify with ATC or the controlling agency.</div>'+(p.EXCLUSION?'<div class=\"info-section\"><h4>EXCLUSIONS</h4><div class=\"raw-advisory\">'+escapeHtml(p.EXCLUSION)+'</div></div>':'')+'<div class=\"info-section\"><h4>ALL PUBLISHED FIELDS</h4>'+allPropertiesHtml(p,[])+'</div><div class=\"info-actions\"><button id=\"fitSuaAreaBtn\" class=\"info-action primary\" type=\"button\">FIT AIRSPACE</button><button id=\"closeSuaDetailBtn\" class=\"info-action\" type=\"button\">CLOSE</button></div>';\n  var fit=$(\"fitSuaAreaBtn\");if(fit)fit.onclick=fitOverlayFeature;var close=$(\"closeSuaDetailBtn\");if(close)close.onclick=closeInfo\n}\n\n\n\nfunction directTrafficSources(){\n  return[\n    {name:\"airplanes.live\",urls:function(t){return[\"https://api.airplanes.live/v2/point/\"+t.lat+\"/\"+t.lon+\"/\"+t.radius]},rows:function(d){return Array.isArray(d.ac)?d.ac:[]}},\n    {name:\"adsb.lol\",urls:function(t){return[\"https://api.adsb.lol/v2/point/\"+t.lat+\"/\"+t.lon+\"/\"+t.radius]},rows:function(d){return Array.isArray(d.ac)?d.ac:[]}},\n    {name:\"adsb.fi\",urls:function(t){return[\"https://opendata.adsb.fi/api/v3/lat/\"+t.lat+\"/lon/\"+t.lon+\"/dist/\"+t.radius,\"https://opendata.adsb.fi/api/v2/lat/\"+t.lat+\"/lon/\"+t.lon+\"/dist/\"+t.radius]},rows:function(d){return Array.isArray(d.aircraft)?d.aircraft:(Array.isArray(d.ac)?d.ac:[])}},\n    {name:\"theairtraffic\",urls:function(t){return[\"https://api.theairtraffic.com/v2/point/\"+t.lat+\"/\"+t.lon+\"/\"+t.radius]},rows:function(d){return Array.isArray(d.ac)?d.ac:(Array.isArray(d.aircraft)?d.aircraft:[])}}\n  ]\n}\nfunction directNormalizeAircraft(a){\n  var lat=Number(a.lat),lon=Number(a.lon);if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;\n  return{hex:a.hex||null,flight:typeof a.flight===\"string\"?a.flight.trim():null,r:a.r||null,t:a.t||null,desc:a.desc||null,ownOp:a.ownOp||null,year:a.year||null,dbFlags:a.dbFlags||null,lat:lat,lon:lon,alt_baro:a.alt_baro!=null?a.alt_baro:a.altitude,alt_geom:a.alt_geom!=null?a.alt_geom:null,gs:a.gs!=null?a.gs:a.speed,track:a.track!=null?a.track:null,baro_rate:a.baro_rate!=null?a.baro_rate:(a.vert_rate!=null?a.vert_rate:a.geom_rate),squawk:a.squawk||null,emergency:a.emergency||null,category:a.category||null,seen:a.seen!=null?a.seen:null,seen_pos:a.seen_pos!=null?a.seen_pos:null}\n}\nfunction directTilesForViewport(bbox,c,radius){\n  if(radius<=249)return[{lat:c.lat.toFixed(5),lon:c.lng.toFixed(5),radius:Math.max(10,Math.min(249,Math.round(radius)))}];\n  var south=bbox[0],west=bbox[1],north=bbox[2],east=bbox[3],tiles=[{lat:c.lat,lon:c.lng}];\n  [[.27,.27],[.27,.73],[.73,.27],[.73,.73]].forEach(function(f){tiles.push({lat:south+(north-south)*f[0],lon:west+(east-west)*f[1]})});\n  return tiles.map(function(t){return{lat:Number(t.lat).toFixed(5),lon:Number(t.lon).toFixed(5),radius:249}})\n}\nasync function directJson(url){\n  var controller=new AbortController(),timer=setTimeout(function(){controller.abort()},6500);\n  try{\n    var r=await fetch(url,{mode:\"cors\",cache:\"no-store\",signal:controller.signal,referrerPolicy:\"no-referrer\"}),text=await r.text();\n    if(!r.ok)throw new Error(\"HTTP \"+r.status);try{return JSON.parse(text)}catch(e){throw new Error(\"non-JSON response\")}\n  }finally{clearTimeout(timer)}\n}\nfunction directPositionSummary(list){\n  var ages=list.map(function(a){var n=Number(a.seen_pos!=null?a.seen_pos:a.seen);return Number.isFinite(n)?Math.max(0,n):null}).filter(Number.isFinite).sort(function(a,b){return a-b});\n  function at(f){return ages.length?ages[Math.min(ages.length-1,Math.round((ages.length-1)*f))]:null}\n  return{count:ages.length,freshest:at(0),median:at(.5),p95:at(.95),oldest:at(1)}\n}\nasync function fetchDirectTraffic(bbox,c,radius){\n  var tiles=directTilesForViewport(bbox,c,radius),errors=[];\n  for(var si=0;si<directTrafficSources().length;si++){\n    var source=directTrafficSources()[si],merged=new Map(),sourceTime=0,ok=0;\n    for(var ti=0;ti<tiles.length;ti++){\n      var urls=source.urls(tiles[ti]),tileDone=false;\n      for(var ui=0;ui<urls.length;ui++){\n        try{\n          var d=await directJson(urls[ui]),rows=source.rows(d);sourceTime=Math.max(sourceTime,trafficEpochMs(d.now||d.ctime||d.time)||Date.now());\n          rows.forEach(function(raw){var a=directNormalizeAircraft(raw);if(!a)return;var key=a.hex||a.lat.toFixed(5)+\":\"+a.lon.toFixed(5);var prev=merged.get(key);if(!prev||aircraftAge(a)<aircraftAge(prev))merged.set(key,a)});\n          ok++;tileDone=true;break\n        }catch(e){errors.push(source.name+\" tile \"+(ti+1)+\": \"+String(e.message||e))}\n      }\n      if(!tileDone&&tiles.length===1)break\n    }\n    if(ok){\n      var list=Array.from(merged.values()).filter(function(a){return a.lat>=bbox[0]&&a.lat<=bbox[2]&&a.lon>=bbox[1]&&a.lon<=bbox[3]}),now=Date.now(),summary=directPositionSummary(list);\n      return{source:\"DIRECT \u00b7 \"+source.name,generatedAt:new Date(sourceTime||now).toISOString(),sourceTimestamp:new Date(sourceTime||now).toISOString(),receivedAt:new Date(now).toISOString(),snapshotAgeSec:Math.max(0,(now-(sourceTime||now))/1000),positionAgeSec:summary,feedState:\"live\",total:list.length,uncappedTotal:list.length,sourceStats:[{source:source.name,ok:true,count:list.length,direct:true}],aircraft:list,stale:false,cached:false,direct:true,errors:errors}\n    }\n  }\n  throw new Error(errors.join(\" | \")||\"all browser-direct sources failed\")\n}\n\nfunction viewportBbox(expand){\n  var b=map.getBounds(),latPad=(b.getNorth()-b.getSouth())*(expand||.08),lonPad=(b.getEast()-b.getWest())*(expand||.08);\n  return[clamp(b.getSouth()-latPad,-85,85),clamp(b.getWest()-lonPad,-180,180),clamp(b.getNorth()+latPad,-85,85),clamp(b.getEast()+lonPad,-180,180)]\n}\nfunction bboxParam(b){return b.map(function(v){return Number(v.toFixed(3))}).join(\",\")}\nfunction viewportRadiusNm(){\n  var c=map.getCenter(),b=map.getBounds(),corners=[[b.getNorth(),b.getEast()],[b.getSouth(),b.getWest()],[b.getNorth(),b.getWest()],[b.getSouth(),b.getEast()]];\n  return clamp(Math.ceil(Math.max.apply(null,corners.map(function(p){return distanceNm(c.lat,c.lng,p[0],p[1])}))*1.12),15,450)\n}\nfunction trafficViewportDataKey(){\n  var c=map.getCenter(),b=viewportBbox(.04);\n  return[c.lng.toFixed(2),c.lat.toFixed(2),map.getZoom().toFixed(1),bboxParam(b),state.coverageMode].join(\"|\")\n}\nfunction referenceViewportDataKey(){\n  var c=map.getCenter(),b=viewportBbox(.04);\n  return[c.lng.toFixed(1),c.lat.toFixed(1),Math.floor(map.getZoom()),bboxParam(b)].join(\"|\")\n}\nasync function loadTrafficViewport(force){\n  var key=trafficViewportDataKey();if(!force&&key===lastTrafficViewportKey)return;lastTrafficViewportKey=key;\n  var token=++trafficRequestToken,bbox=viewportBbox(.10),param=bboxParam(bbox),c=map.getCenter(),radius=viewportRadiusNm(),zoom=map.getZoom();\n  trafficClock.lastAttemptAt=Date.now();refreshTrafficStatus();\n  try{\n    var d,direct=false;\n    try{\n      var result=await fetchApiJson(\"/api/traffic?lat=\"+encodeURIComponent(c.lat)+\"&lon=\"+encodeURIComponent(c.lng)+\"&radius=\"+radius+\"&bbox=\"+encodeURIComponent(param)+\"&zoom=\"+encodeURIComponent(zoom)+\"&coverage=\"+encodeURIComponent(state.coverageMode)+\"&_=\"+Date.now(),{cache:\"no-store\"});\n      d=result.data;\n      if((!d.aircraft||!d.aircraft.length)&&radius<=450){try{var directZero=await fetchDirectTraffic(bbox,c,radius);if(directZero&&directZero.aircraft&&directZero.aircraft.length){d=directZero;direct=true;d.errors=(d.errors||[]).concat([\"Worker returned zero targets; browser-direct fallback supplied traffic\"])}}catch(zeroError){d.errors=(d.errors||[]).concat([\"Zero-target fallback failed: \"+String(zeroError.message||zeroError)])}}\n    }catch(serverError){\n      d=await fetchDirectTraffic(bbox,c,radius);direct=true;d.errors=(d.errors||[]).concat([\"Worker path failed: \"+String(serverError.message||serverError)])\n    }\n    if(token!==trafficRequestToken)return;\n    traffic=Array.isArray(d.aircraft)?d.aircraft:[];prepareTrafficProjection(traffic);trafficMeta=d;recordTrafficSuccess(d,direct);saveTrafficSnapshotV71(d);\n    dataHealth.traffic={state:(trafficClock.state===\"live\"?\"ok\":\"warning\"),count:traffic.length,source:d.source||\"ADS-B\",error:(d.partial?\"Partial tile coverage. \":\"\")+(d.coverageLimited?\"Viewport exceeds regional tile envelope. \":\"\")+(d.errors&&d.errors.length?d.errors.slice(-2).join(\" \u00b7 \"):\"\")};\n    syncAllSources();scheduleTrafficCanvasRender();if(selectedAirport)renderAirportInfo();if(panelTab===\"status\"&&$(\"sidePanel\").classList.contains(\"open\"))renderPanel()\n  }catch(e){\n    recordTrafficFailure(e);dataHealth.traffic={state:\"error\",count:traffic.length,source:dataHealth.traffic.source||\"\",error:String(e.message||e)};\n    if(panelTab===\"status\"&&$(\"sidePanel\").classList.contains(\"open\"))renderPanel()\n  }\n}\nasync function loadReferenceViewport(force){\n  var key=referenceViewportDataKey();if(!force&&key===lastReferenceViewportKey)return;lastReferenceViewportKey=key;\n  var token=++referenceRequestToken,bbox=viewportBbox(.10),param=bboxParam(bbox),zoom=map.getZoom();\n  dataHealth.airports.state=\"loading\";dataHealth.navaids.state=\"loading\";dataHealth.weather.state=\"loading\";dataHealth.airspace.state=\"loading\";\n  if(panelTab===\"status\"&&$(\"sidePanel\").classList.contains(\"open\"))renderPanel();\n\n  var results=await Promise.all([\n    fetchApiResult(\"/api/airports?bbox=\"+encodeURIComponent(param)+\"&zoom=\"+encodeURIComponent(zoom),{cache:\"no-store\"}),\n    fetchApiResult(\"/api/navaids?bbox=\"+encodeURIComponent(param)+\"&zoom=\"+encodeURIComponent(zoom),{cache:\"no-store\"}),\n    fetchApiResult(\"/api/weather?bbox=\"+encodeURIComponent(param)+\"&_=\"+Date.now(),{cache:\"no-store\"}),\n    fetchApiResult(\"/api/airspace?bbox=\"+encodeURIComponent(param)+\"&_=\"+Date.now(),{cache:\"no-store\"})\n  ]);\n  if(token!==referenceRequestToken)return;\n\n  var airportResult=results[0],navaidResult=results[1],weatherResult=results[2],airspaceResult=results[3];\n  if(airportResult.ok){\n    airports=Array.isArray(airportResult.data.airports)?airportResult.data.airports:[];\n    dataHealth.airports={state:\"ok\",count:airports.length,source:airportResult.data.source||\"Airport catalogue\",error:airportResult.data.stale?\"Using cached airport data\":\"\"}\n  }else{\n    dataHealth.airports={state:\"error\",count:airports.length,source:dataHealth.airports.source||\"\",error:airportResult.data.error||\"Airport API failed\"}\n  }\n\n  if(navaidResult.ok){\n    navaids=Array.isArray(navaidResult.data.navaids)?navaidResult.data.navaids:[];\n    dataHealth.navaids={state:\"ok\",count:navaids.length,source:navaidResult.data.source||\"Navaid catalogue\",error:navaidResult.data.stale?\"Using cached navaid data\":\"\"}\n  }else{\n    dataHealth.navaids={state:\"error\",count:navaids.length,source:dataHealth.navaids.source||\"\",error:navaidResult.data.error||\"Navaid API failed\"}\n  }\n\n  if(weatherResult.ok){\n    var w=weatherResult.data;\n    weather={metars:Array.isArray(w.metars)?w.metars:[],tafs:Array.isArray(w.tafs)?w.tafs:[],pireps:Array.isArray(w.pireps)?w.pireps:[],gairmets:w.gairmets||emptyFC(),sigmets:w.sigmets||emptyFC(),cwas:w.cwas||emptyFC(),tcf:w.tcf||emptyFC()};\n    lastWeatherAt=Date.parse(w.generatedAt||\"\")||Date.now();\n    dataHealth.weather={state:\"ok\",count:weather.metars.length,source:w.source||\"Aviation weather\",error:(w.errors&&w.errors.length)?w.errors.join(\" \u00b7 \"):w.stale?\"Using cached weather\":\"\"}\n    if(state.windFlow)loadWinds();\n  }else{\n    dataHealth.weather={state:\"error\",count:(weather.metars||[]).length,source:dataHealth.weather.source||\"\",error:weatherResult.data.error||\"Weather API failed\"}\n  }\n\n  if(airspaceResult.ok){\n    var s=airspaceResult.data;airspace=s.airspace&&Array.isArray(s.airspace.features)?s.airspace:emptyFC();\n    dataHealth.airspace={state:\"ok\",count:airspace.features.length,source:s.source||\"FAA special use airspace\",error:s.stale?\"Using cached airspace\":\"\"}\n  }else{\n    dataHealth.airspace={state:\"error\",count:(airspace.features||[]).length,source:dataHealth.airspace.source||\"\",error:airspaceResult.data.error||\"Airspace API failed\"}\n  }\n\n  syncAllSources();\n  if(selectedAirport)renderAirportInfo();\n  if(state.radar)updateRadarImage();\n  if(state.lightning)updateLightningImage();\n  if(panelTab===\"status\"&&$(\"sidePanel\").classList.contains(\"open\"))renderPanel()\n}\nasync function loadViewportData(force){\n  await Promise.allSettled([loadTrafficViewport(!!force),loadReferenceViewport(!!force)])\n}\nfunction scheduleViewportLoad(force){\n  clearTimeout(trafficViewportTimer);clearTimeout(referenceViewportTimer);\n  trafficViewportTimer=setTimeout(function(){loadTrafficViewport(!!force)},force?30:260);\n  referenceViewportTimer=setTimeout(function(){loadReferenceViewport(!!force)},force?80:850)\n}\nasync function loadAirports(){return loadReferenceViewport(true)}\nasync function loadTraffic(manual){\n  if(manual)$(\"refreshBtn\").disabled=true;\n  try{await loadTrafficViewport(true)}finally{if(manual)$(\"refreshBtn\").disabled=false}\n}\nasync function loadWeather(){return loadReferenceViewport(true)}\nfunction updateStats(){\n  var now=Date.now(),age=formatTrafficAge(sourceAgeSeconds()),wx=lastWeatherAt?formatTrafficAge(Math.max(0,(now-lastWeatherAt)/1000)):\"\u2014\";\n  refreshTrafficStatus();\n  var stateNow=trafficFreshnessState(),sinceSuccess=trafficClock.lastSuccessAt?(now-trafficClock.lastSuccessAt)/1000:Infinity;\n  if(stateNow===\"offline\"&&sinceSuccess>300&&traffic.length&&!trafficClearedForStale){\n    traffic=[];trafficMeta=Object.assign({},trafficMeta,{uncappedTotal:0,total:0});prepareTrafficProjection(traffic);scheduleTrafficCanvasRender();trafficClearedForStale=true\n  }\n  var count=traffic.filter(function(a){return matchesTraffic(a)}).length;$(\"topAircraft\").textContent=count;$(\"barAircraft\").textContent=count;$(\"topAge\").textContent=age;$(\"topWx\").textContent=wx;\n  $(\"barMetar\").textContent=(weather.metars||[]).length;$(\"barPirep\").textContent=(weather.pireps||[]).length;updateDetailContext()\n}\nfunction openCommand(){\n  var d=$(\"commandDialog\");if(!d.open)d.showModal();$(\"commandInput\").value=\"\";renderCommands(\"\");setTimeout(function(){$(\"commandInput\").focus()},0)\n}\nfunction commandCatalog(){\n  var commands=[\n    {title:\"Open map layers\",sub:\"Aviation, VFR Sectional, IFR Low and IFR High\",run:function(){openPanel(\"base\")}},\n    {title:\"Open weather layers\",sub:\"Radar, GOES, lightning, METAR and weather hazards\",run:function(){openPanel(\"weather\")}},\n    {title:\"Open special use airspace\",sub:\"MOAs, restricted, prohibited, warning and alert areas\",run:function(){openPanel(\"airspace\")}},\n    {title:\"Open traffic settings\",sub:\"Labels, vectors and filters\",run:function(){openPanel(\"traffic\")}},\n    {title:\"Open data status\",sub:\"Traffic, airports, navaids and weather health\",run:function(){openPanel(\"status\")}},\n    {title:\"Return to KAPN\",sub:\"Close panels and restore the home operating picture\",run:function(){goHome(true)}},\n    {title:\"Toggle NOAA radar\",sub:state.radar?\"Turn radar off\":\"Turn radar on\",run:function(){state.radar=!state.radar;saveState();syncVisibility();if(state.radar)updateRadarImage();renderPanel()}},\n    {title:\"Toggle clean view\",sub:\"Hide or restore application chrome\",run:function(){setClean(!state.clean)}},\n    {title:\"VFR Sectional\",sub:\"Official FAA Sectional chart-only mode\",run:function(){setBase(\"vfr\")}},\n    {title:\"IFR Low\",sub:\"Official FAA Low Enroute chart-only mode\",run:function(){setBase(\"ifr-low\")}},\n    {title:\"IFR High\",sub:\"Official FAA High Enroute chart-only mode\",run:function(){setBase(\"ifr-high\")}},\n    {title:\"Aviation map\",sub:\"Minimal airports, navaids and geographic context\",run:function(){setBase(\"aviation\")}}\n  ];\n  [25,50,100,150,250].forEach(function(r){commands.push({title:\"Set range to \"+r+\" NM\",sub:\"Fit around the current map center\",run:function(){setRange(r)}})});\n  traffic.slice(0,40).forEach(function(a){commands.push({title:aircraftName(a),sub:[a.r,a.t,altitude(a)].filter(Boolean).join(\" \u00b7 \"),aircraft:a,run:function(){selectAircraft(a)}})});\n  return commands\n}\nfunction renderCommands(q){\n  q=String(q||\"\").trim().toLowerCase();var list=$(\"commandList\");list.replaceChildren();\n  var items=commandCatalog().filter(function(c){return!q||(c.title+\" \"+c.sub).toLowerCase().includes(q)}).slice(0,18);\n  var label=document.createElement(\"div\");label.className=\"command-group\";label.textContent=q?\"RESULTS\":\"QUICK ACTIONS\";list.appendChild(label);\n  items.forEach(function(c){\n    var b=document.createElement(\"button\");b.type=\"button\";b.className=\"command-item\";\n    b.innerHTML=\"<div><strong>\"+escapeHtml(c.title)+\"</strong><span>\"+escapeHtml(c.sub||\"\")+\"</span></div>\"+(c.aircraft?\"<span class='command-key'>AIRCRAFT</span>\":\"\");\n    b.onclick=function(){$(\"commandDialog\").close();c.run()};list.appendChild(b)\n  })\n}\nfunction setRange(r){state.range=Number(r);saveState();document.querySelectorAll(\"[data-range]\").forEach(function(b){b.classList.toggle(\"active\",Number(b.dataset.range)===state.range)});syncAllSources();fitRange(true,map.getCenter());loadTraffic(false)}\nfunction setClean(on){state.clean=!!on;saveState();document.body.classList.toggle(\"clean\",state.clean);$(\"app\").classList.toggle(\"clean\",state.clean);setTimeout(function(){map.resize()},50)}\nfunction bindUI(){\n  document.querySelectorAll(\"[data-map-mode]\").forEach(function(b){b.onclick=function(){setBase(b.dataset.mapMode)}});\n  $(\"nativeZoomBtn\").onclick=snapChartNativeZoom;\n  document.querySelectorAll(\"[data-open-tab]\").forEach(function(b){b.onclick=function(){openPanel(b.dataset.openTab)}});\n  document.querySelectorAll(\".panel-tab\").forEach(function(b){b.onclick=function(){panelTab=b.dataset.tab;renderPanel()}});\n  document.querySelectorAll(\"[data-range]\").forEach(function(b){b.onclick=function(){setRange(b.dataset.range)}});\n  $(\"sideClose\").onclick=closePanel;$(\"infoClose\").onclick=closeInfo;$(\"homeBtn\").onclick=function(){goHome(true)};\n  $(\"fitRange\").onclick=function(){fitRange(true,map.getCenter())};$(\"zoomIn\").onclick=function(){map.zoomIn({duration:160})};$(\"zoomOut\").onclick=function(){map.zoomOut({duration:160})};\n  $(\"commandBtn\").onclick=openCommand;$(\"commandInput\").oninput=function(){renderCommands(this.value)};$(\"refreshBtn\").onclick=function(){loadTraffic(true);if(state.radar)updateRadarImage();if(state.lightning)updateLightningImage()};\n  $(\"radarTimelinePlay\").onclick=function(){setRadarLoop(!state.radarLoop)};\n  $(\"radarTimelineSlider\").oninput=function(){setRadarLoop(false);showRadarTimelineFrame(Number(this.value))};\n  $(\"weatherAltitudeSlider\").oninput=function(){state.weatherAltitudeIndex=Number(this.value);saveState();updateWeatherAltitudeUi();syncAllSources();if(state.windFlow)loadWinds()};\n  $(\"cleanBtn\").onclick=function(){setClean(true)};$(\"cleanReturn\").onclick=function(){setClean(false)};\n  document.addEventListener(\"keydown\",function(e){\n    var typing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement&&document.activeElement.tagName||\"\");\n    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()===\"k\"){e.preventDefault();openCommand();return}\n    if(typing)return;\n    if(e.key===\"Escape\"){closePanel();closeInfo()}\n    if(e.key.toLowerCase()===\"l\")openPanel(\"base\");\n    if(e.key.toLowerCase()===\"w\")openPanel(\"weather\");\n    if(e.key.toLowerCase()===\"a\")openPanel(\"airspace\");\n    if(e.key.toLowerCase()===\"t\")openPanel(\"traffic\")\n  })\n}\n\n\nvar missionV7Defaults={mode:\"fly\",phase:\"preflight\",active:false,analysis:null,selectedApproach:null,approachPack:null,customApproachCount:0,customPackState:\"loading\",planner:{origin:\"KAPN\",destination:\"\",route:\"\",rules:\"IFR\",preferredAltitude:7000,magneticCourse:\"\",aircraft:{type:\"C172\",category:\"A\",cruiseTas:115,fuelBurn:9,serviceCeiling:14000,rnav:true,waas:true,ifr:true}}};\nvar missionV7=JSON.parse(JSON.stringify(missionV7Defaults));\nfunction missionEscapeV7(value){return escapeHtml(value==null?\"\":String(value))}\n\nfunction customApproachesForDestinationV71(destination){\n  var pack=missionV7.approachPack||{},aliases=[String(destination||\"\").toUpperCase()];if(/^K[A-Z0-9]{3}$/.test(aliases[0]))aliases.push(aliases[0].slice(1));return(pack.procedures||[]).filter(function(x){return aliases.includes(String(x.airport||\"\").toUpperCase())})\n}\nfunction updateCustomPackBadgeV71(){\n  var total=missionV7.approachPack&&Array.isArray(missionV7.approachPack.procedures)?missionV7.approachPack.procedures.length:0,text=missionV7.customPackState===\"missing\"?\"NO PACK\":missionV7.customPackState===\"error\"?\"ERROR\":\"CUSTOM \"+total;customNavBadge.textContent=text;customMobileBadge.textContent=missionV7.customPackState===\"ok\"?String(total):\"!\"\n}\nasync function loadCustomApproachSummaryV71(destination){\n  try{var response=await fetchApiJson(\"/api/approach-pack\",{cache:\"no-store\"}),pack=response.data||{};missionV7.approachPack=pack;missionV7.customPackState=pack.warning&&/404/.test(String(pack.warning))?\"missing\":\"ok\";missionV7.customApproachCount=destination?customApproachesForDestinationV71(destination).length:0;updateCustomPackBadgeV71();return pack}catch(e){missionV7.approachPack=null;missionV7.customPackState=\"error\";missionV7.customApproachCount=0;updateCustomPackBadgeV71();return null}\n}\nfunction customPackCardV71(){\n  var destination=missionV7.analysis&&missionV7.analysis.input&&missionV7.analysis.input.destination||missionV7.planner.destination||\"\";\n  if(missionV7.customPackState===\"loading\")return\"<div class='custom-pack-card'><strong>ATEFLIGHT CUSTOM APPROACHES</strong><span>Checking the installed custom approach pack\u2026</span></div>\";\n  if(missionV7.customPackState===\"missing\")return\"<div class='custom-pack-card missing'><strong>CUSTOM APPROACH PACK NOT INSTALLED</strong><span>The planner and FAA Library still work. Add the manifest and custom chart assets when they are ready.</span></div>\";\n  if(missionV7.customPackState===\"error\")return\"<div class='custom-pack-card missing'><strong>CUSTOM APPROACH PACK UNKNOWN</strong><span>AteFlight could not verify the custom manifest.</span></div>\";\n  var count=destination?customApproachesForDestinationV71(destination).length:(missionV7.approachPack.procedures||[]).length;\n  return\"<div class='custom-pack-card \"+(count?\"available\":\"\")+\"'><strong>ATEFLIGHT CUSTOM APPROACHES \u00b7 \"+count+\"</strong><span>\"+(destination?(count?count+\" custom product\"+(count===1?\"\":\"s\")+\" available for \"+destination:\"Pack connected \u00b7 no custom procedure registered for \"+destination):\"Pack connected\")+\" \u00b7 cycle \"+missionEscapeV7(missionV7.approachPack.cycle||\"UNSET\")+\"</span></div>\"\n}\n\nfunction loadMissionStateV7(){try{var saved=JSON.parse(localStorage.getItem(\"ateflight-mission-v71\")||\"null\");if(saved)missionV7=Object.assign({},missionV7,saved,{planner:Object.assign({},missionV7.planner,saved.planner||{},{aircraft:Object.assign({},missionV7.planner.aircraft,saved.planner&&saved.planner.aircraft||{})})})}catch(e){}}\nfunction saveMissionStateV7(){try{localStorage.setItem(\"ateflight-mission-v71\",JSON.stringify({mode:missionV7.mode,phase:missionV7.phase,active:missionV7.active,analysis:missionV7.analysis,selectedApproach:missionV7.selectedApproach,planner:missionV7.planner}))}catch(e){}}\nfunction readPlannerV7(){missionV7.planner={origin:planOrigin.value.trim().toUpperCase(),destination:planDestination.value.trim().toUpperCase(),route:planRoute.value.trim().toUpperCase(),rules:planRules.value,preferredAltitude:Number(planPreferredAltitude.value)||null,magneticCourse:planMagneticCourse.value===\"\"?null:Number(planMagneticCourse.value),aircraft:{type:profileType.value.trim().toUpperCase(),category:profileCategory.value,cruiseTas:Number(profileTas.value)||null,fuelBurn:Number(profileFuelBurn.value)||null,serviceCeiling:Number(profileCeiling.value)||null,rnav:profileRnav.checked,waas:profileWaas.checked,ifr:profileIfr.checked}};saveMissionStateV7();return missionV7.planner}\nfunction writePlannerV7(){var p=missionV7.planner||missionV7Defaults.planner;planOrigin.value=p.origin||\"\";planDestination.value=p.destination||\"\";planRoute.value=p.route||\"\";planRules.value=p.rules||\"IFR\";planPreferredAltitude.value=p.preferredAltitude||\"\";planMagneticCourse.value=p.magneticCourse==null?\"\":p.magneticCourse;var a=p.aircraft||{};profileType.value=a.type||\"\";profileCategory.value=a.category||\"A\";profileTas.value=a.cruiseTas||\"\";profileFuelBurn.value=a.fuelBurn||\"\";profileCeiling.value=a.serviceCeiling||\"\";profileRnav.checked=!!a.rnav;profileWaas.checked=!!a.waas;profileIfr.checked=!!a.ifr}\nfunction missionSourceV7(item){return item&&item.source||null}\nfunction missionDecisionHtmlV7(item,stateName){var encoded=encodeURIComponent(JSON.stringify({item:item,state:stateName}));return\"<article class='story-item'><strong>\"+missionEscapeV7(item.title)+\"</strong><p>\"+missionEscapeV7(item.consequence||\"\")+\"</p><button data-why='\"+encoded+\"' type='button'>WHY?</button></article>\"}\nfunction missionSectionV7(name,items){var element=$(\"story\"+name.charAt(0).toUpperCase()+name.slice(1)),count=$(\"story\"+name.charAt(0).toUpperCase()+name.slice(1)+\"Count\");items=items||[];count.textContent=items.length;element.innerHTML=items.length?items.map(function(item){return missionDecisionHtmlV7(item,name)}).join(\"\"):\"<div class='story-empty'>No \"+name.toUpperCase()+\" items.</div>\"}\nfunction phaseNextV7(){var unknown=missionV7.analysis&&missionV7.analysis.decisions&&missionV7.analysis.decisions.unknown||[];if(missionV7.phase===\"preflight\")return unknown.length?{title:\"Resolve UNKNOWN items before departure\",detail:\"Terrain, minimum altitude, route gaps, weather, and equipment assumptions must be confirmed.\"}:{title:\"Complete the departure briefing\",detail:\"Confirm clearance, runway, initial route, and immediate threats.\"};if(missionV7.phase===\"departure\")return{title:\"Fly the actual clearance\",detail:\"AteFlight recommendations are secondary to ATC clearance and approved navigation.\"};if(missionV7.phase===\"enroute\")return{title:\"Monitor path, fuel, weather, and threats\",detail:\"Re-evaluate changes against the airplane and destination.\"};if(missionV7.phase===\"arrival\")return{title:\"Confirm runway and approach strategy\",detail:\"Wind, weather, route geometry, equipment, and NOTAM consequences should drive the arrival story.\"};if(missionV7.phase===\"approach\")return{title:\"Actual approach clearance controls\",detail:\"Final path, applicable minimum, runway environment, and missed action should dominate.\"};if(missionV7.phase===\"missed\")return{title:\"Execute the published missed approach\",detail:\"Immediate course and altitude first; then route, terrain, and hold.\"};return{title:\"Clear the runway and transition to ground\",detail:\"Runway remaining, exit, hotspots, tower, and ground become primary.\"}}\nfunction renderFlightStoryV7(){var a=missionV7.analysis,selected=missionV7.selectedApproach;if(!a){storyTitle.textContent=\"No active flight\";storyMeta.textContent=\"Build a plan to create contextual guidance.\";storyNext.innerHTML=\"<span>NEXT</span><strong>Build or activate a flight</strong><p>AteFlight cannot prioritize the story without a destination.</p>\";[\"active\",\"context\",\"unknown\",\"suppressed\"].forEach(function(n){missionSectionV7(n,[])});sourceLedger.innerHTML=\"\";return}storyTitle.textContent=(a.origin&&a.origin.id||a.input.origin)+\" \u2192 \"+(a.destination&&a.destination.id||a.input.destination);storyMeta.textContent=(a.route.knownDistanceNm||a.route.directDistanceNm||0)+\" NM resolved \u00b7 \"+a.input.rules+\" \u00b7 \"+a.route.completeness+\"% token resolution\";var next=phaseNextV7();storyNext.innerHTML=\"<span>NEXT</span><strong>\"+missionEscapeV7(next.title)+\"</strong><p>\"+missionEscapeV7(next.detail)+\"</p>\";var decisions=JSON.parse(JSON.stringify(a.decisions||{active:[],context:[],unknown:[],suppressed:[]}));if(missionV7.customApproachCount>0){var approachDecision={id:\"custom-approach-available\",title:missionV7.customApproachCount+\" AteFlight custom approach product\"+(missionV7.customApproachCount===1?\"\":\"s\")+\" available\",consequence:\"Available in Library for the planned destination. The actual ATC clearance remains controlling.\",why:[\"The installed AteFlight custom approach manifest contains destination-matched products.\",\"Custom pack cycle \"+(missionV7.approachPack&&missionV7.approachPack.cycle||\"UNSET\")],source:\"AteFlight custom approach pack\"};(missionV7.phase===\"arrival\"||missionV7.phase===\"approach\"?decisions.active:decisions.context).unshift(approachDecision)}if(selected)decisions.context.unshift({id:\"approach-context\",title:(selected.title||selected.name||\"Selected approach\")+\" selected\",consequence:\"Context only \u00b7 actual ATC clearance remains controlling.\",why:[\"Selected from the AteFlight/FAA procedure library.\",selected.source||\"\"]});[\"active\",\"context\",\"unknown\",\"suppressed\"].forEach(function(n){missionSectionV7(n,decisions[n]||[])});document.querySelectorAll(\"[data-why]\").forEach(function(button){button.onclick=function(){openWhyV7(button.dataset.why)}});sourceLedger.innerHTML=(a.sources||[]).map(function(source){return\"<div class='ledger-row'><strong>\"+missionEscapeV7(source.name)+\"</strong><span>\"+missionEscapeV7(source.role)+\" \u00b7 \"+missionEscapeV7(source.freshness)+\" \u00b7 \"+(source.authoritative?\"AUTHORITATIVE\":\"SUPPLEMENTAL\")+\"</span></div>\"}).join(\"\")}\nfunction openWhyV7(encoded){try{var data=JSON.parse(decodeURIComponent(encoded)),item=data.item||{};whyTitle.textContent=item.title||\"Decision detail\";whyBody.innerHTML=\"<div class='why-evidence \"+(data.state===\"unknown\"?\"why-unknown\":\"\")+\"'><strong>OPERATIONAL MEANING</strong><br>\"+missionEscapeV7(item.consequence||\"No consequence text\")+\"</div><h4>EVIDENCE AND ASSUMPTIONS</h4>\"+(item.why||[]).map(function(line){return\"<div class='why-evidence'>\"+missionEscapeV7(line)+\"</div>\"}).join(\"\");whyDialog.showModal()}catch(e){}}\nfunction updateMissionChromeV7(){document.body.classList.remove(\"mission-fly\",\"mission-plan\",\"mission-airport\",\"mission-weather\",\"mission-library\");document.body.classList.add(\"mission-\"+missionV7.mode);document.querySelectorAll(\"[data-mission]\").forEach(function(button){button.classList.toggle(\"active\",button.dataset.mission===missionV7.mode)});document.querySelectorAll(\"[data-phase]\").forEach(function(button){button.classList.toggle(\"active\",button.dataset.phase===missionV7.phase)});phaseBadge.textContent=missionV7.phase.toUpperCase();if(missionV7.analysis)activeFlightBadge.textContent=(missionV7.analysis.input.origin||\"\")+\" \u2192 \"+(missionV7.analysis.input.destination||\"\")+\" \u00b7 \"+missionV7.analysis.input.rules;else activeFlightBadge.textContent=\"NO ACTIVE FLIGHT\";plannerWorkspace.classList.toggle(\"open\",missionV7.mode===\"plan\");libraryWorkspace.classList.toggle(\"open\",missionV7.mode===\"library\");flightStory.style.display=[\"airport\",\"weather\",\"library\"].includes(missionV7.mode)?\"none\":\"block\";phaseStrip.style.display=[\"plan\",\"fly\"].includes(missionV7.mode)?\"grid\":\"none\"}\nfunction setMissionModeV7(mode){if(mode===\"airport\"){missionV7.mode=\"airport\";updateMissionChromeV7();openDestinationAirportV7();return}if(mode===\"weather\"){missionV7.mode=\"weather\";updateMissionChromeV7();openPanel(\"weather\");return}missionV7.mode=mode;saveMissionStateV7();updateMissionChromeV7();if(mode===\"library\")loadApproachLibraryV7();setTimeout(function(){map.resize();map.easeTo({padding:cameraPadding(),duration:150})},30)}\nasync function analyzePlanV7(){var input=readPlannerV7();if(!input.destination){plannerResult.innerHTML=\"<p>Destination is required.</p>\";return}analyzePlanBtn.disabled=true;analyzePlanBtn.textContent=\"ANALYZING\u2026\";try{var response=await fetchApiJson(\"/api/plan\",{method:\"POST\",headers:{\"content-type\":\"application/json\"},body:JSON.stringify(input)});missionV7.analysis=response.data;missionV7.active=false;activatePlanBtn.disabled=!response.data.ok;await loadCustomApproachSummaryV71(response.data.input.destination);saveMissionStateV7();renderPlannerResultV7();renderFlightStoryV7();syncMissionMapV7();fitMissionRouteV7()}catch(error){plannerResult.innerHTML=\"<p class='route-note'>\"+missionEscapeV7(error.message)+\"</p>\"}finally{analyzePlanBtn.disabled=false;analyzePlanBtn.textContent=\"ANALYZE FLIGHT\"}}\nfunction renderPlannerResultV7(){var a=missionV7.analysis;if(!a){plannerResult.innerHTML=\"<p>Enter a destination to begin.</p>\"+customPackCardV71();return}var route=a.route||{},tokens=a.tokenResults||[],alts=a.altitudeCandidates||[];plannerResult.innerHTML=\"<div class='result-summary'><div><span>RESOLVED</span><strong>\"+(route.knownDistanceNm||0)+\" NM</strong></div><div><span>COURSE</span><strong>\"+(route.courseUsed==null?\"\u2014\":Math.round(route.courseUsed)+\"\u00b0\")+\"</strong></div><div><span>GEOMETRY</span><strong>\"+(route.completeness||0)+\"%</strong></div></div><div class='token-strip'>\"+tokens.map(function(t){return\"<span class='token-chip \"+t.status+\"'>\"+missionEscapeV7(t.token)+\"</span>\"}).join(\"\")+\"</div><h4>PRELIMINARY ALTITUDE CANDIDATES</h4><div class='altitude-list'>\"+(alts.length?alts.map(function(x){return\"<div class='altitude-row'><strong>\"+Number(x.altitudeFt).toLocaleString()+\"</strong><span>\"+(x.estimatedTimeMinutes==null?\"Time unknown\":x.estimatedTimeMinutes+\" min\")+\" \u00b7 \"+(x.estimatedFuel==null?\"Fuel unknown\":x.estimatedFuel+\" gal\")+\"</span><em>UNKNOWN</em></div>\"}).join(\"\"):\"<p>No candidate generated.</p>\")+\"</div>\"+customPackCardV71()}\nfunction fitMissionRouteV7(){var a=missionV7.analysis,pts=a&&a.route&&a.route.points||[];if(!map||pts.length<2)return;var b=new maplibregl.LngLatBounds();pts.forEach(function(p){b.extend([p.lon,p.lat])});map.fitBounds(b,{padding:cameraPadding({top:70,bottom:70}),duration:500,maxZoom:10})}\nasync function loadApproachLibraryV7(){var a=missionV7.analysis,destination=a&&a.destination&&a.destination.id||a&&a.input&&a.input.destination;if(!destination){libraryTitle.textContent=\"Destination procedures\";customApproachList.innerHTML=officialApproachList.innerHTML=\"<div class='approach-empty'>Build a flight first.</div>\";return}libraryTitle.textContent=destination+\" procedures\";customApproachList.innerHTML=officialApproachList.innerHTML=\"<div class='approach-empty'>Loading procedures\u2026</div>\";var results=await Promise.allSettled([fetchApiJson(\"/api/approach-pack\",{cache:\"no-store\"}),fetchApiJson(\"/api/procedures?ident=\"+encodeURIComponent(destination),{cache:\"no-store\"})]);missionV7.approachPack=results[0].status===\"fulfilled\"?results[0].value.data:null;missionV7.customPackState=missionV7.approachPack&&missionV7.approachPack.warning&&/404/.test(String(missionV7.approachPack.warning))?\"missing\":missionV7.approachPack?\"ok\":\"error\";missionV7.customApproachCount=customApproachesForDestinationV71(destination).length;updateCustomPackBadgeV71();missionV7.officialProcedures=results[1].status===\"fulfilled\"&&results[1].value.data?results[1].value.data.procedures||[]:[];var aliases=[String(destination).toUpperCase()];if(/^K[A-Z0-9]{3}$/.test(aliases[0]))aliases.push(aliases[0].slice(1));var custom=(missionV7.approachPack&&missionV7.approachPack.procedures||[]).filter(function(x){return aliases.includes(String(x.airport||\"\").toUpperCase())});customProcedureCount.textContent=custom.length;officialProcedureCount.textContent=missionV7.officialProcedures.length;customPackCycle.textContent=\"CYCLE \"+missionEscapeV7(missionV7.approachPack&&missionV7.approachPack.cycle||\"UNSET\");customApproachList.innerHTML=custom.length?custom.map(function(x,i){return approachRowV7(x,\"CUSTOM\",i)}).join(\"\"):\"<div class='approach-empty'>No custom procedures installed for \"+missionEscapeV7(destination)+\".</div>\";officialApproachList.innerHTML=missionV7.officialProcedures.length?missionV7.officialProcedures.map(function(x,i){return approachRowV7({title:x.name||x.chartName||\"FAA Procedure\",subtitle:[x.code,x.amendment].filter(Boolean).join(\" \u00b7 \"),chartUrl:x.url||x.pdfUrl,airport:destination},\"FAA\",i)}).join(\"\"):\"<div class='approach-empty'>No FAA d-TPP list returned.</div>\";bindApproachRowsV7()}\nfunction approachRowV7(item,source,index){var meta=encodeURIComponent(JSON.stringify({source:source,index:index,title:item.title||item.name||\"Approach\",url:item.chartUrl||item.url||\"\"}));return\"<article class='approach-row'><span class='type'>\"+source+\"</span><div><strong>\"+missionEscapeV7(item.title||item.name||\"Approach\")+\"</strong><small>\"+missionEscapeV7(item.subtitle||[item.guidance,item.runway,item.id].filter(Boolean).join(\" \u00b7 \"))+\"</small></div><div style='display:flex;gap:4px'><button class='approach-open' data-approach-select='\"+meta+\"' type='button'>SELECT</button>\"+((item.chartUrl||item.url)?\"<button class='approach-open' data-approach-open='\"+meta+\"' type='button'>OPEN</button>\":\"\")+\"</div></article>\"}\nfunction approachItemFromEncodedV7(encoded){try{var m=JSON.parse(decodeURIComponent(encoded)),list=m.source===\"CUSTOM\"?(missionV7.approachPack&&missionV7.approachPack.procedures||[]):missionV7.officialProcedures||[],x=list[m.index]||{};return Object.assign({},x,{source:m.source,title:x.title||x.name||m.title,chartUrl:x.chartUrl||x.url||x.pdfUrl||m.url})}catch(e){return null}}\nfunction bindApproachRowsV7(){document.querySelectorAll(\"[data-approach-select]\").forEach(function(b){b.onclick=function(){var x=approachItemFromEncodedV7(b.dataset.approachSelect);if(x)selectApproachV7(x)}});document.querySelectorAll(\"[data-approach-open]\").forEach(function(b){b.onclick=function(){var x=approachItemFromEncodedV7(b.dataset.approachOpen);if(x&&x.chartUrl)openApproachViewerV7(x)}})}\nfunction selectApproachV7(item){missionV7.selectedApproach=item;saveMissionStateV7();syncMissionMapV7();renderFlightStoryV7();toast(\"Approach context selected \u00b7 actual ATC clearance remains controlling\",false)}\nfunction openApproachViewerV7(item){approachViewerTitle.textContent=item.title||\"Approach\";approachViewerFrame.src=item.chartUrl;approachViewer.showModal()}\nfunction openDestinationAirportV7(){var a=missionV7.analysis;if(!a||!a.destination){toast(\"Plan a destination first.\",true);setMissionModeV7(\"plan\");return}var id=String(a.destination.id||a.input.destination).toUpperCase(),airport=airports.find(function(x){return[airportCode(x),x.ident,x.icao,x.gps,x.iata].filter(Boolean).some(function(v){return String(v).toUpperCase()===id})});if(airport)selectAirport(airport);else{map.easeTo({center:[a.destination.lon,a.destination.lat],zoom:10,duration:450});toast(\"Destination centered. Select the airport symbol when reference data loads.\",false)}}\nfunction setPhaseV7(phase){missionV7.phase=phase;saveMissionStateV7();updateMissionChromeV7();renderFlightStoryV7();if(phase===\"approach\")loadApproachLibraryV7()}\nfunction bindMissionUIV7(){writePlannerV7();renderFlightStoryV7();updateMissionChromeV7();document.querySelectorAll(\"[data-mission]\").forEach(function(b){b.onclick=function(){setMissionModeV7(b.dataset.mission)}});document.querySelectorAll(\"[data-phase]\").forEach(function(b){b.onclick=function(){setPhaseV7(b.dataset.phase)}});displayBtn.onclick=function(){openPanel(\"base\")};plannerClose.onclick=function(){setMissionModeV7(\"fly\")};libraryClose.onclick=function(){setMissionModeV7(\"fly\")};analyzePlanBtn.onclick=analyzePlanV7;activatePlanBtn.onclick=activatePlanV7;clearPlanBtn.onclick=clearPlanV7;storyCollapse.onclick=function(){flightStory.classList.toggle(\"collapsed\");storyCollapse.textContent=flightStory.classList.contains(\"collapsed\")?\"\u203a\":\"\u2039\";setTimeout(function(){map.resize();map.easeTo({padding:cameraPadding(),duration:120})},20)};ledgerToggle.onclick=function(){var hidden=sourceLedger.hasAttribute(\"hidden\");if(hidden)sourceLedger.removeAttribute(\"hidden\");else sourceLedger.setAttribute(\"hidden\",\"\");ledgerToggle.querySelector(\"b\").textContent=hidden?\"HIDE\":\"SHOW\"};whyClose.onclick=function(){whyDialog.close()};approachViewerClose.onclick=function(){approachViewer.close();approachViewerFrame.src=\"about:blank\"};[planOrigin,planDestination,planRoute,planRules,planPreferredAltitude,planMagneticCourse,profileType,profileCategory,profileTas,profileFuelBurn,profileCeiling,profileRnav,profileWaas,profileIfr].forEach(function(c){c.addEventListener(\"change\",readPlannerV7)});if(missionV7.analysis){activatePlanBtn.disabled=!missionV7.analysis.ok;renderPlannerResultV7();syncMissionMapV7()}setMissionModeV7(missionV7.mode||\"fly\")}\nloadMissionStateV7();\nloadCustomApproachSummaryV71(missionV7.analysis&&missionV7.analysis.input&&missionV7.analysis.input.destination||missionV7.planner.destination||\"\").then(function(){renderPlannerResultV7();renderFlightStoryV7()});\n\nloadState();\nrestoreTrafficSnapshotV71();\n\nvar map=new maplibregl.Map({\n  container:\"map\",style:styleForBase(state.base),center:CENTER,zoom:6.1,bearing:0,pitch:0,\n  hash:false,interactive:true,dragPan:true,scrollZoom:true,doubleClickZoom:true,keyboard:true,\n  touchZoomRotate:true,touchPitch:false,dragRotate:false,pitchWithRotate:false,renderWorldCopies:false,\n  attributionControl:false,fadeDuration:120,cancelPendingTileRequestsWhileZooming:false\n});\nmap.touchZoomRotate.disableRotation();\nmap.addControl(new maplibregl.NavigationControl({showCompass:false,visualizePitch:false}),\"top-right\");\nmap.on(\"style.load\",afterStyleLoad);\nmap.on(\"styleimagemissing\",function(e){\n  if(/^plane-/.test(e.id)&&map.hasImage(\"alt-plane\")){\n    try{map.addImage(e.id,map.getImage(\"alt-plane\"))}catch(err){}\n  }\n});\nmap.on(\"moveend\",function(){updateMapModeUI();updateDetailContext();scheduleViewportLoad(false);if(state.radar)updateRadarImage();if(state.lightning)updateLightningImage();if(state.windFlow)scheduleWindFlow()});\nmap.on(\"zoom\",function(){updateMapModeUI();updateDetailContext()});\nmap.on(\"render\",renderTrafficCanvas);\nmap.on(\"mousemove\",function(e){updateMapCursor(e.point)});\nmap.on(\"mouseout\",function(){map.getCanvas().style.cursor=\"\"});\nmap.on(\"dragstart\",clearCameraModeFromUser);\nmap.on(\"zoomstart\",clearCameraModeFromUser);\nmap.on(\"load\",function(){installLayers();installMissionLayersV7();syncMissionMapV7();fitRange(false,{lng:CENTER[0],lat:CENTER[1]});updateDetailContext();if(traffic.length){syncAllSources();scheduleTrafficCanvasRender()}loadTrafficViewport(true);setTimeout(function(){loadReferenceViewport(true)},650)});\nupdateVisualViewport();bindUI();bindMissionUIV7();bindSheetGestures();setSheetDetent(\"peek\",false);setClean(state.clean);updateWeatherAltitudeUi();$(\"radarTimelineSlider\").value=String(state.radarFrameIndex);renderPanel();\nwindow.addEventListener(\"resize\",function(){updateVisualViewport();if(!isMobile())$(\"bottomBar\").classList.remove(\"sheet-open\");map.resize()});\nif(window.visualViewport){window.visualViewport.addEventListener(\"resize\",function(){updateVisualViewport();if(isMobile()&&$(\"infoPanel\").classList.contains(\"open\"))setSheetDetent(sheetDetent,false);map.resize()})}\ntrafficTimer=setInterval(function(){loadTrafficViewport(true)},TRAFFIC_POLL);\nweatherTimer=setInterval(function(){loadReferenceViewport(true)},WEATHER_POLL);\nsetInterval(updateStats,1000);\n})();\n</script>\n</body>\n</html>";


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/custom-approaches/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        if (url.pathname === "/api/traffic") return await traffic(request, ctx);
        if (url.pathname === "/api/weather") return await aviationWeatherV65(request, ctx);
        if (url.pathname === "/api/airspace") return await specialUseAirspaceV67(request, ctx);
        if (url.pathname === "/api/winds") return await windsAloftV68(request, ctx);
        if (url.pathname === "/api/weather-map-config") return await weatherMapConfigV68(request, ctx);
        if (url.pathname === "/api/trace") return await selectedTrace(request, ctx);
        if (url.pathname === "/api/route") return await routeLookup(request, ctx);
        if (url.pathname === "/api/airports") return await airportCatalogV65(request, ctx);
        if (url.pathname === "/api/navaids") return await navaidCatalogV65(request, ctx);
        if (url.pathname === "/api/airport-detail") return await airportDetail(request, ctx);
        if (url.pathname === "/api/procedures") return await airportProcedures(request, ctx);
        if (url.pathname === "/api/status") return await systemStatusV65(request, ctx);
        if (url.pathname === "/api/plan") return await flightPlanV7(request, ctx);
        if (url.pathname === "/api/approach-pack") return await customApproachPackV7(request, env);

        if (url.pathname === "/api/health") {
          return json({
            ok: true,
            version: "7.1",
            architecture: "ateflight-context-first-flight-story",
            mapEngine: "MapLibre GL JS 6.1.0",
            traffic: "TheAirTraffic / HPRadar / optional FlyItalyADSB",
            weather: "NOAA/NWS",
            bboxHelpers: true,
            apiErrorBoundary: true,
            airportCatalog: true,
            navaidCatalog: true,
            aviationWeather: true,
            featureStatus: "/api/status",
            specialUseAirspace: true,
            windsAloft: true,
            radarTimeline: true,
            weatherAltitudeSelector: true,
            flightPlanning: true,
            flightStory: true,
            decisionLedger: true,
            customApproachPack: true,
            productDoctrine: true,
            time: new Date().toISOString()
          });
        }

        return json({
          error: "API route not found",
          endpoint: url.pathname,
          version: "7.1"
        }, 404);
      } catch (error) {
        const requestId = typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        console.error("AteFlight API failure", {
          requestId,
          endpoint: url.pathname,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : null
        });

        return json({
          error: "AteFlight API request failed",
          detail: error instanceof Error ? error.message : String(error),
          endpoint: url.pathname,
          requestId,
          version: "7.1"
        }, 500);
      }
    }

    return new Response(PAGE, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
};
