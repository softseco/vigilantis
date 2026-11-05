// SPDX-License-Identifier: BUSL-1.1
//! Roles, pause and seizure (Vigilantis 1.0), one situation at a time, in LiteSVM. These run here
//! rather than on a local validator because `seize` needs the cluster clock 24 hours ahead.
// The helpers return LiteSVM's own error type, large but only ever built in tests.
#![allow(clippy::result_large_err)]

mod common;

use common::*;
use litesvm::LiteSVM;
use solana_address::Address as Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;

struct Setup {
    svm: LiteSVM,
    issuer: Keypair,
    officer: Keypair,
    holder: Keypair,
    mint: Pubkey,
    account: Pubkey,
}

const CASE: [u8; 32] = [7u8; 32];

fn reason(code: u16) -> Reason {
    Reason {
        code,
        case_ref: CASE,
    }
}

/// A mint with every enforcement extension pointed at Vigilantis, a policy and meta list, and one
/// holder with 500 tokens.
fn setup() -> Setup {
    let mut svm = svm();
    let issuer = Keypair::new();
    let officer = Keypair::new();
    let holder = Keypair::new();
    for k in [&issuer, &officer, &holder] {
        fund(&mut svm, &k.pubkey(), 10_000_000_000);
    }
    let mint = Keypair::new();
    let m = mint.pubkey();
    let mint = create_mint_with(
        &mut svm,
        &issuer,
        mint,
        Some(&freeze_authority_pda(&m)),
        Some(&permanent_delegate_pda(&m)),
        Some(&pause_authority_pda(&m)),
    )
    .pubkey();
    let rules = Rules {
        blocklist: true,
        ..Rules::default()
    };
    send(
        &mut svm,
        &issuer,
        &[],
        &[
            ix::initialize_policy(issuer.pubkey(), mint, rules),
            ix::initialize_meta_list(issuer.pubkey(), mint),
        ],
    )
    .expect("policy");
    let account = create_token_account(&mut svm, &issuer, &mint, &holder.pubkey());
    mint_to(&mut svm, &issuer, &mint, &account, 500);
    Setup {
        svm,
        issuer,
        officer,
        holder,
        mint,
        account,
    }
}

impl Setup {
    fn grant(&mut self, permissions: u16) {
        let ix = ix::grant_role(
            self.issuer.pubkey(),
            self.mint,
            self.officer.pubkey(),
            permissions,
        );
        send(&mut self.svm, &self.issuer, &[], &[ix]).expect("grant_role");
    }

    /// `ix` signed by the officer, passing the officer's role entry.
    fn as_officer(
        &mut self,
        ix: solana_instruction::Instruction,
    ) -> Result<Vec<String>, litesvm::types::FailedTransactionMetadata> {
        let role = role_pda(&self.mint, &self.officer.pubkey());
        let ix = ix::with_role(ix, Some(role));
        let officer = self.officer.insecure_clone();
        send_logs(&mut self.svm, &officer, &[], &[ix])
    }

    fn freeze(&mut self) {
        let ix = ix::set_frozen(
            true,
            self.issuer.pubkey(),
            self.mint,
            self.account,
            reason(2),
        );
        send(&mut self.svm, &self.issuer, &[], &[ix]).expect("freeze");
    }

    fn seize_by_issuer(
        &mut self,
    ) -> Result<Vec<String>, litesvm::types::FailedTransactionMetadata> {
        let ix = ix::seize(self.issuer.pubkey(), self.mint, self.account, reason(2));
        send_logs(&mut self.svm, &self.issuer.insecure_clone(), &[], &[ix])
    }
}

