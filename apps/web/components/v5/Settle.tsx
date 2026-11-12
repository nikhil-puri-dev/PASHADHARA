"use client";
import sp from "../settlement-proof.json";
import { setMode } from "./app";
import { RUN } from "./run";
import { simApi, useSim } from "./sim";
import { cx, money, Pv } from "./ui";

const toC = (v: string) => Math.round(Number(v) * 100);

function Bar({ parts, label }: { parts: { v: number; cls: string; text: string }[]; label: string }) {
  return <div className="recbar" role="img" aria-label={label}>{parts.filter(p => p.v > 0).map((p, i) => <div key={i} className={p.cls} style={{ flexGrow: p.v }}>{p.text}</div>)}</div>;
}

function SimSettle() {
  const s = useSim();
  if (s.served === 0) return <><p className="note" style={{ marginTop: 0 }}>Nothing to settle yet. Run the autopilot in step 2, then close the lease here.</p><a className="btn sm" href="#s2">Go to the autopilot ↑</a></>;
  if (!s.closed) return (
    <>
      <div className="terms"><div><small>Committed</small><span className="num">{money(s.committed)}</span></div><div><small>Refused, charged</small><span className="num">{s.refused} · $0.00</span></div></div>
      <p className="note">Closing captures the committed {money(s.committed)} in one go and releases the other {money(s.hold)}. The fee uses the formula measured on the $3.00 capture: 49 cents plus 3.49%. PayPal charged exactly the capture on the recorded 10 cent run, so very small captures may differ.</p>
      <button className="btn pri" type="button" onClick={() => { setMode("sim"); simApi.close(); }}>Close the lease and capture</button>
    </>
  );
  const net = s.captured - s.fee;
  return (
    <>
      <Bar label={`Captured ${money(s.captured)} of which fee ${money(s.fee)}, released ${money(s.released)}`} parts={[{ v: Math.max(net, 0), cls: "rb-net", text: net > 0 ? money(net) : "" }, { v: Math.min(s.fee, s.captured), cls: "rb-fee", text: money(Math.min(s.fee, s.captured)) }, { v: s.released, cls: "rb-rel", text: `${money(s.released)} released` }]} />
      <table className="rectab"><tbody>
        <tr><td>Captured gross</td><td className="num">{money(s.captured)}</td></tr>
        <tr><td>Fee, computed</td><td className="num">{money(s.fee)}</td></tr>
        <tr><td>Released</td><td className="num">{money(s.released)}</td></tr>
        <tr><td>Captured + released</td><td className="num">{money(s.captured + s.released)} of {money(s.cap)} <span className="ck">{s.captured + s.released === s.cap ? "conserved" : "mismatch"}</span></td></tr>
      </tbody></table>
      {net < 0 && <p className="note">The fee is larger than the sale. Per-call captures would make that worse.</p>}
      <p className="note">An illustration: no PayPal call was made, so there is nothing to read back. The recorded runs below were read back.</p>
    </>
  );
}

