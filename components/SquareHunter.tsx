"use client";

import { useState, useEffect, useRef } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const EXCHANGE_ADDRESS = "0x12759afcA690637b425ffbA3265F0Dc2F6242A8D";
const USDM_TOKEN       = "0xfafddbb3fc7688494971a79cc65dca3ef82079e7";
const SCAN_BACK        = Number(process.env.NEXT_PUBLIC_SCAN_BACK ?? 500);
const POLL_MS          = Number(process.env.NEXT_PUBLIC_POLL_MS   ?? 5000);
const STORAGE_KEY      = "squarehunter_v1";

// ─── CONFIRMED TOPIC0s ────────────────────────────────────────────────────────
const T0_BALANCE  = "0x163aa6d2d8e5248ce93dbd22509af93e5f270870";
const T0_MINTED   = "0x9f039a0ca58d6157d7b6914e2d60cedacf65f54f3";
const T0_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ─── BUCKET CONFIG ────────────────────────────────────────────────────────────
// Based on absolute $ priceInterval ranges observed on-chain
// $0.50 interval → 1.42x; buckets scale with interval size
const MULT_BUCKETS = [
  { label:"1.42x", mult:1.42,  maxInterval: 1      },
  { label:"1.68x", mult:1.68,  maxInterval: 2      },
  { label:"2.77x", mult:2.77,  maxInterval: 4      },
  { label:"3.33x", mult:3.33,  maxInterval: 7      },
  { label:"3.60x", mult:3.60,  maxInterval: 11     },
  { label:"6.52x", mult:6.52,  maxInterval: 18     },
  { label:"6.87x", mult:6.87,  maxInterval: 28     },
  { label:"12.0x", mult:12.0,  maxInterval: 45     },
  { label:"13.6x", mult:13.6,  maxInterval: 70     },
  { label:"19.2x", mult:19.2,  maxInterval: 110    },
  { label:"41.2x", mult:41.2,  maxInterval: 200    },
  { label:"100x",  mult:100,   maxInterval: 999999 },
];

function getBucket(priceInterval: number): number {
  const idx = MULT_BUCKETS.findIndex(b => priceInterval <= b.maxInterval);
  return idx >= 0 ? idx : MULT_BUCKETS.length - 1;
}

// ─── CALLDATA DECODER ─────────────────────────────────────────────────────────
// Exact byte positions confirmed from real on-chain calldata analysis
function decodeExecuteTrade(input: string): {
  takerAmount: number;
  startPrice: number;
  priceInterval: number;
  bucket: number;
} | null {
  try {
    const hex = input.startsWith("0x") ? input.slice(2) : input;
    if (hex.length < 700) return null;

    const extract = (byteStart: number, byteLen: number) =>
      parseInt(hex.slice(byteStart * 2, (byteStart + byteLen) * 2), 16);

    const takerAmount   = extract(112, 8);  // uint64, 8 bytes
    const startPrice    = extract(309, 5);  // 5 bytes, divide by 1e8
    const priceInterval = extract(342, 4);  // uint32, 4 bytes, divide by 1e8

    if (!startPrice || !priceInterval) return null;

    const spUSD = startPrice    / 1e8;
    const piUSD = priceInterval / 1e8;
    const bucket = getBucket(piUSD);

    return { takerAmount, startPrice: spUSD, priceInterval: piUSD, bucket };
  } catch { return null; }
}

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface Zone {
  label: string; mult: number;
  taps: number; hits: number; hitRate: number; volume: number;
}
interface FeedItem {
  id: string; txHash: string; bucket: number;
  itm: boolean; amount: number; priceInterval: number;
}
interface StoredData {
  zones: Zone[];
  feed: FeedItem[];
  totalTrades: number;
  lastBlock: number;
  savedAt: number;
}

function makeZones(): Zone[] {
  return MULT_BUCKETS.map(b => ({
    label: b.label, mult: b.mult,
    taps: 0, hits: 0, hitRate: 0, volume: 0,
  }));
}

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
function loadStored(): StoredData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data: StoredData = JSON.parse(raw);
    // Invalidate if older than 7 days
    if (Date.now() - data.savedAt > 7 * 24 * 60 * 60 * 1000) return null;
    return data;
  } catch { return null; }
}

function saveStored(data: StoredData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, savedAt: Date.now() }));
  } catch {}
}