#[test]
fn a_role_holder_does_exactly_what_its_role_allows() {
    let mut s = setup();
    s.grant(perm::FREEZE | perm::BLOCK);
    let (officer, mint, account) = (s.officer.pubkey(), s.mint, s.account);

    // Allowed: freeze and block.
    s.as_officer(ix::set_frozen(true, officer, mint, account, reason(1)))
        .expect("officer freezes");
    assert!(is_frozen(&s.svm, &account));
    let wallet = s.holder.pubkey();
    s.as_officer(ix::block_with_reason(
        true,
        officer,
        mint,
        wallet,
        reason(1),
    ))
    .expect("officer blocks");

    // Not allowed: thaw, unblock, the policy and roles.
    for refused in [
        ix::set_frozen(false, officer, mint, account, reason(7)),
        ix::block_with_reason(false, officer, mint, wallet, reason(7)),
        ix::add_to_list(false, officer, mint, wallet),
    ] {
        let err = s.as_officer(refused).unwrap_err();
        assert_eq!(custom_code(&err), Some(code::UNAUTHORIZED));
    }
    let officer_kp = s.officer.insecure_clone();
    let err = send(
        &mut s.svm,
        &officer_kp,
        &[],
        &[ix::update_policy(officer, mint, Rules::default())],
    )
    .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::UNAUTHORIZED));
    let err = send(
        &mut s.svm,
        &officer_kp,
        &[],
        &[ix::grant_role(
            officer,
            mint,
            Keypair::new().pubkey(),
            perm::ALL,
        )],
    )
    .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::UNAUTHORIZED));

    // Without passing its role entry, the officer is nobody.
    let err = send(
        &mut s.svm,
        &officer_kp,
        &[],
        &[ix::set_frozen(false, officer, mint, account, reason(1))],
    )
    .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::UNAUTHORIZED));

    // The admin widens the role; now the thaw works.
    let ix = ix::update_role(s.issuer.pubkey(), mint, officer, perm::FREEZE | perm::THAW);
    send(&mut s.svm, &s.issuer.insecure_clone(), &[], &[ix]).expect("update_role");
    s.as_officer(ix::set_frozen(false, officer, mint, account, reason(7)))
        .expect("officer thaws");
    assert!(!is_frozen(&s.svm, &account));
}

#[test]
fn a_role_entry_works_only_for_its_holder_and_mint() {
    let mut s = setup();
    s.grant(perm::ALL);
    let stranger = Keypair::new();
    fund(&mut s.svm, &stranger.pubkey(), 1_000_000_000);
    // A stranger passes the officer's role entry: refused, the entry is not theirs.
    let role = role_pda(&s.mint, &s.officer.pubkey());
    let ix = ix::with_role(
        ix::set_frozen(true, stranger.pubkey(), s.mint, s.account, reason(1)),
        Some(role),
    );
    let err = send(&mut s.svm, &stranger, &[], &[ix]).unwrap_err();
    assert_eq!(custom_code(&err), Some(code::UNAUTHORIZED));

    // The officer passes its entry for this mint on another mint whose admin is the issuer.
    let other = Keypair::new();
    let o = other.pubkey();
    let other = create_mint_with(
        &mut s.svm,
        &s.issuer,
        other,
        Some(&freeze_authority_pda(&o)),
        None,
        None,
    )
    .pubkey();
    let issuer = s.issuer.insecure_clone();
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::initialize_policy(
            issuer.pubkey(),
            other,
            Rules::default(),
        )],
    )
    .unwrap();
    let other_account = create_token_account(&mut s.svm, &issuer, &other, &s.holder.pubkey());
    let ix = ix::with_role(
        ix::set_frozen(true, s.officer.pubkey(), other, other_account, reason(1)),
        Some(role),
    );
    let err = send(&mut s.svm, &s.officer.insecure_clone(), &[], &[ix]).unwrap_err();
    assert_eq!(custom_code(&err), Some(code::UNAUTHORIZED));
}

