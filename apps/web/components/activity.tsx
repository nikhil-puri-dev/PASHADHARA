"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { callKind, cents, hold, REASON, shortId, usd, utc, useShowcase, type Call } from "../lib/showcase-store";
import { HoldNotice, Pill, Shell, Source } from "./site";

type F = "all" | "served" | "refused" | "collected";
const FILTERS: [F, string][] = [["all", "All"], ["served", "Served"], ["refused", "Refused"], ["collected", "Collected"]];

function status(c: Call) {
  const k = callKind(c);
  if (k === "refused") return <Pill kind="no">Refused</Pill>;
  if (k === "served") return c.captured ? <Pill kind="ok">Collected</Pill> : <Pill kind="wait">Spent, not collected</Pill>;
  return <Pill kind="n">{c.status.replace(/_/g, " ")}</Pill>;
}

export function Activity() {
  const s = useShowcase();
  const h = hold(s.data);
  const [filter, setFilter] = useState<F>("all");
  const [sel, setSel] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => { const id = new URLSearchParams(location.search).get("call"); if (id) setSel(id); }, []);
  const pick = (id: string | null) => {
    setSel(id);
    history.replaceState(null, "", id ? `/activity?call=${id}` : "/activity");
    if (id) setTimeout(() => sheet.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
  };
  const all = [...(s.data?.calls ?? []), ...(s.data?.refused_calls ?? [])].filter((c, i, a) => a.findIndex(x => x.id === c.id) === i)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const rows = all.filter(c => filter === "all" || (filter === "served" ? callKind(c) === "served" : filter === "refused" ? callKind(c) === "refused" : !!c.captured));
  const call = all.find(c => c.id === sel) ?? null;
  const refusedAny = all.some(c => callKind(c) === "refused");
  return (
    <Shell route="activity">
      <div className="page">
        <div className="pagehead"><h1>Activity</h1><p className="muted">Every paid call the agent made on this hold, and every call that was refused. Select a row for the detail.</p></div>
        <HoldNotice d={s.data} />
        {!s.data ? <div className="panel"><div className="body"><p className="muted">{s.loading ? "Reading the live hold..." : "The live read is not answering. Nothing is shown in its place."}</p></div></div> : (
          <div className={`split${call ? " open" : ""}`}>
            <section className="panel" aria-label="Calls">
              <div className="cap"><div className="chips" role="group" aria-label="Filter">
                {FILTERS.map(([k, label]) => <button key={k} className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>)}
              </div><span>{rows.length} result{rows.length === 1 ? "" : "s"}</span></div>
              {rows.length ? (
                <div className="scroll"><table className="tbl">
                  <thead><tr><th className="amt">Amount</th><th>Status</th><th className="hide-sm">Tool</th><th className="hide-sm">Time</th></tr></thead>
                  <tbody>
                    {rows.map(c => (
                      <tr key={c.id} className={`click${sel === c.id ? " sel" : ""}`} onClick={() => pick(c.id)}>
                        <td className="amt"><button className="rowbtn" style={{ textAlign: "right" }} aria-pressed={sel === c.id} aria-label={`Open ${c.tool_id}, ${usd(cents(c.price_minor))}, ${callKind(c)}`}>{usd(cents(c.price_minor))}</button></td>
                        <td>{status(c)}<div className="show-sm mono muted small">{c.tool_id} · {utc(c.created_at)}</div></td><td className="mono hide-sm">{c.tool_id}</td><td className="mono hide-sm">{utc(c.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              ) : (
                <div className="empty"><p>{all.length ? "No calls match this filter." : "Calls your agent pays for will appear here."}</p>{!all.length && <Link className="btn sm" href="/developers">Connect an agent</Link>}</div>
              )}
              {!refusedAny && <p className="src" style={{ margin: 16 }}>No refused call has been recorded on this hold yet. Use <Link href="/budget">Check an amount</Link> to see the limit check refuse one live. That check posts nothing, so it is not listed here.</p>}
            </section>
            {call && (
              <aside className="sheet" ref={sheet} aria-label="Call detail">
                <div className="row between"><h2>{call.tool_id} · {usd(cents(call.price_minor))}</h2>{status(call)}</div>
                <ol className="tl">
                  <li><span>Asked for {usd(cents(call.price_minor))}</span><span className="t">{utc(call.created_at)}</span></li>
                  {callKind(call) === "refused" ? (
                    <>
                      <li className="r"><span>Limit check failed: {REASON[call.status] ?? call.status}</span><span /></li>
                      <li className="r"><span>Refused before the model ran. Nothing charged.</span><span /></li>
                    </>
                  ) : (
                    <>
                      <li><span>Limit check passed</span><span /></li>
                      <li><span>Tool ran</span><span /></li>
                      <li><span>Committed to the journal</span><span /></li>
                      {call.captured ? <li><span>Collected by a PayPal capture</span><span /></li> : <li className="p"><span>Awaiting collection</span><span className="t">pending</span></li>}
                    </>
                  )}
                </ol>
                <dl className="kv">
                  <dt>Price</dt><dd>{usd(cents(call.price_minor))}</dd>
                  {call.captured !== undefined && callKind(call) === "served" && <><dt>Collected</dt><dd>{call.captured ? "yes" : "$0.00"}</dd></>}
                  {call.ledger_group_id && <><dt>Journal group</dt><dd>{shortId(call.ledger_group_id)}</dd></>}
                  {h?.paypalId && <><dt>PayPal hold</dt><dd>{shortId(h.paypalId)}</dd></>}
                </dl>
                <Source>{callKind(call) === "refused" ? "Gateway refusal record" : "Budget journal"}{s.data.read_at ? `, read ${utc(s.data.read_at)}` : ""}. <Link href="/proof#hold">See the PayPal evidence for this hold</Link></Source>
                <button className="btn sm" onClick={() => pick(null)}>Close</button>
              </aside>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}
