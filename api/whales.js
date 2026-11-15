// What the best Hyperliquid traders hold right now. The public leaderboard is ~40 MB (too much for a phone),
// so the server picks proven, active traders, reads their open positions and returns a small per-coin summary.
// Vercel caches the answer for 5 minutes.
const INFO = 'https://api.hyperliquid.xyz/info';
const TOP = 50;

const perf = (row, w) => Object.fromEntries(row.windowPerformances)[w] || {pnl:0, roi:0, vlm:0};
const post = body => fetch(INFO, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}).then(r => { if(!r.ok) throw new Error('info ' + r.status); return r.json(); });

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try{
    const lb = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard').then(r => { if(!r.ok) throw new Error('leaderboard ' + r.status); return r.json(); });
    // proven (big all-time profit), in form (profitable this month), real traders (not market makers churning volume, not idle)
    const picks = lb.leaderboardRows.filter(r => {
      const av = +r.accountValue, m = perf(r, 'month'), all = perf(r, 'allTime');
      return av >= 5e5 && +all.pnl >= 1e6 && +m.pnl > 0 && +m.vlm / av >= 0.5 && +m.vlm / av <= 200;
    }).sort((a, b) => +perf(b, 'month').pnl - +perf(a, 'month').pnl).slice(0, TOP);

    const states = [];
    for(let i = 0; i < picks.length; i += 10){ // small batches: the info API is rate limited per IP
      const batch = picks.slice(i, i + 10);
      states.push(...await Promise.all(batch.map(p => post({type:'clearinghouseState', user:p.ethAddress}).catch(() => null))));
    }

    const coins = {};
    picks.forEach((p, rank) => {
      const st = states[rank]; if(!st) return;
      for(const ap of st.assetPositions || []){
        const pos = ap.position, sz = +pos.szi; if(!sz) continue;
        const side = sz > 0 ? 'long' : 'short', usd = +pos.positionValue, entry = +pos.entryPx;
        const c = coins[pos.coin] ||= {long:{n:0, usd:0, wEntry:0, upnl:0}, short:{n:0, usd:0, wEntry:0, upnl:0}, top:[]};
        const s = c[side]; s.n++; s.usd += usd; s.wEntry += entry * usd; s.upnl += +pos.unrealizedPnl;
        c.top.push({rank:rank + 1, side, usd:Math.round(usd), entry, lev:pos.leverage?.value || null, upnl:Math.round(+pos.unrealizedPnl),
          liq:pos.liquidationPx ? +pos.liquidationPx : null, month:Math.round(+perf(p, 'month').pnl), addr:p.ethAddress.slice(0, 6) + '…' + p.ethAddress.slice(-4)});
      }
    });
    const out = {};
    for(const [coin, c] of Object.entries(coins).sort((a, b) => (b[1].long.usd + b[1].short.usd) - (a[1].long.usd + a[1].short.usd)).slice(0, 40)){
      const side = s => ({n:s.n, usd:Math.round(s.usd), entry:s.usd ? s.wEntry / s.usd : null, upnl:Math.round(s.upnl)});
      out[coin] = {long:side(c.long), short:side(c.short), top:c.top.sort((a, b) => b.usd - a.usd).slice(0, 6)};
    }
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({updated:Date.now(), traders:picks.length, read:states.filter(Boolean).length, coins:out});
  }catch(e){
    res.setHeader('Cache-Control', 's-maxage=60');
    res.status(502).json({error:String(e && e.message || e)});
  }
};
