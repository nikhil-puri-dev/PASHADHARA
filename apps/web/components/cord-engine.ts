// @ts-nocheck
import recordedShowcase from "./showcase-recorded.json";
import proofEvidence from "./proof-evidence.json";
/* Pashadhara cord engine. Ported from design/cord/index.html. It drives the whole interface
   imperatively into #hdr, #main and #ftr, exactly as the approved prototype does. */
export function startCord(): () => void {
const ac=new AbortController();
const on=(t,ev,fn)=>t.addEventListener(ev,fn,{signal:ac.signal});
const timeouts=new Set();
const later=(fn,ms)=>{const id=setTimeout(()=>{timeouts.delete(id);fn()},ms);timeouts.add(id);return id};
/* =============================================================
   Money is integer cents. Nothing here is a float.
============================================================= */
let CAP=2000;
const fmt=c=>"$"+(c/100).toFixed(2);
const feeC=c=>Math.round(49+0.0349*c);          // computed model, three measured points fit it
const $=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s).replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));
const TAG_TIP={measured:"Came back from a PayPal sandbox call",computed:"Derived by our code or verified in a test",documented:"What PayPal's docs say. We have not tested it",fixture:"Sample data for this prototype",recorded:"Recorded from a real sandbox run"};
const tagHtml=(k,t)=>`<span class="tag ${k}" title="${TAG_TIP[k]||""}">${t||k}</span>`;
const datedTag=(kind,date,note="")=>`${tagHtml(kind)}${note?" "+note:""} · <span class="tag-date">${date}</span>`;
const KEY_HTML=`<span class="key" role="group" aria-label="Key"><span><i class="sw gold"></i>captured</span><span><i class="sw owed"></i>committed</span><span><i class="sw free"></i>uncommitted</span></span>`;
const closedLabel=()=>S.showcase?.mode==="fixture"?"uncommitted in fixture":S.showcase?.ended||S.liveEnded?"uncommitted at last read":"free to spend";
/* a row: words hard left, tags hard right */
const trow=(msg,tags,cls="")=>`<div class="trow${cls?" "+cls:""}"><span class="msg">${msg}</span><span class="tags">${tags}</span></div>`;
const GOLD="#C8A24A";
const PART_TIP={
  captured:"Captured. These paid calls have been collected from the hold.",
  owed:"Owed. These calls are made and still held, not yet captured.",
  free:"Uncommitted in the journal. Spendability depends on the lease and honor window.",
  "captured-edge":"Where captured length ends and owed length begins.",
  "free-edge":"Where owed length ends and free length begins.",
  cut:"The cut. Length past this point was released.",
   released:"Released in this sample. A real void would ask PayPal to release the remaining hold."
};
const LEVEL_NAMES=["Tens","Dollars","Dimes","Cents"];

const SAMPLE=()=>[
  {id:1,tool:"flights.search",c:120,st:"captured",t:"09:02"},
  {id:2,tool:"pdf.extract",c:75,st:"captured",t:"09:04"},
  {id:3,tool:"geocode.batch",c:250,st:"captured",t:"09:11"},
  {id:4,tool:"filings.fetch",c:300,st:"captured",t:"09:15"},
  {id:5,tool:"translate.es",c:40,st:"accrued",t:"09:38"},
  {id:6,tool:"pdf.extract",c:115,st:"accrued",t:"09:41"},
  {id:7,tool:"web.search",c:35,st:"accrued",t:"09:44"}
];
const QUEUE=[["maps.route",60],["filings.fetch",225],["summarize.long",475],["web.search",35],["pdf.extract",115],["translate.es",40],["summarize.long",475],["maps.route",60]];

const S={
  status:"active",       // active | voided | none
  calls:SAMPLE(),
  q:0, nextId:8, clock:9*60+46,
  running:false, timer:null,
  log:[{t:"09:44",m:"Committed $0.35 to web.search."}],
  refused:0, settles:[], voided:null,
  ui:{sel:null,voidOpen:false,approve:"idle",settleN:null,settleBusy:false,settleDone:null,
      esc:{a:{v:2,s:88},b:{v:1,s:64}}}
};
const sums=()=>{
  const b=S.user?.showcase?S.showcase?.lease?.balances:S.user?.live?S.privateBalances:null;
  if(b){
    return {C:b.total_captured,A:b.committed_unsettled,F:b.hold_available,held:b.hold_available+b.committed_unsettled};
  }
  let C=0,A=0;for(const k of S.calls){if(k.st==="captured")C+=k.c;else if(k.st==="accrued")A+=k.c}
  return {C,A,F:S.status==="voided"?0:CAP-C-A,held:S.status==="voided"?0:CAP-C}};
const clockStr=m=>String(Math.floor(m/60)%24).padStart(2,"0")+":"+String(m%60).padStart(2,"0");
const say=m=>{$("#live").textContent=m};

/* =============================================================
   The cord. One drawing, used on Lease, Proof, and as a slim
   status strip. Quipu rules: pendants hang from one main cord,
   and the amount is tied as knots by decimal place.
============================================================= */
const LEVELS=[36,98,160,222];
const digits=c=>[Math.floor(c/1000)%10,Math.floor(c/100)%10,Math.floor(c/10)%10,c%10];
const NSLOT=16;
const reduceMotion=matchMedia("(prefers-reduced-motion:reduce)");
const fineHover=matchMedia("(hover:hover) and (pointer:fine)");
const easeOut="cubic-bezier(.23, 1, .32, 1)";

function motion(el,frames,duration,fill="none"){
  if(el&&!reduceMotion.matches)return el.animate(frames,{duration,easing:easeOut,fill});
}
function arrive(el,duration=150,opacity=.74){
  return motion(el,[{opacity},{opacity:1}],duration);
}
function changeText(el,text,animate=true){
  if(el.textContent===text)return;
  el.textContent=text;
  if(animate)arrive(el);
}
function paintText(el,html,targets,animate=true){
  if(!el||el.innerHTML===html)return;
  const before=animate?[...el.querySelectorAll(targets)].map(n=>n.textContent):[];
  el.innerHTML=html;
  if(before.length)el.querySelectorAll(targets).forEach((n,i)=>{
    if(n.textContent!==before[i]&&!n.matches(".tag")&&!n.querySelector(".tag"))arrive(n);
  });
}


/* =============================================================
   Motion, step 2. Every interaction decided before it was coded:
   refusal   rare, state    90 ms taut, 60 ms freeze, damped spring 640 ms, linear samples of a spring (WAAPI)
   approve   rare, state    700 ms knot ease-out, 800 ms ground cross-fade, 1700 ms sheen once
   spend     often, state   fixed 320 ms drop then a 900 ms damped swing, same for every call
   capture   state          400 ms outlined knot fades into gold
   void      rare, state    1200 ms hold (ring fills linearly), 900 ms untie from the free end
   idle      ambience       1 px breath over 8 s on the cord only, paused when off screen
   reduced   zero movement, same words; the 120 ms button press stays
============================================================= */
const TAU=Math.PI*2;
const damped=(amp,zeta,hz,ms,fn)=>{
  const w=TAU*hz, wd=w*Math.sqrt(1-zeta*zeta), n=Math.max(2,Math.round(ms/16)), out=[];
  for(let i=0;i<=n;i++){const t=i/n*ms/1000;out.push(amp*Math.exp(-zeta*w*t)*fn(wd*t))}
  return out;
};
const easeOut3=t=>1-Math.pow(1-t,3);
const REFUSE={taut:90,freeze:60,swing:640};
const REFUSE_MS=REFUSE.taut+REFUSE.freeze+REFUSE.swing;
const DROP_MS=320, SWING_MS=900;

/* sound: synthesised, no files, off until the visitor turns it on */
const SOUND_KEY="pashadhara-sound";
const soundOn=()=>{try{return localStorage.getItem(SOUND_KEY)==="on"}catch(e){return false}};
let AC=null;
function audio(){
  try{
    if(!AC){const C=window.AudioContext||window.webkitAudioContext;if(!C)return null;AC=new C()}
    if(AC.state==="suspended")AC.resume().catch(()=>{});
    return AC;
  }catch(e){return null}
}
function sfx(kind){
  if(!soundOn())return;
  const c=audio(); if(!c||c.state==="closed")return;
  const t=c.currentTime, out=c.createGain(); out.connect(c.destination);
  const tone=(f0,f1,dur,gain,type="sine",at=0)=>{
    const o=c.createOscillator(), g=c.createGain();
    o.type=type; o.frequency.setValueAtTime(f0,t+at); o.frequency.exponentialRampToValueAtTime(f1,t+at+dur);
    g.gain.setValueAtTime(0.0001,t+at); g.gain.exponentialRampToValueAtTime(gain,t+at+.004); g.gain.exponentialRampToValueAtTime(0.0001,t+at+dur);
    o.connect(g); g.connect(out); o.start(t+at); o.stop(t+at+dur+.02);
  };
  if(kind==="refuse"){                       // a dry tick, then a short low knock
    const len=Math.floor(c.sampleRate*.018), buf=c.createBuffer(1,len,c.sampleRate), d=buf.getChannelData(0);
    for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/len,3);
    const src=c.createBufferSource(), hp=c.createBiquadFilter(), g=c.createGain();
    src.buffer=buf; hp.type="bandpass"; hp.frequency.value=2600; hp.Q.value=1.1; g.gain.value=.5;
    src.connect(hp); hp.connect(g); g.connect(out); src.start(t);
    tone(190,110,.11,.22,"sine",.09);
  }else if(kind==="drop"){ tone(92,58,.13,.26)}    // the drum beat of a paid call
  else if(kind==="void"){ tone(64,40,.32,.3)}
}
function syncSound(){
  const on=soundOn();
  document.querySelectorAll('[data-act="sound"]').forEach(b=>{b.setAttribute("aria-pressed",String(on));b.textContent=on?"Sound on":"Sound off"});
}
function feel(kind,haptic){
  sfx(kind);
  if(haptic&&navigator.vibrate&&navigator.userActivation?.hasBeenActive){try{navigator.vibrate(kind==="void"?30:18)}catch(e){}}
}

/* refusal: the cord goes taut, freezes, springs back, the free length flashes cochineal once */
function refuseFx(root,haptic){
  const svg=root&&root.querySelector("svg"); if(!svg||reduceMotion.matches)return 0;
  const rail=$(".rail",svg), pins=$(".pendants",svg), layer=$(".cord-fx",svg);
  if(!rail||!pins)return 0;
  const {taut,freeze,swing}=REFUSE, A=.022, frames=[], at=ms=>ms/REFUSE_MS;
  for(let i=0;i<=6;i++)frames.push({offset:at(taut*i/6),transform:`scaleX(${1+A*easeOut3(i/6)})`});
  frames.push({offset:at(taut+freeze),transform:`scaleX(${1+A})`});
  const sp=damped(A,.2,4.4,swing,Math.cos);
  for(let i=1;i<sp.length;i++)frames.push({offset:at(taut+freeze+swing*i/(sp.length-1)),transform:`scaleX(${1+sp[i]})`});
  for(const n of [rail,pins,layer]){if(!n)continue;n.style.transformOrigin="64px 62px";n.animate(frames,{duration:REFUSE_MS,easing:"linear"})}
  [...pins.querySelectorAll(".pen")].forEach((pen,i)=>{
    const len=Number(pen.dataset.length)||300, hz=2.9*Math.sqrt(300/len), sw=damped(-5.2,.14,hz,SWING_MS,Math.sin);
    pen.animate(sw.map((v,j)=>({offset:j/(sw.length-1),transform:`rotate(${v}deg)`})),{duration:SWING_MS,delay:taut+freeze+i*14,easing:"linear"});
  });
  later(()=>{
    const free=$('[data-part="free"]',rail); if(!free||!layer)return;
    const c=free.cloneNode(true); const first=c.querySelector("rect"); if(first)first.setAttribute("fill","#DB2C57");
    overlay(layer,[c],[{opacity:0},{opacity:1,offset:.3},{opacity:0}],240);
  },taut+freeze);
  feel("refuse",haptic);
  return REFUSE_MS;
}

/* a paid call: drops on a fixed beat, swings, settles */
function dropPendant(node){
  if(reduceMotion.matches)return;
  const len=Number(node.dataset.length)||300, hz=2.6*Math.sqrt(300/len), sw=damped(-3.6,.16,hz,SWING_MS,Math.sin), total=DROP_MS+SWING_MS;
  const fr=[{offset:0,transform:"translateY(-34px) rotate(0deg)",opacity:0,easing:easeOut},{offset:DROP_MS/total,transform:"translateY(0) rotate(0deg)",opacity:1}];
  for(let i=1;i<sw.length;i++)fr.push({offset:(DROP_MS+SWING_MS*i/(sw.length-1))/total,transform:`translateY(0) rotate(${sw[i]}deg)`,opacity:1});
  node.animate(fr,{duration:total,easing:"linear"});
  later(()=>feel("drop"),DROP_MS);
}

/* approval: the knot pulls tight, the ground crosses to pearl (CSS), one slow sheen runs along the cord */
function approveFx(root){
  const svg=root&&root.querySelector("svg"); if(!svg||reduceMotion.matches)return;
  const loop=$(".loop",svg), layer=$(".cord-fx",svg); if(!layer)return;
  if(loop){loop.style.transformOrigin="41px 62px";loop.animate([{transform:"scale(1.3,1.12)"},{transform:"scale(1)"}],{duration:700,easing:easeOut})}
  const vb=svg.viewBox.baseVal, L=vb.height>vb.width?820:1072, id="sh"+Math.random().toString(36).slice(2,7), g=document.createElementNS(layer.namespaceURI,"g");
  g.innerHTML=`<defs><linearGradient id="${id}g"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".62"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><clipPath id="${id}c"><rect x="64" y="53" width="${L}" height="18"/></clipPath></defs><g clip-path="url(#${id}c)"><rect class="sheen" x="-86" y="53" width="150" height="18" fill="url(#${id}g)"/></g>`;
  layer.append(g);
  const band=g.querySelector(".sheen");
  const a=band.animate([{transform:"translateX(0)"},{transform:`translateX(${L+150}px)`}],{duration:1700,easing:"linear"});
  a.finished.then(()=>g.remove(),()=>g.remove());
}

function cordSVG(o,retained){
  const N=o.N||NSLOT, vertical=!!o.vertical, L=vertical?(o.compactV?160:820):1072, x0=64, y0=62, cap=o.cap||CAP;
  const ps=o.ps||1, KS=ps<1?5.6:7;      // ps: pendant scale, so a hero cord fits the first screen
  const k=L/cap, z=o.ghost?0:1, wC=o.C*k*z, wA=o.A*k*z, wF=o.F*k*z;
  const scope=o.live||"cord", ply=`url(#${scope}-ply)`, hatch=`url(#${scope}-hatch)`, soft=`url(#${scope}-soft)`;
  const defs=`<defs>
    <pattern id="${scope}-ply" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="7" height="7" fill="none"/><line x1="0" y1="0" x2="0" y2="7" stroke="#231F1B" stroke-opacity=".3" stroke-width="1.6"/></pattern>
    <pattern id="${scope}-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><line x1="0" y1="0" x2="0" y2="7" stroke="#231F1B" stroke-opacity=".38" stroke-width="1.2"/></pattern>
    <pattern id="${scope}-fibre" width="23" height="17" patternUnits="userSpaceOnUse"><path d="M2 3l5 1.2M13 2l4 -.4M8 8l6 1.6M19 7l3 .9M1 13l4 -.8M11 14l6 .6M4 10l2 -1.4M16 12l3 1.1" stroke="#231F1B" stroke-opacity=".34" stroke-width=".7" stroke-linecap="round" fill="none"/><path d="M5 6l3 -.6M15 5l3 1.3M9 12l4 -.5M20 15l2 -1M2 16l3 .3" stroke="#F3EFE2" stroke-opacity=".55" stroke-width=".6" stroke-linecap="round" fill="none"/></pattern>
    <linearGradient id="${scope}-shade" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#231F1B" stop-opacity="0"/><stop offset=".35" stop-color="#231F1B" stop-opacity=".26"/><stop offset="1" stop-color="#231F1B" stop-opacity="0"/></linearGradient>
    <filter id="${scope}-soft" x="-5%" y="-5%" width="110%" height="110%"><feDropShadow dx="0" dy="2.5" stdDeviation="1.6" flood-color="#231F1B" flood-opacity=".32"/></filter>
  </defs>`;
  const seg=(part,x,w,fill,over)=>w<=0?"":`<g data-part="${part}" data-x="${x}" data-w="${w}"><title>${PART_TIP[part]}</title><rect x="${x}" y="${y0-9}" width="${w}" height="18" fill="${fill}" stroke="currentColor" stroke-width=".8"/><rect x="${x}" y="${y0-9}" width="${w}" height="18" fill="${over}"/><rect x="${x}" y="${y0-9}" width="${w}" height="18" fill="url(#${scope}-fibre)"/><rect class="gl" x="${x}" y="${y0-8}" width="${w}" height="3" fill="#fff"/></g>`;
  const whip=(part,x)=>`<g data-part="${part}" data-x="${x}"><g transform="translate(${x} 0)"><rect x="-4" y="${y0-13}" width="8" height="26" fill="currentColor"/><path d="M-4 ${y0-9}l8 4M-4 ${y0-3}l8 4M-4 ${y0+3}l8 4M-4 ${y0+9}l8 3" stroke="#F3EFE2" stroke-opacity=".6" stroke-width="1"/></g><title>${PART_TIP[part]}</title></g>`;
  let main="";
  let xc=x0;
  if(o.ghost){main=`<rect x="${x0}" y="${y0-9}" width="${L}" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="6 6"/>`}
  main+=seg("captured",xc,wC,GOLD,ply);                 // captured: gold leaf
  if(wC>0){xc+=wC}
  main+=seg("owed",xc,wA,"#F3EFE2",hatch);              // accrued: bare cotton, not yet settled
  if(wC>0&&wA>0)main+=whip("captured-edge",x0+wC);
  xc+=wA;
  if(o.voided){
    const wT=(o.relA+o.relF)*k;
    main+=`<g data-part="released" class="released-trace"><rect x="${xc}" y="${y0+21}" width="${Math.max(wT-wA,0)}" height="18" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="5 4"/></g>`;
    main+=`<path data-part="cut" d="M${xc} ${y0-12}v24" stroke="currentColor" stroke-width="2"/>`;
  }else{
    main+=seg("free",xc,wF,"#1B6F7A",ply);               // free to spend: tide (still water). Red is kept for refusals.
    if(wA>0&&wF>0)main+=whip("free-edge",xc);
  }
  const endx=o.voided&&o.live?xc:x0+L;
  const frays=[-5,0,5].map(d=>`<path d="M${endx} ${y0+d} l12 ${d*1.6}" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`).join("");
  const loop=`<g class="loop"><title>The hold. The cord is tied to it, and its length is the budget.</title><line x1="22" y1="14" x2="22" y2="112" stroke="#54504A" stroke-width="6" stroke-linecap="round"/>
    <rect x="12" y="28" width="${x0-6}" height="68" rx="30" fill="none" stroke="currentColor" stroke-width="9"/>
    <rect class="rd" x="12" y="28" width="${x0-6}" height="68" rx="30" fill="none" stroke="#F3EFE2" stroke-width="5" stroke-dasharray="3 4"/></g>`;
  let pens="";
  const items=o.items.slice(0,N);
  // a pendant hangs where its call was paid on the cord, with a minimum gap so knots never touch
  const xs=[]; let cum=0, prev=-1e9; const gap=vertical?40:38;
  items.forEach(it=>{cum+=it.c; let x=x0+cum*k; if(x<prev+gap)x=prev+gap; x=Math.min(x,x0+L-12); xs.push(x); prev=x;});
  let ticks="", vticks="";
  for(let v=0;!retained&&v<=cap;v+=(cap>4000?2000:500)){const tx=x0+v*k;
    ticks+=`<line x1="${tx}" y1="${y0+10}" x2="${tx}" y2="${y0+19}" stroke="currentColor" stroke-opacity=".5" stroke-width="1.2"/>`;
    if(vertical&&v>0)vticks+=`<text x="${y0-15}" y="${tx+6}" text-anchor="end" font-family="Spline Sans Mono,monospace" font-size="${o.tickFs||18}" class="tk">$${v/100}</text>`;
    if(!vertical)ticks+=`<text x="${v===0?tx+16:tx}" y="${y0-22}" text-anchor="${v===0?"start":v===cap?"end":"middle"}" font-family="Spline Sans Mono,monospace" font-size="${o.tickFs||Math.max(14,Math.round(14*1176/Math.max(320,Math.min(innerWidth,1360)-2*Math.min(56,innerWidth*.04))))}" class="tk"><title>$${v/100} of the $${cap/100} hold</title>$${v/100}</text>`;}
  for(let i=0;i<items.length;i++){
    const x=xs[i], it=items[i];
    const len=Math.round((292+((i*53)%5)*12)*ps);
    const open=`<g class="pen" data-id="${it.id}" data-x="${x}" data-state="${it.st}" data-length="${len}">`;
    const previous=retained?.get(String(it.id))?.dataset;
    if(previous?.x===String(x)&&previous.state===it.st&&previous.length===String(len)){
      pens+=open+"</g>";
      continue;
    }
    const d=digits(it.c);
    let knots="";
    d.forEach((n,lv)=>{
      if(!n)return;
      let level="";
      for(let j=0;j<n;j++){
        const y=y0+Math.round(LEVELS[lv]*ps)+j*KS;
        level+=it.st==="captured"
          ?`<rect x="${x-6.5}" y="${y}" width="13" height="5" rx="2.5" fill="${GOLD}" stroke="currentColor" stroke-width=".9"/>`
          :`<rect x="${x-6.5}" y="${y}" width="13" height="5" rx="2.5" fill="#F3EFE2" stroke="currentColor" stroke-width="1.2"/>`;
      }
      knots+=`<g><title>${LEVEL_NAMES[lv]}: ${n} knot${n>1?"s":""}, ${it.st==="captured"?"captured":"owed"}</title>${level}</g>`;
    });
    const frayP=[-3,0,3].map(dd=>`<path d="M${x+dd} ${y0+len} l${dd*1.1} 9" stroke="currentColor" stroke-opacity=".7" stroke-width="1.2" stroke-linecap="round"/>`).join("");
    pens+=`${open}
      <rect class="shade" x="${x+3}" y="${y0+11}" width="8" height="${len-12}" fill="url(#${scope}-shade)"/>
      <rect class="body" x="${x-3.6}" y="${y0+9}" width="7.2" height="${len-9}" fill="#F3EFE2" stroke="currentColor" stroke-width=".7"/>
      <rect x="${x-3.6}" y="${y0+9}" width="7.2" height="${len-9}" fill="${ply}"/>
      <rect x="${x-3.6}" y="${y0+9}" width="7.2" height="${len-9}" fill="url(#${scope}-fibre)"/>
      <g class="knots">${knots}</g>${frayP}
      ${o.interactive?`<rect class="hit" data-id="${it.id}" x="${x-(vertical?22:30)}" y="${y0+9}" width="${vertical?44:60}" height="${len+10}"><title>${esc(`Call ${it.id}, ${it.tool||"paid call"}, ${fmt(it.c)}, ${it.st}. Hover or tap for the raw row.`)}</title></rect>`:""}
    </g>`;
  }
  const H=y0+(items.length||(o.live&&vertical)?Math.round((292+4*12)*ps)+40:(o.live?Math.round(120*ps):78));
  const end=`<g data-part="end" data-x="${endx}"><title>The cap. The gateway refuses a call that would pass this end.</title>${frays}</g>`;
  const inner=retained?`<g class="pendants">${pens}</g><g class="rail">${main}${end}</g>`:o.live
    ?`<g>${ticks}</g><g filter="${soft}">${loop}</g><g class="pendants">${pens}</g><g class="rail">${main}${end}</g><g class="cord-fx" aria-hidden="true"></g>`
    :`<g>${ticks}</g><g filter="${soft}">${loop}${pens}${main}${end}</g><g class="cord-fx" aria-hidden="true"></g>`;
  if(vertical){
    return `<svg viewBox="0 0 ${H} ${x0+L+40}" role="img" aria-label="${esc(o.label)}">${retained?"":defs}<g transform="matrix(0 1 1 0 0 0)">${inner}</g>${retained?"":vticks}</svg>`;
  }
  return `<svg viewBox="0 0 ${x0+L+40} ${H}" role="img" aria-label="${esc(o.label)}">${retained?"":defs}${inner}</svg>`;
}

