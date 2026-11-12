import Link from "next/link";
import { useEffect, useRef } from "react";
import { utc } from "../../lib/showcase-store";

/* One navigation and one footer for every page. The journey page adds its own step row on top. */
export const SITE_NAV: [string, string][] = [
  ["/", "Journey"], ["/check", "Check"], ["/budget", "Budget"], ["/activity", "Journal"], ["/collect", "Settle"], ["/escrow", "Escrow"], ["/developers", "Connect"], ["/finance", "Finance agent"], ["/proof", "Evidence"], ["/#about", "About"],
];
export const CREATOR = { name: "Nikhil Puri", github: "https://github.com/nikhil-puri-dev" };

export function SiteBrand() {
  return <Link className="brand" href="/" aria-label="Pashadhara home"><img src="/mark.svg" alt="" width={30} height={30} />Pashadhara</Link>;
}

export function SitePages({ route, open, onToggle, onClose }: { route: string; open: boolean; onToggle: () => void; onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open) nav.current?.querySelector("a")?.focus();
  }, [open]);
  return <div onKeyDown={event => {
    if (event.key === "Escape" && open) {
      onClose();
      button.current?.focus();
    }
  }}>
    <button ref={button} className="pages-btn" type="button" aria-expanded={open} aria-controls={open ? "site-pages" : undefined} onClick={onToggle}>Pages<span aria-hidden="true"> ▾</span></button>
    {open && <nav ref={nav} className="steps-menu" id="site-pages" aria-label="Site pages">
      {SITE_NAV.map(([href, label]) => <Link key={href} href={href} aria-current={href === route ? "page" : undefined} onClick={onClose}>{label}</Link>)}
    </nav>}
  </div>;
}

export function SiteFooter({ honor }: { honor?: string | null }) {
  return (
    <footer>
      <div className="ft">
        <div>
          <div className="wm" aria-label="Pashadhara">Pasha<i>dhara</i></div>
          <p className="note">pasha, the bond. dhara, the bearer. An agent should be free to act exactly as far as it was trusted, and not one cent further.</p>
          <nav className="footer-links" aria-label="Footer">{SITE_NAV.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}</nav>
        </div>
        <div>
          <h3>What this does not claim</h3>
          <ul>
            <li><b>Sandbox money.</b> Every hold, capture and void is PayPal sandbox.</li>
            <li><b>A hold ends.</b> PayPal honors this one {honor ? `until ${utc(honor)}` : "for a limited window"}. After that spending is off and the page says so.</li>
            <li><b>A void ends spending.</b> After a void every paid call is refused and charged nothing (tested at kernel level). A separate recorded settlement did void its remainder at PayPal.</li>
            <li><b>The autopilot is a drill.</b> Real rules, scripted agents.</li>
          </ul>
        </div>
        <div className="fine"><span>Built for the PayPal AI Hackathon · MIT</span><span>By <Link href="/#about">{CREATOR.name}</Link></span></div>
      </div>
    </footer>
  );
}
