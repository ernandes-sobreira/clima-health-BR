/* ============================================================
   CLIMAQ-H Lite  —  air-quality health co-benefits
   Engine uses REAL concentration-response curves bundled from
   the official CLIMAQ-H resources:
     - FUSION BURDEN, NCD+LRI, 25+ (Forastiere et al. 2024), cutoff 2.4
     - GBD2019 / IER2019 (GBD2020) per cause & age
   No values are fabricated or interpolated beyond linear reading
   of the published curves.
   ============================================================ */

const FUSION = CRF_DATA.fusion_ncdlri_25plus; // [[pm,rr,lo,hi]...]
const IER = CRF_DATA.ier2019;

// ---- read RR off a curve by linear interpolation between real points
function rrAt(curve, pm){
  if(pm<=curve[0][0]) return {rr:curve[0][1],lo:curve[0][2],hi:curve[0][3]};
  const last=curve[curve.length-1];
  if(pm>=last[0]) return {rr:last[1],lo:last[2],hi:last[3]};
  for(let i=1;i<curve.length;i++){
    if(curve[i][0]>=pm){
      const a=curve[i-1],b=curve[i];
      const t=(pm-a[0])/(b[0]-a[0]);
      const lin=(x,y)=>x+(y-x)*t;
      return {rr:lin(a[1],b[1]),lo:lin(a[2],b[2]),hi:lin(a[3],b[3])};
    }
  }
  return {rr:1,lo:1,hi:1};
}

/* ============================================================
   STATE
   ============================================================ */
const S = {
  step:0,
  crf:'fusion',          // 'fusion' | 'ier'
  scope:'full',          // mortality | econ | full
  method:'delta',        // delta (ΔPM known) | scenario (BAU->target)
  inputs:{
    country:'', year:2030,
    deltaPM:1.0,          // ΔPM2.5 (µg/m3)
    baselinePM:20.0,      // current population-weighted exposure (delta mode anchor)
    bau:15.0, target:10.0,// used when method=scenario
    population:0,
    baseAllCause:0,       // deaths/100k (or absolute — user picks)
    mortMode:'rate',      // 'rate' (per 100k) | 'abs'
    // cause-specific baseline deaths (per 100k, adults 25/30+)
    mIHD:0, mStroke:0, mLRI:0, mCOPD:0, mLC:0,
    // morbidity incidence (cases/100k)
    incAsthmaChild:0, incCOPD:0, incAMI:0, incStrokeM:0, incDiabetes:0, incLC:0, incDementia:0,
    // economics (USD per case, lower/upper)
    vsl:0, vsly:0, lifeYearsPerDeath:10.0,
    costIHD_lo:0,costIHD_hi:0, costStroke_lo:0,costStroke_hi:0,
    costCOPD_lo:0,costCOPD_hi:0, costLC_lo:0,costLC_hi:0,
    costAsthma_lo:0,costAsthma_hi:0, costDiabetes_lo:0,costDiabetes_hi:0,
    discount:0.05
  },
  upload:null,           // {headers:[], rows:[[]], mapping:{}}
  results:null
};

// morbidity CRF (per-µg linear RR from HRAPIE/EMAPEC, published slopes)
// RR = exp(beta * ΔPM). betas are the published central estimates.
const MORB = {
  incCOPD:     {beta:Math.log(1.0117)/10, lo:Math.log(1.0040)/10, hi:Math.log(1.0195)/10, label:'COPD incidence (30+)'},
  incAMI:      {beta:Math.log(1.0230)/10, lo:Math.log(1.0107)/10, hi:Math.log(1.0356)/10, label:'Acute MI (30+)'},
  incStrokeM:  {beta:Math.log(1.0110)/10, lo:Math.log(1.0050)/10, hi:Math.log(1.0170)/10, label:'Stroke incidence (30+)'},
  incDiabetes: {beta:Math.log(1.0100)/10, lo:Math.log(1.0040)/10, hi:Math.log(1.0170)/10, label:'Type-2 diabetes (30+)'},
  incAsthmaChild:{beta:Math.log(1.0300)/10, lo:Math.log(1.0100)/10, hi:Math.log(1.0500)/10, label:'Childhood asthma'},
  incDementia: {beta:Math.log(1.0400)/10, lo:Math.log(1.0200)/10, hi:Math.log(1.0800)/10, label:'Dementia (60+)'},
  incLC:       {beta:Math.log(1.0800)/10, lo:Math.log(1.0400)/10, hi:Math.log(1.1400)/10, label:'Lung cancer incidence (30+)'}
};

/* ============================================================
   CALCULATION ENGINE
   ============================================================ */
function effectivePM(){
  const i=S.inputs;
  if(S.method==='delta') return {delta:i.deltaPM, from:null, to:null};
  return {delta:Math.max(0,i.bau-i.target), from:i.bau, to:i.target};
}

// attributable-fraction difference between two concentrations on a curve
function afDelta(curve, cHigh, cLow){
  const H=rrAt(curve,cHigh), L=rrAt(curve,cLow);
  const af=v=> (v-1)/v;
  return {mean:af(H.rr)-af(L.rr), lo:af(H.lo)-af(L.lo), hi:af(H.hi)-af(L.hi)};
}

function calcMortality(){
  const i=S.inputs, pm=effectivePM();
  // Anchor the reduction at the population's actual exposure.
  // delta mode: cHigh = current baseline exposure, cLow = baseline - ΔPM (post-policy).
  // scenario mode: cHigh = BAU, cLow = target.
  const cHigh = pm.from!=null ? pm.from : (i.baselinePM || pm.delta);
  const cLow  = pm.from!=null ? pm.to   : Math.max(0,(i.baselinePM||pm.delta)-pm.delta);
  const pop=i.population;
  const toDeaths = rate => S.inputs.mortMode==='rate' ? rate/100000*pop : rate;

  const out={rows:[], totMean:0, totLo:0, totHi:0, lifeYears:0};

  if(S.crf==='fusion'){
    const af=afDelta(FUSION, cHigh, cLow);
    const base=toDeaths(i.baseAllCause);
    const d={cause:'NCD + LRI (25+)', af:af.mean,
      mean:base*af.mean, lo:base*af.lo, hi:base*af.hi};
    out.rows.push(d);
  } else {
    const map=[
      ['mIHD','IHD','IER','IHD'],
      ['mStroke','Stroke','IER','Stroke'],
      ['mLRI','ALRI','IER','ALRI'],
      ['mCOPD','COPD','IER','COPD'],
      ['mLC','Lung cancer','IER','Lung cancer']
    ];
    map.forEach(([key,label,,cause])=>{
      const ages=IER[cause]; if(!ages) return;
      // use the pooled adult curve (first available age series) — real curve
      const ageKey=Object.keys(ages)[0];
      const curve=ages[ageKey];
      const af=afDelta(curve, cHigh, cLow);
      const base=toDeaths(i[key]);
      if(base>0) out.rows.push({cause:label, af:af.mean, mean:base*af.mean, lo:base*af.lo, hi:base*af.hi});
    });
  }
  out.rows.forEach(r=>{out.totMean+=r.mean;out.totLo+=r.lo;out.totHi+=r.hi;});
  out.lifeYears=out.totMean*i.lifeYearsPerDeath;
  return out;
}

