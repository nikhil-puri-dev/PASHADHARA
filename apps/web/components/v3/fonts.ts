import { Bodoni_Moda, DM_Mono, Onest } from "next/font/google";

export const serif = Bodoni_Moda({ subsets: ["latin"], style: ["normal", "italic"], axes: ["opsz"], variable: "--v3-serif", display: "swap" });
export const mono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--v3-mono", display: "swap" });
export const sans = Onest({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--v3-sans", display: "swap" });
export const fontVars = `${serif.variable} ${mono.variable} ${sans.variable}`;
