import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalletManager } from '../core/walletManager.js';

// First Hardhat/Foundry default test account — safe to use in tests
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TEST_ENV = 'TEST_WALLET_KEY';

const makeWallet = () => {
  process.env[TEST_ENV] = TEST_KEY;
  return WalletManager.from_env(TEST_ENV);
};

// ─── from_env ─────────────────────────────────────────────────────────────────

describe('WalletManager.from_env', () => {
  beforeEach(() => {
    delete process.env[TEST_ENV];
    delete process.env['PRIVATE_KEY'];
  });

  it('throws when env var is not set', () => {
    expect(() => WalletManager.from_env(TEST_ENV)).toThrow(`${TEST_ENV} environment variable not set`);
  });

  it('throws when private key lacks 0x prefix', () => {
    process.env[TEST_ENV] = TEST_KEY.slice(2);
    expect(() => WalletManager.from_env(TEST_ENV)).toThrow('Invalid private key format');
  });

  it('loads wallet and derives correct address', () => {
    process.env[TEST_ENV] = TEST_KEY;
    expect(WalletManager.from_env(TEST_ENV).getAddress()).toBe(TEST_ADDRESS);
  });

  it('uses PRIVATE_KEY as default env var name', () => {
    process.env['PRIVATE_KEY'] = TEST_KEY;
    expect(WalletManager.from_env().getAddress()).toBe(TEST_ADDRESS);
  });
});

// ─── generate ────────────────────────────────────────────────────────────────

