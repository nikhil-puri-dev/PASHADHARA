import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Familjen_Grotesk, Spline_Sans_Mono } from "next/font/google";
import "./cord.css";
import "./tide.css";

const ui = Familjen_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--nf-ui", display: "swap" });
const data = Spline_Sans_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--nf-data", display: "swap" });

export const metadata: Metadata = {
  title: "Pashadhara | A budget your agent cannot break",
  description: "One PayPal hold becomes a spending limit enforced by a database, not by the model.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en" className={`${ui.variable} ${data.variable}`}><body>{children}</body></html>;
}
