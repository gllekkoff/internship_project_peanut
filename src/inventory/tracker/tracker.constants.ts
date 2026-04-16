/**
 * Maximum allowed deviation from the ideal even split before rebalancing is flagged, in percentage points.
 * Example: with 2 venues ideal is 50% each; deviation > 30pp means one venue holds > 80%.
 */
export const REBALANCE_THRESHOLD_PCT = 30;