function updateParts(parent,next,key,update){
  const old=new Map([...parent.children].map(node=>[node.dataset[key],node]));
  let cursor=parent.firstElementChild;
  for(const part of [...next.children]){
    const id=part.dataset[key], current=old.get(id);
    const node=current||part;
    if(node!==cursor)parent.insertBefore(node,cursor);
    update(node,current?part:null);
    cursor=node.nextElementSibling;
    old.delete(id);
  }
  old.forEach(node=>node.remove());
}
function overlay(layer,nodes,frames,duration){
  if(!nodes.length||reduceMotion.matches)return;
  const group=document.createElementNS(layer.namespaceURI,"g");
  group.append(...nodes.map(node=>node.cloneNode(true)));
  layer.append(group);
  const animation=motion(group,frames,duration,"forwards");
  animation?.finished.then(()=>group.remove(),()=>group.remove());
}
function previousKnots(pen){
  const previous=$(".knots",pen).cloneNode(true);
  for(const knot of previous.querySelectorAll("rect")){
    knot.setAttribute("fill","#F3EFE2");
    knot.setAttribute("stroke","#231F1B");
    knot.setAttribute("stroke-width","1.2");
  }
  overlay(pen,[previous],[{opacity:1},{opacity:0}],400);
}
const movingRail=new WeakMap();
function updateCord(el,options,cue={}){
  const svg=el.firstElementChild;
  if(!svg){el.innerHTML=cordSVG(options);return}
  const rail=$(".rail",svg), pins=$(".pendants",svg), layer=$(".cord-fx",svg);
  const pinNodes=[...pins.children];
  const template=document.createElement("template");
  template.innerHTML=cordSVG(options,new Map(pinNodes.map(node=>[node.dataset.id,node])));
  const next=template.content.firstElementChild;
  if(svg.getAttribute("viewBox")!==next.getAttribute("viewBox")){el.innerHTML=cordSVG(options);return}
  svg.setAttribute("aria-label",options.label);
  const play=cue.animate!==false&&!reduceMotion.matches;
  const railNodes=[...rail.children];
  const railTransforms=new Map();
  for(const node of railNodes){
    const running=movingRail.get(node);
    if(running?.playState==="running"){
      const transform=getComputedStyle(node).transform;
      if(transform!=="none")railTransforms.set(node,new DOMMatrixReadOnly(transform));
    }
  }
  if(play&&cue.cut){
    // void: the cord unties from its free end over 900 ms. Free length first, owed length behind it, pendants fall right to left.
    const grp=(nodes,frames,opt)=>{
      if(!nodes.length)return;
      const g=document.createElementNS(layer.namespaceURI,"g");
      g.append(...nodes.map(n=>n.cloneNode(true)));
      if(opt.origin)g.style.transformOrigin=opt.origin;
      layer.append(g);
      const a=g.animate(frames,{duration:opt.ms,delay:opt.delay||0,easing:opt.easing||"cubic-bezier(.4,0,.2,1)",fill:"both"});
      a.finished.then(()=>g.remove(),()=>g.remove());
    };
    const part=name=>railNodes.find(n=>n.dataset.part===name);
    const free=part("free"), owed=part("owed"), end=part("end");
    const fw=free?Number(free.dataset.w):0, fx=free?Number(free.dataset.x):0;
    if(free)grp([free],[{transform:"scaleX(1)",opacity:1},{transform:"scaleX(0)",opacity:.6}],{ms:900,origin:`${fx}px 62px`});
    if(end&&fw)grp([end],[{transform:"translateX(0)",opacity:1},{transform:`translateX(${-fw}px)`,opacity:.5}],{ms:900});
    if(owed)grp([owed],[{transform:"scaleX(1)",opacity:1},{transform:"scaleX(0)",opacity:.6}],{ms:520,delay:380,origin:`${Number(owed.dataset.x)}px 62px`});
    grp(railNodes.filter(n=>n.dataset.part&&n.dataset.part.endsWith("-edge")),[{opacity:1},{opacity:0}],{ms:240});
    const owedPins=pinNodes.filter(n=>n.dataset.state!=="captured").sort((a,b)=>Number(b.dataset.x)-Number(a.dataset.x));
    owedPins.forEach((n,i)=>grp([n],[
      {transform:"translateY(0) rotate(0deg)",opacity:1},
      {transform:`translateY(46px) rotate(${i%2?7:-7}deg)`,opacity:0}
    ],{ms:420,delay:80+i*(430/Math.max(1,owedPins.length)),origin:`${Number(n.dataset.x)}px 71px`,easing:easeOut}));
  }
  if(play&&cue.reset)overlay(layer,[...pinNodes,...railNodes],[{opacity:1},{opacity:0}],420);
  if(play&&cue.capture){
    const owed=$('[data-part="owed"]',rail);
    if(owed)overlay(layer,[owed],[{opacity:1},{opacity:0}],400);
  }
  if(play&&cue.dropId&&options.F===0){
    const free=$('[data-part="free"]',rail);
    if(free){
      const end=Number(free.dataset.x)+Number(free.dataset.w);
      overlay(layer,[free],[{transform:"none",opacity:1},{transform:`translateX(${end*.98}px) scaleX(.02)`,opacity:0}],220);
    }
  }
  updateParts(rail,$(".rail",next),"part",(node,part)=>{
    if(!part){
      if(play&&node.dataset.part==="cut")node.animate([{opacity:0},{opacity:1}],{duration:200,delay:700,easing:easeOut,fill:"backwards"});
      if(play&&node.dataset.part==="released")node.animate([{opacity:0},{opacity:.45}],{duration:260,delay:700,easing:easeOut,fill:"backwards"});
      if(play&&node.dataset.part==="owed"&&cue.dropId)arrive(node,170,.45);
      return;
    }
    if(node.dataset.x===part.dataset.x&&node.dataset.w===part.dataset.w)return;
    const oldX=Number(node.dataset.x), oldWidth=Number(node.dataset.w);
    const newX=Number(part.dataset.x), newWidth=Number(part.dataset.w);
    const matrix=railTransforms.get(node);
    movingRail.get(node)?.cancel();
    if(part.dataset.w!==undefined){
      for(const rect of node.children){
        if(rect.tagName!=="rect")continue;
        if(oldX!==newX)rect.setAttribute("x",part.dataset.x);
        if(oldWidth!==newWidth)rect.setAttribute("width",part.dataset.w);
      }
    }else if(node.dataset.part.endsWith("-edge")){
      node.firstElementChild.setAttribute("transform",`translate(${newX} 0)`);
    }else node.innerHTML=part.innerHTML;
    if(part.dataset.x!==undefined)node.dataset.x=part.dataset.x;
    if(part.dataset.w!==undefined)node.dataset.w=part.dataset.w;
    if(!play||!Number.isFinite(oldX)||cue.cut||cue.reset)return;
    const scale=newWidth?(oldWidth*(matrix?.a??1))/newWidth:1;
    const from=oldX*(matrix?.a??1)+(matrix?.e??0)-newX*scale;
    if(from||scale!==1)movingRail.set(node,motion(node,[{transform:`translateX(${from}px) scaleX(${scale})`},{transform:"none"}],220));
  });
  updateParts(pins,$(".pendants",next),"id",(node,part)=>{
    if(!part){
      if(play&&node.dataset.id===String(cue.dropId)){
        dropPendant(node);
      }
      return;
    }
    const stateChanged=node.dataset.state!==part.dataset.state;
    if(!part.firstElementChild)return;
    const knots=$(".knots",node);
    const previous=play&&stateChanged?knots.cloneNode(true):null;
    if(node.dataset.x!==part.dataset.x||node.dataset.length!==part.dataset.length)node.innerHTML=part.innerHTML;
    else if(stateChanged)knots.innerHTML=$(".knots",part).innerHTML;
    if(previous)overlay(node,[previous],[{opacity:1},{opacity:0}],400);
    node.dataset.x=part.dataset.x;
    node.dataset.state=part.dataset.state;
    node.dataset.length=part.dataset.length;
  });
  if(play&&cue.refused)refuseFx(el,cue.haptic!==false);
}

/* slim strip: main cord only, used under the nav on other views */
function slimSVG(o){
  const s=o||sums(), k=1072/((o&&o.cap)||CAP), y=22;
  const wC=s.C*k,wA=s.A*k,wF=s.F*k, x0=0;
  const r=(state,x,w,f,o)=>w>0?`<g data-state="${state}"><rect x="${x}" y="${y-8}" width="${w}" height="16" fill="${f}" stroke="currentColor" stroke-width=".8"/><rect x="${x}" y="${y-8}" width="${w}" height="16" fill="${o}"/></g>`:"";
  return `<svg viewBox="0 0 1072 44" aria-hidden="true"><defs>
    <pattern id="plyS" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><line x1="0" y1="0" x2="0" y2="7" stroke="#231F1B" stroke-opacity=".3" stroke-width="1.6"/></pattern>
    <pattern id="hatchS" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><line x1="0" y1="0" x2="0" y2="7" stroke="#231F1B" stroke-opacity=".38" stroke-width="1.2"/></pattern></defs>
    ${r("captured",x0,wC,GOLD,"url(#plyS)")}${r("owed",x0+wC,wA,"#F3EFE2","url(#hatchS)")}${r("free",x0+wC+wA,wF,"#1B6F7A","url(#plyS)")}</svg>`;
}

/* =============================================================
   Chrome
============================================================= */
const KEY="pashadhara-session";
/* Live mode: reads one lease from the API with its lease token. Entered with /lease#live=<lease id>.<token>.
   The fragment never reaches a server and is stripped from the address bar at once. */
const LIVE_KEY="pashadhara-live";
const liveTag=()=>S.user&&S.user.live?(S.showcase?.mode==="fixture"?tagHtml("fixture","saved demo fixture"):tagHtml("computed",S.showcase?.ended||S.liveEnded?"journal, hold ended":"live journal")):tagHtml("fixture");
function liveTake(){
  const m=/^#live=([0-9a-f-]{36})\.([\w.-]{20,600})$/i.exec(location.hash);
  if(!m)return;
  store.set(LIVE_KEY,JSON.stringify({id:m[1].toLowerCase(),token:m[2]}));
  history.replaceState(null,"",location.pathname==="/"?"/lease":location.pathname);
   stopRun(); S.user={name:"Live lease",live:true}; S.privateBalances=null; S.liveEnded=false; S.liveReady=false; S.liveSig=""; S.liveErr="";
  S.status="active"; S.calls=[]; S.log=[]; S.refused=0; S.settles=[]; S.voided=null; S.ui.sel=null;
}
/* Never a blank page. If the gateway cannot be reached, the dated recording is shown and says so.
   If the hold's honor period has ended, the live journal is still shown, marked ended, and spending is off. */
async function fetchShowcase(){
  let data;
  try{
    const abort=new AbortController(), cut=setTimeout(()=>abort.abort(),8000);
    try{
      const response=await fetch("/api/showcase",{cache:"no-store",signal:abort.signal});
      if(!response.ok){try{await response.body?.cancel()}catch(e){}throw new Error("HTTP "+response.status)}
      data=await response.json();
    }finally{clearTimeout(cut)}
  }catch(e){
    return {...recordedShowcase,unreachable:true};
  }
   if(data.mode==="recorded")return {...recordedShowcase,unreachable:false};
  const b=data.lease?.balances;
  if(data.mode!=="live"||!b||!Array.isArray(data.journal?.entries)||!Array.isArray(data.lease.authorizations)||!Array.isArray(data.calls)
    ||![data.lease.cap_minor,b.hold_available,b.committed_unsettled,b.total_captured].every(v=>Number.isSafeInteger(v)&&v>=0))return {...recordedShowcase,unreachable:true};
  const honor=data.lease?.authorizations?.[0]?.honor_until;
  return {...data,read_at:Date.now(),ended:data.lease.state!=="active"||data.lease.guaranteed_now===false||!honor||!Number.isFinite(Date.parse(honor))||Date.parse(honor)<=Date.now()};
}
async function loadShowcase(){const d=await fetchShowcase();DK.data=d;return d}
function enterShowcase(){
  if(S.user?.showcase)return;
  stopRun();
  S.user={name:"Demo lease",live:true,showcase:true};
   S.privateBalances=null; S.liveEnded=false; S.liveReady=false; S.liveSig=""; S.liveErr=""; S.showcase=null;
  S.status="active"; S.calls=[]; S.log=[]; S.refused=0; S.settles=[]; S.voided=null; S.ui.sel=null;
}
async function liveLoad(){
  let L=null; try{L=JSON.parse(store.get(LIVE_KEY)||"null")}catch(e){}
  if(!L&&!S.user?.showcase)return false;
  try{
    let lease,entries;
    const showcase=S.user?.showcase;
    if(showcase){
      const data=await loadShowcase();
      if(!S.user?.showcase)return false;
      S.showcase=data;
      lease=data.lease; entries=data.journal.entries;
    }else{
      const init={headers:{Authorization:"Bearer "+L.token,Accept:"application/json"},cache:"no-store"};
      const [a,b]=await Promise.all([fetch(`/api/v1/leases/${L.id}`,init),fetch(`/api/v1/leases/${L.id}/journal`,init)]);
      if(!a.ok||!b.ok)throw new Error("HTTP "+(a.ok?b.status:a.status));
      lease=await a.json(); ({entries}=await b.json());
    }
    const money=v=>Number.isSafeInteger(v)&&v>=0;
     const b=lease?.balances;
     if(!lease||!money(lease.cap_minor)||!b||![b.hold_available,b.committed_unsettled,b.total_captured].every(money)||!Array.isArray(entries)||(lease.authorizations&&!Array.isArray(lease.authorizations))||entries.some(e=>!e||!money(e.amount_minor)))throw new Error("unexpected response");
    const when=iso=>new Date(iso).toISOString().slice(11,16)+" UTC";
    const calls=[]; const log=[];
    const auth=lease.authorizations&&lease.authorizations[0];
    if(auth)log.push({t:when(entries.length?entries[0].created_at:auth.honor_until),m:`Authorization${auth.paypal_authorization_id?" "+auth.paypal_authorization_id:""} holds ${fmt(auth.amount_minor)} (read from the lease record).`});
    for(const e of showcase?[]:entries){
      if(e.ref_type!=="commit"||e.account!=="COMMITTED_UNSETTLED"||e.direction!=="D")continue;
      const id=calls.length+1;
       calls.push({id,tool:"call",c:e.amount_minor,st:"committed",t:when(e.created_at),raw:e});
      log.push({t:when(e.created_at),m:`Committed ${fmt(e.amount_minor)} for call ${id}.`});
    }
    if(showcase){
      for(const row of S.showcase.calls){
        const t=when(row.created_at), amount=Number(row.price_minor);
        if(row.status==="served")calls.push({id:calls.length+1,tool:row.tool_id,c:amount,st:row.captured?"captured":"accrued",t,raw:row});
        log.push({t,m:row.status==="served"?`Committed ${fmt(amount)} for ${row.tool_id}.`:`Refused ${fmt(amount)}: ${({refused_cap:"above what was free",refused_window:"the hold had ended",refused_exposure:"above the unsettled limit",refused_inactive:"the lease was not active"})[row.status]||"refused by the kernel"}.`});
      }
    }
    if(lease.state!=="active")log.push({t:"",m:`Lease state is ${lease.state}.`});
     const sig=JSON.stringify([lease.cap_minor,b,calls,lease.state,auth&&auth.honor_until,showcase&&S.showcase]);
    S.liveErr="";
    if(sig===S.liveSig)return true;
     S.liveSig=sig; CAP=lease.cap_minor; S.calls=calls; S.log=log; S.nextId=calls.length+1;
     S.privateBalances=showcase?null:b;
     S.liveState=lease.state;
     S.liveEnded=!showcase&&(lease.state!=="active"||lease.guaranteed_now===false||!auth?.honor_until||Date.parse(auth.honor_until)<=Date.now());
    S.liveHonor=auth?String(auth.honor_until).replace("T"," ").slice(0,16):"";
    S.liveChanged=true;
    return true;
  }catch(e){S.liveErr="The live lease could not be read ("+(e&&e.message||"error")+"). Showing the last good read.";return false}
}
function liveStart(){
  if(S.livePoll)return;
  S.livePoll=setInterval(async()=>{
    const ok=await liveLoad();
    if(current!=="lease"||!S.user||!S.user.live)return;
    if(S.liveChanged){S.liveChanged=false;paintLease({})}
    else if(!ok)paintReadout();
  },5000);
}
/* localStorage so a refresh, a new tab and a deep link keep the sample session. */
const store={get:k=>{try{return localStorage.getItem(k)}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}},del:k=>{try{localStorage.removeItem(k)}catch(e){}}};
function save(){try{if(!S.user){store.del(KEY);return}store.set(KEY,JSON.stringify({CAP,user:S.user,status:S.status,calls:S.calls,q:S.q,nextId:S.nextId,clock:S.clock,log:S.log,refused:S.refused,settles:S.settles,voided:S.voided,rules:S.rules}))}catch(e){}}
function restore(){try{const j=JSON.parse(store.get(KEY)||"null");if(!j||!j.user)return;CAP=j.CAP;S.user=j.user;S.status=j.status;S.calls=j.calls;S.q=j.q;S.nextId=j.nextId;S.clock=j.clock;S.log=j.log;S.refused=j.refused;S.settles=j.settles;S.voided=j.voided;S.rules=j.rules;if(S.user&&S.user.live&&!S.user.showcase&&!store.get(LIVE_KEY))S.user=null;}catch(e){}}
function route(){const h=location.pathname.replace(/^\/+|\/+$/g,"");return h||"home"}
function go(path,replace){const p=path.split("?")[0];if(location.pathname===p&&!replace)return;history[replace?"replaceState":"pushState"](null,"",path);mount()}
function linkClick(e){const a=e.target.closest&&e.target.closest("a[href]");if(!a||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||a.target||a.hasAttribute("download")||a.dataset.act||a.dataset.scroll)return false;const h=a.getAttribute("href")||"";if(h[0]!=="/"||h[1]==="/")return false;e.preventDefault();go(h);return true}
/* Lease is home. Escrow and Settle are sections of the one lease object, shown as tabs under the header. */
function renderNav(r){
  const lease=r==="lease"||r==="escrow"||r==="settle";
  $("#nav").innerHTML=`<li><a href="/lease"${lease?' aria-current="page"':""}>Lease</a></li><li><a href="/proof"${r==="proof"?' aria-current="page"':""}>Proof</a></li>`;
  const nl=$("#newlease"); if(nl){if(r==="approve")nl.setAttribute("aria-current","page");else nl.removeAttribute("aria-current")}
}
const simBand=text=>`<div class="wrap"><div class="modeband" role="note"><span class="dk-line"><span class="dk-dot sim" aria-hidden="true"></span><strong class="dk-mode">INTERACTIVE SIMULATION</strong></span><span class="dk-sub">${text}</span></div></div>`;
function leaseSource(){
  if(S.user?.showcase&&S.showcase?.mode==="fixture")return `<div class="wrap"><div class="modeband" role="note"><span class="dk-line"><span class="dk-dot sim" aria-hidden="true"></span><strong class="dk-mode">SAVED DEMO FIXTURE</strong></span><span class="dk-sub">Snapshot assembled for fallback from ${esc(S.showcase.fixture_on)}. Its raw run is unavailable, so it is not PayPal evidence.${S.showcase.unreachable?" The live gateway did not answer.":""}</span></div></div>`;
  if(!S.user?.live)return "";
  const ended=S.showcase?.ended||S.liveEnded;
  return `<div class="wrap"><div class="modeband" role="note"><span class="dk-line"><span class="dk-dot live" aria-hidden="true"></span><strong class="dk-mode">LIVE PAYPAL SANDBOX${ended?" · SPENDING CLOSED":""}</strong></span><span class="dk-sub">${ended?"The last lease read is historical. New paid calls are refused.":"Balances are computed from the sandbox lease journal. This is not a fresh PayPal GET."}</span></div></div>`;
}
function leaseTabs(v){
  const item=(k,l,href)=>`<li><a href="${href}"${v===k?' aria-current="page"':""}>${l}</a></li>`;
  return `<div id="leaseSource">${leaseSource()}</div>${S.user?.live?"":simBand("sample lease, fixture amounts, nothing reaches PayPal")}<div class="wrap"><nav class="leasetabs" aria-label="This lease"><span class="lt-label"><span class="lt-d">This lease</span><span class="lt-m">${esc(S.user?.showcase?"Demo lease":S.user?.live?"Live lease":S.user?.sample?"Sample lease (fixture)":S.user?.name?"Your lease":"Lease")}</span></span><ul>${item("lease","Cord","/lease")}${S.user?.live?"":item("settle","Settle","/settle")}${item("escrow","Escrow","/escrow")}</ul></nav></div>`;
}
function slimBlock(){
  const s=sums();
  const words=S.status==="voided"?"Lease voided. Nothing is held.":`${fmt(s.F)} ${S.showcase?.mode==="fixture"?"uncommitted in fixture":S.showcase?.ended||S.liveEnded?"uncommitted at last read":"available"}, ${fmt(s.A)} committed, ${fmt(s.C)} captured, of ${fmt(CAP)}.`;
  return `<div class="slimcord"><div aria-hidden="true">${slimSVG()}</div>${trow(`<span class="help num">${words}</span>`,liveTag())}</div>`;
}

/* =============================================================
   Views
============================================================= */
const V={};

