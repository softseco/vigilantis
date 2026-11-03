// SPDX-License-Identifier: BUSL-1.1
//! Model-based fuzzing of Vigilantis.
//!
//! Each case sets up a mint whose transfer hook is Vigilantis and whose freeze authority is Vigilantis's
//! freeze address, the issuer, or no one, then runs a random sequence of operations: every Vigilantis
//! instruction, signed by the right authority or by someone else; blocks, freezes and thaws with
//! reasons, on the right accounts and on wrong ones; the freeze authority handed to Vigilantis, and
//! by Vigilantis to someone else or to no one (2.3); public transfers through Token-2022, by owners
//! and by delegates; approvals; direct
//! calls to the hook (public and confidential amounts, and with made-up accounts); and strangers
//! funding the program's addresses before setup. A plain Rust model predicts each outcome. After
//! every operation the test checks that
//!
//! - the outcome matches the model (success, or the exact error where the model names one),
//! - the policy, the allow and block entries, a pending handover, every balance, delegation and
//!   frozen state, the mint's freeze authority, and the meta list are exactly what the model says,
//! - a successful operation emitted exactly the `EnforcementAction` and `FreezeAuthorityChanged`
//!   events the model expects, field by field, and no others,
//! - the total supply is unchanged by transfers.
//!
//! The model is the threat model's invariants written as code (`docs/threat-model.md`):
//! fail closed (1), only the policy authority changes rules (2), only the mint authority sets up (3),
//! handover needs both sides (4), blocklist (5), allowlist (6), limit and confidential amounts (7),
//! entries cannot be forged (8), the hook holds no state (9), only the policy authority freezes,
//! and only through the mint's own freeze address (10), enforcement is recorded (11).
//!
//! Vigilantis 1.0 adds roles, pause and seizure, and the model covers them too: the admin grants,
//! changes and revokes roles and holders renounce them; every gated action is tried by the admin, by
//! role holders with and without the permission, with someone else's role entry, and with a real
//! role entry of another mint that holds every permission there (12); pause and
//! resume on mints with and without Pausable, and the pause authority handed on (13); seizures, with
//! the cluster clock moved forward so that some come after the 24-hour delay and some before, on
//! mints with and without Vigilantis as permanent delegate, and their closing (14). The checks also
//! cover the role entries, the pause state, every freeze record and open seizure, and the mint's
//! supply, which a seizure lowers by exactly what it burnt.
//!
//! `FUZZ_CASES` (default 64), `FUZZ_STEPS` (default 60) and `FUZZ_SEED` (default fixed) set the run.
//! A failure prints the seed, the case and the operations that led to it.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use common::*;
use litesvm::LiteSVM;
use solana_address::Address as Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// SplitMix64: small, fast and reproducible from its seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize]
    }
}

const WALLETS: usize = 5;
const CONFIDENTIAL: u64 = u64::MAX;

/// What the model expects of one operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Expect {
    Ok,
    /// Fails with this custom error code.
    Code(u32),
    /// Fails; the model does not pin down which error.
    Err,
}

/// Who signs or is named: the issuer (mint authority), wallet `i`, or an address nobody holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Who {
    Issuer,
    Wallet(usize),
    Nobody,
}

#[derive(Clone, Debug)]
enum Op {
    InitPolicy {
        signer: Who,
        rules: Rules,
    },
    InitMetaList {
        signer: Who,
    },
    UpdatePolicy {
        signer: Who,
        rules: Rules,
    },
    UpdateMetaList {
        signer: Who,
    },
    /// `add_to_*`, or `block_wallet` when there is a reason.
    AddEntry {
        block: bool,
        signer: Who,
        wallet: Who,
        reason: Option<Reason>,
        role: RolePick,
    },
    /// `remove_from_*`, or `unblock_wallet` when there is a reason.
    RemoveEntry {
        block: bool,
        signer: Who,
        wallet: Who,
        reason: Option<Reason>,
        role: RolePick,
    },
    /// `freeze_token_account`, or `thaw_token_account` when `thaw`.
    Freeze {
        signer: Who,
        target: Target,
        thaw: bool,
        reason: Reason,
        role: RolePick,
    },
    GrantRole {
        signer: Who,
        holder: Who,
        permissions: u16,
    },
    UpdateRole {
        signer: Who,
        holder: Who,
        permissions: u16,
    },
    RevokeRole {
        signer: Who,
        holder: Who,
    },
    RenounceRole {
        holder: Who,
    },
    /// `pause`, or `resume` when `resume`.
    Pause {
        signer: Who,
        resume: bool,
        reason: Reason,
        role: RolePick,
    },
    /// Token-2022 `SetAuthority`: `signer` names Vigilantis's pause address as the mint's pause
    /// authority. Only the current pause authority can.
    HandOverPause {
        signer: Who,
    },
    /// Vigilantis's `set_pause_authority`.
    SetPauseAuthority {
        signer: Who,
        to: NewFreeze,
        reason: Reason,
    },
    /// `seize` wallet `account`'s token account under case `case` (an index into `CASES`).
    Seize {
        signer: Who,
        account: usize,
        case: usize,
        code: u16,
        role: RolePick,
    },
    CloseSeizure {
        signer: Who,
        account: usize,
        case: usize,
        outcome: u8,
        code: u16,
        role: RolePick,
    },
    /// Move the cluster clock forward.
    Warp {
        seconds: i64,
    },
    /// Token-2022 `SetAuthority`: `signer` names Vigilantis's freeze address as the mint's freeze
    /// authority. Only the current freeze authority can; while Vigilantis holds it, only Vigilantis's
    /// own `set_freeze_authority` moves it.
    HandOverFreeze {
        signer: Who,
    },
    /// Vigilantis's `set_freeze_authority` (2.3).
    SetFreezeAuthority {
        signer: Who,
        to: NewFreeze,
        reason: Reason,
    },
    Propose {
        signer: Who,
        new_authority: ProposeTo,
    },
    Cancel {
        signer: Who,
    },
    Accept {
        signer: Who,
        previous: Who,
    },
    Approve {
        owner: usize,
        delegate: Who,
        amount: u64,
    },
    Transfer {
        from: usize,
        to: usize,
        authority: Who,
        amount: u64,
    },
    /// `Execute` sent straight to Vigilantis with the accounts Token-2022 would resolve.
    Execute {
        from: usize,
        to: usize,
        authority: Who,
        amount: u64,
        /// What goes in the fifth extra account, the transfer authority's block entry.
        fifth: Fifth,
    },
    /// The transfer-hook interface's `InitializeExtraAccountMetas`, which Vigilantis must refuse: its
    /// meta list is created only by its own instruction, which checks the mint authority.
    InterfaceInit {
        signer: Who,
    },
    /// `Execute` sent straight to Vigilantis with made-up accounts.
    ExecuteGarbage {
        amount: u64,
        seed: u64,
    },
    /// A stranger funds the policy or meta-list address before it exists.
    Prefund {
        meta_list: bool,
        lamports: u64,
    },
}

/// Which role entry a gated action passes: the signer's own when it has one (what the SDK does),
/// none, someone else's (which may not exist), or wallet 0's real entry for the other mint, which
/// holds every permission there and none here.
#[derive(Clone, Copy, Debug)]
enum RolePick {
    Auto,
    Without,
    Of(Who),
    OtherMint,
}

/// The role entry a gated action passes, resolved: this mint's entry for a holder (which may not
/// exist), or the other mint's entry for wallet 0.
#[derive(Clone, Copy, Debug)]
enum Passed {
    ThisMint(Pubkey),
    OtherMint,
}

/// The case references seizures use: an all-zero one (refused) and two real ones.
const CASES: [[u8; 32]; 3] = [[0; 32], [1; 32], [2; 32]];

/// The fifth extra account of a direct `Execute`. Token-2022 always passes the authority's own
/// block entry; a direct caller can pass anything, and the hook must check it by content
/// (invariant 8): only this mint's `BlockEntry` for this authority may block.
#[derive(Clone, Copy, Debug)]
enum Fifth {
    Resolved,
    /// The policy account: owned by Vigilantis, but not a `BlockEntry`.
    Policy,
    /// Someone's block entry address, perhaps not the authority's.
    EntryOf(Who),
}

/// The account a freeze or thaw names.
#[derive(Clone, Copy, Debug)]
enum Target {
    /// Wallet `i`'s token account of the mint.
    Account(usize),
    /// A token account of another mint.
    OtherMint,
    /// The policy account: not a token account.
    Policy,
    /// The mint itself: owned by Token-2022, but not a token account.
    Mint,
}

/// Where `set_freeze_authority` hands the freeze authority.
#[derive(Clone, Copy, Debug)]
enum NewFreeze {
    Who(Who),
    /// Vigilantis's own freeze address: refused.
    Vigilantis,
    /// The default address: refused (giving it up is `Renounce`).
    Default,
    Renounce,
}

