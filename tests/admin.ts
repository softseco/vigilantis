// SPDX-License-Identifier: BUSL-1.1
//
// Vigilantis 2.1: the blocklist also covers the transfer authority (a delegate), the policy
// authority is handed over in two steps, and every policy change and every refusal emits an
// event.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createApproveCheckedInstruction,
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
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { Vigilantis } from "../sdk/src/idl/vigilantis";

const CONFIRM = { commitment: "confirmed" as const };

describe("vigilantis — delegates, authority handover, events", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vigilantis as Program<Vigilantis>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const events = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));

  const mint = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const mallory = Keypair.generate();
  const dave = Keypair.generate();
  const newAuthority = Keypair.generate();
  const stranger = Keypair.generate();

  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const policyPda = pda([Buffer.from("policy"), mint.publicKey.toBuffer()]);
  const metaListPda = pda([Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()]);
  const pendingPda = pda([Buffer.from("pending-authority"), mint.publicKey.toBuffer()]);
  const allowEntry = (w: PublicKey) => pda([Buffer.from("allow"), mint.publicKey.toBuffer(), w.toBuffer()]);
  const blockEntry = (w: PublicKey) => pda([Buffer.from("block"), mint.publicKey.toBuffer(), w.toBuffer()]);
  const ataOf = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint.publicKey, owner, true, TOKEN_2022_PROGRAM_ID);
  const balanceOf = async (owner: PublicKey) =>
    (await getAccount(connection, ataOf(owner), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

  /** Events emitted by Vigilantis in a confirmed transaction. */
  async function eventsOf(signature: string) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return [...events.parseLogs(tx?.meta?.logMessages ?? [])];
  }

  /** Expect `run` to fail with Vigilantis error `name`; return the failed transaction's logs. */
  async function expectError(run: () => Promise<unknown>, name: string): Promise<string[]> {
    try {
      await run();
    } catch (e) {
      const logs =
        e instanceof SendTransactionError
          ? (await e.getLogs(connection)) ?? []
          : ((e as { logs?: string[] }).logs ?? []);
      const text = String(e) + "\n" + logs.join("\n");
      assert.include(text, name, text);
      return logs;
    }
    assert.fail(`expected ${name}, but the transaction went through`);
  }

  /** A public transfer through the hook, signed by `authority` (the owner or a delegate). */
  async function transfer(from: PublicKey, to: PublicKey, authority: Keypair, amount: bigint) {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection,
      ataOf(from),
      mint.publicKey,
      ataOf(to),
      authority.publicKey,
      amount,
      0,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    return sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer, authority], CONFIRM);
  }

  const listAccounts = (authority: PublicKey, wallet: PublicKey) => ({
    authority,
    mint: mint.publicKey,
    policyConfig: policyPda,
    wallet,
    // The signer is the admin, so no role entry is needed.
    role: null,
  });

  const updatePolicy = (authority: Keypair, allowlist: boolean, blocklist: boolean) =>
    program.methods
      .updatePolicy(allowlist, blocklist, new anchor.BN(0), false)
      .accountsPartial({ authority: authority.publicKey, mint: mint.publicKey, policyConfig: policyPda })
      .signers([authority])
      .rpc(CONFIRM);

  before(async () => {
    for (const k of [alice, mallory, dave, newAuthority, stranger]) {
      await connection.confirmTransaction(
        await connection.requestAirdrop(k.publicKey, LAMPORTS_PER_SOL),
        "confirmed"
      );
    }
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
        createInitializeTransferHookInstruction(
          mint.publicKey,
          payer.publicKey,
          program.programId,
          TOKEN_2022_PROGRAM_ID
        ),
        createInitializeMintInstruction(mint.publicKey, 0, payer.publicKey, null, TOKEN_2022_PROGRAM_ID)
      ),
      [payer, mint],
      CONFIRM
    );
    await program.methods
      .initializePolicy(false, true, new anchor.BN(0), false)
      .accountsPartial({
        authority: payer.publicKey,
        mint: mint.publicKey,
        policyConfig: policyPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
    await program.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({
        payer: payer.publicKey,
        extraAccountMetaList: metaListPda,
        mint: mint.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
    const tx = new Transaction();
    for (const owner of [alice, bob, mallory, dave]) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ataOf(owner.publicKey),
          owner.publicKey,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    tx.add(createMintToInstruction(mint.publicKey, ataOf(alice.publicKey), payer.publicKey, 1000, [], TOKEN_2022_PROGRAM_ID));
    await sendAndConfirmTransaction(connection, tx, [payer], CONFIRM);
  });

  describe("blocklist and delegates", () => {
    it("refuses a transfer that a blocklisted delegate makes from a clean account", async () => {
      await program.methods
        .addToBlocklist()
        .accountsPartial({ ...listAccounts(payer.publicKey, mallory.publicKey), blockEntry: blockEntry(mallory.publicKey) })
        .rpc(CONFIRM);
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          createApproveCheckedInstruction(ataOf(alice.publicKey), mint.publicKey, mallory.publicKey, alice.publicKey, 500, 0, [], TOKEN_2022_PROGRAM_ID)
        ),
        [payer, alice],
        CONFIRM
      );

      const logs = await expectError(() => transfer(alice.publicKey, bob.publicKey, mallory, 100n), "AuthorityBlocked");
      const refused = [...events.parseLogs(logs)].find((e) => e.name === "transferRefused");
      assert.ok(refused, "no TransferRefused event in the failed transaction's logs");
      assert.equal(refused!.data.errorCode, 6006);
      assert.ok((refused!.data.transferAuthority as PublicKey).equals(mallory.publicKey));
      assert.ok((refused!.data.sourceOwner as PublicKey).equals(alice.publicKey));
      assert.ok((refused!.data.destinationOwner as PublicKey).equals(bob.publicKey));
      assert.equal(await balanceOf(bob.publicKey), 0n);
    });

    it("still lets a clean delegate move the tokens", async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          createApproveCheckedInstruction(ataOf(alice.publicKey), mint.publicKey, dave.publicKey, alice.publicKey, 500, 0, [], TOKEN_2022_PROGRAM_ID)
        ),
        [payer, alice],
        CONFIRM
      );
      await transfer(alice.publicKey, bob.publicKey, dave, 100n);
      assert.equal(await balanceOf(bob.publicKey), 100n);
    });

    it("does not apply the blocklist when the policy turns it off", async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          createApproveCheckedInstruction(ataOf(alice.publicKey), mint.publicKey, mallory.publicKey, alice.publicKey, 500, 0, [], TOKEN_2022_PROGRAM_ID)
        ),
        [payer, alice],
        CONFIRM
      );
      await updatePolicy(payer, false, false);
      await transfer(alice.publicKey, bob.publicKey, mallory, 10n);
      assert.equal(await balanceOf(bob.publicKey), 110n);
      await updatePolicy(payer, false, true);
    });
  });

  describe("meta list", () => {
    it("lets only the policy authority rewrite the meta list", async () => {
      await expectError(
        () =>
          program.methods
            .updateExtraAccountMetaList()
            .accountsPartial({
              authority: stranger.publicKey,
              mint: mint.publicKey,
              policyConfig: policyPda,
              extraAccountMetaList: metaListPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([stranger])
            .rpc(CONFIRM),
        "Unauthorized"
      );
    });

    it("rewrites a current list in place, and transfers keep working", async () => {
      const before = (await connection.getAccountInfo(metaListPda))!.data.length;
      const sig = await program.methods
        .updateExtraAccountMetaList()
        .accountsPartial({
          authority: payer.publicKey,
          mint: mint.publicKey,
          policyConfig: policyPda,
          extraAccountMetaList: metaListPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc(CONFIRM);
      assert.equal((await connection.getAccountInfo(metaListPda))!.data.length, before);
      const updated = (await eventsOf(sig)).find((e) => e.name === "metaListUpdated");
      assert.equal(updated?.data.entries, 5);
      await transfer(alice.publicKey, bob.publicKey, alice, 1n);
    });
  });

  describe("events", () => {
    it("emits PolicyUpdated with the new rules", async () => {
      const sig = await updatePolicy(payer, true, true);
      const e = (await eventsOf(sig)).find((x) => x.name === "policyUpdated");
      assert.ok(e, "no PolicyUpdated event");
      assert.isTrue(e!.data.allowlistEnabled);
      assert.isTrue(e!.data.blocklistEnabled);
      assert.ok((e!.data.authority as PublicKey).equals(payer.publicKey));
      await updatePolicy(payer, false, true);
    });

    it("emits ListEntryAdded and ListEntryRemoved", async () => {
      const added = await program.methods
        .addToAllowlist()
        .accountsPartial({ ...listAccounts(payer.publicKey, bob.publicKey), allowEntry: allowEntry(bob.publicKey) })
        .rpc(CONFIRM);
      const a = (await eventsOf(added)).find((x) => x.name === "listEntryAdded");
      assert.ok((a!.data.wallet as PublicKey).equals(bob.publicKey));
      assert.deepEqual(a!.data.list, { allow: {} });

      const removed = await program.methods
        .removeFromBlocklist()
        .accountsPartial({ ...listAccounts(payer.publicKey, mallory.publicKey), blockEntry: blockEntry(mallory.publicKey) })
        .rpc(CONFIRM);
      const r = (await eventsOf(removed)).find((x) => x.name === "listEntryRemoved");
      assert.ok((r!.data.wallet as PublicKey).equals(mallory.publicKey));
      assert.deepEqual(r!.data.list, { block: {} });
    });
  });

  describe("fails closed", () => {
    // A second mint whose hook is Vigilantis but which has no policy yet.
    const bare = Keypair.generate();
    const bareAta = (owner: PublicKey) =>
      getAssociatedTokenAddressSync(bare.publicKey, owner, true, TOKEN_2022_PROGRAM_ID);

    before(async () => {
      const mintLen = getMintLen([ExtensionType.TransferHook]);
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: bare.publicKey,
            space: mintLen,
            lamports: await connection.getMinimumBalanceForRentExemption(mintLen),
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          createInitializeTransferHookInstruction(bare.publicKey, payer.publicKey, program.programId, TOKEN_2022_PROGRAM_ID),
          createInitializeMintInstruction(bare.publicKey, 0, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
          createAssociatedTokenAccountInstruction(payer.publicKey, bareAta(alice.publicKey), alice.publicKey, bare.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
          createAssociatedTokenAccountInstruction(payer.publicKey, bareAta(bob.publicKey), bob.publicKey, bare.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
          createMintToInstruction(bare.publicKey, bareAta(alice.publicKey), payer.publicKey, 10, [], TOKEN_2022_PROGRAM_ID)
        ),
        [payer, bare],
        CONFIRM
      );
    });

    it("refuses meta-list setup by anyone but the mint authority", async () => {
      await expectError(
        () =>
          program.methods
            .initializeExtraAccountMetaList()
            .accountsPartial({
              payer: stranger.publicKey,
              extraAccountMetaList: pda([Buffer.from("extra-account-metas"), bare.publicKey.toBuffer()]),
              mint: bare.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([stranger])
            .rpc(CONFIRM),
        "Unauthorized"
      );
    });

    it("refuses every transfer of a mint whose policy does not exist yet", async () => {
      await program.methods
        .initializeExtraAccountMetaList()
        .accountsPartial({
          payer: payer.publicKey,
          extraAccountMetaList: pda([Buffer.from("extra-account-metas"), bare.publicKey.toBuffer()]),
          mint: bare.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc(CONFIRM);
      const ix = await createTransferCheckedWithTransferHookInstruction(
        connection,
        bareAta(alice.publicKey),
        bare.publicKey,
        bareAta(bob.publicKey),
        alice.publicKey,
        1n,
        0,
        [],
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      );
      await expectError(
        () => sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer, alice], CONFIRM),
        "AccountNotInitialized"
      );
    });
  });

  describe("two-step authority handover", () => {
    const propose = (signer: Keypair, to: PublicKey) =>
      program.methods
        .proposeAuthority(to)
        .accountsPartial({
          authority: signer.publicKey,
          mint: mint.publicKey,
          policyConfig: policyPda,
          pendingAuthority: pendingPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([signer])
        .rpc(CONFIRM);
    const accept = (signer: Keypair) =>
      program.methods
        .acceptAuthority()
        .accountsPartial({
          newAuthority: signer.publicKey,
          previousAuthority: payer.publicKey,
          mint: mint.publicKey,
          policyConfig: policyPda,
          pendingAuthority: pendingPda,
        })
        .signers([signer])
        .rpc(CONFIRM);
    const cancel = () =>
      program.methods
        .cancelAuthorityTransfer()
        .accountsPartial({
          authority: payer.publicKey,
          mint: mint.publicKey,
          policyConfig: policyPda,
          pendingAuthority: pendingPda,
        })
        .rpc(CONFIRM);
    const authorityOf = async () => (await program.account.policyConfig.fetch(policyPda)).authority;

    it("refuses a proposal to the current authority or to the default address", async () => {
      await expectError(() => propose(payer, payer.publicKey), "InvalidAuthority");
      await expectError(() => propose(payer, PublicKey.default), "InvalidAuthority");
    });

    it("refuses a proposal from anyone but the authority", async () => {
      await expectError(() => propose(stranger, stranger.publicKey), "Unauthorized");
    });

    it("changes nothing until the new authority accepts", async () => {
      const sig = await propose(payer, newAuthority.publicKey);
      const e = (await eventsOf(sig)).find((x) => x.name === "authorityTransferProposed");
      assert.ok((e!.data.newAuthority as PublicKey).equals(newAuthority.publicKey));
      assert.ok((await authorityOf()).equals(payer.publicKey));
      await expectError(() => updatePolicy(newAuthority, true, true), "Unauthorized");
    });

    it("refuses an accept signed by anyone but the proposed authority", async () => {
      await expectError(() => accept(stranger), "Unauthorized");
    });

    it("can be cancelled, after which the proposal cannot be accepted", async () => {
      const sig = await cancel();
      assert.ok((await eventsOf(sig)).some((x) => x.name === "authorityTransferCancelled"));
      assert.isNull(await connection.getAccountInfo(pendingPda));
      await expectError(() => accept(newAuthority), "AccountNotInitialized");
    });

    it("hands the policy over when the proposed authority accepts", async () => {
      await propose(payer, newAuthority.publicKey);
      const sig = await accept(newAuthority);
      const e = (await eventsOf(sig)).find((x) => x.name === "authorityTransferred");
      assert.ok((e!.data.previousAuthority as PublicKey).equals(payer.publicKey));
      assert.ok((e!.data.newAuthority as PublicKey).equals(newAuthority.publicKey));
      assert.ok((await authorityOf()).equals(newAuthority.publicKey));
      assert.isNull(await connection.getAccountInfo(pendingPda), "the proposal account should be closed");

      await expectError(() => updatePolicy(payer, true, true), "Unauthorized");
      await updatePolicy(newAuthority, false, true);
      await program.methods
        .addToBlocklist()
        .accountsPartial({ ...listAccounts(newAuthority.publicKey, stranger.publicKey), blockEntry: blockEntry(stranger.publicKey) })
        .signers([newAuthority])
        .rpc(CONFIRM);
    });
  });
});