/* ---------- lease ---------- */
const visibleLeaseRegions=new WeakSet();
let leaseObserver;
function watchLeaseRegions(){
  leaseObserver=new IntersectionObserver(entries=>{
    for(const {target,isIntersecting} of entries){
      if(isIntersecting)visibleLeaseRegions.add(target);
      else visibleLeaseRegions.delete(target);
    }
  });
  for(const id of ["lead","ledger","controls"])leaseObserver.observe(document.getElementById(id));
}
V.lease=()=>{
  return `<div class="wrap"><div class="stage" id="leaseStage">
    <div class="lead" id="lead"></div>
    <aside class="honor" id="honor"></aside>
   <div class="cordwrap"><div id="cord"></div><div class="scrub" id="scrub" role="slider" aria-orientation="vertical" aria-label="Move along the cord" tabindex="0" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="No call selected"><span class="thumb" aria-hidden="true"><i></i><i></i><i></i></span></div><div class="readout" id="readout" aria-live="off"></div><div class="cordtools"><span id="cordKey">${KEY_HTML}</span><button class="link-btn" data-act="sound" aria-pressed="false">Sound off</button></div></div>
    <section class="controls" id="controls" aria-label="Lease actions"></section>
  </div></div>
  <div class="band"><div class="wrap"><div class="stage">
    <section class="ledger" aria-labelledby="ledh"><h2 class="sec" id="ledh">The ledger, read as a table</h2><div id="ledger"></div></section>
  </div></div></div>`;
};
function paintLead(){
  const s=sums();
  const el=$("#lead"); if(!el)return;
  if(S.status==="voided"){
     paintText(el,`<h1>The sample hold is released.</h1><p class="sub"><span>${fmt(S.voided.C)} was marked captured before the void. ${S.voided.A?`${fmt(S.voided.A)} owed for earlier calls was left unsettled in this sample. `:""}</span>The remaining sample hold was released in this browser. No PayPal call was made. ${tagHtml("fixture")}</p>`,"h1,.sub > span:not(.tag)");
    return;
  }
  const amount=fmt(s.F), balance=`Your agent has captured <span class="balance-amount">${fmt(s.C)}</span>${s.A?` and owes <span class="balance-amount balance-owed">${fmt(s.A)}</span> more that is still held, not yet captured`:""}.`;
  if(S.user?.showcase&&S.showcase?.mode==="fixture"){
    el.innerHTML=`<h1>Saved demo fixture.</h1><p class="sub"><span class="msg">This sample snapshot shows ${fmt(s.F)} uncommitted, ${fmt(s.A)} committed and ${fmt(s.C)} captured. Its raw run is unavailable, and these are not a current PayPal balance. <a href="/proof">See recorded PayPal evidence.</a></span> ${liveTag()}</p>`;
    return;
  }
  if(S.user?.live&&(S.showcase?.ended||S.liveEnded)){
    el.innerHTML=`<h1>The ${S.user.showcase?"demo":"live"} hold cannot spend.</h1><p class="sub"><span class="msg">The last lease read shows ${fmt(s.F)} uncommitted. The lease is ${esc(S.liveState||"unknown")} or its honor window has ended. The gateway refuses new paid calls.</span> ${liveTag()}</p>`;
    return;
  }
  const headline=$(".motion-value",el);
  if(headline){
    const visible=visibleLeaseRegions.has(el);
    changeText(headline,amount,visible);
    const summary=$(".balance-copy",el), owed=$(".balance-owed",summary);
    if(Boolean(owed)!==Boolean(s.A)){
      summary.innerHTML=balance;
      if(visible)arrive(summary);
    }else{
      changeText($(".balance-amount",summary),fmt(s.C),visible);
      if(owed)changeText(owed,fmt(s.A),visible);
    }
    return;
  }
   el.innerHTML=`<h1><span class="num motion-value">${amount}</span> is free to spend.</h1>
    <p class="sub"><span class="msg">${S.user?.live?"You approved":"In this sample you approved"} ${fmt(CAP)} once. <span class="balance-copy">${balance}</span> The gateway refuses any call that would pass the cap.</span> ${liveTag()}</p>`;
}
function paintHonor(){
  const el=$("#honor"); if(!el)return;
  // fixture clock: hour 9 of a 72 hour honor period, day 4 opens the reauthorize window (assumed)
  const pct=h=>(h/96*100).toFixed(1)+"%";
  if(S.user&&S.user.live){
    const ended=S.showcase?.ended||S.liveEnded, fixture=S.showcase?.mode==="fixture";
    el.innerHTML=`<h2>${fixture?"Fixture snapshot":ended?"Spending window closed":"72 hour honor period, then best effort"}</h2>${trow(`<span class="help">${fixture?"No current hold or traceable raw run is attached to this view.":`${ended?"Honor boundary":"Honored until"} ${esc(S.liveHonor||"unknown")} UTC. Ledger read ${esc(whenUTC(S.showcase?.read_at||Date.now()))}.`}</span>`,"")}`;return}
  el.innerHTML=`<h2>72 hour honor period, then best effort</h2>
   <div class="rulebar" aria-hidden="true"><i style="left:0;width:${pct(72)}"></i><b style="left:0"></b><b style="left:${pct(72)}"></b><em style="left:${pct(72)};width:${(100-72/96*100).toFixed(1)}%"></em><b style="left:${pct(9)};top:2px;height:25px;width:3px"></b></div>
   <p class="help">Hour 9 of 72. Day 4 would open a reauthorize window. Whether it works is unproven. ${tagHtml("fixture","fixture clock")} ${tagHtml("computed","proposal, not verified")}</p>`;
}
// after a void the uncaptured pendants have no cord to hang from, so only captured ones stay drawn
function itemsForLease(){return S.calls.filter(k=>S.status==="voided"?k.st==="captured":true).slice(0,NSLOT)}
function isVertical(){return matchMedia("(max-width:720px)").matches}
function scrubPoints(){
  const svg=$("#cord svg"); if(!svg)return [];
  const r=svg.getBoundingClientRect();
  return [...svg.querySelectorAll(".pendants .hit")].map(h=>{const b=h.getBoundingClientRect();return {id:+h.dataset.id,y:b.top+b.height/2-r.top}}).sort((a,b)=>a.y-b.y);
}
function paintScrub(){
  const sc=$("#scrub"), svg=$("#cord svg"); if(!sc||!svg||!isVertical())return;
  const r=svg.getBoundingClientRect(), w=sc.parentElement.getBoundingClientRect();
  sc.style.top=(r.top-w.top)+"px"; sc.style.height=r.height+"px";
  const pts=scrubPoints(), i=pts.findIndex(p=>p.id===S.ui.sel), k=S.calls.find(c=>c.id===S.ui.sel);
  sc.style.setProperty("--ty",Math.max(0,Math.min(r.height-44,(i>=0?pts[i].y:22)-22))+"px");
  sc.setAttribute("aria-valuemax",String(pts.length)); sc.setAttribute("aria-valuenow",String(i+1));
  sc.setAttribute("aria-valuetext",k?`Call ${k.id}, ${k.tool}, ${fmt(k.c)}, ${k.st}`:"No call selected");
}
function scrubTo(id){
  if(id===S.ui.sel)return;
  S.ui.sel=id; S.ui.hint=true; paintSelection();
  if(navigator.vibrate&&navigator.userActivation?.hasBeenActive){try{navigator.vibrate(6)}catch(e){}}
}
let scrubbing=false;
on(document,"pointerdown",e=>{
  const sc=e.target.closest?.("#scrub"); if(!sc)return;
  e.preventDefault(); scrubbing=true; sc.focus({preventScroll:true}); sc.setPointerCapture?.(e.pointerId);
  const y=e.clientY-sc.getBoundingClientRect().top, pts=scrubPoints();
  if(pts.length)scrubTo(pts.reduce((a,b)=>Math.abs(b.y-y)<Math.abs(a.y-y)?b:a).id);
});
on(document,"pointermove",e=>{
  if(!scrubbing)return;
  const sc=$("#scrub"); if(!sc)return;
  const y=e.clientY-sc.getBoundingClientRect().top, pts=scrubPoints();
  if(pts.length)scrubTo(pts.reduce((a,b)=>Math.abs(b.y-y)<Math.abs(a.y-y)?b:a).id);
});
on(document,"pointerup",()=>{scrubbing=false});
on(document,"pointercancel",()=>{scrubbing=false});
on(document,"keydown",e=>{
  if(!e.target.closest?.("#scrub"))return;
  const pts=scrubPoints(); if(!pts.length)return;
  const i=pts.findIndex(p=>p.id===S.ui.sel);
  const go=n=>{e.preventDefault();scrubTo(pts[Math.max(0,Math.min(pts.length-1,n))].id)};
  if(e.key==="ArrowDown"||e.key==="ArrowRight")go(i<0?0:i+1);
  else if(e.key==="ArrowUp"||e.key==="ArrowLeft")go(i<0?0:i-1);
  else if(e.key==="Home")go(0); else if(e.key==="End")go(pts.length-1);
  else if(e.key==="Escape"){S.ui.sel=null;paintSelection()}
});
function paintSelection(){
  const svg=$("#cord svg");
  if(!svg)return;
  svg.classList.toggle("dim",S.ui.sel!==null);
  svg.querySelectorAll(".pen").forEach(node=>node.classList.toggle("sel",+node.dataset.id===S.ui.sel));
  $("#ledger")?.querySelectorAll("tr[data-id]").forEach(row=>{
    const selected=+row.dataset.id===S.ui.sel;
    row.classList.toggle("sel",selected);
    const button=$(".rowbtn",row);
    if(button.getAttribute("aria-pressed")!==String(selected))button.setAttribute("aria-pressed",String(selected));
  });
  paintReadout();
  paintScrub();
}
function paintCord(opts={}){
  const el=$("#cord"); if(!el)return;
  const key=$("#cordKey"); if(key){key.innerHTML=KEY_HTML; const label=key.querySelector(".key span:last-child"); if(label)label.lastChild.textContent=closedLabel()}
  const s=sums();
  const items=itemsForLease();
  const rel=S.voided||{A:0,F:0};
  updateCord(el,{items,cap:CAP,C:s.C,A:s.A,F:s.F,vertical:isVertical(),compactV:isVertical()&&!items.length,ps:isVertical()?1:.8,voided:S.status==="voided",
    relA:rel.A,relF:rel.F,interactive:true,live:"lease",
    label:S.status==="voided"?"The lease cord, cut. The released length is gone.":`The lease as a knotted cord. ${items.length} calls tied. ${fmt(s.F)} uncommitted, ${fmt(s.A)} committed, ${fmt(s.C)} captured.`},opts);
  paintSelection();
}
function paintReadout(){
  const el=$("#readout"); if(!el)return;
  const k=S.calls.find(c=>c.id===S.ui.sel);
  const html=k
    ?trow(`<strong>Call ${k.id}, ${esc(k.tool)}</strong> <span class="num">${fmt(k.c)}</span> <span>${k.st}</span> <span class="num">${k.t}</span>`,liveTag())+`<code class="raw" aria-label="Raw row">${esc(JSON.stringify(k.raw||{id:k.id,tool:k.tool,amount_minor:k.c,state:k.st,at:k.t}))}</code>`
    :S.liveErr?`<span class="help">${esc(S.liveErr)}</span>`
    :`<div class="hintrow"><button class="link-btn" data-act="read-cord" aria-expanded="${Boolean(S.ui.hint)}" aria-controls="cordhint">How to read this cord</button><span class="help" id="cordhint"${S.ui.hint?"":" hidden"}>Each pendant is a paid call. Knots by decimal place: tens, dollars, dimes, cents. Gold is captured, outlined is committed, teal is uncommitted. ${isVertical()?"Drag the handle on the right, or tap a pendant, for its raw row.":"Hover or tap a pendant for its raw row."}</span></div>`;
  paintText(el,html,".msg,.raw,#cordhint");
}
function paintLedger(){
  const el=$("#ledger"); if(!el)return;
  const s=sums();
   const freeLabel=S.showcase?.mode==="fixture"?"Uncommitted in fixture":S.showcase?.ended||S.liveEnded?"Uncommitted at last read":"Free to spend";
  const visible=visibleLeaseRegions.has(el);
  if(!S.calls.length){
    el.innerHTML=`<div class="empty"><p><strong>No calls yet.</strong> Each paid call your agent makes ties one pendant onto the cord and takes its price out of the free length.</p><p class="help" style="margin-top:12px">${S.user&&S.user.live?"Calls appear here when your agent pays through the gateway.":"Press Let the agent spend to watch the first one."}</p></div>`;
    return;
  }
  const rowHtml=k=>`<tr class="${S.ui.sel===k.id?"sel":""}" data-id="${k.id}">
    <td><button class="rowbtn" data-sel="${k.id}" aria-pressed="${S.ui.sel===k.id}"><span class="num">${String(k.id).padStart(2,"0")}</span><span>${esc(k.tool)}</span></button></td>
    <td class="num r">${fmt(k.c)}</td><td>${k.st}</td><td class="num r">${k.t}</td></tr>`;
  const logItem=l=>`<li><time>${l.t}</time><span>${esc(l.m)}</span></li>`;
  const body=$("tbody",el);
  if(body){
    for(const [i,call] of S.calls.entries()){
      if(body.rows[i])changeText(body.rows[i].cells[2],call.st,visible);
      else{
        body.insertAdjacentHTML("beforeend",rowHtml(call));
        if(visible)arrive(body.lastElementChild);
      }
    }
    const amounts=[s.C,s.A,s.F];
    el.querySelectorAll("tfoot .num").forEach((cell,i)=>changeText(cell,fmt(amounts[i]),visible));
    changeText(el.querySelector("tfoot tr:last-child td:first-child"),freeLabel,false);
    const log=$(".log",el), seen=Number(log.dataset.seen);
    if(seen!==S.log.length){
      const latest=S.log.slice(Math.max(seen,S.log.length-4)).reverse();
      log.insertAdjacentHTML("afterbegin",latest.map(logItem).join(""));
      while(log.children.length>4)log.lastElementChild.remove();
      log.dataset.seen=S.log.length;
      const wait=(S.hold||0)-performance.now();
      if(wait>0){
        const fresh=[...log.children].slice(0,latest.length);
        fresh.forEach(n=>{n.style.opacity="0"});
        later(()=>fresh.forEach(n=>{n.style.opacity="";arrive(n)}),wait);
      }else if(visible)arrive(log.firstElementChild);
    }
    return;
  }
  el.innerHTML=`<div class="wide" tabindex="0" role="region" aria-label="Tool calls table, scrolls sideways"><table class="rt ledgerrt"><caption class="sr">Tool calls on this lease${S.user&&S.user.live?"":", fixture data"}</caption>
   <thead><tr><th scope="col">Call</th><th scope="col" class="r">Price</th><th scope="col">State</th><th scope="col" class="r">Time</th></tr></thead>
   <tbody>${S.calls.map(rowHtml).join("")}</tbody>
   <tfoot><tr><td>Captured</td><td class="num r">${fmt(s.C)}</td><td colspan="2"></td></tr>
   <tr><td>Owed, not captured</td><td class="num r">${fmt(s.A)}</td><td colspan="2"></td></tr>
   <tr><td>${freeLabel}</td><td class="num r">${fmt(s.F)}</td><td colspan="2"></td></tr></tfoot></table></div>
   <ul class="log" aria-label="Gateway log" data-seen="${S.log.length}">${S.log.slice(-4).reverse().map(logItem).join("")}</ul>
    ${trow(S.user&&S.user.live?`<span class="help">${S.showcase?.mode==="fixture"?"Saved fixture, not a current balance.":"Balances are from the lease record, not a fresh PayPal GET."} ${S.user.showcase?"Tool names are from tool-call records.":"Call rows and balances are separate reads; capture cannot be assigned to a call from these rows."} Separate PayPal captures are on Proof.</span>`:`<span class="help">Prices and tool names are sample data. Real captures are on Proof.</span>`,S.user&&S.user.live?liveTag():tagHtml("fixture","fixture ledger"))}`;
}
function gaugeHtml(){
  return `<div class="gauge" data-gauge><div class="trow"><span class="msg"><span class="gnum num"></span> <span>free to spend</span></span><span class="tags">${liveTag()}</span></div><div class="gbar" aria-hidden="true"></div><p class="help gcap"></p></div>`;
}
function fillGauge(root){
  const g=root&&$("[data-gauge]",root); if(!g)return;
  const s=sums(), capped=s.F<=0;
  changeText($(".gnum",g),fmt(s.F),false);
  $(".gbar",g).innerHTML=slimSVG({C:s.C,A:s.A,F:s.F,cap:CAP});
  g.dataset.state=capped?"cap":"open";
  changeText($(".gcap",g),capped?"Cap reached. Nothing is free to spend, so the gateway refuses the next call.":`${fmt(s.held)} still held of ${fmt(CAP)}. ${fmt(s.A)} owed, ${fmt(s.C)} captured.`,false);
}
function paintControls(){
  const el=$("#controls"); if(!el)return;
  if(S.user?.showcase){
    const data=S.showcase, live=deskState().mode==="live", shape=live?"live":data?.mode==="fixture"?"fixture":"end";
    if(el.dataset.shape!==shape||!el.querySelector("[data-desk]")){
      el.dataset.shape=shape;
      const note=shape==="fixture"?`<p class="note-p">${data.unreachable?"The gateway did not answer, so this page shows a saved demo fixture from ":"No live demo lease is configured, so this page shows a saved demo fixture from "}<span class="num">${esc(data.fixture_on)}</span>. Its raw run is unavailable. The desk below is a separate simulation. <a href="/proof">Inspect recorded PayPal evidence.</a></p>`
        :shape==="end"?`<p class="note-p">The demo lease is ${esc(data.lease.state)} or its honor window ended. The gateway refuses new paid calls. The balance above is a last journal read, not spendable funds. The desk below is a separate simulation.</p>`:"";
      el.innerHTML=`${note}<section class="moment dk-moment" aria-labelledby="momh"><div class="dk-cols${live?"":" solo"}"><div class="dk-left"><h2 class="sec" id="momh">Check an amount</h2>${deskHtml("lease")}</div>
         ${live?`<aside class="dk-real" aria-labelledby="realh"><h2 class="sec" id="realh">Run one sandbox tool call</h2><p>Claude Haiku 5.5 summarises a fixed paragraph. The kernel reserves 3 cents inside a locked transaction; the commitment becomes durable only if the tool succeeds. PayPal capture is a later settlement step.</p><button class="btn fill cta" data-act="showcase-run">Run the agent · up to $0.03</button><p class="help" id="showcase-budget"></p></aside>`:""}</div></section>`;
    }
    paintDesk();
    if(live){$("#showcase-budget").textContent=`Demo calls left, per visitor today: ${data?.remaining_calls??0}.`;syncRunButton()}
    return;
  }
  if(S.user&&S.user.live){el.dataset.phase="live";el.innerHTML=`<p><strong>Live lease.</strong> Your agent spends through the gateway. This page only reads the journal. It cannot spend, settle or void.</p>`;return}
  const s=sums();
  const visible=visibleLeaseRegions.has(el);
  if(S.status==="voided"){
    paintText(el,`<p><strong>This lease is voided.</strong> Spending is closed.</p><a class="btn fill" href="/approve">Start a new lease</a>`,"p,a",visible);
    return;
  }
  const next=QUEUE[S.q%QUEUE.length];
  const runLabel=S.running?"Pause the agent":"Let the agent spend";
  const warning=next[1]>s.F?`That is above the ${fmt(s.F)} left, so the gateway will refuse it.`:"";
  const settleAmount=fmt(s.A);
  if(!S.ui.voidOpen&&el.dataset.phase==="active"&&Boolean($("#settleCall",el))===(s.A>0)){
    const run=$("#run",el);
    if(run.getAttribute("aria-pressed")!==String(S.running))run.setAttribute("aria-pressed",String(S.running));
    changeText(run,runLabel,visible);
    changeText($(".next-tool",el),next[0],visible);
    changeText($(".next-price",el),fmt(next[1]),visible);
    changeText($(".next-warning",el),warning,visible);
    fillGauge(el);
    if(s.A){
      changeText($(".owed-call",el),`${settleAmount} is owed and not captured.`,visible);
      changeText($("#settleCall",el),`Settle ${settleAmount}`,visible);
    }
    return;
  }
  let html=`<div>${gaugeHtml()}<div class="btnrow">
    <button class="btn fill" id="run" aria-pressed="${S.running}">${runLabel}</button>
    <button class="btn" id="one">One call</button></div>
    <p class="help" style="margin-top:12px">Next call: <span class="mono next-tool">${next[0]}</span> at <span class="num next-price">${fmt(next[1])}</span>. <span class="err next-warning">${warning}</span></p></div>`;
  if(s.A>0)html+=`<div><p><strong class="owed-call">${settleAmount} is owed and not captured.</strong> Capturing in fewer, larger steps costs less.</p><a class="btn" id="settleCall" href="/settle" style="margin-top:12px">Settle ${settleAmount}</a></div>`;
  if(!S.ui.voidOpen){
    html+=`<div><button class="btn" id="voidOpen">Void lease</button><p class="help" style="margin-top:8px">On a real lease this releases the hold at PayPal. Here it is simulated. You confirm with the amount first.</p></div>`;
  }else{
    const held=s.held;
    html+=`<div class="confirm" role="group" aria-labelledby="vh"><p id="vh"><strong>Void releases the whole ${fmt(held)} hold.</strong></p>
      <p style="margin-top:8px">${s.A?`${fmt(s.A)} of it is owed for calls already made. Settle before voiding if you want those calls captured in this sample. `:""}This cannot be undone.</p>
      ${s.A?`<p style="margin-top:8px"><a href="/settle">Settle ${fmt(s.A)} first</a></p>`:""}
      <div class="field"><label for="vin">Type <span class="num">${(held/100).toFixed(2)}</span> to confirm</label><input id="vin" type="text" inputmode="decimal" autocomplete="off" aria-describedby="vhelp"></div>
      <p class="help" id="vhelp" style="margin-top:8px">The button stays off until the amount matches.${reduced()?"":" Then hold it for 1.2 seconds."}</p>
      <div class="btnrow" style="margin-top:16px"><button class="btn fill hold" id="voidGo" aria-disabled="true" aria-describedby="vhelp"><svg class="ring" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle class="rb" cx="12" cy="12" r="10"/><circle class="rf" cx="12" cy="12" r="10" pathLength="100"/></svg>Void ${fmt(held)}</button><button class="btn" id="voidCancel">Keep the lease</button></div></div>`;
  }
  const keep=document.activeElement&&el.contains(document.activeElement)?document.activeElement.id:"";
  paintText(el,html,".btn, .help, #vh, .confirm .field label, .controls strong",visible);
  el.dataset.phase=S.ui.voidOpen?"confirm":"active";
  fillGauge(el);
  if(keep)document.getElementById(keep)?.focus({preventScroll:true});
}
function paintLease(opts){
  setGround();
  const source=$("#leaseSource"); if(source)source.innerHTML=leaseSource();
  document.body.dataset.ended=S.user?.live&&(S.showcase?.ended||S.liveEnded)?"1":"";
  if(opts?.refused&&!reduced())S.hold=performance.now()+REFUSE_MS;
  const firstCall=opts?.dropId&&$("#ledger .empty");
  paintLead();
  paintHonor();
  paintCord(opts); paintLedger(); paintControls();
  if(firstCall&&visibleLeaseRegions.has($("#ledger"))){
    arrive($("#ledger tbody tr"));
    arrive($("#ledger .log li"));
  }
}

/* agent */
function spend(){
  if(S.status!=="active")return false;
  const s=sums();
  const [tool,c]=QUEUE[S.q%QUEUE.length]; S.q++;
  S.clock+=1+((S.nextId*7)%3);
  const t=clockStr(S.clock);
  const TOOLCAT={"web.search":"Data and search","filings.fetch":"Data and search","flights.search":"Data and search","pdf.extract":"Documents","summarize.long":"Documents","maps.route":"Maps","geocode.batch":"Maps","translate.es":"Translation"};
  if(S.rules&&TOOLCAT[tool]&&!S.rules.cats.includes(TOOLCAT[tool])){
    S.refused++; S.log.push({t,m:"Refused "+tool+". "+TOOLCAT[tool]+" is not on your allowed list."}); say("Gateway refused "+tool+". Not on your allowed list."); stopRun(); paintLease({refused:true}); return false;
  }
  if(S.rules&&c>S.rules.per){
    S.refused++; S.log.push({t,m:"Refused "+tool+" at "+fmt(c)+". Your per-call ceiling is "+fmt(S.rules.per)+"."}); say("Gateway refused "+tool+". Above your per-call ceiling."); stopRun(); paintLease({refused:true}); return false;
  }
  if(c>s.F){
    S.refused++;
    S.log.push({t,m:`Refused ${tool} at ${fmt(c)}. It would pass the cap; ${fmt(s.F)} is free.`});
    say(`Gateway refused ${tool}. It would pass the cap.`);
    stopRun(); paintLease({refused:true}); return false;
  }
  if(S.calls.filter(k=>k.st!=="refused").length>=NSLOT){stopRun();S.log.push({t,m:"The cord has no free slot. Settle, then start another lease."});paintLease();return false}
  const k={id:S.nextId++,tool,c,st:"accrued",t};
  S.calls.push(k); S.log.push({t,m:`Committed ${fmt(c)} to ${tool}.`}); S.ui.sel=null;
  say(`Committed ${fmt(c)} to ${tool}. ${fmt(sums().F)} free.`);
  paintLease({dropId:k.id});
  return true;
}
function startRun(){if(S.running||S.ui.voidOpen)return;S.running=true;S.timer=setInterval(()=>{if(!spend())return},1500);paintControls()}
function stopRun(){S.running=false;clearInterval(S.timer);S.timer=null;clearInterval(S.livePoll);S.livePoll=null}

/* ---------- approve ---------- */
V.approve=()=>{
  if(S.status==="active"){
    const s=sums();
    return `${simBand("sample lease, fixture amounts, nothing reaches PayPal")}<div class="wrap"><div class="approve"><div><h1>A lease is already active.</h1>
      <p class="sub" style="margin-top:24px;font-size:1.25rem;max-width:32rem">In this simulation it holds ${fmt(s.held)}, and nothing is held at PayPal. ${tagHtml("fixture")} Void it from the Lease page first, or reset this prototype to try the approval flow from the start.</p></div>
      <div><div class="btnrow"><a class="btn fill" href="/lease">Back to the lease</a><button class="btn" id="resetAll">Reset and approve again</button></div>
      <p class="help" style="margin-top:12px">Reset clears the fixture ledger on this page. It touches nothing at PayPal.</p></div></div></div>`;
  }
  const st=S.ui.approve;
  const busy=st==="loading";
  return `${simBand("sample lease, fixture amounts, nothing reaches PayPal")}<div class="wrap"><div class="approve"><div>
    <h1>Give your agent a budget.</h1>
    <ul class="terms">
      <li><span>One hold</span><span>On a real lease, PayPal would hold <strong class="num">${fmt(CAP)}</strong> on your account and charge nothing yet. Here nothing is held. ${tagHtml("fixture")}</span></li>
      <li><span>Spend</span><span>Your agent pays for tools from it, call by call. The gateway would refuse any call that would pass ${fmt(CAP)}.</span></li>
      <li><span>Capture</span><span>We capture in batches, because each capture costs about $0.49 plus 3.49% ${tagHtml("computed")}.</span></li>
      <li><span>Honor period</span><span>PayPal documents a 3 day honor period, then it is best effort. ${tagHtml("documented","from PayPal docs, not tested")}</span></li>
       <li><span>Void</span><span>This sample lets you void and confirm with the held amount. Hosted lease closing is not wired yet.</span></li>
    </ul></div>
    <div><div class="slimcord" aria-hidden="true"><svg viewBox="0 0 1072 44"><rect x="1" y="14" width="1070" height="16" fill="none" stroke="#231F1B" stroke-width="1.4" stroke-dasharray="6 6"/></svg></div>
      <p class="sub" style="font-size:1.25rem">One approval. This is a sandbox prototype, so the approval below is a ${tagHtml("fixture")} and makes no PayPal call.</p>
      <div class="btnrow" style="margin-top:24px">
        <button class="btn accent" id="approveGo" ${busy?'aria-busy="true" aria-disabled="true"':""} style="min-width:15.5rem">${busy?"Simulating approval":`Simulate ${fmt(CAP)} approval`}</button>
        <button class="btn" id="approveNo" ${busy?'aria-disabled="true"':""}>Simulate decline</button></div>
      ${st==="declined"?`<p class="err" style="margin-top:16px" role="alert">The simulated approval was declined. Nothing was held or charged. You can try again.</p>`:""}
      </div></div></div>`;
};