#[test]
fn roles_are_granted_changed_revoked_and_renounced() {
    let mut s = setup();
    let (issuer, mint, officer) = (s.issuer.pubkey(), s.mint, s.officer.pubkey());
    let admin = s.issuer.insecure_clone();
    // No permission, or an unknown one: refused.
    for bad in [0u16, 1 << 9, perm::ALL + 1] {
        let err = send(
            &mut s.svm,
            &admin,
            &[],
            &[ix::grant_role(issuer, mint, officer, bad)],
        )
        .unwrap_err();
        assert_eq!(custom_code(&err), Some(code::INVALID_PERMISSIONS), "{bad}");
    }
    s.grant(perm::PAUSE);
    assert_eq!(read_role(&s.svm, &mint, &officer), Some(perm::PAUSE));
    // A second grant to the same holder: refused (the entry exists; use update_role).
    assert!(send(
        &mut s.svm,
        &admin,
        &[],
        &[ix::grant_role(issuer, mint, officer, perm::SEIZE)]
    )
    .is_err());
    send(
        &mut s.svm,
        &admin,
        &[],
        &[ix::update_role(issuer, mint, officer, perm::SEIZE)],
    )
    .unwrap();
    assert_eq!(read_role(&s.svm, &mint, &officer), Some(perm::SEIZE));
    // The holder gives it up; only the holder can.
    assert!(send(&mut s.svm, &admin, &[], &[ix::renounce_role(officer, mint)]).is_err());
    send(
        &mut s.svm,
        &s.officer.insecure_clone(),
        &[],
        &[ix::renounce_role(officer, mint)],
    )
    .unwrap();
    assert_eq!(read_role(&s.svm, &mint, &officer), None);
    // Granted again, then revoked by the admin.
    s.grant(perm::FREEZE);
    let stranger = Keypair::new();
    fund(&mut s.svm, &stranger.pubkey(), 1_000_000_000);
    let err = send(
        &mut s.svm,
        &stranger,
        &[],
        &[ix::revoke_role(stranger.pubkey(), mint, officer)],
    )
    .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::UNAUTHORIZED));
    send(
        &mut s.svm,
        &admin,
        &[],
        &[ix::revoke_role(issuer, mint, officer)],
    )
    .unwrap();
    assert_eq!(read_role(&s.svm, &mint, &officer), None);
}

#[test]
fn pause_stops_the_token_and_resume_restarts_it() {
    let mut s = setup();
    s.grant(perm::PAUSE);
    let (officer, mint) = (s.officer.pubkey(), s.mint);
    let logs = s
        .as_officer(ix::pause(false, officer, mint, reason(4)))
        .expect("pause");
    assert_eq!(
        pause_state(&s.svm, &mint),
        Some((Some(pause_authority_pda(&mint)), true))
    );
    let events = enforcement_events(&logs);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].action, Action::Pause);
    assert_eq!(events[0].authority, officer);

    // While paused: a transfer and a mint are refused; a freeze still works.
    let other = Keypair::new();
    let issuer = s.issuer.insecure_clone();
    let to = create_token_account(&mut s.svm, &issuer, &mint, &other.pubkey());
    let extras = ix::hook_extras(
        &mint,
        &s.holder.pubkey(),
        &other.pubkey(),
        &s.holder.pubkey(),
    );
    let transfer = ix::transfer(s.account, mint, to, s.holder.pubkey(), &extras, 10);
    let err = send(
        &mut s.svm,
        &s.holder.insecure_clone(),
        &[],
        std::slice::from_ref(&transfer),
    )
    .unwrap_err();
    assert_eq!(custom_code(&err), Some(token_code::MINT_PAUSED));
    s.freeze();
    assert!(is_frozen(&s.svm, &s.account));

    // The officer may pause but not resume; the admin resumes.
    let err = s
        .as_officer(ix::pause(true, officer, mint, reason(7)))
        .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::UNAUTHORIZED));
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::pause(true, issuer.pubkey(), mint, reason(7))],
    )
    .expect("resume");
    assert_eq!(
        pause_state(&s.svm, &mint),
        Some((Some(pause_authority_pda(&mint)), false))
    );
}

