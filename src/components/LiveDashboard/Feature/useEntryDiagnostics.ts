"use client";

import { endpoints } from "@/components/endpoints";
import type { SlowTradingEntryDiagnostic } from "@/lib/slowTrading/client";
import axios from "axios";
import { useCallback, useEffect, useState } from "react";

interface EntryDiagnosticsResponse {
  diagnostics: SlowTradingEntryDiagnostic[];
  generatedAt: number;
}

export interface EntryDiagnosticsController {
  diagnostics: SlowTradingEntryDiagnostic[];
  error: string;
  generatedAt: number;
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Loads the shared entry diagnostics used by entry and position UI. */
export default function useEntryDiagnostics(): EntryDiagnosticsController {
  const [diagnostics, setDiagnostics] = useState<SlowTradingEntryDiagnostic[]>(
    [],
  );
  const [error, setError] = useState("");
  const [generatedAt, setGeneratedAt] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const response = await axios.get<EntryDiagnosticsResponse>(
        endpoints.slow.prod.entryDiagnostics,
      );
      setDiagnostics(response.data.diagnostics);
      setGeneratedAt(response.data.generatedAt);
    } catch (refreshError: any) {
      setError(
        refreshError?.response?.data?.error ??
          "Could not load entry decisions.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { diagnostics, error, generatedAt, loading, refresh };
}
