import { readFile, writeFile } from 'fs/promises';
import type { Hex, TransactionSerializable, TypedDataDomain, TypedDataParameter } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Wallet } from 'ethers';
import { WalletError, SigningError, KeyfileError } from '@/core/core.errors';

export class WalletManager {
  /**
   * Manages wallet operations: key loading, signing, and serialization safety.
   *
   * Keys can be loaded from an environment variable or an encrypted keyfile
   * (Web3 Secret Storage format, compatible with geth/MetaMask).
   *
   * CRITICAL: The private key must never appear in logs, errors, or string representations.
   */
  private privateKey: `0x${string}`;
  private address: string;
  private static shownPrivateKey = false;

  private constructor(privateKey: `0x${string}`) {
    this.privateKey = privateKey;
    this.address = this.getAddress();
  }

  static from_env(env_var: string = 'PRIVATE_KEY'): WalletManager {
    const rawPrivateKey = process.env[env_var];
    if (!rawPrivateKey) {
      throw new WalletError(`${env_var} environment variable not set`);
    }

    if (!rawPrivateKey.startsWith('0x')) {
      throw new WalletError('Invalid private key format');
    }

    return new WalletManager(rawPrivateKey as `0x${string}`);
  }

  static generate(): WalletManager {
    const privateKey = generatePrivateKey();
    if (!WalletManager.shownPrivateKey) {
      console.log('Generated private key:', privateKey);
      WalletManager.shownPrivateKey = true;
    }
    return new WalletManager(privateKey);
  }

  public getAddress(): string {
    if (this.address) {
      return this.address;
    }
    const account = privateKeyToAccount(this.privateKey);
    this.address = account.address;
    return this.address;
  }

  public async signMessage(message: string): Promise<Hex> {
    if (message.trim() === '') {
      throw new SigningError('message must not be empty');
    }

    const account = privateKeyToAccount(this.privateKey);
    try {
      const signature = await account.signMessage({ message });
      return signature;
    } catch (e) {
      throw new SigningError('Failed to sign message', { cause: e });
    }
  }

  public async signTypedData(
    domain: TypedDataDomain,
    types: TypedDataParameter,
    value: TypedDataParameter,
  ): Promise<Hex> {
    const primaryType = Object.keys(types)[0];
    if (!primaryType) {
      throw new Error('types object is empty');
    }

    const account = privateKeyToAccount(this.privateKey);
    try {
      const signature = await account.signTypedData({
        domain,
        types,
        primaryType,
        message: value,
      });
      return signature;
    } catch (e) {
      throw new SigningError('Failed to sign typed data', { cause: e });
    }
  }

  public async signTransaction(transaction: TransactionSerializable): Promise<Hex> {
    const requiredFields: (keyof TransactionSerializable)[] = ['to', 'chainId', 'gas', 'nonce'];
    for (const field of requiredFields) {
      if (!(field in transaction)) {
        throw new Error(`transaction is missing required field: ${field}`);
      }
    }

    const account = privateKeyToAccount(this.privateKey);
    try {
      const signature = await account.signTransaction(transaction);
      return signature;
    } catch (e) {
      throw new SigningError('Failed to sign transaction', { cause: e });
    }
  }

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
      // Do not include password or decrypted content in the message.
      throw new KeyfileError('Failed to decrypt keyfile: invalid keyfile or wrong password', {
        cause: e,
      });
    }

    return new WalletManager(ethersWallet.privateKey as `0x${string}`);
  }

  async to_keyfile(path: string, password: string): Promise<void> {
    const ethersWallet = new Wallet(this.privateKey);
    let json: string;
    try {
      json = await ethersWallet.encrypt(password);
    } catch (e) {
      // Do not include password or key material in the message.
      throw new KeyfileError('Failed to encrypt keyfile', { cause: e });
    }

    try {
      await writeFile(path, json, 'utf-8');
    } catch (e) {
      throw new KeyfileError(`Failed to write keyfile to "${path}"`, { cause: e });
    }
  }

  toString(): string {
    return `WalletManager(address=${this.address})`;
  }

  toJSON(): object {
    return { address: this.address };
  }
}
