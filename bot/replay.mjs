// Replays the server bot over past days as if it had been running every 15 minutes:
// same engine (index.html), same entry rules and trade management as bot/run.mjs, $1000 demo start.
// Usage: node bot/replay.mjs [startISO]   (default 2026-10-15T00:00Z)
import fs from 'fs';

const CFG = Object.assign({risk:1, maxPos:5, dayLoss:3, minScore:9, adxMin:20, tfs:['4h', '1h'], coins:30, startBalance:1000, waitBars:48},
  JSON.parse(fs.readFileSync('config.json', 'utf8')));
const START = Date.parse(process.argv[2] || '2026-10-15T00:00:00Z'), END = Date.now();
const FEE_T = 0.00045, FEE_M = 0.00015;
const TFMS = {'5m':3e5, '15m':9e5, '1h':36e5, '4h':144e5, '1d':864e5, '1w':6048e5};
const HTF = {'15m':'1h', '1h':'4h', '4h':'1d', '1d':'1w'};
const TFLABEL = {'15m':'15m', '1h':'1h', '4h':'4h', '1d':'1D', '1w':'1W'};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let NOW = START; const CLOCK = () => NOW;
const out = []; const say = (...a) => { const l = `[${new Date(NOW).toISOString().slice(5, 16).replace('T', ' ')}] ${a.join(' ')}`; out.push(l); };

/* engine from the app */
const html = fs.readFileSync('index.html', 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/<\/?script>/g, '');
const E = new Function('TFMS', 'HTF', 'TFLABEL', 'tr', 'fmt', 'document', 'S', 'state',
  js.slice(js.indexOf('function ema('), js.indexOf('\nfunction composeCall(')) + '\nreturn {analyze, bestCall, htfBias, tfBonus};')(TFMS, HTF, TFLABEL, en => en, x => String(x), {addEventListener(){}}, () => ({}), {});
function resample(C, ms){
  const r = [];
  for(const c of C){ const t = Math.floor(c.t / ms) * ms, l = r[r.length - 1];
    if(l && l.t === t){ l.h = Math.max(l.h, c.h); l.l = Math.min(l.l, c.l); l.c = c.c; l.v += c.v; } else r.push({...c, t}); }
  return r;
}

/* demo account: the exact functions from bot/run.mjs, with the clock replaced by replay time */
const src = fs.readFileSync('bot/run.mjs', 'utf8');
const sec = src.slice(src.indexOf('function fillLeg('), src.indexOf('/* ---------- Hyperliquid TESTNET mirror')).replace(/Date\.now\(\)/g, 'CLOCK()');
const S = {start:CFG.startBalance, balance:CFG.startBalance, brackets:[], history:[]};
const A = new Function('S', 'FEE_T', 'FEE_M', 'say', 'CLOCK', 'tgSay', 'CFG', sec + '\nreturn {fillLeg, step, equityNow, lastPx};')(S, FEE_T, FEE_M, say, CLOCK, () => {}, CFG);

