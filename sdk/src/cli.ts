#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
//
// `vigilantis`: run Vigilantis from a terminal. Each command is a thin layer over VigilantisClient.
// What the CLI adds: the RPC and keypair from the Solana CLI config, names for reasons, permissions
// and outcomes, case references hashed with a salt that never goes on the command line, and an
// export mode (`--multisig <vault>`) that prints transactions for a multisig to propose instead
// of sending them. docs/deployment.md uses these commands in the runbook.
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parseArgs } from "util";
import { AnchorError, AnchorProvider, Wallet, utils } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  createSetAuthorityInstruction,
  getMint,
  getPermanentDelegate,
  getTransferHook,
  unpackAccount,
} from "@solana/spl-token";
import {
  ENFORCEMENT_REASONS,
  MAX_FREEZES_PER_TX,
  MAX_LIST_UPDATES_PER_TX,
  MAX_TRANSACTION_BYTES,
  PERMISSIONS,
  VigilantisClient,
  amountCommitment,
  caseRef,
  packInstructions,
  type Enforcement,
  type SeizureOutcome,
} from "./client";
import { version } from "../package.json";

/** Where the CLI writes. `main` takes one so the tests can run it in-process. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  env: Record<string, string | undefined>;
}

const processIo: CliIo = {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  env: process.env,
};

/** A mistake in the command line: exit code 2, with a pointer to the help. */
class UsageError extends Error {}

const CONFIRM = { commitment: "confirmed" as const };

/**
 * The most bytes an exported transaction may take. A multisig wraps the transaction in its own
 * instruction, which needs room, so export mode packs fewer instructions per transaction than the
 * 1,232 bytes a transaction may have.
 */
const MULTISIG_TX_BYTES = 900;

const CLUSTERS: Record<string, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  m: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  d: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  t: "https://api.testnet.solana.com",
  localhost: "http://127.0.0.1:8899",
  l: "http://127.0.0.1:8899",
};

const OPTIONS = {
  url: { type: "string", short: "u" },
  keypair: { type: "string", short: "k" },
  multisig: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  reason: { type: "string" },
  case: { type: "string" },
  "case-ref": { type: "string" },
  "case-salt-file": { type: "string" },
  "amount-commitment": { type: "string" },
  "amount-salt-file": { type: "string" },
  permissions: { type: "string" },
  outcome: { type: "string" },
  allowlist: { type: "string" },
  blocklist: { type: "string" },
  "max-amount": { type: "string" },
  "allow-confidential": { type: "string" },
  freeze: { type: "boolean" },
  "give-up": { type: "boolean" },
} as const;

type OptionName = keyof typeof OPTIONS;
type Values = Partial<Record<OptionName, string | boolean>>;

const GLOBAL_OPTIONS: OptionName[] = ["url", "keypair", "json", "help", "version"];
const ENFORCEMENT: OptionName[] = ["reason", "case", "case-ref", "case-salt-file"];
const POLICY: OptionName[] = ["allowlist", "blocklist", "max-amount", "allow-confidential"];

interface Context {
  client: VigilantisClient;
  connection: Connection;
  /** The keypair that signs, or null in export mode. */
  signer: Keypair | null;
  /** Who acts: the signer, or the multisig vault in export mode. */
  authority: PublicKey;
  multisig: PublicKey | null;
  values: Values;
  io: CliIo;
}

interface Command {
  name: string;
  usage: string;
  summary: string;
  group: string;
  options?: OptionName[];
  /** Accepts `--multisig`. */
  multisig?: boolean;
  /** Why `--multisig` does not apply, when that needs saying. */
  noMultisig?: string;
  /** Needs no RPC connection. */
  offline?: boolean;
  run(ctx: Context, args: string[]): Promise<void>;
}

// ---- Parsing ----

function address(value: string | undefined, what: string): PublicKey {
  if (!value) throw new UsageError(`missing ${what}`);
  try {
    return new PublicKey(value);
  } catch {
    throw new UsageError(`${what} is not a valid address: ${value}`);
  }
}

function onOff(value: string | boolean | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  const v = String(value).toLowerCase();
  if (["on", "true", "yes"].includes(v)) return true;
  if (["off", "false", "no"].includes(v)) return false;
  throw new UsageError(`--${name} takes on or off, got ${value}`);
}

function amountArg(value: string | boolean | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  const v = String(value);
  if (v === "none") return 0n;
  if (!/^\d+$/.test(v) || BigInt(v) > 0xffffffffffffffffn) {
    throw new UsageError(`--max-amount takes a whole number of base units (0 or none for no limit), got ${v}`);
  }
  return BigInt(v);
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const REASON_NAMES = Object.keys(ENFORCEMENT_REASONS).map(kebab);
const PERMISSION_NAMES = Object.keys(PERMISSIONS).filter((p) => p !== "all").map(kebab);
const OUTCOMES: SeizureOutcome[] = ["returnedToOwner", "paidToVictim", "paidToState", "other"];

/**
 * `--reason`. Optional (0, "unspecified") except where `required`: seizures and forfeitures always
 * record why. Freezes, pauses and blocks may have to happen within seconds, before anyone has a
 * case, so they never wait for one.
 */
function reasonArg(value: string | boolean | undefined, required = false): number {
  if (value === undefined) {
    if (!required) return ENFORCEMENT_REASONS.unspecified;
    throw new UsageError(`this command records why it was done: add --reason (${REASON_NAMES.join(", ")} or a number)`);
  }
  const v = String(value);
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n > 0xffff) throw new UsageError(`--reason must be from 0 to 65535, got ${v}`);
    return n;
  }
  const code = (ENFORCEMENT_REASONS as Record<string, number>)[camel(v)];
  if (code === undefined) throw new UsageError(`unknown reason ${v}; use ${REASON_NAMES.join(", ")} or a number`);
  return code;
}

function permissionsArg(value: string | boolean | undefined): number {
  if (value === undefined) throw new UsageError(`add --permissions, a comma-separated list of ${PERMISSION_NAMES.join(", ")} (or all)`);
  let bits = 0;
  for (const name of String(value).split(",").map((s) => s.trim()).filter(Boolean)) {
    const bit = (PERMISSIONS as Record<string, number>)[camel(name)];
    if (bit === undefined) throw new UsageError(`unknown permission ${name}; use ${PERMISSION_NAMES.join(", ")} or all`);
    bits |= bit;
  }
  if (bits === 0) throw new UsageError("--permissions is empty");
  return bits;
}

function permissionNames(bits: number): string[] {
  return Object.entries(PERMISSIONS)
    .filter(([name, bit]) => name !== "all" && (bits & bit) !== 0)
    .map(([name]) => kebab(name));
}

function outcomeArg(value: string | boolean | undefined): SeizureOutcome {
  const names = OUTCOMES.map(kebab);
  if (value === undefined) throw new UsageError(`add --outcome (${names.join(", ")})`);
  const outcome = camel(String(value)) as SeizureOutcome;
  if (!OUTCOMES.includes(outcome)) throw new UsageError(`unknown outcome ${value}; use ${names.join(", ")}`);
  return outcome;
}

