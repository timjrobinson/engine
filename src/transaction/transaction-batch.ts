import { Note } from '../note';
import { bytes } from '../utils';
import { Wallet, TXO, TreeBalance } from '../wallet';
import { Prover } from '../prover';
import { ByteLength, formatToByteLength } from '../utils/bytes';
import { calculateTotalSpend, findSolutions } from './solutions';
import { Transaction } from './transaction';
import { SpendingSolutionGroup } from '../models/txo-types';
import { TokenType, BigIntish, SerializedTransaction } from '../models/formatted-types';

class TransactionBatch {
  private chainID: number;

  private tokenAddress: string;

  private outputs: Note[] = [];

  private tokenType: TokenType;

  private withdrawAddress: string | undefined;

  private withdrawTotal: bigint = BigInt(0);

  private overrideWithdrawAddress: string | undefined;

  /**
   * Create ERC20Transaction Object
   * @param tokenAddress - token address, unformatted
   * @param tokenType - enum of token type
   * @param chainID - chainID of network transaction will be built for
   */
  constructor(tokenAddress: string, tokenType: TokenType, chainID: number) {
    this.tokenAddress = formatToByteLength(tokenAddress, ByteLength.UINT_256);
    this.tokenType = tokenType;
    this.chainID = chainID;
  }

  addOutput(output: Note) {
    this.outputs.push(output);
  }

  resetOutputs() {
    this.outputs = [];
  }

  setWithdraw(withdrawAddress: string, value: BigIntish, overrideWithdrawAddress?: string) {
    if (this.withdrawAddress != null) {
      throw new Error('You may only call .withdraw once for a given transaction batch.');
    }

    this.withdrawAddress = withdrawAddress;
    this.withdrawTotal = BigInt(value);
    this.overrideWithdrawAddress = overrideWithdrawAddress;
  }

  /**
   * Generates spending solution groups for outputs
   * @param wallet - wallet to spend from
   */
  async generateValidSpendingSolutionGroups(wallet: Wallet): Promise<SpendingSolutionGroup[]> {
    const outputTotal = this.outputs.reduce((left, right) => left + right.value, BigInt(0));

    // Calculate total required to be supplied by UTXOs
    const totalRequired = outputTotal + this.withdrawTotal;

    // Check if output token fields match tokenID for this transaction
    this.outputs.forEach((output, index) => {
      if (output.token !== this.tokenAddress)
        throw new Error(`Token address mismatch on output ${index}`);
    });

    // Get UTXOs sorted by tree
    const treeSortedBalances = (await wallet.balancesByTree(this.chainID))[
      formatToByteLength(this.tokenAddress, 32, false)
    ];

    if (treeSortedBalances === undefined) {
      const formattedTokenAddress = `0x${bytes.trim(this.tokenAddress, ByteLength.Address)}`;
      throw new Error(`No wallet balance for token: ${formattedTokenAddress}`);
    }

    // Sum balances
    const balance: bigint = treeSortedBalances.reduce(
      (left, right) => left + right.balance,
      BigInt(0),
    );

    // Check if wallet balance is enough to cover this transaction
    if (totalRequired > balance) throw new Error('Wallet balance too low');

    // If single group possible, return it.
    const singleSpendingSolutionGroup = this.createSingleSpendingSolutionGroupIfPossible(
      treeSortedBalances,
      totalRequired,
    );
    if (singleSpendingSolutionGroup) {
      return [singleSpendingSolutionGroup];
    }

    // Single group not possible - need a more complex model.
    throw new Error(
      'Complex TXO spending group required. Please consolidate balances or send in increments.',
    );
  }

