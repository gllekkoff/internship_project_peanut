export interface CallFrame {
  type: string;
  from: string;
  to?: string;
  value?: string;
  gas: string;
  gasUsed: string;
  input: string;
  output?: string;
  error?: string;
  calls?: CallFrame[];
}

export interface TransferInfo {
  token: string;
  symbol: string;
  from: string;
  to: string;
  amount: string;
  rawValue: bigint;
  decimals: number;
}
