/** Known ERC-20 tokens on Arbitrum One used for portfolio tracking. */
export const ARBITRUM_TOKENS: Record<string, { address: `0x${string}`; decimals: number }> = {
  WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
  USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  'USDC.e': { address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6 },
  USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  ARB: { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
  WBTC: { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
};