/**
 * The case reference from `--case-ref` (the 32 bytes in hex) or `--case` (hashed with the salt).
 * The salt comes from VIGILANTIS_CASE_SALT or a file, never from the command line, where it would
 * end up in the shell history. Null when neither option is given.
 */
function caseRefArg(ctx: { values: Values; io: CliIo }): Uint8Array | null {
  const { values } = ctx;
  if (values["case-ref"] !== undefined && values.case !== undefined) {
    throw new UsageError("give --case or --case-ref, not both");
  }
  if (values["case-ref"] !== undefined) {
    const hex = String(values["case-ref"]).replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new UsageError("--case-ref takes 64 hex characters (32 bytes)");
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }
  if (values.case === undefined) return null;
  return caseRef(caseId(String(values.case), "--case"), salt(ctx));
}

/** The same case number must always give the same hash: Unicode in one form (NFC), no surrounding spaces. */
function caseId(text: string, what: string): string {
  const id = text.normalize("NFC").trim();
  if (!id) throw new UsageError(`${what} is empty`);
  return id;
}

function checkedSalt(value: string, ctx: { io: CliIo }): string {
  if (Buffer.byteLength(value, "utf8") < 16) {
    ctx.io.err("warning: the case salt is shorter than 16 bytes; a short salt makes case numbers easier to guess from their hashes");
  }
  return value;
}

function salt(ctx: { values: Values; io: CliIo }): string {
  const file = ctx.values["case-salt-file"];
  if (file !== undefined) {
    let text: string;
    try {
      text = readFileSync(String(file), "utf8");
    } catch (e) {
      throw new UsageError(`cannot read the case salt file ${file}: ${(e as Error).message}`);
    }
    // Surrounding whitespace (a trailing newline, a BOM) would change every hash, so it is not
    // part of the salt, here or in VIGILANTIS_CASE_SALT.
    const value = text.replace(/^\uFEFF/, "").trim();
    if (!value) throw new UsageError(`the case salt file ${file} is empty`);
    return checkedSalt(value, ctx);
  }
  const env = ctx.io.env.VIGILANTIS_CASE_SALT?.trim();
  if (env) return checkedSalt(env, ctx);
  throw new UsageError(
    "--case needs the salt it is hashed with: set VIGILANTIS_CASE_SALT or pass --case-salt-file <path>. " +
      "Use the same salt every time, and keep it private.",
  );
}

/** `--reason` and `--case`. Both optional, except for seizures and forfeitures (`caseRequired`). */
function enforcement(ctx: Context, caseRequired = false): Enforcement {
  const reasonCode = reasonArg(ctx.values.reason, caseRequired);
  const ref = caseRefArg(ctx);
  if (!ref && caseRequired) throw new UsageError("this command needs a case: add --case <id> or --case-ref <hex>");
  return { reasonCode, caseRef: ref ?? new Uint8Array(32) };
}

/** An amount in base units for `amount-commitment`. */
function baseUnits(value: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) > 0xffffffffffffffffn) {
    throw new UsageError(`the amount is a whole number of base units, got ${value}`);
  }
  return BigInt(value);
}

/**
 * The salt for `amount-commitment`, from VIGILANTIS_AMOUNT_SALT or `--amount-salt-file`, never from
 * the command line. Keep it apart from the case salt.
 */
function amountSalt(ctx: { values: Values; io: CliIo }): string {
  const file = ctx.values["amount-salt-file"];
  if (file !== undefined) {
    let text: string;
    try {
      text = readFileSync(String(file), "utf8");
    } catch (e) {
      throw new UsageError(`cannot read the amount salt file ${file}: ${(e as Error).message}`);
    }
    const value = text.replace(/^\uFEFF/, "").trim();
    if (!value) throw new UsageError(`the amount salt file ${file} is empty`);
    return checkedSalt(value, ctx);
  }
  const env = ctx.io.env.VIGILANTIS_AMOUNT_SALT?.trim();
  if (env) return checkedSalt(env, ctx);
  throw new UsageError("amount-commitment needs a salt: set VIGILANTIS_AMOUNT_SALT or pass --amount-salt-file <path>");
}

