import type { Metadata } from "next";
import { FinanceInvestigation } from "../../components/finance-investigation";

export const metadata: Metadata = { title: "Recorded finance investigation | Pashadhara" };
export default function Page() { return <FinanceInvestigation />; }
