"use client";
import Link from "next/link";
import { useState } from "react";
import { cents, feeFor, hold, usd, utc, useShowcase } from "../lib/showcase-store";
import { recorded } from "../lib/recorded";
import proof from "./proof-evidence.json";
import sandboxProof from "./finance-sandbox-proof.json";
import { HoldNotice, Pill, Shell, Source, useNow } from "./site";

const fixed = (n: number) => `$${(n / 100).toFixed(2)}`;
const day = (iso: string) => { const d = new Date(iso + (iso.length === 10 ? "T00:00:00Z" : "")); return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`; };

/* ---------------- Collect ---------------- */
export function Collect() {
  const s = useShowcase();
  const h = hold(s.data, useNow(60_000));
  const f = proof.fees;
  const caps = s.data?.captures ?? [];
  const spent = h?.spent ?? null;
  const now = spent != null && spent > 0 ? { fee: feeFor(spent), net: spent - feeFor(spent) } : null;
  return (
    <Shell route="collect">
      <div className="page">
        <div className="pagehead"><h1>Collect from the hold</h1><p className="muted">Spending is metered against the hold. The money moves only when the owner collects it with a PayPal capture. Each capture costs PayPal&apos;s fee, so fewer, larger captures keep more of it.</p></div>
        <HoldNotice d={s.data} />
        {s.data && spent != null && (
          <section className="panel">
            <div className="cap"><span>This hold</span><span>{s.data.read_at ? `Read ${utc(s.data.read_at)}` : ""}</span></div>
            <div className="body">
              <dl className="kv" style={{ fontSize: "1rem" }}>
                <dt>Spent, not collected</dt><dd>{usd(spent)}</dd>
                {now && <><dt>PayPal fee if collected now</dt><dd>{usd(now.fee)}</dd><dt>{now.net < 0 ? "Fee is more than the amount, by" : "Left after the fee"}</dt><dd>{usd(Math.abs(now.net))}</dd></>}
                <dt>Already collected</dt><dd>{usd(h?.collected ?? 0)}</dd>
              </dl>
              {now && <div className="act">{now.net <= 0 ? `Collecting ${usd(spent)} now would cost ${usd(now.fee)} in fees, more than it brings in. Wait until more is spent.` : `Collecting now would keep ${usd(now.net)} of ${usd(spent)}. Waiting for a larger total keeps more.`}</div>}
              <Source>Spent comes from the budget journal. The fee is computed with PayPal&apos;s measured rate of 0.49 plus 3.49% per capture. {caps.length ? "" : "No capture has been made on this hold yet."}</Source>
            </div>
          </section>
        )}
        {caps.length > 0 && (
          <section className="panel"><div className="cap"><span>Captures on this hold</span><span>{caps.length}</span></div>
            <div className="scroll"><table className="tbl"><thead><tr><th className="amt">Amount</th><th className="amt">PayPal fee</th><th>Status</th><th>Capture</th></tr></thead><tbody>
              {caps.map((c, i) => <tr key={c.id ?? i}><td className="amt">{usd(cents(c.amount_minor))}</td><td className="amt">{c.fee_minor != null ? usd(cents(c.fee_minor)) : ""}</td><td>{c.status ?? ""}</td><td className="mono">{c.paypal_capture_id ?? ""}</td></tr>)}
            </tbody></table></div></section>
        )}
        <section className="panel">
          <div className="cap"><span>Why batching matters</span><span>Recorded sandbox run, {day(f.date)}</span></div>
          <div className="body">
            <dl className="kv" style={{ fontSize: "1rem" }}>
              <dt>{f.rows.length} separate $1.00 captures</dt><dd>fees {fixed(f.feeTotal)} ({Math.round((f.feeTotal / f.total) * 100)}%)</dd>
              <dt>1 batched {fixed(f.total)} capture</dt><dd>fee {fixed(f.singleCaptureEstimate)} ({((f.singleCaptureEstimate / f.total) * 100).toFixed(1)}%)</dd>
              <dt><strong>Saved by batching</strong></dt><dd><strong>{fixed(f.feeTotal - f.singleCaptureEstimate)}</strong></dd>
            </dl>
            <Source>The {fixed(f.feeTotal)} is measured: PayPal returned a fee on each of {f.rows.length} real sandbox captures. The {fixed(f.singleCaptureEstimate)} for one capture is computed from the same rate. <Link href="/proof#captures">See the {f.rows.length} captures</Link></Source>
          </div>
        </section>
      </div>
    </Shell>
  );
}

/* ---------------- Escrow ---------------- */
export function Escrow() {
  const e = proof.escrow;
  const job = e.decision.amount;
  return (
    <Shell route="escrow">
      <div className="page">
        <div className="pagehead"><h1>Escrow</h1><p className="muted">A seller does a job. Two AI judges score it. The database, not a model, works out how much is released.</p></div>
        <div className="strip" role="group" aria-label="Job money">
          <div><div className="l">Job price</div><div className="v">{fixed(job)}</div></div>
          <div><div className="l">Held</div><div className="v">{fixed(job)}</div></div>
          <div><div className="l">Released</div><div className="v">{fixed(job)}</div></div>
          <div><div className="l">PayPal fee</div><div className="v">{fixed(e.capture.fee)}</div></div>
          <div><div className="l">Seller paid</div><div className="v">{fixed(e.payout.amount)}</div></div>
        </div>
        <section className="panel">
          <div className="cap"><span><Pill kind="wait">Recorded {day(e.date)}, not live</Pill> A real PayPal sandbox run.</span><Pill kind="ok">Released</Pill></div>
          <div className="body">
            <div className="checks">
              {e.verdicts.map(v => <div className="check" key={v.provider}><span>{v.provider} judge</span><span className="mono">{v.verdict} · {v.score}</span></div>)}
              <div className="check"><span>Limit check, using the buyer&apos;s rubric</span><span className="mono">release {fixed(job)}</span></div>
            </div>
            <div className="act ok">Captured {fixed(e.capture.amount)}, {e.capture.status}. Seller payout {e.payout.status}, {fixed(e.payout.amount)} after PayPal&apos;s {fixed(e.capture.fee)} fee.</div>
            <details>
              <summary>How judging works</summary>
              <p>The buyer sets a rubric before the job: score thresholds that map to a share of the price. The judges only return a verdict and a score. The database maps those to an amount, so no model ever chooses or emits one. Both judges scored 100 here, so the full {fixed(job)} was released.</p>
              <p className="muted small" style={{ marginTop: 8 }}>PayPal&apos;s separate payout processing fee of $0.25 appears in its response and is not in our journal.</p>
            </details>
            <Source>PayPal capture response ({e.capture.id}), PayPal payout GET (SUCCESS), OpenAI and Anthropic judge verdicts, and the database decision. Recorded {day(e.date)}. <Link href="/proof#escrow">PayPal evidence</Link></Source>
          </div>
        </section>
      </div>
    </Shell>
  );
}

/* ---------------- Developers ---------------- */
const MCP = "https://pashadhara.vercel.app/api/mcp";
const CONFIGS: Record<string, { label: string; code: string; note: string }> = {
  code: { label: "Claude Code", code: `claude mcp add --transport http pashadhara \\\n  ${MCP} \\\n  --header "Authorization: Bearer $BUDGET_TOKEN"`, note: "Adds the gateway as a remote MCP server." },
  json: { label: "Cursor and other clients", code: `{\n  "mcpServers": {\n    "pashadhara": {\n      "type": "http",\n      "url": "${MCP}",\n      "headers": { "Authorization": "Bearer $BUDGET_TOKEN" }\n    }\n  }\n}`, note: "Standard remote MCP settings. The shape is the same in any client that supports HTTP servers." },
  rest: { label: "Read the hold (REST)", code: `curl -H "Authorization: Bearer $BUDGET_TOKEN" \\\n  https://pashadhara.vercel.app/api/v1/leases/$BUDGET_ID`, note: "Returns hold_available, committed_unsettled and total_captured." },
};