/** `--amount-commitment`: 64 hex characters, or nothing (all zeros on-chain). */
function amountCommitmentArg(value: string | boolean | undefined): Uint8Array | undefined {
  if (value === undefined) return undefined;
  const hex = String(value).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new UsageError("--amount-commitment takes 64 hex characters (32 bytes)");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function hasEnforcement(values: Values): boolean {
  return values.reason !== undefined || values.case !== undefined || values["case-ref"] !== undefined;
}

// ---- Output ----

/** A value with addresses, bigints and bytes turned into strings, for --json. */
function plain(value: unknown): unknown {
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function json(ctx: Context, value: unknown) {
  ctx.io.out(JSON.stringify(plain(value), null, 2));
}

/** Label and value rows; a label that starts with two spaces is a sub-row of the row above. */
function table(ctx: Context, rows: [string, string][]) {
  const width = Math.max(...rows.filter(([k]) => !k.startsWith("  ")).map(([k]) => k.length));
  for (const [k, v] of rows) ctx.io.out(k.startsWith("  ") ? `${k}  ${v}` : `${k.padEnd(width)}  ${v}`);
}

const time = (unix: number) => new Date(unix * 1000).toISOString().replace(".000Z", "Z");

function named(addr: PublicKey | null, vigilantis: PublicKey): string {
  if (!addr) return "none";
  return addr.equals(vigilantis) ? `Vigilantis (${addr.toBase58()})` : addr.toBase58();
}

// ---- Sending ----

/**
 * Split instructions into transactions of at most `max` instructions that fit a transaction (1,232
 * bytes); in export mode at most MULTISIG_TX_BYTES, which leaves room for the multisig's own
 * wrapping. The order is kept, so the first transaction holds the first instructions.
 */
function pack(ctx: Context, ixs: TransactionInstruction[], max: number): TransactionInstruction[][] {
  return packInstructions(ixs, ctx.authority, max, ctx.multisig ? MULTISIG_TX_BYTES : MAX_TRANSACTION_BYTES);
}

/**
 * Send each group as one transaction signed by the keypair, or, in export mode, print it for the
 * multisig: an unsigned legacy transaction, fee payer the vault, base58, the format Squads imports
 * ("Add instruction", then "Import base58 encoded tx") and the one `solana-verify export-pda-tx`
 * prints. Then report what was done.
 */
async function submit(ctx: Context, action: string, groups: TransactionInstruction[][]) {
  groups = groups.filter((g) => g.length > 0);
  if (ctx.multisig) {
    const transactions = groups.map((ixs) => {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = ctx.multisig!;
      tx.recentBlockhash = PublicKey.default.toBase58();
      return utils.bytes.bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    });
    if (ctx.values.json) return json(ctx, { action, multisig: ctx.multisig, transactions });
    const n = transactions.length;
    ctx.io.out(`${action}: ${n} transaction${n === 1 ? "" : "s"} for ${ctx.multisig.toBase58()} to propose, in this order.`);
    ctx.io.out(`In Squads: Add instruction, then "Import base58 encoded tx".`);
    transactions.forEach((tx, i) => {
      ctx.io.out("");
      ctx.io.out(`Transaction ${i + 1} of ${n}:`);
      ctx.io.out(tx);
    });
    return;
  }
  const signatures: string[] = [];
  for (const ixs of groups) {
    try {
      signatures.push(
        await sendAndConfirmTransaction(ctx.connection, new Transaction().add(...ixs), [ctx.signer!], CONFIRM),
      );
    } catch (e) {
      // Say what already landed, so a rerun can pick up from there instead of repeating it.
      if (signatures.length > 0) {
        ctx.io.err(`${action}: ${signatures.length} of ${groups.length} transactions went through before this one failed:`);
        for (const s of signatures) ctx.io.err(`  ${s}`);
      }
      throw e;
    }
  }
  done(ctx, action, signatures);
}

function done(ctx: Context, action: string, signatures: string[]) {
  if (ctx.values.json) return json(ctx, { action, signatures });
  ctx.io.out(`${action}: done.`);
  for (const s of signatures) ctx.io.out(`  signature ${s}`);
}

// ---- Token accounts ----

/**
 * The token accounts of `mint` that `target` names: the account itself when `target` is a token
 * account of the mint, otherwise every account the wallet `target` holds.
 */
async function tokenAccounts(ctx: Context, mint: PublicKey, target: PublicKey) {
  const info = await ctx.connection.getAccountInfo(target, "confirmed");
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    let account;
    try {
      account = unpackAccount(target, info, TOKEN_2022_PROGRAM_ID);
    } catch {
      account = null; // a mint, not a token account
    }
    if (account) {
      if (!account.mint.equals(mint)) {
        throw new UsageError(`${target.toBase58()} is a token account of another mint (${account.mint.toBase58()})`);
      }
      return { wallet: null, accounts: [{ address: target, owner: account.owner, amount: account.amount, frozen: account.isFrozen }] };
    }
  }
  return { wallet: target, accounts: await ctx.client.tokenAccountsOf(mint, target) };
}

async function freezeOrThaw(ctx: Context, args: string[], thaw: boolean) {
  const mint = address(args[0], "mint");
  const target = address(args[1], "wallet or token account");
  const e = enforcement(ctx);
  const { wallet, accounts } = await tokenAccounts(ctx, mint, target);
  if (accounts.length === 0) {
    throw new Error(`${target.toBase58()} holds no token account of ${mint.toBase58()}`);
  }
  let todo = accounts.filter((a) => a.frozen === thaw);
  const verb = thaw ? "thaw" : "freeze";
  const what = wallet ? `token accounts of ${wallet.toBase58()}` : target.toBase58();
  if (thaw && todo.length > 0) {
    // A forfeited account cannot be thawed until the admin releases the forfeiture.
    const forfeited = await ctx.client.forfeitedAmong(mint, todo.map((a) => a.address));
    if (forfeited.size > 0) {
      if (!wallet) {
        throw new Error(
          `${target.toBase58()} is forfeited; the admin must run \`vigilantis forfeiture release\` before it can be thawed`,
        );
      }
      if (!ctx.values.json) {
        ctx.io.err(`skipping ${forfeited.size} forfeited token account${forfeited.size === 1 ? "" : "s"}; see \`vigilantis forfeiture list\``);
      }
      todo = todo.filter((a) => !forfeited.has(a.address.toBase58()));
    }
  }
  if (todo.length === 0) {
    if (ctx.values.json) return json(ctx, { action: `${verb} ${what}`, signatures: [], alreadyDone: true });
    ctx.io.out(`Nothing to ${verb}: ${wallet ? "every token account of the wallet is" : "the account is"} already ${thaw ? "thawed" : "frozen"}.`);
    return;
  }
  const ixs = await Promise.all(
    todo.map((a) =>
      ctx.client.freezeInstruction({ mint, tokenAccount: a.address, enforcement: e, thaw, authority: ctx.authority }),
    ),
  );
  const count = !wallet ? what : todo.length === 1 ? `1 token account of ${wallet.toBase58()}` : `${todo.length} ${what}`;
  await submit(ctx, `${verb} ${count}`, pack(ctx, ixs, MAX_FREEZES_PER_TX));
}

async function listCommand(ctx: Context, args: string[], list: "allow" | "block", action: "add" | "remove") {
  const mint = address(args[0], "mint");
  if (args.length < 2) throw new UsageError("give at least one wallet");
  const wallets = args.slice(1).map((w) => address(w, "wallet"));
  const freeze = list === "block" && action === "add" && ctx.values.freeze === true;
  // With --freeze, the block is recorded too (reason "unspecified" when none is given).
  const recorded = list === "block" && (hasEnforcement(ctx.values) || freeze);
  if (freeze && wallets.length !== 1) throw new UsageError("--freeze takes one wallet at a time");
  // Lists hold wallets. A token account's address on a list would match nothing: the hook looks
  // up the owner of each token account.
  if (list === "block" || list === "allow") {
    const infos = await ctx.connection.getMultipleAccountsInfo(wallets, "confirmed");
    infos.forEach((info, i) => {
      if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID) && info.data.length >= 165) {
        const owner = new PublicKey(info.data.subarray(32, 64)).toBase58();
        throw new Error(`${wallets[i].toBase58()} is a token account, not a wallet; use its owner ${owner}`);
      }
    });
  }

  let ixs: TransactionInstruction[];
  if (recorded) {
    const e = enforcement(ctx);
    ixs = await Promise.all(
      wallets.map((wallet) =>
        action === "add"
          ? ctx.client.blockWalletInstruction({ mint, wallet, enforcement: e, authority: ctx.authority })
          : ctx.client.unblockWalletInstruction({ mint, wallet, enforcement: e, authority: ctx.authority }),
      ),
    );
  } else {
    ixs = await Promise.all(
      wallets.map((wallet) => ctx.client.listInstruction({ mint, wallet, list, action, authority: ctx.authority })),
    );
  }
  const listName = list === "allow" ? "allowlist" : "blocklist";
  const what = wallets.length === 1 ? wallets[0].toBase58() : `${wallets.length} wallets`;
  if (!freeze) {
    return submit(ctx, `${action === "add" ? "add" : "remove"} ${what} ${action === "add" ? "to" : "from"} the ${listName}`, pack(ctx, ixs, MAX_LIST_UPDATES_PER_TX));
  }
  // Block and freeze: the block and the first freezes in one transaction, as blockAndFreezeWallet does.
  const e = enforcement(ctx);
  const accounts = (await ctx.client.tokenAccountsOf(mint, wallets[0])).filter((a) => !a.frozen);
  const freezes = await Promise.all(
    accounts.map((a) => ctx.client.freezeInstruction({ mint, tokenAccount: a.address, enforcement: e, authority: ctx.authority })),
  );
  const first = pack(ctx, [...ixs, ...freezes], MAX_FREEZES_PER_TX)[0];
  const rest = pack(ctx, freezes.slice(first.length - 1), MAX_FREEZES_PER_TX);
  await submit(ctx, `block ${what} and freeze ${accounts.length} token account${accounts.length === 1 ? "" : "s"}`, [first, ...rest]);
}

