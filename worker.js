const CENTER = { lat: 45.0781, lon: -83.5603 };
const FRESH_TTL = 15;
const STALE_TTL = 300;

const SOURCES = [
  {
    name: "airplanes.live",
    url: (lat, lon, radius) =>
      `https://api.airplanes.live/v2/point/${lat}/${lon}/${radius}`,
    rows: (data) => Array.isArray(data.ac) ? data.ac : []
  },
  {
    name: "adsb.lol",
    url: (lat, lon, radius) =>
      `https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`,
    rows: (data) => Array.isArray(data.ac) ? data.ac : []
  },
  {
    name: "adsb.fi",
    url: (lat, lon, radius) =>
      `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${radius}`,
    rows: (data) => Array.isArray(data.aircraft) ? data.aircraft :
                    Array.isArray(data.ac) ? data.ac : []
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
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    alt_baro: a.alt_baro ?? null,
    alt_geom: a.alt_geom ?? null,
    gs: a.gs ?? null,
    track: a.track ?? null,
    baro_rate: a.baro_rate ?? a.geom_rate ?? null,
    squawk: a.squawk ?? null,
    emergency: a.emergency ?? null,
    category: a.category ?? null,
    seen: a.seen ?? null,
    seen_pos: a.seen_pos ?? null
  };
}

async function fetchWithTimeout(url, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent": "AviationLiveTraffic/1.3 home-office-hangar-display"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function trySource(source, lat, lon, radius) {
  const response = await fetchWithTimeout(source.url(lat, lon, radius));
  if (!response.ok) throw new Error(`${source.name} HTTP ${response.status}`);

  const data = await response.json();
  const rows = source.rows(data);
  const aircraft = rows
    .map(normalize)
    .filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon));

  return {
    source: source.name,
    generatedAt: new Date().toISOString(),
    center: { lat, lon, radiusNm: radius },
    total: aircraft.length,
    aircraft,
    stale: false
  };
}