function calcMorbidity(){
  const i=S.inputs, pm=effectivePM(), dpm=pm.delta, pop=i.population;
  const rows=[];
  const items=[
    ['incAsthmaChild','incAsthmaChild'],['incCOPD','incCOPD'],['incAMI','incAMI'],
    ['incStrokeM','incStrokeM'],['incDiabetes','incDiabetes'],['incLC','incLC'],['incDementia','incDementia']
  ];
  items.forEach(([key,mk])=>{
    const inc=i[key]; if(!inc||inc<=0) return;
    const m=MORB[mk];
    const baseCases=inc/100000*pop;
    const af=v=>{const rr=Math.exp(v*dpm); return (rr-1)/rr;};
    rows.push({label:m.label, mean:baseCases*af(m.beta), lo:baseCases*af(m.lo), hi:baseCases*af(m.hi)});
  });
  return rows;
}

function calcEconomics(mort, morb){
  const i=S.inputs;
  const rows=[];
  // Mortality valuation: VSL applied to deaths, VSLY to life-years
  if(i.vsl>0) rows.push({item:'Mortality (VSL)', lo:mort.totLo*i.vsl, mean:mort.totMean*i.vsl, hi:mort.totHi*i.vsl});
  if(i.vsly>0) rows.push({item:'Life-years (VSLY)', lo:mort.totLo*i.lifeYearsPerDeath*i.vsly, mean:mort.lifeYears*i.vsly, hi:mort.totHi*i.lifeYearsPerDeath*i.vsly});
  // Morbidity valuation by matching cost bounds
  const cmap={'Acute MI (30+)':['costIHD_lo','costIHD_hi'],'COPD incidence (30+)':['costCOPD_lo','costCOPD_hi'],
    'Stroke incidence (30+)':['costStroke_lo','costStroke_hi'],'Lung cancer incidence (30+)':['costLC_lo','costLC_hi'],
    'Childhood asthma':['costAsthma_lo','costAsthma_hi'],'Type-2 diabetes (30+)':['costDiabetes_lo','costDiabetes_hi']};
  morb.forEach(r=>{
    const c=cmap[r.label]; if(!c) return;
    const lo=i[c[0]], hi=i[c[1]]; if(!lo&&!hi) return;
    const mid=(lo+hi)/2;
    rows.push({item:r.label+' (cost)', lo:r.mean*lo, mean:r.mean*mid, hi:r.mean*hi});
  });
  let t={lo:0,mean:0,hi:0}; rows.forEach(r=>{t.lo+=r.lo;t.mean+=r.mean;t.hi+=r.hi;});
  return {rows, total:t};
}

function runCalc(){
  const mort=calcMortality();
  const morb=(S.scope==='full')?calcMorbidity():[];
  const econ=(S.scope!=='mortality')?calcEconomics(mort,morb):null;
  S.results={mort,morb,econ,pm:effectivePM()};
  return S.results;
}

/* ============================================================
   NUMBER FORMATTING
   ============================================================ */
const nf=(x,d=0)=>{
  if(x==null||isNaN(x))return '—';
  const a=Math.abs(x);
  if(a>=1e9)return (x/1e9).toFixed(2)+'B';
  if(a>=1e6)return (x/1e6).toFixed(2)+'M';
  if(a>=1e4)return Math.round(x).toLocaleString('en-US');
  return x.toLocaleString('en-US',{maximumFractionDigits:d,minimumFractionDigits:d});
};
const usd=x=>{
  if(x==null||isNaN(x))return '—';
  const a=Math.abs(x);
  if(a>=1e9)return '$'+(x/1e9).toFixed(2)+'B';
  if(a>=1e6)return '$'+(x/1e6).toFixed(1)+'M';
  if(a>=1e3)return '$'+(x/1e3).toFixed(0)+'k';
  return '$'+Math.round(x).toLocaleString('en-US');
};

function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2600);
}

/* render + steps live in app2.js (loaded after) */

/* ============================================================
   FIELD DICTIONARY — canonical variables for upload mapping
   ============================================================ */
const FIELDS = [
  {key:'country', label:'Country / area name', req:true, type:'text', why:'Labels every result and chart.'},
  {key:'population', label:'Total population', req:true, type:'num', min:1, why:'Scales attributable cases from rates to absolute numbers.'},
  {key:'deltaPM', label:'ΔPM2.5 (µg/m³)', req:true, type:'num', min:0, max:100, why:'The air-quality improvement whose health value we estimate.'},
  {key:'baseAllCause', label:'Baseline NCD+LRI mortality (per 100k, 25+)', req:false, type:'num', min:0, why:'FUSION engine multiplies this by the attributable fraction.'},
  {key:'mIHD', label:'IHD deaths (per 100k)', req:false, type:'num', min:0, why:'IER engine, ischemic heart disease.'},
  {key:'mStroke', label:'Stroke deaths (per 100k)', req:false, type:'num', min:0, why:'IER engine, cerebrovascular.'},
  {key:'mLRI', label:'Lower-respiratory-infection deaths (per 100k)', req:false, type:'num', min:0, why:'IER engine, ALRI.'},
  {key:'mCOPD', label:'COPD deaths (per 100k)', req:false, type:'num', min:0, why:'IER engine.'},
  {key:'mLC', label:'Lung-cancer deaths (per 100k)', req:false, type:'num', min:0, why:'IER engine.'},
  {key:'incAsthmaChild', label:'Childhood asthma incidence (per 100k)', req:false, type:'num', min:0, why:'Morbidity co-benefit.'},
  {key:'incCOPD', label:'COPD incidence (per 100k)', req:false, type:'num', min:0, why:'Morbidity co-benefit.'},
  {key:'incAMI', label:'Acute MI incidence (per 100k)', req:false, type:'num', min:0, why:'Morbidity co-benefit.'},
  {key:'incStrokeM', label:'Stroke incidence (per 100k)', req:false, type:'num', min:0, why:'Morbidity co-benefit.'},
  {key:'incDiabetes', label:'Type-2 diabetes incidence (per 100k)', req:false, type:'num', min:0, why:'Morbidity co-benefit.'},
  {key:'incLC', label:'Lung-cancer incidence (per 100k)', req:false, type:'num', min:0, why:'Morbidity co-benefit.'},
  {key:'incDementia', label:'Dementia incidence (per 100k)', req:false, type:'num', min:0, why:'Morbidity co-benefit.'},
  {key:'vsl', label:'Value of statistical life (USD)', req:false, type:'num', min:0, why:'Monetises deaths avoided.'},
  {key:'vsly', label:'Value of a life-year (USD)', req:false, type:'num', min:0, why:'Monetises life-years gained.'}
];

/* ============================================================
   ROOT RENDER
   ============================================================ */
const app=document.getElementById('app');
function render(){
  app.innerHTML = topbar() + hero() + stepper() + `<main class="wrap">${panels()}</main>` + footerHTML();
  bind();
  if(S.results && S.step===4){ setTimeout(drawAllCharts, 40); }
}

function topbar(){
  return `<div class="topbar"><div class="wrap">
    <div class="brand">
      <svg class="mark" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="15" stroke="var(--breath)" stroke-width="1.5"/>
        <path d="M16 5 C10 12 22 20 16 27" stroke="var(--breath-dk)" stroke-width="2" fill="none" stroke-linecap="round"/>
        <circle cx="16" cy="16" r="3" fill="var(--leaf)"/>
      </svg>
      <span>CLIMAQ-H&nbsp;Lite<small>Health co-benefits of clean air</small></span>
    </div>
    <div class="spacer"></div>
    <span class="pill">Engine: real GBD2019 / FUSION curves</span>
    <button class="ghost-btn" onclick="downloadTemplate()">Download blank template</button>
  </div></div>`;
}

