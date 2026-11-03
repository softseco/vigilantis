// SPDX-License-Identifier: BUSL-1.1
//
// End-to-end proof of Vigilantis's compliance rules on a Token-2022 mint whose
// transfer hook is Vigilantis: a transfer limit, a toggleable allowlist, a
// blocklist, and live policy updates.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
// The committed IDL, the same one the SDK builds against. `target/types/` is a
// build artifact and is not in the repository, so CI can typecheck this file.
import { Vigilantis } from "../sdk/src/idl/vigilantis";
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
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assert } from "chai";

// Confirm everything at the same commitment we read at.
const CONFIRM = { commitment: "confirmed" as const };

describe("vigilantis — policy rules", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vigilantis as Program<Vigilantis>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const mint = Keypair.generate();
  const decimals = 0;
  const LIMIT = 100;

  const allowed = Keypair.generate();
  const blocked = Keypair.generate();
  const sanctioned = Keypair.generate();

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  const metaListPda = pda([Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()]);
  const policyPda = pda([Buffer.from("policy"), mint.publicKey.toBuffer()]);
  const allowEntryPda = (w: PublicKey) =>
    pda([Buffer.from("allow"), mint.publicKey.toBuffer(), w.toBuffer()]);
  const blockEntryPda = (w: PublicKey) =>
    pda([Buffer.from("block"), mint.publicKey.toBuffer(), w.toBuffer()]);

  const ataOf = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint.publicKey, owner, true, TOKEN_2022_PROGRAM_ID);

  const balanceOf = async (owner: PublicKey) =>
    (await getAccount(connection, ataOf(owner), "confirmed", TOKEN_2022_PROGRAM_ID)).amount.toString();

  async function createHolder(owner: PublicKey, amount: number) {
    const ata = ataOf(owner);
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    if (amount > 0) {
      tx.add(
        createMintToInstruction(mint.publicKey, ata, payer.publicKey, amount, [], TOKEN_2022_PROGRAM_ID)
      );
    }
    await sendAndConfirmTransaction(connection, tx, [payer], CONFIRM);
    return ata;
  }

  async function transfer(destinationAta: PublicKey, amount: number) {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection,
      ataOf(payer.publicKey),
      mint.publicKey,
      destinationAta,
      payer.publicKey,
      BigInt(amount),
      decimals,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    return sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], CONFIRM);
  }

  const expectBlocked = async (destinationAta: PublicKey, amount: number) => {
    try {
      await transfer(destinationAta, amount);
      return false;
    } catch (_e) {
      return true;
    }
  };

  const setPolicy = (
    allowlist: boolean,
    blocklist: boolean,
    limit: number,
    allowConfidential = false
  ) =>
    program.methods
      .updatePolicy(allowlist, blocklist, new anchor.BN(limit), allowConfidential)
      .accountsPartial({ authority: payer.publicKey, mint: mint.publicKey, policyConfig: policyPda })
      .rpc(CONFIRM);

  // Token-2022 invokes the transfer hook for a *confidential* transfer with
  // amount = u64::MAX, because the real amount is encrypted and never reaches
  // the hook. tests/confidential.ts tests those rules with genuine confidential
  // transfers; here a direct call only shows that the hook refuses to run
  // outside a transfer.
  const U64_MAX = new anchor.BN("18446744073709551615");

  const callHook = (amount: anchor.BN, destOwner: PublicKey) =>
    program.methods
      .transferHook(amount)
      .accountsPartial({
        sourceToken: ataOf(payer.publicKey),
        mint: mint.publicKey,
        destinationToken: ataOf(destOwner),
        owner: payer.publicKey,
        extraAccountMetaList: metaListPda,
        policyConfig: policyPda,
        sourceBlock: blockEntryPda(payer.publicKey),
        destBlock: blockEntryPda(destOwner),
        allowEntry: allowEntryPda(destOwner),
      })
      .rpc(CONFIRM);

  it("creates a Token-2022 mint whose transfer hook is Vigilantis", async () => {
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mint.publicKey,
        payer.publicKey,
        program.programId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(mint.publicKey, decimals, payer.publicKey, null, TOKEN_2022_PROGRAM_ID)
    );
    await sendAndConfirmTransaction(connection, tx, [payer, mint], CONFIRM);
  });

  it("initializes the policy (allowlist on, limit 100)", async () => {
    await program.methods
      .initializePolicy(true, false, new anchor.BN(LIMIT), false)
      .accountsPartial({
        authority: payer.publicKey,
        mint: mint.publicKey,
        policyConfig: policyPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
  });

  it("initializes the extra-account-meta list", async () => {
    await program.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({
        payer: payer.publicKey,
        extraAccountMetaList: metaListPda,
        mint: mint.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
  });

  it("sets up a funded source and recipients", async () => {
    await createHolder(payer.publicKey, 1000);
    await createHolder(allowed.publicKey, 0);
    await createHolder(blocked.publicKey, 0);
    await createHolder(sanctioned.publicKey, 0);

    await program.methods
      .addToAllowlist()
      .accountsPartial({
        authority: payer.publicKey,
        mint: mint.publicKey,
        wallet: allowed.publicKey,
        policyConfig: policyPda,
        allowEntry: allowEntryPda(allowed.publicKey),
        systemProgram: SystemProgram.programId,
        role: null,
      })
      .rpc(CONFIRM);
  });

  it("allows an allowlisted transfer within the limit", async () => {
    await transfer(ataOf(allowed.publicKey), LIMIT);
    assert.equal(await balanceOf(allowed.publicKey), String(LIMIT));
  });

  it("blocks a transfer over the limit", async () => {
    assert.isTrue(await expectBlocked(ataOf(allowed.publicKey), LIMIT + 1), "over-limit must be blocked");
    assert.equal(await balanceOf(allowed.publicKey), String(LIMIT), "no tokens should have moved");
  });

  it("blocks a non-allowlisted recipient", async () => {
    assert.isTrue(await expectBlocked(ataOf(blocked.publicKey), 50), "non-allowlisted must be blocked");
    assert.equal(await balanceOf(blocked.publicKey), "0");
  });

  it("respects a live policy update: disabling the allowlist lets the transfer through", async () => {
    await setPolicy(false, false, LIMIT);
    await transfer(ataOf(blocked.publicKey), 50);
    assert.equal(await balanceOf(blocked.publicKey), "50", "with allowlist off, the transfer should succeed");
  });

  it("enforces the blocklist: a sanctioned recipient is blocked while others still flow", async () => {
    // allowlist off, blocklist on
    await setPolicy(false, true, LIMIT);

    await program.methods
      .addToBlocklist()
      .accountsPartial({
        authority: payer.publicKey,
        mint: mint.publicKey,
        wallet: sanctioned.publicKey,
        policyConfig: policyPda,
        blockEntry: blockEntryPda(sanctioned.publicKey),
        systemProgram: SystemProgram.programId,
        role: null,
      })
      .rpc(CONFIRM);

    // sanctioned recipient is blocked...
    assert.isTrue(await expectBlocked(ataOf(sanctioned.publicKey), 10), "blocklisted recipient must be blocked");
    assert.equal(await balanceOf(sanctioned.publicKey), "0");

    // ...while a non-blocklisted recipient still receives.
    await transfer(ataOf(allowed.publicKey), 10);
    assert.equal(await balanceOf(allowed.publicKey), String(LIMIT + 10), "non-blocklisted recipient should still receive");
  });

  it("refuses a direct call of the hook, outside a transfer, without an event", async () => {
    // Token-2022 sets the source account's `transferring` flag for the length of a transfer; the
    // hook refuses any call without it before evaluating anything. Otherwise anyone could call it
    // with someone else's accounts and leave a TransferRefused naming them in the logs. The rules
    // for confidential amounts (u64::MAX) are tested with real confidential transfers in
    // tests/confidential.ts.
    for (const [amount, policy] of [[new anchor.BN(1), [false, true, 0]], [U64_MAX, [false, false, LIMIT]]] as const) {
      await setPolicy(policy[0], policy[1], policy[2], false);
      let name: string | undefined;
      let code: number | undefined;
      let logs: string[] = [];
      try {
        await callHook(amount, allowed.publicKey);
      } catch (e) {
        const err = e as anchor.AnchorError;
        name = err?.error?.errorCode?.code;
        code = err?.error?.errorCode?.number;
        logs = err?.logs ?? [];
      }
      assert.equal(name, "NotInTransfer");
      assert.equal(code, 6017);
      assert.isFalse(logs.some((l) => l.startsWith("Program data:")), "a refused direct call must emit no event");
    }
    await setPolicy(false, false, 0, false);
  });

  it("rejects allowlist writes from a non-authority", async () => {
    const rando = Keypair.generate();
    const outsider = Keypair.generate();
    const airdrop = await connection.requestAirdrop(rando.publicKey, 1_000_000_000);
    await connection.confirmTransaction(airdrop, "confirmed");

    let rejected = false;
    try {
      await program.methods
        .addToAllowlist()
        .accountsPartial({
          authority: rando.publicKey,
          mint: mint.publicKey,
          wallet: outsider.publicKey,
          policyConfig: policyPda,
          allowEntry: allowEntryPda(outsider.publicKey),
          systemProgram: SystemProgram.programId,
          role: null,
        })
        .signers([rando])
        .rpc(CONFIRM);
    } catch (_e) {
      rejected = true;
    }
    assert.isTrue(rejected, "only the policy authority may modify the allowlist");
  });

  it("rejects policy init by a non-mint-authority", async () => {
    const mint2 = Keypair.generate();
    const rando = Keypair.generate();
    const air = await connection.requestAirdrop(rando.publicKey, 1_000_000_000);
    await connection.confirmTransaction(air, "confirmed");

    // Create a fresh mint whose mint authority is the payer.
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint2.publicKey,
          space: mintLen,
          lamports,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(mint2.publicKey, payer.publicKey, program.programId, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(mint2.publicKey, 0, payer.publicKey, null, TOKEN_2022_PROGRAM_ID)
      ),
      [payer, mint2],
      CONFIRM
    );

    // A non-mint-authority tries to initialize the policy → rejected.
    const policy2 = pda([Buffer.from("policy"), mint2.publicKey.toBuffer()]);
    let rejected = false;
    try {
      await program.methods
        .initializePolicy(true, false, new anchor.BN(100), false)
        .accountsPartial({
          authority: rando.publicKey,
          mint: mint2.publicKey,
          policyConfig: policy2,
          systemProgram: SystemProgram.programId,
        })
        .signers([rando])
        .rpc(CONFIRM);
    } catch (_e) {
      rejected = true;
    }
    assert.isTrue(rejected, "only the mint authority may initialize the policy");
  });
});
