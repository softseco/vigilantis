// SPDX-License-Identifier: BUSL-1.1
//
// Real Token-2022 confidential transfers through Vigilantis. Unlike the policy suite, which calls the
// hook directly with amount = u64::MAX, every transfer here is a genuine confidential transfer: the
// sender's proofs are generated and verified by the ZK ElGamal Proof Program, Token-2022 executes
// the transfer, and Token-2022 itself invokes Vigilantis as the mint's transfer hook.
//
// The validator must be Agave 4.x (older ones reject today's ZK proofs) and needs a Token-2022 build
// that matches @solana-program/token-2022 (see tests/fixtures/README.md), which Anchor.toml loads
// for `anchor test`. The SDK used for the confidential side is the published
// @softseco/confidential-transfers.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  applyPendingBalance,
  configureAccount,
  decryptBalance,
  decryptTransferAmountAsAuditor,
  deposit,
  deriveAuditorElgamalKeypair,
  getAuditorElgamalPubkey,
  transfer,
} from "@softseco/confidential-transfers";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getInitializeTransferHookInstruction,
  getMintSize,
  getMintToInstruction,
} from "@solana-program/token-2022";
import {
  address,
  airdropFactory,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  some,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  TOKEN_2022_PROGRAM_ID,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { assert } from "chai";
import { Vigilantis } from "../sdk/src/idl/vigilantis";

const CONFIRM = { commitment: "confirmed" as const };

describe("vigilantis — real confidential transfers", function () {
  // Each confidential transfer is five transactions (four proofs and the transfer).
  this.timeout(300_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vigilantis as Program<Vigilantis>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const rpcUrl = connection.rpcEndpoint;
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(
    rpcUrl.replace(/^http/, "ws").replace(/:8899\b/, ":8900")
  );
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  const airdrop = airdropFactory({ rpc, rpcSubscriptions });

  const LIMIT = 1_000n;
  const decimals = 2;

  // The mint authority must sign Vigilantis's policy and meta-list setup, so it is the provider
  // wallet, used from both web3.js (Anchor) and @solana/kit.
  let authority: KeyPairSigner;
  let mint: KeyPairSigner;
  const aliceWeb3 = anchor.web3.Keypair.generate();
  let alice: KeyPairSigner;
  let bob: KeyPairSigner;
  let carol: KeyPairSigner;
  let auditorWallet: KeyPairSigner;
  let auditorElgamalPubkey: Address;

  const mintKey = () => new PublicKey(mint.address);
  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const policyPda = () => pda([Buffer.from("policy"), mintKey().toBuffer()]);
  const metaListPda = () => pda([Buffer.from("extra-account-metas"), mintKey().toBuffer()]);
  const allowEntryPda = (w: Address) =>
    pda([Buffer.from("allow"), mintKey().toBuffer(), new PublicKey(w).toBuffer()]);
  const blockEntryPda = (w: Address) =>
    pda([Buffer.from("block"), mintKey().toBuffer(), new PublicKey(w).toBuffer()]);
  const freezeAuthorityPda = () => pda([Buffer.from("freeze-authority"), mintKey().toBuffer()]);
  const ataOf = (owner: Address) =>
    getAssociatedTokenAddressSync(mintKey(), new PublicKey(owner), true, TOKEN_2022_PROGRAM_ID);

  async function send(feePayer: KeyPairSigner, instructions: Instruction[]) {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx)
    );
    const signed = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithBlockhashLifetime(signed);
    await sendAndConfirm(signed, CONFIRM);
  }

  async function fundedSigner(signer?: KeyPairSigner): Promise<KeyPairSigner> {
    signer ??= await generateKeyPairSigner();
    await airdrop({
      recipientAddress: signer.address,
      lamports: lamports(2_000_000_000n),
      commitment: "confirmed",
    });
    return signer;
  }

  const setPolicy = (allowlist: boolean, blocklist: boolean, limit: bigint, allowConfidential: boolean) =>
    program.methods
      .updatePolicy(allowlist, blocklist, new anchor.BN(limit.toString()), allowConfidential)
      .accountsPartial({ authority: payer.publicKey, mint: mintKey(), policyConfig: policyPda() })
      .rpc(CONFIRM);

  const listAccounts = (wallet: Address) => ({
    authority: payer.publicKey,
    mint: mintKey(),
    policyConfig: policyPda(),
    wallet: new PublicKey(wallet),
    role: null,
  });

  const confidentialTransfer = (from: KeyPairSigner, to: KeyPairSigner, amount: bigint) =>
    transfer({
      rpc,
      rpcSubscriptions,
      payer: from,
      owner: from,
      mint: mint.address,
      destinationOwner: to.address,
      amount,
      auditorElgamalPubkey,
    });

  /**
   * Run a confidential transfer that Vigilantis must refuse, check that the refusal came from the
   * hook (Token-2022's Transfer instruction calling Vigilantis), and return the error text.
   */
  async function refused(from: KeyPairSigner, to: KeyPairSigner, amount: bigint): Promise<string> {
    let message: string | undefined;
    try {
      await confidentialTransfer(from, to, amount);
    } catch (e) {
      message = String((e as Error).message ?? e);
    }
    if (message === undefined)
      assert.fail("the confidential transfer went through, but Vigilantis should have refused it");
    assert.include(
      message,
      "ConfidentialTransferInstruction::Transfer",
      "not refused in Token-2022's Transfer:\n" + message
    );
    assert.include(
      message,
      `Program ${program.programId.toBase58()} invoke [2]`,
      "Vigilantis was not called as the hook:\n" + message
    );
    if (process.env.SHOW_REFUSAL) console.log(message);
    return message;
  }

  /** The program logs of a confirmed transaction. */
  async function logsOf(signature: Signature): Promise<string[]> {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return tx?.meta?.logMessages ?? [];
  }

  /** The logs of the transaction that holds the Token-2022 transfer (the others carry proofs). */
  async function transferLogs(signatures: Signature[]): Promise<string[]> {
    for (const signature of signatures) {
      const logs = await logsOf(signature);
      if (logs.some((l) => l.includes("ConfidentialTransferInstruction::Transfer"))) return logs;
    }
    assert.fail("no transaction of the confidential transfer ran Token-2022's Transfer instruction");
  }

  before(async () => {
    // Agave 2.x and 3.x verify ZK ElGamal proofs in an older format and reject the proofs that
    // @solana/zk-sdk makes today (`AlgebraicRelation`). Say so instead of failing nine tests.
    const { "solana-core": core } = await rpc.getVersion().send();
    if (Number(core.split(".")[0]) < 4) {
      throw new Error(
        `these tests need solana-test-validator from Agave 4.x, but the validator is ${core}. ` +
          "Put an Agave 4.x install first in PATH (solana-test-validator --version)."
      );
    }
    authority = await createKeyPairSignerFromBytes(payer.secretKey);
    [mint, alice, bob, carol, auditorWallet] = await Promise.all([
      generateKeyPairSigner(),
      createKeyPairSignerFromBytes(aliceWeb3.secretKey).then(fundedSigner),
      fundedSigner(),
      fundedSigner(),
      generateKeyPairSigner(),
    ]);
    auditorElgamalPubkey = getAuditorElgamalPubkey(await deriveAuditorElgamalKeypair(auditorWallet));
  });

  it("creates a mint with confidential transfers, an auditor, and Vigilantis as its transfer hook and freeze authority", async () => {
    const extensions = [
      extension("TransferHook", {
        authority: authority.address,
        programId: address(program.programId.toBase58()),
      }),
      extension("ConfidentialTransferMint", {
        authority: some(authority.address),
        autoApproveNewAccounts: true,
        auditorElgamalPubkey: some(auditorElgamalPubkey),
      }),
    ];
    const space = BigInt(getMintSize(extensions));
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    await send(authority, [
      getCreateAccountInstruction({
        payer: authority,
        newAccount: mint,
        lamports: rent,
        space,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getInitializeTransferHookInstruction({
        mint: mint.address,
        authority: some(authority.address),
        programId: some(address(program.programId.toBase58())),
      }),
      getInitializeConfidentialTransferMintInstruction({
        mint: mint.address,
        authority: some(authority.address),
        autoApproveNewAccounts: true,
        auditorElgamalPubkey: some(auditorElgamalPubkey),
      }),
      getInitializeMint2Instruction({
        mint: mint.address,
        decimals,
        mintAuthority: authority.address,
        freezeAuthority: some(address(freezeAuthorityPda().toBase58())),
      }),
    ]);
  });

  it("sets a policy with a limit and no confidential opt-in, and the meta list", async () => {
    await program.methods
      .initializePolicy(false, true, new anchor.BN(LIMIT.toString()), false)
      .accountsPartial({
        authority: payer.publicKey,
        mint: mintKey(),
        policyConfig: policyPda(),
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
    await program.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({
        payer: payer.publicKey,
        extraAccountMetaList: metaListPda(),
        mint: mintKey(),
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
  });

  it("configures three accounts and moves 5000 of Alice's tokens into her confidential balance", async () => {
    for (const owner of [alice, bob, carol]) {
      await configureAccount({ rpc, rpcSubscriptions, payer: owner, owner, mint: mint.address });
    }
    await send(authority, [
      getMintToInstruction({
        mint: mint.address,
        token: address(ataOf(alice.address).toBase58()),
        mintAuthority: authority,
        amount: 10_000n,
      }),
    ]);
    await deposit({
      rpc,
      rpcSubscriptions,
      payer: alice,
      owner: alice,
      mint: mint.address,
      amount: 5_000n,
      decimals,
    });
    await applyPendingBalance({ rpc, rpcSubscriptions, payer: alice, owner: alice, mint: mint.address });
    assert.equal(await decryptBalance({ rpc, owner: alice, mint: mint.address }), 5_000n);
  });

  it("refuses a confidential transfer: the limit cannot be checked and the issuer has not opted in", async () => {
    const error = await refused(alice, bob, 100n);
    assert.match(error, /ConfidentialAmountNotEnforceable|0x1775/);
    assert.equal(await decryptBalance({ rpc, owner: alice, mint: mint.address }), 5_000n);
  });

  it("still enforces the limit on a public transfer of the same mint", async () => {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection,
      ataOf(alice.address),
      mintKey(),
      ataOf(bob.address),
      new PublicKey(alice.address),
      LIMIT + 1n,
      decimals,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(ix), [aliceWeb3], CONFIRM);
      assert.fail("a public transfer over the limit went through");
    } catch (e) {
      assert.match(String((e as Error).message ?? e), /TransferExceedsLimit|0x1771/);
    }
  });

  it("lets a confidential transfer through once the issuer opts in, and Bob can read it", async () => {
    await setPolicy(false, true, LIMIT, true);
    const { signatures } = await confidentialTransfer(alice, bob, 250n);
    const logs = await transferLogs(signatures);
    assert.ok(
      logs.some((l) => l.includes("Vigilantis: confidential transfer allowed")),
      "Vigilantis did not run as the hook of the transfer:\n" + logs.join("\n")
    );
    await applyPendingBalance({ rpc, rpcSubscriptions, payer: bob, owner: bob, mint: mint.address });
    assert.equal(await decryptBalance({ rpc, owner: bob, mint: mint.address }), 250n);
    assert.equal(await decryptBalance({ rpc, owner: alice, mint: mint.address }), 4_750n);
  });

  it("lets the auditor read the amount the hook could not see", async () => {
    // The amount is above the limit: on-chain the hook cannot tell, off-chain the auditor can.
    const { signatures } = await confidentialTransfer(alice, bob, 1_500n);
    const auditorKeypair = await deriveAuditorElgamalKeypair(auditorWallet);
    let amount: bigint | undefined;
    for (const signature of signatures) {
      try {
        amount = await decryptTransferAmountAsAuditor({ rpc, signature, auditorKeypair });
        break;
      } catch {
        // a proof transaction, not the transfer: try the next one
      }
    }
    assert.equal(amount, 1_500n);
    assert.isTrue(amount! > LIMIT);
  });

  it("refuses a confidential transfer to a blocklisted recipient", async () => {
    await program.methods
      .addToBlocklist()
      .accountsPartial({ ...listAccounts(carol.address), blockEntry: blockEntryPda(carol.address) })
      .rpc(CONFIRM);
    const error = await refused(alice, carol, 10n);
    assert.match(error, /RecipientBlocked|0x1773/);
  });

  it("refuses a confidential transfer from a blocklisted sender, and allows it again once unblocked", async () => {
    await program.methods
      .addToBlocklist()
      .accountsPartial({ ...listAccounts(alice.address), blockEntry: blockEntryPda(alice.address) })
      .rpc(CONFIRM);
    const error = await refused(alice, bob, 10n);
    assert.match(error, /SenderBlocked|0x1772/);

    await program.methods
      .removeFromBlocklist()
      .accountsPartial({ ...listAccounts(alice.address), blockEntry: blockEntryPda(alice.address) })
      .rpc(CONFIRM);
    await confidentialTransfer(alice, bob, 10n);
  });

  it("applies the allowlist to confidential transfers", async () => {
    await setPolicy(true, true, LIMIT, true);
    const error = await refused(alice, bob, 10n);
    assert.match(error, /RecipientNotAllowlisted|0x1770/);

    await program.methods
      .addToAllowlist()
      .accountsPartial({ ...listAccounts(bob.address), allowEntry: allowEntryPda(bob.address) })
      .rpc(CONFIRM);
    await confidentialTransfer(alice, bob, 10n);
  });

  it("stops a confidential transfer to a frozen account, and lets it through after a thaw", async () => {
    // Freezing is Token-2022's own check, made before the hook runs, so the refusal comes from
    // Token-2022 (AccountFrozen, 0x11) and Vigilantis is never called.
    const freezeAccounts = {
      authority: payer.publicKey,
      mint: mintKey(),
      policyConfig: policyPda(),
      tokenAccount: ataOf(bob.address),
      freezeAuthority: freezeAuthorityPda(),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      freezeRecord: PublicKey.findProgramAddressSync(
        [Buffer.from("freeze-record"), mintKey().toBuffer(), ataOf(bob.address).toBuffer()],
        program.programId,
      )[0],
      systemProgram: SystemProgram.programId,
      role: null,
    };
    const caseRef = Array.from({ length: 32 }, (_, i) => i);
    await program.methods.freezeTokenAccount(4, caseRef).accountsPartial(freezeAccounts).rpc(CONFIRM);

    let message: string | undefined;
    try {
      await confidentialTransfer(alice, bob, 10n);
    } catch (e) {
      message = String((e as Error).message ?? e);
    }
    if (message === undefined) assert.fail("a confidential transfer reached a frozen account");
    assert.match(message, /0x11|frozen/i);
    assert.notInclude(message, `Program ${program.programId.toBase58()} invoke [2]`);

    await program.methods.thawTokenAccount(7, caseRef).accountsPartial(freezeAccounts).rpc(CONFIRM);
    await confidentialTransfer(alice, bob, 10n);
  });

  it("leaves the balances consistent with the transfers that went through", async () => {
    await applyPendingBalance({ rpc, rpcSubscriptions, payer: bob, owner: bob, mint: mint.address });
    // 250 + 1500 + 10 + 10 + 10 reached Bob; every refused transfer left Alice's balance untouched.
    assert.equal(await decryptBalance({ rpc, owner: bob, mint: mint.address }), 1_780n);
    assert.equal(await decryptBalance({ rpc, owner: alice, mint: mint.address }), 5_000n - 1_780n);
  });
});
