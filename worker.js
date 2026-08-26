const CENTER = { lat: 45.0781, lon: -83.5603 };
const FRESH_TTL = 15;
const STALE_TTL = 600;

const SOURCES = {
  theairtraffic: {
    name: "theairtraffic",
    urls: ["https://globe.theairtraffic.com/data/aircraft.json"]
  },
  hpradar: {
    name: "hpradar",
    urls: ["https://skylink.hpradar.com/data/aircraft.json"]
  },
  flyitalyadsb: {
    name: "flyitalyadsb",
    urls: [
      "https://mappa.flyitalyadsb.com/data/aircraft.json",
      "https://mappa.flyitalyadsb.com/tar1090/data/aircraft.json"
    ]
  }
};

const TRAFFIC_SOURCE_ORDER = {
  // Default: one proven source, one fallback. This is the fast/reliable path.
  fast: [SOURCES.theairtraffic, SOURCES.hpradar],
  // Expanded: one already-aggregated source first, then proven fallbacks.
  expanded: [SOURCES.flyitalyadsb, SOURCES.theairtraffic, SOURCES.hpradar]
};

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
        "user-agent": "Mozilla/5.0 AteFlight/6.3"
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

function aircraftPositionAge(a) {
  const p = Number(a && a.seen_pos);
  if (Number.isFinite(p)) return p;
  const s = Number(a && a.seen);
  return Number.isFinite(s) ? s : 999999;
}

async function fetchAircraftSnapshot(source) {
  const errors = [];

  for (const url of source.urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8500);

    try {
      const response = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": "Mozilla/5.0 AteFlight/6.3"
        },
        // Cloudflare may reuse the origin response between viewport requests.
        cf: {
          cacheEverything: true,
          cacheTtl: 12
        },
        signal: controller.signal
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const raw = await response.json();
      const rows = Array.isArray(raw.aircraft) ? raw.aircraft :
                   Array.isArray(raw.ac) ? raw.ac : [];

      return {
        source: source.name,
        url,
        now: Number(raw.now),
        rows,
        rawCount: rows.length
      };
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(errors.join(" | ") || "No source URL succeeded");
}

function trafficWithinScope(a, bbox, lat, lon, radius) {
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return false;
  if (bbox) return withinBbox(a.lat, a.lon, bbox);
  return distanceNm(lat, lon, a.lat, a.lon) <= radius;
}