#[test]
fn pause_needs_a_pausable_mint_with_vigilantis_as_its_pause_authority() {
    let mut s = setup();
    let issuer = s.issuer.insecure_clone();
    // A mint without Pausable.
    let plain = Keypair::new();
    let p = plain.pubkey();
    let plain = create_mint_with(
        &mut s.svm,
        &issuer,
        plain,
        Some(&freeze_authority_pda(&p)),
        None,
        None,
    )
    .pubkey();
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::initialize_policy(
            issuer.pubkey(),
            plain,
            Rules::default(),
        )],
    )
    .unwrap();
    let err = send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::pause(false, issuer.pubkey(), plain, reason(4))],
    )
    .unwrap_err();
    assert_eq!(
        custom_code(&err),
        Some(code::PAUSE_AUTHORITY_NOT_VIGILANTIS)
    );

    // Vigilantis hands its pause authority to the issuer: then it can no longer pause.
    let mint = s.mint;
    for bad in [Some(pause_authority_pda(&mint)), Some(Pubkey::default())] {
        let err = send(
            &mut s.svm,
            &issuer,
            &[],
            &[ix::set_pause_authority(
                issuer.pubkey(),
                mint,
                bad,
                reason(0),
            )],
        )
        .unwrap_err();
        assert_eq!(custom_code(&err), Some(code::INVALID_AUTHORITY));
    }
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::set_pause_authority(
            issuer.pubkey(),
            mint,
            Some(issuer.pubkey()),
            reason(0),
        )],
    )
    .expect("set_pause_authority");
    assert_eq!(
        pause_state(&s.svm, &mint),
        Some((Some(issuer.pubkey()), false))
    );
    let err = send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::pause(false, issuer.pubkey(), mint, reason(4))],
    )
    .unwrap_err();
    assert_eq!(
        custom_code(&err),
        Some(code::PAUSE_AUTHORITY_NOT_VIGILANTIS)
    );
}

#[test]
fn seize_waits_24_hours_after_the_freeze_then_burns_the_public_balance() {
    let mut s = setup();
    s.grant(perm::SEIZE | perm::CLOSE_SEIZURE);
    let (mint, account, officer) = (s.mint, s.account, s.officer.pubkey());

    // Not frozen: there is no freeze record.
    let err = s.seize_by_issuer().unwrap_err();
    assert_eq!(
        custom_code(&err),
        Some(anchor_code::ACCOUNT_NOT_INITIALIZED)
    );

    s.freeze();
    let frozen_at = read_freeze_record(&s.svm, &mint, &account).expect("freeze record");
    assert_eq!(frozen_at, now(&s.svm));

    // Too early, for the admin as for everyone.
    let err = s.seize_by_issuer().unwrap_err();
    assert_eq!(custom_code(&err), Some(code::SEIZE_TOO_EARLY));
    advance_clock(&mut s.svm, SEIZE_DELAY_SECONDS - 1);
    let err = s.seize_by_issuer().unwrap_err();
    assert_eq!(custom_code(&err), Some(code::SEIZE_TOO_EARLY));
    advance_clock(&mut s.svm, 1);

    // A seizure needs a case reference.
    let zero = Reason {
        code: 2,
        case_ref: [0; 32],
    };
    let err = s
        .as_officer(ix::seize(officer, mint, account, zero))
        .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::INVALID_CASE_REF));

    // Now: the officer seizes. The balance is burnt, the supply falls, the account stays frozen.
    let supply = supply_of(&s.svm, &mint);
    let logs = s
        .as_officer(ix::seize(officer, mint, account, reason(2)))
        .expect("seize");
    assert_eq!(token_state(&s.svm, &account).0, 0);
    assert_eq!(supply_of(&s.svm, &mint), supply - 500);
    assert!(is_frozen(&s.svm, &account));
    assert_eq!(read_seizure(&s.svm, &mint, &account, &CASE), Some(500));
    let events = enforcement_events(&logs);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].action, Action::Seize);
    assert_eq!(events[0].token_account, account);
    assert_eq!(events[0].wallet, s.holder.pubkey());

    // The same case again: refused, its record is open.
    assert!(s.seize_by_issuer().is_err());
    // Another case: nothing left to seize.
    let other_case = Reason {
        code: 2,
        case_ref: [8; 32],
    };
    let err = s
        .as_officer(ix::seize(officer, mint, account, other_case))
        .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::NOTHING_TO_SEIZE));

    // Closing the case.
    let logs = s
        .as_officer(ix::close_seizure(officer, mint, account, CASE, 2, 7))
        .expect("close_seizure");
    assert_eq!(read_seizure(&s.svm, &mint, &account, &CASE), None);
    let events = enforcement_events(&logs);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].action, Action::CloseSeizure);
    assert_eq!(events[0].reason.case_ref, CASE);
}

