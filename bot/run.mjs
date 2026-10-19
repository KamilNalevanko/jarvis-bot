// J.A.R.V.I.S. server bot: runs every 15 min on GitHub Actions.
// Uses the exact engine from index.html, keeps a demo account in state.json and mirrors trades to the
// Hyperliquid TESTNET (orders can only ever go to the testnet URL below; there is no mainnet code path).
import fs from 'fs';
import { ethers } from 'ethers';
import { encode } from '@msgpack/msgpack';

const CFG = Object.assign({risk:1, maxPos:5, dayLoss:3, minScore:9, adxMin:20, tfs:['4h', '1h'], coins:30, startBalance:1000,
  waitBars:48, mirror:true, mirrorRisk:1, maxNotional:3000}, fs.existsSync('config.json') ? JSON.parse(fs.readFileSync('config.json', 'utf8')) : {});
const DATA_API = 'https://api.hyperliquid.xyz/info';            // market data (read only)
const TESTNET = 'https://api.hyperliquid-testnet.xyz';           // the only place orders are sent
const FEE_T = 0.00045, FEE_M = 0.00015;
const TFMS = {'5m':3e5, '15m':9e5, '1h':36e5, '4h':144e5, '1d':864e5, '1w':6048e5};
const HTF = {'15m':'1h', '1h':'4h', '4h':'1d', '1d':'1w'};
const TFLABEL = {'15m':'15m', '1h':'1h', '4h':'4h', '1d':'1D', '1w':'1W'};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const say = (...a) => { const line = `[${new Date().toISOString().slice(0, 16)}] ${a.join(' ')}`; console.log(line); log.push(line); };

/* ---------- engine: extracted from the app so the bot and the app always agree ---------- */
const html = fs.readFileSync('index.html', 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/<\/?script>/g, '');
const ea = js.indexOf('function ema('), eb = js.indexOf('\nfunction composeCall(');
if(ea < 0 || eb < 0) throw new Error('engine markers not found in index.html');
const E = new Function('TFMS', 'HTF', 'TFLABEL', 'tr', 'fmt', 'document', 'S', 'state',
  js.slice(ea, eb) + '\nreturn {analyze, bestCall, htfBias, tfBonus};')(TFMS, HTF, TFLABEL, en => en, x => String(x), {addEventListener(){}}, () => ({}), {});
function resample(C, ms){
  const out = [];
  for(const c of C){ const t = Math.floor(c.t / ms) * ms, l = out[out.length - 1];
    if(l && l.t === t){ l.h = Math.max(l.h, c.h); l.l = Math.min(l.l, c.l); l.c = c.c; l.v += c.v; } else out.push({...c, t}); }
  return out;
}

