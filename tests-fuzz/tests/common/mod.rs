// SPDX-License-Identifier: BUSL-1.1
//! A Vigilantis mint in LiteSVM: the built program, Token-2022 v11.1 from `tests/fixtures`, and
//! plain builders for every Vigilantis instruction (Anchor discriminators and Borsh arguments, written
//! out by hand so this crate does not depend on the program crate).
// `send` returns LiteSVM's own error type, large but only ever built in tests.
#![allow(dead_code, clippy::result_large_err)]

use litesvm::{types::FailedTransactionMetadata, LiteSVM};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_token_2022_interface::{
    extension::{
        pausable, transfer_hook, BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::Mint,
};

pub const VIGILANTIS_ID: Pubkey =
    Pubkey::from_str_const("4DoDFZJmJWYuBx86UqXi3y24GkQ3Cq4nUBHZwDE5PQM5");
pub const TOKEN_2022_ID: Pubkey =
    Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const SYSTEM_ID: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");

/// Vigilantis's error codes (`VigilantisError` in the program, 6000 + position).
pub mod code {
    pub const RECIPIENT_NOT_ALLOWLISTED: u32 = 6000;
    pub const TRANSFER_EXCEEDS_LIMIT: u32 = 6001;
    pub const SENDER_BLOCKED: u32 = 6002;
    pub const RECIPIENT_BLOCKED: u32 = 6003;
    pub const UNAUTHORIZED: u32 = 6004;
    pub const CONFIDENTIAL_AMOUNT_NOT_ENFORCEABLE: u32 = 6005;
    pub const AUTHORITY_BLOCKED: u32 = 6006;
    pub const INVALID_AUTHORITY: u32 = 6007;
    pub const FREEZE_AUTHORITY_NOT_VIGILANTIS: u32 = 6008;
    pub const INVALID_PERMISSIONS: u32 = 6009;
    pub const PAUSE_AUTHORITY_NOT_VIGILANTIS: u32 = 6010;
    pub const PERMANENT_DELEGATE_NOT_VIGILANTIS: u32 = 6011;
    pub const ACCOUNT_NOT_FROZEN: u32 = 6012;
    pub const NOTHING_TO_SEIZE: u32 = 6013;
    pub const SEIZE_TOO_EARLY: u32 = 6014;
    pub const INVALID_CASE_REF: u32 = 6015;
    pub const INVALID_TOKEN_ACCOUNT: u32 = 6016;
    pub const NOT_IN_TRANSFER: u32 = 6017;
    pub const OWNER_CAN_CHANGE: u32 = 6018;
    pub const PAUSED_MINT_HANDOVER: u32 = 6019;
    pub const ACCOUNT_FORFEITED: u32 = 6020;
}

/// Anchor's own error codes that the model predicts.
pub mod anchor_code {
    pub const ACCOUNT_NOT_INITIALIZED: u32 = 3012;
}

/// Role permissions, as `permission` in the program.
pub mod perm {
    pub const ALLOWLIST: u16 = 1 << 0;
    pub const BLOCK: u16 = 1 << 1;
    pub const UNBLOCK: u16 = 1 << 2;
    pub const FREEZE: u16 = 1 << 3;
    pub const THAW: u16 = 1 << 4;
    pub const PAUSE: u16 = 1 << 5;
    pub const RESUME: u16 = 1 << 6;
    pub const SEIZE: u16 = 1 << 7;
    pub const CLOSE_SEIZURE: u16 = 1 << 8;
    pub const ALL: u16 = (1 << 9) - 1;
}

/// The program's 24-hour seizure delay, in seconds.
pub const SEIZE_DELAY_SECONDS: i64 = 24 * 60 * 60;

/// Token-2022's error codes that the model predicts (`TokenError`, by position).
pub mod token_code {
    pub const INVALID_STATE: u32 = 13;
    pub const ACCOUNT_FROZEN: u32 = 17;
    pub const MINT_PAUSED: u32 = 67;
}

/// Path of a file next to this crate, overridable by an environment variable.
fn path(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| format!("{}/{}", env!("CARGO_MANIFEST_DIR"), default))
}

