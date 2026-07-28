// ── PART 1: Constants, State, Utilities ───────────────────────────────────────

const API = {
  daily:      '/daily',
  dates:      '/daily-dates',
  history:    '/history',
  state:      '/state',
  resetToday: '/reset-today',
};
const REFRESH_MS   = 3000;
const TREND_DAYS   = 14;
const PALETTE      = ['#6366f1','#10b981','#f59e0b','#06b6d4','#ec4899','#8b5cf6','#ef4444','#3b82f6','#84cc16','#f97316'];

const state = {
  tab:            'today',
  todayDate:      '',
  selectedDate:   '',
  dates:          [],
  trendRows:      [],
  todayStats:     null,
  selectedStats:  null,
  allDayStats:    new Map(),   // date → normalizeStats result
  expandedKeys:   new Set(),
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const q  = id => document.getElementById(id);
const el = (tag, cls, text) => { const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; };

// ── Time formatting ───────────────────────────────────────────────────────────
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(Number(sec)||0));
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  if(h>0) return `${h}h ${m}m`;
  if(m>0) return `${m}m ${s}s`;
  return `${s}s`;
}
function fmtDurLong(sec) {
  sec = Math.max(0, Math.floor(Number(sec)||0));
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  if(h>0) return `${h}h ${m}m ${s}s`;
  if(m>0) return `${m}m ${s}s`;
  return `${s}s`;
}
function shortLabel(name, max=22) {
  const v = String(name||'Unknown');
  return v.length <= max ? v : v.slice(0,max-1)+'…';
}
function safeNum(v) { const n=Number(v); return Number.isFinite(n)&&n>=0?n:0; }

function localIso() {
  const d=new Date(), y=d.getFullYear(),
        m=String(d.getMonth()+1).padStart(2,'0'),
        day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function isoToDate(s) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y,m,d]=s.split('-').map(Number);
  return new Date(y,m-1,d);
}
function dateToIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function formatDateLabel(iso, todayIso) {
  const dt = isoToDate(iso); if(!dt) return iso;
  const wd = dt.toLocaleDateString(undefined,{weekday:'short'});
  const [y,m,d] = iso.split('-');
  const s = `${wd} ${d}/${m}/${y}`;
  return iso===todayIso ? `${s} (Today)` : s;
}

// ── Browser detection ─────────────────────────────────────────────────────────
function isBrowser(name) {
  const l=String(name||'').toLowerCase();
  return l.includes('brave')||l.includes('chrome')||l.includes('chromium')||l.includes('firefox')||l.includes('edge');
}

// ── Status bar ────────────────────────────────────────────────────────────────
function setStatus(msg) {
  const el=q('status'); if(!el) return;
  el.textContent = msg||'';
  el.className   = msg ? 'show' : '';
}
// ── PART 2: Data Fetching & Normalization ──────────────────────────────────────

async function fetchJson(url) {
  const r = await fetch(url, {cache:'no-store'});
  if(!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

function normStats(raw) {
  const appsObj = raw&&typeof raw==='object' ? raw.apps : null;
  const rows = [];
  if(appsObj && typeof appsObj==='object') {
    for(const [name, entry] of Object.entries(appsObj)) {
      if(!name) continue;
      const e = entry&&typeof entry==='object' ? entry : {};
      const childObj = e.children&&typeof e.children==='object' ? e.children : {};
      const children = isBrowser(name)
        ? Object.entries(childObj)
            .map(([n,s])=>({name:n, seconds:safeNum(s)}))
            .filter(c=>c.name&&c.seconds>0)
            .sort((a,b)=>b.seconds-a.seconds)
        : [];
      const childTotal = children.reduce((s,c)=>s+c.seconds,0);
      const total = Math.max(safeNum(e.total), childTotal);
      if(!name||total<=0) continue;
      rows.push({name, total, children});
    }
  }
  rows.sort((a,b)=>b.total-a.total);
  const totalSeconds = rows.reduce((s,r)=>s+r.total,0);
  // aggregate domains
  const domMap = new Map();
  for(const r of rows)
    for(const c of r.children)
      domMap.set(c.name, (domMap.get(c.name)||0)+c.seconds);
  const domains = [...domMap.entries()]
    .map(([name,seconds])=>({name,seconds}))
    .sort((a,b)=>b.seconds-a.seconds);
  return {apps:rows, totalSeconds, domains};
}

function normDateList(raw) {
  if(!raw||!Array.isArray(raw.dates)) return [];
  return [...new Set(raw.dates.filter(v=>/^\d{4}-\d{2}-\d{2}$/.test(v)))].sort();
}

function buildRecentWindow(todayIso, n=14) {
  const base = isoToDate(todayIso)||new Date();
  const out = [];
  for(let i=n-1;i>=0;i--) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate()-i);
    out.push(dateToIso(d));
  }
  return out;
}

