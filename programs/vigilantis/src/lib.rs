// SPDX-License-Identifier: BUSL-1.1
//! Vigilantis — programmable compliance for Token-2022 tokenized assets, built on
//! the Transfer Hook extension.
//!
//! Each mint has a `PolicyConfig` that toggles the active rules. On every
//! transfer the hook enforces them:
//!   - **limit**: `amount <= max_transfer_amount` (when `max_transfer_amount > 0`)
//!   - **allowlist** (when enabled): the recipient must have an `AllowEntry`
//!   - **blocklist** (when enabled): neither sender nor recipient may have a `BlockEntry`
//!
//! The blocklist also covers the transfer authority, so a blocked wallet cannot move tokens as a
//! delegate of someone else's account (2.1; mints created before 2.1 call
//! `update_extra_account_meta_list` once to get this).
//!
//! A hook can only refuse transfers. To stop a token account completely (transfers, burns,
//! approvals, confidential deposits and withdrawals), the policy authority freezes it through
//! Vigilantis (2.2): the mint's freeze authority is Vigilantis's freeze-authority address for the mint,
//! and `freeze_token_account` / `thaw_token_account` sign for it. Every block, unblock, freeze and
//! thaw made with a reason emits `EnforcementAction` with the issuer's reason code and case
//! reference, so the record of what was done and why stays on-chain. The policy authority can hand
//! the freeze authority on to another address, or give it up, with `set_freeze_authority` (2.3);
//! that move is recorded too (`FreezeAuthorityChanged`).
//!
//! Confidential transfers are a special case. Token-2022 hides the amount from
//! the hook, so the limit rule cannot be evaluated at all — it is unenforceable
//! rather than satisfied. A mint that sets a limit therefore refuses
//! confidential transfers unless its policy sets `allow_confidential`, which is
//! the issuer explicitly accepting that the limit does not apply to them. The
//! allowlist and blocklist rules work on addresses, so they apply to
//! confidential transfers unchanged.
//!
//! Enforcement functions (1.0):
//!   - **roles**: the policy authority (the admin) can give other addresses a `RoleEntry` with some
//!     of the permissions in [`permission`], for example one per compliance officer. A role holder
//!     can do exactly those actions; the admin can do all of them. Only the admin manages roles,
//!     the policy and the authorities, and a holder can renounce its own role.
//!   - **pause**: for a mint with Token-2022's Pausable extension whose pause authority is
//!     Vigilantis's pause-authority address, `pause` stops every transfer, mint and burn of the
//!     token, confidential ones included, until `resume`.
//!   - **seizure**: for a mint whose permanent delegate is Vigilantis's permanent-delegate address,
//!     `seize` burns the public balance of a token account that Vigilantis froze at least
//!     [`SEIZE_DELAY_SECONDS`] earlier, refreezes it, and keeps a `SeizureRecord` until
//!     `close_seizure`. Vigilantis never moves value to anyone. A confidential balance cannot be
//!     seized, because moving it needs proofs only its owner can make; freezing is the tool there.
//!
//! The transfer hook never reads roles, so transfers cost the same as before, and a mint without
//! role entries, Pausable or a permanent delegate behaves as in Sentinel 2.3.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::system_program::{
    allocate, assign, create_account, transfer, Allocate, Assign, CreateAccount, Transfer,
};
use anchor_spl::token_2022::{
    self as token_2022, spl_token_2022::instruction::AuthorityType, Token2022,
};
use anchor_spl::token_interface::Mint;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

/// Token-2022 invokes the transfer hook for a **confidential** transfer with
/// `amount` set to `u64::MAX`, because the real amount is encrypted and the
/// program cannot see it. Treat this value as "amount unknown", never as a
/// literal quantity.
pub const CONFIDENTIAL_TRANSFER_AMOUNT: u64 = u64::MAX;

declare_id!("4DoDFZJmJWYuBx86UqXi3y24GkQ3Cq4nUBHZwDE5PQM5");

const META_LIST_SEED: &[u8] = b"extra-account-metas";
const POLICY_SEED: &[u8] = b"policy";
const ALLOW_SEED: &[u8] = b"allow";
const BLOCK_SEED: &[u8] = b"block";
const PENDING_AUTHORITY_SEED: &[u8] = b"pending-authority";
/// The PDA (`["freeze-authority", mint]`) that a mint names as its freeze authority so that
/// Vigilantis can freeze and thaw its token accounts. It holds no data; it only signs.
const FREEZE_AUTHORITY_SEED: &[u8] = b"freeze-authority";
/// Offset of the `owner` field in an SPL token account (mint[0..32], owner[32..64]).
const TOKEN_ACCOUNT_OWNER_OFFSET: u8 = 32;
/// A role holder's `RoleEntry`: `["role", mint, holder]`.
const ROLE_SEED: &[u8] = b"role";
/// The PDA (`["pause-authority", mint]`) that a Pausable mint names as its pause authority so that
/// Vigilantis can pause and resume it. It holds no data; it only signs.
const PAUSE_AUTHORITY_SEED: &[u8] = b"pause-authority";
/// The PDA (`["permanent-delegate", mint]`) that a mint names as its permanent delegate so that
/// Vigilantis can burn a seized public balance. It holds no data; it only signs, and only in `seize`.
const PERMANENT_DELEGATE_SEED: &[u8] = b"permanent-delegate";
/// When Vigilantis froze a token account: `["freeze-record", mint, token_account]`.
const FREEZE_RECORD_SEED: &[u8] = b"freeze-record";
/// An open seizure: `["seizure", mint, token_account, case_ref]`.
const SEIZURE_SEED: &[u8] = b"seizure";

/// How long a token account must have been frozen through Vigilantis before `seize` can burn its
/// public balance: 24 hours, for everyone, the admin included. The time counts from the latest
/// `freeze_token_account` of that account; a thaw through Vigilantis deletes the record, so the
/// clock starts again at the next freeze. It gives the admin a day to undo a wrong freeze before
/// a single key can destroy a balance.
pub const SEIZE_DELAY_SECONDS: i64 = 24 * 60 * 60;

/// The permissions a `RoleEntry` can hold, as bits of `RoleEntry::permissions`.
pub mod permission {
    /// `add_to_allowlist` and `remove_from_allowlist`.
    pub const ALLOWLIST: u16 = 1 << 0;
    /// `add_to_blocklist` and `block_wallet`.
    pub const BLOCK: u16 = 1 << 1;
    /// `remove_from_blocklist` and `unblock_wallet`.
    pub const UNBLOCK: u16 = 1 << 2;
    /// `freeze_token_account`.
    pub const FREEZE: u16 = 1 << 3;
    /// `thaw_token_account`.
    pub const THAW: u16 = 1 << 4;
    /// `pause`.
    pub const PAUSE: u16 = 1 << 5;
    /// `resume`.
    pub const RESUME: u16 = 1 << 6;
    /// `seize`.
    pub const SEIZE: u16 = 1 << 7;
    /// `close_seizure`.
    pub const CLOSE_SEIZURE: u16 = 1 << 8;
    /// Every permission above.
    pub const ALL: u16 = (1 << 9) - 1;
}

/// Token-2022 mint layout: the base mint padded to the length of a token account, then the
/// account-type byte (1 = mint), then the extensions as type (u16) / length (u16) / value entries.
const MINT_ACCOUNT_TYPE_OFFSET: usize = 165;
const ACCOUNT_TYPE_MINT: u8 = 1;
/// Token-2022 `ExtensionType` numbers that Vigilantis reads. The crate version Anchor 0.31 uses
/// (spl-token-2022 6.0) predates Pausable, so the mint's extensions are read here directly.
const EXTENSION_PERMANENT_DELEGATE: u16 = 12;
const EXTENSION_PAUSABLE: u16 = 26;
/// A token account's account type (at offset 165 of an extended account), and the two account
/// extensions the hook reads: `ImmutableOwner` (7) and `TransferHookAccount` (15), whose one byte
/// is the `transferring` flag Token-2022 sets for the length of a transfer.
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;
const EXTENSION_IMMUTABLE_OWNER: u16 = 7;
const EXTENSION_TRANSFER_HOOK_ACCOUNT: u16 = 15;
/// The `paused` flag in the Pausable extension's value, after the 32-byte authority.
const PAUSABLE_PAUSED_OFFSET: usize = 32;
/// Token-2022 instruction bytes for the calls the 6.0 crate cannot build: `SetAuthority` (6) with
/// `AuthorityType::Pause` (16), and the Pausable extension (44) `Pause` (1) / `Resume` (2).
const TOKEN_IX_SET_AUTHORITY: u8 = 6;
const AUTHORITY_TYPE_PAUSE: u8 = 16;
const TOKEN_IX_PAUSABLE_EXTENSION: u8 = 44;
const PAUSABLE_PAUSE: u8 = 1;
const PAUSABLE_RESUME: u8 = 2;
/// SPL token account layout: amount at 64..72 and state at 108 (2 = frozen).
const TOKEN_ACCOUNT_AMOUNT_OFFSET: usize = 64;
const TOKEN_ACCOUNT_STATE_OFFSET: usize = 108;
const TOKEN_ACCOUNT_BASE_LEN: usize = 165;
const TOKEN_ACCOUNT_STATE_FROZEN: u8 = 2;