/// A LiteSVM with Token-2022 v11.1 (the same build the integration tests use) and Vigilantis.
pub fn svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let token = path("TOKEN_2022_SO", "../tests/fixtures/spl_token_2022.so");
    let vigilantis = path("VIGILANTIS_SO", "../target/deploy/vigilantis.so");
    svm.add_program_from_file(TOKEN_2022_ID, &token)
        .unwrap_or_else(|e| panic!("loading {token}: {e:?}"));
    svm.add_program_from_file(VIGILANTIS_ID, &vigilantis)
        .unwrap_or_else(|e| panic!("loading {vigilantis}: {e:?} (run `anchor build` first)"));
    svm
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &VIGILANTIS_ID).0
}
pub fn policy_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"policy", mint.as_ref()])
}
pub fn meta_list_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"extra-account-metas", mint.as_ref()])
}
pub fn pending_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"pending-authority", mint.as_ref()])
}
pub fn allow_pda(mint: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[b"allow", mint.as_ref(), wallet.as_ref()])
}
pub fn block_pda(mint: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[b"block", mint.as_ref(), wallet.as_ref()])
}
pub fn freeze_authority_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"freeze-authority", mint.as_ref()])
}
pub fn pause_authority_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"pause-authority", mint.as_ref()])
}
pub fn permanent_delegate_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"permanent-delegate", mint.as_ref()])
}
pub fn role_pda(mint: &Pubkey, holder: &Pubkey) -> Pubkey {
    pda(&[b"role", mint.as_ref(), holder.as_ref()])
}
pub fn freeze_record_pda(mint: &Pubkey, account: &Pubkey) -> Pubkey {
    pda(&[b"freeze-record", mint.as_ref(), account.as_ref()])
}
pub fn seizure_pda(mint: &Pubkey, account: &Pubkey, case_ref: &[u8; 32]) -> Pubkey {
    pda(&[b"seizure", mint.as_ref(), account.as_ref(), case_ref])
}
pub fn forfeiture_pda(mint: &Pubkey, account: &Pubkey) -> Pubkey {
    pda(&[b"forfeiture", mint.as_ref(), account.as_ref()])
}

/// The first 8 bytes of sha256(`preimage`).
fn discriminator(preimage: &str) -> [u8; 8] {
    let hash = Sha256::digest(preimage.as_bytes());
    hash[..8].try_into().unwrap()
}

fn anchor_ix(name: &str, args: &[u8], accounts: Vec<AccountMeta>) -> Instruction {
    let mut data = discriminator(&format!("global:{name}")).to_vec();
    data.extend_from_slice(args);
    Instruction {
        program_id: VIGILANTIS_ID,
        accounts,
        data,
    }
}

fn w(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, false)
}
fn ws(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, true)
}
fn r(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}
fn rs(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, true)
}

/// The policy's flags and limit, as `initialize_policy` and `update_policy` take them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rules {
    pub allowlist: bool,
    pub blocklist: bool,
    pub max_transfer_amount: u64,
    pub allow_confidential: bool,
}

impl Rules {
    fn args(&self) -> Vec<u8> {
        let mut v = vec![self.allowlist as u8, self.blocklist as u8];
        v.extend_from_slice(&self.max_transfer_amount.to_le_bytes());
        v.push(self.allow_confidential as u8);
        v
    }
}

/// The issuer's reason for an enforcement action: `reason_code` and `case_ref`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reason {
    pub code: u16,
    pub case_ref: [u8; 32],
}

impl Reason {
    fn args(&self) -> Vec<u8> {
        let mut v = self.code.to_le_bytes().to_vec();
        v.extend_from_slice(&self.case_ref);
        v
    }
}

/// `EnforcementKind` in the program, in its order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Block,
    Unblock,
    Freeze,
    Thaw,
    Pause,
    Resume,
    Seize,
    CloseSeizure,
    Forfeit,
    ReleaseForfeiture,
}

/// A decoded `FreezeAuthorityChanged` event (2.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FreezeChange {
    pub mint: Pubkey,
    pub new_freeze_authority: Option<Pubkey>,
    pub reason: Reason,
    pub authority: Pubkey,
}

/// A decoded `EnforcementAction` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Enforcement {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub token_account: Pubkey,
    pub action: Action,
    pub reason: Reason,
    pub authority: Pubkey,
}

pub mod ix {
    use super::*;

