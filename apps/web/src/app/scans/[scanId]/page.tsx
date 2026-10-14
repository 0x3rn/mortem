import type { Metadata } from "next";
import { ScanDetailClient } from "./scan-detail-client";

export const metadata: Metadata = {
  title: "Scan Lifecycle & Status — Mortem",
  description:
    "View real-time scan lifecycle stage, page discovery counters, and report status.",
};

export default async function ScanDetailPage({
  params,
}: {
  params: Promise<{ scanId: string }>;
}) {
  const { scanId } = await params;
  return <ScanDetailClient scanId={scanId} />;
}