describe('WalletManager.generate', () => {
  it('creates a wallet with a valid Ethereum address', () => {
    expect(WalletManager.generate().getAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('each call generates a unique address', () => {
    expect(WalletManager.generate().getAddress()).not.toBe(WalletManager.generate().getAddress());
  });
});


describe('WalletManager - private key exposure', () => {
  let wallet: WalletManager;

  beforeEach(() => {
    wallet = makeWallet();
  });

  it('toString does not contain the private key', () => {
    expect(wallet.toString()).not.toContain(TEST_KEY);
    expect(wallet.toString()).not.toContain(TEST_KEY.slice(2));
  });

  it('toString returns only the address', () => {
    expect(wallet.toString()).toBe(`WalletManager(address=${TEST_ADDRESS})`);
  });

  it('JSON.stringify does not expose the private key', () => {
    const json = JSON.stringify(wallet);
    expect(json).not.toContain(TEST_KEY);
    expect(json).not.toContain(TEST_KEY.slice(2));
  });

  it('toJSON returns only the address field', () => {
    expect(wallet.toJSON()).toEqual({ address: TEST_ADDRESS });
  });
});


describe('WalletManager.signMessage', () => {
  let wallet: WalletManager;

  beforeEach(() => {
    wallet = makeWallet();
  });

  it('rejects empty string', async () => {
    await expect(wallet.signMessage('')).rejects.toThrow('message must not be empty');
  });

  it('rejects whitespace-only string', async () => {
    await expect(wallet.signMessage('   ')).rejects.toThrow('message must not be empty');
  });

  it('rejects tab and newline string', async () => {
    await expect(wallet.signMessage('\t\n')).rejects.toThrow('message must not be empty');
  });

  it('signs a valid message and returns 65-byte hex signature', async () => {
    const sig = await wallet.signMessage('hello');
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('signs unicode message', async () => {
    const sig = await wallet.signMessage('こんにちは 🚀');
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('same message produces same signature', async () => {
    const sig1 = await wallet.signMessage('hello');
    const sig2 = await wallet.signMessage('hello');
    expect(sig1).toBe(sig2);
  });

  it('different messages produce different signatures', async () => {
    const sig1 = await wallet.signMessage('hello');
    const sig2 = await wallet.signMessage('world');
    expect(sig1).not.toBe(sig2);
  });

  it('error from empty message does not expose private key', async () => {
    try {
      await wallet.signMessage('');
    } catch (e) {
      expect(String(e)).not.toContain(TEST_KEY);
    }
  });
});


describe('WalletManager.signTypedData', () => {
  let wallet: WalletManager;

  beforeEach(() => {
    wallet = makeWallet();
  });

  it('rejects empty types object before any crypto', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(wallet.signTypedData({}, {} as any, {} as any)).rejects.toThrow(
      'types object is empty',
    );
  });

  it('signs valid EIP-712 typed data and returns 65-byte hex', async () => {
    const domain = { name: 'Test', version: '1', chainId: 1 };
    const types = { Order: [{ name: 'amount', type: 'uint256' }] };
    const value = { amount: 100n };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig = await wallet.signTypedData(domain, types as any, value as any);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('same typed data produces same signature', async () => {
    const domain = { name: 'Test', version: '1', chainId: 1 };
    const types = { Order: [{ name: 'amount', type: 'uint256' }] };
    const value = { amount: 100n };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig1 = await wallet.signTypedData(domain, types as any, value as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig2 = await wallet.signTypedData(domain, types as any, value as any);
    expect(sig1).toBe(sig2);
  });
});


describe('WalletManager.signTransaction', () => {
  let wallet: WalletManager;

  const validTx = {
    to: TEST_ADDRESS as `0x${string}`,
    chainId: 1,
    gas: 21000n,
    nonce: 0,
    gasPrice: 1000000000n,
    type: 'legacy' as const,
  };

  beforeEach(() => {
    wallet = makeWallet();
  });

  it('rejects transaction missing "to" field', async () => {
    const { to: _to, ...tx } = validTx;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(wallet.signTransaction(tx as any)).rejects.toThrow('missing required field: to');
  });

  it('rejects transaction missing "chainId" field', async () => {
    const { chainId: _chainId, ...tx } = validTx;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(wallet.signTransaction(tx as any)).rejects.toThrow('missing required field: chainId');
  });

  it('rejects transaction missing "gas" field', async () => {
    const { gas: _gas, ...tx } = validTx;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(wallet.signTransaction(tx as any)).rejects.toThrow('missing required field: gas');
  });

  it('rejects transaction missing "nonce" field', async () => {
    const { nonce: _nonce, ...tx } = validTx;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(wallet.signTransaction(tx as any)).rejects.toThrow('missing required field: nonce');
  });

  it('signs valid legacy transaction and returns hex', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig = await wallet.signTransaction(validTx as any);
    expect(sig).toMatch(/^0x[0-9a-f]+$/);
  });

  it('error from missing field does not expose private key', async () => {
    const { to: _to, ...tx } = validTx;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await wallet.signTransaction(tx as any);
    } catch (e) {
      expect(String(e)).not.toContain(TEST_KEY);
    }
  });
});


describe('WalletManager keyfile', () => {
  let tmpDir: string;
  let keyfilePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'wallet-test-'));
    keyfilePath = join(tmpDir, 'keyfile.json');
    process.env[TEST_ENV] = TEST_KEY;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('to_keyfile writes a valid JSON file', async () => {
    const wallet = makeWallet();
    await wallet.to_keyfile(keyfilePath, 'test-password');
    const { readFile } = await import('fs/promises');
    const content = await readFile(keyfilePath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('from_keyfile recovers the original address', async () => {
    const original = makeWallet();
    await original.to_keyfile(keyfilePath, 'test-password');

    const loaded = await WalletManager.from_keyfile(keyfilePath, 'test-password');
    expect(loaded.getAddress()).toBe(TEST_ADDRESS);
  });

  it('from_keyfile wallet can sign (is fully functional)', async () => {
    const original = makeWallet();
    await original.to_keyfile(keyfilePath, 'secret');

    const loaded = await WalletManager.from_keyfile(keyfilePath, 'secret');
    const sig = await loaded.signMessage('hello');
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('loaded wallet produces same signature as original', async () => {
    const original = makeWallet();
    await original.to_keyfile(keyfilePath, 'secret');
    const loaded = await WalletManager.from_keyfile(keyfilePath, 'secret');

    const msg = 'round-trip test';
    expect(await loaded.signMessage(msg)).toBe(await original.signMessage(msg));
  });

  it('from_keyfile rejects wrong password', async () => {
    const wallet = makeWallet();
    await wallet.to_keyfile(keyfilePath, 'correct-password');

    await expect(WalletManager.from_keyfile(keyfilePath, 'wrong-password')).rejects.toThrow(
      'invalid keyfile or wrong password',
    );
  });

  it('from_keyfile error on wrong password does not expose the password', async () => {
    const wallet = makeWallet();
    await wallet.to_keyfile(keyfilePath, 'correct-password');

    try {
      await WalletManager.from_keyfile(keyfilePath, 'wrong-password');
    } catch (e) {
      expect(String(e)).not.toContain('wrong-password');
      expect(String(e)).not.toContain('correct-password');
    }
  });

  it('from_keyfile rejects non-existent file with clear message', async () => {
    await expect(WalletManager.from_keyfile('/no/such/file.json', 'pw')).rejects.toThrow(
      'Failed to read keyfile',
    );
  });

  it('from_keyfile rejects invalid JSON', async () => {
    const { writeFile } = await import('fs/promises');
    await writeFile(keyfilePath, 'not-json', 'utf-8');
    await expect(WalletManager.from_keyfile(keyfilePath, 'pw')).rejects.toThrow(
      'invalid keyfile or wrong password',
    );
  });

  it('toJSON of loaded wallet does not expose private key', async () => {
    const original = makeWallet();
    await original.to_keyfile(keyfilePath, 'secret');
    const loaded = await WalletManager.from_keyfile(keyfilePath, 'secret');

    expect(JSON.stringify(loaded)).not.toContain(TEST_KEY);
    expect(loaded.toJSON()).toEqual({ address: TEST_ADDRESS });
  });
});
