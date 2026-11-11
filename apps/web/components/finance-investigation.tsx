import "../app/finance.css";

export function FinanceInvestigation() {
  return <div className="finance"><header><a href="/">Pashadhara</a><a href="/proof">Separate PayPal proof</a></header><main>
    <p className="finance-kicker">Recorded run · 12 November 2026</p><h1>A closer look at supplier payments.</h1>
    <p className="finance-intro">A model investigated four invoice pairs and chose two payment lookups. The review queue below is its recorded output, not a live session.</p>
    <p className="finance-notice"><strong>Fixture boundary.</strong> Invoice and payment records, and the 6¢ authorization, were synthetic. The model calls were real. This run did not include a budget refusal and has no connected PayPal response.</p>
    <div className="finance-stats"><div><span className="finance-kicker">Fixture budget</span><strong>6¢</strong></div><div><span className="finance-kicker">Computed spend</span><strong>4¢</strong></div><div><span className="finance-kicker">Computed remaining</span><strong>2¢</strong></div></div>
    <section><p className="finance-kicker">Model-selected evidence</p><h2>Two questions worth buying.</h2>
      <div className="finance-row"><strong>Pair B · 2¢</strong><div><p>The model investigated a possible invoice reissue. PAY-B showed one payment reversed before its replacement settled.</p><p className="finance-quiet">Fixture evidence · INV-B1, INV-B2, PAY-B</p></div></div>
      <div className="finance-row"><strong>Pair C · 2¢</strong><div><p>Different supplier and invoice names obscured a match. PAY-C showed two settled payments with the same remittance reference.</p><p className="finance-quiet">Fixture evidence · INV-C1, INV-C2, PAY-C</p></div></div>
    </section>
    <section><p className="finance-kicker">Human review queue · fixture</p><h2>What the agent returned.</h2>
      <div className="finance-row"><strong>A · Review</strong><p>Potential duplicate. Invoice fields match; payment status was not purchased or verified. INV-A1, INV-A2.</p></div>
      <div className="finance-row"><strong>B · Not duplicate</strong><p>Replacement after reversal. Reviewer should confirm bank records. INV-B1, INV-B2, PAY-B.</p></div>
      <div className="finance-row"><strong>C · Review</strong><p>Potential duplicate payment. Confirm vendor identity. INV-C1, INV-C2, PAY-C.</p></div>
      <div className="finance-row"><strong>D · Not duplicate</strong><p>Monthly billing pattern; no payment evidence purchased. INV-D1, INV-D2.</p></div>
    </section>
    <section><p className="finance-kicker">Separate PayPal sandbox run</p><h2>Refused, then adapted.</h2><p>In a separate recorded run, PayPal&apos;s sandbox authorized 6¢. The model requested a 7¢ fixture evidence bundle; the kernel refused it with no ledger commitment. It then selected three 2¢ lookups for A, B and C. Its final response was interrupted by its output limit. A separate model call reconstructed a review queue from the recorded results, without further purchases. A derived artifact mechanically adds three missing payment citations already present in the model rationale; the original is retained. The fixed-purchase baseline achieved the same three correct classifications and one abstention for the same 6¢ evidence spend. No capture was made.</p><p>An independent PayPal GET matched the authorization ID, amount and status against the kernel. The invoice and payment records remain fixtures.</p><p><a href="/finance-paypal-trace.jsonl">Read the interrupted run</a> · <a href="/finance-paypal-proof.json">PayPal GET and kernel evidence</a> · <a href="/finance-paypal-resume.jsonl">Original reconstructed response</a> · <a href="/finance-paypal-derived.jsonl">Citation repair</a></p></section>
    <section><p className="finance-kicker">Limits of the fixture run</p><h2>Small fixture, separate proof.</h2><p>Four synthetic pairs are not a general accuracy benchmark. The recorded comparison excludes model provider costs. The fixture run shown above did not attempt the 7¢ bundle or receive a refusal.</p><p><a href="/proof">See historical PayPal sandbox proof</a> · <a href="/finance-trace.jsonl">Read the fixture run</a></p></section>
  </main></div>;
}
