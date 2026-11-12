"use client";

import { useState } from "react";
import { CAP, EXPOSURE, PER_REQUEST, decide, initial, money, quotes, remaining, total, type Commitment, type Decision, type Delegation } from "../lib/delegation";
import "../app/cord.css";
import "../app/tide.css";
import "../app/delegation.css";

export function DelegationApp() {
  const [state, setState] = useState<Delegation>(initial);
  const [selected, setSelected] = useState<number | "authorize" | null>(null);
  const [notice, setNotice] = useState<Decision | null>(null);
  const spent = total(state);
  const free = remaining(state);
  const run = (id: string) => {
    const quote = quotes.find(q => q.id === id);
    if (!quote) return;
    const result = decide(state, quote);
    setState(result.next);
    setNotice(result.decision);
    setSelected(result.decision.outcome === "admitted" ? result.decision.sequence : selected);
  };
  const reset = () => { setState(initial); setNotice(null); setSelected(null); };
  const active: Commitment | undefined = typeof selected === "number" ? state.commitments.find(c => c.sequence === selected) : undefined;
  return <div className="delegation">
    <a className="dg-skip" href="#dg-main">Skip to workspace</a>
    <header className="dg-header"><a className="dg-brand" href="/">Pashadhara</a><nav aria-label="Primary"><a aria-current="page" href="/delegation">Delegation</a><a href="/lease?showcase=1">$2 sandbox pilot</a><a href="/proof">PayPal proof</a></nav></header>
    <main id="dg-main">
      <section className="dg-hero" aria-labelledby="dg-title">
        <div className="dg-intro"><p className="dg-kicker">Finance operations / scenario 01</p><h1 id="dg-title">The agent moves.<br/><em>You hold the line.</em></h1><p className="dg-lede">Delegate a quarter-close evidence run with fixed prices and a $5,000 ceiling. Let the agent request work without asking each time. A deterministic rule check decides whether it may proceed.</p><p className="dg-disclaimer"><strong>Interactive fixture.</strong> The $5,000 authority and all jobs below are sample data in this browser. No PayPal hold, provider task, or merchant payment is created.</p></div>
        <div className="dg-authority" aria-label="Fixture authority balance"><p className="dg-kicker">Remaining authority <span className="dg-chip">fixture</span></p><strong className="dg-big" data-testid="remaining">{money(free)}</strong><div className="dg-scale" role="img" aria-label={`${money(spent)} committed, ${money(free)} uncommitted of ${money(CAP)}`}><span style={{width:`${Number(spent * 100n / CAP)}%`}}/></div><div className="dg-scale-labels"><span><b>{money(spent)}</b> committed</span><span><b>{money(CAP)}</b> ceiling</span></div><p className="dg-small">Commitments are reserved in this fixture journal. No PayPal authorization or capture exists for this scenario.</p></div>
      </section>

      <section className="dg-workspace" aria-label="Delegation workspace">
        <div className="dg-desk"><div className="dg-section-head"><div><p className="dg-kicker">Decision desk</p><h2>What can the agent do next?</h2></div><span className="dg-step">01 / Admit or refuse</span></div><p className="dg-description">These are fixed sample quotes. Select one to apply the rules before the simulated task. A refusal creates no commitment and leaves the balance unchanged.</p>
          <div className="dg-quotes">{quotes.map(q => <div className="dg-quote" key={q.id}><div><span className="dg-category">{q.category}</span><h3>{q.name}</h3><p>{q.purpose}</p></div><div className="dg-quote-act"><strong>{money(q.amount)}</strong><button type="button" onClick={() => run(q.id)} aria-label={`Simulate request: ${q.name}, ${money(q.amount)}`}>Test request <span aria-hidden="true">↗</span></button></div></div>)}</div>
          {notice && <div className={`dg-result ${notice.outcome}`} role="status" data-testid="decision"><span className="dg-kicker">{notice.outcome === "admitted" ? "Admitted / fixture" : "Refused before execution / fixture"}</span><strong>{notice.name} · {money(notice.amount)}</strong><p>{notice.reason}. {notice.outcome === "admitted" ? "The simulated task completed and its commitment was posted to the fixture journal. No external task ran." : "No task ran. No journal posting was made."}</p></div>}
        </div>
        <aside className="dg-policy" aria-labelledby="dg-rules"><p className="dg-kicker">Authority set by the buyer</p><h2 id="dg-rules">Three rules. One decision.</h2><dl><div><dt>Total authority</dt><dd>{money(CAP)}</dd></div><div><dt>Per request</dt><dd>{money(PER_REQUEST)}</dd></div><div><dt>Outstanding exposure</dt><dd>{money(EXPOSURE)}</dd></div></dl><p>Amounts are fixed before the request. The model cannot choose a higher price. The real gateway checks its lease cap and outstanding exposure inside the kernel; this fixture adds a sample per-request ceiling for the business scenario.</p><p>PayPal authorization backs a platform hold. It does not directly pay arbitrary merchants. Settlement and any seller payout require separate platform steps.</p><a href="/proof">Inspect the historical sandbox run <span aria-hidden="true">↗</span></a></aside>
      </section>

      <section className="dg-journal" aria-labelledby="dg-journal-title"><div className="dg-section-head"><div><p className="dg-kicker">Inspectable fixture journal</p><h2 id="dg-journal-title">The record behind the balance.</h2></div><span className="dg-step">02 / Account for every cent</span></div><p>Sample authority and each accepted request have balanced, paired entries. Refusals appear in the decision trail but create no money entry. Select a row to inspect its posting.</p>
        <div className="dg-journal-grid"><div className="dg-ledger"><button type="button" className={selected === "authorize" ? "selected" : ""} onClick={() => setSelected("authorize")}><span><small>00 · Sample authority</small><b>Buyer authority opened</b></span><strong>{money(CAP)}</strong></button>{state.commitments.map(c => <button type="button" className={selected === c.sequence ? "selected" : ""} onClick={() => setSelected(c.sequence)} key={c.sequence}><span><small>{String(c.sequence).padStart(2,"0")} · {c.category}</small><b>{c.name}</b></span><strong>{money(c.amount)}</strong></button>)}</div><div className="dg-posting"><p className="dg-kicker">{selected === "authorize" ? "Journal group 00" : active ? `Journal group ${String(active.sequence).padStart(2,"0")}` : "Select a journal row"}</p><h3>{selected === "authorize" ? "Sample authority recorded" : active?.name ?? "Every entry has two sides."}</h3>{selected === null ? <p>Choose the sample authority or a commitment to see the debit and credit. The amounts below come from the same fixture state as the balance above.</p> : <><div className="dg-entry"><span>Debit</span><b>{selected === "authorize" ? "HOLD_AVAILABLE" : "COMMITTED_UNSETTLED"}</b><strong>{money(selected === "authorize" ? CAP : active!.amount)}</strong></div><div className="dg-entry"><span>Credit</span><b>{selected === "authorize" ? "BUYER_COMMITMENT" : "HOLD_AVAILABLE"}</b><strong>{money(selected === "authorize" ? CAP : active!.amount)}</strong></div><p>Balanced group · {money(selected === "authorize" ? CAP : active!.amount)} on each side · fixture</p></>}</div></div>
        <div className="dg-trail"><h3>Decision trail</h3>{state.decisions.length ? <ol>{state.decisions.map(d => <li key={d.sequence}><span className={d.outcome}>{d.outcome === "refused" ? "Refused" : "Admitted"}</span><b>{d.name}</b><span>{money(d.amount)}</span><small>{d.reason}{d.outcome === "refused" ? " · no posting" : " · journal group " + String(d.sequence).padStart(2,"0")}</small></li>)}</ol> : <p>No visitor requests yet. The three opening commitments are fixture history.</p>}</div>
        <div className="dg-journal-foot"><span>Computed from fixture cents: {money(CAP)} = {money(spent)} committed + {money(free)} remaining.</span><button type="button" onClick={reset}>Reset scenario</button></div>
      </section>
      <section className="dg-evidence"><div><p className="dg-kicker">Evidence boundary</p><h2>Historic proof stays historic.</h2><p>The separate PayPal proof records a $20 sandbox authorization, partial captures, fees, payout, and void from November 2026. This $5,000 scenario is a browser fixture and has no PayPal response behind it.</p></div><div><a href="/proof">View measured PayPal evidence</a><a href="/lease?showcase=1">Inspect the small sandbox lease</a></div></section>
    </main><footer className="dg-footer">Pashadhara · sandbox prototype · <span>fixture scenario, no real money movement</span></footer>
  </div>;
}