// Who to contact about a vulnerability, readable from the deployed program itself
// (`query-security-txt <program id>`, Solana Explorer, auditors' tooling). Keep it in step with
// SECURITY.md; `scripts/check-security-txt.sh` checks the built program in CI.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Vigilantis",
    project_url: "https://github.com/softseco/vigilantis",
    contacts: "link:https://github.com/softseco/vigilantis/security/advisories/new,email:hello@softseco.com",
    policy: "https://github.com/softseco/vigilantis/blob/main/SECURITY.md",
    preferred_languages: "en,pl",
    source_code: "https://github.com/softseco/vigilantis",
    source_release: concat!("v", env!("CARGO_PKG_VERSION")),
    auditors: "None yet: self-audited, not independently audited. Self-review: https://github.com/softseco/vigilantis/blob/main/docs/threat-model.md"
}

#[program]
pub mod vigilantis {
    use super::*;

    /// Create the mint's `PolicyConfig`. The signer becomes its authority.
    pub fn initialize_policy(
        ctx: Context<InitializePolicy>,
        allowlist_enabled: bool,
        blocklist_enabled: bool,
        max_transfer_amount: u64,
        allow_confidential: bool,
    ) -> Result<()> {
        ctx.accounts.policy_config.set_inner(PolicyConfig {
            mint: ctx.accounts.mint.key(),
            authority: ctx.accounts.authority.key(),
            allowlist_enabled,
            blocklist_enabled,
            max_transfer_amount,
            allow_confidential,
            bump: ctx.bumps.policy_config,
            role_epoch: 0,
        });
        emit!(PolicyInitialized {
            mint: ctx.accounts.mint.key(),
            authority: ctx.accounts.authority.key(),
            allowlist_enabled,
            blocklist_enabled,
            max_transfer_amount,
            allow_confidential,
        });
        Ok(())
    }

