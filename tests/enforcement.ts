// SPDX-License-Identifier: BUSL-1.1
//
// Vigilantis 2.2: blocking with a recorded reason, and freezing and thawing token accounts through
// Vigilantis's freeze-authority address. A hook can only refuse transfers; a frozen account refuses
// everything. Vigilantis 2.3: handing the freeze authority on, or giving it up, also with a reason.
import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createApproveCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  createBurnCheckedInstruction,
  createFreezeAccountInstruction,
  createInitializeAccount3Instruction,
  createMintToInstruction,
  createInitializeImmutableOwnerInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  getAccountLen,
  getAssociatedTokenAddressSync,
  getAccount,
  getDefaultAccountState,
  getMint,
  AccountState,
  ExtensionType,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { ENFORCEMENT_REASONS, VigilantisClient, caseRef, newCaseRef } from "../sdk/src";

const CONFIRM = { commitment: "confirmed" as const };
const SALT = "test-salt-not-for-production";

describe("vigilantis — enforcement: reasons, freeze and thaw", () => {
  const provider = anchor.AnchorProvider.env();
  const client = new VigilantisClient(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const mint = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const mallory = Keypair.generate();
  const stranger = Keypair.generate();
  const aliceSecond = Keypair.generate(); // a second token account of Alice's, not an ATA (but with ImmutableOwner)

  const ata = (owner: PublicKey, m: PublicKey = mint.publicKey) =>
    getAssociatedTokenAddressSync(m, owner, false, TOKEN_2022_PROGRAM_ID);
  const reason = (reasonCode: number, caseId: string) => ({ reasonCode, caseRef: caseRef(caseId, SALT) });

  /** The error text of a failed transaction, including its logs. */
  async function failure(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (e) {
      const logs = e instanceof SendTransactionError ? ((await e.getLogs(connection)) ?? []) : [];
      return String(e) + "\n" + logs.join("\n");
    }
    assert.fail("expected the transaction to fail, but it went through");
  }

  const send = (ixs: TransactionInstruction[], signers: Keypair[] = []) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [payer, ...signers], CONFIRM);

  const transfer = (from: Keypair, to: PublicKey, amount: bigint, source?: PublicKey) =>
    client.transfer({ mint: mint.publicKey, amount, decimals: 0, owner: from, destinationOwner: to, source });

  /** A mint with Vigilantis as hook, a blocklist policy, the meta list, and these holders. */
  async function setUpMint(
    m: Keypair,
    freezeAuthority: PublicKey | "vigilantis" | null,
    holders: Keypair[],
  ): Promise<void> {
    await client.createCompliantMint({ mint: m, decimals: 0, freezeAuthority });
    await client.initializePolicy({ mint: m.publicKey, allowlist: false, blocklist: true, maxTransferAmount: 0 });
    await client.initializeExtraAccountMetaList(m.publicKey);
    await send(
      holders.flatMap((h) => [
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ata(h.publicKey, m.publicKey),
          h.publicKey,
          m.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createMintToInstruction(m.publicKey, ata(h.publicKey, m.publicKey), payer.publicKey, 100, [], TOKEN_2022_PROGRAM_ID),
      ]),
    );
  }

  before(async () => {
    for (const k of [alice, stranger]) {
      await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, LAMPORTS_PER_SOL), "confirmed");
    }
    await setUpMint(mint, "vigilantis", [alice, bob, mallory]);
    // Alice's second account of the same mint. Vigilantis moves tokens only between accounts whose
    // owner cannot change, so it carries ImmutableOwner, as every associated token account does.
    const len = getAccountLen([ExtensionType.TransferHookAccount, ExtensionType.ImmutableOwner]);
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: aliceSecond.publicKey,
          space: len,
          lamports: await connection.getMinimumBalanceForRentExemption(len),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeImmutableOwnerInstruction(aliceSecond.publicKey, TOKEN_2022_PROGRAM_ID),
        createInitializeAccount3Instruction(aliceSecond.publicKey, mint.publicKey, alice.publicKey, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(mint.publicKey, aliceSecond.publicKey, payer.publicKey, 50, [], TOKEN_2022_PROGRAM_ID),
      ],
      [aliceSecond],
    );
  });

  it("names Vigilantis's freeze-authority address as the mint's freeze authority", async () => {
    const info = await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.ok(info.freezeAuthority?.equals(client.freezeAuthority(mint.publicKey)));
  });

  it("records why a wallet was blocked and unblocked", async () => {
    const blocked = await client.blockWallet(mint.publicKey, mallory.publicKey, reason(ENFORCEMENT_REASONS.sanctions, "CASE-1"));
    assert.isTrue(await client.isBlocklisted(mint.publicKey, mallory.publicKey));
    const events = await client.getEvents(blocked);
    assert.deepEqual(
      events.map((e) => e.name),
      ["listEntryAdded", "enforcementAction"],
    );
    const action = events[1].data;
    assert.deepEqual(action.action, { block: {} });
    assert.equal(action.reasonCode, ENFORCEMENT_REASONS.sanctions);
    assert.deepEqual(Array.from(action.caseRef as number[]), Array.from(caseRef("CASE-1", SALT)));
    assert.ok((action.wallet as PublicKey).equals(mallory.publicKey));
    assert.ok((action.tokenAccount as PublicKey).equals(PublicKey.default));
    assert.ok((action.authority as PublicKey).equals(payer.publicKey));

    // The blocklist works as before: Mallory cannot receive.
    assert.match(await failure(() => transfer(alice, mallory.publicKey, 1n)), /RecipientBlocked/);

    const unblocked = await client.unblockWallet(mint.publicKey, mallory.publicKey, reason(ENFORCEMENT_REASONS.caseClosed, "CASE-1"));
    assert.isFalse(await client.isBlocklisted(mint.publicKey, mallory.publicKey));
    const after = (await client.getEvents(unblocked)).find((e) => e.name === "enforcementAction");
    assert.deepEqual(after?.data.action, { unblock: {} });
    assert.equal(after?.data.reasonCode, ENFORCEMENT_REASONS.caseClosed);
  });

  it("freezes every token account of a wallet in one call", async () => {
    const signatures = await client.freezeWallet(mint.publicKey, alice.publicKey, reason(ENFORCEMENT_REASONS.courtOrder, "CASE-2"));
    assert.equal(signatures.length, 1);
    assert.isTrue(await client.isFrozen(ata(alice.publicKey)));
    assert.isTrue(await client.isFrozen(aliceSecond.publicKey));

    const actions = (await client.getEvents(signatures[0])).filter((e) => e.name === "enforcementAction");
    assert.equal(actions.length, 2);
    const frozen = actions.map((a) => (a.data.tokenAccount as PublicKey).toBase58()).sort();
    assert.deepEqual(frozen, [ata(alice.publicKey), aliceSecond.publicKey].map((k) => k.toBase58()).sort());
    for (const a of actions) {
      assert.deepEqual(a.data.action, { freeze: {} });
      assert.ok((a.data.wallet as PublicKey).equals(alice.publicKey));
      assert.equal(a.data.reasonCode, ENFORCEMENT_REASONS.courtOrder);
    }
  });

  it("stops everything on a frozen account: sending, receiving, burning, approving", async () => {
    const frozenError = /0x11|frozen/i; // Token-2022 AccountFrozen
    assert.match(await failure(() => transfer(alice, bob.publicKey, 1n)), frozenError);
    assert.match(await failure(() => transfer(alice, bob.publicKey, 1n, aliceSecond.publicKey)), frozenError);
    assert.match(await failure(() => transfer(bob, alice.publicKey, 1n)), frozenError);
    assert.match(
      await failure(() =>
        send([createBurnCheckedInstruction(ata(alice.publicKey), mint.publicKey, alice.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [alice]),
      ),
      frozenError,
    );
    assert.match(
      await failure(() =>
        send(
          [createApproveCheckedInstruction(ata(alice.publicKey), mint.publicKey, mallory.publicKey, alice.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)],
          [alice],
        ),
      ),
      frozenError,
    );
  });

  it("lets only the policy authority freeze and thaw", async () => {
    const thawByStranger = await client.freezeInstruction({
      mint: mint.publicKey,
      tokenAccount: ata(alice.publicKey),
      enforcement: reason(0, "x"),
      thaw: true,
      authority: stranger.publicKey,
    });
    assert.match(await failure(() => send([thawByStranger], [stranger])), /Unauthorized/);
    const freezeByStranger = await client.freezeInstruction({
      mint: mint.publicKey,
      tokenAccount: ata(bob.publicKey),
      enforcement: reason(0, "x"),
      authority: stranger.publicKey,
    });
    assert.match(await failure(() => send([freezeByStranger], [stranger])), /Unauthorized/);
    assert.isFalse(await client.isFrozen(ata(bob.publicKey)));
  });

  it("refuses to freeze a frozen account or thaw a live one", async () => {
    assert.match(
      await failure(() => client.freezeTokenAccount(mint.publicKey, ata(alice.publicKey), reason(0, "x"))),
      /0xd|invalid state/i, // Token-2022 InvalidState
    );
    assert.match(
      await failure(() => client.thawTokenAccount(mint.publicKey, ata(bob.publicKey), reason(0, "x"))),
      /0xd|invalid state/i,
    );
  });

  it("thaws the wallet, and its tokens move again", async () => {
    const signatures = await client.thawWallet(mint.publicKey, alice.publicKey, reason(ENFORCEMENT_REASONS.caseClosed, "CASE-2"));
    assert.equal(signatures.length, 1);
    assert.isFalse(await client.isFrozen(ata(alice.publicKey)));
    assert.isFalse(await client.isFrozen(aliceSecond.publicKey));
    const actions = (await client.getEvents(signatures[0])).filter((e) => e.name === "enforcementAction");
    assert.equal(actions.length, 2);
    for (const a of actions) assert.deepEqual(a.data.action, { thaw: {} });
    await transfer(alice, bob.publicKey, 5n);
    const accounts = await client.tokenAccountsOf(mint.publicKey, bob.publicKey);
    assert.equal(accounts[0].amount, 105n);
  });

  it("blocks and freezes a wallet in one transaction", async () => {
    const signatures = await client.blockAndFreezeWallet(mint.publicKey, mallory.publicKey, reason(ENFORCEMENT_REASONS.fraud, "CASE-3"));
    assert.equal(signatures.length, 1);
    assert.isTrue(await client.isBlocklisted(mint.publicKey, mallory.publicKey));
    assert.isTrue(await client.isFrozen(ata(mallory.publicKey)));
    const actions = (await client.getEvents(signatures[0])).filter((e) => e.name === "enforcementAction");
    assert.deepEqual(
      actions.map((a) => a.data.action),
      [{ block: {} }, { freeze: {} }],
    );
  });

  it("blocks and freezes a wallet with nine token accounts, as many to a transaction as fit", async () => {
    // Anyone can open empty token accounts for a wallet. Eight freezes are over the 1,232-byte limit,
    // so the SDK packs by size.
    const target = Keypair.generate();
    const extra = Array.from({ length: 8 }, () => Keypair.generate());
    const len = getAccountLen([ExtensionType.TransferHookAccount, ExtensionType.ImmutableOwner]);
    const rent = await connection.getMinimumBalanceForRentExemption(len);
    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, ata(target.publicKey), target.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    ]);
    for (let i = 0; i < extra.length; i += 4) {
      const batch = extra.slice(i, i + 4);
      await send(
        batch.flatMap((k) => [
          SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: k.publicKey, space: len, lamports: rent, programId: TOKEN_2022_PROGRAM_ID }),
          createInitializeImmutableOwnerInstruction(k.publicKey, TOKEN_2022_PROGRAM_ID),
          createInitializeAccount3Instruction(k.publicKey, mint.publicKey, target.publicKey, TOKEN_2022_PROGRAM_ID),
        ]),
        batch,
      );
    }
    const signatures = await client.blockAndFreezeWallet(mint.publicKey, target.publicKey, reason(ENFORCEMENT_REASONS.fraud, "CASE-8"));
    assert.isAtLeast(signatures.length, 2);
    assert.isTrue(await client.isBlocklisted(mint.publicKey, target.publicKey));
    const accounts = await client.tokenAccountsOf(mint.publicKey, target.publicKey);
    assert.lengthOf(accounts, 9);
    assert.isTrue(accounts.every((a) => a.frozen));
    const thawed = await client.thawWallet(mint.publicKey, target.publicKey, reason(ENFORCEMENT_REASONS.caseClosed, "CASE-8"));
    assert.isAtLeast(thawed.length, 2);
    assert.isTrue((await client.tokenAccountsOf(mint.publicKey, target.publicKey)).every((a) => !a.frozen));
  });

  it("refuses transfers to or from a token account whose owner can change", async () => {
    // A plain token account without ImmutableOwner. Its owner could hand the whole account, with its
    // balance, to someone the rules refuse (SetAuthority does not call the hook), so Vigilantis
    // refuses every transfer that touches it.
    const plain = Keypair.generate();
    const len = getAccountLen([ExtensionType.TransferHookAccount]);
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: plain.publicKey,
          space: len,
          lamports: await connection.getMinimumBalanceForRentExemption(len),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeAccount3Instruction(plain.publicKey, mint.publicKey, bob.publicKey, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(mint.publicKey, plain.publicKey, payer.publicKey, 40, [], TOKEN_2022_PROGRAM_ID),
      ],
      [plain],
    );
    // Out of it, and into it.
    assert.match(await failure(() => transfer(bob, alice.publicKey, 1n, plain.publicKey)), /OwnerCanChange/);
    assert.match(
      await failure(() => client.transfer({ mint: mint.publicKey, amount: 1n, decimals: 0, owner: bob, destination: plain.publicKey })),
      /OwnerCanChange/,
    );
    // Handing the account to Mallory (blocked above) changes the owner, but not what it can do.
    await send([createSetAuthorityInstruction(plain.publicKey, bob.publicKey, AuthorityType.AccountOwner, mallory.publicKey, [], TOKEN_2022_PROGRAM_ID)], [bob]);
    assert.match(await failure(() => transfer(mallory, alice.publicKey, 1n, plain.publicKey)), /OwnerCanChange|AccountFrozen|SenderBlocked/);
  });

  it("refuses to freeze through Vigilantis when the mint's freeze authority is someone else, until it is handed over", async () => {
    const other = Keypair.generate();
    await setUpMint(other, payer.publicKey, [bob]);
    const error = await failure(() => client.freezeTokenAccount(other.publicKey, ata(bob.publicKey, other.publicKey), reason(0, "x")));
    assert.match(error, /FreezeAuthorityNotVigilantis/);

    await client.setVigilantisAsFreezeAuthority(other.publicKey, payer);
    await client.freezeTokenAccount(other.publicKey, ata(bob.publicKey, other.publicKey), reason(0, "x"));
    assert.isTrue(await client.isFrozen(ata(bob.publicKey, other.publicKey)));
  });

  it("refuses to freeze through Vigilantis on a mint without a freeze authority", async () => {
    const none = Keypair.generate();
    await setUpMint(none, null, [bob]);
    const error = await failure(() => client.freezeTokenAccount(none.publicKey, ata(bob.publicKey, none.publicKey), reason(0, "x")));
    assert.match(error, /FreezeAuthorityNotVigilantis/);
  });

  describe("handing the freeze authority on (2.3)", () => {
    it("lets only the policy authority hand it on", async () => {
      const m = Keypair.generate();
      await setUpMint(m, "vigilantis", [bob]);
      const byStranger = await client.setFreezeAuthorityInstruction({
        mint: m.publicKey,
        newFreezeAuthority: stranger.publicKey,
        enforcement: reason(0, "x"),
        authority: stranger.publicKey,
      });
      assert.match(await failure(() => send([byStranger], [stranger])), /Unauthorized/);
      assert.ok((await client.getFreezeAuthority(m.publicKey))?.equals(client.freezeAuthority(m.publicKey)));
    });

    it("hands it to another address with the reason recorded, and Vigilantis stops freezing until it comes back", async () => {
      const m = Keypair.generate();
      const successor = Keypair.generate();
      await setUpMint(m, "vigilantis", [bob]);
      const bobAccount = ata(bob.publicKey, m.publicKey);

      const signature = await client.setFreezeAuthority(
        m.publicKey,
        successor.publicKey,
        reason(ENFORCEMENT_REASONS.internalReview, "MIGRATION-1"),
      );
      assert.ok((await client.getFreezeAuthority(m.publicKey))?.equals(successor.publicKey));
      const events = await client.getEvents(signature);
      assert.deepEqual(events.map((e) => e.name), ["freezeAuthorityChanged"]);
      const changed = events[0].data;
      assert.ok((changed.mint as PublicKey).equals(m.publicKey));
      assert.ok((changed.newFreezeAuthority as PublicKey).equals(successor.publicKey));
      assert.equal(changed.reasonCode, ENFORCEMENT_REASONS.internalReview);
      assert.deepEqual(Array.from(changed.caseRef as number[]), Array.from(caseRef("MIGRATION-1", SALT)));
      assert.ok((changed.authority as PublicKey).equals(payer.publicKey));

      // Vigilantis no longer holds it; the new holder freezes through Token-2022 directly.
      assert.match(await failure(() => client.freezeTokenAccount(m.publicKey, bobAccount, reason(0, "x"))), /FreezeAuthorityNotVigilantis/);
      await send([createFreezeAccountInstruction(bobAccount, m.publicKey, successor.publicKey, [], TOKEN_2022_PROGRAM_ID)], [successor]);
      assert.isTrue(await client.isFrozen(bobAccount));

      // The new holder hands it back, and Vigilantis can thaw again.
      await client.setVigilantisAsFreezeAuthority(m.publicKey, successor);
      await client.thawTokenAccount(m.publicKey, bobAccount, reason(ENFORCEMENT_REASONS.caseClosed, "MIGRATION-1"));
      assert.isFalse(await client.isFrozen(bobAccount));
    });

    it("gives it up for good", async () => {
      const m = Keypair.generate();
      await setUpMint(m, "vigilantis", [bob]);
      const signature = await client.setFreezeAuthority(m.publicKey, null, reason(ENFORCEMENT_REASONS.unspecified, "RENOUNCE"));
      assert.isNull(await client.getFreezeAuthority(m.publicKey));
      const changed = (await client.getEvents(signature)).find((e) => e.name === "freezeAuthorityChanged");
      assert.isNull(changed?.data.newFreezeAuthority);

      assert.match(
        await failure(() => client.freezeTokenAccount(m.publicKey, ata(bob.publicKey, m.publicKey), reason(0, "x"))),
        /FreezeAuthorityNotVigilantis/,
      );
      // Nobody can bring it back: Token-2022 has no freeze authority left to sign.
      await failure(() => client.setVigilantisAsFreezeAuthority(m.publicKey, payer));
      assert.isNull(await client.getFreezeAuthority(m.publicKey));
    });

    it("refuses Vigilantis's own addresses and the default address, and mints Vigilantis does not hold", async () => {
      const m = Keypair.generate();
      await setUpMint(m, "vigilantis", [bob]);
      // The SDK refuses before sending; the program refuses as well (InvalidAuthority).
      const vigilantisAddresses = [
        client.freezeAuthority(m.publicKey),
        client.pauseAuthority(m.publicKey),
        client.permanentDelegate(m.publicKey),
        client.policy(m.publicKey),
      ];
      for (const target of [...vigilantisAddresses, PublicKey.default]) {
        let message = "";
        try {
          await client.setFreezeAuthorityInstruction({ mint: m.publicKey, newFreezeAuthority: target, enforcement: reason(0, "x") });
        } catch (e) {
          message = String(e);
        }
        assert.match(message, /newFreezeAuthority/);
        const raw = await client.program.methods
          .setFreezeAuthority(target, 0, Array.from(caseRef("x", SALT)))
          .accountsPartial({
            authority: payer.publicKey,
            mint: m.publicKey,
            policyConfig: client.policy(m.publicKey),
            freezeAuthority: client.freezeAuthority(m.publicKey),
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();
        assert.match(await failure(() => send([raw])), /InvalidAuthority/);
      }
      assert.ok((await client.getFreezeAuthority(m.publicKey))?.equals(client.freezeAuthority(m.publicKey)));

      const issuerHeld = Keypair.generate();
      await setUpMint(issuerHeld, payer.publicKey, [bob]);
      assert.match(
        await failure(() => client.setFreezeAuthority(issuerHeld.publicKey, stranger.publicKey, reason(0, "x"))),
        /FreezeAuthorityNotVigilantis/,
      );
    });
  });

  it("checks reason codes and case references before sending", async () => {
    let message = "";
    try {
      await client.blockWalletInstruction({ mint: mint.publicKey, wallet: bob.publicKey, enforcement: { reasonCode: 70_000, caseRef: new Uint8Array(32) } });
    } catch (e) {
      message = String(e);
    }
    assert.match(message, /reasonCode/);
    try {
      await client.blockWalletInstruction({ mint: mint.publicKey, wallet: bob.publicKey, enforcement: { reasonCode: 1, caseRef: new Uint8Array(31) } });
    } catch (e) {
      message = String(e);
    }
    assert.match(message, /32 bytes/);
  });

  it("keeps the default account state for later, or starts every new account frozen", async () => {
    const holder = (m: Keypair) => ata(alice.publicKey, m.publicKey);
    const openAccount = (m: Keypair) =>
      send([
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          holder(m),
          alice.publicKey,
          m.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      ]);

    // "initialized": the extension is there, and new accounts start usable, as without it.
    const later = Keypair.generate();
    await client.createCompliantMint({ mint: later, decimals: 6, freezeAuthority: "vigilantis", defaultAccountState: "initialized" });
    const laterInfo = await getMint(connection, later.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.equal(getDefaultAccountState(laterInfo)?.state, AccountState.Initialized);
    await openAccount(later);
    assert.isFalse((await getAccount(connection, holder(later), "confirmed", TOKEN_2022_PROGRAM_ID)).isFrozen);

    // "frozen": a new account starts frozen, and Vigilantis's thaw opens it, with no freeze record.
    const gated = Keypair.generate();
    await client.createCompliantMint({ mint: gated, decimals: 6, freezeAuthority: "vigilantis", defaultAccountState: "frozen" });
    await client.initializePolicy({ mint: gated.publicKey, allowlist: false, blocklist: true, maxTransferAmount: 0 });
    await client.initializeExtraAccountMetaList(gated.publicKey);
    await openAccount(gated);
    assert.isTrue((await getAccount(connection, holder(gated), "confirmed", TOKEN_2022_PROGRAM_ID)).isFrozen);
    await client.thawTokenAccount(gated.publicKey, holder(gated), { reasonCode: 0, caseRef: newCaseRef() });
    assert.isFalse((await getAccount(connection, holder(gated), "confirmed", TOKEN_2022_PROGRAM_ID)).isFrozen);

    // Without a freeze authority nothing could ever be thawed, so the SDK refuses before sending.
    let message = "";
    try {
      await client.createCompliantMint({ mint: Keypair.generate(), decimals: 6, defaultAccountState: "frozen" });
    } catch (e) {
      message = String(e);
    }
    assert.match(message, /needs a freeze authority/);
  });

  it("makes a new random case reference each time", () => {
    const [a, b] = [newCaseRef(), newCaseRef()];
    assert.lengthOf(a, 32);
    assert.notDeepEqual(Array.from(a), Array.from(b));
  });
});