/* ---------- escrow ---------- */
const VERD=[["Fail",0],["Unsure",1],["Pass",2]];
const ESCROW=250;
function escrowCalc(){
  const a=S.ui.esc.a,b=S.ui.esc.b;
  if(a.v!==b.v||a.v===1)return {ea:a.v,eb:b.v,held:true,pay:0,rule:"A split or an unsure verdict holds the reserve for another round or buyer appeal.",twist:0};
  if(a.v===0)return {ea:0,eb:0,held:false,pay:0,rule:"Two fails void the job decision. The reserve returns to the lease.",twist:1};
  const score=Math.min(a.s,b.s), share=score>=70?100:score>=40?60:20;
  return {ea:2,eb:2,held:false,pay:Math.floor(ESCROW*share/100),share,rule:`Two passes. The lower score is ${score}; the buyer's preset rubric pays ${share}%.`,twist:1};
}
V.escrow=()=>{
  const a=S.ui.esc.a,b=S.ui.esc.b;
  const judge=(key,label,j)=>`<div class="judge"><h3 id="j${key}">${label}</h3>
    <div class="seg" role="radiogroup" aria-labelledby="j${key}">${VERD.map(([n,v])=>`<button role="radio" tabindex="${j.v===v?0:-1}" aria-checked="${j.v===v}" data-j="${key}" data-v="${v}">${n}</button>`).join("")}</div>
    <div class="scorerow"><label for="sc${key}">Score</label><input type="range" id="sc${key}" data-sc="${key}" min="0" max="100" value="${j.s}"><span class="num" id="scv${key}" style="min-width:2.5ch;text-align:right">${j.s}</span></div></div>`;
  const er=proofEvidence.escrow;
  const recordedRun=`<section class="recorded-run" aria-labelledby="rrh"><h2 class="sec" id="rrh">A recorded escrow run</h2>
    <p class="help">A ${fmt(er.capture.amount)} job, judged by two providers. Verdicts and decision come from the run report. The capture is supported by its PayPal POST response; the payout has a separate GET. ${tagHtml("recorded","recorded "+er.date)}</p>
    <div class="rr-rows">${er.verdicts.map(v=>trow(`<span>Judge ${esc(v.provider)}</span> <span class="num">${esc(v.verdict)} · ${v.score}</span>`,tagHtml("recorded"))).join("")}
      ${trow(`<span>Kernel decision</span> <strong class="num">${esc(er.decision.status)} ${fmt(er.decision.amount)}</strong>`,tagHtml("computed"))}
      ${trow(`<span>Capture ${esc(er.capture.status)} (POST response)</span> <span class="num">${fmt(er.capture.amount)} \u00b7 fee ${fmt(er.capture.fee)}</span>`,tagHtml("measured"))}
      ${trow(`<span>Payout ${esc(er.payout.status)}</span> <strong class="num">${fmt(er.payout.amount)}</strong>`,tagHtml("measured"))}</div>
     <p class="help">The hosted site does not run escrow jobs yet. This is the saved run. <a href="/proof">The PayPal responses behind it</a> are on the evidence page.</p></section>`;
   return `<div class="wrap"><div class="modeband" role="note"><span class="dk-line"><span class="dk-dot sim" aria-hidden="true"></span><strong class="dk-mode">INTERACTIVE SIMULATION</strong></span><span class="dk-sub">Sample $2.50 job and buyer rubric. Nothing reaches PayPal.</span></div><div class="two"><div class="title-block">
     <h2 class="sec">Try the rule</h2><h1 class="try-h">Two judges propose. The kernel decides.</h1>
    <p class="sub">The buyer set the rubric before the job began. A judge may only answer with a verdict from a fixed list and a score. No model ever writes an amount.</p>
    ${judge("a","Judge A, provider one",a)}${judge("b","Judge B, provider two",b)}
    <p class="help" style="margin-top:16px">${tagHtml("fixture","sample job")} The $2.50 job, rubric and verdicts are sample data. This browser simulation mirrors the kernel's pass, fail and hold rule.</p>
   </div><div id="escOut"><div class="ply-out"></div><div class="kernel"></div></div></div><div class="modeband" role="note"><span class="dk-line"><span class="dk-dot recorded" aria-hidden="true"></span><strong class="dk-mode">RECORDED EVIDENCE</strong></span><span class="dk-sub">Dated sandbox run. This is not the current demo lease.</span></div>${recordedRun}</div>`;
};
function plySVG(tw,pay){
  const W=700,H=210,mid=96,X1=470,wl=64;
  const sm=v=>{v=Math.max(0,Math.min(1,v));return v*v*(3-2*v)};
  const path=(sgn,ph)=>{let d="";for(let x=0;x<=X1;x+=4){
    const conv=tw*sm((x-110)/280), sep=42*(1-conv), amp=6+conv*10;
    const y=mid+sgn*sep+amp*Math.sin(x/wl*Math.PI*2+ph);d+=(x?"L":"M")+x+" "+y.toFixed(1)+" "}return d};
  const strand=(d,fill)=>`<path d="${d}" fill="none" stroke="#231F1B" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${fill}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#231F1B" stroke-opacity=".3" stroke-width="9" stroke-dasharray="1.5 6"/>`;
  const frayEnd=y=>[-4,0,4].map(d=>`<path d="M${X1+2} ${y} l11 ${d*1.5}" stroke="#231F1B" stroke-width="1.3" stroke-linecap="round"/>`).join("");
  const out=tw>0?`<path d="M${X1} ${mid} L${W-12} ${mid}" stroke="#231F1B" stroke-width="14" stroke-linecap="round"/><path d="M${X1} ${mid} L${W-12} ${mid}" stroke="#F3EFE2" stroke-width="10" stroke-linecap="round"/><path d="M${X1} ${mid} L${W-12} ${mid}" stroke="#231F1B" stroke-opacity=".3" stroke-width="10" stroke-dasharray="1.5 6"/>`:"";
  let kn=""; if(tw>0){digits(pay).forEach((n,lv)=>{for(let j=0;j<n;j++)kn+=`<rect x="${X1+34+lv*48+j*6}" y="${mid-11}" width="4.5" height="22" rx="2" fill="#231F1B"/>`})}
  const fr=tw>0?"":frayEnd(mid-42)+frayEnd(mid+42);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Two judge strands. ${tw>0?"They agree enough to twist into one cord, and the payout is tied on it as knots.":"They split and stay apart, so no payout is tied."}"><defs><filter id="sf" x="-5%" y="-10%" width="110%" height="140%"><feDropShadow dx="0" dy="2.5" stdDeviation="1.6" flood-color="#231F1B" flood-opacity=".3"/></filter></defs><g filter="url(#sf)">${strand(path(1,Math.PI),"#F3EFE2")}${strand(path(-1,0),"#4a423a")}${out}${kn}${fr}</g></svg>`;
}
function paintEscrow(animate=true){
  const el=$("#escOut"); if(!el)return;
  const r=escrowCalc(), a=S.ui.esc.a,b=S.ui.esc.b;
  const nm=i=>VERD[i][0];
  const ply=$(".ply-out",el), drawing=`${r.twist}:${r.pay}`;
  if(ply.dataset.drawing!==drawing){
    const previous=ply.firstElementChild;
    const opacity=previous&&animate&&!reduced()?Number(getComputedStyle(previous).opacity):1;
    ply.innerHTML=plySVG(r.twist,r.pay);
    ply.dataset.drawing=drawing;
    if(previous&&animate&&!reduced()){
      previous.getAnimations({subtree:true}).forEach(animation=>animation.cancel());
      previous.classList.add("ply-exit");
      previous.setAttribute("aria-hidden","true");
      $("defs",previous).remove();
      ply.append(previous);
      motion(previous,[{opacity},{opacity:0}],160,"forwards").finished.then(()=>previous.remove(),()=>previous.remove());
      arrive(ply.firstElementChild,230,.25);
    }
  }else if(!animate){
    ply.getAnimations({subtree:true}).forEach(animation=>animation.cancel());
    $(".ply-exit",ply)?.remove();
  }
  paintText($(".kernel",el),`<h2 style="font-size:1.25rem;letter-spacing:-.01em">What the kernel does with it ${tagHtml("computed","computed in your browser")}</h2>
    <dl><dt>Judge A counts as</dt><dd>${nm(r.ea)}</dd><dt>Judge B counts as</dt><dd>${nm(r.eb)}</dd><dt>Escrow</dt><dd class="num">${fmt(ESCROW)} ${tagHtml("fixture")}</dd></dl>
    <p style="margin-top:12px">${r.rule}</p>
    <div class="payout num" role="status">${r.held?`${fmt(ESCROW)} held`:`${fmt(r.pay)} to the seller`}</div>
    <p class="help" style="margin-top:8px">${r.held?"Nobody is paid while held.":`${fmt(ESCROW-r.pay)} would return to the lease. The capture and seller payout are later, separate steps. This page moves no money.`}</p>
    <p class="help" style="margin-top:12px">${tagHtml("fixture","fixture rubric")} The shares and score thresholds below are sample choices a buyer would set.</p>
    <pre class="rule" tabindex="0" aria-label="The rubric as code">two pass -> use the lower score
score 70+ pays 100%; 40+ pays 60%; below 40 pays 20%
two fail -> void; split or unsure -> hold
amount = floor(job cents * rubric basis points / 10000)</pre>`,"dd,.kernel > p,.payout",animate);
}

/* ---------- settle ---------- */
function accruedCalls(){return S.calls.filter(k=>k.st==="accrued")}
function groupsFor(items,n){
  const m=items.length,base=Math.floor(m/n),extra=m%n,g=[];let i=0;
  for(let j=0;j<n;j++){const sz=base+(j<extra?1:0);g.push(items.slice(i,i+sz));i+=sz}return g;
}
V.settle=()=>`<div class="wrap">${slimBlock()}<div id="settleBody"></div></div>`;
function paintSettle(){
  const el=$("#settleBody"); if(!el)return;
  const items=accruedCalls(), m=items.length;
  if(S.status==="voided"){el.innerHTML=`<h1 class="big">Nothing to settle.</h1><p class="sub" style="margin-top:24px;font-size:1.2rem;max-width:32rem">The sample lease is voided. Start a new lease to spend again.</p><a class="btn fill" style="margin-top:24px" href="/approve">Start a new lease</a>`;return}
  if(!m){
    const done=S.ui.settleDone;
    const fromCapture=done&&$("#settleHead");
    const bundle=fromCapture&&$("#bundle");
    const oldParts=bundle&&!reduced()&&[...bundle.querySelectorAll(".cordseg,.whip")].map(node=>[node,node.getBoundingClientRect()]);
    if(fromCapture){
      const summary=$(".slimcord"), owed=$('[data-state="owed"]',summary);
      const next=document.createElement("template");
      next.innerHTML=slimBlock();
      const updated=next.content.firstElementChild;
      summary.replaceWith(updated);
      if(owed)overlay($("svg",updated),[owed],[{opacity:1},{opacity:0}],230);
      arrive($("p > span:not(.tag)",updated));
    }
    el.innerHTML=`<h1 class="big">${done?"Settled.":"Nothing is owed yet."}</h1>
     <div class="empty" style="margin-top:32px"><p>${done?`<span>${done.n} capture${done.n>1?"s":""} of ${fmt(done.amt)} went through for ${fmt(done.fee)} in fees</span> ${tagHtml("computed")} ${tagHtml("fixture","no PayPal call was made")}. The pendants on the Lease page now carry solid knots.`:"Calls your agent makes accrue here until you capture them. Fewer, larger captures cost less."}</p>
     <div class="btnrow" style="margin-top:20px"><a class="btn fill" href="/lease">${done?"See the cord":"Go and let the agent spend"}</a></div></div>`;
    if(fromCapture){
      arrive($("h1",el),180,.64);
      arrive($(".empty p > span",el));
      if(oldParts){
        const origin=el.getBoundingClientRect();
        oldParts.forEach(([node,rect])=>exitBundlePart(el,node,rect,origin,0,18,160));
      }
    }
    return;
  }
  const A=items.reduce((a,k)=>a+k.c,0);
  if(S.ui.settleN==null||S.ui.settleN>m)S.ui.settleN=Math.max(1,Math.ceil(m/3));
  el.innerHTML=`<div id="settleHead"></div>
   <div class="range-block"><label for="nr" style="font-weight:600">How many captures</label>
    <div class="scorerow" style="max-width:none"><input type="range" id="nr" min="1" max="${m}" value="${S.ui.settleN}" ${m===1?"disabled":""} aria-describedby="nrh"><span class="num" id="nrv" style="min-width:2.5ch;text-align:right">${S.ui.settleN}</span></div>
    <div class="btnrow" style="margin-top:8px"><button class="btn" id="fewest" ${m===1?'aria-disabled="true"':""}>Fewest, 1 capture</button><button class="btn" id="every" ${m===1?'aria-disabled="true"':""}>One per call, ${m}</button></div>
    <p class="help" id="nrh" style="margin-top:8px">${m===1?"One call is owed, so one capture is all there is.":"Drag to group the owed calls into captures. Each group is tied with a dark whipping."}</p></div>
   <div id="bundle"></div>
   <div class="compare" id="compare"></div>
   <div style="margin-top:32px" id="settleAct"></div>`;
  paintSettleLive(items,A);
}
function paintSettleLive(items,A,animate=false){
  const n=S.ui.settleN, g=groupsFor(items,n);
  const fee=g.reduce((a,grp)=>a+feeC(grp.reduce((x,k)=>x+k.c,0)),0);
  const per=items.reduce((a,k)=>a+feeC(k.c),0);
  const one=feeC(A);
  paintText($("#settleHead"),`<h1 class="big">${fmt(A)} owed. Settle it in ${n} capture${n>1?"s":""} for <span class="num">${fmt(fee)}</span>.</h1>`,"h1",animate);
  $("#nrv").textContent=n;
  const parts=[];
  g.forEach((grp,i)=>{const amt=grp.reduce((x,k)=>x+k.c,0);
    parts.push(`<div class="grp" style="--w:${Math.max(amt,20)}"><div class="cordseg"></div><div class="cap"><b class="num">${fmt(amt)}</b><span>capture ${i+1}, ${grp.length} call${grp.length>1?"s":""}</span><br><span class="num help">fee ${fmt(feeC(amt))}</span></div></div>`);
    if(i<g.length-1)parts.push(`<div class="whip" aria-hidden="true"></div>`)});
  paintBundle(`<div class="bundle" role="group" aria-label="The owed calls grouped into ${n} captures">${parts.join("")}</div>`,animate);
  paintText($("#compare"),`<table><caption class="sr">Fee comparison, computed</caption><thead><tr><th scope="col">Way to capture</th><th scope="col" class="r">Fees</th></tr></thead><tbody>
    <tr><td>One capture per call, ${items.length}</td><td class="num r">${fmt(per)}</td></tr>
    <tr><td><strong>Your choice, ${n}</strong></td><td class="num r"><strong>${fmt(fee)}</strong></td></tr>
    <tr><td>One capture for everything</td><td class="num r">${fmt(one)}</td></tr></tbody>
    <tfoot><tr><td>You save against one per call</td><td class="num r">${fmt(per-fee)}</td></tr></tfoot></table>
    <p class="help" style="margin-top:12px">${tagHtml("computed")} Fee model 0.49 plus 3.49% per capture, rounded to the cent. It reproduces the three fees PayPal returned in the sandbox spikes, on 1.00, 2.00 and 3.00. The 72 hour honor period is from PayPal docs and capture after day 3 has not been tested, so capture early.</p>`,"td strong,tfoot td.r",animate);
  const busy=S.ui.settleBusy;
  paintText($("#settleAct"),`<button class="btn fill" id="settleGo" ${busy?'aria-busy="true" aria-disabled="true"':""} style="min-width:17rem">${busy?"Capturing":`Capture ${fmt(A)} in ${n} step${n>1?"s":""}`}</button><p class="help" style="margin-top:8px">${tagHtml("fixture")} Makes no PayPal call. It changes only this page's ledger.</p>`,"button",animate);
}
function paintBundle(html,animate){
  const el=$("#bundle"), before=el.firstElementChild;
  if(before?.outerHTML===html){
    if(!animate){
      el.getAnimations({subtree:true}).forEach(animation=>animation.cancel());
      el.querySelectorAll(".bundle-exit").forEach(node=>node.remove());
    }
    return;
  }
  if(!animate||!before||reduced()){el.innerHTML=html;return}
  const origin=el.getBoundingClientRect();
  const parts=selector=>[...el.querySelectorAll(`.bundle ${selector}`)];
  const oldSegments=parts(".cordseg").map(node=>[node,node.getBoundingClientRect()]);
  const oldWhips=parts(".whip").map(node=>[node,node.getBoundingClientRect()]);
  el.innerHTML=html;
  const whips=parts(".whip"), segments=parts(".cordseg");
  const placement=(node,old,duration)=>{
    const rect=node.getBoundingClientRect();
    const x=old.left-rect.left, y=old.top-rect.top, sx=rect.width?old.width/rect.width:1;
    if(x||y||sx!==1)motion(node,[{transform:`translate(${x}px,${y}px) scaleX(${sx})`},{transform:"none"}],duration);
  };
  segments.forEach((node,i)=>oldSegments[i]?placement(node,oldSegments[i][1],240):arrive(node,200,.2));
  whips.forEach((node,i)=>oldWhips[i]?placement(node,oldWhips[i][1],220):arrive(node,180,.1));
  oldWhips.slice(whips.length).forEach(([node,rect])=>exitBundlePart(el,node,rect,origin,0,0,130));
  const join=segments.at(-1).getBoundingClientRect();
  oldSegments.slice(segments.length).forEach(([node,rect])=>{
    const x=Math.max(-52,Math.min(52,join.right-rect.right)), y=Math.max(-52,Math.min(52,join.top-rect.top));
    exitBundlePart(el,node,rect,origin,x,y,160);
  });
  parts(".cap").forEach(node=>arrive(node));
}
function exitBundlePart(root,source,rect,origin,x,y,duration){
  if(rect.bottom<0||rect.top>innerHeight)return;
  const node=source.cloneNode(true);
  node.classList.add("bundle-exit");
  node.setAttribute("aria-hidden","true");
  Object.assign(node.style,{top:`${rect.top-origin.top}px`,left:`${rect.left-origin.left}px`,width:`${rect.width}px`,height:`${rect.height}px`,margin:0});
  root.append(node);
  motion(node,[{opacity:1,transform:"none"},{opacity:0,transform:`translate(${x}px,${y}px)`}],duration,"forwards").finished.then(()=>node.remove(),()=>node.remove());
}

/* ---------- proof ---------- */
V.proof=()=>{
  const {fees,reconciliation,escrow,limits}=proofEvidence;
  const money=c=>`<span class="num money">${fmt(c)}</span>`;
  const utc=date=>date+" UTC";
  const feeDay=utc(fees.date);
  const reportTag=datedTag("recorded",escrow.date+" IST","(run report)");
  const rows=fees.rows.map(({id,time,amount,fee,status},i)=>`<tr><td class="num">${String(i+1).padStart(2,"0")}</td><td class="num">${esc(id)}</td><td class="num">${time}</td><td class="r">${money(amount)}</td><td class="r">${money(fee)}</td><td>${status}</td><td class="tagcell">${tagHtml("measured")}</td></tr>`).join("");
  const items=fees.rows.map(({amount},i)=>({id:i+1,c:amount,st:"captured"}));
  const svg=cordSVG({items,cap:fees.cap,C:fees.total,A:0,F:fees.remaining,vertical:isVertical(),interactive:false,settle:false,label:"Recorded sandbox captures drawn as a cord"});
  const captureDate=reconciliation.rows[0].date;
  const sharedCaptureDate=reconciliation.rows.every(row=>row.date===captureDate);
  const checks=reconciliation.rows.map(({id,amount,state,date})=>`<tr><th scope="row" class="mono">${esc(id)}</th><td>${money(amount)}</td><td>${state==="matched"?"Matched by fresh GET":"POST response only"} ${sharedCaptureDate?tagHtml("measured"):datedTag("measured",utc(date))}</td></tr>`).join("");
  const auth=reconciliation.authorization;
  return `<div class="wrap proofpage" id="sandbox-proof"><div class="modeband" role="note"><span class="dk-line"><span class="dk-dot recorded" aria-hidden="true"></span><strong class="dk-mode">RECORDED EVIDENCE</strong></span><span class="dk-sub">Dated PayPal sandbox responses and independently computed ledger figures. This is not the current demo lease.</span></div>
   <div class="proofhead"><h1>PayPal sandbox proof</h1><p class="sub">Recorded evidence from the capture fee experiment and the replacement lease run.</p></div>
   <section class="proof-section" aria-labelledby="proof-fees">
    <h2 id="proof-fees">Capture fees on one authorization</h2>
    <div class="cordwrap proof-cord">${svg}</div>
    <p class="help proof-balance">Cord visualization ${datedTag("computed",feeDay)}<br>Authorized ${money(fees.cap)} ${datedTag("measured",feeDay)}<br>Still held before void ${money(fees.remaining)} ${datedTag("computed",feeDay)}</p>
    <div class="wide" tabindex="0" role="region" aria-label="Capture fees table"><table class="rt proofrt">
     <caption class="proof-caption">Capture POST responses ${datedTag("measured",feeDay)}</caption>
     <thead><tr><th scope="col">No.</th><th scope="col">Capture ID</th><th scope="col">UTC</th><th scope="col" class="r">Amount</th><th scope="col" class="r">PayPal fee</th><th scope="col">Status</th><th scope="col">Evidence</th></tr></thead>
     <tbody>${rows}</tbody>
     <tfoot><tr><td colspan="3">Total</td><td class="r">${money(fees.total)}</td><td class="r">${money(fees.feeTotal)}</td><td colspan="2" class="tagcell">${tagHtml("computed")}</td></tr>
     <tr><td colspan="3">Estimated fee if captured together</td><td class="r">${money(fees.total)}</td><td class="r">${money(fees.singleCaptureEstimate)}</td><td colspan="2" class="tagcell">${tagHtml("computed")}</td></tr></tfoot>
    </table></div>
   </section>
   <section class="proof-section" aria-labelledby="proof-reconcile">
    <h2 id="proof-reconcile">Capture reconciliation</h2>
    <p class="help">Matched rows agree on capture ID, status, amount and fee in separate PayPal GET responses.</p>
    <table class="rt reconcile-rt"><caption class="proof-caption">Replacement run captures ${sharedCaptureDate?datedTag("measured",utc(captureDate)):tagHtml("measured")}</caption><thead><tr><th scope="col">Sandbox record</th><th scope="col">Amount</th><th scope="col">Evidence</th></tr></thead>
     <tbody>${checks}<tr><th scope="row">Earlier authorization</th><td></td><td>No capture recorded for this authorization in the log. ${datedTag("computed",utc(auth.logDate))}<br>Log entry in <code class="proof-log-path">evidence/sandbox-readonly-20261108.jsonl</code> records a PayPal GET response of ${auth.status}. ${datedTag("measured",auth.readAt)}</td></tr></tbody>
    </table>
   </section>
   <section class="proof-section proof-escrow" aria-labelledby="proof-escrow">
    <h2 id="proof-escrow">Escrow run</h2>
    <p class="help">The run report records both verdicts and the kernel decision. Raw verdict rows are absent from the logs.</p>
    <dl>
     ${escrow.verdicts.map(({provider,verdict,score})=>`<div><dt>${esc(provider)}</dt><dd>${verdict} · <span class="num">${score}</span><small>${reportTag}</small></dd></div>`).join("")}
     <div><dt>Kernel decision</dt><dd>${escrow.decision.status} ${money(escrow.decision.amount)}<small>${reportTag}</small></dd></div>
     <div><dt>Capture</dt><dd>${money(escrow.capture.amount)} · ${escrow.capture.status} · fee ${money(escrow.capture.fee)}<small>${escrow.capture.state==="matched"?"Confirmed by PayPal GET":"POST response only"} ${datedTag("measured",utc(escrow.capture.date))}</small></dd></div>
     <div><dt>Payout</dt><dd>${money(escrow.payout.amount)} · ${escrow.payout.status}<small>Confirmed by PayPal GET ${datedTag("measured",utc(escrow.payout.date))}</small></dd></div>
    </dl>
   </section>
   <section class="proof-section" aria-labelledby="proof-limits">
    <h2 id="proof-limits">What this does not prove</h2>
    <p>PayPal mentioned a ${limits.overage} overage limit in an error response. ${datedTag("measured",utc(limits.date))} The run did not test that boundary.</p>
    <p>Day-four reauthorization, webhook latency, refusal of a paid call after a real PayPal void, and PayPal timeout handling remain unproven.</p>
   </section>
  </div>`;
};