function computeStreak(dates, todayIso) {
  const set = new Set(dates);
  let streak = 0, cur = isoToDate(todayIso)||new Date();
  while(true) {
    const iso = dateToIso(cur);
    if(!set.has(iso)) break;
    streak++;
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate()-1);
  }
  return streak;
}

async function loadDashboard() {
  const [todayRaw, dateRaw, histRaw] = await Promise.all([
    fetchJson(`${API.daily}?date=today`),
    fetchJson(API.dates),
    fetchJson(API.history).catch(()=>null),
  ]);

  const todayIso   = (todayRaw&&typeof todayRaw.date==='string') ? todayRaw.date : localIso();
  const todayStats = normStats(todayRaw);
  const dateList   = [...new Set([todayIso, ...normDateList(dateRaw)])].sort();

  let selDate = state.selectedDate;
  if(!selDate||!dateList.includes(selDate)) selDate = todayIso;

  const selRaw  = selDate===todayIso ? todayRaw
    : await fetchJson(`${API.daily}?date=${encodeURIComponent(selDate)}`);
  const selStats = normStats(selRaw);

  // Trend: last TREND_DAYS from recent window
  const window14 = buildRecentWindow(todayIso, TREND_DAYS);
  const allNeeded = [...new Set([...window14, ...dateList.slice(-TREND_DAYS)])].sort().slice(-TREND_DAYS);

  // Fetch missing days
  const fetches = await Promise.all(
    allNeeded.map(d =>
      state.allDayStats.has(d)
        ? Promise.resolve(null)
        : fetchJson(`${API.daily}?date=${encodeURIComponent(d)}`).catch(()=>null)
    )
  );
  allNeeded.forEach((d,i)=>{ if(fetches[i]!=null) state.allDayStats.set(d, normStats(fetches[i])); });

  const trendRows = window14.map(d=>({
    date:d,
    totalSeconds: state.allDayStats.has(d) ? state.allDayStats.get(d).totalSeconds : 0,
    apps: state.allDayStats.has(d) ? state.allDayStats.get(d).apps : [],
  }));

  const streak  = computeStreak(dateList, todayIso);
  const nowApp  = histRaw&&typeof histRaw.currentApp==='string' ? histRaw.currentApp : null;
  const nowDomain = histRaw&&typeof histRaw.currentDomain==='string'&&histRaw.currentDomain ? histRaw.currentDomain : null;

  return {todayIso, todayStats, selDate, selStats, dateList, trendRows, streak, nowApp, nowDomain};
}
// ── PART 3: Chart Renderers ────────────────────────────────────────────────────

// ── Donut SVG ─────────────────────────────────────────────────────────────────
function buildDonut(svgEl, items, totalSec, cx, cy, r, thickness) {
  svgEl.innerHTML = '';
  const W = cx*2, H = cy*2;
  svgEl.setAttribute('viewBox',`0 0 ${W} ${H}`);

  // Background ring
  const bg = document.createElementNS('http://www.w3.org/2000/svg','circle');
  bg.setAttribute('cx',cx); bg.setAttribute('cy',cy); bg.setAttribute('r',r);
  bg.setAttribute('fill','none'); bg.setAttribute('stroke','#1e293b'); bg.setAttribute('stroke-width',thickness);
  svgEl.appendChild(bg);

  if(!items.length||totalSec<=0) return;

  const circ = 2*Math.PI*r;
  let offset = -circ/4; // start from top

  items.slice(0,8).forEach((item,i)=>{
    const frac = item.seconds/totalSec;
    const dash  = frac*circ;
    const gap   = circ - dash;
    const arc = document.createElementNS('http://www.w3.org/2000/svg','circle');
    arc.setAttribute('cx',cx); arc.setAttribute('cy',cy); arc.setAttribute('r',r);
    arc.setAttribute('fill','none');
    arc.setAttribute('stroke', PALETTE[i%PALETTE.length]);
    arc.setAttribute('stroke-width', thickness);
    arc.setAttribute('stroke-dasharray', `${dash} ${gap}`);
    arc.setAttribute('stroke-dashoffset', -offset);
    arc.setAttribute('stroke-linecap','butt');
    arc.style.transition='stroke-dasharray 500ms ease';
    svgEl.appendChild(arc);
    offset += dash;
  });
}

