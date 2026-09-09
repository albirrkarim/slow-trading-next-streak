import coinTags from "@/lib/devBacktest/coins/tags";

export type SpeedTier = 1 | 2 | 3;
export type SpeedTierBySymbol = Record<string, SpeedTier>;

export function getSpeedTierFromMap(
  symbol: string,
  speedTierBySymbol: SpeedTierBySymbol,
): SpeedTier {
  return speedTierBySymbol[symbol.trim().toUpperCase()] ?? 3;
}

function parseSpeedTierTag(tag: string): SpeedTier | null {
  const normalized = tag.trim().toLocaleLowerCase();
  const match =
    normalized.match(/^speed\s*tier\s*([123])$/) ??
    normalized.match(/^tier\s*([123])$/);
  const tier = Number(match?.[1]);
  return tier === 1 || tier === 2 || tier === 3 ? tier : null;
}

/** Builds the exit-priority speed-tier lookup from persisted coin tags. */
export function buildSpeedTierBySymbolFromCoinTags(
  coinTagMap: Record<string, string[]>,
): SpeedTierBySymbol {
  const result: SpeedTierBySymbol = {};
  for (const [symbolInput, tags] of Object.entries(coinTagMap)) {
    const symbol = symbolInput.trim().toUpperCase();
    if (!symbol) continue;
    for (const tag of tags) {
      const speedTier = parseSpeedTierTag(tag);
      if (speedTier) {
        result[symbol] = speedTier;
        break;
      }
    }
  }
  return result;
}

export function buildSpeedTierBySymbolFromMetadata(): SpeedTierBySymbol {
  return buildSpeedTierBySymbolFromCoinTags(coinTags.list().coinTags);
}
