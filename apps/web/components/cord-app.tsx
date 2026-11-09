"use client";
import { useEffect } from "react";
import { startCord } from "./cord-engine";

/* The shell is static. The engine fills #hdr, #main and #ftr and owns everything inside them. */
export function CordApp() {
  useEffect(() => startCord(), []);
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header id="hdr" />
      <main id="main" tabIndex={-1} />
      <div className="sp" aria-hidden="true" />
      <footer id="ftr" hidden />
      <div id="live" className="sr" aria-live="polite" />
      <noscript><p style={{ padding: 24 }}>Pashadhara draws its cord with JavaScript. Please enable it.</p></noscript>
    </>
  );
}
