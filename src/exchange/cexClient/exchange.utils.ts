import { PRICE_SCALE } from '@/core/core.constants';

/** Floor quantity to the nearest valid lot size step. stepSize must be scaled by PRICE_SCALE. */
export function roundQuantity(qty: bigint, stepSize: bigint): bigint {
  if (stepSize === 0n) return qty;
  return (qty / stepSize) * stepSize;
}

/** Round price to the nearest valid tick. tickSize must be scaled by PRICE_SCALE. */
export function roundPrice(price: bigint, tickSize: bigint): bigint {
  if (tickSize === 0n) return price;
  return ((price + tickSize / 2n) / tickSize) * tickSize;
}

/**
 * Returns true if the order meets the MIN_NOTIONAL filter.
 * qty and price are both scaled by PRICE_SCALE — product is divided back to a single scale.
 */
export function checkMinNotional(qty: bigint, price: bigint, minNotional: bigint): boolean {
  return (qty * price) / PRICE_SCALE >= minNotional;
}