    pub fn initialize_policy(authority: Pubkey, mint: Pubkey, rules: Rules) -> Instruction {
        anchor_ix(
            "initialize_policy",
            &rules.args(),
            vec![ws(authority), r(mint), w(policy_pda(&mint)), r(SYSTEM_ID)],
        )
    }
    pub fn update_policy(authority: Pubkey, mint: Pubkey, rules: Rules) -> Instruction {
        anchor_ix(
            "update_policy",
            &rules.args(),
            vec![rs(authority), r(mint), w(policy_pda(&mint))],
        )
    }
    pub fn initialize_meta_list(payer: Pubkey, mint: Pubkey) -> Instruction {
        anchor_ix(
            "initialize_extra_account_meta_list",
            &[],
            vec![ws(payer), w(meta_list_pda(&mint)), r(mint), r(SYSTEM_ID)],
        )
    }
    pub fn update_meta_list(authority: Pubkey, mint: Pubkey) -> Instruction {
        anchor_ix(
            "update_extra_account_meta_list",
            &[],
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(meta_list_pda(&mint)),
                r(SYSTEM_ID),
            ],
        )
    }
    pub fn add_to_list(
        block: bool,
        authority: Pubkey,
        mint: Pubkey,
        wallet: Pubkey,
    ) -> Instruction {
        let (name, entry) = if block {
            ("add_to_blocklist", block_pda(&mint, &wallet))
        } else {
            ("add_to_allowlist", allow_pda(&mint, &wallet))
        };
        anchor_ix(
            name,
            &[],
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                r(wallet),
                w(entry),
                r(SYSTEM_ID),
                no_role(),
            ],
        )
    }
    pub fn remove_from_list(
        block: bool,
        authority: Pubkey,
        mint: Pubkey,
        wallet: Pubkey,
    ) -> Instruction {
        let (name, entry) = if block {
            ("remove_from_blocklist", block_pda(&mint, &wallet))
        } else {
            ("remove_from_allowlist", allow_pda(&mint, &wallet))
        };
        anchor_ix(
            name,
            &[],
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                r(wallet),
                w(entry),
                no_role(),
            ],
        )
    }
    /// `block_wallet` / `unblock_wallet`: the list instructions with a recorded reason.
    pub fn block_with_reason(
        block: bool,
        authority: Pubkey,
        mint: Pubkey,
        wallet: Pubkey,
        reason: Reason,
    ) -> Instruction {
        let mut ix = if block {
            add_to_list(true, authority, mint, wallet)
        } else {
            remove_from_list(true, authority, mint, wallet)
        };
        let name = if block {
            "block_wallet"
        } else {
            "unblock_wallet"
        };
        ix.data = discriminator(&format!("global:{name}")).to_vec();
        ix.data.extend_from_slice(&reason.args());
        ix
    }

    /// `freeze_token_account` (`freeze`) or `thaw_token_account`.
    pub fn set_frozen(
        freeze: bool,
        authority: Pubkey,
        mint: Pubkey,
        token_account: Pubkey,
        reason: Reason,
    ) -> Instruction {
        let name = if freeze {
            "freeze_token_account"
        } else {
            "thaw_token_account"
        };
        anchor_ix(
            name,
            &reason.args(),
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(token_account),
                r(freeze_authority_pda(&mint)),
                r(TOKEN_2022_ID),
                w(freeze_record_pda(&mint, &token_account)),
                r(SYSTEM_ID),
                r(forfeiture_pda(&mint, &token_account)),
                no_role(),
            ],
        )
    }

    /// The same instruction with `role` in its last account, the optional `role`: the signer's
    /// `RoleEntry` (or whatever the caller wants to pass), or none.
    pub fn with_role(mut ix: Instruction, role: Option<Pubkey>) -> Instruction {
        let last = ix.accounts.last_mut().expect("accounts");
        *last = match role {
            Some(key) => r(key),
            None => no_role(),
        };
        ix
    }

    /// Anchor reads the program's own address in an optional account's place as "none".
    fn no_role() -> AccountMeta {
        r(VIGILANTIS_ID)
    }

    fn reason_args(reason: Reason) -> Vec<u8> {
        reason.args()
    }

    /// `pause`, or `resume` when `resume`.
    pub fn pause(resume: bool, authority: Pubkey, mint: Pubkey, reason: Reason) -> Instruction {
        anchor_ix(
            if resume { "resume" } else { "pause" },
            &reason_args(reason),
            vec![
                rs(authority),
                w(mint),
                r(policy_pda(&mint)),
                r(pause_authority_pda(&mint)),
                r(TOKEN_2022_ID),
                no_role(),
            ],
        )
    }

    /// `set_pause_authority`.
    pub fn set_pause_authority(
        authority: Pubkey,
        mint: Pubkey,
        new: Option<Pubkey>,
        reason: Reason,
    ) -> Instruction {
        let mut args = match new {
            Some(key) => {
                let mut v = vec![1u8];
                v.extend_from_slice(key.as_ref());
                v
            }
            None => vec![0u8],
        };
        args.extend_from_slice(&reason.args());
        anchor_ix(
            "set_pause_authority",
            &args,
            vec![
                rs(authority),
                w(mint),
                r(policy_pda(&mint)),
                r(pause_authority_pda(&mint)),
                r(TOKEN_2022_ID),
            ],
        )
    }

    /// `seize`.
    pub fn seize(
        authority: Pubkey,
        mint: Pubkey,
        token_account: Pubkey,
        reason: Reason,
    ) -> Instruction {
        anchor_ix(
            "seize",
            &reason.args(),
            vec![
                ws(authority),
                w(mint),
                r(policy_pda(&mint)),
                w(token_account),
                r(freeze_record_pda(&mint, &token_account)),
                w(seizure_pda(&mint, &token_account, &reason.case_ref)),
                r(freeze_authority_pda(&mint)),
                r(permanent_delegate_pda(&mint)),
                r(TOKEN_2022_ID),
                r(SYSTEM_ID),
                no_role(),
            ],
        )
    }

    /// `close_seizure` with `outcome` (0 returned to owner, 1 paid to victim, 2 paid to the state,
    /// 3 other) and `reason_code`.
    pub fn close_seizure(
        authority: Pubkey,
        mint: Pubkey,
        token_account: Pubkey,
        case_ref: [u8; 32],
        outcome: u8,
        reason_code: u16,
    ) -> Instruction {
        let mut args = vec![outcome];
        args.extend_from_slice(&reason_code.to_le_bytes());
        anchor_ix(
            "close_seizure",
            &args,
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(seizure_pda(&mint, &token_account, &case_ref)),
                no_role(),
            ],
        )
    }

    /// `forfeit` with an optional `amount_commitment` (all zeros for none).
    pub fn forfeit(
        authority: Pubkey,
        mint: Pubkey,
        token_account: Pubkey,
        reason: Reason,
        amount_commitment: [u8; 32],
    ) -> Instruction {
        let mut args = reason.args();
        args.extend_from_slice(&amount_commitment);
        anchor_ix(
            "forfeit",
            &args,
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                r(token_account),
                r(freeze_record_pda(&mint, &token_account)),
                w(forfeiture_pda(&mint, &token_account)),
                r(freeze_authority_pda(&mint)),
                r(TOKEN_2022_ID),
                r(SYSTEM_ID),
                no_role(),
            ],
        )
    }

    /// `release_forfeiture` with `reason_code` (the admin only; no role account).
    pub fn release_forfeiture(
        authority: Pubkey,
        mint: Pubkey,
        token_account: Pubkey,
        reason_code: u16,
    ) -> Instruction {
        anchor_ix(
            "release_forfeiture",
            &reason_code.to_le_bytes(),
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(forfeiture_pda(&mint, &token_account)),
            ],
        )
    }

    pub fn grant_role(
        authority: Pubkey,
        mint: Pubkey,
        holder: Pubkey,
        permissions: u16,
    ) -> Instruction {
        anchor_ix(
            "grant_role",
            &permissions.to_le_bytes(),
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                r(holder),
                w(role_pda(&mint, &holder)),
                r(SYSTEM_ID),
            ],
        )
    }
    pub fn update_role(
        authority: Pubkey,
        mint: Pubkey,
        holder: Pubkey,
        permissions: u16,
    ) -> Instruction {
        anchor_ix(
            "update_role",
            &permissions.to_le_bytes(),
            vec![
                rs(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(role_pda(&mint, &holder)),
            ],
        )
    }
    pub fn revoke_role(authority: Pubkey, mint: Pubkey, holder: Pubkey) -> Instruction {
        anchor_ix(
            "revoke_role",
            &[],
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(role_pda(&mint, &holder)),
            ],
        )
    }
    pub fn renounce_role(holder: Pubkey, mint: Pubkey) -> Instruction {
        anchor_ix(
            "renounce_role",
            &[],
            vec![ws(holder), r(mint), w(role_pda(&mint, &holder))],
        )
    }

    /// Vigilantis's `set_freeze_authority` (2.3): hand the mint's freeze authority from Vigilantis's
    /// address to `new`, or give it up with `None`.
    pub fn set_freeze_authority(
        authority: Pubkey,
        mint: Pubkey,
        new: Option<Pubkey>,
        reason: Reason,
    ) -> Instruction {
        let mut args = match new {
            Some(key) => {
                let mut v = vec![1u8];
                v.extend_from_slice(key.as_ref());
                v
            }
            None => vec![0u8],
        };
        args.extend_from_slice(&reason.args());
        anchor_ix(
            "set_freeze_authority",
            &args,
            vec![
                rs(authority),
                w(mint),
                r(policy_pda(&mint)),
                r(freeze_authority_pda(&mint)),
                r(TOKEN_2022_ID),
            ],
        )
    }

    pub fn propose_authority(
        authority: Pubkey,
        mint: Pubkey,
        new_authority: Pubkey,
    ) -> Instruction {
        anchor_ix(
            "propose_authority",
            new_authority.as_ref(),
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(pending_pda(&mint)),
                r(SYSTEM_ID),
            ],
        )
    }
    pub fn cancel_authority_transfer(authority: Pubkey, mint: Pubkey) -> Instruction {
        anchor_ix(
            "cancel_authority_transfer",
            &[],
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(pending_pda(&mint)),
            ],
        )
    }
    pub fn accept_authority(new_authority: Pubkey, previous: Pubkey, mint: Pubkey) -> Instruction {
        anchor_ix(
            "accept_authority",
            &[],
            vec![
                rs(new_authority),
                w(previous),
                r(mint),
                w(policy_pda(&mint)),
                w(pending_pda(&mint)),
            ],
        )
    }

    /// The accounts Token-2022 resolves from the meta list, in its order: policy, sender block,
    /// recipient block, recipient allow, transfer-authority block.
    pub fn hook_extras(
        mint: &Pubkey,
        from_owner: &Pubkey,
        to_owner: &Pubkey,
        authority: &Pubkey,
    ) -> Vec<Pubkey> {
        vec![
            policy_pda(mint),
            block_pda(mint, from_owner),
            block_pda(mint, to_owner),
            allow_pda(mint, to_owner),
            block_pda(mint, authority),
        ]
    }

    /// The transfer-hook interface's `Execute`, sent straight to Vigilantis (not through a transfer).
    pub fn execute(
        source: Pubkey,
        mint: Pubkey,
        destination: Pubkey,
        authority: Pubkey,
        extras: &[Pubkey],
        amount: u64,
    ) -> Instruction {
        let mut data = discriminator("spl-transfer-hook-interface:execute").to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        let mut accounts = vec![
            r(source),
            r(mint),
            r(destination),
            r(authority),
            r(meta_list_pda(&mint)),
        ];
        accounts.extend(extras.iter().map(|k| r(*k)));
        Instruction {
            program_id: VIGILANTIS_ID,
            accounts,
            data,
        }
    }

    /// The transfer-hook interface's own `InitializeExtraAccountMetas` with an empty list, as a
    /// generic client would send it to any hook program.
    pub fn interface_initialize_meta_list(authority: Pubkey, mint: Pubkey) -> Instruction {
        let mut data =
            discriminator("spl-transfer-hook-interface:initialize-extra-account-metas").to_vec();
        data.extend_from_slice(&0u32.to_le_bytes());
        Instruction {
            program_id: VIGILANTIS_ID,
            accounts: vec![
                w(meta_list_pda(&mint)),
                r(mint),
                ws(authority),
                r(SYSTEM_ID),
            ],
            data,
        }
    }

    /// Token-2022 `TransferChecked` (decimals 0) with the hook's accounts appended, as wallets
    /// build it after resolving the meta list.
    pub fn transfer(
        source: Pubkey,
        mint: Pubkey,
        destination: Pubkey,
        authority: Pubkey,
        extras: &[Pubkey],
        amount: u64,
    ) -> Instruction {
        let mut ix = spl_token_2022_interface::instruction::transfer_checked(
            &TOKEN_2022_ID,
            &source,
            &mint,
            &destination,
            &authority,
            &[],
            amount,
            0,
        )
        .unwrap();
        ix.accounts.extend(extras.iter().map(|k| r(*k)));
        ix.accounts.push(r(VIGILANTIS_ID));
        ix.accounts.push(r(meta_list_pda(&mint)));
        ix
    }
}