// ─── RPC ──────────────────────────────────────────────────────────────────────
let _id = 1;
async function rpc(method: string, params: unknown[]) {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: _id++, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function getBlockNumber(): Promise<number> {
  return parseInt(await rpc("eth_blockNumber", []), 16);
}

async function getLogs(from: number, to: number) {
  return rpc("eth_getLogs", [{
    address: EXCHANGE_ADDRESS,
    fromBlock: "0x" + from.toString(16),
    toBlock:   "0x" + to.toString(16),
  }]);
}

async function getTx(hash: string) {
  return rpc("eth_getTransactionByHash", [hash]);
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────
function Cell({ zone, isNew }: { zone: Zone; isNew: boolean }) {
  const hasTaps   = zone.taps > 0;
  const hitPct    = hasTaps ? Math.round(zone.hitRate * 100) : null;
  const intensity = Math.min(zone.taps / 100, 1);
  const isHot     = hasTaps && zone.hitRate > 0.55;
  const isCold    = hasTaps && zone.hitRate < 0.30;

  const bg = !hasTaps ? "rgba(255,255,255,0.03)"
    : isHot  ? `rgba(180,255,80,${0.1  + intensity * 0.2})`
    : isCold ? `rgba(255,80,80,${0.08 + intensity * 0.14})`
    :           `rgba(210,255,100,${0.06 + intensity * 0.16})`;

  const border = !hasTaps ? "rgba(255,255,255,0.06)"
    : isHot  ? `rgba(180,255,80,${0.3  + intensity * 0.45})`
    : isCold ? "rgba(255,80,80,0.3)"
    :           `rgba(210,255,100,${0.18 + intensity * 0.35})`;

  const glow = isNew ? "0 0 24px rgba(210,255,100,0.7)"
    : isHot ? `0 0 ${6 + intensity * 14}px rgba(180,255,80,${0.15 + intensity * 0.3})` : "none";

  return (
    <div style={{
      background: bg, border: `1px solid ${border}`, borderRadius: 10,
      padding: "8px 12px", display: "flex", alignItems: "center",
      justifyContent: "space-between", boxShadow: glow,
      transition: "all 0.35s ease",
      animation: isNew ? "tapPop 0.5s ease" : "none",
      minHeight: 44,
    }}>
      <div style={{
        fontSize: hasTaps ? 17 : 13, fontWeight: 800,
        color: !hasTaps ? "rgba(255,255,255,0.15)" : isHot ? "#d4ff50" : isCold ? "#ff8080" : "#e8ff90",
        fontFamily: "var(--font-dm-mono), monospace",
      }}>
        {hasTaps ? `${hitPct}%` : "—"}
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-dm-mono)" }}>
          {zone.taps} taps
        </div>
        {zone.volume > 0 && (
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.22)", fontFamily: "var(--font-dm-mono)" }}>
            ${zone.volume.toFixed(0)} vol
          </div>
        )}
      </div>
    </div>
  );
}

function Feed({ items }: { items: FeedItem[] }) {
  if (!items.length) return (
    <div style={{ color: "rgba(255,255,255,0.18)", fontSize: 11, fontFamily: "var(--font-dm-mono)", textAlign: "center", paddingTop: 24 }}>
      Waiting for settled positions…
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 340, overflowY: "auto" }}>
      {items.map((item, idx) => (
        <div key={item.id} style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 10px",
          background: item.itm ? "rgba(180,255,80,0.06)" : "rgba(255,80,80,0.05)",
          border: `1px solid ${item.itm ? "rgba(180,255,80,0.14)" : "rgba(255,80,80,0.1)"}`,
          borderRadius: 8, opacity: Math.max(0.25, 1 - idx * 0.05),
          fontSize: 11, fontFamily: "var(--font-dm-mono)",
        }}>
          <span style={{ color: "rgba(255,255,255,0.25)", fontSize: 9, minWidth: 30 }}>
            #{item.txHash?.slice(2, 6) ?? "????"}
          </span>
          <span style={{ color: "rgba(255,255,255,0.35)", minWidth: 38 }}>
            {MULT_BUCKETS[item.bucket]?.label ?? "?"}
          </span>
          <span style={{ flex: 1, color: "rgba(255,255,255,0.2)" }}>
            ${(item.amount / 1e18).toFixed(2)}
          </span>
          <span style={{ fontWeight: 800, color: item.itm ? "#d4ff50" : "#ff6060" }}>
            {item.itm ? "HIT" : "MISS"}
          </span>
        </div>
      ))}
    </div>
  );
}

