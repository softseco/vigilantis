<!-- SPDX-License-Identifier: BUSL-1.1 -->
# Model-based fuzzing of Vigilantis

The integration tests in `tests/` check one situation at a time. These tests throw long random
sequences of operations at the program instead, and check every step against a model of the
rules written in plain Rust.

Next to them, `tests/enforcement.rs` checks roles, pause and seizure one situation at a time (11
tests). It lives here rather than in `tests/` because a seizure needs the clock 24 hours ahead,
which LiteSVM can do and a local validator cannot:

```bash
cd tests-fuzz
cargo test --test enforcement
```

They run the built program (`target/deploy/vigilantis.so`) in [LiteSVM](https://github.com/LiteSVM/litesvm),
next to the same Token-2022 build the integration tests use (`tests/fixtures/spl_token_2022.so`,
v11.1). This is a separate Cargo project: it loads the program file and does not depend on the
program crate.

## Run

```bash
anchor build                      # or: cargo build-sbf --manifest-path programs/vigilantis/Cargo.toml
cd tests-fuzz
cargo test --test model -- --nocapture
```

| Variable | Default | |
|---|---|---|
| `FUZZ_CASES` | 64 | Independent cases (a fresh mint each) |
| `FUZZ_STEPS` | 60 | Random operations per case, after setup |
| `FUZZ_SEED` | fixed | Seed of the whole run; CI uses its run id, so every push tries new cases |
| `VIGILANTIS_SO`, `TOKEN_2022_SO` | the paths above | Programs to load |

The first build compiles the Solana runtime and takes several minutes. A default run then takes
about 8 seconds and makes about 4,000 operations.

A failure prints the seed, the case, the step, what the model expected, what happened (with the
program logs) and the operations that led there. `FUZZ_SEED=<seed>` reproduces it exactly.

## What a case does

Setup: a mint with Vigilantis as its transfer hook, five wallets with token accounts and random
balances. The mint's freeze authority is Vigilantis's freeze address in most cases, the issuer in
some, and nobody in a few. Its permanent delegate is Vigilantis's address, the issuer or nobody,
and it is Pausable (with Vigilantis's pause address or the issuer as pause authority) or not. Most cases then create the policy (random rules) and the meta list;
some start without one or both, and some have a stranger fund the policy or meta-list address
first. A second mint provides a token account that is not the first mint's.

Then random operations, each picked from:

- every Vigilantis instruction, signed by the current authority, the issuer, a pending authority, a
  random wallet, or an address nobody holds a key for;
- blocks and unblocks with a reason (`block_wallet`, `unblock_wallet`) as well as without;
- freezes and thaws with random reason codes and case references, mostly of the mint's token
  accounts, sometimes of the other mint's account, the policy account or the mint itself, and
  sometimes of an account already in that state;
- whoever holds the mint's freeze authority (or someone else) handing it to Vigilantis, and Vigilantis
  handing it on with `set_freeze_authority` (2.3): to the issuer, a wallet, an address nobody
  holds, or nobody at all, and to the addresses it must refuse (its own and the default address);
- public transfers through Token-2022, by the owner or a delegate, including self-transfers,
  zero amounts, amounts at and above the limit, and more than the balance;
- approvals of delegates, which a frozen account refuses;
- `Execute` sent straight to the hook with the accounts Token-2022 would pass, with a public
  amount or `u64::MAX` (what Token-2022 passes for a confidential transfer), and with made-up
  accounts. Since 1.0.0-rc.1 the hook refuses every such call (`NotInTransfer`) before any rule
  runs, so the model expects that, and the rules themselves are checked through real transfers;
- strangers funding the policy or meta-list address before it exists;
- (1.0) roles granted, changed, revoked and renounced, with random permissions (including none and
  unknown bits), for a wallet or the issuer; every gated instruction signed by a role holder with
  or without the right permission, with its own role entry, someone else's, or none;
- (1.0) pauses and resumes, and the pause authority handed on by Vigilantis or handed to it;
- (1.0) seizures, mostly of frozen accounts, with a case reference that is new, already used or
  all zeros, and their closing with a random outcome;
- (1.0) the clock moved forward by one hour, 12 hours, one second short of 24 hours, exactly 24
  hours or about 28 hours.

## What is checked after every step

- **The outcome.** The model predicts success or failure, and for each Vigilantis rule the exact
  error code (`RecipientNotAllowlisted`, `TransferExceedsLimit`, `SenderBlocked`,
  `RecipientBlocked`, `Unauthorized`, `ConfidentialAmountNotEnforceable`, `AuthorityBlocked`,
  `InvalidAuthority`, `FreezeAuthorityNotVigilantis`, and in 1.0 `InvalidPermissions`,
  `PauseAuthorityNotVigilantis`, `PermanentDelegateNotVigilantis`, `AccountNotFrozen`,
  `NothingToSeize`, `SeizeTooEarly`, `InvalidCaseRef`, `InvalidTokenAccount`), in the order the
  program checks them; Anchor's own codes where an account fails to load or a constraint fails
  first; and Token-2022's `AccountFrozen`, `InvalidState` and `MintPaused` where those come first.
- **The whole state.** The policy (mint, authority, rules), every allow and block entry, a pending
  handover, every balance, delegation and frozen flag, the mint's freeze authority, the meta list's
  bytes (which only `initialize` and `update_extra_account_meta_list` may change), the total
  supply, and in 1.0 every role entry, the pause state and pause authority, every freeze record
  and every open seizure.
- **The record.** Every `EnforcementAction` and `FreezeAuthorityChanged` event a successful step
  emitted, decoded from its logs and compared field by field with what the model expects; a step
  that should emit none must emit none.

The model is the threat model's invariants written as code (`docs/threat-model.md`): fail closed,
only the policy authority changes the rules, only the mint authority sets up and nobody can block
that, a handover needs both sides, blocklist, allowlist, limit and confidential amounts, entries
cannot be forged, the hook holds no state, only the policy authority (or a role allowed to) freezes
and only through the mint's own freeze address, enforcement is recorded, a role does exactly what
it says, pause goes only through the mint's own pause address, and a seizure is slow, complete and
recorded.

It also models the Token-2022 behaviour that decides outcomes here: a frozen source is refused
first; a transfer whose source and destination are the same account then returns before the hook
is called (a frozen account still refuses it); a frozen destination is refused after that. A
paused mint refuses every transfer, after the frozen-source and balance checks and before the
authority check; and a permanent delegate may transfer from any account, without touching the
account's own delegation.

## Does it catch bugs?

It found finding 8 of the threat model on the 2.1.0 build: a stranger funding a mint's meta-list
address first blocked the mint's setup for good.

`mutants.py` breaks the program on purpose, one small change at a time (a dropped authority check,
a rule switched off, an off-by-one), builds each broken program and runs these tests against it:

```bash
python3 tests-fuzz/mutants.py          # from the repository root; about 10 s per mutant
```

With 256 cases (`FUZZ_CASES=256`, 29 October 2026), all 70 are caught:

| Mutant | What it breaks | Result |
|---|---|---|
| `limit-off-by-one` | the limit refuses a transfer equal to it | caught |
| `limit-ignored` | the limit is never checked | caught |
| `confidential-limit-ignored` | confidential transfers pass a limited mint without `allow_confidential` | caught |
| `sender-blocklist-off` | a blocklisted sender is not refused | caught |
| `recipient-blocklist-off` | a blocklisted recipient is not refused | caught |
| `authority-blocklist-off` | a blocklisted delegate is not refused | caught |
| `blocklist-flag-ignored` | the blocklist applies while switched off | caught |
| `allowlist-off` | the allowlist is never checked | caught |
| `any-block-entry-blocks` | any block entry passed as the authority's blocks the transfer | caught |
| `rules-in-wrong-order` | sender and recipient checks swapped (wrong error code) | caught |
| `update-policy-anyone` | anyone can change the rules | caught |
| `add-allow-anyone` | anyone can allowlist | caught |
| `remove-allow-anyone` | anyone can remove an allow entry | caught |
| `add-block-anyone` | anyone can blocklist | caught |
| `remove-block-anyone` | anyone can remove a block entry | caught |
| `update-meta-list-anyone` | anyone can rewrite the meta list | caught |
| `propose-anyone` | anyone can propose a new authority | caught |
| `cancel-anyone` | anyone can cancel a handover | caught |
| `accept-anyone` | anyone can accept a handover | caught |
| `accept-wrong-rent-receiver` | the proposal's rent can go to someone other than the old authority | caught |
| `propose-to-self` | the authority can propose itself | caught |
| `init-policy-anyone` | anyone can create the policy | caught |
| `init-meta-list-anyone` | anyone can create the meta list | caught |
| `update-policy-keeps-flag` | `update_policy` forgets to store the blocklist flag | caught |
| `accept-keeps-old-authority` | `accept_authority` does not change the authority | caught |
| `funded-address-blocks-setup` | the 2.1.0 bug: a funded meta-list address blocks setup | caught |
| `freeze-anyone` | anyone can freeze and thaw | caught |
| `freeze-authority-check-off` | Vigilantis tries to freeze on a mint whose freeze authority is not its address (wrong error) | caught |
| `thaw-freezes` | `thaw_token_account` freezes | caught |
| `freeze-recorded-as-thaw` | a freeze is recorded as a thaw | caught |
| `unblock-recorded-as-block` | an unblock is recorded as a block | caught |
| `block-reason-dropped` | `block_wallet` records reason code 0 instead of the issuer's | caught |
| `freeze-case-ref-dropped` | a freeze or thaw records an empty case reference | caught |
| `freeze-event-wrong-wallet` | a freeze names the signer instead of the account's owner | caught |
| `freeze-event-wrong-account` | a freeze names the mint instead of the token account | caught |
| `set-freeze-authority-anyone` | anyone can move the freeze authority away from Vigilantis | caught |
| `set-freeze-authority-check-off` | Vigilantis tries to move a freeze authority it does not hold (wrong error) | caught |
| `freeze-authority-to-vigilantis-allowed` | handing the freeze authority to Vigilantis's own address is accepted | caught |
| `freeze-authority-change-recorded-wrong` | the record says the freeze authority was given up when it was handed on | caught |
| `block-wallet-anyone` | anyone can block a wallet with a reason | caught |
| `unblock-wallet-anyone` | anyone can unblock a wallet with a reason | caught |
| `thaw-anyone` | anyone can thaw | caught |
| `role-of-anyone` | a role entry works for any signer, not only its holder | caught |
| `role-of-any-mint` | a role entry of another mint works on this one | caught |
| `role-any-permission` | a role with any permission can do every gated action | caught |
| `thaw-with-freeze-permission` | FREEZE is enough to thaw | caught |
| `unblock-with-block-permission` | BLOCK is enough to unblock | caught |
| `grant-role-anyone` | anyone can grant a role | caught |
| `update-role-anyone` | anyone can change a role | caught |
| `revoke-role-anyone` | anyone can revoke a role | caught |
| `role-permissions-unchecked` | a role with no permissions or unknown bits is accepted | caught |
| `update-role-keeps-permissions` | `update_role` does not store the new permissions | caught |
| `pause-anyone` | anyone can pause and resume | caught |
| `resume-with-pause-permission` | PAUSE is enough to resume | caught |
| `resume-pauses` | `resume` pauses | caught |
| `pause-authority-check-off` | Vigilantis tries to move a pause authority it does not hold (wrong error) | caught |
| `set-pause-authority-anyone` | anyone can move the pause authority away from Vigilantis | caught |
| `pause-authority-to-vigilantis-allowed` | handing the pause authority to Vigilantis's own address is accepted | caught |
| `pause-recorded-as-resume` | a pause is recorded as a resume | caught |
| `seize-anyone` | anyone can seize | caught |
| `seize-delay-off` | no 24-hour wait before a seizure | caught |
| `seize-delay-off-by-one` | a seizure at exactly 24 hours is refused | caught |
| `seize-without-case-ref` | a seizure with an all-zero case reference is accepted | caught |
| `seize-delegate-check-off` | Vigilantis tries to seize on a mint whose permanent delegate is not its address (wrong error) | caught |
| `seize-burns-one-less` | a seizure leaves one base unit behind | caught |
| `seize-not-refrozen` | the account is left thawed after a seizure | caught |
| `seize-recorded-as-freeze` | a seizure is recorded as a freeze | caught |
| `freeze-record-not-written` | a freeze writes no freeze record | caught |
| `thaw-keeps-freeze-record` | a thaw keeps the freeze record, so a new freeze can be seized at once | caught |
| `close-seizure-anyone` | anyone can close a seizure | caught |

A mutant that survives points to a gap in the model or in what the generator tries.
`accept-wrong-rent-receiver` survived the first run, because the generator rarely named a wrong
rent receiver when accepting a handover; it now does so more often. When 2.2 added freezes and
thaws, the new operations made two rare paths rarer, and `accept-wrong-rent-receiver` and
`any-block-entry-blocks` survived again. The generator now accepts a pending handover more often,
starts some cases with one already proposed, and passes a blocklisted wallet's entry as the fifth
account of a direct `Execute` more often. (Those runs predate 1.0.0-rc.1, where a direct `Execute`
is refused before any rule runs; Token-2022 resolves the fifth account itself in a real transfer.)

The 1.0 mutants found four gaps of the same kind. `role-of-any-mint` survived because the model never
passed a real role entry of another mint; each case now sets up a second mint with a policy and a
role for wallet 0 holding every permission, and gated actions sometimes pass that entry.
`unblock-with-block-permission`, `revoke-role-anyone` and `seize-delay-off-by-one` were caught in
some runs and not in others. The generator now has role holders try list changes more often, has
someone other than the admin try half the revocations, and moves the clock to the exact second a
frozen account becomes seizable, then tries to seize it.

## Coverage

`coverage.sh` builds the program unoptimized with debug information, runs the fuzz tests with
LiteSVM recording every instruction Vigilantis executes, and maps the trace back to source lines with
[sbpf-coverage](https://github.com/LimeChain/sbpf-coverage) (a separate tool, installed with
`cargo install sbpf-coverage --version 0.2.12 --locked`). Traces are large, about 1.5 GB per 8
cases, so it runs in chunks and keeps only the coverage files.

```bash
bash tests-fuzz/coverage.sh       # from the repository root; about 10 minutes
```

On 29 October 2026 (48 cases, 1.0 in development): **986 of the 1,025 lines of `lib.rs` that carry
code were executed (96.2%).** On 16 October (2.3.0) it was 524 of 543. The other 39:

| Lines | What | Why not here |
|---|---|---|
| 264–278 | `update_extra_account_meta_list` growing a list made before 2.1 | Every list made by 2.1 or later already has its full size, so under Vigilantis's own program ID no list needs to grow. Sentinel's upgrade check (a 2.0.2 mint upgraded and migrated on a local validator) ran it until 1.0.0-rc.1; a test comes back with the first change to the list's layout. |
| 539 | `set_pause_authority` giving the pause authority up (`None`) | Generated, but rare: it needs a Pausable mint whose pause authority is Vigilantis's address and the admin signing. `enforcement.rs` tests it. |
| 598–604 | `seize` refusing a token account of another mint, or one that is not frozen | Both need a freeze record for that account. Vigilantis writes one only when it freezes an account of the mint and deletes it on a thaw, so only a thaw outside Vigilantis leaves one behind. `enforcement.rs` tests the thawed account. |
| 646, 658, 667 | the `?` after the thaw, burn and freeze in `seize` | The checks before them make Token-2022 accept all three. |
| 747–749 | `grant_role` refusing the default address | The generator never names the default address as a holder. `enforcement.rs` tests it. |
| 846 | the `?` after the `SetAuthority` call in `set_freeze_authority` | The mint's constraint already ensures that Vigilantis's address is the freeze authority, so Token-2022 accepts the call. |
| 986, 999 | the `?` after the System transfer and `allocate` in `create_program_account` | The transfer fails only if the payer cannot pay. A failing `allocate` does run (a second meta list), but the debug information does not attribute its exit to this line. |
| 1106–1112 | `write_freeze_record` overwriting a record | Only an account thawed outside Vigilantis and frozen again has a record when it is frozen. `enforcement.rs` tests it. |
| 1227, 1236, 1243 | `mint_extension` returning `None` on a malformed extension list | Token-2022 only writes well-formed mints, and Vigilantis checks the mint's owner. |
| 1284, 1297, 1317, 1330 | the `?` after `ExtraAccountMeta::new_with_seeds` | The seeds are constants; these calls cannot fail. |
| 1386 | `false` when an account's data cannot be borrowed | Nothing else holds the account inside the hook. |

Line coverage counts lines, not paths; the fuzz tests' value is in the model they check against.