export function Developers() {
  const s = useShowcase();
  const [tab, setTab] = useState("code");
  const [copied, setCopied] = useState<string | null>(null);
  const cfg = CONFIGS[tab] ?? CONFIGS.code!;
  const copy = async (key: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1500); } catch {} };
  const seen = new Map<string, number | null>();
  for (const c of s.data?.calls ?? []) seen.set(c.tool_id, cents(c.price_minor));
  const tools = seen.size ? [...seen] : [["summarise", 3] as [string, number | null]];
  return (
    <Shell route="developers">
      <div className="page">
        <div className="pagehead"><h1>Connect your agent</h1><p className="muted">The gateway is a remote MCP server. Your agent calls paid tools. Each call is checked against the hold before it runs.</p></div>
        <section className="panel">
          <div className="cap"><span>Set up</span><span>Sandbox</span></div>
          <div className="body">
            <div className="tabs" role="tablist" aria-label="Client">
              {Object.entries(CONFIGS).map(([k, v]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{v.label}</button>)}
            </div>
            <pre tabIndex={0}><code>{cfg.code}</code></pre>
            <p className="muted small">{cfg.note}</p>
            <div className="row"><button className="btn" onClick={() => copy("cfg", cfg.code)}>{copied === "cfg" ? "Copied" : "Copy config"}</button></div>
            <div><h3>Budget token</h3>
              <div className="keyrow" style={{ marginTop: 8 }}><code>$BUDGET_TOKEN</code><button className="btn" onClick={() => copy("tok", "$BUDGET_TOKEN")}>{copied === "tok" ? "Copied" : "Copy"}</button></div>
              <p className="muted small" style={{ marginTop: 8 }}>A budget token is issued when a buyer approves a hold. It is shown once and is not displayed on this site.</p></div>
          </div>
        </section>
        <section className="panel">
          <div className="cap"><span>Paid tools</span><span>{seen.size ? "From the live call records" : "Price is set in the database"}</span></div>
          <div className="scroll"><table className="tbl"><thead><tr><th>Tool</th><th className="amt">Price</th><th>Does</th></tr></thead><tbody>
            {tools.map(([name, p]) => <tr key={name}><td className="mono">{name}</td><td className="amt">{p != null ? usd(p) : ""}</td><td>{name === "summarise" ? "Summarises text with Claude Haiku 5.5" : "Paid tool on the gateway"}</td></tr>)}
          </tbody></table></div>
        </section>
        <section className="panel" id="renew">
          <div className="cap"><span>Renewing a hold</span></div>
          <div className="body"><p style={{ maxWidth: "64ch" }}>PayPal documents a 72 hour guarantee for an authorization. When it ends the gateway refuses paid calls on that hold by design, and the record stays readable. The owner approves a new hold as the sandbox buyer and points the demo at it. No visitor action can renew or release a hold.</p></div>
        </section>
      </div>
    </Shell>
  );
}