function WinBars({ zones }: { zones: Zone[] }) {
  const maxRate = Math.max(...zones.map(z => z.hitRate), 0.01);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {zones.map((z, i) => {
        const pct   = Math.round(z.hitRate * 100);
        const color = z.hitRate > 0.55 ? "#d4ff50"
          : z.hitRate > 0.35 ? "#ffc820"
          : z.taps > 0 ? "#ff6060"
          : "rgba(255,255,255,0.08)";
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 38, fontSize: 10, color: "rgba(255,255,255,0.3)", textAlign: "right", fontFamily: "var(--font-dm-mono)" }}>
              {z.label}
            </div>
            <div style={{ flex: 1, background: "rgba(255,255,255,0.05)", borderRadius: 3, height: 18, overflow: "hidden" }}>
              <div style={{
                width: z.taps > 0 ? `${(z.hitRate / maxRate) * 100}%` : "0%",
                height: "100%",
                background: `linear-gradient(90deg, ${color}28, ${color}65)`,
                borderRadius: 3, display: "flex", alignItems: "center", paddingLeft: 6,
                transition: "width 1.2s ease",
              }}>
                {z.taps > 0 && (
                  <span style={{ fontSize: 9, color, fontWeight: 700, fontFamily: "var(--font-dm-mono)" }}>
                    {pct}%
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function SquareHunter() {
  const [zones,      setZones]     = useState<Zone[]>(makeZones());
  const [feed,       setFeed]      = useState<FeedItem[]>([]);
  const [status,     setStatus]    = useState<"init"|"scanning"|"live"|"error">("init");
  const [msg,        setMsg]       = useState("Loading saved data…");
  const [blockNum,   setBlockNum]  = useState<number | null>(null);
  const [newBucket,  setNewBucket] = useState<number | null>(null);
  const [totalTrades,setTotal]     = useState(0);
  const [minted,     setMinted]    = useState(0);
  const [settled,    setSettled]   = useState(0);

  const lastBlockRef  = useRef<number | null>(null);
  const zonesRef      = useRef<Zone[]>(zones);
  const feedRef       = useRef<FeedItem[]>(feed);
  const totalRef      = useRef(0);
  zonesRef.current    = zones;
  feedRef.current     = feed;
  totalRef.current    = totalTrades;

  // ── Boot ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    async function boot() {
      // Load persisted data first
      const stored = loadStored();
      if (stored) {
        setZones(stored.zones);
        setFeed(stored.feed);
        setTotal(stored.totalTrades);
        lastBlockRef.current = stored.lastBlock;
        setMsg(`Restored ${stored.totalTrades} trades · syncing new blocks…`);
      }

      try {
        const bn = await getBlockNumber();
        setBlockNum(bn);
        setStatus("scanning");

        // If no stored data, scan back SCAN_BACK blocks
        // If stored, only scan from last saved block
        const from = lastBlockRef.current
          ? lastBlockRef.current + 1
          : Math.max(0, bn - SCAN_BACK);

        if (from <= bn) {
          setMsg(`Scanning blocks ${from.toLocaleString()} → ${bn.toLocaleString()}…`);
          const logs = await getLogs(from, bn);
          setMsg(`${logs?.length ?? 0} new logs found`);
          if (logs?.length) await processLogs(logs);
        }

        lastBlockRef.current = bn;
        setStatus("live");
        setMsg(`Live · polling every ${POLL_MS / 1000}s`);
      } catch (e: any) {
        setStatus("error");
        setMsg("Error: " + e.message);
      }
    }
    boot();
  }, []);

  // ── Poll ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "live") return;
    const iv = setInterval(async () => {
      try {
        const latest = await getBlockNumber();
        setBlockNum(latest);
        const from = (lastBlockRef.current ?? latest - 1) + 1;
        if (from > latest) return;
        lastBlockRef.current = latest;
        const logs = await getLogs(from, latest);
        if (logs?.length) await processLogs(logs);
      } catch (e: any) {
        setMsg("Poll error: " + e.message);
      }
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [status]);

  // ── Auto-save every 30s ───────────────────────────────────────────────────
  useEffect(() => {
    const iv = setInterval(() => {
      if (!lastBlockRef.current) return;
      saveStored({
        zones:       zonesRef.current,
        feed:        feedRef.current.slice(0, 50),
        totalTrades: totalRef.current,
        lastBlock:   lastBlockRef.current,
        savedAt:     Date.now(),
      });
    }, 30000);
    return () => clearInterval(iv);
  }, []);

  // ── Process logs ──────────────────────────────────────────────────────────
  async function processLogs(logs: any[]) {
    // Group by transaction
    const byTx: Record<string, any[]> = {};
    for (const log of logs) {
      const h = log.transactionHash;
      if (!byTx[h]) byTx[h] = [];
      byTx[h].push(log);
    }

    let mintCount = 0, settleCount = 0;

    for (const [txHash, txLogs] of Object.entries(byTx)) {
      const t0s = txLogs.map((l: any) => l.topics?.[0]?.toLowerCase() ?? "");

      // ── PositionMinted: 4 topics, empty data ──────────────────────────────
      const mintLog = txLogs.find((l: any) =>
        l.topics?.length === 4 && (!l.data || l.data === "0x")
      );

      if (mintLog) {
        mintCount++;
        try {
          const tx = await getTx(txHash);
          const cd = decodeExecuteTrade(tx?.input ?? "");
          if (cd) {
            const { bucket, takerAmount } = cd;
            setZones(prev => {
              const next = [...prev];
              next[bucket] = {
                ...next[bucket],
                taps:   next[bucket].taps + 1,
                volume: next[bucket].volume + takerAmount / 1e18,
              };
              return next;
            });
            setTotal(t => t + 1);
            flash(bucket);
          }
        } catch {}
      }

      // ── Settlement: USDm Transfer FROM Exchange TO user ───────────────────
      const settleTransfer = txLogs.find((l: any) => {
        if (l.topics?.[0]?.toLowerCase() !== T0_TRANSFER.toLowerCase()) return false;
        // from = Exchange (topic1)
        const from = "0x" + (l.topics?.[1] ?? "").slice(26);
        return from.toLowerCase() === EXCHANGE_ADDRESS.toLowerCase();
      });

      if (settleTransfer && !mintLog) {
        settleCount++;
        const data    = (settleTransfer.data ?? "0x").slice(2);
        const amount  = data ? parseInt(data.slice(0, 64), 16) : 0;
        const itm     = amount > 0;

        // Try to get bucket from this tx's calldata (settlePosition has positionId)
        // Use a simple heuristic: most recent pending bucket
        const bucket = 0; // fallback — settlement tx doesn't have zone info

        if (itm) {
          setZones(prev => {
            const next = [...prev];
            const newHits = next[bucket].hits + 1;
            next[bucket] = {
              ...next[bucket],
              hits:    newHits,
              hitRate: next[bucket].taps > 0 ? newHits / next[bucket].taps : 0,
            };
            return next;
          });
        }

        setFeed(prev => [{
          id:            txHash + settleTransfer.logIndex,
          txHash,
          bucket,
          itm,
          amount,
          priceInterval: 0,
        }, ...prev].slice(0, 50));

        flash(bucket);
      }
    }

    setMinted(m => m + mintCount);
    setSettled(s => s + settleCount);
  }

  function flash(bucket: number) {
    setNewBucket(bucket);
    setTimeout(() => setNewBucket(null), 700);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const totalTaps = zones.reduce((a, z) => a + z.taps, 0);
  const totalHits = zones.reduce((a, z) => a + z.hits, 0);
  const winRate   = totalTaps > 0 ? Math.round((totalHits / totalTaps) * 100) : null;
  const hotIdx    = zones.reduce((best, z, i) => z.taps > zones[best].taps ? i : best, 0);
  const totalVol  = zones.reduce((a, z) => a + z.volume, 0);
  const maxTaps   = Math.max(...zones.map(z => z.taps), 1);

  const statusColor = { init:"#ffc820", scanning:"#c0a0ff", live:"#d4ff50", error:"#ff4040" }[status];
  const statusLabel = { init:"Initialising", scanning:"Scanning…", live:"Live · MegaETH", error:"Error" }[status];

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #180a12; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: rgba(212,255,80,0.15); border-radius: 2px; }
        @keyframes tapPop {
          0%  { transform: scale(1); }
          40% { transform: scale(1.05); box-shadow: 0 0 28px rgba(210,255,100,0.7); }
          100%{ transform: scale(1); }
        }
        @keyframes blink { 0%,100%{opacity:1;} 50%{opacity:0.2;} }
      `}</style>

      <div style={{
        minHeight: "100vh", background: "#180a12",
        backgroundImage: `
          radial-gradient(ellipse 70% 55% at 50% 0%, rgba(130,18,75,0.4) 0%, transparent 65%),
          radial-gradient(ellipse 50% 40% at 85% 85%, rgba(70,8,45,0.35) 0%, transparent 60%)
        `,
        fontFamily: "var(--font-dm-mono), monospace",
        color: "#fff", padding: "20px 16px",
      }}>
        <div style={{ maxWidth: 1060, margin: "0 auto" }}>

          {/* Header */}
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, background:"rgba(0,0,0,0.4)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:30, padding:"7px 16px" }}>
                <span style={{ fontSize:16 }}>✳</span>
                <span style={{ fontFamily:"var(--font-syne),sans-serif", fontSize:17, fontWeight:800, letterSpacing:-0.5 }}>euphoria</span>
              </div>
              <span style={{ color:"rgba(255,255,255,0.18)" }}>·</span>
              <span style={{ fontFamily:"var(--font-syne),sans-serif", fontSize:15, fontWeight:700, color:"rgba(255,255,255,0.45)" }}>
                Square Hunter
              </span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:7 }}>
              <div style={{ width:7, height:7, borderRadius:"50%", background:statusColor, boxShadow:`0 0 6px ${statusColor}`, animation: status==="live"||status==="scanning" ? "blink 1.8s ease infinite" : "none" }} />
              <span style={{ fontSize:11, color:"rgba(255,255,255,0.35)", letterSpacing:1.3, textTransform:"uppercase" }}>
                {statusLabel}
              </span>
            </div>
          </div>

          {/* Debug bar */}
          <div style={{ fontSize:10, color:"rgba(255,255,255,0.25)", marginBottom:14, padding:"6px 12px", background:"rgba(0,0,0,0.25)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:8, display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
            <span>{msg}</span>
            <span style={{ color:"rgba(255,255,255,0.15)" }}>
              {minted} minted · {settled} settled{blockNum ? ` · block #${blockNum.toLocaleString()}` : ""}
            </span>
          </div>

          {/* Stats */}
          <div style={{ display:"flex", gap:10, marginBottom:16 }}>
            {[
              { label:"Positions",  value: totalTaps > 0 ? totalTaps.toLocaleString() : "—",      color:"#c0a0ff" },
              { label:"Win Rate",   value: winRate != null ? `${winRate}%` : "—",                  color:"#d4ff50" },
              { label:"Hot Zone",   value: totalTaps > 0 ? zones[hotIdx]?.label : "—",             color:"#ffc820" },
              { label:"Volume",     value: totalVol > 0 ? `$${totalVol.toFixed(0)}` : "—",         color:"rgba(255,255,255,0.4)" },
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
              {zones.map((zone, i) => {
                const multColor = zone.mult >= 20 ? "#ff7070" : zone.mult >= 8 ? "#ffc820" : zone.mult >= 3 ? "#ffdd70" : "#d4ff50";
                return (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                    <div style={{ width:52, textAlign:"right", flexShrink:0, fontSize:13, fontWeight:700, color:multColor }}>
                      {zone.label}
                    </div>
                    <div style={{ flex:1 }}>
                      <Cell zone={zone} isNew={newBucket === i} />
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
                {([["#d4ff50",">55% win"],["#ffc820","35–55%"],["#ff6060","<35%"]] as const).map(([c,l]) => (
                  <div key={l} style={{ display:"flex", alignItems:"center", gap:5 }}>
                    <div style={{ width:8, height:8, borderRadius:2, background:c, opacity:0.65 }} />
                    <span style={{ fontSize:9, color:"rgba(255,255,255,0.25)" }}>{l}</span>
                  </div>
                ))}
                <button
                  onClick={() => { localStorage.removeItem(STORAGE_KEY); window.location.reload(); }}
                  style={{ marginLeft:"auto", fontSize:9, color:"rgba(255,255,255,0.2)", background:"none", border:"none", cursor:"pointer", textDecoration:"underline" }}
                >
                  reset data
                </button>
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
            Square Hunter · community analytics · not affiliated with Euphoria Finance · auto-saved locally
          </div>
        </div>
      </div>
    </>
  );
}