    /// Update the mint's policy. Only the policy authority may call this.
    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        allowlist_enabled: bool,
        blocklist_enabled: bool,
        max_transfer_amount: u64,
        allow_confidential: bool,
    ) -> Result<()> {
        let policy = &mut ctx.accounts.policy_config;
        policy.allowlist_enabled = allowlist_enabled;
        policy.blocklist_enabled = blocklist_enabled;
        policy.max_transfer_amount = max_transfer_amount;
        policy.allow_confidential = allow_confidential;
        emit!(PolicyUpdated {
            mint: policy.mint,
            authority: policy.authority,
            allowlist_enabled,
            blocklist_enabled,
            max_transfer_amount,
            allow_confidential,
        });
        Ok(())
    }

    /// Create and initialize the `ExtraAccountMetaList` PDA for `mint`, declaring
    /// the accounts the hook needs on every transfer: the policy config, the
    /// sender's and recipient's blocklist entries, and the recipient's allowlist
    /// entry (all resolved from the transfer's own accounts).
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let extra_account_metas = extra_account_metas()?;
        let account_size = ExtraAccountMetaList::size_of(extra_account_metas.len())?;

        let mint_key = ctx.accounts.mint.key();
        let bump = ctx.bumps.extra_account_meta_list;
        let signer_seeds: &[&[&[u8]]] = &[&[META_LIST_SEED, mint_key.as_ref(), &[bump]]];

        create_program_account(
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.extra_account_meta_list.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            account_size,
            signer_seeds,
            ctx.program_id,
        )?;

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &extra_account_metas,
        )?;

        msg!("Vigilantis: meta list initialized for mint {}", mint_key);
        emit!(MetaListUpdated {
            mint: mint_key,
            entries: extra_account_metas.len() as u8,
        });
        Ok(())
    }

    /// Rewrite a mint's `ExtraAccountMetaList` to the current list, growing the account if
    /// needed. Mints initialized before 2.1 run this once so the hook also receives the transfer
    /// authority's blocklist entry. The list's content is fixed by the program; only the policy
    /// authority may trigger the rewrite, and it pays for any extra rent.
    pub fn update_extra_account_meta_list(ctx: Context<UpdateExtraAccountMetaList>) -> Result<()> {
        let extra_account_metas = extra_account_metas()?;
        let new_len = ExtraAccountMetaList::size_of(extra_account_metas.len())?;
        let meta_list = ctx.accounts.extra_account_meta_list.to_account_info();

        if meta_list.data_len() < new_len {
            let required = Rent::get()?.minimum_balance(new_len);
            let top_up = required.saturating_sub(meta_list.lamports());
            if top_up > 0 {
                transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.authority.to_account_info(),
                            to: meta_list.clone(),
                        },
                    ),
                    top_up,
                )?;
            }
            meta_list.resize(new_len)?;
        }

        ExtraAccountMetaList::update::<ExecuteInstruction>(
            &mut meta_list.try_borrow_mut_data()?,
            &extra_account_metas,
        )?;

        emit!(MetaListUpdated {
            mint: ctx.accounts.mint.key(),
            entries: extra_account_metas.len() as u8,
        });
        Ok(())
    }

    /// Add a wallet to a mint's allowlist by creating its `AllowEntry` PDA. The admin, or a holder
    /// of `permission::ALLOWLIST`.
    pub fn add_to_allowlist(ctx: Context<AddToAllowlist>) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::ALLOWLIST,
        )?;
        ctx.accounts.allow_entry.set_inner(AllowEntry {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            bump: ctx.bumps.allow_entry,
        });
        emit!(ListEntryAdded {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            list: ListKind::Allow,
        });
        Ok(())
    }

    /// Remove a wallet from a mint's allowlist by closing its `AllowEntry` PDA. The admin, or a
    /// holder of `permission::ALLOWLIST`.
    pub fn remove_from_allowlist(ctx: Context<RemoveFromAllowlist>) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::ALLOWLIST,
        )?;
        emit!(ListEntryRemoved {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            list: ListKind::Allow,
        });
        Ok(())
    }

    /// Add a wallet to a mint's blocklist by creating its `BlockEntry` PDA. The admin, or a holder
    /// of `permission::BLOCK`.
    pub fn add_to_blocklist(ctx: Context<AddToBlocklist>) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::BLOCK,
        )?;
        ctx.accounts.block_entry.set_inner(BlockEntry {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            bump: ctx.bumps.block_entry,
        });
        emit!(ListEntryAdded {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            list: ListKind::Block,
        });
        Ok(())
    }

    /// Remove a wallet from a mint's blocklist by closing its `BlockEntry` PDA. The admin, or a
    /// holder of `permission::UNBLOCK`.
    pub fn remove_from_blocklist(ctx: Context<RemoveFromBlocklist>) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::UNBLOCK,
        )?;
        emit!(ListEntryRemoved {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            list: ListKind::Block,
        });
        Ok(())
    }

    /// `add_to_blocklist`, recording why: also emits `EnforcementAction` with the issuer's
    /// `reason_code` and `case_ref` (for example a salted hash of its case number).
    pub fn block_wallet(
        ctx: Context<AddToBlocklist>,
        reason_code: u16,
        case_ref: [u8; 32],
    ) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::BLOCK,
        )?;
        let mint = ctx.accounts.mint.key();
        let wallet = ctx.accounts.wallet.key();
        ctx.accounts.block_entry.set_inner(BlockEntry {
            mint,
            wallet,
            bump: ctx.bumps.block_entry,
        });
        emit!(ListEntryAdded {
            mint,
            wallet,
            list: ListKind::Block,
        });
        emit!(EnforcementAction {
            mint,
            wallet,
            token_account: Pubkey::default(),
            action: EnforcementKind::Block,
            reason_code,
            case_ref,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    /// `remove_from_blocklist`, recording why (`EnforcementAction`).
    pub fn unblock_wallet(
        ctx: Context<RemoveFromBlocklist>,
        reason_code: u16,
        case_ref: [u8; 32],
    ) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::UNBLOCK,
        )?;
        let mint = ctx.accounts.mint.key();
        let wallet = ctx.accounts.wallet.key();
        emit!(ListEntryRemoved {
            mint,
            wallet,
            list: ListKind::Block,
        });
        emit!(EnforcementAction {
            mint,
            wallet,
            token_account: Pubkey::default(),
            action: EnforcementKind::Unblock,
            reason_code,
            case_ref,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    /// Freeze one token account of the mint: Token-2022 then refuses every instruction on it
    /// (transfers in and out, burns, approvals, confidential deposits, transfers and withdrawals)
    /// until it is thawed. The admin, or a holder of `permission::FREEZE`, and only for a mint
    /// whose freeze authority is Vigilantis's freeze-authority address for that mint.
    ///
    /// Also writes the account's `FreezeRecord` (the time of this freeze), which `seize` needs; the
    /// signer pays its rent.
    pub fn freeze_token_account(
        ctx: Context<SetFrozen>,
        reason_code: u16,
        case_ref: [u8; 32],
    ) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::FREEZE,
        )?;
        set_frozen(&ctx, true)?;
        write_freeze_record(&ctx)?;
        emit_frozen(&ctx, EnforcementKind::Freeze, reason_code, case_ref);
        Ok(())
    }

    /// Thaw a token account frozen with `freeze_token_account` (or by any earlier holder of the
    /// mint's freeze authority). The admin, or a holder of `permission::THAW`. Deletes the
    /// account's `FreezeRecord`, if there is one, and returns its rent to the signer.
    pub fn thaw_token_account(
        ctx: Context<SetFrozen>,
        reason_code: u16,
        case_ref: [u8; 32],
    ) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::THAW,
        )?;
        set_frozen(&ctx, false)?;
        close_freeze_record(&ctx)?;
        emit_frozen(&ctx, EnforcementKind::Thaw, reason_code, case_ref);
        Ok(())
    }

    /// Stop the whole token: Token-2022 then refuses every transfer, mint and burn of it,
    /// confidential ones included, until `resume`. Freezing and thawing still work. The admin, or a
    /// holder of `permission::PAUSE`, and only for a Pausable mint whose pause authority is
    /// Vigilantis's pause-authority address for that mint.
    pub fn pause(ctx: Context<SetPaused>, reason_code: u16, case_ref: [u8; 32]) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::PAUSE,
        )?;
        set_paused(&ctx, true)?;
        emit_paused(&ctx, EnforcementKind::Pause, reason_code, case_ref);
        Ok(())
    }

    /// End a pause. The admin, or a holder of `permission::RESUME`.
    pub fn resume(ctx: Context<SetPaused>, reason_code: u16, case_ref: [u8; 32]) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::RESUME,
        )?;
        set_paused(&ctx, false)?;
        emit_paused(&ctx, EnforcementKind::Resume, reason_code, case_ref);
        Ok(())
    }

    /// Hand the mint's pause authority from Vigilantis to `new_pause_authority`, or give it up for
    /// good with `None`. The admin only, and only while Vigilantis holds the pause authority. The
    /// move is recorded in `PauseAuthorityChanged`.
    pub fn set_pause_authority(
        ctx: Context<SetPauseAuthority>,
        new_pause_authority: Option<Pubkey>,
        reason_code: u16,
        case_ref: [u8; 32],
    ) -> Result<()> {
        let vigilantis = ctx.accounts.pause_authority.key();
        require!(
            pause_authority_of(&ctx.accounts.mint)? == Some(vigilantis),
            VigilantisError::PauseAuthorityNotVigilantis
        );
        // Handing on or giving up the pause authority of a paused mint could leave it paused for
        // good, with nobody able to resume it. Resume first.
        require!(
            !is_paused(&ctx.accounts.mint)?,
            VigilantisError::PausedMintHandover
        );
        if let Some(new) = new_pause_authority {
            require!(
                new != Pubkey::default() && !is_vigilantis_address(&ctx.accounts.mint.key(), &new),
                VigilantisError::InvalidAuthority
            );
        }
        // SetAuthority: [6, authority type, COption<Pubkey>].
        let mut data = vec![TOKEN_IX_SET_AUTHORITY, AUTHORITY_TYPE_PAUSE];
        match new_pause_authority {
            Some(new) => {
                data.push(1);
                data.extend_from_slice(new.as_ref());
            }
            None => data.push(0),
        }
        let mint = ctx.accounts.mint.key();
        let bump = [ctx.bumps.pause_authority];
        let signer_seeds: &[&[&[u8]]] = &[&[PAUSE_AUTHORITY_SEED, mint.as_ref(), &bump]];
        invoke_signed(
            &Instruction {
                program_id: ctx.accounts.token_program.key(),
                accounts: vec![
                    AccountMeta::new(mint, false),
                    AccountMeta::new_readonly(vigilantis, true),
                ],
                data,
            },
            &[
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.pause_authority.to_account_info(),
            ],
            signer_seeds,
        )?;
        emit!(PauseAuthorityChanged {
            mint,
            new_pause_authority,
            reason_code,
            case_ref,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    /// Burn the public balance of a token account under a court order. The admin, or a holder of
    /// `permission::SEIZE`; `case_ref` must not be all zeros.
    ///
    /// The account must have been frozen through Vigilantis at least `SEIZE_DELAY_SECONDS` before
    /// and still be frozen, and the mint's permanent delegate must be Vigilantis's
    /// permanent-delegate address. In one instruction Vigilantis thaws the account, burns its whole
    /// public balance as the permanent delegate, and freezes it again. The reserve behind the burnt
    /// tokens stays with the issuer for the case; paying out under the judgment is a separate step.
    /// A `SeizureRecord` stays open until `close_seizure`. A confidential balance is not touched.
    pub fn seize(ctx: Context<Seize>, reason_code: u16, case_ref: [u8; 32]) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::SEIZE,
        )?;
        require!(case_ref != [0u8; 32], VigilantisError::InvalidCaseRef);
        let mint = ctx.accounts.mint.key();
        let delegate = ctx.accounts.permanent_delegate.key();
        {
            let mint_info = ctx.accounts.mint.to_account_info();
            let data = mint_info.try_borrow_data()?;
            require!(
                mint_extension_address(&data, EXTENSION_PERMANENT_DELEGATE) == Some(delegate),
                VigilantisError::PermanentDelegateNotVigilantis
            );
        }
        let (wallet, amount) = {
            let data = ctx.accounts.token_account.try_borrow_data()?;
            require!(
                data.len() >= TOKEN_ACCOUNT_BASE_LEN && data[..32] == mint.to_bytes(),
                VigilantisError::InvalidTokenAccount
            );
            require!(
                data[TOKEN_ACCOUNT_STATE_OFFSET] == TOKEN_ACCOUNT_STATE_FROZEN,
                VigilantisError::AccountNotFrozen
            );
            let mut amount_bytes = [0u8; 8];
            amount_bytes.copy_from_slice(
                &data[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8],
            );
            (
                token_account_owner(&ctx.accounts.token_account),
                u64::from_le_bytes(amount_bytes),
            )
        };
        require!(amount > 0, VigilantisError::NothingToSeize);
        let clock = Clock::get()?;
        let earliest = ctx
            .accounts
            .freeze_record
            .frozen_at
            .saturating_add(SEIZE_DELAY_SECONDS);
        require!(
            clock.unix_timestamp >= earliest,
            VigilantisError::SeizeTooEarly
        );

        // Thaw, burn as the permanent delegate, freeze again. Burning a frozen account is refused,
        // even for the permanent delegate, so the thaw and refreeze bracket the burn.
        let token_program = ctx.accounts.token_program.to_account_info();
        let account = ctx.accounts.token_account.to_account_info();
        let mint_info = ctx.accounts.mint.to_account_info();
        let freeze_authority = ctx.accounts.freeze_authority.to_account_info();
        let freeze_bump = [ctx.bumps.freeze_authority];
        let freeze_seeds: &[&[&[u8]]] = &[&[FREEZE_AUTHORITY_SEED, mint.as_ref(), &freeze_bump]];
        let delegate_bump = [ctx.bumps.permanent_delegate];
        let delegate_seeds: &[&[&[u8]]] =
            &[&[PERMANENT_DELEGATE_SEED, mint.as_ref(), &delegate_bump]];
        token_2022::thaw_account(CpiContext::new_with_signer(
            token_program.clone(),
            token_2022::ThawAccount {
                account: account.clone(),
                mint: mint_info.clone(),
                authority: freeze_authority.clone(),
            },
            freeze_seeds,
        ))?;
        token_2022::burn(
            CpiContext::new_with_signer(
                token_program.clone(),
                token_2022::Burn {
                    mint: mint_info.clone(),
                    from: account.clone(),
                    authority: ctx.accounts.permanent_delegate.to_account_info(),
                },
                delegate_seeds,
            ),
            amount,
        )?;
        token_2022::freeze_account(CpiContext::new_with_signer(
            token_program,
            token_2022::FreezeAccount {
                account,
                mint: mint_info,
                authority: freeze_authority,
            },
            freeze_seeds,
        ))?;

        let authority = ctx.accounts.authority.key();
        let token_account = ctx.accounts.token_account.key();
        ctx.accounts.seizure_record.set_inner(SeizureRecord {
            mint,
            wallet,
            token_account,
            amount,
            reason_code,
            case_ref,
            authority,
            seized_at: clock.unix_timestamp,
            slot: clock.slot,
            bump: ctx.bumps.seizure_record,
        });
        emit!(EnforcementAction {
            mint,
            wallet,
            token_account,
            action: EnforcementKind::Seize,
            reason_code,
            case_ref,
            authority,
        });
        emit!(Seized {
            mint,
            wallet,
            token_account,
            amount,
            reason_code,
            case_ref,
            authority,
            seized_at: clock.unix_timestamp,
        });
        Ok(())
    }

    /// Close a `SeizureRecord` once the case is settled, recording the outcome. The admin, or a
    /// holder of `permission::CLOSE_SEIZURE`. The record's rent goes to the signer; the events of
    /// the seizure and of its closing stay in the chain's history.
    pub fn close_seizure(
        ctx: Context<CloseSeizure>,
        outcome: SeizureOutcome,
        reason_code: u16,
    ) -> Result<()> {
        authorize(
            &ctx.accounts.policy_config,
            &ctx.accounts.authority.key(),
            &ctx.accounts.role,
            permission::CLOSE_SEIZURE,
        )?;
        let record = &ctx.accounts.seizure_record;
        let authority = ctx.accounts.authority.key();
        emit!(EnforcementAction {
            mint: record.mint,
            wallet: record.wallet,
            token_account: record.token_account,
            action: EnforcementKind::CloseSeizure,
            reason_code,
            case_ref: record.case_ref,
            authority,
        });
        emit!(SeizureClosed {
            mint: record.mint,
            wallet: record.wallet,
            token_account: record.token_account,
            amount: record.amount,
            case_ref: record.case_ref,
            outcome,
            reason_code,
            authority,
        });
        Ok(())
    }

    /// Give `holder` a role with `permissions` (bits of [`permission`]). The admin only.
    pub fn grant_role(ctx: Context<GrantRole>, permissions: u16) -> Result<()> {
        require_valid_permissions(permissions)?;
        let holder = ctx.accounts.holder.key();
        require!(
            holder != Pubkey::default(),
            VigilantisError::InvalidAuthority
        );
        let mint = ctx.accounts.mint.key();
        ctx.accounts.role.set_inner(RoleEntry {
            mint,
            holder,
            permissions,
            bump: ctx.bumps.role,
            epoch: ctx.accounts.policy_config.role_epoch,
        });
        emit!(RoleChanged {
            mint,
            holder,
            previous_permissions: 0,
            permissions,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    /// Change the permissions of an existing role. The admin only.
    pub fn update_role(ctx: Context<UpdateRole>, permissions: u16) -> Result<()> {
        require_valid_permissions(permissions)?;
        let role = &mut ctx.accounts.role;
        let previous_permissions = role.permissions;
        role.permissions = permissions;
        // A role from before the last handover becomes valid again only through this update.
        role.epoch = ctx.accounts.policy_config.role_epoch;
        emit!(RoleChanged {
            mint: role.mint,
            holder: role.holder,
            previous_permissions,
            permissions,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    /// Take a role away. The admin only; the rent goes to the admin.
    pub fn revoke_role(ctx: Context<RevokeRole>) -> Result<()> {
        let role = &ctx.accounts.role;
        emit!(RoleChanged {
            mint: role.mint,
            holder: role.holder,
            previous_permissions: role.permissions,
            permissions: 0,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    /// Give up one's own role, for example when its key may be stolen. Signed by the holder; the
    /// rent goes to the holder.
    pub fn renounce_role(ctx: Context<RenounceRole>) -> Result<()> {
        let role = &ctx.accounts.role;
        emit!(RoleChanged {
            mint: role.mint,
            holder: role.holder,
            previous_permissions: role.permissions,
            permissions: 0,
            authority: role.holder,
        });
        Ok(())
    }

    /// Hand the mint's freeze authority from Vigilantis to `new_freeze_authority` (for example a
    /// newer compliance program, or the issuer's own multisig), or give it up for good with `None`.
    /// Only the policy authority may do this, and only while Vigilantis holds the freeze authority.
    /// From then on Vigilantis can no longer freeze or thaw the mint's accounts; whoever holds the
    /// freeze authority can hand it back with Token-2022 `SetAuthority`. The move is recorded in
    /// `FreezeAuthorityChanged`, with the issuer's reason.
    pub fn set_freeze_authority(
        ctx: Context<SetFreezeAuthority>,
        new_freeze_authority: Option<Pubkey>,
        reason_code: u16,
        case_ref: [u8; 32],
    ) -> Result<()> {
        if let Some(new) = new_freeze_authority {
            // To give the freeze authority up, pass None: the default address is nobody's key,
            // handing it to Vigilantis's freeze address would change nothing, and none of
            // Vigilantis's other addresses for this mint can ever sign a freeze.
            require!(
                new != Pubkey::default() && !is_vigilantis_address(&ctx.accounts.mint.key(), &new),
                VigilantisError::InvalidAuthority
            );
        }
        let mint = ctx.accounts.mint.key();
        let bump = [ctx.bumps.freeze_authority];
        let signer_seeds: &[&[&[u8]]] = &[&[FREEZE_AUTHORITY_SEED, mint.as_ref(), &bump]];
        token_2022::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_2022::SetAuthority {
                    current_authority: ctx.accounts.freeze_authority.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                signer_seeds,
            ),
            AuthorityType::FreezeAccount,
            new_freeze_authority,
        )?;
        emit!(FreezeAuthorityChanged {
            mint,
            new_freeze_authority,
            reason_code,
            case_ref,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    /// Start handing the policy to `new_authority` (for example a multisig vault). Nothing
    /// changes until `new_authority` accepts, so a mistyped address cannot lock the policy.
    pub fn propose_authority(ctx: Context<ProposeAuthority>, new_authority: Pubkey) -> Result<()> {
        let current = ctx.accounts.authority.key();
        require!(
            new_authority != Pubkey::default() && new_authority != current,
            VigilantisError::InvalidAuthority
        );
        ctx.accounts.pending_authority.set_inner(PendingAuthority {
            mint: ctx.accounts.mint.key(),
            new_authority,
            bump: ctx.bumps.pending_authority,
        });
        emit!(AuthorityTransferProposed {
            mint: ctx.accounts.mint.key(),
            authority: current,
            new_authority,
        });
        Ok(())
    }

    /// Withdraw a pending proposal. Only the current authority may call this.
    pub fn cancel_authority_transfer(ctx: Context<CancelAuthorityTransfer>) -> Result<()> {
        emit!(AuthorityTransferCancelled {
            mint: ctx.accounts.mint.key(),
            authority: ctx.accounts.authority.key(),
            new_authority: ctx.accounts.pending_authority.new_authority,
        });
        Ok(())
    }

    /// Complete the handover: the proposed authority signs and becomes the policy authority.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let policy = &mut ctx.accounts.policy_config;
        let previous = policy.authority;
        policy.authority = ctx.accounts.new_authority.key();
        // Every role granted so far stops working: a handover is often a key rotation, and the
        // roles the previous authority granted (possibly to itself) must not outlive it. The new
        // authority grants or updates the roles it wants to keep.
        policy.role_epoch = policy.role_epoch.wrapping_add(1);
        emit!(AuthorityTransferred {
            mint: policy.mint,
            previous_authority: previous,
            new_authority: policy.authority,
        });
        Ok(())
    }

    /// Invoked by Token-2022 on every transfer. Enforces the mint's policy.
    ///
    /// A refusal emits `TransferRefused` before returning the error, so indexers can read the
    /// reason from the failed transaction's logs.
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        // Only inside a Token-2022 transfer of this mint. A direct call is refused before anything
        // is evaluated and without an event, so nobody can put a `TransferRefused` naming someone
        // else into the logs.
        require_in_transfer(&ctx)?;
        let is_confidential = amount == CONFIDENTIAL_TRANSFER_AMOUNT;
        let verdict =
            check_owners_fixed(&ctx).and_then(|()| check_transfer(&ctx, amount, is_confidential));
        if let Err(reason) = verdict {
            emit!(TransferRefused {
                mint: ctx.accounts.mint.key(),
                source_owner: token_account_owner(&ctx.accounts.source_token),
                destination_owner: token_account_owner(&ctx.accounts.destination_token),
                transfer_authority: ctx.accounts.owner.key(),
                confidential: is_confidential,
                error_code: u32::from(reason),
            });
            return Err(reason.into());
        }

        if is_confidential {
            msg!("Vigilantis: confidential transfer allowed (amount not visible to the hook)");
        } else {
            msg!("Vigilantis: transfer allowed ({} units)", amount);
        }
        Ok(())
    }

    /// Route Token-2022's `Execute` (transfer-hook interface discriminator) to
    /// `transfer_hook`.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)?;
        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}

/// Create `account`, a PDA of this program signed for by `signer_seeds`, with `space` bytes, rent
/// paid by `payer`. Done the way Anchor's `init` does it: anyone can send lamports to any address,
/// and System `CreateAccount` refuses an address that already holds some, so an address that was
/// funded first is topped up, allocated and assigned instead. Without this, a stranger could block
/// a mint's setup for good by funding its meta-list address before the issuer creates the list.
fn create_program_account<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    space: usize,
    signer_seeds: &[&[&[u8]]],
    owner: &Pubkey,
) -> Result<()> {
    let required = Rent::get()?.minimum_balance(space);
    let current = account.lamports();
    if current == 0 {
        return create_account(
            CpiContext::new(
                system_program.clone(),
                CreateAccount {
                    from: payer.clone(),
                    to: account.clone(),
                },
            )
            .with_signer(signer_seeds),
            required,
            space as u64,
            owner,
        );
    }
    let top_up = required.saturating_sub(current);
    if top_up > 0 {
        transfer(
            CpiContext::new(
                system_program.clone(),
                Transfer {
                    from: payer.clone(),
                    to: account.clone(),
                },
            ),
            top_up,
        )?;
    }
    // `allocate` fails ("already in use") unless the account is still an empty system account, so
    // an existing list cannot be overwritten this way.
    allocate(
        CpiContext::new(
            system_program.clone(),
            Allocate {
                account_to_allocate: account.clone(),
            },
        )
        .with_signer(signer_seeds),
        space as u64,
    )?;
    assign(
        CpiContext::new(
            system_program.clone(),
            Assign {
                account_to_assign: account.clone(),
            },
        )
        .with_signer(signer_seeds),
        owner,
    )
}

/// Freeze (`true`) or thaw the token account, signing as the mint's freeze authority. Token-2022
/// checks the rest: the account belongs to the mint, it is not already in that state, and the
/// mint's freeze authority is the signer.
fn set_frozen(ctx: &Context<SetFrozen>, freeze: bool) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let bump = [ctx.bumps.freeze_authority];
    let signer_seeds: &[&[&[u8]]] = &[&[FREEZE_AUTHORITY_SEED, mint_key.as_ref(), &bump]];
    let program = ctx.accounts.token_program.to_account_info();
    let account = ctx.accounts.token_account.to_account_info();
    let mint = ctx.accounts.mint.to_account_info();
    let authority = ctx.accounts.freeze_authority.to_account_info();
    if freeze {
        token_2022::freeze_account(CpiContext::new_with_signer(
            program,
            token_2022::FreezeAccount {
                account,
                mint,
                authority,
            },
            signer_seeds,
        ))
    } else {
        token_2022::thaw_account(CpiContext::new_with_signer(
            program,
            token_2022::ThawAccount {
                account,
                mint,
                authority,
            },
            signer_seeds,
        ))
    }
}

fn emit_frozen(
    ctx: &Context<SetFrozen>,
    action: EnforcementKind,
    reason_code: u16,
    case_ref: [u8; 32],
) {
    emit!(EnforcementAction {
        mint: ctx.accounts.mint.key(),
        wallet: token_account_owner(&ctx.accounts.token_account),
        token_account: ctx.accounts.token_account.key(),
        action,
        reason_code,
        case_ref,
        authority: ctx.accounts.authority.key(),
    });
}

/// Whether `signer` may do an action that needs `needed`: it is the policy authority (the admin), or
/// `role` is its `RoleEntry` for the policy's mint and holds every bit of `needed`. `role` is checked
/// by content rather than by address: an account of this program with the `RoleEntry` type can only
/// have been written by `grant_role` / `update_role` at the address of its own mint and holder.
fn authorize(
    policy: &PolicyConfig,
    signer: &Pubkey,
    role: &Option<Account<RoleEntry>>,
    needed: u16,
) -> Result<()> {
    if *signer == policy.authority {
        return Ok(());
    }
    match role {
        Some(role)
            if role.mint == policy.mint
                && role.holder == *signer
                && role.epoch == policy.role_epoch
                && role.permissions & needed == needed =>
        {
            Ok(())
        }
        _ => err!(VigilantisError::Unauthorized),
    }
}

/// A role must hold at least one permission, and only known ones.
fn require_valid_permissions(permissions: u16) -> Result<()> {
    require!(
        permissions != 0 && permissions & !permission::ALL == 0,
        VigilantisError::InvalidPermissions
    );
    Ok(())
}

/// Record the time of this freeze in the token account's `FreezeRecord`, creating it (the signer
/// pays) or, if one is left from an earlier freeze that was undone outside Vigilantis, overwriting
/// it, so the seizure delay always counts from the latest freeze through Vigilantis.
fn write_freeze_record(ctx: &Context<SetFrozen>) -> Result<()> {
    let clock = Clock::get()?;
    let mint = ctx.accounts.mint.key();
    let token_account = ctx.accounts.token_account.key();
    let info = ctx.accounts.freeze_record.to_account_info();
    if info.owner == &crate::ID && !info.data_is_empty() {
        let mut data = info.try_borrow_mut_data()?;
        let mut record = FreezeRecord::try_deserialize(&mut &data[..])?;
        record.frozen_at = clock.unix_timestamp;
        record.slot = clock.slot;
        record.try_serialize(&mut &mut data[..])?;
        return Ok(());
    }
    let bump = ctx.bumps.freeze_record;
    let signer_seeds: &[&[&[u8]]] = &[&[
        FREEZE_RECORD_SEED,
        mint.as_ref(),
        token_account.as_ref(),
        &[bump],
    ]];
    create_program_account(
        &ctx.accounts.authority.to_account_info(),
        &info,
        &ctx.accounts.system_program.to_account_info(),
        FreezeRecord::LEN,
        signer_seeds,
        ctx.program_id,
    )?;
    let record = FreezeRecord {
        mint,
        token_account,
        frozen_at: clock.unix_timestamp,
        slot: clock.slot,
        bump,
    };
    let mut data = info.try_borrow_mut_data()?;
    record.try_serialize(&mut &mut data[..])?;
    Ok(())
}

/// Delete the token account's `FreezeRecord` after a thaw, if it has one, and return its rent to
/// the signer. An account frozen before Vigilantis 1.0, or by another freeze authority, has none.
fn close_freeze_record(ctx: &Context<SetFrozen>) -> Result<()> {
    let info = ctx.accounts.freeze_record.to_account_info();
    if info.owner == &crate::ID && !info.data_is_empty() {
        // What Anchor's `close` constraint does: move the rent out, hand the account back to the
        // System Program and empty it, so it cannot be read as a record again.
        let destination = ctx.accounts.authority.to_account_info();
        let lamports = info.lamports();
        **destination.try_borrow_mut_lamports()? = destination
            .lamports()
            .checked_add(lamports)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        **info.try_borrow_mut_lamports()? = 0;
        info.assign(&anchor_lang::system_program::ID);
        info.resize(0)?;
    }
    Ok(())
}

/// Pause (`true`) or resume the mint through Token-2022's Pausable extension, signing as its pause
/// authority. Token-2022 checks that the signer is the mint's pause authority.
fn set_paused(ctx: &Context<SetPaused>, pause: bool) -> Result<()> {
    let mint = ctx.accounts.mint.key();
    let pause_authority = ctx.accounts.pause_authority.key();
    require!(
        pause_authority_of(&ctx.accounts.mint)? == Some(pause_authority),
        VigilantisError::PauseAuthorityNotVigilantis
    );
    let bump = [ctx.bumps.pause_authority];
    let signer_seeds: &[&[&[u8]]] = &[&[PAUSE_AUTHORITY_SEED, mint.as_ref(), &bump]];
    let action = if pause {
        PAUSABLE_PAUSE
    } else {
        PAUSABLE_RESUME
    };
    invoke_signed(
        &Instruction {
            program_id: ctx.accounts.token_program.key(),
            accounts: vec![
                AccountMeta::new(mint, false),
                AccountMeta::new_readonly(pause_authority, true),
            ],
            data: vec![TOKEN_IX_PAUSABLE_EXTENSION, action],
        },
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.pause_authority.to_account_info(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

fn emit_paused(
    ctx: &Context<SetPaused>,
    action: EnforcementKind,
    reason_code: u16,
    case_ref: [u8; 32],
) {
    emit!(EnforcementAction {
        mint: ctx.accounts.mint.key(),
        wallet: Pubkey::default(),
        token_account: Pubkey::default(),
        action,
        reason_code,
        case_ref,
        authority: ctx.accounts.authority.key(),
    });
}

/// The pause authority of a Token-2022 mint: `Ok(None)` if it has the Pausable extension with no
/// authority, an error if it is not a Token-2022 mint with that extension.
fn pause_authority_of(mint: &AccountInfo) -> Result<Option<Pubkey>> {
    let data = mint.try_borrow_data()?;
    require!(
        mint_extension(&data, EXTENSION_PAUSABLE).is_some(),
        VigilantisError::PauseAuthorityNotVigilantis
    );
    Ok(mint_extension_address(&data, EXTENSION_PAUSABLE))
}

/// The value of extension `extension_type` in a Token-2022 mint's data, or `None` if the account is
/// not an extended mint or has no such extension.
fn mint_extension(data: &[u8], extension_type: u16) -> Option<&[u8]> {
    extension_of(data, ACCOUNT_TYPE_MINT, extension_type)
}

/// The value of extension `extension_type` in a Token-2022 token account's data, or `None` if the
/// account is not an extended token account or has no such extension.
fn token_account_extension(data: &[u8], extension_type: u16) -> Option<&[u8]> {
    extension_of(data, ACCOUNT_TYPE_ACCOUNT, extension_type)
}

/// The TLV reader behind `mint_extension` and `token_account_extension`. Mints and token accounts
/// both put their account type at offset 165 and their extensions right after it.
fn extension_of(data: &[u8], account_type: u8, extension_type: u16) -> Option<&[u8]> {
    if data.len() <= MINT_ACCOUNT_TYPE_OFFSET || data[MINT_ACCOUNT_TYPE_OFFSET] != account_type {
        return None;
    }
    let mut at = MINT_ACCOUNT_TYPE_OFFSET + 1;
    while at.checked_add(4)? <= data.len() {
        let kind = u16::from_le_bytes([data[at], data[at + 1]]);
        let len = usize::from(u16::from_le_bytes([data[at + 2], data[at + 3]]));
        let start = at + 4;
        let end = start.checked_add(len)?;
        if end > data.len() {
            return None;
        }
        if kind == extension_type {
            return Some(&data[start..end]);
        }
        if kind == 0 {
            // Uninitialized: nothing follows.
            return None;
        }
        at = end;
    }
    None
}

/// The address at the start of extension `extension_type` (the permanent delegate, or the pause
/// authority), or `None` if there is no such extension or the address is unset (all zeros).
fn mint_extension_address(data: &[u8], extension_type: u16) -> Option<Pubkey> {
    let value = mint_extension(data, extension_type)?;
    let bytes: [u8; 32] = value.get(..32)?.try_into().ok()?;
    let address = Pubkey::new_from_array(bytes);
    (address != Pubkey::default()).then_some(address)
}

/// Whether the Pausable mint is paused right now.
fn is_paused(mint: &AccountInfo) -> Result<bool> {
    let data = mint.try_borrow_data()?;
    let value = mint_extension(&data, EXTENSION_PAUSABLE)
        .ok_or(VigilantisError::PauseAuthorityNotVigilantis)?;
    Ok(value.get(PAUSABLE_PAUSED_OFFSET).is_some_and(|b| *b != 0))
}

/// Whether `address` is one of the addresses Vigilantis derives for `mint`. None of them can sign
/// as a freeze or pause authority for someone else, so handing an authority to one loses it.
fn is_vigilantis_address(mint: &Pubkey, address: &Pubkey) -> bool {
    [
        POLICY_SEED,
        META_LIST_SEED,
        FREEZE_AUTHORITY_SEED,
        PAUSE_AUTHORITY_SEED,
        PERMANENT_DELEGATE_SEED,
        PENDING_AUTHORITY_SEED,
    ]
    .iter()
    .any(|seed| Pubkey::find_program_address(&[seed, mint.as_ref()], &crate::ID).0 == *address)
}

/// Refuse a call of the hook that is not part of a Token-2022 transfer of this mint: both token
/// accounts must be Token-2022 accounts of the mint, and the source must carry the `transferring`
/// flag, which Token-2022 sets on both accounts just before it calls the hook and clears after.
fn require_in_transfer(ctx: &Context<TransferHook>) -> Result<()> {
    let mint = ctx.accounts.mint.key();
    for account in [&ctx.accounts.source_token, &ctx.accounts.destination_token] {
        require_keys_eq!(
            *account.owner,
            token_2022::ID,
            VigilantisError::NotInTransfer
        );
        let data = account.try_borrow_data()?;
        require!(
            data.len() > TOKEN_ACCOUNT_BASE_LEN && data[..32] == mint.to_bytes(),
            VigilantisError::NotInTransfer
        );
    }
    let data = ctx.accounts.source_token.try_borrow_data()?;
    let transferring = token_account_extension(&data, EXTENSION_TRANSFER_HOOK_ACCOUNT)
        .and_then(|value| value.first())
        .is_some_and(|flag| *flag != 0);
    require!(transferring, VigilantisError::NotInTransfer);
    Ok(())
}

/// Both token accounts must have an owner that cannot change. Otherwise a holder could hand a
/// whole account, with its balance, to someone the rules would refuse (SetAuthority on the account
/// owner does not call the hook), and that someone could spend from it and hand it on again.
fn check_owners_fixed(ctx: &Context<TransferHook>) -> core::result::Result<(), VigilantisError> {
    for account in [&ctx.accounts.source_token, &ctx.accounts.destination_token] {
        let data = account
            .try_borrow_data()
            .map_err(|_| VigilantisError::OwnerCanChange)?;
        if token_account_extension(&data, EXTENSION_IMMUTABLE_OWNER).is_none() {
            return Err(VigilantisError::OwnerCanChange);
        }
    }
    Ok(())
}

/// An entry account (allow or block) is "active" when it exists: owned by this
/// program with non-empty data. A non-existent PDA is owned by the system program.
fn is_active(account: &AccountInfo, program_id: &Pubkey) -> bool {
    account.owner == program_id && !account.data_is_empty()
}

/// The accounts the hook needs on every transfer, in the order the `TransferHook` accounts and
/// `remaining_accounts` expect them. Index 0-4 are fixed by the transfer-hook interface: source,
/// mint, destination, transfer authority, this list.
fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    let block_entry_of_owner = |account_index: u8| -> Result<ExtraAccountMeta> {
        Ok(ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: BLOCK_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountData {
                    account_index,
                    data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                    length: 32,
                },
            ],
            false,
            false,
        )?)
    };
    Ok(vec![
        // index 5: policy config ["policy", mint]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: POLICY_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        // index 6: sender block entry ["block", mint, source_owner]
        block_entry_of_owner(0)?,
        // index 7: recipient block entry ["block", mint, dest_owner]
        block_entry_of_owner(2)?,
        // index 8: recipient allow entry ["allow", mint, dest_owner]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: ALLOW_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountData {
                    account_index: 2,
                    data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                    length: 32,
                },
            ],
            false,
            false,
        )?,
        // index 9 (2.1): transfer authority block entry ["block", mint, authority]. Same as
        // index 6 when the owner signs; differs when a delegate moves the tokens.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: BLOCK_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 3 },
            ],
            false,
            false,
        )?,
    ])
}

/// Evaluate the mint's policy for one transfer. `Err` carries the rule that refused it.
fn check_transfer(
    ctx: &Context<TransferHook>,
    amount: u64,
    is_confidential: bool,
) -> core::result::Result<(), VigilantisError> {
    let policy = &ctx.accounts.policy_config;

    // Limit rule. A confidential transfer hides its amount from the hook, so the limit cannot be
    // checked. Refuse rather than wave it through, unless the policy has opted in to going
    // without the limit.
    if policy.max_transfer_amount > 0 {
        if is_confidential {
            if !policy.allow_confidential {
                return Err(VigilantisError::ConfidentialAmountNotEnforceable);
            }
        } else if amount > policy.max_transfer_amount {
            return Err(VigilantisError::TransferExceedsLimit);
        }
    }

    // Blocklist rule: neither party may be blocked, nor the authority moving the tokens.
    if policy.blocklist_enabled {
        if is_active(&ctx.accounts.source_block, ctx.program_id) {
            return Err(VigilantisError::SenderBlocked);
        }
        if is_active(&ctx.accounts.dest_block, ctx.program_id) {
            return Err(VigilantisError::RecipientBlocked);
        }
        // Present only once the mint's meta list carries index 9 (2.1). It arrives through
        // `remaining_accounts`, so its content is checked rather than trusted: it blocks only
        // if it is this program's `BlockEntry` for this mint and this authority.
        if let Some(entry) = ctx.remaining_accounts.first() {
            if is_block_entry_for(entry, &ctx.accounts.mint.key(), &ctx.accounts.owner.key()) {
                return Err(VigilantisError::AuthorityBlocked);
            }
        }
    }

    // Allowlist rule (recipient must be allowlisted).
    if policy.allowlist_enabled && !is_active(&ctx.accounts.allow_entry, ctx.program_id) {
        return Err(VigilantisError::RecipientNotAllowlisted);
    }
    Ok(())
}

/// Whether `account` is this program's `BlockEntry` for (`mint`, `wallet`).
fn is_block_entry_for(account: &AccountInfo, mint: &Pubkey, wallet: &Pubkey) -> bool {
    if account.owner != &crate::ID {
        return false;
    }
    let Ok(data) = account.try_borrow_data() else {
        return false;
    };
    let mut bytes: &[u8] = &data;
    match BlockEntry::try_deserialize(&mut bytes) {
        Ok(entry) => entry.mint == *mint && entry.wallet == *wallet,
        Err(_) => false,
    }
}

/// The `owner` field of an SPL token account, or the default address if the data is too short.
fn token_account_owner(account: &AccountInfo) -> Pubkey {
    let start = TOKEN_ACCOUNT_OWNER_OFFSET as usize;
    account
        .try_borrow_data()
        .ok()
        .and_then(|data| data.get(start..start + 32).map(Pubkey::try_from))
        .and_then(|owner| owner.ok())
        .unwrap_or_default()
}

/// Per-mint compliance policy: which rules are active and their parameters.
#[account]
pub struct PolicyConfig {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub allowlist_enabled: bool,
    pub blocklist_enabled: bool,
    pub max_transfer_amount: u64,
    /// Permit confidential transfers on a mint that also sets
    /// `max_transfer_amount`. The limit cannot be enforced on an encrypted
    /// amount, so the issuer opts in to that gap explicitly. Irrelevant when no
    /// limit is set, because there is then nothing to enforce.
    pub allow_confidential: bool,
    pub bump: u8,
    /// Increased by every `accept_authority`. A role works only while its `epoch` equals this, so
    /// a handover of the policy ends every role granted before it.
    pub role_epoch: u32,
}

impl PolicyConfig {
    const LEN: usize = 8 + 32 + 32 + 1 + 1 + 8 + 1 + 1 + 4;
}

/// An allowlist entry: its existence means `wallet` may receive `mint`.
#[account]
pub struct AllowEntry {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub bump: u8,
}

/// A blocklist entry: its existence means `wallet` may neither send nor receive `mint`.
#[account]
pub struct BlockEntry {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub bump: u8,
}

/// Shared on-chain size for the simple (mint, wallet, bump) entry accounts.
const ENTRY_LEN: usize = 8 + 32 + 32 + 1;

/// A proposed handover of a mint's policy authority, waiting for `new_authority` to accept.
#[account]
pub struct PendingAuthority {
    pub mint: Pubkey,
    pub new_authority: Pubkey,
    pub bump: u8,
}

impl PendingAuthority {
    const LEN: usize = 8 + 32 + 32 + 1;
}

/// A role: `holder` may do the actions in `permissions` (bits of [`permission`]) for `mint`.
#[account]
pub struct RoleEntry {
    pub mint: Pubkey,
    pub holder: Pubkey,
    pub permissions: u16,
    pub bump: u8,
    /// The policy's `role_epoch` when the role was granted or last updated. The role works only
    /// while the two are equal.
    pub epoch: u32,
}

impl RoleEntry {
    const LEN: usize = 8 + 32 + 32 + 2 + 1 + 4;
}

/// When Vigilantis last froze `token_account`. Written by `freeze_token_account`, deleted by
/// `thaw_token_account`, read by `seize`.
#[account]
pub struct FreezeRecord {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    /// Unix time of the freeze.
    pub frozen_at: i64,
    pub slot: u64,
    pub bump: u8,
}

impl FreezeRecord {
    const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

/// An open seizure: `amount` of `wallet`'s public balance in `token_account` was burnt. Closed by
/// `close_seizure` once the case is settled.
#[account]
pub struct SeizureRecord {
    pub mint: Pubkey,
    /// The owner of the token account at the time of the seizure.
    pub wallet: Pubkey,
    pub token_account: Pubkey,
    pub amount: u64,
    pub reason_code: u16,
    pub case_ref: [u8; 32],
    /// Who seized.
    pub authority: Pubkey,
    /// Unix time of the seizure.
    pub seized_at: i64,
    pub slot: u64,
    pub bump: u8,
}

impl SeizureRecord {
    const LEN: usize = 8 + 32 + 32 + 32 + 8 + 2 + 32 + 32 + 8 + 8 + 1;
}

/// How a seizure ended, recorded by `close_seizure`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SeizureOutcome {
    /// The equivalent was given back to the owner.
    ReturnedToOwner,
    /// The equivalent was paid to the victim.
    PaidToVictim,
    /// The equivalent was paid to the State Treasury or a court.
    PaidToState,
    /// Anything else; the issuer's case file says what.
    Other,
}

#[derive(Accounts)]
pub struct InitializePolicy<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        constraint = mint.mint_authority == COption::Some(authority.key()) @ VigilantisError::Unauthorized,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = PolicyConfig::LEN,
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub authority: Signer<'info>,

    /// CHECK: the mint whose policy is governed (address only, used for the seed).
    pub mint: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ VigilantisError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: PDA that stores the extra-account-meta list; created & written here.
    #[account(
        mut,
        seeds = [META_LIST_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    #[account(
        constraint = mint.mint_authority == COption::Some(payer.key()) @ VigilantisError::Unauthorized,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddToAllowlist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: the wallet being allowlisted (address only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = ENTRY_LEN,
        seeds = [ALLOW_SEED, mint.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub allow_entry: Account<'info, AllowEntry>,

    pub system_program: Program<'info, System>,

    /// The signer's `RoleEntry` for this mint, when the signer is not the admin.
    pub role: Option<Account<'info, RoleEntry>>,
}

#[derive(Accounts)]
pub struct RemoveFromAllowlist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: the wallet being removed (address only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        close = authority,
        seeds = [ALLOW_SEED, mint.key().as_ref(), wallet.key().as_ref()],
        bump = allow_entry.bump
    )]
    pub allow_entry: Account<'info, AllowEntry>,

    /// The signer's `RoleEntry` for this mint, when the signer is not the admin.
    pub role: Option<Account<'info, RoleEntry>>,
}

#[derive(Accounts)]
pub struct AddToBlocklist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: the wallet being blocklisted (address only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = ENTRY_LEN,
        seeds = [BLOCK_SEED, mint.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub block_entry: Account<'info, BlockEntry>,

    pub system_program: Program<'info, System>,

    /// The signer's `RoleEntry` for this mint, when the signer is not the admin.
    pub role: Option<Account<'info, RoleEntry>>,
}

#[derive(Accounts)]
pub struct RemoveFromBlocklist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: the wallet being removed (address only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        close = authority,
        seeds = [BLOCK_SEED, mint.key().as_ref(), wallet.key().as_ref()],
        bump = block_entry.bump
    )]
    pub block_entry: Account<'info, BlockEntry>,

    /// The signer's `RoleEntry` for this mint, when the signer is not the admin.
    pub role: Option<Account<'info, RoleEntry>>,
}

#[derive(Accounts)]
pub struct UpdateExtraAccountMetaList<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: the mint whose list is rewritten (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ VigilantisError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: this program's ExtraAccountMetaList PDA for `mint`; resized and rewritten here.
    #[account(
        mut,
        seeds = [META_LIST_SEED, mint.key().as_ref()],
        bump,
        owner = crate::ID,
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: the mint whose policy is handed over (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ VigilantisError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    #[account(
        init,
        payer = authority,
        space = PendingAuthority::LEN,
        seeds = [PENDING_AUTHORITY_SEED, mint.key().as_ref()],
        bump
    )]
    pub pending_authority: Account<'info, PendingAuthority>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelAuthorityTransfer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: the mint whose policy was being handed over (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ VigilantisError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    #[account(
        mut,
        close = authority,
        seeds = [PENDING_AUTHORITY_SEED, mint.key().as_ref()],
        bump = pending_authority.bump,
    )]
    pub pending_authority: Account<'info, PendingAuthority>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub new_authority: Signer<'info>,

    /// CHECK: the outgoing authority, which paid for the proposal and gets its rent back.
    #[account(mut, address = policy_config.authority @ VigilantisError::Unauthorized)]
    pub previous_authority: AccountInfo<'info>,

    /// CHECK: the mint whose policy is handed over (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    #[account(
        mut,
        close = previous_authority,
        seeds = [PENDING_AUTHORITY_SEED, mint.key().as_ref()],
        bump = pending_authority.bump,
        constraint = pending_authority.new_authority == new_authority.key() @ VigilantisError::Unauthorized,
    )]
    pub pending_authority: Account<'info, PendingAuthority>,
}

