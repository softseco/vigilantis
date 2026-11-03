// SPDX-License-Identifier: BUSL-1.1
import { AnchorProvider, BN, BorshCoder, EventParser, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AuthorityType,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
  getPausableConfig,
  unpackAccount,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha2";
import idl from "./idl/vigilantis.json";
import type { Vigilantis } from "./idl/vigilantis";
import {
  allowEntryPda,
  blockEntryPda,
  freezeAuthorityPda,
  freezeRecordPda,
  metaListPda,
  pauseAuthorityPda,
  pendingAuthorityPda,
  permanentDelegatePda,
  policyPda,
  rolePda,
  seizureRecordPda,
} from "./pdas";

const CONFIRM = { commitment: "confirmed" as const };

/**
 * How many allow or block list changes the batch helpers put in one transaction. Each one creates
 * or closes an account, so this stays well inside the transaction size and compute limits.
 */
export const MAX_LIST_UPDATES_PER_TX = 8;

/** How many freezes or thaws the wallet helpers put in one transaction. */
export const MAX_FREEZES_PER_TX = 8;

/** The largest serialized transaction Solana accepts, in bytes. */
export const MAX_TRANSACTION_BYTES = 1232;

/**
 * The serialized size of a legacy transaction of `ixs` paid by `feePayer`, signatures included.
 * Counted from the compiled message, because `Transaction.serialize` refuses (throws) above the limit.
 */
export function transactionSize(ixs: TransactionInstruction[], feePayer: PublicKey): number {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer;
  tx.recentBlockhash = PublicKey.default.toBase58();
  const message = tx.compileMessage();
  const signatures = message.header.numRequiredSignatures;
  const shortVecLength = signatures < 0x80 ? 1 : signatures < 0x4000 ? 2 : 3;
  return shortVecLength + 64 * signatures + message.serialize().length;
}

/**
 * Split `ixs` into transactions of at most `maxCount` instructions and at most `maxBytes` bytes
 * each, keeping their order. Freezes differ in size (a role holder adds a signature), so counting
 * alone is not enough: eight freezes are about 1,270 bytes, over the limit.
 */
export function packInstructions(
  ixs: TransactionInstruction[],
  feePayer: PublicKey,
  maxCount: number,
  maxBytes: number = MAX_TRANSACTION_BYTES,
): TransactionInstruction[][] {
  const groups: TransactionInstruction[][] = [];
  let current: TransactionInstruction[] = [];
  for (const ix of ixs) {
    const next = [...current, ix];
    if (current.length > 0 && (current.length === maxCount || transactionSize(next, feePayer) > maxBytes)) {
      groups.push(current);
      current = [ix];
    } else {
      current = next;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Why a wallet was blocked or unblocked, or a token account frozen or thawed. Vigilantis does not
 * interpret either field; both go into the `enforcementAction` event.
 *
 * - `reasonCode`: the issuer's own code, 0 to 65535. `ENFORCEMENT_REASONS` is a suggested set.
 * - `caseRef`: 32 bytes pointing to the issuer's case file. Use `caseRef(caseId, salt)`, so the
 *   chain holds a hash and no personal data, and only someone with the salt can match it.
 */
export interface Enforcement {
  reasonCode: number;
  caseRef: Uint8Array | number[];
}

/** A suggested set of reason codes. Issuers may use their own; Vigilantis only records the number. */
export const ENFORCEMENT_REASONS = {
  unspecified: 0,
  sanctions: 1,
  courtOrder: 2,
  authorityRequest: 3,
  fraud: 4,
  stolenFunds: 5,
  internalReview: 6,
  /** For an unblock or a thaw: the case is closed. */
  caseClosed: 7,
} as const;

/**
 * A 32-byte case reference for `Enforcement.caseRef`: SHA-256 of `salt` followed by `caseId`.
 * Keep the salt private: with it, the issuer (or its supervisor) can show which case an on-chain
 * action belongs to; without it, nobody can guess the case number from the hash.
 */
export function caseRef(caseId: string, salt: string | Uint8Array): Uint8Array {
  const saltBytes = typeof salt === "string" ? Buffer.from(salt, "utf8") : Buffer.from(salt);
  return sha256(Buffer.concat([saltBytes, Buffer.from(caseId, "utf8")]));
}

/**
 * The permissions a role can hold (bits of `RoleView.permissions`). Combine them with `|`. The policy
 * authority (the admin) can always do everything; only the admin manages roles, the policy and the
 * authorities.
 */
export const PERMISSIONS = {
  /** `add_to_allowlist`, `remove_from_allowlist`. */
  allowlist: 1 << 0,
  /** `add_to_blocklist`, `block_wallet`. */
  block: 1 << 1,
  /** `remove_from_blocklist`, `unblock_wallet`. */
  unblock: 1 << 2,
  /** `freeze_token_account`. */
  freeze: 1 << 3,
  /** `thaw_token_account`. */
  thaw: 1 << 4,
  /** `pause`. */
  pause: 1 << 5,
  /** `resume`. */
  resume: 1 << 6,
  /** `seize`. */
  seize: 1 << 7,
  /** `close_seizure`. */
  closeSeizure: 1 << 8,
  /** Every permission. */
  all: (1 << 9) - 1,
} as const;

/** How long an account must have been frozen through Vigilantis before `seize` (24 hours). */
export const SEIZE_DELAY_SECONDS = 24 * 60 * 60;

/** How a seizure ended, recorded by `close_seizure`. */
export type SeizureOutcome = "returnedToOwner" | "paidToVictim" | "paidToState" | "other";

/** A role: `holder` may do the actions in `permissions` for `mint`. */
export interface RoleView {
  address: PublicKey;
  mint: PublicKey;
  holder: PublicKey;
  permissions: number;
  /** The policy's role epoch when the role was granted or last updated. */
  epoch: number;
  /**
   * Whether the role works: false for a role granted before the policy last changed hands. The
   * new authority brings it back with `updateRole`, or removes it with `revokeRole`.
   */
  active: boolean;
}

/** When Vigilantis last froze a token account, and from when `seize` may act on it. */
export interface FreezeRecordView {
  tokenAccount: PublicKey;
  /** Unix time of the freeze, in seconds. */
  frozenAt: number;
  slot: bigint;
  /** `frozenAt + SEIZE_DELAY_SECONDS`. */
  seizableFrom: number;
}

/** An open seizure, until `close_seizure`. */
export interface SeizureView {
  address: PublicKey;
  mint: PublicKey;
  wallet: PublicKey;
  tokenAccount: PublicKey;
  amount: bigint;
  reasonCode: number;
  caseRef: Uint8Array;
  authority: PublicKey;
  /** Unix time of the seizure, in seconds. */
  seizedAt: number;
  slot: bigint;
}

/** A token account of a mint and whether it is frozen. */
export interface TokenAccountView {
  address: PublicKey;
  owner: PublicKey;
  amount: bigint;
  frozen: boolean;
}

/**
 * An event emitted by the program, decoded from transaction logs. `name` is camelCase, for
 * example `transferRefused`, `policyUpdated`, `listEntryAdded` or `authorityTransferred`.
 */
export interface VigilantisEvent {
  name: string;
  data: Record<string, unknown>;
}

type ListName = "allow" | "block";
type ListAction = "add" | "remove";

/** A decoded view of a mint's compliance policy. */
export interface PolicyView {
  mint: PublicKey;
  authority: PublicKey;
  allowlistEnabled: boolean;
  blocklistEnabled: boolean;
  maxTransferAmount: bigint;
  /**
   * Whether confidential transfers are permitted on a mint that also sets
   * `maxTransferAmount`. The hook cannot see an encrypted amount, so the limit
   * is unenforceable for those transfers and the issuer opts in explicitly.
   */
  allowConfidential: boolean;
}

/**
 * Client for the Vigilantis compliance program. Wraps mint creation, policy
 * management, allow/blocklist entries, hook-aware transfers, and reads.
 */
export class VigilantisClient {
  readonly program: Program<Vigilantis>;
  readonly provider: AnchorProvider;
  readonly programId: PublicKey;

  constructor(provider: AnchorProvider) {
    this.provider = provider;
    this.program = new Program<Vigilantis>(idl as Vigilantis, provider);
    this.programId = this.program.programId;
  }

  // ---- PDA helpers ----
  policy(mint: PublicKey): PublicKey {
    return policyPda(mint, this.programId);
  }
  metaList(mint: PublicKey): PublicKey {
    return metaListPda(mint, this.programId);
  }
  allowEntry(mint: PublicKey, wallet: PublicKey): PublicKey {
    return allowEntryPda(mint, wallet, this.programId);
  }
  blockEntry(mint: PublicKey, wallet: PublicKey): PublicKey {
    return blockEntryPda(mint, wallet, this.programId);
  }
  pendingAuthority(mint: PublicKey): PublicKey {
    return pendingAuthorityPda(mint, this.programId);
  }
  /** Vigilantis's freeze-authority address for `mint` (2.2). */
  freezeAuthority(mint: PublicKey): PublicKey {
    return freezeAuthorityPda(mint, this.programId);
  }
  /** Vigilantis's pause-authority address for `mint`. */
  pauseAuthority(mint: PublicKey): PublicKey {
    return pauseAuthorityPda(mint, this.programId);
  }
  /** Vigilantis's permanent-delegate address for `mint`. */
  permanentDelegate(mint: PublicKey): PublicKey {
    return permanentDelegatePda(mint, this.programId);
  }
  /** `holder`'s `RoleEntry` address for `mint`. */
  role(mint: PublicKey, holder: PublicKey): PublicKey {
    return rolePda(mint, holder, this.programId);
  }
  /** The `FreezeRecord` address of a token account. */
  freezeRecord(mint: PublicKey, tokenAccount: PublicKey): PublicKey {
    return freezeRecordPda(mint, tokenAccount, this.programId);
  }
  /** The `SeizureRecord` address of a seizure. */
  seizureRecord(mint: PublicKey, tokenAccount: PublicKey, caseRef: Uint8Array | number[]): PublicKey {
    return seizureRecordPda(mint, tokenAccount, caseRef, this.programId);
  }

  private get connection() {
    return this.provider.connection;
  }
  private get payer(): Signer {
    return (this.provider.wallet as unknown as { payer: Signer }).payer;
  }

  /**
   * Create a Token-2022 mint whose transfer hook is Vigilantis. Signs with `mint`.
   *
   * `freezeAuthority: "vigilantis"` names Vigilantis's freeze-authority address, so the policy
   * authority can freeze and thaw token accounts through Vigilantis. The default is no freeze
   * authority, as before 2.2; a freeze authority cannot be added to a mint created without one.
   *
   * Two extensions can only be added here, at creation:
   * - `pausable: true` adds Token-2022's Pausable extension with Vigilantis's pause-authority
   *   address as its authority, so `pause` and `resume` work;
   * - `permanentDelegate: true` names Vigilantis's permanent-delegate address, so `seize` can burn
   *   a seized public balance. Explorers show that a mint has a permanent delegate.
   *
   * For `seize`, use both with `freezeAuthority: "vigilantis"`.
   */
  async createCompliantMint(params: {
    mint: Keypair;
    decimals: number;
    mintAuthority?: PublicKey;
    freezeAuthority?: PublicKey | "vigilantis" | null;
    pausable?: boolean;
    permanentDelegate?: boolean;
    /**
     * Who may change the mint's transfer hook: point it at another program, or at none, which
     * switches every Vigilantis rule off. Default: the provider wallet. Use the issuer's multisig,
     * or `null` so that nobody can ever change it (Vigilantis itself can still be upgraded in place).
     */
    transferHookAuthority?: PublicKey | null;
  }): Promise<PublicKey> {
    const mint = params.mint.publicKey;
    const authority = params.mintAuthority ?? this.payer.publicKey;
    const hookAuthority = params.transferHookAuthority === undefined ? this.payer.publicKey : params.transferHookAuthority;
    const freezeAuthority =
      params.freezeAuthority === "vigilantis" ? this.freezeAuthority(mint) : (params.freezeAuthority ?? null);
    const extensions = [ExtensionType.TransferHook];
    const extensionIxs = [
      createInitializeTransferHookInstruction(mint, hookAuthority ?? PublicKey.default, this.programId, TOKEN_2022_PROGRAM_ID),
    ];
    if (params.permanentDelegate) {
      extensions.push(ExtensionType.PermanentDelegate);
      extensionIxs.push(
        createInitializePermanentDelegateInstruction(mint, this.permanentDelegate(mint), TOKEN_2022_PROGRAM_ID),
      );
    }
    if (params.pausable) {
      extensions.push(ExtensionType.PausableConfig);
      extensionIxs.push(createInitializePausableConfigInstruction(mint, this.pauseAuthority(mint), TOKEN_2022_PROGRAM_ID));
    }
    const mintLen = getMintLen(extensions);
    const lamports = await this.connection.getMinimumBalanceForRentExemption(mintLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: this.payer.publicKey,
        newAccountPubkey: params.mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      ...extensionIxs,
      createInitializeMintInstruction(
        params.mint.publicKey,
        params.decimals,
        authority,
        freezeAuthority,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(this.connection, tx, [this.payer, params.mint], CONFIRM);
    return params.mint.publicKey;
  }

  /** Create the mint's policy. The provider wallet becomes its authority. */
  initializePolicy(params: {
    mint: PublicKey;
    allowlist: boolean;
    blocklist: boolean;
    maxTransferAmount: bigint | number;
    /** Permit confidential transfers even though the limit cannot apply to them. */
    allowConfidential?: boolean;
  }): Promise<string> {
    return this.program.methods
      .initializePolicy(
        params.allowlist,
        params.blocklist,
        new BN(params.maxTransferAmount.toString()),
        params.allowConfidential ?? false,
      )
      .accountsPartial({
        authority: this.payer.publicKey,
        mint: params.mint,
        policyConfig: this.policy(params.mint),
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
  }

  /** Update the mint's policy (authority only). */
  updatePolicy(params: {
    mint: PublicKey;
    allowlist: boolean;
    blocklist: boolean;
    maxTransferAmount: bigint | number;
    /** Permit confidential transfers even though the limit cannot apply to them. */
    allowConfidential?: boolean;
  }): Promise<string> {
    return this.program.methods
      .updatePolicy(
        params.allowlist,
        params.blocklist,
        new BN(params.maxTransferAmount.toString()),
        params.allowConfidential ?? false,
      )
      .accountsPartial({
        authority: this.payer.publicKey,
        mint: params.mint,
        policyConfig: this.policy(params.mint),
      })
      .rpc(CONFIRM);
  }

  /** Initialize the mint's ExtraAccountMetaList so Token-2022 invokes the hook. */
  initializeExtraAccountMetaList(mint: PublicKey): Promise<string> {
    return this.program.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({
        payer: this.payer.publicKey,
        extraAccountMetaList: this.metaList(mint),
        mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
  }

  async addToAllowlist(mint: PublicKey, wallet: PublicKey): Promise<string> {
    return this.send([await this.listInstruction({ mint, wallet, list: "allow", action: "add" })]);
  }


  async removeFromAllowlist(mint: PublicKey, wallet: PublicKey): Promise<string> {
    return this.send([await this.listInstruction({ mint, wallet, list: "allow", action: "remove" })]);
  }


  async addToBlocklist(mint: PublicKey, wallet: PublicKey): Promise<string> {
    return this.send([await this.listInstruction({ mint, wallet, list: "block", action: "add" })]);
  }


  async removeFromBlocklist(mint: PublicKey, wallet: PublicKey): Promise<string> {
    return this.send([await this.listInstruction({ mint, wallet, list: "block", action: "remove" })]);
  }


  // ---- Instruction builders ----
  //
  // Every authority-gated instruction, with the authority as a parameter. Use these when the
  // policy authority is a multisig (for example a Squads vault): build the instruction with the
  // vault's address as `authority` and propose it in the multisig instead of signing here.
  //
  // `authority` can also be a role holder for the actions its role allows. The builders pass the
  // signer's `RoleEntry` when one exists (one account lookup), so the same call works for the
  // admin and for a role holder.

  /** The signer's `RoleEntry` for `mint` if it exists, else `null` (the admin needs none). */
  private async roleAccount(mint: PublicKey, signer: PublicKey): Promise<PublicKey | null> {
    const address = this.role(mint, signer);
    const info = await this.connection.getAccountInfo(address, "confirmed");
    return info && info.owner.equals(this.programId) ? address : null;
  }

  /** `update_policy`, signed by `authority` (default: the provider wallet). */
  updatePolicyInstruction(params: {
    mint: PublicKey;
    allowlist: boolean;
    blocklist: boolean;
    maxTransferAmount: bigint | number;
    allowConfidential?: boolean;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    return this.program.methods
      .updatePolicy(
        params.allowlist,
        params.blocklist,
        new BN(params.maxTransferAmount.toString()),
        params.allowConfidential ?? false,
      )
      .accountsPartial({
        authority: params.authority ?? this.payer.publicKey,
        mint: params.mint,
        policyConfig: this.policy(params.mint),
      })
      .instruction();
  }

  /** Add or remove one wallet on the allowlist or blocklist, signed by `authority`. */
  async listInstruction(params: {
    mint: PublicKey;
    wallet: PublicKey;
    list: ListName;
    action: ListAction;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint, wallet } = params;
    const authority = params.authority ?? this.payer.publicKey;
    const base = {
      authority,
      mint,
      policyConfig: this.policy(mint),
      wallet,
      role: await this.roleAccount(mint, authority),
    };
    if (params.list === "allow") {
      const allowEntry = this.allowEntry(mint, wallet);
      return params.action === "add"
        ? this.program.methods
            .addToAllowlist()
            .accountsPartial({ ...base, allowEntry, systemProgram: SystemProgram.programId })
            .instruction()
        : this.program.methods.removeFromAllowlist().accountsPartial({ ...base, allowEntry }).instruction();
    }
    const blockEntry = this.blockEntry(mint, wallet);
    return params.action === "add"
      ? this.program.methods
          .addToBlocklist()
          .accountsPartial({ ...base, blockEntry, systemProgram: SystemProgram.programId })
          .instruction()
      : this.program.methods.removeFromBlocklist().accountsPartial({ ...base, blockEntry }).instruction();
  }

  /** `propose_authority`: start handing the policy to `newAuthority`. */
  proposeAuthorityInstruction(
    mint: PublicKey,
    newAuthority: PublicKey,
    authority: PublicKey = this.payer.publicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .proposeAuthority(newAuthority)
      .accountsPartial({
        authority,
        mint,
        policyConfig: this.policy(mint),
        pendingAuthority: this.pendingAuthority(mint),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** `accept_authority`, signed by the proposed authority. `previousAuthority` gets the proposal's rent back. */
  acceptAuthorityInstruction(
    mint: PublicKey,
    newAuthority: PublicKey,
    previousAuthority: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .acceptAuthority()
      .accountsPartial({
        newAuthority,
        previousAuthority,
        mint,
        policyConfig: this.policy(mint),
        pendingAuthority: this.pendingAuthority(mint),
      })
      .instruction();
  }

  /** `cancel_authority_transfer`, signed by the current authority. */
  cancelAuthorityTransferInstruction(
    mint: PublicKey,
    authority: PublicKey = this.payer.publicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .cancelAuthorityTransfer()
      .accountsPartial({
        authority,
        mint,
        policyConfig: this.policy(mint),
        pendingAuthority: this.pendingAuthority(mint),
      })
      .instruction();
  }

  /** `update_extra_account_meta_list`, signed by the policy authority (who pays any extra rent). */
  updateExtraAccountMetaListInstruction(
    mint: PublicKey,
    authority: PublicKey = this.payer.publicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .updateExtraAccountMetaList()
      .accountsPartial({
        authority,
        mint,
        policyConfig: this.policy(mint),
        extraAccountMetaList: this.metaList(mint),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** `block_wallet` (`add_to_blocklist` that records why), signed by `authority`. */
  async blockWalletInstruction(params: {
    mint: PublicKey;
    wallet: PublicKey;
    enforcement: Enforcement;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint, wallet } = params;
    const authority = params.authority ?? this.payer.publicKey;
    const [reasonCode, ref] = enforcementArgs(params.enforcement);
    return this.program.methods
      .blockWallet(reasonCode, ref)
      .accountsPartial({
        authority,
        mint,
        policyConfig: this.policy(mint),
        wallet,
        blockEntry: this.blockEntry(mint, wallet),
        systemProgram: SystemProgram.programId,
        role: await this.roleAccount(mint, authority),
      })
      .instruction();
  }

  /** `unblock_wallet` (`remove_from_blocklist` that records why), signed by `authority`. */
  async unblockWalletInstruction(params: {
    mint: PublicKey;
    wallet: PublicKey;
    enforcement: Enforcement;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint, wallet } = params;
    const authority = params.authority ?? this.payer.publicKey;
    const [reasonCode, ref] = enforcementArgs(params.enforcement);
    return this.program.methods
      .unblockWallet(reasonCode, ref)
      .accountsPartial({
        authority,
        mint,
        policyConfig: this.policy(mint),
        wallet,
        blockEntry: this.blockEntry(mint, wallet),
        role: await this.roleAccount(mint, authority),
      })
      .instruction();
  }

  /**
   * `freeze_token_account` or `thaw_token_account` for one token account, signed by `authority`. A
   * freeze also writes the account's `FreezeRecord` (the signer pays its rent), which `seize` needs;
   * a thaw deletes it and returns the rent to the signer.
   */
  async freezeInstruction(params: {
    mint: PublicKey;
    tokenAccount: PublicKey;
    enforcement: Enforcement;
    thaw?: boolean;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint } = params;
    const authority = params.authority ?? this.payer.publicKey;
    const [reasonCode, ref] = enforcementArgs(params.enforcement);
    const accounts = {
      authority,
      mint,
      policyConfig: this.policy(mint),
      tokenAccount: params.tokenAccount,
      freezeAuthority: this.freezeAuthority(mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      freezeRecord: this.freezeRecord(mint, params.tokenAccount),
      systemProgram: SystemProgram.programId,
      role: await this.roleAccount(mint, authority),
    };
    return params.thaw
      ? this.program.methods.thawTokenAccount(reasonCode, ref).accountsPartial(accounts).instruction()
      : this.program.methods.freezeTokenAccount(reasonCode, ref).accountsPartial(accounts).instruction();
  }

  /**
   * `set_freeze_authority` (2.3), signed by `authority`: Vigilantis hands the mint's freeze authority
   * to `newFreezeAuthority`, or gives it up for good with `null`. Check the address twice: once it
   * is set, only that address can freeze, thaw or hand the authority on.
   */
  setFreezeAuthorityInstruction(params: {
    mint: PublicKey;
    newFreezeAuthority: PublicKey | null;
    enforcement: Enforcement;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint, newFreezeAuthority } = params;
    const [reasonCode, ref] = enforcementArgs(params.enforcement);
    if (newFreezeAuthority !== null) {
      if (newFreezeAuthority.equals(PublicKey.default)) {
        throw new Error("newFreezeAuthority is the default address; pass null to give the freeze authority up");
      }
      if (newFreezeAuthority.equals(this.freezeAuthority(mint))) {
        throw new Error("newFreezeAuthority is Vigilantis's own freeze-authority address; nothing would change");
      }
      if (this.isVigilantisAddress(mint, newFreezeAuthority)) {
        throw new Error("newFreezeAuthority is one of Vigilantis's addresses for this mint, which can never sign a freeze");
      }
    }
    return this.program.methods
      .setFreezeAuthority(newFreezeAuthority, reasonCode, ref)
      .accountsPartial({
        authority: params.authority ?? this.payer.publicKey,
        mint,
        policyConfig: this.policy(mint),
        freezeAuthority: this.freezeAuthority(mint),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  }

  // ---- Enforcement (provider wallet as the policy authority) ----

  /** Blocklist `wallet`, recording why. */
  async blockWallet(mint: PublicKey, wallet: PublicKey, enforcement: Enforcement): Promise<string> {
    return this.send([await this.blockWalletInstruction({ mint, wallet, enforcement })]);
  }

  /** Remove `wallet` from the blocklist, recording why. */
  async unblockWallet(mint: PublicKey, wallet: PublicKey, enforcement: Enforcement): Promise<string> {
    return this.send([await this.unblockWalletInstruction({ mint, wallet, enforcement })]);
  }

  /** Freeze one token account. The mint's freeze authority must be `freezeAuthority(mint)`. */
  async freezeTokenAccount(mint: PublicKey, tokenAccount: PublicKey, enforcement: Enforcement): Promise<string> {
    return this.send([await this.freezeInstruction({ mint, tokenAccount, enforcement })]);
  }

  /** Thaw one token account. */
  async thawTokenAccount(mint: PublicKey, tokenAccount: PublicKey, enforcement: Enforcement): Promise<string> {
    return this.send([await this.freezeInstruction({ mint, tokenAccount, enforcement, thaw: true })]);
  }

  /**
   * Freeze every token account of `mint` that `owner` holds and that is not frozen yet, as many
   * to a transaction as fit (at most `MAX_FREEZES_PER_TX`). A wallet can hold several accounts of one mint; the
   * blocklist covers the wallet, but freezing is per account. Returns the signatures.
   */
  async freezeWallet(mint: PublicKey, owner: PublicKey, enforcement: Enforcement): Promise<string[]> {
    const accounts = (await this.tokenAccountsOf(mint, owner)).filter((a) => !a.frozen);
    return this.freezeBatch(mint, accounts.map((a) => a.address), enforcement, false);
  }

  /** Thaw every frozen token account of `mint` that `owner` holds. */
  async thawWallet(mint: PublicKey, owner: PublicKey, enforcement: Enforcement): Promise<string[]> {
    const accounts = (await this.tokenAccountsOf(mint, owner)).filter((a) => a.frozen);
    return this.freezeBatch(mint, accounts.map((a) => a.address), enforcement, true);
  }

  /**
   * Blocklist `wallet` and freeze its token accounts of `mint`. The block and as many freezes as
   * fit go in one transaction, so the wallet is never blocked without its first accounts frozen
   * too. Fails if the wallet is already blocklisted; use
   * `freezeWallet` then. Returns the signatures.
   */
  async blockAndFreezeWallet(mint: PublicKey, wallet: PublicKey, enforcement: Enforcement): Promise<string[]> {
    const accounts = (await this.tokenAccountsOf(mint, wallet)).filter((a) => !a.frozen).map((a) => a.address);
    const freezes = await Promise.all(accounts.map((tokenAccount) => this.freezeInstruction({ mint, tokenAccount, enforcement })));
    const [first, ...rest] = packInstructions(
      [await this.blockWalletInstruction({ mint, wallet, enforcement }), ...freezes],
      this.payer.publicKey,
      MAX_FREEZES_PER_TX,
    );
    const signatures = [await this.send(first)];
    for (const ixs of rest) signatures.push(await this.send(ixs));
    return signatures;
  }

  /**
   * Hand the mint's freeze authority to Vigilantis, so the policy authority can freeze and thaw
   * through it. `currentFreezeAuthority` must sign. Works only on a mint that has a freeze
   * authority; one created without can never get one.
   */
  setVigilantisAsFreezeAuthority(mint: PublicKey, currentFreezeAuthority: Signer): Promise<string> {
    const ix = createSetAuthorityInstruction(
      mint,
      currentFreezeAuthority.publicKey,
      AuthorityType.FreezeAccount,
      this.freezeAuthority(mint),
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const extra = currentFreezeAuthority.publicKey.equals(this.payer.publicKey) ? [] : [currentFreezeAuthority];
    return this.send([ix], extra);
  }

  /**
   * Hand the mint's freeze authority from Vigilantis to `newFreezeAuthority`, or give it up for good
   * with `null` (2.3), recording why. Vigilantis then can no longer freeze or thaw; the new holder can
   * hand it back with `setVigilantisAsFreezeAuthority`.
   */
  async setFreezeAuthority(
    mint: PublicKey,
    newFreezeAuthority: PublicKey | null,
    enforcement: Enforcement,
  ): Promise<string> {
    return this.send([await this.setFreezeAuthorityInstruction({ mint, newFreezeAuthority, enforcement })]);
  }

  /** The mint's freeze authority, or `null` if it has none. */
  async getFreezeAuthority(mint: PublicKey): Promise<PublicKey | null> {
    return (await getMint(this.connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).freezeAuthority;
  }

  /** Every token account of `mint` held by `owner`, with its state. */
  async tokenAccountsOf(mint: PublicKey, owner: PublicKey): Promise<TokenAccountView[]> {
    const { value } = await this.connection.getTokenAccountsByOwner(owner, { mint }, "confirmed");
    return value.map(({ pubkey, account }) => {
      const parsed = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
      return { address: pubkey, owner: parsed.owner, amount: parsed.amount, frozen: parsed.isFrozen };
    });
  }

  /** Whether a token account is frozen. */
  async isFrozen(tokenAccount: PublicKey): Promise<boolean> {
    return (await getAccount(this.connection, tokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID)).isFrozen;
  }

  private async freezeBatch(
    mint: PublicKey,
    tokenAccounts: PublicKey[],
    enforcement: Enforcement,
    thaw: boolean,
  ): Promise<string[]> {
    const ixs = await Promise.all(tokenAccounts.map((tokenAccount) => this.freezeInstruction({ mint, tokenAccount, enforcement, thaw })));
    const signatures: string[] = [];
    for (const group of packInstructions(ixs, this.payer.publicKey, MAX_FREEZES_PER_TX)) signatures.push(await this.send(group));
    return signatures;
  }

  // ---- Roles ----

  /** `grant_role`: give `holder` a role with `permissions` (from `PERMISSIONS`), signed by the admin. */
  grantRoleInstruction(params: {
    mint: PublicKey;
    holder: PublicKey;
    permissions: number;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    return this.program.methods
      .grantRole(permissionsArg(params.permissions))
      .accountsPartial({
        authority: params.authority ?? this.payer.publicKey,
        mint: params.mint,
        policyConfig: this.policy(params.mint),
        holder: params.holder,
        role: this.role(params.mint, params.holder),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** `update_role`: change a role's permissions, signed by the admin. */
  updateRoleInstruction(params: {
    mint: PublicKey;
    holder: PublicKey;
    permissions: number;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    return this.program.methods
      .updateRole(permissionsArg(params.permissions))
      .accountsPartial({
        authority: params.authority ?? this.payer.publicKey,
        mint: params.mint,
        policyConfig: this.policy(params.mint),
        role: this.role(params.mint, params.holder),
      })
      .instruction();
  }

  /** `revoke_role`: take a role away, signed by the admin (who gets the rent back). */
  revokeRoleInstruction(params: { mint: PublicKey; holder: PublicKey; authority?: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods
      .revokeRole()
      .accountsPartial({
        authority: params.authority ?? this.payer.publicKey,
        mint: params.mint,
        policyConfig: this.policy(params.mint),
        role: this.role(params.mint, params.holder),
      })
      .instruction();
  }

  /** `renounce_role`: the holder gives up its own role. */
  renounceRoleInstruction(mint: PublicKey, holder: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods
      .renounceRole()
      .accountsPartial({ holder, mint, role: this.role(mint, holder) })
      .instruction();
  }

  /** Give `holder` a role (provider wallet as the admin). */
  async grantRole(mint: PublicKey, holder: PublicKey, permissions: number): Promise<string> {
    return this.send([await this.grantRoleInstruction({ mint, holder, permissions })]);
  }

  /** Change a role's permissions (provider wallet as the admin). */
  async updateRole(mint: PublicKey, holder: PublicKey, permissions: number): Promise<string> {
    return this.send([await this.updateRoleInstruction({ mint, holder, permissions })]);
  }

  /** Take a role away (provider wallet as the admin). */
  async revokeRole(mint: PublicKey, holder: PublicKey): Promise<string> {
    return this.send([await this.revokeRoleInstruction({ mint, holder })]);
  }

  /** Give up `holder`'s own role; `holder` signs. */
  async renounceRole(mint: PublicKey, holder: Signer): Promise<string> {
    return this.send([await this.renounceRoleInstruction(mint, holder.publicKey)], [holder]);
  }

  /** `holder`'s role for `mint`, or `null` if it has none. */
  async getRole(mint: PublicKey, holder: PublicKey): Promise<RoleView | null> {
    const address = this.role(mint, holder);
    const [acc, epoch] = await Promise.all([this.program.account.roleEntry.fetchNullable(address), this.roleEpoch(mint)]);
    return acc
      ? { address, mint: acc.mint, holder: acc.holder, permissions: acc.permissions, epoch: acc.epoch, active: acc.epoch === epoch }
      : null;
  }

  /** Every role of `mint`, including those a handover ended (`active: false`). */
  async listRoles(mint: PublicKey): Promise<RoleView[]> {
    const [all, epoch] = await Promise.all([
      this.program.account.roleEntry.all([{ memcmp: { offset: 8, bytes: mint.toBase58() } }]),
      this.roleEpoch(mint),
    ]);
    return all.map(({ publicKey, account }) => ({
      address: publicKey,
      mint: account.mint,
      holder: account.holder,
      permissions: account.permissions,
      epoch: account.epoch,
      active: account.epoch === epoch,
    }));
  }

  /** The policy's current role epoch (increased by every handover), or null without a policy. */
  private async roleEpoch(mint: PublicKey): Promise<number | null> {
    const policy = await this.program.account.policyConfig.fetchNullable(this.policy(mint));
    return policy ? policy.roleEpoch : null;
  }

  /**
   * Whether `address` is one of Vigilantis's own addresses for `mint`. None of them can sign as a
   * freeze or pause authority for anyone else, so the program refuses to hand an authority to one.
   */
  isVigilantisAddress(mint: PublicKey, address: PublicKey): boolean {
    return [
      this.policy(mint),
      this.metaList(mint),
      this.freezeAuthority(mint),
      this.pauseAuthority(mint),
      this.permanentDelegate(mint),
      pendingAuthorityPda(mint, this.programId),
    ].some((a) => a.equals(address));
  }

  // ---- Pause ----

  /** `pause` or `resume` the whole token, signed by `authority` (the admin or a role holder). */
  async pauseInstruction(params: {
    mint: PublicKey;
    enforcement: Enforcement;
    resume?: boolean;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint } = params;
    const authority = params.authority ?? this.payer.publicKey;
    const [reasonCode, ref] = enforcementArgs(params.enforcement);
    const accounts = {
      authority,
      mint,
      policyConfig: this.policy(mint),
      pauseAuthority: this.pauseAuthority(mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      role: await this.roleAccount(mint, authority),
    };
    return params.resume
      ? this.program.methods.resume(reasonCode, ref).accountsPartial(accounts).instruction()
      : this.program.methods.pause(reasonCode, ref).accountsPartial(accounts).instruction();
  }

  /**
   * `set_pause_authority`, signed by the admin: Vigilantis hands the mint's pause authority to
   * `newPauseAuthority`, or gives it up for good with `null`.
   */
  setPauseAuthorityInstruction(params: {
    mint: PublicKey;
    newPauseAuthority: PublicKey | null;
    enforcement: Enforcement;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint, newPauseAuthority } = params;
    const [reasonCode, ref] = enforcementArgs(params.enforcement);
    if (newPauseAuthority !== null) {
      if (newPauseAuthority.equals(PublicKey.default)) {
        throw new Error("newPauseAuthority is the default address; pass null to give the pause authority up");
      }
      if (newPauseAuthority.equals(this.pauseAuthority(mint))) {
        throw new Error("newPauseAuthority is Vigilantis's own pause-authority address; nothing would change");
      }
      if (this.isVigilantisAddress(mint, newPauseAuthority)) {
        throw new Error("newPauseAuthority is one of Vigilantis's addresses for this mint, which can never sign a pause");
      }
    }
    return this.program.methods
      .setPauseAuthority(newPauseAuthority, reasonCode, ref)
      .accountsPartial({
        authority: params.authority ?? this.payer.publicKey,
        mint,
        policyConfig: this.policy(mint),
        pauseAuthority: this.pauseAuthority(mint),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  }

  /** Pause the whole token: no transfers, mints or burns until `resume`. Freezes and thaws still work. */
  async pause(mint: PublicKey, enforcement: Enforcement): Promise<string> {
    return this.send([await this.pauseInstruction({ mint, enforcement })]);
  }

  /** End a pause. */
  async resume(mint: PublicKey, enforcement: Enforcement): Promise<string> {
    return this.send([await this.pauseInstruction({ mint, enforcement, resume: true })]);
  }

  /** Hand the mint's pause authority from Vigilantis to `newPauseAuthority`, or give it up with `null`. */
  async setPauseAuthority(mint: PublicKey, newPauseAuthority: PublicKey | null, enforcement: Enforcement): Promise<string> {
    return this.send([await this.setPauseAuthorityInstruction({ mint, newPauseAuthority, enforcement })]);
  }

  /** Hand a Pausable mint's pause authority to Vigilantis. `currentPauseAuthority` must sign. */
  setVigilantisAsPauseAuthority(mint: PublicKey, currentPauseAuthority: Signer): Promise<string> {
    const ix = createSetAuthorityInstruction(
      mint,
      currentPauseAuthority.publicKey,
      AuthorityType.PausableConfig,
      this.pauseAuthority(mint),
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const extra = currentPauseAuthority.publicKey.equals(this.payer.publicKey) ? [] : [currentPauseAuthority];
    return this.send([ix], extra);
  }

  /** The mint's pause state, or `null` if it is not Pausable. */
  async getPauseState(mint: PublicKey): Promise<{ authority: PublicKey | null; paused: boolean } | null> {
    const config = getPausableConfig(await getMint(this.connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID));
    if (!config) return null;
    return { authority: config.authority.equals(PublicKey.default) ? null : config.authority, paused: config.paused };
  }

  // ---- Seizure ----

  /**
   * `seize`, signed by `authority` (the admin or a role holder): burn the whole public balance of a
   * token account frozen through Vigilantis at least `SEIZE_DELAY_SECONDS` ago, refreeze it, and
   * open a `SeizureRecord`. `enforcement.caseRef` must not be all zeros, and one case can seize one
   * account once while its record is open.
   */
  async seizeInstruction(params: {
    mint: PublicKey;
    tokenAccount: PublicKey;
    enforcement: Enforcement;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint, tokenAccount } = params;
    const authority = params.authority ?? this.payer.publicKey;
    const [reasonCode, ref] = enforcementArgs(params.enforcement);
    if (ref.every((b) => b === 0)) throw new Error("a seizure needs a case reference (caseRef is all zeros)");
    return this.program.methods
      .seize(reasonCode, ref)
      .accountsPartial({
        authority,
        mint,
        policyConfig: this.policy(mint),
        tokenAccount,
        freezeRecord: this.freezeRecord(mint, tokenAccount),
        seizureRecord: this.seizureRecord(mint, tokenAccount, ref),
        freezeAuthority: this.freezeAuthority(mint),
        permanentDelegate: this.permanentDelegate(mint),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        role: await this.roleAccount(mint, authority),
      })
      .instruction();
  }

  /** `close_seizure`, signed by `authority`: close the record once the case is settled. */
  async closeSeizureInstruction(params: {
    mint: PublicKey;
    tokenAccount: PublicKey;
    caseRef: Uint8Array | number[];
    outcome: SeizureOutcome;
    reasonCode: number;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint } = params;
    const authority = params.authority ?? this.payer.publicKey;
    const [reasonCode, ref] = enforcementArgs({ reasonCode: params.reasonCode, caseRef: params.caseRef });
    return this.program.methods
      .closeSeizure({ [params.outcome]: {} } as never, reasonCode)
      .accountsPartial({
        authority,
        mint,
        policyConfig: this.policy(mint),
        seizureRecord: this.seizureRecord(mint, params.tokenAccount, ref),
        role: await this.roleAccount(mint, authority),
      })
      .instruction();
  }

  /** Seize a token account's public balance (provider wallet as the admin or a role holder). */
  async seize(mint: PublicKey, tokenAccount: PublicKey, enforcement: Enforcement): Promise<string> {
    return this.send([await this.seizeInstruction({ mint, tokenAccount, enforcement })]);
  }

  /** Close a seizure with its outcome. */
  async closeSeizure(params: {
    mint: PublicKey;
    tokenAccount: PublicKey;
    caseRef: Uint8Array | number[];
    outcome: SeizureOutcome;
    reasonCode: number;
  }): Promise<string> {
    return this.send([await this.closeSeizureInstruction(params)]);
  }

  /** When Vigilantis last froze `tokenAccount`, or `null` if it has no freeze record. */
  async getFreezeRecord(mint: PublicKey, tokenAccount: PublicKey): Promise<FreezeRecordView | null> {
    const acc = await this.program.account.freezeRecord.fetchNullable(this.freezeRecord(mint, tokenAccount));
    if (!acc) return null;
    const frozenAt = Number(acc.frozenAt.toString());
    return { tokenAccount, frozenAt, slot: BigInt(acc.slot.toString()), seizableFrom: frozenAt + SEIZE_DELAY_SECONDS };
  }

  /** An open seizure, or `null` if there is none (never seized, or closed). */
  async getSeizure(mint: PublicKey, tokenAccount: PublicKey, caseRef: Uint8Array | number[]): Promise<SeizureView | null> {
    const address = this.seizureRecord(mint, tokenAccount, caseRef);
    const acc = await this.program.account.seizureRecord.fetchNullable(address);
    return acc ? seizureView(address, acc) : null;
  }

  /** Every open seizure of `mint`. */
  async listSeizures(mint: PublicKey): Promise<SeizureView[]> {
    const all = await this.program.account.seizureRecord.all([{ memcmp: { offset: 8, bytes: mint.toBase58() } }]);
    return all.map(({ publicKey, account }) => seizureView(publicKey, account));
  }

  // ---- Authority handover (provider wallet as the current authority) ----

  /** Propose `newAuthority` as the policy authority. Nothing changes until it accepts. */
  async proposeAuthority(mint: PublicKey, newAuthority: PublicKey): Promise<string> {
    return this.send([await this.proposeAuthorityInstruction(mint, newAuthority)]);
  }

  /** Accept a pending handover. `newAuthority` must sign. */
  async acceptAuthority(mint: PublicKey, newAuthority: Signer): Promise<string> {
    const policy = await this.getPolicy(mint);
    if (!policy) throw new Error(`no Vigilantis policy for mint ${mint.toBase58()}`);
    const ix = await this.acceptAuthorityInstruction(mint, newAuthority.publicKey, policy.authority);
    return this.send([ix], [newAuthority]);
  }

  /** Withdraw a pending handover. */
  async cancelAuthorityTransfer(mint: PublicKey): Promise<string> {
    return this.send([await this.cancelAuthorityTransferInstruction(mint)]);
  }

  /** The authority a handover is waiting for, or `null` if none is pending. */
  async getPendingAuthority(mint: PublicKey): Promise<PublicKey | null> {
    const pending = await this.program.account.pendingAuthority.fetchNullable(this.pendingAuthority(mint));
    return pending ? pending.newAuthority : null;
  }

  /**
   * Bring a mint's ExtraAccountMetaList up to the current program's list. Mints set up before
   * 2.1 need this once so the blocklist also covers delegates. Safe to run again.
   */
  async updateExtraAccountMetaList(mint: PublicKey): Promise<string> {
    return this.send([await this.updateExtraAccountMetaListInstruction(mint)]);
  }

  // ---- Batch list updates ----

  /** Allowlist many wallets, `MAX_LIST_UPDATES_PER_TX` per transaction. Returns the signatures. */
  addToAllowlistBatch(mint: PublicKey, wallets: PublicKey[]): Promise<string[]> {
    return this.listBatch(mint, wallets, "allow", "add");
  }

  /** Remove many wallets from the allowlist. */
  removeFromAllowlistBatch(mint: PublicKey, wallets: PublicKey[]): Promise<string[]> {
    return this.listBatch(mint, wallets, "allow", "remove");
  }

  /** Blocklist many wallets, for example from a sanctions list. */
  addToBlocklistBatch(mint: PublicKey, wallets: PublicKey[]): Promise<string[]> {
    return this.listBatch(mint, wallets, "block", "add");
  }

  /** Remove many wallets from the blocklist. */
  removeFromBlocklistBatch(mint: PublicKey, wallets: PublicKey[]): Promise<string[]> {
    return this.listBatch(mint, wallets, "block", "remove");
  }

  private async listBatch(
    mint: PublicKey,
    wallets: PublicKey[],
    list: ListName,
    action: ListAction,
  ): Promise<string[]> {
    const signatures: string[] = [];
    for (let i = 0; i < wallets.length; i += MAX_LIST_UPDATES_PER_TX) {
      const chunk = wallets.slice(i, i + MAX_LIST_UPDATES_PER_TX);
      const ixs = await Promise.all(chunk.map((wallet) => this.listInstruction({ mint, wallet, list, action })));
      signatures.push(await this.send(ixs));
    }
    return signatures;
  }

  // ---- Events ----

  /** Decode Vigilantis events from transaction logs (including the logs of a failed transaction). */
  parseEvents(logs: string[]): VigilantisEvent[] {
    const parser = new EventParser(this.programId, new BorshCoder(this.program.idl));
    return [...parser.parseLogs(logs)].map((e) => ({ name: e.name, data: e.data as Record<string, unknown> }));
  }

  /** Decode the Vigilantis events of a confirmed transaction. */
  async getEvents(signature: string): Promise<VigilantisEvent[]> {
    const tx = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return this.parseEvents(tx?.meta?.logMessages ?? []);
  }

  private send(instructions: TransactionInstruction[], extraSigners: Signer[] = []): Promise<string> {
    return sendAndConfirmTransaction(
      this.connection,
      new Transaction().add(...instructions),
      [this.payer, ...extraSigners],
      CONFIRM,
    );
  }

  /** Transfer tokens through the hook (extra accounts resolved automatically). */
  async transfer(params: {
    mint: PublicKey;
    amount: bigint | number;
    decimals: number;
    destinationOwner?: PublicKey;
    destination?: PublicKey;
    owner?: Signer;
    source?: PublicKey;
  }): Promise<string> {
    const owner = params.owner ?? this.payer;
    const source =
      params.source ??
      getAssociatedTokenAddressSync(params.mint, owner.publicKey, true, TOKEN_2022_PROGRAM_ID);
    let destination = params.destination;
    if (!destination) {
      if (!params.destinationOwner) {
        throw new Error("transfer requires destination or destinationOwner");
      }
      destination = getAssociatedTokenAddressSync(
        params.mint,
        params.destinationOwner,
        true,
        TOKEN_2022_PROGRAM_ID
      );
    }
    const ix = await createTransferCheckedWithTransferHookInstruction(
      this.connection,
      source,
      params.mint,
      destination,
      owner.publicKey,
      BigInt(params.amount),
      params.decimals,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    const signers = owner.publicKey.equals(this.payer.publicKey) ? [this.payer] : [this.payer, owner];
    return sendAndConfirmTransaction(this.connection, new Transaction().add(ix), signers, CONFIRM);
  }

  /** Read a mint's policy, or `null` if it has none. */
  async getPolicy(mint: PublicKey): Promise<PolicyView | null> {
    const acc = await this.program.account.policyConfig.fetchNullable(this.policy(mint));
    if (!acc) return null;
    return {
      mint: acc.mint,
      authority: acc.authority,
      allowlistEnabled: acc.allowlistEnabled,
      blocklistEnabled: acc.blocklistEnabled,
      maxTransferAmount: BigInt(acc.maxTransferAmount.toString()),
      allowConfidential: acc.allowConfidential,
    };
  }

  async isAllowlisted(mint: PublicKey, wallet: PublicKey): Promise<boolean> {
    return (await this.program.account.allowEntry.fetchNullable(this.allowEntry(mint, wallet))) !== null;
  }

  async isBlocklisted(mint: PublicKey, wallet: PublicKey): Promise<boolean> {
    return (await this.program.account.blockEntry.fetchNullable(this.blockEntry(mint, wallet))) !== null;
  }
}

/** A role's permissions, checked: at least one, and only known ones. */
function permissionsArg(permissions: number): number {
  if (!Number.isInteger(permissions) || permissions <= 0 || (permissions & ~PERMISSIONS.all) !== 0) {
    throw new Error(`permissions must combine PERMISSIONS values, got ${permissions}`);
  }
  return permissions;
}

/** A decoded `SeizureRecord`. */
function seizureView(
  address: PublicKey,
  acc: {
    mint: PublicKey;
    wallet: PublicKey;
    tokenAccount: PublicKey;
    amount: { toString(): string };
    reasonCode: number;
    caseRef: number[];
    authority: PublicKey;
    seizedAt: { toString(): string };
    slot: { toString(): string };
  },
): SeizureView {
  return {
    address,
    mint: acc.mint,
    wallet: acc.wallet,
    tokenAccount: acc.tokenAccount,
    amount: BigInt(acc.amount.toString()),
    reasonCode: acc.reasonCode,
    caseRef: Uint8Array.from(acc.caseRef),
    authority: acc.authority,
    seizedAt: Number(acc.seizedAt.toString()),
    slot: BigInt(acc.slot.toString()),
  };
}

/** The program's arguments for an `Enforcement`, checked. */
function enforcementArgs(e: Enforcement): [number, number[]] {
  if (!Number.isInteger(e.reasonCode) || e.reasonCode < 0 || e.reasonCode > 0xffff) {
    throw new Error(`reasonCode must be an integer from 0 to 65535, got ${e.reasonCode}`);
  }
  const ref = Array.from(e.caseRef);
  if (ref.length !== 32) throw new Error(`caseRef must be 32 bytes, got ${ref.length}`);
  return [e.reasonCode, ref];
}