#[derive(Clone, Copy, Debug)]
enum ProposeTo {
    Who(Who),
    Default,
    Current,
}

struct World {
    svm: LiteSVM,
    issuer: Keypair,
    wallets: Vec<Keypair>,
    nobody: Pubkey,
    mint: Pubkey,
    accounts: Vec<Pubkey>,
    /// Another mint, with a policy and a role entry for wallet 0 holding every permission.
    other_mint: Pubkey,
    /// Wallet 0's token account of the other mint.
    other_account: Pubkey,
    meta_list_bytes: Option<Vec<u8>>,
}

impl World {
    fn key(&self, who: Who) -> Pubkey {
        match who {
            Who::Issuer => self.issuer.pubkey(),
            Who::Wallet(i) => self.wallets[i].pubkey(),
            Who::Nobody => self.nobody,
        }
    }
    fn keypair(&self, who: Who) -> &Keypair {
        match who {
            Who::Issuer => &self.issuer,
            Who::Wallet(i) => &self.wallets[i],
            Who::Nobody => unreachable!("nobody holds this key"),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Model {
    policy: Option<(Pubkey, Rules)>,
    meta_list: bool,
    pending: Option<Pubkey>,
    allow: BTreeSet<Pubkey>,
    block: BTreeSet<Pubkey>,
    balances: Vec<u64>,
    delegations: Vec<Option<(Pubkey, u64)>>,
    frozen: Vec<bool>,
    freeze_authority: Option<Pubkey>,
    supply: u64,
    roles: BTreeMap<Pubkey, u16>,
    /// The policy's role epoch (raised by every accepted handover) and the epoch each role was
    /// granted or last updated in. A role works only while the two are equal.
    role_epoch: u32,
    role_epochs: BTreeMap<Pubkey, u32>,
    /// Whether the mint has the Pausable extension, its pause authority, and whether it is paused.
    pausable: bool,
    pause_authority: Option<Pubkey>,
    paused: bool,
    /// The mint's permanent delegate, and whether it is Vigilantis's address.
    permanent_delegate: Option<Pubkey>,
    delegate_is_vigilantis: bool,
    /// When Vigilantis froze each wallet's account (its `FreezeRecord`).
    freeze_records: Vec<Option<i64>>,
    /// Open seizures: (wallet, case index) -> amount burnt.
    seizures: BTreeMap<(usize, usize), u64>,
}

impl Model {
    /// The hook's verdict on a transfer from `from_owner` to `to_owner` moved by `authority`.
    /// `check_authority`: whether the hook receives the transfer authority's own block entry.
    fn hook(
        &self,
        from_owner: Pubkey,
        to_owner: Pubkey,
        authority: Pubkey,
        amount: u64,
        check_authority: bool,
    ) -> Expect {
        let Some((_, rules)) = self.policy else {
            return Expect::Err; // fail closed: no policy, no transfer
        };
        if rules.max_transfer_amount > 0 {
            if amount == CONFIDENTIAL {
                if !rules.allow_confidential {
                    return Expect::Code(code::CONFIDENTIAL_AMOUNT_NOT_ENFORCEABLE);
                }
            } else if amount > rules.max_transfer_amount {
                return Expect::Code(code::TRANSFER_EXCEEDS_LIMIT);
            }
        }
        if rules.blocklist {
            if self.block.contains(&from_owner) {
                return Expect::Code(code::SENDER_BLOCKED);
            }
            if self.block.contains(&to_owner) {
                return Expect::Code(code::RECIPIENT_BLOCKED);
            }
            if check_authority && self.block.contains(&authority) {
                return Expect::Code(code::AUTHORITY_BLOCKED);
            }
        }
        if rules.allowlist && !self.allow.contains(&to_owner) {
            return Expect::Code(code::RECIPIENT_NOT_ALLOWLISTED);
        }
        Expect::Ok
    }

    fn authority(&self) -> Option<Pubkey> {
        self.policy.map(|(a, _)| a)
    }

    /// The role entry a gated action passes, if any.
    fn role_holder(&self, world: &World, pick: RolePick, signer: Pubkey) -> Option<Passed> {
        match pick {
            RolePick::Auto => self
                .roles
                .contains_key(&signer)
                .then_some(Passed::ThisMint(signer)),
            RolePick::Without => None,
            RolePick::Of(who) => Some(Passed::ThisMint(world.key(who))),
            RolePick::OtherMint => Some(Passed::OtherMint),
        }
    }

    /// Whether the passed role entry does not exist (Anchor then refuses to load it). The other
    /// mint's entry always exists.
    fn role_missing(&self, passed: Option<Passed>) -> bool {
        matches!(passed, Some(Passed::ThisMint(h)) if !self.roles.contains_key(&h))
    }

    /// Whether `signer` may do an action needing `needed`, passing this role entry. An entry of
    /// the other mint never counts, whatever it holds (invariant 12).
    fn allowed(&self, signer: Pubkey, passed: Option<Passed>, needed: u16) -> bool {
        if self.authority() == Some(signer) {
            return true;
        }
        match passed {
            Some(Passed::ThisMint(holder)) => {
                holder == signer
                    && self.role_epochs.get(&signer) == Some(&self.role_epoch)
                    && self
                        .roles
                        .get(&signer)
                        .is_some_and(|p| p & needed == needed)
            }
            _ => false,
        }
    }
}

fn random_rules(rng: &mut Rng) -> Rules {
    Rules {
        allowlist: rng.chance(40),
        blocklist: rng.chance(60),
        max_transfer_amount: match rng.below(4) {
            0 | 1 => 0,
            2 => 1 + rng.below(300),
            _ => 1 + rng.below(1_000),
        },
        allow_confidential: rng.chance(50),
    }
}

fn random_reason(rng: &mut Rng) -> Reason {
    let code = match rng.below(4) {
        0 => 0,
        1 | 2 => 1 + rng.below(7) as u16,
        _ => rng.next() as u16,
    };
    let mut case_ref = [0u8; 32];
    for chunk in case_ref.chunks_mut(8) {
        chunk.copy_from_slice(&rng.next().to_le_bytes());
    }
    Reason { code, case_ref }
}

/// Who tries a gated action: a role holder more often than `random_who` picks one, because each
/// gated action has its own permission, and a permission must not stand in for another.
fn random_actor(rng: &mut Rng, model: &Model, world: &World) -> Who {
    if !model.roles.is_empty() && rng.chance(30) {
        let holders: Vec<Pubkey> = model.roles.keys().copied().collect();
        return who_of(world, holders[rng.below(holders.len() as u64) as usize]);
    }
    random_who(rng, model, world)
}

fn random_who(rng: &mut Rng, model: &Model, world: &World) -> Who {
    // Bias towards the people who matter: the current authority and a pending one.
    let authority = model.authority();
    let pending = model.pending;
    if !model.roles.is_empty() && rng.chance(25) {
        let holders: Vec<Pubkey> = model.roles.keys().copied().collect();
        return who_of(world, holders[rng.below(holders.len() as u64) as usize]);
    }
    match rng.below(10) {
        0..=3 => match authority {
            Some(a) => who_of(world, a),
            None => Who::Issuer,
        },
        4 => match pending {
            Some(p) => who_of(world, p),
            None => Who::Issuer,
        },
        5 => Who::Issuer,
        6 if rng.chance(30) => Who::Nobody,
        _ => Who::Wallet(rng.below(WALLETS as u64) as usize),
    }
}

fn who_of(world: &World, key: Pubkey) -> Who {
    if key == world.issuer.pubkey() {
        return Who::Issuer;
    }
    for (i, w) in world.wallets.iter().enumerate() {
        if w.pubkey() == key {
            return Who::Wallet(i);
        }
    }
    Who::Nobody
}

fn random_role_pick(rng: &mut Rng, model: &Model, world: &World) -> RolePick {
    match rng.below(20) {
        0..=1 => RolePick::Without,
        2..=3 => RolePick::Of(random_who(rng, model, world)),
        4 => RolePick::OtherMint,
        _ => RolePick::Auto,
    }
}

/// The address of the role entry a gated action passes.
fn role_account(world: &World, passed: Option<Passed>) -> Option<Pubkey> {
    passed.map(|p| match p {
        Passed::ThisMint(holder) => role_pda(&world.mint, &holder),
        Passed::OtherMint => role_pda(&world.other_mint, &world.wallets[0].pubkey()),
    })
}

fn random_permissions(rng: &mut Rng) -> u16 {
    match rng.below(12) {
        0 => perm::ALL,
        1 => 0,
        2 => 1 << 9,
        3 => perm::FREEZE | perm::BLOCK | perm::PAUSE | perm::ALLOWLIST,
        4 => perm::SEIZE | perm::CLOSE_SEIZURE,
        5 => perm::THAW | perm::UNBLOCK | perm::RESUME,
        _ => 1 << rng.below(9),
    }
}

fn random_amount(rng: &mut Rng, balance: u64, model: &Model) -> u64 {
    let limit = model
        .policy
        .map(|(_, r)| r.max_transfer_amount)
        .unwrap_or(0);
    match rng.below(8) {
        0 => 0,
        1 => 1,
        2 => balance,
        3 => balance + 1,
        4 if limit > 0 => limit,
        5 if limit > 0 => limit + 1,
        _ => rng.below(balance.max(1) + 1),
    }
}

fn random_op(rng: &mut Rng, model: &Model, world: &World) -> Op {
    let wallet = |rng: &mut Rng| rng.below(WALLETS as u64) as usize;
    // A pending handover lasts only until it is accepted or cancelled, and its checks (who
    // accepts, who gets the proposal's rent back) matter: try accepting it more often.
    if model.pending.is_some() && rng.chance(10) {
        return random_accept(rng, model, world);
    }
    // The same for an open seizure, which only a few steps of a case ever see.
    if !model.seizures.is_empty() && rng.chance(8) {
        return random_close_seizure(rng, model, world);
    }
    // And for a role holder unblocking a blocked wallet, where BLOCK must not stand in for UNBLOCK.
    if !model.block.is_empty() && !model.roles.is_empty() && rng.chance(5) {
        let blocked: Vec<Pubkey> = model.block.iter().copied().collect();
        let holders: Vec<Pubkey> = model.roles.keys().copied().collect();
        return Op::RemoveEntry {
            block: true,
            signer: who_of(world, holders[rng.below(holders.len() as u64) as usize]),
            wallet: who_of(world, blocked[rng.below(blocked.len() as u64) as usize]),
            reason: rng.chance(50).then(|| random_reason(rng)),
            role: RolePick::Auto,
        };
    }
    match rng.below(150) {
        0..=29 => {
            let from = wallet(rng);
            let to = if rng.chance(10) { from } else { wallet(rng) };
            // Mostly the owner; else the account's delegate when it has one, so delegated
            // transfers (and a blocklisted delegate) come up often.
            let authority = match model.delegations[from] {
                Some((d, _)) if rng.chance(40) => who_of(world, d),
                _ if rng.chance(80) => Who::Wallet(from),
                _ => random_who(rng, model, world),
            };
            let amount = random_amount(rng, model.balances[from], model);
            Op::Transfer {
                from,
                to,
                authority,
                amount,
            }
        }
        30..=37 => {
            let from = wallet(rng);
            let to = wallet(rng);
            let authority = if rng.chance(60) {
                Who::Wallet(from)
            } else {
                random_who(rng, model, world)
            };
            let amount = if rng.chance(50) {
                CONFIDENTIAL
            } else {
                random_amount(rng, model.balances[from], model)
            };
            let fifth = match rng.below(100) {
                0..=74 => Fifth::Resolved,
                75..=84 => Fifth::Policy,
                _ => {
                    // Mostly a blocklisted wallet's entry: only a real block entry tells a hook
                    // that checks the entry's content from one that blocks on any entry.
                    let blocked: Vec<Pubkey> = model.block.iter().copied().collect();
                    if !blocked.is_empty() && rng.chance(70) {
                        Fifth::EntryOf(who_of(
                            world,
                            blocked[rng.below(blocked.len() as u64) as usize],
                        ))
                    } else {
                        Fifth::EntryOf(random_who(rng, model, world))
                    }
                }
            };
            Op::Execute {
                from,
                to,
                authority,
                amount,
                fifth,
            }
        }
        38 => Op::InterfaceInit {
            signer: random_who(rng, model, world),
        },
        39..=40 => Op::ExecuteGarbage {
            amount: if rng.chance(50) {
                CONFIDENTIAL
            } else {
                rng.below(2_000)
            },
            seed: rng.next(),
        },
        41..=46 => {
            // Another wallet (those are what the lists name most), sometimes the issuer.
            let owner = wallet(rng);
            let delegate = if rng.chance(15) {
                Who::Issuer
            } else {
                Who::Wallet((owner + 1 + rng.below(WALLETS as u64 - 1) as usize) % WALLETS)
            };
            Op::Approve {
                owner,
                delegate,
                amount: rng.below(model.balances[owner] + 2),
            }
        }
        47..=53 => Op::UpdatePolicy {
            signer: random_who(rng, model, world),
            rules: random_rules(rng),
        },
        54..=73 => {
            let block = rng.chance(55);
            let signer = random_actor(rng, model, world);
            let target = if rng.chance(85) {
                Who::Wallet(wallet(rng))
            } else {
                rng.pick(&[Who::Issuer, Who::Nobody])
            };
            let set = if block { &model.block } else { &model.allow };
            // Half the blocklist changes go through block_wallet / unblock_wallet with a reason.
            let reason = if block && rng.chance(50) {
                Some(random_reason(rng))
            } else {
                None
            };
            // Remove what is there more often than not, so lists shrink as well as grow.
            let role = random_role_pick(rng, model, world);
            if set.contains(&world.key(target)) && rng.chance(60) {
                Op::RemoveEntry {
                    block,
                    signer,
                    wallet: target,
                    reason,
                    role,
                }
            } else if rng.chance(80) {
                Op::AddEntry {
                    block,
                    signer,
                    wallet: target,
                    reason,
                    role,
                }
            } else {
                Op::RemoveEntry {
                    block,
                    signer,
                    wallet: target,
                    reason,
                    role,
                }
            }
        }
        74..=78 => {
            let new_authority = match rng.below(10) {
                0 => ProposeTo::Default,
                1 => ProposeTo::Current,
                2 => ProposeTo::Who(Who::Nobody),
                _ => ProposeTo::Who(random_who(rng, model, world)),
            };
            Op::Propose {
                signer: random_who(rng, model, world),
                new_authority,
            }
        }
        79..=80 => Op::Cancel {
            signer: random_who(rng, model, world),
        },
        81..=84 => random_accept(rng, model, world),
        85..=87 => Op::UpdateMetaList {
            signer: random_who(rng, model, world),
        },
        88..=91 => Op::InitPolicy {
            signer: random_who(rng, model, world),
            rules: random_rules(rng),
        },
        92..=95 => Op::InitMetaList {
            signer: random_who(rng, model, world),
        },
        96..=99 => Op::Prefund {
            meta_list: rng.chance(50),
            lamports: rng.pick(&[1_000_000, 890_880, 5_000_000, 100_000_000]),
        },
        100..=109 => {
            let target = match rng.below(20) {
                0 => Target::Policy,
                1 => Target::Mint,
                2 => Target::OtherMint,
                _ => Target::Account(wallet(rng)),
            };
            let frozen = matches!(target, Target::Account(i) if model.frozen[i]);
            // Mostly the change that makes sense (thaw what is frozen); sometimes the other.
            let thaw = if rng.chance(75) { frozen } else { !frozen };
            Op::Freeze {
                signer: random_actor(rng, model, world),
                target,
                thaw,
                reason: random_reason(rng),
                role: random_role_pick(rng, model, world),
            }
        }
        110..=111 => Op::HandOverFreeze {
            // Mostly whoever holds the freeze authority now (Vigilantis's address maps to Nobody).
            signer: match model.freeze_authority {
                Some(k) if rng.chance(60) => who_of(world, k),
                _ if rng.chance(50) => Who::Issuer,
                _ => random_who(rng, model, world),
            },
        },
        112..=115 => {
            let to = match rng.below(10) {
                0 => NewFreeze::Vigilantis,
                1 => NewFreeze::Default,
                2 => NewFreeze::Renounce,
                3 => NewFreeze::Who(Who::Nobody),
                4 => NewFreeze::Who(Who::Issuer),
                _ => NewFreeze::Who(Who::Wallet(wallet(rng))),
            };
            Op::SetFreezeAuthority {
                signer: random_who(rng, model, world),
                to,
                reason: random_reason(rng),
            }
        }
        116..=123 => {
            // Roles: mostly the admin, so they get created; holders are wallets or the issuer.
            let signer = if rng.chance(75) {
                match model.authority() {
                    Some(a) => who_of(world, a),
                    None => Who::Issuer,
                }
            } else {
                random_who(rng, model, world)
            };
            // Often a holder that has a role, so changes, revocations and renunciations act on one.
            let holder = if !model.roles.is_empty() && rng.chance(40) {
                let holders: Vec<Pubkey> = model.roles.keys().copied().collect();
                who_of(world, holders[rng.below(holders.len() as u64) as usize])
            } else if rng.chance(85) {
                Who::Wallet(wallet(rng))
            } else {
                Who::Issuer
            };
            let exists = model.roles.contains_key(&world.key(holder));
            match rng.below(10) {
                0..=4 if !exists || rng.chance(20) => Op::GrantRole {
                    signer,
                    holder,
                    permissions: random_permissions(rng),
                },
                0..=5 => Op::UpdateRole {
                    signer,
                    holder,
                    permissions: random_permissions(rng),
                },
                // Revoking is tried by someone other than the admin half the time.
                6..=7 => Op::RevokeRole {
                    signer: if rng.chance(50) {
                        signer
                    } else {
                        random_who(rng, model, world)
                    },
                    holder,
                },
                _ => Op::RenounceRole { holder },
            }
        }
        124..=128 => Op::Pause {
            signer: random_actor(rng, model, world),
            resume: if rng.chance(75) {
                model.paused
            } else {
                !model.paused
            },
            reason: random_reason(rng),
            role: random_role_pick(rng, model, world),
        },
        129 => Op::HandOverPause {
            signer: match model.pause_authority {
                Some(k) if rng.chance(60) => who_of(world, k),
                _ => random_who(rng, model, world),
            },
        },
        130..=131 => {
            let to = match rng.below(10) {
                0 => NewFreeze::Vigilantis,
                1 => NewFreeze::Default,
                2 => NewFreeze::Renounce,
                3 => NewFreeze::Who(Who::Nobody),
                4 => NewFreeze::Who(Who::Issuer),
                _ => NewFreeze::Who(Who::Wallet(wallet(rng))),
            };
            Op::SetPauseAuthority {
                signer: random_who(rng, model, world),
                to,
                reason: random_reason(rng),
            }
        }
        132..=140 => {
            // Mostly a frozen account, so seizures get as far as the clock and the balance. With
            // nothing frozen yet, the admin often freezes an account first.
            let frozen: Vec<usize> = (0..WALLETS).filter(|i| model.frozen[*i]).collect();
            if frozen.is_empty() && rng.chance(70) {
                return Op::Freeze {
                    signer: match model.authority() {
                        Some(a) => who_of(world, a),
                        None => Who::Issuer,
                    },
                    target: Target::Account(wallet(rng)),
                    thaw: false,
                    reason: random_reason(rng),
                    role: RolePick::Auto,
                };
            }
            // The 24-hour boundary itself: an account that became seizable this very second is
            // tried first, mostly by the admin; if none is, the clock is sometimes moved there.
            let t = now(&world.svm);
            let boundary = |i: &usize| model.freeze_records[*i].map(|f| f + SEIZE_DELAY_SECONDS);
            let at_boundary: Vec<usize> = frozen
                .iter()
                .copied()
                .filter(|i| boundary(i) == Some(t))
                .collect();
            let ahead: Vec<i64> = frozen
                .iter()
                .filter_map(boundary)
                .filter(|b| *b > t)
                .collect();
            if at_boundary.is_empty() && !ahead.is_empty() && rng.chance(25) {
                return Op::Warp {
                    seconds: ahead[rng.below(ahead.len() as u64) as usize] - t,
                };
            }
            let account = if !at_boundary.is_empty() && rng.chance(70) {
                at_boundary[rng.below(at_boundary.len() as u64) as usize]
            } else if !frozen.is_empty() && rng.chance(80) {
                frozen[rng.below(frozen.len() as u64) as usize]
            } else {
                wallet(rng)
            };
            let signer = match model.authority() {
                Some(a) if at_boundary.contains(&account) && rng.chance(50) => who_of(world, a),
                _ => random_actor(rng, model, world),
            };
            Op::Seize {
                signer,
                account,
                case: if rng.chance(10) {
                    0
                } else {
                    1 + rng.below(2) as usize
                },
                code: rng.below(8) as u16,
                role: random_role_pick(rng, model, world),
            }
        }
        141..=143 => random_close_seizure(rng, model, world),
        _ => {
            // Sometimes exactly to the second a frozen account becomes seizable, so that a seizure
            // lands on the boundary of the 24 hours.
            let t = now(&world.svm);
            let boundaries: Vec<i64> = model
                .freeze_records
                .iter()
                .flatten()
                .map(|frozen_at| frozen_at + SEIZE_DELAY_SECONDS)
                .filter(|b| *b > t)
                .collect();
            let seconds = if !boundaries.is_empty() && rng.chance(40) {
                boundaries[rng.below(boundaries.len() as u64) as usize] - t
            } else {
                rng.pick(&[3_600, 43_200, 86_399, 86_400, 100_000])
            };
            Op::Warp { seconds }
        }
    }
}

fn random_close_seizure(rng: &mut Rng, model: &Model, world: &World) -> Op {
    let open: Vec<(usize, usize)> = model.seizures.keys().copied().collect();
    let (account, case) = if !open.is_empty() && rng.chance(80) {
        open[rng.below(open.len() as u64) as usize]
    } else {
        (rng.below(WALLETS as u64) as usize, rng.below(3) as usize)
    };
    Op::CloseSeizure {
        signer: random_actor(rng, model, world),
        account,
        case,
        outcome: rng.below(4) as u8,
        code: rng.below(8) as u16,
        role: random_role_pick(rng, model, world),
    }
}

fn random_accept(rng: &mut Rng, model: &Model, world: &World) -> Op {
    let signer = match model.pending {
        Some(p) if rng.chance(70) => who_of(world, p),
        _ => random_who(rng, model, world),
    };
    // The account that gets the proposal's rent back must be the outgoing authority; try someone
    // else often enough that a missing check shows.
    let previous = match model.authority() {
        Some(a) if rng.chance(65) => who_of(world, a),
        _ => Who::Wallet(rng.below(WALLETS as u64) as usize),
    };
    Op::Accept { signer, previous }
}

impl fmt::Display for Op {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

/// Predict `op`, run it, update the model, and check the outcome.
/// Returns what the model expected, for the summary.
fn step(world: &mut World, model: &mut Model, op: &Op) -> Result<Expect, String> {
    let mint = world.mint;
    let signer_ok = |who: Who| who != Who::Nobody;
    // The `EnforcementAction` and `FreezeAuthorityChanged` events a successful operation must emit,
    // in order.
    let mut events: Vec<Enforcement> = Vec::new();
    let mut freeze_changes: Vec<FreezeChange> = Vec::new();
    let vigilantis_freeze = freeze_authority_pda(&mint);
    let (expect, ixs, signers): (Expect, Vec<solana_instruction::Instruction>, Vec<Who>) = match op
        .clone()
    {
        Op::InitPolicy { signer, rules } => {
            let s = world.key(signer);
            let expect = if !signer_ok(signer) {
                Expect::Err
            } else if s != world.issuer.pubkey() {
                if model.policy.is_some() {
                    Expect::Err
                } else {
                    Expect::Code(code::UNAUTHORIZED)
                }
            } else if model.policy.is_some() {
                Expect::Err
            } else {
                Expect::Ok
            };
            if expect == Expect::Ok {
                model.policy = Some((s, rules));
            }
            (
                expect,
                vec![ix::initialize_policy(s, mint, rules)],
                vec![signer],
            )
        }
        Op::InitMetaList { signer } => {
            let s = world.key(signer);
            let expect = if !signer_ok(signer) {
                Expect::Err
            } else if s != world.issuer.pubkey() {
                Expect::Code(code::UNAUTHORIZED)
            } else if model.meta_list {
                Expect::Err
            } else {
                Expect::Ok
            };
            if expect == Expect::Ok {
                model.meta_list = true;
            }
            (
                expect,
                vec![ix::initialize_meta_list(s, mint)],
                vec![signer],
            )
        }
        Op::UpdatePolicy { signer, rules } => {
            let s = world.key(signer);
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.policy = Some((s, rules));
            }
            (
                expect,
                vec![ix::update_policy(s, mint, rules)],
                vec![signer],
            )
        }
        Op::UpdateMetaList { signer } => {
            let s = world.key(signer);
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) => Expect::Err,
                Some(_) if !model.meta_list => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) => Expect::Ok,
            };
            (expect, vec![ix::update_meta_list(s, mint)], vec![signer])
        }
        Op::AddEntry {
            block,
            signer,
            wallet,
            reason,
            role,
        } => {
            let s = world.key(signer);
            let w = world.key(wallet);
            let holder = model.role_holder(world, role, s);
            let needed = if block { perm::BLOCK } else { perm::ALLOWLIST };
            let exists = if block {
                model.block.contains(&w)
            } else {
                model.allow.contains(&w)
            };
            // Accounts load first (the new entry is created then), the role entry last; the
            // permission is checked in the instruction.
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) || exists => Expect::Err,
                Some(_) if model.role_missing(holder) => {
                    Expect::Code(anchor_code::ACCOUNT_NOT_INITIALIZED)
                }
                Some(_) if !model.allowed(s, holder, needed) => Expect::Code(code::UNAUTHORIZED),
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                if block {
                    model.block.insert(w);
                } else {
                    model.allow.insert(w);
                }
            }
            let ix = match reason {
                Some(reason) => {
                    events.push(Enforcement {
                        mint,
                        wallet: w,
                        token_account: Pubkey::default(),
                        action: Action::Block,
                        reason,
                        authority: s,
                    });
                    ix::block_with_reason(true, s, mint, w, reason)
                }
                None => ix::add_to_list(block, s, mint, w),
            };
            let ix = ix::with_role(ix, role_account(world, holder));
            (expect, vec![ix], vec![signer])
        }
        Op::RemoveEntry {
            block,
            signer,
            wallet,
            reason,
            role,
        } => {
            let s = world.key(signer);
            let w = world.key(wallet);
            let holder = model.role_holder(world, role, s);
            let needed = if block {
                perm::UNBLOCK
            } else {
                perm::ALLOWLIST
            };
            let exists = if block {
                model.block.contains(&w)
            } else {
                model.allow.contains(&w)
            };
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) || !exists => Expect::Err,
                Some(_) if model.role_missing(holder) => {
                    Expect::Code(anchor_code::ACCOUNT_NOT_INITIALIZED)
                }
                Some(_) if !model.allowed(s, holder, needed) => Expect::Code(code::UNAUTHORIZED),
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                if block {
                    model.block.remove(&w);
                } else {
                    model.allow.remove(&w);
                }
            }
            let ix = match reason {
                Some(reason) => {
                    events.push(Enforcement {
                        mint,
                        wallet: w,
                        token_account: Pubkey::default(),
                        action: Action::Unblock,
                        reason,
                        authority: s,
                    });
                    ix::block_with_reason(false, s, mint, w, reason)
                }
                None => ix::remove_from_list(block, s, mint, w),
            };
            let ix = ix::with_role(ix, role_account(world, holder));
            (expect, vec![ix], vec![signer])
        }
        Op::Freeze {
            signer,
            target,
            thaw,
            reason,
            role,
        } => {
            let s = world.key(signer);
            let holder = model.role_holder(world, role, s);
            let needed = if thaw { perm::THAW } else { perm::FREEZE };
            let account = match target {
                Target::Account(i) => world.accounts[i],
                Target::OtherMint => world.other_account,
                Target::Policy => policy_pda(&mint),
                Target::Mint => mint,
            };
            // Anchor loads every account first (a missing policy, then a missing role entry, fail
            // there), then checks the constraints in field order: the mint's freeze authority, then
            // that the target is owned by Token-2022. The instruction then checks the permission,
            // and Token-2022 the rest during the CPI.
            let expect = match model.policy {
                _ if !signer_ok(signer) => Expect::Err,
                None => Expect::Err,
                Some(_) if model.role_missing(holder) => {
                    Expect::Code(anchor_code::ACCOUNT_NOT_INITIALIZED)
                }
                Some(_) if model.freeze_authority != Some(vigilantis_freeze) => {
                    Expect::Code(code::FREEZE_AUTHORITY_NOT_VIGILANTIS)
                }
                Some(_) if matches!(target, Target::Policy) => Expect::Err,
                Some(_) if !model.allowed(s, holder, needed) => Expect::Code(code::UNAUTHORIZED),
                Some(_) => match target {
                    Target::Account(i) if model.frozen[i] == !thaw => {
                        Expect::Code(token_code::INVALID_STATE)
                    }
                    Target::Account(_) => Expect::Ok,
                    _ => Expect::Err,
                },
            };
            if let (Expect::Ok, Target::Account(i)) = (expect, target) {
                model.frozen[i] = !thaw;
                model.freeze_records[i] = if thaw { None } else { Some(now(&world.svm)) };
                events.push(Enforcement {
                    mint,
                    wallet: world.wallets[i].pubkey(),
                    token_account: account,
                    action: if thaw { Action::Thaw } else { Action::Freeze },
                    reason,
                    authority: s,
                });
            }
            let ix = ix::with_role(
                ix::set_frozen(!thaw, s, mint, account, reason),
                role_account(world, holder),
            );
            (expect, vec![ix], vec![signer])
        }
        Op::HandOverFreeze { signer } => {
            let s = world.key(signer);
            let expect = if signer_ok(signer) && model.freeze_authority == Some(s) {
                Expect::Ok
            } else {
                Expect::Err
            };
            if expect == Expect::Ok {
                model.freeze_authority = Some(vigilantis_freeze);
            }
            (
                expect,
                vec![set_freeze_authority_ix(&mint, &s, &vigilantis_freeze)],
                vec![signer],
            )
        }
        Op::SetFreezeAuthority { signer, to, reason } => {
            let s = world.key(signer);
            let new = match to {
                NewFreeze::Who(w) => Some(world.key(w)),
                NewFreeze::Vigilantis => Some(vigilantis_freeze),
                NewFreeze::Default => Some(Pubkey::default()),
                NewFreeze::Renounce => None,
            };
            // Accounts load first (a missing policy fails there), then the mint's freeze authority
            // and the policy authority are checked, then the new address.
            let expect = match model.policy {
                _ if !signer_ok(signer) => Expect::Err,
                None => Expect::Err,
                Some(_) if model.freeze_authority != Some(vigilantis_freeze) => {
                    Expect::Code(code::FREEZE_AUTHORITY_NOT_VIGILANTIS)
                }
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) if new == Some(vigilantis_freeze) || new == Some(Pubkey::default()) => {
                    Expect::Code(code::INVALID_AUTHORITY)
                }
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.freeze_authority = new;
                freeze_changes.push(FreezeChange {
                    mint,
                    new_freeze_authority: new,
                    reason,
                    authority: s,
                });
            }
            (
                expect,
                vec![ix::set_freeze_authority(s, mint, new, reason)],
                vec![signer],
            )
        }
        Op::Propose {
            signer,
            new_authority,
        } => {
            let s = world.key(signer);
            let new = match new_authority {
                ProposeTo::Who(w) => world.key(w),
                ProposeTo::Default => Pubkey::default(),
                ProposeTo::Current => model.authority().unwrap_or(s),
            };
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) || model.pending.is_some() => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some((a, _)) if new == Pubkey::default() || new == a => {
                    Expect::Code(code::INVALID_AUTHORITY)
                }
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.pending = Some(new);
            }
            (
                expect,
                vec![ix::propose_authority(s, mint, new)],
                vec![signer],
            )
        }
        Op::Cancel { signer } => {
            let s = world.key(signer);
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) || model.pending.is_none() => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.pending = None;
            }
            (
                expect,
                vec![ix::cancel_authority_transfer(s, mint)],
                vec![signer],
            )
        }
        Op::Accept { signer, previous } => {
            let s = world.key(signer);
            let p = world.key(previous);
            let expect = match (model.policy, model.pending) {
                (None, _) | (_, None) => Expect::Err,
                _ if !signer_ok(signer) => Expect::Err,
                (Some((a, _)), _) if a != p => Expect::Code(code::UNAUTHORIZED),
                (_, Some(n)) if n != s => Expect::Code(code::UNAUTHORIZED),
                _ => Expect::Ok,
            };
            if expect == Expect::Ok {
                let rules = model.policy.unwrap().1;
                model.policy = Some((s, rules));
                model.pending = None;
                model.role_epoch = model.role_epoch.wrapping_add(1);
            }
            (expect, vec![ix::accept_authority(s, p, mint)], vec![signer])
        }
        Op::GrantRole {
            signer,
            holder,
            permissions,
        } => {
            let s = world.key(signer);
            let h = world.key(holder);
            // The role entry is created while the accounts load; the admin check is a constraint;
            // the permissions are checked in the instruction.
            let expect = match model.policy {
                _ if !signer_ok(signer) => Expect::Err,
                None => Expect::Err,
                Some(_) if model.roles.contains_key(&h) => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) if permissions == 0 || permissions & !perm::ALL != 0 => {
                    Expect::Code(code::INVALID_PERMISSIONS)
                }
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.roles.insert(h, permissions);
                model.role_epochs.insert(h, model.role_epoch);
            }
            (
                expect,
                vec![ix::grant_role(s, mint, h, permissions)],
                vec![signer],
            )
        }
        Op::UpdateRole {
            signer,
            holder,
            permissions,
        } => {
            let s = world.key(signer);
            let h = world.key(holder);
            let expect = match model.policy {
                _ if !signer_ok(signer) => Expect::Err,
                None => Expect::Err,
                Some(_) if !model.roles.contains_key(&h) => {
                    Expect::Code(anchor_code::ACCOUNT_NOT_INITIALIZED)
                }
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) if permissions == 0 || permissions & !perm::ALL != 0 => {
                    Expect::Code(code::INVALID_PERMISSIONS)
                }
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.roles.insert(h, permissions);
                model.role_epochs.insert(h, model.role_epoch);
            }
            (
                expect,
                vec![ix::update_role(s, mint, h, permissions)],
                vec![signer],
            )
        }
        Op::RevokeRole { signer, holder } => {
            let s = world.key(signer);
            let h = world.key(holder);
            let expect = match model.policy {
                _ if !signer_ok(signer) => Expect::Err,
                None => Expect::Err,
                Some(_) if !model.roles.contains_key(&h) => {
                    Expect::Code(anchor_code::ACCOUNT_NOT_INITIALIZED)
                }
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.roles.remove(&h);
                model.role_epochs.remove(&h);
            }
            (expect, vec![ix::revoke_role(s, mint, h)], vec![signer])
        }
        Op::RenounceRole { holder } => {
            let h = world.key(holder);
            // Needs no policy: only the holder's own entry and signature.
            let expect = if !signer_ok(holder) {
                Expect::Err
            } else if !model.roles.contains_key(&h) {
                Expect::Code(anchor_code::ACCOUNT_NOT_INITIALIZED)
            } else {
                Expect::Ok
            };
            if expect == Expect::Ok {
                model.roles.remove(&h);
                model.role_epochs.remove(&h);
            }
            (expect, vec![ix::renounce_role(h, mint)], vec![holder])
        }
        Op::Pause {
            signer,
            resume,
            reason,
            role,
        } => {
            let s = world.key(signer);
            let holder = model.role_holder(world, role, s);
            let needed = if resume { perm::RESUME } else { perm::PAUSE };
            let vigilantis_pause = pause_authority_pda(&mint);
            let expect = match model.policy {
                _ if !signer_ok(signer) => Expect::Err,
                None => Expect::Err,
                Some(_) if model.role_missing(holder) => {
                    Expect::Code(anchor_code::ACCOUNT_NOT_INITIALIZED)
                }
                Some(_) if !model.allowed(s, holder, needed) => Expect::Code(code::UNAUTHORIZED),
                Some(_) if !model.pausable || model.pause_authority != Some(vigilantis_pause) => {
                    Expect::Code(code::PAUSE_AUTHORITY_NOT_VIGILANTIS)
                }
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.paused = !resume;
                events.push(Enforcement {
                    mint,
                    wallet: Pubkey::default(),
                    token_account: Pubkey::default(),
                    action: if resume {
                        Action::Resume
                    } else {
                        Action::Pause
                    },
                    reason,
                    authority: s,
                });
            }
            let ix = ix::with_role(
                ix::pause(resume, s, mint, reason),
                role_account(world, holder),
            );
            (expect, vec![ix], vec![signer])
        }
        Op::HandOverPause { signer } => {
            let s = world.key(signer);
            let vigilantis_pause = pause_authority_pda(&mint);
            let expect = if model.pausable && signer_ok(signer) && model.pause_authority == Some(s)
            {
                Expect::Ok
            } else {
                Expect::Err
            };
            if expect == Expect::Ok {
                model.pause_authority = Some(vigilantis_pause);
            }
            (
                expect,
                vec![set_pause_authority_ix(&mint, &s, &vigilantis_pause)],
                vec![signer],
            )
        }
        Op::SetPauseAuthority { signer, to, reason } => {
            let s = world.key(signer);
            let vigilantis_pause = pause_authority_pda(&mint);
            let new = match to {
                NewFreeze::Who(w) => Some(world.key(w)),
                NewFreeze::Vigilantis => Some(vigilantis_pause),
                NewFreeze::Default => Some(Pubkey::default()),
                NewFreeze::Renounce => None,
            };
            let expect = match model.policy {
                _ if !signer_ok(signer) => Expect::Err,
                None => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) if !model.pausable || model.pause_authority != Some(vigilantis_pause) => {
                    Expect::Code(code::PAUSE_AUTHORITY_NOT_VIGILANTIS)
                }
                Some(_) if model.paused => Expect::Code(code::PAUSED_MINT_HANDOVER),
                Some(_) if new == Some(vigilantis_pause) || new == Some(Pubkey::default()) => {
                    Expect::Code(code::INVALID_AUTHORITY)
                }
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.pause_authority = new;
            }
            (
                expect,
                vec![ix::set_pause_authority(s, mint, new, reason)],
                vec![signer],
            )
        }
        Op::Seize {
            signer,
            account,
            case,
            code: reason_code,
            role,
        } => {
            let s = world.key(signer);
            let holder = model.role_holder(world, role, s);
            let reason = Reason {
                code: reason_code,
                case_ref: CASES[case],
            };
            let earliest = model.freeze_records[account].map(|t| t + SEIZE_DELAY_SECONDS);
            // Loading: the policy, the freeze record, the new seizure record, the role entry. Then
            // the mint's freeze authority (a constraint). Then, in the instruction: the permission,
            // the case reference, the permanent delegate, the account's state, its balance and the
            // delay; then Token-2022's burn, which a paused mint refuses.
            let expect = match model.policy {
                _ if !signer_ok(signer) => Expect::Err,
                None => Expect::Err,
                Some(_) if model.freeze_records[account].is_none() => {
                    Expect::Code(anchor_code::ACCOUNT_NOT_INITIALIZED)
                }
                Some(_) if model.seizures.contains_key(&(account, case)) => Expect::Err,
                Some(_) if model.role_missing(holder) => {
                    Expect::Code(anchor_code::ACCOUNT_NOT_INITIALIZED)
                }
                Some(_) if model.freeze_authority != Some(vigilantis_freeze) => {
                    Expect::Code(code::FREEZE_AUTHORITY_NOT_VIGILANTIS)
                }
                Some(_) if !model.allowed(s, holder, perm::SEIZE) => {
                    Expect::Code(code::UNAUTHORIZED)
                }
                Some(_) if case == 0 => Expect::Code(code::INVALID_CASE_REF),
                Some(_) if !model.delegate_is_vigilantis => {
                    Expect::Code(code::PERMANENT_DELEGATE_NOT_VIGILANTIS)
                }
                Some(_) if !model.frozen[account] => Expect::Code(code::ACCOUNT_NOT_FROZEN),
                Some(_) if model.balances[account] == 0 => Expect::Code(code::NOTHING_TO_SEIZE),
                Some(_) if earliest.is_some_and(|t| now(&world.svm) < t) => {
                    Expect::Code(code::SEIZE_TOO_EARLY)
                }
                Some(_) if model.paused => Expect::Code(token_code::MINT_PAUSED),
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                let amount = model.balances[account];
                model.balances[account] = 0;
                model.supply -= amount;
                model.seizures.insert((account, case), amount);
                events.push(Enforcement {
                    mint,
                    wallet: world.wallets[account].pubkey(),
                    token_account: world.accounts[account],
                    action: Action::Seize,
                    reason,
                    authority: s,
                });
            }
            let ix = ix::with_role(
                ix::seize(s, mint, world.accounts[account], reason),
                role_account(world, holder),
            );
            (expect, vec![ix], vec![signer])
        }
        Op::CloseSeizure {
            signer,
            account,
            case,
            outcome,
            code: reason_code,
            role,
        } => {
            let s = world.key(signer);
            let holder = model.role_holder(world, role, s);
            let expect = match model.policy {
                _ if !signer_ok(signer) => Expect::Err,
                None => Expect::Err,
                Some(_) if !model.seizures.contains_key(&(account, case)) => {
                    Expect::Code(anchor_code::ACCOUNT_NOT_INITIALIZED)
                }
                Some(_) if model.role_missing(holder) => {
                    Expect::Code(anchor_code::ACCOUNT_NOT_INITIALIZED)
                }
                Some(_) if !model.allowed(s, holder, perm::CLOSE_SEIZURE) => {
                    Expect::Code(code::UNAUTHORIZED)
                }
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.seizures.remove(&(account, case));
                events.push(Enforcement {
                    mint,
                    wallet: world.wallets[account].pubkey(),
                    token_account: world.accounts[account],
                    action: Action::CloseSeizure,
                    reason: Reason {
                        code: reason_code,
                        case_ref: CASES[case],
                    },
                    authority: s,
                });
            }
            let ix = ix::with_role(
                ix::close_seizure(
                    s,
                    mint,
                    world.accounts[account],
                    CASES[case],
                    outcome,
                    reason_code,
                ),
                role_account(world, holder),
            );
            (expect, vec![ix], vec![signer])
        }
        Op::Warp { seconds } => {
            advance_clock(&mut world.svm, seconds);
            return check_state(world, model).map(|()| Expect::Ok);
        }
        Op::Approve {
            owner,
            delegate,
            amount,
        } => {
            let d = world.key(delegate);
            let expect = if model.frozen[owner] {
                Expect::Code(token_code::ACCOUNT_FROZEN)
            } else {
                Expect::Ok
            };
            if expect == Expect::Ok {
                model.delegations[owner] = Some((d, amount));
            }
            let o = world.wallets[owner].pubkey();
            (
                expect,
                vec![approve_ix(&o, &mint, &world.accounts[owner], &d, amount)],
                vec![Who::Wallet(owner)],
            )
        }
        Op::Transfer {
            from,
            to,
            authority,
            amount,
        } => {
            let a = world.key(authority);
            let from_owner = world.wallets[from].pubkey();
            let to_owner = world.wallets[to].pubkey();
            // Token-2022 checks the mint's permanent delegate first: it may move any account's
            // tokens, and that leaves the account's own delegation untouched.
            let permanent = model.permanent_delegate == Some(a);
            let delegated = match model.delegations[from] {
                Some((d, allowance)) if d == a && !permanent => Some(allowance),
                _ => None,
            };
            let token_ok = signer_ok(authority)
                && amount <= model.balances[from]
                && (permanent
                    || match delegated {
                        Some(allowance) => allowance >= amount,
                        None => a == from_owner,
                    });
            // Token-2022's order: a frozen source, then funds, then a paused mint, then the
            // authority, then a self-transfer returns, then a frozen destination, and only then the
            // hook.
            let expect = if !signer_ok(authority) {
                Expect::Err
            } else if model.frozen[from] {
                Expect::Code(token_code::ACCOUNT_FROZEN)
            } else if amount > model.balances[from] {
                Expect::Err
            } else if model.paused {
                Expect::Code(token_code::MINT_PAUSED)
            } else if !token_ok {
                Expect::Err
            } else if from == to {
                // Token-2022 returns before calling the hook on a self-transfer: nothing moves.
                Expect::Ok
            } else if model.frozen[to] {
                Expect::Code(token_code::ACCOUNT_FROZEN)
            } else if !model.meta_list {
                Expect::Err // fail closed: Token-2022 cannot resolve the hook's accounts
            } else {
                model.hook(from_owner, to_owner, a, amount, true)
            };
            if expect == Expect::Ok && from != to {
                model.balances[from] -= amount;
                model.balances[to] += amount;
                if let Some(allowance) = delegated {
                    let left = allowance - amount;
                    model.delegations[from] = if left == 0 { None } else { Some((a, left)) };
                }
            }
            let extras = ix::hook_extras(&mint, &from_owner, &to_owner, &a);
            let ix = ix::transfer(
                world.accounts[from],
                mint,
                world.accounts[to],
                a,
                &extras,
                amount,
            );
            (expect, vec![ix], vec![authority])
        }
        Op::Execute {
            from,
            to,
            authority,
            amount,
            fifth,
        } => {
            let a = world.key(authority);
            let from_owner = world.wallets[from].pubkey();
            let to_owner = world.wallets[to].pubkey();
            // A direct call, outside a transfer: the source account's `transferring` flag is not
            // set, so the hook refuses it (NotInTransfer) before evaluating any rule, whatever
            // the model would say about the same transfer. Accounts Anchor checks first (the
            // policy) can still fail it earlier. Nothing may change (invariant 9).
            let mut extras = ix::hook_extras(&mint, &from_owner, &to_owner, &a);
            let check_authority = match fifth {
                Fifth::Resolved => true,
                Fifth::Policy => {
                    extras[4] = policy_pda(&mint);
                    false
                }
                Fifth::EntryOf(w) => {
                    extras[4] = block_pda(&mint, &world.key(w));
                    world.key(w) == a
                }
            };
            let expect = match model.hook(from_owner, to_owner, a, amount, check_authority) {
                Expect::Code(code) if code < 6000 => Expect::Code(code),
                Expect::Err => Expect::Err,
                _ => Expect::Code(code::NOT_IN_TRANSFER),
            };
            let ix = ix::execute(
                world.accounts[from],
                mint,
                world.accounts[to],
                a,
                &extras,
                amount,
            );
            (expect, vec![ix], vec![])
        }
        Op::InterfaceInit { signer } => {
            let s = world.key(signer);
            (
                Expect::Err,
                vec![ix::interface_initialize_meta_list(s, mint)],
                vec![signer],
            )
        }
        Op::ExecuteGarbage { amount, seed } => {
            let mut rng = Rng(seed);
            let mut candidates: Vec<Pubkey> = world.accounts.clone();
            candidates.extend(world.wallets.iter().map(|w| w.pubkey()));
            candidates.push(policy_pda(&mint));
            candidates.push(meta_list_pda(&mint));
            for w in &world.wallets {
                candidates.push(block_pda(&mint, &w.pubkey()));
                candidates.push(allow_pda(&mint, &w.pubkey()));
            }
            candidates.push(Keypair::new().pubkey());
            let n = candidates.len() as u64;
            let picks: Vec<Pubkey> = (0..9).map(|_| candidates[rng.below(n) as usize]).collect();
            let extras = &picks[3..3 + rng.below(6) as usize];
            let ix = ix::execute(picks[0], mint, picks[1], picks[2], extras, amount);
            let result = send(&mut world.svm, &world.issuer, &[], &[ix]);
            let _ = result; // any verdict; what matters is that nothing changed
            return check_state(world, model).map(|()| Expect::Ok);
        }
        Op::Prefund {
            meta_list,
            lamports,
        } => {
            let target = if meta_list {
                meta_list_pda(&mint)
            } else {
                policy_pda(&mint)
            };
            let exists = if meta_list {
                model.meta_list
            } else {
                model.policy.is_some()
            };
            if exists {
                return check_state(world, model).map(|()| Expect::Ok);
            }
            let ix = solana_system_interface::instruction::transfer(
                &world.wallets[4].pubkey(),
                &target,
                lamports,
            );
            send(&mut world.svm, &world.wallets[4], &[], &[ix])
                .map_err(|e| format!("prefund: {e:?}"))?;
            return check_state(world, model).map(|()| Expect::Ok);
        }
    };

    // `Nobody` has no keypair: its signature stays missing and the runtime refuses the transaction.
    let keypairs: Vec<Keypair> = signers
        .iter()
        .filter(|w| **w != Who::Nobody)
        .map(|w| world.keypair(*w).insecure_clone())
        .collect();
    let refs: Vec<&Keypair> = keypairs.iter().collect();
    let issuer = world.issuer.insecure_clone();
    let result = send_logs(&mut world.svm, &issuer, &refs, &ixs);
    let ok = match (&result, expect) {
        (Ok(_), Expect::Ok) => true,
        (Err(e), Expect::Code(c)) => custom_code(e) == Some(c),
        (Err(_), Expect::Err) => true,
        _ => false,
    };
    if !ok {
        let got = match &result {
            Ok(_) => "Ok".to_string(),
            Err(e) => format!("{:?}\n    logs: {:#?}", e.err, e.meta.logs),
        };
        return Err(format!("expected {expect:?}, got {got}"));
    }
    if let Ok(logs) = &result {
        let emitted = enforcement_events(logs);
        if emitted != events {
            return Err(format!(
                "EnforcementAction events {emitted:#?}, model {events:#?}"
            ));
        }
        let emitted = freeze_authority_events(logs);
        if emitted != freeze_changes {
            return Err(format!(
                "FreezeAuthorityChanged events {emitted:#?}, model {freeze_changes:#?}"
            ));
        }
    }
    if expect == Expect::Ok {
        if let Op::InitMetaList { .. } | Op::UpdateMetaList { .. } = op {
            world.meta_list_bytes =
                vigilantis_account(&world.svm, &meta_list_pda(&mint)).map(|a| a.data);
        }
    }
    check_state(world, model).map(|()| expect)
}