/// Send `ixs` signed by `payer` and `signers`; a fresh blockhash each time, so identical
/// transactions are not refused as duplicates. Keypairs the message does not need are ignored, and
/// a signer the message needs but nobody passed is left unsigned, so the runtime refuses it.
pub fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<(), FailedTransactionMetadata> {
    send_logs(svm, payer, signers, ixs).map(|_| ())
}

/// `send`, returning the program logs of a successful transaction.
pub fn send_logs(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<Vec<String>, FailedTransactionMetadata> {
    svm.expire_blockhash();
    let mut tx = Transaction::new_unsigned(Message::new(ixs, Some(&payer.pubkey())));
    let required = &tx.message.account_keys[..tx.message.header.num_required_signatures as usize];
    let mut keys: Vec<&Keypair> = vec![payer];
    for s in signers {
        if required.contains(&s.pubkey()) && !keys.iter().any(|k| k.pubkey() == s.pubkey()) {
            keys.push(s);
        }
    }
    tx.try_partial_sign(&keys, svm.latest_blockhash())
        .expect("sign");
    svm.send_transaction(tx).map(|meta| meta.logs)
}

/// Standard base64 (with padding), enough for Anchor's `Program data:` logs.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut bits, mut n) = (0u32, 0);
    for c in text.trim_end_matches('=').bytes() {
        bits = (bits << 6) | ALPHABET.iter().position(|&a| a == c)? as u32;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
        }
    }
    Some(out)
}