/* ---------------- Proof ---------------- */
export function Proof() {
  const s = useShowcase();
  const h = hold(s.data, useNow(60_000));
  const auth = recorded.find(r => r.kind === "authorization");
  const caps = recorded.filter(r => r.kind === "capture");
  const sp = sandboxProof;
  const [all, setAll] = useState(false);
  return (
    <Shell route="proof">
      <div className="page">
        <div className="pagehead"><h1>PayPal evidence</h1><p className="muted">What PayPal itself returned in sandbox calls, kept apart from what our code computed. Each block says which it is.</p></div>
        <section className="panel" id="hold">
          <div className="cap"><span>The live demo hold</span><span>{s.data?.read_at ? `Read ${utc(s.data.read_at)}` : ""}</span></div>
          <div className="body">
            {h ? (
              <dl className="kv">
                {h.paypalId && <><dt>PayPal authorization</dt><dd>{h.paypalId}</dd></>}
                {h.cap != null && <><dt>Authorized amount</dt><dd>{usd(h.cap)} USD</dd></>}
                {h.honor && <><dt>Guaranteed until</dt><dd>{utc(h.honor)}</dd></>}
                {h.expires && <><dt>PayPal authorization expires</dt><dd>{utc(h.expires)}</dd></>}
                <dt>Hold state</dt><dd className="txt">{h.state}</dd>
              </dl>
            ) : <p className="muted">{s.loading ? "Reading the live hold..." : "The live read is not answering. Nothing is shown in its place."}</p>}
            <Source>Authorization id and times were stored from PayPal&apos;s response when the buyer approved. Balances on this hold are computed from our ledger. This page did not make a PayPal call.</Source>
          </div>
        </section>
        <section className="panel" id="reads">
          <div className="cap"><span>PayPal GET of a sandbox authorization</span><Pill kind="n">measured</Pill></div>
          <div className="body">
            <dl className="kv">
              <dt>Authorization</dt><dd>{sp.paypal_get.http_status === 200 ? `HTTP ${sp.paypal_get.http_status}, id matches the local row` : ""}</dd>
              <dt>Status</dt><dd>{sp.paypal_get.status}</dd>
              <dt>Amount</dt><dd>{sp.paypal_get.amount.value} {sp.paypal_get.amount.currency_code}</dd>
              <dt>Refused over-budget call</dt><dd className="txt">{sp.refusal_probe.reason}; paid rows unchanged ({sp.refusal_probe.served_before.n} before, {sp.refusal_probe.served_after.n} after)</dd>
            </dl>
            <Source>Recorded 12 Nov in a PayPal sandbox run on a $0.16 hold. The tool charges are local journal commitments. Nothing was captured on that hold. Allowlisted fields only.</Source>
          </div>
        </section>
        <section className="panel" id="captures">
          <div className="cap"><span>{caps.length} captures on one authorization</span><Pill kind="n">measured</Pill></div>
          <div className="scroll"><table className="tbl"><thead><tr><th>PayPal capture</th><th className="amt">Amount</th><th className="amt">PayPal fee</th><th>Status</th><th>Time</th></tr></thead><tbody>
            {(all ? caps : caps.slice(0, 3)).map(c => <tr key={c.id}><td className="mono">{c.id}</td><td className="amt">${c.amount}</td><td className="amt">${c.fee}</td><td>{c.status}</td><td className="mono">{utc(c.at)}</td></tr>)}
          </tbody></table></div>
          <div className="body">{caps.length > 3 && <button className="btn sm" onClick={() => setAll(v => !v)}>{all ? "Show fewer" : `Show all ${caps.length}`}</button>}<dl className="kv"><dt>Total captured</dt><dd>{fixed(proof.fees.total)}</dd><dt>Total fees</dt><dd>{fixed(proof.fees.feeTotal)}</dd></dl>
            <Source>PayPal capture responses, {day(proof.fees.date)}. The two totals are computed by summing these rows. {auth ? `A later PayPal GET of the authorization returned PayPal status "${auth.status}".` : ""}</Source></div>
        </section>
        <section className="panel" id="escrow">
          <div className="cap"><span>Escrow job, recorded {day(proof.escrow.date)}</span><Pill kind="n">measured</Pill></div>
          <div className="body">
            <dl className="kv"><dt>Capture</dt><dd>{proof.escrow.capture.id}</dd><dt>Captured</dt><dd>{fixed(proof.escrow.capture.amount)} · fee {fixed(proof.escrow.capture.fee)}</dd><dt>Seller payout</dt><dd>{proof.escrow.payout.status} · {fixed(proof.escrow.payout.amount)}</dd></dl>
            <Source>PayPal capture response and payout GET. <Link href="/escrow">Back to the job</Link></Source>
          </div>
        </section>
        <section className="panel">
          <div className="cap"><span>What PayPal refused, and what we have not tested</span></div>
          <div className="body">
            <ul style={{ paddingLeft: "1.2rem", display: "flex", flexDirection: "column", gap: 6 }}>
              <li>Capture of $20.00 after $12.00 on a $20.00 authorization: 422 MAX_CAPTURE_AMOUNT_EXCEEDED. PayPal&apos;s default overage limit is 115%, so this does not prove a 100% cap. Measured.</li>
              <li>Capture after the hold was released: 422 AUTHORIZATION_VOIDED. Measured.</li>
              <li>Reauthorize on day 0: 422 REAUTHORIZATION_TOO_SOON, &quot;only allowed once from Day 4 to Day 29&quot;. Measured.</li>
              <li>Not tested: reauthorize on day 4 or later, capture after day 3, webhook latency and order.</li>
            </ul>
            <Source>Request log of the sandbox spike, {day(proof.limits.date)}. Raw rows stay out of the repository because they hold account fields.</Source>
          </div>
        </section>
      </div>
    </Shell>
  );
}
