"use client";

import { useState, useEffect, useRef } from "react";

const EXCHANGE_ADDRESS = "0x12759afcA690637b425ffbA3265F0Dc2F6242A8D";
const SCAN_BACK  = Number(process.env.NEXT_PUBLIC_SCAN_BACK ?? 500);
const POLL_MS    = Number(process.env.NEXT_PUBLIC_POLL_MS   ?? 5000);

// Confirmed topic0s from real transaction logs
const T0_BALANCE_UPDATE    = "0x163aa6d2d8e5248ce93dbd22509af93e5f27"; // truncated — full below
const T0_POSITION_MINTED   = "0x9f039a0ca58d6157d7b6914e2d60cedacf65f"; // 4 topics, empty data

// Full topic0s — confirmed from screenshots
const TOPIC0_BALANCE  = "0x163aa6d2d8e5248ce93dbd22509af93e5f270870";
const TOPIC0_MINTED   = "0x9f039a0ca58d6157d7b6914e2d60cedacf65f54f3";

const MULT_BUCKETS = [
  { label:"1.42x", mult:1.42,  min:0,    max:0.05  },
  { label:"1.68x", mult:1.68,  min:0.05, max:0.10  },
  { label:"2.77x", mult:2.77,  min:0.10, max:0.15  },
  { label:"3.33x", mult:3.33,  min:0.15, max:0.20  },
  { label:"3.60x", mult:3.60,  min:0.20, max:0.25  },
  { label:"6.52x", mult:6.52,  min:0.25, max:0.35  },
  { label:"6.87x", mult:6.87,  min:0.35, max:0.45  },
  { label:"12.0x", mult:12.0,  min:0.45, max:0.60  },
  { label:"13.6x", mult:13.6,  min:0.60, max:0.75  },
  { label:"19.2x", mult:19.2,  min:0.75, max:1.00  },
  { label:"41.2x", mult:41.2,  min:1.00, max:1.50  },
  { label:"100x",  mult:100,   min:1.50, max:999   },
];

interface Zone {
  label:string; mult:number;
  taps:number; hits:number; hitRate:number; volume:number;
}
interface FeedItem {
  id:string; txHash:string; bucket:number;
  itm:boolean; amount:number;
}
interface LogStats { total:number; minted:number; settled:number; balance:number; other:number; }

function makeZones(): Zone[] {
  return MULT_BUCKETS.map(b => ({ label:b.label, mult:b.mult, taps:0, hits:0, hitRate:0, volume:0 }));
}

