"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { callKind, cents, hold, REASON, shortId, usd, utc, useShowcase, type Call } from "../lib/showcase-store";
import { runAgent, tryAmount, type RunResult, type TryResult } from "../lib/showcase-actions";
import proof from "./proof-evidence.json";
import sandboxProof from "./finance-sandbox-proof.json";
import { HoldNotice, Shell, useNow } from "./site";

export function Refusal({ r, check = false }: { r: TryResult | RunResult; check?: boolean }) {
  if (r.kind === "error") return <div className="callout" role="alert"><strong>{r.message}</strong></div>;
  if (r.kind === "served") return <div className="callout" style={{ background: "var(--tealbg)", color: "var(--teal)" }} role="status"><strong>This amount would be served.</strong><span>{usd(r.price)} fits inside {usd(r.remaining)} available. Nothing was posted.</span></div>;
  const over = r.price - r.remaining;
  return (
    <div className="callout" role="alert">
      {check && <span className="small mono">Live limit check on the hold. Posts nothing.</span>}
      <strong>Refused before the model ran. Nothing charged.</strong>
      <span>{usd(r.price)} asked, {usd(Math.max(r.remaining, 0))} available{over > 0 ? `, ${usd(over)} over` : ""}. {REASON[r.reason] ?? r.reason}.</span>
    </div>
  );
}

export function CallRow({ c, link = true }: { c: Call; link?: boolean }) {
  const kind = callKind(c);
  const body = <><span>{c.tool_id} · {usd(cents(c.price_minor))} · {kind === "served" ? "served" : kind === "refused" ? "refused, nothing charged" : c.status}</span><span>{utc(c.created_at)}</span></>;
  if (kind === "refused") return <div className="call no">{body}</div>;
  return link ? <Link className="call" href={`/activity?call=${c.id}`}>{body}</Link> : <div className="call">{body}</div>;
}

function Recorded() {
  const j = sandboxProof.journal;
  const left = sandboxProof.local_authorization.amount_minor - j.cents;
  return (
    <>
      <div className="cap"><span>Recorded run, 12 Nov. Not live.</span><span className="muted">sandbox hold {usd(sandboxProof.local_authorization.amount_minor)}</span></div>
      <div className="body">
        <div className="feed">
          <div className="call"><span>{j.served} paid calls · served</span><span>{usd(j.cents)}</span></div>
          <div className="call no"><span>{sandboxProof.refusal_probe.tool} · refused, {sandboxProof.refusal_probe.reason}</span><span>nothing charged</span></div>
        </div>
        <div className="callout"><strong>Refused before any model ran. {j.served} served rows before and after: unchanged.</strong><span>{usd(left)} was left on the hold, so a larger tool call did not fit.</span></div>
        <p className="src"><strong>Source:</strong> PayPal GET of the authorization (HTTP {sandboxProof.paypal_get.http_status}, status {sandboxProof.paypal_get.status}) and the kernel journal. The live read is not answering right now. <Link href="/proof">PayPal evidence</Link></p>
      </div>
    </>
  );
}

let autoDone = false;
let autoRes: TryResult | null = null;

export function Home() {
  const s = useShowcase();
  const now = useNow(60_000);
  const h = hold(s.data, now);
  const [asked, setAsked] = useState<TryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState<RunResult | null>(null);
  const ended = h?.state === "ended";
  const avail0 = h?.available ?? null;
  useEffect(() => { if (avail0 == null || ended || autoDone) return; autoDone = true; void tryAmount(avail0 + 1).then(r => { autoRes = r; setAsked(a => a ?? r); }); }, [avail0, ended]);
  useEffect(() => { if (autoRes) setAsked(a => a ?? autoRes); }, []);
  const calls = [...(s.data?.calls ?? []), ...(s.data?.refused_calls ?? [])].filter((c, i, a) => a.findIndex(x => x.id === c.id) === i)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 4);
  const overspend = async () => { setBusy(true); setAsked(await tryAmount((h?.available ?? 0) + 1)); setBusy(false); };
  const run = async () => { setBusy(true); setRan(await runAgent()); setBusy(false); };
  return (
    <Shell route="">
      <div className="page">
        <HoldNotice d={s.data} />
        <section className="hero">
          <div>
            <h1>A budget your AI agent cannot overspend</h1>
            <p className="lede">One PayPal authorization hold is the spending limit. Every paid call is checked against it before the model runs. If it does not fit, it is refused and nothing is charged.</p>
            <div className="row ctas">
              <button className="btn pri" onClick={run} disabled={busy || ended || !s.data || s.data.remaining_calls === 0}>{ended ? "Spending is closed" : "Run it on the live hold"}</button>
              <Link className="btn" href="/developers">Connect your agent</Link>
            </div>
            {ran && <div style={{ marginTop: 16 }}>{ran.kind === "served" ? <div className="callout" style={{ background: "var(--tealbg)", color: "var(--teal)" }} role="status"><strong>Served. {usd(ran.price)} committed against the hold.</strong><span>{usd(ran.remaining)} left. See it in <Link href="/activity">Activity</Link>.</span></div> : <Refusal r={ran} />}</div>}
          </div>
          <div className="panel live" aria-label="Live demo hold">
            {!s.data && !s.loading ? <Recorded /> : (
              <>
                <div className="cap"><span>Agent calls, from the budget journal</span><span className="mono">{h?.paypalId ? `Hold ${shortId(h.paypalId)}` : ""}</span></div>
                <div className="body">
                  {!s.data ? <><div className="skel" /><div className="skel" /></> : (
                    <>
                      <div className="feed">
                        {calls.length ? calls.map(c => <CallRow key={c.id} c={c} />) : <p className="muted small">No paid calls yet on this hold.</p>}
                      </div>
                      {asked && <><Refusal r={asked} check /><p className="muted small">Run when the page loaded. It is not a journal row, so Activity does not list it.</p></>}
                      <div className="row between">
                        <span className="mono">{h?.available != null && h.cap != null ? (ended ? `Spending closed. ${usd(h.available)} of ${usd(h.cap)} left on the hold` : `${usd(h.available)} of ${usd(h.cap)} available`) : ""}</span>
                        <button className="btn" onClick={overspend} disabled={busy || ended || h?.available == null}>Try to overspend{h?.available != null ? ` by ${usd(1)}` : ""}</button>
                      </div>
                      <p className="src"><strong>Source:</strong> budget journal{s.data.read_at ? `, read ${utc(s.data.read_at)}` : ""}. These rows are our record, not PayPal output. Our record of the PayPal authorization: created, nothing collected yet.</p><Link className="btn sm" href="/proof#hold">See the PayPal evidence</Link>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="cap"><span>How it holds</span><span className="muted">{proof.fees.rows.length} captures on a separate recorded sandbox authorization</span></div>
          <div className="body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 20 }}>
            <div><h3>Buyer approves once</h3><p className="muted small">PayPal authorizes the full amount. Nothing is collected yet.</p></div>
            <div><h3>Gateway checks every call</h3><p className="muted small">The database, not the model, decides whether a paid call fits the hold.</p></div>
            <div><h3>Collect in batches</h3><p className="muted small">PayPal charges 0.49 plus 3.49% per capture, so the owner collects once. <Link href="/collect">See the arithmetic</Link></p></div>
          </div>
        </section>
      </div>
    </Shell>
  );
}
