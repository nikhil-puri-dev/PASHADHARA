import Link from "next/link";
import { Shell } from "../components/site";

export default function NotFound() {
  return (
    <Shell route="">
      <div className="page">
        <div className="pagehead">
          <p className="eyebrow">404</p>
          <h1>Page not found.</h1>
          <p>That address is not part of Pashadhara. Everything lives on the journey page or under the links in the menu.</p>
        </div>
        <div className="row"><Link className="btn pri" href="/">Back to the journey</Link><Link className="btn" href="/proof">PayPal evidence</Link></div>
      </div>
    </Shell>
  );
}