/* =============================================================
   Site: landing, sign up, log in, and the chrome around them
============================================================= */
const BRAND_HTML=`<a class="brand" href="/lease" aria-label="Pashadhara, lease"><svg class="mark" viewBox="0 0 80 80" aria-hidden="true"><path d="M40.0 29.0 L40.7 29.0 L41.4 29.0 L42.2 29.1 L42.9 29.1 L43.6 29.2 L44.3 29.2 L45.0 29.3 L45.7 29.4 L46.4 29.5 L47.1 29.7 L47.8 29.8 L48.5 29.9 L49.2 30.1 L49.9 30.3 L50.6 30.5 L51.2 30.7 L51.9 30.9 L52.6 31.1 L53.2 31.3 L53.8 31.6 L54.5 31.8 L55.1 32.1 L55.7 32.4 L56.3 32.7 L56.9 33.0 L57.5 33.3 L58.1 33.6 L58.7 33.9 L59.2 34.3 L59.8 34.6 L60.3 35.0 L60.8 35.3 L61.3 35.7 L61.8 36.1 L62.3 36.5 L62.8 36.9 L63.3 37.3 L63.7 37.7 L64.1 38.1 L64.6 38.5 L65.0 39.0 L65.3 39.4 L65.7 39.8 L66.1 40.3 L66.4 40.7 L66.8 41.2 L67.1 41.6 L67.4 42.1 L67.7 42.6 L67.9 43.0 L68.2 43.5 L68.4 44.0 L68.7 44.4 L68.9 44.9 L69.1 45.4 L69.2 45.9 L69.4 46.4 L69.5 46.8 L69.7 47.3 L69.8 47.8 L69.9 48.3 L69.9 48.7 L70.0 49.2 L70.1 49.7 L70.1 50.1 L70.1 50.6 L70.1 51.0 L70.1 51.5 L70.0 51.9 L70.0 52.4 L69.9 52.8 L69.8 53.3 L69.7 53.7 L69.6 54.1 L69.5 54.5 L69.3 54.9 L69.2 55.3 L69.0 55.7 L68.8 56.1 L68.6 56.5 L68.4 56.9 L68.1 57.2 L67.9 57.6 L67.6 57.9 L67.3 58.3 L67.0 58.6 L66.7 58.9 L66.4 59.2 L66.1 59.5 L65.7 59.8 L65.4 60.0 L65.0 60.3 L64.6 60.5 L64.2 60.8 L63.8 61.0 L63.4 61.2 L63.0 61.4 L62.5 61.6 L62.1 61.7 L61.6 61.9 L61.2 62.0 L60.7 62.2 L60.2 62.3 L59.7 62.4 L59.2 62.5 L58.7 62.5 L58.2 62.6 L57.7 62.6 L57.1 62.7 L56.6 62.7 L56.1 62.7 L55.5 62.7 L55.0 62.6 L54.4 62.6 L53.8 62.5 L53.3 62.5 L52.7 62.4 L52.1 62.3 L51.6 62.1 L51.0 62.0 L50.4 61.8 L49.8 61.7 L49.3 61.5 L48.7 61.3 L48.1 61.1 L47.5 60.9 L46.9 60.6 L46.4 60.4 L45.8 60.1 L45.2 59.8 L44.6 59.5 L44.1 59.2 L43.5 58.9 L42.9 58.5 L42.4 58.2 L41.8 57.8 L41.3 57.4 L40.7 57.0 L40.2 56.6 L39.6 56.2 L39.1 55.8 L38.6 55.3 L38.0 54.9 L37.5 54.4 L37.0 53.9 L36.5 53.4 L36.0 52.9 L35.5 52.4 L35.1 51.9 L34.6 51.3 L34.1 50.8 L33.7 50.2 L33.3 49.7 L32.8 49.1 L32.4 48.5 L32.0 47.9 L31.6 47.3 L31.2 46.7 L30.8 46.1 L30.5 45.5 L30.1 44.9 L29.8 44.2 L29.4 43.6 L29.1 43.0 L28.8 42.3 L28.5 41.7 L28.2 41.0 L28.0 40.3 L27.7 39.7 L27.5 39.0 L27.2 38.3 L27.0 37.7 L26.8 37.0 L26.6 36.3 L26.5 35.6 L26.3 34.9 L26.1 34.3 L26.0 33.6 L25.9 32.9 L25.8 32.2 L25.7 31.5 L25.6 30.9 L25.5 30.2 L25.5 29.5 L25.4 28.9 L25.4 28.2 L25.4 27.5 L25.4 26.9 L25.4 26.2 L25.4 25.6 L25.5 24.9 L25.5 24.3 L25.6 23.7 L25.7 23.1 L25.8 22.4 L25.9 21.8 L26.0 21.2 L26.1 20.6 L26.3 20.0 L26.4 19.5 L26.6 18.9 L26.8 18.4 L27.0 17.8 L27.2 17.3 L27.4 16.7 L27.6 16.2 L27.9 15.7 L28.1 15.2 L28.4 14.7 L28.7 14.3 L28.9 13.8 L29.2 13.4 L29.5 13.0 L29.8 12.5 L30.1 12.1 L30.5 11.7 L30.8 11.4 L31.1 11.0 L31.5 10.7 L31.8 10.3 L32.2 10.0 L32.6 9.7 L33.0 9.4 L33.3 9.1 L33.7 8.9 L34.1 8.6 L34.5 8.4 L34.9 8.2 L35.3 8.0 L35.7 7.8 L36.2 7.7 L36.6 7.5 L37.0 7.4 L37.4 7.3 L37.8 7.2 L38.3 7.1 L38.7 7.1 L39.1 7.0 L39.6 7.0 L40.0 7.0 L40.4 7.0 L40.9 7.0 L41.3 7.1 L41.7 7.1 L42.2 7.2 L42.6 7.3 L43.0 7.4 L43.4 7.5 L43.8 7.7 L44.3 7.8 L44.7 8.0 L45.1 8.2 L45.5 8.4 L45.9 8.6 L46.3 8.9 L46.7 9.1 L47.0 9.4 L47.4 9.7 L47.8 10.0 L48.2 10.3 L48.5 10.7 L48.9 11.0 L49.2 11.4 L49.5 11.7 L49.9 12.1 L50.2 12.5 L50.5 13.0 L50.8 13.4 L51.1 13.8 L51.3 14.3 L51.6 14.7 L51.9 15.2 L52.1 15.7 L52.4 16.2 L52.6 16.7 L52.8 17.3 L53.0 17.8 L53.2 18.4 L53.4 18.9 L53.6 19.5 L53.7 20.0 L53.9 20.6 L54.0 21.2 L54.1 21.8 L54.2 22.4 L54.3 23.1 L54.4 23.7 L54.5 24.3 L54.5 24.9 L54.6 25.6 L54.6 26.2 L54.6 26.9 L54.6 27.5 L54.6 28.2 L54.6 28.9 L54.5 29.5 L54.5 30.2 L54.4 30.9 L54.3 31.5 L54.2 32.2 L54.1 32.9 L54.0 33.6 L53.9 34.3 L53.7 34.9 L53.5 35.6 L53.4 36.3 L53.2 37.0 L53.0 37.7 L52.8 38.3 L52.5 39.0 L52.3 39.7 L52.0 40.3 L51.8 41.0 L51.5 41.7 L51.2 42.3 L50.9 43.0 L50.6 43.6 L50.2 44.2 L49.9 44.9 L49.5 45.5 L49.2 46.1 L48.8 46.7 L48.4 47.3 L48.0 47.9 L47.6 48.5 L47.2 49.1 L46.7 49.7 L46.3 50.2 L45.9 50.8 L45.4 51.3 L44.9 51.9 L44.5 52.4 L44.0 52.9 L43.5 53.4 L43.0 53.9 L42.5 54.4 L42.0 54.9 L41.4 55.3 L40.9 55.8 L40.4 56.2 L39.8 56.6 L39.3 57.0 L38.7 57.4 L38.2 57.8 L37.6 58.2 L37.1 58.5 L36.5 58.9 L35.9 59.2 L35.4 59.5 L34.8 59.8 L34.2 60.1 L33.6 60.4 L33.1 60.6 L32.5 60.9 L31.9 61.1 L31.3 61.3 L30.7 61.5 L30.2 61.7 L29.6 61.8 L29.0 62.0 L28.4 62.1 L27.9 62.3 L27.3 62.4 L26.7 62.5 L26.2 62.5 L25.6 62.6 L25.0 62.6 L24.5 62.7 L23.9 62.7 L23.4 62.7 L22.9 62.7 L22.3 62.6 L21.8 62.6 L21.3 62.5 L20.8 62.5 L20.3 62.4 L19.8 62.3 L19.3 62.2 L18.8 62.0 L18.4 61.9 L17.9 61.7 L17.5 61.6 L17.0 61.4 L16.6 61.2 L16.2 61.0 L15.8 60.8 L15.4 60.5 L15.0 60.3 L14.6 60.0 L14.3 59.8 L13.9 59.5 L13.6 59.2 L13.3 58.9 L13.0 58.6 L12.7 58.3 L12.4 57.9 L12.1 57.6 L11.9 57.2 L11.6 56.9 L11.4 56.5 L11.2 56.1 L11.0 55.7 L10.8 55.3 L10.7 54.9 L10.5 54.5 L10.4 54.1 L10.3 53.7 L10.2 53.3 L10.1 52.8 L10.0 52.4 L10.0 51.9 L9.9 51.5 L9.9 51.0 L9.9 50.6 L9.9 50.1 L9.9 49.7 L10.0 49.2 L10.1 48.7 L10.1 48.3 L10.2 47.8 L10.3 47.3 L10.5 46.8 L10.6 46.4 L10.8 45.9 L10.9 45.4 L11.1 44.9 L11.3 44.4 L11.6 44.0 L11.8 43.5 L12.1 43.0 L12.3 42.6 L12.6 42.1 L12.9 41.6 L13.2 41.2 L13.6 40.7 L13.9 40.3 L14.3 39.8 L14.7 39.4 L15.0 39.0 L15.4 38.5 L15.9 38.1 L16.3 37.7 L16.7 37.3 L17.2 36.9 L17.7 36.5 L18.2 36.1 L18.7 35.7 L19.2 35.3 L19.7 35.0 L20.2 34.6 L20.8 34.3 L21.3 33.9 L21.9 33.6 L22.5 33.3 L23.1 33.0 L23.7 32.7 L24.3 32.4 L24.9 32.1 L25.5 31.8 L26.2 31.6 L26.8 31.3 L27.4 31.1 L28.1 30.9 L28.8 30.7 L29.4 30.5 L30.1 30.3 L30.8 30.1 L31.5 29.9 L32.2 29.8 L32.9 29.7 L33.6 29.5 L34.3 29.4 L35.0 29.3 L35.7 29.2 L36.4 29.2 L37.1 29.1 L37.8 29.1 L38.6 29.0 L39.3 29.0 L40.0 29.0 " fill="none" stroke="#231F1B" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><path d="M40.0 29.0 L40.7 29.0 L41.4 29.0 L42.2 29.1 L42.9 29.1 L43.6 29.2 L44.3 29.2 L45.0 29.3 L45.7 29.4 L46.4 29.5 L47.1 29.7 L47.8 29.8 L48.5 29.9 L49.2 30.1 L49.9 30.3 L50.6 30.5 L51.2 30.7 L51.9 30.9 L52.6 31.1 L53.2 31.3 L53.8 31.6 L54.5 31.8 L55.1 32.1 L55.7 32.4 L56.3 32.7 L56.9 33.0 L57.5 33.3 L58.1 33.6 L58.7 33.9 L59.2 34.3 L59.8 34.6 L60.3 35.0 L60.8 35.3 L61.3 35.7 L61.8 36.1 L62.3 36.5 L62.8 36.9 L63.3 37.3 L63.7 37.7 L64.1 38.1 L64.6 38.5 L65.0 39.0 L65.3 39.4 L65.7 39.8 L66.1 40.3 L66.4 40.7 L66.8 41.2 L67.1 41.6 L67.4 42.1 L67.7 42.6 L67.9 43.0 L68.2 43.5 L68.4 44.0 L68.7 44.4 L68.9 44.9 L69.1 45.4 L69.2 45.9 L69.4 46.4 L69.5 46.8 L69.7 47.3 L69.8 47.8 L69.9 48.3 L69.9 48.7 L70.0 49.2 L70.1 49.7 L70.1 50.1 L70.1 50.6 L70.1 51.0 L70.1 51.5 L70.0 51.9 L70.0 52.4 L69.9 52.8 L69.8 53.3 L69.7 53.7 L69.6 54.1 L69.5 54.5 L69.3 54.9 L69.2 55.3 L69.0 55.7 L68.8 56.1 L68.6 56.5 L68.4 56.9 L68.1 57.2 L67.9 57.6 L67.6 57.9 L67.3 58.3 L67.0 58.6 L66.7 58.9 L66.4 59.2 L66.1 59.5 L65.7 59.8 L65.4 60.0 L65.0 60.3 L64.6 60.5 L64.2 60.8 L63.8 61.0 L63.4 61.2 L63.0 61.4 L62.5 61.6 L62.1 61.7 L61.6 61.9 L61.2 62.0 L60.7 62.2 L60.2 62.3 L59.7 62.4 L59.2 62.5 L58.7 62.5 L58.2 62.6 L57.7 62.6 L57.1 62.7 L56.6 62.7 L56.1 62.7 L55.5 62.7 L55.0 62.6 L54.4 62.6 L53.8 62.5 L53.3 62.5 L52.7 62.4 L52.1 62.3 L51.6 62.1 L51.0 62.0 L50.4 61.8 L49.8 61.7 L49.3 61.5 L48.7 61.3 L48.1 61.1 L47.5 60.9 L46.9 60.6 L46.4 60.4 L45.8 60.1 L45.2 59.8 L44.6 59.5 L44.1 59.2 L43.5 58.9 L42.9 58.5 L42.4 58.2 L41.8 57.8 L41.3 57.4 L40.7 57.0 L40.2 56.6 L39.6 56.2 L39.1 55.8 L38.6 55.3 L38.0 54.9 L37.5 54.4 L37.0 53.9 L36.5 53.4 L36.0 52.9 L35.5 52.4 L35.1 51.9 L34.6 51.3 L34.1 50.8 L33.7 50.2 L33.3 49.7 L32.8 49.1 L32.4 48.5 L32.0 47.9 L31.6 47.3 L31.2 46.7 L30.8 46.1 L30.5 45.5 L30.1 44.9 L29.8 44.2 L29.4 43.6 L29.1 43.0 L28.8 42.3 L28.5 41.7 L28.2 41.0 L28.0 40.3 L27.7 39.7 L27.5 39.0 L27.2 38.3 L27.0 37.7 L26.8 37.0 L26.6 36.3 L26.5 35.6 L26.3 34.9 L26.1 34.3 L26.0 33.6 L25.9 32.9 L25.8 32.2 L25.7 31.5 L25.6 30.9 L25.5 30.2 L25.5 29.5 L25.4 28.9 L25.4 28.2 L25.4 27.5 L25.4 26.9 L25.4 26.2 L25.4 25.6 L25.5 24.9 L25.5 24.3 L25.6 23.7 L25.7 23.1 L25.8 22.4 L25.9 21.8 L26.0 21.2 L26.1 20.6 L26.3 20.0 L26.4 19.5 L26.6 18.9 L26.8 18.4 L27.0 17.8 L27.2 17.3 L27.4 16.7 L27.6 16.2 L27.9 15.7 L28.1 15.2 L28.4 14.7 L28.7 14.3 L28.9 13.8 L29.2 13.4 L29.5 13.0 L29.8 12.5 L30.1 12.1 L30.5 11.7 L30.8 11.4 L31.1 11.0 L31.5 10.7 L31.8 10.3 L32.2 10.0 L32.6 9.7 L33.0 9.4 L33.3 9.1 L33.7 8.9 L34.1 8.6 L34.5 8.4 L34.9 8.2 L35.3 8.0 L35.7 7.8 L36.2 7.7 L36.6 7.5 L37.0 7.4 L37.4 7.3 L37.8 7.2 L38.3 7.1 L38.7 7.1 L39.1 7.0 L39.6 7.0 L40.0 7.0 " fill="none" stroke="#4a423a" stroke-width="8.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M40.0 7.0 L40.4 7.0 L40.9 7.0 L41.3 7.1 L41.7 7.1 L42.2 7.2 L42.6 7.3 L43.0 7.4 L43.4 7.5 L43.8 7.7 L44.3 7.8 L44.7 8.0 L45.1 8.2 L45.5 8.4 L45.9 8.6 L46.3 8.9 L46.7 9.1 L47.0 9.4 L47.4 9.7 L47.8 10.0 L48.2 10.3 L48.5 10.7 L48.9 11.0 L49.2 11.4 L49.5 11.7 L49.9 12.1 L50.2 12.5 L50.5 13.0 L50.8 13.4 L51.1 13.8 L51.3 14.3 L51.6 14.7 L51.9 15.2 L52.1 15.7 L52.4 16.2 L52.6 16.7 L52.8 17.3 L53.0 17.8 L53.2 18.4 L53.4 18.9 L53.6 19.5 L53.7 20.0 L53.9 20.6 L54.0 21.2 L54.1 21.8 L54.2 22.4 L54.3 23.1 L54.4 23.7 L54.5 24.3 L54.5 24.9 L54.6 25.6 L54.6 26.2 L54.6 26.9 L54.6 27.5 L54.6 28.2 L54.6 28.9 L54.5 29.5 L54.5 30.2 L54.4 30.9 L54.3 31.5 L54.2 32.2 L54.1 32.9 L54.0 33.6 L53.9 34.3 L53.7 34.9 L53.5 35.6 L53.4 36.3 L53.2 37.0 L53.0 37.7 L52.8 38.3 L52.5 39.0 L52.3 39.7 L52.0 40.3 L51.8 41.0 L51.5 41.7 L51.2 42.3 L50.9 43.0 L50.6 43.6 L50.2 44.2 L49.9 44.9 L49.5 45.5 L49.2 46.1 L48.8 46.7 L48.4 47.3 L48.0 47.9 L47.6 48.5 L47.2 49.1 L46.7 49.7 L46.3 50.2 L45.9 50.8 L45.4 51.3 L44.9 51.9 L44.5 52.4 L44.0 52.9 L43.5 53.4 L43.0 53.9 L42.5 54.4 L42.0 54.9 L41.4 55.3 L40.9 55.8 L40.4 56.2 L39.8 56.6 L39.3 57.0 L38.7 57.4 L38.2 57.8 L37.6 58.2 L37.1 58.5 L36.5 58.9 L35.9 59.2 L35.4 59.5 L34.8 59.8 L34.2 60.1 L33.6 60.4 L33.1 60.6 L32.5 60.9 L31.9 61.1 L31.3 61.3 L30.7 61.5 L30.2 61.7 L29.6 61.8 L29.0 62.0 L28.4 62.1 L27.9 62.3 L27.3 62.4 L26.7 62.5 L26.2 62.5 L25.6 62.6 L25.0 62.6 L24.5 62.7 L23.9 62.7 L23.4 62.7 L22.9 62.7 L22.3 62.6 L21.8 62.6 L21.3 62.5 L20.8 62.5 L20.3 62.4 L19.8 62.3 L19.3 62.2 L18.8 62.0 L18.4 61.9 L17.9 61.7 L17.5 61.6 L17.0 61.4 L16.6 61.2 L16.2 61.0 L15.8 60.8 L15.4 60.5 L15.0 60.3 L14.6 60.0 L14.3 59.8 L13.9 59.5 L13.6 59.2 L13.3 58.9 L13.0 58.6 L12.7 58.3 L12.4 57.9 L12.1 57.6 L11.9 57.2 L11.6 56.9 L11.4 56.5 L11.2 56.1 L11.0 55.7 L10.8 55.3 L10.7 54.9 L10.5 54.5 L10.4 54.1 L10.3 53.7 L10.2 53.3 L10.1 52.8 L10.0 52.4 L10.0 51.9 L9.9 51.5 L9.9 51.0 L9.9 50.6 L9.9 50.1 L9.9 49.7 L10.0 49.2 L10.1 48.7 L10.1 48.3 L10.2 47.8 L10.3 47.3 L10.5 46.8 L10.6 46.4 L10.8 45.9 L10.9 45.4 L11.1 44.9 L11.3 44.4 L11.6 44.0 L11.8 43.5 L12.1 43.0 L12.3 42.6 L12.6 42.1 L12.9 41.6 L13.2 41.2 L13.6 40.7 L13.9 40.3 L14.3 39.8 L14.7 39.4 L15.0 39.0 L15.4 38.5 L15.9 38.1 L16.3 37.7 L16.7 37.3 L17.2 36.9 L17.7 36.5 L18.2 36.1 L18.7 35.7 L19.2 35.3 L19.7 35.0 L20.2 34.6 L20.8 34.3 L21.3 33.9 L21.9 33.6 L22.5 33.3 L23.1 33.0 L23.7 32.7 L24.3 32.4 L24.9 32.1 L25.5 31.8 L26.2 31.6 L26.8 31.3 L27.4 31.1 L28.1 30.9 L28.8 30.7 L29.4 30.5 L30.1 30.3 L30.8 30.1 L31.5 29.9 L32.2 29.8 L32.9 29.7 L33.6 29.5 L34.3 29.4 L35.0 29.3 L35.7 29.2 L36.4 29.2 L37.1 29.1 L37.8 29.1 L38.6 29.0 L39.3 29.0 L40.0 29.0 " fill="none" stroke="#8C1D38" stroke-width="8.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M55.0 62.6 L54.4 62.6 L53.8 62.5 L53.3 62.5 L52.7 62.4 L52.1 62.3 L51.6 62.1 L51.0 62.0 L50.4 61.8 L49.8 61.7 L49.3 61.5 L48.7 61.3 L48.1 61.1 L47.5 60.9 L46.9 60.6 L46.4 60.4 L45.8 60.1 L45.2 59.8 L44.6 59.5 L44.1 59.2 L43.5 58.9 L42.9 58.5 L42.4 58.2 L41.8 57.8 L41.3 57.4 L40.7 57.0 L40.2 56.6 L39.6 56.2 L39.1 55.8 L38.6 55.3 L38.0 54.9 L37.5 54.4 L37.0 53.9 L36.5 53.4 L36.0 52.9 L35.5 52.4 L35.1 51.9 L34.6 51.3 L34.1 50.8 L33.7 50.2 L33.3 49.7 L32.8 49.1 L32.4 48.5 L32.0 47.9 L31.6 47.3 L31.2 46.7 L30.8 46.1 L30.5 45.5 L30.1 44.9 L29.8 44.2 L29.4 43.6 L29.1 43.0 L28.8 42.3 " fill="none" stroke="#D5D8CE" stroke-width="19" stroke-linecap="butt"/><path d="M55.0 62.6 L54.4 62.6 L53.8 62.5 L53.3 62.5 L52.7 62.4 L52.1 62.3 L51.6 62.1 L51.0 62.0 L50.4 61.8 L49.8 61.7 L49.3 61.5 L48.7 61.3 L48.1 61.1 L47.5 60.9 L46.9 60.6 L46.4 60.4 L45.8 60.1 L45.2 59.8 L44.6 59.5 L44.1 59.2 L43.5 58.9 L42.9 58.5 L42.4 58.2 L41.8 57.8 L41.3 57.4 L40.7 57.0 L40.2 56.6 L39.6 56.2 L39.1 55.8 L38.6 55.3 L38.0 54.9 L37.5 54.4 L37.0 53.9 L36.5 53.4 L36.0 52.9 L35.5 52.4 L35.1 51.9 L34.6 51.3 L34.1 50.8 L33.7 50.2 L33.3 49.7 L32.8 49.1 L32.4 48.5 L32.0 47.9 L31.6 47.3 L31.2 46.7 L30.8 46.1 L30.5 45.5 L30.1 44.9 L29.8 44.2 L29.4 43.6 L29.1 43.0 L28.8 42.3 " fill="none" stroke="#231F1B" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><path d="M55.0 62.6 L54.4 62.6 L53.8 62.5 L53.3 62.5 L52.7 62.4 L52.1 62.3 L51.6 62.1 L51.0 62.0 L50.4 61.8 L49.8 61.7 L49.3 61.5 L48.7 61.3 L48.1 61.1 L47.5 60.9 L46.9 60.6 L46.4 60.4 L45.8 60.1 L45.2 59.8 L44.6 59.5 L44.1 59.2 L43.5 58.9 L42.9 58.5 L42.4 58.2 L41.8 57.8 L41.3 57.4 L40.7 57.0 L40.2 56.6 L39.6 56.2 L39.1 55.8 L38.6 55.3 L38.0 54.9 L37.5 54.4 L37.0 53.9 L36.5 53.4 L36.0 52.9 L35.5 52.4 L35.1 51.9 L34.6 51.3 L34.1 50.8 L33.7 50.2 L33.3 49.7 L32.8 49.1 L32.4 48.5 L32.0 47.9 L31.6 47.3 L31.2 46.7 L30.8 46.1 L30.5 45.5 L30.1 44.9 L29.8 44.2 L29.4 43.6 L29.1 43.0 L28.8 42.3 " fill="none" stroke="#4a423a" stroke-width="8.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M52.1 15.7 L52.4 16.2 L52.6 16.7 L52.8 17.3 L53.0 17.8 L53.2 18.4 L53.4 18.9 L53.6 19.5 L53.7 20.0 L53.9 20.6 L54.0 21.2 L54.1 21.8 L54.2 22.4 L54.3 23.1 L54.4 23.7 L54.5 24.3 L54.5 24.9 L54.6 25.6 L54.6 26.2 L54.6 26.9 L54.6 27.5 L54.6 28.2 L54.6 28.9 L54.5 29.5 L54.5 30.2 L54.4 30.9 L54.3 31.5 L54.2 32.2 L54.1 32.9 L54.0 33.6 L53.9 34.3 L53.7 34.9 L53.5 35.6 L53.4 36.3 L53.2 37.0 L53.0 37.7 L52.8 38.3 L52.5 39.0 L52.3 39.7 L52.0 40.3 L51.8 41.0 L51.5 41.7 L51.2 42.3 L50.9 43.0 L50.6 43.6 L50.2 44.2 L49.9 44.9 L49.5 45.5 L49.2 46.1 L48.8 46.7 L48.4 47.3 L48.0 47.9 L47.6 48.5 " fill="none" stroke="#D5D8CE" stroke-width="19" stroke-linecap="butt"/><path d="M52.1 15.7 L52.4 16.2 L52.6 16.7 L52.8 17.3 L53.0 17.8 L53.2 18.4 L53.4 18.9 L53.6 19.5 L53.7 20.0 L53.9 20.6 L54.0 21.2 L54.1 21.8 L54.2 22.4 L54.3 23.1 L54.4 23.7 L54.5 24.3 L54.5 24.9 L54.6 25.6 L54.6 26.2 L54.6 26.9 L54.6 27.5 L54.6 28.2 L54.6 28.9 L54.5 29.5 L54.5 30.2 L54.4 30.9 L54.3 31.5 L54.2 32.2 L54.1 32.9 L54.0 33.6 L53.9 34.3 L53.7 34.9 L53.5 35.6 L53.4 36.3 L53.2 37.0 L53.0 37.7 L52.8 38.3 L52.5 39.0 L52.3 39.7 L52.0 40.3 L51.8 41.0 L51.5 41.7 L51.2 42.3 L50.9 43.0 L50.6 43.6 L50.2 44.2 L49.9 44.9 L49.5 45.5 L49.2 46.1 L48.8 46.7 L48.4 47.3 L48.0 47.9 L47.6 48.5 " fill="none" stroke="#231F1B" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><path d="M52.1 15.7 L52.4 16.2 L52.6 16.7 L52.8 17.3 L53.0 17.8 L53.2 18.4 L53.4 18.9 L53.6 19.5 L53.7 20.0 L53.9 20.6 L54.0 21.2 L54.1 21.8 L54.2 22.4 L54.3 23.1 L54.4 23.7 L54.5 24.3 L54.5 24.9 L54.6 25.6 L54.6 26.2 L54.6 26.9 L54.6 27.5 L54.6 28.2 L54.6 28.9 L54.5 29.5 L54.5 30.2 L54.4 30.9 L54.3 31.5 L54.2 32.2 L54.1 32.9 L54.0 33.6 L53.9 34.3 L53.7 34.9 L53.5 35.6 L53.4 36.3 L53.2 37.0 L53.0 37.7 L52.8 38.3 L52.5 39.0 L52.3 39.7 L52.0 40.3 L51.8 41.0 L51.5 41.7 L51.2 42.3 L50.9 43.0 L50.6 43.6 L50.2 44.2 L49.9 44.9 L49.5 45.5 L49.2 46.1 L48.8 46.7 L48.4 47.3 L48.0 47.9 L47.6 48.5 " fill="none" stroke="#8C1D38" stroke-width="8.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.9 41.6 L13.2 41.2 L13.6 40.7 L13.9 40.3 L14.3 39.8 L14.7 39.4 L15.0 39.0 L15.4 38.5 L15.9 38.1 L16.3 37.7 L16.7 37.3 L17.2 36.9 L17.7 36.5 L18.2 36.1 L18.7 35.7 L19.2 35.3 L19.7 35.0 L20.2 34.6 L20.8 34.3 L21.3 33.9 L21.9 33.6 L22.5 33.3 L23.1 33.0 L23.7 32.7 L24.3 32.4 L24.9 32.1 L25.5 31.8 L26.2 31.6 L26.8 31.3 L27.4 31.1 L28.1 30.9 L28.8 30.7 L29.4 30.5 L30.1 30.3 L30.8 30.1 L31.5 29.9 L32.2 29.8 L32.9 29.7 L33.6 29.5 L34.3 29.4 L35.0 29.3 L35.7 29.2 L36.4 29.2 L37.1 29.1 L37.8 29.1 L38.6 29.0 L39.3 29.0 L40.0 29.0 L40.7 29.0 L41.4 29.0 L42.2 29.1 L42.9 29.1 L43.6 29.2 " fill="none" stroke="#D5D8CE" stroke-width="19" stroke-linecap="butt"/><path d="M12.9 41.6 L13.2 41.2 L13.6 40.7 L13.9 40.3 L14.3 39.8 L14.7 39.4 L15.0 39.0 L15.4 38.5 L15.9 38.1 L16.3 37.7 L16.7 37.3 L17.2 36.9 L17.7 36.5 L18.2 36.1 L18.7 35.7 L19.2 35.3 L19.7 35.0 L20.2 34.6 L20.8 34.3 L21.3 33.9 L21.9 33.6 L22.5 33.3 L23.1 33.0 L23.7 32.7 L24.3 32.4 L24.9 32.1 L25.5 31.8 L26.2 31.6 L26.8 31.3 L27.4 31.1 L28.1 30.9 L28.8 30.7 L29.4 30.5 L30.1 30.3 L30.8 30.1 L31.5 29.9 L32.2 29.8 L32.9 29.7 L33.6 29.5 L34.3 29.4 L35.0 29.3 L35.7 29.2 L36.4 29.2 L37.1 29.1 L37.8 29.1 L38.6 29.0 L39.3 29.0 L40.0 29.0 L40.7 29.0 L41.4 29.0 L42.2 29.1 L42.9 29.1 L43.6 29.2 " fill="none" stroke="#231F1B" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.9 41.6 L13.2 41.2 L13.6 40.7 L13.9 40.3 L14.3 39.8 L14.7 39.4 L15.0 39.0 L15.4 38.5 L15.9 38.1 L16.3 37.7 L16.7 37.3 L17.2 36.9 L17.7 36.5 L18.2 36.1 L18.7 35.7 L19.2 35.3 L19.7 35.0 L20.2 34.6 L20.8 34.3 L21.3 33.9 L21.9 33.6 L22.5 33.3 L23.1 33.0 L23.7 32.7 L24.3 32.4 L24.9 32.1 L25.5 31.8 L26.2 31.6 L26.8 31.3 L27.4 31.1 L28.1 30.9 L28.8 30.7 L29.4 30.5 L30.1 30.3 L30.8 30.1 L31.5 29.9 L32.2 29.8 L32.9 29.7 L33.6 29.5 L34.3 29.4 L35.0 29.3 L35.7 29.2 L36.4 29.2 L37.1 29.1 L37.8 29.1 L38.6 29.0 L39.3 29.0 L40.0 29.0 L40.7 29.0 L41.4 29.0 L42.2 29.1 L42.9 29.1 L43.6 29.2 " fill="none" stroke="#8C1D38" stroke-width="8.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="word">Pashadhara</span></a>`;
const brand=(href,label)=>BRAND_HTML.replace('href="/lease"',`href="${href}"`).replace('aria-label="Pashadhara, lease"',`aria-label="${label}"`);
const APP_ROUTES=["lease","approve","escrow","settle","proof","quickstart"];
const reduced=()=>reduceMotion.matches;