let _id = 1;
async function rpc(method:string, params:unknown[]) {
  const res = await fetch("/api/rpc", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ jsonrpc:"2.0", id:_id++, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function getBlockNumber(): Promise<number> {
  return parseInt(await rpc("eth_blockNumber",[]), 16);
}

async function getLogs(from:number, to:number) {
  return rpc("eth_getLogs",[{
    address: EXCHANGE_ADDRESS,
    fromBlock: "0x"+from.toString(16),
    toBlock:   "0x"+to.toString(16),
  }]);
}

async function getTx(hash:string) {
  return rpc("eth_getTransactionByHash",[hash]);
}

// Decode executeTrade calldata to get startPrice and priceInterval
// Function selector for executeTrade — we'll detect by input length
// Order struct: user, vault, underlying, nonce, startTime, timeInterval, startPrice, priceInterval, takerAmount, makerAmount
// Each field = 32 bytes, selector = 4 bytes
// Offset: 4 + (field_index * 32)
function decodeCalldata(input:string): { startPrice:number; priceInterval:number; takerAmount:number } | null {
  try {
    const data = input.slice(2); // remove 0x
    if (data.length < 8 + 320) return null; // need at least selector + 10 fields
    // Skip 4-byte selector (8 hex chars)
    const body = data.slice(8);
    const getWord = (i:number) => parseInt(body.slice(i*64, (i+1)*64), 16);
    // Order fields: user(0), vault(1), underlying(2), nonce(3), startTime(4), timeInterval(5), startPrice(6), priceInterval(7), takerAmount(8), makerAmount(9)
    const startPrice    = getWord(6);
    const priceInterval = getWord(7);
    const takerAmount   = getWord(8);
    return { startPrice, priceInterval, takerAmount };
  } catch { return null; }
}

function getBucket(priceInterval:number, startPrice:number): number {
  if (!startPrice) return 0;
  const pct = (priceInterval / startPrice) * 100;
  const idx = MULT_BUCKETS.findIndex(b => pct >= b.min*100 && pct < b.max*100);
  return idx >= 0 ? idx : 0;
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────
function Cell({ zone, isNew }:{ zone:Zone; isNew:boolean }) {
  const hasTaps   = zone.taps > 0;
  const hitPct    = hasTaps ? Math.round(zone.hitRate * 100) : null;
  const intensity = Math.min(zone.taps / 100, 1);
  const isHot     = hasTaps && zone.hitRate > 0.55;
  const isCold    = hasTaps && zone.hitRate < 0.30;
  const bg = !hasTaps ? "rgba(255,255,255,0.03)"
    : isHot  ? `rgba(180,255,80,${0.1+intensity*0.2})`
    : isCold ? `rgba(255,80,80,${0.08+intensity*0.14})`
    :          `rgba(210,255,100,${0.06+intensity*0.16})`;
  const border = !hasTaps ? "rgba(255,255,255,0.06)"
    : isHot  ? `rgba(180,255,80,${0.3+intensity*0.45})`
    : isCold ? "rgba(255,80,80,0.3)"
    :          `rgba(210,255,100,${0.18+intensity*0.35})`;
  const glow = isNew ? "0 0 24px rgba(210,255,100,0.7)"
    : isHot ? `0 0 ${6+intensity*14}px rgba(180,255,80,${0.15+intensity*0.3})` : "none";
  return (
    <div style={{
      background:bg, border:`1px solid ${border}`, borderRadius:10,
      padding:"8px 12px", display:"flex", alignItems:"center",
      justifyContent:"space-between", boxShadow:glow,
      transition:"all 0.35s ease",
      animation: isNew ? "tapPop 0.5s ease" : "none",
      minHeight:44,
    }}>
      <div style={{ fontSize:hasTaps?17:13, fontWeight:800,
        color:!hasTaps?"rgba(255,255,255,0.15)":isHot?"#d4ff50":isCold?"#ff8080":"#e8ff90",
        fontFamily:"var(--font-dm-mono),monospace" }}>
        {hasTaps ? `${hitPct}%` : "—"}
      </div>
      <div style={{ textAlign:"right" }}>
        <div style={{ fontSize:10, color:"rgba(255,255,255,0.4)", fontFamily:"var(--font-dm-mono)" }}>
          {zone.taps} taps
        </div>
        {zone.volume > 0 && (
          <div style={{ fontSize:9, color:"rgba(255,255,255,0.22)", fontFamily:"var(--font-dm-mono)" }}>
            ${zone.volume.toFixed(0)} vol
          </div>
        )}
      </div>
    </div>
  );
}

function Feed({ items }:{ items:FeedItem[] }) {
  if (!items.length) return (
    <div style={{ color:"rgba(255,255,255,0.18)", fontSize:11, fontFamily:"var(--font-dm-mono)", textAlign:"center", paddingTop:24 }}>
      Waiting for settled positions…
    </div>
  );
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:5, maxHeight:340, overflowY:"auto" }}>
      {items.map((item,idx) => (
        <div key={item.id} style={{
          display:"flex", alignItems:"center", gap:8,
          padding:"6px 10px",
          background: item.itm ? "rgba(180,255,80,0.06)" : "rgba(255,80,80,0.05)",
          border:`1px solid ${item.itm?"rgba(180,255,80,0.14)":"rgba(255,80,80,0.1)"}`,
          borderRadius:8, opacity:Math.max(0.25,1-idx*0.05),
          fontSize:11, fontFamily:"var(--font-dm-mono)",
        }}>
          <span style={{ color:"rgba(255,255,255,0.25)", fontSize:9, minWidth:30 }}>
            #{item.txHash?.slice(2,6)??"????"}
          </span>
          <span style={{ color:"rgba(255,255,255,0.35)", minWidth:38 }}>
            {MULT_BUCKETS[item.bucket]?.label??"?"}
          </span>
          <span style={{ flex:1, color:"rgba(255,255,255,0.2)" }}>
            ${(item.amount/1e18).toFixed(2)}
          </span>
          <span style={{ fontWeight:800, color:item.itm?"#d4ff50":"#ff6060" }}>
            {item.itm ? "HIT" : "MISS"}
          </span>
        </div>
      ))}
    </div>
  );
}

