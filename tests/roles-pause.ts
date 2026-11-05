// SPDX-License-Identifier: BUSL-1.1
//
// Vigilantis 1.0: roles, pause and the first half of seizure and forfeiture, through the SDK on a
// local validator. Both need the clock 24 hours ahead, which a validator cannot do, so their success
// paths are tested in LiteSVM (tests-fuzz/tests/enforcement.rs); here they must be refused as too
// early.
import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getPermanentDelegate,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assert } from "chai";
import {
  ENFORCEMENT_REASONS,
  PERMISSIONS,
  SEIZE_DELAY_SECONDS,
  VigilantisClient,
  amountCommitment,
  caseRef,
} from "../sdk/src";

const CONFIRM = { commitment: "confirmed" as const };
const SALT = "test-salt-not-for-production";

describe("vigilantis — roles, pause, seizure (SDK)", () => {
  const provider = anchor.AnchorProvider.env();
  const admin = new VigilantisClient(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const officer = Keypair.generate();
  const asOfficer = new VigilantisClient(new anchor.AnchorProvider(connection, new anchor.Wallet(officer), CONFIRM));
  const mint = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);
  const reason = (reasonCode: number, caseId: string) => ({ reasonCode, caseRef: caseRef(caseId, SALT) });

  async function failure(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (e) {
      const logs = e instanceof SendTransactionError ? ((await e.getLogs(connection)) ?? []) : [];
      return String(e) + "\n" + logs.join("\n");
    }
    assert.fail("expected the transaction to fail, but it went through");
  }

  const transfer = (amount: bigint) =>
    admin.transfer({ mint: mint.publicKey, amount, decimals: 0, owner: alice, destinationOwner: bob.publicKey });

  before(async () => {
    for (const k of [officer, alice]) {
      await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, LAMPORTS_PER_SOL), "confirmed");
    }
    await admin.createCompliantMint({
      mint,
      decimals: 0,
      freezeAuthority: "vigilantis",
      pausable: true,
      permanentDelegate: true,
    });
    await admin.initializePolicy({ mint: mint.publicKey, allowlist: false, blocklist: true, maxTransferAmount: 0 });
    await admin.initializeExtraAccountMetaList(mint.publicKey);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        ...[alice, bob].map((h) =>
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            ata(h.publicKey),
            h.publicKey,
            mint.publicKey,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        ),
        createMintToInstruction(mint.publicKey, ata(alice.publicKey), payer.publicKey, 1_000, [], TOKEN_2022_PROGRAM_ID),
      ),
      [payer],
      CONFIRM,
    );
  });

  it("creates the mint with Vigilantis as pause authority and permanent delegate", async () => {
    const info = await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.ok(getPermanentDelegate(info)?.delegate.equals(admin.permanentDelegate(mint.publicKey)));
    const pause = await admin.getPauseState(mint.publicKey);
    assert.deepEqual(pause, { authority: admin.pauseAuthority(mint.publicKey), paused: false });
  });

  it("grants a role and records it", async () => {
    assert.throws(() => admin.grantRoleInstruction({ mint: mint.publicKey, holder: officer.publicKey, permissions: 0 }));
    const signature = await admin.grantRole(mint.publicKey, officer.publicKey, PERMISSIONS.freeze | PERMISSIONS.pause);
    const role = await admin.getRole(mint.publicKey, officer.publicKey);
    assert.equal(role?.permissions, PERMISSIONS.freeze | PERMISSIONS.pause);
    const roles = await admin.listRoles(mint.publicKey);
    assert.deepEqual(roles.map((r) => r.holder.toBase58()), [officer.publicKey.toBase58()]);
    const changed = (await admin.getEvents(signature)).find((e) => e.name === "roleChanged");
    assert.equal(changed?.data.permissions, PERMISSIONS.freeze | PERMISSIONS.pause);
    assert.equal(changed?.data.previousPermissions, 0);
  });

  it("lets the officer freeze, and records when, but not thaw", async () => {
    const before = Math.floor(Date.now() / 1000);
    await asOfficer.freezeTokenAccount(mint.publicKey, ata(alice.publicKey), reason(ENFORCEMENT_REASONS.courtOrder, "CASE-9"));
    assert.isTrue(await admin.isFrozen(ata(alice.publicKey)));
    const record = await admin.getFreezeRecord(mint.publicKey, ata(alice.publicKey));
    assert.ok(record);
    assert.approximately(record!.frozenAt, before, 120);
    assert.equal(record!.seizableFrom, record!.frozenAt + SEIZE_DELAY_SECONDS);

    const error = await failure(() =>
      asOfficer.thawTokenAccount(mint.publicKey, ata(alice.publicKey), reason(ENFORCEMENT_REASONS.caseClosed, "CASE-9")),
    );
    assert.match(error, /Unauthorized/);
  });

  it("refuses a seizure before the 24 hours are up, and one without a case reference", async () => {
    const tooEarly = await failure(() =>
      admin.seize(mint.publicKey, ata(alice.publicKey), reason(ENFORCEMENT_REASONS.courtOrder, "CASE-9")),
    );
    assert.match(tooEarly, /SeizeTooEarly/);
    let threw = false;
    try {
      await admin.seizeInstruction({
        mint: mint.publicKey,
        tokenAccount: ata(alice.publicKey),
        enforcement: { reasonCode: 2, caseRef: new Uint8Array(32) },
      });
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "a zero case reference must be refused before sending");
    assert.isNull(await admin.getSeizure(mint.publicKey, ata(alice.publicKey), caseRef("CASE-9", SALT)));
  });

  it("refuses a forfeiture before the 24 hours are up, one without a case, and one by a role without SEIZE", async () => {
    const commitment = amountCommitment(1_000n, "amount-salt-not-for-production");
    const tooEarly = await failure(() =>
      admin.forfeit(mint.publicKey, ata(alice.publicKey), reason(ENFORCEMENT_REASONS.courtOrder, "CASE-9"), commitment),
    );
    assert.match(tooEarly, /SeizeTooEarly/);
    const noSeize = await failure(() =>
      asOfficer.forfeit(mint.publicKey, ata(alice.publicKey), reason(ENFORCEMENT_REASONS.courtOrder, "CASE-9")),
    );
    assert.match(noSeize, /Unauthorized/);
    let threw = false;
    try {
      await admin.forfeitInstruction({
        mint: mint.publicKey,
        tokenAccount: ata(alice.publicKey),
        enforcement: { reasonCode: 2, caseRef: new Uint8Array(32) },
      });
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "a zero case reference must be refused before sending");
    // An account Vigilantis never froze has no freeze record to wait from.
    const neverFrozen = await failure(() =>
      admin.forfeit(mint.publicKey, ata(bob.publicKey), reason(ENFORCEMENT_REASONS.courtOrder, "CASE-9")),
    );
    assert.match(neverFrozen, /AccountNotInitialized|3012/);
    assert.isNull(await admin.getForfeiture(mint.publicKey, ata(alice.publicKey)));
    assert.deepEqual(await admin.listForfeitures(mint.publicKey), []);
    assert.equal((await admin.forfeitedAmong(mint.publicKey, [ata(alice.publicKey), ata(bob.publicKey)])).size, 0);
    // Releasing what is not forfeited fails.
    assert.match(
      await failure(() => admin.releaseForfeiture(mint.publicKey, ata(alice.publicKey), ENFORCEMENT_REASONS.caseClosed)),
      /AccountNotInitialized|3012/,
    );
  });

  it("commits to an amount the same way every time, and differently for another amount or salt", () => {
    const a = amountCommitment(1_000n, "amount-salt-not-for-production");
    assert.equal(a.length, 32);
    assert.deepEqual(a, amountCommitment(1000, "amount-salt-not-for-production"));
    assert.notDeepEqual(a, amountCommitment(1_001n, "amount-salt-not-for-production"));
    assert.notDeepEqual(a, amountCommitment(1_000n, "another-amount-salt-for-tests"));
    assert.throws(() => amountCommitment(-1n, "amount-salt-not-for-production"));
    assert.throws(() => amountCommitment(1n << 64n, "amount-salt-not-for-production"));
  });

  it("thaws (admin) and deletes the freeze record", async () => {
    await admin.thawTokenAccount(mint.publicKey, ata(alice.publicKey), reason(ENFORCEMENT_REASONS.caseClosed, "CASE-9"));
    assert.isFalse(await admin.isFrozen(ata(alice.publicKey)));
    assert.isNull(await admin.getFreezeRecord(mint.publicKey, ata(alice.publicKey)));
  });

  it("lets the officer pause the token, which stops transfers; only the admin resumes", async () => {
    await asOfficer.pause(mint.publicKey, reason(ENFORCEMENT_REASONS.internalReview, "INCIDENT-1"));
    assert.isTrue((await admin.getPauseState(mint.publicKey))!.paused);
    assert.match(await failure(() => transfer(10n)), /0x43|paused/i);
    assert.match(
      await failure(() => asOfficer.resume(mint.publicKey, reason(ENFORCEMENT_REASONS.caseClosed, "INCIDENT-1"))),
      /Unauthorized/,
    );
    const resumed = await admin.resume(mint.publicKey, reason(ENFORCEMENT_REASONS.caseClosed, "INCIDENT-1"));
    const action = (await admin.getEvents(resumed)).find((e) => e.name === "enforcementAction");
    assert.deepEqual(action?.data.action, { resume: {} });
    await transfer(10n);
  });

  it("hands the pause authority away and back", async () => {
    const keeper = Keypair.generate();
    await admin.setPauseAuthority(mint.publicKey, keeper.publicKey, reason(0, "HANDOVER"));
    assert.ok((await admin.getPauseState(mint.publicKey))!.authority?.equals(keeper.publicKey));
    assert.match(
      await failure(() => admin.pause(mint.publicKey, reason(0, "x"))),
      /PauseAuthorityNotVigilantis/,
    );
    await admin.setVigilantisAsPauseAuthority(mint.publicKey, keeper);
    assert.ok((await admin.getPauseState(mint.publicKey))!.authority?.equals(admin.pauseAuthority(mint.publicKey)));
  });

  it("refuses to hand on or give up the pause authority while paused, or to give it to a Vigilantis address", async () => {
    await admin.pause(mint.publicKey, reason(ENFORCEMENT_REASONS.internalReview, "INCIDENT-2"));
    // Handed on or given up now, the token could stay paused for good.
    for (const target of [null, Keypair.generate().publicKey]) {
      assert.match(await failure(() => admin.setPauseAuthority(mint.publicKey, target, reason(0, "x"))), /PausedMintHandover/);
    }
    await admin.resume(mint.publicKey, reason(ENFORCEMENT_REASONS.caseClosed, "INCIDENT-2"));
    // The permanent-delegate address can never sign a pause. The SDK refuses it, and so does the program.
    const target = admin.permanentDelegate(mint.publicKey);
    assert.throws(
      () => admin.setPauseAuthorityInstruction({ mint: mint.publicKey, newPauseAuthority: target, enforcement: reason(0, "x") }),
      /newPauseAuthority/,
    );
    const raw = await admin.program.methods
      .setPauseAuthority(target, 0, Array.from(caseRef("x", SALT)))
      .accountsPartial({
        authority: payer.publicKey,
        mint: mint.publicKey,
        policyConfig: admin.policy(mint.publicKey),
        pauseAuthority: admin.pauseAuthority(mint.publicKey),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
    assert.match(
      await failure(() => sendAndConfirmTransaction(connection, new Transaction().add(raw), [payer], CONFIRM)),
      /InvalidAuthority/,
    );
    await transfer(1n);
  });

  it("lets the officer renounce the role, after which it can do nothing", async () => {
    await asOfficer.renounceRole(mint.publicKey, officer);
    assert.isNull(await admin.getRole(mint.publicKey, officer.publicKey));
    assert.match(
      await failure(() => asOfficer.freezeTokenAccount(mint.publicKey, ata(bob.publicKey), reason(0, "x"))),
      /Unauthorized/,
    );
  });
  it("ends every role when the policy changes hands; an update brings one back", async () => {
    const newAdmin = Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(newAdmin.publicKey, LAMPORTS_PER_SOL), "confirmed");
    const asNewAdmin = new VigilantisClient(new anchor.AnchorProvider(connection, new anchor.Wallet(newAdmin), CONFIRM));
    await admin.grantRole(mint.publicKey, officer.publicKey, PERMISSIONS.freeze);
    // The outgoing admin also gives itself every permission, as a stolen key would before a rotation.
    await admin.grantRole(mint.publicKey, payer.publicKey, PERMISSIONS.all);
    assert.isTrue((await admin.getRole(mint.publicKey, officer.publicKey))!.active);

    await admin.proposeAuthority(mint.publicKey, newAdmin.publicKey);
    await admin.acceptAuthority(mint.publicKey, newAdmin);
    assert.match(
      await failure(() => asOfficer.freezeTokenAccount(mint.publicKey, ata(bob.publicKey), reason(0, "x"))),
      /Unauthorized/,
    );
    assert.match(await failure(() => admin.pause(mint.publicKey, reason(0, "x"))), /Unauthorized/);
    const roles = await asNewAdmin.listRoles(mint.publicKey);
    assert.lengthOf(roles, 2);
    assert.isTrue(roles.every((r) => !r.active));

    await asNewAdmin.updateRole(mint.publicKey, officer.publicKey, PERMISSIONS.freeze);
    assert.isTrue((await asNewAdmin.getRole(mint.publicKey, officer.publicKey))!.active);
    await asOfficer.freezeTokenAccount(mint.publicKey, ata(bob.publicKey), reason(ENFORCEMENT_REASONS.fraud, "CASE-9"));
    assert.isTrue(await admin.isFrozen(ata(bob.publicKey)));
  });
});