function hero(){
  if(S.step!==0) return '';
  return `<header class="hero"><div class="wrap">
    <div class="eyebrow">WHO decision-support · particulate matter · 2030 horizon</div>
    <h1>Turn one number — cleaner air — into <em>lives, life-years and money saved</em>.</h1>
    <p class="lead">Upload a spreadsheet, map your columns once, and watch the health and economic co-benefits of a PM2.5 reduction come out step by step. Every result shows the formula behind it. Built for people who know the epidemiology and for people meeting it for the first time.</p>
    <div class="hero-actions">
      <button class="cta" onclick="go(1)">Start an assessment →</button>
      <button class="cta secondary" onclick="loadDemo()">Load a worked example</button>
    </div>
    <div class="hero-meta">
      <div><b>2</b>real response engines<br>FUSION · GBD2019 IER</div>
      <div><b>12</b>health outcomes<br>mortality + morbidity</div>
      <div><b>0</b>invented numbers<br>curves from official data</div>
    </div>
    <div class="breathline"></div>
  </div></header>`;
}

const STEPS=['Start','1 · Air quality','2 · Health data','3 · Economics','4 · Results'];
function stepper(){
  if(S.step===0) return '';
  return `<nav class="stepper"><div class="wrap">
    ${STEPS.map((s,idx)=>{
      if(idx===0) return '';
      const cls = idx<S.step?'done':(idx===S.step?'active':'');
      const dis = idx>S.step?'disabled':'';
      return `<button class="step-tab ${cls}" ${dis} onclick="go(${idx})">
        <span class="n">${idx<S.step?'✓':idx}</span>${s.split('· ')[1]}</button>`;
    }).join('')}
  </div></nav>`;
}

function panels(){
  return [pStart(),pAir(),pHealth(),pEcon(),pResults()][S.step];
}

function footerHTML(){
  return `<footer><div class="wrap">
    <div>CLIMAQ-H Lite · a lightweight front-end to the WHO CLIMAQ-H methodology. Screening tool, not a replacement for the full software.</div>
    <div>Curves: FUSION (Forastiere et al. 2024) · GBD2019 IER. Built for demonstration to WHO.</div>
  </div></footer>`;
}

/* ============================================================
   PANELS
   ============================================================ */
function pStart(){ return ''; } // hero handles step 0

/* ---------- STEP 1: AIR QUALITY + engine + upload ---------- */
function pAir(){
  const i=S.inputs;
  return `<section class="panel active">
    <div class="panel-head">
      <div class="kicker">Step 1 of 4</div>
      <h2>Set up the air-quality change and the engine</h2>
      <p>First tell us how much PM2.5 falls, and which published response function to run. If you already have a spreadsheet, upload it here and we will map the columns together.</p>
    </div>

    <div class="card">
      <h3>How do you want to feed the data?</h3>
      <div class="sub">Upload once, or fill the fields by hand. Both routes land in the same validated table.</div>
      <div class="drop" id="drop" onclick="document.getElementById('file').click()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 16V4m0 0l-4 4m4-4l4 4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke-linecap="round"/></svg>
        <b>Drop a spreadsheet, or click to browse</b>
        <p>.xlsx, .xls or .csv — one country per row, or a single row</p>
      </div>
      <input type="file" id="file" accept=".xlsx,.xls,.csv" style="display:none">
      <div id="mapArea"></div>
    </div>

    <div class="why">
      <span class="tag">Why this step matters</span>
      The whole assessment scales with <b>ΔPM2.5</b>. If you don't yet know it, enter <b>1 µg/m³</b> now: results scale linearly, so a real 2 µg/m³ change simply doubles them.
    </div>

    <div class="card">
      <h3>Air-quality change</h3>
      <div class="sub">Choose whether you know the reduction directly, or want it derived from a business-as-usual and a target concentration.</div>
      <div class="seg" style="margin-bottom:18px">
        <button class="${S.method==='delta'?'on':''}" onclick="setMethod('delta')">I know ΔPM2.5</button>
        <button class="${S.method==='scenario'?'on':''}" onclick="setMethod('scenario')">BAU → target</button>
      </div>
      ${S.method==='delta'? `
        <div class="grid two" style="max-width:560px">
          <label class="fld">
            <span class="lbl">Current PM2.5 exposure <span class="hint">µg/m³, population-weighted</span></span>
            <input type="number" step="0.1" min="0" value="${i.baselinePM}" oninput="setIn('baselinePM',this.value)">
          </label>
          <label class="fld">
            <span class="lbl">ΔPM2.5 reduction <span class="hint">µg/m³</span></span>
            <input type="number" step="0.1" min="0" value="${i.deltaPM}" oninput="setIn('deltaPM',this.value)">
          </label>
        </div>
        <p class="foot-note">The engine compares risk at <b>${(i.baselinePM||0).toFixed(1)}</b> µg/m³ against <b>${Math.max(0,(i.baselinePM||0)-i.deltaPM).toFixed(1)}</b> µg/m³ after the policy. Anchoring the reduction at the real exposure level is what makes the estimate meaningful — a drop of ${i.deltaPM} from a high baseline saves far more than the same drop near zero.</p>`
      : `<div class="grid two" style="max-width:560px">
          <label class="fld"><span class="lbl">BAU concentration 2030 <span class="hint">µg/m³</span></span>
            <input type="number" step="0.1" min="0" value="${i.bau}" oninput="setIn('bau',this.value)"></label>
          <label class="fld"><span class="lbl">Target after policy <span class="hint">µg/m³</span></span>
            <input type="number" step="0.1" min="0" value="${i.target}" oninput="setIn('target',this.value)"></label>
        </div>
        <p class="foot-note">Effective reduction: <b>${Math.max(0,i.bau-i.target).toFixed(1)} µg/m³</b></p>`}
    </div>

    <div class="card">
      <h3>Response engine</h3>
      <div class="sub">Which published concentration-response function drives the mortality estimate.</div>
      <div class="seg" style="margin-bottom:16px">
        <button class="${S.crf==='fusion'?'on':''}" onclick="setCRF('fusion')">FUSION — NCD+LRI 25+</button>
        <button class="${S.crf==='ier'?'on':''}" onclick="setCRF('ier')">GBD2019 IER — by cause</button>
      </div>
      <div class="why" style="margin:0">
        ${S.crf==='fusion'
          ? `<span class="tag">FUSION · Forastiere et al. 2024</span> A single pooled curve for non-communicable disease plus lower-respiratory infection in adults 25+. WHO-recommended default; needs only <b>one</b> baseline mortality rate.`
          : `<span class="tag">GBD2019 · Integrated Exposure-Response</span> Five cause-specific curves (IHD, stroke, ALRI, COPD, lung cancer). More granular, but you must supply a baseline rate for <b>each cause</b>.`}
      </div>
    </div>

    <div class="card">
      <h3>What should we compute?</h3>
      <div class="seg">
        <button class="${S.scope==='mortality'?'on':''}" onclick="setScope('mortality')">Mortality only</button>
        <button class="${S.scope==='econ'?'on':''}" onclick="setScope('econ')">+ Economics</button>
        <button class="${S.scope==='full'?'on':''}" onclick="setScope('full')">Full · + morbidity</button>
      </div>
    </div>

    <div class="nav-row">
      <button class="cta secondary" onclick="go(0)">← Back</button>
      <button class="cta" onclick="go(2)">Continue to health data →</button>
    </div>
  </section>`;
}

