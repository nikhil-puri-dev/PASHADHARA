import { Pv } from "./ui";

/* External figures. Each one was checked against its cited page: percent, sample, sponsor, date. The Gartner line is a forecast. */
const STATS: { big: string; unit?: string; text: string; by: string; href: string }[] = [
  { big: "53", unit: "%", text: "of organizations have had AI agents exceed their intended permissions.", by: "Cloud Security Alliance, commissioned by Zenity. n=445 IT and security professionals, Sep and Nov 2025.", href: "https://cloudsecurityalliance.org/press-releases/2026/04/16/more-than-half-of-organizations-experience-ai-agent-scope-violations-cloud-security-alliance-study-finds" },
  { big: "92", unit: "%", text: "of organizations implementing agentic AI reported costs higher or much higher than expected.", by: "IDC, sponsored by DataRobot. n=318 senior decision-makers, 1,000+ employee firms, July 2025.", href: "https://www.datarobot.com/newsroom/press/the-hidden-ai-tax-idc-research-reveals-nearly-all-organizations-lose-cost-control-when-deploying-genai-and-agentic-workflows-at-scale/" },
  { big: "1 in 5", text: "enterprises have no real-time way to stop a runaway agent before the bill arrives.", by: "VentureBeat Pulse Research. n=107 enterprises, July 2026.", href: "https://venturebeat.com/resources/agentic-orchestration-enterprise-ai-organizations-know-how-to-govern-agents-but-still-cant-meter-what-they-cost" },
  { big: "80", unit: "%", text: "of companies say their AI agents have taken unintended actions. 39% say agents accessed unauthorized systems.", by: "SailPoint, run by Dimensional Research (independent). n=353, May 2025.", href: "https://www.sailpoint.com/press-releases/sailpoint-ai-agent-adoption-report" },
];

export function Why() {
  return (
    <section className="stage" id="s0">
      <div className="stage-h"><span className="stage-n">0</span><h2>Agents spend. <em>Dashboards report.</em></h2></div>
      <p className="stage-lede">A hold is the other order: <b>permission first, spend second, reconciliation last</b>.</p>
      <div className="stats">
        {STATS.map(s => (
          <div className="stat" key={s.big}>
            <div className="big">{s.big}{s.unit && <i>{s.unit}</i>}</div>
            <p>{s.text}</p>
            <div className="by"><Pv k="survey" /> {s.by} <a className="src" href={s.href} target="_blank" rel="noopener noreferrer">Source</a></div>
          </div>
        ))}
      </div>
      <p className="note">Three of these are vendor-sponsored or vendor-run, and "unintended action" covers mistakes as well as attacks. They describe agents in general, not Pashadhara. Gartner forecast on 25 Jun 2025 that over 40% of agentic AI projects will be canceled by 2027 over costs, unclear value or weak risk controls (<a className="src" href="https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027" target="_blank" rel="noopener noreferrer">a forecast, not a measurement</a>).</p>
    </section>
  );
}