async function setAuthority(ctx: Context, args: string[], kind: "freeze" | "pause") {
  const mint = address(args[0], "mint");
  if (!args[1]) throw new UsageError(`give the new ${kind} authority, or none`);
  const giveUp = args[1] === "none";
  if (giveUp && ctx.values["give-up"] !== true) {
    throw new UsageError(`giving the ${kind} authority up cannot be undone; add --give-up if that is what you mean`);
  }
  const target = giveUp ? null : address(args[1], `new ${kind} authority`);
  const e = enforcement(ctx);
  const ix =
    kind === "freeze"
      ? await ctx.client.setFreezeAuthorityInstruction({ mint, newFreezeAuthority: target, enforcement: e, authority: ctx.authority })
      : await ctx.client.setPauseAuthorityInstruction({ mint, newPauseAuthority: target, enforcement: e, authority: ctx.authority });
  await submit(ctx, giveUp ? `give up the ${kind} authority of ${mint.toBase58()}` : `hand the ${kind} authority to ${target!.toBase58()}`, [[ix]]);
}

async function toVigilantis(ctx: Context, args: string[], kind: "freeze" | "pause") {
  const mint = address(args[0], "mint");
  const ix = createSetAuthorityInstruction(
    mint,
    ctx.authority,
    kind === "freeze" ? AuthorityType.FreezeAccount : AuthorityType.PausableConfig,
    kind === "freeze" ? ctx.client.freezeAuthority(mint) : ctx.client.pauseAuthority(mint),
    [],
    TOKEN_2022_PROGRAM_ID,
  );
  await submit(ctx, `hand the ${kind} authority of ${mint.toBase58()} to Vigilantis`, [[ix]]);
}

async function policyOrFail(ctx: Context, mint: PublicKey) {
  const policy = await ctx.client.getPolicy(mint);
  if (!policy) throw new Error(`${mint.toBase58()} has no Vigilantis policy (vigilantis policy init <mint>)`);
  return policy;
}

// ---- Commands ----