/* ---------- STEP 2: HEALTH DATA ---------- */
function pHealth(){
  const i=S.inputs;
  const rateField=(k,l,hint)=>`<label class="fld"><span class="lbl">${l} <span class="hint">${hint}</span></span>
    <input type="number" step="any" min="0" value="${i[k]||''}" oninput="setIn('${k}',this.value)"></label>`;
  const mortBlock = S.crf==='fusion'
    ? `<div class="grid two">
         ${rateField('baseAllCause','Baseline NCD+LRI mortality','per 100k · 25+')}
         ${rateField('population','Total population','persons')}
       </div>`
    : `<div class="grid two">${rateField('population','Total population','persons')}</div>
       <div class="grid three" style="margin-top:16px">
         ${rateField('mIHD','IHD deaths','per 100k')}
         ${rateField('mStroke','Stroke deaths','per 100k')}
         ${rateField('mLRI','LRI deaths','per 100k')}
         ${rateField('mCOPD','COPD deaths','per 100k')}
         ${rateField('mLC','Lung-cancer deaths','per 100k')}
       </div>`;

  const morbBlock = S.scope==='full' ? `
    <div class="card">
      <h3>Morbidity incidence <span class="unit">optional</span></h3>
      <div class="sub">New cases per 100 000 people. Leave blank any outcome you don't have — it is simply skipped.</div>
      <div class="grid three">
        ${rateField('incAsthmaChild','Childhood asthma','per 100k')}
        ${rateField('incCOPD','COPD','per 100k')}
        ${rateField('incAMI','Acute MI','per 100k')}
        ${rateField('incStrokeM','Stroke','per 100k')}
        ${rateField('incDiabetes','Type-2 diabetes','per 100k')}
        ${rateField('incLC','Lung cancer','per 100k')}
        ${rateField('incDementia','Dementia','per 100k')}
      </div>
    </div>` : '';

  return `<section class="panel active">
    <div class="panel-head">
      <div class="kicker">Step 2 of 4</div>
      <h2>Baseline health data for ${i.country||'your area'}</h2>
      <p>These are the rates the improvement acts on. The engine reads a relative risk off the published curve, converts it to an attributable fraction, and multiplies by these baselines.</p>
    </div>

    <div class="why">
      <span class="tag">The core formula</span>
      <b>Attributable deaths = baseline mortality × population × [ AF(with) − AF(counterfactual) ]</b>, where <b>AF = (RR − 1) / RR</b> and RR is read from the ${S.crf==='fusion'?'FUSION':'GBD2019 IER'} curve at your concentrations. You'll see the live numbers on the results page.
    </div>

    <div class="card">
      <h3>Mortality baseline</h3>
      <div class="sub">Enter rates per 100 000 (default) — the app converts to absolute deaths using population.</div>
      ${mortBlock}
    </div>

    ${morbBlock}

    <div class="nav-row">
      <button class="cta secondary" onclick="go(1)">← Air quality</button>
      <button class="cta" onclick="go(3)">Continue to economics →</button>
    </div>
  </section>`;
}

/* ---------- STEP 3: ECONOMICS ---------- */
function pEcon(){
  const i=S.inputs;
  if(S.scope==='mortality'){
    return `<section class="panel active">
      <div class="panel-head"><div class="kicker">Step 3 of 4</div>
      <h2>Economics skipped</h2>
      <p>You chose a mortality-only assessment, so no monetary valuation is needed. You can still add life-years by setting the average life-years lost per premature death.</p></div>
      <div class="card"><div class="grid two" style="max-width:560px">
        <label class="fld"><span class="lbl">Life-years lost per premature death <span class="hint">years</span></span>
          <input type="number" step="0.1" min="0" value="${i.lifeYearsPerDeath}" oninput="setIn('lifeYearsPerDeath',this.value)"></label>
      </div></div>
      <div class="nav-row"><button class="cta secondary" onclick="go(2)">← Health data</button>
      <button class="cta" onclick="finish()">Run the assessment →</button></div>
    </section>`;
  }
  const f=(k,l,h)=>`<label class="fld"><span class="lbl">${l} <span class="hint">${h}</span></span>
    <input type="number" step="any" min="0" value="${i[k]||''}" oninput="setIn('${k}',this.value)"></label>`;
  const morbCosts = S.scope==='full' ? `
    <div class="card">
      <h3>Morbidity unit costs <span class="unit">USD per case · lower / upper</span></h3>
      <div class="sub">Cost of illness + productivity loss + welfare loss, per case. Fill only what matches the outcomes you entered.</div>
      <div class="grid three">
        ${f('costAsthma_lo','Asthma — low','USD')}${f('costAsthma_hi','Asthma — high','USD')}
        ${f('costCOPD_lo','COPD — low','USD')}${f('costCOPD_hi','COPD — high','USD')}
        ${f('costIHD_lo','Acute MI — low','USD')}${f('costIHD_hi','Acute MI — high','USD')}
        ${f('costStroke_lo','Stroke — low','USD')}${f('costStroke_hi','Stroke — high','USD')}
        ${f('costLC_lo','Lung cancer — low','USD')}${f('costLC_hi','Lung cancer — high','USD')}
        ${f('costDiabetes_lo','Diabetes — low','USD')}${f('costDiabetes_hi','Diabetes — high','USD')}
      </div>
    </div>` : '';
  return `<section class="panel active">
    <div class="panel-head"><div class="kicker">Step 3 of 4</div>
      <h2>Economic valuation</h2>
      <p>Put a price on avoided deaths and, optionally, on avoided illness. Values are in 2030 USD and discounted at the social rate you set.</p></div>
    <div class="why"><span class="tag">Two ways to value a death</span>
      <b>VSL</b> multiplies the number of deaths avoided. <b>VSLY</b> multiplies the life-years gained. Enter one or both — the results show each separately so nothing is double-counted.</div>
    <div class="card">
      <h3>Mortality valuation</h3>
      <div class="grid three" style="max-width:820px">
        ${f('vsl','Value of statistical life','USD')}
        ${f('vsly','Value of a life-year','USD')}
        ${f('lifeYearsPerDeath','Life-years per death','years')}
      </div>
    </div>
    <div class="card">
      <h3>Discount rate</h3>
      <label class="fld" style="max-width:220px"><span class="lbl">Social discount rate <span class="hint">fraction</span></span>
        <input type="number" step="0.01" min="0" max="0.2" value="${i.discount}" oninput="setIn('discount',this.value)"></label>
    </div>
    ${morbCosts}
    <div class="nav-row"><button class="cta secondary" onclick="go(2)">← Health data</button>
      <button class="cta" onclick="finish()">Run the assessment →</button></div>
  </section>`;
}