/* ---------- Hyperliquid (paced to stay far below the rate limit) ---------- */
let lastCall = 0;
async function post(url, body){
  for(let attempt = 0; attempt < 5; attempt++){
    const wait = 2200 - (Date.now() - lastCall); if(wait > 0) await sleep(wait);
    lastCall = Date.now();
    const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if(r.status === 429){ await sleep(10000 * (attempt + 1)); continue; }
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  throw new Error('rate limited');
}
const info = body => post(DATA_API, body);
async function candles(coin, tf, n, start){
  const end = Date.now();
  const d = await info({type:'candleSnapshot', req:{coin, interval:tf, startTime:start ?? end - n * TFMS[tf], endTime:end}});
  return d.map(k => ({t:k.t, o:+k.o, h:+k.h, l:+k.l, c:+k.c, v:+k.v}));
}

/* ---------- demo account (same rules as the app's demo / backtest) ---------- */
const S = fs.existsSync('state.json') ? JSON.parse(fs.readFileSync('state.json', 'utf8'))
  : {start:CFG.startBalance, balance:CFG.startBalance, created:Date.now(), brackets:[], history:[], equity:[], runs:0, log:[]};
function fillLeg(b, leg, px, fee){
  leg.filled = true; b.avg = b.qty > 0 ? (b.avg * b.qty + px * leg.qty) / (b.qty + leg.qty) : px;
  b.qty += leg.qty; b.filledQty += leg.qty; const f = px * leg.qty * fee; b.fees += f; b.realized -= f; S.balance -= f;
  b.status = 'open'; b.oneR = b.avg + (b.dir === 'long' ? 1 : -1) * Math.abs(b.avg - b.sl0);
}
function closeQty(b, qty, px, fee){
  qty = Math.min(qty, b.qty); if(!(qty > 0)) return;
  const pnl = (b.dir === 'long' ? 1 : -1) * (px - b.avg) * qty, f = px * qty * fee;
  b.qty -= qty; b.realized += pnl - f; b.fees += f; S.balance += pnl - f; b.exitSum = (b.exitSum || 0) + px * qty; b.exitQty = (b.exitQty || 0) + qty;
}
const finished = [];
function finalize(b, reason){
  S.brackets = S.brackets.filter(x => x !== b);
  const h = {id:b.id, coin:b.coin, dir:b.dir, tf:b.tf, source:'server', score:b.score, avg:b.avg, exit: b.exitQty ? b.exitSum / b.exitQty : null,
    pnl:b.realized, R: b.riskUsd ? b.realized / b.riskUsd : 0, fees:b.fees, reason, opened:b.created, closed:Date.now(), filled:b.filledQty > 0};
  S.history.unshift(h); finished.push(b);
  say(`CLOSE ${b.coin} ${b.dir} ${reason}${h.filled ? ` pnl ${h.pnl.toFixed(2)} (${h.R.toFixed(2)}R)` : ''}`);
}
function step(b, lo, hi, t){
  const L = b.dir === 'long', reach = px => L ? hi >= px : lo <= px, against = px => L ? lo <= px : hi >= px;
  if(b.filledQty === 0 && t > b.expires){ finalize(b, 'expired'); return true; }
  if(!b.r1) for(const leg of b.legs) if(!leg.filled && against(leg.px)) fillLeg(b, leg, leg.px, FEE_M);
  if(b.filledQty === 0){
    if(!b.armed && (L ? lo < b.tp1 : hi > b.tp1)) b.armed = true;
    if(b.armed !== false && reach(b.tp1)){ finalize(b, 'missed'); return true; } return false;
  }
  if(against(b.sl)){ const be = b.r1; closeQty(b, b.qty, b.sl, FEE_T); finalize(b, be ? 'BE' : 'SL'); return true; }
  if(!b.r1 && reach(b.oneR)){ closeQty(b, b.filledQty * 0.35, b.oneR, FEE_M); b.r1 = true; b.sl = b.avg; }
  if(!b.t1 && reach(b.tp1)){ closeQty(b, b.filledQty * 0.30, b.tp1, FEE_M); b.t1 = true; if(!b.r1){ b.r1 = true; b.sl = b.avg; } }
  if(reach(b.tp2)){ closeQty(b, b.qty, b.tp2, FEE_M); finalize(b, 'TP2'); return true; }
  return false;
}
const lastPx = {};
function equityNow(){ let e = S.balance; for(const b of S.brackets){ const m = lastPx[b.coin]; if(m != null && b.qty > 0) e += (b.dir === 'long' ? 1 : -1) * (m - b.avg) * b.qty; } return e; }

/* ---------- Hyperliquid TESTNET mirror ---------- */
const KEY = process.env.HL_KEY, ADDR = process.env.HL_ADDR, mirrorOn = CFG.mirror && KEY && ADDR;
const wallet = mirrorOn ? new ethers.Wallet(KEY.startsWith('0x') ? KEY : '0x' + KEY) : null;
const wire = x => { const t = (+x).toFixed(8).replace(/\.?0+$/, ''); return t === '-0' ? '0' : t; };
const pxW = (px, szd) => wire(+(+(+px).toPrecision(5)).toFixed(Math.max(0, 6 - szd)));
const szW = (sz, szd) => wire(Math.floor(sz * 10**szd + 1e-9) / 10**szd);
let tMeta = null;
async function testnetMeta(){ if(!tMeta){ const m = await post(TESTNET + '/info', {type:'meta'}); tMeta = m.universe.map((u, i) => ({name:u.name, i, sz:u.szDecimals})); } return tMeta; }
async function exchange(action){
  const nonce = Date.now(), packed = encode(action), data = new Uint8Array(packed.length + 9);
  data.set(packed, 0); new DataView(data.buffer).setBigUint64(packed.length, BigInt(nonce)); data[packed.length + 8] = 0;
  const sig = ethers.Signature.from(await wallet.signTypedData(
    {name:'Exchange', version:'1', chainId:1337, verifyingContract:'0x0000000000000000000000000000000000000000'},
    {Agent:[{name:'source', type:'string'}, {name:'connectionId', type:'bytes32'}]},
    {source:'b', connectionId:ethers.keccak256(data)})); // 'b' = testnet
  const d = await post(TESTNET + '/exchange', {action, nonce, signature:{r:sig.r, s:sig.s, v:sig.v}, vaultAddress:null});
  if(d.status !== 'ok') throw new Error(typeof d.response === 'string' ? d.response : JSON.stringify(d.response));
  const errs = (d.response?.data?.statuses || []).filter(x => x && x.error).map(x => x.error);
  if(errs.length) throw new Error(errs.join('; '));
  return d;
}
async function testnetState(){
  const [st, sp, oo] = await Promise.all([post(TESTNET + '/info', {type:'clearinghouseState', user:ADDR}), post(TESTNET + '/info', {type:'spotClearinghouseState', user:ADDR}).catch(() => null), post(TESTNET + '/info', {type:'frontendOpenOrders', user:ADDR})]);
  const spot = +((sp?.balances || []).find(b => b.coin === 'USDC')?.total || 0);
  return {st, oo:oo || [], equity:+st.marginSummary.accountValue + spot};
}
async function mirrorOpen(b, plan){
  const meta = await testnetMeta(), a = meta.find(m => m.name === b.coin); if(!a){ say(`testnet: ${b.coin} not listed`); return; }
  const ts = await testnetState();
  if((ts.st.assetPositions || []).some(x => x.position.coin === b.coin && +x.position.szi !== 0) || ts.oo.some(o => o.coin === b.coin)){ say(`testnet: ${b.coin} busy, skipped`); return; }
  let qty = ts.equity * CFG.mirrorRisk / 100 / Math.abs(plan.avg - plan.sl);
  if(qty * plan.avg > CFG.maxNotional) qty = CFG.maxNotional / plan.avg;
  const half = Math.floor(qty / 2 * 10**a.sz + 1e-9) / 10**a.sz;
  if(!(half * Math.min(plan.e1, plan.e2) >= 10)){ say(`testnet: ${b.coin} order below $10, skipped`); return; }
  const L = b.dir === 'long', sz = szW(half, a.sz), px = v => pxW(v, a.sz);
  const leg = (entry, tpx) => ({type:'order', orders:[
    {a:a.i, b:L, p:px(entry), s:sz, r:false, t:{limit:{tif:'Gtc'}}},
    {a:a.i, b:!L, p:px(tpx * (L ? 0.9 : 1.1)), s:sz, r:true, t:{trigger:{isMarket:true, triggerPx:px(tpx), tpsl:'tp'}}},
    {a:a.i, b:!L, p:px(plan.sl * (L ? 0.9 : 1.1)), s:sz, r:true, t:{trigger:{isMarket:true, triggerPx:px(plan.sl), tpsl:'sl'}}},
  ], grouping:'normalTpsl'});
  const oids = [];
  for(const lg of [leg(plan.e1, plan.tp1), leg(plan.e2, plan.tp2)]){
    try{ const r = await exchange(lg); const o = r.response?.data?.statuses?.[0]?.resting?.oid; if(o != null) oids.push(o); }
    catch(e){ say(`testnet: ${b.coin} order failed: ${e.message}`); }
  }
  b.hl = {asset:a.i, oids}; say(`testnet: ${b.coin} ${b.dir} placed ${sz} x2 (E1 ${px(plan.e1)} / E2 ${px(plan.e2)}, SL ${px(plan.sl)})`);
}
async function mirrorCancel(b){
  if(!mirrorOn || !b.hl?.oids?.length || b.filledQty > 0) return;
  try{
    const ts = await testnetState(), open = new Set(ts.oo.map(o => o.oid)), todo = b.hl.oids.filter(o => open.has(o));
    if(todo.length){ await exchange({type:'cancel', cancels:todo.map(o => ({a:b.hl.asset, o}))}); say(`testnet: ${b.coin} entry orders cancelled`); }
  }catch(e){ say(`testnet: cancel ${b.coin} failed: ${e.message}`); }
}

/* ---------- one run ---------- */
async function main(){
  const now = Date.now();
  say(`run #${(S.runs || 0) + 1} · open ${S.brackets.length} · mirror ${mirrorOn ? 'TESTNET' : 'off'}`);
  // 1) settle open demo trades with 5m candles since the last run
  for(const b of S.brackets.slice()){
    try{
      const C = await candles(b.coin, '5m', 0, (b.last || b.created) - 3e5);
      for(const c of C){ lastPx[b.coin] = c.c; if(c.t + 3e5 <= (b.last || b.created) || c.t < b.created) continue; if(step(b, c.l, c.h, c.t + 3e5)) break; }
      if(S.brackets.includes(b)) b.last = now;
    }catch(e){ say(`settle ${b.coin}: ${e.message}`); }
  }
  for(const b of finished) await mirrorCancel(b);
  // 2) risk limits
  const d0 = new Date(); d0.setUTCHours(0, 0, 0, 0);
  const dayPnl = S.history.filter(h => h.closed >= +d0).reduce((a, h) => a + h.pnl, 0), eq = equityNow();
  if(dayPnl <= -eq * CFG.dayLoss / 100) say(`daily loss limit hit (${dayPnl.toFixed(2)}), no new trades today`);
  else if(S.brackets.length >= CFG.maxPos) say(`full: ${S.brackets.length}/${CFG.maxPos}`);
  else {
    // 3) scan the most traded coins on each timeframe
    const [meta, ctxs] = await info({type:'metaAndAssetCtxs'});
    const top = meta.universe.map((u, i) => ({name:u.name, dl:u.isDelisted, vol:+ctxs[i].dayNtlVlm, funding:+ctxs[i].funding})).filter(x => !x.dl).sort((a, b) => b.vol - a.vol).slice(0, CFG.coins);
    const picks = [];
    for(const tf of CFG.tfs){
      let btc = null;
      try{ btc = E.htfBias(resample(await candles('BTC', tf, 400), TFMS[HTF[tf]])); }catch(e){}
      for(const c of top){
        try{
          const C = await candles(c.name, tf, 400); if(C.length < 120) continue;
          lastPx[c.name] = C.at(-1).c;
          const A = E.analyze(C, resample(C, TFMS[HTF[tf]]), c, tf); A.btc = c.name === 'BTC' ? null : btc;
          const B = E.bestCall(A), p = B.plan, thr = CFG.minScore + E.tfBonus(tf);
          const tp1Passed = B.dir === 'long' ? A.P >= p.tp1 : A.P <= p.tp1;
          if(B.sc.score >= thr && p.rr2 >= 2 && A.ind.adx != null && A.ind.adx >= CFG.adxMin && !tp1Passed)
            picks.push({coin:c.name, tf, dir:B.dir, score:B.sc.score, margin:B.sc.score - thr, plan:p, price:A.P});
        }catch(e){ say(`scan ${c.name} ${tf}: ${e.message}`); }
      }
    }
    picks.sort((a, b) => b.margin - a.margin);
    say(`setups: ${picks.map(p => `${p.coin} ${p.tf} ${p.dir} ${p.score.toFixed(1)}`).join(', ') || 'none'}`);
    // 4) open new demo trades (+ testnet mirror)
    for(const pk of picks){
      if(S.brackets.length >= CFG.maxPos) break;
      if(S.brackets.some(b => b.coin === pk.coin)) continue;
      // same setup ended unfilled recently (missed / expired): wait one bar of that timeframe before trying it again
      if(S.history.some(h => h.coin === pk.coin && h.dir === pk.dir && h.tf === pk.tf && !h.filled && now - h.closed < TFMS[pk.tf])) continue;
      // 24h pause on a coin after a stop loss there (tested on 7 months: better in- and out-of-sample)
      if(S.history.some(h => h.coin === pk.coin && h.reason === 'SL' && now - h.closed < (CFG.slPauseH ?? 24) * 36e5)) continue;
      const p = pk.plan, riskUsd = equityNow() * CFG.risk / 100, qty = riskUsd / Math.abs(p.avg - p.sl);
      const b = {id:'s' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), coin:pk.coin, tf:pk.tf, dir:pk.dir, source:'server', score:pk.score,
        legs:[{px:p.e1, qty:qty/2, filled:false}, {px:p.e2, qty:qty/2, filled:false}], sl0:p.sl, sl:p.sl, tp1:p.tp1, tp2:p.tp2, riskUsd,
        lev:Math.max(1, Math.ceil(qty * p.avg / (equityNow() * 0.25))), qty:0, filledQty:0, avg:null, realized:0, fees:0, r1:false, t1:false,
        created:now, last:now, expires:now + CFG.waitBars * TFMS[pk.tf], status:'pending', armed:true};
      if(p.market) fillLeg(b, b.legs[0], pk.price, FEE_T);
      S.brackets.push(b);
      say(`OPEN ${pk.coin} ${pk.tf} ${pk.dir} score ${pk.score.toFixed(1)} E1 ${p.e1} E2 ${p.e2} SL ${p.sl} TP ${p.tp1}/${p.tp2} risk $${riskUsd.toFixed(2)}`);
      if(mirrorOn) await mirrorOpen(b, p);
    }
  }
  // 5) record
  S.runs = (S.runs || 0) + 1; S.lastRun = now;
  S.equity.push([now, +equityNow().toFixed(2)]); if(S.equity.length > 6000) S.equity = S.equity.slice(-6000);
  if(mirrorOn){ try{ const ts = await testnetState(); S.testnet = {equity:+ts.equity.toFixed(2), positions:(ts.st.assetPositions || []).filter(x => +x.position.szi !== 0).length, orders:ts.oo.length, at:now}; }catch(e){} }
  S.log = [...log, ...(S.log || [])].slice(0, 300);
  S.history = S.history.slice(0, 1000);
  fs.writeFileSync('state.json', JSON.stringify(S));
  const f = S.history.filter(h => h.filled), wins = f.filter(h => h.pnl > 0).length, eqNow = equityNow();
  const days = ((now - S.created) / 864e5).toFixed(1);
  fs.writeFileSync('REPORT.md', [
    `# J.A.R.V.I.S. server bot`, ``, `Updated ${new Date(now).toISOString().replace('T', ' ').slice(0, 16)} UTC · running ${days} days · ${S.runs} runs`, ``,
    `| Demo equity | PnL | Trades | Winrate | Avg R | Open |`, `|---|---|---|---|---|---|`,
    `| $${eqNow.toFixed(2)} | ${(eqNow - S.start >= 0 ? '+' : '')}$${(eqNow - S.start).toFixed(2)} (${((eqNow / S.start - 1) * 100).toFixed(2)} %) | ${f.length} | ${f.length ? (wins / f.length * 100).toFixed(0) + ' %' : '–'} | ${f.length ? (f.reduce((a, h) => a + h.R, 0) / f.length).toFixed(2) + 'R' : '–'} | ${S.brackets.length} |`, ``,
    S.testnet ? `Hyperliquid testnet: equity $${S.testnet.equity} · ${S.testnet.positions} positions · ${S.testnet.orders} open orders` : `Hyperliquid testnet mirror: off`, ``,
    `## Last trades`, ``, `| Closed | Coin | Side | TF | Result | PnL | R |`, `|---|---|---|---|---|---|---|`,
    ...S.history.slice(0, 25).map(h => `| ${new Date(h.closed).toISOString().slice(5, 16).replace('T', ' ')} | ${h.coin} | ${h.dir} | ${h.tf} | ${h.reason} | ${h.filled ? h.pnl.toFixed(2) : '–'} | ${h.filled ? h.R.toFixed(2) : '–'} |`),
    ``, `## Log`, '```', ...S.log.slice(0, 40), '```',
  ].join('\n'));
  say('done');
}
main().catch(e => { console.error(e); process.exit(1); });
