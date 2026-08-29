"use client";

import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { VPointTunerCombination } from "@/lib/devBacktest/vpoints";

export const VPOINT_TUNER_COLORS = [
  "#d32f2f",
  "#1976d2",
  "#2e7d32",
  "#7b1fa2",
  "#ed6c02",
  "#00838f",
  "#c2185b",
  "#5d4037",
  "#455a64",
  "#827717",
] as const;

interface CombinationEditorProps {
  combinations: VPointTunerCombination[];
  disabled: boolean;
  maxCombinations: number;
  onChange: (combinations: VPointTunerCombination[]) => void;
}

export default function CombinationEditor({
  combinations,
  disabled,
  maxCombinations,
  onChange,
}: CombinationEditorProps) {
  function update(
    index: number,
    field: keyof VPointTunerCombination,
    value: string,
  ) {
    onChange(
      combinations.map((combination, combinationIndex) =>
        combinationIndex === index
          ? { ...combination, [field]: Number(value) }
          : combination,
      ),
    );
  }

  function remove(index: number) {
    onChange(combinations.filter((_, combinationIndex) => combinationIndex !== index));
  }

  function add() {
    const last = combinations.at(-1) ?? {
      reversalThreshold: 1,
      vpointsThreshold: 2,
    };
    onChange([
      ...combinations,
      {
        reversalThreshold: last.reversalThreshold,
        vpointsThreshold: last.vpointsThreshold + 1,
      },
    ]);
  }

  return (
    <Box component="section" sx={{ display: "grid", gap: 1.25 }}>
      <Box
        sx={{
          alignItems: { sm: "center" },
          display: "flex",
          flexDirection: { xs: "column", sm: "row" },
          gap: 1,
          justifyContent: "space-between",
        }}
      >
        <Box>
          <Typography component="h2" fontWeight={750} variant="h6">
            Threshold combinations
          </Typography>
          <Typography color="text.secondary" variant="body2">
            Each color keeps the same combination on every coin chart.
          </Typography>
        </Box>
        <Button
          disabled={disabled || combinations.length >= maxCombinations}
          onClick={add}
          size="small"
          startIcon={<AddIcon />}
          sx={{ minHeight: 44 }}
          variant="outlined"
        >
          Add combination
        </Button>
      </Box>

      <Box sx={{ display: "grid", gap: 1 }}>
        {combinations.map((combination, index) => {
          const color = VPOINT_TUNER_COLORS[index % VPOINT_TUNER_COLORS.length];
          return (
            <Paper
              key={index}
              variant="outlined"
              sx={{
                alignItems: "center",
                display: "grid",
                gap: 1.25,
                gridTemplateColumns: {
                  xs: "auto minmax(0, 1fr) auto",
                  sm: "auto minmax(150px, 1fr) minmax(150px, 1fr) auto",
                },
                p: 1.25,
              }}
            >
              <Box
                aria-label={`Combination ${index + 1} color`}
                sx={{
                  bgcolor: color,
                  borderRadius: 1,
                  height: 32,
                  width: 8,
                }}
              />
              <TextField
                disabled={disabled}
                error={
                  !Number.isFinite(combination.vpointsThreshold) ||
                  combination.vpointsThreshold <= 0
                }
                fullWidth
                inputProps={{ min: 0.01, max: 100, step: 0.1 }}
                label={`#${index + 1} vPoint threshold %`}
                onChange={(event) =>
                  update(index, "vpointsThreshold", event.target.value)
                }
                size="small"
                type="number"
                value={combination.vpointsThreshold}
              />
              <TextField
                disabled={disabled}
                error={
                  !Number.isFinite(combination.reversalThreshold) ||
                  combination.reversalThreshold <= 0
                }
                fullWidth
                inputProps={{ min: 0.01, max: 100, step: 0.1 }}
                label="Reversal threshold %"
                onChange={(event) =>
                  update(index, "reversalThreshold", event.target.value)
                }
                size="small"
                sx={{ gridColumn: { xs: "2 / 3", sm: "auto" } }}
                type="number"
                value={combination.reversalThreshold}
              />
              <IconButton
                aria-label={`Remove combination ${index + 1}`}
                disabled={disabled || combinations.length === 1}
                onClick={() => remove(index)}
                sx={{ minHeight: 44, minWidth: 44 }}
              >
                <DeleteOutlineIcon />
              </IconButton>
            </Paper>
          );
        })}
      </Box>
    </Box>
  );
}
