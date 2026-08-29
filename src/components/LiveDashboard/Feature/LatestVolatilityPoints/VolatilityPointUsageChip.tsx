"use client";

import { Chip, Tooltip } from "@mui/material";

export default function VolatilityPointUsageChip({
  symbol,
  used,
}: {
  symbol: string;
  used?: boolean;
}) {
  // PROD:LATEST_VOLATILITY_POINT_USAGE
  const isUsed = used === true;
  const label = isUsed ? "Used" : "Unused";
  const description = isUsed
    ? "This latest volatility point has already been used for an entry."
    : "This latest volatility point has not been used for an entry."

  return (
    <Tooltip arrow placement="top" title={description}>
      <Chip
        aria-label={`${symbol} latest volatility point: ${label.toLowerCase()}`}
        color={isUsed ? "warning" : "success"}
        label={label}
        size="small"
        sx={{
          height: 22,
          mt: 0.75,
          "& .MuiChip-label": {
            fontSize: "0.75rem",
            fontWeight: 700,
            px: 1,
          },
        }}
        role="status"
        variant="outlined"
      />
    </Tooltip>
  );
}
