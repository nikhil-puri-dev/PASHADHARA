"use client";
import { useState, type ReactNode } from "react";
import s from "../../app/v3.module.css";
import { cx } from "./bits";

/* Connect: the same endpoint the Developers page documents. The paid call and refusal samples are shapes taken
   from recorded sandbox runs and are labelled as such. They are never produced by this page. */
const C = ({ children }: { children: ReactNode }) => <span className={s.c}>{children}</span>;
const K = ({ children }: { children: ReactNode }) => <span className={s.k}>{children}</span>;
const S = ({ children }: { children: ReactNode }) => <span className={s.s}>{children}</span>;
const R = ({ children }: { children: ReactNode }) => <span className={s.r}>{children}</span>;

const SAMPLES: Record<string, { label: string; text: string; node: ReactNode; note: string }> = {
  cfg: {
    label: "MCP config",
    text: `// .mcp.json\n{\n  "mcpServers": {\n    "pashadhara": {\n      "url": "https://pashadhara.vercel.app/api/mcp",\n      "headers": { "Authorization": "Bearer <lease token>" }\n    }\n  }\n}`,
    node: <><C>{"// .mcp.json"}</C>{"\n{\n  "}<K>"mcpServers"</K>{": {\n    "}<K>"pashadhara"</K>{": {\n      "}<K>"url"</K>{": "}<S>"https://pashadhara.vercel.app/api/mcp"</S>{",\n      "}<K>"headers"</K>{": { "}<K>"Authorization"</K>{": "}<S>"Bearer &lt;lease token&gt;"</S>{" }\n    }\n  }\n}"}</>,
    note: "Client settings. Your lease token comes from the budget owner.",
  },
  call: {
    label: "Paid call",
    text: `// tools/call, served (recorded shape)\n{\n  "name": "summarise",\n  "result": { "text": "..." },\n  "price": 3,\n  "charged": 3,\n  "hold_available": 997\n}`,
    node: <><C>{"// tools/call, served (recorded shape)"}</C>{"\n{\n  "}<K>"name"</K>{": "}<S>"summarise"</S>{",\n  "}<K>"result"</K>{": { "}<K>"text"</K>{": "}<S>"..."</S>{" },\n  "}<K>"price"</K>{": 3,\n  "}<K>"charged"</K>{": 3,\n  "}<K>"hold_available"</K>{": 997\n}"}</>,
    note: "Recorded, not live. Shape and values come from a recorded sandbox run on a 1000 cent hold.",
  },
  ref: {
    label: "Refusal",
    text: `// tools/call, refused. The tool never started. (recorded shape)\n{\n  "isError": true,\n  "error": "cap_reached",\n  "price": 3,\n  "remaining": 2,\n  "charged": 0\n}`,
    node: <><C>{"// tools/call, refused. The tool never started. (recorded shape)"}</C>{"\n{\n  "}<K>"isError"</K>{": true,\n  "}<K>"error"</K>{": "}<R>"cap_reached"</R>{",\n  "}<K>"price"</K>{": 3,\n  "}<K>"remaining"</K>{": 2,\n  "}<K>"charged"</K>{": 0\n}"}</>,
    note: "Recorded, not live. From a 5 cent sandbox lease: a 3 cent call after 3 cents were committed.",
  },
};

export function ConnectView() {
  const [tab, setTab] = useState("cfg");
  const [copy, setCopy] = useState("Copy");
  const cur = SAMPLES[tab]!;
  const doCopy = async () => { try { await navigator.clipboard.writeText(cur.text); setCopy("Copied"); setTimeout(() => setCopy("Copy"), 1400); } catch { setCopy("Select and copy"); } };
  return (
    <section aria-labelledby="con-h">
      <div className={s.mh}><h2 id="con-h" className={s.mhT}>Connect</h2><span className={s.dim} style={{ fontSize: 14 }}>One URL. Any MCP client.</span></div>
      <div className={s.tabs} role="group" aria-label="Samples">
        {Object.entries(SAMPLES).map(([k, v]) => <button key={k} className={s.tab} type="button" aria-pressed={tab === k} onClick={() => { setTab(k); setCopy("Copy"); }}>{v.label}</button>)}
      </div>
      <div className={s.cw}><button className={cx(s.copy)} type="button" onClick={() => void doCopy()}>{copy}</button><pre className={s.code} tabIndex={0}><code>{cur.node}</code></pre></div>
      <p className={s.srcNote}>{cur.note}</p>
      <div className={s.three}>
        <div><b>Refuses before it runs</b><span>The price check and the charge are one transaction. A failed model call rolls the charge back.</span></div>
        <div><b>Replay is free</b><span>A paid result is stored. The same key returns it, charged 0.</span></div>
        <div><b>Bring your own judge</b><span>Escrow jobs run two judges and release only what the rubric allows.</span></div>
      </div>
    </section>
  );
}