/// The payloads (after the 8-byte tag) of every event named `name` in `logs`, in order.
fn event_payloads(logs: &[String], name: &str) -> Vec<Vec<u8>> {
    let tag = discriminator(&format!("event:{name}"));
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: ").and_then(base64_decode))
        .filter(|data| data.len() >= 8 && data[..8] == tag)
        .map(|data| data[8..].to_vec())
        .collect()
}

/// Every `FreezeAuthorityChanged` event in `logs`, in order.
pub fn freeze_authority_events(logs: &[String]) -> Vec<FreezeChange> {
    event_payloads(logs, "FreezeAuthorityChanged")
        .into_iter()
        .map(|d| {
            let key = |at: usize| Pubkey::new_from_array(d[at..at + 32].try_into().unwrap());
            let (new_freeze_authority, at) = match d[32] {
                0 => (None, 33),
                1 => (Some(key(33)), 65),
                other => panic!("bad Option tag {other}"),
            };
            assert_eq!(d.len(), at + 2 + 32 + 32, "FreezeAuthorityChanged size");
            FreezeChange {
                mint: key(0),
                new_freeze_authority,
                reason: Reason {
                    code: u16::from_le_bytes([d[at], d[at + 1]]),
                    case_ref: d[at + 2..at + 34].try_into().unwrap(),
                },
                authority: key(at + 34),
            }
        })
        .collect()
}

