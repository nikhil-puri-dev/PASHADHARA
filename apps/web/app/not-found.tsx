import Link from "next/link";

export default function NotFound() {
  return (
    <main style={{ padding: "96px clamp(16px,4vw,56px)" }}>
      <h1 style={{ fontSize: "clamp(2.4rem,6vw,5rem)", fontWeight: 600, letterSpacing: "-.03em", lineHeight: 1 }}>Page not found.</h1>
      <p style={{ marginTop: 24, maxWidth: "32rem" }}>That address is not part of Pashadhara. The lease, escrow, settle and proof pages live behind the home page.</p>
      <p style={{ marginTop: 24 }}><Link className="btn fill" href="/">Back to the home page</Link></p>
    </main>
  );
}
