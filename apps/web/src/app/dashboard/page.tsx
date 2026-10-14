import type { Metadata } from "next";
import { DashboardClient } from "./dashboard-client";

export const metadata: Metadata = {
  title: "Dashboard & Scan History — Mortem",
  description:
    "Start website autopsies and review workspace-isolated scan and report history.",
};

export default function DashboardPage() {
  return <DashboardClient />;
}