/* data */
let last = 0;
async function info(body){
  for(let i = 0; i < 6; i++){
    const w = 1500 - (Date.now() - last); if(w > 0) await sleep(w); last = Date.now();
    const r = await fetch('https://api.hyperliquid.xyz/info', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if(r.status === 429){ await sleep(8000 * (i + 1)); continue; }
    if(!r.ok) throw new Error('HTTP ' + r.status); return r.json();
  }
  throw new Error('rate limited');
}
const snap = async (coin, tf, from) => (await info({type:'candleSnapshot', req:{coin, interval:tf, startTime:from, endTime:END}})).map(k => ({t:k.t, o:+k.o, h:+k.h, l:+k.l, c:+k.c, v:+k.v}));
const [meta, ctxs] = await info({type:'metaAndAssetCtxs'});
const top = meta.universe.map((u, i) => ({name:u.name, dl:u.isDelisted, vol:+ctxs[i].dayNtlVlm, funding:+ctxs[i].funding})).filter(x => !x.dl).sort((a, b) => b.vol - a.vol).slice(0, CFG.coins);
if(!top.some(c => c.name === 'BTC')) top.push({name:'BTC', vol:0, funding:0});
const D = {};
for(const c of top){
  try{
    D[c.name] = {m5: await snap(c.name, '5m', START - 864e5)};
    for(const tf of CFG.tfs) D[c.name][tf] = await snap(c.name, tf, START - 420 * TFMS[tf]);
    process.stdout.write('.');
  }catch(e){ console.log('\nskip', c.name, e.message); }
}
console.log('\ndata loaded');

/* candles the live bot would have seen at time t: closed bars + the forming bar built from 5m candles */
function view(coin, tf, t){
  const d = D[coin], ms = TFMS[tf], bar = Math.floor(t / ms) * ms;
  const C = d[tf].filter(c => c.t < bar).slice(-399);
  const part = d.m5.filter(c => c.t >= bar && c.t + 3e5 <= t);
  if(part.length) C.push({t:bar, o:part[0].o, h:Math.max(...part.map(c => c.h)), l:Math.min(...part.map(c => c.l)), c:part.at(-1).c, v:part.reduce((a, c) => a + c.v, 0)});
  return C;
}

const eqCurve = [];
for(NOW = START; NOW <= END; NOW += 9e5){
  // settle with 5m candles completed since the last check
  for(const b of S.brackets.slice()){
    const from = b.last || b.created;
    for(const c of D[b.coin].m5){
      if(c.t + 3e5 <= from || c.t < b.created || c.t + 3e5 > NOW) continue;
      A.lastPx[b.coin] = c.c; if(A.step(b, c.l, c.h, c.t + 3e5)) break;
    }
    if(S.brackets.includes(b)) b.last = NOW;
  }
  const d0 = Math.floor(NOW / 864e5) * 864e5, eq = A.equityNow();
  const dayPnl = S.history.filter(h => h.closed >= d0).reduce((a, h) => a + h.pnl, 0);
  if(dayPnl > -eq * CFG.dayLoss / 100 && S.brackets.length < CFG.maxPos){
    const picks = [];
    for(const tf of CFG.tfs){
      let btc = null; try{ btc = E.htfBias(resample(view('BTC', tf, NOW), TFMS[HTF[tf]])); }catch(e){}
      for(const c of top){
        if(!D[c.name]) continue;
        try{
          const C = view(c.name, tf, NOW); if(C.length < 120) continue;
          A.lastPx[c.name] = C.at(-1).c;
          const An = E.analyze(C, resample(C, TFMS[HTF[tf]]), c, tf); An.btc = c.name === 'BTC' ? null : btc;
          const B = E.bestCall(An), p = B.plan, thr = CFG.minScore + E.tfBonus(tf);
          const tp1Passed = B.dir === 'long' ? An.P >= p.tp1 : An.P <= p.tp1;
          if(B.sc.score >= thr && p.rr2 >= 2 && An.ind.adx != null && An.ind.adx >= CFG.adxMin && !tp1Passed)
            picks.push({coin:c.name, tf, dir:B.dir, score:B.sc.score, margin:B.sc.score - thr, plan:p, price:An.P});
        }catch(e){}
      }
    }
    picks.sort((a, b) => b.margin - a.margin);
    for(const pk of picks){
      if(S.brackets.length >= CFG.maxPos) break;
      if(S.brackets.some(b => b.coin === pk.coin)) continue;
      if(S.history.some(h => h.coin === pk.coin && h.dir === pk.dir && h.tf === pk.tf && !h.filled && NOW - h.closed < TFMS[pk.tf])) continue;
      if(S.history.some(h => h.coin === pk.coin && h.reason === 'SL' && NOW - h.closed < (CFG.slPauseH ?? 24) * 36e5)) continue;
      const p = pk.plan, riskUsd = A.equityNow() * CFG.risk / 100, qty = riskUsd / Math.abs(p.avg - p.sl);
      const b = {id:'r' + NOW, coin:pk.coin, tf:pk.tf, dir:pk.dir, score:pk.score, legs:[{px:p.e1, qty:qty/2, filled:false}, {px:p.e2, qty:qty/2, filled:false}],
        sl0:p.sl, sl:p.sl, tp1:p.tp1, tp2:p.tp2, riskUsd, qty:0, filledQty:0, avg:null, realized:0, fees:0, r1:false, t1:false,
        created:NOW, last:NOW, expires:NOW + CFG.waitBars * TFMS[pk.tf], status:'pending', armed:true};
      if(p.market) A.fillLeg(b, b.legs[0], pk.price, FEE_T);
      S.brackets.push(b);
      say(`OPEN ${pk.coin} ${pk.tf} ${pk.dir} score ${pk.score.toFixed(1)} E1 ${+p.e1.toPrecision(5)} SL ${+p.sl.toPrecision(5)} TP1 ${+p.tp1.toPrecision(5)} TP2 ${+p.tp2.toPrecision(5)}`);
    }
  }
  if(NOW % 36e5 === 0) eqCurve.push([NOW, A.equityNow()]);
}

const fin = S.history.filter(h => h.filled), wins = fin.filter(h => h.pnl > 0), eqEnd = A.equityNow();
const sumR = fin.reduce((a, h) => a + h.R, 0);
const lines = [
  `# Replay ${new Date(START).toISOString().slice(0, 16)} → ${new Date(END).toISOString().slice(0, 16)} UTC`,
  ``, `Start $${CFG.startBalance} · end equity **$${eqEnd.toFixed(2)}** (${((eqEnd / CFG.startBalance - 1) * 100).toFixed(2)} %) · balance $${S.balance.toFixed(2)}`,
  `Filled trades ${fin.length} · wins ${wins.length} · winrate ${fin.length ? (wins.length / fin.length * 100).toFixed(0) : 0} % · total ${sumR.toFixed(2)}R · unfilled ${S.history.length - fin.length} · still open ${S.brackets.length}`,
  ``, `| Closed | Coin | Side | TF | Result | PnL | R |`, `|---|---|---|---|---|---|---|`,
  ...S.history.slice().reverse().map(h => `| ${new Date(h.closed).toISOString().slice(5, 16).replace('T', ' ')} | ${h.coin} | ${h.dir} | ${h.tf} | ${h.reason} | ${h.filled ? h.pnl.toFixed(2) : '–'} | ${h.filled ? h.R.toFixed(2) : '–'} |`),
  ``, `Open now: ${S.brackets.map(b => `${b.coin} ${b.tf} ${b.dir} (${b.filledQty ? 'filled, ' + (b.realized >= 0 ? '+' : '') + b.realized.toFixed(2) + ' realized' : 'waiting'})`).join(', ') || 'none'}`,
  ``, '```', ...out, '```'];
fs.writeFileSync('REPLAY.md', lines.join('\n'));
fs.writeFileSync('replay-equity.json', JSON.stringify(eqCurve));
console.log(lines.slice(0, 4).join('\n'));
