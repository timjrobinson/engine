import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import memdown from 'memdown';
import { groth16 } from 'snarkjs';
import { RailgunEngine } from '../railgun-engine';
import { abi as erc20Abi } from '../test/test-erc20-abi.test';
import { config } from '../test/config.test';
import { abi as erc721Abi } from '../test/test-erc721-abi.test';
import { RailgunWallet } from '../wallet/railgun-wallet';
import {
  artifactsGetter,
  awaitScan,
  DECIMALS_18,
  getEthersWallet,
  mockQuickSync,
} from '../test/helper.test';
import { ShieldNoteERC20 } from '../note/erc20/shield-note-erc20';
import { ShieldNoteNFT } from '../note/nft/shield-note-nft';
import { MerkleTree } from '../merkletree/merkletree';
import { ByteLength, formatToByteLength, hexToBigInt, hexToBytes, randomHex } from '../utils/bytes';
import { RailgunSmartWalletContract } from '../contracts/railgun-smart-wallet/railgun-smart-wallet';
import {
  CommitmentType,
  LegacyGeneratedCommitment,
  OutputType,
  TokenType,
} from '../models/formatted-types';
import { Groth16 } from '../prover/prover';
import { ERC20, TestERC721 } from '../typechain-types';
import { promiseTimeout } from '../utils/promises';
import { Chain, ChainType } from '../models/engine-types';
import { TransactNote } from '../note/transact-note';
import { MEMO_SENDER_RANDOM_NULL, TOKEN_SUB_ID_NULL } from '../models/transaction-constants';
import { getTokenDataERC20, getTokenDataHash, getTokenDataNFT } from '../note/note-util';
import { TransactionBatch } from '../transaction/transaction-batch';
import { UnshieldNoteNFT } from '../note/nft/unshield-note-nft';

chai.use(chaiAsPromised);

let provider: ethers.providers.JsonRpcProvider;
let chain: Chain;
let engine: RailgunEngine;
let etherswallet: ethers.Wallet;
let snapshot: number;
let token: ERC20;
let nft: TestERC721;
let wallet: RailgunWallet;
let wallet2: RailgunWallet;
let merkleTree: MerkleTree;
let tokenAddress: string;
let railgunSmartWalletContract: RailgunSmartWalletContract;

const testMnemonic = config.mnemonic;
const testEncryptionKey = config.encryptionKey;

const shieldTestTokens = async (railgunAddress: string, value: bigint) => {
  const mpk = RailgunEngine.decodeAddress(railgunAddress).masterPublicKey;
  const receiverViewingPublicKey = wallet.getViewingKeyPair().pubkey;
  const random = randomHex(16);
  const shield = new ShieldNoteERC20(mpk, random, value, token.address);

  const shieldPrivateKey = hexToBytes(randomHex(32));
  const shieldInput = await shield.serialize(shieldPrivateKey, receiverViewingPublicKey);

  // Create shield
  const shieldTx = await railgunSmartWalletContract.generateShield([shieldInput]);

  // Send shield on chain
  await etherswallet.sendTransaction(shieldTx);
  await expect(awaitScan(wallet, chain)).to.be.fulfilled;
};

const shieldTestNFT = async (railgunAddress: string, tokenID: bigint) => {
  const approval = await nft.approve(railgunSmartWalletContract.address, tokenID);
  await approval.wait();

  const mpk = RailgunEngine.decodeAddress(railgunAddress).masterPublicKey;
  const receiverViewingPublicKey = wallet.getViewingKeyPair().pubkey;
  const random = randomHex(16);
  const shield = new ShieldNoteNFT(mpk, random, nft.address, TokenType.ERC721, tokenID.toString());

  const shieldPrivateKey = hexToBytes(randomHex(32));
  const shieldInput = await shield.serialize(shieldPrivateKey, receiverViewingPublicKey);

  // Create shield
  const shieldTx = await railgunSmartWalletContract.generateShield([shieldInput]);

  // Send shield on chain
  await etherswallet.sendTransaction(shieldTx);
  await expect(awaitScan(wallet, chain)).to.be.fulfilled;
};

