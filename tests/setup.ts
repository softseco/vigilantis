// SPDX-License-Identifier: BUSL-1.1
//
// Setting up a mint must not be something a stranger can block. Anyone can send lamports to any
// address, including the policy and meta-list PDAs of a mint whose setup has not run yet.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { Vigilantis } from "../sdk/src/idl/vigilantis";

const CONFIRM = { commitment: "confirmed" as const };

describe("vigilantis — setup cannot be blocked by pre-funding its accounts", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vigilantis as Program<Vigilantis>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const stranger = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  async function createHookedMint(): Promise<Keypair> {
    const mint = Keypair.generate();
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space: mintLen,
          lamports: await connection.getMinimumBalanceForRentExemption(mintLen),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(mint.publicKey, payer.publicKey, program.programId, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(mint.publicKey, 0, payer.publicKey, null, TOKEN_2022_PROGRAM_ID)
      ),
      [payer, mint],
      CONFIRM
    );
    return mint;
  }

  /** The stranger sends `lamports` to `address`, as anyone can. */
  const fund = (address: PublicKey, lamports: number) =>
    sendAndConfirmTransaction(
      connection,
      new Transaction().add(SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: address, lamports })),
      [stranger],
      CONFIRM
    );

  before(async () => {
    await connection.confirmTransaction(
      await connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL),
      "confirmed"
    );
  });

  /**
   * The stranger front-runs the issuer: a system account holding `lamports` now sits at the
   * policy and meta-list addresses. With System `CreateAccount` alone the issuer could never
   * create the list (Vigilantis 2.1.0 and earlier), and every transfer of the mint would fail for
   * good. Then the issuer sets the mint up and a transfer goes through the hook.
   */
  async function setUpAfterPrefunding(lamports: number) {
    const mint = await createHookedMint();
    const policy = pda([Buffer.from("policy"), mint.publicKey.toBuffer()]);
    const metaList = pda([Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()]);
    await fund(metaList, lamports);
    await fund(policy, lamports);

    await program.methods
      .initializePolicy(false, false, new anchor.BN(0), false)
      .accountsPartial({ authority: payer.publicKey, mint: mint.publicKey, policyConfig: policy, systemProgram: SystemProgram.programId })
      .rpc(CONFIRM);
    await program.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({ payer: payer.publicKey, extraAccountMetaList: metaList, mint: mint.publicKey, systemProgram: SystemProgram.programId })
      .rpc(CONFIRM);

    const info = await connection.getAccountInfo(metaList, "confirmed");
    assert.ok(info, "meta list missing");
    assert.ok(info!.owner.equals(program.programId), "meta list not owned by Vigilantis");
    assert.isAtLeast(info!.lamports, await connection.getMinimumBalanceForRentExemption(info!.data.length));

    // And the mint works: a transfer goes through the hook.
    const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(payer.publicKey, ata(alice.publicKey), alice.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(payer.publicKey, ata(bob.publicKey), bob.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createMintToInstruction(mint.publicKey, ata(alice.publicKey), payer.publicKey, 10, [], TOKEN_2022_PROGRAM_ID)
      ),
      [payer],
      CONFIRM
    );
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection, ata(alice.publicKey), mint.publicKey, ata(bob.publicKey), alice.publicKey, 4n, 0, [], "confirmed", TOKEN_2022_PROGRAM_ID
    );
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer, alice], CONFIRM);
    assert.equal((await getAccount(connection, ata(bob.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 4n);
  }

  it("creates the meta list when a stranger funded its address first (issuer tops up the rent)", async () => {
    // Rent-exempt for an empty account, less than the list needs.
    await setUpAfterPrefunding(await connection.getMinimumBalanceForRentExemption(0));
  });

  it("creates the meta list when a stranger funded its address with more than its rent", async () => {
    await setUpAfterPrefunding(LAMPORTS_PER_SOL / 100);
  });

  it("still refuses a second meta list for the same mint", async () => {
    const mint = await createHookedMint();
    const metaList = pda([Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()]);
    // The compute-unit limit only makes the second transaction differ from the first.
    const init = (units: number) =>
      program.methods
        .initializeExtraAccountMetaList()
        .accountsPartial({ payer: payer.publicKey, extraAccountMetaList: metaList, mint: mint.publicKey, systemProgram: SystemProgram.programId })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units })])
        .rpc(CONFIRM);
    await init(200_000);
    try {
      await init(210_000);
    } catch (e) {
      assert.match(String(e) + JSON.stringify((e as { logs?: string[] }).logs ?? []), /already in use/i);
      return;
    }
    assert.fail("a second initialize_extra_account_meta_list went through");
  });
});
