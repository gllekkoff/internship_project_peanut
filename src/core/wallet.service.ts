import { readFile, writeFile } from 'fs/promises';
import type { Hex, TransactionSerializable, TypedDataDomain, TypedDataParameter } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Wallet } from 'ethers'; // ethers: viem lacks Web3 Secret Storage keyfile decryption
import { WalletError, SigningError, KeyfileError } from '@/core/core.errors';

/**
 * Loads and holds a private key; signs messages, typed data, and transactions.
 * The private key never appears in logs, errors, or serialized representations.
 */
export class WalletManager {
  private privateKey: `0x${string}`;
  private address: string;
  private static shownPrivateKey = false;

  private constructor(privateKey: `0x${string}`) {
    this.privateKey = privateKey;
    this.address = this.getAddress();
  }

  /** Loads the private key from the named environment variable (defaults to PRIVATE_KEY). */
  static from_env(env_var: string = 'PRIVATE_KEY'): WalletManager {
    const rawPrivateKey = process.env[env_var];
    if (!rawPrivateKey) {
      throw new WalletError(`${env_var} environment variable not set`);
    }
    if (!rawPrivateKey.startsWith('0x')) {
      throw new WalletError('Invalid private key format');
    }
    return new WalletManager(rawPrivateKey as `0x${string}`); // validated 0x prefix above
  }

  /** Generates a fresh random private key and prints it once to stdout. */
  static generate(): WalletManager {
    const privateKey = generatePrivateKey();
    if (!WalletManager.shownPrivateKey) {
      console.log('Generated private key:', privateKey);
      WalletManager.shownPrivateKey = true;
    }
    return new WalletManager(privateKey);
  }

  /** Returns the checksummed Ethereum address derived from the private key. */
  public getAddress(): string {
    if (this.address) return this.address;
    const account = privateKeyToAccount(this.privateKey);
    this.address = account.address;
    return this.address;
  }

  /** Signs an EIP-191 personal message and returns the hex signature. */
  public async signMessage(message: string): Promise<Hex> {
    if (message.trim() === '') throw new SigningError('message must not be empty');
    const account = privateKeyToAccount(this.privateKey);
    try {
      return await account.signMessage({ message });
    } catch (e) {
      throw new SigningError('Failed to sign message', { cause: e });
    }
  }

  /** Signs EIP-712 typed data and returns the hex signature. */
  public async signTypedData(
    domain: TypedDataDomain,
    types: TypedDataParameter,
    value: TypedDataParameter,
  ): Promise<Hex> {
    const primaryType = Object.keys(types)[0];
    if (!primaryType) throw new SigningError('types object is empty');
    const account = privateKeyToAccount(this.privateKey);
    try {
      return await account.signTypedData({ domain, types, primaryType, message: value });
    } catch (e) {
      throw new SigningError('Failed to sign typed data', { cause: e });
    }
  }

  /** Signs a serializable transaction and returns the RLP-encoded hex. */
  public async signTransaction(transaction: TransactionSerializable): Promise<Hex> {
    const requiredFields: (keyof TransactionSerializable)[] = ['to', 'chainId', 'gas', 'nonce'];
    for (const field of requiredFields) {
      if (!(field in transaction)) throw new SigningError(`transaction missing field: ${field}`);
    }
    const account = privateKeyToAccount(this.privateKey);
    try {
      return await account.signTransaction(transaction);
    } catch (e) {
      throw new SigningError('Failed to sign transaction', { cause: e });
    }
  }

  /** Decrypts a Web3 Secret Storage keyfile and returns a WalletManager for the recovered key. */
  static async from_keyfile(path: string, password: string): Promise<WalletManager> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (e) {
      throw new KeyfileError(`Failed to read keyfile at "${path}"`, { cause: e });
    }
    let ethersWallet: Awaited<ReturnType<typeof Wallet.fromEncryptedJson>>;
    try {
      ethersWallet = await Wallet.fromEncryptedJson(raw, password);
    } catch (e) {
      // Password and decrypted key must not appear in the error message.
      throw new KeyfileError('Failed to decrypt keyfile: invalid keyfile or wrong password', {
        cause: e,
      });
    }
    return new WalletManager(ethersWallet.privateKey as `0x${string}`); // ethers returns a valid hex key
  }

  /** Encrypts the private key as a Web3 Secret Storage keyfile and writes it to disk. */
  async to_keyfile(path: string, password: string): Promise<void> {
    const ethersWallet = new Wallet(this.privateKey);
    let json: string;
    try {
      json = await ethersWallet.encrypt(password);
    } catch (e) {
      // Password must not appear in the error message.
      throw new KeyfileError('Failed to encrypt keyfile', { cause: e });
    }
    try {
      await writeFile(path, json, 'utf-8');
    } catch (e) {
      throw new KeyfileError(`Failed to write keyfile to "${path}"`, { cause: e });
    }
  }

  /** Returns a safe string representation that exposes address only, never the key. */
  toString(): string {
    return `WalletManager(address=${this.address})`;
  }

  /** Returns a safe JSON representation that exposes address only, never the key. */
  toJSON(): object {
    return { address: this.address };
  }
}