S.user=null;
S.rules={per:500,cats:["Data and search","Documents","Maps","Translation"]};
const CATS=["Data and search","Documents","Maps","Translation"];
const suFresh=(mode)=>({mode,step:1,name:"",email:"",err:{},codeErr:"",resend:0,paypal:"idle",cap:2000,per:500,cats:["Data and search","Documents","Maps","Translation"],customCap:"",approve:"idle",reveal:false,copied:false,test:"idle",busy:false});
S.su=suFresh("signup");
const resetSample=()=>{CAP=2000;S.status="active";S.calls=SAMPLE();S.q=0;S.nextId=8;S.clock=9*60+46;S.log=[{t:"09:44",m:"Committed $0.35 to web.search."}];S.refused=0;S.settles=[];S.voided=null;S.rules={per:500,cats:[...CATS]};S.ui.sel=null;S.ui.settleDone=null;S.ui.settleN=null;S.ui.voidOpen=false;S.ui.approve="idle";stopRun()};

/* ---------- chrome ---------- */
function progressCord(step,total){
  const W=150;let k="";
  for(let i=0;i<total;i++){const x=6+i*(W-12)/(total-1);
    const knot=i<step-1?`<rect x="${x-4}" y="5" width="8" height="18" rx="2" fill="#231F1B"/>`
     :i===step-1?`<rect x="${x-4}" y="5" width="8" height="18" rx="2" fill="#F3EFE2" stroke="#231F1B" stroke-width="1.5"/>`
     :`<rect x="${x-4}" y="6" width="8" height="16" rx="2" fill="none" stroke="#231F1B" stroke-opacity=".4" stroke-dasharray="2 2"/>`;
    k+=`<g data-knot="${i}">${knot}</g>`;
  }
  return `<svg viewBox="0 0 ${W} 28" aria-hidden="true"><rect x="0" y="10" width="${W}" height="8" fill="#F3EFE2" stroke="#231F1B" stroke-width=".8"/><rect x="0" y="10" width="${W}" height="8" fill="url(#plyP)"/><defs><pattern id="plyP" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><line x1="0" y1="0" x2="0" y2="7" stroke="#231F1B" stroke-opacity=".3" stroke-width="1.6"/></pattern></defs>${k}</svg>`;
}
function renderChrome(mode,v){
  const h=$("#hdr"); document.body.dataset.mode=mode;
  if(mode==="site"){
    h.innerHTML=`<div class="bar wrap">${brand("/","Pashadhara, home")}
     <nav aria-label="Primary"><ul>
      <li><a href="/#how" data-scroll="how">How it works</a></li><li><a href="/#limits" data-scroll="limits">Limits</a></li><li><a href="/quickstart"${v==="quickstart"?' aria-current="page"':""}>Developers</a></li><li><a href="/escrow"${v==="escrow"?' aria-current="page"':""}>Escrow</a></li><li><a href="/proof"${v==="proof"?' aria-current="page"':""}>Proof</a></li></ul></nav>
     <div class="acts"><a class="btn fill sm" href="/delegation">Explore $5,000 fixture</a></div></div>`;
  }else if(mode==="flow"){
    const {step,mode:flowMode}=S.su, login=flowMode==="login", total=login?2:6;
    const progress=$(".pcord",h), label=`Step ${step} of ${total}`;
    if(progress?.dataset.mode===flowMode){
      if(progress.dataset.step===String(step))return;
      const template=document.createElement("template");
      template.innerHTML=progressCord(step,total);
      progress.querySelectorAll("[data-knot]").forEach((node,i)=>{
        const next=template.content.querySelectorAll("[data-knot]")[i];
        if(node.innerHTML===next.innerHTML)return;
        const before=node.firstElementChild;
        node.replaceChildren(...next.children);
        overlay(node,[before],[{opacity:1},{opacity:0}],150);
      });
      progress.dataset.step=step;
      $(".sr",progress).textContent=label;
      if(!login){const visible=$('span[aria-hidden="true"]',progress);visible.textContent=label;arrive(visible)}
      return;
    }
    h.innerHTML=`<div class="bar wrap flowbar">${brand("/","Pashadhara, home")}
      <div class="pcord" data-mode="${flowMode}" data-step="${step}"><span class="sr">${label}</span>${progressCord(step,total)}<span aria-hidden="true">${login?"Log in":label}</span></div>
      <div class="acts"><a class="nav-login" href="/">Exit</a></div></div>`;
  }else{
    h.innerHTML=`<div class="bar wrap">${brand("/lease","Pashadhara, lease")}<nav aria-label="Primary"><ul id="nav"></ul></nav>
      <div class="acts"><span class="who">${esc(S.user?.showcase?"Demo lease":S.user?.live?"Live lease":S.user?.sample?"Sample lease (fixture)":S.user?.name||"")}</span><button class="link-btn so" data-act="theme" aria-pressed="${darkView()}">${darkView()?"Light view":"Dark view"}</button>${S.user?.showcase?`<a class="link-btn so" id="newlease" href="/">About</a>`:`<button class="link-btn so" data-act="signout">Sign out</button><a class="btn fill sm" id="newlease" href="/approve">New lease</a>`}</div></div>`;
    renderNav(v);
  }
  renderFooter(mode);
}
function legend(){return `<h3>How every number is labelled</h3><dl class="lg"><div><dt><span class="tag measured">measured</span></dt><dd>came back from a PayPal sandbox call</dd></div><div><dt><span class="tag computed">computed</span></dt><dd>derived by our code, or checked in a test. A live journal is computed from our own ledger</dd></div><div><dt><span class="tag documented">documented</span></dt><dd>what PayPal's docs say, not tested by us</dd></div><div><dt><span class="tag recorded">recorded</span></dt><dd>a saved result from a real sandbox run, with its date</dd></div><div><dt><span class="tag fixture">fixture</span></dt><dd>sample data. Never PayPal output</dd></div></dl><p class="help">Sandbox only. No real money moves.</p>`}
function renderFooter(mode){
  const f=$("#ftr");
  if(mode==="flow"){f.innerHTML="";f.hidden=true;return}
  f.hidden=false;
  if(mode==="app"){f.innerHTML=`<div class="wrap">${legend()}</div>`;return}
  f.innerHTML=`<div class="wrap"><div class="cols"><div>${legend()}</div>
   <div><h3>Product</h3><ul><li><a href="/lease?showcase=1">Open the live demo</a></li><li><a href="/proof">PayPal proof</a></li><li><a href="/" data-act="sample">Sample lease (fixture)</a></li></ul></div>
   <div><h3>Read</h3><ul><li><a href="/#how" data-scroll="how">How it works</a></li><li><a href="/#limits" data-scroll="limits">What it cannot promise</a></li><li><a href="/quickstart">Developer quickstart</a></li></ul></div></div></div>`;
}

/* ---------- landing ---------- */
on(reduceMotion,"change",()=>{if(reduced())document.getAnimations().forEach(animation=>animation.cancel())});
const HOW=[
 ["Approve","You approve one PayPal hold. Nothing is charged. The hold becomes the cord, and its length is your budget.",()=>cordSVG({items:[],cap:2000,C:0,A:0,F:2000,vertical:isVertical(),tickFs:24,label:"An empty cord. Twenty dollars of free length."}),"One hold, one budget. The teal length is what your agent may still spend. Illustration, fixture amounts."],
 ["Spend","Your agent pays for tools through the gateway. Each call ties a pendant to the cord. A call that would pass the cap is refused before PayPal is ever asked.",()=>cordSVG({items:[{id:1,c:120,st:"accrued"},{id:2,c:75,st:"accrued"},{id:3,c:250,st:"accrued"},{id:4,c:300,st:"accrued"},{id:5,c:475,st:"accrued"}],cap:2000,C:0,A:1220,F:780,vertical:isVertical(),tickFs:24,label:"Five paid calls tied on the cord."}),"Outlined knots are owed, not yet captured. Illustration, fixture amounts."],
 ["Settle",`Calls pile up as owed. We capture them in fewer, larger steps, because every capture costs about $0.49 plus 3.49%. Twelve $1 captures cost ${fmt(proofEvidence.fees.feeTotal)} in fees. One $12 capture is about ${fmt(proofEvidence.fees.singleCaptureEstimate)}. The fee figures come from recorded sandbox captures.`,()=>cordSVG({items:[{id:1,c:120,st:"captured"},{id:2,c:75,st:"captured"},{id:3,c:250,st:"captured"},{id:4,c:300,st:"captured"},{id:5,c:475,st:"captured"}],cap:2000,C:1220,A:0,F:780,vertical:isVertical(),tickFs:24,label:"The same calls, now captured."}),"Solid knots are captured. Fee figures are measured, then computed."],
 ["Judge","For escrowed jobs, two AI judges propose a verdict from a fixed list and a score. The database turns that into an amount with the rubric you set before the job. No model writes a number. The real judged runs are recorded on the proof page.",()=>plySVG(1,150),"Agreeing judges twist into one cord. A split stays apart and the money stays held."],
 ["Void","A completed close flow would settle commitments, void the rest at PayPal, then post release entries. The hosted close route is not wired. The sample lease shows the intended interaction without a PayPal call.",()=>cordSVG({items:[{id:1,c:120,st:"captured"},{id:2,c:75,st:"captured"},{id:3,c:250,st:"captured"},{id:4,c:300,st:"captured"}],cap:2000,C:745,A:0,F:0,vertical:false,voided:true,relA:0,relF:1255,animCut:false,label:"A cord cut after four captured calls."}),"The faded dashes illustrate a released length; this is fixture data."]
];
function howPaint(i){
  const [name,txt,vis,cap]=HOW[i];
  paintText($("#howbody"),`<h3>${name}</h3><p>${txt}</p>`,"h3,p");
  const illustration=$("#howvis"), previous=illustration.firstElementChild;
  if(illustration.dataset.tab!==String(i)){
    illustration.innerHTML=`${vis()}<p class="cap">${cap}</p>`;
    illustration.dataset.tab=i;
    if(previous){arrive(illustration.firstElementChild,200,.32);arrive($(".cap",illustration))}
  }
  document.querySelectorAll("#tabs button").forEach((b,j)=>{b.setAttribute("aria-selected",String(j===i));b.tabIndex=j===i?0:-1});
}
const faqTestTag=datedTag("computed","2026-11-11","· stubbed provider tests");
const FAQ=[
 ["Does my agent ever see my card?","No. Your agent gets a gateway token. The card stays with PayPal, and you approve the hold on PayPal's own page."],
 ["What if my agent tries to overspend?",`Both Run the agent and Check this amount refuse a price above the remaining cap. Run checks before committing the price or calling the provider. Check this amount only evaluates the price. ${faqTestTag}`],
 ["What happens when I void a lease?",`The kernel refuses further paid calls without a new commitment. A closed lease token also stops authorizing protected reads. The sample void is a browser simulation; the recorded PayPal void is on the proof page. ${faqTestTag}`],
 ["What happens after the honor period?","After the honor period, capture is best effort. Day-four reauthorization and capture behavior are unproven."],
 ["Why not just give my agent a virtual card?","Agent cards with limits are real and useful. Pashadhara is a sandbox pilot for agent authority bounded by a PayPal hold and an auditable kernel journal. Capture batching and judged escrow have recorded runs; hosted self-service and lease closing are unfinished."],
 ["What if PayPal does not answer?","PayPal timeout handling is unproven end to end."],
 ["Is this live?","The showcase can run real agent calls against a PayPal sandbox lease while demo capacity is available. When no showcase lease is configured, the showcase shows a dated recording. The sample lease uses fixture data. All PayPal activity uses sandbox funds.",`Run the agent uses the gateway path that checks and commits the call price. ${faqTestTag}`]
];
V.home=()=>`
<section class="hero2"><div class="wrap">
  <div class="herogrid"><div class="herocopy" style="grid-area:copy">
  <p class="eyebrow">Spending authority for AI agents, built on PayPal holds</p>
  <h1 class="h1d">Give your agent authority.<br><span class="h1-accent">Keep the boundary.</span></h1>
  <p class="lede2">Approve one PayPal sandbox hold. Your agent calls paid tools on its own. A deterministic kernel checks and reserves each price before execution, then commits it if the tool succeeds. The model cannot raise the limit.</p>
  <div class="ctas"><a class="btn fill" href="/delegation">Explore the $5,000 fixture</a><a class="tert" href="/lease?showcase=1">Inspect $2 sandbox pilot</a><a class="tert" href="/proof">See PayPal evidence</a></div>
  </div>
  <div class="deskcol"><a class="flag-preview" href="/delegation"><span class="eyebrow">Interactive business scenario · fixture</span><strong class="num">$2,235.00</strong><span>remaining of $5,000.00 after $2,765.00 in sample commitments</span><em>Test a request and inspect the journal ↗</em></a></div>
  <section class="holds" aria-labelledby="holds-h"><h2 class="holds-h" id="holds-h">How the limit holds</h2>
   <ol>
    <li><span>You approve one hold on PayPal. Nothing is charged yet.</span></li>
    <li><span>Your agent gets a gateway token. It never sees your card.</span></li>
    <li><span>Each paid call is priced and checked against the hold before it runs.</span></li>
    <li><span>Over the line: refused before any model is called. Nothing charged.</span></li>
    <li><span>Served calls are journaled as commitments. PayPal captures are separate. Inspect the <a href="/proof">recorded proof</a>.</span></li>
   </ol></section>
  </div>
</div></section>
<section class="home-live-desk sect"><div class="wrap"><div><p class="eyebrow">Separate sandbox pilot</p><h2 class="big2">The small sandbox lease.</h2><p>The sandbox pilot uses a $2 hold and a 3-cent paid tool. It is a narrow integration proof, shown separately from the $5,000 fixture scenario.</p></div>${deskHtml("home")}</div></section>

<section class="sect" id="how"><div class="wrap">
  <h2 class="big2">One hold. Five moves.</h2>
  <div class="how">
    <div><div class="tabs" id="tabs" role="tablist" aria-label="How it works">${HOW.map((h,i)=>`<button role="tab" id="tab${i}" aria-selected="${i===0}" tabindex="${i===0?0:-1}" data-act="how" data-i="${i}" aria-controls="howbody">${h[0]}</button>`).join("")}</div>
      <div class="body" id="howbody" style="margin-top:var(--s6)" role="tabpanel" aria-live="polite" aria-labelledby="tab0"></div></div>
    <div class="stage-v" id="howvis"></div>
  </div>
</div></section>

<section class="sect connect" id="connect"><div class="wrap">
  <div class="cn-copy">
    <h2 class="big2">An agent budget you can integrate.</h2>
    <p class="lede">Pashadhara exposes a Streamable HTTP MCP gateway. A lease token gives one agent access to one approved budget. The kernel prices and checks calls; successful calls become journal commitments. Captures at PayPal happen later.</p>
    <ol class="connect-steps"><li><strong>Provision</strong> an operator-created sandbox lease and have the buyer approve the PayPal hold.</li><li><strong>Connect</strong> the lease token to your MCP client with the configuration shown here.</li><li><strong>Verify</strong> available, committed and captured cents from the lease and journal reads. The public demo preview checks only the demo lease.</li></ol>
    <p class="help">The current paid tool is <span class="mono">summarise</span>, backed by Claude Haiku 5.5, priced at 3 cents per call. Lease creation requires an operator key; public self-service onboarding is not available. <a href="/quickstart">Developer quickstart and exact requests</a>.</p>
  </div>
  <pre class="rule snippet" tabindex="0" aria-label="MCP client configuration"><code>{
  "mcpServers": {
    "pashadhara": {
      "type": "http",
      "url": "https://pashadhara.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer &lt;lease token&gt;" }
    }
  }
}</code></pre>
</div></section>

<section class="limits sect" id="limits"><div class="wrap">
  <h2 class="big2">What it cannot promise, said plainly.</h2>
  <p class="lede">PayPal has no agent wallet. We build on an authorization hold, and a hold has limits we would rather you read here than discover later.</p>
  <div class="cols">
    <div><h3>The kernel and database enforce</h3><ul>
      <li><span>The kernel checks the remaining cap under the lease lock before a paid tool runs. The database rejects an invalid posting.</span></li>
      <li><span>Money is whole cents. A model never chooses an amount.</span></li>
      <li><span>For escrow, the stored buyer rubric determines a payout after the judges propose verdicts.</span><span class="tags"><a href="/proof">${tagHtml("recorded","recorded runs")}</a></span></li>
      <li><span>The database allows a release posting only after a succeeded PayPal void call. Hosted lease closing is not wired yet.</span></li></ul></div>
    <div><h3>PayPal decides</h3><ul>
      <li><span>A hold is honored for about 72 hours, then it is best effort.</span><span class="tags">${tagHtml("documented","from PayPal docs")}</span></li>
      <li><span>Day-four reauthorization is unproven.</span></li>
      <li><span>The gateway enforces its own cap. The PayPal overage boundary is unproven.</span></li>
      <li><span>A $1.00 sandbox payout reached SUCCESS 24 seconds after it was created.</span><span class="tags">${tagHtml("measured")}</span></li>
      <li><span>An authorization carries an expiry time 29 days after it was created.</span><span class="tags">${tagHtml("measured")}</span></li>
      <li><span>Capture after the honor period is unproven.</span></li>
      <li><span>PayPal timeout handling is unproven end to end.</span></li></ul></div>
  </div>
</div></section>

<section class="why sect" id="why"><div class="wrap">
  <h2 class="big2">Twelve $1.00 captures paid ${fmt(proofEvidence.fees.feeTotal)} in fees. One $12.00 capture would pay an estimated ${fmt(proofEvidence.fees.singleCaptureEstimate)}.</h2>
  <p class="lede">That is why capture batching matters. These numbers come from our own PayPal sandbox log; hosted lease settlement is not wired yet.</p>
  <div class="receipt">
    <div class="rrow"><span class="what">Fees on twelve $1.00 captures of one authorization</span><span class="val">${fmt(proofEvidence.fees.feeTotal)}</span><span class="tags">${tagHtml("measured")}</span></div>
    <div class="rrow"><span class="what">Fee on one $12.00 capture, from the same fee model</span><span class="val">${fmt(proofEvidence.fees.singleCaptureEstimate)}</span><span class="tags">${tagHtml("computed")}</span></div>
    <div class="rrow"><span class="what">Sandbox authorization used for the fee experiment</span><span class="val">${fmt(proofEvidence.fees.cap)}</span><span class="tags">${tagHtml("measured")}</span></div>
  </div>
  <a class="rawlink" href="/proof">See the recorded capture evidence</a>
</div></section>

<section class="sect" id="faq" style="padding-top:var(--s8)"><div class="wrap">
  <h2 class="big2">Questions worth asking first.</h2>
  <div class="faq">${FAQ.map(([q,a,test])=>`<details><summary>${q}</summary><p>${a}</p>${test?`<p>${test}</p>`:""}</details>`).join("")}</div>
</div></section>

<section class="close"><div class="wrap">
  <h2>Hand your agent a limit, not your card.</h2>
  <div class="ctas"><a class="btn fill" href="/lease?showcase=1">Open the live demo</a><a class="tert" href="/proof">See the PayPal proof</a></div>
  <p class="help" style="margin-top:var(--s5)">Sandbox only. No real money moves.</p>
</div></section>`;
V.quickstart=()=>`<div class="wrap quickstart"><p class="eyebrow">Developer integration · sandbox pilot</p><h1>One hold. One lease token. A bounded agent.</h1>
   <p class="lede">This path is for an operator provisioning an agent for a buyer. The signup flow is a simulation. In this build, lease creation requires an operator key. Keep it on your server; the agent receives only the lease token. Deploy this build and verify its contract before sending a provisioning request to a hosted API.</p>
  <ol class="qs-steps">
   <li><h2>Provision a sandbox lease</h2><p>POST <code>/api/v1/leases</code> with the operator bearer after this build is deployed. Amounts are integer USD cents. The response contains a lease token and a PayPal sandbox approval URL. Open the URL as the buyer.</p><button class="link-btn copy-code" data-act="copy-code">Copy request</button><pre class="snippet" tabindex="0"><code>curl -X POST "$PASHADHARA_API/v1/leases" \\
  -H "Authorization: Bearer &lt;operator key&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"buyer_ref":"my-agent","cap_minor":2000,"unsettled_limit_minor":1000}'</code></pre></li>
   <li><h2>Confirm the authorization</h2><p>The PayPal return callback attempts authorization. Read <code>/api/v1/leases/&lt;lease id&gt;</code> with the lease token and wait for <code>state: active</code> and <code>guaranteed_now: true</code>. An operator can call <code>POST /api/v1/leases/&lt;lease id&gt;/authorize</code> after buyer approval if the callback did not finish. Never infer success from the browser redirect alone.</p></li>
   <li><h2>Connect the agent</h2><p>Use the Streamable HTTP MCP endpoint at <code>/api/mcp</code>. The current paid tool is <code>summarise</code> at 3 cents, subject to the database tool price. Its input is <code>text</code> and <code>idempotency_key</code>. Make the key with a fresh UUID, a colon and SHA-256 of the tool name, a NUL byte and the exact UTF-8 text. Reuse the key only for the same invocation.</p><button class="link-btn copy-code" data-act="copy-code">Copy MCP settings</button><pre class="snippet" tabindex="0"><code>{
  "mcpServers": {
    "pashadhara": {
      "type": "http",
      "url": "https://pashadhara.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer &lt;lease token&gt;" }
    }
  }
}</code></pre></li>
   <li><h2>Read the boundary</h2><p>GET <code>/api/v1/leases/&lt;lease id&gt;</code> for <code>hold_available</code>, <code>committed_unsettled</code> and <code>total_captured</code>. GET its <code>/journal</code> for the immutable postings. A served tool commits its price; a later PayPal capture is a different event. A refused MCP tool result returns a structured reason. A missing bearer must return HTTP 401 on protected REST reads.</p></li>
   </ol><p class="help">Sandbox only. No production money path is offered. The public showcase has a separate lease and should not be used as an integration token. Several contract operations remain reserved and return 503. Due payout recovery uses an operator-only POST, never a read. <a href="/proof">Inspect recorded PayPal evidence</a> or <a href="/api/openapi.json">read the deployed API contract</a>.</p></div>`;
function initHome(){
  howPaint(0);
  void deskInit();
}