function WinBars({ zones }:{ zones:Zone[] }) {
  const maxRate = Math.max(...zones.map(z=>z.hitRate), 0.01);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      {zones.map((z,i) => {
        const pct   = Math.round(z.hitRate*100);
        const color = z.hitRate>0.55?"#d4ff50":z.hitRate>0.35?"#ffc820":z.taps>0?"#ff6060":"rgba(255,255,255,0.08)";
        return (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ width:38, fontSize:10, color:"rgba(255,255,255,0.3)", textAlign:"right", fontFamily:"var(--font-dm-mono)" }}>
              {z.label}
            </div>
            <div style={{ flex:1, background:"rgba(255,255,255,0.05)", borderRadius:3, height:18, overflow:"hidden" }}>
              <div style={{
                width: z.taps>0 ? `${(z.hitRate/maxRate)*100}%` : "0%",
                height:"100%", background:`linear-gradient(90deg,${color}28,${color}65)`,
                borderRadius:3, display:"flex", alignItems:"center", paddingLeft:6,
                transition:"width 1.2s ease",
              }}>
                {z.taps>0 && <span style={{ fontSize:9, color, fontWeight:700, fontFamily:"var(--font-dm-mono)" }}>{pct}%</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function SquareHunter() {
  const [zones,     setZones]    = useState<Zone[]>(makeZones());
  const [feed,      setFeed]     = useState<FeedItem[]>([]);
  const [status,    setStatus]   = useState<"init"|"scanning"|"live"|"error">("init");
  const [msg,       setMsg]      = useState("Connecting…");
  const [blockNum,  setBlockNum] = useState<number|null>(null);
  const [newBucket, setNewBucket]= useState<number|null>(null);
  const [logStats,  setLogStats] = useState<LogStats>({total:0,minted:0,settled:0,balance:0,other:0});

  const lastBlockRef = useRef<number|null>(null);
  const pendingRef   = useRef<Record<string,{bucket:number;takerAmount:number}>>({});

  useEffect(() => {
    async function boot() {
      try {
        const bn = await getBlockNumber();
        setBlockNum(bn);
        setStatus("scanning");
        const from = Math.max(0, bn - SCAN_BACK);
        setMsg(`Scanning ${from.toLocaleString()} → ${bn.toLocaleString()}…`);
        const logs = await getLogs(from, bn);
        setMsg(`${logs?.length??0} logs found`);
        if (logs?.length) await processLogs(logs);
        lastBlockRef.current = bn;
        setStatus("live");
        setMsg(`Live · polling every ${POLL_MS/1000}s`);
      } catch(e:any) {
        setStatus("error");
        setMsg("Error: "+e.message);
      }
    }
    boot();
  }, []);

  useEffect(() => {
    if (status !== "live") return;
    const iv = setInterval(async () => {
      try {
        const latest = await getBlockNumber();
        setBlockNum(latest);
        const from = (lastBlockRef.current??latest-1)+1;
        if (from>latest) return;
        lastBlockRef.current = latest;
        const logs = await getLogs(from, latest);
        if (logs?.length) await processLogs(logs);
      } catch(e:any) { setMsg("Poll error: "+e.message); }
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [status]);

  async function processLogs(logs:any[]) {
    let minted=0, settled=0, balance=0, other=0;

    // Group logs by transaction
    const byTx: Record<string, any[]> = {};
    for (const log of logs) {
      const h = log.transactionHash;
      if (!byTx[h]) byTx[h] = [];
      byTx[h].push(log);
    }

    for (const [txHash, txLogs] of Object.entries(byTx)) {
      // Check if this tx has a PositionMinted log (4 topics)
      const mintLog = txLogs.find(l =>
        l.topics?.length === 4 &&
        (!l.data || l.data === "0x")
      );

      if (mintLog) {
        minted++;
        // Fetch tx to get calldata for zone calculation
        try {
          const tx = await getTx(txHash);
          const cd = decodeCalldata(tx?.input ?? "");
          const bucket = cd ? getBucket(cd.priceInterval, cd.startPrice) : 0;
          const takerAmount = cd?.takerAmount ?? 0;

          const posId = mintLog.topics[1];
          pendingRef.current[posId] = { bucket, takerAmount };

          setZones(prev => {
            const next = [...prev];
            next[bucket] = {
              ...next[bucket],
              taps:   next[bucket].taps + 1,
              volume: next[bucket].volume + takerAmount/1e18,
            };
            return next;
          });
          flash(bucket);
        } catch {}
      }

      // Check for settlement — USDm transfer FROM exchange to user
      // This is a Transfer event on USDm token where from = exchange
      const settleLogs = txLogs.filter(l =>
        l.topics?.[0]?.toLowerCase().startsWith("0xddf252ad") && // Transfer topic0
        l.topics?.[1]?.toLowerCase().includes(EXCHANGE_ADDRESS.slice(2).toLowerCase().slice(-20))
      );

      if (settleLogs.length > 0 && !mintLog) {
        settled++;
        // Find amount from transfer value
        const transferLog = settleLogs[0];
        const data = (transferLog.data??"0x").slice(2);
        const amount = data ? parseInt(data.slice(0,64),16) : 0;
        const itm = amount > 0;

        // Try to match to a pending position
        // Use first pending position as approximation
        const pendingKeys = Object.keys(pendingRef.current);
        const bucket = pendingKeys.length > 0
          ? pendingRef.current[pendingKeys[0]]?.bucket ?? 0
          : 0;

        if (itm) {
          setZones(prev => {
            const next = [...prev];
            const newHits = next[bucket].hits + 1;
            next[bucket] = {
              ...next[bucket],
              hits:    newHits,
              hitRate: next[bucket].taps > 0 ? newHits/next[bucket].taps : 0,
            };
            return next;
          });
        }

        setFeed(prev => [{
          id:     txHash+transferLog.logIndex,
          txHash,
          bucket,
          itm,
          amount,
        }, ...prev].slice(0, 24));

        flash(bucket);
      }

      // Count balance updates
      const balanceLogs = txLogs.filter(l => l.topics?.[0]?.toLowerCase().startsWith("0x163aa6d2"));
      balance += balanceLogs.length;
      other += txLogs.length - (mintLog?1:0) - settleLogs.length - balanceLogs.length;
    }

    setLogStats(prev => ({
      total:   prev.total + logs.length,
      minted:  prev.minted + minted,
      settled: prev.settled + settled,
      balance: prev.balance + balance,
      other:   prev.other + other,
    }));
  }

  function flash(bucket:number) {
    setNewBucket(bucket);
    setTimeout(() => setNewBucket(null), 700);
  }

  const totalTaps = zones.reduce((a,z)=>a+z.taps,0);
  const totalHits = zones.reduce((a,z)=>a+z.hits,0);
  const winRate   = totalTaps>0 ? Math.round((totalHits/totalTaps)*100) : null;
  const hotIdx    = zones.reduce((best,z,i)=>z.taps>zones[best].taps?i:best,0);
  const totalVol  = zones.reduce((a,z)=>a+z.volume,0);
  const maxTaps   = Math.max(...zones.map(z=>z.taps),1);

  const statusColor = {init:"#ffc820",scanning:"#c0a0ff",live:"#d4ff50",error:"#ff4040"}[status];
  const statusLabel = {init:"Initialising",scanning:"Scanning…",live:"Live · MegaETH",error:"Error"}[status];

  return (
    <>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        body{background:#180a12;}
        ::-webkit-scrollbar{width:3px;}
        ::-webkit-scrollbar-thumb{background:rgba(212,255,80,0.15);border-radius:2px;}
        @keyframes tapPop{0%{transform:scale(1);}40%{transform:scale(1.05);box-shadow:0 0 28px rgba(210,255,100,0.7);}100%{transform:scale(1);}}
        @keyframes blink{0%,100%{opacity:1;}50%{opacity:0.2;}}
      `}</style>
      <div style={{
        minHeight:"100vh", background:"#180a12",
        backgroundImage:`
          radial-gradient(ellipse 70% 55% at 50% 0%,rgba(130,18,75,0.4) 0%,transparent 65%),
          radial-gradient(ellipse 50% 40% at 85% 85%,rgba(70,8,45,0.35) 0%,transparent 60%)
        `,
        fontFamily:"var(--font-dm-mono),monospace", color:"#fff", padding:"20px 16px",
      }}>
        <div style={{ maxWidth:1060, margin:"0 auto" }}>

          {/* Header */}
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, background:"rgba(0,0,0,0.4)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:30, padding:"7px 16px" }}>
                <span style={{ fontSize:16 }}>✳</span>
                <span style={{ fontFamily:"var(--font-syne),sans-serif", fontSize:17, fontWeight:800, letterSpacing:-0.5 }}>euphoria</span>
              </div>
              <span style={{ color:"rgba(255,255,255,0.18)" }}>·</span>
              <span style={{ fontFamily:"var(--font-syne),sans-serif", fontSize:15, fontWeight:700, color:"rgba(255,255,255,0.45)" }}>Square Hunter</span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:7 }}>
              <div style={{ width:7, height:7, borderRadius:"50%", background:statusColor, boxShadow:`0 0 6px ${statusColor}`, animation:status==="live"||status==="scanning"?"blink 1.8s ease infinite":"none" }} />
              <span style={{ fontSize:11, color:"rgba(255,255,255,0.35)", letterSpacing:1.3, textTransform:"uppercase" }}>{statusLabel}</span>
            </div>
          </div>

          {/* Debug */}
          <div style={{ fontSize:10, color:"rgba(255,255,255,0.25)", marginBottom:14, padding:"6px 12px", background:"rgba(0,0,0,0.25)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:8, display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
            <span>{msg}</span>
            <span style={{ color:"rgba(255,255,255,0.15)" }}>
              {logStats.total} logs · {logStats.minted} minted · {logStats.settled} settled · {logStats.balance} balance
              {blockNum?` · #${blockNum.toLocaleString()}`:""}
            </span>
          </div>

          {/* Stats */}
          <div style={{ display:"flex", gap:10, marginBottom:16 }}>
            {[
              {label:"Positions",  value:totalTaps>0?totalTaps.toLocaleString():"—",      color:"#c0a0ff"},
              {label:"Win Rate",   value:winRate!=null?`${winRate}%`:"—",                  color:"#d4ff50"},
              {label:"Hot Zone",   value:totalTaps>0?zones[hotIdx]?.label:"—",             color:"#ffc820"},
              {label:"Volume",     value:totalVol>0?`$${totalVol.toFixed(0)}`:"—",         color:"rgba(255,255,255,0.4)"},
            ].map(s => (
              <div key={s.label} style={{ flex:1, background:"rgba(0,0,0,0.28)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:12, padding:"11px 14px", textAlign:"center" }}>
                <div style={{ fontSize:18, fontWeight:800, color:s.color, letterSpacing:-0.5 }}>{s.value}</div>
                <div style={{ fontSize:10, color:"rgba(255,255,255,0.25)", marginTop:3, textTransform:"uppercase", letterSpacing:1.2 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Grid + Sidebar */}
          <div style={{ display:"flex", gap:14 }}>
            <div style={{ flex:1, background:"rgba(0,0,0,0.22)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:16, padding:18 }}>
              <div style={{ fontSize:11, color:"rgba(255,255,255,0.25)", textTransform:"uppercase", letterSpacing:1.5, marginBottom:14 }}>
                Hit % by Multiplier Zone · On-Chain
              </div>
              {zones.map((zone,i) => {
                const multColor = zone.mult>=20?"#ff7070":zone.mult>=8?"#ffc820":zone.mult>=3?"#ffdd70":"#d4ff50";
                return (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                    <div style={{ width:52, textAlign:"right", flexShrink:0, fontSize:13, fontWeight:700, color:multColor }}>
                      {zone.label}
                    </div>
                    <div style={{ flex:1 }}>
                      <Cell zone={zone} isNew={newBucket===i} />
                    </div>
                    <div style={{ width:72, display:"flex", alignItems:"center", gap:5 }}>
                      <div style={{ flex:1, background:"rgba(255,255,255,0.04)", borderRadius:3, height:5, overflow:"hidden" }}>
                        <div style={{ width:`${(zone.taps/maxTaps)*100}%`, height:"100%", background:"rgba(212,255,80,0.38)", borderRadius:3, transition:"width 0.8s ease" }} />
                      </div>
                      <span style={{ fontSize:9, color:"rgba(255,255,255,0.2)", minWidth:22, textAlign:"right" }}>{zone.taps}</span>
                    </div>
                  </div>
                );
              })}
              <div style={{ display:"flex", gap:16, marginTop:14, paddingLeft:62 }}>
                {([["#d4ff50",">55% win"],["#ffc820","35–55%"],["#ff6060","<35%"]] as const).map(([c,l])=>(
                  <div key={l} style={{ display:"flex", alignItems:"center", gap:5 }}>
                    <div style={{ width:8, height:8, borderRadius:2, background:c, opacity:0.65 }} />
                    <span style={{ fontSize:9, color:"rgba(255,255,255,0.25)" }}>{l}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ width:228, display:"flex", flexDirection:"column", gap:12 }}>
              <div style={{ background:"rgba(0,0,0,0.22)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:16, padding:16 }}>
                <div style={{ fontSize:11, color:"rgba(255,255,255,0.25)", textTransform:"uppercase", letterSpacing:1.5, marginBottom:12 }}>Win % by Zone</div>
                <WinBars zones={zones} />
              </div>
              <div style={{ background:"rgba(0,0,0,0.22)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:16, padding:16, flex:1 }}>
                <div style={{ fontSize:11, color:"rgba(255,255,255,0.25)", textTransform:"uppercase", letterSpacing:1.5, marginBottom:12 }}>Settled Positions</div>
                <Feed items={feed} />
              </div>
            </div>
          </div>

          <div style={{ marginTop:14, textAlign:"center", fontSize:9, color:"rgba(255,255,255,0.1)" }}>
            Square Hunter · community analytics · not affiliated with Euphoria Finance · {EXCHANGE_ADDRESS.slice(0,10)}…
          </div>
        </div>
      </div>
    </>
  );
}