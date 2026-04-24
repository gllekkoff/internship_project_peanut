import { PRICE_SCALE } from '@/core/core.constants';
import type { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import type { VenueProfile } from '@/venues/venue.interfaces';

/**
 * Fetches live venue data from the exchange API and writes it into a VenueProfile.
 * Profiles ship with static defaults; hydration overwrites the mutable withdrawalFee
 * entries with real values at startup.
 */
export class VenueHydrator {
  /**
   * Calls fetchWithdrawalFees() on the client and writes live fee values into
   * profile.inventory.withdrawalFees entries. Sets profile.hydrated = true on completion.
   * Assets not returned by the API retain their static defaults — hydration never fails hard.
   */
  async hydrate(profile: VenueProfile, client: ExchangeClient): Promise<void> {
    try {
      const liveFees = await client.fetchWithdrawalFees();
      for (const [asset, feeScaled] of Object.entries(liveFees)) {
        const entry = profile.inventory.withdrawalFees[asset];
        if (entry !== undefined) {
          entry.withdrawalFee = feeScaled;
          console.log(
            `[VenueHydrator] ${profile.displayName} ${asset} withdrawalFee → ${feeScaled}`,
          );
        }
      }
      console.log(`[VenueHydrator] ${profile.displayName} profile hydrated (live fees)`);
    } catch (e) {
      // Testnet sandboxes don't expose fetchWithdrawalFees — static defaults remain in place.
      console.warn(
        `[VenueHydrator] fee fetch unavailable, using static defaults: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Profile is considered hydrated regardless — static defaults are valid for trading.
    profile.hydrated = true;
  }
}

/** Converts a float fee from ccxt to a bigint scaled by PRICE_SCALE. */
export function toScaledFee(fee: number): bigint {
  return BigInt(Math.round(fee * Number(PRICE_SCALE)));
}