#[test]
fn a_thaw_restarts_the_seizure_clock() {
    let mut s = setup();
    let (mint, account) = (s.mint, s.account);
    let issuer = s.issuer.insecure_clone();
    s.freeze();
    advance_clock(&mut s.svm, SEIZE_DELAY_SECONDS);
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::set_frozen(
            false,
            issuer.pubkey(),
            mint,
            account,
            reason(7),
        )],
    )
    .expect("thaw");
    assert_eq!(read_freeze_record(&s.svm, &mint, &account), None);
    s.freeze();
    let err = s.seize_by_issuer().unwrap_err();
    assert_eq!(custom_code(&err), Some(code::SEIZE_TOO_EARLY));
    advance_clock(&mut s.svm, SEIZE_DELAY_SECONDS);
    s.seize_by_issuer().expect("seize");
}

#[test]
fn seize_refuses_a_mint_whose_permanent_delegate_is_not_vigilantis() {
    let mut s = setup();
    let issuer = s.issuer.insecure_clone();
    // A mint whose permanent delegate is the issuer.
    let mint = Keypair::new();
    let m = mint.pubkey();
    let mint = create_mint_with(
        &mut s.svm,
        &issuer,
        mint,
        Some(&freeze_authority_pda(&m)),
        Some(&issuer.pubkey()),
        None,
    )
    .pubkey();
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::initialize_policy(
            issuer.pubkey(),
            mint,
            Rules::default(),
        )],
    )
    .unwrap();
    let account = create_token_account(&mut s.svm, &issuer, &mint, &s.holder.pubkey());
    mint_to(&mut s.svm, &issuer, &mint, &account, 10);
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::set_frozen(
            true,
            issuer.pubkey(),
            mint,
            account,
            reason(2),
        )],
    )
    .unwrap();
    advance_clock(&mut s.svm, SEIZE_DELAY_SECONDS);
    let err = send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::seize(issuer.pubkey(), mint, account, reason(2))],
    )
    .unwrap_err();
    assert_eq!(
        custom_code(&err),
        Some(code::PERMANENT_DELEGATE_NOT_VIGILANTIS)
    );
    assert_eq!(token_state(&s.svm, &account).0, 10);
}

#[test]
fn seize_is_refused_while_the_token_is_paused() {
    let mut s = setup();
    let issuer = s.issuer.insecure_clone();
    s.freeze();
    advance_clock(&mut s.svm, SEIZE_DELAY_SECONDS);
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::pause(false, issuer.pubkey(), s.mint, reason(4))],
    )
    .unwrap();
    let err = s.seize_by_issuer().unwrap_err();
    assert_eq!(custom_code(&err), Some(token_code::MINT_PAUSED));
    assert_eq!(token_state(&s.svm, &s.account).0, 500);
}

#[test]
fn the_pause_authority_can_be_given_up_and_a_role_needs_a_real_holder() {
    let mut s = setup();
    let issuer = s.issuer.insecure_clone();
    let mint = s.mint;
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::set_pause_authority(
            issuer.pubkey(),
            mint,
            None,
            reason(0),
        )],
    )
    .expect("give up the pause authority");
    assert_eq!(pause_state(&s.svm, &mint), Some((None, false)));
    let err = send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::pause(false, issuer.pubkey(), mint, reason(4))],
    )
    .unwrap_err();
    assert_eq!(
        custom_code(&err),
        Some(code::PAUSE_AUTHORITY_NOT_VIGILANTIS)
    );

    // The default address is nobody's key, so it cannot hold a role.
    let err = send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::grant_role(
            issuer.pubkey(),
            mint,
            Pubkey::default(),
            perm::FREEZE,
        )],
    )
    .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::INVALID_AUTHORITY));
}

