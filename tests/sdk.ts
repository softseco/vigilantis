// SPDX-License-Identifier: BUSL-1.1
//
// The @softseco/vigilantis SDK against the program: batch list updates, events, the authority
// handover and the meta-list update, through VigilantisClient.
import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createApproveCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, SendTransactionError, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { assert } from "chai";
import { MAX_LIST_UPDATES_PER_TX, VigilantisClient } from "../sdk/src";

describe("vigilantis — SDK", () => {
  const provider = anchor.AnchorProvider.env();
  const client = new VigilantisClient(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const mint = Keypair.generate();

  before(async () => {
    await client.createCompliantMint({ mint, decimals: 0 });
    await client.initializePolicy({ mint: mint.publicKey, allowlist: false, blocklist: true, maxTransferAmount: 0 });
    await client.initializeExtraAccountMetaList(mint.publicKey);
  });

  it("blocklists many wallets in batches", async () => {
    const wallets = Array.from({ length: 2 * MAX_LIST_UPDATES_PER_TX + 3 }, () => Keypair.generate().publicKey);
    const signatures = await client.addToBlocklistBatch(mint.publicKey, wallets);
    assert.equal(signatures.length, 3);
    for (const w of wallets) assert.isTrue(await client.isBlocklisted(mint.publicKey, w));

    const added = (await client.getEvents(signatures[0])).filter((e) => e.name === "listEntryAdded");
    assert.equal(added.length, MAX_LIST_UPDATES_PER_TX);

    await client.removeFromBlocklistBatch(mint.publicKey, wallets.slice(0, 5));
    assert.isFalse(await client.isBlocklisted(mint.publicKey, wallets[0]));
    assert.isTrue(await client.isBlocklisted(mint.publicKey, wallets[5]));
  });

  it("decodes the TransferRefused event of a refused transfer", async () => {
    const holder = Keypair.generate();
    const delegate = Keypair.generate();
    const recipient = Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(delegate.publicKey, LAMPORTS_PER_SOL), "confirmed");
    const ata = (owner: Keypair) =>
      getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const createAta = (owner: Keypair) =>
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata(owner),
        owner.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createAta(holder),
        createAta(recipient),
        createMintToInstruction(mint.publicKey, ata(holder), payer.publicKey, 100, [], TOKEN_2022_PROGRAM_ID),
        createApproveCheckedInstruction(ata(holder), mint.publicKey, delegate.publicKey, holder.publicKey, 100, 0, [], TOKEN_2022_PROGRAM_ID)
      ),
      [payer, holder],
      { commitment: "confirmed" }
    );
    await client.addToBlocklist(mint.publicKey, delegate.publicKey);

    try {
      await client.transfer({ mint: mint.publicKey, amount: 10n, decimals: 0, destinationOwner: recipient.publicKey, owner: delegate, source: ata(holder) });
      assert.fail("a blocklisted delegate moved tokens");
    } catch (e) {
      assert.instanceOf(e, SendTransactionError);
      const events = client.parseEvents((await (e as SendTransactionError).getLogs(connection)) ?? []);
      const refused = events.find((x) => x.name === "transferRefused");
      assert.ok(refused, "no TransferRefused event");
      assert.equal(refused!.data.errorCode, 6006);
    }
  });

  it("hands the policy authority over in two steps", async () => {
    const next = Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(next.publicKey, LAMPORTS_PER_SOL), "confirmed");

    await client.proposeAuthority(mint.publicKey, next.publicKey);
    assert.ok((await client.getPendingAuthority(mint.publicKey))!.equals(next.publicKey));
    await client.cancelAuthorityTransfer(mint.publicKey);
    assert.isNull(await client.getPendingAuthority(mint.publicKey));

    await client.proposeAuthority(mint.publicKey, next.publicKey);
    await client.acceptAuthority(mint.publicKey, next);
    assert.ok((await client.getPolicy(mint.publicKey))!.authority.equals(next.publicKey));

    // The new authority works through the instruction builders, as a multisig would.
    const ix = await client.updatePolicyInstruction({
      mint: mint.publicKey,
      allowlist: false,
      blocklist: false,
      maxTransferAmount: 0,
      authority: next.publicKey,
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer, next], { commitment: "confirmed" });
    assert.isFalse((await client.getPolicy(mint.publicKey))!.blocklistEnabled);
  });
});