/// Every `EnforcementAction` event in `logs`, in order.
pub fn enforcement_events(logs: &[String]) -> Vec<Enforcement> {
    let mut events = Vec::new();
    for data in event_payloads(logs, "EnforcementAction") {
        let d = &data[..];
        assert_eq!(d.len(), 32 * 4 + 1 + 2 + 32, "EnforcementAction size");
        let key = |at: usize| Pubkey::new_from_array(d[at..at + 32].try_into().unwrap());
        let action = match d[96] {
            0 => Action::Block,
            1 => Action::Unblock,
            2 => Action::Freeze,
            3 => Action::Thaw,
            4 => Action::Pause,
            5 => Action::Resume,
            6 => Action::Seize,
            7 => Action::CloseSeizure,
            8 => Action::Forfeit,
            9 => Action::ReleaseForfeiture,
            other => panic!("unknown EnforcementKind {other}"),
        };
        events.push(Enforcement {
            mint: key(0),
            wallet: key(32),
            token_account: key(64),
            action,
            reason: Reason {
                code: u16::from_le_bytes([d[97], d[98]]),
                case_ref: d[99..131].try_into().unwrap(),
            },
            authority: key(131),
        });
    }
    events
}

/// The custom error code of a failed transaction, if it has one.
pub fn custom_code(err: &FailedTransactionMetadata) -> Option<u32> {
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
        _ => None,
    }
}

pub fn fund(svm: &mut LiteSVM, key: &Pubkey, lamports: u64) {
    svm.airdrop(key, lamports).expect("airdrop");
}

/// A mint (decimals 0) whose transfer hook is Vigilantis, whose mint authority is `issuer`, and whose
/// freeze authority is `freeze_authority`.
pub fn create_hooked_mint(
    svm: &mut LiteSVM,
    issuer: &Keypair,
    mint: Keypair,
    freeze_authority: Option<&Pubkey>,
) -> Keypair {
    create_mint_with(svm, issuer, mint, freeze_authority, None, None)
}

/// `create_hooked_mint`, plus a permanent delegate and/or the Pausable extension with this pause
/// authority, when given.
pub fn create_mint_with(
    svm: &mut LiteSVM,
    issuer: &Keypair,
    mint: Keypair,
    freeze_authority: Option<&Pubkey>,
    permanent_delegate: Option<&Pubkey>,
    pause_authority: Option<&Pubkey>,
) -> Keypair {
    let mut extensions = vec![ExtensionType::TransferHook];
    if permanent_delegate.is_some() {
        extensions.push(ExtensionType::PermanentDelegate);
    }
    if pause_authority.is_some() {
        extensions.push(ExtensionType::Pausable);
    }
    let len = ExtensionType::try_calculate_account_len::<Mint>(&extensions).unwrap();
    let rent = svm.minimum_balance_for_rent_exemption(len);
    let create = solana_system_interface::instruction::create_account(
        &issuer.pubkey(),
        &mint.pubkey(),
        rent,
        len as u64,
        &TOKEN_2022_ID,
    );
    let hook = transfer_hook::instruction::initialize(
        &TOKEN_2022_ID,
        &mint.pubkey(),
        Some(issuer.pubkey()),
        Some(VIGILANTIS_ID),
    )
    .unwrap();
    let mut ixs = vec![create, hook];
    if let Some(delegate) = permanent_delegate {
        ixs.push(
            spl_token_2022_interface::instruction::initialize_permanent_delegate(
                &TOKEN_2022_ID,
                &mint.pubkey(),
                delegate,
            )
            .unwrap(),
        );
    }
    if let Some(authority) = pause_authority {
        ixs.push(
            pausable::instruction::initialize(&TOKEN_2022_ID, &mint.pubkey(), authority).unwrap(),
        );
    }
    ixs.push(
        spl_token_2022_interface::instruction::initialize_mint2(
            &TOKEN_2022_ID,
            &mint.pubkey(),
            &issuer.pubkey(),
            freeze_authority,
            0,
        )
        .unwrap(),
    );
    send(svm, issuer, &[&mint], &ixs).expect("create mint");
    mint
}

