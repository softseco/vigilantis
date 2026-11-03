// SPDX-License-Identifier: BUSL-1.1
//
// Vigilantis demo — a compliant tokenized asset ("ACME") on Token-2022.
//
// Shows the compliance engine gating real transfers: allowlist, blocklist, a
// per-transfer limit, and a live policy update. Run against a local validator
// with the Vigilantis program deployed:
//
//   Terminal 1:  cd ~/vigilantis && anchor localnet
//   Terminal 2:  cd ~/vigilantis/sdk && npm run demo
//
// The demo funds its own wallet via airdrop, so nothing needs pre-funding.
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { VigilantisClient } from "../src";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const DECIMALS = 0;

const line = (s = "") => console.log(s);
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const issuer = Keypair.generate();

  line("┌──────────────────────────────────────────────────────────┐");
  line("│   Vigilantis — Compliant Tokenized Asset demo (ACME)       │");
  line("└──────────────────────────────────────────────────────────┘");

  const airdrop = await connection.requestAirdrop(issuer.publicKey, 5 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(airdrop, "confirmed");

  const provider = new AnchorProvider(connection, new Wallet(issuer), { commitment: "confirmed" });
  const vigilantis = new VigilantisClient(provider);

  // Cast of holders.
  const alice = Keypair.generate(); // KYC'd, allowlisted
  const bob = Keypair.generate(); // KYC'd, allowlisted
  const carol = Keypair.generate(); // not KYC'd, NOT allowlisted
  const mallory = Keypair.generate(); // KYC'd, then sanctioned
  const mintKp = Keypair.generate();

  step("1. Issue the ACME security token (Token-2022 + Vigilantis transfer hook)");
  await vigilantis.createCompliantMint({ mint: mintKp, decimals: DECIMALS });
  const mint = mintKp.publicKey;
  line(`   mint: ${mint.toBase58()}`);

  step("2. Set the compliance policy — allowlist ON, blocklist ON, max 1000 / transfer");
  // `allowConfidential: false` is what makes the limit meaningful: a confidential transfer
  // reaches the hook with an encrypted amount (Token-2022 passes u64::MAX), so a per-transfer
  // limit cannot be checked against it. With the flag off, such transfers are rejected rather
  // than waved through. Set it to true only if the limit is allowed not to apply to them.
  await vigilantis.initializePolicy({
    mint, allowlist: true, blocklist: true, maxTransferAmount: 1000, allowConfidential: false,
  });
  await vigilantis.initializeExtraAccountMetaList(mint);

  step("3. Mint 10,000 ACME to the issuer");
  const issuerAta = await getOrCreateAssociatedTokenAccount(
    connection, issuer, mint, issuer.publicKey, true, "confirmed", undefined, TOKEN_2022_PROGRAM_ID
  );
  await mintTo(
    connection, issuer, mint, issuerAta.address, issuer.publicKey, 10_000, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  step("4. Open investor accounts + KYC (allowlist) Alice, Bob, Mallory");
  for (const who of [alice, bob, carol, mallory]) {
    await getOrCreateAssociatedTokenAccount(
      connection, issuer, mint, who.publicKey, true, "confirmed", undefined, TOKEN_2022_PROGRAM_ID
    );
  }
  await vigilantis.addToAllowlist(mint, alice.publicKey);
  await vigilantis.addToAllowlist(mint, bob.publicKey);
  await vigilantis.addToAllowlist(mint, mallory.publicKey);
  line("   allowlisted: Alice, Bob, Mallory    not allowlisted: Carol");

  step("5. Move the asset under the policy");
  await attempt(vigilantis, mint, "Issuer → Alice    500   (allowlisted, within limit)", alice.publicKey, 500);
  await attempt(vigilantis, mint, "Issuer → Carol    500   (not allowlisted)", carol.publicKey, 500, "recipient not allowlisted");
  await attempt(vigilantis, mint, "Issuer → Alice   2000   (over the 1000 limit)", alice.publicKey, 2000, "exceeds transfer limit");

  step("6. Mallory is sanctioned → added to the blocklist");
  await vigilantis.addToBlocklist(mint, mallory.publicKey);
  await attempt(vigilantis, mint, "Issuer → Mallory  100   (allowlisted BUT sanctioned)", mallory.publicKey, 100, "recipient sanctioned");

  step("7. Issuer raises the per-transfer limit to 5000 (live policy update)");
  await vigilantis.updatePolicy({
    mint, allowlist: true, blocklist: true, maxTransferAmount: 5000, allowConfidential: false,
  });
  await attempt(vigilantis, mint, "Issuer → Alice   2000   (now within the new limit)", alice.publicKey, 2000);

  step("Final cap table");
  for (const [name, kp] of [["Alice", alice], ["Bob", bob], ["Carol", carol], ["Mallory", mallory]] as const) {
    line(`   ${name.padEnd(9)} ${await balanceOf(connection, mint, kp.publicKey)} ACME`);
  }
  line("\n✔ A cap table enforced on-chain — Vigilantis decided every transfer.\n");
}

async function attempt(
  vigilantis: VigilantisClient,
  mint: PublicKey,
  label: string,
  destinationOwner: PublicKey,
  amount: number,
  blockedReason?: string
) {
  try {
    await vigilantis.transfer({ mint, destinationOwner, amount, decimals: DECIMALS });
    console.log(`   \x1b[32m✅ ${label}\x1b[0m`);
  } catch {
    console.log(`   \x1b[31m⛔ ${label}\x1b[0m  → ${blockedReason ?? "blocked"}`);
  }
}

async function balanceOf(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<string> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  try {
    const acc = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
    return acc.amount.toString().padStart(5);
  } catch {
    return "    0";
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