/// A freeze record outlives a thaw done outside Vigilantis (after the freeze authority left it).
/// `seize` then refuses the thawed account, and the next freeze through Vigilantis rewrites the
/// record, so the 24 hours start again.
#[test]
fn a_freeze_record_left_by_a_thaw_outside_vigilantis() {
    let mut s = setup();
    let issuer = s.issuer.insecure_clone();
    let (mint, account) = (s.mint, s.account);
    s.freeze();
    let frozen_at = read_freeze_record(&s.svm, &mint, &account).expect("record");

    // Vigilantis hands the freeze authority to the issuer, who thaws the account directly and
    // hands the authority back.
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::set_freeze_authority(
            issuer.pubkey(),
            mint,
            Some(issuer.pubkey()),
            reason(0),
        )],
    )
    .expect("hand the freeze authority to the issuer");
    let thaw = spl_token_2022_interface::instruction::thaw_account(
        &TOKEN_2022_ID,
        &account,
        &mint,
        &issuer.pubkey(),
        &[],
    )
    .unwrap();
    send(&mut s.svm, &issuer, &[], &[thaw]).expect("thaw outside Vigilantis");
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[set_freeze_authority_ix(
            &mint,
            &issuer.pubkey(),
            &freeze_authority_pda(&mint),
        )],
    )
    .expect("hand it back");
    assert!(!is_frozen(&s.svm, &account));
    assert_eq!(read_freeze_record(&s.svm, &mint, &account), Some(frozen_at));

    advance_clock(&mut s.svm, SEIZE_DELAY_SECONDS + 1);
    let err = s.seize_by_issuer().unwrap_err();
    assert_eq!(custom_code(&err), Some(code::ACCOUNT_NOT_FROZEN));

    // Freezing again through Vigilantis rewrites the existing record.
    s.freeze();
    let refrozen_at = read_freeze_record(&s.svm, &mint, &account).expect("record");
    assert_eq!(refrozen_at, now(&s.svm));
    assert!(refrozen_at > frozen_at);
    let err = s.seize_by_issuer().unwrap_err();
    assert_eq!(custom_code(&err), Some(code::SEIZE_TOO_EARLY));
    assert_eq!(token_state(&s.svm, &account).0, 500);
}

/// Forfeiture (1.0.0-rc.2): a case ends with the balance out of reach, typically a confidential
/// one, so the account stays frozen for good. `forfeit` waits 24 hours after the freeze like
/// `seize`, needs a case, and from then on `thaw_token_account` refuses the account, the admin's
/// thaw included, until the admin (never a role) releases the forfeiture.
#[test]
fn a_forfeited_account_cannot_be_thawed_until_the_admin_releases_it() {
    let mut s = setup();
    s.grant(perm::SEIZE | perm::THAW | perm::FREEZE);
    let (mint, account, officer) = (s.mint, s.account, s.officer.pubkey());
    let issuer = s.issuer.insecure_clone();
    let commitment = [9u8; 32];

    // Not frozen: there is no freeze record.
    let err = s
        .as_officer(ix::forfeit(officer, mint, account, reason(2), commitment))
        .unwrap_err();
    assert_eq!(
        custom_code(&err),
        Some(anchor_code::ACCOUNT_NOT_INITIALIZED)
    );

    s.freeze();
    // Too early, for the admin as for everyone.
    let err = send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::forfeit(
            issuer.pubkey(),
            mint,
            account,
            reason(2),
            commitment,
        )],
    )
    .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::SEIZE_TOO_EARLY));
    advance_clock(&mut s.svm, SEIZE_DELAY_SECONDS);

    // A forfeiture needs a case reference.
    let zero = Reason {
        code: 2,
        case_ref: [0; 32],
    };
    let err = s
        .as_officer(ix::forfeit(officer, mint, account, zero, commitment))
        .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::INVALID_CASE_REF));

    // The officer forfeits. Nothing is burnt; the account stays frozen with its balance.
    let supply = supply_of(&s.svm, &mint);
    let logs = s
        .as_officer(ix::forfeit(officer, mint, account, reason(2), commitment))
        .expect("forfeit");
    assert!(is_frozen(&s.svm, &account));
    assert_eq!(token_state(&s.svm, &account).0, 500);
    assert_eq!(supply_of(&s.svm, &mint), supply);
    assert_eq!(
        read_forfeiture(&s.svm, &mint, &account),
        Some((CASE, commitment, officer))
    );
    let events = enforcement_events(&logs);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].action, Action::Forfeit);
    assert_eq!(events[0].wallet, s.holder.pubkey());
    assert_eq!(events[0].token_account, account);
    assert_eq!(events[0].reason, reason(2));

    // A second forfeiture of the same account fails: its record exists.
    assert!(s
        .as_officer(ix::forfeit(officer, mint, account, reason(2), commitment))
        .is_err());

    // Nobody can thaw it now: not the officer with THAW, not the admin.
    let err = s
        .as_officer(ix::set_frozen(false, officer, mint, account, reason(7)))
        .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::ACCOUNT_FORFEITED));
    let err = send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::set_frozen(
            false,
            issuer.pubkey(),
            mint,
            account,
            reason(7),
        )],
    )
    .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::ACCOUNT_FORFEITED));
    assert!(is_frozen(&s.svm, &account));

    // The public balance can still be seized.
    s.seize_by_issuer().expect("seize the public part");
    assert_eq!(token_state(&s.svm, &account).0, 0);
    assert!(is_frozen(&s.svm, &account));

    // Only the admin releases the forfeiture, with no role at all.
    let officer_kp = s.officer.insecure_clone();
    let err = send(
        &mut s.svm,
        &officer_kp,
        &[],
        &[ix::release_forfeiture(officer, mint, account, 7)],
    )
    .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::UNAUTHORIZED));
    let logs = send_logs(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::release_forfeiture(issuer.pubkey(), mint, account, 7)],
    )
    .expect("release_forfeiture");
    assert_eq!(read_forfeiture(&s.svm, &mint, &account), None);
    let events = enforcement_events(&logs);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].action, Action::ReleaseForfeiture);
    assert_eq!(events[0].reason.case_ref, CASE);
    assert_eq!(events[0].reason.code, 7);
    // Still frozen until a thaw, which works again.
    assert!(is_frozen(&s.svm, &account));
    s.as_officer(ix::set_frozen(false, officer, mint, account, reason(7)))
        .expect("thaw after the release");
    assert!(!is_frozen(&s.svm, &account));
}