/// A token account of `mint` owned by `owner` (a keypair account, not an ATA).
pub fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let account = Keypair::new();
    // The account extensions the mint requires (TransferHookAccount for a hooked mint,
    // PausableAccount for a Pausable one), plus ImmutableOwner: Vigilantis moves tokens only
    // between accounts whose owner cannot change, as associated token accounts are.
    let mint_data = svm.get_account(mint).expect("mint").data;
    let len =
        spl_token_2022_interface::extension::account_len::try_calculate_account_len_from_mint_data(
            &mint_data,
            &[spl_token_2022_interface::extension::ExtensionType::ImmutableOwner],
        )
        .expect("account length");
    let rent = svm.minimum_balance_for_rent_exemption(len);
    let create = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &account.pubkey(),
        rent,
        len as u64,
        &TOKEN_2022_ID,
    );
    let init = spl_token_2022_interface::instruction::initialize_account3(
        &TOKEN_2022_ID,
        &account.pubkey(),
        mint,
        owner,
    )
    .unwrap();
    let immutable = spl_token_2022_interface::instruction::initialize_immutable_owner(
        &TOKEN_2022_ID,
        &account.pubkey(),
    )
    .unwrap();
    send(svm, payer, &[&account], &[create, immutable, init]).expect("create token account");
    account.pubkey()
}

pub fn mint_to(svm: &mut LiteSVM, issuer: &Keypair, mint: &Pubkey, account: &Pubkey, amount: u64) {
    let ix = spl_token_2022_interface::instruction::mint_to_checked(
        &TOKEN_2022_ID,
        mint,
        account,
        &issuer.pubkey(),
        &[],
        amount,
        0,
    )
    .unwrap();
    send(svm, issuer, &[], &[ix]).expect("mint_to");
}

/// Token-2022 `ApproveChecked` (decimals 0).
pub fn approve_ix(
    owner: &Pubkey,
    mint: &Pubkey,
    account: &Pubkey,
    delegate: &Pubkey,
    amount: u64,
) -> Instruction {
    spl_token_2022_interface::instruction::approve_checked(
        &TOKEN_2022_ID,
        account,
        mint,
        delegate,
        owner,
        &[],
        amount,
        0,
    )
    .unwrap()
}

/// Token-2022 `SetAuthority` naming `new` as the mint's freeze authority, signed by `current`.
pub fn set_freeze_authority_ix(mint: &Pubkey, current: &Pubkey, new: &Pubkey) -> Instruction {
    spl_token_2022_interface::instruction::set_authority(
        &TOKEN_2022_ID,
        mint,
        Some(new),
        spl_token_2022_interface::instruction::AuthorityType::FreezeAccount,
        current,
        &[],
    )
    .unwrap()
}

/// Token-2022 `SetAuthority` naming `new` as the mint's pause authority, signed by `current`.
pub fn set_pause_authority_ix(mint: &Pubkey, current: &Pubkey, new: &Pubkey) -> Instruction {
    spl_token_2022_interface::instruction::set_authority(
        &TOKEN_2022_ID,
        mint,
        Some(new),
        spl_token_2022_interface::instruction::AuthorityType::Pause,
        current,
        &[],
    )
    .unwrap()
}

/// Balance, delegate and delegated amount of a token account.
pub fn token_state(svm: &LiteSVM, account: &Pubkey) -> (u64, Option<Pubkey>, u64) {
    let data = svm.get_account(account).expect("token account").data;
    let amount = u64::from_le_bytes(data[64..72].try_into().unwrap());
    let delegate = if u32::from_le_bytes(data[72..76].try_into().unwrap()) == 1 {
        Some(Pubkey::new_from_array(data[76..108].try_into().unwrap()))
    } else {
        None
    };
    let delegated = u64::from_le_bytes(data[121..129].try_into().unwrap());
    (amount, delegate, delegated)
}