/* =============================================================
   The decision desk. One component, two places (home hero, lease page).
   Three realities, never blurred:
   live        a real sandbox hold read from /api/showcase; decisions come from our kernel (POST /api/showcase/try posts nothing)
   simulation  runs in this browser on a sample hold; no request leaves the page
   (recorded runs live on the proof page; a recorded or ended lease falls back to the simulation, with the reason said)
   Money is integer cents. A typed dollar amount is parsed with a regex and string split, never a float.
============================================================= */
const SIM_CAP=200, DK_MAX=6;
const DK={data:null,rows:[],spent:0,busy:false,wait:"",err:"",key:"",fresh:false,timer:null};
const whenUTC=iso=>new Date(iso).toUTCString().replace(/^(\w{3}), (\d+) (\w{3}) \d+ (\d\d:\d\d).*/,(m,a,d,mo,t)=>a+" "+Number(d)+" "+mo+", "+t+" UTC");
const shortId=id=>{id=String(id||"");return id.length>10?id.slice(0,4)+"\u2026"+id.slice(-4):id};
const hms=t=>{const d=new Date(t),p=n=>String(n).padStart(2,"0");return p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds())};
function parseCents(raw){
  const m=/^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(raw).trim());
  return m?Number(m[1])*100+Number((m[2]||"").padEnd(2,"0")):null;
}
const goodCents=v=>Number.isSafeInteger(v)&&v>=0;
function deskState(){
  const d=DK.data;
  if(!d)return {mode:"loading"};
  const b=d.lease?.balances, a=d.lease?.authorizations?.[0]||{};
  if(d.mode==="live"&&!d.ended&&b&&goodCents(d.lease.cap_minor)&&goodCents(Number(b.hold_available))&&goodCents(Number(b.committed_unsettled))&&goodCents(Number(b.total_captured))){
    return {mode:"live",id:d.lease.id,cap:d.lease.cap_minor,F:Number(b.hold_available),A:Number(b.committed_unsettled),C:Number(b.total_captured),pa:a.paypal_authorization_id,honor:a.honor_until,left:Number(d.remaining_calls??0),readAt:d.read_at};
  }
  const why=d.ended?`live spending closed ${a.honor_until?whenUTC(a.honor_until):""}`:d.unreachable||d.mode==="live"?"the gateway did not answer":"no live demo lease is configured";
  return {mode:"sim",cap:SIM_CAP,F:SIM_CAP-DK.spent,A:DK.spent,C:0,why,fixture:d.mode==="fixture",fixtureOn:d.fixture_on};
}
function deskLoadRows(key){
  let j=null; try{j=JSON.parse(sessionStorage.getItem(key)||"null")}catch{}
  DK.rows=Array.isArray(j?.rows)?j.rows.filter(r=>r&&Number.isSafeInteger(r.t)&&typeof r.text==="string"&&["allowed","refused","none","unknown"].includes(r.v)).slice(0,DK_MAX):[];
  DK.spent=key==="desk:sim"&&Number.isSafeInteger(j?.spent)&&j.spent>=0&&j.spent<=SIM_CAP?j.spent:0;
}
function deskSave(){try{sessionStorage.setItem(DK.key,JSON.stringify({rows:DK.rows,spent:DK.spent}))}catch{}}
function deskPush(row){DK.rows.unshift({t:Date.now(),...row});DK.rows.length=Math.min(DK.rows.length,DK_MAX);DK.fresh=true;deskSave()}
function deskHtml(ctx){
  return `<div class="dk" data-desk="${ctx}">
   <div class="dk-band" data-dk="band"></div>
   <div class="dk-bal" data-dk="bal"></div>
   <div class="dk-ask" data-dk="ask"><h3 class="dk-h" id="dk-h-${ctx}">Your agent asks to spend</h3>
    <div class="dk-presets" data-dk="presets" role="group" aria-labelledby="dk-h-${ctx}"></div>
    <form class="dk-form" data-form="desk" novalidate><label class="dk-lab" for="dk-amt">Another amount</label>
     <div class="dk-fr"><span class="dk-in"><span class="dk-cur" aria-hidden="true">$</span><input id="dk-amt" type="text" inputmode="decimal" autocomplete="off" aria-describedby="dk-err" placeholder="0.05"></span>
     <button class="btn accent dk-go" type="submit">Check this amount</button></div>
     <p class="dk-err errtxt" id="dk-err" data-dk="err" role="alert"></p></form></div>
   <div class="dk-dec"><ol class="dk-list" data-dk="list" aria-live="polite" aria-label="Decisions, newest first"></ol><p class="dk-reset" data-dk="reset"></p></div>
   <p class="dk-cap help" data-dk="cap"></p></div>`;
}
function deskRowHtml(r,seen){
  let g="";
  if(r.tag){const k=r.tag+"|"+r.label; g=seen.has(k)?`<span class="dk-gl">${esc(r.label)}</span>`:tagHtml(r.tag,r.label); seen.add(k)}
  const word=r.v==="allowed"?"Allowed":r.v==="refused"?"Refused":r.v==="unknown"?"Unknown":"Not checked";
  return `<li class="dk-r is-${r.v}"><span class="dk-t num">${hms(r.t)}</span><span class="dk-a">${r.ask==null?"Agent call":`Asked <span class="num">${fmt(r.ask)}</span>`}</span><b class="dk-v">${word}</b><span class="dk-s">${esc(r.text)}</span>${r.quote?`<q class="dk-quote">${esc(String(r.quote).slice(0,400))}</q>`:""}${g?`<span class="dk-g">${g}</span>`:""}</li>`;
}
function paintDesk(){
  const root=document.querySelector("[data-desk]"); if(!root)return;
  const st=deskState();
  const q=k=>root.querySelector(`[data-dk="${k}"]`);
  const set=(el,html)=>{if(el&&el.innerHTML!==html)el.innerHTML=html};
  const loading=st.mode==="loading";
  root.dataset.mode=st.mode;
  q("ask").inert=loading; q("list").parentElement.inert=loading;
  if(loading){
    set(q("band"),`<span class="sk" style="width:15rem"></span>`);
    set(q("bal"),`<span class="sk" style="width:9rem;height:3rem"></span><span class="sk" style="width:100%;height:16px;margin-top:12px"></span>`);
    set(q("presets"),""); set(q("list"),""); set(q("reset"),""); set(q("cap"),"");
    return;
  }
  const key=st.mode==="live"?"desk:"+st.id:"desk:sim";
  if(key!==DK.key){DK.key=key;deskLoadRows(key)}
  const live=st.mode==="live", ctx=root.dataset.desk, F=st.F;
  set(q("band"),live
    ?`<span class="dk-line"><span class="dk-dot live" aria-hidden="true"></span><strong class="dk-mode">LIVE PAYPAL SANDBOX</strong></span><span class="dk-sub"><span class="nb">${st.pa?`hold <span class="num">${esc(shortId(st.pa))}</span>`:"hold"}${st.honor?",":""}</span>${st.honor?` <span class="nb">honored until <span class="num">${esc(whenUTC(st.honor))}</span></span>`:""}. Kernel journal read ${esc(whenUTC(st.readAt))}; this is not a fresh PayPal GET.</span>`
    :`${st.fixture?`<span class="dk-line"><span class="dk-dot sim" aria-hidden="true"></span><strong class="dk-mode">SAVED DEMO FIXTURE</strong></span><span class="dk-sub">Sample snapshot from ${esc(st.fixtureOn)}. Raw source unavailable; no current balance or live check. ${esc(st.why)}.</span>`:""}<span class="dk-line"><span class="dk-dot sim" aria-hidden="true"></span><strong class="dk-mode">INTERACTIVE SIMULATION</strong></span><span class="dk-sub">Separate sample <span class="num">${fmt(SIM_CAP)}</span> budget in this browser. Nothing reaches PayPal.${st.fixture?"":` ${esc(st.why)}.`}</span>`);
  set(q("bal"),ctx==="lease"&&live?"":`<div class="dk-free"><span class="num dk-big">${fmt(F)}</span><span class="dk-unit">free to spend</span></div>
    <p class="dk-of">of <span class="num">${fmt(st.cap)}</span> held. ${live?`<span class="num">${fmt(st.C)}</span> captured, <span class="num">${fmt(st.A)}</span> owed.`:`<span class="num">${fmt(st.A)}</span> spent in the simulation.`}</p>
    <div class="dk-bar" aria-hidden="true">${slimSVG({C:st.C,A:st.A,F:st.F,cap:st.cap})}</div>`);
  const off=DK.busy?' aria-disabled="true"':"";
  const half=Math.floor(F/2), pre=[{c:3,l:"one tool call"}];
  if(half>=1&&half!==3&&half!==F+1)pre.push({c:half,l:"about half"});
  const over=F+1; const dup=pre.findIndex(p=>p.c===over); if(dup>=0)pre.splice(dup,1);
  pre.push({c:over,l:"one cent over",p:1});
  const focusI=document.activeElement?.closest?.('[data-dk="presets"]')?document.activeElement.dataset.i:null;
  set(q("presets"),pre.map((p,i)=>`<button type="button" class="dk-pre${p.p?" primary":""}" data-act="desk-ask" data-c="${p.c}" data-i="${i}"${off}><span class="num dk-pv">${fmt(p.c)}</span><span class="dk-pc">${p.l}</span></button>`).join(""));
  if(focusI!==null&&document.activeElement===document.body)q("presets").querySelector(`[data-i="${focusI}"]`)?.focus({preventScroll:true});
  const gobtn=root.querySelector(".dk-go"); if(gobtn)DK.busy?gobtn.setAttribute("aria-disabled","true"):gobtn.removeAttribute("aria-disabled");
  const inp=root.querySelector("#dk-amt");
  if(inp){DK.err?inp.setAttribute("aria-invalid","true"):inp.removeAttribute("aria-invalid")}
  set(q("err"),esc(DK.err));
  const seen=new Set();
  const rows=DK.rows.map((r,i)=>{const h=deskRowHtml(r,seen);return i===0&&DK.fresh?h.replace('class="dk-r ','class="dk-r fresh '):h}).join("");
  set(q("list"),(DK.busy?`<li class="dk-wait">${esc(DK.wait)}</li>`:"")+(rows||(DK.busy?"":`<li class="dk-empty">Pick an amount. The answer comes from the same check that guards the hold.</li>`)));
  DK.fresh=false;
  set(q("reset"),!live&&DK.spent>0?`<button type="button" class="link-btn" data-act="desk-reset">Reset the sample hold</button>`:"");
  set(q("cap"),live
    ?(ctx==="home"?`These checks run the real kernel against the live hold and post nothing. To make a real paid call, <a href="/lease?showcase=1">open the live demo</a>.`:`These checks run the real kernel against the live hold and post nothing. To make a real paid call, use Run the agent.`)
    :`This runs in your browser on sample figures. The <a href="/proof">PayPal evidence</a> is read only.`);
}
function deskRowFrom(run,c,status,j){
  const none=text=>({ask:run?null:c,v:"none",text});
  /* A paid run that did not come back cleanly may have reached the gateway. Unknown beats guess. */
  const unknown=()=>({ask:null,v:"unknown",text:"The request did not return. The outcome is unknown. The journal below is the record: reload it to see whether a call was charged."});
  if(!j||typeof j!=="object")return run?unknown():none("The check could not be completed. Nothing was charged.");
  const price=Number.isSafeInteger(j.price_minor)?j.price_minor:c, rem=j.remaining_minor;
  if(j.reason){
    const tag={tag:"computed",label:run?"live journal":"kernel preview, nothing posted"};
    if(j.reason==="window_ended")return {ask:price,v:"refused",text:"The hold's honor period has ended. Nothing charged.",...tag};
    if(j.reason==="cap_reached"&&goodCents(rem)&&goodCents(price))return {ask:price,v:"refused",text:`${fmt(price-rem)} over the ${fmt(rem)} free. ${run?"No model was called":"No model would be called"}. Nothing charged.`,...tag};
    return {ask:price,v:"refused",text:`Refused by the kernel (${String(j.reason).slice(0,40)}). Nothing charged.`,...tag};
  }
  if(j.error==="demo_limit")return none("The demo call limit is reached for today. Nothing was charged.");
  if(j.error==="tool_failed")return j.charged===false||!run?none("The model call failed. Nothing was charged."):unknown();
  if(j.error==="busy")return j.charged===false||!run?none("The gateway was busy. Nothing was charged. Try again."):unknown();
  if(status!==200||j.error||!goodCents(rem))return run?unknown():none("The check could not be completed. Nothing was charged.");
  if(!run&&c>rem)return none("The kernel response did not include a refusal for an amount above the available balance. No decision is shown; nothing was posted.");
  if(run){
    const quote=typeof j.result?.summary==="string"?j.result.summary:"";
    return {ask:price,v:"allowed",text:`Ran summarise. Committed ${fmt(price)} to the journal. ${fmt(rem)} remains available. PayPal capture is separate.`,quote,tag:"computed",label:"kernel journal"};
  }
  return {ask:c,v:"allowed",text:`Within the ${fmt(rem)} free. A real call at this price would leave ${fmt(rem-c)}.`,tag:"computed",label:"kernel preview, nothing posted"};
}
/* One call path for the live desk: "try" is the non-posting kernel preview, "run" is the real paid agent call. */
async function showcaseAction(action,c){
  if(DK.busy)return;
  const st=deskState(); if(st.mode!=="live")return;
  const run=action==="run";
  DK.busy=true; DK.wait=run?"Running the agent against the live hold.":"Asking the kernel."; DK.err=""; paintDesk(); syncRunButton();
  let row, dropped=false;
  try{
    const response=await fetch("/api/showcase/"+action+(run?"":"?price_minor="+encodeURIComponent(c)),{method:"POST",headers:{"Content-Type":"application/json"}});
    let j=null; try{j=await response.json()}catch{}
    row=deskRowFrom(run,c,response.status,j);
    if(row.v==="refused"&&$("#cord")){const wait=refuseFx($("#cord"),true);if(wait)await new Promise(r=>later(r,wait))}
    dropped=run&&row.v==="allowed";
  }catch{
    row=deskRowFrom(run,c,0,null);
  }
  deskPush(row);
  if(run){try{await liveLoad()}catch{}}
  DK.busy=false;
  if(current==="lease"&&S.user?.showcase)paintLease(dropped?{dropId:S.calls.length}:{});
  else paintDesk();
  syncRunButton();
}
function syncRunButton(){
  const b=document.querySelector('[data-act="showcase-run"]'); if(!b)return;
  b.disabled=!!DK.busy||!(S.showcase?.remaining_calls>0);
}
function deskSim(c){
  const F=SIM_CAP-DK.spent;
  if(c<=F){DK.spent+=c; deskPush({ask:c,v:"allowed",text:`Committed ${fmt(c)} in the simulation. ${fmt(F-c)} left.`,tag:"fixture",label:"simulation"})}
  else deskPush({ask:c,v:"refused",text:`${fmt(c-F)} over the ${fmt(F)} left. Refused before any model call. Nothing charged.`,tag:"fixture",label:"simulation"});
  paintDesk();
}
function deskAsk(c){
  if(DK.busy||!Number.isSafeInteger(c)||c<1)return;
  const st=deskState(); if(st.mode==="loading")return;
  DK.err="";
  if(st.mode==="sim")deskSim(c); else void showcaseAction("try",c);
}
function deskSubmit(){
  const inp=document.querySelector("#dk-amt"); if(!inp||DK.busy)return;
  const c=parseCents(inp.value);
  if(c===null||c<1){
    DK.err=c===0?"Enter an amount above $0.00.":"Enter dollars and cents, like 0.05. Two decimals at most, and seven digits before the point.";
    paintDesk(); inp.focus(); return;
  }
  DK.err=""; inp.value=""; deskAsk(c);
}
function deskReset(){DK.spent=0;DK.rows=[];deskSave();paintDesk()}
async function deskInit(){
  paintDesk();
  let data=await loadShowcase();
  /* A cold gateway can miss the first read. Ask once more, still showing the skeleton,
     before settling on the simulation. */
  if(data.unreachable){
    DK.data=null; paintDesk();
    await new Promise(r=>setTimeout(r,2000));
    if(route()!=="home"||!document.querySelector("[data-desk]"))return;
    data=await loadShowcase();
  }
  if(route()!=="home"||!document.querySelector("[data-desk]"))return;
  paintDesk();
  deskSchedule();
}
function deskSchedule(){
  clearTimeout(DK.timer);
  DK.timer=later(async()=>{
    if(ac.signal.aborted||route()!=="home")return;
    await loadShowcase();
    if(ac.signal.aborted||route()!=="home")return;
    paintDesk();
    deskSchedule();
  },10000);
}

/* ---------- sign up and log in ---------- */
 const SU_TITLES=["","Sample account","Fixture code","Sample PayPal connection","Set sample rules","Simulate approval","Preview agent settings"];
