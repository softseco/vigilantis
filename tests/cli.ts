// SPDX-License-Identifier: BUSL-1.1
//
// The `vigilantis` command line (sdk/src/cli.ts) on a local validator. The tests call its `main`
// in-process with the arguments a user would type, then check the result on chain through the
// SDK. Export mode (`--multisig`) is checked by signing the printed transactions with the "vault"
// key and sending them: what a multisig would execute.
import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeAccount3Instruction,
  createInitializeImmutableOwnerInstruction,
  createMintToInstruction,
  getAccountLen,
  getAccountTypeOfMintType,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getMint,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { assert } from "chai";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { VigilantisClient, caseRef } from "../sdk/src";
import { main } from "../sdk/src/cli";

const CONFIRM = { commitment: "confirmed" as const };
const SALT = "cli-test-salt-not-for-production";

describe("vigilantis — command line", () => {
  const provider = anchor.AnchorProvider.env();
  const sdk = new VigilantisClient(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const url = connection.rpcEndpoint;

  const mint = Keypair.generate();
  const officer = Keypair.generate();
  const successor = Keypair.generate();
  const vault = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const carol = Keypair.generate();
  const aliceAta = getAssociatedTokenAddressSync(mint.publicKey, alice.publicKey, false, TOKEN_2022_PROGRAM_ID);
  let aliceSecond: PublicKey;

  // An empty HOME, so no Solana CLI config on the machine changes what the tests see.
  const home = mkdtempSync(join(tmpdir(), "vigilantis-cli-"));
  const keyFile = (name: string, k: Keypair) => {
    const path = join(home, `${name}.json`);
    writeFileSync(path, JSON.stringify(Array.from(k.secretKey)));
    return path;
  };
  const adminKey = keyFile("admin", payer);
  const officerKey = keyFile("officer", officer);
  const successorKey = keyFile("successor", successor);
  const M = mint.publicKey.toBase58();

  /** Run the CLI. `--url` is added; `--keypair` too unless `keypair` is null (export mode). */
  async function cli(args: string[], opts: { keypair?: string | null; env?: Record<string, string> } = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const keypair = opts.keypair === undefined ? adminKey : opts.keypair;
    const code = await main([...args, "--url", url, ...(keypair ? ["--keypair", keypair] : [])], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: { HOME: home, VIGILANTIS_CASE_SALT: SALT, ...opts.env },
    });
    return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) };
  }

  /** Run the CLI and expect it to succeed. */
  async function ok(args: string[], opts?: { keypair?: string | null; env?: Record<string, string> }) {
    const r = await cli(args, opts);
    assert.equal(r.code, 0, `vigilantis ${args.join(" ")} failed:\n${r.err}`);
    return r;
  }

  /** Sign the transactions export mode printed with the vault key and send them, in order. */
  async function executeAsVault(transactions: string[]) {
    for (const encoded of transactions) {
      const tx = Transaction.from(anchor.utils.bytes.bs58.decode(encoded));
      assert.isTrue(tx.feePayer!.equals(vault.publicKey));
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      await sendAndConfirmTransaction(connection, tx, [vault], CONFIRM);
    }
  }

  const isFrozen = (account: PublicKey) => sdk.isFrozen(account);

  before(async () => {
    for (const k of [officer, successor, vault, alice]) {
      await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, LAMPORTS_PER_SOL), "confirmed");
    }
    await sdk.createCompliantMint({ mint, decimals: 0, freezeAuthority: "vigilantis", pausable: true, permanentDelegate: true });
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          aliceAta,
          alice.publicKey,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createMintToInstruction(mint.publicKey, aliceAta, payer.publicKey, 100, [], TOKEN_2022_PROGRAM_ID),
      ),
      [payer],
      CONFIRM,
    );
    // A second account of the same mint, so "freeze a wallet" has more than one to freeze. Not an
    // ATA, but with ImmutableOwner: Vigilantis moves tokens only between accounts whose owner
    // cannot change.
    const second = Keypair.generate();
    const mintInfo = await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
    const len = getAccountLen([
      ...getExtensionTypes(mintInfo.tlvData).map(getAccountTypeOfMintType).filter((t) => t !== ExtensionType.Uninitialized),
      ExtensionType.ImmutableOwner,
    ]);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: second.publicKey,
          space: len,
          lamports: await connection.getMinimumBalanceForRentExemption(len),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeImmutableOwnerInstruction(second.publicKey, TOKEN_2022_PROGRAM_ID),
        createInitializeAccount3Instruction(second.publicKey, mint.publicKey, alice.publicKey, TOKEN_2022_PROGRAM_ID),
      ),
      [payer, second],
      CONFIRM,
    );
    aliceSecond = second.publicKey;
  });

  it("prints its help and version without an RPC", async () => {
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: () => undefined, env: { HOME: home } };
    assert.equal(await main(["--help"], io), 0);
    assert.match(out.join("\n"), /Usage: vigilantis <command>/);
    assert.equal(await main(["--version"], io), 0);
    assert.match(out[out.length - 1], /^\d+\.\d+\.\d+/);
  });

  it("refuses a command line it cannot run, with exit code 2", async () => {
    const cases: [string[], RegExp][] = [
      [["launch", M], /unknown command/],
      [["freeze", M, alice.publicKey.toBase58()], /--reason/],
      [["freeze", M, alice.publicKey.toBase58(), "--reason", "weather"], /unknown reason weather/],
      [["role", "list", M, "--reason", "fraud"], /--reason does not apply to `role list`/],
      [["policy", "update", M], /nothing to change/],
      [["policy", "show", "not-an-address"], /mint is not a valid address/],
      [["freeze-authority", "set", M, "none", "--reason", "fraud"], /--give-up/],
      [["seize", M, aliceAta.toBase58(), "--reason", "court-order"], /needs a case/],
      [["role", "grant", M, officer.publicKey.toBase58(), "--permissions", "freeze,fly"], /unknown permission fly/],
      [["policy", "init", M, "--multisig", vault.publicKey.toBase58()], /authority propose/],
    ];
    for (const [args, message] of cases) {
      const r = await cli(args);
      assert.equal(r.code, 2, `vigilantis ${args.join(" ")}`);
      assert.match(r.err, message);
    }
    const noSalt = await cli(["block", "add", M, bob.publicKey.toBase58(), "--reason", "fraud", "--case", "X"], {
      env: { VIGILANTIS_CASE_SALT: "" },
    });
    assert.equal(noSalt.code, 2);
    assert.match(noSalt.err, /VIGILANTIS_CASE_SALT/);
  });

  it("hashes a case ID with the salt, offline", async () => {
    const r = await ok(["case-ref", "CASE-1"]);
    assert.equal(r.out, Buffer.from(caseRef("CASE-1", SALT)).toString("hex"));
  });

  it("hashes a case the same way however the case ID and the salt are written", async () => {
    const expected = Buffer.from(caseRef("CASE-1", SALT)).toString("hex");
    const file = join(home, "salt.txt");
    writeFileSync(file, `\uFEFF${SALT}  \r\n\n`);
    assert.equal((await ok(["case-ref", " CASE-1 ", "--case-salt-file", file])).out, expected);
    assert.equal((await ok(["case-ref", "CASE-1"], { env: { VIGILANTIS_CASE_SALT: ` ${SALT}\n` } })).out, expected);
    // "é" written as one code point or as e + combining accent is the same case.
    assert.equal(
      (await ok(["case-ref", "AFFAIRE-\u00e9"])).out,
      (await ok(["case-ref", "AFFAIRE-e\u0301"])).out,
    );
    const empty = await cli(["case-ref", " "]);
    assert.equal(empty.code, 2);
    assert.match(empty.err, /empty/);
    const short = await cli(["case-ref", "CASE-1"], { env: { VIGILANTIS_CASE_SALT: "short" } });
    assert.match(short.err, /shorter than 16 bytes/);
  });

  it("does not quote a keypair file it cannot read", async () => {
    const file = join(home, "not-a-keypair.json");
    writeFileSync(file, "SECRETSECRETSECRET");
    const r = await cli(["allow", "add", M, bob.publicKey.toBase58()], { keypair: file });
    assert.equal(r.code, 2);
    assert.match(r.err, /not a JSON keypair file/);
    assert.notInclude(r.err, "SECRET");
  });

  it("creates the policy and the meta list, shows and updates the policy", async () => {
    await ok(["policy", "init", M, "--blocklist", "on"]);
    await ok(["meta-list", "init", M]);
    let policy = (await ok(["policy", "show", M, "--json"])).json();
    assert.include(policy, { allowlistEnabled: false, blocklistEnabled: true, maxTransferAmount: "0", allowConfidential: false });
    assert.equal(policy.authority, payer.publicKey.toBase58());

    await ok(["policy", "update", M, "--max-amount", "500"]);
    policy = (await ok(["policy", "show", M, "--json"])).json();
    assert.include(policy, { blocklistEnabled: true, maxTransferAmount: "500" }, "the settings not given stay as they were");
    await ok(["policy", "update", M, "--max-amount", "none"]);
  });

  it("refuses a token account where a wallet is expected", async () => {
    const r = await cli(["block", "add", M, aliceAta.toBase58()]);
    assert.equal(r.code, 1);
    assert.include(r.err, `is a token account, not a wallet; use its owner ${alice.publicKey.toBase58()}`);
    assert.isFalse(await sdk.isBlocklisted(mint.publicKey, aliceAta));
  });

  it("edits the lists, and records why a wallet was blocked", async () => {
    const [w1, w2] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    await ok(["allow", "add", M, w1.toBase58(), w2.toBase58()]);
    assert.isTrue(await sdk.isAllowlisted(mint.publicKey, w1));
    assert.isTrue(await sdk.isAllowlisted(mint.publicKey, w2));
    await ok(["allow", "remove", M, w2.toBase58()]);
    assert.isFalse(await sdk.isAllowlisted(mint.publicKey, w2));

    const r = await ok(["block", "add", M, bob.publicKey.toBase58(), "--reason", "sanctions", "--case", "CASE-1", "--json"]);
    assert.isTrue(await sdk.isBlocklisted(mint.publicKey, bob.publicKey));
    const events = await sdk.getEvents(r.json().signatures[0]);
    const action = events.find((e) => e.name === "enforcementAction");
    assert.exists(action);
    assert.equal(action!.data.reasonCode, 1);
    assert.deepEqual(Buffer.from(action!.data.caseRef as number[]), Buffer.from(caseRef("CASE-1", SALT)));

    const checked = (await ok(["check", M, bob.publicKey.toBase58(), "--json"])).json();
    assert.include(checked, { blocklisted: true, allowlisted: false });
  });

  it("freezes and thaws a wallet's token accounts, or one account", async () => {
    const A = alice.publicKey.toBase58();
    const r = await ok(["freeze", M, A, "--reason", "court-order", "--case", "CASE-2"]);
    assert.match(r.out, /freeze 2 token accounts of/);
    assert.isTrue(await isFrozen(aliceAta));
    assert.isTrue(await isFrozen(aliceSecond));
    const checked = (await ok(["check", M, A, "--json"])).json();
    assert.lengthOf(checked.tokenAccounts, 2);
    for (const a of checked.tokenAccounts) assert.exists(a.freezeRecord, "a freeze through Vigilantis writes a record");

    const again = await ok(["freeze", M, A, "--reason", "court-order"]);
    assert.match(again.out, /Nothing to freeze/);

    await ok(["thaw", M, aliceAta.toBase58(), "--reason", "case-closed"]);
    assert.isFalse(await isFrozen(aliceAta));
    assert.isTrue(await isFrozen(aliceSecond));
    await ok(["thaw", M, A, "--reason", "case-closed"]);
    assert.isFalse(await isFrozen(aliceSecond));
  });

  it("pauses and resumes the token, and shows it in the status", async () => {
    await ok(["pause", M, "--reason", "internal-review"]);
    assert.isTrue((await sdk.getPauseState(mint.publicKey))!.paused);
    const status = await ok(["status", M]);
    assert.match(status.out, /Pause\s+PAUSED \(authority: Vigilantis/);
    assert.match(status.out, /Freeze authority\s+Vigilantis/);
    assert.match(status.out, /Transfer hook\s+Vigilantis/);
    await ok(["resume", M, "--reason", "internal-review"]);
    assert.isFalse((await sdk.getPauseState(mint.publicKey))!.paused);
  });

  it("gives a role, lets its holder act within it and refuses the rest", async () => {
    const O = officer.publicKey.toBase58();
    await ok(["role", "grant", M, O, "--permissions", "freeze,thaw"]);
    const roles = (await ok(["role", "list", M, "--json"])).json();
    assert.deepEqual(roles.map((r: { holder: string; permissionNames: string[] }) => [r.holder, r.permissionNames]), [[O, ["freeze", "thaw"]]]);

    await ok(["freeze", M, aliceAta.toBase58(), "--reason", "fraud", "--case", "CASE-3"], { keypair: officerKey });
    assert.isTrue(await isFrozen(aliceAta));

    const refused = await cli(["pause", M, "--reason", "fraud"], { keypair: officerKey });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /Unauthorized \(6004\)/);

    await ok(["role", "update", M, O, "--permissions", "thaw"]);
    await ok(["thaw", M, aliceAta.toBase58(), "--reason", "case-closed"], { keypair: officerKey });
    await ok(["role", "revoke", M, O]);
    assert.isNull(await sdk.getRole(mint.publicKey, officer.publicKey));
  });

  it("refuses a seizure before the 24 hours have passed", async () => {
    await ok(["freeze", M, aliceAta.toBase58(), "--reason", "court-order", "--case", "CASE-4"]);
    const r = await cli(["seize", M, aliceAta.toBase58(), "--reason", "court-order", "--case", "CASE-4"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /SeizeTooEarly/);
    assert.equal((await ok(["seizure", "list", M])).out, "No open seizures.");
    await ok(["thaw", M, aliceAta.toBase58(), "--reason", "case-closed"]);
  });

  it("hands the freeze authority out and back to Vigilantis", async () => {
    await ok(["freeze-authority", "set", M, payer.publicKey.toBase58(), "--reason", "internal-review"]);
    assert.isTrue((await sdk.getFreezeAuthority(mint.publicKey))!.equals(payer.publicKey));
    await ok(["freeze-authority", "to-vigilantis", M]);
    assert.isTrue((await sdk.getFreezeAuthority(mint.publicKey))!.equals(sdk.freezeAuthority(mint.publicKey)));
  });

  it("hands the policy over in two steps", async () => {
    const S = successor.publicKey.toBase58();
    await ok(["authority", "propose", M, S]);
    await ok(["authority", "cancel", M]);
    assert.isNull(await sdk.getPendingAuthority(mint.publicKey));

    await ok(["authority", "propose", M, S]);
    const wrong = await cli(["authority", "accept", M], { keypair: officerKey });
    assert.equal(wrong.code, 2);
    assert.match(wrong.err, /waits for/);
    await ok(["authority", "accept", M], { keypair: successorKey });
    assert.isTrue((await sdk.getPolicy(mint.publicKey))!.authority.equals(successor.publicKey));
  });

  it("prints transactions for a multisig instead of sending them", async () => {
    const V = vault.publicKey.toBase58();
    await ok(["authority", "propose", M, V], { keypair: successorKey });

    // Export mode needs no keypair: the vault accepts the policy and then blocks a wallet.
    const accept = (await ok(["authority", "accept", M, "--multisig", V, "--json"], { keypair: null })).json();
    assert.equal(accept.multisig, V);
    assert.lengthOf(accept.transactions, 1);
    assert.isTrue((await sdk.getPendingAuthority(mint.publicKey))!.equals(vault.publicKey), "nothing was sent yet");
    await executeAsVault(accept.transactions);
    assert.isTrue((await sdk.getPolicy(mint.publicKey))!.authority.equals(vault.publicKey));

    const wallets = Array.from({ length: 10 }, () => Keypair.generate().publicKey.toBase58());
    const block = (await ok(["block", "add", M, ...wallets, "--multisig", V, "--json"], { keypair: null })).json();
    assert.isAbove(block.transactions.length, 1, "ten list changes do not fit one multisig transaction");
    for (const tx of block.transactions) assert.isAtMost(anchor.utils.bytes.bs58.decode(tx).length, 900);
    await executeAsVault(block.transactions);
    for (const w of wallets) assert.isTrue(await sdk.isBlocklisted(mint.publicKey, new PublicKey(w)));

    const text = await ok(["pause", M, "--reason", "fraud", "--multisig", V], { keypair: null });
    assert.match(text.out, /Import base58 encoded tx/);
    assert.isFalse((await sdk.getPauseState(mint.publicKey))!.paused, "export mode sends nothing");
  });

  it("does not print the RPC URL when the RPC fails", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["policy", "show", M, "--url", "http://127.0.0.1:9/?api-key=not-a-real-key", "--keypair", adminKey], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: { HOME: home },
    });
    assert.equal(code, 1);
    assert.notInclude(err.join("\n") + out.join("\n"), "not-a-real-key");
  });
});
