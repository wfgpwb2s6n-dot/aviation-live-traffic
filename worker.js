const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#07111b">
<title>Aviation Live Traffic</title>
<style>
:root{
  color-scheme:dark;
  --bg:#07111b;--panel:#0e1b28;--panel2:#132437;--line:#294056;
  --text:#f5f8fb;--muted:#91a7ba;--good:#65df91;--warn:#ffd166;--bad:#ff7179;
  --accent:#6fd7ff;--select:#ffd166;
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);
  font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button,select{font:inherit}
.app{min-height:100dvh;padding:12px;display:grid;grid-template-rows:auto auto minmax(570px,1fr) auto;gap:9px}
header,.controls,.footer{display:flex;align-items:center;justify-content:space-between;gap:12px}
.eyebrow{font-size:10px;font-weight:900;letter-spacing:.15em;color:#b8c9d8}
h1{font-size:clamp(26px,3.4vw,42px);margin:5px 0 0;line-height:1;letter-spacing:-.04em}
.status{display:flex;gap:8px;align-items:center;color:#b8c8d7;white-space:nowrap;font-size:14px}
.dot{width:11px;height:11px;border-radius:50%;background:var(--warn);box-shadow:0 0 0 5px #ffd1661a}
.dot.good{background:var(--good);box-shadow:0 0 0 5px #65df911a}.dot.bad{background:var(--bad)}
.controls{justify-content:flex-start;flex-wrap:wrap;background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:8px 10px}
.control{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px;font-weight:800}
select,button{height:40px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:10px;padding:0 11px;font-weight:800}
button{cursor:pointer}.control-spacer{flex:1}
.radar-wrap{position:relative;min-height:570px;border:1px solid var(--line);border-radius:18px;overflow:hidden;
  background:radial-gradient(circle at center,#112b3d 0,#0b1c2a 55%,#07111b 100%)}
#radar{display:block;width:100%;height:100%;min-height:570px}
.hudbar{position:absolute;left:12px;top:12px;z-index:3;display:flex;align-items:center;gap:9px;
  background:#07111be8;border:1px solid #ffffff1c;border-radius:11px;padding:7px 10px;backdrop-filter:blur(8px);
  font-size:11px;color:var(--muted);pointer-events:none}
.hudbar strong{color:var(--text);font-size:13px}.hudsep{opacity:.45}
.plane{cursor:pointer}.plane-label{paint-order:stroke;stroke:#07111b;stroke-width:4px;stroke-linejoin:round;font-weight:800}
.plane-sub{paint-order:stroke;stroke:#07111b;stroke-width:3px;stroke-linejoin:round;font-weight:700}
.vector{stroke:#8bc5df;stroke-width:1.4;opacity:.72}.trail{fill:none;stroke:#58b8e6;stroke-width:2.2;opacity:.62;stroke-linecap:round;stroke-linejoin:round}.trail-dot{fill:#58b8e6;opacity:.72}
.selected-ring{fill:none;stroke:var(--select);stroke-width:2.5;opacity:.9}
.detail{position:absolute;right:12px;bottom:12px;width:min(410px,calc(100% - 24px));background:#0d1925f5;border:1px solid var(--line);
  border-radius:16px;padding:15px;display:none;box-shadow:0 16px 44px #0008;z-index:5}
.detail h2{margin:4px 0 3px;font-size:27px}.detail-subtitle{color:var(--muted);font-size:12px;margin-bottom:12px}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.detail-grid div{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:8px}
.detail-grid span,.detail-grid strong{display:block}.detail-grid span{font-size:9px;color:var(--muted);margin-bottom:3px;letter-spacing:.05em}
.detail-grid strong{font-size:14px}.close{position:absolute;right:8px;top:8px;width:36px;padding:0;font-size:21px}
.notice{position:absolute;left:12px;right:12px;bottom:12px;background:#4a3b16dd;border:1px solid #ffd16655;color:#ffe6a3;
  padding:8px 10px;border-radius:10px;font-size:11px;display:none;z-index:4}
.notice.fatal{background:#45171bdd;border-color:#ff717966;color:#ffd6d8}
.footer{font-size:10px;color:var(--muted);padding:1px 4px}
.legend{position:absolute;right:12px;top:12px;color:#6e879b;font-size:10px;z-index:2;pointer-events:none;text-align:right}
@media(max-width:760px){
  header{align-items:flex-start}.status{font-size:12px}.app{grid-template-rows:auto auto minmax(620px,1fr) auto}
  .radar-wrap,#radar{min-height:620px}.control-spacer{display:none}.footer{flex-direction:column;align-items:flex-start}
  .hudbar{max-width:calc(100% - 24px);overflow:hidden;white-space:nowrap}
}
</style>
</head>
<body>
<main class="app">
<header>
  <div><div class="eyebrow">AVIATION LIVE TRAFFIC</div><h1>Alpena Area</h1></div>
  <div class="status"><span id="dot" class="dot"></span><span id="status">Connecting…</span></div>
</header>

<section class="controls">
  <label class="control">Range
    <select id="range">
      <option value="25">25 NM</option><option value="50">50 NM</option><option value="100" selected>100 NM</option>
      <option value="150">150 NM</option><option value="200">200 NM</option><option value="250">250 NM</option>
    </select>
  </label>
  <label class="control">Labels
    <select id="labels">
      <option value="full" selected>Callsign + alt/speed</option>
      <option value="callsign">Callsign only</option><option value="altitude">Altitude only</option><option value="none">None</option>
    </select>
  </label>
  <label class="control">Trails
    <select id="trails">
      <option value="0" selected>Off</option><option value="60">1 min</option><option value="300">5 min</option>
    </select>
  </label>
  <label class="control">Traffic
    <select id="trafficFilter">
      <option value="all" selected>All</option><option value="airline">Airline</option><option value="ga">GA</option>
    </select>
  </label>
  <label class="control">Altitude
    <select id="altFilter">
      <option value="all" selected>All</option><option value="low">&lt; 5K</option><option value="mid">5K–15K</option><option value="high">&gt; 15K</option>
    </select>
  </label>
  <span class="control-spacer"></span>
  <button id="refresh" type="button">Refresh</button>
</section>

<section class="radar-wrap">
  <svg id="radar" viewBox="0 0 1000 700" aria-label="Live aircraft radar">
    <defs><filter id="glow"><feGaussianBlur stdDeviation="1.8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <g id="grid"></g><g id="trailsLayer"></g><g id="planes"></g>
  </svg>
  <div class="hudbar">
    <strong id="count">—</strong><span>AIRCRAFT</span><span class="hudsep">|</span>
    <strong id="rangeHud">100</strong><span>NM</span><span class="hudsep">|</span>
    <strong id="ageHud">—</strong><span>DATA AGE</span><span class="hudsep">|</span>
    <strong id="trailHud">OFF</strong><span>TRAIL</span>
  </div>
  <div class="legend">Click an aircraft for details</div>
  <div id="notice" class="notice"></div>
  <aside id="detail" class="detail">
    <button id="close" class="close" type="button" aria-label="Close">×</button>
    <div class="eyebrow">SELECTED AIRCRAFT</div>
    <h2 id="dtitle">—</h2>
    <div id="dsubtitle" class="detail-subtitle">—</div>
    <div class="detail-grid">
      <div><span>ALTITUDE</span><strong id="dalt">—</strong></div>
      <div><span>GROUND SPEED</span><strong id="dgs">—</strong></div>
      <div><span>VERTICAL RATE</span><strong id="dvr">—</strong></div>
      <div><span>TRACK</span><strong id="dtrack">—</strong></div>
      <div><span>DISTANCE FROM KAPN</span><strong id="ddist">—</strong></div>
      <div><span>BEARING FROM KAPN</span><strong id="dbrg">—</strong></div>
      <div><span>SQUAWK</span><strong id="dsq">—</strong></div>
      <div><span>POSITION AGE</span><strong id="dage">—</strong></div>
    </div>
  </aside>
</section>

<footer class="footer"><span id="source">Direct browser ADS-B feed</span><span>Home/office/hangar display — not for navigation or collision avoidance</span></footer>
</main>

<script>
(()=>{
"use strict";
const CENTER={lat:45.0781,lon:-83.5603},POLL=30000,NS="http://www.w3.org/2000/svg";
const $=id=>document.getElementById(id),grid=$("grid"),planes=$("planes"),trailsLayer=$("trailsLayer"),notice=$("notice"),detail=$("detail");
const controls={range:$("range"),labels:$("labels"),trails:$("trails"),traffic:$("trafficFilter"),alt:$("altFilter")};

const SOURCES=[
  {name:"Airplanes.live",url:(lat,lon,r)=>"https://api.airplanes.live/v2/point/"+lat+"/"+lon+"/"+r,rows:d=>Array.isArray(d.ac)?d.ac:[]},
  {name:"ADSB.lol",url:(lat,lon,r)=>"https://api.adsb.lol/v2/point/"+lat+"/"+lon+"/"+r,rows:d=>Array.isArray(d.ac)?d.ac:[]},
  {name:"adsb.fi",url:(lat,lon,r)=>"https://opendata.adsb.fi/api/v3/lat/"+lat+"/lon/"+lon+"/dist/"+r,rows:d=>Array.isArray(d.aircraft)?d.aircraft:(Array.isArray(d.ac)?d.ac:[])},
  {name:"ADSB One",url:(lat,lon,r)=>"https://api.adsb.one/v2/point/"+lat+"/"+lon+"/"+r,rows:d=>Array.isArray(d.ac)?d.ac:[]}
];

let last=[],timer=null,busy=false,everLive=false,lastGoodAt=0,selectedHex=null,lastManualRefresh=0;
const history=new Map();
const prefsKey="aviationLiveTrafficPrefsV17";
const historyKey="aviationLiveTrafficHistoryV17";
const snapshotKey="aviationLiveTrafficLastGoodV17";

function S(tag,a={},t=null){const n=document.createElementNS(NS,tag);Object.entries(a).forEach(([k,v])=>n.setAttribute(k,String(v)));if(t!==null)n.textContent=t;return n}
function status(kind,text){$("dot").className="dot"+(kind?" "+kind:"");$("status").textContent=text}
function alt(a){if(a.alt_baro==="ground")return"GROUND";const n=Number(a.alt_baro??a.alt_geom);return Number.isFinite(n)?Math.round(n).toLocaleString()+" ft":"—"}
function altNum(a){const n=Number(a.alt_baro??a.alt_geom);return Number.isFinite(n)?n:null}
function name(a){return(a.flight&&String(a.flight).trim())||a.r||(a.hex?String(a.hex).toUpperCase():"UNKNOWN")}
function subtitle(a){const bits=[a.r,a.t,a.ownOp].filter(Boolean);return bits.length?bits.join(" · "):"Aircraft details"}
function nm(a,b,c,d){const R=3440.065,r=x=>x*Math.PI/180,p1=r(a),p2=r(c),dp=r(c-a),dl=r(d-b),h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)))}
function brg(a,b,c,d){const r=x=>x*Math.PI/180,D=x=>x*180/Math.PI,p1=r(a),p2=r(c),dl=r(d-b),y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);return(D(Math.atan2(y,x))+360)%360}
function ageSec(a){const n=Number(a.seen_pos??a.seen);return Number.isFinite(n)?Math.max(0,n):0}
function opacityFor(a){const s=ageSec(a);if(s<=5)return 1;if(s>=30)return .28;return 1-(s-5)/25*.72}
function isAirline(a){const f=(a.flight||"").trim();return /^[A-Z]{3}\\d+[A-Z]?$/.test(f)}
function matchesFilters(a){
  if(controls.traffic.value==="airline"&&!isAirline(a))return false;
  if(controls.traffic.value==="ga"&&isAirline(a))return false;
  const h=altNum(a);
  if(controls.alt.value==="low"&&(h===null||h>=5000))return false;
  if(controls.alt.value==="mid"&&(h===null||h<5000||h>15000))return false;
  if(controls.alt.value==="high"&&(h===null||h<=15000))return false;
  return true
}
function savePrefs(){try{localStorage.setItem(prefsKey,JSON.stringify({range:controls.range.value,labels:controls.labels.value,trails:controls.trails.value,traffic:controls.traffic.value,alt:controls.alt.value}))}catch{}}
function loadPrefs(){try{const p=JSON.parse(localStorage.getItem(prefsKey)||"null");if(!p)return;if(p.range)controls.range.value=p.range;if(p.labels)controls.labels.value=p.labels;if(p.trails)controls.trails.value=p.trails;if(p.traffic)controls.traffic.value=p.traffic;if(p.alt)controls.alt.value=p.alt}catch{}}
function saveSnapshot(source){try{localStorage.setItem(snapshotKey,JSON.stringify({aircraft:last,source,generatedAt:new Date(lastGoodAt).toISOString(),savedAt:Date.now()}))}catch{}}
function restoreSnapshot(){try{const snap=JSON.parse(localStorage.getItem(snapshotKey)||"null");if(!snap||!Array.isArray(snap.aircraft)||Date.now()-Number(snap.savedAt)>30*60*1000)return false;last=snap.aircraft;lastGoodAt=Date.parse(snap.generatedAt)||Number(snap.savedAt);everLive=true;$("source").textContent="Last saved: "+(snap.source||"ADS-B");draw(last);status("","Connecting · saved traffic shown");return true}catch{return false}}
function loadHistory(){try{const raw=JSON.parse(localStorage.getItem(historyKey)||"{}"),cutoff=Date.now()-310000;for(const [hex,pts] of Object.entries(raw)){if(!Array.isArray(pts))continue;const clean=pts.filter(p=>p&&Number(p.t)>=cutoff&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))).map(p=>({t:Number(p.t),lat:Number(p.lat),lon:Number(p.lon)}));if(clean.length)history.set(hex,clean)}}catch{}}
function saveHistory(){try{const out={},cutoff=Date.now()-310000;for(const [hex,pts] of history){const clean=pts.filter(p=>p.t>=cutoff).slice(-30);if(clean.length)out[hex]=clean}localStorage.setItem(historyKey,JSON.stringify(out))}catch{}}

function drawGrid(){grid.replaceChildren();const cx=500,cy=350,R=300,m=Number(controls.range.value)||100;grid.append(S("line",{x1:cx-R,y1:cy,x2:cx+R,y2:cy,stroke:"#2e4a60"}));grid.append(S("line",{x1:cx,y1:cy-R,x2:cx,y2:cy+R,stroke:"#2e4a60"}));[.25,.5,.75,1].forEach((f,i)=>{grid.append(S("circle",{cx,cy,r:R*f,fill:"none",stroke:i===3?"#52758d":"#36546a","stroke-width":i===3?2:1.2}));grid.append(S("text",{x:cx+8,y:cy-R*f+16,fill:"#7891a4","font-size":13,"font-weight":700},Math.round(m*f)+" NM"))});[["N",cx,cy-R-18],["E",cx+R+20,cy+5],["S",cx,cy+R+30],["W",cx-R-22,cy+5]].forEach(c=>grid.append(S("text",{x:c[1],y:c[2],fill:"#bfd0dd","font-size":15,"font-weight":900,"text-anchor":"middle"},c[0])));grid.append(S("circle",{cx,cy,r:4,fill:"#70d6ff",filter:"url(#glow)"}));grid.append(S("text",{x:cx+10,y:cy-10,fill:"#a1bacb","font-size":12,"font-weight":800},"KAPN"))}
function displayLabel(a){const mode=controls.labels.value;if(mode==="none")return{top:"",sub:""};if(mode==="altitude")return{top:alt(a).replace(" ft",""),sub:""};if(mode==="callsign")return{top:name(a),sub:""};const gs=Number(a.gs);return{top:name(a),sub:alt(a).replace(" ft","")+" · "+(Number.isFinite(gs)?Math.round(gs)+"kt":"—")}}
function showDetail(a){selectedHex=a.hex||null;$("dtitle").textContent=name(a);$("dsubtitle").textContent=subtitle(a);$("dalt").textContent=alt(a);$("dgs").textContent=Number.isFinite(Number(a.gs))?Math.round(Number(a.gs))+" kt":"—";$("dvr").textContent=Number.isFinite(Number(a.baro_rate))?Math.round(Number(a.baro_rate))+" fpm":"—";$("dtrack").textContent=Number.isFinite(Number(a.track))?Math.round(Number(a.track))+"°":"—";const d=nm(CENTER.lat,CENTER.lon,Number(a.lat),Number(a.lon)),b=brg(CENTER.lat,CENTER.lon,Number(a.lat),Number(a.lon));$("ddist").textContent=d.toFixed(1)+" NM";$("dbrg").textContent=Math.round(b).toString().padStart(3,"0")+"°";$("dsq").textContent=a.squawk||"—";$("dage").textContent=Math.round(ageSec(a))+" sec";detail.style.display="block";draw(last)}
function addHistory(list){const now=Date.now();for(const a of list){if(!a.hex||!Number.isFinite(Number(a.lat))||!Number.isFinite(Number(a.lon)))continue;const arr=history.get(a.hex)||[],prev=arr[arr.length-1];if(!prev||Math.abs(prev.lat-Number(a.lat))>.00001||Math.abs(prev.lon-Number(a.lon))>.00001)arr.push({t:now,lat:Number(a.lat),lon:Number(a.lon)});while(arr.length&&now-arr[0].t>310000)arr.shift();history.set(a.hex,arr)}saveHistory()}
function radarXY(lat,lon,maxNm){const cx=500,cy=350,R=300,d=nm(CENTER.lat,CENTER.lon,lat,lon),b=brg(CENTER.lat,CENTER.lon,lat,lon),ang=(b-90)*Math.PI/180,pr=d/maxNm*R;return{x:cx+Math.cos(ang)*pr,y:cy+Math.sin(ang)*pr,d,b}}
function rectOverlap(a,b,pad=3){return !(a.x2+pad<b.x1||a.x1-pad>b.x2||a.y2+pad<b.y1||a.y1-pad>b.y2)}
function drawTrails(maxNm){trailsLayer.replaceChildren();const seconds=Number(controls.trails.value)||0;if(!seconds){$("trailHud").textContent="OFF";return}const cutoff=Date.now()-seconds*1000;let tracks=0,maxPoints=0;for(const a of last){if(!matchesFilters(a)||!a.hex)continue;const arr=(history.get(a.hex)||[]).filter(p=>p.t>=cutoff);maxPoints=Math.max(maxPoints,arr.length);if(arr.length<2)continue;const pts=arr.map(p=>radarXY(p.lat,p.lon,maxNm)).filter(p=>p.d<=maxNm);if(pts.length<2)continue;const d=pts.map((p,i)=>(i?"L":"M")+p.x.toFixed(1)+" "+p.y.toFixed(1)).join(" ");trailsLayer.append(S("path",{d,class:"trail",opacity:a.hex===selectedHex?.9:.62}));for(const pt of pts.slice(0,-1))trailsLayer.append(S("circle",{cx:pt.x.toFixed(1),cy:pt.y.toFixed(1),r:1.8,class:"trail-dot"}));tracks++}$("trailHud").textContent=tracks?tracks+" TRACKS":(maxPoints?"BUILDING":"WAITING")}
function draw(list){planes.replaceChildren();const max=Number(controls.range.value)||100;$("rangeHud").textContent=String(max);drawTrails(max);const visible=[];for(const a of list){if(!matchesFilters(a)||!Number.isFinite(Number(a.lat))||!Number.isFinite(Number(a.lon)))continue;const p=radarXY(Number(a.lat),Number(a.lon),max);if(p.d<=max)visible.push({a,p})}const labelRects=[];visible.sort((u,v)=>u.a.hex===selectedHex?-1:v.a.hex===selectedHex?1:ageSec(u.a)-ageSec(v.a));for(const {a,p} of visible){const tr=Number.isFinite(Number(a.track))?Number(a.track):0,op=opacityFor(a),g=S("g",{class:"plane",transform:"translate("+p.x.toFixed(1)+" "+p.y.toFixed(1)+")",opacity:op}),vecLen=Math.max(13,Math.min(34,(Number(a.gs)||150)/15)),va=(tr-90)*Math.PI/180;g.append(S("line",{x1:0,y1:0,x2:(Math.cos(va)*vecLen).toFixed(1),y2:(Math.sin(va)*vecLen).toFixed(1),class:"vector"}));if(a.hex===selectedHex)g.append(S("circle",{cx:0,cy:0,r:14,class:"selected-ring"}));g.append(S("path",{d:"M 0 -8 L 2.5 -1.5 L 9 1.5 L 9 4 L 2.5 3 L 1.5 7.5 L 4.5 10 L 4.5 12 L 0 10.5 L -4.5 12 L -4.5 10 L -1.5 7.5 L -2.5 3 L -9 4 L -9 1.5 L -2.5 -1.5 Z",fill:a.hex===selectedHex?"#ffd166":"#f8fbff",stroke:"#07111b","stroke-width":1.3,transform:"rotate("+tr+")",filter:"url(#glow)"}));const lab=displayLabel(a);if(lab.top){const hash=(a.hex||name(a)).split("").reduce((sum,c)=>sum+c.charCodeAt(0),0),side=hash%2===0?1:-1,lx=side>0?13:-13,anchor=side>0?"start":"end",width=Math.max(lab.top.length*7.1,(lab.sub||"").length*6.1),rect={x1:p.x+(side>0?lx:lx-width),x2:p.x+(side>0?lx+width:lx),y1:p.y-16,y2:p.y+(lab.sub?17:5)},collide=labelRects.some(r=>rectOverlap(rect,r,4));if(!collide||a.hex===selectedHex){g.append(S("text",{x:lx,y:-7,fill:"#f4f7fb","font-size":11.5,class:"plane-label","text-anchor":anchor},lab.top));if(lab.sub)g.append(S("text",{x:lx,y:7,fill:"#9fc1d2","font-size":9.5,class:"plane-sub","text-anchor":anchor},lab.sub));labelRects.push(rect)}}g.addEventListener("click",()=>showDetail(a));planes.append(g)}$("count").textContent=String(visible.length)}
function updateAgeHud(){if(!lastGoodAt){$("ageHud").textContent="—";return}$("ageHud").textContent=Math.max(0,Math.round((Date.now()-lastGoodAt)/1000))+"s"}

async function fetchJson(url,timeoutMs=9000){
  const controller=new AbortController(),t=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url,{mode:"cors",cache:"no-store",signal:controller.signal,referrerPolicy:"no-referrer"});
    if(!response.ok)throw new Error("HTTP "+response.status);
    return await response.json();
  }finally{clearTimeout(t)}
}

async function load(force=false){
  if(busy)return false;
  busy=true;
  const btn=$("refresh"),oldText=btn.textContent;
  if(force){btn.disabled=true;btn.textContent="Refreshing…"}
  status("",everLive?"Updating…":"Connecting…");notice.style.display="none";
  const r=Number(controls.range.value)||100,errors=[];
  let success=false;
  try{
    for(const source of SOURCES){
      try{
        const data=await fetchJson(source.url(CENTER.lat,CENTER.lon,r)+(force?((source.url(CENTER.lat,CENTER.lon,r).includes("?")?"&":"?")+"_="+Date.now()):""));
        const rows=source.rows(data);
        if(!Array.isArray(rows))throw new Error("Unexpected response");
        last=rows;
        lastGoodAt=Date.now();
        addHistory(last);draw(last);everLive=true;saveSnapshot(source.name);
        $("source").textContent="Direct data: "+source.name;
        status("good","Live · "+source.name);
        if(selectedHex){const selected=last.find(a=>a.hex===selectedHex);if(selected)showDetail(selected)}
        success=true;
        break;
      }catch(e){errors.push(source.name+": "+(e&&e.message?e.message:String(e)))}
    }
    if(!success)throw new Error(errors.join(" | "));
  }catch(e){
    if(everLive&&last.length){
      draw(last);status("","Holding last good data");
      notice.className="notice";notice.textContent="Live refresh missed. Last good traffic remains on screen. "+e.message;notice.style.display="block"
    }else{
      status("bad","Waiting for feed");notice.className="notice fatal";
      notice.textContent="Direct browser feeds failed: "+e.message;notice.style.display="block"
    }
  }finally{
    busy=false;updateAgeHud();
    if(force){btn.textContent=success?"Updated":"No new data";setTimeout(()=>{btn.disabled=false;btn.textContent=oldText},900)}
  }
  return success;
}

function redrawAndSave(){savePrefs();drawGrid();draw(last)}
function restart(){clearInterval(timer);redrawAndSave();load(false);timer=setInterval(()=>load(false),POLL)}

controls.range.addEventListener("change",restart);
[controls.labels,controls.trails,controls.traffic,controls.alt].forEach(c=>c.addEventListener("change",redrawAndSave));
$("refresh").addEventListener("click",()=>{const now=Date.now();if(now-lastManualRefresh<5000)return;lastManualRefresh=now;load(true)});
$("close").addEventListener("click",()=>{detail.style.display="none";selectedHex=null;draw(last)});
document.addEventListener("visibilitychange",()=>{if(document.hidden)clearInterval(timer);else restart()});

loadPrefs();loadHistory();drawGrid();restoreSnapshot();restart();setInterval(updateAgeHud,1000);
})();
</script>
</body></html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ok:true,version:"1.7",architecture:"browser-direct-adsb"}), {
        headers: {"content-type":"application/json","cache-control":"no-store"}
      });
    }
    return new Response(PAGE, {
      headers: {"content-type":"text/html; charset=utf-8","cache-control":"no-store"}
    });
  }
};
