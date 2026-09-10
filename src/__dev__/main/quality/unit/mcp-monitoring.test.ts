import { afterEach, describe, expect, it, vi } from "vitest";
import slowTradingMcp from "@/lib/slowTrading/mcp";
import slowTradingMcpMonitoring from "@/lib/slowTrading/mcp/monitoring";
import slowTradingStorage from "@/lib/slowTrading/storage";

describe("SLOW MCP monitoring snapshot", () => {
  afterEach(() => vi.restoreAllMocks());
  // PROD:MCP_MONITORING_SNAPSHOT
  // PROD:MCP_MONITORING_CREDENTIAL_REDACTION
  // PROD:MCP_MONITORING_EFFECTIVE_CONFIG
  it("returns unified multi-account configuration without credentials", async () => {
    const storage = slowTradingStorage.data.createDefault();
    const account = storage.runtime.exchangeAccounts[0]!;
    account.credentials.apiKey = "secret-key";
    account.credentials.apiSecret = "secret-value";
    vi.spyOn(slowTradingStorage.data, "load").mockResolvedValue(storage);
    vi.spyOn(slowTradingStorage.logs, "load").mockResolvedValue({ errors: [{ id: "e", createdAt: 1, source: "test", status: "new", message: "secret-key", details: { apiSecret: "secret-value" } }], management: [], safeHaven: [], withdrawals: [] });
    const result = await slowTradingMcpMonitoring.read({ include: ["config", "automation", "logs"] }, "streak");
    const serialized = JSON.stringify(result);
    expect(result.instance.accountModel).toBe("multi");
    expect(result.config?.effectiveByAccount[account.slug]).toBeDefined();
    expect(result.logs?.errors[0]?.message).toBe("[REDACTED]");
    expect(serialized).not.toContain("secret-key");
    expect(serialized).not.toContain("secret-value");
  });
  // PROD:MCP_MONITORING_SECTION_FAILURE
  it("reports unavailable optional logs as a partial snapshot", async () => {
    vi.spyOn(slowTradingStorage.data, "load").mockResolvedValue(slowTradingStorage.data.createDefault());
    vi.spyOn(slowTradingStorage.logs, "load").mockRejectedValue(new Error("private failure"));
    const result = await slowTradingMcpMonitoring.read({ include: ["logs"] }, "streak");
    expect(result).toMatchObject({ status: "partial", issues: [{ section: "logs", code: "logs_unavailable" }] });
    expect(result).not.toHaveProperty("logs");
  });
  it("publishes a read-only monitoring tool", () => {
    expect(slowTradingMcp.tools.catalog().find((tool) => tool.name === "slow_monitoring_snapshot_read")).toMatchObject({ permission: "monitoring.read", readOnly: true });
  });
});