async function traffic(request, ctx) {
  const u = new URL(request.url);
  const lat = clampNumber(u.searchParams.get("lat"), -90, 90, CENTER.lat);
  const lon = clampNumber(u.searchParams.get("lon"), -180, 180, CENTER.lon);
  const radius = Math.round(clampNumber(u.searchParams.get("radius"), 5, 1600, 100));
  const bbox = u.searchParams.has("bbox")
    ? parseBbox(u.searchParams.get("bbox"), null)
    : null;
  const zoom = clampNumber(u.searchParams.get("zoom"), 0, 24, 7);
  const coverageMode = u.searchParams.get("coverage") === "expanded"
    ? "expanded"
    : "fast";

  const scopeKey = bbox
    ? `bbox/${bboxKey(bbox, 0.20)}`
    : `point/${lat.toFixed(3)}/${lon.toFixed(3)}/${radius}`;

  const cache = caches.default;
  const freshKey = new Request(`${u.origin}/__traffic_cache/v62/${coverageMode}/${scopeKey}/fresh`);
  const staleKey = new Request(`${u.origin}/__traffic_cache/v62/${coverageMode}/${scopeKey}/stale`);

  const fresh = await cache.match(freshKey);
  if (fresh) {
    const payload = await fresh.json();
    payload.cached = true;
    return json(payload);
  }

  const sourceOrder = TRAFFIC_SOURCE_ORDER[coverageMode];
  const sourceStats = [];
  const errors = [];
  let selectedSnapshot = null;
  let selectedAircraft = [];

  // One global source at a time. Stop when we have usable visible traffic.
  // This avoids downloading/parsing two enormous global files per refresh.
  for (const source of sourceOrder) {
    try {
      const snap = await fetchAircraftSnapshot(source);
      const scoped = [];

      for (const raw of snap.rows) {
        const a = normalize(raw);
        if (!trafficWithinScope(a, bbox, lat, lon, radius)) continue;
        scoped.push(a);
      }

      sourceStats.push({
        source: source.name,
        ok: true,
        rawCount: snap.rawCount,
        scopedCount: scoped.length,
        url: snap.url
      });

      // A successful source with visible aircraft is sufficient.
      // If it reports zero for a wide populated view, try the next source.
      if (scoped.length || snap.rawCount === 0) {
        selectedSnapshot = snap;
        selectedAircraft = scoped;
        break;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${source.name}: ${detail}`);
      sourceStats.push({
        source: source.name,
        ok: false,
        error: detail,
        rawCount: 0,
        scopedCount: 0
      });
    }
  }

  if (selectedSnapshot) {
    selectedAircraft.sort((a, b) => aircraftPositionAge(a) - aircraftPositionAge(b));

    // Canvas rendering handles broad views well, but the payload still needs
    // a safety ceiling for memory-constrained phones.
    const maxTargets = zoom < 4.5 ? 8500 : zoom < 6 ? 7000 : 5000;
    const uncappedTotal = selectedAircraft.length;
    const aircraft = selectedAircraft.slice(0, maxTargets);

    const generatedAt = Number.isFinite(selectedSnapshot.now)
      ? new Date(selectedSnapshot.now * 1000).toISOString()
      : new Date().toISOString();

    const payload = {
      source: selectedSnapshot.source,
      coverageMode,
      generatedAt,
      center: { lat, lon, radiusNm: radius },
      bbox,
      total: aircraft.length,
      uncappedTotal,
      sourceCount: 1,
      attemptedSourceCount: sourceStats.length,
      sourceStats,
      errors,
      aircraft,
      stale: false,
      cached: false
    };

    const freshResponse = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${FRESH_TTL}`
      }
    });
    const staleResponse = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${STALE_TTL}`
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
    payload.warning = errors.join(" | ");
    return json(payload);
  }

  return json({
    error: "No live ADS-B source is reachable yet",
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
        "user-agent": "AteFlight/6.3 weather-display contact=local-home-display"
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
        "user-agent": "AteFlight/6.3 selected-flight-trace"
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
          "user-agent": "AteFlight/6.3 static-route-lookup"
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
          "user-agent": "AteFlight/6.3 fallback-route-lookup"
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
        "user-agent": "AteFlight/6.3 airport-catalog"
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
        "user-agent": "AteFlight/6.3 airport-detail"
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
        "user-agent": "AteFlight/6.3 airport-detail"
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
  const lines = csvText.split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0];
  const needles = airportIds.filter(Boolean).map(id => `,"${String(id).toUpperCase()}",`);
  const matching = lines.slice(1).filter(line =>
    needles.some(n => line.toUpperCase().includes(n))
  );
  if (!matching.length) return [];
  return rowsToObjects([header, ...matching].join("\n"));
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
      headers: { "user-agent": "AteFlight/6.3 FAA-dTPP" },
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

const PAGE = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"theme-color\" content=\"#071019\">\n<title>AteFlight \u2014 Operations</title>\n<link rel=\"stylesheet\" href=\"https://unpkg.com/maplibre-gl@6.1.0/dist/maplibre-gl.css\">\n<style>\n:root{\n  color-scheme:dark;\n  --bg:#070b10;\n  --chrome:#0b1118;\n  --surface:#0e151d;\n  --surface-2:#121c26;\n  --surface-3:#17232e;\n  --border:#263541;\n  --border-strong:#344a5a;\n  --text:#f4f7f9;\n  --muted:#8da0ae;\n  --subtle:#657784;\n  --accent:#58c7e8;\n  --accent-soft:#123848;\n  --good:#52d18c;\n  --warning:#f0c35a;\n  --danger:#ef6973;\n  --selected:#ffc857;\n  --vfr:#3ed083;\n  --mvfr:#4b9dff;\n  --ifr:#ef5d63;\n  --lifr:#b66cff;\n  --radius:7px;\n  --shadow:0 18px 50px rgba(0,0,0,.38);\n}\n*{box-sizing:border-box}\nhtml,body{margin:0;width:100%;height:100%;overflow:hidden;overscroll-behavior:none;background:var(--bg);color:var(--text);\n  font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;\n  font-feature-settings:\"tnum\" 1,\"ss01\" 1}\nbutton,input,select{font:inherit}\nbutton{color:inherit}\nbutton:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n.app{height:100vh;height:100svh;height:100dvh;display:grid;grid-template-rows:46px minmax(0,1fr);overflow:hidden}\n.topbar{\n  min-width:0;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:14px;\n  padding:0 10px;border-bottom:1px solid var(--border);background:var(--chrome);z-index:50\n}\n.brand{display:flex;align-items:center;gap:9px;min-width:0}\n.brand-mark{width:27px;height:27px;border:1px solid var(--border-strong);border-radius:6px;display:grid;place-items:center;\n  color:var(--accent);font-size:8px;font-weight:950;letter-spacing:.08em;background:#0c1720}\n.brand-copy strong{display:block;font-size:13px;letter-spacing:.045em;font-weight:900}\n.brand-copy span{display:block;font-size:8.5px;letter-spacing:.11em;color:var(--subtle);font-weight:800;margin-top:2px;line-height:1.25}\n.ops-strip{justify-self:center;display:flex;align-items:center;gap:11px;min-width:0}\n.ops-item{display:flex;align-items:baseline;gap:5px;color:var(--muted);font-size:8.5px;white-space:nowrap}\n.ops-item strong{font-size:10.5px;color:var(--text);font-weight:900}\n.status-dot{width:7px;height:7px;border-radius:50%;background:var(--warning);box-shadow:0 0 0 3px rgba(240,195,90,.08)}\n.status-dot.good{background:var(--good);box-shadow:0 0 0 3px rgba(82,209,140,.08)}\n.status-dot.bad{background:var(--danger);box-shadow:0 0 0 3px rgba(239,105,115,.08)}\n.actions{display:flex;align-items:center;gap:5px}\n.btn{\n  height:31px;border:1px solid var(--border);border-radius:6px;background:var(--surface);\n  color:#c4d0d7;padding:0 10px;font-size:9.5px;font-weight:850;letter-spacing:.025em;cursor:pointer\n}\n.btn:hover{background:var(--surface-2);border-color:var(--border-strong)}\n.btn.active{background:var(--accent-soft);border-color:#2e7891;color:#d8f6ff}\n.btn.icon{width:29px;padding:0;display:grid;place-items:center}\n.btn svg,.rail-btn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}\n.workspace{position:relative;min-width:0;min-height:0;overflow:hidden}\n#map{position:absolute;inset:0}\n.maplibregl-map{font:inherit}\n.maplibregl-canvas{outline:none}\n.maplibregl-ctrl-bottom-left,.maplibregl-ctrl-bottom-right{display:none}\n.rail{\n  position:absolute;z-index:25;left:8px;top:8px;width:42px;display:flex;flex-direction:column;gap:5px\n}\n.rail-btn{\n  width:42px;height:42px;border:1px solid rgba(50,72,86,.9);border-radius:7px;background:rgba(9,17,24,.94);\n  color:#9aadb9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;\n  box-shadow:0 7px 18px rgba(0,0,0,.17)\n}\n.rail-btn span{font-size:6px;font-weight:900;letter-spacing:.07em}\n.rail-btn:hover{color:#d3e1e8;border-color:#476273}\n.rail-btn.active{background:#103044;border-color:#377c96;color:#d9f6ff}\n.side-panel{\n  position:absolute;z-index:30;left:56px;top:8px;bottom:48px;width:min(368px,calc(100vw - 76px));\n  background:rgba(10,17,24,.97);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);\n  display:none;grid-template-rows:auto auto minmax(0,1fr);overflow:hidden\n}\n.side-panel.open{display:grid}\n.panel-head{height:43px;padding:0 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}\n.panel-title strong{display:block;font-size:12px;letter-spacing:.065em}\n.panel-title span{display:block;font-size:8.5px;color:var(--muted);margin-top:3px;line-height:1.3}\n.panel-tabs{height:34px;display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--border);background:#0b141c}\n.panel-tab{\n  border:0;border-right:1px solid var(--border);background:transparent;color:var(--muted);\n  font-size:9px;font-weight:900;letter-spacing:.07em;cursor:pointer\n}\n.panel-tab:last-child{border-right:0}\n.panel-tab.active{color:var(--text);box-shadow:inset 0 -2px 0 var(--accent);background:#0e1b25}\n.panel-scroll{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:10px}\n.panel-section{margin-bottom:14px}\n.section-label{font-size:9px;color:#778f9f;font-weight:900;letter-spacing:.115em;margin-bottom:8px}\n.choice-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}\n.choice{\n  min-height:44px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:#b7c4cc;\n  padding:7px;text-align:left;cursor:pointer\n}\n.choice strong,.choice span{display:block}.choice strong{font-size:10.5px}.choice span{font-size:8.5px;color:var(--muted);margin-top:3px;line-height:1.25}\n.choice.active{border-color:#3d839b;background:#102b39;color:#e2f8ff}\n.row{\n  min-height:41px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;align-items:center;\n  border-bottom:1px solid rgba(38,53,65,.55)\n}\n.row:last-child{border-bottom:0}\n.row-copy strong,.row-copy span{display:block}.row-copy strong{font-size:10px}.row-copy span{font-size:8.25px;color:var(--muted);margin-top:3px;line-height:1.35}\n.switch{position:relative;width:32px;height:18px}\n.switch input{position:absolute;opacity:0;pointer-events:none}\n.switch-track{position:absolute;inset:0;border-radius:20px;background:#172630;border:1px solid #35505f;transition:.12s}\n.switch-track:after{content:\"\";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#8ea0aa;transition:.12s}\n.switch input:checked+.switch-track{background:#0e526a;border-color:#3986a0}\n.switch input:checked+.switch-track:after{transform:translateX(14px);background:#e0f8ff}\n.small-select{height:31px;min-width:98px;border:1px solid var(--border);border-radius:5px;background:#0b151d;color:var(--text);font-size:9px;padding:0 8px}\n.range-input{width:93px;accent-color:var(--accent)}\n.info-panel{\n  position:absolute;z-index:31;right:8px;top:8px;bottom:48px;width:min(392px,42%);\n  background:rgba(8,15,21,.98);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);\n  display:none;grid-template-rows:auto minmax(0,1fr);overflow:hidden\n}\n.info-panel.open{display:grid}\n.info-head{padding:11px 11px 9px;border-bottom:1px solid var(--border)}\n.info-kicker{font-size:8px;letter-spacing:.13em;color:var(--subtle);font-weight:900}\n.info-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}\n.info-title{font-size:22px;font-weight:900;letter-spacing:-.02em;margin-top:2px}\n.info-sub{font-size:10px;color:var(--muted);margin-top:3px;line-height:1.35}\n.info-scroll{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:10px}\n.route-card{\n  border:1px solid var(--border);border-radius:7px;background:#0c151d;padding:9px;margin-bottom:9px\n}\n.route-line{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center}\n.airport{text-align:left}.airport:last-child{text-align:right}\n.airport strong{display:block;font-size:15px}.airport span{display:block;font-size:6.5px;color:var(--muted);margin-top:2px}\n.route-arrow{color:var(--accent);font-size:14px}\n.route-note{margin-top:8px;font-size:8.5px;color:var(--subtle);line-height:1.4}\n.metrics{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-top:2px}\n.metric{border:0;border-bottom:1px solid rgba(38,53,65,.62);background:transparent;padding:10px 6px}\n.metric:nth-last-child(-n+2){border-bottom:0}\n.metric:nth-child(odd){border-right:1px solid rgba(38,53,65,.62)}\n.metric span,.metric strong{display:block}.metric span{font-size:8px;color:var(--muted);letter-spacing:.045em}.metric strong{font-size:12.5px;margin-top:3px}\n.info-section{margin-top:13px}.info-section h4{font-size:8.5px;color:#7f96a5;letter-spacing:.11em;margin:0 0 7px}\n.info-actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}\n.info-action{\n  height:32px;border:1px solid var(--border);border-radius:5px;background:#0d1a24;color:#b9c9d2;\n  padding:0 10px;font-size:9px;font-weight:900;cursor:pointer;transition:background .12s,border-color .12s,color .12s\n}\n.info-action:hover{border-color:var(--border-strong);color:var(--text)}\n.info-action.active,.info-action.primary.active{\n  border-color:#3b8da8;background:#123b4e;color:#e4f9ff;box-shadow:inset 0 -2px 0 #58c7e8\n}\n.info-action:disabled{opacity:.42;cursor:default}\n\n.airport-badge{display:inline-flex;align-items:center;height:20px;border:1px solid var(--border);border-radius:4px;padding:0 6px;font-size:8px;font-weight:900;color:#aebdc6;background:#0c171f}\n.airport-badge.scheduled{border-color:#2d7189;color:#cceef8;background:#0d2b3a}\n.movement-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:10px 0}\n.movement-summary div{border-top:1px solid var(--border);padding:7px 2px 2px}\n.movement-summary strong,.movement-summary span{display:block}\n.movement-summary strong{font-size:14px}.movement-summary span{font-size:7.5px;color:var(--muted);margin-top:2px}\n.movement-board{border-top:1px solid var(--border)}\n.movement-row{width:100%;min-height:43px;border:0;border-bottom:1px solid rgba(38,53,65,.62);background:transparent;color:var(--text);display:grid;grid-template-columns:64px 1fr auto;gap:8px;align-items:center;text-align:left;padding:6px 2px;cursor:pointer}\n.movement-row:hover{background:#0d1a23}\n.movement-status{font-size:7.5px;font-weight:900;letter-spacing:.05em}\n.movement-status.GROUND{color:#59d49a}.movement-status.ARRIVING{color:#64c8ee}.movement-status.DEPARTING{color:#f0c35a}.movement-status.NEARBY{color:#8da0ae}\n.movement-main strong,.movement-main span{display:block}.movement-main strong{font-size:10px}.movement-main span{font-size:8px;color:var(--muted);margin-top:2px}\n.movement-side{text-align:right}.movement-side strong,.movement-side span{display:block}.movement-side strong{font-size:9px}.movement-side span{font-size:7px;color:var(--muted);margin-top:2px}\n\n.loading-line{height:3px;background:#0d1b24;overflow:hidden;margin-top:8px;border-radius:2px}\n.loading-line i{display:block;width:35%;height:100%;background:var(--accent);animation:load 1.1s ease-in-out infinite}\n@keyframes load{0%{transform:translateX(-120%)}100%{transform:translateX(340%)}}\n.bottom-bar{\n  position:absolute;z-index:24;left:56px;right:8px;bottom:8px;height:34px;border:1px solid rgba(52,74,88,.86);\n  border-radius:7px;background:rgba(8,15,21,.93);display:flex;align-items:center;gap:7px;padding:3px 6px;\n  backdrop-filter:blur(8px);box-shadow:0 8px 18px rgba(0,0,0,.14)\n}\n.segment{display:flex;gap:2px}\n.segment button{\n  height:26px;min-width:34px;border:0;border-radius:5px;background:transparent;color:#8699a6;font-size:7px;font-weight:900;cursor:pointer\n}\n.segment button.active{background:#143246;color:#dff8ff}\n.bar-sep{width:1px;height:16px;background:var(--border)}\n.bar-stat{display:flex;align-items:baseline;gap:3px;font-size:6.5px;color:var(--muted);white-space:nowrap}\n.bar-stat strong{font-size:8px;color:var(--text)}\n.bar-spacer{flex:1}\n.map-btn{\n  width:30px;height:26px;border:1px solid var(--border);border-radius:5px;background:#0c171f;color:#a7b6bf;\n  display:grid;place-items:center;cursor:pointer;font-size:10px\n}\n.map-btn:hover{border-color:var(--border-strong);color:var(--text)}\n.toast{\n  position:absolute;z-index:60;left:50%;top:10px;transform:translateX(-50%);max-width:min(680px,calc(100% - 90px));\n  border:1px solid #705f28;border-radius:6px;background:rgba(53,43,16,.96);color:#f3dda0;padding:7px 10px;\n  font-size:7.5px;box-shadow:var(--shadow);display:none\n}\n.toast.bad{border-color:#70313a;background:rgba(54,20,25,.97);color:#ffd8dc}\n.command{\n  width:min(620px,calc(100% - 24px));max-height:min(620px,calc(100vh - 48px));padding:0;\n  border:1px solid var(--border-strong);border-radius:9px;background:#0a1118;color:var(--text);box-shadow:0 28px 80px rgba(0,0,0,.55)\n}\n.command::backdrop{background:rgba(2,6,9,.68);backdrop-filter:blur(2px)}\n.command-head{height:45px;display:flex;align-items:center;border-bottom:1px solid var(--border);padding:0 11px}\n.command-input{width:100%;border:0;background:transparent;color:var(--text);font-size:12px;outline:none}\n.command-list{max-height:520px;overflow:auto;padding:6px}\n.command-group{font-size:6.5px;color:var(--subtle);letter-spacing:.12em;font-weight:900;padding:7px 7px 4px}\n.command-item{\n  width:100%;min-height:38px;border:0;border-radius:6px;background:transparent;color:#c6d2d9;\n  display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 8px;text-align:left;cursor:pointer\n}\n.command-item:hover,.command-item.focused{background:#11212c}\n.command-item strong{display:block;font-size:8px}.command-item span{display:block;font-size:6.5px;color:var(--muted);margin-top:2px}\n.command-key{font-size:6px;color:#778b98;border:1px solid var(--border);border-radius:4px;padding:2px 5px}\n.maplibregl-ctrl.maplibregl-ctrl-group{\n  background:rgba(8,15,21,.94);border:1px solid var(--border);box-shadow:none;border-radius:6px;overflow:hidden\n}\n.maplibregl-ctrl-group button{width:29px;height:29px}\n.maplibregl-ctrl-group button+button{border-top:1px solid var(--border)}\n.maplibregl-ctrl-icon{filter:invert(.8)}\n.maplibregl-popup-content{background:#0a131b;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;box-shadow:var(--shadow)}\n.maplibregl-popup-tip{border-top-color:#0a131b!important}\n.clean .topbar,.clean .rail,.clean .bottom-bar,.clean .side-panel{display:none!important}\n.clean .app{grid-template-rows:minmax(0,1fr)}\n.clean .info-panel{top:8px;bottom:8px}\n.clean .clean-return{display:block}\n.clean-return{display:none;position:absolute;left:8px;top:8px;z-index:70}\n@media(max-width:900px){\n  .brand-copy span{display:none}.ops-strip{display:none}\n  .side-panel{width:310px}\n  .info-panel{width:min(345px,45%)}\n}\n@media(max-width:720px){\n  .app{grid-template-rows:42px minmax(0,1fr)}\n  .topbar{padding:0 6px;gap:6px}.brand-mark{display:none}.brand-copy strong{font-size:10px}\n  .actions .btn:not(.icon){padding:0 6px}\n  .side-panel{left:6px;right:6px;top:auto;bottom:48px;width:auto;height:min(68%,520px)}\n  .info-panel{left:6px;right:6px;top:auto;bottom:48px;width:auto;height:min(56%,450px)}\n  .bottom-bar{left:6px}.rail{left:6px;top:7px}.rail-btn{width:37px;height:37px}\n  .rail-btn span{display:none}\n  .bar-stat.optional{display:none}\n}\n\n/* V5.1 readability / product typography pass */\n.brand-copy strong{font-size:14px}\n.brand-copy span{font-size:9.5px;line-height:1.3}\n.ops-item{font-size:9.5px}\n.ops-item strong{font-size:11.5px}\n.btn{font-size:10.5px;height:32px}\n.rail-btn span{font-size:7.5px}\n.panel-title strong{font-size:13px}\n.panel-title span{font-size:10px;line-height:1.35}\n.panel-tab{font-size:10.5px}\n.panel-scroll{font-size:11px;padding:12px}\n.section-label{font-size:10px;margin-bottom:9px}\n.choice{min-height:52px;padding:9px}\n.choice strong{font-size:11.5px}\n.choice span{font-size:9.5px;line-height:1.35;margin-top:4px}\n.row{min-height:50px}\n.row-copy strong{font-size:11.5px}\n.row-copy span{font-size:9.5px;line-height:1.4;margin-top:3px}\n.small-select{font-size:10.5px;height:32px;min-width:104px}\n.info-kicker{font-size:9.5px}\n.info-title{font-size:26px}\n.info-sub{font-size:11px;line-height:1.4}\n.info-scroll{padding:12px}\n.airport strong{font-size:17px}\n.airport span{font-size:9px;line-height:1.25}\n.route-note{font-size:9.5px;line-height:1.45}\n.metric{padding:11px 8px}\n.metric span{font-size:9px}\n.metric strong{font-size:14px;margin-top:4px}\n.info-section h4{font-size:9.5px;margin-bottom:8px}\n.info-action{height:34px;font-size:10px;padding:0 11px}\n.airport-badge{font-size:9px;height:23px}\n.movement-summary strong{font-size:16px}\n.movement-summary span{font-size:8.5px}\n.movement-row{min-height:49px}\n.movement-status{font-size:8.75px}\n.movement-main strong{font-size:11.5px}\n.movement-main span{font-size:9.5px;line-height:1.3}\n.movement-side strong{font-size:10.5px}\n.movement-side span{font-size:9px}\n.bar-stat{font-size:8px}\n.bar-stat strong{font-size:10px}\n.segment button{font-size:9px}\n.command-input{font-size:13px}\n.command-group{font-size:8.5px}\n.command-item strong{font-size:11px}\n.command-item span{font-size:9.5px;line-height:1.3}\n.command-key{font-size:7.5px}\n.maplibregl-popup-content{font-size:11px;line-height:1.4}\n\n\n.sheet-handle{display:none;height:18px;align-items:center;justify-content:center;touch-action:none;cursor:ns-resize}\n.sheet-handle i{display:block;width:38px;height:4px;border-radius:4px;background:#526673}\n.mobile-peek{display:none;padding:0 12px 10px;border-bottom:1px solid var(--border)}\n.sheet-actions{display:none}\n.airport-runway{padding:10px 0;border-bottom:1px solid rgba(38,53,65,.62)}\n.airport-runway:last-child{border-bottom:0}\n.airport-runway-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline}\n.airport-runway-head strong{font-size:12px}\n.airport-runway-head span{font-size:9px;color:var(--muted)}\n.airport-runway-meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:5px;font-size:9px;color:#afbec7}\n.airport-freq-row{display:grid;grid-template-columns:72px 1fr auto;gap:8px;padding:8px 0;border-bottom:1px solid rgba(38,53,65,.55);align-items:center}\n.airport-freq-row:last-child{border-bottom:0}\n.airport-freq-row strong{font-size:10px}\n.airport-freq-row span{font-size:9px;color:var(--muted)}\n.airport-freq-row em{font-style:normal;font-size:11px;font-weight:900;color:#dce8ed}\n.resource-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px}\n.resource-link{min-height:39px;border:1px solid var(--border);border-radius:6px;background:#0d1a24;color:#c7d5dc;text-decoration:none;display:flex;flex-direction:column;justify-content:center;padding:7px 8px}\n.resource-link strong{font-size:10px}.resource-link span{font-size:8px;color:var(--muted);margin-top:2px}\n.resource-link:hover{border-color:#3b7388;background:#102431}\n@media(max-width:720px){\n  .info-panel{\n    left:6px;right:6px;top:auto;bottom:46px;width:auto;\n    height:var(--sheet-height,168px);max-height:calc(100% - 54px);\n    transition:height .18s cubic-bezier(.2,.7,.2,1);border-radius:10px 10px 7px 7px\n  }\n  .info-panel.sheet-peek{--sheet-height:168px}\n  .info-panel.sheet-half{--sheet-height:43%}\n  .info-panel.sheet-full{--sheet-height:82%}\n  .sheet-handle{display:flex}\n  .sheet-actions{height:38px;display:flex;gap:5px;align-items:center;padding:4px 10px;border-top:1px solid var(--border);background:#0a1219}\n  .sheet-actions button{height:28px;flex:1;border:1px solid var(--border);border-radius:5px;background:#0d1821;color:#93a6b2;font-size:9px;font-weight:900}\n  .sheet-actions button.active{background:#123848;border-color:#3b829a;color:#e3f9ff}\n  .mobile-peek{display:block}\n  .info-panel.sheet-peek .info-scroll{display:none}\n  .info-panel.sheet-peek .info-head{padding-bottom:7px}\n  .info-panel.sheet-peek .info-title{font-size:21px}\n  .info-panel.sheet-peek .info-sub{font-size:10px}\n  .info-panel.sheet-half .mobile-peek,.info-panel.sheet-full .mobile-peek{display:none}\n  .info-panel.sheet-half .info-scroll,.info-panel.sheet-full .info-scroll{display:block}\n  .bottom-bar.sheet-open{display:none}\n}\n\n\n.procedure-list{border-top:1px solid var(--border)}\n.procedure-row{display:grid;grid-template-columns:58px minmax(0,1fr) auto;gap:8px;align-items:center;min-height:45px;border-bottom:1px solid rgba(38,53,65,.6);padding:6px 0}\n.procedure-type{font-size:8.5px;font-weight:900;color:#7fa0b2;letter-spacing:.06em}\n.procedure-copy strong,.procedure-copy span{display:block}.procedure-copy strong{font-size:10.5px}.procedure-copy span{font-size:8.5px;color:var(--muted);margin-top:2px}\n.procedure-view{height:29px;border:1px solid var(--border);border-radius:5px;background:#0e1a23;color:#c8d7de;text-decoration:none;display:flex;align-items:center;padding:0 8px;font-size:8.5px;font-weight:900}\n.procedure-view:hover{border-color:#3c7f96;background:#102d3b;color:#e0f8ff}\n.integration-state{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid rgba(38,53,65,.55)}\n.integration-state strong,.integration-state span{display:block}.integration-state strong{font-size:10px}.integration-state span{font-size:8.5px;color:var(--muted);margin-top:2px}\n.integration-state em{font-style:normal;font-size:8px;font-weight:900;color:#d0a950}\n\n/* V5.4 mobile interaction and runway intelligence */\n.info-panel{grid-template-rows:auto minmax(0,1fr);background:rgba(8,15,21,.985)}\n.info-head{position:relative;z-index:3;background:#081119;min-width:0}\n.info-title{line-height:1.04}\n.info-sub{line-height:1.35;white-space:normal}\n.info-scroll{position:relative;z-index:1;min-height:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;scrollbar-gutter:auto;background:#081119}\n.sheet-actions{background:#081119}\n.airport-tabs{position:sticky;top:-1px;z-index:4;display:flex;gap:3px;overflow-x:auto;scrollbar-width:none;padding:0 0 8px;background:#081119;border-bottom:1px solid var(--border);margin-bottom:10px}\n.airport-tabs::-webkit-scrollbar{display:none}\n.airport-tab{height:31px;flex:0 0 auto;border:1px solid transparent;border-radius:5px;background:transparent;color:#8094a1;padding:0 9px;font-size:9px;font-weight:900;letter-spacing:.035em;cursor:pointer}\n.airport-tab.active{background:#123545;border-color:#377d95;color:#e3f8ff}\n.runway-recommendation{border:1px solid #256b4c;background:#0b231a;border-radius:7px;padding:10px;margin-bottom:10px}\n.runway-recommendation.neutral{border-color:var(--border);background:#0c161e}\n.runway-rec-head{display:flex;align-items:center;justify-content:space-between;gap:10px}\n.runway-rec-title{display:flex;align-items:center;gap:8px;min-width:0}\n.runway-arrow-chip{width:31px;height:31px;border-radius:6px;display:grid;place-items:center;background:#123d29;color:#63df97;font-size:20px;font-weight:950;transform:rotate(var(--arrow-rotation,0deg))}\n.runway-rec-title strong,.runway-rec-title span{display:block}.runway-rec-title strong{font-size:13px;color:#dff9ea}.runway-rec-title span{font-size:9px;color:#91b9a2;margin-top:2px}\n.runway-rec-wind{text-align:right}.runway-rec-wind strong,.runway-rec-wind span{display:block}.runway-rec-wind strong{font-size:12px}.runway-rec-wind span{font-size:8px;color:#91a59a;margin-top:2px}\n.runway-components{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px;border-top:1px solid rgba(78,143,103,.3);padding-top:8px}\n.runway-components div span,.runway-components div strong{display:block}.runway-components div span{font-size:8px;color:#82a18d}.runway-components div strong{font-size:12px;margin-top:2px}\n.runway-caution{font-size:8.5px;line-height:1.4;color:#83a08d;margin-top:8px}\n.runway-card{padding:11px 0;border-bottom:1px solid rgba(38,53,65,.7)}\n.runway-card:last-child{border-bottom:0}\n.runway-card.preferred{background:linear-gradient(90deg,rgba(19,67,43,.36),rgba(19,67,43,0));padding-left:8px;border-left:2px solid #55d18a}\n.runway-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}\n.runway-card-head strong{font-size:13px}.runway-card-head span{font-size:10px;color:var(--muted)}\n.runway-direction-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}\n.runway-direction{border-left:2px solid #314451;padding-left:7px}\n.runway-direction.preferred{border-left-color:#55d18a}\n.runway-direction strong,.runway-direction span{display:block}.runway-direction strong{font-size:11px}.runway-direction span{font-size:8.5px;color:var(--muted);margin-top:2px}\n.runway-preferred-badge{display:inline-flex;align-items:center;height:20px;border-radius:4px;background:#123d29;color:#75e3a5;padding:0 6px;font-size:8px;font-weight:900}\n.airport-summary-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;margin-bottom:10px}\n.airport-summary-cell{border-top:1px solid var(--border);padding:8px 2px 2px}.airport-summary-cell span,.airport-summary-cell strong{display:block}.airport-summary-cell span{font-size:8.5px;color:var(--muted)}.airport-summary-cell strong{font-size:13px;margin-top:3px}\n.info-actions{align-items:stretch}\n@media(max-width:720px){\n  html,body,.app{height:var(--visual-height,100dvh);min-height:var(--visual-height,100dvh)}\n  .info-panel{\n    left:6px;right:6px;top:auto;bottom:max(6px,env(safe-area-inset-bottom));width:auto;\n    height:var(--sheet-height,210px);max-height:calc(var(--visual-height,100dvh) - 50px);\n    grid-template-rows:18px auto auto minmax(0,1fr) 42px;\n    background:#081119;backdrop-filter:none;border-radius:11px;overflow:hidden;contain:layout paint;\n    transition:height .2s cubic-bezier(.2,.72,.2,1),transform .2s ease\n  }\n  .info-panel.sheet-peek{--sheet-height:clamp(204px,25dvh,226px)}\n  .info-panel.sheet-half{--sheet-height:52dvh}\n  .info-panel.sheet-full{--sheet-height:calc(var(--visual-height,100dvh) - 54px)}\n  .sheet-handle{grid-row:1;display:flex;background:#081119}\n  .info-head{grid-row:2;padding:4px 13px 10px;background:#081119;border-bottom:1px solid var(--border)}\n  .mobile-peek{grid-row:3;display:block;padding:8px 13px 10px;background:#081119;border-bottom:1px solid var(--border)}\n  .info-scroll{grid-row:4;padding:12px 14px 18px;background:#081119;touch-action:pan-y}\n  .sheet-actions{grid-row:5;height:42px;display:flex;gap:5px;align-items:center;padding:5px 10px;border-top:1px solid var(--border);background:#081119}\n  .sheet-actions button{height:31px;font-size:9.5px}\n  .info-panel.sheet-peek .info-scroll{display:none!important}\n  .info-panel.sheet-half .mobile-peek,.info-panel.sheet-full .mobile-peek{display:none!important}\n  .info-panel.sheet-half .info-scroll,.info-panel.sheet-full .info-scroll{display:block!important}\n  .info-panel.sheet-peek .info-title{font-size:23px;line-height:1}\n  .info-panel.sheet-peek .info-sub{font-size:10px;margin-top:3px}\n  .info-panel.sheet-peek .info-kicker{font-size:8px}\n  .info-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}\n  .info-action{width:100%;height:35px}\n  .bottom-bar.sheet-open{display:none!important}\n  .airport-tabs{top:-12px;padding-top:2px}\n  .airport-tab{font-size:9.5px;height:33px}\n  .runway-rec-head{align-items:flex-start}.runway-rec-wind strong{font-size:11px}\n}\n\n\n.context-nav{display:none;border-bottom:1px solid var(--border);background:#081119;overflow-x:auto;scrollbar-width:none}\n.context-nav::-webkit-scrollbar{display:none}\n.context-nav.airport{display:flex;padding:5px 8px;gap:4px}\n.context-nav .airport-tab{font-size:10px;height:34px;padding:0 11px}\n@media(max-width:720px){\n  .info-panel{\n    grid-template-rows:18px auto auto auto minmax(0,1fr) 42px;\n  }\n  .context-nav.airport{position:relative;z-index:3;flex:0 0 auto;padding:5px 8px 6px}\n  .context-nav .airport-tab{font-size:10px;height:35px}\n  .info-panel.sheet-peek .context-nav{display:none}\n  .info-panel.sheet-peek{grid-template-rows:18px auto auto minmax(0,0) 0 42px}\n  .info-panel.sheet-half .context-nav.airport,.info-panel.sheet-full .context-nav.airport{display:flex}\n}\n\n\n.identifier-line{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}\n.identifier-chip{display:inline-flex;align-items:center;height:22px;padding:0 7px;border:1px solid var(--border);border-radius:4px;background:#0c171f;color:#aebdc6;font-size:8.5px;font-weight:900}\n.identifier-chip.primary{border-color:#3c839b;background:#102d3b;color:#dff8ff}\n.identifier-chip.navaid{border-color:#7c6b39;background:#261f0d;color:#eed58d}\n.navaid-row{display:grid;grid-template-columns:58px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(38,53,65,.58)}\n.navaid-row:last-child{border-bottom:0}\n.navaid-row strong{font-size:10px}.navaid-row span{font-size:8.5px;color:var(--muted)}\n.navaid-row em{font-style:normal;font-size:10px;font-weight:900;color:#d9e6ec}\n.data-source-note{font-size:8px;color:var(--subtle);line-height:1.4;padding:7px 0}\n.aircraft-class-chip{display:inline-flex;align-items:center;height:20px;border:1px solid var(--border);border-radius:4px;padding:0 6px;background:#0d1821;color:#aebdc6;font-size:8px;font-weight:900;margin-right:5px}\n\n\n/* V6.0 professional aviation chart modes */\n.map-mode-bar{position:absolute;z-index:23;left:50%;top:8px;transform:translateX(-50%);display:flex;gap:2px;padding:3px;border:1px solid rgba(48,70,84,.9);border-radius:8px;background:rgba(7,14,20,.94);box-shadow:0 10px 26px rgba(0,0,0,.24);backdrop-filter:blur(10px)}\n.map-mode-btn{height:31px;border:0;border-radius:5px;background:transparent;color:#91a4b0;padding:0 12px;font-size:9px;font-weight:900;letter-spacing:.045em;cursor:pointer;white-space:nowrap}\n.map-mode-btn:hover{color:#e1edf2;background:#101e28}.map-mode-btn.active{background:#173445;color:#ecfbff;box-shadow:inset 0 -2px 0 #58c7e8}\n.chart-badge{display:none;position:absolute;z-index:22;right:8px;top:48px;min-width:215px;border:1px solid rgba(47,69,83,.9);border-radius:7px;background:rgba(7,14,20,.92);padding:7px 9px;box-shadow:0 8px 22px rgba(0,0,0,.22);backdrop-filter:blur(8px)}\n.chart-badge.open{display:block}.chart-badge strong,.chart-badge span{display:block}.chart-badge strong{font-size:10px;letter-spacing:.055em}.chart-badge span{font-size:8px;color:#8ea2af;margin-top:3px;line-height:1.35}.chart-badge.overzoom{border-color:#8c7130}.chart-badge.overzoom strong{color:#f1ca66}.chart-native-btn{margin-top:6px;height:25px;border:1px solid #304a5a;border-radius:4px;background:#0e1a23;color:#b9cbd4;font-size:7.5px;font-weight:900;padding:0 7px;cursor:pointer}\n.aviation-legend{display:none;position:absolute;z-index:21;right:8px;bottom:48px;border:1px solid rgba(48,69,82,.75);border-radius:6px;background:rgba(7,14,20,.88);padding:6px 8px;color:#95a9b5;font-size:8px;line-height:1.5;backdrop-filter:blur(7px)}\n.aviation-legend.open{display:block}.aviation-legend b{color:#e0ebef}.aviation-legend i{display:inline-block;width:9px;height:9px;margin-right:4px;vertical-align:-1px}\n.layer-note{margin-top:8px;padding:8px;border:1px solid rgba(50,72,86,.65);border-radius:6px;background:#0b151d;color:#8fa3af;font-size:8.5px;line-height:1.45}.layer-note strong{color:#d5e2e8}\n.weather-legend-row{display:flex;gap:9px;flex-wrap:wrap;margin-top:7px;font-size:8px;color:#93a6b2}.weather-legend-row span{white-space:nowrap}\n.weather-legend-row i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}\n.navaid-popup strong{font-size:12px}.navaid-popup span{font-size:9px;color:#9cafba}\n@media(max-width:720px){\n .map-mode-bar{top:7px;left:51px;right:49px;transform:none;overflow-x:auto;justify-content:flex-start;scrollbar-width:none}.map-mode-bar::-webkit-scrollbar{display:none}.map-mode-btn{height:30px;padding:0 10px;font-size:8.5px}\n .chart-badge{top:45px;right:6px;min-width:188px;max-width:calc(100% - 62px)}\n .aviation-legend{display:none!important}\n}\n\n\n.traffic-cluster-label{font-weight:950;letter-spacing:.01em}\n.feed-health{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}\n.feed-health div{border-top:1px solid var(--border);padding:7px 2px 2px}\n.feed-health strong,.feed-health span{display:block}.feed-health strong{font-size:12px}.feed-health span{font-size:8px;color:var(--muted);margin-top:2px}\n.airport-data-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px}\n.airport-data-summary div{border:1px solid var(--border);border-radius:6px;background:#0c161e;padding:8px}\n.airport-data-summary strong,.airport-data-summary span{display:block}.airport-data-summary strong{font-size:14px}.airport-data-summary span{font-size:8px;color:var(--muted);margin-top:2px}\n.detail-mode-badge{position:absolute;left:58px;top:8px;z-index:22;height:25px;border:1px solid rgba(57,83,99,.72);border-radius:5px;background:rgba(8,15,21,.82);display:flex;align-items:center;padding:0 7px;color:#9eb0ba;font-size:8px;font-weight:900;letter-spacing:.05em;pointer-events:none}\n@media(max-width:720px){.detail-mode-badge{left:51px;top:7px;font-size:7.5px}}\n\n\n.traffic-canvas{\n  position:absolute;inset:0;z-index:12;width:100%;height:100%;\n  pointer-events:none;touch-action:none\n}\n\n\n/* AteFlight V6.3 inspector system */\n:root{\n  --af-panel:#081017;--af-panel-2:#0c151d;--af-line:#24343f;--af-line-strong:#385364;\n  --af-text:#f2f6f8;--af-muted:#9babb5;--af-dim:#6e818d;--af-cyan:#59c8e8;--af-green:#58d18e\n}\n.info-panel{\n  width:min(438px,44%);border-radius:4px;border:1px solid var(--af-line-strong);\n  background:var(--af-panel);box-shadow:0 20px 55px rgba(0,0,0,.42);\n  grid-template-rows:auto auto minmax(0,1fr);overflow:hidden\n}\n.info-head{padding:16px 18px 13px;background:var(--af-panel);border-bottom:1px solid var(--af-line);z-index:5}\n.info-kicker{font-size:10px;letter-spacing:.14em;color:#7f95a2}\n.info-title{font-size:29px;line-height:1;font-weight:850;letter-spacing:-.025em}\n.info-sub{font-size:12px;color:#a9b8c1;margin-top:5px;line-height:1.35}\n.info-meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;font-size:10px;color:#7f929e}\n.info-meta b{font-weight:850;color:#dce7ec}\n.context-nav{display:none;background:#0a131a;border-bottom:1px solid var(--af-line);overflow-x:auto;scrollbar-width:none;padding:0 10px}\n.info-panel.airport-mode .context-nav{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0}\n.context-nav .airport-tab{\n  min-width:0;height:43px;border:0;border-radius:0;background:transparent;color:#879aa6;padding:0 4px;\n  font-size:9.5px;font-weight:850;letter-spacing:.025em;border-bottom:2px solid transparent;\n  display:flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;overflow:hidden\n}\n.airport-tab-count{font:800 8px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#617783}\n.context-nav .airport-tab.active .airport-tab-count{color:#72d8ff}\n.context-nav .airport-tab:hover{color:#d9e6ec;background:#0e1a22}\n.context-nav .airport-tab.active{color:#ecfaff;background:transparent;border-bottom-color:var(--af-cyan);box-shadow:none}\n.info-scroll{padding:16px 18px 22px;background:var(--af-panel);font-size:12px;color:var(--af-text)}\n.identifier-line{display:none!important}\n.data-source-note{font-size:10px;color:#7f929e;line-height:1.45;padding:0 0 10px}\n.airport-data-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:0 0 16px;border-top:1px solid var(--af-line);border-bottom:1px solid var(--af-line)}\n.airport-data-summary div{border:0;border-right:1px solid var(--af-line);border-radius:0;background:transparent;padding:10px 8px}\n.airport-data-summary div:last-child{border-right:0}\n.airport-data-summary strong{font-size:17px}.airport-data-summary span{font-size:9px;color:#81949f;margin-top:3px}\n.airport-summary-grid{gap:0;margin-bottom:15px;border-top:1px solid var(--af-line);border-bottom:1px solid var(--af-line)}\n.airport-summary-cell{border-top:0;border-bottom:1px solid var(--af-line);padding:11px 6px}\n.airport-summary-cell:nth-last-child(-n+2){border-bottom:0}\n.airport-summary-cell:nth-child(odd){border-right:1px solid var(--af-line)}\n.airport-summary-cell span{font-size:9px}.airport-summary-cell strong{font-size:15px}\n.info-section{margin-top:17px}.info-section h4{font-size:10px;color:#8da0ab;letter-spacing:.11em;margin:0 0 9px}\n.runway-recommendation{border-radius:4px;padding:12px;margin-bottom:15px}\n.runway-rec-title strong{font-size:14px}.runway-rec-title span{font-size:10px}\n.runway-caution{font-size:10px;line-height:1.5}\n.runway-card{padding:14px 0}.runway-card-head strong{font-size:15px}.runway-card-head span{font-size:11px}\n.runway-direction strong{font-size:12px}.runway-direction span{font-size:10px;line-height:1.35}\n.airport-freq-row{grid-template-columns:80px minmax(0,1fr) auto;padding:11px 0}\n.airport-freq-row strong{font-size:11px}.airport-freq-row span{font-size:10px}.airport-freq-row em{font-size:13px}\n.procedure-row{grid-template-columns:66px minmax(0,1fr) auto;min-height:50px}\n.procedure-type{font-size:9px}.procedure-copy strong{font-size:11px}.procedure-copy span{font-size:9px}.procedure-view{font-size:9px;height:31px}\n.info-actions{position:sticky;bottom:-22px;background:linear-gradient(180deg,rgba(8,16,23,0),var(--af-panel) 26%);padding-top:18px}\n.info-action{height:35px;font-size:10px;border-radius:3px}\n.af-loading{display:grid;gap:8px;padding:8px 0}\n.af-loading i{height:11px;border-radius:2px;background:linear-gradient(90deg,#0d1820,#172832,#0d1820);background-size:200% 100%;animation:afShimmer 1.1s linear infinite}\n.af-loading i:nth-child(2){width:78%}.af-loading i:nth-child(3){width:55%}\n@keyframes afShimmer{to{background-position:-200% 0}}\n.af-empty{padding:13px;border-left:2px solid #536873;background:#0b151c;color:#9fb0ba;font-size:11px;line-height:1.5}\n.af-empty strong{display:block;color:#d7e2e7;margin-bottom:3px;font-size:11px}\n@media(max-width:900px){.info-panel{width:min(420px,48%)}}\n@media(max-width:720px){\n  .info-panel{left:6px;right:6px;width:auto;border-radius:8px 8px 3px 3px;grid-template-rows:18px auto auto auto minmax(0,1fr) 42px}\n  .info-head{padding:5px 14px 11px}.info-title{font-size:24px}.info-sub{font-size:11px}.info-meta{font-size:9px;margin-top:6px}\n  .info-panel.airport-mode.sheet-half .context-nav,.info-panel.airport-mode.sheet-full .context-nav{display:grid!important;grid-template-columns:repeat(5,minmax(0,1fr));padding:0 4px}\n  .info-panel.sheet-peek .context-nav{display:none!important}\n  .context-nav .airport-tab{height:39px;font-size:8.5px;padding:0 2px;gap:2px}.airport-tab-count{font-size:7px}\n  .info-scroll{padding:13px 14px 20px;font-size:12px}\n}\n\n</style>\n</head>\n<body>\n<main id=\"app\" class=\"app\">\n  <header class=\"topbar\">\n    <div class=\"brand\">\n      <div class=\"brand-mark\">AF</div>\n      <div class=\"brand-copy\"><strong>AteFlight</strong><span>LIVE AIRSPACE \u00b7 WEATHER \u00b7 AIRPORTS</span></div>\n    </div>\n    <div class=\"ops-strip\">\n      <div class=\"ops-item\"><span id=\"statusDot\" class=\"status-dot\"></span><strong id=\"statusText\">CONNECTING</strong></div>\n      <div class=\"ops-item\"><strong id=\"topAircraft\">\u2014</strong><span>AIRCRAFT</span></div>\n      <div class=\"ops-item\"><strong id=\"topAge\">\u2014</strong><span>DATA AGE</span></div>\n      <div class=\"ops-item\"><strong id=\"topWx\">\u2014</strong><span>WX AGE</span></div>\n    </div>\n    <div class=\"actions\">\n      <button id=\"commandBtn\" class=\"btn\" type=\"button\">SEARCH <span style=\"color:var(--subtle)\">\u2318K</span></button>\n      <button id=\"refreshBtn\" class=\"btn icon\" type=\"button\" aria-label=\"Refresh\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"M20 11a8 8 0 1 0-2.3 5.7\"/><path d=\"M20 4v7h-7\"/></svg>\n      </button>\n      <button id=\"cleanBtn\" class=\"btn icon\" type=\"button\" aria-label=\"Clean view\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5\"/></svg>\n      </button>\n    </div>\n  </header>\n\n  <section class=\"workspace\">\n    <div id=\"map\"></div><canvas id=\"trafficCanvas\" class=\"traffic-canvas\" aria-label=\"Live aircraft\"></canvas>\n    <div id=\"mapModeBar\" class=\"map-mode-bar\" aria-label=\"Aviation map mode\">\n      <button class=\"map-mode-btn active\" data-map-mode=\"aviation\" type=\"button\">AVIATION</button>\n      <button class=\"map-mode-btn\" data-map-mode=\"vfr\" type=\"button\">VFR SECTIONAL</button>\n      <button class=\"map-mode-btn\" data-map-mode=\"ifr-low\" type=\"button\">IFR LOW</button>\n      <button class=\"map-mode-btn\" data-map-mode=\"ifr-high\" type=\"button\">IFR HIGH</button>\n    </div>\n    <div id=\"chartBadge\" class=\"chart-badge\"><strong id=\"chartBadgeTitle\">FAA CHART</strong><span id=\"chartBadgeMeta\">FAA Aeronautical Information Services</span><button id=\"nativeZoomBtn\" class=\"chart-native-btn\" type=\"button\">NATIVE DETAIL</button></div>\n    <div id=\"aviationLegend\" class=\"aviation-legend\"><b>AVIATION BASE</b><br><span><i style=\"border:2px solid #58c7e8;border-radius:50%\"></i>Reporting airport</span><br><span><i style=\"background:#d6e0e5;transform:rotate(45deg)\"></i>VOR / VORTAC</span></div>\n\n    <div class=\"rail\">\n      <button class=\"rail-btn\" data-open-tab=\"base\" type=\"button\" aria-label=\"Map layers\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"m12 2 9 5-9 5-9-5 9-5Z\"/><path d=\"m3 12 9 5 9-5M3 17l9 5 9-5\"/></svg><span>MAP</span>\n      </button>\n      <button class=\"rail-btn\" data-open-tab=\"weather\" type=\"button\" aria-label=\"Weather layers\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"M17.5 19H7a5 5 0 1 1 1.3-9.8A6 6 0 0 1 20 11a4 4 0 0 1-2.5 8Z\"/></svg><span>WX</span>\n      </button>\n      <button class=\"rail-btn\" data-open-tab=\"traffic\" type=\"button\" aria-label=\"Traffic layers\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"m12 2 2 7 6 3v2l-6-1-1 6 3 2v1l-4-1-4 1v-1l3-2-1-6-6 1v-2l6-3 2-7Z\"/></svg><span>TRFC</span>\n      </button>\n      <button id=\"homeBtn\" class=\"rail-btn\" type=\"button\" aria-label=\"Return to KAPN\">\n        <svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"7\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><path d=\"M12 2v3M12 19v3M2 12h3M19 12h3\"/></svg><span>KAPN</span>\n      </button>\n    </div>\n    <div id=\"detailModeBadge\" class=\"detail-mode-badge\">AUTO DETAIL \u00b7 REGIONAL</div>\n\n    <aside id=\"sidePanel\" class=\"side-panel\" aria-label=\"Map controls\">\n      <div class=\"panel-head\">\n        <div class=\"panel-title\"><strong>DISPLAY</strong><span id=\"panelSubtitle\">Map and chart presentation</span></div>\n        <button id=\"sideClose\" class=\"btn icon\" type=\"button\" aria-label=\"Close panel\">\u00d7</button>\n      </div>\n      <div class=\"panel-tabs\">\n        <button class=\"panel-tab active\" data-tab=\"base\" type=\"button\">BASE</button>\n        <button class=\"panel-tab\" data-tab=\"weather\" type=\"button\">WEATHER</button>\n        <button class=\"panel-tab\" data-tab=\"traffic\" type=\"button\">TRAFFIC</button>\n      </div>\n      <div id=\"panelScroll\" class=\"panel-scroll\"></div>\n    </aside>\n\n    <aside id=\"infoPanel\" class=\"info-panel\" aria-label=\"Selected item details\">\n      <div id=\"sheetHandle\" class=\"sheet-handle\" aria-hidden=\"true\"><i></i></div>\n      <div class=\"info-head\">\n        <div id=\"infoKicker\" class=\"info-kicker\">SELECTED AIRCRAFT</div>\n        <div class=\"info-title-row\"><div id=\"infoTitle\" class=\"info-title\">\u2014</div><button id=\"infoClose\" class=\"btn icon\" type=\"button\">\u00d7</button></div>\n        <div id=\"infoSub\" class=\"info-sub\">\u2014</div><div id=\"infoMeta\" class=\"info-meta\"></div>\n        <div id=\"infoLoading\" class=\"loading-line\" style=\"display:none\"><i></i></div>\n      </div>\n      <div id=\"mobilePeek\" class=\"mobile-peek\"></div>\n      <div id=\"contextNav\" class=\"context-nav\"></div>\n      <div id=\"infoScroll\" class=\"info-scroll\"></div>\n      <div id=\"sheetActions\" class=\"sheet-actions\">\n        <button data-sheet=\"peek\" type=\"button\">PEEK</button>\n        <button data-sheet=\"half\" type=\"button\">DETAILS</button>\n        <button data-sheet=\"full\" type=\"button\">FULL</button>\n      </div>\n    </aside>\n\n    <div id=\"bottomBar\" class=\"bottom-bar\">\n      <div id=\"rangeSegment\" class=\"segment\">\n        <button data-range=\"25\" type=\"button\">25</button>\n        <button data-range=\"50\" type=\"button\">50</button>\n        <button data-range=\"100\" class=\"active\" type=\"button\">100</button>\n        <button data-range=\"150\" type=\"button\">150</button>\n        <button data-range=\"250\" type=\"button\">250</button>\n      </div>\n      <div class=\"bar-sep\"></div>\n      <div class=\"bar-stat\"><strong id=\"barAircraft\">\u2014</strong><span>ACFT</span></div>\n      <div class=\"bar-stat optional\"><strong id=\"barMetar\">\u2014</strong><span>METAR</span></div>\n      <div class=\"bar-stat optional\"><strong id=\"barPirep\">\u2014</strong><span>PIREP</span></div>\n      <div class=\"bar-stat optional\"><strong id=\"barContext\">REGIONAL</strong><span>DETAIL</span></div>\n      <div class=\"bar-spacer\"></div>\n      <button id=\"zoomOut\" class=\"map-btn\" type=\"button\" aria-label=\"Zoom out\">\u2212</button>\n      <button id=\"zoomIn\" class=\"map-btn\" type=\"button\" aria-label=\"Zoom in\">+</button>\n      <button id=\"fitRange\" class=\"map-btn\" type=\"button\" aria-label=\"Fit selected range\">\u25ce</button>\n    </div>\n\n    <div id=\"toast\" class=\"toast\"></div>\n    <button id=\"cleanReturn\" class=\"btn clean-return\" type=\"button\">SHOW CONTROLS</button>\n  </section>\n</main>\n\n<dialog id=\"commandDialog\" class=\"command\">\n  <div class=\"command-head\"><input id=\"commandInput\" class=\"command-input\" autocomplete=\"off\" placeholder=\"Search aircraft or run a command\u2026\"></div>\n  <div id=\"commandList\" class=\"command-list\"></div>\n</dialog>\n\n<script type=\"module\">\nimport * as maplibregl from \"https://unpkg.com/maplibre-gl@6.1.0/dist/maplibre-gl.mjs\";\n\n(function(){\n\"use strict\";\n\nvar CENTER=[-83.5603,45.0781];\nvar TRAFFIC_POLL=20000;\nvar WEATHER_POLL=120000;\nvar MICH_COORDS=[[-91.10252, 47.59131], [-81.83658, 47.59131], [-81.83658, 41.23557], [-91.10252, 41.23557]];\nvar STYLE_URLS={\n  dark:\"https://tiles.openfreemap.org/styles/dark\",\n  light:\"https://tiles.openfreemap.org/styles/positron\",\n  liberty:\"https://tiles.openfreemap.org/styles/liberty\"\n};\nvar state={\n  range:100,base:\"aviation\",chartOpacity:.92,terminalCharts:false,satellite:false,satelliteOpacity:.88,\n  radar:false,radarOpacity:.66,radarLoop:false,lightning:false,lightningOpacity:.72,\n  metars:true,tafs:true,pireps:true,advisories:true,cwas:true,tcf:true,\n  rings:false,labels:\"full\",trafficFilter:\"all\",altFilter:\"all\",vectors:true,coverageMode:\"fast\",clean:false\n};\nvar traffic=[],trafficMeta={sourceCount:0,attemptedSourceCount:0,sourceStats:[],uncappedTotal:0},weather={metars:[],tafs:[],pireps:[],gairmets:{type:\"FeatureCollection\",features:[]},sigmets:{type:\"FeatureCollection\",features:[]},cwas:{type:\"FeatureCollection\",features:[]},tcf:{type:\"FeatureCollection\",features:[]}};\nvar selected=null,selectedTrace=null,selectedRoute=null,selectedToken=0;\nvar nearbyNavaids=[];\nvar selectedAirport=null,airportTraffic=[],airportToken=0,airportDetail=null,airportProcedures=null,airportTab=\"overview\",airportLoad={detail:\"idle\",procedures:\"idle\",traffic:\"idle\"},airports=[],navaids=[];\nvar cameraMode=\"free\",cameraProgrammatic=false;\nvar sheetDetent=\"peek\",sheetDragging=false,sheetStartY=0,sheetStartHeight=0;\nvar lastTrafficAt=0,lastWeatherAt=0,trafficBusy=false,weatherBusy=false;\nvar trafficTimer=null,weatherTimer=null,radarLoopTimer=null,radarFrame=5,trafficViewportTimer=null,referenceViewportTimer=null,lastTrafficViewportKey=\"\",lastReferenceViewportKey=\"\",trafficRequestToken=0,referenceRequestToken=0,trafficCanvasFrame=0,canvasTargets=[];\nvar panelTab=\"base\";\nvar prefsKey=\"ateflight-v63\";\n\nfunction $(id){return document.getElementById(id)}\nfunction updateVisualViewport(){\n  var h=window.visualViewport?window.visualViewport.height:window.innerHeight;\n  document.documentElement.style.setProperty(\"--visual-height\",Math.round(h)+\"px\")\n}\nfunction escapeHtml(s){return String(s==null?\"\":s).replace(/[&<>\"']/g,function(c){return({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#039;\"})[c]})}\nfunction clamp(v,a,b){return Math.max(a,Math.min(b,v))}\nfunction saveState(){try{localStorage.setItem(prefsKey,JSON.stringify(state))}catch(e){}}\nfunction loadState(){try{var p=JSON.parse(localStorage.getItem(prefsKey)||\"null\");if(p)Object.keys(state).forEach(function(k){if(p[k]!==undefined)state[k]=p[k]})}catch(e){}}\nfunction toast(text,bad){\n  var t=$(\"toast\");if(!text){t.style.display=\"none\";return}\n  t.className=\"toast\"+(bad?\" bad\":\"\");t.textContent=text;t.style.display=\"block\";\n  clearTimeout(toast._timer);toast._timer=setTimeout(function(){t.style.display=\"none\"},4300)\n}\nfunction setStatus(kind,text){\n  $(\"statusDot\").className=\"status-dot\"+(kind?\" \"+kind:\"\");$(\"statusText\").textContent=text\n}\nfunction aircraftName(a){return(a.flight&&String(a.flight).trim())||a.r||(a.hex?String(a.hex).toUpperCase():\"UNKNOWN\")}\nfunction altitude(a){\n  if(a.alt_baro===\"ground\")return\"GROUND\";\n  var n=Number(a.alt_baro!=null?a.alt_baro:a.alt_geom);return Number.isFinite(n)?Math.round(n).toLocaleString()+\" ft\":\"\u2014\"\n}\nfunction altitudeNumber(a){var n=Number(a.alt_baro!=null?a.alt_baro:a.alt_geom);return Number.isFinite(n)?n:null}\nfunction aircraftAge(a){var n=Number(a.seen_pos!=null?a.seen_pos:a.seen);return Number.isFinite(n)?Math.max(0,n):0}\nfunction isAirline(a){return/^[A-Z]{3}\\d+[A-Z]?$/.test((a.flight||\"\").trim())}\nfunction flightCategoryColor(cat){\n  cat=String(cat||\"\").toUpperCase();\n  return cat===\"VFR\"?\"#3ed083\":cat===\"MVFR\"?\"#4b9dff\":cat===\"IFR\"?\"#ef5d63\":cat===\"LIFR\"?\"#b66cff\":\"#9aadb9\"\n}\nfunction distanceNm(lat1,lon1,lat2,lon2){\n  var R=3440.065,r=function(x){return x*Math.PI/180},p1=r(lat1),p2=r(lat2),dp=r(lat2-lat1),dl=r(lon2-lon1);\n  var h=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);\n  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)))\n}\nfunction destinationPoint(lon,lat,bearingDeg,distanceNmValue){\n  var R=3440.065,d=distanceNmValue/R,br=bearingDeg*Math.PI/180,p1=lat*Math.PI/180,l1=lon*Math.PI/180;\n  var p2=Math.asin(Math.sin(p1)*Math.cos(d)+Math.cos(p1)*Math.sin(d)*Math.cos(br));\n  var l2=l1+Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(p1),Math.cos(d)-Math.sin(p1)*Math.sin(p2));\n  return[(l2*180/Math.PI+540)%360-180,p2*180/Math.PI]\n}\nfunction rangeBoundsAt(center,nm){\n  var lng=Number(center.lng!=null?center.lng:center[0]),lat=Number(center.lat!=null?center.lat:center[1]);\n  var n=destinationPoint(lng,lat,0,nm),e=destinationPoint(lng,lat,90,nm),s=destinationPoint(lng,lat,180,nm),w=destinationPoint(lng,lat,270,nm);\n  return[[w[0],s[1]],[e[0],n[1]]]\n}\nfunction cameraPadding(extra){\n  var wide=window.innerWidth>900;\n  var left=56,right=16,top=16,bottom=48;\n  if(wide&&$(\"sidePanel\").classList.contains(\"open\"))left=392;\n  if(wide&&$(\"infoPanel\").classList.contains(\"open\"))right=410;\n  if(!wide&&$(\"infoPanel\").classList.contains(\"open\"))bottom=Math.max(18,$(\"infoPanel\").getBoundingClientRect().height+12);\n  if(extra){left=Math.max(left,extra.left||0);right=Math.max(right,extra.right||0);top=Math.max(top,extra.top||0);bottom=Math.max(bottom,extra.bottom||0)}\n  return{left:left,right:right,top:top,bottom:bottom}\n}\nfunction fitRange(animate,center){\n  var c=center||map.getCenter();\n  map.fitBounds(rangeBoundsAt(c,state.range),{padding:cameraPadding(),duration:animate===false?0:420,maxZoom:11,linear:true})\n}\nfunction goHome(animate){\n  map.stop();\n  $(\"sidePanel\").classList.remove(\"open\");\n  document.querySelectorAll(\".rail-btn[data-open-tab]\").forEach(function(b){b.classList.remove(\"active\")});\n  $(\"infoPanel\").classList.remove(\"open\",\"airport-mode\");\n  $(\"bottomBar\").classList.remove(\"sheet-open\");\n  var nav=$(\"contextNav\");nav.className=\"context-nav\";nav.innerHTML=\"\";$(\"infoMeta\").innerHTML=\"\";\n  selected=null;selectedTrace=null;selectedRoute=null;selectedToken++;\n  selectedAirport=null;airportTraffic=[];airportDetail=null;airportProcedures=null;airportToken++;\n  cameraMode=\"kapn\";cameraProgrammatic=true;syncAllSources();\n  map.fitBounds(rangeBoundsAt({lng:CENTER[0],lat:CENTER[1]},state.range),{\n    padding:{left:56,right:16,top:16,bottom:48},duration:animate===false?0:520,maxZoom:11,linear:true\n  });\n  map.once(\"moveend\",function(){cameraProgrammatic=false;lastViewportKey=\"\";scheduleViewportLoad(true);toast(\"HOME \u00b7 KAPN\",false)});\n}\nfunction greatCircle(start,end,steps){\n  steps=steps||64;\n  var lon1=start[0]*Math.PI/180,lat1=start[1]*Math.PI/180,lon2=end[0]*Math.PI/180,lat2=end[1]*Math.PI/180;\n  var d=2*Math.asin(Math.sqrt(Math.sin((lat2-lat1)/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin((lon2-lon1)/2)**2));\n  if(!Number.isFinite(d)||d===0)return[start,end];\n  var out=[];\n  for(var i=0;i<=steps;i++){\n    var f=i/steps,A=Math.sin((1-f)*d)/Math.sin(d),B=Math.sin(f*d)/Math.sin(d);\n    var x=A*Math.cos(lat1)*Math.cos(lon1)+B*Math.cos(lat2)*Math.cos(lon2);\n    var y=A*Math.cos(lat1)*Math.sin(lon1)+B*Math.cos(lat2)*Math.sin(lon2);\n    var z=A*Math.sin(lat1)+B*Math.sin(lat2);\n    out.push([Math.atan2(y,x)*180/Math.PI,Math.atan2(z,Math.sqrt(x*x+y*y))*180/Math.PI])\n  }\n  return out\n}\nfunction blankChartStyle(color,name){\n  return{version:8,name:name,metadata:{_altStyle:name},sources:{},layers:[{id:\"background\",type:\"background\",paint:{\"background-color\":color}}]}\n}\nfunction styleForBase(base){\n  if([\"vfr\",\"ifr-low\",\"ifr-high\"].includes(base))return blankChartStyle(\"#e9e7df\",\"FAA Aeronautical Chart\");\n  if(base===\"light\")return STYLE_URLS.light;\n  if(base===\"dark\")return STYLE_URLS.dark;\n  return STYLE_URLS.liberty;\n}\nfunction firstSymbolLayer(){\n  var style=map.getStyle();if(!style||!style.layers)return undefined;\n  var layer=style.layers.find(function(l){return l.type===\"symbol\"});return layer&&layer.id\n}\nfunction addPlaneImage(){\n  if(map.hasImage(\"alt-plane\"))return;\n  var c=document.createElement(\"canvas\");c.width=48;c.height=48;var x=c.getContext(\"2d\");\n  x.translate(24,24);x.fillStyle=\"#f7fbfd\";x.strokeStyle=\"#071019\";x.lineWidth=2;\n  x.beginPath();x.moveTo(0,-17);x.lineTo(4,-4);x.lineTo(17,2);x.lineTo(17,6);x.lineTo(4,4);\n  x.lineTo(3,13);x.lineTo(9,17);x.lineTo(9,20);x.lineTo(0,17);x.lineTo(-9,20);x.lineTo(-9,17);\n  x.lineTo(-3,13);x.lineTo(-4,4);x.lineTo(-17,6);x.lineTo(-17,2);x.lineTo(-4,-4);x.closePath();x.fill();x.stroke();\n  map.addImage(\"alt-plane\",x.getImageData(0,0,48,48));\n\n  function addSvgAircraftIcon(name,svg){\n    if(map.hasImage(name))return;\n    var img=new Image(96,96);\n    img.onload=function(){\n      try{if(!map.hasImage(name))map.addImage(name,img,{pixelRatio:3})}catch(e){}\n    };\n    img.src=\"data:image/svg+xml;charset=utf-8,\"+encodeURIComponent(svg)\n  }\n  function aircraftSvg(body){\n    return'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\" viewBox=\"0 0 64 64\">'+\n      '<g fill=\"#f7fbfd\" stroke=\"#071019\" stroke-width=\"2.4\" stroke-linejoin=\"round\" stroke-linecap=\"round\">'+body+'</g></svg>'\n  }\n  addSvgAircraftIcon(\"plane-light\",aircraftSvg(\n    '<path d=\"M32 6 L36 24 L53 31 L53 35 L36 33 L35 48 L42 54 L42 57 L32 53 L22 57 L22 54 L29 48 L28 33 L11 35 L11 31 L28 24 Z\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-small\",aircraftSvg(\n    '<path d=\"M32 5 L36 23 L55 31 L55 35 L36 33 L35 47 L44 53 L44 57 L32 52 L20 57 L20 53 L29 47 L28 33 L9 35 L9 31 L28 23 Z\"/>'+\n    '<ellipse cx=\"20\" cy=\"33\" rx=\"2.5\" ry=\"4\"/><ellipse cx=\"44\" cy=\"33\" rx=\"2.5\" ry=\"4\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-large\",aircraftSvg(\n    '<path d=\"M32 4 C35 10 37 18 38 25 L57 32 L57 37 L38 34 L37 47 L47 53 L47 57 L32 52 L17 57 L17 53 L27 47 L26 34 L7 37 L7 32 L26 25 C27 18 29 10 32 4 Z\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-heavy\",aircraftSvg(\n    '<path d=\"M32 3 C36 10 39 19 40 26 L59 32 L59 38 L40 35 L39 47 L50 53 L50 58 L32 52 L14 58 L14 53 L25 47 L24 35 L5 38 L5 32 L24 26 C25 19 28 10 32 3 Z\"/>'+\n    '<ellipse cx=\"15\" cy=\"35\" rx=\"3\" ry=\"5\"/><ellipse cx=\"49\" cy=\"35\" rx=\"3\" ry=\"5\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-fast\",aircraftSvg(\n    '<path d=\"M32 4 L38 23 L53 44 L39 39 L37 52 L44 57 L44 60 L32 55 L20 60 L20 57 L27 52 L25 39 L11 44 L26 23 Z\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-rotor\",aircraftSvg(\n    '<path d=\"M28 14 L36 14 L38 39 L35 52 L29 52 L26 39 Z\"/>'+\n    '<path d=\"M10 23 L54 23 M32 7 L32 39 M37 45 L52 51\"/>'\n  ));\n  addSvgAircraftIcon(\"plane-glider\",aircraftSvg(\n    '<path d=\"M32 6 L34 26 L59 31 L59 35 L34 33 L33 51 L39 56 L39 59 L32 56 L25 59 L25 56 L31 51 L30 33 L5 35 L5 31 L30 26 Z\"/>'\n  ));\n\n  if(!map.hasImage(\"preferred-runway-arrow\")){\n    var a=document.createElement(\"canvas\");a.width=42;a.height=24;var g=a.getContext(\"2d\");\n    g.translate(4,12);g.fillStyle=\"#5de092\";g.strokeStyle=\"#071019\";g.lineWidth=2;\n    g.beginPath();g.moveTo(0,-4);g.lineTo(23,-4);g.lineTo(23,-9);g.lineTo(36,0);g.lineTo(23,9);g.lineTo(23,4);g.lineTo(0,4);g.closePath();g.fill();g.stroke();\n    map.addImage(\"preferred-runway-arrow\",g.getImageData(0,0,42,24))\n  }\n}\nfunction emptyFC(){return{type:\"FeatureCollection\",features:[]}}\nfunction safeAddSource(id,source){if(!map.getSource(id))map.addSource(id,source)}\nfunction safeAddLayer(layer,before){if(!map.getLayer(layer.id))map.addLayer(layer,before)}\nfunction installLayers(){\n  addPlaneImage();\n  var before=firstSymbolLayer();\n\n  safeAddSource(\"michigan\",{type:\"image\",url:\"/assets/michigan_chart.webp\",coordinates:MICH_COORDS});\n  safeAddLayer({id:\"michigan\",type:\"raster\",source:\"michigan\",paint:{\"raster-opacity\":state.chartOpacity,\"raster-fade-duration\":0}},before);\n\n  safeAddSource(\"satellite\",{type:\"raster\",tiles:[\"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}\"],tileSize:256});\n  safeAddLayer({id:\"satellite\",type:\"raster\",source:\"satellite\",paint:{\"raster-opacity\":state.satelliteOpacity}},before);\n\n\n  safeAddSource(\"faa-vfr\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:8,maxzoom:12});\n  safeAddLayer({id:\"faa-vfr\",type:\"raster\",source:\"faa-vfr\",paint:{\"raster-opacity\":0.0,\"raster-fade-duration\":0,\"raster-resampling\":\"linear\"}},before);\n\n  safeAddSource(\"faa-terminal\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:10,maxzoom:12});\n  safeAddLayer({id:\"faa-terminal\",type:\"raster\",source:\"faa-terminal\",paint:{\"raster-opacity\":0.0,\"raster-fade-duration\":0,\"raster-resampling\":\"linear\"}},before);\n\n  safeAddSource(\"faa-ifr-low\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:7,maxzoom:12});\n  safeAddLayer({id:\"faa-ifr-low\",type:\"raster\",source:\"faa-ifr-low\",paint:{\"raster-opacity\":0,\"raster-fade-duration\":0,\"raster-resampling\":\"linear\"}},before);\n\n  safeAddSource(\"faa-ifr-high\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:3,maxzoom:12});\n  safeAddLayer({id:\"faa-ifr-high\",type:\"raster\",source:\"faa-ifr-high\",paint:{\"raster-opacity\":0,\"raster-fade-duration\":0,\"raster-resampling\":\"linear\"}},before);\n\n  safeAddSource(\"lightning\",{type:\"image\",url:transparentPixel(),coordinates:[[-90,50],[-80,50],[-80,40],[-90,40]]});\n  safeAddLayer({id:\"lightning\",type:\"raster\",source:\"lightning\",paint:{\"raster-opacity\":state.lightningOpacity,\"raster-fade-duration\":0}},before);\n\n  safeAddSource(\"airports\",{type:\"geojson\",data:emptyFC()});\n\n  // Progressive airport detail: only national hubs at continental zoom,\n  // reporting/regional fields at regional zoom, and small fields when close.\n  safeAddLayer({id:\"airport-wx-hub\",type:\"circle\",source:\"airports\",minzoom:3.5,maxzoom:6.0,\n    filter:[\"all\",[\"==\",[\"get\",\"hasMetar\"],true],[\"==\",[\"get\",\"hub\"],true]],paint:{\n      \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],3.5,3,6,4.2],\"circle-color\":[\"get\",\"wxColor\"],\n      \"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.4,\"circle-opacity\":0.96\n  }});\n  safeAddLayer({id:\"airport-hub\",type:\"circle\",source:\"airports\",minzoom:3.5,maxzoom:6.5,\n    filter:[\"all\",[\"==\",[\"get\",\"hub\"],true],[\"==\",[\"get\",\"hasMetar\"],false]],paint:{\n      \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],3.5,2.8,6.5,4.2],\"circle-color\":\"#0a141c\",\n      \"circle-stroke-color\":\"#72d8ff\",\"circle-stroke-width\":1.5\n  }});\n  safeAddLayer({id:\"airport-wx\",type:\"circle\",source:\"airports\",minzoom:6.0,filter:[\"==\",[\"get\",\"hasMetar\"],true],paint:{\n    \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],6,3.5,9,5,12,6.4],\"circle-color\":[\"get\",\"wxColor\"],\n    \"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.55,\"circle-opacity\":0.98\n  }});\n  safeAddLayer({id:\"airport-major\",type:\"circle\",source:\"airports\",minzoom:6.0,\n    filter:[\"all\",[\"==\",[\"get\",\"major\"],true],[\"==\",[\"get\",\"hasMetar\"],false]],paint:{\n      \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],6,3,10,4.8],\"circle-color\":\"#0a141c\",\n      \"circle-stroke-color\":[\"case\",[\"==\",[\"get\",\"scheduled\"],true],\"#58c7e8\",\"#c7d2d8\"],\n      \"circle-stroke-width\":[\"case\",[\"==\",[\"get\",\"scheduled\"],true],1.8,1.2]\n  }});\n  safeAddLayer({id:\"airport-small\",type:\"circle\",source:\"airports\",minzoom:9.25,\n    filter:[\"all\",[\"==\",[\"get\",\"major\"],false],[\"==\",[\"get\",\"hasMetar\"],false]],paint:{\n      \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],9.25,2.2,12,3.6],\"circle-color\":\"#0a141c\",\n      \"circle-stroke-color\":\"#91a4af\",\"circle-stroke-width\":1.0,\"circle-opacity\":0.92\n  }});\n  safeAddLayer({id:\"airport-hub-label\",type:\"symbol\",source:\"airports\",minzoom:4.5,maxzoom:7,\n    filter:[\"==\",[\"get\",\"hub\"],true],layout:{\"text-field\":[\"get\",\"label\"],\"text-size\":9.5,\"text-offset\":[.9,0],\"text-anchor\":\"left\",\"text-optional\":true},\n    paint:{\"text-color\":\"#e3edf2\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.5}});\n  safeAddLayer({id:\"airport-label\",type:\"symbol\",source:\"airports\",minzoom:7,\n    filter:[\"any\",[\"==\",[\"get\",\"major\"],true],[\"==\",[\"get\",\"hasMetar\"],true]],layout:{\n      \"text-field\":[\"get\",\"label\"],\"text-size\":[\"interpolate\",[\"linear\"],[\"zoom\"],7,9.2,10,11.2],\"text-offset\":[.9,0],\"text-anchor\":\"left\",\"text-optional\":true\n    },paint:{\"text-color\":\"#e0eaee\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.45}});\n  safeAddLayer({id:\"airport-small-label\",type:\"symbol\",source:\"airports\",minzoom:11,\n    filter:[\"all\",[\"==\",[\"get\",\"major\"],false],[\"==\",[\"get\",\"hasMetar\"],false]],layout:{\n      \"text-field\":[\"get\",\"label\"],\"text-size\":9.5,\"text-offset\":[.8,0],\"text-anchor\":\"left\",\"text-optional\":true\n    },paint:{\"text-color\":\"#aebfc9\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.2}});\n\n  safeAddSource(\"selected-airport\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"selected-airport-halo\",type:\"circle\",source:\"selected-airport\",paint:{\n    \"circle-radius\":10,\"circle-color\":\"rgba(0,0,0,0)\",\"circle-stroke-color\":\"#58c7e8\",\"circle-stroke-width\":2.2\n  }});\n  safeAddLayer({id:\"selected-airport-label\",type:\"symbol\",source:\"selected-airport\",layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":11,\"text-offset\":[0,1.25],\"text-anchor\":\"top\",\"text-allow-overlap\":true\n  },paint:{\"text-color\":\"#e5f8ff\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.5}});\n\n  safeAddSource(\"selected-runways\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"selected-runway-shadow\",type:\"line\",source:\"selected-runways\",paint:{\"line-color\":\"#071019\",\"line-width\":8,\"line-opacity\":0.72}});\n  safeAddLayer({id:\"selected-runways\",type:\"line\",source:\"selected-runways\",paint:{\"line-color\":\"#d5dee2\",\"line-width\":4.2,\"line-opacity\":0.95}});\n\n  safeAddSource(\"runway-ends\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"runway-end-labels\",type:\"symbol\",source:\"runway-ends\",layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":10,\"text-allow-overlap\":true\n  },paint:{\"text-color\":\"#eef4f6\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.6}});\n\n  safeAddSource(\"preferred-runway\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"preferred-runway-line\",type:\"line\",source:\"preferred-runway\",paint:{\"line-color\":\"#5de092\",\"line-width\":5.5,\"line-opacity\":0.9}});\n  safeAddLayer({id:\"preferred-runway-arrow\",type:\"symbol\",source:\"preferred-runway\",layout:{\n    \"symbol-placement\":\"line-center\",\"icon-image\":\"preferred-runway-arrow\",\"icon-size\":0.72,\n    \"icon-rotation-alignment\":\"map\",\"icon-keep-upright\":false,\"icon-allow-overlap\":true\n  }});\n\n  safeAddSource(\"airport-traffic\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"airport-ground\",type:\"circle\",source:\"airport-traffic\",filter:[\"==\",[\"get\",\"status\"],\"GROUND\"],paint:{\n    \"circle-radius\":5,\"circle-color\":\"#52d18c\",\"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.5\n  }});\n  safeAddLayer({id:\"airport-traffic-label\",type:\"symbol\",source:\"airport-traffic\",minzoom:9,layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":9.5,\"text-offset\":[1.0,0],\"text-anchor\":\"left\",\"text-optional\":true\n  },paint:{\"text-color\":\"#eef7fa\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.4}});\n\n  safeAddSource(\"goes\",{type:\"raster\",tiles:[\"https://gis.nnvl.noaa.gov/arcgis/rest/services/GOES/GOES_current/ImageServer/tile/{z}/{y}/{x}\"],tileSize:256});\n  safeAddLayer({id:\"goes\",type:\"raster\",source:\"goes\",paint:{\"raster-opacity\":0.28}},before);\n\n  safeAddSource(\"mrms\",{type:\"image\",url:transparentPixel(),coordinates:[[-90,50],[-80,50],[-80,40],[-90,40]]});\n  safeAddLayer({id:\"mrms\",type:\"raster\",source:\"mrms\",paint:{\"raster-opacity\":state.radarOpacity,\"raster-fade-duration\":0}},before);\n\n  safeAddSource(\"advisories\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"advisory-fill\",type:\"fill\",source:\"advisories\",paint:{\"fill-color\":[\"get\",\"color\"],\"fill-opacity\":0.10}});\n  safeAddLayer({id:\"advisory-line\",type:\"line\",source:\"advisories\",paint:{\"line-color\":[\"get\",\"color\"],\"line-width\":1.4,\"line-opacity\":0.85}});\n\n  safeAddSource(\"rings\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"rings\",type:\"line\",source:\"rings\",paint:{\"line-color\":\"#91a9b8\",\"line-width\":[\"case\",[\"==\",[\"get\",\"outer\"],true],1.3,0.8],\"line-opacity\":0.42}});\n\n  safeAddSource(\"route\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"route-shadow\",type:\"line\",source:\"route\",paint:{\"line-color\":\"#071019\",\"line-width\":4.5,\"line-opacity\":0.58}});\n  safeAddLayer({id:\"route-line\",type:\"line\",source:\"route\",paint:{\"line-color\":\"#65b9d8\",\"line-width\":1.8,\"line-dasharray\":[3,2],\"line-opacity\":0.82}});\n\n  safeAddSource(\"selected-trace\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"trace-shadow\",type:\"line\",source:\"selected-trace\",paint:{\"line-color\":\"#071019\",\"line-width\":5.5,\"line-opacity\":0.7}});\n  safeAddLayer({id:\"selected-trace\",type:\"line\",source:\"selected-trace\",paint:{\"line-color\":\"#61d1f0\",\"line-width\":2.4,\"line-opacity\":0.92}});\n\n  safeAddSource(\"route-airports\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"route-airport-dot\",type:\"circle\",source:\"route-airports\",paint:{\"circle-radius\":4.5,\"circle-color\":[\"get\",\"color\"],\"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.5}});\n  safeAddLayer({id:\"route-airport-label\",type:\"symbol\",source:\"route-airports\",layout:{\"text-field\":[\"get\",\"label\"],\"text-size\":10,\"text-offset\":[0,1.1],\"text-anchor\":\"top\",\"text-allow-overlap\":true},paint:{\"text-color\":\"#f3f7f9\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.5}});\n\n  safeAddSource(\"navaids\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"navaid-symbol\",type:\"symbol\",source:\"navaids\",minzoom:6.25,filter:[\"==\",[\"get\",\"major\"],true],layout:{\n    \"text-field\":[\"get\",\"symbol\"],\"text-size\":[\"interpolate\",[\"linear\"],[\"zoom\"],6.25,12,9,17],\"text-allow-overlap\":false\n  },paint:{\"text-color\":[\"get\",\"color\"],\"text-halo-color\":\"#071019\",\"text-halo-width\":1.45}});\n  safeAddLayer({id:\"navaid-label\",type:\"symbol\",source:\"navaids\",minzoom:7.5,filter:[\"==\",[\"get\",\"major\"],true],layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":[\"interpolate\",[\"linear\"],[\"zoom\"],7.5,9,10,11],\"text-offset\":[1.2,0],\"text-anchor\":\"left\",\"text-optional\":true\n  },paint:{\"text-color\":\"#d6e1e6\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.35}});\n  safeAddLayer({id:\"navaid-secondary-symbol\",type:\"symbol\",source:\"navaids\",minzoom:9.25,filter:[\"==\",[\"get\",\"major\"],false],layout:{\n    \"text-field\":[\"get\",\"symbol\"],\"text-size\":12,\"text-allow-overlap\":false\n  },paint:{\"text-color\":\"#9eb0ba\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.2}});\n  safeAddLayer({id:\"navaid-secondary-label\",type:\"symbol\",source:\"navaids\",minzoom:10.25,filter:[\"==\",[\"get\",\"major\"],false],layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":9,\"text-offset\":[1.1,0],\"text-anchor\":\"left\",\"text-optional\":true\n  },paint:{\"text-color\":\"#aebdc5\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.2}});\n\n  safeAddSource(\"tafs\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"taf-ring\",type:\"circle\",source:\"tafs\",minzoom:7.25,paint:{\n    \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],6,6.5,10,8.5],\"circle-color\":\"rgba(0,0,0,0)\",\"circle-stroke-color\":\"#6fd8ff\",\"circle-stroke-width\":1.4,\"circle-opacity\":0.92\n  }});\n\n  safeAddSource(\"metars\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"metar-circle\",type:\"circle\",source:\"metars\",minzoom:6.25,paint:{\"circle-radius\":4.5,\"circle-color\":[\"get\",\"color\"],\"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.3}});\n  safeAddLayer({id:\"metar-label\",type:\"symbol\",source:\"metars\",minzoom:8.25,layout:{\"text-field\":[\"get\",\"id\"],\"text-size\":9,\"text-offset\":[1,0],\"text-anchor\":\"left\",\"text-optional\":true},paint:{\"text-color\":\"#edf5f8\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.3}});\n\n  safeAddSource(\"pireps\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"pirep-circle\",type:\"circle\",source:\"pireps\",minzoom:6.5,paint:{\"circle-radius\":5,\"circle-color\":[\"get\",\"color\"],\"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.3}});\n  safeAddLayer({id:\"pirep-label\",type:\"symbol\",source:\"pireps\",minzoom:8.25,layout:{\"text-field\":[\"get\",\"label\"],\"text-size\":8,\"text-offset\":[1,0],\"text-anchor\":\"left\",\"text-optional\":true},paint:{\"text-color\":\"#f5f8fa\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.2}});\n\n  safeAddSource(\"vectors\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"vectors\",type:\"line\",source:\"vectors\",minzoom:6.5,paint:{\"line-color\":\"#a6cad8\",\"line-width\":1.1,\"line-opacity\":0.68}});\n\n\n  safeAddSource(\"kapn\",{type:\"geojson\",data:{type:\"FeatureCollection\",features:[{type:\"Feature\",properties:{label:\"KAPN\"},geometry:{type:\"Point\",coordinates:CENTER}}]}});\n  safeAddLayer({id:\"kapn-label\",type:\"symbol\",source:\"kapn\",layout:{\n    \"text-field\":\"KAPN \u00b7 BASE\",\"text-size\":11.5,\"text-offset\":[0.9,0],\"text-anchor\":\"left\",\n    \"text-allow-overlap\":true\n  },paint:{\"text-color\":\"#58c7e8\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.8}});\n\n  syncVisibility();syncAllSources();bindLayerEvents();\n}\nfunction transparentPixel(){return\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+X7w5WQAAAABJRU5ErkJggg==\"}\nfunction customLayerIds(){\n  return new Set([\"michigan\",\"satellite\",\"faa-vfr\",\"faa-terminal\",\"faa-ifr-low\",\"faa-ifr-high\",\"goes\",\"mrms\",\"lightning\",\"advisory-fill\",\"advisory-line\",\"rings\",\"route-shadow\",\"route-line\",\"trace-shadow\",\"selected-trace\",\"route-airport-dot\",\"route-airport-label\",\"navaid-symbol\",\"navaid-label\",\"airport-wx\",\"airport-small\",\"airport-major\",\"airport-label\",\"airport-small-label\",\"selected-airport-halo\",\"selected-airport-label\",\"airport-ground\",\"airport-traffic-label\",\"selected-runway-shadow\",\"selected-runways\",\"preferred-runway-glow\",\"preferred-runway\",\"runway-end-labels\",\"preferred-runway-arrow\",\"taf-ring\",\"metar-circle\",\"metar-label\",\"pirep-circle\",\"pirep-label\",\"vectors\",\"kapn-label\"])\n}\nfunction applyBaseProfile(){\n  var style=map.getStyle();if(!style||!style.layers)return;\n  var custom=customLayerIds(),chartOnly=[\"vfr\",\"ifr-low\",\"ifr-high\"].includes(state.base),aviation=state.base===\"aviation\";\n  style.layers.forEach(function(layer){\n    if(custom.has(layer.id))return;\n    var id=String(layer.id||\"\").toLowerCase(),sourceLayer=String(layer[\"source-layer\"]||\"\").toLowerCase();\n    var vis=\"visible\";\n    if(chartOnly){vis=layer.type===\"background\"?\"visible\":\"none\"}\n    else if(aviation){\n      var noise=/(road|street|highway|motorway|path|track|building|house|poi|transit|rail|ferry|aeroway|landuse|park|shop|amenity)/.test(id+\" \"+sourceLayer);\n      var useful=/(background|water|boundary|admin|place|city|town|state|country|coast|landcover)/.test(id+\" \"+sourceLayer);\n      vis=noise&&!useful?\"none\":\"visible\"\n    }\n    try{map.setLayoutProperty(layer.id,\"visibility\",vis)}catch(e){}\n  })\n}\nfunction syncVisibility(){\n  applyBaseProfile();\n  var mich=state.base===\"michigan\";\n  if(map.getLayer(\"michigan\"))map.setLayoutProperty(\"michigan\",\"visibility\",mich?\"visible\":\"none\");\n  if(map.getLayer(\"michigan\"))map.setPaintProperty(\"michigan\",\"raster-opacity\",state.chartOpacity);\n\n  var vfr=state.base===\"vfr\";\n  if(map.getLayer(\"faa-vfr\")){map.setLayoutProperty(\"faa-vfr\",\"visibility\",vfr?\"visible\":\"none\");map.setPaintProperty(\"faa-vfr\",\"raster-opacity\",vfr?1:0)}\n  var tac=vfr&&state.terminalCharts;\n  if(map.getLayer(\"faa-terminal\")){map.setLayoutProperty(\"faa-terminal\",\"visibility\",tac?\"visible\":\"none\");map.setPaintProperty(\"faa-terminal\",\"raster-opacity\",tac?1:0)}\n  if(map.getLayer(\"faa-ifr-low\")){map.setLayoutProperty(\"faa-ifr-low\",\"visibility\",state.base===\"ifr-low\"?\"visible\":\"none\");map.setPaintProperty(\"faa-ifr-low\",\"raster-opacity\",state.base===\"ifr-low\"?1:0)}\n  if(map.getLayer(\"faa-ifr-high\")){map.setLayoutProperty(\"faa-ifr-high\",\"visibility\",state.base===\"ifr-high\"?\"visible\":\"none\");map.setPaintProperty(\"faa-ifr-high\",\"raster-opacity\",state.base===\"ifr-high\"?1:0)}\n  if(map.getLayer(\"satellite\"))map.setLayoutProperty(\"satellite\",\"visibility\",state.base===\"satellite\"?\"visible\":\"none\");\n  if(map.getLayer(\"satellite\"))map.setPaintProperty(\"satellite\",\"raster-opacity\",state.satelliteOpacity);\n  if(map.getLayer(\"goes\"))map.setLayoutProperty(\"goes\",\"visibility\",state.satellite?\"visible\":\"none\");\n  if(map.getLayer(\"mrms\"))map.setLayoutProperty(\"mrms\",\"visibility\",state.radar?\"visible\":\"none\");\n  if(map.getLayer(\"lightning\")){map.setLayoutProperty(\"lightning\",\"visibility\",state.lightning?\"visible\":\"none\");map.setPaintProperty(\"lightning\",\"raster-opacity\",state.lightningOpacity)}\n  if(map.getLayer(\"rings\"))map.setLayoutProperty(\"rings\",\"visibility\",(state.rings&&!selectedAirport)?\"visible\":\"none\");\n  var chartOnly=[\"vfr\",\"ifr-low\",\"ifr-high\"].includes(state.base);\n  [\"airport-small\",\"airport-major\",\"airport-label\",\"airport-small-label\",\"navaid-symbol\",\"navaid-label\"].forEach(function(id){if(map.getLayer(id))map.setLayoutProperty(id,\"visibility\",chartOnly?\"none\":\"visible\")});\n  [\"airport-wx\",\"metar-circle\",\"metar-label\"].forEach(function(id){if(map.getLayer(id))map.setLayoutProperty(id,\"visibility\",state.metars?\"visible\":\"none\")});\n  if(map.getLayer(\"taf-ring\"))map.setLayoutProperty(\"taf-ring\",\"visibility\",state.tafs?\"visible\":\"none\");\n  [\"pirep-circle\",\"pirep-label\"].forEach(function(id){if(map.getLayer(id))map.setLayoutProperty(id,\"visibility\",state.pireps?\"visible\":\"none\")});\n  [\"advisory-fill\",\"advisory-line\"].forEach(function(id){if(map.getLayer(id))map.setLayoutProperty(id,\"visibility\",(state.advisories||state.cwas||state.tcf)?\"visible\":\"none\")});\n  if(map.getLayer(\"vectors\"))map.setLayoutProperty(\"vectors\",\"visibility\",state.vectors?\"visible\":\"none\");\n  if(map.getLayer(\"kapn-label\"))map.setLayoutProperty(\"kapn-label\",\"visibility\",selectedAirport?\"none\":\"visible\");\n  updateMapModeUI();\n}\nfunction circleLine(nm,outer){\n  var coords=[];for(var b=0;b<=360;b+=4)coords.push(destinationPoint(CENTER[0],CENTER[1],b,nm));\n  return{type:\"Feature\",properties:{outer:!!outer,range:nm},geometry:{type:\"LineString\",coordinates:coords}}\n}\nfunction ringData(){\n  return{type:\"FeatureCollection\",features:[.25,.5,.75,1].map(function(f){return circleLine(state.range*f,f===1)})}\n}\nfunction labelFor(a){\n  if(state.labels===\"none\")return\"\";\n  if(state.labels===\"callsign\")return aircraftName(a);\n  if(state.labels===\"altitude\")return altitude(a).replace(\" ft\",\"\");\n  var gs=Number(a.gs);return aircraftName(a)+\"\\n\"+altitude(a).replace(\" ft\",\"\")+\" \u00b7 \"+(Number.isFinite(gs)?Math.round(gs)+\"kt\":\"\u2014\")\n}\nfunction matchesTraffic(a){\n  if(state.trafficFilter===\"airline\"&&!isAirline(a))return false;\n  if(state.trafficFilter===\"ga\"&&isAirline(a))return false;\n  var h=altitudeNumber(a);\n  if(state.altFilter===\"low\"&&(h===null||h>=5000))return false;\n  if(state.altFilter===\"mid\"&&(h===null||h<5000||h>15000))return false;\n  if(state.altFilter===\"high\"&&(h===null||h<=15000))return false;\n  return true\n}\n\nfunction emitterClass(a){\n  var c=String(a.category||\"\").toUpperCase(),gs=Number(a.gs);\n  if(c===\"A7\")return{icon:\"plane-rotor\",label:\"ROTORCRAFT\",scale:.62};\n  if(c===\"A6\")return{icon:\"plane-fast\",label:\"HIGH PERFORMANCE\",scale:.62};\n  if(c===\"A5\")return{icon:\"plane-heavy\",label:\"HEAVY \u00b7 \u2265300K LB\",scale:.68};\n  if(c===\"A4\")return{icon:\"plane-heavy\",label:\"HIGH-VORTEX LARGE\",scale:.67};\n  if(c===\"A3\")return{icon:\"plane-large\",label:\"LARGE \u00b7 75\u2013300K LB\",scale:.65};\n  if(c===\"A2\"&&Number.isFinite(gs)&&gs>260)return{icon:\"plane-small\",label:\"SMALL JET / TURBOPROP \u00b7 15.5\u201375K LB\",scale:.61};\n  if(c===\"A2\")return{icon:\"plane-small\",label:\"SMALL \u00b7 15.5\u201375K LB\",scale:.60};\n  if(c===\"A1\")return{icon:\"plane-light\",label:\"LIGHT \u00b7 <15.5K LB\",scale:.57};\n  if(c===\"B1\")return{icon:\"plane-glider\",label:\"GLIDER\",scale:.60};\n  if(Number.isFinite(gs)&&gs>420)return{icon:\"plane-large\",label:\"FAST TRANSPORT\",scale:.65};\n  if(Number.isFinite(gs)&&gs>280)return{icon:\"plane-small\",label:\"JET / TURBOPROP\",scale:.60};\n  return{icon:\"plane-light\",label:\"AIRCRAFT\",scale:.43}\n}\n\nfunction aircraftFeature(a,selectedFlag){\n  var age=aircraftAge(a),cls=emitterClass(a);\n  return{type:\"Feature\",id:a.hex,properties:{\n    hex:a.hex,name:aircraftName(a),shortLabel:aircraftName(a),label:labelFor(a),track:Number(a.track)||0,selected:!!selectedFlag,sort:selectedFlag?0:Math.min(100,age),\n    icon:cls.icon,iconScale:cls.scale,aircraftClass:cls.label\n  },geometry:{type:\"Point\",coordinates:[Number(a.lon),Number(a.lat)]}}\n}\nfunction trafficData(){\n  var features=[];\n  traffic.forEach(function(a){\n    if(!matchesTraffic(a)||!Number.isFinite(Number(a.lat))||!Number.isFinite(Number(a.lon)))return;\n    if(selected&&a.hex===selected.hex)return;\n    features.push(aircraftFeature(a,false))\n  });\n  return{type:\"FeatureCollection\",features:features}\n}\nfunction selectedAircraftData(){\n  if(!selected||!Number.isFinite(Number(selected.lat))||!Number.isFinite(Number(selected.lon)))return emptyFC();\n  return{type:\"FeatureCollection\",features:[aircraftFeature(selected,true)]}\n}\nfunction vectorData(){\n  var features=[];\n  if(!state.vectors)return{type:\"FeatureCollection\",features:features};\n  traffic.forEach(function(a){\n    if(!matchesTraffic(a)||!Number.isFinite(Number(a.lat))||!Number.isFinite(Number(a.lon)))return;\n    var gs=Number(a.gs),tr=Number(a.track);if(!Number.isFinite(gs)||!Number.isFinite(tr)||gs<20)return;\n    var end=destinationPoint(Number(a.lon),Number(a.lat),tr,gs/60);\n    features.push({type:\"Feature\",properties:{hex:a.hex},geometry:{type:\"LineString\",coordinates:[[Number(a.lon),Number(a.lat)],end]}})\n  });\n  return{type:\"FeatureCollection\",features:features}\n}\n\nvar trafficCanvas=$(\"trafficCanvas\"),trafficCtx=trafficCanvas.getContext(\"2d\",{alpha:true}),canvasHitGrid=new Map(),canvasHitCell=44,cursorCheckFrame=0,pendingCursorPoint=null;\nvar AIRCRAFT_PATHS={\n  \"plane-light\":new Path2D(\"M32 6 L36 24 L53 31 L53 35 L36 33 L35 48 L42 54 L42 57 L32 53 L22 57 L22 54 L29 48 L28 33 L11 35 L11 31 L28 24 Z\"),\n  \"plane-small\":new Path2D(\"M32 5 L36 23 L55 31 L55 35 L36 33 L35 47 L44 53 L44 57 L32 52 L20 57 L20 53 L29 47 L28 33 L9 35 L9 31 L28 23 Z\"),\n  \"plane-large\":new Path2D(\"M32 4 C35 10 37 18 38 25 L57 32 L57 37 L38 34 L37 47 L47 53 L47 57 L32 52 L17 57 L17 53 L27 47 L26 34 L7 37 L7 32 L26 25 C27 18 29 10 32 4 Z\"),\n  \"plane-heavy\":new Path2D(\"M32 3 C36 10 39 19 40 26 L59 32 L59 38 L40 35 L39 47 L50 53 L50 58 L32 52 L14 58 L14 53 L25 47 L24 35 L5 38 L5 32 L24 26 C25 19 28 10 32 3 Z\"),\n  \"plane-fast\":new Path2D(\"M32 4 L38 23 L53 44 L39 39 L37 52 L44 57 L44 60 L32 55 L20 60 L20 57 L27 52 L25 39 L11 44 L26 23 Z\"),\n  \"plane-rotor\":new Path2D(\"M28 14 L36 14 L38 39 L35 52 L29 52 L26 39 Z M10 23 L54 23 M32 7 L32 39 M37 45 L52 51\"),\n  \"plane-glider\":new Path2D(\"M32 6 L34 26 L59 31 L59 35 L34 33 L33 51 L39 56 L39 59 L32 56 L25 59 L25 56 L31 51 L30 33 L5 35 L5 31 L30 26 Z\")\n};\n\nfunction resizeTrafficCanvas(){\n  var rect=map.getContainer().getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2.25);\n  var w=Math.max(1,Math.round(rect.width*dpr)),h=Math.max(1,Math.round(rect.height*dpr));\n  if(trafficCanvas.width!==w||trafficCanvas.height!==h){trafficCanvas.width=w;trafficCanvas.height=h;trafficCanvas.style.width=rect.width+\"px\";trafficCanvas.style.height=rect.height+\"px\"}\n  trafficCtx.setTransform(dpr,0,0,dpr,0,0);return{w:rect.width,h:rect.height,dpr:dpr}\n}\nfunction mercatorNormalized(lon,lat){\n  var x=(Number(lon)+180)/360,rad=clamp(Number(lat),-85.051129,85.051129)*Math.PI/180;\n  var y=(1-Math.log(Math.tan(rad)+1/Math.cos(rad))/Math.PI)/2;return{x:x,y:y}\n}\nfunction prepareTrafficProjection(list){(list||[]).forEach(function(a){var p=mercatorNormalized(a.lon,a.lat);a.__mx=p.x;a.__my=p.y;a.__displayName=aircraftName(a);a.__altLabel=altitude(a).replace(\" ft\",\"\")})}\nfunction scheduleTrafficCanvasRender(){if(map&&map.loaded())map.triggerRepaint()}\nfunction canvasIconSize(z,cls){var base=z<4?5:z<5.5?6.5:z<7?8:z<9?10.5:13;return base*clamp((cls.scale||.5)/.5,.85,1.28)}\nfunction drawWideAircraft(ctx,x,y,track,size,selectedFlag){ctx.save();ctx.translate(x,y);ctx.rotate((Number(track)||0)*Math.PI/180);ctx.beginPath();ctx.moveTo(0,-size);ctx.lineTo(size*.58,size*.72);ctx.lineTo(0,size*.38);ctx.lineTo(-size*.58,size*.72);ctx.closePath();ctx.fillStyle=selectedFlag?\"#ffc857\":\"rgba(244,248,250,.94)\";ctx.strokeStyle=\"#061019\";ctx.lineWidth=1.2;ctx.fill();ctx.stroke();ctx.restore()}\nfunction drawAircraftPath(ctx,x,y,track,size,icon,selectedFlag){var p=AIRCRAFT_PATHS[icon]||AIRCRAFT_PATHS[\"plane-light\"];ctx.save();ctx.translate(x,y);ctx.rotate((Number(track)||0)*Math.PI/180);ctx.scale(size/64,size/64);ctx.translate(-32,-32);ctx.fillStyle=selectedFlag?\"#ffc857\":\"#f7fbfd\";ctx.strokeStyle=\"#061019\";ctx.lineWidth=Math.max(1.6,64/size*1.05);ctx.lineJoin=\"round\";ctx.lineCap=\"round\";ctx.fill(p);ctx.stroke(p);ctx.restore()}\nfunction hitGridAdd(target){\n  var cx=Math.floor(target.x/canvasHitCell),cy=Math.floor(target.y/canvasHitCell),key=cx+\":\"+cy,arr=canvasHitGrid.get(key);\n  if(!arr){arr=[];canvasHitGrid.set(key,arr)}arr.push(target)\n}\nfunction renderTrafficCanvas(){\n  if(!map||!map.loaded())return;\n  var size=resizeTrafficCanvas(),ctx=trafficCtx,z=map.getZoom(),mobile=isMobile(),center=map.getCenter(),centerMerc=mercatorNormalized(center.lng,center.lat),centerScreen=map.project(center),worldSize=512*Math.pow(2,z);\n  ctx.clearRect(0,0,size.w,size.h);canvasTargets=[];canvasHitGrid.clear();\n  var candidates=[],selectedItem=null;\n  traffic.forEach(function(a){\n    if(!matchesTraffic(a)||!Number.isFinite(a.__mx)||!Number.isFinite(a.__my))return;\n    var dx=a.__mx-centerMerc.x;if(dx>0.5)dx-=1;if(dx<-0.5)dx+=1;\n    var x=centerScreen.x+dx*worldSize,y=centerScreen.y+(a.__my-centerMerc.y)*worldSize;\n    if(x<-28||y<-28||x>size.w+28||y>size.h+28)return;\n    var item={a:a,x:x,y:y,selected:!!(selected&&selected.hex===a.hex)};\n    if(item.selected)selectedItem=item;else candidates.push(item)\n  });\n  var maxDraw=mobile?4200:7600;if(candidates.length>maxDraw)candidates=candidates.slice(candidates.length-maxDraw);\n  if(selectedItem)candidates.push(selectedItem);\n  var labelCells=new Set(),showCallsign=z>=6.4,showFull=z>=8.1;\n  ctx.font=(mobile?\"10px\":\"10.5px\")+\" -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\";ctx.textBaseline=\"middle\";\n  candidates.forEach(function(item){\n    var a=item.a,cls=emitterClass(a),iconSize=canvasIconSize(z,cls),selectedFlag=item.selected;\n    if(z<5.2)drawWideAircraft(ctx,item.x,item.y,a.track,iconSize,selectedFlag);else drawAircraftPath(ctx,item.x,item.y,a.track,iconSize,cls.icon,selectedFlag);\n    if(selectedFlag){ctx.beginPath();ctx.arc(item.x,item.y,iconSize*.9,0,Math.PI*2);ctx.strokeStyle=\"#ffc857\";ctx.lineWidth=2;ctx.stroke()}\n    var target={x:item.x,y:item.y,r:Math.max(10,iconSize),a:a};canvasTargets.push(target);hitGridAdd(target);\n    if((showCallsign||selectedFlag)&&state.labels!==\"none\"){\n      var key=Math.floor((item.x+18)/96)+\":\"+Math.floor(item.y/21);\n      if(selectedFlag||!labelCells.has(key)){\n        labelCells.add(key);var line1=a.__displayName||aircraftName(a),line2=showFull&&state.labels===\"full\"?(a.__altLabel||altitude(a).replace(\" ft\",\"\"))+\" \u00b7 \"+(Number.isFinite(Number(a.gs))?Math.round(Number(a.gs))+\"kt\":\"\u2014\"):\"\";\n        ctx.lineWidth=3.5;ctx.strokeStyle=\"#061019\";ctx.fillStyle=selectedFlag?\"#fff3c6\":\"#f4f8fa\";ctx.strokeText(line1,item.x+iconSize*.72+4,item.y-4);ctx.fillText(line1,item.x+iconSize*.72+4,item.y-4);\n        if(line2){ctx.font=(mobile?\"8.5px\":\"9px\")+\" -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\";ctx.fillStyle=\"#a8c0cc\";ctx.strokeText(line2,item.x+iconSize*.72+4,item.y+7);ctx.fillText(line2,item.x+iconSize*.72+4,item.y+7);ctx.font=(mobile?\"10px\":\"10.5px\")+\" -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\"}\n      }\n    }\n  })\n}\nfunction canvasAircraftAt(point){\n  var cx=Math.floor(point.x/canvasHitCell),cy=Math.floor(point.y/canvasHitCell),best=null,bestD=Infinity;\n  for(var x=cx-1;x<=cx+1;x++)for(var y=cy-1;y<=cy+1;y++){\n    var arr=canvasHitGrid.get(x+\":\"+y)||[];arr.forEach(function(t){var dx=t.x-point.x,dy=t.y-point.y,d=Math.sqrt(dx*dx+dy*dy);if(d<=t.r+6&&d<bestD){best=t.a;bestD=d}})\n  }\n  return best\n}\nfunction mapSelectableAt(point){\n  var ids=[\"metar-circle\",\"pirep-circle\",\"navaid-symbol\",\"navaid-secondary-symbol\",\"advisory-fill\",\"airport-wx-hub\",\"airport-hub\",\"airport-wx\",\"airport-major\",\"airport-small\",\"airport-hub-label\",\"airport-label\",\"airport-small-label\",\"kapn-label\",\"route-airport-dot\"];\n  var existing=ids.filter(function(id){return map.getLayer(id)});return existing.length?map.queryRenderedFeatures(point,{layers:existing}).length>0:false\n}\nfunction selectCanvasAircraftAt(point){if(mapSelectableAt(point))return false;var a=canvasAircraftAt(point);if(a){selectAircraft(a);return true}return false}\nfunction updateMapCursor(point){\n  pendingCursorPoint=point;if(cursorCheckFrame)return;\n  cursorCheckFrame=requestAnimationFrame(function(){\n    cursorCheckFrame=0;if(!pendingCursorPoint||map.isMoving())return;\n    map.getCanvas().style.cursor=(canvasAircraftAt(pendingCursorPoint)||mapSelectableAt(pendingCursorPoint))?\"pointer\":\"\"\n  })\n}\n\nfunction navaidData(){\n  return{type:\"FeatureCollection\",features:navaids.filter(function(n){return Number.isFinite(Number(n.lat))&&Number.isFinite(Number(n.lon))}).map(function(n){\n    var type=String(n.type||\"\").toUpperCase(),major=/(VOR|VORTAC|VOR-DME|TACAN)/.test(type);\n    var symbol=type.includes(\"NDB\")?\"\u25b3\":type.includes(\"TACAN\")||type.includes(\"VORTAC\")?\"\u2726\":type.includes(\"VOR\")?\"\u25c7\":\"\u25a1\";\n    var freq=Number.isFinite(Number(n.frequencyKhz))?(Number(n.frequencyKhz)>=1000?(Number(n.frequencyKhz)/1000).toFixed(2):String(Math.round(Number(n.frequencyKhz)))):\"\";\n    return{type:\"Feature\",properties:{ident:n.ident||\"\",label:(n.ident||\"\")+(freq?\"  \"+freq:\"\"),name:n.name||\"\",navaidType:type,major:major,symbol:symbol,color:major?\"#e3edf1\":\"#a9bac4\",raw:JSON.stringify(n)},geometry:{type:\"Point\",coordinates:[Number(n.lon),Number(n.lat)]}}\n  })}\n}\nfunction tafData(){\n  var airportByCode=new Map();airports.forEach(function(a){[a.icao,a.gps,a.ident,a.local].filter(Boolean).forEach(function(v){airportByCode.set(String(v).toUpperCase(),a)})});\n  return{type:\"FeatureCollection\",features:(weather.tafs||[]).map(function(t){\n    var lat=Number(t.lat),lon=Number(t.lon),ap=airportByCode.get(String(t.icaoId||\"\").toUpperCase());\n    if((!Number.isFinite(lat)||!Number.isFinite(lon))&&ap){lat=Number(ap.lat);lon=Number(ap.lon)}\n    if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;\n    return{type:\"Feature\",properties:{id:t.icaoId||\"\",raw:JSON.stringify(t)},geometry:{type:\"Point\",coordinates:[lon,lat]}}\n  }).filter(Boolean)}\n}\nfunction metarData(){\n  var airportCodes=new Set();\n  airports.forEach(function(a){\n    [a.icao,a.gps,a.ident,a.local].filter(Boolean).forEach(function(v){airportCodes.add(String(v).toUpperCase())})\n  });\n  return{\n    type:\"FeatureCollection\",\n    features:(weather.metars||[]).filter(function(m){\n      return Number.isFinite(Number(m.lat))&&Number.isFinite(Number(m.lon))&&!airportCodes.has(String(m.icaoId||\"\").toUpperCase())\n    }).map(function(m){\n      return{\n        type:\"Feature\",\n        properties:{id:m.icaoId||\"\",color:flightCategoryColor(m.fltCat),raw:JSON.stringify(m)},\n        geometry:{type:\"Point\",coordinates:[Number(m.lon),Number(m.lat)]}\n      }\n    })\n  }\n}\nfunction pirepSeverity(p){\n  var t=[p.tbInt1,p.tbInt2,p.icgInt1,p.icgInt2,p.rawOb,p.rawText].filter(Boolean).join(\" \").toUpperCase();\n  if(t.includes(\"SEV\")||t.includes(\"EXTM\"))return{color:\"#ef6973\",label:\"SEV\"};\n  if(t.includes(\"MOD\"))return{color:\"#ef9c4c\",label:\"MOD\"};\n  if(t.includes(\"LGT\")||t.includes(\"TRC\"))return{color:\"#f0c35a\",label:\"LGT\"};\n  return{color:\"#58c7e8\",label:\"PIREP\"}\n}\nfunction pirepData(){\n  return{type:\"FeatureCollection\",features:(weather.pireps||[]).filter(function(p){return Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))}).map(function(p){\n    var sev=pirepSeverity(p);return{type:\"Feature\",properties:{color:sev.color,label:sev.label,raw:JSON.stringify(p)},geometry:{type:\"Point\",coordinates:[Number(p.lon),Number(p.lat)]}}\n  })}\n}\nfunction advisoryData(){\n  var out=[];\n  function push(fc,kind,enabled){\n    if(!enabled)return;\n    (fc&&Array.isArray(fc.features)?fc.features:[]).forEach(function(f){\n      var p=Object.assign({},f.properties||{}),h=String(p.hazard||p.hazardType||p.type||kind).toUpperCase();\n      p.kind=kind;\n      p.color=kind===\"TCF\"?\"#ff4f8a\":kind===\"CWA\"?\"#f0a84c\":kind===\"SIGMET\"||h.includes(\"CONV\")||h.includes(\"TS\")?\"#ef6973\":h.includes(\"ICE\")?\"#58c7e8\":h.includes(\"TURB\")?\"#ef9c4c\":h.includes(\"IFR\")?\"#b66cff\":\"#c7aa54\";\n      out.push({type:\"Feature\",properties:p,geometry:f.geometry})\n    })\n  }\n  push(weather.gairmets,\"G-AIRMET\",state.advisories);push(weather.sigmets,\"SIGMET\",state.advisories);push(weather.cwas,\"CWA\",state.cwas);push(weather.tcf,\"TCF\",state.tcf);\n  return{type:\"FeatureCollection\",features:out}\n}\n\nfunction runwayHeadingFromIdent(ident){\n  var m=String(ident||\"\").match(/^(\\d{1,2})/);if(!m)return null;\n  var n=Number(m[1]);if(!Number.isFinite(n))return null;return n===36?360:n*10\n}\nfunction runwayCoordinates(r,ap){\n  var le=(Number.isFinite(Number(r.leLon))&&Number.isFinite(Number(r.leLat)))?[Number(r.leLon),Number(r.leLat)]:null;\n  var he=(Number.isFinite(Number(r.heLon))&&Number.isFinite(Number(r.heLat)))?[Number(r.heLon),Number(r.heLat)]:null;\n  if(le&&he)return{le:le,he:he};\n  var lengthNm=(Number(r.lengthFt)||3000)/6076.12,half=lengthNm/2;\n  var lh=Number(r.leHeading)||runwayHeadingFromIdent(r.leIdent)||0;\n  return{le:destinationPoint(Number(ap.lon),Number(ap.lat),(lh+180)%360,half),he:destinationPoint(Number(ap.lon),Number(ap.lat),lh,half)}\n}\nfunction runwayComponent(windDir,windSpeed,heading){\n  if(!Number.isFinite(windDir)||!Number.isFinite(windSpeed)||!Number.isFinite(heading))return null;\n  var diff=(windDir-heading)*Math.PI/180;\n  return{headwind:windSpeed*Math.cos(diff),crosswind:Math.abs(windSpeed*Math.sin(diff))}\n}\nfunction preferredRunwayInfo(ap,metar,runways){\n  if(!ap||!metar||!Array.isArray(runways)||!runways.length)return{available:false,reason:\"NO CURRENT WIND / RUNWAY DATA\"};\n  var windDir=Number(metar.wdir),windSpeed=Number(metar.wspd),gust=Number(metar.wgst);\n  if(!Number.isFinite(windDir)||!Number.isFinite(windSpeed))return{available:false,reason:\"VARIABLE OR UNAVAILABLE WIND\",windSpeed:windSpeed};\n  if(windSpeed<5)return{available:false,reason:\"CALM WIND \u2014 NO WIND-BASED PREFERENCE\",windDir:windDir,windSpeed:windSpeed,gust:Number.isFinite(gust)?gust:null};\n  var best=null;\n  runways.filter(function(r){return!r.closed}).forEach(function(r){\n    [[\"le\",r.leIdent,Number(r.leHeading)||runwayHeadingFromIdent(r.leIdent)],[\"he\",r.heIdent,Number(r.heHeading)||runwayHeadingFromIdent(r.heIdent)]].forEach(function(end){\n      var comp=runwayComponent(windDir,windSpeed,end[2]);if(!comp)return;\n      var candidate={available:true,runway:r,end:end[0],ident:end[1],heading:end[2],headwind:comp.headwind,crosswind:comp.crosswind,windDir:windDir,windSpeed:windSpeed,gust:Number.isFinite(gust)?gust:null};\n      if(!best||candidate.headwind>best.headwind||(Math.abs(candidate.headwind-best.headwind)<.1&&candidate.crosswind<best.crosswind))best=candidate\n    })\n  });\n  return best||{available:false,reason:\"NO OPEN RUNWAY DATA\",windDir:windDir,windSpeed:windSpeed}\n}\nfunction componentText(value){\n  if(!Number.isFinite(value))return\"\u2014\";return value>=0?\"HW \"+Math.round(value)+\" kt\":\"TW \"+Math.round(Math.abs(value))+\" kt\"\n}\nfunction runwayEndComponent(r,end,metar){\n  var h=end===\"le\"?(Number(r.leHeading)||runwayHeadingFromIdent(r.leIdent)):(Number(r.heHeading)||runwayHeadingFromIdent(r.heIdent));\n  return runwayComponent(Number(metar&&metar.wdir),Number(metar&&metar.wspd),h)\n}\nfunction selectedRunwayData(){\n  if(!selectedAirport||!airportDetail||!Array.isArray(airportDetail.runways))return emptyFC();\n  return{type:\"FeatureCollection\",features:airportDetail.runways.filter(function(r){return!r.closed}).map(function(r){var c=runwayCoordinates(r,selectedAirport);return{type:\"Feature\",properties:{label:[r.leIdent,r.heIdent].filter(Boolean).join(\" / \")},geometry:{type:\"LineString\",coordinates:[c.le,c.he]}}})}\n}\nfunction runwayEndData(){\n  if(!selectedAirport||!airportDetail||!Array.isArray(airportDetail.runways))return emptyFC();\n  var f=[];airportDetail.runways.filter(function(r){return!r.closed}).forEach(function(r){var c=runwayCoordinates(r,selectedAirport);if(r.leIdent)f.push({type:\"Feature\",properties:{label:r.leIdent},geometry:{type:\"Point\",coordinates:c.le}});if(r.heIdent)f.push({type:\"Feature\",properties:{label:r.heIdent},geometry:{type:\"Point\",coordinates:c.he}})});return{type:\"FeatureCollection\",features:f}\n}\nfunction preferredRunwayData(){\n  if(!selectedAirport||!airportDetail)return emptyFC();var p=preferredRunwayInfo(selectedAirport,airportMetar(selectedAirport),airportDetail.runways||[]);if(!p.available)return emptyFC();var c=runwayCoordinates(p.runway,selectedAirport),coords=p.end===\"le\"?[c.le,c.he]:[c.he,c.le];return{type:\"FeatureCollection\",features:[{type:\"Feature\",properties:{label:p.ident},geometry:{type:\"LineString\",coordinates:coords}}]}\n}\n\nfunction airportMetarMatch(a){\n  var candidates=[a.icao,a.gps,a.ident,a.local].filter(Boolean).map(function(v){return String(v).toUpperCase()});\n  return(weather.metars||[]).find(function(m){\n    var id=String(m.icaoId||\"\").toUpperCase();\n    return candidates.indexOf(id)>=0\n  })||null\n}\nfunction metarAutomation(m){\n  var raw=String(m&&m.rawOb||\"\").toUpperCase();\n  if(/\\bAO2A?\\b/.test(raw))return\"AO2\";\n  if(/\\bAO1A?\\b/.test(raw))return\"AO1\";\n  return\"\"\n}\nfunction airportData(){\n  return{\n    type:\"FeatureCollection\",\n    features:airports.map(function(a){\n      var hub=!!(a.scheduled||a.type===\"large_airport\"),regional=a.type===\"medium_airport\",major=hub||regional;\n      var m=airportMetarMatch(a);\n      return{\n        type:\"Feature\",\n        properties:{\n          id:a.id||\"\",ident:a.ident,label:a.icao||a.gps||a.ident||a.iata,\n          name:a.name,municipality:a.municipality||\"\",type:a.type,\n          elevationFt:a.elevationFt||0,scheduled:!!a.scheduled,hub:hub,regional:regional,major:major,\n          iata:a.iata||\"\",icao:a.icao||\"\",gps:a.gps||\"\",local:a.local||\"\",\n          hasMetar:!!m,wxColor:m?flightCategoryColor(m.fltCat):\"#8da0ae\",\n          wxCat:m&&m.fltCat||\"\",wxAutomation:m?metarAutomation(m):\"\",\n          wxWind:m&&Number.isFinite(Number(m.wspd))?((m.wdir||\"VRB\")+\"\u00b0 / \"+m.wspd+\" kt\"):\"\",\n          wxRaw:m&&m.rawOb||\"\"\n        },\n        geometry:{type:\"Point\",coordinates:[Number(a.lon),Number(a.lat)]}\n      }\n    })\n  }\n}\nfunction selectedAirportData(){\n  if(!selectedAirport)return emptyFC();\n  return{type:\"FeatureCollection\",features:[{\n    type:\"Feature\",properties:{label:airportCode(selectedAirport)},\n    geometry:{type:\"Point\",coordinates:[selectedAirport.lon,selectedAirport.lat]}\n  }]}\n}\nfunction angleDiff(a,b){\n  var d=Math.abs(((a-b+540)%360)-180);return d\n}\nfunction bearingBetween(lat1,lon1,lat2,lon2){\n  var r=function(x){return x*Math.PI/180},D=function(x){return x*180/Math.PI};\n  var p1=r(lat1),p2=r(lat2),dl=r(lon2-lon1);\n  var y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);\n  return(D(Math.atan2(y,x))+360)%360\n}\nfunction movementFor(a,ap){\n  var lat=Number(a.lat),lon=Number(a.lon),d=distanceNm(ap.lat,ap.lon,lat,lon);\n  var gs=Number(a.gs),vr=Number(a.baro_rate),track=Number(a.track);\n  var ground=a.alt_baro===\"ground\"||(d<2.5&&Number.isFinite(gs)&&gs<45);\n  if(ground)return{status:\"GROUND\",distance:d};\n\n  if(Number.isFinite(track)){\n    var toward=bearingBetween(lat,lon,ap.lat,ap.lon),away=bearingBetween(ap.lat,ap.lon,lat,lon);\n    if(d<=35&&angleDiff(track,toward)<=50&&(vr<-100||d<12))return{status:\"ARRIVING\",distance:d};\n    if(d<=25&&angleDiff(track,away)<=55&&(vr>100||d<8))return{status:\"DEPARTING\",distance:d};\n  }\n  return{status:\"NEARBY\",distance:d}\n}\nfunction airportTrafficData(){\n  if(!selectedAirport)return emptyFC();\n  return{\n    type:\"FeatureCollection\",\n    features:airportTraffic.filter(function(a){return Number.isFinite(Number(a.lat))&&Number.isFinite(Number(a.lon))}).map(function(a){\n      var mv=movementFor(a,selectedAirport);\n      return{\n        type:\"Feature\",\n        properties:{hex:a.hex||\"\",label:aircraftName(a),status:mv.status},\n        geometry:{type:\"Point\",coordinates:[Number(a.lon),Number(a.lat)]}\n      }\n    })\n  }\n}\n\nfunction syncAllSources(){\n  if(map.getSource(\"rings\"))map.getSource(\"rings\").setData(ringData());\n  scheduleTrafficCanvasRender();\n  scheduleTrafficCanvasRender();\n  if(map.getSource(\"vectors\"))map.getSource(\"vectors\").setData(vectorData());\n  if(map.getSource(\"metars\"))map.getSource(\"metars\").setData(metarData());\n  if(map.getSource(\"pireps\"))map.getSource(\"pireps\").setData(pirepData());\n  if(map.getSource(\"advisories\"))map.getSource(\"advisories\").setData(advisoryData());\n  if(map.getSource(\"navaids\"))map.getSource(\"navaids\").setData(navaidData());\n  if(map.getSource(\"tafs\"))map.getSource(\"tafs\").setData(tafData());\n  if(map.getSource(\"airports\"))map.getSource(\"airports\").setData(airportData());\n  if(map.getSource(\"selected-airport\"))map.getSource(\"selected-airport\").setData(selectedAirportData());\n  if(map.getSource(\"airport-traffic\"))map.getSource(\"airport-traffic\").setData(airportTrafficData());\n  if(map.getSource(\"selected-runways\"))map.getSource(\"selected-runways\").setData(selectedRunwayData());\n  if(map.getSource(\"runway-ends\"))map.getSource(\"runway-ends\").setData(runwayEndData());\n  if(map.getSource(\"preferred-runway\"))map.getSource(\"preferred-runway\").setData(preferredRunwayData());\n  syncSelectedSources()\n}\nfunction syncSelectedSources(){\n  if(map.getSource(\"selected-trace\")){\n    var coords=selectedTrace&&Array.isArray(selectedTrace.points)?selectedTrace.points.map(function(p){return[p.lon,p.lat]}):[];\n    map.getSource(\"selected-trace\").setData({type:\"FeatureCollection\",features:coords.length>1?[{type:\"Feature\",properties:{},geometry:{type:\"LineString\",coordinates:coords}}]:[]})\n  }\n  var routeFeatures=[],airportFeatures=[];\n  if(selectedRoute&&selectedRoute.route&&selected&&Number.isFinite(Number(selected.lon))&&Number.isFinite(Number(selected.lat))){\n    var dest=selectedRoute.route.destination,orig=selectedRoute.route.origin;\n    if(dest&&Number.isFinite(dest.lon)&&Number.isFinite(dest.lat)){\n      routeFeatures.push({type:\"Feature\",properties:{},geometry:{type:\"LineString\",coordinates:greatCircle([Number(selected.lon),Number(selected.lat)],[dest.lon,dest.lat],72)}});\n      airportFeatures.push({type:\"Feature\",properties:{label:dest.iata||dest.icao||\"DEST\",color:\"#58c7e8\"},geometry:{type:\"Point\",coordinates:[dest.lon,dest.lat]}})\n    }\n    if(orig&&Number.isFinite(orig.lon)&&Number.isFinite(orig.lat))airportFeatures.push({type:\"Feature\",properties:{label:orig.iata||orig.icao||\"ORIG\",color:\"#8da0ae\"},geometry:{type:\"Point\",coordinates:[orig.lon,orig.lat]}})\n  }\n  if(map.getSource(\"route\"))map.getSource(\"route\").setData({type:\"FeatureCollection\",features:routeFeatures});\n  if(map.getSource(\"route-airports\"))map.getSource(\"route-airports\").setData({type:\"FeatureCollection\",features:airportFeatures})\n}\nvar CHART_META={\n  vfr:{title:\"VFR SECTIONAL\",edition:\"FAA AIS \u00b7 Current 56-day chart\",min:8,max:12},\n  \"ifr-low\":{title:\"IFR LOW ENROUTE\",edition:\"FAA AIS \u00b7 Current 56-day chart\",min:7,max:12},\n  \"ifr-high\":{title:\"IFR HIGH ENROUTE\",edition:\"FAA AIS \u00b7 Current 56-day chart\",min:3,max:12}\n};\nfunction applyMapZoomConstraints(animate){\n  var meta=CHART_META[state.base];\n  if(!meta){map.setMinZoom(2);map.setMaxZoom(18);return}\n  var minDisplay=Math.max(2,meta.min-.2),maxDisplay=meta.max+.25;\n  map.setMinZoom(minDisplay);map.setMaxZoom(maxDisplay);\n  var z=map.getZoom(),target=clamp(z,minDisplay,maxDisplay);\n  if(Math.abs(target-z)>.01)map.easeTo({zoom:target,duration:animate===false?0:260})\n}\nfunction zoomContext(){\n  var z=map.getZoom();\n  if(z<5.25)return\"CONTINENTAL\";\n  if(z<7.25)return\"REGIONAL\";\n  if(z<9.25)return\"LOCAL\";\n  return\"TERMINAL\"\n}\nfunction updateDetailContext(){\n  var label=zoomContext();\n  $(\"barContext\").textContent=label;\n  $(\"detailModeBadge\").textContent=\"AUTO DETAIL \u00b7 \"+label;\n}\nfunction updateMapModeUI(){\n  document.querySelectorAll(\"[data-map-mode]\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.mapMode===state.base)});\n  var badge=$(\"chartBadge\"),meta=CHART_META[state.base],legend=$(\"aviationLegend\");\n  badge.classList.toggle(\"open\",!!meta);legend.classList.toggle(\"open\",state.base===\"aviation\");\n  if(meta){\n    var z=map.getZoom(),over=z>meta.max+.05,under=z<meta.min-.05;\n    badge.classList.toggle(\"overzoom\",over||under);\n    $(\"chartBadgeTitle\").textContent=meta.title+(over?\" \u00b7 OVERZOOM\":under?\" \u00b7 OVERVIEW\":\"\");\n    $(\"chartBadgeMeta\").textContent=meta.edition+\" \u00b7 NATIVE Z\"+meta.min+\"\u2013\"+meta.max+((over||under)?\" \u00b7 CURRENT Z\"+z.toFixed(1):\"\")\n  }\n}\nfunction snapChartNativeZoom(){\n  var meta=CHART_META[state.base];if(!meta)return;\n  var target=clamp(map.getZoom(),meta.min,meta.max);map.easeTo({zoom:target,duration:320})\n}\nfunction setBase(base){\n  state.base=base;saveState();\n  document.querySelectorAll(\"[data-map-mode]\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.mapMode===base)});\n  map.setStyle(styleForBase(base),{diff:false});\n  setTimeout(function(){applyMapZoomConstraints(true)},0)\n}\nfunction afterStyleLoad(){\n  if(map.getStyle())map.getStyle().metadata=Object.assign({},map.getStyle().metadata||{},{_altStyle:styleForBase(state.base)});\n  installLayers();syncVisibility();syncAllSources();applyMapZoomConstraints(true);if(state.radar)updateRadarImage();if(state.lightning)updateLightningImage();renderPanel();updateMapModeUI()\n}\nfunction setSourceData(id,data){var s=map.getSource(id);if(s&&s.setData)s.setData(data)}\nfunction bindLayerEvents(){\n  if(bindLayerEvents.done)return;bindLayerEvents.done=true;\n  map.on(\"click\",\"metar-circle\",function(e){if(!e.features||!e.features[0])return;try{showMetar(JSON.parse(e.features[0].properties.raw))}catch(err){}});\n  map.on(\"click\",\"pirep-circle\",function(e){if(!e.features||!e.features[0])return;try{showPirep(JSON.parse(e.features[0].properties.raw))}catch(err){}});\n  [\"navaid-symbol\",\"navaid-secondary-symbol\"].forEach(function(navaidLayer){map.on(\"click\",navaidLayer,function(e){if(!e.features||!e.features[0])return;try{var n=JSON.parse(e.features[0].properties.raw),freq=Number.isFinite(Number(n.frequencyKhz))?(Number(n.frequencyKhz)>=1000?(Number(n.frequencyKhz)/1000).toFixed(2)+\" MHz\":Math.round(Number(n.frequencyKhz))+\" kHz\"):\"Frequency unavailable\";new maplibregl.Popup({closeButton:false,offset:10}).setLngLat(e.features[0].geometry.coordinates).setHTML(\"<div class='navaid-popup'><strong>\"+escapeHtml(n.ident||\"NAVAID\")+\" \u00b7 \"+escapeHtml(n.type||\"\")+\"</strong><br><span>\"+escapeHtml(n.name||\"\")+\" \u00b7 \"+escapeHtml(freq)+\"</span></div>\").addTo(map)}catch(err){}})});\n  [\"navaid-symbol\",\"navaid-secondary-symbol\"].forEach(function(id){map.on(\"mouseenter\",id,function(){map.getCanvas().style.cursor=\"pointer\"});map.on(\"mouseleave\",id,function(){map.getCanvas().style.cursor=\"\"})});\n  map.on(\"click\",\"advisory-fill\",function(e){if(e.features&&e.features[0])showAdvisory(e.features[0].properties)});\n  map.on(\"click\",\"kapn-label\",function(){\n    var ap=airports.find(function(a){\n      return [a.icao,a.gps,a.ident].filter(Boolean).some(function(v){return String(v).toUpperCase()===\"KAPN\"})\n    });\n    if(ap)selectAirport(ap)\n  });\n  map.on(\"click\",function(e){selectCanvasAircraftAt(e.point)});\n  var airportHover=null;\n  [\"airport-wx-hub\",\"airport-hub\",\"airport-wx\",\"airport-major\",\"airport-small\",\"airport-hub-label\",\"airport-label\",\"airport-small-label\"].forEach(function(layerId){\n    map.on(\"click\",layerId,function(e){\n      if(!e.features||!e.features[0])return;\n      var ident=e.features[0].properties.ident;\n      var ap=airports.find(function(a){return a.ident===ident});\n      if(ap)selectAirport(ap);\n    });\n    map.on(\"mouseenter\",layerId,function(e){\n      map.getCanvas().style.cursor=\"pointer\";\n      if(!e.features||!e.features[0])return;\n      var p=e.features[0].properties||{},coords=e.features[0].geometry&&e.features[0].geometry.coordinates;\n      if(!coords)return;\n      if(airportHover)airportHover.remove();\n      var wx=p.hasMetar===true||String(p.hasMetar)===\"true\";\n      var html=\"<div style='min-width:150px'><strong style='font-size:12px'>\"+escapeHtml(p.label||p.ident||\"AIRPORT\")+\"</strong>\"+\n        \"<div style='margin-top:2px;color:#9dafba;font-size:10px'>\"+escapeHtml(p.name||\"\")+\"</div>\"+\n        (wx?\"<div style='margin-top:6px;font-size:10px'><span style='display:inline-block;width:8px;height:8px;border-radius:50%;background:\"+escapeHtml(p.wxColor||\"#8da0ae\")+\";margin-right:5px'></span><strong>\"+escapeHtml(p.wxCat||\"METAR\")+\"</strong>\"+(p.wxAutomation?\" \u00b7 \"+escapeHtml(p.wxAutomation):\"\")+\"</div>\":\"\")+\n        (p.wxWind?\"<div style='margin-top:3px;color:#c5d2d9;font-size:10px'>\"+escapeHtml(p.wxWind)+\"</div>\":\"\")+\"</div>\";\n      airportHover=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:10,maxWidth:\"260px\"}).setLngLat(coords).setHTML(html).addTo(map)\n    });\n    map.on(\"mouseleave\",layerId,function(){\n      map.getCanvas().style.cursor=\"\";\n      if(airportHover){airportHover.remove();airportHover=null}\n    });\n  });\n}\nfunction updateArcgisMapImage(sourceId,serviceUrl){\n  var source=map.getSource(sourceId);if(!source)return;\n  var b=map.getBounds(),nw=[b.getWest(),b.getNorth()],ne=[b.getEast(),b.getNorth()],se=[b.getEast(),b.getSouth()],sw=[b.getWest(),b.getSouth()];\n  function merc(lon,lat){var R=6378137,x=R*lon*Math.PI/180,y=R*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));return[x,y]}\n  var p1=merc(b.getWest(),b.getSouth()),p2=merc(b.getEast(),b.getNorth()),box=map.getContainer(),w=Math.min(1400,Math.max(420,box.clientWidth)),h=Math.min(1000,Math.max(320,box.clientHeight));\n  var q=\"bbox=\"+encodeURIComponent([p1[0],p1[1],p2[0],p2[1]].join(\",\"))+\"&bboxSR=3857&imageSR=3857&size=\"+Math.round(w)+\",\"+Math.round(h)+\"&format=png32&transparent=true&f=image\";\n  source.updateImage({url:serviceUrl+\"/export?\"+q,coordinates:[nw,ne,se,sw]})\n}\nfunction updateLightningImage(){\n  if(!state.lightning)return;\n  updateArcgisMapImage(\"lightning\",\"https://nowcoast.noaa.gov/arcgis/rest/services/nowcoast/sat_meteo_emulated_imagery_lightningstrikedensity_goes_time/MapServer\")\n}\nfunction updateRadarImage(timeMs){\n  if(!state.radar||!map.getSource(\"mrms\"))return;\n  var b=map.getBounds(),nw=[b.getWest(),b.getNorth()],ne=[b.getEast(),b.getNorth()],se=[b.getEast(),b.getSouth()],sw=[b.getWest(),b.getSouth()];\n  function merc(lon,lat){var R=6378137,x=R*lon*Math.PI/180,y=R*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));return[x,y]}\n  var p1=merc(b.getWest(),b.getSouth()),p2=merc(b.getEast(),b.getNorth());\n  var size=map.getContainer(),w=Math.min(1400,Math.max(400,size.clientWidth)),h=Math.min(1000,Math.max(300,size.clientHeight));\n  var q=\"bbox=\"+encodeURIComponent([p1[0],p1[1],p2[0],p2[1]].join(\",\"))+\"&bboxSR=3857&imageSR=3857&size=\"+Math.round(w)+\",\"+Math.round(h)+\"&format=png32&transparent=true&f=image\";\n  if(timeMs)q+=\"&time=\"+encodeURIComponent(timeMs);\n  map.getSource(\"mrms\").updateImage({url:\"https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer/exportImage?\"+q,coordinates:[nw,ne,se,sw]})\n}\nfunction setRadarLoop(on){\n  state.radarLoop=!!on;clearInterval(radarLoopTimer);radarLoopTimer=null;radarFrame=5;\n  if(on){\n    radarLoopTimer=setInterval(function(){radarFrame=(radarFrame+1)%6;var t=radarFrame===5?null:Date.now()-(5-radarFrame)*5*60*1000;updateRadarImage(t)},850)\n  }else updateRadarImage(null);\n  saveState();renderPanel()\n}\nfunction renderPanel(){\n  var scroll=$(\"panelScroll\");\n  document.querySelectorAll(\".panel-tab\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.tab===panelTab)});\n  $(\"panelSubtitle\").textContent=panelTab===\"base\"?\"Professional aviation chart modes\":panelTab===\"weather\"?\"NOAA observations, imagery and advisories\":\"Traffic symbology and filtering\";\n  if(panelTab===\"base\"){\n    scroll.innerHTML='<section class=\"panel-section\"><div class=\"section-label\">PRIMARY AVIATION MAPS</div><div class=\"choice-grid\">'+\n      choice(\"aviation\",\"AVIATION\",\"Airports, navaids and geographic context\")+choice(\"vfr\",\"VFR SECTIONAL\",\"Official FAA sectional \u00b7 chart only\")+choice(\"ifr-low\",\"IFR LOW\",\"FAA low enroute \u00b7 below FL180\")+choice(\"ifr-high\",\"IFR HIGH\",\"FAA high enroute \u00b7 FL180 and above\")+\n      '</div><div class=\"layer-note\"><strong>FAA chart quality</strong><br>Official cached FAA AIS raster tiles are kept inside their native zoom envelope so labels and linework stay crisp.</div></section>'+\n      (state.base===\"vfr\"?row(\"Terminal Area Charts\",\"Optional TAC overlay where published\",toggle(\"terminalCharts\",state.terminalCharts)):\"\")+\n      '<section class=\"panel-section\"><div class=\"section-label\">ALTERNATE BASES</div><div class=\"choice-grid\">'+choice(\"satellite\",\"SATELLITE\",\"Esri World Imagery\")+choice(\"michigan\",\"MICHIGAN AERO\",\"Uploaded 2026 MDOT chart\")+choice(\"liberty\",\"LIBERTY\",\"Full OpenFreeMap vector map\")+choice(\"dark\",\"DARK\",\"Low-light vector map\")+'</div></section>'+\n      row(\"Michigan opacity\",\"Uploaded Michigan raster only\",\"<input id=\\'chartOpacity\\' class=\\'range-input\\' type=\\'range\\' min=\\'25\\' max=\\'100\\' value=\\'\"+Math.round(state.chartOpacity*100)+\"\\'>\")+\n      row(\"Satellite opacity\",\"Esri imagery base\",\"<input id=\\'satOpacity\\' class=\\'range-input\\' type=\\'range\\' min=\\'25\\' max=\\'100\\' value=\\'\"+Math.round(state.satelliteOpacity*100)+\"\\'>\");\n  }else if(panelTab===\"weather\"){\n    scroll.innerHTML=row(\"NOAA MRMS radar\",\"Current composite base reflectivity\",toggle(\"radar\",state.radar))+\n      row(\"Radar opacity\",\"Overlay intensity\",\"<input id=\\'radarOpacity\\' class=\\'range-input\\' type=\\'range\\' min=\\'20\\' max=\\'100\\' value=\\'\"+Math.round(state.radarOpacity*100)+\"\\'>\")+\n      row(\"Radar loop\",\"Six frames \u00b7 about 25 minutes\",toggle(\"radarLoop\",state.radarLoop))+\n      row(\"GOES infrared\",\"NOAA/NESDIS cloud imagery\",toggle(\"satellite\",state.satellite))+\n      row(\"Lightning density\",\"NOAA nowCOAST GOES / GLM composite\",toggle(\"lightning\",state.lightning))+\n      row(\"Lightning opacity\",\"Strike-density overlay\",\"<input id=\\'lightningOpacity\\' class=\\'range-input\\' type=\\'range\\' min=\\'20\\' max=\\'100\\' value=\\'\"+Math.round(state.lightningOpacity*100)+\"\\'>\")+\n      row(\"Airport METAR colors\",\"VFR / MVFR / IFR / LIFR\",toggle(\"metars\",state.metars))+\n      row(\"TAF stations\",\"Forecast-available airport ring\",toggle(\"tafs\",state.tafs))+\n      row(\"PIREPs\",\"Pilot reports\",toggle(\"pireps\",state.pireps))+\n      row(\"SIGMET / G-AIRMET\",\"Operational aviation advisories\",toggle(\"advisories\",state.advisories))+\n      row(\"Center Weather Advisories\",\"CWA polygons\",toggle(\"cwas\",state.cwas))+\n      row(\"TFM Convective Forecast\",\"TCF convective polygons\",toggle(\"tcf\",state.tcf))+\n      '<div class=\"weather-legend-row\"><span><i style=\"background:#3ed083\"></i>VFR</span><span><i style=\"background:#4b9dff\"></i>MVFR</span><span><i style=\"background:#ef5d63\"></i>IFR</span><span><i style=\"background:#b66cff\"></i>LIFR</span><span><i style=\"background:#f0a84c\"></i>CWA</span><span><i style=\"background:#ff4f8a\"></i>TCF</span></div>';\n  }else{\n    scroll.innerHTML=row(\"Range rings\",\"Optional home reference\",toggle(\"rings\",state.rings))+\n      row(\"Track vectors\",\"One-minute projection\",toggle(\"vectors\",state.vectors))+\n      row(\"Labels\",\"Collision-managed aircraft labels\",selectHtml(\"labels\",state.labels,[[\"full\",\"FULL\"],[\"callsign\",\"CALLSIGN\"],[\"altitude\",\"ALTITUDE\"],[\"none\",\"NONE\"]]))+\n      row(\"Traffic\",\"Display filter\",selectHtml(\"trafficFilter\",state.trafficFilter,[[\"all\",\"ALL\"],[\"airline\",\"AIRLINE\"],[\"ga\",\"GA\"]]))+\n      row(\"Altitude\",\"Display filter\",selectHtml(\"altFilter\",state.altFilter,[[\"all\",\"ALL\"],[\"low\",\"<5K\"],[\"mid\",\"5\u201315K\"],[\"high\",\">15K\"]]))+\n      row(\"Coverage\",\"Fast is the reliable default; Expanded uses a broader aggregated feed\",selectHtml(\"coverageMode\",state.coverageMode,[[\"fast\",\"FAST\"],[\"expanded\",\"EXPANDED\"]]))+\n      '<section class=\"panel-section\" style=\"margin-top:12px\"><div class=\"section-label\">DISPLAY DENSITY</div><div class=\"row-copy\"><strong>Every target remains an aircraft</strong><span>Wide views use small vector aircraft with labels suppressed. Zooming in progressively reveals callsigns and full labels. No count clusters are used.</span></div></section>'+trafficFeedHealthHtml()\n  }\n  bindPanelInputs()\n}\nfunction trafficFeedHealthHtml(){\n  var stats=trafficMeta&&Array.isArray(trafficMeta.sourceStats)?trafficMeta.sourceStats:[];\n  var ok=stats.filter(function(s){return s.ok}).length,attempted=trafficMeta.attemptedSourceCount||stats.length||0,total=trafficMeta.uncappedTotal||traffic.length;\n  var active=trafficMeta.source||\"\u2014\";\n  return\"<section class='panel-section'><div class='section-label'>ADS-B SOURCE</div><div class='feed-health'><div><strong>\"+escapeHtml(active.toUpperCase())+\"</strong><span>ACTIVE SOURCE</span></div><div><strong>\"+total.toLocaleString()+\"</strong><span>VISIBLE TARGETS</span></div><div><strong>\"+escapeHtml(String(state.coverageMode||\"fast\").toUpperCase())+\"</strong><span>COVERAGE MODE</span></div></div></section>\"\n}\nfunction choice(id,title,sub){return\"<button class='choice\"+(state.base===id?\" active\":\"\")+\"' data-base='\"+id+\"' type='button'><strong>\"+title+\"</strong><span>\"+sub+\"</span></button>\"}\nfunction row(title,sub,control){return\"<div class='row'><div class='row-copy'><strong>\"+title+\"</strong><span>\"+sub+\"</span></div>\"+control+\"</div>\"}\nfunction toggle(id,on){return\"<label class='switch'><input data-toggle='\"+id+\"' type='checkbox'\"+(on?\" checked\":\"\")+\"><span class='switch-track'></span></label>\"}\nfunction selectHtml(id,val,opts){return\"<select data-select='\"+id+\"' class='small-select'>\"+opts.map(function(o){return\"<option value='\"+o[0]+\"'\"+(o[0]===val?\" selected\":\"\")+\">\"+o[1]+\"</option>\"}).join(\"\")+\"</select>\"}\nfunction bindPanelInputs(){\n  document.querySelectorAll(\".choice[data-base]\").forEach(function(b){b.onclick=function(){setBase(b.dataset.base)}});\n  document.querySelectorAll(\"[data-toggle]\").forEach(function(i){i.onchange=function(){\n    var k=i.dataset.toggle;state[k]=i.checked;\n    if(k===\"radarLoop\")setRadarLoop(i.checked);\n    else{saveState();syncVisibility();syncAllSources();if(k===\"radar\"&&i.checked)updateRadarImage();if(k===\"radar\"&&!i.checked)setRadarLoop(false);if(k===\"lightning\"&&i.checked)updateLightningImage()}\n  }});\n  document.querySelectorAll(\"[data-select]\").forEach(function(s){s.onchange=function(){\n    state[s.dataset.select]=s.value;saveState();syncAllSources();\n    if(s.dataset.select===\"coverageMode\"){lastTrafficViewportKey=\"\";loadTrafficViewport(true);renderPanel()}\n  }});\n  var c=$(\"chartOpacity\");if(c)c.oninput=function(){state.chartOpacity=Number(c.value)/100;saveState();syncVisibility()};\n  var so=$(\"satOpacity\");if(so)so.oninput=function(){state.satelliteOpacity=Number(so.value)/100;saveState();syncVisibility()};\n  var ro=$(\"radarOpacity\");if(ro)ro.oninput=function(){state.radarOpacity=Number(ro.value)/100;if(map.getLayer(\"mrms\"))map.setPaintProperty(\"mrms\",\"raster-opacity\",state.radarOpacity);saveState()};\n  var lo=$(\"lightningOpacity\");if(lo)lo.oninput=function(){state.lightningOpacity=Number(lo.value)/100;if(map.getLayer(\"lightning\"))map.setPaintProperty(\"lightning\",\"raster-opacity\",state.lightningOpacity);saveState()}\n}\nfunction openPanel(tab){\n  panelTab=tab||panelTab;$(\"sidePanel\").classList.add(\"open\");document.querySelectorAll(\".rail-btn[data-open-tab]\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.openTab===panelTab)});\n  renderPanel();map.easeTo({padding:cameraPadding(),duration:180})\n}\nfunction closePanel(){\n  $(\"sidePanel\").classList.remove(\"open\");document.querySelectorAll(\".rail-btn[data-open-tab]\").forEach(function(b){b.classList.remove(\"active\")});map.easeTo({padding:cameraPadding(),duration:180})\n}\nfunction metric(label,value){return\"<div class='metric'><span>\"+escapeHtml(label)+\"</span><strong>\"+escapeHtml(value==null?\"\u2014\":value)+\"</strong></div>\"}\nfunction routeCard(){\n  if(!selectedRoute||!selectedRoute.route)return\"<div class='route-card'><div class='route-note'>ROUTE NOT AVAILABLE \u00b7 The destination line is only shown when the callsign can be matched to a route.</div></div>\";\n  var r=selectedRoute.route,o=r.origin,d=r.destination;\n  return\"<div class='route-card'><div class='route-line'><div class='airport'><strong>\"+escapeHtml(o&&(o.iata||o.icao)||\"\u2014\")+\"</strong><span>\"+escapeHtml(o&&(o.location||o.name)||\"Origin\")+\"</span></div><div class='route-arrow'>\u2192</div><div class='airport'><strong>\"+escapeHtml(d&&(d.iata||d.icao)||\"\u2014\")+\"</strong><span>\"+escapeHtml(d&&(d.location||d.name)||\"Destination\")+\"</span></div></div><div class='route-note'>\"+escapeHtml(r.iataCodes||r.airportCodes||\"Route lookup\")+(r.plausible===true?\" \u00b7 PLAUSIBLE ROUTE\":\"\")+\"</div></div>\"\n}\n\nfunction airportCode(ap){return ap.icao||ap.gps||ap.ident||ap.iata}\nfunction airportMetaHtml(ap){\n  var primary=airportCode(ap),items=[];\n  if(primary)items.push(\"<span><b>\"+(ap.icao||ap.gps?\"ICAO\":\"AIRPORT ID\")+\"</b> \"+escapeHtml(primary)+\"</span>\");\n  if(ap.ident&&String(ap.ident).toUpperCase()!==String(primary).toUpperCase())items.push(\"<span><b>FAA LID</b> \"+escapeHtml(ap.ident)+\"</span>\");\n  if(ap.iata&&String(ap.iata).toUpperCase()!==String(primary).toUpperCase())items.push(\"<span><b>IATA</b> \"+escapeHtml(ap.iata)+\"</span>\");\n  return items.join(\"\")\n}\n\n\nfunction renderNavaids(){\n  if(!nearbyNavaids.length)return\"<div class='route-note'>Radio navaid detail is not loaded in this release.</div>\";\n  return nearbyNavaids.map(function(x){\n    var n=x.n,freq=Number.isFinite(Number(n.frequencyMhz))?Number(n.frequencyMhz).toFixed(2):\"\u2014\";\n    return\"<div class='navaid-row'><strong>\"+escapeHtml(n.identifier||\"\")+\"</strong><span>\"+escapeHtml([n.name,n.type,x.d.toFixed(1)+\" NM\"].filter(Boolean).join(\" \u00b7 \"))+\"</span><em>\"+escapeHtml(freq)+\"</em></div>\"\n  }).join(\"\")\n}\nfunction airportMetar(ap){return airportMetarMatch(ap)}\nfunction airportTaf(ap){\n  var candidates=[ap.icao,ap.gps,ap.ident,ap.local].filter(Boolean).map(function(v){return String(v).toUpperCase()});\n  return(weather.tafs||[]).find(function(t){return candidates.indexOf(String(t.icaoId||\"\").toUpperCase())>=0})||null\n}\nfunction movementCounts(){\n  var counts={GROUND:0,ARRIVING:0,DEPARTING:0,NEARBY:0};\n  if(!selectedAirport)return counts;\n  airportTraffic.forEach(function(a){counts[movementFor(a,selectedAirport).status]++});\n  return counts\n}\nfunction resourceLink(url,title,sub){\n  return\"<a class='resource-link' href='\"+escapeHtml(url)+\"' target='_blank' rel='noopener'><strong>\"+escapeHtml(title)+\"</strong><span>\"+escapeHtml(sub)+\"</span></a>\"\n}\nfunction runwayRecommendationHtml(ap,m,runways){\n  var p=preferredRunwayInfo(ap,m,runways||[]);\n  if(!p.available)return\"<div class='runway-recommendation neutral'><div class='runway-rec-title'><div><strong>NO WIND-BASED RUNWAY</strong><span>\"+escapeHtml(p.reason||\"Insufficient data\")+\"</span></div></div><div class='runway-caution'>Runway use may be determined by ATC, traffic flow, NOTAMs, noise programs, runway condition and local procedures.</div></div>\";\n  var gustText=p.gust?\"G\"+Math.round(p.gust):\"\";\n  return\"<div class='runway-recommendation'><div class='runway-rec-head'><div class='runway-rec-title'><div class='runway-arrow-chip' style='--arrow-rotation:\"+Math.round(p.heading-90)+\"deg'>\u279c</div><div><strong>WIND-PREFERRED RWY \"+escapeHtml(p.ident)+\"</strong><span>Best alignment from current METAR wind</span></div></div><div class='runway-rec-wind'><strong>\"+String(Math.round(p.windDir)).padStart(3,\"0\")+\"\u00b0 / \"+Math.round(p.windSpeed)+gustText+\" KT</strong><span>METAR WIND</span></div></div><div class='runway-components'><div><span>HEADWIND COMPONENT</span><strong>\"+Math.round(p.headwind)+\" kt</strong></div><div><span>CROSSWIND COMPONENT</span><strong>\"+Math.round(p.crosswind)+\" kt</strong></div></div><div class='runway-caution'>Wind-derived indication only. ATC runway assignment, traffic, runway condition, NOTAMs, local runway-use programs and aircraft limits take precedence.</div></div>\"\n}\nfunction runwayDirectionHtml(r,end,m,preferred){\n  var ident=end===\"le\"?r.leIdent:r.heIdent,heading=end===\"le\"?(Number(r.leHeading)||runwayHeadingFromIdent(r.leIdent)):(Number(r.heHeading)||runwayHeadingFromIdent(r.heIdent));\n  var comp=runwayEndComponent(r,end,m),isPreferred=preferred&&preferred.available&&preferred.runway.id===r.id&&preferred.end===end;\n  return\"<div class='runway-direction \"+(isPreferred?\"preferred\":\"\")+\"'><strong>RWY \"+escapeHtml(ident||\"\u2014\")+(isPreferred?\" <span class='runway-preferred-badge'>PREFERRED</span>\":\"\")+\"</strong><span>\"+(Number.isFinite(heading)?Math.round(heading)+\"\u00b0 TRUE \u00b7 \":\"\")+(comp?(componentText(comp.headwind)+\" \u00b7 XW \"+Math.round(comp.crosswind)+\" kt\"):\"NO COMPONENT\")+\"</span></div>\"\n}\nfunction renderRunways(runways,m,ap){\n  if(!runways||!runways.length){\n    var err=airportDetail&&Array.isArray(airportDetail.diagnostics)?airportDetail.diagnostics.map(function(d){return d.source+\": \"+(d.ok?d.count+\" records\":d.error)}).join(\" \u00b7 \"):\"No runway records matched this airport.\";\n    return\"<div class='route-note'>\"+escapeHtml(err)+\"</div>\"\n  }\n  var preferred=preferredRunwayInfo(ap,m,runways);\n  return runways.map(function(r){\n    var isPreferred=preferred.available&&preferred.runway.id===r.id;\n    var ident=[r.leIdent,r.heIdent].filter(Boolean).join(\" / \")||\"RUNWAY\";\n    var dims=[r.lengthFt?Number(r.lengthFt).toLocaleString()+\" ft\":null,r.widthFt?r.widthFt+\" ft\":null].filter(Boolean).join(\" \u00d7 \");\n    var extras=[r.condition&&!/GOOD/i.test(String(r.condition))?r.condition:null,r.lighting||null,r.grossWtSingle?(\"SW \"+r.grossWtSingle+\"K\"):null,r.effectiveDate?(\"EFF \"+r.effectiveDate):null].filter(Boolean).join(\" \u00b7 \");\n    return\"<div class='runway-card \"+(isPreferred?\"preferred\":\"\")+\"'><div class='runway-card-head'><strong>\"+escapeHtml(ident)+\"</strong><span>\"+escapeHtml(dims)+\" \u00b7 \"+escapeHtml(r.surface||\"SURFACE N/A\")+\" \u00b7 \"+(r.lighted?\"LIGHTED\":\"UNLIGHTED\")+(extras?\" \u00b7 \"+escapeHtml(extras):\"\")+\"</span></div><div class='runway-direction-grid'>\"+runwayDirectionHtml(r,\"le\",m,preferred)+runwayDirectionHtml(r,\"he\",m,preferred)+\"</div></div>\"\n  }).join(\"\")\n}\nfunction renderFrequencies(freqs){\n  if(!freqs||!freqs.length){\n    var err=airportDetail&&Array.isArray(airportDetail.diagnostics)?airportDetail.diagnostics.map(function(d){return d.source+\": \"+(d.ok?d.count+\" records\":d.error)}).join(\" \u00b7 \"):\"No communication frequency records matched this airport.\";\n    return\"<div class='route-note'>\"+escapeHtml(err)+\"</div>\"\n  }\n  return freqs.map(function(f){return\"<div class='airport-freq-row'><strong>\"+escapeHtml(f.type||\"FREQ\")+\"</strong><span>\"+escapeHtml(f.description||\"\")+\"</span><em>\"+escapeHtml(f.frequencyMhz||\"\u2014\")+\"</em></div>\"}).join(\"\")\n}\n\nfunction procedureLabel(code){\n  return code===\"APD\"?\"DIAGRAM\":code===\"IAP\"?\"APPROACH\":code===\"DP\"?\"DEPARTURE\":code===\"ODP\"?\"ODP\":code===\"STAR\"?\"ARRIVAL\":code===\"MIN\"?\"MINIMUMS\":code===\"HOT\"?\"HOT SPOT\":code||\"CHART\"\n}\nfunction renderProcedures(data){\n  var list=data&&Array.isArray(data.procedures)?data.procedures:[];\n  if(!list.length)return\"<div class='route-note'>No current FAA terminal procedures returned for this airport.</div>\";\n  return\"<div class='procedure-list'>\"+list.map(function(p){\n    return\"<div class='procedure-row'><div class='procedure-type'>\"+escapeHtml(procedureLabel(p.code))+\"</div><div class='procedure-copy'><strong>\"+escapeHtml(p.name)+\"</strong><span>\"+escapeHtml([p.amendment?(\"AMDT \"+p.amendment):null,p.amendmentDate].filter(Boolean).join(\" \u00b7 \"))+\"</span></div><a class='procedure-view' href='\"+escapeHtml(p.url)+\"' target='_blank' rel='noopener'>VIEW</a></div>\"\n  }).join(\"\")+\"</div>\"\n}\n\nfunction loadingRows(){return\"<div class='af-loading'><i></i><i></i><i></i></div>\"}\nfunction airportCount(value,state){return state===\"loading\"?\"\u2026\":state===\"error\"?\"\u2014\":String(value||0)}\nfunction sourceFailureHtml(title,diagnostics){\n  var detail=(diagnostics||[]).map(function(d){return d.source+\": \"+(d.ok?(d.count+\" records\"):(d.error||\"failed\"))}).join(\" \u00b7 \");\n  return\"<div class='af-empty'><strong>\"+escapeHtml(title)+\"</strong>\"+escapeHtml(detail||\"The source returned no records. Retry the airport or refresh the page.\")+\"</div>\"\n}\nfunction airportTabsHtml(){\n  var counts={\n    runways:airportLoad.detail===\"loading\"?\"\u2026\":airportLoad.detail===\"error\"?\"\u2014\":String(airportDetail&&airportDetail.runways?airportDetail.runways.length:0),\n    comms:airportLoad.detail===\"loading\"?\"\u2026\":airportLoad.detail===\"error\"?\"\u2014\":String(airportDetail&&airportDetail.frequencies?airportDetail.frequencies.length:0),\n    procedures:airportLoad.procedures===\"loading\"?\"\u2026\":airportLoad.procedures===\"error\"?\"\u2014\":String(airportProcedures&&airportProcedures.procedures?airportProcedures.procedures.length:0),\n    traffic:airportLoad.traffic===\"loading\"?\"\u2026\":airportLoad.traffic===\"error\"?\"\u2014\":String(airportTraffic.length||0)\n  };\n  var compact=isMobile();\n  return[[\"overview\",compact?\"INFO\":\"OVERVIEW\"],[\"runways\",compact?\"RWYS\":\"RUNWAYS\"],[\"comms\",\"COMMS\"],[\"procedures\",compact?\"PROCS\":\"PROCEDURES\"],[\"traffic\",\"TRAFFIC\"]].map(function(t){\n    var count=t[0]===\"overview\"?\"\":\"<span class='airport-tab-count'>\"+counts[t[0]]+\"</span>\";\n    return\"<button class='airport-tab \"+(airportTab===t[0]?\"active\":\"\")+\"' data-airport-tab='\"+t[0]+\"' type='button'><span>\"+t[1]+\"</span>\"+count+\"</button>\"\n  }).join(\"\")\n}\nfunction airportOverviewHtml(ap,m,detail){\n  var p=preferredRunwayInfo(ap,m,detail.runways||[]),counts=movementCounts();\n  return (detail&&detail.runwaySource?\"<div class='data-source-note'>Runways: \"+escapeHtml(detail.runwaySource)+\" \u00b7 Comms: \"+escapeHtml(detail.frequencySource||\"not available\")+\"</div>\":\"\")+\n    runwayRecommendationHtml(ap,m,detail.runways||[])+\"<div class='airport-data-summary'><div><strong>\"+airportCount((detail.runways||[]).length,airportLoad.detail)+\"</strong><span>RUNWAYS</span></div><div><strong>\"+airportCount((detail.frequencies||[]).length,airportLoad.detail)+\"</strong><span>COMMS</span></div><div><strong>\"+airportCount((airportProcedures&&airportProcedures.procedures?airportProcedures.procedures.length:0),airportLoad.procedures)+\"</strong><span>PROCEDURES</span></div></div><div class='airport-summary-grid'><div class='airport-summary-cell'><span>FIELD ELEVATION</span><strong>\"+(ap.elevationFt?Number(ap.elevationFt).toLocaleString()+\" ft\":\"\u2014\")+\"</strong></div><div class='airport-summary-cell'><span>WEATHER</span><strong>\"+escapeHtml(m&&m.fltCat||\"NO REPORT\")+\"</strong></div><div class='airport-summary-cell'><span>WIND</span><strong>\"+escapeHtml(m&&Number.isFinite(Number(m.wspd))?((m.wdir||\"VRB\")+\"\u00b0 / \"+m.wspd+(m.wgst?\"G\"+m.wgst:\"\")+\" kt\"):\"\u2014\")+\"</strong></div><div class='airport-summary-cell'><span>LIVE MOVEMENTS</span><strong>\"+(counts.GROUND+counts.ARRIVING+counts.DEPARTING)+\"</strong></div></div>\"+(m&&m.rawOb?\"<div class='info-section'><h4>CURRENT METAR</h4><div style='font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.5;color:#d0dde3;padding:9px 0;border-bottom:1px solid var(--border)'>\"+escapeHtml(m.rawOb)+\"</div></div>\":\"\")+(airportTaf(ap)&&airportTaf(ap).rawTAF?\"<div class='info-section'><h4>CURRENT TAF</h4><div style='font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.5;color:#bdd8e5;padding:9px 0;border-bottom:1px solid var(--border)'>\"+escapeHtml(airportTaf(ap).rawTAF)+\"</div></div>\":\"\")+\"<div class='info-section'><h4>DATA STATUS</h4><div class='integration-state'><div><strong>FAA terminal procedures</strong><span>Current d-TPP list is embedded under Procedures.</span></div><em style='color:#67d79a'>CONNECTED</em></div><div class='integration-state'><div><strong>NOTAMs</strong><span>FAA NMS API requires approved access.</span></div><em>NOT CONNECTED</em></div><div class='integration-state'><div><strong>FBO directory</strong><span>No reliable structured current source connected.</span></div><em>NOT CONNECTED</em></div></div>\"\n}\nfunction airportTrafficHtml(){\n  var rows=airportTraffic.map(function(a){return{a:a,mv:movementFor(a,selectedAirport)}}).sort(function(x,y){var order={GROUND:0,ARRIVING:1,DEPARTING:2,NEARBY:3};return order[x.mv.status]-order[y.mv.status]||x.mv.distance-y.mv.distance}).slice(0,24),counts=movementCounts();\n  return\"<div class='movement-summary'><div><strong>\"+counts.GROUND+\"</strong><span>GROUND</span></div><div><strong>\"+counts.ARRIVING+\"</strong><span>ARRIVING</span></div><div><strong>\"+counts.DEPARTING+\"</strong><span>DEPARTING</span></div><div><strong>\"+counts.NEARBY+\"</strong><span>NEARBY</span></div></div><div class='movement-board'>\"+rows.map(function(item){var a=item.a,mv=item.mv;return\"<button class='movement-row' data-aircraft='\"+escapeHtml(a.hex||\"\")+\"' type='button'><span class='movement-status \"+mv.status+\"'>\"+mv.status+\"</span><span class='movement-main'><strong>\"+escapeHtml(aircraftName(a))+\"</strong><span>\"+escapeHtml([a.r,a.t].filter(Boolean).join(\" \u00b7 \"))+\"</span></span><span class='movement-side'><strong>\"+mv.distance.toFixed(1)+\" NM</strong><span>\"+escapeHtml(altitude(a))+\"</span></span></button>\"}).join(\"\")+\"</div><div class='route-note'>Categories are inferred from ADS-B track, groundspeed and vertical rate; this is not a tower or schedule feed.</div>\"\n}\nfunction renderAirportInfo(){\n  if(!selectedAirport)return;\n  $(\"infoKicker\").textContent=\"AIRPORT\";\n  $(\"infoTitle\").textContent=airportCode(selectedAirport);\n  $(\"infoSub\").textContent=[selectedAirport.name,selectedAirport.municipality].filter(Boolean).join(\" \u00b7 \");\n  $(\"infoMeta\").innerHTML=airportMetaHtml(selectedAirport);\n  $(\"infoLoading\").style.display=(airportLoad.detail===\"loading\"||airportLoad.procedures===\"loading\")?\"block\":\"none\";\n  renderMobilePeek();\n\n  var nav=$(\"contextNav\");\n  nav.className=\"context-nav airport\";\n  nav.innerHTML=airportTabsHtml();\n\n  var scroll=$(\"infoScroll\"),oldScroll=scroll.scrollTop,m=airportMetar(selectedAirport);\n  var detail=airportDetail||{runways:[],frequencies:[],diagnostics:[]},content=\"\";\n\n  if(airportTab===\"overview\")content=airportOverviewHtml(selectedAirport,m,detail);\n  if(airportTab===\"runways\")content=airportLoad.detail===\"loading\"?loadingRows():(detail.runways&&detail.runways.length?runwayRecommendationHtml(selectedAirport,m,detail.runways)+renderRunways(detail.runways,m,selectedAirport):sourceFailureHtml(\"RUNWAY DATA UNAVAILABLE\",detail.diagnostics));\n  if(airportTab===\"comms\")content=airportLoad.detail===\"loading\"?loadingRows():(detail.frequencies&&detail.frequencies.length?renderFrequencies(detail.frequencies):sourceFailureHtml(\"COMMUNICATIONS UNAVAILABLE\",detail.diagnostics));\n  if(airportTab===\"procedures\")content=airportLoad.procedures===\"loading\"?loadingRows():(airportProcedures&&airportProcedures.procedures&&airportProcedures.procedures.length?renderProcedures(airportProcedures):sourceFailureHtml(\"FAA PROCEDURES UNAVAILABLE\",airportProcedures&&airportProcedures.diagnostics));\n  if(airportTab===\"traffic\")content=airportLoad.traffic===\"loading\"?loadingRows():airportTrafficHtml();\n\n  scroll.innerHTML=content+\"<div class='info-actions'><button id='fitAirportBtn' class='info-action active' type='button'>CENTER AIRPORT</button><button id='closeAirportBtn' class='info-action' type='button'>CLOSE</button></div>\";\n  requestAnimationFrame(function(){scroll.scrollTop=Math.max(0,Math.min(oldScroll,scroll.scrollHeight-scroll.clientHeight))});\n  nav.querySelectorAll(\"[data-airport-tab]\").forEach(function(b){b.onclick=function(){airportTab=b.dataset.airportTab;scroll.scrollTop=0;renderAirportInfo()}});\n  scroll.querySelectorAll(\".movement-row\").forEach(function(b){b.onclick=function(){var a=airportTraffic.find(function(x){return x.hex===b.dataset.aircraft});if(a)selectAircraft(a)}});\n  var fa=$(\"fitAirportBtn\");if(fa)fa.onclick=fitAirportView;\n  var ca=$(\"closeAirportBtn\");if(ca)ca.onclick=closeInfo\n}\n\nfunction fitAirportView(){\n  if(!selectedAirport)return;\n  var bounds=new maplibregl.LngLatBounds();\n  [0,90,180,270].forEach(function(b){bounds.extend(destinationPoint(selectedAirport.lon,selectedAirport.lat,b,7))});\n  performCamera(\"airport\",function(){map.fitBounds(bounds,{padding:cameraPadding({top:30,bottom:50}),duration:450,maxZoom:13})})\n}\nasync function selectAirport(ap){\n  selected=null;selectedTrace=null;selectedRoute=null;selectedToken++;\n  selectedAirport=ap;airportTraffic=[];airportDetail=null;airportProcedures=null;airportTab=\"overview\";\n  airportLoad={detail:\"loading\",procedures:\"loading\",traffic:\"loading\"};cameraMode=\"airport\";airportToken++;\n  var token=airportToken;\n  closePanel();\n  $(\"infoPanel\").classList.add(\"open\",\"airport-mode\");\n  $(\"infoScroll\").scrollTop=0;\n  if(isMobile())setSheetDetent(\"half\",false);\n  syncVisibility();syncAllSources();renderAirportInfo();fitAirportView();\n\n  var detailUrl=\"/api/airport-detail?ident=\"+encodeURIComponent(ap.icao||ap.gps||ap.ident||\"\")+\"&local=\"+encodeURIComponent(ap.ident||ap.local||\"\")+\"&icao=\"+encodeURIComponent(ap.icao||ap.gps||\"\")+\"&ref=\"+encodeURIComponent(ap.id||\"\")+\"&_=\"+Date.now();\n  fetch(detailUrl,{cache:\"no-store\"}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(result){\n    if(token!==airportToken)return;\n    airportDetail=result.ok?result.data:{runways:[],frequencies:[],diagnostics:[{source:\"Airport detail\",ok:false,error:result.data&&result.data.error||\"Request failed\"}]};\n    airportLoad.detail=result.ok?\"ready\":\"error\";syncAllSources();renderAirportInfo()\n  }).catch(function(error){if(token!==airportToken)return;airportDetail={runways:[],frequencies:[],diagnostics:[{source:\"Airport detail\",ok:false,error:String(error)}]};airportLoad.detail=\"error\";renderAirportInfo()});\n\n  var procedureIdent=ap.icao||ap.gps||ap.ident;\n  fetch(\"/api/procedures?ident=\"+encodeURIComponent(procedureIdent)+\"&_=\"+Date.now(),{cache:\"no-store\"}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(result){\n    if(token!==airportToken)return;\n    airportProcedures=result.data||{procedures:[]};airportLoad.procedures=result.ok?\"ready\":\"error\";renderAirportInfo()\n  }).catch(function(error){if(token!==airportToken)return;airportProcedures={procedures:[],diagnostics:[{source:\"FAA d-TPP\",ok:false,error:String(error)}]};airportLoad.procedures=\"error\";renderAirportInfo()});\n\n  fetch(\"/api/traffic?lat=\"+encodeURIComponent(ap.lat)+\"&lon=\"+encodeURIComponent(ap.lon)+\"&radius=35&_=\"+Date.now(),{cache:\"no-store\"}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(result){\n    if(token!==airportToken)return;\n    airportTraffic=result.ok&&Array.isArray(result.data.aircraft)?result.data.aircraft:[];airportLoad.traffic=result.ok?\"ready\":\"error\";syncAllSources();renderAirportInfo()\n  }).catch(function(){if(token!==airportToken)return;airportTraffic=[];airportLoad.traffic=\"error\";renderAirportInfo()})\n}\n\n\nfunction isMobile(){return window.matchMedia(\"(max-width:720px)\").matches}\nfunction setSheetDetent(detent,animate){\n  if(![\"peek\",\"half\",\"full\"].includes(detent))detent=\"peek\";\n  sheetDetent=detent;var panel=$(\"infoPanel\");panel.style.height=\"\";\n  panel.classList.remove(\"sheet-peek\",\"sheet-half\",\"sheet-full\");panel.classList.add(\"sheet-\"+detent);\n  document.querySelectorAll(\"[data-sheet]\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.sheet===detent)});\n  $(\"bottomBar\").classList.toggle(\"sheet-open\",panel.classList.contains(\"open\")&&isMobile());\n  if(panel.classList.contains(\"open\")&&isMobile())setTimeout(function(){map.easeTo({padding:cameraPadding(),duration:animate===false?0:190})},30)\n}\nfunction renderMobilePeek(){\n  var box=$(\"mobilePeek\");\n  if(selected){\n    var gs=Number(selected.gs),vr=Number(selected.baro_rate);\n    var routeText=selectedRoute&&selectedRoute.route?escapeHtml(((selectedRoute.route.origin&&(selectedRoute.route.origin.iata||selectedRoute.route.origin.icao))||\"\u2014\")+\" \u2192 \"+((selectedRoute.route.destination&&(selectedRoute.route.destination.iata||selectedRoute.route.destination.icao))||\"\u2014\")):\"ROUTE UNKNOWN\";\n    box.innerHTML=\"<div style='display:grid;grid-template-columns:repeat(3,1fr);gap:10px'><div><span style='font-size:8.5px;color:var(--muted)'>ALTITUDE</span><strong style='display:block;font-size:14px;margin-top:3px'>\"+escapeHtml(altitude(selected))+\"</strong></div><div><span style='font-size:8.5px;color:var(--muted)'>SPEED</span><strong style='display:block;font-size:14px;margin-top:3px'>\"+(Number.isFinite(gs)?Math.round(gs)+\" kt\":\"\u2014\")+\"</strong></div><div><span style='font-size:8.5px;color:var(--muted)'>VERT RATE</span><strong style='display:block;font-size:14px;margin-top:3px'>\"+(Number.isFinite(vr)?Math.round(vr)+\" fpm\":\"\u2014\")+\"</strong></div></div><div style='margin-top:9px;font-size:9.5px;color:#a3b4be'>\"+routeText+(selectedTrace&&selectedTrace.points?\" \u00b7 \"+selectedTrace.originalPointCount+\" track pts\":\"\")+\"</div>\";\n    return\n  }\n  if(selectedAirport){\n    var m=airportMetar(selectedAirport),p=preferredRunwayInfo(selectedAirport,m,airportDetail&&airportDetail.runways||[]);\n    box.innerHTML=\"<div style='display:grid;grid-template-columns:repeat(3,1fr);gap:10px'><div><span style='font-size:8.5px;color:var(--muted)'>WEATHER</span><strong style='display:block;font-size:14px;margin-top:3px'>\"+escapeHtml(m&&m.fltCat||\"NO REPORT\")+\"</strong></div><div><span style='font-size:8.5px;color:var(--muted)'>WIND</span><strong style='display:block;font-size:14px;margin-top:3px'>\"+escapeHtml(m&&Number.isFinite(Number(m.wspd))?((m.wdir||\"VRB\")+\"/\"+m.wspd):\"\u2014\")+\"</strong></div><div><span style='font-size:8.5px;color:var(--muted)'>WIND-PREFERRED</span><strong style='display:block;font-size:14px;margin-top:3px;color:#69de9a'>\"+escapeHtml(p.available?(\"RWY \"+p.ident):\"\u2014\")+\"</strong></div></div>\";\n    return\n  }\n  box.innerHTML=\"\"\n}\nfunction bindSheetGestures(){\n  var handle=$(\"sheetHandle\"),panel=$(\"infoPanel\"),lastY=0,lastT=0,velocity=0;\n  handle.addEventListener(\"pointerdown\",function(e){if(!isMobile())return;sheetDragging=true;sheetStartY=e.clientY;sheetStartHeight=panel.getBoundingClientRect().height;lastY=e.clientY;lastT=performance.now();velocity=0;handle.setPointerCapture(e.pointerId);panel.style.transition=\"none\"});\n  handle.addEventListener(\"pointermove\",function(e){if(!sheetDragging||!isMobile())return;var now=performance.now(),dt=Math.max(1,now-lastT);velocity=(e.clientY-lastY)/dt;lastY=e.clientY;lastT=now;panel.style.height=clamp(sheetStartHeight+(sheetStartY-e.clientY),150,Math.min(window.innerHeight*.9,parseFloat(getComputedStyle(document.documentElement).getPropertyValue(\"--visual-height\"))||window.innerHeight))+\"px\"});\n  function finish(){if(!sheetDragging)return;sheetDragging=false;var h=panel.getBoundingClientRect().height,vh=window.visualViewport?window.visualViewport.height:window.innerHeight;panel.style.height=\"\";panel.style.transition=\"\";var next;if(velocity<-.35)next=sheetDetent===\"peek\"?\"half\":\"full\";else if(velocity>.35)next=sheetDetent===\"full\"?\"half\":\"peek\";else next=h<vh*.34?\"peek\":h<vh*.69?\"half\":\"full\";setSheetDetent(next,true)}\n  handle.addEventListener(\"pointerup\",finish);handle.addEventListener(\"pointercancel\",finish);\n  document.querySelectorAll(\"[data-sheet]\").forEach(function(b){b.onclick=function(){setSheetDetent(b.dataset.sheet,true)}})\n}\n\nfunction centerSelectedAircraft(){\n  if(!selected||!Number.isFinite(Number(selected.lon))||!Number.isFinite(Number(selected.lat)))return;\n  performCamera(\"aircraft\",function(){map.easeTo({center:[Number(selected.lon),Number(selected.lat)],zoom:map.getZoom(),padding:cameraPadding(),duration:280,essential:true})})\n}\n\nfunction renderAircraftInfo(){\n  if(!selected)return;\n  var infoScroll=$(\"infoScroll\"),oldScroll=infoScroll.scrollTop;\n  $(\"infoKicker\").textContent=\"SELECTED AIRCRAFT\";\n  $(\"infoTitle\").textContent=aircraftName(selected);$(\"infoSub\").textContent=[selected.r,selected.t,selected.desc,selected.year].filter(Boolean).join(\" \u00b7 \");$(\"infoMeta\").innerHTML=\"\";\n  var traceText=selectedTrace&&selectedTrace.points?selectedTrace.originalPointCount+\" points \u00b7 \"+formatDuration((selectedTrace.endTime-selectedTrace.startTime)*1000):\"Loading flight history\u2026\";\n  var cls=emitterClass(selected);\n  $(\"infoScroll\").innerHTML=routeCard()+\n    \"<div style='margin-bottom:8px'><span class='aircraft-class-chip'>\"+escapeHtml(cls.label)+\"</span>\"+(selected.category?\"<span class='aircraft-class-chip'>ADS-B \"+escapeHtml(selected.category)+\"</span>\":\"\")+\"</div><div class='metrics'>\"+metric(\"ALTITUDE\",altitude(selected))+metric(\"GROUND SPEED\",Number.isFinite(Number(selected.gs))?Math.round(Number(selected.gs))+\" kt\":\"\u2014\")+\n    metric(\"VERTICAL RATE\",Number.isFinite(Number(selected.baro_rate))?Math.round(Number(selected.baro_rate))+\" fpm\":\"\u2014\")+metric(\"TRACK\",Number.isFinite(Number(selected.track))?Math.round(Number(selected.track))+\"\u00b0\":\"\u2014\")+\n    metric(\"SQUAWK\",selected.squawk||\"\u2014\")+metric(\"POSITION AGE\",Math.round(aircraftAge(selected))+\" sec\")+\"</div>\"+\n    \"<div class='info-section'><h4>FLIGHT TRACK</h4><div class='row-copy'><strong>\"+escapeHtml(traceText)+\"</strong><span>Full current leg is loaded only for this selected aircraft.</span></div></div>\"+\n    \"<div class='info-actions'><button id='currentAircraftBtn' class='info-action \"+(cameraMode===\"aircraft\"?\"active\":\"\")+\"' type='button'>AIRCRAFT</button><button id='fitTrackBtn' class='info-action \"+(cameraMode===\"track\"?\"active\":\"\")+\"' type='button'>FULL TRACK</button><button id='fitRouteBtn' class='info-action \"+(cameraMode===\"route\"?\"active\":\"\")+\"' type='button' \"+(!selectedRoute||!selectedRoute.route?\"disabled\":\"\")+\">ROUTE</button><button id='returnBtn' class='info-action \"+(cameraMode===\"kapn\"?\"active\":\"\")+\"' type='button'>KAPN</button></div>\";\n  renderMobilePeek();\n  var ca=$(\"currentAircraftBtn\");if(ca)ca.onclick=centerSelectedAircraft;\n  var ft=$(\"fitTrackBtn\");if(ft)ft.onclick=fitSelectedTrack;\n  var fr=$(\"fitRouteBtn\");if(fr)fr.onclick=fitSelectedRoute;\n  var rb=$(\"returnBtn\");if(rb)rb.onclick=function(){goHome(true)};\n  requestAnimationFrame(function(){infoScroll.scrollTop=Math.min(oldScroll,Math.max(0,infoScroll.scrollHeight-infoScroll.clientHeight))})\n}\nfunction formatDuration(ms){\n  if(!Number.isFinite(ms)||ms<0)return\"\u2014\";var m=Math.round(ms/60000),h=Math.floor(m/60);m%=60;return(h?h+\"h \":\"\")+m+\"m\"\n}\nasync function selectAircraft(a){\n  selectedAirport=null;airportTraffic=[];airportDetail=null;airportProcedures=null;nearbyNavaids=[];airportToken++;\n  airportTab=\"overview\";\n  var nav=$(\"contextNav\");nav.className=\"context-nav\";nav.innerHTML=\"\";\n  $(\"infoPanel\").classList.remove(\"airport-mode\");\n  $(\"infoKicker\").textContent=\"SELECTED AIRCRAFT\";\n  cameraMode=\"aircraft\";\n  selected=a;selectedTrace=null;selectedRoute=null;selectedToken++;\n  var token=selectedToken;$(\"infoKicker\").textContent=\"SELECTED AIRCRAFT\";$(\"infoPanel\").classList.add(\"open\");$(\"infoScroll\").scrollTop=0;if(isMobile())setSheetDetent(\"peek\",false);$(\"infoLoading\").style.display=\"block\";\n  closePanel();syncAllSources();renderAircraftInfo();setTimeout(centerSelectedAircraft,30);\n  var callsign=aircraftName(a),tracePromise=fetch(\"/api/trace?hex=\"+encodeURIComponent(a.hex||\"\"),{cache:\"no-store\"}).then(function(r){return r.json()}),\n      routePromise=fetch(\"/api/route?callsign=\"+encodeURIComponent(callsign)+\"&lat=\"+encodeURIComponent(a.lat)+\"&lon=\"+encodeURIComponent(a.lon),{cache:\"no-store\"}).then(function(r){return r.json()});\n  var results=await Promise.allSettled([tracePromise,routePromise]);if(token!==selectedToken)return;\n  if(results[0].status===\"fulfilled\"&&Array.isArray(results[0].value.points))selectedTrace=results[0].value;\n  if(results[1].status===\"fulfilled\")selectedRoute=results[1].value;\n  $(\"infoLoading\").style.display=\"none\";syncSelectedSources();renderAircraftInfo();renderMobilePeek()\n}\nfunction closeInfo(){\n  $(\"infoPanel\").classList.remove(\"open\",\"airport-mode\");\n  var nav=$(\"contextNav\");nav.className=\"context-nav\";nav.innerHTML=\"\";\n  selected=null;selectedTrace=null;selectedRoute=null;selectedAirport=null;airportTraffic=[];airportDetail=null;airportProcedures=null;\n  selectedToken++;airportToken++;cameraMode=\"free\";\n  $(\"bottomBar\").classList.remove(\"sheet-open\");syncAllSources();map.easeTo({padding:cameraPadding(),duration:180})\n}\nfunction boundsFromCoords(coords){\n  if(!coords||!coords.length)return null;var b=new maplibregl.LngLatBounds();coords.forEach(function(c){if(Number.isFinite(c[0])&&Number.isFinite(c[1]))b.extend(c)});return b\n}\n\nfunction performCamera(mode,fn){\n  cameraMode=mode;\n  cameraProgrammatic=true;\n  if(selected)renderAircraftInfo();\n  fn();\n  map.once(\"moveend\",function(){cameraProgrammatic=false})\n}\nfunction clearCameraModeFromUser(){\n  if(cameraProgrammatic)return;\n  if(cameraMode!==\"free\"){\n    cameraMode=\"free\";\n    if(selected)renderAircraftInfo();\n  }\n}\n\nfunction fitSelectedTrack(){\n  if(!selectedTrace||!selectedTrace.points||selectedTrace.points.length<2)return;\n  var b=boundsFromCoords(selectedTrace.points.map(function(p){return[p.lon,p.lat]}));\n  if(b)performCamera(\"track\",function(){map.fitBounds(b,{padding:cameraPadding({top:35,bottom:55}),duration:500,maxZoom:10})})\n}\nfunction fitSelectedRoute(){\n  var coords=[];if(selectedTrace&&selectedTrace.points)coords=coords.concat(selectedTrace.points.map(function(p){return[p.lon,p.lat]}));\n  if(selectedRoute&&selectedRoute.route&&selectedRoute.route.destination&&Number.isFinite(selectedRoute.route.destination.lon))coords.push([selectedRoute.route.destination.lon,selectedRoute.route.destination.lat]);\n  if(selectedRoute&&selectedRoute.route&&selectedRoute.route.origin&&Number.isFinite(selectedRoute.route.origin.lon))coords.push([selectedRoute.route.origin.lon,selectedRoute.route.origin.lat]);\n  var b=boundsFromCoords(coords);\n  if(b)performCamera(\"route\",function(){map.fitBounds(b,{padding:cameraPadding({top:35,bottom:55}),duration:600,maxZoom:9})})\n}\nfunction showMetar(m){\n  new maplibregl.Popup({closeButton:false,offset:10}).setLngLat([Number(m.lon),Number(m.lat)]).setHTML(\"<strong>\"+escapeHtml(m.icaoId||\"METAR\")+\"</strong><br><span style='font-size:10px;color:#9dafba'>\"+escapeHtml(m.fltCat||\"\")+\" \u00b7 \"+escapeHtml(m.rawOb||\"\")+\"</span>\").addTo(map)\n}\nfunction showPirep(p){\n  new maplibregl.Popup({closeButton:false,offset:10}).setLngLat([Number(p.lon),Number(p.lat)]).setHTML(\"<strong>PIREP</strong><br><span style='font-size:10px;color:#9dafba'>\"+escapeHtml(p.rawOb||p.rawText||\"Pilot report\")+\"</span>\").addTo(map)\n}\nfunction showAdvisory(p){toast((p.kind||\"ADVISORY\")+\" \u00b7 \"+(p.hazard||p.hazardType||p.type||\"Weather advisory\"),false)}\n\nfunction viewportBbox(expand){\n  var b=map.getBounds(),latPad=(b.getNorth()-b.getSouth())*(expand||.08),lonPad=(b.getEast()-b.getWest())*(expand||.08);\n  return[clamp(b.getSouth()-latPad,-85,85),clamp(b.getWest()-lonPad,-180,180),clamp(b.getNorth()+latPad,-85,85),clamp(b.getEast()+lonPad,-180,180)]\n}\nfunction bboxParam(b){return b.map(function(v){return Number(v.toFixed(3))}).join(\",\")}\nfunction viewportRadiusNm(){\n  var c=map.getCenter(),b=map.getBounds(),corners=[[b.getNorth(),b.getEast()],[b.getSouth(),b.getWest()],[b.getNorth(),b.getWest()],[b.getSouth(),b.getEast()]];\n  return clamp(Math.ceil(Math.max.apply(null,corners.map(function(p){return distanceNm(c.lat,c.lng,p[0],p[1])}))*1.12),15,450)\n}\nfunction trafficViewportDataKey(){\n  var c=map.getCenter(),b=viewportBbox(.04);\n  return[c.lng.toFixed(2),c.lat.toFixed(2),map.getZoom().toFixed(1),bboxParam(b),state.coverageMode].join(\"|\")\n}\nfunction referenceViewportDataKey(){\n  var c=map.getCenter(),b=viewportBbox(.04);\n  return[c.lng.toFixed(1),c.lat.toFixed(1),Math.floor(map.getZoom()),bboxParam(b)].join(\"|\")\n}\nasync function loadTrafficViewport(force){\n  var key=trafficViewportDataKey();if(!force&&key===lastTrafficViewportKey)return;lastTrafficViewportKey=key;\n  var token=++trafficRequestToken,bbox=viewportBbox(.10),param=bboxParam(bbox),c=map.getCenter(),radius=viewportRadiusNm(),zoom=map.getZoom();\n  try{\n    var r=await fetch(\"/api/traffic?lat=\"+encodeURIComponent(c.lat)+\"&lon=\"+encodeURIComponent(c.lng)+\"&radius=\"+radius+\"&bbox=\"+encodeURIComponent(param)+\"&zoom=\"+encodeURIComponent(zoom)+\"&coverage=\"+encodeURIComponent(state.coverageMode)+\"&_=\"+Date.now(),{cache:\"no-store\"});\n    var d=await r.json();if(token!==trafficRequestToken)return;\n    if(!r.ok)throw new Error((d.errors||[]).join(\" | \")||d.error||(\"HTTP \"+r.status));\n    traffic=Array.isArray(d.aircraft)?d.aircraft:[];prepareTrafficProjection(traffic);trafficMeta=d;lastTrafficAt=Date.parse(d.generatedAt||\"\")||Date.now();\n    setStatus(d.stale?\"\":\"good\",(d.stale?\"HOLDING \u00b7 \":\"LIVE \u00b7 \")+(d.source||\"ADS-B\").toUpperCase());\n    syncAllSources();scheduleTrafficCanvasRender();if(selectedAirport)renderAirportInfo()\n  }catch(e){\n    if(!traffic.length)setStatus(\"bad\",\"TRAFFIC OFFLINE\");\n    toast(\"Traffic update failed: \"+String(e.message||e),true)\n  }\n}\nasync function loadReferenceViewport(force){\n  var key=referenceViewportDataKey();if(!force&&key===lastReferenceViewportKey)return;lastReferenceViewportKey=key;\n  var token=++referenceRequestToken,bbox=viewportBbox(.10),param=bboxParam(bbox),zoom=map.getZoom();\n  var calls=[\n    fetch(\"/api/airports?bbox=\"+encodeURIComponent(param)+\"&zoom=\"+encodeURIComponent(zoom),{cache:\"no-store\"}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}),\n    fetch(\"/api/navaids?bbox=\"+encodeURIComponent(param)+\"&zoom=\"+encodeURIComponent(zoom),{cache:\"no-store\"}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}),\n    fetch(\"/api/weather?bbox=\"+encodeURIComponent(param)+\"&_=\"+Date.now(),{cache:\"no-store\"}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})})\n  ];\n  var results=await Promise.allSettled(calls);if(token!==referenceRequestToken)return;\n  if(results[0].status===\"fulfilled\"&&results[0].value.ok)airports=Array.isArray(results[0].value.data.airports)?results[0].value.data.airports:[];\n  if(results[1].status===\"fulfilled\"&&results[1].value.ok)navaids=Array.isArray(results[1].value.data.navaids)?results[1].value.data.navaids:[];\n  if(results[2].status===\"fulfilled\"&&results[2].value.ok){\n    var w=results[2].value.data;\n    weather={metars:Array.isArray(w.metars)?w.metars:[],tafs:Array.isArray(w.tafs)?w.tafs:[],pireps:Array.isArray(w.pireps)?w.pireps:[],gairmets:w.gairmets||emptyFC(),sigmets:w.sigmets||emptyFC(),cwas:w.cwas||emptyFC(),tcf:w.tcf||emptyFC()};\n    lastWeatherAt=Date.parse(w.generatedAt||\"\")||Date.now()\n  }\n  syncAllSources();if(selectedAirport)renderAirportInfo();if(state.radar)updateRadarImage();if(state.lightning)updateLightningImage()\n}\nasync function loadViewportData(force){\n  await Promise.allSettled([loadTrafficViewport(!!force),loadReferenceViewport(!!force)])\n}\nfunction scheduleViewportLoad(force){\n  clearTimeout(trafficViewportTimer);clearTimeout(referenceViewportTimer);\n  trafficViewportTimer=setTimeout(function(){loadTrafficViewport(!!force)},force?30:260);\n  referenceViewportTimer=setTimeout(function(){loadReferenceViewport(!!force)},force?80:850)\n}\nasync function loadAirports(){return loadReferenceViewport(true)}\nasync function loadTraffic(manual){\n  if(manual)$(\"refreshBtn\").disabled=true;\n  try{await loadTrafficViewport(true)}finally{if(manual)$(\"refreshBtn\").disabled=false}\n}\nasync function loadWeather(){return loadReferenceViewport(true)}\nfunction updateStats(){\n  var now=Date.now(),age=lastTrafficAt?Math.max(0,Math.round((now-lastTrafficAt)/1000))+\"s\":\"\u2014\",wx=lastWeatherAt?Math.max(0,Math.round((now-lastWeatherAt)/1000))+\"s\":\"\u2014\";\n  var count=traffic.filter(function(a){return matchesTraffic(a)}).length;$(\"topAircraft\").textContent=count;$(\"barAircraft\").textContent=count;$(\"topAge\").textContent=age;$(\"topWx\").textContent=wx;\n  $(\"barMetar\").textContent=(weather.metars||[]).length;$(\"barPirep\").textContent=(weather.pireps||[]).length;updateDetailContext()\n}\nfunction openCommand(){\n  var d=$(\"commandDialog\");if(!d.open)d.showModal();$(\"commandInput\").value=\"\";renderCommands(\"\");setTimeout(function(){$(\"commandInput\").focus()},0)\n}\nfunction commandCatalog(){\n  var commands=[\n    {title:\"Open map layers\",sub:\"Aviation, VFR Sectional, IFR Low and IFR High\",run:function(){openPanel(\"base\")}},\n    {title:\"Open weather layers\",sub:\"Radar, GOES, lightning, METAR, TAF and advisories\",run:function(){openPanel(\"weather\")}},\n    {title:\"Open traffic settings\",sub:\"Labels, vectors and filters\",run:function(){openPanel(\"traffic\")}},\n    {title:\"Return to KAPN\",sub:\"Close panels and restore the home operating picture\",run:function(){goHome(true)}},\n    {title:\"Toggle NOAA radar\",sub:state.radar?\"Turn radar off\":\"Turn radar on\",run:function(){state.radar=!state.radar;saveState();syncVisibility();if(state.radar)updateRadarImage();renderPanel()}},\n    {title:\"Toggle clean view\",sub:\"Hide or restore application chrome\",run:function(){setClean(!state.clean)}},\n    {title:\"VFR Sectional\",sub:\"Official FAA Sectional chart-only mode\",run:function(){setBase(\"vfr\")}},\n    {title:\"IFR Low\",sub:\"Official FAA Low Enroute chart-only mode\",run:function(){setBase(\"ifr-low\")}},\n    {title:\"IFR High\",sub:\"Official FAA High Enroute chart-only mode\",run:function(){setBase(\"ifr-high\")}},\n    {title:\"Aviation map\",sub:\"Minimal airports, navaids and geographic context\",run:function(){setBase(\"aviation\")}}\n  ];\n  [25,50,100,150,250].forEach(function(r){commands.push({title:\"Set range to \"+r+\" NM\",sub:\"Fit around the current map center\",run:function(){setRange(r)}})});\n  traffic.slice(0,40).forEach(function(a){commands.push({title:aircraftName(a),sub:[a.r,a.t,altitude(a)].filter(Boolean).join(\" \u00b7 \"),aircraft:a,run:function(){selectAircraft(a)}})});\n  return commands\n}\nfunction renderCommands(q){\n  q=String(q||\"\").trim().toLowerCase();var list=$(\"commandList\");list.replaceChildren();\n  var items=commandCatalog().filter(function(c){return!q||(c.title+\" \"+c.sub).toLowerCase().includes(q)}).slice(0,18);\n  var label=document.createElement(\"div\");label.className=\"command-group\";label.textContent=q?\"RESULTS\":\"QUICK ACTIONS\";list.appendChild(label);\n  items.forEach(function(c){\n    var b=document.createElement(\"button\");b.type=\"button\";b.className=\"command-item\";\n    b.innerHTML=\"<div><strong>\"+escapeHtml(c.title)+\"</strong><span>\"+escapeHtml(c.sub||\"\")+\"</span></div>\"+(c.aircraft?\"<span class='command-key'>AIRCRAFT</span>\":\"\");\n    b.onclick=function(){$(\"commandDialog\").close();c.run()};list.appendChild(b)\n  })\n}\nfunction setRange(r){state.range=Number(r);saveState();document.querySelectorAll(\"[data-range]\").forEach(function(b){b.classList.toggle(\"active\",Number(b.dataset.range)===state.range)});syncAllSources();fitRange(true,map.getCenter());loadTraffic(false)}\nfunction setClean(on){state.clean=!!on;saveState();document.body.classList.toggle(\"clean\",state.clean);$(\"app\").classList.toggle(\"clean\",state.clean);setTimeout(function(){map.resize()},50)}\nfunction bindUI(){\n  document.querySelectorAll(\"[data-map-mode]\").forEach(function(b){b.onclick=function(){setBase(b.dataset.mapMode)}});\n  $(\"nativeZoomBtn\").onclick=snapChartNativeZoom;\n  document.querySelectorAll(\"[data-open-tab]\").forEach(function(b){b.onclick=function(){openPanel(b.dataset.openTab)}});\n  document.querySelectorAll(\".panel-tab\").forEach(function(b){b.onclick=function(){panelTab=b.dataset.tab;renderPanel()}});\n  document.querySelectorAll(\"[data-range]\").forEach(function(b){b.onclick=function(){setRange(b.dataset.range)}});\n  $(\"sideClose\").onclick=closePanel;$(\"infoClose\").onclick=closeInfo;$(\"homeBtn\").onclick=function(){goHome(true)};\n  $(\"fitRange\").onclick=function(){fitRange(true,map.getCenter())};$(\"zoomIn\").onclick=function(){map.zoomIn({duration:160})};$(\"zoomOut\").onclick=function(){map.zoomOut({duration:160})};\n  $(\"commandBtn\").onclick=openCommand;$(\"commandInput\").oninput=function(){renderCommands(this.value)};$(\"refreshBtn\").onclick=function(){loadTraffic(true);if(state.radar)updateRadarImage();if(state.lightning)updateLightningImage()};\n  $(\"cleanBtn\").onclick=function(){setClean(true)};$(\"cleanReturn\").onclick=function(){setClean(false)};\n  document.addEventListener(\"keydown\",function(e){\n    var typing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement&&document.activeElement.tagName||\"\");\n    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()===\"k\"){e.preventDefault();openCommand();return}\n    if(typing)return;\n    if(e.key===\"Escape\"){closePanel();closeInfo()}\n    if(e.key.toLowerCase()===\"l\")openPanel(\"base\");\n    if(e.key.toLowerCase()===\"w\")openPanel(\"weather\");\n    if(e.key.toLowerCase()===\"t\")openPanel(\"traffic\")\n  })\n}\n\nloadState();\n\nvar map=new maplibregl.Map({\n  container:\"map\",style:styleForBase(state.base),center:CENTER,zoom:6.1,bearing:0,pitch:0,\n  hash:false,interactive:true,dragPan:true,scrollZoom:true,doubleClickZoom:true,keyboard:true,\n  touchZoomRotate:true,touchPitch:false,dragRotate:false,pitchWithRotate:false,renderWorldCopies:false,\n  attributionControl:false,fadeDuration:120,cancelPendingTileRequestsWhileZooming:false\n});\nmap.touchZoomRotate.disableRotation();\nmap.addControl(new maplibregl.NavigationControl({showCompass:false,visualizePitch:false}),\"top-right\");\nmap.on(\"style.load\",afterStyleLoad);\nmap.on(\"styleimagemissing\",function(e){\n  if(/^plane-/.test(e.id)&&map.hasImage(\"alt-plane\")){\n    try{map.addImage(e.id,map.getImage(\"alt-plane\"))}catch(err){}\n  }\n});\nmap.on(\"moveend\",function(){updateMapModeUI();updateDetailContext();scheduleViewportLoad(false);if(state.radar)updateRadarImage();if(state.lightning)updateLightningImage()});\nmap.on(\"zoom\",function(){updateMapModeUI();updateDetailContext()});\nmap.on(\"render\",renderTrafficCanvas);\nmap.on(\"mousemove\",function(e){updateMapCursor(e.point)});\nmap.on(\"mouseout\",function(){map.getCanvas().style.cursor=\"\"});\nmap.on(\"dragstart\",clearCameraModeFromUser);\nmap.on(\"zoomstart\",clearCameraModeFromUser);\nmap.on(\"load\",function(){installLayers();fitRange(false,{lng:CENTER[0],lat:CENTER[1]});updateDetailContext();scheduleViewportLoad(true)});\nupdateVisualViewport();bindUI();bindSheetGestures();setSheetDetent(\"peek\",false);setClean(state.clean);renderPanel();\nwindow.addEventListener(\"resize\",function(){updateVisualViewport();if(!isMobile())$(\"bottomBar\").classList.remove(\"sheet-open\");map.resize()});\nif(window.visualViewport){window.visualViewport.addEventListener(\"resize\",function(){updateVisualViewport();if(isMobile()&&$(\"infoPanel\").classList.contains(\"open\"))setSheetDetent(sheetDetent,false);map.resize()})}\ntrafficTimer=setInterval(function(){loadTrafficViewport(true)},TRAFFIC_POLL);\nweatherTimer=setInterval(function(){loadReferenceViewport(true)},WEATHER_POLL);\nsetInterval(updateStats,1000);\n})();\n</script>\n</body>\n</html>";


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/assets/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/traffic") return traffic(request, ctx);
    if (url.pathname === "/api/weather") return aviationWeatherV6(request, ctx);
    if (url.pathname === "/api/trace") return selectedTrace(request, ctx);
    if (url.pathname === "/api/route") return routeLookup(request, ctx);
    if (url.pathname === "/api/airports") return airportCatalogV6(request, ctx);
    if (url.pathname === "/api/navaids") return navaidCatalogV6(request, ctx);
    if (url.pathname === "/api/airport-detail") return airportDetail(request, ctx);
    if (url.pathname === "/api/procedures") return airportProcedures(request, ctx);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        version: "6.3",
        architecture: "maplibre-national-aviation-charts",
        mapEngine: "MapLibre GL JS 6.1.0",
        traffic: "TheAirTraffic / HPRadar",
        trace: "tar1090/readsb current-leg trace",
        route: "adsb.lol routeset when available",
        weather: "NOAA/NWS",
        time: new Date().toISOString()
      });
    }

    return new Response(PAGE, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
};