const COMMANDS: Command[] = [
  // Reading
  {
    name: "status",
    usage: "<mint>",
    summary: "the policy, the mint's authorities, pause state, roles, open seizures and forfeitures",
    group: "Reading",
    async run(ctx, [m]) {
      const mint = address(m, "mint");
      const { client, connection } = ctx;
      const policy = await policyOrFail(ctx, mint);
      const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
      const [pending, pause, roles, seizures, forfeitures, metaList] = await Promise.all([
        client.getPendingAuthority(mint),
        client.getPauseState(mint),
        client.listRoles(mint),
        client.listSeizures(mint),
        client.listForfeitures(mint),
        connection.getAccountInfo(client.metaList(mint), "confirmed"),
      ]);
      const hookExtension = getTransferHook(mintInfo);
      const hook = hookExtension?.programId ?? null;
      const hookAuthority = hookExtension && !hookExtension.authority.equals(PublicKey.default) ? hookExtension.authority : null;
      const delegate = getPermanentDelegate(mintInfo)?.delegate ?? null;
      const status = {
        mint,
        program: client.programId,
        transferHook: hook && !hook.equals(PublicKey.default) ? hook : null,
        transferHookAuthority: hookAuthority,
        metaList: metaList !== null,
        policy,
        pendingAuthority: pending,
        freezeAuthority: mintInfo.freezeAuthority,
        pause,
        permanentDelegate: delegate && !delegate.equals(PublicKey.default) ? delegate : null,
        roles: roles.map((r) => ({ ...r, permissionNames: permissionNames(r.permissions) })),
        seizures,
        forfeitures,
      };
      if (ctx.values.json) return json(ctx, status);
      const limit = policy.maxTransferAmount;
      const confidential =
        limit === 0n
          ? "allowed (no limit to enforce)"
          : policy.allowConfidential
            ? "allowed; the limit does not reach them"
            : "refused while a limit is set";
      table(ctx, [
        ["Mint", mint.toBase58()],
        ["Program", client.programId.toBase58()],
        ["Transfer hook", !status.transferHook ? "none" : status.transferHook.equals(client.programId) ? "Vigilantis" : `${status.transferHook.toBase58()} (not this program)`],
        // Whoever holds this can point the mint at another hook, or none, which switches every rule off.
        ["Hook authority", hookAuthority ? `${hookAuthority.toBase58()} (can switch the hook off)` : "none (the hook cannot be changed)"],
        ["Meta list", status.metaList ? "initialized" : "missing (vigilantis meta-list init <mint>)"],
        ["Policy authority", policy.authority.toBase58()],
        ["Handover", pending ? `waiting for ${pending.toBase58()}` : "none pending"],
        ["Allowlist", policy.allowlistEnabled ? "on" : "off"],
        ["Blocklist", policy.blocklistEnabled ? "on" : "off"],
        ["Transfer limit", limit === 0n ? "none" : `${limit} base units`],
        ["Confidential", confidential],
        ["Freeze authority", named(mintInfo.freezeAuthority, client.freezeAuthority(mint))],
        ["Pause", pause ? `${pause.paused ? "PAUSED" : "running"} (authority: ${named(pause.authority, client.pauseAuthority(mint))})` : "not pausable"],
        ["Permanent delegate", named(status.permanentDelegate, client.permanentDelegate(mint))],
        ["Roles", String(roles.length)],
        ...roles.map((r): [string, string] => [
          `  ${r.holder.toBase58()}`,
          `${permissionNames(r.permissions).join(", ")}${r.active ? "" : " (inactive: granted before the last handover)"}`,
        ]),
        ["Open seizures", String(seizures.length)],
        ...seizures.map((s): [string, string] => [
          `  ${s.tokenAccount.toBase58()}`,
          `${s.amount} base units of ${s.wallet.toBase58()}, seized ${time(s.seizedAt)}, case ${Buffer.from(s.caseRef).toString("hex")}`,
        ]),
        ["Forfeited accounts", String(forfeitures.length)],
        ...forfeitures.map((f): [string, string] => [
          `  ${f.tokenAccount.toBase58()}`,
          `of ${f.wallet.toBase58()}, forfeited ${time(f.forfeitedAt)}, case ${Buffer.from(f.caseRef).toString("hex")}`,
        ]),
      ]);
    },
  },
  {
    name: "check",
    usage: "<mint> <wallet>",
    summary: "whether a wallet is allowlisted or blocklisted, its role, and its token accounts",
    group: "Reading",
    async run(ctx, [m, w]) {
      const mint = address(m, "mint");
      const wallet = address(w, "wallet");
      const { client } = ctx;
      const policy = await policyOrFail(ctx, mint);
      const [allowlisted, blocklisted, role, accounts] = await Promise.all([
        client.isAllowlisted(mint, wallet),
        client.isBlocklisted(mint, wallet),
        client.getRole(mint, wallet),
        client.tokenAccountsOf(mint, wallet),
      ]);
      const [records, forfeitures] = await Promise.all([
        Promise.all(accounts.map((a) => client.getFreezeRecord(mint, a.address))),
        Promise.all(accounts.map((a) => client.getForfeiture(mint, a.address))),
      ]);
      const view = {
        wallet,
        allowlisted,
        blocklisted,
        isPolicyAuthority: policy.authority.equals(wallet),
        role: role ? { ...role, permissionNames: permissionNames(role.permissions) } : null,
        tokenAccounts: accounts.map((a, i) => ({ ...a, freezeRecord: records[i], forfeiture: forfeitures[i] })),
      };
      if (ctx.values.json) return json(ctx, view);
      table(ctx, [
        ["Wallet", wallet.toBase58()],
        ["Allowlisted", `${allowlisted ? "yes" : "no"}${policy.allowlistEnabled ? "" : " (the allowlist is off)"}`],
        ["Blocklisted", `${blocklisted ? "yes" : "no"}${policy.blocklistEnabled ? "" : " (the blocklist is off)"}`],
        ["Role", view.isPolicyAuthority ? "policy authority (every permission)" : role ? permissionNames(role.permissions).join(", ") : "none"],
        ["Token accounts", String(accounts.length)],
        ...accounts.map((a, i): [string, string] => {
          const r = records[i];
          const f = forfeitures[i];
          const freeze = f
            ? `FORFEITED ${time(f.forfeitedAt)} (case ${Buffer.from(f.caseRef).toString("hex")}); frozen until the admin releases it`
            : !a.frozen
              ? "not frozen"
              : r
                ? `frozen ${time(r.frozenAt)}, seizable or forfeitable from ${time(r.seizableFrom)}`
                : "frozen";
          return [`  ${a.address.toBase58()}`, `${a.amount} public base units, ${freeze}`];
        }),
      ]);
    },
  },
  {
    name: "case-ref",
    usage: "<case-id>",
    summary: "print the 32-byte case reference for a case ID, hashed with the salt",
    group: "Reading",
    options: ["case-salt-file"],
    offline: true,
    async run(ctx, [id]) {
      if (id === undefined) throw new UsageError("missing case ID");
      const ref = Buffer.from(caseRef(caseId(id, "the case ID"), salt(ctx))).toString("hex");
      if (ctx.values.json) return json(ctx, { caseRef: ref });
      ctx.io.out(ref);
    },
  },
  {
    name: "amount-commitment",
    usage: "<amount>",
    summary: "print the 32-byte commitment to an amount in base units, hashed with the amount salt",
    group: "Reading",
    options: ["amount-salt-file"],
    offline: true,
    async run(ctx, [a]) {
      if (a === undefined) throw new UsageError("missing amount (in base units)");
      const commitment = Buffer.from(amountCommitment(baseUnits(a), amountSalt(ctx))).toString("hex");
      if (ctx.values.json) return json(ctx, { amountCommitment: commitment });
      ctx.io.out(commitment);
    },
  },

  // Policy
  {
    name: "policy show",
    usage: "<mint>",
    summary: "the policy",
    group: "Policy (the policy authority)",
    async run(ctx, [m]) {
      const policy = await policyOrFail(ctx, address(m, "mint"));
      if (ctx.values.json) return json(ctx, policy);
      table(ctx, [
        ["Authority", policy.authority.toBase58()],
        ["Allowlist", policy.allowlistEnabled ? "on" : "off"],
        ["Blocklist", policy.blocklistEnabled ? "on" : "off"],
        ["Transfer limit", policy.maxTransferAmount === 0n ? "none" : `${policy.maxTransferAmount} base units`],
        ["Allow confidential", policy.allowConfidential ? "on" : "off"],
      ]);
    },
  },
  {
    name: "policy init",
    usage: "<mint> [--allowlist on|off] [--blocklist on|off] [--max-amount <n>] [--allow-confidential on|off]",
    summary: "create the policy, signed by the mint authority, who becomes the policy authority",
    group: "Policy (the policy authority)",
    options: POLICY,
    noMultisig: "create the policy with a key, then hand it to the multisig with `vigilantis authority propose`",
    async run(ctx, [m]) {
      const mint = address(m, "mint");
      const signature = await ctx.client.initializePolicy({
        mint,
        allowlist: onOff(ctx.values.allowlist, "allowlist") ?? false,
        blocklist: onOff(ctx.values.blocklist, "blocklist") ?? false,
        maxTransferAmount: amountArg(ctx.values["max-amount"]) ?? 0n,
        allowConfidential: onOff(ctx.values["allow-confidential"], "allow-confidential") ?? false,
      });
      done(ctx, `create the policy of ${mint.toBase58()}`, [signature]);
    },
  },
  {
    name: "policy update",
    usage: "<mint> [--allowlist on|off] [--blocklist on|off] [--max-amount <n>] [--allow-confidential on|off]",
    summary: "change the settings given; the others stay as they are",
    group: "Policy (the policy authority)",
    options: POLICY,
    multisig: true,
    async run(ctx, [m]) {
      const mint = address(m, "mint");
      const changes = {
        allowlist: onOff(ctx.values.allowlist, "allowlist"),
        blocklist: onOff(ctx.values.blocklist, "blocklist"),
        maxTransferAmount: amountArg(ctx.values["max-amount"]),
        allowConfidential: onOff(ctx.values["allow-confidential"], "allow-confidential"),
      };
      if (Object.values(changes).every((v) => v === undefined)) {
        throw new UsageError("nothing to change: give --allowlist, --blocklist, --max-amount or --allow-confidential");
      }
      const current = await policyOrFail(ctx, mint);
      const ix = await ctx.client.updatePolicyInstruction({
        mint,
        allowlist: changes.allowlist ?? current.allowlistEnabled,
        blocklist: changes.blocklist ?? current.blocklistEnabled,
        maxTransferAmount: changes.maxTransferAmount ?? current.maxTransferAmount,
        allowConfidential: changes.allowConfidential ?? current.allowConfidential,
        authority: ctx.authority,
      });
      await submit(ctx, `update the policy of ${mint.toBase58()}`, [[ix]]);
    },
  },
  {
    name: "meta-list init",
    usage: "<mint>",
    summary: "create the account list Token-2022 calls the hook with, signed by the mint authority",
    group: "Policy (the policy authority)",
    noMultisig: "the meta list is created with the mint authority's key, before the policy goes to a multisig",
    async run(ctx, [m]) {
      const mint = address(m, "mint");
      done(ctx, `create the meta list of ${mint.toBase58()}`, [await ctx.client.initializeExtraAccountMetaList(mint)]);
    },
  },
  {
    name: "meta-list update",
    usage: "<mint>",
    summary: "bring the meta list up to the program's current layout (mints set up before 2.1)",
    group: "Policy (the policy authority)",
    multisig: true,
    async run(ctx, [m]) {
      const mint = address(m, "mint");
      await submit(ctx, `update the meta list of ${mint.toBase58()}`, [
        [await ctx.client.updateExtraAccountMetaListInstruction(mint, ctx.authority)],
      ]);
    },
  },

  // Lists
  {
    name: "allow add",
    usage: "<mint> <wallet>...",
    summary: "allowlist wallets",
    group: "Lists (the policy authority or a role)",
    multisig: true,
    run: (ctx, args) => listCommand(ctx, args, "allow", "add"),
  },
  {
    name: "allow remove",
    usage: "<mint> <wallet>...",
    summary: "take wallets off the allowlist",
    group: "Lists (the policy authority or a role)",
    multisig: true,
    run: (ctx, args) => listCommand(ctx, args, "allow", "remove"),
  },
  {
    name: "block add",
    usage: "<mint> <wallet>... [--reason <r>] [--case <id>] [--freeze]",
    summary: "blocklist wallets; with --reason, record why; with --freeze, also freeze the wallet's accounts",
    group: "Lists (the policy authority or a role)",
    options: [...ENFORCEMENT, "freeze"],
    multisig: true,
    run: (ctx, args) => listCommand(ctx, args, "block", "add"),
  },
  {
    name: "block remove",
    usage: "<mint> <wallet>... [--reason <r>] [--case <id>]",
    summary: "take wallets off the blocklist; with --reason, record why",
    group: "Lists (the policy authority or a role)",
    options: ENFORCEMENT,
    multisig: true,
    run: (ctx, args) => listCommand(ctx, args, "block", "remove"),
  },

  // Enforcement
  {
    name: "freeze",
    usage: "<mint> <wallet|token-account> [--reason <r>] [--case <id>]",
    summary: "freeze a token account, or every token account of a wallet",
    group: "Enforcement (the policy authority or a role)",
    options: ENFORCEMENT,
    multisig: true,
    run: (ctx, args) => freezeOrThaw(ctx, args, false),
  },
  {
    name: "thaw",
    usage: "<mint> <wallet|token-account> [--reason <r>] [--case <id>]",
    summary: "thaw a token account, or every frozen token account of a wallet",
    group: "Enforcement (the policy authority or a role)",
    options: ENFORCEMENT,
    multisig: true,
    run: (ctx, args) => freezeOrThaw(ctx, args, true),
  },
  {
    name: "pause",
    usage: "<mint> [--reason <r>] [--case <id>]",
    summary: "stop every transfer, mint and burn of the token",
    group: "Enforcement (the policy authority or a role)",
    options: ENFORCEMENT,
    multisig: true,
    async run(ctx, [m]) {
      const mint = address(m, "mint");
      const ix = await ctx.client.pauseInstruction({ mint, enforcement: enforcement(ctx), authority: ctx.authority });
      await submit(ctx, `pause ${mint.toBase58()}`, [[ix]]);
    },
  },
  {
    name: "resume",
    usage: "<mint> [--reason <r>] [--case <id>]",
    summary: "end a pause",
    group: "Enforcement (the policy authority or a role)",
    options: ENFORCEMENT,
    multisig: true,
    async run(ctx, [m]) {
      const mint = address(m, "mint");
      const ix = await ctx.client.pauseInstruction({ mint, enforcement: enforcement(ctx), resume: true, authority: ctx.authority });
      await submit(ctx, `resume ${mint.toBase58()}`, [[ix]]);
    },
  },
  {
    name: "seize",
    usage: "<mint> <token-account> --reason <r> --case <id>",
    summary: "burn the public balance of an account frozen through Vigilantis at least 24 hours ago",
    group: "Enforcement (the policy authority or a role)",
    options: ENFORCEMENT,
    multisig: true,
    async run(ctx, [m, t]) {
      const mint = address(m, "mint");
      const tokenAccount = address(t, "token account");
      const ix = await ctx.client.seizeInstruction({ mint, tokenAccount, enforcement: enforcement(ctx, true), authority: ctx.authority });
      await submit(ctx, `seize the public balance of ${tokenAccount.toBase58()}`, [[ix]]);
    },
  },
  {
    name: "seizure close",
    usage: "<mint> <token-account> --case <id> --outcome <o> --reason <r>",
    summary: "close a seizure with its outcome: returned-to-owner, paid-to-victim, paid-to-state, other",
    group: "Enforcement (the policy authority or a role)",
    options: [...ENFORCEMENT, "outcome"],
    multisig: true,
    async run(ctx, [m, t]) {
      const mint = address(m, "mint");
      const tokenAccount = address(t, "token account");
      const { reasonCode, caseRef: ref } = enforcement(ctx, true);
      const outcome = outcomeArg(ctx.values.outcome);
      if (!(await ctx.client.getSeizure(mint, tokenAccount, ref))) {
        throw new Error(`no open seizure of ${tokenAccount.toBase58()} under this case reference`);
      }
      const ix = await ctx.client.closeSeizureInstruction({ mint, tokenAccount, caseRef: ref, outcome, reasonCode, authority: ctx.authority });
      await submit(ctx, `close the seizure of ${tokenAccount.toBase58()} (${kebab(outcome)})`, [[ix]]);
    },
  },
  {
    name: "seizure list",
    usage: "<mint>",
    summary: "every open seizure",
    group: "Enforcement (the policy authority or a role)",
    async run(ctx, [m]) {
      const seizures = await ctx.client.listSeizures(address(m, "mint"));
      if (ctx.values.json) return json(ctx, seizures);
      if (seizures.length === 0) return ctx.io.out("No open seizures.");
      for (const s of seizures) {
        ctx.io.out(`${s.tokenAccount.toBase58()}  ${s.amount} base units of ${s.wallet.toBase58()}`);
        ctx.io.out(`  seized ${time(s.seizedAt)} by ${s.authority.toBase58()}, reason ${s.reasonCode}, case ${Buffer.from(s.caseRef).toString("hex")}`);
      }
    },
  },
  {
    name: "forfeit",
    usage: "<mint> <token-account> --reason <r> --case <id> [--amount-commitment <hex>]",
    summary: "end a case whose balance cannot be seized: the account, frozen 24 hours or more, stays frozen until released",
    group: "Enforcement (the policy authority or a role)",
    options: [...ENFORCEMENT, "amount-commitment"],
    multisig: true,
    async run(ctx, [m, t]) {
      const mint = address(m, "mint");
      const tokenAccount = address(t, "token account");
      const commitment = amountCommitmentArg(ctx.values["amount-commitment"]);
      const ix = await ctx.client.forfeitInstruction({
        mint,
        tokenAccount,
        enforcement: enforcement(ctx, true),
        amountCommitment: commitment,
        authority: ctx.authority,
      });
      await submit(ctx, `forfeit ${tokenAccount.toBase58()} (it stays frozen until the admin releases it)`, [[ix]]);
    },
  },
  {
    name: "forfeiture release",
    usage: "<mint> <token-account> --reason <r>",
    summary: "remove a forfeiture, for example after an appeal, so the account can be thawed (the admin only)",
    group: "Enforcement (the policy authority or a role)",
    options: ["reason"],
    multisig: true,
    async run(ctx, [m, t]) {
      const mint = address(m, "mint");
      const tokenAccount = address(t, "token account");
      const reasonCode = reasonArg(ctx.values.reason, true);
      if (!(await ctx.client.getForfeiture(mint, tokenAccount))) {
        throw new Error(`${tokenAccount.toBase58()} is not forfeited`);
      }
      const ix = await ctx.client.releaseForfeitureInstruction({ mint, tokenAccount, reasonCode, authority: ctx.authority });
      await submit(ctx, `release the forfeiture of ${tokenAccount.toBase58()} (it stays frozen until a thaw)`, [[ix]]);
    },
  },
  {
    name: "forfeiture list",
    usage: "<mint>",
    summary: "every forfeited token account",
    group: "Enforcement (the policy authority or a role)",
    async run(ctx, [m]) {
      const forfeitures = await ctx.client.listForfeitures(address(m, "mint"));
      if (ctx.values.json) return json(ctx, forfeitures);
      if (forfeitures.length === 0) return ctx.io.out("No forfeited accounts.");
      for (const f of forfeitures) {
        ctx.io.out(`${f.tokenAccount.toBase58()}  of ${f.wallet.toBase58()}`);
        ctx.io.out(`  forfeited ${time(f.forfeitedAt)} by ${f.authority.toBase58()}, reason ${f.reasonCode}, case ${Buffer.from(f.caseRef).toString("hex")}`);
      }
    },
  },

  // Roles
  {
    name: "role grant",
    usage: "<mint> <holder> --permissions <list>",
    summary: `give a role; permissions: ${PERMISSION_NAMES.join(", ")}, or all`,
    group: "Roles (the policy authority)",
    options: ["permissions"],
    multisig: true,
    async run(ctx, [m, h]) {
      const mint = address(m, "mint");
      const holder = address(h, "holder");
      const permissions = permissionsArg(ctx.values.permissions);
      const ix = await ctx.client.grantRoleInstruction({ mint, holder, permissions, authority: ctx.authority });
      await submit(ctx, `give ${holder.toBase58()} a role (${permissionNames(permissions).join(", ")})`, [[ix]]);
    },
  },
  {
    name: "role update",
    usage: "<mint> <holder> --permissions <list>",
    summary: "replace a role's permissions",
    group: "Roles (the policy authority)",
    options: ["permissions"],
    multisig: true,
    async run(ctx, [m, h]) {
      const mint = address(m, "mint");
      const holder = address(h, "holder");
      const permissions = permissionsArg(ctx.values.permissions);
      const ix = await ctx.client.updateRoleInstruction({ mint, holder, permissions, authority: ctx.authority });
      await submit(ctx, `set the role of ${holder.toBase58()} to ${permissionNames(permissions).join(", ")}`, [[ix]]);
    },
  },
  {
    name: "role revoke",
    usage: "<mint> <holder>",
    summary: "take a role away",
    group: "Roles (the policy authority)",
    multisig: true,
    async run(ctx, [m, h]) {
      const mint = address(m, "mint");
      const holder = address(h, "holder");
      await submit(ctx, `take the role of ${holder.toBase58()} away`, [
        [await ctx.client.revokeRoleInstruction({ mint, holder, authority: ctx.authority })],
      ]);
    },
  },
  {
    name: "role renounce",
    usage: "<mint>",
    summary: "give up your own role (the keypair, or the multisig, is the holder)",
    group: "Roles (the policy authority)",
    multisig: true,
    async run(ctx, [m]) {
      const mint = address(m, "mint");
      await submit(ctx, `give up the role of ${ctx.authority.toBase58()}`, [
        [await ctx.client.renounceRoleInstruction(mint, ctx.authority)],
      ]);
    },
  },
  {
    name: "role list",
    usage: "<mint>",
    summary: "every role",
    group: "Roles (the policy authority)",
    async run(ctx, [m]) {
      const roles = await ctx.client.listRoles(address(m, "mint"));
      if (ctx.values.json) return json(ctx, roles.map((r) => ({ ...r, permissionNames: permissionNames(r.permissions) })));
      if (roles.length === 0) return ctx.io.out("No roles.");
      for (const r of roles) ctx.io.out(`${r.holder.toBase58()}  ${permissionNames(r.permissions).join(", ")}`);
    },
  },

  // Authorities
  {
    name: "authority propose",
    usage: "<mint> <new-authority>",
    summary: "start handing the policy to a new authority; nothing changes until it accepts",
    group: "Authorities (the policy authority)",
    multisig: true,
    async run(ctx, [m, n]) {
      const mint = address(m, "mint");
      const next = address(n, "new authority");
      await submit(ctx, `propose ${next.toBase58()} as the policy authority`, [
        [await ctx.client.proposeAuthorityInstruction(mint, next, ctx.authority)],
      ]);
    },
  },
  {
    name: "authority accept",
    usage: "<mint>",
    summary: "accept a handover (the keypair, or the multisig, is the proposed authority)",
    group: "Authorities (the policy authority)",
    multisig: true,
    async run(ctx, [m]) {
      const mint = address(m, "mint");
      const policy = await policyOrFail(ctx, mint);
      const pending = await ctx.client.getPendingAuthority(mint);
      if (!pending) throw new Error(`no handover of ${mint.toBase58()} is pending`);
      if (!pending.equals(ctx.authority)) {
        throw new UsageError(`the handover waits for ${pending.toBase58()}, not ${ctx.authority.toBase58()}`);
      }
      const ix = await ctx.client.acceptAuthorityInstruction(mint, ctx.authority, policy.authority);
      await submit(ctx, `accept the policy of ${mint.toBase58()}`, [[ix]]);
    },
  },
  {
    name: "authority cancel",
    usage: "<mint>",
    summary: "withdraw a pending handover",
    group: "Authorities (the policy authority)",
    multisig: true,
    async run(ctx, [m]) {
      const mint = address(m, "mint");
      await submit(ctx, `cancel the handover of ${mint.toBase58()}`, [
        [await ctx.client.cancelAuthorityTransferInstruction(mint, ctx.authority)],
      ]);
    },
  },
  {
    name: "freeze-authority set",
    usage: "<mint> <address|none> [--reason <r>] [--case <id>] [--give-up]",
    summary: "hand the mint's freeze authority from Vigilantis to an address, or give it up",
    group: "Authorities (the policy authority)",
    options: [...ENFORCEMENT, "give-up"],
    multisig: true,
    run: (ctx, args) => setAuthority(ctx, args, "freeze"),
  },
  {
    name: "freeze-authority to-vigilantis",
    usage: "<mint>",
    summary: "hand a mint's freeze authority to Vigilantis (the keypair is the current freeze authority)",
    group: "Authorities (the policy authority)",
    multisig: true,
    run: (ctx, args) => toVigilantis(ctx, args, "freeze"),
  },
  {
    name: "pause-authority set",
    usage: "<mint> <address|none> [--reason <r>] [--case <id>] [--give-up]",
    summary: "hand the mint's pause authority from Vigilantis to an address, or give it up",
    group: "Authorities (the policy authority)",
    options: [...ENFORCEMENT, "give-up"],
    multisig: true,
    run: (ctx, args) => setAuthority(ctx, args, "pause"),
  },
  {
    name: "pause-authority to-vigilantis",
    usage: "<mint>",
    summary: "hand a Pausable mint's pause authority to Vigilantis (the keypair is the current pause authority)",
    group: "Authorities (the policy authority)",
    multisig: true,
    run: (ctx, args) => toVigilantis(ctx, args, "pause"),
  },
];

