# Ethereum Trading

TypeScript infrastructure for interacting with Ethereum — wallet management, transaction building, on-chain queries, and transaction analysis.

## Setup

```bash
npm install
```

Create a `.env` file in the project root:

```bash
cp .env.example  .env
```

```
PORT=your_port
API_KEY=your_api_key
SEPOLIA_RPC_URL=https://eth-sepolia.../API_KEY
MAINNET_RPC_URL=https://eth-mainnet.../API_KEY
PRIVATE_KEY=0x...
```

To generate a new wallet:

```bash
npx tsx -e "import { WalletManager } from './core/walletManager.js'; WalletManager.generate();"
```

Copy the printed key into `PRIVATE_KEY`.
## Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run lint` | Lint source files |
| `npm run format` | Format source files |

## Usage

### Send ETH

```typescript
import { WalletManager } from './core/walletManager.js';
import { ChainClient } from './chain/chainClient.js';
import { TransactionBuilder } from './chain/transactionBuilder.js';
import { Address, TokenAmount } from './core/baseTypes.js';
import { sepolia } from 'viem/chains';
import 'dotenv/config';

const wallet = WalletManager.from_env('PRIVATE_KEY');
const client = new ChainClient([process.env['SEPOLIA_RPC_URL']], 30, 3, sepolia);

const receipt = await new TransactionBuilder(client, wallet)
  .to(new Address('0xRecipient...'))
  .value(TokenAmount.fromHuman('0.01', 18, 'ETH'))
  .withGasEstimate()
  .withGasPrice('medium')
  .sendAndWait(120);

console.log(receipt.status ? 'SUCCESS' : 'FAILED');
console.log('Fee:', receipt.txFee.human, 'ETH');
```

### Check balance

```typescript
const balance = await client.getBalance(new Address('0x...'));
console.log(balance.human, 'ETH');
```

### Analyze a transaction

```bash
# Text output
npx tsx chain/analyzer.ts 0xYOUR_TX_HASH

# JSON output
npx tsx chain/analyzer.ts 0xYOUR_TX_HASH --format json

# With internal call trace
npx tsx chain/analyzer.ts 0xYOUR_TX_HASH --trace

# Custom RPC
npx tsx chain/analyzer.ts 0xYOUR_TX_HASH --rpc https://eth.llamarpc.com
```

### Integration test (Sepolia)

```bash
npx tsx scripts/integration_test.ts
```