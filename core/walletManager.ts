import { readFile, writeFile } from 'fs/promises';
import type { Hex, TransactionSerializable, TypedDataDomain, TypedDataParameter } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Wallet } from 'ethers';

export class WalletManager {
  /**
   * Manages wallet operations: key loading, signing, verification.
   *
   * Keys can be loaded from:
   * - Environment variable
   * - Encrypted keyfile (optional stretch goal)
   *
   * CRITICAL: Private key must never appear in logs, errors, or string representations.
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
      throw new Error(`${env_var} environment variable not set`);
    }

    if (!rawPrivateKey.startsWith('0x')) {
      throw new Error('Invalid private key format');
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
    /*
    Returns checksummed address.
    */
    if (this.address) {
      return this.address;
    }
    const account = privateKeyToAccount(this.privateKey);
    this.address = account.address;
    return this.address;
  }

  public async signMessage(message: string): Promise<Hex> {
    /*
    Sign an arbitrary message (with EIP-191 prefix).
    */
    if (message.trim() === '') {
      throw new Error('message must not be empty');
    }

    const account = privateKeyToAccount(this.privateKey);
    try {
      const signature = await account.signMessage({ message });
      return signature;
    } catch (e) {
      throw new Error(
        `Failed to sign message: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
  }

  public async signTypedData(
    domain: TypedDataDomain,
    types: TypedDataParameter,
    value: TypedDataParameter,
  ): Promise<Hex> {
    /*
    Sign EIP-712 typed data (used by many DeFi protocols).
    */
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
      throw new Error(
        `Failed to sign typed data: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
  }

  public async signTransaction(transaction: TransactionSerializable): Promise<Hex> {
    /*
    Sign a serializable transaction (EIP-1559, legacy, etc.).
    */
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
      throw new Error(
        `Failed to sign transaction: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
  }

  static async from_keyfile(path: string, password: string): Promise<WalletManager> {
    /*
    Load wallet from an encrypted JSON keyfile (geth/clef Web3 Secret Storage format).
    */
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (e) {
      throw new Error(
        `Failed to read keyfile at "${path}": ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }

    let ethersWallet: Awaited<ReturnType<typeof Wallet.fromEncryptedJson>>;
    try {
      ethersWallet = await Wallet.fromEncryptedJson(raw, password);
    } catch {
      // Deliberately omit the ethers error — it may echo the password on bad input
      throw new Error('Failed to decrypt keyfile: invalid keyfile or wrong password');
    }

    return new WalletManager(ethersWallet.privateKey as `0x${string}`);
  }

  async to_keyfile(path: string, password: string): Promise<void> {
    /*
    Export wallet to an encrypted JSON keyfile (geth/clef Web3 Secret Storage format).
    */
    const ethersWallet = new Wallet(this.privateKey);
    let json: string;
    try {
      json = await ethersWallet.encrypt(password);
    } catch (e) {
      throw new Error(
        `Failed to encrypt keyfile: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }

    try {
      await writeFile(path, json, 'utf-8');
    } catch (e) {
      throw new Error(
        `Failed to write keyfile to "${path}": ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
  }

  toString(): string {
    return `WalletManager(address=${this.address})`;
  }

  toJSON(): object {
    return { address: this.address };
  }
}
