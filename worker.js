const CENTER = { lat: 45.0781, lon: -83.5603 };
const FRESH_TTL = 20;
const STALE_TTL = 600;

const SOURCES = [
  {
    name: "theairtraffic",
    url: "https://globe.theairtraffic.com/data/aircraft.json"
  },
  {
    name: "hpradar",
    url: "https://skylink.hpradar.com/data/aircraft.json"
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
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36 AviationLiveTraffic/4.0"
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

async function trySource(source, lat, lon, radius) {
  const response = await fetchWithTimeout(source.url);
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    throw new Error(`${source.name} HTTP ${response.status}${retry ? ` retry-after=${retry}` : ""}`);
  }

  const raw = await response.json();
  const rows = Array.isArray(raw.aircraft) ? raw.aircraft :
               Array.isArray(raw.ac) ? raw.ac : [];

  const aircraft = rows
    .map(normalize)
    .filter(a =>
      Number.isFinite(a.lat) &&
      Number.isFinite(a.lon) &&
      distanceNm(lat, lon, a.lat, a.lon) <= radius
    );

  const upstreamNow = Number(raw.now);
  const generatedAt = Number.isFinite(upstreamNow)
    ? new Date(upstreamNow * 1000).toISOString()
    : new Date().toISOString();

  return {
    source: source.name,
    generatedAt,
    center: { lat, lon, radiusNm: radius },
    total: aircraft.length,
    aircraft,
    stale: false,
    cached: false
  };
}

async function traffic(request, ctx) {
  const u = new URL(request.url);
  const lat = clampNumber(u.searchParams.get("lat"), -90, 90, CENTER.lat);
  const lon = clampNumber(u.searchParams.get("lon"), -180, 180, CENTER.lon);
  const radius = Math.round(clampNumber(u.searchParams.get("radius"), 5, 250, 100));
  const force = false;

  const cache = caches.default;
  const cacheBase = `${u.origin}/__traffic_cache/${lat.toFixed(4)}/${lon.toFixed(4)}/${radius}`;
  const freshKey = new Request(`${cacheBase}/fresh`);
  const staleKey = new Request(`${cacheBase}/stale`);

  const fresh = await cache.match(freshKey);
  if (fresh) {
    const payload = await fresh.json();
    payload.cached = true;
    return json(payload);
  }

  const errors = [];

  for (const source of SOURCES) {
    try {
      const payload = await trySource(source, lat, lon, radius);

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
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
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
    errors,
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
        "user-agent": "AviationLiveTraffic/4.0 weather-display contact=local-home-display"
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
        "user-agent": "AviationLiveTraffic/4.0 selected-flight-trace"
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
          "user-agent": "AviationLiveTraffic/4.0 static-route-lookup"
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
          "user-agent": "AviationLiveTraffic/4.0 fallback-route-lookup"
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
        "user-agent": "AviationLiveTraffic/5.0 airport-catalog"
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

const PAGE = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"theme-color\" content=\"#071019\">\n<title>Alpena Traffic \u2014 Operations</title>\n<link rel=\"stylesheet\" href=\"https://unpkg.com/maplibre-gl@6.1.0/dist/maplibre-gl.css\">\n<style>\n:root{\n  color-scheme:dark;\n  --bg:#070b10;\n  --chrome:#0b1118;\n  --surface:#0e151d;\n  --surface-2:#121c26;\n  --surface-3:#17232e;\n  --border:#263541;\n  --border-strong:#344a5a;\n  --text:#f4f7f9;\n  --muted:#8da0ae;\n  --subtle:#657784;\n  --accent:#58c7e8;\n  --accent-soft:#123848;\n  --good:#52d18c;\n  --warning:#f0c35a;\n  --danger:#ef6973;\n  --selected:#ffc857;\n  --vfr:#3ed083;\n  --mvfr:#4b9dff;\n  --ifr:#ef5d63;\n  --lifr:#b66cff;\n  --radius:7px;\n  --shadow:0 18px 50px rgba(0,0,0,.38);\n}\n*{box-sizing:border-box}\nhtml,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--text);\n  font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;\n  font-feature-settings:\"tnum\" 1,\"ss01\" 1}\nbutton,input,select{font:inherit}\nbutton{color:inherit}\nbutton:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n.app{height:100vh;height:100svh;height:100dvh;display:grid;grid-template-rows:46px minmax(0,1fr);overflow:hidden}\n.topbar{\n  min-width:0;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:14px;\n  padding:0 10px;border-bottom:1px solid var(--border);background:var(--chrome);z-index:50\n}\n.brand{display:flex;align-items:center;gap:9px;min-width:0}\n.brand-mark{width:27px;height:27px;border:1px solid var(--border-strong);border-radius:6px;display:grid;place-items:center;\n  color:var(--accent);font-size:8px;font-weight:950;letter-spacing:.08em;background:#0c1720}\n.brand-copy strong{display:block;font-size:13px;letter-spacing:.045em;font-weight:900}\n.brand-copy span{display:block;font-size:8.5px;letter-spacing:.11em;color:var(--subtle);font-weight:800;margin-top:2px;line-height:1.25}\n.ops-strip{justify-self:center;display:flex;align-items:center;gap:11px;min-width:0}\n.ops-item{display:flex;align-items:baseline;gap:5px;color:var(--muted);font-size:8.5px;white-space:nowrap}\n.ops-item strong{font-size:10.5px;color:var(--text);font-weight:900}\n.status-dot{width:7px;height:7px;border-radius:50%;background:var(--warning);box-shadow:0 0 0 3px rgba(240,195,90,.08)}\n.status-dot.good{background:var(--good);box-shadow:0 0 0 3px rgba(82,209,140,.08)}\n.status-dot.bad{background:var(--danger);box-shadow:0 0 0 3px rgba(239,105,115,.08)}\n.actions{display:flex;align-items:center;gap:5px}\n.btn{\n  height:31px;border:1px solid var(--border);border-radius:6px;background:var(--surface);\n  color:#c4d0d7;padding:0 10px;font-size:9.5px;font-weight:850;letter-spacing:.025em;cursor:pointer\n}\n.btn:hover{background:var(--surface-2);border-color:var(--border-strong)}\n.btn.active{background:var(--accent-soft);border-color:#2e7891;color:#d8f6ff}\n.btn.icon{width:29px;padding:0;display:grid;place-items:center}\n.btn svg,.rail-btn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}\n.workspace{position:relative;min-width:0;min-height:0;overflow:hidden}\n#map{position:absolute;inset:0}\n.maplibregl-map{font:inherit}\n.maplibregl-canvas{outline:none}\n.maplibregl-ctrl-bottom-left,.maplibregl-ctrl-bottom-right{display:none}\n.rail{\n  position:absolute;z-index:25;left:8px;top:8px;width:42px;display:flex;flex-direction:column;gap:5px\n}\n.rail-btn{\n  width:42px;height:42px;border:1px solid rgba(50,72,86,.9);border-radius:7px;background:rgba(9,17,24,.94);\n  color:#9aadb9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;\n  box-shadow:0 7px 18px rgba(0,0,0,.17)\n}\n.rail-btn span{font-size:6px;font-weight:900;letter-spacing:.07em}\n.rail-btn:hover{color:#d3e1e8;border-color:#476273}\n.rail-btn.active{background:#103044;border-color:#377c96;color:#d9f6ff}\n.side-panel{\n  position:absolute;z-index:30;left:56px;top:8px;bottom:48px;width:min(368px,calc(100vw - 76px));\n  background:rgba(10,17,24,.97);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);\n  display:none;grid-template-rows:auto auto minmax(0,1fr);overflow:hidden\n}\n.side-panel.open{display:grid}\n.panel-head{height:43px;padding:0 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}\n.panel-title strong{display:block;font-size:12px;letter-spacing:.065em}\n.panel-title span{display:block;font-size:8.5px;color:var(--muted);margin-top:3px;line-height:1.3}\n.panel-tabs{height:34px;display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--border);background:#0b141c}\n.panel-tab{\n  border:0;border-right:1px solid var(--border);background:transparent;color:var(--muted);\n  font-size:9px;font-weight:900;letter-spacing:.07em;cursor:pointer\n}\n.panel-tab:last-child{border-right:0}\n.panel-tab.active{color:var(--text);box-shadow:inset 0 -2px 0 var(--accent);background:#0e1b25}\n.panel-scroll{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:10px}\n.panel-section{margin-bottom:14px}\n.section-label{font-size:9px;color:#778f9f;font-weight:900;letter-spacing:.115em;margin-bottom:8px}\n.choice-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}\n.choice{\n  min-height:44px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:#b7c4cc;\n  padding:7px;text-align:left;cursor:pointer\n}\n.choice strong,.choice span{display:block}.choice strong{font-size:10.5px}.choice span{font-size:8.5px;color:var(--muted);margin-top:3px;line-height:1.25}\n.choice.active{border-color:#3d839b;background:#102b39;color:#e2f8ff}\n.row{\n  min-height:41px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;align-items:center;\n  border-bottom:1px solid rgba(38,53,65,.55)\n}\n.row:last-child{border-bottom:0}\n.row-copy strong,.row-copy span{display:block}.row-copy strong{font-size:10px}.row-copy span{font-size:8.25px;color:var(--muted);margin-top:3px;line-height:1.35}\n.switch{position:relative;width:32px;height:18px}\n.switch input{position:absolute;opacity:0;pointer-events:none}\n.switch-track{position:absolute;inset:0;border-radius:20px;background:#172630;border:1px solid #35505f;transition:.12s}\n.switch-track:after{content:\"\";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#8ea0aa;transition:.12s}\n.switch input:checked+.switch-track{background:#0e526a;border-color:#3986a0}\n.switch input:checked+.switch-track:after{transform:translateX(14px);background:#e0f8ff}\n.small-select{height:31px;min-width:98px;border:1px solid var(--border);border-radius:5px;background:#0b151d;color:var(--text);font-size:9px;padding:0 8px}\n.range-input{width:93px;accent-color:var(--accent)}\n.info-panel{\n  position:absolute;z-index:31;right:8px;top:8px;bottom:48px;width:min(392px,42%);\n  background:rgba(8,15,21,.98);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);\n  display:none;grid-template-rows:auto minmax(0,1fr);overflow:hidden\n}\n.info-panel.open{display:grid}\n.info-head{padding:11px 11px 9px;border-bottom:1px solid var(--border)}\n.info-kicker{font-size:8px;letter-spacing:.13em;color:var(--subtle);font-weight:900}\n.info-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}\n.info-title{font-size:22px;font-weight:900;letter-spacing:-.02em;margin-top:2px}\n.info-sub{font-size:10px;color:var(--muted);margin-top:3px;line-height:1.35}\n.info-scroll{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:10px}\n.route-card{\n  border:1px solid var(--border);border-radius:7px;background:#0c151d;padding:9px;margin-bottom:9px\n}\n.route-line{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center}\n.airport{text-align:left}.airport:last-child{text-align:right}\n.airport strong{display:block;font-size:15px}.airport span{display:block;font-size:6.5px;color:var(--muted);margin-top:2px}\n.route-arrow{color:var(--accent);font-size:14px}\n.route-note{margin-top:8px;font-size:8.5px;color:var(--subtle);line-height:1.4}\n.metrics{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-top:2px}\n.metric{border:0;border-bottom:1px solid rgba(38,53,65,.62);background:transparent;padding:10px 6px}\n.metric:nth-last-child(-n+2){border-bottom:0}\n.metric:nth-child(odd){border-right:1px solid rgba(38,53,65,.62)}\n.metric span,.metric strong{display:block}.metric span{font-size:8px;color:var(--muted);letter-spacing:.045em}.metric strong{font-size:12.5px;margin-top:3px}\n.info-section{margin-top:13px}.info-section h4{font-size:8.5px;color:#7f96a5;letter-spacing:.11em;margin:0 0 7px}\n.info-actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}\n.info-action{\n  height:32px;border:1px solid var(--border);border-radius:5px;background:#0d1a24;color:#b9c9d2;\n  padding:0 10px;font-size:9px;font-weight:900;cursor:pointer;transition:background .12s,border-color .12s,color .12s\n}\n.info-action:hover{border-color:var(--border-strong);color:var(--text)}\n.info-action.active,.info-action.primary.active{\n  border-color:#3b8da8;background:#123b4e;color:#e4f9ff;box-shadow:inset 0 -2px 0 #58c7e8\n}\n.info-action:disabled{opacity:.42;cursor:default}\n\n.airport-badge{display:inline-flex;align-items:center;height:20px;border:1px solid var(--border);border-radius:4px;padding:0 6px;font-size:8px;font-weight:900;color:#aebdc6;background:#0c171f}\n.airport-badge.scheduled{border-color:#2d7189;color:#cceef8;background:#0d2b3a}\n.movement-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:10px 0}\n.movement-summary div{border-top:1px solid var(--border);padding:7px 2px 2px}\n.movement-summary strong,.movement-summary span{display:block}\n.movement-summary strong{font-size:14px}.movement-summary span{font-size:7.5px;color:var(--muted);margin-top:2px}\n.movement-board{border-top:1px solid var(--border)}\n.movement-row{width:100%;min-height:43px;border:0;border-bottom:1px solid rgba(38,53,65,.62);background:transparent;color:var(--text);display:grid;grid-template-columns:64px 1fr auto;gap:8px;align-items:center;text-align:left;padding:6px 2px;cursor:pointer}\n.movement-row:hover{background:#0d1a23}\n.movement-status{font-size:7.5px;font-weight:900;letter-spacing:.05em}\n.movement-status.GROUND{color:#59d49a}.movement-status.ARRIVING{color:#64c8ee}.movement-status.DEPARTING{color:#f0c35a}.movement-status.NEARBY{color:#8da0ae}\n.movement-main strong,.movement-main span{display:block}.movement-main strong{font-size:10px}.movement-main span{font-size:8px;color:var(--muted);margin-top:2px}\n.movement-side{text-align:right}.movement-side strong,.movement-side span{display:block}.movement-side strong{font-size:9px}.movement-side span{font-size:7px;color:var(--muted);margin-top:2px}\n\n.loading-line{height:3px;background:#0d1b24;overflow:hidden;margin-top:8px;border-radius:2px}\n.loading-line i{display:block;width:35%;height:100%;background:var(--accent);animation:load 1.1s ease-in-out infinite}\n@keyframes load{0%{transform:translateX(-120%)}100%{transform:translateX(340%)}}\n.bottom-bar{\n  position:absolute;z-index:24;left:56px;right:8px;bottom:8px;height:34px;border:1px solid rgba(52,74,88,.86);\n  border-radius:7px;background:rgba(8,15,21,.93);display:flex;align-items:center;gap:7px;padding:3px 6px;\n  backdrop-filter:blur(8px);box-shadow:0 8px 18px rgba(0,0,0,.14)\n}\n.segment{display:flex;gap:2px}\n.segment button{\n  height:26px;min-width:34px;border:0;border-radius:5px;background:transparent;color:#8699a6;font-size:7px;font-weight:900;cursor:pointer\n}\n.segment button.active{background:#143246;color:#dff8ff}\n.bar-sep{width:1px;height:16px;background:var(--border)}\n.bar-stat{display:flex;align-items:baseline;gap:3px;font-size:6.5px;color:var(--muted);white-space:nowrap}\n.bar-stat strong{font-size:8px;color:var(--text)}\n.bar-spacer{flex:1}\n.map-btn{\n  width:30px;height:26px;border:1px solid var(--border);border-radius:5px;background:#0c171f;color:#a7b6bf;\n  display:grid;place-items:center;cursor:pointer;font-size:10px\n}\n.map-btn:hover{border-color:var(--border-strong);color:var(--text)}\n.toast{\n  position:absolute;z-index:60;left:50%;top:10px;transform:translateX(-50%);max-width:min(680px,calc(100% - 90px));\n  border:1px solid #705f28;border-radius:6px;background:rgba(53,43,16,.96);color:#f3dda0;padding:7px 10px;\n  font-size:7.5px;box-shadow:var(--shadow);display:none\n}\n.toast.bad{border-color:#70313a;background:rgba(54,20,25,.97);color:#ffd8dc}\n.command{\n  width:min(620px,calc(100% - 24px));max-height:min(620px,calc(100vh - 48px));padding:0;\n  border:1px solid var(--border-strong);border-radius:9px;background:#0a1118;color:var(--text);box-shadow:0 28px 80px rgba(0,0,0,.55)\n}\n.command::backdrop{background:rgba(2,6,9,.68);backdrop-filter:blur(2px)}\n.command-head{height:45px;display:flex;align-items:center;border-bottom:1px solid var(--border);padding:0 11px}\n.command-input{width:100%;border:0;background:transparent;color:var(--text);font-size:12px;outline:none}\n.command-list{max-height:520px;overflow:auto;padding:6px}\n.command-group{font-size:6.5px;color:var(--subtle);letter-spacing:.12em;font-weight:900;padding:7px 7px 4px}\n.command-item{\n  width:100%;min-height:38px;border:0;border-radius:6px;background:transparent;color:#c6d2d9;\n  display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 8px;text-align:left;cursor:pointer\n}\n.command-item:hover,.command-item.focused{background:#11212c}\n.command-item strong{display:block;font-size:8px}.command-item span{display:block;font-size:6.5px;color:var(--muted);margin-top:2px}\n.command-key{font-size:6px;color:#778b98;border:1px solid var(--border);border-radius:4px;padding:2px 5px}\n.maplibregl-ctrl.maplibregl-ctrl-group{\n  background:rgba(8,15,21,.94);border:1px solid var(--border);box-shadow:none;border-radius:6px;overflow:hidden\n}\n.maplibregl-ctrl-group button{width:29px;height:29px}\n.maplibregl-ctrl-group button+button{border-top:1px solid var(--border)}\n.maplibregl-ctrl-icon{filter:invert(.8)}\n.maplibregl-popup-content{background:#0a131b;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;box-shadow:var(--shadow)}\n.maplibregl-popup-tip{border-top-color:#0a131b!important}\n.clean .topbar,.clean .rail,.clean .bottom-bar,.clean .side-panel{display:none!important}\n.clean .app{grid-template-rows:minmax(0,1fr)}\n.clean .info-panel{top:8px;bottom:8px}\n.clean .clean-return{display:block}\n.clean-return{display:none;position:absolute;left:8px;top:8px;z-index:70}\n@media(max-width:900px){\n  .brand-copy span{display:none}.ops-strip{display:none}\n  .side-panel{width:310px}\n  .info-panel{width:min(345px,45%)}\n}\n@media(max-width:720px){\n  .app{grid-template-rows:42px minmax(0,1fr)}\n  .topbar{padding:0 6px;gap:6px}.brand-mark{display:none}.brand-copy strong{font-size:10px}\n  .actions .btn:not(.icon){padding:0 6px}\n  .side-panel{left:6px;right:6px;top:auto;bottom:48px;width:auto;height:min(68%,520px)}\n  .info-panel{left:6px;right:6px;top:auto;bottom:48px;width:auto;height:min(56%,450px)}\n  .bottom-bar{left:6px}.rail{left:6px;top:7px}.rail-btn{width:37px;height:37px}\n  .rail-btn span{display:none}\n  .bar-stat.optional{display:none}\n}\n</style>\n</head>\n<body>\n<main id=\"app\" class=\"app\">\n  <header class=\"topbar\">\n    <div class=\"brand\">\n      <div class=\"brand-mark\">ALT</div>\n      <div class=\"brand-copy\"><strong>ALPENA TRAFFIC</strong><span>OPERATIONS CONSOLE \u00b7 KAPN</span></div>\n    </div>\n    <div class=\"ops-strip\">\n      <div class=\"ops-item\"><span id=\"statusDot\" class=\"status-dot\"></span><strong id=\"statusText\">CONNECTING</strong></div>\n      <div class=\"ops-item\"><strong id=\"topAircraft\">\u2014</strong><span>AIRCRAFT</span></div>\n      <div class=\"ops-item\"><strong id=\"topAge\">\u2014</strong><span>DATA AGE</span></div>\n      <div class=\"ops-item\"><strong id=\"topWx\">\u2014</strong><span>WX AGE</span></div>\n    </div>\n    <div class=\"actions\">\n      <button id=\"commandBtn\" class=\"btn\" type=\"button\">SEARCH <span style=\"color:var(--subtle)\">\u2318K</span></button>\n      <button id=\"refreshBtn\" class=\"btn icon\" type=\"button\" aria-label=\"Refresh\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"M20 11a8 8 0 1 0-2.3 5.7\"/><path d=\"M20 4v7h-7\"/></svg>\n      </button>\n      <button id=\"cleanBtn\" class=\"btn icon\" type=\"button\" aria-label=\"Clean view\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5\"/></svg>\n      </button>\n    </div>\n  </header>\n\n  <section class=\"workspace\">\n    <div id=\"map\"></div>\n\n    <div class=\"rail\">\n      <button class=\"rail-btn\" data-open-tab=\"base\" type=\"button\" aria-label=\"Map layers\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"m12 2 9 5-9 5-9-5 9-5Z\"/><path d=\"m3 12 9 5 9-5M3 17l9 5 9-5\"/></svg><span>MAP</span>\n      </button>\n      <button class=\"rail-btn\" data-open-tab=\"weather\" type=\"button\" aria-label=\"Weather layers\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"M17.5 19H7a5 5 0 1 1 1.3-9.8A6 6 0 0 1 20 11a4 4 0 0 1-2.5 8Z\"/></svg><span>WX</span>\n      </button>\n      <button class=\"rail-btn\" data-open-tab=\"traffic\" type=\"button\" aria-label=\"Traffic layers\">\n        <svg viewBox=\"0 0 24 24\"><path d=\"m12 2 2 7 6 3v2l-6-1-1 6 3 2v1l-4-1-4 1v-1l3-2-1-6-6 1v-2l6-3 2-7Z\"/></svg><span>TRFC</span>\n      </button>\n      <button id=\"homeBtn\" class=\"rail-btn\" type=\"button\" aria-label=\"Return to KAPN\">\n        <svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"7\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><path d=\"M12 2v3M12 19v3M2 12h3M19 12h3\"/></svg><span>KAPN</span>\n      </button>\n    </div>\n\n    <aside id=\"sidePanel\" class=\"side-panel\" aria-label=\"Map controls\">\n      <div class=\"panel-head\">\n        <div class=\"panel-title\"><strong>DISPLAY</strong><span id=\"panelSubtitle\">Map and chart presentation</span></div>\n        <button id=\"sideClose\" class=\"btn icon\" type=\"button\" aria-label=\"Close panel\">\u00d7</button>\n      </div>\n      <div class=\"panel-tabs\">\n        <button class=\"panel-tab active\" data-tab=\"base\" type=\"button\">BASE</button>\n        <button class=\"panel-tab\" data-tab=\"weather\" type=\"button\">WEATHER</button>\n        <button class=\"panel-tab\" data-tab=\"traffic\" type=\"button\">TRAFFIC</button>\n      </div>\n      <div id=\"panelScroll\" class=\"panel-scroll\"></div>\n    </aside>\n\n    <aside id=\"infoPanel\" class=\"info-panel\" aria-label=\"Selected item details\">\n      <div class=\"info-head\">\n        <div class=\"info-kicker\">SELECTED AIRCRAFT</div>\n        <div class=\"info-title-row\"><div id=\"infoTitle\" class=\"info-title\">\u2014</div><button id=\"infoClose\" class=\"btn icon\" type=\"button\">\u00d7</button></div>\n        <div id=\"infoSub\" class=\"info-sub\">\u2014</div>\n        <div id=\"infoLoading\" class=\"loading-line\" style=\"display:none\"><i></i></div>\n      </div>\n      <div id=\"infoScroll\" class=\"info-scroll\"></div>\n    </aside>\n\n    <div class=\"bottom-bar\">\n      <div id=\"rangeSegment\" class=\"segment\">\n        <button data-range=\"25\" type=\"button\">25</button>\n        <button data-range=\"50\" type=\"button\">50</button>\n        <button data-range=\"100\" class=\"active\" type=\"button\">100</button>\n        <button data-range=\"150\" type=\"button\">150</button>\n        <button data-range=\"250\" type=\"button\">250</button>\n      </div>\n      <div class=\"bar-sep\"></div>\n      <div class=\"bar-stat\"><strong id=\"barAircraft\">\u2014</strong><span>ACFT</span></div>\n      <div class=\"bar-stat optional\"><strong id=\"barMetar\">\u2014</strong><span>METAR</span></div>\n      <div class=\"bar-stat optional\"><strong id=\"barPirep\">\u2014</strong><span>PIREP</span></div>\n      <div class=\"bar-spacer\"></div>\n      <button id=\"zoomOut\" class=\"map-btn\" type=\"button\" aria-label=\"Zoom out\">\u2212</button>\n      <button id=\"zoomIn\" class=\"map-btn\" type=\"button\" aria-label=\"Zoom in\">+</button>\n      <button id=\"fitRange\" class=\"map-btn\" type=\"button\" aria-label=\"Fit selected range\">\u25ce</button>\n    </div>\n\n    <div id=\"toast\" class=\"toast\"></div>\n    <button id=\"cleanReturn\" class=\"btn clean-return\" type=\"button\">SHOW CONTROLS</button>\n  </section>\n</main>\n\n<dialog id=\"commandDialog\" class=\"command\">\n  <div class=\"command-head\"><input id=\"commandInput\" class=\"command-input\" autocomplete=\"off\" placeholder=\"Search aircraft or run a command\u2026\"></div>\n  <div id=\"commandList\" class=\"command-list\"></div>\n</dialog>\n\n<script type=\"module\">\nimport * as maplibregl from \"https://unpkg.com/maplibre-gl@6.1.0/dist/maplibre-gl.mjs\";\n\n(function(){\n\"use strict\";\n\nvar CENTER=[-83.5603,45.0781];\nvar TRAFFIC_POLL=20000;\nvar WEATHER_POLL=120000;\nvar MICH_COORDS=[[-91.10252, 47.59131], [-81.83658, 47.59131], [-81.83658, 41.23557], [-91.10252, 41.23557]];\nvar STYLE_URLS={\n  dark:\"https://tiles.openfreemap.org/styles/dark\",\n  light:\"https://tiles.openfreemap.org/styles/positron\",\n  liberty:\"https://tiles.openfreemap.org/styles/liberty\"\n};\nvar state={\n  range:100,base:\"liberty\",chartOpacity:.76,satellite:false,satelliteOpacity:.88,\n  radar:false,radarOpacity:.66,radarLoop:false,metars:true,pireps:true,advisories:true,\n  rings:true,labels:\"full\",trafficFilter:\"all\",altFilter:\"all\",vectors:true,clean:false\n};\nvar traffic=[],weather={metars:[],pireps:[],gairmets:{type:\"FeatureCollection\",features:[]},sigmets:{type:\"FeatureCollection\",features:[]}};\nvar selected=null,selectedTrace=null,selectedRoute=null,selectedToken=0;\nvar selectedAirport=null,airportTraffic=[],airportToken=0,airports=[];\nvar cameraMode=\"free\",cameraProgrammatic=false;\nvar lastTrafficAt=0,lastWeatherAt=0,trafficBusy=false,weatherBusy=false;\nvar trafficTimer=null,weatherTimer=null,radarLoopTimer=null,radarFrame=5;\nvar panelTab=\"base\";\nvar prefsKey=\"alt-ops-v50\";\n\nfunction $(id){return document.getElementById(id)}\nfunction escapeHtml(s){return String(s==null?\"\":s).replace(/[&<>\"']/g,function(c){return({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#039;\"})[c]})}\nfunction clamp(v,a,b){return Math.max(a,Math.min(b,v))}\nfunction saveState(){try{localStorage.setItem(prefsKey,JSON.stringify(state))}catch(e){}}\nfunction loadState(){try{var p=JSON.parse(localStorage.getItem(prefsKey)||\"null\");if(p)Object.keys(state).forEach(function(k){if(p[k]!==undefined)state[k]=p[k]})}catch(e){}}\nfunction toast(text,bad){\n  var t=$(\"toast\");if(!text){t.style.display=\"none\";return}\n  t.className=\"toast\"+(bad?\" bad\":\"\");t.textContent=text;t.style.display=\"block\";\n  clearTimeout(toast._timer);toast._timer=setTimeout(function(){t.style.display=\"none\"},4300)\n}\nfunction setStatus(kind,text){\n  $(\"statusDot\").className=\"status-dot\"+(kind?\" \"+kind:\"\");$(\"statusText\").textContent=text\n}\nfunction aircraftName(a){return(a.flight&&String(a.flight).trim())||a.r||(a.hex?String(a.hex).toUpperCase():\"UNKNOWN\")}\nfunction altitude(a){\n  if(a.alt_baro===\"ground\")return\"GROUND\";\n  var n=Number(a.alt_baro!=null?a.alt_baro:a.alt_geom);return Number.isFinite(n)?Math.round(n).toLocaleString()+\" ft\":\"\u2014\"\n}\nfunction altitudeNumber(a){var n=Number(a.alt_baro!=null?a.alt_baro:a.alt_geom);return Number.isFinite(n)?n:null}\nfunction aircraftAge(a){var n=Number(a.seen_pos!=null?a.seen_pos:a.seen);return Number.isFinite(n)?Math.max(0,n):0}\nfunction isAirline(a){return/^[A-Z]{3}\\d+[A-Z]?$/.test((a.flight||\"\").trim())}\nfunction flightCategoryColor(cat){\n  cat=String(cat||\"\").toUpperCase();\n  return cat===\"VFR\"?\"#3ed083\":cat===\"MVFR\"?\"#4b9dff\":cat===\"IFR\"?\"#ef5d63\":cat===\"LIFR\"?\"#b66cff\":\"#9aadb9\"\n}\nfunction distanceNm(lat1,lon1,lat2,lon2){\n  var R=3440.065,r=function(x){return x*Math.PI/180},p1=r(lat1),p2=r(lat2),dp=r(lat2-lat1),dl=r(lon2-lon1);\n  var h=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);\n  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)))\n}\nfunction destinationPoint(lon,lat,bearingDeg,distanceNmValue){\n  var R=3440.065,d=distanceNmValue/R,br=bearingDeg*Math.PI/180,p1=lat*Math.PI/180,l1=lon*Math.PI/180;\n  var p2=Math.asin(Math.sin(p1)*Math.cos(d)+Math.cos(p1)*Math.sin(d)*Math.cos(br));\n  var l2=l1+Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(p1),Math.cos(d)-Math.sin(p1)*Math.sin(p2));\n  return[(l2*180/Math.PI+540)%360-180,p2*180/Math.PI]\n}\nfunction rangeBounds(nm){\n  var n=destinationPoint(CENTER[0],CENTER[1],0,nm),e=destinationPoint(CENTER[0],CENTER[1],90,nm),\n      s=destinationPoint(CENTER[0],CENTER[1],180,nm),w=destinationPoint(CENTER[0],CENTER[1],270,nm);\n  return[[w[0],s[1]],[e[0],n[1]]]\n}\nfunction cameraPadding(extra){\n  var wide=window.innerWidth>900;\n  var left=56,right=16,top=16,bottom=48;\n  if(wide&&$(\"sidePanel\").classList.contains(\"open\"))left=344;\n  if(wide&&$(\"infoPanel\").classList.contains(\"open\"))right=378;\n  if(extra){left=Math.max(left,extra.left||0);right=Math.max(right,extra.right||0);top=Math.max(top,extra.top||0);bottom=Math.max(bottom,extra.bottom||0)}\n  return{left:left,right:right,top:top,bottom:bottom}\n}\nfunction fitRange(animate){\n  map.fitBounds(rangeBounds(state.range),{padding:cameraPadding(),duration:animate===false?0:420,maxZoom:11,linear:true})\n}\nfunction greatCircle(start,end,steps){\n  steps=steps||64;\n  var lon1=start[0]*Math.PI/180,lat1=start[1]*Math.PI/180,lon2=end[0]*Math.PI/180,lat2=end[1]*Math.PI/180;\n  var d=2*Math.asin(Math.sqrt(Math.sin((lat2-lat1)/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin((lon2-lon1)/2)**2));\n  if(!Number.isFinite(d)||d===0)return[start,end];\n  var out=[];\n  for(var i=0;i<=steps;i++){\n    var f=i/steps,A=Math.sin((1-f)*d)/Math.sin(d),B=Math.sin(f*d)/Math.sin(d);\n    var x=A*Math.cos(lat1)*Math.cos(lon1)+B*Math.cos(lat2)*Math.cos(lon2);\n    var y=A*Math.cos(lat1)*Math.sin(lon1)+B*Math.cos(lat2)*Math.sin(lon2);\n    var z=A*Math.sin(lat1)+B*Math.sin(lat2);\n    out.push([Math.atan2(y,x)*180/Math.PI,Math.atan2(z,Math.sqrt(x*x+y*y))*180/Math.PI])\n  }\n  return out\n}\nfunction styleForBase(base){\n  if(base===\"light\")return STYLE_URLS.light;\n  if(base===\"dark\")return STYLE_URLS.dark;\n  return STYLE_URLS.liberty;\n}\nfunction firstSymbolLayer(){\n  var style=map.getStyle();if(!style||!style.layers)return undefined;\n  var layer=style.layers.find(function(l){return l.type===\"symbol\"});return layer&&layer.id\n}\nfunction addPlaneImage(){\n  if(map.hasImage(\"alt-plane\"))return;\n  var c=document.createElement(\"canvas\");c.width=48;c.height=48;var x=c.getContext(\"2d\");\n  x.translate(24,24);x.fillStyle=\"#f7fbfd\";x.strokeStyle=\"#071019\";x.lineWidth=2;\n  x.beginPath();x.moveTo(0,-17);x.lineTo(4,-4);x.lineTo(17,2);x.lineTo(17,6);x.lineTo(4,4);\n  x.lineTo(3,13);x.lineTo(9,17);x.lineTo(9,20);x.lineTo(0,17);x.lineTo(-9,20);x.lineTo(-9,17);\n  x.lineTo(-3,13);x.lineTo(-4,4);x.lineTo(-17,6);x.lineTo(-17,2);x.lineTo(-4,-4);x.closePath();x.fill();x.stroke();\n  map.addImage(\"alt-plane\",x.getImageData(0,0,48,48))\n}\nfunction emptyFC(){return{type:\"FeatureCollection\",features:[]}}\nfunction safeAddSource(id,source){if(!map.getSource(id))map.addSource(id,source)}\nfunction safeAddLayer(layer,before){if(!map.getLayer(layer.id))map.addLayer(layer,before)}\nfunction installLayers(){\n  addPlaneImage();\n  var before=firstSymbolLayer();\n\n  safeAddSource(\"michigan\",{type:\"image\",url:\"/assets/michigan_chart.webp\",coordinates:MICH_COORDS});\n  safeAddLayer({id:\"michigan\",type:\"raster\",source:\"michigan\",paint:{\"raster-opacity\":state.chartOpacity,\"raster-fade-duration\":0}},before);\n\n  safeAddSource(\"satellite\",{type:\"raster\",tiles:[\"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}\"],tileSize:256});\n  safeAddLayer({id:\"satellite\",type:\"raster\",source:\"satellite\",paint:{\"raster-opacity\":state.satelliteOpacity}},before);\n\n\n  safeAddSource(\"faa-vfr\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:8,maxzoom:12});\n  safeAddLayer({id:\"faa-vfr\",type:\"raster\",source:\"faa-vfr\",paint:{\"raster-opacity\":0.0,\"raster-fade-duration\":80}},before);\n\n  safeAddSource(\"faa-terminal\",{type:\"raster\",tiles:[\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile/{z}/{y}/{x}\"],tileSize:256,minzoom:10,maxzoom:12});\n  safeAddLayer({id:\"faa-terminal\",type:\"raster\",source:\"faa-terminal\",paint:{\"raster-opacity\":0.0,\"raster-fade-duration\":80}},before);\n\n  safeAddSource(\"airports\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"airport-small\",type:\"circle\",source:\"airports\",minzoom:8,filter:[\"==\",[\"get\",\"major\"],false],paint:{\n    \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],8,2.5,12,4],\n    \"circle-color\":\"#0a141c\",\"circle-stroke-color\":\"#9fb0ba\",\"circle-stroke-width\":1.1,\"circle-opacity\":0.94\n  }});\n  safeAddLayer({id:\"airport-major\",type:\"circle\",source:\"airports\",paint:{\n    \"circle-radius\":[\"interpolate\",[\"linear\"],[\"zoom\"],5,3,10,5],\n    \"circle-color\":\"#0a141c\",\n    \"circle-stroke-color\":[\"case\",[\"==\",[\"get\",\"scheduled\"],true],\"#58c7e8\",\"#c7d2d8\"],\n    \"circle-stroke-width\":[\"case\",[\"==\",[\"get\",\"scheduled\"],true],2,1.4]\n  }});\n  safeAddLayer({id:\"airport-label\",type:\"symbol\",source:\"airports\",minzoom:6,filter:[\"==\",[\"get\",\"major\"],true],layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":[\"interpolate\",[\"linear\"],[\"zoom\"],6,9,10,11],\n    \"text-offset\":[0.9,0],\"text-anchor\":\"left\",\"text-optional\":true\n  },paint:{\"text-color\":\"#dce6eb\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.4}});\n  safeAddLayer({id:\"airport-small-label\",type:\"symbol\",source:\"airports\",minzoom:10,filter:[\"==\",[\"get\",\"major\"],false],layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":9,\"text-offset\":[0.8,0],\"text-anchor\":\"left\",\"text-optional\":true\n  },paint:{\"text-color\":\"#aebfc9\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.2}});\n\n  safeAddSource(\"selected-airport\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"selected-airport-halo\",type:\"circle\",source:\"selected-airport\",paint:{\n    \"circle-radius\":10,\"circle-color\":\"rgba(0,0,0,0)\",\"circle-stroke-color\":\"#58c7e8\",\"circle-stroke-width\":2.2\n  }});\n  safeAddLayer({id:\"selected-airport-label\",type:\"symbol\",source:\"selected-airport\",layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":11,\"text-offset\":[0,1.25],\"text-anchor\":\"top\",\"text-allow-overlap\":true\n  },paint:{\"text-color\":\"#e5f8ff\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.5}});\n\n  safeAddSource(\"airport-traffic\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"airport-ground\",type:\"circle\",source:\"airport-traffic\",filter:[\"==\",[\"get\",\"status\"],\"GROUND\"],paint:{\n    \"circle-radius\":5,\"circle-color\":\"#52d18c\",\"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.5\n  }});\n  safeAddLayer({id:\"airport-traffic-label\",type:\"symbol\",source:\"airport-traffic\",minzoom:9,layout:{\n    \"text-field\":[\"get\",\"label\"],\"text-size\":9.5,\"text-offset\":[1.0,0],\"text-anchor\":\"left\",\"text-optional\":true\n  },paint:{\"text-color\":\"#eef7fa\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.4}});\n\n  safeAddSource(\"goes\",{type:\"raster\",tiles:[\"https://gis.nnvl.noaa.gov/arcgis/rest/services/GOES/GOES_current/ImageServer/tile/{z}/{y}/{x}\"],tileSize:256});\n  safeAddLayer({id:\"goes\",type:\"raster\",source:\"goes\",paint:{\"raster-opacity\":0.28}},before);\n\n  safeAddSource(\"mrms\",{type:\"image\",url:transparentPixel(),coordinates:[[-90,50],[-80,50],[-80,40],[-90,40]]});\n  safeAddLayer({id:\"mrms\",type:\"raster\",source:\"mrms\",paint:{\"raster-opacity\":state.radarOpacity,\"raster-fade-duration\":0}},before);\n\n  safeAddSource(\"advisories\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"advisory-fill\",type:\"fill\",source:\"advisories\",paint:{\"fill-color\":[\"get\",\"color\"],\"fill-opacity\":0.10}});\n  safeAddLayer({id:\"advisory-line\",type:\"line\",source:\"advisories\",paint:{\"line-color\":[\"get\",\"color\"],\"line-width\":1.4,\"line-opacity\":0.85}});\n\n  safeAddSource(\"rings\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"rings\",type:\"line\",source:\"rings\",paint:{\"line-color\":\"#91a9b8\",\"line-width\":[\"case\",[\"==\",[\"get\",\"outer\"],true],1.3,0.8],\"line-opacity\":0.42}});\n\n  safeAddSource(\"route\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"route-shadow\",type:\"line\",source:\"route\",paint:{\"line-color\":\"#071019\",\"line-width\":4.5,\"line-opacity\":0.58}});\n  safeAddLayer({id:\"route-line\",type:\"line\",source:\"route\",paint:{\"line-color\":\"#65b9d8\",\"line-width\":1.8,\"line-dasharray\":[3,2],\"line-opacity\":0.82}});\n\n  safeAddSource(\"selected-trace\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"trace-shadow\",type:\"line\",source:\"selected-trace\",paint:{\"line-color\":\"#071019\",\"line-width\":5.5,\"line-opacity\":0.7}});\n  safeAddLayer({id:\"selected-trace\",type:\"line\",source:\"selected-trace\",paint:{\"line-color\":\"#61d1f0\",\"line-width\":2.4,\"line-opacity\":0.92}});\n\n  safeAddSource(\"route-airports\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"route-airport-dot\",type:\"circle\",source:\"route-airports\",paint:{\"circle-radius\":4.5,\"circle-color\":[\"get\",\"color\"],\"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.5}});\n  safeAddLayer({id:\"route-airport-label\",type:\"symbol\",source:\"route-airports\",layout:{\"text-field\":[\"get\",\"label\"],\"text-size\":10,\"text-offset\":[0,1.1],\"text-anchor\":\"top\",\"text-allow-overlap\":true},paint:{\"text-color\":\"#f3f7f9\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.5}});\n\n  safeAddSource(\"metars\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"metar-circle\",type:\"circle\",source:\"metars\",paint:{\"circle-radius\":4.5,\"circle-color\":[\"get\",\"color\"],\"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.3}});\n  safeAddLayer({id:\"metar-label\",type:\"symbol\",source:\"metars\",layout:{\"text-field\":[\"get\",\"id\"],\"text-size\":9,\"text-offset\":[1,0],\"text-anchor\":\"left\",\"text-optional\":true},paint:{\"text-color\":\"#edf5f8\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.3}});\n\n  safeAddSource(\"pireps\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"pirep-circle\",type:\"circle\",source:\"pireps\",paint:{\"circle-radius\":5,\"circle-color\":[\"get\",\"color\"],\"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1.3}});\n  safeAddLayer({id:\"pirep-label\",type:\"symbol\",source:\"pireps\",layout:{\"text-field\":[\"get\",\"label\"],\"text-size\":8,\"text-offset\":[1,0],\"text-anchor\":\"left\",\"text-optional\":true},paint:{\"text-color\":\"#f5f8fa\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.2}});\n\n  safeAddSource(\"vectors\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"vectors\",type:\"line\",source:\"vectors\",paint:{\"line-color\":\"#a6cad8\",\"line-width\":1.1,\"line-opacity\":0.68}});\n\n  safeAddSource(\"traffic\",{type:\"geojson\",data:emptyFC()});\n  safeAddLayer({id:\"selected-halo\",type:\"circle\",source:\"traffic\",filter:[\"==\",[\"get\",\"selected\"],true],paint:{\"circle-radius\":13,\"circle-color\":\"rgba(0,0,0,0)\",\"circle-stroke-color\":\"#ffc857\",\"circle-stroke-width\":2}});\n  safeAddLayer({id:\"traffic\",type:\"symbol\",source:\"traffic\",layout:{\n    \"icon-image\":\"alt-plane\",\"icon-size\":0.43,\"icon-rotate\":[\"get\",\"track\"],\"icon-rotation-alignment\":\"map\",\"icon-allow-overlap\":true,\n    \"text-field\":[\"get\",\"label\"],\"text-size\":10,\"text-offset\":[1.25,0],\"text-anchor\":\"left\",\"text-optional\":true,\n    \"text-allow-overlap\":false,\"symbol-sort-key\":[\"get\",\"sort\"]\n  },paint:{\"text-color\":\"#f4f7f9\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.5}});\n\n  safeAddSource(\"kapn\",{type:\"geojson\",data:{type:\"FeatureCollection\",features:[{type:\"Feature\",properties:{label:\"KAPN\"},geometry:{type:\"Point\",coordinates:CENTER}}]}});\n  safeAddLayer({id:\"kapn-dot\",type:\"circle\",source:\"kapn\",paint:{\"circle-radius\":3.5,\"circle-color\":\"#58c7e8\",\"circle-stroke-color\":\"#071019\",\"circle-stroke-width\":1}});\n  safeAddLayer({id:\"kapn-label\",type:\"symbol\",source:\"kapn\",layout:{\"text-field\":\"KAPN\",\"text-size\":9,\"text-offset\":[1,0],\"text-anchor\":\"left\"},paint:{\"text-color\":\"#bdd8e3\",\"text-halo-color\":\"#071019\",\"text-halo-width\":1.2}});\n\n  syncVisibility();syncAllSources();bindLayerEvents();\n}\nfunction transparentPixel(){return\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+X7w5WQAAAABJRU5ErkJggg==\"}\nfunction syncVisibility(){\n  var mich=state.base===\"michigan\";\n  if(map.getLayer(\"michigan\"))map.setLayoutProperty(\"michigan\",\"visibility\",mich?\"visible\":\"none\");\n  if(map.getLayer(\"michigan\"))map.setPaintProperty(\"michigan\",\"raster-opacity\",state.chartOpacity);\n\n  var faaMode=state.base===\"faa\"||state.base===\"aviation\";\n  if(map.getLayer(\"faa-vfr\")){\n    map.setLayoutProperty(\"faa-vfr\",\"visibility\",faaMode?\"visible\":\"none\");\n    map.setPaintProperty(\"faa-vfr\",\"raster-opacity\",state.base===\"faa\"\n      ? [\"interpolate\",[\"linear\"],[\"zoom\"],7.9,0,8,0.96,12,0.96,13,0.68,14,0.36]\n      : [\"interpolate\",[\"linear\"],[\"zoom\"],7.9,0,8,0.48,12,0.52,13,0.32,14,0.16]);\n  }\n  if(map.getLayer(\"faa-terminal\")){\n    map.setLayoutProperty(\"faa-terminal\",\"visibility\",faaMode?\"visible\":\"none\");\n    map.setPaintProperty(\"faa-terminal\",\"raster-opacity\",state.base===\"faa\"?0.98:0.58);\n  }\n  if(map.getLayer(\"satellite\"))map.setLayoutProperty(\"satellite\",\"visibility\",state.base===\"satellite\"?\"visible\":\"none\");\n  if(map.getLayer(\"satellite\"))map.setPaintProperty(\"satellite\",\"raster-opacity\",state.satelliteOpacity);\n  if(map.getLayer(\"goes\"))map.setLayoutProperty(\"goes\",\"visibility\",state.satellite?\"visible\":\"none\");\n  if(map.getLayer(\"mrms\"))map.setLayoutProperty(\"mrms\",\"visibility\",state.radar?\"visible\":\"none\");\n  if(map.getLayer(\"rings\"))map.setLayoutProperty(\"rings\",\"visibility\",state.rings?\"visible\":\"none\");\n  [\"metar-circle\",\"metar-label\"].forEach(function(id){if(map.getLayer(id))map.setLayoutProperty(id,\"visibility\",state.metars?\"visible\":\"none\")});\n  [\"pirep-circle\",\"pirep-label\"].forEach(function(id){if(map.getLayer(id))map.setLayoutProperty(id,\"visibility\",state.pireps?\"visible\":\"none\")});\n  [\"advisory-fill\",\"advisory-line\"].forEach(function(id){if(map.getLayer(id))map.setLayoutProperty(id,\"visibility\",state.advisories?\"visible\":\"none\")});\n  if(map.getLayer(\"vectors\"))map.setLayoutProperty(\"vectors\",\"visibility\",state.vectors?\"visible\":\"none\")\n}\nfunction circleLine(nm,outer){\n  var coords=[];for(var b=0;b<=360;b+=4)coords.push(destinationPoint(CENTER[0],CENTER[1],b,nm));\n  return{type:\"Feature\",properties:{outer:!!outer,range:nm},geometry:{type:\"LineString\",coordinates:coords}}\n}\nfunction ringData(){\n  return{type:\"FeatureCollection\",features:[.25,.5,.75,1].map(function(f){return circleLine(state.range*f,f===1)})}\n}\nfunction labelFor(a){\n  if(state.labels===\"none\")return\"\";\n  if(state.labels===\"callsign\")return aircraftName(a);\n  if(state.labels===\"altitude\")return altitude(a).replace(\" ft\",\"\");\n  var gs=Number(a.gs);return aircraftName(a)+\"\\n\"+altitude(a).replace(\" ft\",\"\")+\" \u00b7 \"+(Number.isFinite(gs)?Math.round(gs)+\"kt\":\"\u2014\")\n}\nfunction matchesTraffic(a){\n  if(state.trafficFilter===\"airline\"&&!isAirline(a))return false;\n  if(state.trafficFilter===\"ga\"&&isAirline(a))return false;\n  var h=altitudeNumber(a);\n  if(state.altFilter===\"low\"&&(h===null||h>=5000))return false;\n  if(state.altFilter===\"mid\"&&(h===null||h<5000||h>15000))return false;\n  if(state.altFilter===\"high\"&&(h===null||h<=15000))return false;\n  return true\n}\nfunction trafficData(){\n  var features=[];\n  traffic.forEach(function(a){\n    if(!matchesTraffic(a)||!Number.isFinite(Number(a.lat))||!Number.isFinite(Number(a.lon)))return;\n    var d=distanceNm(CENTER[1],CENTER[0],Number(a.lat),Number(a.lon));if(d>state.range*1.08)return;\n    var sel=!!(selected&&a.hex===selected.hex),age=aircraftAge(a);\n    features.push({type:\"Feature\",id:a.hex,properties:{\n      hex:a.hex,name:aircraftName(a),label:labelFor(a),track:Number(a.track)||0,selected:sel,sort:sel?0:Math.min(100,age)\n    },geometry:{type:\"Point\",coordinates:[Number(a.lon),Number(a.lat)]}})\n  });\n  return{type:\"FeatureCollection\",features:features}\n}\nfunction vectorData(){\n  var features=[];\n  if(!state.vectors)return{type:\"FeatureCollection\",features:features};\n  traffic.forEach(function(a){\n    if(!matchesTraffic(a)||!Number.isFinite(Number(a.lat))||!Number.isFinite(Number(a.lon)))return;\n    var d=distanceNm(CENTER[1],CENTER[0],Number(a.lat),Number(a.lon));if(d>state.range*1.08)return;\n    var gs=Number(a.gs),tr=Number(a.track);if(!Number.isFinite(gs)||!Number.isFinite(tr)||gs<20)return;\n    var end=destinationPoint(Number(a.lon),Number(a.lat),tr,gs/60);\n    features.push({type:\"Feature\",properties:{hex:a.hex},geometry:{type:\"LineString\",coordinates:[[Number(a.lon),Number(a.lat)],end]}})\n  });\n  return{type:\"FeatureCollection\",features:features}\n}\nfunction metarData(){\n  return{type:\"FeatureCollection\",features:(weather.metars||[]).filter(function(m){return Number.isFinite(Number(m.lat))&&Number.isFinite(Number(m.lon))}).map(function(m){\n    return{type:\"Feature\",properties:{id:m.icaoId||\"\",color:flightCategoryColor(m.fltCat),raw:JSON.stringify(m)},geometry:{type:\"Point\",coordinates:[Number(m.lon),Number(m.lat)]}}\n  })}\n}\nfunction pirepSeverity(p){\n  var t=[p.tbInt1,p.tbInt2,p.icgInt1,p.icgInt2,p.rawOb,p.rawText].filter(Boolean).join(\" \").toUpperCase();\n  if(t.includes(\"SEV\")||t.includes(\"EXTM\"))return{color:\"#ef6973\",label:\"SEV\"};\n  if(t.includes(\"MOD\"))return{color:\"#ef9c4c\",label:\"MOD\"};\n  if(t.includes(\"LGT\")||t.includes(\"TRC\"))return{color:\"#f0c35a\",label:\"LGT\"};\n  return{color:\"#58c7e8\",label:\"PIREP\"}\n}\nfunction pirepData(){\n  return{type:\"FeatureCollection\",features:(weather.pireps||[]).filter(function(p){return Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))}).map(function(p){\n    var sev=pirepSeverity(p);return{type:\"Feature\",properties:{color:sev.color,label:sev.label,raw:JSON.stringify(p)},geometry:{type:\"Point\",coordinates:[Number(p.lon),Number(p.lat)]}}\n  })}\n}\nfunction advisoryData(){\n  var out=[];\n  function push(fc,kind){\n    (fc&&Array.isArray(fc.features)?fc.features:[]).forEach(function(f){\n      var p=Object.assign({},f.properties||{}),h=String(p.hazard||p.hazardType||p.type||kind).toUpperCase();\n      p.kind=kind;p.color=kind===\"SIGMET\"||h.includes(\"CONV\")||h.includes(\"TS\")?\"#ef6973\":h.includes(\"ICE\")?\"#58c7e8\":h.includes(\"TURB\")?\"#ef9c4c\":h.includes(\"IFR\")?\"#b66cff\":\"#c7aa54\";\n      out.push({type:\"Feature\",properties:p,geometry:f.geometry})\n    })\n  }\n  push(weather.gairmets,\"G-AIRMET\");push(weather.sigmets,\"SIGMET\");return{type:\"FeatureCollection\",features:out}\n}\n\nfunction airportData(){\n  return{\n    type:\"FeatureCollection\",\n    features:airports.map(function(a){\n      var major=!!(a.scheduled||a.type===\"large_airport\"||a.type===\"medium_airport\");\n      return{\n        type:\"Feature\",\n        properties:{\n          ident:a.ident,label:a.iata||a.icao||a.gps||a.ident,\n          name:a.name,municipality:a.municipality||\"\",type:a.type,\n          elevationFt:a.elevationFt||0,scheduled:!!a.scheduled,major:major,\n          iata:a.iata||\"\",icao:a.icao||\"\",gps:a.gps||\"\",local:a.local||\"\"\n        },\n        geometry:{type:\"Point\",coordinates:[Number(a.lon),Number(a.lat)]}\n      }\n    })\n  }\n}\nfunction selectedAirportData(){\n  if(!selectedAirport)return emptyFC();\n  return{type:\"FeatureCollection\",features:[{\n    type:\"Feature\",properties:{label:selectedAirport.iata||selectedAirport.icao||selectedAirport.gps||selectedAirport.ident},\n    geometry:{type:\"Point\",coordinates:[selectedAirport.lon,selectedAirport.lat]}\n  }]}\n}\nfunction angleDiff(a,b){\n  var d=Math.abs(((a-b+540)%360)-180);return d\n}\nfunction bearingBetween(lat1,lon1,lat2,lon2){\n  var r=function(x){return x*Math.PI/180},D=function(x){return x*180/Math.PI};\n  var p1=r(lat1),p2=r(lat2),dl=r(lon2-lon1);\n  var y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);\n  return(D(Math.atan2(y,x))+360)%360\n}\nfunction movementFor(a,ap){\n  var lat=Number(a.lat),lon=Number(a.lon),d=distanceNm(ap.lat,ap.lon,lat,lon);\n  var gs=Number(a.gs),vr=Number(a.baro_rate),track=Number(a.track);\n  var ground=a.alt_baro===\"ground\"||(d<2.5&&Number.isFinite(gs)&&gs<45);\n  if(ground)return{status:\"GROUND\",distance:d};\n\n  if(Number.isFinite(track)){\n    var toward=bearingBetween(lat,lon,ap.lat,ap.lon),away=bearingBetween(ap.lat,ap.lon,lat,lon);\n    if(d<=35&&angleDiff(track,toward)<=50&&(vr<-100||d<12))return{status:\"ARRIVING\",distance:d};\n    if(d<=25&&angleDiff(track,away)<=55&&(vr>100||d<8))return{status:\"DEPARTING\",distance:d};\n  }\n  return{status:\"NEARBY\",distance:d}\n}\nfunction airportTrafficData(){\n  if(!selectedAirport)return emptyFC();\n  return{\n    type:\"FeatureCollection\",\n    features:airportTraffic.filter(function(a){return Number.isFinite(Number(a.lat))&&Number.isFinite(Number(a.lon))}).map(function(a){\n      var mv=movementFor(a,selectedAirport);\n      return{\n        type:\"Feature\",\n        properties:{hex:a.hex||\"\",label:aircraftName(a),status:mv.status},\n        geometry:{type:\"Point\",coordinates:[Number(a.lon),Number(a.lat)]}\n      }\n    })\n  }\n}\n\nfunction syncAllSources(){\n  if(map.getSource(\"rings\"))map.getSource(\"rings\").setData(ringData());\n  if(map.getSource(\"traffic\"))map.getSource(\"traffic\").setData(trafficData());\n  if(map.getSource(\"vectors\"))map.getSource(\"vectors\").setData(vectorData());\n  if(map.getSource(\"metars\"))map.getSource(\"metars\").setData(metarData());\n  if(map.getSource(\"pireps\"))map.getSource(\"pireps\").setData(pirepData());\n  if(map.getSource(\"advisories\"))map.getSource(\"advisories\").setData(advisoryData());\n  if(map.getSource(\"airports\"))map.getSource(\"airports\").setData(airportData());\n  if(map.getSource(\"selected-airport\"))map.getSource(\"selected-airport\").setData(selectedAirportData());\n  if(map.getSource(\"airport-traffic\"))map.getSource(\"airport-traffic\").setData(airportTrafficData());\n  syncSelectedSources()\n}\nfunction syncSelectedSources(){\n  if(map.getSource(\"selected-trace\")){\n    var coords=selectedTrace&&Array.isArray(selectedTrace.points)?selectedTrace.points.map(function(p){return[p.lon,p.lat]}):[];\n    map.getSource(\"selected-trace\").setData({type:\"FeatureCollection\",features:coords.length>1?[{type:\"Feature\",properties:{},geometry:{type:\"LineString\",coordinates:coords}}]:[]})\n  }\n  var routeFeatures=[],airportFeatures=[];\n  if(selectedRoute&&selectedRoute.route&&selected&&Number.isFinite(Number(selected.lon))&&Number.isFinite(Number(selected.lat))){\n    var dest=selectedRoute.route.destination,orig=selectedRoute.route.origin;\n    if(dest&&Number.isFinite(dest.lon)&&Number.isFinite(dest.lat)){\n      routeFeatures.push({type:\"Feature\",properties:{},geometry:{type:\"LineString\",coordinates:greatCircle([Number(selected.lon),Number(selected.lat)],[dest.lon,dest.lat],72)}});\n      airportFeatures.push({type:\"Feature\",properties:{label:dest.iata||dest.icao||\"DEST\",color:\"#58c7e8\"},geometry:{type:\"Point\",coordinates:[dest.lon,dest.lat]}})\n    }\n    if(orig&&Number.isFinite(orig.lon)&&Number.isFinite(orig.lat))airportFeatures.push({type:\"Feature\",properties:{label:orig.iata||orig.icao||\"ORIG\",color:\"#8da0ae\"},geometry:{type:\"Point\",coordinates:[orig.lon,orig.lat]}})\n  }\n  if(map.getSource(\"route\"))map.getSource(\"route\").setData({type:\"FeatureCollection\",features:routeFeatures});\n  if(map.getSource(\"route-airports\"))map.getSource(\"route-airports\").setData({type:\"FeatureCollection\",features:airportFeatures})\n}\nfunction setBase(base){\n  state.base=base;saveState();\n  var style=styleForBase(base);\n  if(map.getStyle()&&map.getStyle().metadata&&map.getStyle().metadata._altStyle===style){syncVisibility();renderPanel();return}\n  map.setStyle(style,{diff:false})\n}\nfunction afterStyleLoad(){\n  if(map.getStyle())map.getStyle().metadata=Object.assign({},map.getStyle().metadata||{},{_altStyle:styleForBase(state.base)});\n  installLayers();syncVisibility();if(state.radar)updateRadarImage();renderPanel()\n}\nfunction setSourceData(id,data){var s=map.getSource(id);if(s&&s.setData)s.setData(data)}\nfunction bindLayerEvents(){\n  if(bindLayerEvents.done)return;bindLayerEvents.done=true;\n  map.on(\"click\",\"traffic\",function(e){if(e.features&&e.features[0]){var h=e.features[0].properties.hex,a=traffic.find(function(x){return x.hex===h});if(a)selectAircraft(a)}});\n  map.on(\"mouseenter\",\"traffic\",function(){map.getCanvas().style.cursor=\"pointer\"});\n  map.on(\"mouseleave\",\"traffic\",function(){map.getCanvas().style.cursor=\"\"});\n  map.on(\"click\",\"metar-circle\",function(e){if(!e.features||!e.features[0])return;try{showMetar(JSON.parse(e.features[0].properties.raw))}catch(err){}});\n  map.on(\"click\",\"pirep-circle\",function(e){if(!e.features||!e.features[0])return;try{showPirep(JSON.parse(e.features[0].properties.raw))}catch(err){}});\n  map.on(\"click\",\"advisory-fill\",function(e){if(e.features&&e.features[0])showAdvisory(e.features[0].properties)});\n  [\"airport-major\",\"airport-small\",\"airport-label\",\"airport-small-label\"].forEach(function(layerId){\n    map.on(\"click\",layerId,function(e){\n      if(!e.features||!e.features[0])return;\n      var ident=e.features[0].properties.ident;\n      var ap=airports.find(function(a){return a.ident===ident});\n      if(ap)selectAirport(ap);\n    });\n    map.on(\"mouseenter\",layerId,function(){map.getCanvas().style.cursor=\"pointer\"});\n    map.on(\"mouseleave\",layerId,function(){map.getCanvas().style.cursor=\"\"});\n  });\n}\nfunction updateRadarImage(timeMs){\n  if(!state.radar||!map.getSource(\"mrms\"))return;\n  var b=map.getBounds(),nw=[b.getWest(),b.getNorth()],ne=[b.getEast(),b.getNorth()],se=[b.getEast(),b.getSouth()],sw=[b.getWest(),b.getSouth()];\n  function merc(lon,lat){var R=6378137,x=R*lon*Math.PI/180,y=R*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));return[x,y]}\n  var p1=merc(b.getWest(),b.getSouth()),p2=merc(b.getEast(),b.getNorth());\n  var size=map.getContainer(),w=Math.min(1400,Math.max(400,size.clientWidth)),h=Math.min(1000,Math.max(300,size.clientHeight));\n  var q=\"bbox=\"+encodeURIComponent([p1[0],p1[1],p2[0],p2[1]].join(\",\"))+\"&bboxSR=3857&imageSR=3857&size=\"+Math.round(w)+\",\"+Math.round(h)+\"&format=png32&transparent=true&f=image\";\n  if(timeMs)q+=\"&time=\"+encodeURIComponent(timeMs);\n  map.getSource(\"mrms\").updateImage({url:\"https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer/exportImage?\"+q,coordinates:[nw,ne,se,sw]})\n}\nfunction setRadarLoop(on){\n  state.radarLoop=!!on;clearInterval(radarLoopTimer);radarLoopTimer=null;radarFrame=5;\n  if(on){\n    radarLoopTimer=setInterval(function(){radarFrame=(radarFrame+1)%6;var t=radarFrame===5?null:Date.now()-(5-radarFrame)*5*60*1000;updateRadarImage(t)},850)\n  }else updateRadarImage(null);\n  saveState();renderPanel()\n}\nfunction renderPanel(){\n  var scroll=$(\"panelScroll\");\n  document.querySelectorAll(\".panel-tab\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.tab===panelTab)});\n  $(\"panelSubtitle\").textContent=panelTab===\"base\"?\"Map and chart presentation\":panelTab===\"weather\"?\"NOAA weather overlays\":\"Traffic symbology and filtering\";\n  if(panelTab===\"base\"){\n    scroll.innerHTML='<section class=\"panel-section\"><div class=\"section-label\">BASE STYLE</div><div class=\"choice-grid\">'+\n      choice(\"liberty\",\"LIBERTY\",\"Detailed vector map \u00b7 default\")+choice(\"aviation\",\"AVIATION HYBRID\",\"Liberty + FAA VFR overlays\")+choice(\"faa\",\"FAA VFR\",\"Official Sectional + TAC tiles\")+choice(\"michigan\",\"MICHIGAN AERO\",\"2026 MDOT chart\")+choice(\"dark\",\"DARK\",\"OpenFreeMap\")+choice(\"light\",\"POSITRON\",\"OpenFreeMap\")+choice(\"satellite\",\"SATELLITE\",\"Esri imagery\")+\n      '</div></section>'+\n      row(\"Chart opacity\",\"Michigan chart raster\",\"<input id='chartOpacity' class='range-input' type='range' min='25' max='100' value='\"+Math.round(state.chartOpacity*100)+\"'>\")+\n      row(\"Satellite opacity\",\"Esri imagery base\",\"<input id='satOpacity' class='range-input' type='range' min='25' max='100' value='\"+Math.round(state.satelliteOpacity*100)+\"'>\")+\n      '<section class=\"panel-section\" style=\"margin-top:13px\"><div class=\"section-label\">AVIATION REFERENCE</div><div class=\"row-copy\"><strong>FAA VFR tiles</strong><span>Current FAA Sectional charts with Terminal Area Charts where coverage exists. Official tile cache is native MapLibre raster data.</span></div><div class=\"row-copy\" style=\"margin-top:9px\"><strong>Airport catalogue</strong><span>Current public-domain OurAirports regional data. Major airports remain visible at wider zooms; smaller fields appear as you zoom in.</span></div></section>';\n  }else if(panelTab===\"weather\"){\n    scroll.innerHTML=row(\"NOAA MRMS radar\",\"Current composite base reflectivity\",toggle(\"radar\",state.radar))+\n      row(\"Radar opacity\",\"Overlay intensity\",\"<input id='radarOpacity' class='range-input' type='range' min='20' max='100' value='\"+Math.round(state.radarOpacity*100)+\"'>\")+\n      row(\"Radar loop\",\"Six frames \u00b7 ~25 minutes\",toggle(\"radarLoop\",state.radarLoop))+\n      row(\"GOES infrared\",\"NOAA/NESDIS cloud imagery\",toggle(\"satellite\",state.satellite))+\n      row(\"METARs\",\"Flight category points\",toggle(\"metars\",state.metars))+\n      row(\"PIREPs\",\"Pilot reports\",toggle(\"pireps\",state.pireps))+\n      row(\"Advisories\",\"SIGMETs & G-AIRMETs\",toggle(\"advisories\",state.advisories));\n  }else{\n    scroll.innerHTML=row(\"Range rings\",\"Centered on KAPN\",toggle(\"rings\",state.rings))+\n      row(\"Track vectors\",\"One-minute projection\",toggle(\"vectors\",state.vectors))+\n      row(\"Labels\",\"Collision-managed aircraft labels\",selectHtml(\"labels\",state.labels,[[\"full\",\"FULL\"],[\"callsign\",\"CALLSIGN\"],[\"altitude\",\"ALTITUDE\"],[\"none\",\"NONE\"]]))+\n      row(\"Traffic\",\"Display filter\",selectHtml(\"trafficFilter\",state.trafficFilter,[[\"all\",\"ALL\"],[\"airline\",\"AIRLINE\"],[\"ga\",\"GA\"]]))+\n      row(\"Altitude\",\"Display filter\",selectHtml(\"altFilter\",state.altFilter,[[\"all\",\"ALL\"],[\"low\",\"<5K\"],[\"mid\",\"5\u201315K\"],[\"high\",\">15K\"]]))+\n      '<section class=\"panel-section\" style=\"margin-top:12px\"><div class=\"section-label\">SELECTED FLIGHT</div><div class=\"row-copy\"><strong>Full current-leg trail</strong><span>Fetched from TheAirTraffic/HPRadar only when an aircraft is selected. No global trail clutter.</span></div></section>';\n  }\n  bindPanelInputs()\n}\nfunction choice(id,title,sub){return\"<button class='choice\"+(state.base===id?\" active\":\"\")+\"' data-base='\"+id+\"' type='button'><strong>\"+title+\"</strong><span>\"+sub+\"</span></button>\"}\nfunction row(title,sub,control){return\"<div class='row'><div class='row-copy'><strong>\"+title+\"</strong><span>\"+sub+\"</span></div>\"+control+\"</div>\"}\nfunction toggle(id,on){return\"<label class='switch'><input data-toggle='\"+id+\"' type='checkbox'\"+(on?\" checked\":\"\")+\"><span class='switch-track'></span></label>\"}\nfunction selectHtml(id,val,opts){return\"<select data-select='\"+id+\"' class='small-select'>\"+opts.map(function(o){return\"<option value='\"+o[0]+\"'\"+(o[0]===val?\" selected\":\"\")+\">\"+o[1]+\"</option>\"}).join(\"\")+\"</select>\"}\nfunction bindPanelInputs(){\n  document.querySelectorAll(\".choice[data-base]\").forEach(function(b){b.onclick=function(){setBase(b.dataset.base)}});\n  document.querySelectorAll(\"[data-toggle]\").forEach(function(i){i.onchange=function(){\n    var k=i.dataset.toggle;state[k]=i.checked;\n    if(k===\"radarLoop\")setRadarLoop(i.checked);\n    else{saveState();syncVisibility();syncAllSources();if(k===\"radar\"&&i.checked)updateRadarImage();if(k===\"radar\"&&!i.checked)setRadarLoop(false)}\n  }});\n  document.querySelectorAll(\"[data-select]\").forEach(function(s){s.onchange=function(){state[s.dataset.select]=s.value;saveState();syncAllSources()}});\n  var c=$(\"chartOpacity\");if(c)c.oninput=function(){state.chartOpacity=Number(c.value)/100;saveState();syncVisibility()};\n  var so=$(\"satOpacity\");if(so)so.oninput=function(){state.satelliteOpacity=Number(so.value)/100;saveState();syncVisibility()};\n  var ro=$(\"radarOpacity\");if(ro)ro.oninput=function(){state.radarOpacity=Number(ro.value)/100;if(map.getLayer(\"mrms\"))map.setPaintProperty(\"mrms\",\"raster-opacity\",state.radarOpacity);saveState()}\n}\nfunction openPanel(tab){\n  panelTab=tab||panelTab;$(\"sidePanel\").classList.add(\"open\");document.querySelectorAll(\".rail-btn[data-open-tab]\").forEach(function(b){b.classList.toggle(\"active\",b.dataset.openTab===panelTab)});\n  renderPanel();map.easeTo({padding:cameraPadding(),duration:180})\n}\nfunction closePanel(){\n  $(\"sidePanel\").classList.remove(\"open\");document.querySelectorAll(\".rail-btn[data-open-tab]\").forEach(function(b){b.classList.remove(\"active\")});map.easeTo({padding:cameraPadding(),duration:180})\n}\nfunction metric(label,value){return\"<div class='metric'><span>\"+escapeHtml(label)+\"</span><strong>\"+escapeHtml(value==null?\"\u2014\":value)+\"</strong></div>\"}\nfunction routeCard(){\n  if(!selectedRoute||!selectedRoute.route)return\"<div class='route-card'><div class='route-note'>ROUTE NOT AVAILABLE \u00b7 The destination line is only shown when the callsign can be matched to a route.</div></div>\";\n  var r=selectedRoute.route,o=r.origin,d=r.destination;\n  return\"<div class='route-card'><div class='route-line'><div class='airport'><strong>\"+escapeHtml(o&&(o.iata||o.icao)||\"\u2014\")+\"</strong><span>\"+escapeHtml(o&&(o.location||o.name)||\"Origin\")+\"</span></div><div class='route-arrow'>\u2192</div><div class='airport'><strong>\"+escapeHtml(d&&(d.iata||d.icao)||\"\u2014\")+\"</strong><span>\"+escapeHtml(d&&(d.location||d.name)||\"Destination\")+\"</span></div></div><div class='route-note'>\"+escapeHtml(r.iataCodes||r.airportCodes||\"Route lookup\")+(r.plausible===true?\" \u00b7 PLAUSIBLE ROUTE\":\"\")+\"</div></div>\"\n}\n\nfunction airportCode(ap){return ap.iata||ap.icao||ap.gps||ap.ident}\nfunction airportMetar(ap){\n  var code=ap.icao||ap.gps||ap.ident;\n  return(weather.metars||[]).find(function(m){return String(m.icaoId||\"\").toUpperCase()===String(code||\"\").toUpperCase()})||null\n}\nfunction movementCounts(){\n  var counts={GROUND:0,ARRIVING:0,DEPARTING:0,NEARBY:0};\n  if(!selectedAirport)return counts;\n  airportTraffic.forEach(function(a){counts[movementFor(a,selectedAirport).status]++});\n  return counts\n}\nfunction renderAirportInfo(){\n  if(!selectedAirport)return;\n  $(\"infoTitle\").textContent=airportCode(selectedAirport);\n  $(\"infoSub\").textContent=[selectedAirport.name,selectedAirport.municipality].filter(Boolean).join(\" \u00b7 \");\n  $(\"infoLoading\").style.display=\"none\";\n  var m=airportMetar(selectedAirport),counts=movementCounts();\n  var rows=airportTraffic.map(function(a){\n    var mv=movementFor(a,selectedAirport);\n    return{a:a,mv:mv}\n  }).sort(function(x,y){\n    var order={GROUND:0,ARRIVING:1,DEPARTING:2,NEARBY:3};\n    return order[x.mv.status]-order[y.mv.status]||x.mv.distance-y.mv.distance\n  }).slice(0,18);\n\n  var body=\n    \"<div style='display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px'><span class='airport-badge \"+(selectedAirport.scheduled?\"scheduled\":\"\")+\"'>\"+(selectedAirport.scheduled?\"SCHEDULED SERVICE\":\"AIRPORT\")+\"</span><span class='airport-badge'>\"+escapeHtml(selectedAirport.type.replace(\"_\",\" \").toUpperCase())+\"</span></div>\"+\n    \"<div class='metrics'>\"+\n      metric(\"FIELD ELEVATION\",selectedAirport.elevationFt?selectedAirport.elevationFt.toLocaleString()+\" ft\":\"\u2014\")+\n      metric(\"REGION\",selectedAirport.region||\"\u2014\")+\n      metric(\"METAR\",m?(m.fltCat||\"REPORTING\"):\"NO REPORT\")+\n      metric(\"WIND\",m&&Number.isFinite(Number(m.wspd))?(m.wdir||\"VRB\")+\"\u00b0 / \"+m.wspd+\" kt\":\"\u2014\")+\n    \"</div>\"+\n    \"<div class='movement-summary'>\"+\n      \"<div><strong>\"+counts.GROUND+\"</strong><span>GROUND</span></div>\"+\n      \"<div><strong>\"+counts.ARRIVING+\"</strong><span>ARRIVING</span></div>\"+\n      \"<div><strong>\"+counts.DEPARTING+\"</strong><span>DEPARTING</span></div>\"+\n      \"<div><strong>\"+counts.NEARBY+\"</strong><span>NEARBY</span></div>\"+\n    \"</div>\"+\n    \"<div class='info-section'><h4>LIVE AIRPORT MOVEMENTS</h4><div class='movement-board'>\"+\n    rows.map(function(item){\n      var a=item.a,mv=item.mv;\n      return\"<button class='movement-row' data-aircraft='\"+escapeHtml(a.hex||\"\")+\"' type='button'><span class='movement-status \"+mv.status+\"'>\"+mv.status+\"</span><span class='movement-main'><strong>\"+escapeHtml(aircraftName(a))+\"</strong><span>\"+escapeHtml([a.r,a.t].filter(Boolean).join(\" \u00b7 \"))+\"</span></span><span class='movement-side'><strong>\"+mv.distance.toFixed(1)+\" NM</strong><span>\"+escapeHtml(altitude(a))+\"</span></span></button>\"\n    }).join(\"\")+\n    \"</div><div class='route-note'>Movement categories are inferred from live ADS-B position, track and vertical rate. This is not an airline schedule.</div></div>\"+\n    \"<div class='info-actions'><button id='fitAirportBtn' class='info-action active' type='button'>AIRPORT VIEW</button><button id='returnAirportKapnBtn' class='info-action' type='button'>KAPN</button></div>\";\n\n  $(\"infoScroll\").innerHTML=body;\n  document.querySelectorAll(\".movement-row\").forEach(function(b){\n    b.onclick=function(){\n      var a=airportTraffic.find(function(x){return x.hex===b.dataset.aircraft});\n      if(a)selectAircraft(a)\n    }\n  });\n  var fa=$(\"fitAirportBtn\");if(fa)fa.onclick=function(){fitAirportView()};\n  var fk=$(\"returnAirportKapnBtn\");if(fk)fk.onclick=function(){selectedAirport=null;airportTraffic=[];syncAllSources();performCamera(\"kapn\",function(){fitRange(true)})}\n}\nfunction fitAirportView(){\n  if(!selectedAirport)return;\n  var bounds=new maplibregl.LngLatBounds();\n  [0,90,180,270].forEach(function(b){bounds.extend(destinationPoint(selectedAirport.lon,selectedAirport.lat,b,7))});\n  performCamera(\"airport\",function(){map.fitBounds(bounds,{padding:cameraPadding({top:30,bottom:50}),duration:450,maxZoom:13})})\n}\nasync function selectAirport(ap){\n  selected=null;selectedTrace=null;selectedRoute=null;selectedToken++;\n  selectedAirport=ap;airportTraffic=[];cameraMode=\"airport\";airportToken++;\n  var token=airportToken;\n  closePanel();\n  $(\"infoPanel\").classList.add(\"open\");\n  $(\"infoLoading\").style.display=\"block\";\n  syncAllSources();\n  renderAirportInfo();\n  fitAirportView();\n\n  try{\n    var res=await fetch(\"/api/traffic?lat=\"+encodeURIComponent(ap.lat)+\"&lon=\"+encodeURIComponent(ap.lon)+\"&radius=35&_=\"+Date.now(),{cache:\"no-store\"});\n    var data=await res.json();\n    if(token!==airportToken)return;\n    if(res.ok&&Array.isArray(data.aircraft))airportTraffic=data.aircraft;\n  }catch(e){}\n  if(token!==airportToken)return;\n  syncAllSources();\n  renderAirportInfo()\n}\n\nfunction renderAircraftInfo(){\n  if(!selected)return;\n  $(\"infoTitle\").textContent=aircraftName(selected);$(\"infoSub\").textContent=[selected.r,selected.t,selected.ownOp].filter(Boolean).join(\" \u00b7 \");\n  var traceText=selectedTrace&&selectedTrace.points?selectedTrace.originalPointCount+\" points \u00b7 \"+formatDuration((selectedTrace.endTime-selectedTrace.startTime)*1000):\"Loading flight history\u2026\";\n  $(\"infoScroll\").innerHTML=routeCard()+\n    \"<div class='metrics'>\"+metric(\"ALTITUDE\",altitude(selected))+metric(\"GROUND SPEED\",Number.isFinite(Number(selected.gs))?Math.round(Number(selected.gs))+\" kt\":\"\u2014\")+\n    metric(\"VERTICAL RATE\",Number.isFinite(Number(selected.baro_rate))?Math.round(Number(selected.baro_rate))+\" fpm\":\"\u2014\")+metric(\"TRACK\",Number.isFinite(Number(selected.track))?Math.round(Number(selected.track))+\"\u00b0\":\"\u2014\")+\n    metric(\"SQUAWK\",selected.squawk||\"\u2014\")+metric(\"POSITION AGE\",Math.round(aircraftAge(selected))+\" sec\")+\"</div>\"+\n    \"<div class='info-section'><h4>FLIGHT TRACK</h4><div class='row-copy'><strong>\"+escapeHtml(traceText)+\"</strong><span>Full current leg is loaded only for this selected aircraft.</span></div></div>\"+\n    \"<div class='info-actions'><button id='fitTrackBtn' class='info-action \"+(cameraMode===\"track\"?\"active\":\"\")+\"' type='button'>FULL TRACK</button><button id='fitRouteBtn' class='info-action \"+(cameraMode===\"route\"?\"active\":\"\")+\"' type='button' \"+(!selectedRoute||!selectedRoute.route?\"disabled\":\"\")+\">ROUTE</button><button id='returnBtn' class='info-action \"+(cameraMode===\"kapn\"?\"active\":\"\")+\"' type='button'>KAPN</button></div>\";\n  var ft=$(\"fitTrackBtn\");if(ft)ft.onclick=fitSelectedTrack;\n  var fr=$(\"fitRouteBtn\");if(fr)fr.onclick=fitSelectedRoute;\n  var rb=$(\"returnBtn\");if(rb)rb.onclick=function(){performCamera(\"kapn\",function(){fitRange(true)})}\n}\nfunction formatDuration(ms){\n  if(!Number.isFinite(ms)||ms<0)return\"\u2014\";var m=Math.round(ms/60000),h=Math.floor(m/60);m%=60;return(h?h+\"h \":\"\")+m+\"m\"\n}\nasync function selectAircraft(a){\n  selectedAirport=null;airportTraffic=[];airportToken++;\n  cameraMode=\"free\";\n  selected=a;selectedTrace=null;selectedRoute=null;selectedToken++;\n  var token=selectedToken;$(\"infoPanel\").classList.add(\"open\");$(\"infoLoading\").style.display=\"block\";\n  closePanel();syncAllSources();renderAircraftInfo();map.easeTo({padding:cameraPadding(),duration:180});\n  var callsign=aircraftName(a),tracePromise=fetch(\"/api/trace?hex=\"+encodeURIComponent(a.hex||\"\"),{cache:\"no-store\"}).then(function(r){return r.json()}),\n      routePromise=fetch(\"/api/route?callsign=\"+encodeURIComponent(callsign)+\"&lat=\"+encodeURIComponent(a.lat)+\"&lon=\"+encodeURIComponent(a.lon),{cache:\"no-store\"}).then(function(r){return r.json()});\n  var results=await Promise.allSettled([tracePromise,routePromise]);if(token!==selectedToken)return;\n  if(results[0].status===\"fulfilled\"&&Array.isArray(results[0].value.points))selectedTrace=results[0].value;\n  if(results[1].status===\"fulfilled\")selectedRoute=results[1].value;\n  $(\"infoLoading\").style.display=\"none\";syncSelectedSources();renderAircraftInfo();\n  if(selectedTrace&&selectedTrace.points&&selectedTrace.points.length>1)fitSelectedTrack()\n}\nfunction closeInfo(){\n  $(\"infoPanel\").classList.remove(\"open\");\n  selected=null;selectedTrace=null;selectedRoute=null;selectedAirport=null;airportTraffic=[];\n  selectedToken++;airportToken++;cameraMode=\"free\";\n  syncAllSources();map.easeTo({padding:cameraPadding(),duration:180})\n}\nfunction boundsFromCoords(coords){\n  if(!coords||!coords.length)return null;var b=new maplibregl.LngLatBounds();coords.forEach(function(c){if(Number.isFinite(c[0])&&Number.isFinite(c[1]))b.extend(c)});return b\n}\n\nfunction performCamera(mode,fn){\n  cameraMode=mode;\n  cameraProgrammatic=true;\n  if(selected)renderAircraftInfo();\n  fn();\n  map.once(\"moveend\",function(){cameraProgrammatic=false})\n}\nfunction clearCameraModeFromUser(){\n  if(cameraProgrammatic)return;\n  if(cameraMode!==\"free\"){\n    cameraMode=\"free\";\n    if(selected)renderAircraftInfo();\n  }\n}\n\nfunction fitSelectedTrack(){\n  if(!selectedTrace||!selectedTrace.points||selectedTrace.points.length<2)return;\n  var b=boundsFromCoords(selectedTrace.points.map(function(p){return[p.lon,p.lat]}));\n  if(b)performCamera(\"track\",function(){map.fitBounds(b,{padding:cameraPadding({top:35,bottom:55}),duration:500,maxZoom:10})})\n}\nfunction fitSelectedRoute(){\n  var coords=[];if(selectedTrace&&selectedTrace.points)coords=coords.concat(selectedTrace.points.map(function(p){return[p.lon,p.lat]}));\n  if(selectedRoute&&selectedRoute.route&&selectedRoute.route.destination&&Number.isFinite(selectedRoute.route.destination.lon))coords.push([selectedRoute.route.destination.lon,selectedRoute.route.destination.lat]);\n  if(selectedRoute&&selectedRoute.route&&selectedRoute.route.origin&&Number.isFinite(selectedRoute.route.origin.lon))coords.push([selectedRoute.route.origin.lon,selectedRoute.route.origin.lat]);\n  var b=boundsFromCoords(coords);\n  if(b)performCamera(\"route\",function(){map.fitBounds(b,{padding:cameraPadding({top:35,bottom:55}),duration:600,maxZoom:9})})\n}\nfunction showMetar(m){\n  new maplibregl.Popup({closeButton:false,offset:10}).setLngLat([Number(m.lon),Number(m.lat)]).setHTML(\"<strong>\"+escapeHtml(m.icaoId||\"METAR\")+\"</strong><br><span style='font-size:10px;color:#9dafba'>\"+escapeHtml(m.fltCat||\"\")+\" \u00b7 \"+escapeHtml(m.rawOb||\"\")+\"</span>\").addTo(map)\n}\nfunction showPirep(p){\n  new maplibregl.Popup({closeButton:false,offset:10}).setLngLat([Number(p.lon),Number(p.lat)]).setHTML(\"<strong>PIREP</strong><br><span style='font-size:10px;color:#9dafba'>\"+escapeHtml(p.rawOb||p.rawText||\"Pilot report\")+\"</span>\").addTo(map)\n}\nfunction showAdvisory(p){toast((p.kind||\"ADVISORY\")+\" \u00b7 \"+(p.hazard||p.hazardType||p.type||\"Weather advisory\"),false)}\n\nasync function loadAirports(){\n  try{\n    var res=await fetch(\"/api/airports\",{cache:\"no-store\"}),data=await res.json();\n    if(res.ok&&Array.isArray(data.airports)){\n      airports=data.airports;\n      if(map.getSource(\"airports\"))map.getSource(\"airports\").setData(airportData());\n    }\n  }catch(e){}\n}\n\nasync function loadTraffic(manual){\n  if(trafficBusy)return;trafficBusy=true;if(manual)$(\"refreshBtn\").disabled=true;\n  try{\n    var res=await fetch(\"/api/traffic?lat=\"+CENTER[1]+\"&lon=\"+CENTER[0]+\"&radius=\"+state.range+\"&_=\"+Date.now(),{cache:\"no-store\"}),data=await res.json();\n    if(!res.ok)throw new Error((data.errors||[]).join(\" | \")||data.error||(\"HTTP \"+res.status));\n    traffic=Array.isArray(data.aircraft)?data.aircraft:[];lastTrafficAt=Date.parse(data.generatedAt||\"\")||Date.now();\n    setStatus(data.stale?\"\":\"good\",(data.stale?\"HOLDING \u00b7 \":\"LIVE \u00b7 \")+(data.source||\"ADS-B\").toUpperCase());syncAllSources();\n    if(selected){var fresh=traffic.find(function(a){return a.hex===selected.hex});if(fresh){selected=fresh;renderAircraftInfo()}}\n  }catch(e){\n    if(traffic.length){setStatus(\"\",\"HOLDING LAST GOOD DATA\");toast(\"Traffic refresh missed. Existing targets remain on screen.\",false)}\n    else{setStatus(\"bad\",\"TRAFFIC OFFLINE\");toast(String(e.message||e),true)}\n  }finally{trafficBusy=false;if(manual)$(\"refreshBtn\").disabled=false}\n}\nasync function loadWeather(){\n  if(weatherBusy)return;weatherBusy=true;\n  try{\n    var res=await fetch(\"/api/weather?_=\"+Date.now(),{cache:\"no-store\"}),data=await res.json();if(!res.ok)throw new Error(data.error||(\"HTTP \"+res.status));\n    weather={metars:Array.isArray(data.metars)?data.metars:[],pireps:Array.isArray(data.pireps)?data.pireps:[],gairmets:data.gairmets||emptyFC(),sigmets:data.sigmets||emptyFC()};\n    lastWeatherAt=Date.parse(data.generatedAt||\"\")||Date.now();syncAllSources()\n  }catch(e){}finally{weatherBusy=false}\n}\nfunction updateStats(){\n  var now=Date.now(),age=lastTrafficAt?Math.max(0,Math.round((now-lastTrafficAt)/1000))+\"s\":\"\u2014\",wx=lastWeatherAt?Math.max(0,Math.round((now-lastWeatherAt)/1000))+\"s\":\"\u2014\";\n  var count=trafficData().features.length;$(\"topAircraft\").textContent=count;$(\"barAircraft\").textContent=count;$(\"topAge\").textContent=age;$(\"topWx\").textContent=wx;\n  $(\"barMetar\").textContent=(weather.metars||[]).length;$(\"barPirep\").textContent=(weather.pireps||[]).length\n}\nfunction openCommand(){\n  var d=$(\"commandDialog\");if(!d.open)d.showModal();$(\"commandInput\").value=\"\";renderCommands(\"\");setTimeout(function(){$(\"commandInput\").focus()},0)\n}\nfunction commandCatalog(){\n  var commands=[\n    {title:\"Open map layers\",sub:\"Liberty, Aviation Hybrid, FAA VFR and Michigan\",run:function(){openPanel(\"base\")}},\n    {title:\"Open weather layers\",sub:\"MRMS radar, GOES, METARs and advisories\",run:function(){openPanel(\"weather\")}},\n    {title:\"Open traffic settings\",sub:\"Labels, vectors and filters\",run:function(){openPanel(\"traffic\")}},\n    {title:\"Return to KAPN\",sub:\"Fit the selected range rings\",run:function(){fitRange(true)}},\n    {title:\"Toggle NOAA radar\",sub:state.radar?\"Turn radar off\":\"Turn radar on\",run:function(){state.radar=!state.radar;saveState();syncVisibility();if(state.radar)updateRadarImage();renderPanel()}},\n    {title:\"Toggle clean view\",sub:\"Hide or restore application chrome\",run:function(){setClean(!state.clean)}}\n  ];\n  [25,50,100,150,250].forEach(function(r){commands.push({title:\"Set range to \"+r+\" NM\",sub:\"Fit KAPN range\",run:function(){setRange(r)}})});\n  traffic.slice(0,40).forEach(function(a){commands.push({title:aircraftName(a),sub:[a.r,a.t,altitude(a)].filter(Boolean).join(\" \u00b7 \"),aircraft:a,run:function(){selectAircraft(a)}})});\n  return commands\n}\nfunction renderCommands(q){\n  q=String(q||\"\").trim().toLowerCase();var list=$(\"commandList\");list.replaceChildren();\n  var items=commandCatalog().filter(function(c){return!q||(c.title+\" \"+c.sub).toLowerCase().includes(q)}).slice(0,18);\n  var label=document.createElement(\"div\");label.className=\"command-group\";label.textContent=q?\"RESULTS\":\"QUICK ACTIONS\";list.appendChild(label);\n  items.forEach(function(c){\n    var b=document.createElement(\"button\");b.type=\"button\";b.className=\"command-item\";\n    b.innerHTML=\"<div><strong>\"+escapeHtml(c.title)+\"</strong><span>\"+escapeHtml(c.sub||\"\")+\"</span></div>\"+(c.aircraft?\"<span class='command-key'>AIRCRAFT</span>\":\"\");\n    b.onclick=function(){$(\"commandDialog\").close();c.run()};list.appendChild(b)\n  })\n}\nfunction setRange(r){state.range=Number(r);saveState();document.querySelectorAll(\"[data-range]\").forEach(function(b){b.classList.toggle(\"active\",Number(b.dataset.range)===state.range)});syncAllSources();fitRange(true);loadTraffic(false)}\nfunction setClean(on){state.clean=!!on;saveState();document.body.classList.toggle(\"clean\",state.clean);$(\"app\").classList.toggle(\"clean\",state.clean);setTimeout(function(){map.resize()},50)}\nfunction bindUI(){\n  document.querySelectorAll(\"[data-open-tab]\").forEach(function(b){b.onclick=function(){openPanel(b.dataset.openTab)}});\n  document.querySelectorAll(\".panel-tab\").forEach(function(b){b.onclick=function(){panelTab=b.dataset.tab;renderPanel()}});\n  document.querySelectorAll(\"[data-range]\").forEach(function(b){b.onclick=function(){setRange(b.dataset.range)}});\n  $(\"sideClose\").onclick=closePanel;$(\"infoClose\").onclick=closeInfo;$(\"homeBtn\").onclick=function(){fitRange(true)};\n  $(\"fitRange\").onclick=function(){fitRange(true)};$(\"zoomIn\").onclick=function(){map.zoomIn({duration:160})};$(\"zoomOut\").onclick=function(){map.zoomOut({duration:160})};\n  $(\"commandBtn\").onclick=openCommand;$(\"commandInput\").oninput=function(){renderCommands(this.value)};$(\"refreshBtn\").onclick=function(){loadTraffic(true);loadWeather();if(state.radar)updateRadarImage()};\n  $(\"cleanBtn\").onclick=function(){setClean(true)};$(\"cleanReturn\").onclick=function(){setClean(false)};\n  document.addEventListener(\"keydown\",function(e){\n    var typing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement&&document.activeElement.tagName||\"\");\n    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()===\"k\"){e.preventDefault();openCommand();return}\n    if(typing)return;\n    if(e.key===\"Escape\"){closePanel();closeInfo()}\n    if(e.key.toLowerCase()===\"l\")openPanel(\"base\");\n    if(e.key.toLowerCase()===\"w\")openPanel(\"weather\");\n    if(e.key.toLowerCase()===\"t\")openPanel(\"traffic\")\n  })\n}\n\nloadState();\n\nvar map=new maplibregl.Map({\n  container:\"map\",style:styleForBase(state.base),center:CENTER,zoom:6.1,bearing:0,pitch:0,\n  hash:false,interactive:true,dragPan:true,scrollZoom:true,doubleClickZoom:true,keyboard:true,\n  touchZoomRotate:true,touchPitch:false,dragRotate:false,pitchWithRotate:false,renderWorldCopies:false,\n  attributionControl:false,fadeDuration:120,cancelPendingTileRequestsWhileZooming:false\n});\nmap.touchZoomRotate.disableRotation();\nmap.addControl(new maplibregl.NavigationControl({showCompass:false,visualizePitch:false}),\"top-right\");\nmap.on(\"style.load\",afterStyleLoad);\nmap.on(\"moveend\",function(){if(state.radar)updateRadarImage()});\nmap.on(\"dragstart\",clearCameraModeFromUser);\nmap.on(\"zoomstart\",clearCameraModeFromUser);\nmap.on(\"load\",function(){installLayers();fitRange(false);loadTraffic(false);loadWeather();loadAirports()});\nbindUI();setClean(state.clean);renderPanel();\ntrafficTimer=setInterval(function(){loadTraffic(false)},TRAFFIC_POLL);\nweatherTimer=setInterval(loadWeather,WEATHER_POLL);\nsetInterval(updateStats,1000);\n})();\n</script>\n</body>\n</html>";


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/assets/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/traffic") return traffic(request, ctx);
    if (url.pathname === "/api/weather") return aviationWeather(request, ctx);
    if (url.pathname === "/api/trace") return selectedTrace(request, ctx);
    if (url.pathname === "/api/route") return routeLookup(request, ctx);
    if (url.pathname === "/api/airports") return airportCatalog(request, ctx);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        version: "5.0",
        architecture: "maplibre-aviation-ops-console",
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