/// The chain must hold exactly what the model says.
fn check_state(world: &World, model: &Model) -> Result<(), String> {
    let mint = world.mint;
    let svm = &world.svm;
    let policy = read_policy(svm, &mint);
    match (&policy, model.policy) {
        (None, None) => {}
        (Some(p), Some((authority, rules))) => {
            if p.mint != mint || p.authority != authority || p.rules != rules {
                return Err(format!("policy {p:?}, model {:?}", model.policy));
            }
        }
        _ => return Err(format!("policy {policy:?}, model {:?}", model.policy)),
    }
    let pending = read_pending(svm, &mint);
    if pending != model.pending {
        return Err(format!("pending {pending:?}, model {:?}", model.pending));
    }
    let mut people: Vec<Pubkey> = world.wallets.iter().map(|w| w.pubkey()).collect();
    people.push(world.issuer.pubkey());
    people.push(world.nobody);
    for p in &people {
        let allow = vigilantis_account(svm, &allow_pda(&mint, p)).is_some();
        let block = vigilantis_account(svm, &block_pda(&mint, p)).is_some();
        if allow != model.allow.contains(p) || block != model.block.contains(p) {
            return Err(format!(
                "entries of {p}: allow {allow} block {block}, model allow {} block {}",
                model.allow.contains(p),
                model.block.contains(p)
            ));
        }
    }
    let meta = vigilantis_account(svm, &meta_list_pda(&mint)).map(|a| a.data);
    if meta.is_some() != model.meta_list {
        return Err(format!(
            "meta list exists: {}, model {}",
            meta.is_some(),
            model.meta_list
        ));
    }
    if meta != world.meta_list_bytes {
        return Err("meta list bytes changed outside init/update".into());
    }
    let freeze_authority = freeze_authority_of(svm, &mint);
    if freeze_authority != model.freeze_authority {
        return Err(format!(
            "freeze authority {freeze_authority:?}, model {:?}",
            model.freeze_authority
        ));
    }
    let mut total = 0;
    for (i, account) in world.accounts.iter().enumerate() {
        let frozen = is_frozen(svm, account);
        if frozen != model.frozen[i] {
            return Err(format!(
                "wallet {i}: frozen {frozen}, model {}",
                model.frozen[i]
            ));
        }
        let (amount, delegate, delegated) = token_state(svm, account);
        total += amount;
        let model_delegation = model.delegations[i];
        let chain_delegation = delegate.map(|d| (d, delegated));
        if amount != model.balances[i] || chain_delegation != model_delegation {
            return Err(format!(
                "wallet {i}: balance {amount} delegation {chain_delegation:?}, model {} {model_delegation:?}",
                model.balances[i]
            ));
        }
    }
    if total != model.supply {
        return Err(format!("supply {total}, model {}", model.supply));
    }
    let supply = supply_of(svm, &mint);
    if supply != model.supply {
        return Err(format!("mint supply {supply}, model {}", model.supply));
    }
    for p in &people {
        let role = read_role(svm, &mint, p);
        if role != model.roles.get(p).copied() {
            return Err(format!(
                "role of {p}: {role:?}, model {:?}",
                model.roles.get(p)
            ));
        }
    }
    let pause = pause_state(svm, &mint);
    let model_pause = model
        .pausable
        .then_some((model.pause_authority, model.paused));
    if pause != model_pause {
        return Err(format!("pause {pause:?}, model {model_pause:?}"));
    }
    for (i, account) in world.accounts.iter().enumerate() {
        let record = read_freeze_record(svm, &mint, account);
        if record != model.freeze_records[i] {
            return Err(format!(
                "wallet {i}: freeze record {record:?}, model {:?}",
                model.freeze_records[i]
            ));
        }
        for (case, case_ref) in CASES.iter().enumerate() {
            let seizure = read_seizure(svm, &mint, account, case_ref);
            let expected = model.seizures.get(&(i, case)).copied();
            if seizure != expected {
                return Err(format!(
                    "wallet {i} case {case}: seizure {seizure:?}, model {expected:?}"
                ));
            }
        }
    }
    Ok(())
}

