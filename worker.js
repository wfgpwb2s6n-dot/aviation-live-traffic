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
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36 AviationLiveTraffic/2.1"
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

const PAGE = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"theme-color\" content=\"#07111b\">\n<title>Alpena Live Traffic</title>\n<style>\n:root{\n  color-scheme:dark;\n  --bg:#06101a;--panel:#0b1824;--panel2:#102235;--line:#29445a;\n  --text:#f5f8fb;--muted:#90a6b8;--good:#66df91;--warn:#ffd166;--bad:#ff7179;\n  --accent:#6fd7ff;--select:#ffd166;--glass:rgba(5,14,23,.86);\n}\n*{box-sizing:border-box}\nhtml,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--text);\n  font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}\nbutton,select,input{font:inherit}\nbutton,select{height:36px;border:1px solid var(--line);background:var(--panel2);color:var(--text);\n  border-radius:9px;padding:0 10px;font-weight:800}\nbutton{cursor:pointer}\nbutton:disabled{opacity:.65;cursor:default}\n\n.app{\n  height:100vh;height:100svh;height:100dvh;\n  padding:max(7px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right))\n          max(7px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left));\n  display:grid;grid-template-rows:38px 45px minmax(0,1fr);gap:6px;overflow:hidden\n}\n.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}\n.brand{display:flex;align-items:baseline;gap:9px;min-width:0;white-space:nowrap}\n.brand strong{font-size:17px;letter-spacing:.03em}\n.brand span{font-size:10px;color:var(--muted);font-weight:900;letter-spacing:.12em}\n.status{display:flex;align-items:center;gap:7px;color:#b7c7d5;font-size:12px;white-space:nowrap}\n.dot{width:9px;height:9px;border-radius:50%;background:var(--warn);box-shadow:0 0 0 4px #ffd16618}\n.dot.good{background:var(--good);box-shadow:0 0 0 4px #66df9118}\n.dot.bad{background:var(--bad);box-shadow:0 0 0 4px #ff717918}\n\n.toolbar{\n  min-width:0;display:flex;align-items:center;gap:7px;background:var(--panel);\n  border:1px solid var(--line);border-radius:12px;padding:4px 6px;overflow-x:auto;overflow-y:hidden;\n  scrollbar-width:none;white-space:nowrap\n}\n.toolbar::-webkit-scrollbar{display:none}\n.control{display:inline-flex;align-items:center;gap:5px;color:var(--muted);font-size:10px;font-weight:900;letter-spacing:.02em}\n.control select{font-size:11px}\n.range-control{min-width:155px}\n.range-control input{width:74px;accent-color:var(--accent)}\n.toolbar-spacer{flex:1 0 8px}\n\n.workspace{\n  position:relative;min-width:0;min-height:0;overflow:hidden;border:1px solid var(--line);\n  border-radius:15px;background:radial-gradient(circle at center,#102a3c 0,#0a1b29 58%,#06101a 100%);\n}\n#tileLayer{position:absolute;inset:0;overflow:hidden;opacity:.72;transition:opacity .15s ease;z-index:0}\n.map-tile{position:absolute;width:256px;height:256px;max-width:none;user-select:none;-webkit-user-drag:none}\n#michiganChart{position:absolute;display:none;max-width:none;pointer-events:none;user-select:none;-webkit-user-drag:none;z-index:1;transform-origin:0 0;transition:opacity .15s ease;filter:saturate(.98) contrast(.98)}\n#mapShade{position:absolute;inset:0;pointer-events:none;background:rgba(3,11,18,.12);z-index:2}\n#radar{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:manipulation;z-index:3}\n#grid,#trailsLayer,#planes{pointer-events:none}\n.plane{pointer-events:auto;cursor:pointer}\n.plane-label{paint-order:stroke;stroke:#06101a;stroke-width:4px;stroke-linejoin:round;font-weight:900}\n.plane-sub{paint-order:stroke;stroke:#06101a;stroke-width:3px;stroke-linejoin:round;font-weight:800}\n.vector{stroke:#9ecde1;stroke-width:1.25;opacity:.72}\n.trail{fill:none;stroke:#64c5ef;stroke-width:2;opacity:.6;stroke-linecap:round;stroke-linejoin:round}\n.trail-dot{fill:#64c5ef;opacity:.68}\n.selected-ring{fill:none;stroke:var(--select);stroke-width:2.4}\n\n.hud{\n  position:absolute;left:9px;top:9px;z-index:4;display:flex;gap:7px;align-items:center;\n  background:var(--glass);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);\n  border-radius:9px;padding:6px 8px;font-size:9px;color:var(--muted);pointer-events:none\n}\n.hud strong{font-size:11px;color:var(--text)}\n.hud .sep{opacity:.4}\n.attribution{\n  position:absolute;right:7px;bottom:5px;z-index:3;font-size:8px;color:rgba(230,239,246,.68);\n  background:rgba(4,12,19,.68);border-radius:5px;padding:2px 4px;pointer-events:none\n}\n.disclaimer{\n  position:absolute;left:7px;bottom:5px;z-index:3;font-size:8px;color:rgba(212,224,233,.55);\n  pointer-events:none\n}\n\n.detail{\n  position:absolute;z-index:7;right:9px;top:9px;bottom:9px;width:min(330px,34%);\n  background:rgba(8,20,31,.96);border:1px solid var(--line);border-radius:13px;\n  box-shadow:0 18px 45px rgba(0,0,0,.42);padding:13px;display:none;overflow:auto;\n  backdrop-filter:blur(12px)\n}\n.detail.open{display:block}\n.detail .eyebrow{font-size:9px;letter-spacing:.13em;color:var(--muted);font-weight:900}\n.detail h2{margin:4px 32px 1px 0;font-size:23px}\n.detail-sub{font-size:11px;color:var(--muted);margin-bottom:10px}\n.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}\n.detail-grid div{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:7px}\n.detail-grid span,.detail-grid strong{display:block}\n.detail-grid span{font-size:8px;color:var(--muted);letter-spacing:.04em;margin-bottom:2px}\n.detail-grid strong{font-size:12px}\n.close{position:absolute;right:7px;top:7px;width:31px;height:31px;padding:0;font-size:19px}\n.notice{\n  position:absolute;left:9px;right:9px;bottom:9px;z-index:6;background:rgba(71,57,20,.92);\n  border:1px solid rgba(255,209,102,.35);color:#ffe8aa;padding:7px 9px;border-radius:9px;font-size:10px;display:none\n}\n.notice.fatal{background:rgba(66,21,26,.93);border-color:rgba(255,113,121,.42);color:#ffd6d9}\n\n@media(max-width:720px){\n  .app{grid-template-rows:34px 43px minmax(0,1fr);gap:5px}\n  .brand strong{font-size:14px}.brand span{display:none}.status{font-size:10px}\n  .detail{left:7px;right:7px;top:auto;bottom:7px;width:auto;height:40%;padding:10px}\n  .detail-grid{grid-template-columns:repeat(4,1fr)}\n  .detail h2{font-size:19px}\n}\n@media(max-width:480px){\n  .detail-grid{grid-template-columns:1fr 1fr}\n  .hud{max-width:calc(100% - 18px);overflow:hidden;white-space:nowrap}\n}\n</style>\n</head>\n<body>\n<main class=\"app\">\n  <header class=\"topbar\">\n    <div class=\"brand\"><strong>ALPENA LIVE TRAFFIC</strong><span>KAPN \u00b7 2026 MICHIGAN CHART</span></div>\n    <div class=\"status\"><span id=\"dot\" class=\"dot\"></span><span id=\"statusText\">CONNECTING\u2026</span></div>\n  </header>\n\n  <section class=\"toolbar\" aria-label=\"Display controls\">\n    <label class=\"control\">RANGE\n      <select id=\"range\">\n        <option value=\"25\">25 NM</option><option value=\"50\">50 NM</option><option value=\"100\" selected>100 NM</option>\n        <option value=\"150\">150 NM</option><option value=\"200\">200 NM</option><option value=\"250\">250 NM</option>\n      </select>\n    </label>\n\n    <label class=\"control\">BACKGROUND\n      <select id=\"background\">\n        <option value=\"radar\">RADAR</option><option value=\"map\">MAP</option><option value=\"sectional\">FAA SECTIONAL</option><option value=\"michigan\" selected>MICHIGAN</option>\n      </select>\n    </label>\n\n    <label class=\"control range-control\">OPACITY\n      <input id=\"opacity\" type=\"range\" min=\"25\" max=\"100\" step=\"5\" value=\"70\">\n      <span id=\"opacityLabel\">70%</span>\n    </label>\n\n    <label class=\"control\">RINGS\n      <select id=\"rings\"><option value=\"on\" selected>ON</option><option value=\"off\">OFF</option></select>\n    </label>\n\n    <label class=\"control\">LABELS\n      <select id=\"labels\">\n        <option value=\"full\" selected>FULL</option><option value=\"callsign\">CALLSIGN</option>\n        <option value=\"altitude\">ALTITUDE</option><option value=\"none\">NONE</option>\n      </select>\n    </label>\n\n    <label class=\"control\">TRAILS\n      <select id=\"trails\"><option value=\"0\">OFF</option><option value=\"60\">1 MIN</option><option value=\"300\">5 MIN</option></select>\n    </label>\n\n    <label class=\"control\">TRAFFIC\n      <select id=\"traffic\"><option value=\"all\">ALL</option><option value=\"airline\">AIRLINE</option><option value=\"ga\">GA</option></select>\n    </label>\n\n    <label class=\"control\">ALT\n      <select id=\"altFilter\">\n        <option value=\"all\">ALL</option><option value=\"low\">&lt;5K</option><option value=\"mid\">5\u201315K</option><option value=\"high\">&gt;15K</option>\n      </select>\n    </label>\n\n    <span class=\"toolbar-spacer\"></span>\n    <button id=\"refresh\" type=\"button\">REFRESH</button>\n  </section>\n\n  <section id=\"workspace\" class=\"workspace\">\n    <div id=\"tileLayer\"></div>\n    <img id=\"michiganChart\" src=\"/assets/michigan_chart.webp\" alt=\"\" aria-hidden=\"true\">\n    <div id=\"mapShade\"></div>\n    <svg id=\"radar\" aria-label=\"Live aircraft display\">\n      <defs>\n        <filter id=\"glow\"><feGaussianBlur stdDeviation=\"1.5\" result=\"b\"/><feMerge><feMergeNode in=\"b\"/><feMergeNode in=\"SourceGraphic\"/></feMerge></filter>\n      </defs>\n      <g id=\"grid\"></g><g id=\"trailsLayer\"></g><g id=\"planes\"></g>\n    </svg>\n\n    <div class=\"hud\">\n      <strong id=\"count\">\u2014</strong><span>ACFT</span><span class=\"sep\">|</span>\n      <strong id=\"rangeHud\">100</strong><span>NM</span><span class=\"sep\">|</span>\n      <strong id=\"ageHud\">\u2014</strong><span>AGE</span><span class=\"sep\">|</span>\n      <strong id=\"trailHud\">OFF</strong><span>TRAIL</span>\n    </div>\n\n    <div id=\"attribution\" class=\"attribution\"></div>\n    <div class=\"disclaimer\">ENTHUSIAST DISPLAY \u00b7 NOT FOR NAVIGATION / COLLISION AVOIDANCE</div>\n    <div id=\"notice\" class=\"notice\"></div>\n\n    <aside id=\"detail\" class=\"detail\">\n      <button id=\"close\" class=\"close\" type=\"button\" aria-label=\"Close\">\u00d7</button>\n      <div class=\"eyebrow\">SELECTED AIRCRAFT</div>\n      <h2 id=\"dtitle\">\u2014</h2>\n      <div id=\"dsub\" class=\"detail-sub\">\u2014</div>\n      <div class=\"detail-grid\">\n        <div><span>ALTITUDE</span><strong id=\"dalt\">\u2014</strong></div>\n        <div><span>GROUND SPEED</span><strong id=\"dgs\">\u2014</strong></div>\n        <div><span>VERTICAL RATE</span><strong id=\"dvr\">\u2014</strong></div>\n        <div><span>TRACK</span><strong id=\"dtrack\">\u2014</strong></div>\n        <div><span>DISTANCE KAPN</span><strong id=\"ddist\">\u2014</strong></div>\n        <div><span>BEARING KAPN</span><strong id=\"dbrg\">\u2014</strong></div>\n        <div><span>SQUAWK</span><strong id=\"dsq\">\u2014</strong></div>\n        <div><span>POSITION AGE</span><strong id=\"dage\">\u2014</strong></div>\n      </div>\n    </aside>\n  </section>\n</main>\n\n<script>\n(function(){\n\"use strict\";\n\nvar CENTER={lat:45.0781,lon:-83.5603};\nvar POLL=20000;\nvar TILE=256;\nvar EARTH=6378137;\nvar NS=\"http://www.w3.org/2000/svg\";\n\nvar MAP_URL=\"https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/\";\nvar SECTIONAL_URL=\"https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/\";\n\n// 2026 Michigan Aeronautical Chart calibration.\n// Source asset is a 3600x3802 WebP rendered from the user-supplied full-chart PDF.\n// Calibration is local to KAPN using the chart's printed degree grid and airport position.\nvar MICH={\n  w:3600,h:3802,\n  kapnX:2930.3,kapnY:1503.4,\n  pxPerNmX:9.17,pxPerNmY:9.97\n};\n\nfunction $(id){return document.getElementById(id)}\nvar workspace=$(\"workspace\"),tileLayer=$(\"tileLayer\"),michiganChart=$(\"michiganChart\"),mapShade=$(\"mapShade\"),radar=$(\"radar\");\nvar grid=$(\"grid\"),trailsLayer=$(\"trailsLayer\"),planes=$(\"planes\"),detail=$(\"detail\"),notice=$(\"notice\");\nvar controls={\n  range:$(\"range\"),background:$(\"background\"),opacity:$(\"opacity\"),rings:$(\"rings\"),\n  labels:$(\"labels\"),trails:$(\"trails\"),traffic:$(\"traffic\"),alt:$(\"altFilter\")\n};\n\nvar last=[],busy=false,timer=null,lastGoodAt=0,selectedHex=null,currentView=null;\nvar history=new Map();\nvar prefsKey=\"aviationLiveTrafficPrefsV21\";\nvar historyKey=\"aviationLiveTrafficHistoryV20\";\n\nfunction S(tag,attrs,text){\n  var n=document.createElementNS(NS,tag);\n  if(attrs)Object.keys(attrs).forEach(function(k){n.setAttribute(k,String(attrs[k]))});\n  if(text!==undefined&&text!==null)n.textContent=text;\n  return n\n}\nfunction setStatus(kind,text){\n  $(\"dot\").className=\"dot\"+(kind?\" \"+kind:\"\");\n  $(\"statusText\").textContent=text;\n}\nfunction clamp(v,a,b){return Math.max(a,Math.min(b,v))}\nfunction alt(a){\n  if(a.alt_baro===\"ground\")return\"GROUND\";\n  var n=Number(a.alt_baro!=null?a.alt_baro:a.alt_geom);\n  return Number.isFinite(n)?Math.round(n).toLocaleString()+\" ft\":\"\u2014\"\n}\nfunction altNum(a){\n  var n=Number(a.alt_baro!=null?a.alt_baro:a.alt_geom);\n  return Number.isFinite(n)?n:null\n}\nfunction aircraftName(a){\n  return (a.flight&&String(a.flight).trim())||a.r||(a.hex?String(a.hex).toUpperCase():\"UNKNOWN\")\n}\nfunction subtitle(a){\n  var bits=[a.r,a.t,a.ownOp].filter(Boolean);\n  return bits.length?bits.join(\" \u00b7 \"):\"Aircraft details\"\n}\nfunction nm(lat1,lon1,lat2,lon2){\n  var R=3440.065,r=function(x){return x*Math.PI/180};\n  var p1=r(lat1),p2=r(lat2),dp=r(lat2-lat1),dl=r(lon2-lon1);\n  var h=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);\n  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)))\n}\nfunction brg(lat1,lon1,lat2,lon2){\n  var r=function(x){return x*Math.PI/180},D=function(x){return x*180/Math.PI};\n  var p1=r(lat1),p2=r(lat2),dl=r(lon2-lon1);\n  var y=Math.sin(dl)*Math.cos(p2);\n  var x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);\n  return (D(Math.atan2(y,x))+360)%360\n}\nfunction ageSec(a){\n  var n=Number(a.seen_pos!=null?a.seen_pos:a.seen);\n  return Number.isFinite(n)?Math.max(0,n):0\n}\nfunction opacityFor(a){\n  var s=ageSec(a);\n  if(s<=5)return 1;if(s>=30)return .3;\n  return 1-(s-5)/25*.7\n}\nfunction isAirline(a){\n  var f=(a.flight||\"\").trim();\n  return /^[A-Z]{3}\\d+[A-Z]?$/.test(f)\n}\nfunction matchesFilters(a){\n  if(controls.traffic.value===\"airline\"&&!isAirline(a))return false;\n  if(controls.traffic.value===\"ga\"&&isAirline(a))return false;\n  var h=altNum(a);\n  if(controls.alt.value===\"low\"&&(h===null||h>=5000))return false;\n  if(controls.alt.value===\"mid\"&&(h===null||h<5000||h>15000))return false;\n  if(controls.alt.value===\"high\"&&(h===null||h<=15000))return false;\n  return true\n}\n\nfunction savePrefs(){\n  try{\n    localStorage.setItem(prefsKey,JSON.stringify({\n      range:controls.range.value,background:controls.background.value,opacity:controls.opacity.value,\n      rings:controls.rings.value,labels:controls.labels.value,trails:controls.trails.value,\n      traffic:controls.traffic.value,alt:controls.alt.value\n    }))\n  }catch(e){}\n}\nfunction loadPrefs(){\n  try{\n    var p=JSON.parse(localStorage.getItem(prefsKey)||\"null\");\n    if(!p)return;\n    [\"range\",\"background\",\"opacity\",\"rings\",\"labels\",\"trails\",\"traffic\"].forEach(function(k){\n      if(p[k]!=null&&controls[k])controls[k].value=p[k]\n    });\n    if(p.alt!=null)controls.alt.value=p.alt\n  }catch(e){}\n}\nfunction loadHistory(){\n  try{\n    var raw=JSON.parse(localStorage.getItem(historyKey)||\"{}\"),cutoff=Date.now()-310000;\n    Object.keys(raw).forEach(function(hex){\n      var pts=raw[hex];\n      if(!Array.isArray(pts))return;\n      pts=pts.filter(function(p){return p&&Number(p.t)>=cutoff&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))});\n      if(pts.length)history.set(hex,pts)\n    })\n  }catch(e){}\n}\nfunction saveHistory(){\n  try{\n    var out={},cutoff=Date.now()-310000;\n    history.forEach(function(pts,hex){\n      pts=pts.filter(function(p){return p.t>=cutoff}).slice(-40);\n      if(pts.length)out[hex]=pts\n    });\n    localStorage.setItem(historyKey,JSON.stringify(out))\n  }catch(e){}\n}\nfunction addHistory(list){\n  var now=Date.now();\n  list.forEach(function(a){\n    if(!a.hex||!Number.isFinite(Number(a.lat))||!Number.isFinite(Number(a.lon)))return;\n    var arr=history.get(a.hex)||[],prev=arr[arr.length-1];\n    if(!prev||Math.abs(prev.lat-Number(a.lat))>.00001||Math.abs(prev.lon-Number(a.lon))>.00001){\n      arr.push({t:now,lat:Number(a.lat),lon:Number(a.lon)})\n    }\n    while(arr.length&&now-arr[0].t>310000)arr.shift();\n    history.set(a.hex,arr)\n  });\n  saveHistory()\n}\n\nfunction worldXY(lat,lon,z){\n  var scale=TILE*Math.pow(2,z);\n  var sin=clamp(Math.sin(lat*Math.PI/180),-.9999,.9999);\n  return {\n    x:(lon+180)/360*scale,\n    y:(.5-Math.log((1+sin)/(1-sin))/(4*Math.PI))*scale\n  }\n}\nfunction metersPerPixel(lat,z){\n  return Math.cos(lat*Math.PI/180)*2*Math.PI*EARTH/(TILE*Math.pow(2,z))\n}\nfunction computeView(){\n  var w=Math.max(1,workspace.clientWidth),h=Math.max(1,workspace.clientHeight);\n  var radiusNm=Number(controls.range.value)||100;\n  var radiusM=radiusNm*1852;\n  var targetPx=Math.max(80,Math.min(w,h)/2-24);\n  var desiredMpp=radiusM/targetPx;\n  var z=Math.floor(Math.log2(Math.cos(CENTER.lat*Math.PI/180)*2*Math.PI*EARTH/(TILE*desiredMpp)));\n  z=clamp(z,3,13);\n  var c=worldXY(CENTER.lat,CENTER.lon,z);\n  var mpp=metersPerPixel(CENTER.lat,z);\n  return {w:w,h:h,z:z,cx:w/2,cy:h/2,centerWorld:c,mpp:mpp,radiusNm:radiusNm,radiusPx:radiusM/mpp}\n}\nfunction screenXY(lat,lon){\n  var v=currentView||computeView(),p=worldXY(lat,lon,v.z);\n  return {x:v.cx+(p.x-v.centerWorld.x),y:v.cy+(p.y-v.centerWorld.y)}\n}\n\nfunction renderMichiganChart(){\n  if(controls.background.value!==\"michigan\"){\n    michiganChart.style.display=\"none\";\n    return\n  }\n  var v=currentView||computeView();\n  var screenPxPerNm=1852/v.mpp;\n  var sx=screenPxPerNm/MICH.pxPerNmX;\n  var sy=screenPxPerNm/MICH.pxPerNmY;\n  michiganChart.style.display=\"block\";\n  michiganChart.style.left=(v.cx-MICH.kapnX*sx)+\"px\";\n  michiganChart.style.top=(v.cy-MICH.kapnY*sy)+\"px\";\n  michiganChart.style.width=(MICH.w*sx)+\"px\";\n  michiganChart.style.height=(MICH.h*sy)+\"px\";\n  michiganChart.style.opacity=String(Number(controls.opacity.value)/100);\n}\n\nfunction tileUrl(mode,z,x,y){\n  if(mode===\"sectional\")return SECTIONAL_URL+z+\"/\"+y+\"/\"+x;\n  return MAP_URL+z+\"/\"+y+\"/\"+x\n}\nfunction renderTiles(){\n  currentView=computeView();\n  var mode=controls.background.value;\n  tileLayer.replaceChildren();\n  $(\"attribution\").textContent=\"\";\n\n  if(mode===\"radar\"){\n    tileLayer.style.opacity=\"0\";\n    michiganChart.style.display=\"none\";\n    mapShade.style.background=\"rgba(3,11,18,0)\";\n    return\n  }\n\n  var tileMode=mode===\"michigan\"?\"map\":mode;\n  tileLayer.style.opacity=mode===\"michigan\"?\"0.24\":String(Number(controls.opacity.value)/100);\n  mapShade.style.background=mode===\"sectional\"?\"rgba(3,11,18,.10)\":(mode===\"michigan\"?\"rgba(3,11,18,.04)\":\"rgba(3,11,18,.18)\");\n\n  if(mode===\"michigan\"){\n    $(\"attribution\").textContent=\"2026 Michigan Aeronautical Chart \u00b7 MDOT \u00b7 calibrated at KAPN \u00b7 Esri base\";\n  }else if(mode===\"sectional\"){\n    $(\"attribution\").textContent=\"FAA Aeronautical Information Services \u00b7 ArcGIS\";\n  }else{\n    $(\"attribution\").textContent=\"Esri World Topographic Map\";\n  }\n\n  var v=currentView,z=v.z;\n  var minX=Math.floor((v.centerWorld.x-v.w/2)/TILE)-1;\n  var maxX=Math.floor((v.centerWorld.x+v.w/2)/TILE)+1;\n  var minY=Math.floor((v.centerWorld.y-v.h/2)/TILE)-1;\n  var maxY=Math.floor((v.centerWorld.y+v.h/2)/TILE)+1;\n  var n=Math.pow(2,z);\n\n  for(var tx=minX;tx<=maxX;tx++){\n    for(var ty=minY;ty<=maxY;ty++){\n      if(ty<0||ty>=n)continue;\n      var wrapped=((tx%n)+n)%n;\n      var img=document.createElement(\"img\");\n      img.className=\"map-tile\";\n      img.alt=\"\";\n      img.draggable=false;\n      img.src=tileUrl(tileMode,z,wrapped,ty);\n      img.style.left=(tx*TILE-v.centerWorld.x+v.cx)+\"px\";\n      img.style.top=(ty*TILE-v.centerWorld.y+v.cy)+\"px\";\n      img.onerror=function(){this.remove()};\n      tileLayer.appendChild(img)\n    }\n  }\n\n  renderMichiganChart()\n}\n\nfunction drawGrid(){\n  currentView=computeView();\n  radar.setAttribute(\"viewBox\",\"0 0 \"+currentView.w+\" \"+currentView.h);\n  grid.replaceChildren();\n\n  var v=currentView,cx=v.cx,cy=v.cy,R=v.radiusPx;\n  if(controls.rings.value===\"on\"){\n    [0.25,0.5,0.75,1].forEach(function(f,i){\n      grid.appendChild(S(\"circle\",{cx:cx,cy:cy,r:R*f,fill:\"none\",stroke:i===3?\"#6d899c\":\"#496578\",\n        \"stroke-width\":i===3?1.5:1,opacity:controls.background.value===\"radar\"?.8:.55}));\n      grid.appendChild(S(\"text\",{x:cx+7,y:cy-R*f+13,fill:\"#8298a9\",\"font-size\":10,\"font-weight\":800},\n        Math.round(v.radiusNm*f)+\" NM\"))\n    });\n    grid.appendChild(S(\"line\",{x1:cx-R,y1:cy,x2:cx+R,y2:cy,stroke:\"#4a6679\",\"stroke-width\":.8,opacity:.5}));\n    grid.appendChild(S(\"line\",{x1:cx,y1:cy-R,x2:cx,y2:cy+R,stroke:\"#4a6679\",\"stroke-width\":.8,opacity:.5}))\n  }\n  [[\"N\",cx,cy-R-8],[\"E\",cx+R+10,cy+4],[\"S\",cx,cy+R+15],[\"W\",cx-R-10,cy+4]].forEach(function(c){\n    grid.appendChild(S(\"text\",{x:c[1],y:c[2],fill:\"#c1d0db\",\"font-size\":10,\"font-weight\":900,\"text-anchor\":\"middle\"},c[0]))\n  });\n  grid.appendChild(S(\"circle\",{cx:cx,cy:cy,r:3.3,fill:\"#6fd7ff\",filter:\"url(#glow)\"}));\n  grid.appendChild(S(\"text\",{x:cx+7,y:cy-7,fill:\"#c4d4df\",\"font-size\":9,\"font-weight\":900},\"KAPN\"))\n}\n\nfunction displayLabel(a){\n  var mode=controls.labels.value;\n  if(mode===\"none\")return{top:\"\",sub:\"\"};\n  if(mode===\"altitude\")return{top:alt(a).replace(\" ft\",\"\"),sub:\"\"};\n  if(mode===\"callsign\")return{top:aircraftName(a),sub:\"\"};\n  var gs=Number(a.gs);\n  return {top:aircraftName(a),sub:alt(a).replace(\" ft\",\"\")+\" \u00b7 \"+(Number.isFinite(gs)?Math.round(gs)+\"kt\":\"\u2014\")}\n}\nfunction rectOverlap(a,b,pad){\n  return !(a.x2+pad<b.x1||a.x1-pad>b.x2||a.y2+pad<b.y1||a.y1-pad>b.y2)\n}\n\nfunction drawTrails(){\n  trailsLayer.replaceChildren();\n  var seconds=Number(controls.trails.value)||0;\n  if(!seconds){$(\"trailHud\").textContent=\"OFF\";return}\n  var cutoff=Date.now()-seconds*1000,tracks=0,hasPoints=false;\n  last.forEach(function(a){\n    if(!matchesFilters(a)||!a.hex)return;\n    var arr=(history.get(a.hex)||[]).filter(function(p){return p.t>=cutoff});\n    if(arr.length)hasPoints=true;\n    if(arr.length<2)return;\n    var pts=arr.map(function(p){var q=screenXY(p.lat,p.lon);q.dist=nm(CENTER.lat,CENTER.lon,p.lat,p.lon);return q})\n      .filter(function(p){return p.dist<=currentView.radiusNm});\n    if(pts.length<2)return;\n    var d=pts.map(function(p,i){return(i?\"L\":\"M\")+p.x.toFixed(1)+\" \"+p.y.toFixed(1)}).join(\" \");\n    trailsLayer.appendChild(S(\"path\",{d:d,class:\"trail\",opacity:a.hex===selectedHex?.9:.6}));\n    pts.slice(0,-1).forEach(function(p){trailsLayer.appendChild(S(\"circle\",{cx:p.x,cy:p.y,r:1.5,class:\"trail-dot\"}))});\n    tracks++\n  });\n  $(\"trailHud\").textContent=tracks?tracks+\" TRK\":(hasPoints?\"BUILD\":\"WAIT\")\n}\n\nfunction showDetail(a){\n  selectedHex=a.hex||null;\n  $(\"dtitle\").textContent=aircraftName(a);\n  $(\"dsub\").textContent=subtitle(a);\n  $(\"dalt\").textContent=alt(a);\n  $(\"dgs\").textContent=Number.isFinite(Number(a.gs))?Math.round(Number(a.gs))+\" kt\":\"\u2014\";\n  $(\"dvr\").textContent=Number.isFinite(Number(a.baro_rate))?Math.round(Number(a.baro_rate))+\" fpm\":\"\u2014\";\n  $(\"dtrack\").textContent=Number.isFinite(Number(a.track))?Math.round(Number(a.track))+\"\u00b0\":\"\u2014\";\n  $(\"ddist\").textContent=nm(CENTER.lat,CENTER.lon,Number(a.lat),Number(a.lon)).toFixed(1)+\" NM\";\n  $(\"dbrg\").textContent=Math.round(brg(CENTER.lat,CENTER.lon,Number(a.lat),Number(a.lon))).toString().padStart(3,\"0\")+\"\u00b0\";\n  $(\"dsq\").textContent=a.squawk||\"\u2014\";\n  $(\"dage\").textContent=Math.round(ageSec(a))+\" sec\";\n  detail.classList.add(\"open\");\n  drawAircraft()\n}\n\nfunction drawAircraft(){\n  currentView=computeView();\n  planes.replaceChildren();\n  drawTrails();\n  var visible=[];\n  last.forEach(function(a){\n    if(!matchesFilters(a))return;\n    var lat=Number(a.lat),lon=Number(a.lon);\n    if(!Number.isFinite(lat)||!Number.isFinite(lon))return;\n    var d=nm(CENTER.lat,CENTER.lon,lat,lon);\n    if(d>currentView.radiusNm)return;\n    var p=screenXY(lat,lon);\n    visible.push({a:a,p:p,d:d})\n  });\n\n  visible.sort(function(u,v){\n    if(u.a.hex===selectedHex)return-1;if(v.a.hex===selectedHex)return 1;\n    return ageSec(u.a)-ageSec(v.a)\n  });\n\n  var labels=[];\n  visible.forEach(function(item){\n    var a=item.a,p=item.p,tr=Number.isFinite(Number(a.track))?Number(a.track):0;\n    var g=S(\"g\",{class:\"plane\",transform:\"translate(\"+p.x.toFixed(1)+\" \"+p.y.toFixed(1)+\")\",opacity:opacityFor(a)});\n    var vec=Math.max(12,Math.min(31,(Number(a.gs)||150)/16)),va=(tr-90)*Math.PI/180;\n    g.appendChild(S(\"line\",{x1:0,y1:0,x2:(Math.cos(va)*vec).toFixed(1),y2:(Math.sin(va)*vec).toFixed(1),class:\"vector\"}));\n    if(a.hex===selectedHex)g.appendChild(S(\"circle\",{cx:0,cy:0,r:12,class:\"selected-ring\"}));\n    g.appendChild(S(\"path\",{d:\"M0 -7 L2 -1 L8 1.5 L8 3.5 L2.2 2.8 L1.3 6.5 L4 9 L4 10.5 L0 9 L-4 10.5 L-4 9 L-1.3 6.5 L-2.2 2.8 L-8 3.5 L-8 1.5 L-2 -1 Z\",\n      fill:a.hex===selectedHex?\"#ffd166\":\"#f7fbff\",stroke:\"#06101a\",\"stroke-width\":1.1,transform:\"rotate(\"+tr+\")\",filter:\"url(#glow)\"}));\n\n    var lab=displayLabel(a);\n    if(lab.top){\n      var hash=(a.hex||aircraftName(a)).split(\"\").reduce(function(sum,c){return sum+c.charCodeAt(0)},0);\n      var side=hash%2===0?1:-1,lx=side>0?11:-11,anchor=side>0?\"start\":\"end\";\n      var width=Math.max(lab.top.length*6.2,(lab.sub||\"\").length*5.3);\n      var rect={x1:p.x+(side>0?lx:lx-width),x2:p.x+(side>0?lx+width:lx),y1:p.y-14,y2:p.y+(lab.sub?14:4)};\n      var collide=labels.some(function(r){return rectOverlap(rect,r,3)});\n      if(!collide||a.hex===selectedHex){\n        g.appendChild(S(\"text\",{x:lx,y:-5,fill:\"#f5f8fb\",\"font-size\":10,class:\"plane-label\",\"text-anchor\":anchor},lab.top));\n        if(lab.sub)g.appendChild(S(\"text\",{x:lx,y:6,fill:\"#a4c1cf\",\"font-size\":8,class:\"plane-sub\",\"text-anchor\":anchor},lab.sub));\n        labels.push(rect)\n      }\n    }\n    g.addEventListener(\"click\",function(){showDetail(a)});\n    planes.appendChild(g)\n  });\n  $(\"count\").textContent=String(visible.length);\n  $(\"rangeHud\").textContent=String(currentView.radiusNm)\n}\n\nfunction renderAll(){\n  savePrefs();\n  $(\"opacityLabel\").textContent=controls.opacity.value+\"%\";\n  renderTiles();drawGrid();drawAircraft()\n}\n\nasync function loadTraffic(manual){\n  if(busy)return;\n  busy=true;\n  var btn=$(\"refresh\"),old=btn.textContent;\n  if(manual){btn.disabled=true;btn.textContent=\"CHECKING\u2026\"}\n  setStatus(\"\",last.length?\"CHECKING\u2026\":\"CONNECTING\u2026\");\n  notice.style.display=\"none\";\n  try{\n    var url=\"/api/traffic?lat=\"+CENTER.lat+\"&lon=\"+CENTER.lon+\"&radius=\"+controls.range.value+\"&_=\"+Date.now();\n    var response=await fetch(url,{cache:\"no-store\"});\n    var data=await response.json();\n    if(!response.ok)throw new Error((data.errors||[]).join(\" | \")||data.error||(\"HTTP \"+response.status));\n    last=Array.isArray(data.aircraft)?data.aircraft:[];\n    lastGoodAt=Date.parse(data.generatedAt||\"\")||Date.now();\n    addHistory(last);\n    drawAircraft();\n    var source=(data.source||\"ADS-B\").toUpperCase();\n    setStatus(data.stale?\"\":\"good\",(data.stale?\"HOLDING \u00b7 \":\"LIVE \u00b7 \")+source);\n    if(data.stale){\n      notice.className=\"notice\";notice.textContent=\"Live refresh missed; holding the last good traffic picture.\";notice.style.display=\"block\"\n    }\n    if(selectedHex){\n      var selected=last.find(function(a){return a.hex===selectedHex});\n      if(selected)showDetail(selected)\n    }\n    if(manual)btn.textContent=data.cached?\"CHECKED\":\"UPDATED\"\n  }catch(e){\n    if(last.length){\n      setStatus(\"\",\"HOLDING LAST GOOD DATA\");\n      notice.className=\"notice\";notice.textContent=\"Refresh missed. Existing aircraft remain on screen.\";notice.style.display=\"block\"\n    }else{\n      setStatus(\"bad\",\"WAITING FOR FEED\");\n      notice.className=\"notice fatal\";notice.textContent=String(e.message||e);notice.style.display=\"block\"\n    }\n    if(manual)btn.textContent=\"CHECKED\"\n  }finally{\n    busy=false;\n    if(manual)setTimeout(function(){btn.disabled=false;btn.textContent=old},900)\n  }\n}\nfunction updateAge(){\n  $(\"ageHud\").textContent=lastGoodAt?Math.max(0,Math.round((Date.now()-lastGoodAt)/1000))+\"s\":\"\u2014\"\n}\n\ncontrols.opacity.addEventListener(\"input\",function(){\n  $(\"opacityLabel\").textContent=controls.opacity.value+\"%\";\n  if(controls.background.value===\"michigan\"){\n    michiganChart.style.opacity=String(Number(controls.opacity.value)/100);\n  }else{\n    tileLayer.style.opacity=controls.background.value===\"radar\"?\"0\":String(Number(controls.opacity.value)/100);\n  }\n  savePrefs()\n});\ncontrols.background.addEventListener(\"change\",renderAll);\ncontrols.range.addEventListener(\"change\",function(){renderAll();loadTraffic(false)});\n[controls.rings,controls.labels,controls.trails,controls.traffic,controls.alt].forEach(function(c){c.addEventListener(\"change\",renderAll)});\nmichiganChart.addEventListener(\"error\",function(){\n  if(controls.background.value===\"michigan\"){\n    notice.className=\"notice fatal\";\n    notice.textContent=\"Michigan chart image did not load; the map base is still available.\";\n    notice.style.display=\"block\"\n  }\n});\n$(\"refresh\").addEventListener(\"click\",function(){loadTraffic(true)});\n$(\"close\").addEventListener(\"click\",function(){selectedHex=null;detail.classList.remove(\"open\");drawAircraft()});\n\nvar resizeTimer=null;\nnew ResizeObserver(function(){\n  clearTimeout(resizeTimer);\n  resizeTimer=setTimeout(renderAll,80)\n}).observe(workspace);\n\ndocument.addEventListener(\"visibilitychange\",function(){\n  if(document.hidden){clearInterval(timer)}\n  else{loadTraffic(false);clearInterval(timer);timer=setInterval(function(){loadTraffic(false)},POLL)}\n});\n\nloadPrefs();loadHistory();renderAll();loadTraffic(false);\ntimer=setInterval(function(){loadTraffic(false)},POLL);\nsetInterval(updateAge,1000);\n})();\n</script>\n</body>\n</html>";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/assets/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/traffic") {
      return traffic(request, ctx);
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        version: "2.1",
        architecture: "cloudflare-proxy-global-mirror",
        primary: "theairtraffic",
        fallback: "hpradar",
        time: new Date().toISOString()
      });
    }

    if (url.pathname === "/api/source-test") {
      const results = [];
      for (const source of SOURCES) {
        const started = Date.now();
        try {
          const response = await fetchWithTimeout(source.url, 10000);
          results.push({
            source: source.name,
            status: response.status,
            ok: response.ok,
            ms: Date.now() - started,
            contentType: response.headers.get("content-type")
          });
        } catch (error) {
          results.push({
            source: source.name,
            ok: false,
            ms: Date.now() - started,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      return json({ version: "2.1", results, time: new Date().toISOString() });
    }

    return new Response(PAGE, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
};