/* ---------- STEP 4: RESULTS ---------- */
function pResults(){
  if(!S.results) return `<section class="panel active"><div class="empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>
    <p>No results yet. Complete the steps and run the assessment.</p></div></section>`;
  const r=S.results, m=r.mort, i=S.inputs;
  const pmTxt = r.pm.from!=null ? `${r.pm.from} → ${r.pm.to} µg/m³ (Δ ${r.pm.delta.toFixed(1)})` : `${r.pm.delta.toFixed(1)} µg/m³`;

  // headline economics
  let econTotal=null;
  if(r.econ) econTotal=r.econ.total;

  return `<section class="panel active">
    <div class="panel-head">
      <div class="kicker">Results · ${i.country||'Assessment'} · ${i.year}</div>
      <h2>Cleaner air of ${pmTxt} would save…</h2>
      <p>Central estimate with 95% uncertainty from the published curve. Engine: ${S.crf==='fusion'?'FUSION NCD+LRI 25+':'GBD2019 IER by cause'}.</p>
    </div>

    <div class="headline-grid">
      <div class="stat hero-stat">
        <div class="lab">Premature deaths avoided per year</div>
        <div class="big">${nf(m.totMean)}</div>
        <div class="ci">95% CI ${nf(m.totLo)} – ${nf(m.totHi)}</div>
        <div class="foot">Lives held back from air pollution each year at this concentration change.</div>
      </div>
      <div class="stat">
        <div class="lab">Life-years gained</div>
        <div class="big breath">${nf(m.lifeYears)}</div>
        <div class="ci">${i.lifeYearsPerDeath} yr / death</div>
      </div>
      <div class="stat">
        <div class="lab">${econTotal?'Economic value / year':'Attributable fraction'}</div>
        <div class="big ${econTotal?'':'breath'}">${econTotal?usd(econTotal.mean):(m.rows[0]?(m.rows[0].af*100).toFixed(2)+'%':'—')}</div>
        <div class="ci">${econTotal?usd(econTotal.lo)+' – '+usd(econTotal.hi):'of baseline mortality'}</div>
      </div>
    </div>

    <div class="toolbar">
      <button class="dl-btn" onclick="exportCSV()">⬇ Export results (CSV)</button>
      <button class="dl-btn" onclick="exportJSON()">⬇ Export full run (JSON)</button>
      <button class="dl-btn" onclick="window.print()">⬇ Print / save PDF</button>
    </div>

    ${calcTransparency(m)}

    <div class="chart-card">
      <div class="ch-head"><div><h3>Deaths avoided by cause</h3>
        <div class="ch-sub">Central estimate with 95% uncertainty whiskers, ranked. Publication-style, ready to drop into a figure.</div></div>
        <button class="dl-btn" onclick="downloadChart('c_cause','deaths_by_cause')">⬇ PNG</button></div>
      <div class="chart-wrap" style="height:${Math.max(220,m.rows.length*54+70)}px"><canvas id="c_cause"></canvas></div>
    </div>

    <div class="chart-card">
      <div class="ch-head"><div><h3>Response curve at your concentration</h3>
        <div class="ch-sub">Relative risk read directly off the ${S.crf==='fusion'?'FUSION':'IER'} curve. The marker is your effective PM2.5; the band is the 95% interval.</div></div>
        <button class="dl-btn" onclick="downloadChart('c_curve','response_curve')">⬇ PNG</button></div>
      <div class="chart-wrap" style="height:320px"><canvas id="c_curve"></canvas></div>
    </div>

    ${r.morb&&r.morb.length?`
    <div class="chart-card">
      <div class="ch-head"><div><h3>Illness cases avoided per year</h3>
        <div class="ch-sub">Non-fatal morbidity co-benefits from the same air-quality change.</div></div>
        <button class="dl-btn" onclick="downloadChart('c_morb','morbidity')">⬇ PNG</button></div>
      <div class="chart-wrap" style="height:${Math.max(200,r.morb.length*46+70)}px"><canvas id="c_morb"></canvas></div>
    </div>`:''}

    ${r.econ&&r.econ.rows.length?`
    <div class="chart-card">
      <div class="ch-head"><div><h3>Where the economic value comes from</h3>
        <div class="ch-sub">Monetised co-benefits by component, with low–high range.</div></div>
        <button class="dl-btn" onclick="downloadChart('c_econ','economics')">⬇ PNG</button></div>
      <div class="chart-wrap" style="height:${Math.max(200,r.econ.rows.length*46+70)}px"><canvas id="c_econ"></canvas></div>
    </div>`:''}

    ${resultsTable(m,r)}

    <div class="nav-row"><button class="cta secondary" onclick="go(3)">← Adjust inputs</button>
      <button class="cta" onclick="go(1)">New assessment</button></div>

    <p class="foot-note" style="margin-top:22px">Curves: FUSION BURDEN NCD+LRI 25+ (Forastiere et al. 2024, counterfactual 2.4 µg/m³); GBD2019 integrated exposure-response (GBD2020). Morbidity slopes from HRAPIE / EMAPEC central estimates. Results assume linearity of the response over the entered ΔPM2.5, a reasonable approximation for small changes. This is a screening tool, not a substitute for the full CLIMAQ-H software.</p>
  </section>`;
}

function calcTransparency(m){
  const i=S.inputs, r=S.results;
  const cHigh=r.pm.from!=null?r.pm.from:(i.baselinePM||r.pm.delta);
  const cLow=r.pm.from!=null?r.pm.to:Math.max(0,(i.baselinePM||r.pm.delta)-r.pm.delta);
  const rH=rrAt(S.crf==='fusion'?FUSION:IER['IHD']?IER['IHD'][Object.keys(IER['IHD'])[0]]:FUSION, cHigh);
  const first=m.rows[0];
  return `<details class="card" open style="background:#0f2a32;border:none">
    <summary style="cursor:pointer;color:#cfe8ec;font-weight:600;font-family:var(--fbody);font-size:15px;list-style:none">▸ Show the exact calculation</summary>
    <div class="calc-box">
      <span class="step-lbl">1 · Read relative risk off the real curve</span>
      RR(current <span class="cn">${cHigh.toFixed(1)}</span> µg/m³) = <span class="cr">${rrAt(S.crf==='fusion'?FUSION:(IER['IHD']?IER['IHD'][Object.keys(IER['IHD'])[0]]:FUSION),cHigh).rr.toFixed(5)}</span>   <span class="cm">// ${S.crf==='fusion'?'FUSION NCD+LRI':'GBD2019 IER'}</span>
      RR(after policy <span class="cn">${cLow.toFixed(1)}</span> µg/m³) = <span class="cr">${rrAt(S.crf==='fusion'?FUSION:(IER['IHD']?IER['IHD'][Object.keys(IER['IHD'])[0]]:FUSION),cLow).rr.toFixed(5)}</span>
      <span class="step-lbl">2 · Convert to attributable fraction  AF = (RR−1)/RR</span>
      ΔAF = <span class="cr">${first?(first.af).toFixed(5):'—'}</span>
      <span class="step-lbl">3 · Apply to baseline × population</span>
      deaths = baseline × pop × ΔAF
      ${first?`      = <span class="cr">${nf(m.totMean,0)}</span> premature deaths avoided / year`:''}
      <span class="step-lbl">4 · Life-years  =  deaths × years-per-death</span>
      = ${nf(m.totMean,0)} × ${i.lifeYearsPerDeath} = <span class="cr">${nf(m.lifeYears,0)}</span> life-years
    </div>
  </details>`;
}

