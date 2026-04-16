import 'dotenv/config';

/** Reads and validates all environment variables at module load time — throws immediately on missing required vars. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

export const config = {
  /** Ethereum chain + server settings. */
  chain: {
    mainnetRpcUrl: requireEnv('MAINNET_RPC_URL'),
    privateKey: requireEnv('PRIVATE_KEY') as `0x${string}`,
    sepoliaRpcUrl: optionalEnv('SEPOLIA_RPC_URL'),
    port: Number(optionalEnv('PORT', '3000')),
  },

  /** Binance exchange config — only required when using exchange features. */
  binance: {
    apiKey: optionalEnv('BINANCE_TESTNET_API_KEY'),
    secret: optionalEnv('BINANCE_TESTNET_SECRET'),
    sandbox: true,
    options: {
      defaultType: 'spot' as const,
    },
    enableRateLimit: true,
  },
} as const;
