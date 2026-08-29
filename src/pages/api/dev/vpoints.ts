import { isDevBacktestEnabled } from "@/lib/env/devBacktest";
import type { NextApiRequest, NextApiResponse } from "next";

export const config = {
  api: {
    responseLimit: false,
  },
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!isDevBacktestEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ error: `Method ${req.method} not allowed` });
    return;
  }

  try {
    const { default: vpointTuner } = await import(
      "@/lib/devBacktest/vpoints"
    );
    const action = String(req.body?.action ?? "");
    const range = vpointTuner.input.range.parse(req.body?.range);
    const [symbol, ...extraSymbols] = vpointTuner.input.symbols.parse([
      req.body?.symbol,
    ]);
    if (extraSymbols.length > 0) {
      throw new Error("Prepare or analyze one symbol per request");
    }

    if (action === "prepare") {
      const prepared = await vpointTuner.klines.prepare({ range, symbol });
      res.status(200).json(prepared);
      return;
    }

    if (action === "analyze") {
      const combinations = vpointTuner.input.combinations.parse(
        req.body?.combinations,
      );
      const analysis = await vpointTuner.analysis.run({
        combinations,
        range,
        symbol,
      });
      res.status(200).json(analysis);
      return;
    }

    if (action === "klines") {
      const klines = await vpointTuner.klines.chart.load({ range, symbol });
      res.status(200).json(klines);
      return;
    }

    res.status(400).json({ error: "Action must be prepare, analyze, or klines" });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "VPoint tuner failed",
    });
  }
}