function renderDonut(svgId, centerId, valId, legendId, items, totalSec, label) {
  const svg = q(svgId); if(!svg) return;
  const dim = svg.clientWidth||170;
  const cx=dim/2, cy=dim/2, r=cx*0.72, t=cx*0.22;
  buildDonut(svg, items, totalSec, cx, cy, r, t);

  const center = q(centerId); if(center) {
    center.style.cssText = `position:absolute;text-align:center;width:${dim*0.54}px;left:50%;top:50%;transform:translate(-50%,-50%)`;
  }
  const valEl = q(valId); if(valEl) valEl.textContent = fmtDur(totalSec);

  const leg = q(legendId); if(!leg) return;
  leg.innerHTML='';
  items.slice(0,6).forEach((item,i)=>{
    const pct = totalSec>0 ? Math.round(item.seconds/totalSec*100) : 0;
    const row = el('div','legend-row');
    const sw  = el('div','legend-swatch'); sw.style.background=PALETTE[i%PALETTE.length];
    const nm  = el('span','legend-name'); nm.textContent=shortLabel(item.name,18); nm.title=item.name;
    const vl  = el('span','legend-val'); vl.textContent=`${fmtDur(item.seconds)} · ${pct}%`;
    row.append(sw,nm,vl); leg.appendChild(row);
  });
}

// ── App list ──────────────────────────────────────────────────────────────────
function renderAppList(listId, emptyId, apps, totalSec) {
  const list = q(listId); if(!list) return;
  list.innerHTML='';
  const empty = q(emptyId);
  if(!apps.length){ if(empty) empty.hidden=false; return; }
  if(empty) empty.hidden=true;

  apps.slice(0,10).forEach((app,i)=>{
    const pct = totalSec>0 ? Math.round(app.total/totalSec*100) : 0;
    const w   = totalSec>0 ? Math.max(3, Math.round(app.total/totalSec*100)) : 0;
    const row = el('div','app-row');

    const rank = el('span','app-rank', i+1);
    const name = el('span','app-name'); name.textContent=shortLabel(app.name,20); name.title=app.name;

    const barWrap = el('div','app-bar-wrap');
    const fill    = el('div','app-bar-fill');
    fill.style.width=`${w}%`;
    fill.style.background=`linear-gradient(90deg,${PALETTE[i%PALETTE.length]}cc,${PALETTE[i%PALETTE.length]})`;
    barWrap.appendChild(fill);

    const time = el('span','app-time', fmtDurLong(app.total));
    const pctEl= el('span','app-pct',  `${pct}%`);

    row.append(rank, name, barWrap, time, pctEl);

    // expandable browser children
    if(app.children&&app.children.length) {
      row.style.cursor='pointer';
      const key = `${state.selectedDate}::${app.name}`;
      const togIcon = el('span','',''); togIcon.style.cssText='font-size:0.7rem;color:var(--muted);margin-left:4px';
      togIcon.textContent = state.expandedKeys.has(key)?'▾':'▸';
      name.appendChild(togIcon);

      const childWrap = el('div','');
      childWrap.style.cssText='padding:4px 0 0 28px;display:flex;flex-direction:column;gap:3px';
      childWrap.hidden = !state.expandedKeys.has(key);

      app.children.slice(0,5).forEach(c=>{
        const cr = el('div','');
        cr.style.cssText='display:flex;justify-content:space-between;font-size:0.73rem;color:var(--muted2)';
        const cn = el('span',''); cn.textContent=`↳ ${shortLabel(c.name,22)}`; cn.title=c.name;
        const cv = el('span',''); cv.textContent=fmtDur(c.seconds);
        cr.append(cn,cv); childWrap.appendChild(cr);
      });

      const wrapper = el('div','');
      wrapper.append(row, childWrap);

      row.addEventListener('click',()=>{
        if(state.expandedKeys.has(key)) state.expandedKeys.delete(key);
        else state.expandedKeys.add(key);
        renderSelectedDay();
      });
      list.appendChild(wrapper);
    } else {
      list.appendChild(row);
    }
  });
}

