/* globals describe it beforeEach, afterEach */
import chai, { assert, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { ethers } from 'ethers';
import memdown from 'memdown';

import { Lepton, Transaction } from '../src';

import { abi as erc20abi } from './erc20abi.test';
import { config } from './config.test';
import { Wallet } from '../src/wallet';
import { artifactsGetter, awaitScan, getEthersWallet, mockQuickSync } from './helper';
import { Deposit } from '../src/note/deposit';
import { GeneratedCommitment, MerkleTree } from '../src/merkletree';
import { formatToByteLength, hexToBigInt } from '../src/utils/bytes';
import { ERC20RailgunContract } from '../src/contract';
import { ZERO_ADDRESS } from '../src/utils/constants';

chai.use(chaiAsPromised);

let provider: ethers.providers.JsonRpcProvider;
let chainID: number;
let lepton: Lepton;
let etherswallet: ethers.Wallet;
let snapshot: number;
let token: ethers.Contract;
let walletID: string;
let wallet: Wallet;
let merkleTree: MerkleTree;
let tokenAddress: string;
let contract: ERC20RailgunContract;

const testMnemonic = config.mnemonic;
const testEncryptionKey = config.encryptionKey;
// const { log } = console;

// eslint-disable-next-line func-names
describe('Lepton', function () {
  this.timeout(240000);

  beforeEach(async () => {
    lepton = new Lepton(memdown(), artifactsGetter, mockQuickSync);
    if (!process.env.RUN_HARDHAT_TESTS) {
      return;
    }

    provider = new ethers.providers.JsonRpcProvider(config.rpc);
    chainID = (await provider.getNetwork()).chainId;

    etherswallet = getEthersWallet(config.mnemonic, provider);

    snapshot = await provider.send('evm_snapshot', []);
    token = new ethers.Contract(config.contracts.rail, erc20abi, etherswallet);
    tokenAddress = formatToByteLength(token.address, 32, false);

    const balance = await token.balanceOf(etherswallet.address);
    await token.approve(config.contracts.proxy, balance);

    walletID = await lepton.createWalletFromMnemonic(testEncryptionKey, testMnemonic);
    wallet = lepton.wallets[walletID];
    await lepton.loadNetwork(chainID, config.contracts.proxy, provider, 24);
    merkleTree = lepton.merkletree[chainID].erc20;
    contract = lepton.contracts[chainID];
  });

  it('[HH] Should load existing wallets', async function run() {
    if (!process.env.RUN_HARDHAT_TESTS) {
      this.skip();
      return;
    }

    lepton.unloadWallet(walletID);
    await lepton.loadExistingWallet(testEncryptionKey, walletID);
    expect(lepton.wallets[walletID].id).to.equal(walletID);
  });

  it('[HH] Should show balance after deposit', async function run() {
    if (!process.env.RUN_HARDHAT_TESTS) {
      this.skip();
      return;
    }

    // TODO-balances - needs updated vector.

    const commitment: GeneratedCommitment = {
      hash: '14308448bcb19ecff96805fe3d00afecf82b18fa6f8297b42cf2aadc23f412e6',
      txid: '0x0543be0699a7eac2b75f23b33d435aacaeb0061f63e336230bcc7559a1852f33',
      preimage: {
        npk: '0xc24ea33942c0fb9acce5dbada73137ad3257a6f2e1be8f309c1fe9afc5410a',
        token: {
          tokenType: ZERO_ADDRESS,
          tokenAddress: `0x${tokenAddress}`,
          tokenSubID: ZERO_ADDRESS,
        },
        value: '9138822709a9fc231cba6',
      },
      encryptedRandom: [
        '0xb47a353e294711ff73cf086f97ee1ed29b853b67c353bc2371b87fe72c716cc6',
        '0x3d321af08b8fa7a8f70379407706b752',
      ],
    };
    // override root validator as we're not processing on chain
    merkleTree.validateRoot = () => true;
    await merkleTree.queueLeaves(0, 0, [commitment]);

    await wallet.scan(chainID);
    const balance = await wallet.getBalance(chainID, tokenAddress);
    const value = hexToBigInt(commitment.preimage.value);
    expect(balance).to.equal(value);
  });

  it('[HH] Should deposit, transact and update balance', async function run() {
    if (!process.env.RUN_HARDHAT_TESTS) {
      this.skip();
      return;
    }

    // TODO-balances

    const initialBalance = await wallet.getBalance(chainID, tokenAddress);
    expect(initialBalance).to.equal(undefined);

    const address = wallet.getAddress(chainID);

    const mpk = Lepton.decodeAddress(address).masterPublicKey;
    const vpk = wallet.getViewingKeyPair().privateKey;
    const value = 11000000n * 10n ** 18n;
    // const random = babyjubjub.random();
    const random = '04eaf4ffc3fb976481dece36d3d26460048b6ff04e5e3fa6e1798d32947a0f2e';
    const deposit = new Deposit(mpk, random, value, token.address);

    const { preImage, encryptedRandom } = deposit.serialize(vpk);
    // Create deposit
    const depositTx = await contract.generateDeposit([preImage], [encryptedRandom]);

    // Send deposit on chain
    await etherswallet.sendTransaction(depositTx);
    await expect(awaitScan(wallet, chainID)).to.be.fulfilled;
    const balance = await wallet.getBalance(chainID, tokenAddress);
    expect(balance).to.equal(10972568578553615960099750n);
    // expect(balance).to.equal(10972500000000000000000000n); // Shouldn't it be this?

    // Create transaction
    const transaction = new Transaction(config.contracts.rail, chainID);
    transaction.withdraw(
      await etherswallet.getAddress(),
      300n * 10n ** 18n,
      config.contracts.treasury,
    );

    const proof = await transaction.prove(
      lepton.prover,
      lepton.wallets[walletID],
      testEncryptionKey,
    );
    const transact = await contract.transact([proof]);

    const transactTx = await etherswallet.sendTransaction(transact);
    await transactTx.wait();
    // const receipt = await transactTx.wait();
    // log(receipt);
    await awaitScan(wallet, chainID);

    assert.isTrue(
      (await wallet.getBalance(chainID, tokenAddress)) === 10972568578553615960099750n,
      'Failed to receive expected balance',
    );
    /*
    transaction.outputs = [
      new Note(
        babyjubjub.privateKeyToPubKey(babyjubjub.seedToPrivateKey(bytes.random(32))),
        '0x1e686e7506b0f4f21d6991b4cb58d39e77c31ed0577a986750c8dce8804af5b9',
        new BN('300', 10),
        config.contracts.rail,
      ),
    ];
      */
  }).timeout(900000);

  it('Should set/get last synced block', async () => {
    const chainIDForSyncedBlock = 10010;
    let lastSyncedBlock = await lepton.getLastSyncedBlock(chainIDForSyncedBlock);
    expect(lastSyncedBlock).to.equal(undefined);
    await lepton.setLastSyncedBlock(100, chainIDForSyncedBlock);
    lastSyncedBlock = await lepton.getLastSyncedBlock(chainIDForSyncedBlock);
    expect(lastSyncedBlock).to.equal(100);
    await lepton.setLastSyncedBlock(100000, chainIDForSyncedBlock);
    lastSyncedBlock = await lepton.getLastSyncedBlock(chainIDForSyncedBlock);
    expect(lastSyncedBlock).to.equal(100000);
  });

  afterEach(async () => {
    if (!process.env.RUN_HARDHAT_TESTS) {
      return;
    }
    lepton.unload();
    await provider.send('evm_revert', [snapshot]);
  });
});