export function Settle() {
  const cap = toC(sp.measured.authorization.amount), gross = sp.computed.journal_minor.CAPTURED_GROSS, fee = sp.computed.journal_minor.PAYPAL_FEES, rel = sp.computed.journal_minor.RELEASED;
  const S = RUN.settlement, P = RUN.paypal;
  return (
    <section className="stage" id="s3">
      <div className="stage-h"><span className="stage-n">3</span><h2>Settle once. <em>Release the rest.</em></h2></div>
      <p className="stage-lede">Per call, nothing moves at PayPal. At the end the used amount is captured in one go, the rest is released, and the books are checked against what PayPal says.</p>

      <div className="blk"><div className="card"><h3>Your autopilot run <Pv k="illustrative" /></h3><SimSettle /></div></div>

      <div className="blk">
        <div className="card">
          <h3>Recorded agent run, reconciled <Pv k="measured" /></h3>
          <p className="note" style={{ marginTop: 0 }}>The five lookups from step 2, on a real {money(RUN.hold)} sandbox hold. One capture, read back from PayPal at {P.readAt.slice(11, 16)} UTC.</p>
          <Bar label="Capture of 10 cents, all of it PayPal fee; 10 cents of the hold left open" parts={[{ v: S.captured - S.fee, cls: "rb-net", text: "" }, { v: S.fee, cls: "rb-fee", text: `fee ${money(S.fee)}` }, { v: RUN.hold - S.captured, cls: "rb-un", text: `${money(RUN.hold - S.captured)} still open` }]} />
          <div className="scroll-x"><table className="rectab">
            <thead><tr><th>Check</th><th>Journal <Pv k="computed" /></th><th>PayPal GET <Pv k="measured" /></th><th /></tr></thead>
            <tbody>
              <tr><td>Captured</td><td className="num">{money(S.captured)}</td><td className="num">capture {P.capture.status}, USD {P.capture.amount}</td><td className="ck">match</td></tr>
              <tr><td>Fee</td><td className="num">{money(S.fee)}</td><td className="num">USD {P.capture.fee}</td><td className="ck">match</td></tr>
              <tr><td>Receipts</td><td className="num">{S.receipts} receipts, {S.groups} groups, {S.allocations} allocations of 2¢</td><td className="num">one capture, {P.capture.status}</td><td className="ck">match</td></tr>
              <tr><td>Hold</td><td className="num">{money(S.captured)} + {money(RUN.hold - S.captured)} open = {money(RUN.hold)}</td><td className="num">authorization {P.authorization.status}, USD {P.authorization.amount}</td><td className="ck">match</td></tr>
            </tbody>
          </table></div>
          <p className="note"><b>The fee equals the sale.</b> PayPal's fixed fee swallowed the whole 10 cents, which is why Pashadhara settles once instead of per call. The other 10 cents stayed an open authorization; it was not voided. <Pv k="fixture">invoice data is synthetic</Pv></p>
        </div>
      </div>

      <div className="blk">
        <div className="card">
          <h3>Recorded settlement of a {money(cap)} hold <Pv k="measured" /></h3>
          <p className="note" style={{ marginTop: 0 }}>Three kernel commitments totaling {money(gross)}, captured once, the rest voided. 12 Nov 2026. No model ran. <Pv k="fixture">usage is a fixture</Pv></p>
          <Bar label="Capture of 3 dollars, 59 cents of it fee, 7 dollars released" parts={[{ v: gross - fee, cls: "rb-net", text: money(gross - fee) }, { v: fee, cls: "rb-fee", text: money(fee) }, { v: rel, cls: "rb-rel", text: `${money(rel)} released` }]} />
          <div className="scroll-x"><table className="rectab">
            <thead><tr><th>Check</th><th>Journal <Pv k="computed" /></th><th>PayPal GET <Pv k="measured" /></th><th /></tr></thead>
            <tbody>
              <tr><td>Captured</td><td className="num">{money(gross)}</td><td className="num">capture {sp.measured.capture.status}, USD {sp.measured.capture.amount}</td><td className="ck">match</td></tr>
              <tr><td>Fee</td><td className="num">{money(fee)}</td><td className="num">USD {sp.measured.capture.paypal_fee}</td><td className="ck">match</td></tr>
              <tr><td>Released</td><td className="num">{money(rel)}</td><td className="num">authorization {sp.measured.authorization.status}, USD {sp.measured.authorization.amount}</td><td className="ck">match</td></tr>
              <tr><td>Conserved</td><td className="num">{money(gross)} + {money(rel)} = {money(gross + rel)}</td><td className="num">authorization USD {sp.measured.authorization.amount}</td><td className="ck">match</td></tr>
            </tbody>
          </table></div>
          <div className="feebars">
            <div className="fb"><span>One capture</span><div className="t"><i style={{ width: `${fee / 156 * 100}%`, background: "var(--water)" }} /></div><span className="num">{money(fee)}</span></div>
            <div className={cx("fb")}><span>Three captures (estimate)</span><div className="t"><i style={{ width: "100%", background: "var(--red)" }} /></div><span className="num">$1.56</span></div>
          </div>
          <p className="note">One capture is measured. Three would repeat the fixed part: an estimate from the same fee formula, not a PayPal result.</p>
        </div>
      </div>
      <p className="note">Not shown and not claimed: an automatic seller payout from this path, a scheduler running the settlement sweep on production, a signed webhook delivered by PayPal to the hosted site.</p>
    </section>
  );
}