function help(): string {
  const lines = [
    `vigilantis ${version}: run the Vigilantis compliance program from a terminal.`,
    "",
    "Usage: vigilantis <command> [arguments] [options]",
  ];
  let group = "";
  for (const c of COMMANDS) {
    if (c.group !== group) {
      group = c.group;
      lines.push("", group);
    }
    lines.push(`  ${c.name} ${c.usage}`, `      ${c.summary}`);
  }
  lines.push(
    "",
    "Options",
    "  -u, --url <url>         RPC URL, or mainnet-beta, devnet, testnet, localhost. Default: VIGILANTIS_RPC_URL,",
    "                          then the Solana CLI config. Prefer those two for a URL with an API key in it.",
    "  -k, --keypair <path>    The keypair that signs and pays. Default: the Solana CLI config, then",
    "                          ~/.config/solana/id.json.",
    "      --multisig <vault>  Send nothing: print each transaction, signed by the vault, for the multisig",
    "                          to propose. Needs no keypair.",
    "      --json              Machine-readable output.",
    "  -h, --help, -V, --version",
    "",
    "Why and which case (recorded on chain in the EnforcementAction event). Optional, so a freeze or a pause",
    "never waits; seize and forfeit need both, seizure close and forfeiture release need a reason.",
    `      --reason <reason>   ${REASON_NAMES.join(", ")}, or a number 0-65535.`,
    "      --case <id>         The case ID, hashed with a salt from VIGILANTIS_CASE_SALT or --case-salt-file <path>,",
    "                          so the chain holds no case number. Keep the salt private and always the same.",
    "      --case-ref <hex>    The 32-byte case reference itself, as `case-ref` or `seizure list` prints it.",
    "      --amount-commitment <hex>  For forfeit: the 32 bytes `amount-commitment` prints, with its salt from",
    "                          VIGILANTIS_AMOUNT_SALT or --amount-salt-file <path>. Keep that salt private too.",
    "",
    "Amounts are in base units. Exit codes: 0 done; 1 failed (the RPC, a refused transaction, or nothing on",
    "chain to act on); 2 a mistake in the command line.",
  );
  return lines.join("\n");
}

