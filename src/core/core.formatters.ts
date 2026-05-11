import { PRICE_SCALE_NUM } from '@/core/core.constants';

export function fmtUsd(v: bigint): string {
  return `$${(Number(v) / PRICE_SCALE_NUM).toFixed(4)}`;
}

export function fmtPrice(v: bigint): string {
  return `$${(Number(v) / PRICE_SCALE_NUM).toFixed(4)}`;
}

export function fmtAmt(v: bigint): string {
  return (Number(v) / PRICE_SCALE_NUM).toFixed(4);
}