/// Whether a token account is frozen (`AccountState::Frozen` in its `state` byte).
pub fn is_frozen(svm: &LiteSVM, account: &Pubkey) -> bool {
    svm.get_account(account).expect("token account").data[108] == 2
}

/// The mint's freeze authority.
pub fn freeze_authority_of(svm: &LiteSVM, mint: &Pubkey) -> Option<Pubkey> {
    let data = svm.get_account(mint).expect("mint").data;
    (u32::from_le_bytes(data[46..50].try_into().unwrap()) == 1)
        .then(|| Pubkey::new_from_array(data[50..82].try_into().unwrap()))
}

/// An account owned by Vigilantis with data, i.e. a live PDA.
pub fn vigilantis_account(svm: &LiteSVM, key: &Pubkey) -> Option<Account> {
    svm.get_account(key)
        .filter(|a| a.owner == VIGILANTIS_ID && !a.data.is_empty())
}

/// The decoded `PolicyConfig`.
#[derive(Debug, PartialEq, Eq)]
pub struct Policy {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub rules: Rules,
}

pub fn read_policy(svm: &LiteSVM, mint: &Pubkey) -> Option<Policy> {
    let data = vigilantis_account(svm, &policy_pda(mint))?.data;
    let key = |at: usize| Pubkey::new_from_array(data[at..at + 32].try_into().unwrap());
    Some(Policy {
        mint: key(8),
        authority: key(40),
        rules: Rules {
            allowlist: data[72] == 1,
            blocklist: data[73] == 1,
            max_transfer_amount: u64::from_le_bytes(data[74..82].try_into().unwrap()),
            allow_confidential: data[82] == 1,
        },
    })
}

/// The `new_authority` of a pending handover.
pub fn read_pending(svm: &LiteSVM, mint: &Pubkey) -> Option<Pubkey> {
    let data = vigilantis_account(svm, &pending_pda(mint))?.data;
    Some(Pubkey::new_from_array(data[40..72].try_into().unwrap()))
}

/// Move the cluster clock forward by `seconds`.
pub fn advance_clock(svm: &mut LiteSVM, seconds: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp += seconds;
    svm.set_sysvar(&clock);
}

/// The cluster clock's unix time.
pub fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

/// The pause authority and paused flag of a Pausable mint.
pub fn pause_state(svm: &LiteSVM, mint: &Pubkey) -> Option<(Option<Pubkey>, bool)> {
    let data = svm.get_account(mint).expect("mint").data;
    let state = StateWithExtensions::<Mint>::unpack(&data).expect("mint");
    let config = state.get_extension::<pausable::PausableConfig>().ok()?;
    let authority: Option<solana_address::Address> = config.authority.into();
    Some((authority, bool::from(config.paused)))
}

/// A role's permissions, if it exists.
pub fn read_role(svm: &LiteSVM, mint: &Pubkey, holder: &Pubkey) -> Option<u16> {
    let data = vigilantis_account(svm, &role_pda(mint, holder))?.data;
    Some(u16::from_le_bytes([data[72], data[73]]))
}

/// A token account's freeze record: when Vigilantis froze it.
pub fn read_freeze_record(svm: &LiteSVM, mint: &Pubkey, account: &Pubkey) -> Option<i64> {
    let data = vigilantis_account(svm, &freeze_record_pda(mint, account))?.data;
    Some(i64::from_le_bytes(data[72..80].try_into().unwrap()))
}

/// An open seizure's burnt amount.
pub fn read_seizure(
    svm: &LiteSVM,
    mint: &Pubkey,
    account: &Pubkey,
    case_ref: &[u8; 32],
) -> Option<u64> {
    let data = vigilantis_account(svm, &seizure_pda(mint, account, case_ref))?.data;
    Some(u64::from_le_bytes(data[104..112].try_into().unwrap()))
}

/// A forfeiture: the case reference, the amount commitment and who recorded it.
pub fn read_forfeiture(
    svm: &LiteSVM,
    mint: &Pubkey,
    account: &Pubkey,
) -> Option<([u8; 32], [u8; 32], Pubkey)> {
    let data = vigilantis_account(svm, &forfeiture_pda(mint, account))?.data;
    // discriminator 8, mint 32, wallet 32, token_account 32, reason_code 2, then case_ref.
    let case_ref = data[106..138].try_into().unwrap();
    let commitment = data[138..170].try_into().unwrap();
    let authority = Pubkey::new_from_array(data[170..202].try_into().unwrap());
    Some((case_ref, commitment, authority))
}

/// The mint's supply.
pub fn supply_of(svm: &LiteSVM, mint: &Pubkey) -> u64 {
    let data = svm.get_account(mint).expect("mint").data;
    u64::from_le_bytes(data[36..44].try_into().unwrap())
}