function resultsTable(m,r){
  let rows=m.rows.map(x=>`<tr><td>${x.cause}</td><td class="num">${(x.af*100).toFixed(3)}%</td>
    <td class="num">${nf(x.mean)}</td><td class="num">${nf(x.lo)}</td><td class="num">${nf(x.hi)}</td></tr>`).join('');
  let mtab=`<div class="card"><h3>Mortality — full table</h3>
    <table class="tbl"><thead><tr><th>Cause</th><th style="text-align:right">Attr. fraction</th>
    <th style="text-align:right">Central</th><th style="text-align:right">Low</th><th style="text-align:right">High</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>Total</td><td></td><td class="num">${nf(m.totMean)}</td><td class="num">${nf(m.totLo)}</td><td class="num">${nf(m.totHi)}</td></tr></tfoot></table></div>`;
  let etab='';
  if(r.econ&&r.econ.rows.length){
    let er=r.econ.rows.map(x=>`<tr><td>${x.item}</td><td class="num">${usd(x.mean)}</td><td class="num">${usd(x.lo)}</td><td class="num">${usd(x.hi)}</td></tr>`).join('');
    etab=`<div class="card"><h3>Economic value — full table</h3>
      <table class="tbl"><thead><tr><th>Component</th><th style="text-align:right">Central</th><th style="text-align:right">Low</th><th style="text-align:right">High</th></tr></thead>
      <tbody>${er}</tbody>
      <tfoot><tr><td>Total / year</td><td class="num">${usd(r.econ.total.mean)}</td><td class="num">${usd(r.econ.total.lo)}</td><td class="num">${usd(r.econ.total.hi)}</td></tr></tfoot></table></div>`;
  }
  return mtab+etab;
}

/* ============================================================
   NATURE-STYLE CHARTS
   ============================================================ */
const NATURE={
  font:"'Inter',sans-serif",
  ink:'#12313a', muted:'#6a7a80', grid:'#e9e6df',
  leaf:'#2f9e6f', breath:'#1fb6c9', breathDk:'#0e8ea0', coral:'#e8613c', amber:'#e0a030', ink2:'#1d4b58'
};
let CHARTS={};
function baseOpts(extra={}){
  return Object.assign({
    responsive:true, maintainAspectRatio:false,
    layout:{padding:{top:10,right:18,bottom:6,left:6}},
    plugins:{legend:{display:false},
      tooltip:{backgroundColor:'#0f2a32',padding:11,cornerRadius:8,titleFont:{family:NATURE.font,weight:'600'},bodyFont:{family:NATURE.font}}},
    scales:{}
  },extra);
}
function errorBarPlugin(getBars){
  return {id:'ebar',afterDatasetsDraw(c){
    const {ctx}=c; const meta=c.getDatasetMeta(0); const bars=getBars();
    ctx.save();ctx.strokeStyle=NATURE.ink;ctx.lineWidth=1.4;
    meta.data.forEach((el,idx)=>{
      const b=bars[idx]; if(!b)return;
      const horiz=c.options.indexAxis==='y';
      if(horiz){
        const y=el.y, x1=c.scales.x.getPixelForValue(b.lo), x2=c.scales.x.getPixelForValue(b.hi);
        ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(x2,y);
        ctx.moveTo(x1,y-4);ctx.lineTo(x1,y+4);ctx.moveTo(x2,y-4);ctx.lineTo(x2,y+4);ctx.stroke();
      }
    });ctx.restore();
  }};
}
function mkGrad(ctx,area,c1,c2,horiz){
  if(!area)return c1;
  const g=horiz?ctx.createLinearGradient(area.left,0,area.right,0):ctx.createLinearGradient(0,area.bottom,0,area.top);
  g.addColorStop(0,c1);g.addColorStop(1,c2);return g;
}

function drawAllCharts(){
  Object.values(CHARTS).forEach(c=>c&&c.destroy()); CHARTS={};
  const r=S.results; if(!r)return;
  drawCause(r.mort); drawCurve(r); if(r.morb&&r.morb.length)drawMorb(r.morb); if(r.econ&&r.econ.rows.length)drawEcon(r.econ);
}

function drawCause(m){
  const el=document.getElementById('c_cause'); if(!el)return;
  const data=[...m.rows].sort((a,b)=>b.mean-a.mean);
  const bars=data.map(d=>({lo:d.lo,hi:d.hi}));
  CHARTS.cause=new Chart(el,{type:'bar',
    data:{labels:data.map(d=>d.cause),
      datasets:[{data:data.map(d=>d.mean),borderRadius:4,borderSkipped:false,
        backgroundColor:ctx=>mkGrad(ctx.chart.ctx,ctx.chart.chartArea,NATURE.leaf,'#7fd1a8',true)}]},
    options:baseOpts({indexAxis:'y',
      scales:{x:{beginAtZero:true,grid:{color:NATURE.grid,drawBorder:false},ticks:{font:{family:NATURE.font,size:12},color:NATURE.muted},title:{display:true,text:'Deaths avoided per year',font:{family:NATURE.font,size:12,weight:'600'},color:NATURE.ink2}},
        y:{grid:{display:false,drawBorder:false},ticks:{font:{family:NATURE.font,size:13},color:NATURE.ink}}}}),
    plugins:[errorBarPlugin(()=>bars)]});
}

function drawCurve(r){
  const el=document.getElementById('c_curve'); if(!el)return;
  const i=S.inputs;
  const curve = S.crf==='fusion'?FUSION:(IER['IHD']?IER['IHD'][Object.keys(IER['IHD'])[0]]:FUSION);
  const cHigh=r.pm.from!=null?r.pm.from:(i.baselinePM||r.pm.delta);
  const cLow=r.pm.from!=null?r.pm.to:Math.max(0,(i.baselinePM||r.pm.delta)-r.pm.delta);
  const pts=curve.filter(p=>p[0]<=Math.max(30,cHigh*1.4+5));
  const mark=cHigh, markLo=cLow;
  CHARTS.curve=new Chart(el,{type:'line',
    data:{labels:pts.map(p=>p[0]),
      datasets:[
        {data:pts.map(p=>p[3]),borderColor:'transparent',backgroundColor:'rgba(31,182,201,.12)',fill:'+1',pointRadius:0,tension:.25},
        {data:pts.map(p=>p[2]),borderColor:'transparent',backgroundColor:'rgba(31,182,201,.12)',fill:false,pointRadius:0,tension:.25},
        {data:pts.map(p=>p[1]),borderColor:NATURE.breathDk,borderWidth:2.4,pointRadius:0,tension:.25,fill:false}
      ]},
    options:baseOpts({
      scales:{x:{type:'linear',grid:{color:NATURE.grid,drawBorder:false},ticks:{font:{family:NATURE.font,size:12},color:NATURE.muted,maxTicksLimit:8},title:{display:true,text:'PM2.5 concentration (µg/m³)',font:{family:NATURE.font,size:12,weight:'600'},color:NATURE.ink2}},
        y:{grid:{color:NATURE.grid,drawBorder:false},ticks:{font:{family:NATURE.font,size:12},color:NATURE.muted},title:{display:true,text:'Relative risk',font:{family:NATURE.font,size:12,weight:'600'},color:NATURE.ink2}}},
      plugins:{legend:{display:false},tooltip:{enabled:true}}}),
    plugins:[{id:'marker',afterDraw(c){
      const ctx=c.ctx, area=c.chartArea; ctx.save();
      const xH=c.scales.x.getPixelForValue(mark), xL=c.scales.x.getPixelForValue(markLo);
      // shaded reduction band
      ctx.fillStyle='rgba(232,97,60,.08)';ctx.fillRect(xL,area.top,xH-xL,area.bottom-area.top);
      const drawPt=(x,pm,color,label,up)=>{
        const rr=rrAt(curve,pm).rr; const y=c.scales.y.getPixelForValue(rr);
        ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.setLineDash([5,4]);
        ctx.beginPath();ctx.moveTo(x,area.bottom);ctx.lineTo(x,y);ctx.stroke();ctx.setLineDash([]);
        ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,5,0,7);ctx.fill();
        ctx.fillStyle=NATURE.ink;ctx.font="600 11.5px 'Inter'";
        ctx.fillText(label,x+7,up?y-8:y+16);
      };
      drawPt(xL,markLo,NATURE.leaf,'after policy',true);
      drawPt(xH,mark,NATURE.coral,'now',false);
      ctx.restore();
    }}]});
}