// ---- Configuration ----

function solanaConfig(io: CliIo): { url?: string; keypair?: string } {
  let text: string;
  try {
    text = readFileSync(join(io.env.HOME ?? homedir(), ".config", "solana", "cli", "config.yml"), "utf8");
  } catch {
    return {};
  }
  const get = (key: string) => {
    const value = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^(['"])(.*)\1$/, "$2");
    return value || undefined;
  };
  return { url: get("json_rpc_url"), keypair: get("keypair_path") };
}

function expandHome(path: string, io: CliIo): string {
  return path.startsWith("~/") ? join(io.env.HOME ?? homedir(), path.slice(2)) : path;
}

function loadKeypair(path: string): Keypair {
  let bytes: unknown;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new UsageError(`cannot read the keypair file ${path}: ${(e as NodeJS.ErrnoException).code ?? "read error"}`);
  }
  try {
    bytes = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the start of the file, which may be secret.
    throw new UsageError(`${path} is not a JSON keypair file (expected an array of 64 numbers)`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new UsageError(`${path} is not a Solana keypair file`);
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

/** Finds the command: the longest name the positionals start with. */
function findCommand(positionals: string[]): { command: Command; args: string[] } | null {
  for (const words of [2, 1]) {
    const name = positionals.slice(0, words).join(" ");
    const command = COMMANDS.find((c) => c.name === name);
    if (command) return { command, args: positionals.slice(words) };
  }
  return null;
}

// ---- Errors ----

/** A failed call, as one or more lines: the program's error name and message when there is one. */
async function describe(e: unknown, connection: Connection | null, url: string | null): Promise<string[]> {
  let logs: string[] = [];
  if (e instanceof SendTransactionError) {
    logs = (connection ? await e.getLogs(connection).catch(() => null) : null) ?? e.logs ?? [];
  } else if (e && typeof e === "object" && Array.isArray((e as { logs?: unknown }).logs)) {
    logs = (e as { logs: string[] }).logs;
  }
  const anchor = e instanceof AnchorError ? e : AnchorError.parse(logs);
  const redact = (s: string) => (url ? s.split(url).join("<rpc>") : s);
  if (anchor) {
    const { code, number } = anchor.error.errorCode;
    return [redact(`${code} (${number}): ${anchor.error.errorMessage}`)];
  }
  const message = e instanceof Error ? e.message || e.name : String(e);
  const lines = [redact(message.split("\n")[0] || "unknown error")];
  const failures = logs.filter((l) => /error|failed/i.test(l)).slice(-3);
  for (const l of failures) lines.push(`  ${redact(l)}`);
  return lines;
}

// ---- Main ----

/** Runs one command line. Returns the exit code. */
export async function main(argv: string[], io: CliIo = processIo): Promise<number> {
  let connection: Connection | null = null;
  let url: string | null = null;
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const values = parsed.values as Values;
    if (values.version) {
      io.out(version);
      return 0;
    }
    if (values.help || parsed.positionals.length === 0 || parsed.positionals[0] === "help") {
      io.out(help());
      return 0;
    }
    const found = findCommand(parsed.positionals);
    if (!found) throw new UsageError(`unknown command: ${parsed.positionals.slice(0, 2).join(" ")}`);
    const { command, args } = found;

    const allowed = new Set<OptionName>([...GLOBAL_OPTIONS, ...(command.options ?? []), ...(command.multisig ? (["multisig"] as const) : [])]);
    for (const name of Object.keys(values) as OptionName[]) {
      if (allowed.has(name)) continue;
      if (name === "multisig" && command.noMultisig) throw new UsageError(`--multisig: ${command.noMultisig}`);
      throw new UsageError(`--${name} does not apply to \`${command.name}\``);
    }

    if (command.offline) {
      await command.run({ values, io } as Context, args);
      return 0;
    }

    const config = solanaConfig(io);
    const urlValue = (values.url as string | undefined) ?? io.env.VIGILANTIS_RPC_URL ?? config.url;
    if (!urlValue) throw new UsageError("no RPC: pass --url, set VIGILANTIS_RPC_URL, or set one with `solana config set --url`");
    url = CLUSTERS[urlValue] ?? urlValue;
    connection = new Connection(url, "confirmed");

    const multisig = values.multisig !== undefined ? address(String(values.multisig), "--multisig vault") : null;
    const signer = multisig
      ? null
      : loadKeypair(expandHome((values.keypair as string | undefined) ?? config.keypair ?? "~/.config/solana/id.json", io));
    // Export mode signs nothing; the wallet below only satisfies AnchorProvider.
    const wallet = new Wallet(signer ?? Keypair.generate());
    const client = new VigilantisClient(new AnchorProvider(connection, wallet, CONFIRM));
    await command.run(
      { client, connection, signer, authority: multisig ?? signer!.publicKey, multisig, values, io },
      args,
    );
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}`);
      io.err('Run "vigilantis help" for the commands and options.');
      return 2;
    }
    const [first, ...rest] = await describe(e, connection, url);
    io.err(`error: ${first}`);
    for (const line of rest) io.err(line);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