fn setup(rng: &mut Rng) -> (World, Model, Vec<Op>) {
    let mut svm = svm();
    let issuer = Keypair::new();
    let wallets: Vec<Keypair> = (0..WALLETS).map(|_| Keypair::new()).collect();
    fund(&mut svm, &issuer.pubkey(), 1_000_000_000_000);
    for w in &wallets {
        fund(&mut svm, &w.pubkey(), 100_000_000_000);
    }
    // The mint's freeze authority: Vigilantis's address in most cases, the issuer in some, no one in
    // a few.
    let mint = Keypair::new();
    let freeze_authority = match rng.below(20) {
        0..=11 => Some(freeze_authority_pda(&mint.pubkey())),
        12..=16 => Some(issuer.pubkey()),
        _ => None,
    };
    // Permanent delegate and Pausable (1.0): Vigilantis's addresses in most cases, the issuer in
    // some, not there in a few.
    let delegate = match rng.below(20) {
        0..=11 => Some(permanent_delegate_pda(&mint.pubkey())),
        12..=14 => Some(issuer.pubkey()),
        _ => None,
    };
    let pause_authority = match rng.below(20) {
        0..=11 => Some(pause_authority_pda(&mint.pubkey())),
        12..=14 => Some(issuer.pubkey()),
        _ => None,
    };
    let delegate_is_vigilantis = delegate == Some(permanent_delegate_pda(&mint.pubkey()));
    let mint = create_mint_with(
        &mut svm,
        &issuer,
        mint,
        freeze_authority.as_ref(),
        delegate.as_ref(),
        pause_authority.as_ref(),
    )
    .pubkey();
    // Another mint whose freeze authority is Vigilantis's address for that mint, with a policy and
    // a role for wallet 0 holding every permission: an entry that must not count on this mint.
    let other_mint = Keypair::new();
    let other_freeze = freeze_authority_pda(&other_mint.pubkey());
    let other_mint =
        create_hooked_mint(&mut svm, &issuer, other_mint, Some(&other_freeze)).pubkey();
    let other_account = create_token_account(&mut svm, &issuer, &other_mint, &wallets[0].pubkey());
    send(
        &mut svm,
        &issuer,
        &[&issuer],
        &[
            ix::initialize_policy(issuer.pubkey(), other_mint, Rules::default()),
            ix::grant_role(issuer.pubkey(), other_mint, wallets[0].pubkey(), perm::ALL),
        ],
    )
    .expect("set up the other mint's role");
    let accounts: Vec<Pubkey> = wallets
        .iter()
        .map(|w| create_token_account(&mut svm, &issuer, &mint, &w.pubkey()))
        .collect();
    let mut model = Model {
        balances: vec![0; WALLETS],
        delegations: vec![None; WALLETS],
        frozen: vec![false; WALLETS],
        freeze_authority,
        pausable: pause_authority.is_some(),
        pause_authority,
        permanent_delegate: delegate,
        delegate_is_vigilantis,
        freeze_records: vec![None; WALLETS],
        ..Model::default()
    };
    for (i, account) in accounts.iter().enumerate() {
        let amount = rng.below(1_000);
        if amount > 0 {
            mint_to(&mut svm, &issuer, &mint, account, amount);
        }
        model.balances[i] = amount;
        model.supply += amount;
    }
    let world = World {
        svm,
        issuer,
        wallets,
        nobody: Keypair::new().pubkey(),
        mint,
        accounts,
        other_mint,
        other_account,
        meta_list_bytes: None,
    };
    // Most cases start set up; some start bare (fail closed) or with pre-funded addresses.
    let mut ops = Vec::new();
    if rng.chance(15) {
        ops.push(Op::Prefund {
            meta_list: true,
            lamports: rng.pick(&[890_880, 10_000_000]),
        });
    }
    if rng.chance(10) {
        ops.push(Op::Prefund {
            meta_list: false,
            lamports: 890_880,
        });
    }
    if rng.chance(85) {
        ops.push(Op::InitPolicy {
            signer: Who::Issuer,
            rules: random_rules(rng),
        });
        // Half the cases start with a few roles, so role holders act from the first step.
        if rng.chance(50) {
            for _ in 0..1 + rng.below(3) {
                ops.push(Op::GrantRole {
                    signer: Who::Issuer,
                    holder: Who::Wallet(rng.below(WALLETS as u64) as usize),
                    permissions: random_permissions(rng),
                });
            }
        }
    }
    if rng.chance(85) {
        ops.push(Op::InitMetaList {
            signer: Who::Issuer,
        });
    }
    if rng.chance(20) {
        ops.push(Op::Propose {
            signer: Who::Issuer,
            new_authority: ProposeTo::Who(Who::Wallet(rng.below(WALLETS as u64) as usize)),
        });
    }
    (world, model, ops)
}