#[test]
fn forfeit_needs_the_seize_permission_a_frozen_account_and_vigilantis_freeze_authority() {
    let mut s = setup();
    s.grant(perm::FREEZE | perm::THAW | perm::CLOSE_SEIZURE);
    let (mint, account, officer) = (s.mint, s.account, s.officer.pubkey());
    let issuer = s.issuer.insecure_clone();
    s.freeze();
    advance_clock(&mut s.svm, SEIZE_DELAY_SECONDS);

    // Without SEIZE: refused.
    let err = s
        .as_officer(ix::forfeit(officer, mint, account, reason(2), [0; 32]))
        .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::UNAUTHORIZED));

    // A record whose account was thawed outside Vigilantis: the account is not frozen.
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::set_freeze_authority(
            issuer.pubkey(),
            mint,
            Some(issuer.pubkey()),
            reason(0),
        )],
    )
    .expect("hand the freeze authority to the issuer");
    // While the freeze authority is not Vigilantis's, forfeit is refused outright.
    let err = send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::forfeit(
            issuer.pubkey(),
            mint,
            account,
            reason(2),
            [0; 32],
        )],
    )
    .unwrap_err();
    assert_eq!(
        custom_code(&err),
        Some(code::FREEZE_AUTHORITY_NOT_VIGILANTIS)
    );
    let thaw = spl_token_2022_interface::instruction::thaw_account(
        &TOKEN_2022_ID,
        &account,
        &mint,
        &issuer.pubkey(),
        &[],
    )
    .unwrap();
    send(&mut s.svm, &issuer, &[], &[thaw]).expect("thaw outside Vigilantis");
    send(
        &mut s.svm,
        &issuer,
        &[],
        &[set_freeze_authority_ix(
            &mint,
            &issuer.pubkey(),
            &freeze_authority_pda(&mint),
        )],
    )
    .expect("hand it back");
    let err = send(
        &mut s.svm,
        &issuer,
        &[],
        &[ix::forfeit(
            issuer.pubkey(),
            mint,
            account,
            reason(2),
            [0; 32],
        )],
    )
    .unwrap_err();
    assert_eq!(custom_code(&err), Some(code::ACCOUNT_NOT_FROZEN));
    assert_eq!(read_forfeiture(&s.svm, &mint, &account), None);
}