async function traffic(request, ctx) {
  const u = new URL(request.url);
  const lat = clampNumber(u.searchParams.get("lat"), -90, 90, CENTER.lat);
  const lon = clampNumber(u.searchParams.get("lon"), -180, 180, CENTER.lon);
  const radius = Math.round(clampNumber(u.searchParams.get("radius"), 5, 250, 100));

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

  // A transient outage should not blank an always-on display.
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

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#07111b">
<title>Aviation Live Traffic</title>
<style>
:root{color-scheme:dark;--bg:#07111b;--panel:#0e1b28;--panel2:#132437;--line:#294056;--text:#f5f8fb;--muted:#91a7ba;--good:#65df91;--warn:#ffd166;--bad:#ff7179}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button,select{font:inherit}.app{min-height:100dvh;padding:14px;display:grid;grid-template-rows:auto auto minmax(520px,1fr) auto;gap:10px}
header,.controls,.footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.eyebrow{font-size:11px;font-weight:900;letter-spacing:.15em;color:#b8c9d8}
h1{font-size:clamp(28px,4vw,46px);margin:6px 0 0;line-height:1;letter-spacing:-.04em}.status{display:flex;gap:9px;align-items:center;color:#b8c8d7;white-space:nowrap}
.dot{width:12px;height:12px;border-radius:50%;background:var(--warn);box-shadow:0 0 0 5px #ffd1661a}.dot.good{background:var(--good);box-shadow:0 0 0 5px #65df911a}.dot.bad{background:var(--bad)}
.controls{justify-content:flex-start;flex-wrap:wrap;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:10px 12px}
.control{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px;font-weight:800}select,button{height:44px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:11px;padding:0 13px;font-weight:800}button{cursor:pointer}
.radar-wrap{position:relative;min-height:520px;border:1px solid var(--line);border-radius:18px;overflow:hidden;background:radial-gradient(circle at center,#112b3d 0,#0b1c2a 55%,#07111b 100%)}
#radar{display:block;width:100%;height:100%;min-height:520px}.hud{position:absolute;left:12px;top:12px;display:flex;gap:8px;pointer-events:none}
.hud>div{min-width:90px;padding:9px 11px;background:#07111bdd;border:1px solid #ffffff1c;border-radius:12px}.hud strong,.hud span{display:block}.hud strong{font-size:18px}.hud span{font-size:11px;color:var(--muted)}
.plane{cursor:pointer}.plane-label{paint-order:stroke;stroke:#07111b;stroke-width:4px;stroke-linejoin:round;font-weight:800}
.detail{position:absolute;right:12px;bottom:12px;width:min(370px,calc(100% - 24px));background:#0d1925f4;border:1px solid var(--line);border-radius:16px;padding:16px;display:none;box-shadow:0 16px 44px #0008}.detail h2{margin:4px 0 12px;font-size:27px}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.detail-grid div{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:9px}.detail-grid span,.detail-grid strong{display:block}.detail-grid span{font-size:10px;color:var(--muted);margin-bottom:3px}.close{position:absolute;right:8px;top:8px;width:38px;padding:0;font-size:22px}
.notice{position:absolute;left:12px;right:12px;bottom:12px;background:#4a3b16dd;border:1px solid #ffd16655;color:#ffe6a3;padding:9px 11px;border-radius:11px;font-size:12px;display:none}.fatal{background:#45171bdd;border-color:#ff717966;color:#ffd6d8}
.footer{font-size:11px;color:var(--muted);padding:2px 4px}
@media(max-width:700px){header{align-items:flex-start}.status{font-size:13px}.app{grid-template-rows:auto auto minmax(580px,1fr) auto}.radar-wrap,#radar{min-height:580px}.hud{right:12px;overflow:hidden}.hud>div{min-width:77px}.footer{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>
<main class="app">
<header><div><div class="eyebrow">AVIATION LIVE TRAFFIC</div><h1>Alpena Area</h1></div><div class="status"><span id="dot" class="dot"></span><span id="status">Connecting…</span></div></header>
<section class="controls">
<label class="control">Range<select id="range"><option value="25">25 NM</option><option value="50">50 NM</option><option value="100" selected>100 NM</option><option value="150">150 NM</option><option value="200">200 NM</option><option value="250">250 NM</option></select></label>
<label class="control">Labels<select id="labels"><option value="callsign" selected>Callsign</option><option value="altitude">Altitude</option><option value="both">Both</option><option value="none">None</option></select></label>
<button id="refresh" type="button">Refresh now</button>
</section>
<section class="radar-wrap">
<svg id="radar" viewBox="0 0 1000 700" aria-label="Live aircraft radar"><defs><filter id="glow"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g id="grid"></g><g id="planes"></g></svg>
<div class="hud"><div><strong id="count">—</strong><span>aircraft</span></div><div><strong id="rangeHud">100</strong><span>NM range</span></div><div><strong id="updated">—</strong><span>updated</span></div></div>
<div id="notice" class="notice"></div>
<aside id="detail" class="detail"><button id="close" class="close" type="button">×</button><div class="eyebrow">SELECTED AIRCRAFT</div><h2 id="dtitle">—</h2><div class="detail-grid"><div><span>REGISTRATION</span><strong id="dreg">—</strong></div><div><span>TYPE</span><strong id="dtype">—</strong></div><div><span>ALTITUDE</span><strong id="dalt">—</strong></div><div><span>GROUND SPEED</span><strong id="dgs">—</strong></div><div><span>TRACK</span><strong id="dtrack">—</strong></div><div><span>VERTICAL RATE</span><strong id="dvr">—</strong></div></div></aside>
</section>
<footer class="footer"><span id="source">Community ADS-B data</span><span>Home/office/hangar display — not for navigation or collision avoidance</span></footer>
</main>
<script>
(()=>{
"use strict";
const CENTER={lat:45.0781,lon:-83.5603},POLL=20000,NS="http://www.w3.org/2000/svg";
const $=id=>document.getElementById(id),grid=$("grid"),planes=$("planes"),range=$("range"),labels=$("labels"),notice=$("notice"),detail=$("detail");
let last=[],timer=null,busy=false,everLive=false;
function S(tag,a={},t=null){const n=document.createElementNS(NS,tag);Object.entries(a).forEach(([k,v])=>n.setAttribute(k,String(v)));if(t!==null)n.textContent=t;return n}
function status(kind,text){$("dot").className="dot"+(kind?" "+kind:"");$("status").textContent=text}
function alt(a){if(a.alt_baro==="ground")return"GROUND";const n=Number(a.alt_baro??a.alt_geom);return Number.isFinite(n)?Math.round(n).toLocaleString()+" ft":"—"}
function name(a){return(a.flight&&a.flight.trim())||a.r||(a.hex?a.hex.toUpperCase():"UNKNOWN")}
function nm(a,b,c,d){const R=3440.065,r=x=>x*Math.PI/180,p1=r(a),p2=r(c),dp=r(c-a),dl=r(d-b),h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)))}
function brg(a,b,c,d){const r=x=>x*Math.PI/180,D=x=>x*180/Math.PI,p1=r(a),p2=r(c),dl=r(d-b),y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);return(D(Math.atan2(y,x))+360)%360}
function drawGrid(){grid.replaceChildren();const cx=500,cy=350,R=300,m=Number(range.value)||100;grid.append(S("line",{x1:cx-R,y1:cy,x2:cx+R,y2:cy,stroke:"#2e4a60"}));grid.append(S("line",{x1:cx,y1:cy-R,x2:cx,y2:cy+R,stroke:"#2e4a60"}));[.25,.5,.75,1].forEach((f,i)=>{grid.append(S("circle",{cx,cy,r:R*f,fill:"none",stroke:i===3?"#52758d":"#36546a","stroke-width":i===3?2:1.2}));grid.append(S("text",{x:cx+8,y:cy-R*f+16,fill:"#7891a4","font-size":13,"font-weight":700},Math.round(m*f)+" NM"))});[["N",cx,cy-R-18],["E",cx+R+20,cy+5],["S",cx,cy+R+30],["W",cx-R-22,cy+5]].forEach(c=>grid.append(S("text",{x:c[1],y:c[2],fill:"#bfd0dd","font-size":15,"font-weight":900,"text-anchor":"middle"},c[0])));grid.append(S("circle",{cx,cy,r:4,fill:"#70d6ff",filter:"url(#glow)"}));grid.append(S("text",{x:cx+10,y:cy-10,fill:"#a1bacb","font-size":12,"font-weight":800},"KAPN"))}
function label(a){if(labels.value==="none")return"";if(labels.value==="altitude")return alt(a).replace(" ft","");if(labels.value==="both")return name(a)+" · "+alt(a).replace(" ft","");return name(a)}
function show(a){$("dtitle").textContent=name(a);$("dreg").textContent=a.r||"—";$("dtype").textContent=a.t||"—";$("dalt").textContent=alt(a);$("dgs").textContent=Number.isFinite(Number(a.gs))?Math.round(Number(a.gs))+" kt":"—";$("dtrack").textContent=Number.isFinite(Number(a.track))?Math.round(Number(a.track))+"°":"—";$("dvr").textContent=Number.isFinite(Number(a.baro_rate))?Math.round(Number(a.baro_rate))+" fpm":"—";detail.style.display="block"}
function draw(list){planes.replaceChildren();const cx=500,cy=350,R=300,max=Number(range.value)||100;let c=0;for(const a of list){if(!Number.isFinite(Number(a.lat))||!Number.isFinite(Number(a.lon)))continue;const d=nm(CENTER.lat,CENTER.lon,Number(a.lat),Number(a.lon));if(d>max)continue;const b=brg(CENTER.lat,CENTER.lon,Number(a.lat),Number(a.lon)),ang=(b-90)*Math.PI/180,pr=d/max*R,x=cx+Math.cos(ang)*pr,y=cy+Math.sin(ang)*pr,tr=Number.isFinite(Number(a.track))?Number(a.track):0,g=S("g",{class:"plane",transform:"translate("+x.toFixed(1)+" "+y.toFixed(1)+")"});g.append(S("path",{d:"M 0 -11 L 3 -2 L 12 2 L 12 5 L 3 4 L 2 10 L 6 13 L 6 15 L 0 13 L -6 15 L -6 13 L -2 10 L -3 4 L -12 5 L -12 2 L -3 -2 Z",fill:"#f8fbff",stroke:"#07111b","stroke-width":1.5,transform:"rotate("+tr+")",filter:"url(#glow)"}));const l=label(a);if(l)g.append(S("text",{x:15,y:-9,fill:"#f4f7fb","font-size":12,class:"plane-label"},l));g.addEventListener("click",()=>show(a));planes.append(g);c++}$("count").textContent=String(c)}
async function load(){if(busy)return;busy=true;status("",everLive?"Updating…":"Connecting…");notice.style.display="none";const r=Number(range.value)||100;$("rangeHud").textContent=String(r);try{const res=await fetch("/api/traffic?lat="+CENTER.lat+"&lon="+CENTER.lon+"&radius="+r,{cache:"no-store"}),data=await res.json();if(!res.ok)throw new Error((data.errors||[]).join(" | ")||data.error||"HTTP "+res.status);last=Array.isArray(data.aircraft)?data.aircraft:[];draw(last);everLive=true;$("updated").textContent=new Date(data.generatedAt||Date.now()).toLocaleTimeString([],{hour:"numeric",minute:"2-digit",second:"2-digit"});$("source").textContent="Data: "+(data.source||"community ADS-B");if(data.stale){status("","Holding last good data");notice.className="notice";notice.textContent="A live refresh was missed. Keeping the last good aircraft positions instead of blanking the display.";notice.style.display="block"}else status("good","Live · "+(data.source||"ADS-B"))}catch(e){if(everLive&&last.length){draw(last);status("","Holding last good data");notice.className="notice";notice.textContent="Refresh missed; last good traffic remains on screen. "+e.message;notice.style.display="block"}else{status("bad","Waiting for feed");notice.className="notice fatal";notice.textContent="No aircraft feed has connected yet. "+e.message;notice.style.display="block"}}finally{busy=false}}
function restart(){clearInterval(timer);drawGrid();draw(last);load();timer=setInterval(load,POLL)}
range.addEventListener("change",restart);labels.addEventListener("change",()=>draw(last));$("refresh").addEventListener("click",load);$("close").addEventListener("click",()=>detail.style.display="none");document.addEventListener("visibilitychange",()=>{if(document.hidden)clearInterval(timer);else restart()});drawGrid();restart();
})();
</script>
</body></html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/traffic") {
      return traffic(request, ctx);
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, version: "1.3", time: new Date().toISOString() });
    }

    return new Response(PAGE, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
};