describe('RailgunEngine', function test() {
  this.timeout(240000);

  beforeEach(async () => {
    engine = new RailgunEngine('Test Wallet', memdown(), artifactsGetter, mockQuickSync);
    engine.prover.setSnarkJSGroth16(groth16 as Groth16);

    if (!process.env.RUN_HARDHAT_TESTS) {
      return;
    }

    // EngineDebug.init(console); // uncomment for logs
    provider = new ethers.providers.JsonRpcProvider(config.rpc);
    chain = {
      type: ChainType.EVM,
      id: (await provider.getNetwork()).chainId,
    };

    etherswallet = getEthersWallet(config.mnemonic, provider);

    snapshot = (await provider.send('evm_snapshot', [])) as number;
    token = new ethers.Contract(config.contracts.rail, erc20Abi, etherswallet) as ERC20;
    tokenAddress = formatToByteLength(token.address, 32, false);

    nft = new ethers.Contract(config.contracts.nft, erc721Abi, etherswallet) as TestERC721;

    const balance = await token.balanceOf(etherswallet.address);
    await token.approve(config.contracts.proxy, balance);

    wallet = await engine.createWalletFromMnemonic(testEncryptionKey, testMnemonic);
    wallet2 = await engine.createWalletFromMnemonic(testEncryptionKey, testMnemonic, 1);
    await engine.loadNetwork(
      chain,
      config.contracts.proxy,
      config.contracts.relayAdapt,
      provider,
      24,
    );
    await engine.scanHistory(chain);
    merkleTree = engine.merkletrees[chain.type][chain.id];
    railgunSmartWalletContract = engine.railgunSmartWalletContracts[chain.type][chain.id];
  });

  it('[HH] Should load existing wallets', async function run() {
    if (!process.env.RUN_HARDHAT_TESTS) {
      this.skip();
      return;
    }

    engine.unloadWallet(wallet.id);
    await engine.loadExistingWallet(testEncryptionKey, wallet.id);
    expect(engine.wallets[wallet.id].id).to.equal(wallet.id);
  });

  it('[HH] Should show balance after shield and rescan', async function run() {
    if (!process.env.RUN_HARDHAT_TESTS) {
      this.skip();
      return;
    }

    const commitment: LegacyGeneratedCommitment = {
      commitmentType: CommitmentType.LegacyGeneratedCommitment,
      hash: '14308448bcb19ecff96805fe3d00afecf82b18fa6f8297b42cf2aadc23f412e6',
      txid: '0x0543be0699a7eac2b75f23b33d435aacaeb0061f63e336230bcc7559a1852f33',
      preImage: {
        npk: '0xc24ea33942c0fb9acce5dbada73137ad3257a6f2e1be8f309c1fe9afc5410a',
        token: {
          tokenType: TokenType.ERC20,
          tokenAddress: `0x${tokenAddress}`,
          tokenSubID: TOKEN_SUB_ID_NULL,
        },
        value: '9138822709a9fc231cba6',
      },
      encryptedRandom: [
        '0xb47a353e294711ff73cf086f97ee1ed29b853b67c353bc2371b87fe72c716cc6',
        '0x3d321af08b8fa7a8f70379407706b752',
      ],
      blockNumber: 0,
    };
    // Override root validator
    merkleTree.rootValidator = () => Promise.resolve(true);
    await merkleTree.queueLeaves(0, 0, [commitment]);
    await merkleTree.updateTrees();

    await wallet.scanBalances(chain, undefined);
    const balance = await wallet.getBalance(chain, tokenAddress);
    const value = hexToBigInt(commitment.preImage.value);
    expect(balance).to.equal(value);

    await wallet.fullRescanBalances(chain, undefined);
    const balanceRescan = await wallet.getBalance(chain, tokenAddress);
    expect(balanceRescan).to.equal(value);

    await wallet.clearScannedBalances(chain);
    const balanceClear = await wallet.getBalance(chain, tokenAddress);
    expect(balanceClear).to.equal(undefined);
  });

  it('[HH] With a creation block number provided, should show balance after shield and rescan', async function run() {
    if (!process.env.RUN_HARDHAT_TESTS) {
      this.skip();
      return;
    }

    // { [chain.type]: { [chain.id]: 0 } }
    const creationBlockNumbers: number[][] = [];
    creationBlockNumbers[chain.type] = [];
    creationBlockNumbers[chain.type][chain.id] = 0;
    wallet.setCreationBlockNumbers(creationBlockNumbers);

    const commitment: LegacyGeneratedCommitment = {
      commitmentType: CommitmentType.LegacyGeneratedCommitment,
      hash: '14308448bcb19ecff96805fe3d00afecf82b18fa6f8297b42cf2aadc23f412e6',
      txid: '0x0543be0699a7eac2b75f23b33d435aacaeb0061f63e336230bcc7559a1852f33',
      preImage: {
        npk: '0xc24ea33942c0fb9acce5dbada73137ad3257a6f2e1be8f309c1fe9afc5410a',
        token: {
          tokenType: TokenType.ERC20,
          tokenAddress: `0x${tokenAddress}`,
          tokenSubID: TOKEN_SUB_ID_NULL,
        },
        value: '9138822709a9fc231cba6',
      },
      encryptedRandom: [
        '0xb47a353e294711ff73cf086f97ee1ed29b853b67c353bc2371b87fe72c716cc6',
        '0x3d321af08b8fa7a8f70379407706b752',
      ],
      blockNumber: 0,
    };
    // Override root validator
    merkleTree.rootValidator = () => Promise.resolve(true);
    await merkleTree.queueLeaves(0, 0, [commitment]);
    await merkleTree.updateTrees();

    await wallet.scanBalances(chain, undefined);
    const balance = await wallet.getBalance(chain, tokenAddress);
    const value = hexToBigInt(commitment.preImage.value);
    expect(balance).to.equal(value);

    const walletDetails = await wallet.getWalletDetails(chain);
    expect(walletDetails.creationTree).to.equal(0);
    expect(walletDetails.creationTreeHeight).to.equal(0);

    await wallet.fullRescanBalances(chain, undefined);
    const balanceRescan = await wallet.getBalance(chain, tokenAddress);
    expect(balanceRescan).to.equal(value);

    await wallet.clearScannedBalances(chain);
    const balanceCleared = await wallet.getBalance(chain, tokenAddress);
    expect(balanceCleared).to.equal(undefined);

    const walletDetailsCleared = await wallet.getWalletDetails(chain);
    expect(walletDetailsCleared.creationTree).to.equal(0); // creationTree should not get reset on clear
    expect(walletDetailsCleared.creationTreeHeight).to.equal(0); // creationTreeHeight should not get reset on clear
    expect(walletDetailsCleared.treeScannedHeights.length).to.equal(0);
  });

  it('[HH] Should shield, unshield and update balance, and pull formatted spend/receive transaction history', async function run() {
    if (!process.env.RUN_HARDHAT_TESTS) {
      this.skip();
      return;
    }

    const initialBalance = await wallet.getBalance(chain, tokenAddress);
    expect(initialBalance).to.equal(undefined);

    const address = wallet.getAddress(chain);
    await shieldTestTokens(address, BigInt(110000) * DECIMALS_18);

    const balance = await wallet.getBalance(chain, tokenAddress);
    expect(balance).to.equal(BigInt('109725000000000000000000'));

    const tokenData = getTokenDataERC20(tokenAddress);
    const tokenHash = getTokenDataHash(tokenData);

    // Create transaction
    const transactionBatch = new TransactionBatch(chain);
    transactionBatch.addUnshieldData({
      toAddress: etherswallet.address,
      value: BigInt(300) * DECIMALS_18,
      tokenHash,
      tokenData,
    });

    // Add output for mock Relayer (artifacts require 2+ outputs, including unshield)
    transactionBatch.addOutput(
      TransactNote.createTransfer(
        wallet2.addressKeys,
        wallet.addressKeys,
        randomHex(16),
        1n,
        tokenHash,
        wallet.getViewingKeyPair(),
        false, // showSenderAddressToRecipient
        OutputType.RelayerFee,
        undefined, // memoText
      ),
    );

    const transactions = await transactionBatch.generateTransactions(
      engine.prover,
      wallet,
      testEncryptionKey,
      () => {},
    );
    const transact = await railgunSmartWalletContract.transact(transactions);

    const transactTx = await etherswallet.sendTransaction(transact);
    await transactTx.wait();
    await Promise.all([
      promiseTimeout(awaitScan(wallet, chain), 15000, 'Timed out wallet1 scan'),
      promiseTimeout(awaitScan(wallet2, chain), 15000, 'Timed out wallet2 scan'),
    ]);

    // BALANCE = shielded amount - 300(decimals) - 1
    const newBalance = await wallet.getBalance(chain, tokenAddress);
    expect(newBalance).to.equal(109424999999999999999999n, 'Failed to receive expected balance');

    const newBalance2 = await wallet2.getBalance(chain, tokenAddress);
    expect(newBalance2).to.equal(BigInt(1));

    // check the transactions log
    const history = await wallet.getTransactionHistory(chain);
    expect(history.length).to.equal(2);

    const tokenFormatted = formatToByteLength(tokenAddress, 32, false);

    // Check first output: Shield (receive only).
    expect(history[0].receiveTokenAmounts).deep.eq([
      {
        token: tokenFormatted,
        amount: BigInt('109725000000000000000000'),
        memoText: undefined,
        senderAddress: undefined,
      },
    ]);
    expect(history[0].transferTokenAmounts).deep.eq([]);
    expect(history[0].relayerFeeTokenAmount).eq(undefined);
    expect(history[0].changeTokenAmounts).deep.eq([]);
    expect(history[0].unshieldTokenAmounts).deep.eq([]);

    // Check second output: Unshield (relayer fee + change).
    // NOTE: No receive token amounts should be logged by history.
    expect(history[1].receiveTokenAmounts).deep.eq(
      [],
      "Receive amount should be filtered out - it's the same as change output.",
    );
    expect(history[1].transferTokenAmounts).deep.eq([]);
    expect(history[1].relayerFeeTokenAmount).deep.eq({
      token: tokenFormatted,
      amount: BigInt(1),
      noteAnnotationData: {
        outputType: OutputType.RelayerFee,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        senderRandom: history[1].relayerFeeTokenAmount!.noteAnnotationData!.senderRandom,
        walletSource: 'test wallet',
      },
      memoText: undefined,
    });
    expect(history[1].changeTokenAmounts).deep.eq([
      {
        token: tokenFormatted,
        amount: BigInt('109424999999999999999999'),
        noteAnnotationData: {
          outputType: OutputType.Change,
          senderRandom: MEMO_SENDER_RANDOM_NULL,
          walletSource: 'test wallet',
        },
        memoText: undefined,
      },
    ]);
    expect(history[1].unshieldTokenAmounts).deep.eq([
      {
        token: tokenFormatted,
        amount: BigInt('299250000000000000000'), // 300 minus fee
        recipientAddress: etherswallet.address,
        memoText: undefined,
        senderAddress: undefined,
      },
    ]);
  }).timeout(90000);

  it('[HH] Should shield, transfer and update balance, and pull formatted spend/receive transaction history', async function run() {
    if (!process.env.RUN_HARDHAT_TESTS) {
      this.skip();
      return;
    }

    const initialBalance = await wallet.getBalance(chain, tokenAddress);
    expect(initialBalance).to.equal(undefined);

    const address = wallet.getAddress(chain);
    await shieldTestTokens(address, BigInt(110000) * DECIMALS_18);

    const balance = await wallet.getBalance(chain, tokenAddress);
    expect(balance).to.equal(BigInt('109725000000000000000000'));

    // Create transaction
    const transactionBatch = new TransactionBatch(chain);

    const memoText =
      'A really long memo with emojis 😐 👩🏾‍🔧 and other text, in order to test a major memo for a real live production use case.';

    const tokenData = getTokenDataERC20(tokenAddress);
    const tokenHash = getTokenDataHash(tokenData);

    // Add output for Transfer
    transactionBatch.addOutput(
      TransactNote.createTransfer(
        wallet2.addressKeys,
        wallet.addressKeys,
        randomHex(16),
        10n,
        tokenHash,
        wallet.getViewingKeyPair(),
        true, // showSenderAddressToRecipient
        OutputType.Transfer,
        memoText,
      ),
    );

    const relayerMemoText = 'A short memo with only 32 chars.';

    // Add output for mock Relayer (artifacts require 2+ outputs, including unshield)
    transactionBatch.addOutput(
      TransactNote.createTransfer(
        wallet2.addressKeys,
        wallet.addressKeys,
        randomHex(16),
        1n,
        tokenHash,
        wallet.getViewingKeyPair(),
        false, // showSenderAddressToRecipient
        OutputType.RelayerFee,
        relayerMemoText, // memoText
      ),
    );

    const transactions = await transactionBatch.generateTransactions(
      engine.prover,
      wallet,
      testEncryptionKey,
      () => {},
    );
    const transact = await railgunSmartWalletContract.transact(transactions);

    const transactTx = await etherswallet.sendTransaction(transact);
    await transactTx.wait();
    await Promise.all([
      promiseTimeout(awaitScan(wallet, chain), 15000, 'Timed out wallet1 scan'),
      promiseTimeout(awaitScan(wallet2, chain), 15000, 'Timed out wallet2 scan'),
    ]);

    // BALANCE = shielded amount - 300(decimals) - 1
    const newBalance = await wallet.getBalance(chain, tokenAddress);
    expect(newBalance).to.equal(109724999999999999999989n, 'Failed to receive expected balance');

    const newBalance2 = await wallet2.getBalance(chain, tokenAddress);
    expect(newBalance2).to.equal(BigInt(11));

    // check the transactions log
    const history = await wallet.getTransactionHistory(chain);
    expect(history.length).to.equal(2);

    const tokenFormatted = formatToByteLength(tokenAddress, ByteLength.UINT_256, false);

    // Check first output: Shield (receive only).
    expect(history[0].receiveTokenAmounts).deep.eq([
      {
        token: tokenFormatted,
        amount: BigInt('109725000000000000000000'),
        memoText: undefined,
        senderAddress: undefined,
      },
    ]);
    expect(history[0].transferTokenAmounts).deep.eq([]);
    expect(history[0].relayerFeeTokenAmount).eq(undefined);
    expect(history[0].changeTokenAmounts).deep.eq([]);
    expect(history[0].unshieldTokenAmounts).deep.eq([]);

    // Check second output: Unshield (relayer fee + change).
    // NOTE: No receive token amounts should be logged by history.
    expect(history[1].receiveTokenAmounts).deep.eq(
      [],
      "Receive amount should be filtered out - it's the same as change output.",
    );
    expect(history[1].transferTokenAmounts).deep.eq([
      {
        token: tokenFormatted,
        amount: BigInt(10),
        noteAnnotationData: {
          outputType: OutputType.Transfer,
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          senderRandom: history[1].transferTokenAmounts[0].noteAnnotationData!.senderRandom,
          walletSource: 'test wallet',
        },
        recipientAddress: wallet2.getAddress(),
        memoText,
      },
    ]);
    expect(history[1].relayerFeeTokenAmount).deep.eq({
      token: tokenFormatted,
      amount: BigInt(1),
      noteAnnotationData: {
        outputType: OutputType.RelayerFee,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        senderRandom: history[1].relayerFeeTokenAmount!.noteAnnotationData!.senderRandom,
        walletSource: 'test wallet',
      },
      memoText: relayerMemoText,
    });
    expect(history[1].changeTokenAmounts).deep.eq([
      {
        token: tokenFormatted,
        amount: BigInt('109724999999999999999989'),
        noteAnnotationData: {
          outputType: OutputType.Change,
          senderRandom: MEMO_SENDER_RANDOM_NULL,
          walletSource: 'test wallet',
        },
        memoText: undefined,
      },
    ]);
    expect(history[1].unshieldTokenAmounts).deep.eq([]);

    const history2 = await wallet2.getTransactionHistory(chain);
    expect(history2.length).to.equal(1);
    expect(history2[0].receiveTokenAmounts).deep.eq([
      {
        token: tokenFormatted,
        amount: BigInt(10),
        memoText,
        senderAddress: wallet.getAddress(),
      },
      {
        token: tokenFormatted,
        amount: BigInt(1),
        memoText: relayerMemoText,
        senderAddress: undefined,
      },
    ]);
    expect(history2[0].transferTokenAmounts).deep.eq([]);
    expect(history2[0].relayerFeeTokenAmount).eq(undefined);
    expect(history2[0].changeTokenAmounts).deep.eq([]);
    expect(history2[0].unshieldTokenAmounts).deep.eq([]);
  }).timeout(90000);

  it('[HH] Should shield NFTs, transfer & unshield NFTs, and pull formatted spend/receive NFT history', async function run() {
    if (!process.env.RUN_HARDHAT_TESTS) {
      this.skip();
      return;
    }

    // Mint NFTs with tokenIDs 0 and 1 into public balance.
    const nftBalanceBeforeMint = await nft.balanceOf(etherswallet.address);
    expect(nftBalanceBeforeMint.toHexString()).to.equal('0x00');
    const mintTx0 = await nft.mint(etherswallet.address, 0);
    await mintTx0.wait();
    const mintTx1 = await nft.mint(etherswallet.address, 1);
    await mintTx1.wait();
    const nftBalanceAfterMint = await nft.balanceOf(etherswallet.address);
    expect(nftBalanceAfterMint.toHexString()).to.equal('0x02');
    const tokenOwner = await nft.ownerOf(1);
    expect(tokenOwner).to.equal(etherswallet.address);
    const tokenURI = await nft.tokenURI(1);
    expect(tokenURI).to.equal('');

    await shieldTestNFT(wallet.getAddress(), BigInt(1));

    const history = await wallet.getTransactionHistory(chain);
    expect(history.length).to.equal(1);

    const tokenDataNFT0 = getTokenDataNFT(nft.address, TokenType.ERC721, BigInt(0).toString());
    const tokenHashNFT0 = getTokenDataHash(tokenDataNFT0);

    const tokenDataNFT1 = getTokenDataNFT(nft.address, TokenType.ERC721, BigInt(1).toString());
    const tokenHashNFT1 = getTokenDataHash(tokenDataNFT1);

    // Check first output: Shield (receive only).
    expect(history[0].receiveTokenAmounts).deep.eq([
      {
        token: tokenHashNFT1,
        amount: BigInt(1),
        memoText: undefined,
        senderAddress: undefined,
      },
    ]);
    expect(history[0].transferTokenAmounts).deep.eq([]);
    expect(history[0].relayerFeeTokenAmount).eq(undefined);
    expect(history[0].changeTokenAmounts).deep.eq([]);
    expect(history[0].unshieldTokenAmounts).deep.eq([]);

    // Shield another NFT.
    await shieldTestNFT(wallet.getAddress(), BigInt(0));

    // Shield tokens for Relayer Fee.
    await shieldTestTokens(wallet.getAddress(), BigInt(110000) * DECIMALS_18);

    // Transfer NFT to another wallet.

    // Create transaction
    const transactionBatch = new TransactionBatch(chain);

    const memoText =
      'A really long memo with emojis 😐 👩🏾‍🔧 and other text, in order to test a major memo for a real live production use case.';

    // Add output for Transfer
    transactionBatch.addOutput(
      TransactNote.createNFTTransfer(
        wallet2.addressKeys,
        wallet.addressKeys,
        randomHex(16),
        tokenDataNFT1,
        wallet.getViewingKeyPair(),
        true, // showSenderAddressToRecipient
        memoText,
      ),
    );

    // Add output for NFT Unshield
    const unshieldNote = new UnshieldNoteNFT(
      etherswallet.address,
      nft.address,
      TokenType.ERC721,
      BigInt(0).toString(),
    );
    transactionBatch.addUnshieldData(unshieldNote.unshieldData);

    const relayerMemoText = 'A short memo with only 32 chars.';

    const tokenDataRelayerFee = getTokenDataERC20(token.address);
    const tokenHashRelayerFee = getTokenDataHash(tokenDataRelayerFee);

    // Add output for mock Relayer (artifacts require 2+ outputs, including unshield)
    transactionBatch.addOutput(
      TransactNote.createTransfer(
        wallet2.addressKeys,
        wallet.addressKeys,
        randomHex(16),
        20n,
        tokenHashRelayerFee,
        wallet.getViewingKeyPair(),
        false, // showSenderAddressToRecipient
        OutputType.RelayerFee,
        relayerMemoText, // memoText
      ),
    );

    const transactions = await transactionBatch.generateTransactions(
      engine.prover,
      wallet,
      testEncryptionKey,
      () => {},
    );
    const transact = await railgunSmartWalletContract.transact(transactions);

    const transactTx = await etherswallet.sendTransaction(transact);
    await transactTx.wait();
    await Promise.all([
      promiseTimeout(awaitScan(wallet, chain), 15000, 'Timed out wallet1 scan'),
      promiseTimeout(awaitScan(wallet2, chain), 15000, 'Timed out wallet2 scan'),
    ]);

    const historyAfterTransfer = await wallet.getTransactionHistory(chain);
    expect(historyAfterTransfer.length).to.equal(4);

    const relayerFeeTokenFormatted = formatToByteLength(tokenAddress, 32, false);

    // Check first output: Shield (receive only).
    expect(historyAfterTransfer[3].receiveTokenAmounts).deep.eq([]);
    expect(historyAfterTransfer[3].transferTokenAmounts).deep.eq([
      {
        token: tokenHashNFT1,
        amount: BigInt(1),
        noteAnnotationData: {
          outputType: OutputType.Transfer,
          senderRandom:
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            historyAfterTransfer[3].transferTokenAmounts[0].noteAnnotationData!.senderRandom,
          walletSource: 'test wallet',
        },
        recipientAddress: wallet2.getAddress(),
        memoText,
      },
    ]);
    expect(historyAfterTransfer[3].relayerFeeTokenAmount).deep.eq({
      token: relayerFeeTokenFormatted,
      amount: BigInt(20),
      noteAnnotationData: {
        outputType: OutputType.RelayerFee,
        senderRandom:
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          historyAfterTransfer[3].relayerFeeTokenAmount!.noteAnnotationData!.senderRandom,
        walletSource: 'test wallet',
      },
      memoText: relayerMemoText,
    });
    expect(historyAfterTransfer[3].changeTokenAmounts).deep.eq([
      {
        token: relayerFeeTokenFormatted,
        amount: BigInt('109724999999999999999980'),
        noteAnnotationData: {
          outputType: OutputType.Change,
          senderRandom: MEMO_SENDER_RANDOM_NULL,
          walletSource: 'test wallet',
        },
        memoText: undefined,
      },
    ]);
    expect(historyAfterTransfer[3].unshieldTokenAmounts).deep.eq([
      {
        token: tokenHashNFT0,
        amount: BigInt(1),
        recipientAddress: etherswallet.address,
        memoText: undefined,
        senderAddress: undefined,
      },
    ]);
  }).timeout(90000);

  it('Should set/get last synced block', async () => {
    const chainForSyncedBlock = {
      type: ChainType.EVM,
      id: 10010,
    };
    let lastSyncedBlock = await engine.getLastSyncedBlock(chainForSyncedBlock);
    expect(lastSyncedBlock).to.equal(undefined);
    await engine.setLastSyncedBlock(100, chainForSyncedBlock);
    lastSyncedBlock = await engine.getLastSyncedBlock(chainForSyncedBlock);
    expect(lastSyncedBlock).to.equal(100);
    await engine.setLastSyncedBlock(100000, chainForSyncedBlock);
    lastSyncedBlock = await engine.getLastSyncedBlock(chainForSyncedBlock);
    expect(lastSyncedBlock).to.equal(100000);
  });

  afterEach(async () => {
    if (!process.env.RUN_HARDHAT_TESTS) {
      return;
    }
    engine.unload();
    await provider.send('evm_revert', [snapshot]);
  });
});
