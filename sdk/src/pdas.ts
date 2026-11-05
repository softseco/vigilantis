// SPDX-License-Identifier: BUSL-1.1
import { PublicKey } from "@solana/web3.js";

export const META_LIST_SEED = Buffer.from("extra-account-metas");
export const POLICY_SEED = Buffer.from("policy");
export const ALLOW_SEED = Buffer.from("allow");
export const BLOCK_SEED = Buffer.from("block");
export const PENDING_AUTHORITY_SEED = Buffer.from("pending-authority");
export const FREEZE_AUTHORITY_SEED = Buffer.from("freeze-authority");

/** PDA that stores a mint's ExtraAccountMetaList (`["extra-account-metas", mint]`). */
export const metaListPda = (mint: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([META_LIST_SEED, mint.toBuffer()], programId)[0];

/** A mint's policy config PDA (`["policy", mint]`). */
export const policyPda = (mint: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([POLICY_SEED, mint.toBuffer()], programId)[0];

/** A wallet's allowlist entry PDA for a mint (`["allow", mint, wallet]`). */
export const allowEntryPda = (mint: PublicKey, wallet: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([ALLOW_SEED, mint.toBuffer(), wallet.toBuffer()], programId)[0];

/** A wallet's blocklist entry PDA for a mint (`["block", mint, wallet]`). */
export const blockEntryPda = (mint: PublicKey, wallet: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([BLOCK_SEED, mint.toBuffer(), wallet.toBuffer()], programId)[0];

/** A mint's pending authority handover (`["pending-authority", mint]`), present between propose and accept. */
export const pendingAuthorityPda = (mint: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([PENDING_AUTHORITY_SEED, mint.toBuffer()], programId)[0];

/**
 * Vigilantis's freeze-authority address for a mint (`["freeze-authority", mint]`). A mint that names
 * it as its freeze authority can have its token accounts frozen and thawed through Vigilantis (2.2).
 */
export const freezeAuthorityPda = (mint: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([FREEZE_AUTHORITY_SEED, mint.toBuffer()], programId)[0];

export const ROLE_SEED = Buffer.from("role");
export const PAUSE_AUTHORITY_SEED = Buffer.from("pause-authority");
export const PERMANENT_DELEGATE_SEED = Buffer.from("permanent-delegate");
export const FREEZE_RECORD_SEED = Buffer.from("freeze-record");
export const SEIZURE_SEED = Buffer.from("seizure");
export const FORFEITURE_SEED = Buffer.from("forfeiture");

/** A role holder's `RoleEntry` for a mint (`["role", mint, holder]`). */
export const rolePda = (mint: PublicKey, holder: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([ROLE_SEED, mint.toBuffer(), holder.toBuffer()], programId)[0];

/**
 * Vigilantis's pause-authority address for a mint (`["pause-authority", mint]`). A Pausable mint
 * that names it as its pause authority can be paused and resumed through Vigilantis.
 */
export const pauseAuthorityPda = (mint: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([PAUSE_AUTHORITY_SEED, mint.toBuffer()], programId)[0];

/**
 * Vigilantis's permanent-delegate address for a mint (`["permanent-delegate", mint]`). A mint that
 * names it as its permanent delegate lets `seize` burn a seized public balance.
 */
export const permanentDelegatePda = (mint: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([PERMANENT_DELEGATE_SEED, mint.toBuffer()], programId)[0];

/** When Vigilantis froze a token account (`["freeze-record", mint, tokenAccount]`). */
export const freezeRecordPda = (mint: PublicKey, tokenAccount: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([FREEZE_RECORD_SEED, mint.toBuffer(), tokenAccount.toBuffer()], programId)[0];

/** An open seizure (`["seizure", mint, tokenAccount, caseRef]`). */
export const seizureRecordPda = (
  mint: PublicKey,
  tokenAccount: PublicKey,
  caseRef: Uint8Array | number[],
  programId: PublicKey,
): PublicKey =>
  PublicKey.findProgramAddressSync(
    [SEIZURE_SEED, mint.toBuffer(), tokenAccount.toBuffer(), Buffer.from(Uint8Array.from(caseRef))],
    programId,
  )[0];

/** A token account frozen for good at the end of a case (`["forfeiture", mint, tokenAccount]`). */
export const forfeitureRecordPda = (mint: PublicKey, tokenAccount: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([FORFEITURE_SEED, mint.toBuffer(), tokenAccount.toBuffer()], programId)[0];
