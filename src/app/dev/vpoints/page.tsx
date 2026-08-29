import { isDevBacktestEnabled } from "@/lib/env/devBacktest";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page() {
  if (!isDevBacktestEnabled()) {
    notFound();
  }

  const { default: VPointsPage } = await import(
    "@/components/dev/VPoints"
  );
  return <VPointsPage />;
}
