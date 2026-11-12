"use client";
import { useState } from "react";
import { cx, Pv, type Kind } from "./ui";

const ST: [string, string][] = [["Agent", "any MCP client"], ["Endpoint", "POST /api/mcp"], ["Lease auth", "bearer token"], ["Gateway", "price, key, replay"], ["Kernel", "lock, rules, journal"], ["Tool", "claude-haiku-5-5"], ["PayPal", "hold, capture, void"]];
type O = { plan: string[]; rows: string; tool: string; charged: string; src: [Kind, string]; t: string; d: string; fl: [string, string][]; raw?: string; rawt?: string };
const OUT: Record<string, O> = {
  served: { plan: ["ok", "ok", "ok", "ok", "ok", "ok", "dotted"], rows: "+2, one group", tool: "ran", charged: "the price", src: ["recorded", "a served call in the 12 Nov journal"], t: "Served", d: "The kernel checks the rules, writes the journal group and runs the tool in one transaction. The agent gets the result, the price and what remains. PayPal is not called: the money is already held.", fl: [["price", "from the server registry"], ["journal", "committed up, free down"], ["stored", "the result is kept for replay"]] },
  replay: { plan: ["ok", "ok", "ok", "ok", "skip", "skip", "dotted"], rows: "0", tool: "did not run", charged: "0", src: ["measured", "sandbox run, replay probe"], t: "Retry with the same UUID", d: "The answer was lost, so the agent resends the same UUID and text. The gateway returns the stored result. Nothing is posted and the provider is not called. The same UUID with different text is refused.", fl: [["replayed", "true"], ["charged", "0"], ["rows", "unchanged"]] },
  cap: { plan: ["ok", "ok", "ok", "ok", "fail", "skip", "dotted"], rows: "0 ledger rows", tool: "did not run", charged: "0", src: ["recorded", "live check, HTTP 402, 12 Nov 15:35 UTC"], t: "Over the cap", d: "The price is more than what is free in the hold. The kernel refuses before any provider is called. A refused row is kept; no ledger group.", fl: [["reason", "cap_reached"], ["price_minor", "1001"], ["remaining_minor", "997"]], raw: '{"provenance":"computed","price_minor":1001,"remaining_minor":997,"reason":"cap_reached"}', rawt: "Captured from the live check on a $10.00 hold, 12 Nov 15:35 UTC." },
  exp: { plan: ["ok", "ok", "ok", "ok", "fail", "skip", "dotted"], rows: "0 ledger rows", tool: "did not run", charged: "0", src: ["recorded", "live check, HTTP 402, 12 Nov 15:35 UTC"], t: "Over the spend limit", d: "The hold still has money, but committing this price would pass the unsettled limit. A second rule, separate from the cap. Settling frees room.", fl: [["reason", "exposure_limit"], ["price_minor", "698"], ["remaining_minor", "997 (free, not spendable)"]], raw: '{"provenance":"computed","price_minor":698,"remaining_minor":997,"reason":"exposure_limit"}', rawt: "Captured 12 Nov 15:35 UTC. remaining_minor is the free amount (997); the spendable amount was 697." },
  fail: { plan: ["ok", "ok", "ok", "ok", "rb", "fail", "dotted"], rows: "0 (rolled back)", tool: "started, failed", charged: "0", src: ["computed", "covered by tests, not run live"], t: "The tool fails", d: "The tool runs inside the charging transaction. If the model call fails, the commit and the served row roll back together. The buyer is not charged; the provider cost is the operator's.", fl: [["error", "tool_failed"], ["charged", "false"]] },
  auth: { plan: ["ok", "ok", "fail", "skip", "skip", "skip", "dotted"], rows: "0", tool: "did not run", charged: "0", src: ["recorded", "HTTP 401, probed 12 Nov 15:35 UTC"], t: "No token", d: "Without a lease token nothing reaches the gateway. The server answers 401 and names the realm.", fl: [["HTTP", "401"], ["WWW-Authenticate", 'Bearer realm="pashadhara-lease"']], raw: '{"error":"unauthorized"}', rawt: "Captured from the live endpoint, 12 Nov 15:35 UTC." },
};
const BTN: [string, string][] = [["served", "Served"], ["replay", "Retry, same UUID"], ["cap", "Over the cap"], ["exp", "Over the spend limit"], ["fail", "Tool fails"], ["auth", "No token"]];

