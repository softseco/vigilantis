// SPDX-License-Identifier: BUSL-1.1
//
// What Vigilantis adds to a transfer: compute units and transaction size, measured on real transfers
// through Token-2022 with every rule switched on (allowlist, blocklist, a limit with the
// confidential opt-in). Three kinds of transfer: public by the owner, public by a delegate (the
// blocklist then also reads the delegate's entry) and confidential (the transaction of the SDK's
// transfer that carries Token-2022's Transfer instruction; the proofs travel in the others).
//
// docs/audit-scope.md records the numbers. The checks below fail if the hook gets much more expensive or
// if a transfer transaction loses the room a wallet needs for its priority-fee instructions.
//
// Part of the hook's cost depends on the mint: Anchor checks the meta list's address with
// `find_program_address`, which tries bumps from 255 down and pays 1,500 CU for every try. The
// table shows that part separately, and the limit applies to the rest.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  applyPendingBalance,
  configureAccount,
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
  createApproveCheckedInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { assert } from "chai";
import { Vigilantis } from "../sdk/src/idl/vigilantis";

const CONFIRM = { commitment: "confirmed" as const };

/** Solana's limit on a serialized transaction. */
const PACKET_DATA_SIZE = 1232;
/**
 * Bytes a wallet needs to add `SetComputeUnitLimit` and `SetComputeUnitPrice` to a transaction
 * that does not use the Compute Budget program yet: its address (32) plus two instructions
 * (1 + 1 + 1 + 5 and 1 + 1 + 1 + 9 bytes) is 52, with two bytes to spare for length prefixes.
 */
const COMPUTE_BUDGET_ROOM = 54;
/** About twice what the hook used on 17 Oct 2026 (at most 7,865 CU without the bump search). */
const MAX_HOOK_CU = 16_000;
/** What `create_program_address` costs, once per bump that `find_program_address` tries. */
const CU_PER_BUMP_TRY = 1_500;

type Measurement = {
  transfer: string;
  signature: Signature;
  totalCu: number;
  vigilantisCu: number;
  /** CU of the extra bump tries for the meta list's address; depends on the mint. */
  bumpSearchCu: number;
  bytes: number;
};