#[derive(Accounts)]
pub struct SetFrozen<'info> {
    /// The admin or a role holder; pays for the `FreezeRecord` of a freeze and gets it back on a
    /// thaw.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        constraint = mint.freeze_authority == COption::Some(freeze_authority.key())
            @ VigilantisError::FreezeAuthorityNotVigilantis,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: a token account of `mint`. Token-2022 checks it during the freeze or thaw (owner
    /// program, mint, current state); Vigilantis only reads its owner for the event.
    #[account(mut, owner = token_program.key())]
    pub token_account: UncheckedAccount<'info>,

    /// CHECK: Vigilantis's freeze-authority PDA for `mint`; holds no data and signs the CPI.
    #[account(seeds = [FREEZE_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub freeze_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,

    /// CHECK: the token account's `FreezeRecord` PDA. Created or overwritten by a freeze, deleted
    /// by a thaw; it may not exist (an account frozen before 1.0 or by another freeze authority).
    #[account(
        mut,
        seeds = [FREEZE_RECORD_SEED, mint.key().as_ref(), token_account.key().as_ref()],
        bump
    )]
    pub freeze_record: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// The signer's `RoleEntry` for this mint, when the signer is not the admin.
    pub role: Option<Account<'info, RoleEntry>>,
}

#[derive(Accounts)]
pub struct SetFreezeAuthority<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = mint.freeze_authority == COption::Some(freeze_authority.key())
            @ VigilantisError::FreezeAuthorityNotVigilantis,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ VigilantisError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: Vigilantis's freeze-authority PDA for `mint`; holds no data and signs the CPI.
    #[account(seeds = [FREEZE_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub freeze_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub authority: Signer<'info>,

    /// CHECK: a Token-2022 mint with the Pausable extension; Vigilantis reads its pause authority
    /// and Token-2022 checks the rest.
    #[account(mut, owner = token_program.key())]
    pub mint: UncheckedAccount<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: Vigilantis's pause-authority PDA for `mint`; holds no data and signs the CPI.
    #[account(seeds = [PAUSE_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub pause_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,

    /// The signer's `RoleEntry` for this mint, when the signer is not the admin.
    pub role: Option<Account<'info, RoleEntry>>,
}

