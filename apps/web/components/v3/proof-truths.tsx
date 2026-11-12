import Link from "next/link";
import s from "../../app/v3.module.css";
import proof from "../proof-evidence.json";
import { cx, Mark } from "./bits";
import { MotionButton } from "./shell";

/* Figures. Each card says where it came from. The $2.41 card is read from the recorded escrow proof JSON. */
export function ProofRow() {
  const cap = proof.escrow.capture.amount, fee = proof.escrow.capture.fee, net = proof.escrow.payout.amount;
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const w = (c: number) => Math.round(200 * c / cap);
  return (
    <section className={cx(s.sec, s.band2)} id="proof" aria-labelledby="proof-h">
      <div className={s.wrap}>
        <h2 id="proof-h">Every number says <em>where it came from.</em></h2>
        <div className={s.pf}>
          <div><span className={s.tag}>measured</span><div className={s.viz}><div className={s.dots} aria-hidden="true"><i /><i /><i /></div></div><div className={s.v}>3 of 3</div><p>Real sandbox leases. A paid call debits the hold, then calls past the cap are refused.</p></div>
          <div><span className={s.tag}>measured</span><div className={s.viz}><div className={s.bar} aria-hidden="true"><i style={{ width: 0 }} /></div></div><div className={s.v} style={{ color: "var(--red)" }}>$0.00</div><p>Charged on a refusal. Over-cap and voided-lease calls leave a row and no ledger group.</p></div>
          <div><span className={s.tag}>measured</span><div className={s.viz}><svg viewBox="0 0 200 22" style={{ width: "100%" }} aria-hidden="true"><rect width={w(net)} height="18" y="2" fill="var(--water2)" /><rect x={w(net) + 2} width={w(fee)} height="18" y="2" fill="var(--faint)" /></svg></div><div className={s.v}>{money(net)}</div><p>Net payout from a {money(cap)} capture. PayPal kept {money(fee)}. An independent PayPal read matched the journal.</p></div>
          <div><span className={s.tag}>measured</span><div className={s.viz}><div className={s.bar} aria-hidden="true"><i style={{ width: "100%" }} /></div></div><div className={s.v}>83/83</div><p>API unit tests passed in the last full local run, 12 Nov 2026. Kernel and gateway suites are counted separately.</p></div>
        </div>
        <p className={s.pfNote}>The thurible, the tape and the checks on this page read the live sandbox hold. If it cannot be reached the page says "Recorded, not live" and shows one recorded run instead. <Link className={s.lnk} href="/proof">Open the PayPal evidence</Link></p>
        <div className={s.truths}>
          <div><b>It is sandbox money.</b><span>Every hold, capture and payout is PayPal sandbox. Nothing real moves.</span></div>
          <div><b>A hold ends.</b><span>PayPal honors an authorization for a limited window. Then spending stops and the page shows the date.</span></div>
          <div><b>A model result is one sample.</b><span>The finance agent scored 9 of 12 on one real run. No advantage over the baselines is claimed.</span></div>
          <div><b>A void cuts the budget, not every token.</b><span>After a void, every paid call is refused and nothing is charged. The token itself is not yet revoked on every path.</span></div>
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer>
      <div className={s.wrap}>
        <div className={s.fm}><Mark /><h2 className={s.bw} aria-label="Pashadhara">Pasha<i>dhara</i></h2></div>
        <div className={s.gl}><span>pasha · the bond</span><span className={s.dv} lang="sa">पाशधारा</span><span>dhara · the bearer</span></div>
        <div className={s.sign}>
          <p>An agent should be free to act exactly as far as it was trusted, and not one cent further.</p>
          <Link className={cx(s.btn, s.pri)} href="/demo">Open the full demo</Link>
        </div>
        <div className={s.fine}><span>Built for the PayPal AI Hackathon · PayPal sandbox · MIT · <span className={s.dv} lang="sa">ऋतम्</span> rta, the order that holds</span><MotionButton /></div>
      </div>
    </footer>
  );
}