  private createSingleSpendingSolutionGroupIfPossible(
    treeSortedBalances: TreeBalance[],
    totalRequired: bigint,
  ): SpendingSolutionGroup | undefined {
    try {
      const excludedUTXOIDs: string[] = [];
      const { utxos, spendingTree, amount } = TransactionBatch.createSatisfyingUTXOGroup(
        treeSortedBalances,
        totalRequired,
        excludedUTXOIDs,
      );
      if (amount < totalRequired) {
        throw new Error('Could not find UTXOs to satisfy required amount.');
      }

      const spendingSolutionGroup: SpendingSolutionGroup = {
        utxos,
        spendingTree,
        withdrawValue: this.withdrawTotal,
        outputs: this.outputs,
      };

      return spendingSolutionGroup;
    } catch (err) {
      return undefined;
    }
  }

  /**
   * Finds group of UTXOs above required amount, excluding an already-used array of UTXO IDs.
   */
  private static createSatisfyingUTXOGroup(
    treeSortedBalances: TreeBalance[],
    amountRequired: bigint,
    excludedUTXOIDs: string[],
  ): { utxos: TXO[]; spendingTree: number; amount: bigint } {
    let spendingTree: number | undefined;
    let utxos: TXO[] | undefined;

    // Find first tree with spending solutions.
    treeSortedBalances.forEach((treeBalance, tree) => {
      const solutions = findSolutions(treeBalance, amountRequired, excludedUTXOIDs);
      if (!solutions) {
        return;
      }
      spendingTree = tree;
      utxos = solutions;
    });

    if (utxos == null || spendingTree == null) {
      // Wallet has appropriate balance in aggregate, but no solutions remain.
      // This means these UTXOs were already excluded, which can only occur in multi-send situations with multiple destination addresses.
      throw new Error(
        'You must consolidate balances before multi-sending. Send tokens to one destination address at a time to resolve.',
      );
    }

    return {
      utxos,
      spendingTree,
      amount: calculateTotalSpend(utxos),
    };
  }

  /**
   * Generate proofs and return serialized transactions
   * @param prover - prover to use
   * @param wallet - wallet to spend from
   * @param encryptionKey - encryption key for wallet
   * @returns serialized transaction
   */
  async generateSerializedTransactions(
    prover: Prover,
    wallet: Wallet,
    encryptionKey: string,
  ): Promise<SerializedTransaction[]> {
    const proofPromises: Promise<SerializedTransaction>[] = [];

    const spendingSolutionGroups = await this.generateValidSpendingSolutionGroups(wallet);
    spendingSolutionGroups.forEach((spendingSolutionGroup) => {
      const transaction = this.generateTransactionForSpendingSolutionGroup(spendingSolutionGroup);
      proofPromises.push(transaction.prove(prover, wallet, encryptionKey));
    });

    return Promise.all(proofPromises);
  }

  /**
   * Generate dummy proofs and return serialized transactions
   * @param wallet - wallet to spend from
   * @param encryptionKey - encryption key for wallet
   * @returns serialized transaction
   */
  async generateDummySerializedTransactions(
    wallet: Wallet,
    encryptionKey: string,
  ): Promise<SerializedTransaction[]> {
    const proofPromises: Promise<SerializedTransaction>[] = [];

    const spendingSolutionGroups = await this.generateValidSpendingSolutionGroups(wallet);
    spendingSolutionGroups.forEach((spendingSolutionGroup) => {
      const transaction = this.generateTransactionForSpendingSolutionGroup(spendingSolutionGroup);
      proofPromises.push(transaction.dummyProve(wallet, encryptionKey));
    });

    return Promise.all(proofPromises);
  }

  generateTransactionForSpendingSolutionGroup(
    spendingSolutionGroup: SpendingSolutionGroup,
  ): Transaction {
    const { spendingTree, utxos, outputs, withdrawValue } = spendingSolutionGroup;
    const transaction = new Transaction(
      this.tokenAddress,
      this.tokenType,
      this.chainID,
      spendingTree,
      utxos,
    );
    transaction.setOutputs(outputs);
    if (withdrawValue > 0) {
      transaction.withdraw(this.withdrawAddress, withdrawValue, this.overrideWithdrawAddress);
    }
    return transaction;
  }
}

export { TransactionBatch };