#[derive(Accounts)]
pub struct SetPauseAuthority<'info> {
    pub authority: Signer<'info>,

    /// CHECK: a Token-2022 mint with the Pausable extension; see `SetPaused`.
    #[account(mut, owner = token_program.key())]
    pub mint: UncheckedAccount<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ VigilantisError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: Vigilantis's pause-authority PDA for `mint`; holds no data and signs the CPI.
    #[account(seeds = [PAUSE_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub pause_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
#[instruction(reason_code: u16, case_ref: [u8; 32])]
pub struct Seize<'info> {
    /// The admin or a role holder; pays for the `SeizureRecord`.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = mint.freeze_authority == COption::Some(freeze_authority.key())
            @ VigilantisError::FreezeAuthorityNotVigilantis,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: a token account of `mint`, frozen; its mint, state and amount are read in `seize`
    /// and Token-2022 checks it again in the thaw, burn and freeze.
    #[account(mut, owner = token_program.key())]
    pub token_account: UncheckedAccount<'info>,

    /// When Vigilantis froze `token_account`; without one, the account cannot be seized.
    #[account(
        seeds = [FREEZE_RECORD_SEED, mint.key().as_ref(), token_account.key().as_ref()],
        bump = freeze_record.bump,
    )]
    pub freeze_record: Account<'info, FreezeRecord>,

    #[account(
        init,
        payer = authority,
        space = SeizureRecord::LEN,
        seeds = [SEIZURE_SEED, mint.key().as_ref(), token_account.key().as_ref(), case_ref.as_ref()],
        bump
    )]
    pub seizure_record: Account<'info, SeizureRecord>,

    /// CHECK: Vigilantis's freeze-authority PDA for `mint`; holds no data and signs the CPIs.
    #[account(seeds = [FREEZE_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub freeze_authority: UncheckedAccount<'info>,

    /// CHECK: Vigilantis's permanent-delegate PDA for `mint`; holds no data and signs the burn.
    #[account(seeds = [PERMANENT_DELEGATE_SEED, mint.key().as_ref()], bump)]
    pub permanent_delegate: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,

    /// The signer's `RoleEntry` for this mint, when the signer is not the admin.
    pub role: Option<Account<'info, RoleEntry>>,
}

