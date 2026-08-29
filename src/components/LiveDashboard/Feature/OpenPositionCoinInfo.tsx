"use client";

import CoinTagSelect from "@/components/dev/Coins/CoinTagSelect";
import type { DynamicTradeConfig } from "@/lib/dynamic";
import type { SlowTradingHistoryPosition } from "@/lib/slowTrading";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Box, Button, Grid, TextField, Tooltip, Typography } from "@mui/material";
import type { ReactNode } from "react";

import DisplayCoinSymbol from "./DisplayCoin";
import {
  buildMaxEntryVolumeTooltip,
  estimateMaxEntryFromVolume24h,
  formatVolume24h,
} from "./LatestVolatilityPoints";

interface OpenPositionCoinInfoProps {
  actions?: ReactNode;
  availableTags: string[];
  coinDescription: string;
  coinTags: string[];
  config: DynamicTradeConfig;
  onCoinDescriptionChange: (symbol: string, description: string) => void;
  onCoinTagsChange: (symbol: string, tags: string[]) => void;
  position: SlowTradingHistoryPosition;
  tagColors: Record<string, string>;
  tagDescriptions: Record<string, string>;
  volume24h?: number;
}

/** Builds the CoinGlass pair heatmap URL for a dashboard position symbol. */
function getCoinGlassLiquidationMapUrl(symbol: string) {
  const coin = symbol
    .trim()
    .toUpperCase()
    .replace(/[-/_]?(?:USDT|USDC)$/u, "");

  return `https://www.coinglass.com/pro/futures/LiquidationHeatMapNew?coin=${encodeURIComponent(coin)}&type=pair`;
}

export default function OpenPositionCoinInfo({
  actions,
  availableTags,
  coinDescription,
  coinTags,
  config,
  onCoinDescriptionChange,
  onCoinTagsChange,
  position,
  tagColors,
  tagDescriptions,
  volume24h,
}: OpenPositionCoinInfoProps) {
  const maxEntryBased24HourVolPct = config.maxEntryBased24HourVolPct ?? 0.2;
  const estimatedMaxEntry = estimateMaxEntryFromVolume24h({
    maxEntryBased24HourVolPct,
    volume24h,
  });
  const maxEntryTooltip = buildMaxEntryVolumeTooltip({
    estimatedMaxEntry,
    maxEntryBased24HourVolPct,
    volume24h,
  });

  return (
    <Box
      sx={{
        borderTop: 1,
        borderColor: "divider",
        mt: 1,
        p: 1.5,
      }}
    >
      <Grid container spacing={1.5}>
        <Grid size={{ xs: 12, md: 4 }}>
          <Typography color="text.secondary" variant="caption">
            Coin links
          </Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.25 }}>
            <DisplayCoinSymbol symbol={position.symbol} onlyLink />
          </Box>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, mt: 1 }}>
            <Box>
              <Typography color="text.secondary" variant="caption">
                24h Vol
              </Typography>
              <Typography fontWeight={700} variant="body2">
                {formatVolume24h(volume24h)}
              </Typography>
            </Box>
            <Tooltip arrow title={maxEntryTooltip}>
              <Box>
                <Typography color="text.secondary" variant="caption">
                  Max Entry
                </Typography>
                <Typography fontWeight={700} variant="body2">
                  {formatVolume24h(estimatedMaxEntry)}
                </Typography>
              </Box>
            </Tooltip>
          </Box>
        </Grid>

        <Grid size={{ xs: 12, md: 3 }}>
          <Typography
            color="text.secondary"
            sx={{ display: "block", mb: 0.25 }}
            variant="caption"
          >
            Tags
          </Typography>
          <CoinTagSelect
            label=""
            onChange={(tags) => onCoinTagsChange(position.symbol, tags)}
            options={availableTags}
            tagColors={tagColors}
            tagDescriptions={tagDescriptions}
            value={coinTags}
          />
        </Grid>

        <Grid size={{ xs: 12, md: 5 }}>
          <Typography
            color="text.secondary"
            sx={{ display: "block", mb: 0.25 }}
            variant="caption"
          >
            Description
          </Typography>
          <TextField
            defaultValue={coinDescription}
            fullWidth
            minRows={2}
            multiline
            onBlur={(event) => {
              const normalized = event.target.value.trim();
              if (normalized !== coinDescription) {
                onCoinDescriptionChange(position.symbol, normalized);
              }
            }}
            placeholder="Notes"
            size="small"
            slotProps={{ htmlInput: { maxLength: 1_000 } }}
            variant="standard"
          />
        </Grid>
      </Grid>

      <Box
        sx={{
          alignItems: "center",
          borderTop: 1,
          borderColor: "divider",
          display: "flex",
          flexWrap: "wrap",
          gap: 1,
          justifyContent: "space-between",
          mt: 1.5,
          pt: 1.5,
        }}
      >
        <Button
          color="secondary"
          component="a"
          href={getCoinGlassLiquidationMapUrl(position.symbol)}
          rel="noopener noreferrer"
          size="small"
          startIcon={<OpenInNewIcon fontSize="small" />}
          sx={{ fontSize: "0.7rem", textTransform: "none" }}
          target="_blank"
          title={`Open the CoinGlass liquidation heatmap for ${position.symbol} in a new tab`}
          variant="outlined"
        >
          Liquidation Map
        </Button>
        {actions}
      </Box>
    </Box>
  );
}
