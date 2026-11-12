import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { fontVars } from "../components/v5/fonts";
import "./site-chrome.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://pashadhara.vercel.app"),
  applicationName: "Pashadhara",
  title: { default: "Pashadhara | A budget your agent cannot break", template: "%s | Pashadhara" },
  description: "One PayPal hold becomes a spending limit enforced by a database, not by the model.",
  manifest: "/site.webmanifest",
  authors: [{ name: "Nikhil Puri", url: "https://github.com/nikhil-puri-dev" }],
};
export const viewport: Viewport = { themeColor: "#090507", colorScheme: "dark" };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en" className={fontVars}><body style={{ margin: 0, background: "#090507" }}>{children}</body></html>;
}