#[derive(Accounts)]
pub struct CloseSeizure<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: the mint of the seizure (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    #[account(
        mut,
        close = authority,
        seeds = [
            SEIZURE_SEED,
            mint.key().as_ref(),
            seizure_record.token_account.as_ref(),
            seizure_record.case_ref.as_ref(),
        ],
        bump = seizure_record.bump,
    )]
    pub seizure_record: Account<'info, SeizureRecord>,

    /// The signer's `RoleEntry` for this mint, when the signer is not the admin.
    pub role: Option<Account<'info, RoleEntry>>,
}

#[derive(Accounts)]
pub struct GrantRole<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: the mint the role is for (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ VigilantisError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: the address that gets the role (address only).
    pub holder: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = RoleEntry::LEN,
        seeds = [ROLE_SEED, mint.key().as_ref(), holder.key().as_ref()],
        bump
    )]
    pub role: Account<'info, RoleEntry>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRole<'info> {
    pub authority: Signer<'info>,

    /// CHECK: the mint the role is for (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ VigilantisError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    #[account(
        mut,
        seeds = [ROLE_SEED, mint.key().as_ref(), role.holder.as_ref()],
        bump = role.bump,
    )]
    pub role: Account<'info, RoleEntry>,
}

#[derive(Accounts)]
pub struct RevokeRole<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: the mint the role is for (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ VigilantisError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    #[account(
        mut,
        close = authority,
        seeds = [ROLE_SEED, mint.key().as_ref(), role.holder.as_ref()],
        bump = role.bump,
    )]
    pub role: Account<'info, RoleEntry>,
}

