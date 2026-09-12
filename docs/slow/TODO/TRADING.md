`BOTH:POST_AVERAGE_STOP_LOSS`

Currently its based on

[minimum averaging count] [position net pnl pct] [position net pnl usd]

i need

[latest vpoint drift pct to the adverse direction. the vpoint is based on the vpoint that be used on the latest averaging]

so it will be like

```
                          position
[minimum averaging count] [position net pnl pct] [position net pnl usd]
                          vpoint
                          [vpoint adverse drift pct]
```

also for the both project

## FAQ

Yes—three decisions affect strategy behavior:

1. Should the vPoint adverse-drift boundary trigger independently with **OR** logic?

   Proposed: after the selected minimum averaging count, exit when any enabled boundary is reached:

   `net PnL % OR net PnL USDT OR adverse vPoint drift %`

   yes

2. Should the configured drift be a positive number?

   Proposed: `5` means exit at a `5%` adverse move from the vPoint that triggered the latest successful averaging:
   - LONG: `(vPointPrice - currentPrice) / vPointPrice × 100`
   - SHORT: `(currentPrice - vPointPrice) / vPointPrice × 100`
   - Equality triggers; `0` disables this boundary.

the default value is 0 (mean disabled)

3. Where should the vPoint price anchor be stored?

   Save it as `vPointPrice` on every completed averaging execution, alongside
   the existing `vPointId`. It is the price of the exact vPoint that triggered
   that averaging execution, not the averaging order's fill price and not the
   currently latest vPoint price.

   The post-average stop-loss evaluator reads `vPointPrice` from the latest
   completed averaging execution and uses it as the adverse-drift anchor. No
   runtime vPoint lookup or legacy fallback is required because this feature has
   not entered production yet.

4. What should Trading Live Preview show for this boundary?

   For every projected averaging stage, predict the fee-aware net USDT loss at
   the configured vPoint adverse-drift boundary. Use the projected position
   exposure and projected triggering vPoint price for that stage.

   Compare that predicted loss with the other active deterministic stop-loss
   boundaries. Trading Live Preview must identify the boundary expected to be
   reached first, including when the vPoint adverse-drift boundary comes before
   the position net-PnL percentage boundary, position net-PnL USDT boundary, or
   another existing stop-loss rule.

5. What is the threshold field name?

   Use `maxVPointAdverseDriftPct`. It is stored on each post-average stop-loss
   threshold row and defaults to `0`, which disables only this boundary.

The implementation preserves the existing PnL boundaries and adds this setting
to production, sandbox, and backtest, including settings, backtest rail
handling, Trading Live Preview, `vPointPrice` persistence, and
`BOTH:POST_AVERAGE_STOP_LOSS` tests.