// ── Trend bars ────────────────────────────────────────────────────────────────
function renderTrend(rows) {
  const wrap = q('trendBars'); if(!wrap) return;
  wrap.innerHTML='';
  const emp = q('trendEmpty');
  const sub = q('trendSubtitle');

  const nonZero = rows.filter(r=>r.totalSeconds>0);
  if(!nonZero.length){ if(emp) emp.hidden=false; if(sub) sub.textContent=''; return; }
  if(emp) emp.hidden=true;

  const maxSec = Math.max(...rows.map(r=>r.totalSeconds), 1);
  const avg    = Math.round(nonZero.reduce((s,r)=>s+r.totalSeconds,0)/nonZero.length);
  if(sub) sub.textContent = `avg ${fmtDur(avg)}/day · scale ${fmtDur(maxSec)} max`;

  rows.forEach((row,i)=>{
    const col = el('div','trend-col');
    if(row.date===state.selectedDate) col.classList.add('active');
    col.title=`${row.date}: ${fmtDurLong(row.totalSeconds)}`;
    col.addEventListener('click',()=>{
      if(state.dates.includes(row.date)) {
        state.selectedDate=row.date;
        refreshDashboard();
      }
    });

    const valLbl = el('div','trend-col-val', row.totalSeconds>0?fmtDur(row.totalSeconds):'');
    const track  = el('div','trend-bar-track');
    const fill   = el('div','trend-bar-fill');
    const pct    = Math.max(row.totalSeconds>0?4:0, Math.round(row.totalSeconds/maxSec*100));
    fill.style.height=`${pct}%`;
    fill.style.background = row.date===state.todayDate
      ? `linear-gradient(0deg,${PALETTE[0]},${PALETTE[1]})`
      : `linear-gradient(0deg,${PALETTE[0]}88,${PALETTE[0]}cc)`;
    track.appendChild(fill);

    const dateLbl = el('div','trend-col-date', row.date.slice(5));
    col.append(valLbl, track, dateLbl);
    wrap.appendChild(col);
  });
}

// ── Hourly heatmap ────────────────────────────────────────────────────────────
function renderHeatmap(apps) {
  const wrap = q('heatmap'); if(!wrap) return;
  wrap.innerHTML='';

  // Build synthetic hourly data from today's app usage
  // We estimate by distributing time across hours proportionally
  // (real hourly data requires server support; this is a best-effort estimate)
  const now   = new Date();
  const curH  = now.getHours();
  const total = apps.reduce((s,a)=>s+a.total,0);
  const bins  = new Array(24).fill(0);

  if(total>0) {
    // Distribute sessions assuming typical 9am-8pm work pattern weighted by app time
    const weights = new Array(24).fill(0).map((_,h)=>{
      if(state.selectedDate!==state.todayDate) {
        // for past days spread 8am-10pm
        if(h<8||h>22) return 0.05;
        return 1 + Math.sin((h-8)/14*Math.PI)*0.5;
      }
      // for today only up to current hour
      if(h>curH) return 0;
      if(h<7) return 0.05;
      return 1 + Math.sin((h-7)/Math.max(1,curH-7)*Math.PI)*0.5;
    });
    const wSum = weights.reduce((s,w)=>s+w,0)||1;
    for(let h=0;h<24;h++) bins[h]=Math.round(total*weights[h]/wSum);
  }

  const maxBin = Math.max(...bins,1);
  const levels = [0,0.2,0.4,0.65,1.0];
  const colors = ['#1e293b','#312e81','#4338ca','#6366f1','#a5b4fc'];

  for(let h=0;h<24;h++){
    const col   = el('div','heat-col');
    const cell  = el('div','heat-cell');
    const frac  = bins[h]/maxBin;
    const ci    = levels.findIndex(l=>frac<=l);
    cell.style.background = colors[Math.max(0,ci<0?colors.length-1:ci-1)];
    cell.title=`${String(h).padStart(2,'0')}:00 — ${fmtDur(bins[h])}`;
    if(h===curH&&state.selectedDate===state.todayDate)
      cell.style.outline='2px solid var(--cyan)';
    col.appendChild(cell);
    wrap.appendChild(col);
  }

  // scale legend
  const scale = q('heatScale'); if(!scale) return;
  scale.innerHTML='';
  colors.forEach(c=>{ const d=el('div',''); d.style.cssText=`width:12px;height:12px;border-radius:3px;background:${c}`; scale.appendChild(d); });
}
// ── PART 4: Metrics, Sites, Tab Switching ─────────────────────────────────────