const REC: Record<string, { req: string; http: number; body: string; note?: string }> = {
  init: { req: "initialize", http: 200, body: '{"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"pashadhara","version":"0.1.0"}},"jsonrpc":"2.0","id":1}' },
  list: { req: "tools/list", http: 200, body: '{"result":{"tools":[{"name":"summarise","description":"Summarise text in at most three sentences ... Price: 3 USD cents per call (computed from server registry).","_meta":{"pashadhara/price_minor":3,"pashadhara/currency":"USD"},"inputSchema":{"required":["text","idempotency_key"]}},{"name":"check_budget","description":"Free. Check whether this lease can afford one call to a paid tool right now, without spending anything. ...","inputSchema":{"required":["tool"]}}]},"jsonrpc":"2.0","id":1}', note: 'Shortened with "...". Names, the price in _meta and required fields are as returned.' },
  call: { req: "tools/call, no Authorization header", http: 401, body: '{"error":"unauthorized"}', note: 'Header: WWW-Authenticate: Bearer realm="pashadhara-lease"' },
};

function Probe() {
  const [out, setOut] = useState<{ k: string; live: boolean; http: number; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (k: string) => {
    if (busy) return; setBusy(true);
    const R = REC[k]!, method = k === "init" ? "initialize" : k === "list" ? "tools/list" : "tools/call";
    const params = k === "init" ? { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pashadhara-site", version: "0" } } : k === "call" ? { name: "check_budget", arguments: { tool: "summarise" } } : undefined;
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch("/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal, cache: "no-store" });
      clearTimeout(to);
      const t = await r.text(); let pretty = t; try { pretty = JSON.stringify(JSON.parse(t), null, 1); } catch { /* keep raw */ }
      setOut({ k, live: true, http: r.status, body: pretty });
    } catch { let p = R.body; try { p = JSON.stringify(JSON.parse(R.body), null, 1); } catch { /* keep */ } setOut({ k, live: false, http: R.http, body: p }); }
    finally { setBusy(false); }
  };
  const R = out ? REC[out.k]! : null;
  return (
    <>
      <div className="probe-row">
        {[["init", "initialize"], ["list", "tools/list"], ["call", "tools/call, no token"]].map(([k, l]) => <button key={k} className="btn sm" type="button" disabled={busy} onClick={() => void run(k!)}>{l}</button>)}
      </div>
      <div aria-live="polite">
        {out && R && (
          <>
            <div className={cx("verdict", out.k === "call" ? "bad" : "good")} style={{ marginTop: 10 }}><span className="v1">{R.req}</span><span className="v2">HTTP {out.http} · {out.live ? "answered just now" : "recorded 12 Nov 15:35 UTC"}</span><div className="v3">{out.live ? <Pv k="live" /> : <Pv k="recorded" />}{!out.live && <span>The live request could not be read from here, so this is what the same request returned on 12 Nov. {R.note ?? ""}</span>}</div></div>
            <pre className="code">{out.body}</pre>
          </>
        )}
      </div>
    </>
  );
}

const SEQ: [string, string, Kind][] = [
  ["initialize", "Handshake. The server says its tool list can change.", "recorded"],
  ["tools/list", "The agent sees summarise with its price in _meta, and a free check_budget.", "recorded"],
  ["check_budget { tool }", "Free. Returns the price, whether it is affordable and what remains. The lease comes from the token, never the request.", "recorded"],
  ["tools/call summarise { text, idempotency_key }", "Charged the price. A fresh UUID per request: in one Claude Code run on a local fixture the model made up valid UUIDs unaided (one sample, not a rate).", "recorded"],
  ["The same call again, same UUID and text", "Replayed from the stored result. Charged 0.", "measured"],
  ["A call that does not fit", "isError with a reason, the price and the remaining balance. The agent decides what to do next. Nothing was charged.", "recorded"],
];

const SURF: [string, string, string][] = [
  ["GET /api/health", "200", "API function is up"], ["GET /api/health/db", "200", "database reachable, read time returned"], ["GET /api/openapi.json", "200", "contract 0.5.2, 15 paths"],
  ["POST /api/mcp tools/list", "200", "2 tools: summarise, check_budget"], ["POST /api/mcp tools/call, no token", "401", 'WWW-Authenticate: Bearer realm="pashadhara-lease"'],
  ["POST /api/webhooks/paypal, no headers", "400", "Missing PayPal signature headers"], ["POST /api/webhooks/paypal, fake signature", "400", "rejected (an earlier audit saw 500 here)"],
  ["POST /api/internal/settlement/sweep, no auth", "401", "closed to the public"], ["GET /api/v1/leases, no auth", "401", "reads need a key"],
  ["POST /api/showcase/try?price_minor=1001", "402", "cap_reached, remaining 997"], ["POST /api/showcase/try?price_minor=698", "402", "exposure_limit, the spend-limit rule"],
];

export function Connect() {
  const [o, setO] = useState("served");
  const D = OUT[o]!;
  return (
    <section className="stage" id="s4">
      <div className="stage-h"><span className="stage-n">4</span><h2>One URL. <em>Any agent.</em></h2></div>
      <p className="stage-lede">An agent reaches all of this through an MCP endpoint. It never sees PayPal and never sets a price. Pick what happens to a call and see which part of the system it reaches.</p>
      <div className="outs" role="group" aria-label="Outcome of the call">{BTN.map(([k, l]) => <button key={k} type="button" aria-pressed={o === k} onClick={() => setO(k)}>{l}</button>)}</div>
      <div className="stn" key={o}>{ST.map((s, i) => <div key={i} className={cx("sbtn", D.plan[i])} style={{ animationDelay: `${i * 80}ms` }}><i /><b>{s[0]}</b><span>{s[1]}</span></div>)}</div>
      <div className="facts"><div>Journal rows<b>{D.rows}</b></div><div>Tool<b>{D.tool}</b></div><div>Buyer charged<b>{D.charged}</b></div><div>Evidence<b><Pv k={D.src[0]} /> {D.src[1]}</b></div></div>
      <div className="insp" aria-live="polite">
        <b>{D.t}.</b> {D.d}
        <dl className="fl">{D.fl.map(f => <div key={f[0]} style={{ display: "contents" }}><dt>{f[0]}</dt><dd>{f[1]}</dd></div>)}</dl>
        {D.raw && <><pre className="code">{D.raw}</pre><p className="note">{D.rawt}</p></>}
        <p className="note">PayPal is dotted on purpose: no outcome here calls PayPal. It is touched at grant, capture and void.</p>
      </div>

      <div className="blk"><h3>Ask the live server <Pv k="live">live when reachable</Pv></h3>
        <p className="note" style={{ marginTop: 0 }}>Real requests to this site's endpoint. No token, no spend.</p>
        <Probe />
      </div>

      <div className="blk"><h3>What an agent does, in order</h3>
        <ol className="seq">{SEQ.map(r => <li key={r[0]}><span><b className="mono">{r[0]}</b><span className="d">{r[1]}</span></span><Pv k={r[2]} /></li>)}</ol>
      </div>

      <div className="blk"><h3>Connect a client</h3>
        <pre className="code">{`// .mcp.json
{
  "mcpServers": {
    "pashadhara": {
      "url": "https://pashadhara.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer <lease token>" }
    }
  }
}`}</pre>
        <p className="note">The lease token comes from whoever owns the hold. Tested with the official TypeScript SDK, the MCP Inspector CLI and Claude Code against a local fixture. Not tested: other clients; OAuth is not offered.</p>
      </div>

      <details className="blk surf-d"><summary>The deployed surface, probed <Pv k="measured">measured 12 Nov 15:35 UTC</Pv></summary>
        <div className="scroll-x"><table className="surf"><thead><tr><th>Request</th><th>HTTP</th><th>What it shows</th></tr></thead><tbody>{SURF.map(r => <tr key={r[0]}><td className="m">{r[0]}</td><td className="m good">{r[1]}</td><td>{r[2]}</td></tr>)}</tbody></table></div>
        <p className="note">Not exercised: a signed PayPal webhook, the settlement sweep on a schedule, any call with a real token.</p>
      </details>
    </section>
  );
}