#[test]
fn vigilantis_matches_its_model() {
    let cases: u64 = std::env::var("FUZZ_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(64);
    let steps: u64 = std::env::var("FUZZ_STEPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let seed: u64 = std::env::var("FUZZ_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x05E1_71E1);
    let mut totals = std::collections::BTreeMap::<String, u64>::new();
    for case in 0..cases {
        let case_seed = seed.wrapping_add(case.wrapping_mul(0x9E37_79B9));
        let mut rng = Rng(case_seed);
        let (mut world, mut model, mut ops) = setup(&mut rng);
        let first = ops.len();
        let mut history: Vec<String> = Vec::new();
        for n in 0..(first as u64 + steps) {
            let op = if (n as usize) < first {
                ops[n as usize].clone()
            } else {
                random_op(&mut rng, &model, &world)
            };
            let name = match &op {
                Op::Freeze { thaw: true, .. } => "Thaw".to_string(),
                Op::AddEntry {
                    reason: Some(_), ..
                } => "BlockWallet".to_string(),
                Op::RemoveEntry {
                    reason: Some(_), ..
                } => "UnblockWallet".to_string(),
                _ => format!("{op:?}")
                    .split([' ', '{'])
                    .next()
                    .unwrap()
                    .to_string(),
            };
            let before = model.clone();
            let result = step(&mut world, &mut model, &op);
            let outcome = match &result {
                Ok(Expect::Ok) => "ok".to_string(),
                Ok(Expect::Code(c)) => format!("error {c}"),
                Ok(Expect::Err) | Err(_) => "error".to_string(),
            };
            *totals.entry(format!("{name} {outcome}")).or_default() += 1;
            history.push(format!("{op}"));
            if let Err(why) = result {
                panic!(
                    "case {case} (FUZZ_SEED={seed}, case seed {case_seed}), step {n}: {why}\n  op: {op}\n  model before: {before:?}\n  last operations:\n    {}",
                    history.iter().rev().take(12).rev().cloned().collect::<Vec<_>>().join("\n    ")
                );
            }
        }
        ops.clear();
    }
    let total: u64 = totals.values().sum();
    println!("{cases} cases, {total} operations, all matched the model:");
    for (name, n) in totals {
        println!("  {name:<28} {n}");
    }
}
