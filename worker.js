const ADSB_BASE = "https://api.adsb.lol/v2/point";
const CACHE_SECONDS = 8;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeAircraft(a) {
  return {
    hex: a.hex ?? null,
    callsign: typeof a.flight === "string" ? a.flight.trim() : null,
    registration: a.r ?? null,
    aircraftType: a.t ?? null,
    lat: Number.isFinite(a.lat) ? a.lat : null,
    lon: Number.isFinite(a.lon) ? a.lon : null,
    altitudeBaro: a.alt_baro ?? null,
    altitudeGeom: a.alt_geom ?? null,
    groundSpeed: a.gs ?? null,
    track: a.track ?? null,
    verticalRate: a.baro_rate ?? a.geom_rate ?? null,
    squawk: a.squawk ?? null,
    emergency: a.emergency ?? null,
    category: a.category ?? null,
    seen: a.seen ?? null,
    seenPos: a.seen_pos ?? null
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

async function handleTraffic(request) {
  const url = new URL(request.url);

  const lat = clampNumber(url.searchParams.get("lat"), -90, 90, 45.0781);
  const lon = clampNumber(url.searchParams.get("lon"), -180, 180, -83.5603);
  const radius = Math.round(clampNumber(url.searchParams.get("radius"), 5, 250, 100));

  const upstream = `${ADSB_BASE}/${encodeURIComponent(lat)}/${encodeURIComponent(lon)}/${encodeURIComponent(radius)}`;

  try {
    const response = await fetch(upstream, {
      headers: {
        "accept": "application/json",
        "user-agent": "AviationLiveTrafficCloudflareV1/0.1 personal-display"
      },
      cf: {
        cacheTtl: CACHE_SECONDS,
        cacheEverything: true
      }
    });

    if (!response.ok) {
      return jsonResponse({
        error: "Unable to retrieve live aircraft data",
        detail: `ADSB.lol returned HTTP ${response.status}`
      }, 502);
    }

    const raw = await response.json();
    const rows = Array.isArray(raw.ac)
      ? raw.ac
      : Array.isArray(raw.aircraft)
        ? raw.aircraft
        : [];

    const aircraft = rows
      .map(normalizeAircraft)
      .filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon));

    return jsonResponse({
      source: "adsb.lol",
      generatedAt: new Date().toISOString(),
      center: { lat, lon, radiusNm: radius },
      total: aircraft.length,
      aircraft
    });
  } catch (error) {
    return jsonResponse({
      error: "Unable to retrieve live aircraft data",
      detail: error instanceof Error ? error.message : String(error)
    }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/traffic") {
      return handleTraffic(request);
    }

    return env.ASSETS.fetch(request);
  }
};