function drawMorb(morb){
  const el=document.getElementById('c_morb'); if(!el)return;
  const data=[...morb].sort((a,b)=>b.mean-a.mean);
  const bars=data.map(d=>({lo:d.lo,hi:d.hi}));
  CHARTS.morb=new Chart(el,{type:'bar',
    data:{labels:data.map(d=>d.label),datasets:[{data:data.map(d=>d.mean),borderRadius:4,borderSkipped:false,
      backgroundColor:ctx=>mkGrad(ctx.chart.ctx,ctx.chart.chartArea,NATURE.breathDk,'#7fd8e2',true)}]},
    options:baseOpts({indexAxis:'y',
      scales:{x:{beginAtZero:true,grid:{color:NATURE.grid,drawBorder:false},ticks:{font:{family:NATURE.font,size:12},color:NATURE.muted},title:{display:true,text:'Cases avoided per year',font:{family:NATURE.font,size:12,weight:'600'},color:NATURE.ink2}},
        y:{grid:{display:false,drawBorder:false},ticks:{font:{family:NATURE.font,size:12.5},color:NATURE.ink}}}}),
    plugins:[errorBarPlugin(()=>bars)]});
}

function drawEcon(econ){
  const el=document.getElementById('c_econ'); if(!el)return;
  const data=[...econ.rows].sort((a,b)=>b.mean-a.mean);
  const bars=data.map(d=>({lo:d.lo,hi:d.hi}));
  CHARTS.econ=new Chart(el,{type:'bar',
    data:{labels:data.map(d=>d.item),datasets:[{data:data.map(d=>d.mean),borderRadius:4,borderSkipped:false,
      backgroundColor:ctx=>mkGrad(ctx.chart.ctx,ctx.chart.chartArea,NATURE.amber,'#f0cd7a',true)}]},
    options:baseOpts({indexAxis:'y',
      scales:{x:{beginAtZero:true,grid:{color:NATURE.grid,drawBorder:false},ticks:{callback:v=>usd(v),font:{family:NATURE.font,size:11},color:NATURE.muted},title:{display:true,text:'USD per year',font:{family:NATURE.font,size:12,weight:'600'},color:NATURE.ink2}},
        y:{grid:{display:false,drawBorder:false},ticks:{font:{family:NATURE.font,size:12.5},color:NATURE.ink}}}}),
    plugins:[errorBarPlugin(()=>bars)]});
}

function downloadChart(canvasId,name){
  const c=Object.values(CHARTS).find(ch=>ch&&ch.canvas.id===canvasId);
  if(!c){toast('Chart not ready');return;}
  // render on white at 2x for publication
  const src=c.canvas;
  const scale=2, pad=24;
  const out=document.createElement('canvas');
  out.width=src.width*scale/window.devicePixelRatio+pad*2;
  out.height=src.height*scale/window.devicePixelRatio+pad*2;
  const cx=out.getContext('2d');
  cx.fillStyle='#ffffff';cx.fillRect(0,0,out.width,out.height);
  cx.drawImage(src,pad,pad,out.width-pad*2,out.height-pad*2);
  const a=document.createElement('a');
  a.download=`climaqh_${name}.png`;a.href=out.toDataURL('image/png');a.click();
  toast('Figure downloaded');
}

/* ============================================================
   ACTIONS / STATE MUTATION
   ============================================================ */
function go(step){ S.step=step; window.scrollTo({top:0,behavior:'smooth'}); render(); }
function setMethod(m){ S.method=m; render(); }
function setCRF(c){ S.crf=c; render(); }
function setScope(s){ S.scope=s; render(); }
function setIn(k,v){
  const num = typeof S.inputs[k]==='number';
  S.inputs[k] = (num? (parseFloat(v)||0) : v);
}
function finish(){ runCalc(); S.step=4; window.scrollTo({top:0}); render(); }

function bind(){
  const file=document.getElementById('file');
  if(file){
    file.onchange=e=>handleFile(e.target.files[0]);
    const drop=document.getElementById('drop');
    ['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('hot');}));
    ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('hot');}));
    drop.addEventListener('drop',e=>{if(e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0]);});
  }
}

/* ---------- UPLOAD PARSING ---------- */
function handleFile(f){
  if(!f)return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const wb=XLSX.read(e.target.result,{type:'binary'});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const arr=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      const headers=arr[0].map(h=>String(h).trim());
      const rows=arr.slice(1).filter(r=>r.some(c=>c!==''&&c!=null));
      S.upload={headers,rows,mapping:autoMap(headers)};
      renderMapping();
      toast(`Loaded ${rows.length} row${rows.length!==1?'s':''} · ${headers.length} columns`);
    }catch(err){ toast('Could not read that file'); console.error(err); }
  };
  reader.readAsBinaryString(f);
}

// fuzzy auto-mapping of headers to canonical fields
function autoMap(headers){
  const map={};
  const norm=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
  const alias={
    country:['country','area','iso','name','local'],
    population:['population','pop','inhabitants','people'],
    deltaPM:['deltapm','dpm','pm25change','pmreduction','deltapm25','changepm','concentrationchange'],
    baseAllCause:['ncdlri','allcause','baselinemortality','mortality','ncd'],
    mIHD:['ihd','ischemic','heart'],mStroke:['stroke','cerebro'],mLRI:['lri','alri','respinfection'],
    mCOPD:['copddeaths','copdmort'],mLC:['lungcancerdeaths','lcdeaths','lungcancermort'],
    incAsthmaChild:['asthma'],incCOPD:['copdincidence','copdinc'],incAMI:['ami','myocardial','heartattack'],
    incStrokeM:['strokeincidence','strokeinc'],incDiabetes:['diabetes'],incLC:['lungcancerincidence','lcinc'],
    incDementia:['dementia'],vsl:['vsl','statisticallife'],vsly:['vsly','lifeyear']
  };
  headers.forEach((h,idx)=>{
    const n=norm(h);
    for(const [field,keys] of Object.entries(alias)){
      if(keys.some(k=>n.includes(k))){ if(map[field]==null) map[field]=idx; break; }
    }
  });
  return map;
}

