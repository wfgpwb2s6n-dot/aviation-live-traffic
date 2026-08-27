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
        "user-agent": "Mozilla/5.0 AteFlight/6.8"
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
        "user-agent": "Mozilla/5.0 AteFlight/6.8 regional-traffic"
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
  const freshKey = new Request(`${u.origin}/__traffic_cache/v702/${coverageMode}/${scopeKey}/fresh`);
  const staleKey = new Request(`${u.origin}/__traffic_cache/v702/${coverageMode}/${scopeKey}/stale`);

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

  if (!result) {
    try {
      result = await queryGlobalMirrorV70R(bbox, lat, lon, radius);
      sourceStats.push({ source: result.source, ok: true, count: result.aircraft.length, successfulTiles: 1, requestedTiles: 1 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`global mirror: ${detail}`);
      sourceStats.push({ source: "global-mirror", ok: false, count: 0, error: detail });
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


const GLOBAL_MIRROR_SOURCES_V70R = [
  { name: "theairtraffic-global", url: "https://globe.theairtraffic.com/data/aircraft.json" },
  { name: "hpradar-global", url: "https://skylink.hpradar.com/data/aircraft.json" }
];

async function queryGlobalMirrorV70R(bbox, lat, lon, radius) {
  const errors = [];
  for (const source of GLOBAL_MIRROR_SOURCES_V70R) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9500);
    try {
      const response = await fetch(source.url, {
        headers: { "accept": "application/json", "user-agent": "AteFlight/7.0.2 global-fallback" },
        cf: { cacheEverything: true, cacheTtl: 20 },
        signal: controller.signal
      });
      const type = response.headers.get("content-type") || "";
      const length = Number(response.headers.get("content-length"));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number.isFinite(length) && length > 28_000_000) throw new Error(`response too large (${length} bytes)`);
      const text = await response.text();
      const raw = JSON.parse(text);
      const rows = Array.isArray(raw.aircraft) ? raw.aircraft : (Array.isArray(raw.ac) ? raw.ac : []);
      const aircraft = [];
      for (const item of rows) {
        const a = normalize(item);
        if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
        if (bbox ? withinBbox(a.lat, a.lon, bbox) : distanceNm(lat, lon, a.lat, a.lon) <= radius) aircraft.push(a);
      }
      return {
        source: source.name,
        aircraft,
        successfulTiles: 1,
        requestedTiles: 1,
        errors: [],
        urls: [source.url],
        sourceTimestampMs: sourceTimestampMs(raw)
      };
    } catch (error) {
      errors.push(`${source.name}: ${error instanceof Error ? error.message : String(error)} (${type || "unknown content type"})`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(errors.join(" | ") || "global mirrors failed");
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
        "user-agent": "AteFlight/6.8 weather-display contact=local-home-display"
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
        "user-agent": "AteFlight/6.8 selected-flight-trace"
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
          "user-agent": "AteFlight/6.8 static-route-lookup"
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
          "user-agent": "AteFlight/6.8 fallback-route-lookup"
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
        "user-agent": "AteFlight/6.8 airport-catalog"
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
        "user-agent": "AteFlight/6.8 airport-detail"
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
        "user-agent": "AteFlight/6.8 airport-detail"
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
      headers: { "user-agent": "AteFlight/6.8 FAA-dTPP" },
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
        "user-agent": "AteFlight/6.8 viewport-catalog"
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
        "user-agent": "AteFlight/6.8 winds-aloft"
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
    const response = await fetch(`${NDFD_SERVICE_V68}?f=json`, { headers: { "accept": "application/json", "user-agent": "AteFlight/6.8 weather-map-config" } });
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
      "user-agent": "AteFlight/6.8 FAA-SUA"
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
    version: "6.8",
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
      headers: { "accept": "application/json", "user-agent": "AteFlight/7.0.2 flight-planning" },
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
  const cacheKey=new Request(`${new URL(request.url).origin}/__flight_plan/v702/${encodeURIComponent(cacheParts.join("|")).slice(0,800)}`);
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
  const payload={ok:!!(origin&&destination),version:"7.0.2",generatedAt:new Date().toISOString(),cached:false,input:{origin:originId,destination:destinationId,route:routeTokens,rules,magneticCourse:hasMag?Number(body.magneticCourse):null,preferredAltitude:Number(body.preferredAltitude||profile.preferredAltitude)||null,aircraft:profile},origin,destination,tokenResults,route:{segments,gaps,points:sequence.map(x=>({token:x.token,role:x.role||"route",kind:x.point.kind,name:x.point.name,lat:x.point.lat,lon:x.point.lon})),knownDistanceNm:Math.round(knownDistanceNm*10)/10,directDistanceNm:directDistanceNm==null?null:Math.round(directDistanceNm*10)/10,trueCourse:trueCourse==null?null:Math.round(trueCourse),courseUsed:courseUsed==null?null:Math.round(courseUsed),courseBasis,completeness:sequence.length>1?Math.round(segments.length/(segments.length+gaps.length||1)*100):0},altitudeCandidates:candidates,weather:{origin:originWeather,destination:destinationWeather,tafOrigin:tafById.get(originId)||null,tafDestination:tafById.get(destinationId)||null},decisions:{active,context,unknown,suppressed:[]},sources:[{name:"AviationWeather.gov Navigational Data API",role:"Airport, navaid, fix, METAR, and TAF resolution",freshness:"Live service response",authoritative:true},{name:"Aircraft profile",role:"Cruise performance and service-ceiling constraints",freshness:"Pilot-maintained local profile",authoritative:false},{name:rules==="VFR"?"14 CFR 91.159":"14 CFR 91.179",role:"Directional cruising-altitude parity",freshness:"Rule reference",authoritative:true}],errors};
  const response=new Response(JSON.stringify(payload),{headers:{"content-type":"application/json","cache-control":`public, max-age=${PLAN_V7_TTL}`}});ctx.waitUntil(cache.put(cacheKey,response.clone()));return json(payload);
}

async function customApproachPackV7(request,env){
  try{const assetUrl=new URL("/custom-approaches/manifest.json",request.url),response=await env.ASSETS.fetch(new Request(assetUrl,{headers:{accept:"application/json"}}));if(!response.ok)throw new Error(`Asset HTTP ${response.status}`);const manifest=JSON.parse(await response.text());return json({...APPROACH_PACK_V7_FALLBACK,...manifest,procedures:Array.isArray(manifest.procedures)?manifest.procedures:[]})}
  catch(error){return json({...APPROACH_PACK_V7_FALLBACK,warning:error instanceof Error?error.message:String(error)})}
}

const PAGE = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\">\n<meta name=\"theme-color\" content=\"#09131c\">\n<title>AteFlight 7.0.2 \u00b7 Core Rebuild</title>\n<link rel=\"stylesheet\" href=\"https://unpkg.com/maplibre-gl@6.1.0/dist/maplibre-gl.css\">\n<style>\n:root{\n  color-scheme:dark;\n  --bg:#070d13;--chrome:#0a1219;--panel:#0d1821;--panel2:#111f2a;--panel3:#152735;\n  --border:#263b49;--border2:#365466;--text:#f4f8fa;--muted:#90a5b2;--dim:#657c89;\n  --cyan:#5ed2f2;--cyan2:#153e50;--green:#62da96;--amber:#f0bd58;--red:#ef6d77;--purple:#b779f7;\n  --shadow:0 22px 60px rgba(0,0,0,.42);--radius:10px;\n}\n*{box-sizing:border-box}\nhtml,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;font-feature-settings:\"tnum\" 1}\nbutton,input,select{font:inherit}button{color:inherit;cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}\n.app{height:100vh;height:100svh;height:100dvh;display:grid;grid-template-rows:58px minmax(0,1fr);overflow:hidden}\n.topbar{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:18px;align-items:center;padding:0 12px;background:var(--chrome);border-bottom:1px solid var(--border);z-index:50}\n.brand{display:flex;align-items:center;gap:10px;white-space:nowrap}.brandmark{width:34px;height:34px;border:1px solid var(--border2);border-radius:8px;display:grid;place-items:center;background:#0d1d27;color:var(--cyan);font-weight:950;font-size:11px;letter-spacing:.06em}.brand strong{display:block;font-size:15px;letter-spacing:.035em}.brand span{display:block;font-size:9px;color:var(--dim);letter-spacing:.09em;margin-top:2px}\n.flight-context{min-width:0;display:flex;justify-content:center;align-items:center;gap:8px}.route-chip,.phase-chip{height:34px;border:1px solid var(--border);border-radius:7px;background:#0d1821;display:flex;align-items:center;padding:0 11px;font-size:10px;font-weight:900;white-space:nowrap}.route-chip{max-width:360px;overflow:hidden;text-overflow:ellipsis}.phase-chip{color:#f7d688;border-color:#5c4b21;background:#241e0e}\n.data-strip{display:flex;align-items:center;gap:10px;white-space:nowrap}.feed{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:900}.dot{width:9px;height:9px;border-radius:50%;background:var(--amber);box-shadow:0 0 0 4px rgba(240,189,88,.10)}.dot.live{background:var(--green);box-shadow:0 0 0 4px rgba(98,218,150,.10)}.dot.bad{background:var(--red)}.stat{font-size:9px;color:var(--muted)}.stat strong{color:var(--text);font-size:11px;margin-right:3px}\n.header-actions{display:flex;gap:6px}.header-btn{height:34px;border:1px solid var(--border);border-radius:7px;background:var(--panel);padding:0 10px;font-size:9px;font-weight:900}.header-btn:hover,.header-btn.active{background:var(--cyan2);border-color:#377f99;color:#e2f9ff}\n.stage{position:relative;min-width:0;min-height:0;overflow:hidden}#map{position:absolute;inset:0}.maplibregl-canvas{outline:none}.maplibregl-ctrl-bottom-left,.maplibregl-ctrl-bottom-right{display:none}\n#trafficCanvas{position:absolute;inset:0;z-index:12;width:100%;height:100%;pointer-events:none}\n.rail{position:absolute;left:10px;top:10px;z-index:25;display:flex;flex-direction:column;gap:6px}.rail-btn{width:48px;height:48px;border:1px solid rgba(54,84,102,.88);border-radius:9px;background:rgba(8,17,24,.94);color:#9fb1bb;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;box-shadow:0 8px 22px rgba(0,0,0,.16)}.rail-btn b{font-size:16px;line-height:1}.rail-btn span{font-size:7px;font-weight:900;letter-spacing:.06em}.rail-btn:hover,.rail-btn.active{color:#e2f7ff;border-color:#3b8299;background:#123346}\n.map-badge{position:absolute;left:68px;top:10px;z-index:18;height:32px;display:flex;align-items:center;gap:7px;padding:0 9px;border:1px solid rgba(55,81,97,.55);border-radius:7px;background:rgba(8,17,24,.86);font-size:8px;color:var(--muted);backdrop-filter:blur(8px)}.map-badge strong{color:var(--text);font-size:9px}\n.drawer{position:absolute;z-index:35;left:68px;top:10px;bottom:48px;width:min(410px,calc(100vw - 88px));display:none;grid-template-rows:auto minmax(0,1fr);background:rgba(9,18,25,.985);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);overflow:hidden}.drawer.open{display:grid}.drawer-head{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--border)}.drawer-head strong{display:block;font-size:13px}.drawer-head span{display:block;font-size:9px;color:var(--muted);margin-top:2px}.close-btn{width:34px;height:34px;border:1px solid var(--border);border-radius:7px;background:var(--panel);font-size:20px}.drawer-body{min-height:0;overflow:auto;overscroll-behavior:contain;padding:14px}\n.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.field{display:grid;gap:5px}.field.wide{grid-column:1/-1}.field label{font-size:9px;color:#8da5b2;font-weight:900;letter-spacing:.06em}.field input,.field select{width:100%;height:42px;border:1px solid var(--border);border-radius:7px;background:#0a151d;color:var(--text);padding:0 10px;font-size:12px}.field textarea{width:100%;min-height:70px;border:1px solid var(--border);border-radius:7px;background:#0a151d;color:var(--text);padding:9px;font-size:12px;resize:vertical}.button-row{display:flex;gap:7px;margin-top:12px}.primary{height:38px;border:1px solid #3c8ca6;border-radius:7px;background:#123b4e;color:#e3f9ff;padding:0 12px;font-size:10px;font-weight:900}.secondary{height:38px;border:1px solid var(--border);border-radius:7px;background:var(--panel);color:#c4d2d9;padding:0 12px;font-size:10px;font-weight:900}.primary:disabled{opacity:.45;cursor:default}\n.section{margin-top:16px}.section-title{font-size:9px;color:#7993a1;font-weight:950;letter-spacing:.12em;margin-bottom:8px}.card{border:1px solid var(--border);border-radius:8px;background:#0b161e;padding:11px;margin-bottom:8px}.card.active{border-left:3px solid var(--green)}.card.context{border-left:3px solid var(--cyan)}.card.unknown{border-left:3px solid var(--amber)}.card.suppressed{border-left:3px solid #596b75}.card strong{display:block;font-size:12px}.card p{margin:5px 0 0;font-size:10px;line-height:1.45;color:#a7b8c1}.card small{display:block;margin-top:6px;color:#758b98;font-size:8.5px;line-height:1.4}.why{margin-top:8px;height:28px;border:1px solid var(--border);border-radius:5px;background:#0d1d27;font-size:8px;font-weight:900;padding:0 8px}\n.result-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.result-cell{border-top:1px solid var(--border);padding:8px 2px}.result-cell span,.result-cell strong{display:block}.result-cell span{font-size:8px;color:var(--muted)}.result-cell strong{font-size:13px;margin-top:3px}.unknown-list{margin:8px 0 0;padding-left:18px;color:#d0b36b;font-size:10px;line-height:1.5}\n.approach-row{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:9px;align-items:center;min-height:50px;padding:7px 0;border-bottom:1px solid rgba(38,59,73,.65)}.approach-row .type{font-size:8px;font-weight:900;color:#75a7b9}.approach-row strong,.approach-row span{display:block}.approach-row strong{font-size:11px}.approach-row span{font-size:9px;color:var(--muted);margin-top:3px}.approach-open{height:30px;border:1px solid var(--border);border-radius:5px;background:#0c1b24;font-size:8px;font-weight:900;padding:0 8px}.pack-status{display:flex;align-items:center;justify-content:space-between;border:1px solid var(--border);border-radius:7px;padding:9px 10px;background:#0a151d;margin-bottom:10px}.pack-status strong{font-size:10px}.pack-status span{font-size:8px;color:var(--muted)}\n.story{position:absolute;z-index:28;right:10px;top:10px;bottom:48px;width:350px;background:rgba(8,17,24,.97);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);display:grid;grid-template-rows:auto auto minmax(0,1fr);overflow:hidden}.story-head{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 13px;border-bottom:1px solid var(--border)}.story-head strong{font-size:13px}.story-head span{display:block;font-size:8px;color:var(--muted);margin-top:2px}.story-tabs{height:38px;display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--border)}.story-tab{border:0;background:#0a141c;color:#849aa6;font-size:9px;font-weight:900}.story-tab.active{background:#102634;color:#e5f8ff;box-shadow:inset 0 -2px 0 var(--cyan)}.story-scroll{min-height:0;overflow:auto;padding:12px}.next-action{border:1px solid #3a788e;border-radius:8px;background:#102c3b;padding:11px;margin-bottom:12px}.next-action span,.next-action strong{display:block}.next-action span{font-size:8px;color:#8ec4d5;letter-spacing:.09em;font-weight:900}.next-action strong{font-size:14px;margin-top:4px;line-height:1.3}.trust-row{display:grid;grid-template-columns:1fr auto;gap:10px;padding:8px 0;border-bottom:1px solid rgba(38,59,73,.6)}.trust-row strong,.trust-row span{display:block}.trust-row strong{font-size:10px}.trust-row span{font-size:8.5px;color:var(--muted);margin-top:2px}.trust-row em{font-style:normal;font-size:8px;color:#9eb4bf}\n.info{position:absolute;z-index:40;right:10px;top:10px;bottom:48px;width:390px;display:none;grid-template-rows:auto auto minmax(0,1fr);background:rgba(8,17,24,.99);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);overflow:hidden}.info.open{display:grid}.info-head{padding:12px 13px 10px;border-bottom:1px solid var(--border)}.info-kicker{font-size:8px;color:#7893a2;font-weight:950;letter-spacing:.12em}.info-title-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.info-title{font-size:25px;font-weight:950;margin-top:3px}.info-sub{font-size:10px;color:var(--muted);margin-top:3px}.info-tabs{height:38px;display:flex;overflow:auto;border-bottom:1px solid var(--border)}.info-tabs button{flex:0 0 auto;min-width:72px;border:0;border-right:1px solid var(--border);background:#0a141c;color:#849aa6;font-size:8px;font-weight:900;padding:0 10px}.info-tabs button.active{background:#102634;color:#e5f8ff;box-shadow:inset 0 -2px 0 var(--cyan)}.info-body{min-height:0;overflow:auto;padding:12px}.metrics{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--border)}.metric{padding:10px 4px;border-bottom:1px solid var(--border)}.metric:nth-child(odd){border-right:1px solid var(--border)}.metric span,.metric strong{display:block}.metric span{font-size:8px;color:var(--muted)}.metric strong{font-size:13px;margin-top:3px}.runway{padding:10px 0;border-bottom:1px solid var(--border)}.runway-head{display:flex;justify-content:space-between}.runway-head strong{font-size:12px}.runway-head span{font-size:9px;color:var(--muted)}.freq{display:grid;grid-template-columns:70px 1fr auto;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)}.freq strong{font-size:10px}.freq span{font-size:9px;color:var(--muted)}.freq em{font-style:normal;font-size:11px;font-weight:900}.raw{font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c8d7de;white-space:pre-wrap;word-break:break-word}\n.bottom{position:absolute;z-index:22;left:68px;right:370px;bottom:10px;height:34px;display:flex;align-items:center;gap:8px;padding:3px 6px;background:rgba(8,17,24,.92);border:1px solid var(--border);border-radius:8px;backdrop-filter:blur(8px)}.range{display:flex;gap:2px}.range button{height:26px;min-width:36px;border:0;border-radius:5px;background:transparent;color:#8499a6;font-size:8px;font-weight:900}.range button.active{background:#143648;color:#e3f9ff}.bottom-stat{font-size:8px;color:var(--muted)}.bottom-stat strong{font-size:10px;color:var(--text);margin-right:3px}.bottom-spacer{flex:1}.map-control{width:28px;height:27px;border:1px solid var(--border);border-radius:5px;background:#0b1821}\n.also{position:absolute;z-index:50;display:none;min-width:230px;max-width:320px;background:#09141c;border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);overflow:hidden}.also.open{display:block}.also-head{height:32px;padding:0 9px;display:flex;align-items:center;justify-content:space-between;background:#0d1d27;font-size:8px;font-weight:900}.also button{width:100%;min-height:43px;border:0;border-bottom:1px solid var(--border);background:transparent;text-align:left;padding:7px 9px}.also button:hover{background:#102431}.also button strong,.also button span{display:block}.also button strong{font-size:10px}.also button span{font-size:8px;color:var(--muted);margin-top:2px}\n.toast{position:absolute;z-index:70;left:50%;top:10px;transform:translateX(-50%);max-width:min(700px,calc(100% - 100px));display:none;padding:8px 11px;border:1px solid #6b5827;border-radius:7px;background:#30260d;color:#f3d98c;font-size:9px;box-shadow:var(--shadow)}.toast.bad{border-color:#79343c;background:#3a161b;color:#ffd5d9}\ndialog{color:var(--text)}.why-dialog,.approach-dialog{width:min(650px,calc(100% - 24px));max-height:80vh;border:1px solid var(--border2);border-radius:10px;background:#09131b;padding:0;box-shadow:0 30px 80px rgba(0,0,0,.6)}dialog::backdrop{background:rgba(0,0,0,.65);backdrop-filter:blur(2px)}.dialog-head{height:52px;display:flex;align-items:center;justify-content:space-between;padding:0 13px;border-bottom:1px solid var(--border)}.dialog-body{padding:13px;max-height:calc(80vh - 52px);overflow:auto}.approach-dialog{width:min(1100px,calc(100% - 24px));height:min(88vh,900px)}.approach-dialog iframe{width:100%;height:calc(100% - 52px);border:0;background:#fff}\n@media(max-width:1100px){.story{width:310px}.bottom{right:330px}.route-chip{max-width:240px}.data-strip .stat.wx{display:none}}\n@media(max-width:850px){.topbar{grid-template-columns:auto 1fr auto;gap:8px}.brand span{display:none}.data-strip{justify-self:end}.data-strip .stat{display:none}.header-actions .header-btn:nth-child(2){display:none}.story{top:auto;left:8px;right:8px;bottom:8px;width:auto;height:190px}.story-scroll{padding:9px}.story .card{display:none}.story .next-action{margin-bottom:7px}.bottom{display:none}.rail{top:8px}.map-badge{left:64px}.info{left:8px;right:8px;top:auto;bottom:8px;width:auto;height:58%}.drawer{left:8px;right:8px;top:8px;bottom:8px;width:auto}.app{grid-template-rows:52px minmax(0,1fr)}}\n@media(max-width:600px){.topbar{padding:0 7px}.brandmark{display:none}.brand strong{font-size:13px}.flight-context{justify-content:flex-start}.phase-chip{display:none}.route-chip{max-width:150px;padding:0 8px}.feed span:last-child{display:none}.header-actions{display:none}.rail{left:6px}.rail-btn{width:42px;height:42px}.map-badge{left:54px;font-size:7px}.story{height:176px}.story-head{height:46px}.story-tabs{height:34px}.drawer-body{padding:11px}.form-grid{grid-template-columns:1fr}.field.wide{grid-column:auto}.result-grid{grid-template-columns:1fr 1fr}.approach-row{grid-template-columns:58px minmax(0,1fr)}.approach-row>button{grid-column:2}.also{max-width:calc(100vw - 20px)}}\n</style>\n</head>\n<body>\n<main class=\"app\">\n<header class=\"topbar\">\n  <div class=\"brand\"><div class=\"brandmark\">AF</div><div><strong>AteFlight</strong><span>FLIGHT CONTEXT \u00b7 LIVE AIRSPACE</span></div></div>\n  <div class=\"flight-context\"><span id=\"flightBadge\" class=\"route-chip\">NO ACTIVE FLIGHT</span><span id=\"phaseBadge\" class=\"phase-chip\">PREFLIGHT</span></div>\n  <div class=\"data-strip\"><span class=\"feed\"><i id=\"feedDot\" class=\"dot\"></i><span id=\"feedText\">CONNECTING ADS-B</span></span><span class=\"stat\"><strong id=\"aircraftCount\">\u2014</strong>ACFT</span><span class=\"stat\"><strong id=\"adsbAge\">\u2014</strong>ADS-B</span><span class=\"stat wx\"><strong id=\"wxAge\">\u2014</strong>WX</span></div>\n  <div class=\"header-actions\"><button id=\"planHeaderBtn\" class=\"header-btn\" type=\"button\">PLAN</button><button id=\"approachHeaderBtn\" class=\"header-btn\" type=\"button\">APPROACHES</button><button id=\"layersHeaderBtn\" class=\"header-btn\" type=\"button\">DISPLAY</button></div>\n</header>\n<section class=\"stage\">\n  <div id=\"map\"></div><canvas id=\"trafficCanvas\"></canvas>\n  <div class=\"rail\">\n    <button id=\"homeBtn\" class=\"rail-btn\" type=\"button\"><b>\u25ce</b><span>HOME</span></button>\n    <button id=\"planBtn\" class=\"rail-btn\" type=\"button\"><b>\u2197</b><span>PLAN</span></button>\n    <button id=\"approachBtn\" class=\"rail-btn\" type=\"button\"><b>\u2301</b><span>APCH</span></button>\n    <button id=\"layersBtn\" class=\"rail-btn\" type=\"button\"><b>\u25eb</b><span>MAP</span></button>\n  </div>\n  <div class=\"map-badge\"><strong id=\"mapModeLabel\">AVIATION</strong><span id=\"mapContext\">KAPN \u00b7 100 NM</span></div>\n  <aside id=\"drawer\" class=\"drawer\"><div class=\"drawer-head\"><div><strong id=\"drawerTitle\">PLAN</strong><span id=\"drawerSub\">Flight planning and aircraft context</span></div><button id=\"drawerClose\" class=\"close-btn\" type=\"button\">\u00d7</button></div><div id=\"drawerBody\" class=\"drawer-body\"></div></aside>\n  <aside id=\"story\" class=\"story\"><div class=\"story-head\"><div><strong>FLIGHT STORY</strong><span id=\"storyPhase\">PREFLIGHT \u00b7 NO ACTIVE FLIGHT</span></div><button id=\"storyToggle\" class=\"header-btn\" type=\"button\">DETAIL</button></div><div class=\"story-tabs\"><button class=\"story-tab active\" data-story-tab=\"story\" type=\"button\">STORY</button><button class=\"story-tab\" data-story-tab=\"trust\" type=\"button\">TRUST</button></div><div id=\"storyScroll\" class=\"story-scroll\"></div></aside>\n  <aside id=\"info\" class=\"info\"><div class=\"info-head\"><div id=\"infoKicker\" class=\"info-kicker\">DETAIL</div><div class=\"info-title-row\"><div id=\"infoTitle\" class=\"info-title\">\u2014</div><button id=\"infoClose\" class=\"close-btn\" type=\"button\">\u00d7</button></div><div id=\"infoSub\" class=\"info-sub\">\u2014</div></div><div id=\"infoTabs\" class=\"info-tabs\"></div><div id=\"infoBody\" class=\"info-body\"></div></aside>\n  <div id=\"also\" class=\"also\"><div class=\"also-head\"><span id=\"alsoTitle\">ALSO HERE</span><button id=\"alsoClose\" class=\"close-btn\" type=\"button\">\u00d7</button></div><div id=\"alsoBody\"></div></div>\n  <div class=\"bottom\"><div class=\"range\"><button data-range=\"25\">25</button><button data-range=\"50\">50</button><button data-range=\"100\" class=\"active\">100</button><button data-range=\"150\">150</button><button data-range=\"250\">250</button></div><span class=\"bottom-stat\"><strong id=\"bottomAircraft\">\u2014</strong>ACFT</span><span class=\"bottom-stat\"><strong id=\"bottomMetar\">\u2014</strong>METAR</span><span class=\"bottom-spacer\"></span><button id=\"zoomOut\" class=\"map-control\">\u2212</button><button id=\"zoomIn\" class=\"map-control\">+</button><button id=\"fitHome\" class=\"map-control\">\u25ce</button></div>\n  <div id=\"toast\" class=\"toast\"></div>\n</section>\n</main>\n<dialog id=\"whyDialog\" class=\"why-dialog\"><div class=\"dialog-head\"><strong id=\"whyTitle\">WHY?</strong><button id=\"whyClose\" class=\"close-btn\">\u00d7</button></div><div id=\"whyBody\" class=\"dialog-body\"></div></dialog>\n<dialog id=\"approachDialog\" class=\"approach-dialog\"><div class=\"dialog-head\"><strong id=\"approachDialogTitle\">APPROACH</strong><button id=\"approachDialogClose\" class=\"close-btn\">\u00d7</button></div><iframe id=\"approachFrame\" title=\"Approach chart\"></iframe></dialog>\n<script type=\"module\">\nimport * as maplibregl from \"https://unpkg.com/maplibre-gl@6.1.0/dist/maplibre-gl.mjs\";\n(function(){\n\"use strict\";\nconst HOME={lon:-83.5603,lat:45.0781,id:\"KAPN\"};\nconst STYLE={liberty:\"https://tiles.openfreemap.org/styles/liberty\",dark:\"https://tiles.openfreemap.org/styles/dark\"};\nconst MICH_COORDS=[[-91.10252,47.59131],[-81.83658,47.59131],[-81.83658,41.23557],[-91.10252,41.23557]];\nconst $=id=>document.getElementById(id);\nconst state={range:100,base:\"aviation\",metars:true,pireps:true,sigmets:false,gairmets:false,radar:false,labels:\"full\",phase:\"preflight\"};\nlet traffic=[],airports=[],navaids=[],weather={metars:[],pireps:[],sigmets:{features:[]},gairmets:{features:[]}},trafficMeta={},selected=null,selectedAirport=null,selectedApproach=null,activePlan=null,planAnalysis=null,approachPack=null,officialProcedures=[],lastTrafficSuccess=0,lastWeatherSuccess=0,lastTrafficSourceTime=0,trafficFailures=0,liveTrafficConfirmed=false,trafficTimer=null,referenceTimer=null,moveTimer=null,drawerMode=\"\",storyTab=\"story\",infoMode=\"\",airportDetail=null,airportProcedures=null,airportTraffic=[];\nconst prefsKey=\"ateflight-v702\";\nfunction escapeHtml(v){return String(v==null?\"\":v).replace(/[&<>\"']/g,c=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#039;\"}[c]))}\nfunction toast(text,bad=false){const t=$(\"toast\");t.className=\"toast\"+(bad?\" bad\":\"\");t.textContent=text;t.style.display=\"block\";clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.style.display=\"none\",4200)}\nfunction api(url,options){return fetch(url,options||{}).then(async r=>{const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{throw new Error(`Non-JSON response ${r.status}: ${text.replace(/\\s+/g,\" \").slice(0,120)}`)}if(!r.ok)throw new Error((data.errors||[]).join(\" | \")||data.detail||data.error||`HTTP ${r.status}`);return data})}\nfunction apiTimeout(url,timeoutMs=5000){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);return api(url,{cache:\"no-store\",signal:controller.signal}).finally(()=>clearTimeout(timer))}\nfunction directPositionAgeSummary(ac){const ages=(ac||[]).map(a=>Number(a&&((a.seen_pos??a.seen)))).filter(Number.isFinite).map(x=>Math.max(0,x)).sort((a,b)=>a-b);const pick=f=>ages.length?ages[Math.min(ages.length-1,Math.max(0,Math.round((ages.length-1)*f)))]:null;return{count:ages.length,freshest:ages.length?ages[0]:null,median:pick(.5),p95:pick(.95),oldest:ages.length?ages[ages.length-1]:null}}\n\nfunction savePrefs(){try{localStorage.setItem(prefsKey,JSON.stringify({state,activePlan,planAnalysis,selectedApproach}))}catch{}}\nfunction loadPrefs(){try{const p=JSON.parse(localStorage.getItem(prefsKey)||\"null\");if(p){Object.assign(state,p.state||{});activePlan=p.activePlan||null;planAnalysis=p.planAnalysis||null;selectedApproach=p.selectedApproach||null}}catch{}}\nfunction formatAge(sec){if(!Number.isFinite(sec))return\"\u2014\";if(sec<60)return Math.round(sec)+\"s\";return Math.floor(sec/60)+\"m\"+Math.round(sec%60)+\"s\"}\nfunction trafficAge(){return lastTrafficSourceTime?Math.max(0,(Date.now()-lastTrafficSourceTime)/1000):Infinity}\nfunction trafficState(){const age=trafficAge(),since=lastTrafficSuccess?Math.max(0,(Date.now()-lastTrafficSuccess)/1000):Infinity,median=Number(trafficMeta.positionAgeSec&&trafficMeta.positionAgeSec.median);if(!lastTrafficSuccess)return\"offline\";if(trafficFailures>0)return since>120?\"stale\":\"holding\";if(!lastTrafficSourceTime&&!Number.isFinite(median))return\"unknown\";if(age>120||(Number.isFinite(median)&&median>120))return\"stale\";if(age>40||(Number.isFinite(median)&&median>45))return\"delayed\";return\"live\"}\nfunction updateHeader(){const s=trafficState(),dot=$(\"feedDot\");dot.className=\"dot \"+(s===\"live\"?\"live\":s===\"offline\"||s===\"stale\"?\"bad\":\"\");$(\"feedText\").textContent=(s===\"live\"?\"LIVE\":s.toUpperCase())+\" \u00b7 \"+String(trafficMeta.source||\"ADS-B\").toUpperCase();$(\"aircraftCount\").textContent=traffic.length;$(\"bottomAircraft\").textContent=traffic.length;$(\"adsbAge\").textContent=formatAge(trafficAge());$(\"wxAge\").textContent=lastWeatherSuccess?formatAge((Date.now()-lastWeatherSuccess)/1000):\"\u2014\";$(\"bottomMetar\").textContent=weather.metars.length;$(\"flightBadge\").textContent=activePlan?`${activePlan.input.origin} \u2192 ${activePlan.input.destination} \u00b7 ${activePlan.input.rules}`:\"NO ACTIVE FLIGHT\";$(\"phaseBadge\").textContent=state.phase.toUpperCase();$(\"storyPhase\").textContent=state.phase.toUpperCase()+\" \u00b7 \"+(activePlan?activePlan.input.origin+\" \u2192 \"+activePlan.input.destination:\"NO ACTIVE FLIGHT\")}\nfunction mapStyle(base){if([\"vfr\",\"ifr-low\",\"ifr-high\"].includes(base))return{version:8,sources:{},layers:[{id:\"background\",type:\"background\",paint:{\"background-color\":\"#e7e5dd\"}}]};return STYLE.liberty}\nfunction hideVectorNoise(){if(state.base!==\"aviation\")return;const style=map.getStyle();(style.layers||[]).forEach(l=>{const id=String(l.id).toLowerCase();if(/poi|housenumber|building|transit|rail|ferry|parking|shop|restaurant|amenity/.test(id)){try{map.setLayoutProperty(l.id,\"visibility\",\"none\")}catch{}}else if(l.type===\"line\"&&/road|highway|street/.test(id)){try{map.setPaintProperty(l.id,\"line-opacity\",.22)}catch{}}})}\nfunction emptyFC(){return{type:\"FeatureCollection\",features:[]}}\nfunction addSource(id,s){if(!map.getSource(id))map.addSource(id,s)}\nfunction addLayer(l,before){if(!map.getLayer(l.id))map.addLayer(l,before)}\nfunction transparent(){return\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+X7w5WQAAAABJRU5ErkJggg==\"}\nfunction addPlaneImages(){const make=(name,kind)=>{if(map.hasImage(name))return;const c=document.createElement(\"canvas\");c.width=c.height=64;const g=c.getContext(\"2d\");g.translate(32,32);g.fillStyle=\"#f7fbfd\";g.strokeStyle=\"#061019\";g.lineWidth=2.2;g.lineJoin=\"round\";g.beginPath();if(kind===\"rotor\"){g.rect(-4,-14,8,30);g.moveTo(-22,-4);g.lineTo(22,-4);g.moveTo(0,-23);g.lineTo(0,18)}else{const wing=kind===\"heavy\"?25:kind===\"large\"?21:kind===\"small\"?18:15;g.moveTo(0,-25);g.lineTo(5,-6);g.lineTo(wing,3);g.lineTo(wing,7);g.lineTo(5,5);g.lineTo(3,18);g.lineTo(10,24);g.lineTo(0,20);g.lineTo(-10,24);g.lineTo(-3,18);g.lineTo(-5,5);g.lineTo(-wing,7);g.lineTo(-wing,3);g.lineTo(-5,-6);g.closePath()}g.fill();g.stroke();map.addImage(name,g.getImageData(0,0,64,64),{pixelRatio:2})};make(\"plane-light\",\"light\");make(\"plane-small\",\"small\");make(\"plane-large\",\"large\");make(\"plane-heavy\",\"heavy\");make(\"plane-rotor\",\"rotor\")}\nfunction installLayers(){addPlaneImages();const before=(map.getStyle().layers||[]).find(l=>l.type===\"symbol\")?.id;\n addSource(\"michigan\",{type:\"image\",url:\"/assets/michigan_chart.webp\",coordinates:MICH_COORDS});addLayer({id:\"michigan\",type:\"raster\",source:\"michigan\",paint:{\"raster-opacity\":.9}},before);\n addSource(\"satellite\",{type:\"raster\",tiles:[\"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}\"],tileSize:256});addLayer({id:\"satellite\",type:\"raster\",source:\"satellite\",paint:{\"raster-opacity\":.9}},before);\n addSource(\"faa-vfr\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:8,maxzoom:12});addLayer({id:\"faa-vfr\",type:\"raster\",source:\"faa-vfr\",paint:{\"raster-opacity\":1}},before);\n addSource(\"faa-ifr-low\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:7,maxzoom:12});addLayer({id:\"faa-ifr-low\",type:\"raster\",source:\"faa-ifr-low\",paint:{\"raster-opacity\":1}},before);\n addSource(\"faa-ifr-high\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:3,maxzoom:12});addLayer({id:\"faa-ifr-high\",type:\"raster\",source:\"faa-ifr-high\",paint:{\"raster-opacity\":1}},before);\n addSource(\"radar\",{type:\"image\",url:transparent(),coordinates:[[-90,50],[-80,50],[-80,40],[-90,40]]});addLayer({id:\"radar\",type:\"raster\",source:\"radar\",paint:{\"raster-opacity\":.68}},before);\n addSource(\"weather-polygons\",{type:\"geojson\",data:emptyFC()});addLayer({id:\"weather-fill\",type:\"fill\",source:\"weather-polygons\",paint:{\"fill-color\":[\"get\",\"color\"],\"fill-opacity\":.11}});addLayer({id:\"weather-line\",type:\"line\",source:\"weather-polygons\",paint:{\"line-color\":[\"get\",\"color\"],\"line-width\":1.5,\"line-opacity\":.85}});\n addSource(\"airports\",{type:\"geojson\",data:emptyFC()});addLayer({id:\"airport-dot\",type:\"circle\",source:\"airports\",paint:{\"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],5,3.3,10,5.2],\"circle-color\":[\"get\",\"color\"],\"circle-stroke-color\":\"#061019\",\"circle-stroke-width\":1.5}});addLayer({id:\"airport-label\",type:\"symbol\",source:\"airports\",minzoom:5.5,layout:{\"text-field\":[\"get\",\"label\"],\"text-size\":[\"interpolate\",[\"linear\"],[\"zoom\"],5.5,9,10,11],\"text-offset\":[1,0],\"text-anchor\":\"left\",\"text-optional\":true},paint:{\"text-color\":\"#edf5f8\",\"text-halo-color\":\"#061019\",\"text-halo-width\":1.4}});\n addSource(\"navaids\",{type:\"geojson\",data:emptyFC()});addLayer({id:\"navaid-dot\",type:\"symbol\",source:\"navaids\",minzoom:6.5,layout:{\"text-field\":\"\u25c7\",\"text-size\":15,\"text-allow-overlap\":true},paint:{\"text-color\":\"#efc85b\",\"text-halo-color\":\"#061019\",\"text-halo-width\":1.4}});addLayer({id:\"navaid-label\",type:\"symbol\",source:\"navaids\",minzoom:8,layout:{\"text-field\":[\"get\",\"label\"],\"text-size\":9,\"text-offset\":[1,0],\"text-anchor\":\"left\",\"text-optional\":true},paint:{\"text-color\":\"#f2d67c\",\"text-halo-color\":\"#061019\",\"text-halo-width\":1.3}});\n addSource(\"traffic\",{type:\"geojson\",data:emptyFC()});addLayer({id:\"traffic\",type:\"symbol\",source:\"traffic\",layout:{\"icon-image\":[\"get\",\"icon\"],\"icon-size\":[\"interpolate\",[\"linear\"],[\"zoom\"],4,.25,8,.42,11,.55],\"icon-rotate\":[\"get\",\"track\"],\"icon-rotation-alignment\":\"map\",\"icon-allow-overlap\":true,\"text-field\":[\"step\",[\"zoom\"],\"\",6.7,[\"get\",\"callsign\"],8.3,[\"get\",\"label\"]],\"text-size\":10,\"text-offset\":[1.15,0],\"text-anchor\":\"left\",\"text-optional\":true},paint:{\"text-color\":\"#f6f9fb\",\"text-halo-color\":\"#061019\",\"text-halo-width\":1.4}});\n addSource(\"selected-aircraft\",{type:\"geojson\",data:emptyFC()});addLayer({id:\"selected-halo\",type:\"circle\",source:\"selected-aircraft\",paint:{\"circle-radius\":14,\"circle-color\":\"rgba(0,0,0,0)\",\"circle-stroke-color\":\"#ffc857\",\"circle-stroke-width\":2}});addLayer({id:\"selected-aircraft\",type:\"symbol\",source:\"selected-aircraft\",layout:{\"icon-image\":[\"get\",\"icon\"],\"icon-size\":.6,\"icon-rotate\":[\"get\",\"track\"],\"icon-rotation-alignment\":\"map\",\"icon-allow-overlap\":true}});\n addSource(\"mission-route\",{type:\"geojson\",data:emptyFC()});addLayer({id:\"mission-shadow\",type:\"line\",source:\"mission-route\",paint:{\"line-color\":\"#061019\",\"line-width\":6,\"line-opacity\":.7}});addLayer({id:\"mission-route\",type:\"line\",source:\"mission-route\",paint:{\"line-color\":\"#5ed2f2\",\"line-width\":3,\"line-opacity\":.95}});\n addSource(\"mission-points\",{type:\"geojson\",data:emptyFC()});addLayer({id:\"mission-points\",type:\"circle\",source:\"mission-points\",paint:{\"circle-radius\":4,\"circle-color\":\"#5ed2f2\",\"circle-stroke-color\":\"#061019\",\"circle-stroke-width\":1.5}});addLayer({id:\"mission-labels\",type:\"symbol\",source:\"mission-points\",layout:{\"text-field\":[\"get\",\"label\"],\"text-size\":10,\"text-offset\":[1,0],\"text-anchor\":\"left\"},paint:{\"text-color\":\"#dff8ff\",\"text-halo-color\":\"#061019\",\"text-halo-width\":1.3}});\n addSource(\"approach\",{type:\"geojson\",data:emptyFC()});addLayer({id:\"approach\",type:\"line\",source:\"approach\",paint:{\"line-color\":\"#ffc857\",\"line-width\":3,\"line-opacity\":.95}});\n addSource(\"home\",{type:\"geojson\",data:{type:\"FeatureCollection\",features:[{type:\"Feature\",properties:{label:\"KAPN \u00b7 BASE\"},geometry:{type:\"Point\",coordinates:[HOME.lon,HOME.lat]}}]}});addLayer({id:\"home-label\",type:\"symbol\",source:\"home\",layout:{\"text-field\":[\"get\",\"label\"],\"text-size\":11,\"text-offset\":[1,0],\"text-anchor\":\"left\",\"text-allow-overlap\":true},paint:{\"text-color\":\"#5ed2f2\",\"text-halo-color\":\"#061019\",\"text-halo-width\":1.6}});\n applyVisibility();hideVectorNoise();syncMapData();bindMapClick()}\nfunction setVisibility(id,on){if(map.getLayer(id))map.setLayoutProperty(id,\"visibility\",on?\"visible\":\"none\")}\nfunction applyVisibility(){const b=state.base;setVisibility(\"michigan\",b===\"michigan\");setVisibility(\"satellite\",b===\"satellite\");setVisibility(\"faa-vfr\",b===\"vfr\");setVisibility(\"faa-ifr-low\",b===\"ifr-low\");setVisibility(\"faa-ifr-high\",b===\"ifr-high\");setVisibility(\"radar\",state.radar);setVisibility(\"weather-fill\",state.sigmets||state.gairmets);setVisibility(\"weather-line\",state.sigmets||state.gairmets);$(\"mapModeLabel\").textContent=({aviation:\"AVIATION\",vfr:\"VFR SECTIONAL\",\"ifr-low\":\"IFR LOW\",\"ifr-high\":\"IFR HIGH\",michigan:\"MICHIGAN\",satellite:\"SATELLITE\",dark:\"DARK\"})[b]||\"AVIATION\"}\nfunction setBase(base){state.base=base;savePrefs();map.setStyle(mapStyle(base),{diff:false})}\nfunction aviationColor(cat){cat=String(cat||\"\").toUpperCase();return cat===\"VFR\"?\"#3ed083\":cat===\"MVFR\"?\"#4b9dff\":cat===\"IFR\"?\"#ef5d63\":cat===\"LIFR\"?\"#b779f7\":\"#9cabb4\"}\nfunction airportCode(a){return a.icao||a.gps||a.ident||a.iata||\"APT\"}\nfunction airportMetar(a){const keys=[a.icao,a.gps,a.ident,a.local].filter(Boolean).map(x=>String(x).toUpperCase());return weather.metars.find(m=>keys.includes(String(m.icaoId||\"\").toUpperCase()))||null}\nfunction airportData(){const zoom=map.getZoom();return{type:\"FeatureCollection\",features:airports.map(a=>{const m=airportMetar(a);return{type:\"Feature\",properties:{id:a.id||a.ident,ident:a.ident||\"\",label:airportCode(a),name:a.name||\"Airport\",color:m?aviationColor(m.fltCat):\"#9cabb4\",metar:m?JSON.stringify(m):\"\"},geometry:{type:\"Point\",coordinates:[Number(a.lon),Number(a.lat)]}}}).filter(f=>Number.isFinite(f.geometry.coordinates[0])&&Number.isFinite(f.geometry.coordinates[1]))}}\nfunction navaidData(){const z=map.getZoom();return{type:\"FeatureCollection\",features:navaids.filter(n=>{if(z>=10)return true;return !airports.some(a=>distanceNm(Number(a.lat),Number(a.lon),Number(n.lat),Number(n.lon))<2.5)}).map(n=>({type:\"Feature\",properties:{id:n.ident,label:`${n.ident} \u00b7 ${n.type}`,raw:JSON.stringify(n)},geometry:{type:\"Point\",coordinates:[Number(n.lon),Number(n.lat)]}}))}}\nfunction classFor(a){const c=String(a.category||\"\").toUpperCase();if(c===\"A7\")return\"plane-rotor\";if(c===\"A5\"||c===\"A4\")return\"plane-heavy\";if(c===\"A3\")return\"plane-large\";if(c===\"A2\")return\"plane-small\";return\"plane-light\"}\nfunction nameFor(a){return(a.flight&&String(a.flight).trim())||a.r||(a.hex||\"UNKNOWN\").toUpperCase()}\nfunction altFor(a){if(a.alt_baro===\"ground\")return\"GROUND\";const n=Number(a.alt_baro??a.alt_geom);return Number.isFinite(n)?Math.round(n).toLocaleString()+\" ft\":\"\u2014\"}\nfunction trafficData(){return{type:\"FeatureCollection\",features:traffic.filter(a=>Number.isFinite(Number(a.lat))&&Number.isFinite(Number(a.lon))).map(a=>({type:\"Feature\",properties:{hex:a.hex||nameFor(a),callsign:nameFor(a),label:`${nameFor(a)}\\n${altFor(a).replace(\" ft\",\"\")} \u00b7 ${Number.isFinite(Number(a.gs))?Math.round(Number(a.gs))+\"kt\":\"\u2014\"}`,track:Number(a.track)||0,icon:classFor(a)},geometry:{type:\"Point\",coordinates:[Number(a.lon),Number(a.lat)]}}))}}\nfunction selectedData(){if(!selected)return emptyFC();return{type:\"FeatureCollection\",features:[{type:\"Feature\",properties:{icon:classFor(selected),track:Number(selected.track)||0},geometry:{type:\"Point\",coordinates:[Number(selected.lon),Number(selected.lat)]}}]}}\nfunction weatherData(){const features=[];const add=(fc,kind,color)=>{(fc&&fc.features||[]).forEach(f=>features.push({type:\"Feature\",properties:Object.assign({},f.properties||{},{kind,color,raw:JSON.stringify(f.properties||{})}),geometry:f.geometry}))};if(state.sigmets)add(weather.sigmets,\"SIGMET\",\"#ef6d77\");if(state.gairmets)add(weather.gairmets,\"G-AIRMET\",\"#f0bd58\");return{type:\"FeatureCollection\",features}}\nfunction routeData(){const a=activePlan||planAnalysis;if(!a||!a.route)return emptyFC();return{type:\"FeatureCollection\",features:(a.route.segments||[]).map(s=>({type:\"Feature\",properties:{},geometry:{type:\"LineString\",coordinates:s.coordinates}}))}}\nfunction routePoints(){const a=activePlan||planAnalysis;if(!a||!a.route)return emptyFC();return{type:\"FeatureCollection\",features:(a.route.points||[]).map(p=>({type:\"Feature\",properties:{label:p.token},geometry:{type:\"Point\",coordinates:[p.lon,p.lat]}}))}}\nfunction approachData(){const g=selectedApproach&&selectedApproach.geometry;return g?{type:\"FeatureCollection\",features:[{type:\"Feature\",properties:{},geometry:g}]}:emptyFC()}\nfunction setData(id,data){const s=map.getSource(id);if(s&&s.setData)s.setData(data)}\nfunction syncMapData(){if(!map.loaded())return;setData(\"airports\",airportData());setData(\"navaids\",navaidData());setData(\"traffic\",trafficData());setData(\"selected-aircraft\",selectedData());setData(\"weather-polygons\",weatherData());setData(\"mission-route\",routeData());setData(\"mission-points\",routePoints());setData(\"approach\",approachData())}\nfunction fallbackBounds(){const r=Math.max(25,Number(state.range)||100),latd=r/60,lond=r/(60*Math.max(.2,Math.cos(HOME.lat*Math.PI/180)));return[HOME.lat-latd,HOME.lon-lond,HOME.lat+latd,HOME.lon+lond]}\nfunction bbox(){try{const b=map.getBounds();const values=[b.getSouth(),b.getWest(),b.getNorth(),b.getEast()];if(values.every(Number.isFinite))return values}catch{}return fallbackBounds()}\nfunction bboxString(){return bbox().map(v=>v.toFixed(4)).join(\",\")}\nfunction safeMapCenter(){try{const c=map.getCenter();if(Number.isFinite(c.lat)&&Number.isFinite(c.lng))return c}catch{}return{lat:HOME.lat,lng:HOME.lon}}\nfunction safeMapZoom(){try{const z=map.getZoom();if(Number.isFinite(z))return z}catch{}return 6.2}\nfunction radiusNm(){try{const c=safeMapCenter(),b=map.getBounds(),r=distanceNm(c.lat,c.lng,b.getNorth(),b.getEast());if(Number.isFinite(r))return Math.min(1600,Math.max(25,Math.ceil(r*1.08)))}catch{}return Math.max(25,Number(state.range)||100)}\nfunction saveTrafficSnapshot(d){try{localStorage.setItem(\"ateflight-v70r-traffic\",JSON.stringify({savedAt:Date.now(),data:d}))}catch{}}\nfunction restoreTrafficSnapshot(){try{const s=JSON.parse(localStorage.getItem(\"ateflight-v70r-traffic\")||\"null\");if(!s||Date.now()-s.savedAt>600000)return;traffic=Array.isArray(s.data.aircraft)?s.data.aircraft:[];trafficMeta=Object.assign({},s.data,{stale:true,feedState:\"holding\"});lastTrafficSuccess=s.savedAt;const restoredSource=Date.parse(s.data.sourceTimestamp||\"\");lastTrafficSourceTime=Number.isFinite(restoredSource)?restoredSource:0;trafficFailures=1;liveTrafficConfirmed=false;syncMapData();toast(\"Showing last confirmed traffic while live ADS-B connects\",false)}catch{}}\nasync function directTraffic(){\n  const c=map.getCenter(),r=Math.min(249,Math.max(25,radiusNm()));\n  const sources=[\n    [`https://api.airplanes.live/v2/point/${c.lat}/${c.lng}/${r}`,\"airplanes.live direct\"],\n    [`https://api.adsb.lol/v2/point/${c.lat}/${c.lng}/${r}`,\"adsb.lol direct\"]\n  ];\n  const attempts=sources.map(async function(entry){\n    const d=await apiTimeout(entry[0],5200),ac=Array.isArray(d.ac)?d.ac:Array.isArray(d.aircraft)?d.aircraft:[];\n    if(!ac.length)throw new Error(entry[1]+\" returned zero aircraft\");\n    const raw=Number(d.now||d.ctime),trusted=raw>1e9,ms=raw>1e12?raw:trusted?raw*1000:null;\n    return{source:entry[1],aircraft:ac,generatedAt:new Date(ms||Date.now()).toISOString(),sourceTimestamp:ms?new Date(ms).toISOString():null,sourceTimestampTrusted:!!ms,positionAgeSec:directPositionAgeSummary(ac),receivedAt:new Date().toISOString(),direct:true}\n  });\n  return Promise.any(attempts)\n}\nfunction delayedDirectTraffic(delayMs){return new Promise((resolve,reject)=>setTimeout(()=>directTraffic().then(resolve,reject),delayMs))}\nasync function loadTraffic(force=false){\n  const c=safeMapCenter(),url=`/api/traffic?lat=${c.lat}&lon=${c.lng}&radius=${radiusNm()}&bbox=${encodeURIComponent(bboxString())}&zoom=${safeMapZoom()}&coverage=fast&_=${Date.now()}`;\n  try{\n    const workerRequest=api(url,{cache:\"no-store\"});\n    let d;\n    if(!liveTrafficConfirmed){\n      d=await Promise.any([workerRequest,delayedDirectTraffic(1200)])\n    }else{\n      try{d=await workerRequest}catch(e){d=await directTraffic();d.warning=e.message}\n      if(!Array.isArray(d.aircraft)||(!d.aircraft.length&&radiusNm()<=249)){\n        try{const fallback=await directTraffic();if(fallback.aircraft.length)d=fallback}catch{}\n      }\n    }\n    traffic=Array.isArray(d.aircraft)?d.aircraft:[];trafficMeta=d;lastTrafficSuccess=Date.now();const parsedSource=Date.parse(d.sourceTimestamp||\"\");lastTrafficSourceTime=Number.isFinite(parsedSource)?parsedSource:0;trafficFailures=0;liveTrafficConfirmed=true;saveTrafficSnapshot(d);syncMapData()\n  }catch(e){trafficFailures++;toast(\"ADS-B update failed: \"+e.message,true)}\n  updateHeader();renderStory()\n}\nasync function loadReference(){const b=encodeURIComponent(bboxString()),z=map.getZoom();const results=await Promise.allSettled([api(`/api/airports?bbox=${b}&zoom=${z}`,{cache:\"no-store\"}),api(`/api/navaids?bbox=${b}&zoom=${z}`,{cache:\"no-store\"}),api(`/api/weather?bbox=${b}&_=${Date.now()}`,{cache:\"no-store\"})]);if(results[0].status===\"fulfilled\")airports=results[0].value.airports||[];if(results[1].status===\"fulfilled\")navaids=results[1].value.navaids||[];if(results[2].status===\"fulfilled\"){const w=results[2].value;weather={metars:w.metars||[],pireps:w.pireps||[],sigmets:w.sigmets||emptyFC(),gairmets:w.gairmets||emptyFC()};lastWeatherSuccess=Date.now()}syncMapData();updateHeader()}\nfunction debounceMove(){clearTimeout(moveTimer);moveTimer=setTimeout(()=>{loadTraffic();loadReference()},500)}\nfunction fitHome(){map.fitBounds([[-85.4,43.7],[-81.7,46.5]],{padding:{top:60,bottom:60,left:70,right:370},duration:450,maxZoom:7})}\nfunction fitRange(){const r=state.range,latd=r/60,lond=r/(60*Math.cos(HOME.lat*Math.PI/180));map.fitBounds([[HOME.lon-lond,HOME.lat-latd],[HOME.lon+lond,HOME.lat+latd]],{padding:{top:60,bottom:60,left:70,right:370},duration:450})}\nfunction openDrawer(mode){drawerMode=mode;$(\"drawer\").classList.add(\"open\");$(\"drawerTitle\").textContent=mode===\"plan\"?\"FLIGHT PLAN\":mode===\"approaches\"?\"APPROACH LIBRARY\":\"DISPLAY\";$(\"drawerSub\").textContent=mode===\"plan\"?\"Route, altitude and aircraft context\":mode===\"approaches\"?\"Official FAA and custom AteFlight products\":\"Map and operational layers\";renderDrawer()}\nfunction closeDrawer(){$(\"drawer\").classList.remove(\"open\");drawerMode=\"\"}\nfunction renderDrawer(){const body=$(\"drawerBody\");if(drawerMode===\"plan\")renderPlanner(body);else if(drawerMode===\"approaches\")renderApproaches(body);else renderLayers(body)}\nfunction field(label,id,value,type=\"text\",wide=false){return`<div class=\"field ${wide?\"wide\":\"\"}\"><label for=\"${id}\">${label}</label><input id=\"${id}\" type=\"${type}\" value=\"${escapeHtml(value||\"\")}\"></div>`}\nfunction renderPlanner(body){const p=planAnalysis&&planAnalysis.input||activePlan&&activePlan.input||{};body.innerHTML=`<div class=\"form-grid\">${field(\"ORIGIN\",\"planOrigin\",p.origin||\"KAPN\")}${field(\"DESTINATION\",\"planDestination\",p.destination||\"\")}<div class=\"field wide\"><label>ROUTE</label><textarea id=\"planRoute\" placeholder=\"DCT or resolved fixes; airway geometry remains UNKNOWN\">${escapeHtml((p.route||[]).join?p.route.join(\" \"):p.route||\"\")}</textarea></div><div class=\"field\"><label>RULES</label><select id=\"planRules\"><option ${p.rules!==\"VFR\"?\"selected\":\"\"}>IFR</option><option ${p.rules===\"VFR\"?\"selected\":\"\"}>VFR</option></select></div>${field(\"PREFERRED ALTITUDE\",\"planAltitude\",p.preferredAltitude||7500,\"number\")}${field(\"AIRCRAFT TYPE\",\"aircraftType\",p.aircraft&&p.aircraft.type||\"C172\")}${field(\"CRUISE TAS\",\"aircraftTas\",p.aircraft&&p.aircraft.cruiseTas||115,\"number\")}${field(\"FUEL BURN / HR\",\"aircraftBurn\",p.aircraft&&p.aircraft.fuelBurn||9,\"number\")}${field(\"SERVICE CEILING\",\"aircraftCeiling\",p.aircraft&&p.aircraft.serviceCeiling||14000,\"number\")}</div><div class=\"button-row\"><button id=\"analyzeBtn\" class=\"primary\">ANALYZE FLIGHT</button><button id=\"activateBtn\" class=\"secondary\" ${planAnalysis&&planAnalysis.ok?\"\":\"disabled\"}>ACTIVATE</button><button id=\"clearPlanBtn\" class=\"secondary\">CLEAR</button></div><div id=\"planResult\"></div>`;$(\"analyzeBtn\").onclick=analyzePlan;$(\"activateBtn\").onclick=activatePlan;$(\"clearPlanBtn\").onclick=clearPlan;renderPlanResult()}\nfunction plannerPayload(){return{origin:$(\"planOrigin\").value,destination:$(\"planDestination\").value,route:$(\"planRoute\").value,rules:$(\"planRules\").value,preferredAltitude:Number($(\"planAltitude\").value),aircraft:{type:$(\"aircraftType\").value,cruiseTas:Number($(\"aircraftTas\").value),fuelBurn:Number($(\"aircraftBurn\").value),serviceCeiling:Number($(\"aircraftCeiling\").value),rnav:true,waas:true,ifr:true}}}\nasync function analyzePlan(){const b=$(\"analyzeBtn\");b.disabled=true;b.textContent=\"ANALYZING\u2026\";try{planAnalysis=await api(\"/api/plan\",{method:\"POST\",headers:{\"content-type\":\"application/json\"},body:JSON.stringify(plannerPayload())});savePrefs();syncMapData();renderPlanResult();renderStory();if(planAnalysis.route&&planAnalysis.route.points&&planAnalysis.route.points.length>1){const bounds=new maplibregl.LngLatBounds();planAnalysis.route.points.forEach(p=>bounds.extend([p.lon,p.lat]));map.fitBounds(bounds,{padding:{top:70,bottom:70,left:440,right:370},duration:500,maxZoom:9})}loadApproaches()}catch(e){toast(\"Flight analysis failed: \"+e.message,true)}finally{b.disabled=false;b.textContent=\"ANALYZE FLIGHT\"}}\nfunction activatePlan(){if(!planAnalysis||!planAnalysis.ok)return;activePlan=planAnalysis;state.phase=\"preflight\";savePrefs();syncMapData();updateHeader();renderStory();$(\"activateBtn\").classList.add(\"active\");toast(\"Preliminary flight context activated \u00b7 not an ATC clearance\",false)}\nfunction clearPlan(){planAnalysis=null;activePlan=null;selectedApproach=null;savePrefs();syncMapData();renderPlanner($(\"drawerBody\"));updateHeader();renderStory()}\nfunction renderPlanResult(){const el=$(\"planResult\");if(!el||!planAnalysis){if(el)el.innerHTML=\"\";return}const a=planAnalysis,r=a.route||{},alt=a.altitudeCandidates&&a.altitudeCandidates[0];el.innerHTML=`<div class=\"section\"><div class=\"section-title\">ANALYSIS</div><div class=\"card ${a.ok?\"context\":\"unknown\"}\"><strong>${a.ok?escapeHtml(a.input.origin+\" \u2192 \"+a.input.destination):\"ROUTE ENDPOINTS UNRESOLVED\"}</strong><p>${Number(r.knownDistanceNm||r.directDistanceNm||0).toFixed(1)} NM resolved \u00b7 ${r.completeness||0}% geometry complete</p></div><div class=\"result-grid\"><div class=\"result-cell\"><span>COURSE BASIS</span><strong>${escapeHtml(r.courseBasis||\"UNKNOWN\")}</strong></div><div class=\"result-cell\"><span>ALTITUDE</span><strong>${alt?alt.altitudeFt.toLocaleString()+\" ft\":\"UNKNOWN\"}</strong></div><div class=\"result-cell\"><span>ETA</span><strong>${alt&&alt.estimatedTimeMinutes!=null?alt.estimatedTimeMinutes+\" min\":\"\u2014\"}</strong></div></div>${a.decisions&&a.decisions.unknown&&a.decisions.unknown.length?`<ul class=\"unknown-list\">${a.decisions.unknown.map(x=>`<li>${escapeHtml(x.title)}</li>`).join(\"\")}</ul>`:\"\"}</div>`;const act=$(\"activateBtn\");if(act)act.disabled=!a.ok}\nasync function loadApproaches(){const dest=(planAnalysis&&planAnalysis.input.destination)||(activePlan&&activePlan.input.destination)||\"\";const calls=[api(\"/api/approach-pack\",{cache:\"no-store\"})];if(dest)calls.push(api(\"/api/procedures?ident=\"+encodeURIComponent(dest),{cache:\"no-store\"}));const rs=await Promise.allSettled(calls);approachPack=rs[0].status===\"fulfilled\"?rs[0].value:null;officialProcedures=dest&&rs[1]&&rs[1].status===\"fulfilled\"?rs[1].value.procedures||[]:[];if(drawerMode===\"approaches\")renderApproaches($(\"drawerBody\"));renderStory()}\nfunction customFor(dest){if(!approachPack)return[];const aliases=[String(dest||\"\").toUpperCase()];if(/^K[A-Z0-9]{3}$/.test(aliases[0]))aliases.push(aliases[0].slice(1));return(approachPack.procedures||[]).filter(x=>aliases.includes(String(x.airport||\"\").toUpperCase()))}\nfunction renderApproaches(body){const dest=(planAnalysis&&planAnalysis.input.destination)||(activePlan&&activePlan.input.destination)||\"\";if(!dest){const all=approachPack&&Array.isArray(approachPack.procedures)?approachPack.procedures:[];body.innerHTML=`<div class=\"pack-status\"><div><strong>CUSTOM APPROACH PACK</strong><span>${escapeHtml(approachPack&&approachPack.cycle||\"UNSET\")}</span></div><strong>${all.length} INSTALLED</strong></div>${all.length?`<div class=\"section\"><div class=\"section-title\">INSTALLED ATEFLIGHT PRODUCTS</div>${all.map((x,i)=>approachRow(x,\"CUSTOM\",i)).join(\"\")}</div>`:'<div class=\"card unknown\"><strong>NO CUSTOM PRODUCTS INSTALLED</strong><p>Add real chart and briefing records to the custom-approaches manifest. Official procedures load after a destination is entered.</p></div>'}`;body.querySelectorAll(\"[data-approach]\").forEach(b=>b.onclick=()=>{const meta=JSON.parse(decodeURIComponent(b.dataset.approach)),raw=all[meta.index]||{};selectedApproach=Object.assign({},raw,{title:raw.title||raw.name||meta.title,chartUrl:raw.chartUrl||raw.url||raw.pdfUrl||meta.url,source:\"CUSTOM\"});savePrefs();syncMapData();renderStory()});return}const custom=customFor(dest);body.innerHTML=`<div class=\"pack-status\"><div><strong>CUSTOM APPROACH PACK</strong><span>${escapeHtml(approachPack&&approachPack.cycle||\"UNSET\")}</span></div><strong>${custom.length} INSTALLED</strong></div><div class=\"section\"><div class=\"section-title\">ATEFLIGHT CUSTOM</div><div id=\"customList\">${custom.length?custom.map((x,i)=>approachRow(x,\"CUSTOM\",i)).join(\"\"):'<div class=\"card unknown\"><strong>NO CUSTOM PRODUCTS FOR '+escapeHtml(dest)+'</strong><p>Add chart and briefing assets to the custom-approaches manifest.</p></div>'}</div></div><div class=\"section\"><div class=\"section-title\">OFFICIAL FAA d-TPP</div><div id=\"officialList\">${officialProcedures.length?officialProcedures.map((x,i)=>approachRow({title:x.name||x.chartName||\"FAA Procedure\",subtitle:[x.code,x.amendment].filter(Boolean).join(\" \u00b7 \"),chartUrl:x.url||x.pdfUrl},\"FAA\",i)).join(\"\"):'<div class=\"card context\"><strong>LOADING PROCEDURES</strong><p>Destination procedure list is not available yet.</p></div>'}</div></div>`;body.querySelectorAll(\"[data-approach]\").forEach(b=>b.onclick=()=>{const meta=JSON.parse(decodeURIComponent(b.dataset.approach));const list=meta.source===\"CUSTOM\"?custom:officialProcedures;const raw=list[meta.index]||{};selectedApproach=Object.assign({},raw,{title:raw.title||raw.name||meta.title,chartUrl:raw.chartUrl||raw.url||raw.pdfUrl||meta.url,source:meta.source});savePrefs();syncMapData();renderStory();toast(\"Approach context selected \u00b7 actual ATC clearance remains controlling\",false)});body.querySelectorAll(\"[data-open-approach]\").forEach(b=>b.onclick=()=>{const meta=JSON.parse(decodeURIComponent(b.dataset.openApproach));$(\"approachDialogTitle\").textContent=meta.title;$(\"approachFrame\").src=meta.url;$(\"approachDialog\").showModal()})}\nfunction approachRow(x,source,index){const title=x.title||x.name||\"Approach\",url=x.chartUrl||x.url||x.pdfUrl||\"\",meta=encodeURIComponent(JSON.stringify({source,index,title,url}));return`<div class=\"approach-row\"><span class=\"type\">${source}</span><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(x.subtitle||[x.guidance,x.runway,x.code].filter(Boolean).join(\" \u00b7 \"))}</span></div><div><button class=\"approach-open\" data-approach=\"${meta}\">SELECT</button>${url?`<button class=\"approach-open\" data-open-approach=\"${meta}\">OPEN</button>`:\"\"}</div></div>`}\nfunction renderLayers(body){const choice=(id,title,sub)=>`<button class=\"card ${state.base===id?\"context\":\"\"}\" data-base=\"${id}\"><strong>${title}</strong><p>${sub}</p></button>`;body.innerHTML=`<div class=\"section-title\">BASE MAP</div>${choice(\"aviation\",\"AVIATION\",\"Default vector map. Airports and navaids emphasized; nonaviation clutter subdued.\")}${choice(\"vfr\",\"VFR SECTIONAL\",\"Official FAA VFR Sectional raster.\")}${choice(\"ifr-low\",\"IFR LOW\",\"Official FAA Low Enroute raster.\")}${choice(\"ifr-high\",\"IFR HIGH\",\"Official FAA High Enroute raster.\")}${choice(\"michigan\",\"MICHIGAN AERO\",\"2026 Michigan Aeronautical Chart.\")}${choice(\"satellite\",\"SATELLITE\",\"Optional imagery. Never the default.\")}<div class=\"section\"><div class=\"section-title\">OPERATIONAL LAYERS</div>${toggleRow(\"Airport METAR colors\",\"metars\",state.metars)}${toggleRow(\"SIGMETs\",\"sigmets\",state.sigmets)}${toggleRow(\"G-AIRMETs\",\"gairmets\",state.gairmets)}${toggleRow(\"Radar\",\"radar\",state.radar)}</div>`;body.querySelectorAll(\"[data-base]\").forEach(b=>b.onclick=()=>setBase(b.dataset.base));body.querySelectorAll(\"[data-toggle]\").forEach(b=>b.onchange=()=>{state[b.dataset.toggle]=b.checked;savePrefs();applyVisibility();syncMapData();if(b.dataset.toggle===\"radar\"&&b.checked)updateRadar()})}\nfunction toggleRow(label,key,on){return`<label class=\"card\" style=\"display:flex;justify-content:space-between;align-items:center\"><strong>${label}</strong><input type=\"checkbox\" data-toggle=\"${key}\" ${on?\"checked\":\"\"}></label>`}\nfunction storyItems(){const active=[],context=[],unknown=[],suppressed=[];const s=trafficState();if(s===\"live\")context.push({title:`ADS-B live \u00b7 ${traffic.length} aircraft`,text:`${formatAge(trafficAge())} source age \u00b7 ${trafficMeta.source||\"source\"}`,why:[\"Traffic is supplemental and not collision-avoidance data.\"]});else unknown.push({title:`ADS-B ${s}`,text:\"Current traffic cannot be treated as live.\",why:[trafficMeta.errors&&trafficMeta.errors.join(\" | \")||\"No current traffic source confirmed.\"]});const a=activePlan||planAnalysis;if(a){active.push({title:`${a.input.origin} \u2192 ${a.input.destination} \u00b7 ${a.input.rules}`,text:`${a.route.knownDistanceNm||a.route.directDistanceNm||0} NM resolved`,why:[\"Route endpoints resolved through aviation data services.\"]});(a.decisions&&a.decisions.context||[]).forEach(x=>context.push({title:x.title,text:x.consequence,why:x.why}));(a.decisions&&a.decisions.unknown||[]).forEach(x=>unknown.push({title:x.title,text:x.consequence,why:x.why}));if(selectedApproach)context.push({title:selectedApproach.title||\"Selected approach\",text:`${selectedApproach.source||\"Approach\"} \u00b7 actual ATC clearance remains controlling`,why:[\"This is selected context, not an ATC clearance.\"]})}else active.push({title:\"No active flight\",text:\"Build and activate a flight plan to personalize the operational story.\",why:[\"Without a route and aircraft profile, AteFlight cannot determine what matters to this flight.\"]});return{active,context,unknown,suppressed}}\nfunction renderStory(){const el=$(\"storyScroll\");if(storyTab===\"trust\"){el.innerHTML=trustHtml();return}const items=storyItems(),next=activePlan?phaseNext():\"Build and activate a flight plan\";el.innerHTML=`<div class=\"next-action\"><span>NEXT</span><strong>${escapeHtml(next)}</strong></div>${storySection(\"ACTIVE\",items.active,\"active\")}${storySection(\"CONTEXT\",items.context,\"context\")}${storySection(\"UNKNOWN\",items.unknown,\"unknown\")}${items.suppressed.length?storySection(\"SUPPRESSED\",items.suppressed,\"suppressed\"):\"\"}`;el.querySelectorAll(\"[data-why]\").forEach(b=>b.onclick=()=>{const x=JSON.parse(decodeURIComponent(b.dataset.why));showWhy(x)})}\nfunction phaseNext(){return state.phase===\"preflight\"?\"Verify route, weather, fuel and unresolved unknowns\":state.phase===\"departure\"?\"Fly the cleared departure and monitor the next constraint\":state.phase===\"enroute\"?\"Monitor route, weather and destination trend\":state.phase===\"arrival\"?\"Confirm runway, approach expectation and weather margin\":state.phase===\"approach\"?\"Fly the actual clearance; keep missed action immediately available\":state.phase===\"missed\"?\"Execute the missed approach and verify the next altitude\":\"Transition to runway-exit and taxi awareness\"}\nfunction storySection(title,items,cls){if(!items.length)return\"\";return`<div class=\"section\"><div class=\"section-title\">${title}</div>${items.map(x=>`<div class=\"card ${cls}\"><strong>${escapeHtml(x.title)}</strong><p>${escapeHtml(x.text||\"\")}</p><button class=\"why\" data-why=\"${encodeURIComponent(JSON.stringify(x))}\">WHY?</button></div>`).join(\"\")}</div>`}\nfunction trustHtml(){const rows=[{name:\"ADS-B\",role:\"Supplemental traffic awareness\",fresh:lastTrafficSuccess?formatAge((Date.now()-lastTrafficSuccess)/1000):\"UNKNOWN\"},{name:\"AviationWeather.gov\",role:\"METAR, TAF and advisory context\",fresh:lastWeatherSuccess?formatAge((Date.now()-lastWeatherSuccess)/1000):\"UNKNOWN\"},{name:\"FAA d-TPP\",role:\"Official procedure source\",fresh:\"CURRENT SERVICE\"},{name:\"Custom approach pack\",role:\"AteFlight chart and briefing assets\",fresh:approachPack&&approachPack.cycle||\"UNSET\"}];return`<div class=\"section-title\">SOURCE LEDGER</div>${rows.map(r=>`<div class=\"trust-row\"><div><strong>${escapeHtml(r.name)}</strong><span>${escapeHtml(r.role)}</span></div><em>${escapeHtml(r.fresh)}</em></div>`).join(\"\")}`}\nfunction showWhy(x){$(\"whyTitle\").textContent=x.title||\"WHY?\";$(\"whyBody\").innerHTML=`<div class=\"card context\"><strong>CONCLUSION</strong><p>${escapeHtml(x.text||\"\")}</p></div><div class=\"section-title\">EVIDENCE AND LIMITATIONS</div>${(x.why||[]).map(v=>`<div class=\"card\"><p>${escapeHtml(v)}</p></div>`).join(\"\")}`;$(\"whyDialog\").showModal()}\nfunction openInfo(mode,title,sub,tabs){infoMode=mode;$(\"info\").classList.add(\"open\");$(\"infoKicker\").textContent=mode.toUpperCase();$(\"infoTitle\").textContent=title;$(\"infoSub\").textContent=sub||\"\";$(\"infoTabs\").innerHTML=tabs.map((t,i)=>`<button data-info-tab=\"${t.id}\" class=\"${i===0?\"active\":\"\"}\">${t.label}</button>`).join(\"\");$(\"infoTabs\").querySelectorAll(\"button\").forEach((b,i)=>b.onclick=()=>{$(\"infoTabs\").querySelectorAll(\"button\").forEach(x=>x.classList.remove(\"active\"));b.classList.add(\"active\");tabs[i].render()});tabs[0].render()}\nfunction closeInfo(){$(\"info\").classList.remove(\"open\");selected=null;selectedAirport=null;syncMapData()}\nfunction selectAircraft(a){selected=a;selectedAirport=null;syncMapData();const tabs=[{id:\"summary\",label:\"SUMMARY\",render:()=>renderAircraft(a)},{id:\"track\",label:\"TRACK\",render:()=>loadAircraftTrack(a)}];openInfo(\"aircraft\",nameFor(a),[a.r,a.t,a.desc].filter(Boolean).join(\" \u00b7 \"),tabs);map.easeTo({center:[a.lon,a.lat],duration:250})}\nfunction renderAircraft(a){$(\"infoBody\").innerHTML=`<div class=\"metrics\">${metric(\"ALTITUDE\",altFor(a))}${metric(\"GROUND SPEED\",Number.isFinite(Number(a.gs))?Math.round(Number(a.gs))+\" kt\":\"\u2014\")}${metric(\"VERTICAL RATE\",Number.isFinite(Number(a.baro_rate))?Math.round(Number(a.baro_rate))+\" fpm\":\"\u2014\")}${metric(\"TRACK\",Number.isFinite(Number(a.track))?Math.round(Number(a.track))+\"\u00b0\":\"\u2014\")}${metric(\"SQUAWK\",a.squawk||\"\u2014\")}${metric(\"POSITION AGE\",Number.isFinite(Number(a.seen_pos))?Math.round(Number(a.seen_pos))+\" sec\":\"\u2014\")}</div><div class=\"card context\"><strong>SUPPLEMENTAL TRAFFIC</strong><p>Not for collision avoidance. Source age and position age remain visible in the header.</p></div>`}\nasync function loadAircraftTrack(a){$(\"infoBody\").innerHTML='<div class=\"card context\"><strong>LOADING TRACK</strong></div>';try{const d=await api(\"/api/trace?hex=\"+encodeURIComponent(a.hex),{cache:\"no-store\"});$(\"infoBody\").innerHTML=`<div class=\"card context\"><strong>${d.originalPointCount||d.pointCount||0} TRACK POINTS</strong><p>${d.startTime&&d.endTime?Math.round((d.endTime-d.startTime)/60)+\" minutes available\":\"Current leg trace\"}</p></div>`;if(d.points&&d.points.length>1){setData(\"mission-route\",{type:\"FeatureCollection\",features:[{type:\"Feature\",properties:{},geometry:{type:\"LineString\",coordinates:d.points.map(p=>[p.lon,p.lat])}}]});const b=new maplibregl.LngLatBounds();d.points.forEach(p=>b.extend([p.lon,p.lat]));map.fitBounds(b,{padding:{top:60,bottom:60,left:70,right:410},duration:450,maxZoom:10})}}catch(e){$(\"infoBody\").innerHTML=`<div class=\"card unknown\"><strong>TRACK UNAVAILABLE</strong><p>${escapeHtml(e.message)}</p></div>`}}\nfunction metric(label,value){return`<div class=\"metric\"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`}\nfunction selectAirport(a){selectedAirport=a;selected=null;syncMapData();airportDetail=null;airportProcedures=null;airportTraffic=[];const tabs=[{id:\"overview\",label:\"OVERVIEW\",render:()=>renderAirportOverview(a)},{id:\"runways\",label:\"RUNWAYS\",render:()=>renderAirportRunways(a)},{id:\"comms\",label:\"COMMS\",render:()=>renderAirportComms(a)},{id:\"procedures\",label:\"PROCEDURES\",render:()=>renderAirportProcedures(a)},{id:\"traffic\",label:\"TRAFFIC\",render:()=>renderAirportTraffic(a)}];openInfo(\"airport\",airportCode(a),[a.name,a.municipality].filter(Boolean).join(\" \u00b7 \"),tabs);loadAirportData(a)}\nasync function loadAirportData(a){const id=airportCode(a);const rs=await Promise.allSettled([api(`/api/airport-detail?ident=${encodeURIComponent(id)}&local=${encodeURIComponent(a.ident||\"\")}&icao=${encodeURIComponent(a.icao||a.gps||\"\")}&ref=${encodeURIComponent(a.id||\"\")}`,{cache:\"no-store\"}),api(\"/api/procedures?ident=\"+encodeURIComponent(id),{cache:\"no-store\"}),api(`/api/traffic?lat=${a.lat}&lon=${a.lon}&radius=35&zoom=10&coverage=fast&_=${Date.now()}`,{cache:\"no-store\"})]);airportDetail=rs[0].status===\"fulfilled\"?rs[0].value:{runways:[],frequencies:[],error:rs[0].reason&&rs[0].reason.message};airportProcedures=rs[1].status===\"fulfilled\"?rs[1].value:{procedures:[],error:rs[1].reason&&rs[1].reason.message};airportTraffic=rs[2].status===\"fulfilled\"?rs[2].value.aircraft||[]:[];const active=$(\"infoTabs\").querySelector(\"button.active\");if(active)active.click()}\nfunction renderAirportOverview(a){const m=airportMetar(a),r=(airportDetail&&airportDetail.runways||[]),f=(airportDetail&&airportDetail.frequencies||[]),p=(airportProcedures&&airportProcedures.procedures||[]);$(\"infoBody\").innerHTML=`<div class=\"metrics\">${metric(\"FIELD ELEVATION\",a.elevationFt?Number(a.elevationFt).toLocaleString()+\" ft\":\"\u2014\")}${metric(\"WEATHER\",m?m.fltCat||\"REPORTING\":\"NO REPORT\")}${metric(\"RUNWAYS\",r.length)}${metric(\"COMMS\",f.length)}${metric(\"PROCEDURES\",p.length)}${metric(\"LIVE TRAFFIC\",airportTraffic.length)}</div>${m&&m.rawOb?`<div class=\"section\"><div class=\"section-title\">CURRENT METAR</div><div class=\"raw\">${escapeHtml(m.rawOb)}</div></div>`:\"\"}`}\nfunction renderAirportRunways(){const rows=airportDetail&&airportDetail.runways||[];$(\"infoBody\").innerHTML=rows.length?rows.map(r=>`<div class=\"runway\"><div class=\"runway-head\"><strong>${escapeHtml([r.leIdent,r.heIdent].filter(Boolean).join(\" / \")||r.id||\"RUNWAY\")}</strong><span>${r.lengthFt?Number(r.lengthFt).toLocaleString()+\" \u00d7 \"+(r.widthFt||\"\u2014\")+\" ft\":\"\u2014\"}</span></div><p>${escapeHtml([r.surface,r.lighted?\"LIGHTED\":\"UNLIGHTED\",r.condition].filter(Boolean).join(\" \u00b7 \"))}</p></div>`).join(\"\"):`<div class=\"card unknown\"><strong>RUNWAY DATA UNAVAILABLE</strong><p>${escapeHtml(airportDetail&&airportDetail.error||\"No runway records returned.\")}</p></div>`}\nfunction renderAirportComms(){const rows=airportDetail&&airportDetail.frequencies||[];$(\"infoBody\").innerHTML=rows.length?rows.map(f=>`<div class=\"freq\"><strong>${escapeHtml(f.type||\"FREQ\")}</strong><span>${escapeHtml(f.description||\"\")}</span><em>${escapeHtml(f.frequencyMhz||\"\u2014\")}</em></div>`).join(\"\"):`<div class=\"card unknown\"><strong>COMMS UNAVAILABLE</strong><p>${escapeHtml(airportDetail&&airportDetail.error||\"No frequency records returned.\")}</p></div>`}\nfunction renderAirportProcedures(){const rows=airportProcedures&&airportProcedures.procedures||[];$(\"infoBody\").innerHTML=rows.length?rows.map((p,i)=>approachRow({title:p.name,subtitle:[p.code,p.amendment].filter(Boolean).join(\" \u00b7 \"),chartUrl:p.url},\"FAA\",i)).join(\"\"):`<div class=\"card unknown\"><strong>PROCEDURES UNAVAILABLE</strong><p>${escapeHtml(airportProcedures&&airportProcedures.error||\"No d-TPP procedures returned.\")}</p></div>`;$(\"infoBody\").querySelectorAll(\"[data-open-approach]\").forEach(b=>b.onclick=()=>{const m=JSON.parse(decodeURIComponent(b.dataset.openApproach));$(\"approachDialogTitle\").textContent=m.title;$(\"approachFrame\").src=m.url;$(\"approachDialog\").showModal()})}\nfunction renderAirportTraffic(){const rows=airportTraffic;$(\"infoBody\").innerHTML=rows.length?rows.map(a=>`<button class=\"card\" data-aircraft=\"${escapeHtml(a.hex||\"\")}\" style=\"width:100%;text-align:left\"><strong>${escapeHtml(nameFor(a))}</strong><p>${escapeHtml([a.r,a.t,altFor(a)].filter(Boolean).join(\" \u00b7 \"))}</p></button>`).join(\"\"):'<div class=\"card context\"><strong>NO CURRENT TARGETS</strong><p>No ADS-B aircraft were returned within 35 NM.</p></div>';$(\"infoBody\").querySelectorAll(\"[data-aircraft]\").forEach(b=>b.onclick=()=>{const a=rows.find(x=>x.hex===b.dataset.aircraft);if(a)selectAircraft(a)})}\nfunction bindMapClick(){map.on(\"click\",e=>{const point=e.point,r=innerWidth<700?24:12,box=[[point.x-r,point.y-r],[point.x+r,point.y+r]],c=[];const add=(rank,key,label,sub,run)=>{if(c.some(x=>x.key===key))return;c.push({rank,key,label,sub,run})};const apLayers=[\"airport-dot\",\"airport-label\"].filter(id=>map.getLayer(id));if(apLayers.length)map.queryRenderedFeatures(box,{layers:apLayers}).forEach(f=>{const id=f.properties.id||f.properties.ident,ap=airports.find(a=>String(a.id||a.ident)===String(id)||airportCode(a)===f.properties.label);if(ap)add(0,\"airport:\"+airportCode(ap),airportCode(ap),ap.name,()=>selectAirport(ap))});const tr=map.queryRenderedFeatures(box,{layers:[\"traffic\",\"selected-aircraft\"]});tr.forEach(f=>{const a=traffic.find(x=>String(x.hex||nameFor(x))===String(f.properties.hex||f.id));if(a)add(10,\"aircraft:\"+(a.hex||nameFor(a)),nameFor(a),[a.r,a.t,altFor(a)].filter(Boolean).join(\" \u00b7 \"),()=>selectAircraft(a))});const navLayers=[\"navaid-dot\",\"navaid-label\"].filter(id=>map.getLayer(id));if(navLayers.length)map.queryRenderedFeatures(box,{layers:navLayers}).forEach(f=>{const n=navaids.find(x=>x.ident===f.properties.id);if(n)add(20,\"nav:\"+n.ident,n.ident,[n.name,n.type].filter(Boolean).join(\" \u00b7 \"),()=>showNavaid(n,e.lngLat))});const wxLayers=[\"weather-fill\",\"weather-line\"].filter(id=>map.getLayer(id));if(wxLayers.length)map.queryRenderedFeatures(box,{layers:wxLayers}).forEach(f=>add(40,\"wx:\"+(f.id||JSON.stringify(f.geometry)),f.properties.kind||\"WEATHER\",f.properties.hazard||f.properties.type||\"Advisory\",()=>showWeather(f)));c.sort((a,b)=>a.rank-b.rank);if(c.length){c[0].run();if(c.length>1)showAlso(c.slice(1),point)}else{closeInfo();hideAlso()}});map.on(\"mousemove\",e=>{const box=[[e.point.x-8,e.point.y-8],[e.point.x+8,e.point.y+8]],layers=[\"airport-dot\",\"airport-label\",\"traffic\",\"navaid-dot\",\"navaid-label\",\"weather-fill\"].filter(id=>map.getLayer(id));map.getCanvas().style.cursor=layers.length&&map.queryRenderedFeatures(box,{layers}).length?\"pointer\":\"\"})}\nfunction showAlso(items,point){const el=$(\"also\");el.classList.add(\"open\");el.style.left=Math.min(innerWidth-330,Math.max(8,point.x+12))+\"px\";el.style.top=Math.min(innerHeight-220,Math.max(8,point.y+12))+\"px\";$(\"alsoTitle\").textContent=`ALSO HERE \u00b7 ${items.length}`;$(\"alsoBody\").innerHTML=items.map((x,i)=>`<button data-also=\"${i}\"><strong>${escapeHtml(x.label)}</strong><span>${escapeHtml(x.sub||\"\")}</span></button>`).join(\"\");$(\"alsoBody\").querySelectorAll(\"button\").forEach(b=>b.onclick=()=>{items[Number(b.dataset.also)].run();hideAlso()})}\nfunction hideAlso(){$(\"also\").classList.remove(\"open\")}\nfunction showNavaid(n,ll){new maplibregl.Popup({offset:10}).setLngLat(ll).setHTML(`<strong>${escapeHtml(n.ident)} \u00b7 ${escapeHtml(n.type)}</strong><br><span>${escapeHtml(n.name||\"\")} \u00b7 ${n.frequencyKhz?Number(n.frequencyKhz)>=1000?(Number(n.frequencyKhz)/1000).toFixed(2)+\" MHz\":n.frequencyKhz+\" kHz\":\"Frequency unavailable\"}</span>`).addTo(map)}\nfunction showWeather(f){const p=f.properties||{};openInfo(\"weather\",p.kind||\"WEATHER\",p.hazard||p.type||\"Advisory\",[{id:\"detail\",label:\"DETAIL\",render:()=>{$(\"infoBody\").innerHTML=`<div class=\"metrics\">${metric(\"PRODUCT\",p.kind||\"\u2014\")}${metric(\"HAZARD\",p.hazard||p.type||\"\u2014\")}${metric(\"VALID FROM\",p.validTimeFrom||p.validTime||\"\u2014\")}${metric(\"VALID TO\",p.validTimeTo||p.validTimeEnd||\"\u2014\")}</div><div class=\"section\"><div class=\"section-title\">SOURCE DETAIL</div><div class=\"raw\">${escapeHtml(p.rawText||p.rawAirSigmet||p.raw||JSON.stringify(p,null,2))}</div></div>`}}])}\nfunction updateRadar(){if(!state.radar||!map.getSource(\"radar\"))return;const b=map.getBounds(),merc=(lon,lat)=>{const R=6378137;return[R*lon*Math.PI/180,R*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))]},p1=merc(b.getWest(),b.getSouth()),p2=merc(b.getEast(),b.getNorth()),w=Math.min(1300,map.getContainer().clientWidth),h=Math.min(900,map.getContainer().clientHeight),url=`https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer/exportImage?bbox=${encodeURIComponent([p1[0],p1[1],p2[0],p2[1]].join(\",\"))}&bboxSR=3857&imageSR=3857&size=${Math.round(w)},${Math.round(h)}&format=png32&transparent=true&f=image`;map.getSource(\"radar\").updateImage({url,coordinates:[[b.getWest(),b.getNorth()],[b.getEast(),b.getNorth()],[b.getEast(),b.getSouth()],[b.getWest(),b.getSouth()]]})}\nfunction bind(){loadPrefs();$(\"drawerClose\").onclick=closeDrawer;$(\"planBtn\").onclick=()=>openDrawer(\"plan\");$(\"approachBtn\").onclick=()=>{openDrawer(\"approaches\");loadApproaches()};$(\"layersBtn\").onclick=()=>openDrawer(\"layers\");$(\"planHeaderBtn\").onclick=()=>openDrawer(\"plan\");$(\"approachHeaderBtn\").onclick=()=>{openDrawer(\"approaches\");loadApproaches()};$(\"layersHeaderBtn\").onclick=()=>openDrawer(\"layers\");$(\"homeBtn\").onclick=fitHome;$(\"fitHome\").onclick=fitHome;$(\"zoomIn\").onclick=()=>map.zoomIn();$(\"zoomOut\").onclick=()=>map.zoomOut();$(\"infoClose\").onclick=closeInfo;$(\"alsoClose\").onclick=hideAlso;$(\"whyClose\").onclick=()=>$(\"whyDialog\").close();$(\"approachDialogClose\").onclick=()=>{$(\"approachDialog\").close();$(\"approachFrame\").src=\"about:blank\"};document.querySelectorAll(\"[data-range]\").forEach(b=>b.onclick=()=>{state.range=Number(b.dataset.range);document.querySelectorAll(\"[data-range]\").forEach(x=>x.classList.toggle(\"active\",x===b));savePrefs();fitRange()});document.querySelectorAll(\"[data-story-tab]\").forEach(b=>b.onclick=()=>{storyTab=b.dataset.storyTab;document.querySelectorAll(\"[data-story-tab]\").forEach(x=>x.classList.toggle(\"active\",x===b));renderStory()});$(\"storyToggle\").onclick=()=>{$(\"story\").classList.toggle(\"expanded\")};setInterval(()=>{updateHeader();renderStory()},1000)}\nloadPrefs();bind();\nconst map=new maplibregl.Map({container:\"map\",style:mapStyle(state.base),center:[HOME.lon,HOME.lat],zoom:6.2,interactive:true,dragRotate:false,pitchWithRotate:false,touchPitch:false,renderWorldCopies:false,attributionControl:false});let styleFallbackUsed=false;restoreTrafficSnapshot();loadTraffic();map.touchZoomRotate.disableRotation();map.addControl(new maplibregl.NavigationControl({showCompass:false}),\"top-right\");map.on(\"style.load\",()=>installLayers());map.on(\"error\",e=>{if(styleFallbackUsed||state.base!==\"aviation\"||map.isStyleLoaded())return;styleFallbackUsed=true;toast(\"Vector base unavailable \u00b7 using clean aviation fallback\",true);map.setStyle({version:8,sources:{},layers:[{id:\"background\",type:\"background\",paint:{\"background-color\":\"#dfe6e2\"}}]})});map.on(\"load\",()=>{fitRange();if(!liveTrafficConfirmed)loadTraffic(true);setTimeout(loadReference,550);loadApproaches();trafficTimer=setInterval(loadTraffic,22000);referenceTimer=setInterval(loadReference,120000)});map.on(\"moveend\",()=>{clearTimeout(moveTimer);moveTimer=setTimeout(()=>{loadTraffic();loadReference();if(state.radar)updateRadar()},650)});map.on(\"zoom\",()=>{$(\"mapContext\").textContent=`${HOME.id} \u00b7 Z${map.getZoom().toFixed(1)}`});updateHeader();renderStory();\n})();\n</script>\n</body>\n</html>";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/custom-approaches/")) return env.ASSETS.fetch(request);
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
        if (url.pathname === "/api/health") return json({ok:true,version:"7.0.2",architecture:"core-first-contextual-rebuild",mapDefault:"aviation",trafficPriority:true,flightPlanning:true,approachLibrary:true,customApproachPack:true,time:new Date().toISOString()});
        return json({error:"API route not found",endpoint:url.pathname,version:"7.0.2"},404);
      } catch (error) {
        const requestId=crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`;
        console.error("AteFlight API failure",{requestId,endpoint:url.pathname,message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:null});
        return json({error:"AteFlight API request failed",detail:error instanceof Error?error.message:String(error),endpoint:url.pathname,requestId,version:"7.0.2"},500);
      }
    }
    return new Response(PAGE,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
  }
};