#[derive(Accounts)]
pub struct RenounceRole<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,

    /// CHECK: the mint the role is for (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        mut,
        close = holder,
        seeds = [ROLE_SEED, mint.key().as_ref(), holder.key().as_ref()],
        bump = role.bump,
    )]
    pub role: Account<'info, RoleEntry>,
}

/// Accounts for the Transfer Hook `Execute`. Order is fixed by the interface:
/// source, mint, destination, source authority, meta-list PDA, then our declared
/// extra accounts (policy, sender block, recipient block, recipient allow).
///
/// From 2.1 the list has a fifth extra account, the transfer authority's blocklist entry. It is
/// read from `remaining_accounts`, so mints whose list predates 2.1 keep working without it.
///
/// The entry accounts are bare `AccountInfo`: Token-2022 resolves them
/// deterministically from the ExtraAccountMetaList (by mint + the token accounts'
/// owner fields), and the hook only runs via Token-2022's CPI — so a caller
/// cannot substitute a different allow/block entry.
#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// CHECK: source token account
    pub source_token: AccountInfo<'info>,
    /// CHECK: mint
    pub mint: AccountInfo<'info>,
    /// CHECK: destination token account
    pub destination_token: AccountInfo<'info>,
    /// CHECK: source authority (owner or delegate)
    pub owner: AccountInfo<'info>,
    /// CHECK: ExtraAccountMetaList PDA for this mint
    #[account(seeds = [META_LIST_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: AccountInfo<'info>,
    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump
    )]
    pub policy_config: Account<'info, PolicyConfig>,
    /// CHECK: sender's blocklist entry PDA; may be uninitialized (= not blocked)
    pub source_block: AccountInfo<'info>,
    /// CHECK: recipient's blocklist entry PDA; may be uninitialized (= not blocked)
    pub dest_block: AccountInfo<'info>,
    /// CHECK: recipient's allowlist entry PDA; may be uninitialized (= not allowlisted)
    pub allow_entry: AccountInfo<'info>,
}