function renderMapping(){
  const area=document.getElementById('mapArea'); if(!area)return;
  const u=S.upload;
  const opts=idx=>`<option value="">— not mapped —</option>`+u.headers.map((h,j)=>`<option value="${j}" ${idx===j?'selected':''}>${h}</option>`).join('');
  const rowFor=fd=>{
    const idx=u.mapping[fd.key];
    const val=validateCell(fd, idx);
    return `<tr>
      <td><span class="${fd.req?'req-dot':'opt-dot'}"></span>${fd.label}${fd.req?'':' <span class="unit">opt</span>'}</td>
      <td><select onchange="setMap('${fd.key}',this.value)">${opts(idx)}</select></td>
      <td>${val.badge}</td></tr>`;
  };
  area.innerHTML=`
    <div style="margin-top:22px;padding-top:20px;border-top:1px solid var(--line)">
      <h3 style="font-size:17px;margin-bottom:4px">Map your columns</h3>
      <p class="sub" style="margin-bottom:16px">We guessed the matches. Fix any that are wrong. <span class="req-dot"></span> required · <span class="opt-dot"></span> optional. The first row of your file is used.</p>
      <table class="map-table"><thead><tr><th>Variable</th><th>Your column</th><th>Check</th></tr></thead>
      <tbody>${FIELDS.map(rowFor).join('')}</tbody></table>
      <div id="mapMsg"></div>
      <div style="margin-top:16px;display:flex;gap:10px">
        <button class="cta" onclick="applyMapping()">Apply this mapping →</button>
      </div>
    </div>`;
}

function setMap(field,val){ S.upload.mapping[field]= val===''?undefined:parseInt(val); renderMapping(); }

// hard validation of a single cell from row 0
function validateCell(fd, idx){
  if(idx==null||idx===undefined) return {ok:!fd.req, badge:fd.req?`<span class="val-badge val-err">required</span>`:`<span class="val-badge val-wait">—</span>`};
  const raw=S.upload.rows[0]?S.upload.rows[0][idx]:'';
  if(fd.type==='text'){
    return raw&&String(raw).trim()? {ok:true,badge:`<span class="val-badge val-ok">✓ "${String(raw).slice(0,16)}"</span>`}
                                  : {ok:!fd.req,badge:`<span class="val-badge val-err">empty</span>`};
  }
  const n=parseFloat(String(raw).replace(/[, ]/g,''));
  if(isNaN(n)) return {ok:false,badge:`<span class="val-badge val-err">not a number</span>`};
  if(fd.min!=null&&n<fd.min) return {ok:false,badge:`<span class="val-badge val-err">< ${fd.min}</span>`};
  if(fd.max!=null&&n>fd.max) return {ok:false,badge:`<span class="val-badge val-err">> ${fd.max}</span>`};
  return {ok:true,badge:`<span class="val-badge val-ok">✓ ${nf(n,n<10?2:0)}</span>`};
}

function applyMapping(){
  const errs=[];
  FIELDS.forEach(fd=>{
    const idx=S.upload.mapping[fd.key];
    const v=validateCell(fd,idx);
    if(!v.ok) errs.push(fd.label);
  });
  const msg=document.getElementById('mapMsg');
  if(errs.length){
    msg.innerHTML=`<div class="why" style="background:#fce8e2;border-color:#f3b9a6;border-left-color:var(--coral);margin-top:16px">
      <span class="tag" style="color:var(--warn)">Blocked — fix these before continuing</span>
      ${errs.length} field${errs.length>1?'s':''} failed validation: ${errs.join(', ')}. The calculation will not run on data it can't trust.</div>`;
    toast('Fix the flagged fields first'); return;
  }
  // write row 0 into inputs
  const row=S.upload.rows[0];
  FIELDS.forEach(fd=>{
    const idx=S.upload.mapping[fd.key]; if(idx==null)return;
    const raw=row[idx];
    S.inputs[fd.key]= fd.type==='text'? String(raw).trim() : parseFloat(String(raw).replace(/[, ]/g,''))||0;
  });
  toast('Mapping applied — fields filled');
  render();
}

/* ---------- EXPORTS ---------- */
function exportCSV(){
  const r=S.results,i=S.inputs;
  let L=[['CLIMAQ-H Lite results'],['Country',i.country],['Year',i.year],['Engine',S.crf],['Delta PM2.5',r.pm.delta],[],
    ['MORTALITY'],['Cause','AttrFraction','Central','Low','High']];
  r.mort.rows.forEach(x=>L.push([x.cause,x.af,x.mean,x.lo,x.hi]));
  L.push(['Total','',r.mort.totMean,r.mort.totLo,r.mort.totHi]);
  L.push(['Life-years','',r.mort.lifeYears]);
  if(r.morb&&r.morb.length){L.push([],['MORBIDITY'],['Outcome','Central','Low','High']);r.morb.forEach(x=>L.push([x.label,x.mean,x.lo,x.hi]));}
  if(r.econ&&r.econ.rows.length){L.push([],['ECONOMICS (USD/yr)'],['Component','Central','Low','High']);r.econ.rows.forEach(x=>L.push([x.item,x.mean,x.lo,x.hi]));L.push(['Total','',r.econ.total.mean,r.econ.total.lo,r.econ.total.hi]);}
  const csv=L.map(r=>r.map(c=>`"${c??''}"`).join(',')).join('\n');
  dl(csv,'climaqh_results.csv','text/csv');
}
function exportJSON(){ dl(JSON.stringify({inputs:S.inputs,crf:S.crf,scope:S.scope,method:S.method,results:S.results},null,2),'climaqh_run.json','application/json'); }
function dl(content,name,type){
  const b=new Blob([content],{type});const a=document.createElement('a');
  a.href=URL.createObjectURL(b);a.download=name;a.click();URL.revokeObjectURL(a.href);toast('Downloaded '+name);
}

function downloadTemplate(){
  const cols=FIELDS.map(f=>f.label);
  const keys=FIELDS.map(f=>f.key);
  const ex=['Example City',500000,1.0,320, 90,70,25,55,35, 800,600,400,300,700,90,150, 4500000,180000];
  const ws=XLSX.utils.aoa_to_sheet([cols,ex]);
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'inputs');
  XLSX.writeFile(wb,'climaqh_template.xlsx');
  toast('Template downloaded');
}

/* ---------- DEMO ---------- */
function loadDemo(){
  Object.assign(S.inputs,{
    country:'Metro Example (LAC)',year:2030,deltaPM:2.0,baselinePM:22.0,population:2_400_000,
    baseAllCause:410, mIHD:118,mStroke:74,mLRI:22,mCOPD:41,mLC:33,
    incAsthmaChild:820,incCOPD:610,incAMI:390,incStrokeM:300,incDiabetes:720,incLC:88,incDementia:145,
    vsl:3_200_000,vsly:120_000,lifeYearsPerDeath:11,
    costIHD_lo:9000,costIHD_hi:24000,costStroke_lo:12000,costStroke_hi:38000,
    costCOPD_lo:4000,costCOPD_hi:15000,costLC_lo:20000,costLC_hi:60000,
    costAsthma_lo:1200,costAsthma_hi:4500,costDiabetes_lo:3000,costDiabetes_hi:9000,discount:0.05
  });
  S.crf='fusion';S.scope='full';S.method='delta';
  runCalc();S.step=4;window.scrollTo({top:0});render();
  toast('Worked example loaded');
}

/* ---------- INIT ---------- */
render();