V.flow=()=>`${simBand("onboarding prototype. No account is created and nothing reaches PayPal.")}<div class="flow"><aside class="flow-side" id="fs"></aside><section class="flow-main" id="fm" tabindex="-1"></section></div>`;
const MCP_URL="https://pashadhara.vercel.app/api/mcp";
const MASK="pd_fake_••••••••••••••••";
const TOKEN="pd_fake_not_a_real_token";
function paintFlow(focus){
  const s=S.su, login=s.mode==="login";
  const side=$("#fs"), fm=$("#fm"); if(!side)return;
  renderChrome("flow","");setGround();
  let sideH="",mainH="";
  const vc=o=>`<div class="vc" aria-hidden="true">${cordSVG(Object.assign({vertical:true,interactive:false,settle:false,label:""},o))}</div>`;
  const sampleItems=[{id:1,c:120,st:"captured"},{id:2,c:75,st:"captured"},{id:3,c:250,st:"captured"},{id:4,c:300,st:"captured"},{id:5,c:40,st:"accrued"},{id:6,c:115,st:"accrued"}];
  const preview=()=>s.step===1?vc({items:sampleItems,cap:2000,C:745,A:155,F:1100}):(s.step<=3?vc({items:[],cap:2000,C:0,A:0,F:0,ghost:true}):vc({items:[],cap:20000,C:0,A:0,F:s.cap}));
  if(s.step===1){
     sideH=`<div><h2>${login?"Try the return path.":"One approval. A budget your agent cannot break."}</h2><p>Walk through a sample account flow. No email is sent and no account is created.</p></div>${preview(745,190,1065,2000)}`;
     mainH=`<h1>${login?"Simulate login":"Try account setup"}</h1><p class="sub">Use any sample email. The next screen shows a visible fixture code.</p>
     <form data-form="su1" novalidate><div class="fgrid">
      ${login?"":`<div class="f"><label for="suName">Your name</label><input id="suName" type="text" autocomplete="name" value="${esc(s.name)}" ${s.err.name?'aria-invalid="true" aria-describedby="suNameE"':""}>${s.err.name?`<div class="errtxt" id="suNameE">${s.err.name}</div>`:""}</div>`}
       <div class="f"><label for="suEmail">Sample email</label><input id="suEmail" type="email" inputmode="email" autocomplete="email" value="${esc(s.email)}" ${s.err.email?'aria-invalid="true" aria-describedby="suEmailE"':""}>${s.err.email?`<div class="errtxt" id="suEmailE">${s.err.email}</div>`:`<div class="hint">Stored only in this browser for the simulation.</div>`}</div></div>
       <div class="actions"><button class="btn fill" type="submit">Continue to sample code</button></div></form>
     <p class="swap">${login?`New here? <a href="/signup">Create an account</a>`:`Already have an account? <a href="/login">Log in</a>`}</p>
     <p class="help" style="margin-top:var(--s5)">${tagHtml("fixture")} Prototype: no email is sent and no account is stored.</p>`;
  }else if(s.step===2){
     sideH=`<div><h2>Try a sample code.</h2><p>No email was sent to <strong>${esc(s.email)}</strong>. Enter the fixture code shown here.</p></div>${preview(0,0,2000,2000)}`;
    mainH=`<h1>Enter the code</h1><p class="sub">Type or paste all six digits. We check them as soon as you finish.</p>
     <div class="fm-body"><div class="f"><div class="lab" id="clab">Six digit code</div>
      <div class="cboxes ${s.codeErr?"bad":""}" id="cboxes" role="group" aria-labelledby="clab">${[0,1,2,3,4,5].map(i=>`<input inputmode="numeric" pattern="[0-9]*" autocomplete="${i?"off":"one-time-code"}" aria-label="Digit ${i+1}" data-ci="${i}">`).join("")}</div>
      ${s.codeErr?`<div class="errtxt" role="alert">${s.codeErr}</div>`:`<div class="hint">${tagHtml("fixture")} Prototype code: <span class="mono">123456</span></div>`}</div>
       <div class="actions"><button class="btn" data-act="su-back">Change sample email</button><button class="btn" data-act="su-resend" id="resend" ${s.resend>0?'aria-disabled="true"':""}>${s.resend>0?`Reset fixture code in ${s.resend}s`:"Reset fixture code"}</button></div></div>`;
  }else if(s.step===3){
    const p=s.paypal;
     sideH=`<div><h2>Your card never comes near us.</h2><p>A real buyer would approve a PayPal sandbox hold on PayPal's page. This step only simulates that connection.</p></div>${preview(0,0,2000,2000)}`;
     mainH=`<h1>Simulate PayPal connection</h1><p class="sub">This prototype does not link an account or create a hold.</p>
     <div class="fm-body">
       ${p==="done"?`<div class="linked"><strong>Sample buyer connection</strong><br><span class="help">Fixture account ending 4821 ${tagHtml("fixture")}</span></div>
        <div class="actions"><button class="btn fill" data-act="su-next">Continue</button><button class="btn" data-act="su-paypal-reset">Use another account</button></div>`
       :`${p==="declined"?`<p class="err" role="alert" style="margin-bottom:var(--s4)">The simulated connection was cancelled. Nothing was linked or held.</p>`:""}
         <div class="actions" style="margin-top:0"><button class="btn fill" data-act="su-paypal" id="ppGo" ${p==="busy"?'aria-busy="true" aria-disabled="true"':""} style="min-width:15rem">${p==="busy"?"Simulating connection":"Simulate connection"}</button><button class="btn" data-act="su-paypal-no" ${p==="busy"?'aria-disabled="true"':""}>Simulate cancel</button></div>
        <p class="help" style="margin-top:var(--s4)">${tagHtml("fixture")} This opens no real PayPal page in the prototype.</p>`}
      <p class="swap"><button class="link-btn" data-act="su-back">Back</button></p></div>`;
  }else if(s.step===4){
    const per=Math.min(s.per,s.cap);
    sideH=`<div><h2>Rules the model cannot argue with.</h2><p>The gateway checks these on every call. They are not left to the model.</p></div>${preview(0,0,s.cap,s.cap)}`;
     mainH=`<h1>Set sample rules</h1><p class="sub">Pick a total budget and the most one call may cost. The sample lease can be voided in this browser.</p>
     <div class="fm-body"><div class="fgrid">
      <div class="f"><div class="lab" id="capL">Total budget</div><div class="chips" role="group" aria-labelledby="capL">${[1000,2000,5000,10000].map(v=>`<button data-act="su-cap" data-v="${v}" aria-pressed="${s.cap===v&&!s.customCap}">${fmt(v)}</button>`).join("")}</div>
        <div style="margin-top:var(--s3);max-width:12rem"><label class="lab" for="capC" style="font-weight:500">Or type dollars</label><input id="capC" type="text" inputmode="numeric" autocomplete="off" value="${esc(s.customCap)}" placeholder="5 to 200" ${s.err.cap?'aria-invalid="true" aria-describedby="capE"':""}>${s.err.cap?`<div class="errtxt" id="capE">${s.err.cap}</div>`:""}</div></div>
      <div class="f"><div class="lab" id="perL">Most one call may cost</div><div class="chips" role="group" aria-labelledby="perL">${[100,500,1000].map(v=>`<button data-act="su-per" data-v="${v}" aria-pressed="${s.per===v}" ${v>s.cap?'aria-disabled="true"':""}>${fmt(v)}</button>`).join("")}</div></div>
      <div class="f"><div class="lab" id="catL">What it may buy</div><div class="chips" role="group" aria-labelledby="catL">${CATS.map(c=>`<button data-act="su-cat" data-v="${esc(c)}" aria-pressed="${s.cats.includes(c)}">${c}</button>`).join("")}</div>${s.err.cats?`<div class="errtxt">${s.err.cats}</div>`:`<div class="hint">Choose at least one. Anything else is refused.</div>`}</div>
      <div class="f"><div class="lab">Honor period</div><p>72 hours, set by PayPal ${tagHtml("documented","from PayPal docs")}. After that the hold is best effort.</p></div></div>
      <div class="mandate"><p>Your agent may spend up to <strong class="num">${fmt(s.cap)}</strong> in total, never more than <strong class="num">${fmt(per)}</strong> in one call, on ${s.cats.length} kind${s.cats.length===1?"":"s"} of tool.</p></div>
      <div class="actions"><button class="btn fill" data-act="su-rules">Review and approve</button><button class="btn" data-act="su-back">Back</button></div></div>`;
  }else if(s.step===5){
    const a=s.approve, per=Math.min(s.per,s.cap);
    sideH=`<div><h2>One hold. That is the whole budget.</h2><p>In this sample, a PayPal hold of ${fmt(s.cap)} would bound the agent. Nothing is held here. Only captured calls become a PayPal charge. Hosted lease closing is not wired yet.</p></div>${preview(0,0,s.cap,s.cap)}`;
     mainH=`<h1>Simulate approval</h1><p class="sub">Review the sample authority before opening its lease.</p>
     <div class="fm-body"><dl class="summ"><dt>Hold</dt><dd class="num">${fmt(s.cap)}</dd><dt>One call, at most</dt><dd class="num">${fmt(per)}</dd><dt>May buy</dt><dd>${esc(s.cats.join(", "))}</dd><dt>Honored for</dt><dd>72 hours, then best effort</dd><dt>Charged today</dt><dd class="num">$0.00</dd></dl>
       ${a==="declined"?`<p class="err" role="alert" style="margin-top:var(--s5)">The simulated approval was declined. Nothing was held or charged.</p>`:""}
      <p class="notice" role="note">${tagHtml("fixture")} The approval is simulated and makes no PayPal call.</p>
       <div class="actions"><button class="btn accent" data-act="su-approve" id="apGo" ${a==="busy"?'aria-busy="true" aria-disabled="true"':""} style="min-width:15.5rem">${a==="busy"?"Simulating approval":`Simulate ${fmt(s.cap)} approval`}</button><button class="btn" data-act="su-approve-no" ${a==="busy"?'aria-disabled="true"':""}>Simulate decline</button></div>
      <p class="swap"><button class="link-btn" data-act="su-back">Back to the rules</button></p></div>`;
  }else{
    const t=s.test;
     sideH=`<div><h2>Give it the key, not the card.</h2><p>A real agent would receive a lease-scoped token. This screen uses a fake token and sends no paid calls.</p></div>${preview(0,0,s.cap,s.cap)}`;
     mainH=`<h1>Preview agent settings</h1><p class="sub">This shows the shape of MCP settings. The token below is fake and cannot authorize a tool.</p>
     <div class="fm-body"><pre class="snip" tabindex="0" aria-label="Agent connection settings">{
  "mcpServers": {
    "pashadhara": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer ${s.reveal?TOKEN:MASK}" }
    }
  }
}</pre>
      <div class="actions" style="margin-top:var(--s3)"><button class="btn" data-act="su-reveal" aria-pressed="${s.reveal}">${s.reveal?"Hide token":"Reveal token"}</button><button class="btn" data-act="su-copy">${s.copied?"Copied":"Copy settings"}</button></div>
      <p class="help" style="margin-top:var(--s3)">${tagHtml("fixture")} This address and token are placeholders. Treat a real token like a password.</p>
       <div style="margin-top:var(--s6)"><button class="btn" data-act="su-test" ${t==="busy"?'aria-busy="true" aria-disabled="true"':""}>${t==="busy"?"Simulating":"Simulate a test call"}</button>
       ${t==="ok"?`<div class="testres" role="status"><strong>Simulated answer.</strong> This prototype made no call. Nothing spent, $0.00 captured ${tagHtml("fixture")}</div>`:""}</div>
       <div class="actions"><button class="btn fill" data-act="su-finish">Open sample lease</button><button class="btn" data-act="su-back">Back</button></div></div>`;
  }
  const moved=fm.dataset.step&&fm.dataset.step!==String(s.step);
  const oldFree=$('.vc [data-part="free"]',side);
  paintText(side,sideH,"h2,p");
  if(moved)arrive($(".vc svg",side),210,.32);
  else if(oldFree&&s.step===4){
    const free=$('.vc [data-part="free"]',side);
    if(oldFree.dataset.w!==free.dataset.w){
      const scale=Number(oldFree.dataset.w)/Number(free.dataset.w);
      const offset=Number(free.dataset.x)*(1-scale);
      motion(free,[{transform:`translateX(${offset}px) scaleX(${scale})`},{transform:"none"}],220);
    }
  }
  paintText(fm,mainH,"h1,.sub,.lab,.f label,.btn,.err,.errtxt,.linked,.mandate p,.testres strong,.summ dd");
  fm.dataset.step=s.step;
  document.title=(login?"Log in":SU_TITLES[s.step])+" | Pashadhara";
  if(focus==="h1"){fm.focus({preventScroll:true})}
  else if(focus){const el=$(focus);el&&el.focus()}
  if(s.step===2){const b=$("#cboxes input");if(b&&focus==="h1")later(()=>b.focus(),30)}
}
let resendTimer=null;
function startResend(){clearInterval(resendTimer);S.su.resend=20;resendTimer=setInterval(()=>{if(S.su.resend>0)S.su.resend--;const b=$("#resend");if(b){if(S.su.resend>0){b.setAttribute("aria-disabled","true");b.textContent=`Send a new code in ${S.su.resend}s`}else{b.removeAttribute("aria-disabled");b.textContent="Send a new code"}}if(S.su.resend<=0)clearInterval(resendTimer)},1000)}
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function suGo(step){S.su.step=step;S.su.err={};S.su.codeErr="";paintFlow("h1");window.scrollTo(0,0)}
function verifyCode(){
  const vals=[...document.querySelectorAll("#cboxes input")].map(i=>i.value).join("");
  if(vals.length<6)return;
  if(vals==="123456"){
    S.su.codeErr="";
    if(S.su.mode==="login"){const n=S.su.email.split("@")[0].replace(/[._-]+/g," ");S.user={name:n.replace(/\b\w/g,c=>c.toUpperCase()),email:S.su.email};resetSample();go("/lease");say("Logged in.")}
    else suGo(3);
  }else{S.su.codeErr="That code does not match. Check the newest email, or send a new code.";paintFlow();const f=$("#cboxes input");f&&f.focus()}
}
function siteClick(e){
  const el=e.target.closest("[data-scroll],[data-act]"); if(!el)return false;
  const sc=el.dataset.scroll;
  if(sc){e.preventDefault();const t=document.getElementById(sc);if(!t){go("/#"+sc);return true}if(t){if(t.tagName==="DETAILS")t.open=true;t.scrollIntoView({behavior:reduced()?"auto":"smooth",block:"start"});history.replaceState(null,"","/#"+sc)}return true}
  const a=el.dataset.act, s=S.su;
  if(el.getAttribute("aria-disabled")==="true"&&a!=="how"){e.preventDefault();return true}
  switch(a){
    case "showcase-run": e.preventDefault(); if(!el.disabled)void showcaseAction("run"); return true;
    case "desk-ask": e.preventDefault(); deskAsk(+el.dataset.c); return true;
    case "desk-reset": e.preventDefault(); deskReset(); return true;
    case "copy-code": {const code=el.nextElementSibling?.querySelector("code")?.textContent;if(!code)return true;
      if(!navigator.clipboard){say("Clipboard unavailable. Select the code to copy it.");return true}
      navigator.clipboard.writeText(code).then(()=>{el.textContent="Copied";say("Code copied.");later(()=>{if(el.isConnected)el.textContent=code.startsWith("curl")?"Copy request":"Copy MCP settings"},2500)},()=>say("Clipboard unavailable. Select the code to copy it."));return true}
    case "sample": case "sample-proof": e.preventDefault(); store.del(LIVE_KEY); resetSample(); S.user={name:"Sample",sample:true}; go(a==="sample"?"/lease":"/proof"); return true;
    case "sound": {const on=!soundOn();try{localStorage.setItem(SOUND_KEY,on?"on":"off")}catch(e){}syncSound();if(on){audio();sfx("drop")}return true}
    case "theme": {document.body.classList.add("instant");later(()=>document.body.classList.remove("instant"),80);const d=!darkView();try{localStorage.setItem(THEME_KEY,d?"dark":"light")}catch(e){}el.setAttribute("aria-pressed",String(d));el.textContent=d?"Light view":"Dark view";setGround();return true}
    case "signout": stopRun(); store.del(LIVE_KEY); S.user=null; S.su=suFresh("signup"); go("/",true); say("Signed out."); return true;
    case "read-cord": S.ui.hint=!S.ui.hint; paintReadout(); return true;
    case "how": howPaint(+el.dataset.i); el.focus(); return true;
    case "su-back": if(s.paypal==="busy"||s.approve==="busy")return true; if(s.step===2){clearInterval(resendTimer)} suGo(s.mode==="login"?1:Math.max(1,s.step-1)); return true;
    case "su-resend": startResend(); say("Fixture code reset. No email was sent."); paintFlow("#resend"); return true;
    case "su-next": suGo(s.step+1); return true;
    case "su-paypal": if(s.paypal==="busy")return true; s.paypal="busy"; paintFlow("#ppGo"); later(()=>{if(S.su.paypal!=="busy"||current!=="flow")return;S.su.paypal="done";paintFlow("h1");say("Sample connection ready. No PayPal account was linked.")},1200); return true;
    case "su-paypal-no": if(s.paypal==="busy")return true; s.paypal="declined"; paintFlow("#ppGo"); return true;
    case "su-paypal-reset": s.paypal="idle"; paintFlow("#ppGo"); return true;
    case "su-cap": s.cap=+el.dataset.v; s.customCap=""; s.err.cap=""; if(s.per>s.cap)s.per=Math.min(500,s.cap); paintFlow(`[data-act="su-cap"][data-v="${el.dataset.v}"]`); return true;
    case "su-per": s.per=+el.dataset.v; paintFlow(`[data-act="su-per"][data-v="${el.dataset.v}"]`); return true;
    case "su-cat": {const c=el.dataset.v;s.cats=s.cats.includes(c)?s.cats.filter(x=>x!==c):[...s.cats,c];s.err.cats="";paintFlow(`[data-act="su-cat"][data-v="${c}"]`);return true}
    case "su-rules": {
      s.err={};
      if(s.customCap){const n=Number(s.customCap);if(!Number.isInteger(n)||n<5||n>200){s.err.cap="Type a whole number of dollars from 5 to 200, or pick one above.";paintFlow("#capC");return true}s.cap=n*100;if(s.per>s.cap)s.per=Math.min(500,s.cap)}
      if(!s.cats.length){s.err.cats="Choose at least one kind of tool, or the agent could buy nothing.";paintFlow();return true}
      suGo(5); return true;}
    case "su-approve": if(s.approve==="busy")return true; s.approve="busy"; paintFlow("#apGo"); later(()=>{if(S.su.approve!=="busy"||current!=="flow")return;S.su.approve="done";suGo(6);say("Sample approval complete. No PayPal hold was created.");approveFx($("#fs .vc"))},1200); return true;
    case "su-approve-no": if(s.approve==="busy")return true; s.approve="declined"; paintFlow("#apGo"); return true;
    case "su-reveal": s.reveal=!s.reveal; paintFlow('[data-act="su-reveal"]'); return true;
    case "su-copy": {const txt=`{\n  "mcpServers": {\n    "pashadhara": {\n      "type": "http",\n      "url": "${MCP_URL}",\n      "headers": { "Authorization": "Bearer ${TOKEN}" }\n    }\n  }\n}`;
      (navigator.clipboard?navigator.clipboard.writeText(txt):Promise.reject()).then(()=>{s.copied=true;paintFlow('[data-act="su-copy"]');say("Fixture settings copied.");later(()=>{S.su.copied=false;if(current==="flow"&&S.su.step===6)paintFlow()},2500)},()=>say("Clipboard unavailable. Select the settings to copy them.")); return true}
    case "su-test": if(s.test==="busy")return true; s.test="busy"; paintFlow('[data-act="su-test"]'); later(()=>{if(S.su.test!=="busy"||current!=="flow")return;S.su.test="ok";paintFlow('[data-act="su-test"]');say("Simulated answer ready. No gateway call was made.")},900); return true;
    case "su-finish": {
      CAP=s.cap; S.user={name:s.name||"You",email:s.email,sample:true}; S.status="active"; S.calls=[]; S.q=0; S.nextId=1; S.clock=9*60; S.log=[]; S.refused=0; S.settles=[]; S.voided=null;
      S.rules={per:Math.min(s.per,s.cap),cats:[...s.cats]}; S.ui.sel=null;  S.ui.settleDone=null; S.ui.settleN=null; S.ui.voidOpen=false; stopRun();
      go("/lease"); say("Sample lease is open. No PayPal hold exists."); return true;}
  }
  return false;
}
on(document,"submit",e=>{
  const f=e.target.closest("form[data-form]"); if(!f)return; e.preventDefault();
  if(f.dataset.form==="desk"){deskSubmit();return}
  if(f.dataset.form==="su1"){
    const s=S.su, login=s.mode==="login"; s.err={};
    s.name=($("#suName")?.value||"").trim(); s.email=($("#suEmail")?.value||"").trim();
    if(!login&&!s.name)s.err.name="Tell us what to call you. A first name is enough.";
    if(!EMAIL_RE.test(s.email))s.err.email=s.email?"That email looks incomplete. It should look like name@example.com.":"Enter the email we should send the code to.";
    if(s.err.name||s.err.email){paintFlow(s.err.name?"#suName":"#suEmail");return}
    startResend(); suGo(2);
  }
});
on(document,"input",e=>{
  const t=e.target;
  if(t.dataset&&t.dataset.ci!==undefined){
    const i=+t.dataset.ci, all=[...document.querySelectorAll("#cboxes input")], dg=t.value.replace(/\D/g,"");
    if(dg.length>1){all.forEach((x,j)=>{if(j>=i)x.value=dg[j-i]||""});t.value=dg[0]||"";all[Math.min(i+dg.length,5)].focus()}else t.value=dg;
    if(t.value&&all[i+1])all[i+1].focus();
    if(S.su.codeErr){S.su.codeErr="";$("#cboxes").classList.remove("bad");const er=$("#fm .errtxt");if(er)er.remove()}
    if(all.every(x=>x.value))later(verifyCode,200);
  }
  if(t.id==="dk-amt"&&DK.err){DK.err="";paintDesk()}
  if(t.id==="capC"){S.su.customCap=t.value.replace(/\D/g,"").slice(0,3);t.value=S.su.customCap}
});
on(document,"paste",e=>{
  const t=e.target; if(!(t.dataset&&t.dataset.ci!==undefined))return;
  const d=(e.clipboardData.getData("text")||"").replace(/\D/g,"").slice(0,6); if(!d)return; e.preventDefault();
  const all=[...document.querySelectorAll("#cboxes input")]; all.forEach((x,i)=>x.value=d[i]||""); (all[Math.min(d.length,5)]).focus();
  if(d.length===6)later(verifyCode,200);
});
on(document,"keydown",e=>{
  const tl=e.target.closest&&e.target.closest("[role=tablist]");
  if(tl&&["ArrowLeft","ArrowRight","Home","End"].includes(e.key)){const b=[...tl.querySelectorAll("[role=tab]")],i=b.indexOf(e.target);if(i>-1){e.preventDefault();const n=e.key==="Home"?0:e.key==="End"?b.length-1:(i+(e.key==="ArrowRight"?1:b.length-1))%b.length;howPaint(n);b[n].focus();return}}
  const t=e.target; if(!(t.dataset&&t.dataset.ci!==undefined))return;
  const all=[...document.querySelectorAll("#cboxes input")], i=+t.dataset.ci;
  if(e.key==="Backspace"&&!t.value&&all[i-1]){all[i-1].focus();all[i-1].value=""}
  if(e.key==="ArrowLeft"&&all[i-1]){e.preventDefault();all[i-1].focus()}
  if(e.key==="ArrowRight"&&all[i+1]){e.preventDefault();all[i+1].focus()}
});

function voidNow(){
  if(S.status!=="active"||!S.ui.voidOpen)return;
  const s=sums(); S.voided={C:s.C,A:s.A,F:s.F};
  S.calls.forEach(k=>{if(k.st==="accrued")k.st="voided"});
  S.status="voided"; S.ui.voidOpen=false; S.ui.sel=null; stopRun();
  feel("void",true);
  say("Lease voided. The hold is released.");
  paintLease({cut:true});
  $("#lead h1")?.setAttribute("tabindex","-1"); $("#lead h1")?.focus();
}
/* press and hold: 1.2 s, the ring fills linearly, release or Esc cancels, a buzz at commit */
const HOLD_MS=1200;
let hold=null;
function holdStart(btn){
  if(hold||reduced()||btn.getAttribute("aria-disabled")==="true")return;
  const ring=btn.querySelector(".rf");
  const anim=ring?.animate([{strokeDashoffset:100},{strokeDashoffset:0}],{duration:HOLD_MS,easing:"linear",fill:"forwards"});
  btn.classList.add("holding");
  hold={btn,anim};
  anim?.finished.then(()=>{if(hold&&hold.anim===anim){const h=hold;hold=null;h.btn.classList.remove("holding");voidNow()}},()=>{});
}
function holdCancel(){
  if(!hold)return;
  const h=hold; hold=null;
  h.btn.classList.remove("holding"); h.anim?.cancel();
}
on(document,"pointerdown",e=>{
  if(soundOn())audio();
  const b=e.target.closest?.("#voidGo"); if(!b||e.button!==0||reduced()||b.getAttribute("aria-disabled")==="true")return;
  e.preventDefault(); b.focus({preventScroll:true}); holdStart(b);
});
on(document,"pointerup",holdCancel);
on(document,"pointercancel",holdCancel);
on(document,"contextmenu",e=>{if(e.target.closest?.("#voidGo"))e.preventDefault()});
on(document,"keydown",e=>{
  if(e.key==="Escape")holdCancel();
  const b=e.target.closest?.("#voidGo");
  if(b&&(e.key===" "||e.key==="Enter")&&!reduced()){e.preventDefault();if(!e.repeat)holdStart(b)}
});
on(document,"keyup",e=>{
  if(e.target.closest?.("#voidGo")&&(e.key===" "||e.key==="Enter")&&!reduced()){e.preventDefault();holdCancel()}
});

/* =============================================================
   Router and events
============================================================= */
let current="";
const THEME_KEY="pashadhara-theme";
const darkView=()=>{try{return localStorage.getItem(THEME_KEY)==="dark"}catch(e){return false}};
function setGround(){
  const m=document.body.dataset.mode;
  if(m==="app"&&darkView())document.body.dataset.theme="dark";else document.body.removeAttribute("data-theme");
  const pearl=(m==="app"&&S.user&&S.status==="active")||(m==="flow"&&S.su.mode==="signup"&&S.su.step>=6);
  if(pearl)document.body.dataset.ground="pearl";else document.body.removeAttribute("data-ground");
}
function mount(){
  liveTake();
  const r=route();
  if(r!=="home")clearTimeout(DK.timer);
  if(r==="lease"&&new URLSearchParams(location.search).get("showcase")==="1"&&!location.hash)enterShowcase();
  const v=(r==="home")?"home":(r==="signup"||r==="login")?"flow":(APP_ROUTES.includes(r)?r:"home");
  if(r!=="home"&&v==="home")history.replaceState(null,"","/");
  if(!S.user&&v==="lease")enterShowcase();
  if(APP_ROUTES.includes(v)&&!S.user&&!(["proof","escrow","quickstart"].includes(v))){go("/lease",true);return}
  if(S.user&&S.user.live&&(v==="settle"||v==="approve")){go("/lease",true);return}
  if(S.status==="none"&&["lease","escrow","settle"].includes(v)){go("/approve",true);return}
  const captured=v==="lease"&&current==="settle"?S.ui.settleDone?.ids:null;
  leaseObserver?.disconnect();
  if(current!==v){stopRun();S.ui.voidOpen=false;clearInterval(resendTimer);if(S.ui.approve==="loading"){clearTimeout(S.approveTimer);S.ui.approve="idle"}}
  if(v==="flow"&&(current!=="flow"||S.su.mode!==r))S.su=suFresh(r);
  current=v;
  const siteProof=(["proof","escrow","quickstart"].includes(v))&&!S.user;
  const mode=v==="home"||siteProof?"site":v==="flow"?"flow":"app";
  document.body.classList.toggle("lease",v==="lease");
  document.body.dataset.mode=mode;setGround();
  const main=$("#main");
  if(v==="home"){renderChrome("site",v);document.title="Pashadhara | A budget your agent cannot break";main.innerHTML=V.home();initHome()}
  else if(v==="flow"){main.innerHTML=V.flow();paintFlow(mount.once?"h1":null)}
  else{
    renderChrome(siteProof?"site":"app",v);
    document.title=({lease:"Lease",approve:"New lease",escrow:"Escrow",settle:"Settle",proof:"Proof",quickstart:"Developer quickstart"})[v]+" | Pashadhara";
    const waitLive=Boolean(S.user&&S.user.live&&v==="lease"&&!S.liveReady);
    main.innerHTML=waitLive?`<div class="wrap lease-skel" role="status" aria-label="Reading the demo lease"><span class="sk-line sk-h1"></span><span class="sk-line sk-sub"></span><span class="sk-cord"></span><div class="sk-row"><span class="sk-line"></span><span class="sk-line"></span><span class="sk-line"></span></div><span class="sr">Reading the demo lease.</span></div>`:V[v]();
    if(!waitLive&&(v==="lease"||v==="settle"||(v==="escrow"&&S.user)))main.insertAdjacentHTML("afterbegin",leaseTabs(v));
    if(waitLive){liveLoad().then(ok=>{if(current!=="lease"||!S.user||!S.user.live)return;if(ok){S.liveReady=true;S.liveChanged=false;mount()}else $("#main").innerHTML=`<div class="wrap"><p class="sub" role="alert">${esc(S.liveErr)}</p></div>`})}
    else if(v==="lease"){
      if(S.user&&S.user.live)liveStart();
      paintLease();
      watchLeaseRegions();
      if(captured){
        $("#cord").querySelectorAll(".pendants .pen").forEach(pen=>{if(captured.includes(+pen.dataset.id))previousKnots(pen)});
        delete S.ui.settleDone.ids;
      }
    }
    if(v==="escrow")paintEscrow();
    if(v==="settle")paintSettle();
  }
  window.scrollTo(0,0);
  if(mount.once)say(document.title);
  if(mount.once&&v!=="flow")main.focus({preventScroll:true});
  if(v==="home"&&location.hash){const t=document.getElementById(location.hash.slice(1));if(t){if(t.tagName==="DETAILS")t.open=true;later(()=>t.scrollIntoView({block:"start"}),60)}}
  syncSound();
  save();
  mount.once=true;
}
on(window,"popstate",mount);
let lastVertical=isVertical();
on(window,"resize",()=>{const v=isVertical();if(v!==lastVertical){lastVertical=v;mount()}});

on(document,"click",e=>{
  if(linkClick(e))return;
  if(siteClick(e))return;
  const t=e.target;
  if(t.closest("#cord")&&!S.ui.hint){S.ui.hint=true;paintReadout()}
  const sel=t.closest("[data-sel]");
  if(sel){const id=+sel.dataset.sel;S.ui.sel=S.ui.sel===id?null:id;paintSelection();return}
  const pen=t.closest("#cord .pendants .pen[data-id]");
  if(pen){const id=+pen.dataset.id;S.ui.sel=S.ui.sel===id?null:id;paintSelection();return}
  switch(t.closest("button")?.id){
    case "run": S.running?(stopRun(),paintControls()):startRun(); break;
    case "one": spend(); break;
    case "voidOpen": stopRun(); S.ui.voidOpen=true; paintControls(); $("#vin")?.focus(); break;
    case "voidCancel": S.ui.voidOpen=false; paintControls(); $("#voidOpen")?.focus(); break;
    case "voidGo": {
      if(t.closest("button").getAttribute("aria-disabled")==="true")break;
      if(!reduced()&&e.detail!==0)break;   // a pointer click needs the hold; a click with no pointer (assistive tech) commits
      voidNow(); break;}
    case "approveGo": if(S.ui.approve==="loading")break; S.ui.approve="loading"; $("#main").innerHTML=V.approve();
      S.approveTimer=later(()=>{if(S.ui.approve!=="loading")return;S.status="active";S.calls=[];S.q=0;S.nextId=1;S.clock=9*60;S.log=[];S.settles=[];S.voided=null;S.ui.approve="idle";S.ui.sel=null;S.ui.settleDone=null;S.ui.settleN=null;
        say("Sample lease approved. No PayPal hold exists.");go("/lease");approveFx($("#cord"));},1100); break;
    case "approveNo": if(S.ui.approve==="loading")break; S.ui.approve="declined"; $("#main").innerHTML=V.approve(); $("#approveGo").focus(); break;
    case "resetAll": S.status="none";S.ui.approve="idle";S.calls=[];S.voided=null;stopRun();setGround();$("#main").innerHTML=V.approve();renderNav("approve");break;
    case "fewest": if(t.closest("button").getAttribute("aria-disabled")==="true")break; S.ui.settleN=1; $("#nr").value=1; paintSettleLive(accruedCalls(),accruedCalls().reduce((a,k)=>a+k.c,0),true); break;
    case "every": if(t.closest("button").getAttribute("aria-disabled")==="true")break; {const m=accruedCalls().length; S.ui.settleN=m; $("#nr").value=m; paintSettleLive(accruedCalls(),accruedCalls().reduce((a,k)=>a+k.c,0),true);} break;
    case "settleGo": {
      if(S.ui.settleBusy)break;
      S.ui.settleBusy=true; const items=accruedCalls(); const A=items.reduce((a,k)=>a+k.c,0); paintSettleLive(items,A,true);
      later(()=>{
        if(S.status!=="active"){S.ui.settleBusy=false;if(current==="settle")paintSettle();return}
        const n=S.ui.settleN, g=groupsFor(items,n), fee=g.reduce((a,grp)=>a+feeC(grp.reduce((x,k)=>x+k.c,0)),0);
        items.forEach(k=>{if(k.st==="accrued")k.st="captured"}); S.ui.settleBusy=false; S.ui.settleDone={n,amt:A,fee,ids:items.map(k=>k.id)}; S.ui.settleN=null;
        S.log.push({t:clockStr(S.clock),m:`Captured ${fmt(A)} in ${n} step${n>1?"s":""}. Fees ${fmt(fee)}.`});
        say(`Captured ${fmt(A)} in ${n} steps.`); paintSettle(); $("#settleBody h1")?.setAttribute("tabindex","-1"); $("#settleBody h1")?.focus();
      },900); break;}
  }
  const j=t.closest("button[data-j]");
  if(j){S.ui.esc[j.dataset.j].v=+j.dataset.v; document.querySelectorAll(`button[data-j="${j.dataset.j}"]`).forEach(b=>{b.setAttribute("aria-checked",String(b===j));b.tabIndex=b===j?0:-1});paintEscrow()}
});
on(document,"input",e=>{
  const t=e.target;
  if(t.matches("input[data-sc]")){const k=t.dataset.sc;S.ui.esc[k].s=+t.value;$("#scv"+k).textContent=t.value;paintEscrow(false)}
  if(t.id==="nr"){S.ui.settleN=+t.value;const it=accruedCalls();paintSettleLive(it,it.reduce((a,k)=>a+k.c,0))}
  if(t.id==="vin"){
    const held=sums().held, want=(held/100).toFixed(2), got=t.value.replace(/[$\s]/g,"");
    const ok=got===want, b=$("#voidGo");
    b.setAttribute("aria-disabled",String(!ok));
    const help=$("#vhelp");
    const message=ok?(reduced()?"Amount matches. The button is on.":"Amount matches. Hold the button for 1.2 seconds to void."):(got&&Number(got)!==Number(want)?"That is not the held amount.":"The button stays off until the amount matches.");
    if(help.textContent!==message){help.textContent=message;arrive(help,120)}
  }
});
on(document,"keydown",e=>{
  const g=e.target.closest?.('[role="radiogroup"]'); if(!g)return;
  if(!["ArrowRight","ArrowLeft","ArrowUp","ArrowDown"].includes(e.key))return;
  const btns=[...g.querySelectorAll("button")], i=btns.indexOf(e.target); if(i<0)return;
  e.preventDefault(); const n=btns[(i+(e.key==="ArrowRight"||e.key==="ArrowDown"?1:btns.length-1))%btns.length]; n.focus(); n.click();
  const nb=document.querySelector(`button[data-j="${n.dataset.j}"][data-v="${n.dataset.v}"]`); nb?.focus();
});
/* pointer hover on pendants, desktop only */
on(document,"pointerover",e=>{
  if(e.pointerType!=="mouse"||!fineHover.matches)return;
  if(e.target.closest?.("#cord")&&!S.ui.hint){S.ui.hint=true;paintReadout()}
  const h=e.target.closest?.("#cord .pendants .hit"); if(!h)return;
  const id=+h.dataset.id; if(S.ui.sel===id)return; S.ui.sel=id; paintSelection();
});
on(document,"pointerout",e=>{
  if(e.pointerType!=="mouse"||!fineHover.matches)return;
  if(e.target.closest?.("#cord .pendants .hit")&&!e.relatedTarget?.closest?.("#cord .pendants .hit")){S.ui.sel=null;paintSelection()}
});

restore();
on(window,"pagehide",save);
mount();
return ()=>{ac.abort();timeouts.forEach(clearTimeout);timeouts.clear();stopRun();leaseObserver?.disconnect();clearInterval(resendTimer);clearTimeout(S.approveTimer);["hdr","main","ftr","live"].forEach(id=>{const n=document.getElementById(id);if(n)n.innerHTML=""});document.body.removeAttribute("data-mode");document.body.classList.remove("lease")};
}