#[error_code]
pub enum VigilantisError {
    #[msg("Recipient is not on the allowlist for this mint")]
    RecipientNotAllowlisted,
    #[msg("Transfer amount exceeds the policy limit")]
    TransferExceedsLimit,
    #[msg("Sender is blocklisted for this mint")]
    SenderBlocked,
    #[msg("Recipient is blocklisted for this mint")]
    RecipientBlocked,
    #[msg("The signer is neither the policy authority nor a role holder with this permission")]
    Unauthorized,
    // Appended, so the existing variants keep their error codes.
    #[msg("This mint sets a transfer limit, which cannot be enforced on a confidential transfer; set allow_confidential on the policy to permit them")]
    ConfidentialAmountNotEnforceable,
    #[msg(
        "The transfer authority (a delegate of the source account) is blocklisted for this mint"
    )]
    AuthorityBlocked,
    #[msg("The new authority must be a real address and differ from the current one")]
    InvalidAuthority,
    #[msg(
        "The mint's freeze authority is not Vigilantis's freeze-authority address for this mint"
    )]
    FreezeAuthorityNotVigilantis,
    #[msg("A role needs at least one permission, and only known ones")]
    InvalidPermissions,
    #[msg("The mint is not Pausable, or its pause authority is not Vigilantis's pause-authority address for this mint")]
    PauseAuthorityNotVigilantis,
    #[msg("The mint's permanent delegate is not Vigilantis's permanent-delegate address for this mint")]
    PermanentDelegateNotVigilantis,
    #[msg("The token account is not frozen")]
    AccountNotFrozen,
    #[msg("The token account has no public balance to seize")]
    NothingToSeize,
    #[msg("The token account was frozen through Vigilantis less than 24 hours ago")]
    SeizeTooEarly,
    #[msg("A seizure needs a case reference")]
    InvalidCaseRef,
    #[msg("Not a token account of this mint")]
    InvalidTokenAccount,
    #[msg("The transfer hook was called outside a Token-2022 transfer of this mint")]
    NotInTransfer,
    #[msg("A token account of this mint must have an owner that cannot change (the ImmutableOwner extension, which every associated token account has)")]
    OwnerCanChange,
    #[msg("Resume the mint before handing on or giving up its pause authority")]
    PausedMintHandover,
}

/// What an `EnforcementAction` did.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EnforcementKind {
    Block,
    Unblock,
    Freeze,
    Thaw,
    // Appended in 1.0, so the earlier values keep their numbers.
    Pause,
    Resume,
    Seize,
    CloseSeizure,
}

/// Which list an entry belongs to.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ListKind {
    Allow,
    Block,
}

#[event]
pub struct PolicyInitialized {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub allowlist_enabled: bool,
    pub blocklist_enabled: bool,
    pub max_transfer_amount: u64,
    pub allow_confidential: bool,
}

#[event]
pub struct PolicyUpdated {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub allowlist_enabled: bool,
    pub blocklist_enabled: bool,
    pub max_transfer_amount: u64,
    pub allow_confidential: bool,
}

#[event]
pub struct ListEntryAdded {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub list: ListKind,
}

#[event]
pub struct ListEntryRemoved {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub list: ListKind,
}

#[event]
pub struct MetaListUpdated {
    pub mint: Pubkey,
    pub entries: u8,
}

#[event]
pub struct AuthorityTransferProposed {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct AuthorityTransferCancelled {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct AuthorityTransferred {
    pub mint: Pubkey,
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted by `block_wallet`, `unblock_wallet`, `freeze_token_account`, `thaw_token_account`,
/// `pause`, `resume`, `seize` and `close_seizure`: what was done, to whom, and the issuer's reason. Vigilantis does not interpret `reason_code`;
/// `case_ref` points to the issuer's own case file (for example a salted hash of its case number),
/// so no personal data needs to go on-chain.
#[event]
pub struct EnforcementAction {
    pub mint: Pubkey,
    /// The blocked or unblocked wallet, or the owner of the frozen, thawed or seized token account;
    /// the default address for a pause or resume.
    pub wallet: Pubkey,
    /// The frozen, thawed or seized token account; the default address for a block, unblock, pause
    /// or resume.
    pub token_account: Pubkey,
    pub action: EnforcementKind,
    pub reason_code: u16,
    pub case_ref: [u8; 32],
    pub authority: Pubkey,
}

/// Emitted by `set_freeze_authority` (2.3): Vigilantis handed the mint's freeze authority to
/// `new_freeze_authority`, or gave it up (`None`). Freezes after this are no longer Vigilantis's.
#[event]
pub struct FreezeAuthorityChanged {
    pub mint: Pubkey,
    pub new_freeze_authority: Option<Pubkey>,
    pub reason_code: u16,
    pub case_ref: [u8; 32],
    pub authority: Pubkey,
}

/// Emitted by the hook just before it refuses a transfer. The transaction fails, but its logs
/// (and this event) stay readable. `error_code` is the `VigilantisError` code, e.g. 6003.
#[event]
pub struct TransferRefused {
    pub mint: Pubkey,
    pub source_owner: Pubkey,
    pub destination_owner: Pubkey,
    pub transfer_authority: Pubkey,
    pub confidential: bool,
    pub error_code: u32,
}

/// Emitted by `set_pause_authority`: Vigilantis handed the mint's pause authority to
/// `new_pause_authority`, or gave it up (`None`).
#[event]
pub struct PauseAuthorityChanged {
    pub mint: Pubkey,
    pub new_pause_authority: Option<Pubkey>,
    pub reason_code: u16,
    pub case_ref: [u8; 32],
    pub authority: Pubkey,
}

/// Emitted by `seize`, next to `EnforcementAction`: how much public balance was burnt.
#[event]
pub struct Seized {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub token_account: Pubkey,
    pub amount: u64,
    pub reason_code: u16,
    pub case_ref: [u8; 32],
    pub authority: Pubkey,
    pub seized_at: i64,
}

/// Emitted by `close_seizure`, next to `EnforcementAction`.
#[event]
pub struct SeizureClosed {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub token_account: Pubkey,
    pub amount: u64,
    pub case_ref: [u8; 32],
    pub outcome: SeizureOutcome,
    pub reason_code: u16,
    pub authority: Pubkey,
}

/// Emitted by `grant_role`, `update_role`, `revoke_role` and `renounce_role`. `permissions` is 0
/// when the role is gone; `authority` is the admin, or the holder for a renounce.
#[event]
pub struct RoleChanged {
    pub mint: Pubkey,
    pub holder: Pubkey,
    pub previous_permissions: u16,
    pub permissions: u16,
    pub authority: Pubkey,
}
