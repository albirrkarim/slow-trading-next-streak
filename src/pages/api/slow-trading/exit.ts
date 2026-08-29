import type { NextApiRequest, NextApiResponse } from "next";

import slowTrading from "@/lib/slowTrading";
import type { PositionRole } from "@/lib/trading/models";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      res.status(405).end(`Method ${req.method} Not Allowed`);
      return;
    }

    const symbol = String(req.body?.symbol || "").trim().toUpperCase();
    if (!symbol) {
      res.status(400).json({ error: "Symbol is required" });
      return;
    }
    const requestedRole = req.body?.role;
    if (
      requestedRole !== undefined &&
      requestedRole !== "MAIN" &&
      requestedRole !== "COUNTER"
    ) {
      res.status(400).json({ error: "Role must be MAIN or COUNTER" });
      return;
    }
    const role = requestedRole as PositionRole | undefined;

    const currentStorage = await slowTrading.storage.data.load({
      modeScope: "active",
    });
    const activeMode = currentStorage.runtime.sandboxEnabled ? "sandbox" : "live";
    const hasOpenPosition = currentStorage.modes[activeMode].tradeSettings.some(
      (item) =>
        String(item.symbol || "").trim().toUpperCase() === symbol &&
        (item.model_memory.positions ?? []).some(
          (position) =>
            !position.closed &&
            (!role ||
              (position.role === "COUNTER" ? "COUNTER" : "MAIN") === role),
        ),
    );

    if (!hasOpenPosition) {
      res.status(404).json({
        error:
          `No open ${role ? `${role} leg` : "position"} found for ${symbol}` +
          ` in ${activeMode} mode`,
      });
      return;
    }

    const result = await slowTrading.service.runSlowTradingCycle({
      ignoreRunnerEnabled: true,
      forceExitSymbols: role ? undefined : [symbol],
      forceExitTargets: role ? [{ role, symbol }] : undefined,
      disableAutoEntry: true,
    });

    const nextStorage = await slowTrading.storage.data.load({
      includeHistory: true,
    });

    res.status(200).json({
      success: true,
      result,
      state: await slowTrading.storage.dashboard.buildStateRealtime(nextStorage),
    });
  } catch (error: any) {
    await slowTrading.notifications.notifySlowTradingOperationalError({
      source: "api.slow-trading.exit",
      error,
      details: {
        method: req.method,
        role: req.body?.role,
        symbol: req.body?.symbol,
      },
    });

    res.status(500).json({
      error: error?.message ?? "Failed to exit slow trading position",
    });
  }
}