describe("vigilantis — what the hook costs a transfer", function () {
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

  const decimals = 2;
  const measurements: Measurement[] = [];

  let authority: KeyPairSigner;
  let mint: KeyPairSigner;
  const aliceWeb3 = anchor.web3.Keypair.generate();
  const daveWeb3 = anchor.web3.Keypair.generate();
  let alice: KeyPairSigner;
  let bob: KeyPairSigner;
  let auditorElgamalPubkey: Address;

  const mintKey = () => new PublicKey(mint.address);
  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const policyPda = () => pda([Buffer.from("policy"), mintKey().toBuffer()]);
  const metaListPda = () => pda([Buffer.from("extra-account-metas"), mintKey().toBuffer()]);
  const allowEntryPda = (w: PublicKey) =>
    pda([Buffer.from("allow"), mintKey().toBuffer(), w.toBuffer()]);
  const freezeAuthorityPda = () => pda([Buffer.from("freeze-authority"), mintKey().toBuffer()]);
  const ataOf = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(mintKey(), owner, true, TOKEN_2022_PROGRAM_ID);

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

  async function funded(signer: KeyPairSigner): Promise<KeyPairSigner> {
    await airdrop({
      recipientAddress: signer.address,
      lamports: lamports(2_000_000_000n),
      commitment: "confirmed",
    });
    return signer;
  }

  /** Compute units, Vigilantis's share of them, and the serialized size of a confirmed transaction. */
  async function measure(name: string, signature: Signature): Promise<Measurement> {
    const tx = await rpc
      .getTransaction(signature, {
        commitment: "confirmed",
        encoding: "base64",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    assert.isNotNull(tx, `transaction ${signature} not found`);
    const logs = tx!.meta?.logMessages ?? [];
    const vigilantis = program.programId.toBase58();
    const vigilantisCu = logs
      .map((l) => l.match(new RegExp(`^Program ${vigilantis} consumed (\\d+) of`)))
      .filter((m): m is RegExpMatchArray => m !== null)
      .reduce((sum, m) => sum + Number(m[1]), 0);
    const [, metaListBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mintKey().toBuffer()],
      program.programId
    );
    const m: Measurement = {
      transfer: name,
      signature,
      totalCu: Number(tx!.meta?.computeUnitsConsumed ?? 0),
      vigilantisCu,
      bumpSearchCu: (255 - metaListBump) * CU_PER_BUMP_TRY,
      bytes: Buffer.from(tx!.transaction[0], "base64").length,
    };
    measurements.push(m);
    return m;
  }

  async function publicTransfer(signer: anchor.web3.Keypair, amount: bigint): Promise<Signature> {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection,
      ataOf(aliceWeb3.publicKey),
      mintKey(),
      ataOf(new PublicKey(bob.address)),
      signer.publicKey,
      amount,
      decimals,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    const signature = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [signer], CONFIRM);
    return signature as Signature;
  }

  before(async () => {
    authority = await createKeyPairSignerFromBytes(payer.secretKey);
    mint = await generateKeyPairSigner();
    alice = await funded(await createKeyPairSignerFromBytes(aliceWeb3.secretKey));
    bob = await funded(await generateKeyPairSigner());
    await funded(await createKeyPairSignerFromBytes(daveWeb3.secretKey));
    auditorElgamalPubkey = getAuditorElgamalPubkey(
      await deriveAuditorElgamalKeypair(await generateKeyPairSigner())
    );

    // A mint with confidential transfers, an auditor, Vigilantis as hook and freeze authority.
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
    await send(authority, [
      getCreateAccountInstruction({
        payer: authority,
        newAccount: mint,
        lamports: await rpc.getMinimumBalanceForRentExemption(space).send(),
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

    // Every rule on: allowlist, blocklist, a limit, and the confidential opt-in.
    await program.methods
      .initializePolicy(true, true, new anchor.BN(1_000_000), true)
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
    const bobKey = new PublicKey(bob.address);
    await program.methods
      .addToAllowlist()
      .accountsPartial({
        authority: payer.publicKey,
        mint: mintKey(),
        wallet: bobKey,
        policyConfig: policyPda(),
        allowEntry: allowEntryPda(bobKey),
        systemProgram: SystemProgram.programId,
        role: null,
      })
      .rpc(CONFIRM);

    // Alice and Bob get confidential-capable accounts; Alice gets 10,000, half of it confidential.
    for (const owner of [alice, bob]) {
      await configureAccount({ rpc, rpcSubscriptions, payer: owner, owner, mint: mint.address });
    }
    await send(authority, [
      getMintToInstruction({
        mint: mint.address,
        token: address(ataOf(aliceWeb3.publicKey).toBase58()),
        mintAuthority: authority,
        amount: 10_000n,
      }),
    ]);
    await deposit({ rpc, rpcSubscriptions, payer: alice, owner: alice, mint: mint.address, amount: 5_000n, decimals });
    await applyPendingBalance({ rpc, rpcSubscriptions, payer: alice, owner: alice, mint: mint.address });
  });

  it("measures a public transfer by the owner", async () => {
    const m = await measure("public, signed by the owner", await publicTransfer(aliceWeb3, 100n));
    assert.isAbove(m.vigilantisCu, 0, "Vigilantis did not run");
    assert.isAtMost(m.vigilantisCu - m.bumpSearchCu, MAX_HOOK_CU);
    assert.isAtMost(m.bytes, PACKET_DATA_SIZE - COMPUTE_BUDGET_ROOM, "no room left for priority fees");
  });

  it("measures a public transfer by a delegate", async () => {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createApproveCheckedInstruction(
          ataOf(aliceWeb3.publicKey),
          mintKey(),
          daveWeb3.publicKey,
          aliceWeb3.publicKey,
          500n,
          decimals,
          [],
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [aliceWeb3],
      CONFIRM
    );
    const m = await measure("public, signed by a delegate", await publicTransfer(daveWeb3, 100n));
    assert.isAbove(m.vigilantisCu, 0, "Vigilantis did not run");
    assert.isAtMost(m.vigilantisCu - m.bumpSearchCu, MAX_HOOK_CU);
    assert.isAtMost(m.bytes, PACKET_DATA_SIZE - COMPUTE_BUDGET_ROOM, "no room left for priority fees");
  });

  it("measures a confidential transfer (the transaction that carries Token-2022's Transfer)", async () => {
    const { signatures } = await transfer({
      rpc,
      rpcSubscriptions,
      payer: alice,
      owner: alice,
      mint: mint.address,
      destinationOwner: bob.address,
      amount: 100n,
      auditorElgamalPubkey,
    });
    let found: Measurement | undefined;
    for (const signature of signatures) {
      const tx = await connection.getTransaction(signature, CONFIRM_V0);
      if (tx?.meta?.logMessages?.some((l) => l.includes("ConfidentialTransferInstruction::Transfer"))) {
        found = await measure("confidential, signed by the owner", signature);
      }
    }
    assert.isDefined(found, "no transaction carried the confidential Transfer");
    assert.isAbove(found!.vigilantisCu, 0, "Vigilantis did not run");
    assert.isAtMost(found!.vigilantisCu - found!.bumpSearchCu, MAX_HOOK_CU);
    assert.isAtMost(found!.bytes, PACKET_DATA_SIZE);
  });

  after(() => {
    if (measurements.length === 0) return;
    console.log(
      "\n      | Transfer | Transaction CU | Vigilantis CU | of which extra bump tries | Transaction bytes | Room left |"
    );
    console.log("      |---|---:|---:|---:|---:|---:|");
    for (const m of measurements) {
      console.log(
        `      | ${m.transfer} | ${m.totalCu} | ${m.vigilantisCu} | ${m.bumpSearchCu} | ${m.bytes} | ${PACKET_DATA_SIZE - m.bytes} |`
      );
    }
  });
});

const CONFIRM_V0 = { commitment: "confirmed" as const, maxSupportedTransactionVersion: 0 };