// ── Metrics row ───────────────────────────────────────────────────────────────
function renderMetrics(todaySt, streak, nowApp, nowDomain) {
  const t = todaySt.totalSeconds;
  const top = todaySt.apps[0]||null;
  const webSec = todaySt.domains.reduce((s,d)=>s+d.seconds,0);
  const webPct = t>0?Math.round(webSec/t*100):0;

  q('mTotal').textContent        = fmtDurLong(t);
  q('mTotalSub').textContent     = t>0 ? `${todaySt.apps.length} app${todaySt.apps.length!==1?'s':''} tracked` : 'No activity yet';
  q('mTopApp').textContent       = top ? shortLabel(top.name,14) : '—';
  q('mTopAppTime').textContent   = top ? fmtDurLong(top.total)   : 'Nothing yet';
  q('mWebShare').textContent     = `${webPct}%`;
  q('mWebTime').textContent      = webSec>0?`${fmtDur(webSec)} on the web`:'No web time';
  q('mApps').textContent         = String(todaySt.apps.length);
  q('mSites').textContent        = `${todaySt.domains.length} site${todaySt.domains.length!==1?'s':''} visited`;
  q('mStreak').textContent       = String(streak);

  // Live now badge
  const badge = q('nowBadge'), nowEl = q('nowApp');
  if(nowApp) {
    const label = nowDomain||shortLabel(nowApp,18);
    if(nowEl) nowEl.textContent = label;
    if(badge) badge.classList.add('show');
  } else {
    if(badge) badge.classList.remove('show');
  }

  q('lastUpdate').textContent = `Updated ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
}

// ── Date navigator ────────────────────────────────────────────────────────────
function renderDateNav() {
  const lbl  = q('selectedDateLabel');
  const prev = q('prevDateBtn');
  const next = q('nextDateBtn');
  if(!lbl||!prev||!next) return;

  const idx = state.dates.indexOf(state.selectedDate);
  lbl.textContent  = formatDateLabel(state.selectedDate, state.todayDate);
  prev.disabled    = idx<=0;
  next.disabled    = idx<0||idx>=state.dates.length-1;
}

// ── Selected day section ──────────────────────────────────────────────────────
function renderSelectedDay() {
  if(!state.selectedStats) return;
  const st = state.selectedStats;

  renderAppList('appList','appListEmpty', st.apps, st.totalSeconds);
  renderDonut('donutSvg','donutCenter','donutVal','donutLegend',
    st.apps.slice(0,8).map(a=>({name:a.name,seconds:a.total})),
    st.totalSeconds, 'total');
  renderHeatmap(st.apps);
  renderDateNav();
}

// ── Sites page ────────────────────────────────────────────────────────────────
function renderSites(todaySt) {
  const domains = todaySt.domains;
  const total   = domains.reduce((s,d)=>s+d.seconds,0);

  renderAppList('siteList','siteEmpty', domains.map(d=>({name:d.name,total:d.seconds,children:[]})), total);
  renderDonut('siteDonutSvg','siteDonutCenter','siteDonutVal','siteLegend',
    domains.slice(0,8), total, 'web total');
}

// ── Insights page ─────────────────────────────────────────────────────────────
function renderInsights(todaySt, dateList, trendRows, streak) {
  renderFocusScore(todaySt);
  renderSessionStats(todaySt, trendRows);
  renderStreakGrid(dateList, streak);
}

function renderFocusScore(st) {
  // Focus score: higher if fewer apps with more time per app
  const apps = st.apps;
  if(!apps.length) { q('focusScoreVal').textContent='—'; return; }
  const totalSec = st.totalSeconds;
  const topSec   = apps[0]?.total||0;
  const focusFrac= totalSec>0 ? topSec/totalSec : 0;
  // Penalise many context switches (many apps = lower score)
  const diversity = Math.min(1, apps.length/10);
  const score     = Math.round(Math.max(0, Math.min(100, focusFrac*100*(1-diversity*0.4))));

  const scoreEl = q('focusScoreVal');
  scoreEl.textContent = score;
  scoreEl.style.color = score>=70?'var(--green)':score>=40?'var(--amber)':'var(--red)';
  const bar = q('focusScoreBar');
  if(bar){ bar.style.width=`${score}%`; bar.style.background=score>=70?'linear-gradient(90deg,var(--green),var(--cyan))':score>=40?'linear-gradient(90deg,var(--amber),var(--red))':'linear-gradient(90deg,var(--red),var(--pink))'; }

  const bd = q('focusBreakdown'); if(!bd) return;
  bd.innerHTML='';
  const items=[
    ['Top app share', `${Math.round(focusFrac*100)}%`],
    ['Apps used',     `${apps.length}`],
    ['Total screen',  fmtDurLong(st.totalSeconds)],
    ['Focus rating',  score>=70?'High 🟢':score>=40?'Medium 🟡':'Low 🔴'],
  ];
  items.forEach(([label,val])=>{
    const row = el('div','score-item');
    const l   = el('span','score-item-label',label);
    const v   = el('span','score-item-val',val);
    row.append(l,v); bd.appendChild(row);
  });
}

function renderSessionStats(st, trendRows) {
  const el2 = q('sessionStats'); if(!el2) return;
  el2.innerHTML='';
  const nonZero = trendRows.filter(r=>r.totalSeconds>0);
  const avg     = nonZero.length ? Math.round(nonZero.reduce((s,r)=>s+r.totalSeconds,0)/nonZero.length) : 0;
  const max     = nonZero.length ? Math.max(...nonZero.map(r=>r.totalSeconds)) : 0;
  const maxDay  = nonZero.find(r=>r.totalSeconds===max);
  const items   = [
    ['Today total',   fmtDurLong(st.totalSeconds)],
    ['14-day avg',    avg?fmtDur(avg):'—'],
    ['Best day',      max?fmtDur(max):'—'],
    ['Best date',     maxDay?maxDay.date:'—'],
    ['Active apps',   `${st.apps.length}`],
    ['Sites visited', `${st.domains.length}`],
    ['Days tracked',  `${nonZero.length}`],
  ];
  items.forEach(([label,val])=>{
    const row = el('div','score-item');
    const l   = el('span','score-item-label',label);
    const v   = el('span','score-item-val',val);
    row.append(l,v); el2.appendChild(row);
  });
}

function renderStreakGrid(dateList, streak) {
  const grid = q('streakGrid'); if(!grid) return;
  grid.innerHTML='';
  const set  = new Set(dateList);
  const today= isoToDate(state.todayDate)||new Date();
  const CELLS= 28; // 4 weeks
  for(let i=CELLS-1;i>=0;i--) {
    const d    = new Date(today.getFullYear(),today.getMonth(),today.getDate()-i);
    const iso  = dateToIso(d);
    const cell = el('div','streak-cell');
    if(set.has(iso)) cell.classList.add('has-data');
    if(iso===state.todayDate) cell.classList.add('today');
    const st2 = state.allDayStats.get(iso);
    cell.title = iso + (st2?` — ${fmtDur(st2.totalSeconds)}`:'');
    if(set.has(iso)) {
      cell.style.background = '#312e81';
      cell.style.color      = '#a5b4fc';
      const t2 = st2?st2.totalSeconds:0;
      const intensity = Math.min(1, t2/(6*3600));
      cell.style.background = `hsl(239,${Math.round(50+intensity*50)}%,${Math.round(20+intensity*20)}%)`;
    }
    cell.textContent = String(d.getDate());
    grid.appendChild(cell);
  }

  const ss = q('streakStats'); if(!ss) return;
  ss.innerHTML='';
  const st2Items=[
    ['Current streak',  `${streak} day${streak!==1?'s':''} 🔥`],
    ['Total days',      `${dateList.length}`],
  ];
  st2Items.forEach(([label,val])=>{
    const row = el('div','score-item');
    row.append(el('span','score-item-label',label), el('span','score-item-val',val));
    ss.appendChild(row);
  });
}

// ── History page ──────────────────────────────────────────────────────────────
function renderHistory(dateList) {
  const list = q('historyList'); if(!list) return;
  list.innerHTML='';
  [...dateList].reverse().forEach(d=>{
    const st2 = state.allDayStats.get(d);
    const row = el('div','');
    row.style.cssText='display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--surface2);border-radius:10px;cursor:pointer;transition:background 150ms';
    row.onmouseenter=()=>row.style.background='var(--surface3)';
    row.onmouseleave=()=>row.style.background='var(--surface2)';
    const label = el('span',''); label.textContent=formatDateLabel(d,state.todayDate); label.style.fontWeight='500';
    const val   = el('span',''); val.textContent=st2?fmtDurLong(st2.totalSeconds):'No data'; val.style.cssText='font-size:0.8rem;color:var(--muted2)';
    row.append(label,val);
    row.addEventListener('click',()=>{ state.selectedDate=d; switchTab('today'); refreshDashboard(); });
    list.appendChild(row);
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));
  document.querySelectorAll('.page').forEach(p=>{
    p.classList.toggle('active', p.id===`page${tab.charAt(0).toUpperCase()+tab.slice(1)}`);
  });
}
// ── PART 5: Main refresh loop & event setup ────────────────────────────────────

async function refreshDashboard() {
  try {
    const data = await loadDashboard();

    state.todayDate    = data.todayIso;
    state.selectedDate = data.selDate;
    state.dates        = data.dateList;
    state.trendRows    = data.trendRows;
    state.todayStats   = data.todayStats;
    state.selectedStats= data.selStats;

    renderMetrics(data.todayStats, data.streak, data.nowApp, data.nowDomain);
    renderSelectedDay();
    renderTrend(data.trendRows);

    if(state.tab==='sites')    renderSites(data.todayStats);
    if(state.tab==='insights') renderInsights(data.todayStats, data.dateList, data.trendRows, data.streak);
    if(state.tab==='history')  renderHistory(data.dateList);

    setStatus('');
  } catch(err) {
    console.error('[Dashboard]', err);
    setStatus('⚠ Cannot reach local server. Make sure the extension server is running.');
  }
}

function setup() {
  // Tab buttons
  document.querySelectorAll('.tab').forEach(t=>{
    t.addEventListener('click',()=>{
      switchTab(t.dataset.tab);
      // Render page-specific content on switch
      if(t.dataset.tab==='sites'    && state.todayStats)  renderSites(state.todayStats);
      if(t.dataset.tab==='insights' && state.todayStats)
        renderInsights(state.todayStats, state.dates, state.trendRows,
          computeStreak(state.dates, state.todayDate));
      if(t.dataset.tab==='history')                        renderHistory(state.dates);
    });
  });

  // Refresh button
  q('refreshBtn')?.addEventListener('click', refreshDashboard);

  // Reset today
  q('resetBtn')?.addEventListener('click', async()=>{
    if(!confirm('Reset all usage data for today?')) return;
    try {
      await fetch(API.resetToday,{method:'POST'});
      state.allDayStats.delete(state.todayDate);
      await refreshDashboard();
    } catch(e) { setStatus('Reset failed: '+e.message); }
  });

  // Date navigator
  q('prevDateBtn')?.addEventListener('click',()=>{
    const idx = state.dates.indexOf(state.selectedDate);
    if(idx>0){ state.selectedDate=state.dates[idx-1]; refreshDashboard(); }
  });
  q('nextDateBtn')?.addEventListener('click',()=>{
    const idx = state.dates.indexOf(state.selectedDate);
    if(idx>=0&&idx<state.dates.length-1){ state.selectedDate=state.dates[idx+1]; refreshDashboard(); }
  });

  // Initial load
  refreshDashboard();

  // Auto refresh every 3 seconds
  setInterval(refreshDashboard, REFRESH_MS);
}

setup();
