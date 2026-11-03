# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The on-chain program and the
`@softseco/vigilantis` SDK are versioned together. Until 28 Oct 2026 the project was Sentinel
(`@softseco/sentinel`, up to 2.3.0); that history is kept below, under Sentinel's version numbers.

## [1.0.0-rc.1] - 2026-11-03

The release candidate for an independent audit, and the enforcement functions an issuer of a regulated token
needs: roles, a token-wide pause and seizure under a court order. A mint with no role entries, no
Pausable extension and no permanent delegate behaves as before, except for the two new checks in the
transfer hook under Security: token accounts must have an owner that cannot change, as associated
token accounts do, and the hook runs only inside a Token-2022 transfer.

### Added
- **Roles.** The policy authority (the admin) can give other addresses a `RoleEntry`
  (`["role", mint, holder]`) holding any of nine permissions: allowlist, block, unblock, freeze,
  thaw, pause, resume, seize, close seizure. A role holder can do exactly those actions; the admin
  can still do all of them. New instructions `grant_role`, `update_role`, `revoke_role` (the admin)
  and `renounce_role` (the holder). Every gated instruction takes the signer's role entry as an
  optional last account and checks it by content (holder, mint, permission bits). Only the admin
  manages roles, the policy, the meta list and the authorities. `RoleChanged` event.
- **Pause.** For a mint with Token-2022's Pausable extension whose pause authority is Vigilantis's
  `["pause-authority", mint]` address: `pause` stops every transfer, mint and burn of the token,
  confidential ones included, until `resume`; freezing and thawing still work. `set_pause_authority`
  (the admin) hands the pause authority to another address or gives it up, with a
  `PauseAuthorityChanged` event. The calls to Token-2022 are built by hand, because the
  `spl-token-2022` crate Anchor 0.31 uses (6.0) predates Pausable; Vigilantis also reads the mint's
  extensions directly for the same reason.
- **Seizure.** For a mint whose permanent delegate is Vigilantis's `["permanent-delegate", mint]`
  address: `seize` burns the whole public balance of a token account that Vigilantis froze at least
  24 hours earlier (`SEIZE_DELAY_SECONDS`, the same for everyone, the admin included), and leaves it
  frozen. In one instruction it thaws the account, burns as the permanent delegate and freezes it
  again; Vigilantis never moves value to anyone. A `SeizureRecord`
  (`["seizure", mint, token_account, case_ref]`) stays open until `close_seizure` records the
  outcome. A case reference is required. A confidential balance cannot be seized, only frozen.
  `Seized` and `SeizureClosed` events, and `EnforcementAction` kinds `Pause`, `Resume`, `Seize` and
  `CloseSeizure` (appended, so the earlier values keep their numbers).
- **Freeze records.** `freeze_token_account` writes a `FreezeRecord`
  (`["freeze-record", mint, token_account]`) with the time of the freeze, which `seize` needs;
  `thaw_token_account` deletes it. An account frozen before 1.0 has none and must be thawed and
  frozen again before it can be seized.
- **Errors** 6009 `InvalidPermissions`, 6010 `PauseAuthorityNotVigilantis`, 6011
  `PermanentDelegateNotVigilantis`, 6012 `AccountNotFrozen`, 6013 `NothingToSeize`, 6014
  `SeizeTooEarly`, 6015 `InvalidCaseRef`, 6016 `InvalidTokenAccount`.
- **SDK:** `grantRole`, `updateRole`, `revokeRole`, `renounceRole`, `getRole`, `listRoles`;
  `pause`, `resume`, `setPauseAuthority`, `setVigilantisAsPauseAuthority`, `getPauseState`;
  `seize`, `closeSeizure`, `getFreezeRecord`, `getSeizure`, `listSeizures`; builders for each;
  `createCompliantMint({ pausable, permanentDelegate })`; `PERMISSIONS`, `SEIZE_DELAY_SECONDS`.
- **Tests:** `tests/roles-pause.ts` (8 on a local validator);
  `tests-fuzz/tests/enforcement.rs` (11 in LiteSVM, which can move the clock 24 hours for a
  seizure); the fuzz model now covers roles, pause, seizure and the clock, and checks every role
  entry, the pause state, every freeze record and open seizure, and the mint's supply after every
  step. `tests-fuzz/mutants.py` has 70 planted bugs, 31 of them in the new functions.
- **security.txt in the program** (`solana-security-txt`): name, contacts (GitHub private
  vulnerability reporting, hello@softseco.com), the policy, the source and its release, and the
  audit status ("self-audited, not independently audited"). Explorers and `query-security-txt` read
  it from the deployed program. `scripts/check-security-txt.sh` prints it from a build and checks it
  against the crate version and `SECURITY.md`; CI runs it after every build.
- **`docs/audit-scope.md`**: what an auditor reads (the one program file and its dependencies),
  what is out of scope, the instructions, accounts, events, errors and calls on one page, how to
  build and run every test, and the planned mainnet set-up.
- **`tests/costs.ts`** (3 tests, 66 in all): compute units and transaction size of a public, a
  delegated and a confidential transfer with every rule on. Sentinel uses 7,335–7,865 CU of a
  transfer, plus 1,500 CU for every extra bump `find_program_address` tries for the mint's meta
  list (none for about half of all mints); a public transfer is 478–510 bytes and the confidential
  one 792 of the 1232 allowed. The tests fail if the fixed part goes above 16,000 CU, or if a
  public transfer leaves less than the 54 bytes a wallet needs for priority-fee instructions.
- **Upgrade from 2.1.x** (`tests-upgrade/upgrade-from-2.1.ts`, `scripts/upgrade-check.sh v2.1.0`):
  a mint set up by 2.1.0, the release on devnet, with a blocklisted delegate and an authority
  handover still pending, keeps working after an in-place upgrade; its meta list needs no change;
  blocking with a reason works on it, and freezing does once its freeze authority is handed to
  Sentinel; the handover proposed under 2.1 completes. `upgrade-check.sh` now picks the test for
  the release series it starts from, and CI runs it from 2.0.2 and from 2.1.0.
- **Tests against the Token-2022 on mainnet** (`scripts/mainnet-token-2022.sh`, workflow
  `mainnet Token-2022`, Mondays): dumps the deployed Token-2022, prints its release and hash, and
  runs the integration and fuzz tests with it instead of the pinned v11.1.0 build. The RPC URL is
  never printed, so one with an API key stays out of the logs.
- **`vigilantis` command line** in `@softseco/vigilantis` (`sdk/src/cli.ts`, the package's `bin`):
  `status`, `check`, the policy and meta list, the lists, freeze and thaw (one token account, or
  every account of a wallet), pause and resume, seize and close a seizure, roles, the authority
  handover, and handing the freeze and pause authorities on. Reasons, permissions and outcomes by
  name; `--case` hashed with a salt from `VIGILANTIS_CASE_SALT` or a file, never from the command
  line. `--multisig <vault>` sends nothing and prints each transaction, signed by the vault, in
  base58 for Squads to import, at most 900 bytes each. The RPC and the keypair come from the Solana
  CLI config unless given; an RPC URL is never printed. `--json` for scripts; exit codes 0, 1
  (failed, with the program's error name when it refused) and 2 (a mistake in the command line). `tests/cli.ts`: 16 tests on a local validator, 91
  in all, the multisig exports among them, signed and sent the way a multisig would.
- **Verified build** (`.github/workflows/verified-build.yml`): `solana-verify build` in the Solana
  Foundation's Docker image, on every tag, on pushes that touch the program and by hand. It checks
  the security.txt and, on a tag, the tag against the crate version, and prints the executable hash
  to compare with the deployed program. `[workspace.metadata.cli] solana = "4.2.2"` in `Cargo.toml`
  makes solana-verify use the Agave release CI uses; it would otherwise take the older
  `solana-program` version from `Cargo.lock`.
- **`docs/deployment.md`**: the deployment plan and runbook. Who holds which key, the Squads
  multisig, the verified build, the first deployment with a new program ID, upgrades from a buffer,
  setting up a mint for an issuer with roles, the emergency procedures, and a checklist before
  mainnet.

### Security
Fixes from a second review of our own before this release; findings 9–14 in the
[threat model](./docs/threat-model.md).
- **Token accounts must have an owner that cannot change** (`OwnerCanChange`, 6018). The hook takes
  the parties from the owner fields of the token accounts, and Token-2022's `SetAuthority` on the
  account owner does not call the hook, so a holder could hand a whole account, with its balance, to
  a wallet the allowlist, the limit or the blocklist would refuse. The hook now refuses any transfer
  whose source or destination lacks the ImmutableOwner extension. Associated token accounts have
  it; a program's vault account must be created with `InitializeImmutableOwner`.
- **The hook runs only inside a Token-2022 transfer** (`NotInTransfer`, 6017): both token accounts
  must be Token-2022 accounts of the mint and the source must carry Token-2022's `transferring`
  flag. A direct call is refused before any rule is evaluated and without an event; before, it
  could leave a `TransferRefused` naming any wallet in the logs.
- **A handover of the policy ends every role.** `PolicyConfig` has a `role_epoch` and `RoleEntry`
  an `epoch` (4 bytes each, at the end); `accept_authority` raises the policy's, and a role works
  only while the two match. `update_role` brings a role back. Before, an outgoing admin could grant
  itself every permission and keep it after the handover.
- **`set_pause_authority` refuses while the mint is paused** (`PausedMintHandover`, 6019), which
  could have left it paused for good, and both `set_pause_authority` and `set_freeze_authority`
  refuse the six addresses Vigilantis derives from the mint alone, none of which can sign for anyone else
  (`InvalidAuthority`).
- **SDK and command line:** freezing a wallet with seven or eight token accounts built a
  transaction over the 1,232-byte limit and failed with nothing done. Instructions are now packed by
  size as well as by count (`packInstructions`, `transactionSize`, `MAX_TRANSACTION_BYTES`).
- **SDK:** `createCompliantMint` takes `transferHookAuthority`, the key that can point the mint at
  another hook or none and so switch every rule off; it was always the creator's key, and nothing
  showed it. `vigilantis status` now shows it.
- **Command line:** a keypair file that is not JSON is reported without quoting its contents; a case
  number is normalised (Unicode NFC, no surrounding spaces) and an empty `--case` is refused; a salt
  file loses all surrounding whitespace and a byte-order mark, so it hashes like the same salt in
  `VIGILANTIS_CASE_SALT`; a salt under 16 bytes gets a warning; `block add` and `allow add` refuse a
  token account's address and name its owner; when one of several transactions fails, the ones that
  went through are listed; an error without a message shows its name.

### Changed
- `RoleView` has `epoch` and `active`; `vigilantis role list` and `vigilantis status` mark inactive
  roles. `isVigilantisAddress(mint, address)` is new.
- Tests: the second token accounts in `enforcement.ts` and `cli.ts`, and every account in the fuzz
  tests, carry ImmutableOwner. Four tests that called the hook directly to check confidential
  amounts now check that a direct call is refused; `confidential.ts` covers those rules with real
  confidential transfers. New tests for accounts whose owner can change, for the pause authority
  while paused, for Vigilantis's own addresses as new authorities, and for roles across a handover;
  the fuzz model follows the role epoch and the paused handover.
- Licence: the Business Source License 1.1 ([LICENSE](./LICENSE), in plain words
  [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md)) instead of all rights reserved. Testing and
  development are free for everyone, and so is using the Vigilantis program Softseco deploys,
  whatever the user's size. Any other production use, such as deploying an own copy of the
  program, needs a commercial license from Softseco (developers@softseco.com). Each version
  becomes Apache-2.0 four years after its release (Change Date 2030-11-03 for this one). `sdk/LICENSE` and `sdk/NOTICE`, which still
  carried the Apache-2.0 text of the public repository, now carry the same licence.
- **Who may act is checked in the instruction, not in the accounts.** The list, block, freeze and
  thaw instructions used `has_one = authority` on the policy; they now accept the admin or a role
  holder, so the check moved into the instruction. A signer that is neither still gets
  `Unauthorized` (6004), but after the other account checks rather than before them, and the
  message now says "neither the policy authority nor a role holder with this permission".
- **`freeze_token_account` and `thaw_token_account` take three more accounts:** the freeze record
  (writable), the System program, and the optional role entry. The signer is now writable, because
  a freeze pays the freeze record's rent and a thaw gets it back. The SDK passes them.
- **SDK:** the instruction builders of gated actions are `async` where they were not
  (`listInstruction`) and look up whether the signer holds a role, passing its entry if it does.
  `@solana/spl-token` 0.4.13 or later is needed, for Pausable.
- **New name.** The program is `vigilantis` (crate, IDL, `programs/vigilantis`, `vigilantis.so`)
  and the SDK is `@softseco/vigilantis`: `SentinelClient` is now `VigilantisClient`,
  `SentinelEvent` `VigilantisEvent`, `setSentinelAsFreezeAuthority`
  `setVigilantisAsFreezeAuthority`, and `createCompliantMint({ freezeAuthority: "sentinel" })` takes
  `"vigilantis"`. The error enum is `VigilantisError`, and 6008 is `FreezeAuthorityNotVigilantis`;
  the codes do not change. PDA seeds, accounts, instructions and events are unchanged, so
  addresses differ only by the program ID.
- **Versions start again at 1.0.0.** Sentinel up to 2.3.0 stays published under Apache-2.0.
- **Vigilantis's own program ID: `4DoDFZJmJWYuBx86UqXi3y24GkQ3Cq4nUBHZwDE5PQM5`.** It replaces
  Sentinel's in `declare_id!`, `Anchor.toml` (localnet, and devnet where it is deployed after this
  release), the IDL the SDK uses, the fuzz tests and the mainnet Token-2022 script. Sentinel 2.1.0
  keeps running on devnet at `5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD` and is never upgraded
  to Vigilantis.
- `@softseco/vigilantis` is no longer marked private in `sdk/package.json`, for this release.
- `docs/deployment.md`: the program ID done for devnet; the keypair commands with `--silent`, and
  keypair paths through two variables, with a link for a path that contains a space, which the
  Solana CLI cannot read.
- `tests-fuzz/README.md`: the uncovered lines it lists moved by 15 lines with the security.txt
  block; the coverage itself is unchanged.
- The docs name the confidential-transfer SDK Arcantis (`@softseco/arcantis`), published until now
  as `@softseco/confidential-transfers`. The confidential tests still use the published
  `@softseco/confidential-transfers` 3.x until Arcantis is on npm.

### Removed
- The upgrade checks from Sentinel 2.0.2 and 2.1.0 (`scripts/upgrade-check.sh`, `tests-upgrade/`
  and their CI job). They upgraded Sentinel's deployment in place at its program ID, which
  Vigilantis, with an ID of its own, never does. A check of the upgrade from Vigilantis's previous
  release comes with its first upgrade.

## [2.3.0] - 2026-10-16

The freeze authority can leave Sentinel again. In 2.2, handing a mint's freeze authority to
Sentinel was one-way: only a program upgrade could move it. No breaking changes: accounts, existing
instructions, error codes and events are unchanged, and the SDK only gains methods. The devnet
program stays at 2.1.0 for now.

### Added
- `set_freeze_authority(new_freeze_authority, reason_code, case_ref)`: the policy authority hands
  the mint's freeze authority from Sentinel's address to another address (for example a newer
  compliance program or the issuer's own multisig), or gives it up for good with `None`. It works
  only while Sentinel holds the freeze authority (`FreezeAuthorityNotSentinel`, 6008, otherwise).
  It refuses Sentinel's own address and the default address (`InvalidAuthority`, 6007). Afterwards
  only the new holder can freeze, thaw, or hand the authority back to Sentinel.
- `FreezeAuthorityChanged` event: the mint, the new freeze authority (or none), the reason code,
  the case reference and the authority that signed.
- SDK: `setFreezeAuthority(mint, newFreezeAuthority | null, why)`,
  `setFreezeAuthorityInstruction` (for a multisig authority; it refuses Sentinel's own address and
  the default address before sending) and `getFreezeAuthority(mint)`.
- Tests: four in `tests/enforcement.ts` (only the policy authority, hand on and back with the reason
  recorded, give up for good, refused addresses and mints Sentinel does not hold); 63 in all. The
  fuzz model treats the freeze authority as any address, adds `set_freeze_authority` and decodes
  `FreezeAuthorityChanged`; `tests-fuzz/mutants.py` has 4 new mutants, and the fuzz tests catch
  all 39. Line coverage of the program under fuzzing: 524 of 543 lines with code (96.5%).
- `tests/0-validator-hiccups.ts`: the integration tests retry a transaction whose preflight fails
  with "Blockhash not found". A local validator on a busy machine can stall for a few seconds, and
  that error then failed a test that had nothing wrong with it (seen once in WSL). A transaction
  that fails preflight is never sent, so the retry cannot run anything twice.

### Changed
- Threat model: invariants 10 and 11 cover `set_freeze_authority`; the "one-way" known limit is
  replaced by "handing the freeze authority on is final for Sentinel" (a mistyped address loses the
  freeze power).

## [2.2.0] - 2026-10-15

Freezing through Sentinel, and an on-chain record of why. A transfer hook can only refuse
transfers; burns, approvals and the confidential deposit and withdraw never reach it. A frozen
token account refuses all of them. No breaking changes: accounts, existing instructions, existing
error codes and existing events are unchanged, and the SDK only gains methods. The devnet program
stays at 2.1.0 for now.

### Added
- `freeze_token_account` and `thaw_token_account`: the policy authority freezes or thaws one token
  account of the mint. Sentinel signs as the mint's freeze authority with its freeze-authority
  address for the mint (`["freeze-authority", mint]`), so this works only on a mint whose freeze
  authority is that address; any other mint gets `FreezeAuthorityNotSentinel` (6008). Token-2022
  checks the rest (the account belongs to the mint and is not already frozen, or thawed).
- `block_wallet` and `unblock_wallet`: `add_to_blocklist` and `remove_from_blocklist` that also
  record why.
- `EnforcementAction` event, emitted by the four instructions above: the mint, the wallet, the
  token account (for a freeze or thaw), the action, the issuer's `reason_code` (a `u16`), a 32-byte
  `case_ref`, and the authority that signed. Sentinel does not interpret either; `case_ref` is meant
  for a salted hash of the issuer's case number, so no personal data goes on-chain.
- Error `FreezeAuthorityNotSentinel` (6008), appended.
- SDK: `createCompliantMint({ freezeAuthority: "sentinel" | PublicKey | null })` (default `null`,
  as before), `freezeAuthority(mint)`, `setSentinelAsFreezeAuthority`, `blockWallet`,
  `unblockWallet`, `freezeTokenAccount`, `thawTokenAccount`, `freezeWallet` and `thawWallet` (every
  token account the wallet holds, eight per transaction), `blockAndFreezeWallet` (the block and the
  first freezes in one transaction), `tokenAccountsOf`, `isFrozen`, the builders
  `blockWalletInstruction`, `unblockWalletInstruction` and `freezeInstruction`,
  `ENFORCEMENT_REASONS` (a suggested list of reason codes) and `caseRef(caseId, salt)`. New
  dependency: `@noble/hashes`.
- Tests: `tests/enforcement.ts` (11: reasons on block and unblock, freezing a whole wallet, what a
  frozen account can no longer do, who may freeze, freezing a frozen account, thawing, block and
  freeze in one transaction, a mint whose freeze authority is the issuer before and after handing
  it to Sentinel, a mint without one, input checks), and a confidential transfer to a frozen account
  in `tests/confidential.ts`. The suite is 59 tests. The fuzz model covers freezes, thaws, the
  hand-over, frozen accounts in transfers and approvals, and every `EnforcementAction`, field by
  field. `tests-fuzz/mutants.py` has 9 new mutants; the fuzz tests catch all 35. Line coverage of
  the program under fuzzing: 487 of 505 lines with code (96.4%), every line added in 2.2 among
  them.
- Threat model: invariants 10 and 11, the freeze authority among the trusted actors, and four
  known limits (a freeze authority must be chosen when the mint is created; handing it to Sentinel
  is one-way; a freeze covers the accounts that exist; reasons are not interpreted).

## [2.1.1] - 2026-10-14

A fix found while preparing for an independent audit, and the tests that come with that work. No
breaking changes and no new instructions: accounts, instructions, error codes and the IDL are the
same as in 2.1.0. The SDK has no code changes; its version moves with the program's. The devnet
program stays at 2.1.0 for now; the mints there are already set up, so the fix does not affect
them.

### Fixed
- **A stranger could block a mint's setup for good.** `initialize_extra_account_meta_list` created
  the meta list with System `CreateAccount`, which refuses an address that already holds lamports,
  and anyone can send lamports to any address. Sending about 0.0009 SOL to a mint's meta-list
  address before the issuer created the list made the list impossible to create, and every
  transfer of the mint then failed. The list is now created the way Anchor's `init` creates
  accounts: when the address already holds lamports, the issuer tops up the rent and the program
  allocates and assigns the account. A second `initialize_extra_account_meta_list` for the same
  mint still fails. The policy account was never affected (Anchor's `init` handles it). On 2.1.0,
  creating the meta list in the same transaction as the mint avoids the problem. Found in our own
  review.

### Added
- `tests/setup.ts`: setup with the policy and meta-list addresses funded by a stranger first (less
  and more than the rent), and a second meta list refused. The suite is 47 tests.
- `tests-fuzz/`: model-based fuzzing in LiteSVM, next to the same Token-2022 v11.1 build the
  integration tests use. Random sequences of every instruction (signed by the right authority or
  by someone else), public transfers by owners and delegates, approvals, direct calls to the hook
  (public amounts, `u64::MAX`, made-up accounts) and funded addresses; a Rust model of the rules
  predicts every outcome, down to the error code, and the whole state is compared with the model
  after every step. It finds the bug above on the 2.1.0 build. CI runs a new random set of 256
  cases on every push.
- Threat model: finding 8, two known limits (a self-transfer never reaches the hook; setup needs a
  mint authority that can sign), and how the invariants are tested.

## [2.1.0] - 2026-10-12

Deployed on devnet on 12 October 2026: the program at `5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD`
was upgraded in place, and the meta list of the PAPER showcase mint was updated. No breaking
changes: `PolicyConfig`, the entry accounts, every existing instruction and every existing error
code are unchanged.

### Fixed
- **A blocklisted wallet could move tokens as a delegate.** The blocklist checked the owners of
  the source and destination accounts, not the authority signing the transfer. A blocked wallet
  that a clean holder had approved as delegate (or a blocked permanent delegate) could send that
  holder's tokens to any clean wallet. The hook now also refuses when the transfer authority is
  blocklisted (`AuthorityBlocked`, 6006). Found in our own review, on devnet, before any mainnet
  use.

### Added
- `update_extra_account_meta_list`: rewrites a mint's `ExtraAccountMetaList` to the current list
  and grows the account if needed (the policy authority signs and pays the extra rent). The list
  gains a fifth entry, the transfer authority's blocklist entry.
- Two-step handover of the policy authority: `propose_authority`, `accept_authority` (signed by
  the new authority) and `cancel_authority_transfer`. The proposal lives in its own PDA
  (`["pending-authority", mint]`), so nothing changes until the new authority signs, and a
  mistyped address cannot lock a policy. The authority can be a multisig vault such as Squads.
- Events for every policy change and every refusal: `PolicyInitialized`, `PolicyUpdated`,
  `ListEntryAdded`, `ListEntryRemoved`, `MetaListUpdated`, `AuthorityTransferProposed`,
  `AuthorityTransferCancelled`, `AuthorityTransferred`, and `TransferRefused` (mint, both owners,
  the transfer authority, whether the transfer was confidential, and the error code). A refusal
  fails the transaction, but its logs, and the event in them, stay readable.
- Errors `AuthorityBlocked` (6006) and `InvalidAuthority` (6007), appended.
- SDK: instruction builders for every authority-gated instruction with the authority as a
  parameter (`updatePolicyInstruction`, `listInstruction`, `proposeAuthorityInstruction`,
  `acceptAuthorityInstruction`, `cancelAuthorityTransferInstruction`,
  `updateExtraAccountMetaListInstruction`), for authorities that sign elsewhere, such as a
  multisig. `proposeAuthority`, `acceptAuthority`, `cancelAuthorityTransfer`,
  `getPendingAuthority` and `updateExtraAccountMetaList`. Batch list updates
  (`addToAllowlistBatch`, `addToBlocklistBatch` and the `remove` pair), eight changes per
  transaction. `parseEvents` and `getEvents` decode the events above, including from a failed
  transaction's logs. `pendingAuthorityPda`.
- Integration tests with real Token-2022 confidential transfers (`tests/confidential.ts`). The
  sender's proofs go through the ZK ElGamal Proof Program and Token-2022 calls Sentinel as the
  hook, so the rules are checked on the path a real confidential transfer takes: the limit refuses
  confidential transfers until the issuer sets `allow_confidential`, the blocklist stops a blocked
  sender or recipient, the allowlist applies, and the mint's auditor can still read the amounts
  the hook could not see. Until now the confidential branch was tested by calling the hook
  directly with `u64::MAX`.
- Tests for delegates, the meta-list update, events and the authority handover
  (`tests/admin.ts`), and for the SDK (`tests/sdk.ts`). The suite is 44 tests.
- `scripts/upgrade-check.sh` and `tests-upgrade/`: build 2.0.2 and this version, set a mint up
  under 2.0.2 on a local validator, upgrade in place, and check that the mint keeps working and
  that `update_extra_account_meta_list` turns the delegate check on. CI runs it.
- `docs/threat-model.md`: what Sentinel protects, who is trusted, the invariants, known limits
  and the findings of our own review.
- CI builds the program and runs the whole suite on a local validator, checks that the committed
  IDL matches the program, and runs `cargo audit`.

### Upgrading from 2.0.x
- Upgrade the program in place; existing policies, entries and meta lists keep working.
- For each existing mint, the policy authority calls `update_extra_account_meta_list` once
  (SDK: `client.updateExtraAccountMetaList(mint)`). Until then the hook does not receive the
  transfer authority's entry and the delegate check is skipped for that mint. Mints whose meta
  list is created by 2.1 have it from the start.
- Callers that build transfer instructions by hand must resolve the meta list's accounts as
  usual (`@solana/spl-token`'s `createTransferCheckedWithTransferHookInstruction` and
  `@softseco/confidential-transfers` do); there is no fixed account list to update.

## [2.0.2] - 2026-09-28

Documentation and packaging only. The program code is unchanged and was not redeployed: the devnet
program at `5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD` is the 2.0.1 build.

### Changed
- The README and the SDK README (the npm page) describe the current state: stable API,
  self-audited, deployed on devnet, not independently audited. Both still said "pre-alpha,
  validated on a local validator" in places.
- `PROJECT_PLAN.md`, an early internal planning note, is removed from the repository.
- The IDL metadata and `Cargo.lock` carry the release version; they still said 2.0.0.

### Added
- npm package metadata: keywords, homepage, issue tracker and `engines` (Node ≥ 20).

## [2.0.1] - 2026-09-22

### Changed
- **New program id: `5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD`.** The keypair behind `4Lr94hphpGHq2VY6CRC5Yxq6k3gs9nSSzsh479hVU1Xw` came from a local build, was never deployed
  anywhere, and no longer exists, so the program was rebuilt under a fresh keypair. `declare_id!`,
  `Anchor.toml` and the SDK's bundled IDL all carry the new id. Nothing on chain referenced the old one.

### Added
- **First deployment — Solana devnet.** The program is live at the id above, with the upgrade authority
  held by Softseco. Program behaviour is unchanged from 2.0.0.

## [2.0.0] - 2026-09-20

### Fixed
- **A policy with a transfer limit rejected every confidential transfer.** Token-2022 invokes a
  transfer hook for a confidential transfer with `amount = u64::MAX`, because the real amount is
  encrypted. The limit rule compared that sentinel against `max_transfer_amount` and failed, so a
  mint that combined Token-2022 confidential transfers with any Sentinel limit could not transfer
  at all. Mints with no limit set (`max_transfer_amount == 0`) were unaffected. Found in review,
  before any mainnet use.

### Changed
- **BREAKING — `PolicyConfig` gained `allow_confidential`,** and `initialize_policy` /
  `update_policy` take it as a fourth argument. An amount limit cannot be enforced on an encrypted
  amount, so the hook now refuses a confidential transfer on a limited mint unless the policy sets
  this flag — the issuer accepting, explicitly, that the limit does not apply to those transfers.
  Silently skipping the limit instead would leave a policy that reads as enforced but is not.
- The allowlist and blocklist rules are unchanged: they work on addresses, which stay public, so
  they apply to confidential transfers exactly as they do to public ones.
- The account layout changed, so existing `PolicyConfig` accounts must be recreated.

### Added
- `SentinelError::ConfidentialAmountNotEnforceable`, appended so the existing error codes keep
  their numbers.
- `CONFIDENTIAL_TRANSFER_AMOUNT` — the `u64::MAX` sentinel, named rather than written inline.
- SDK: `allowConfidential` on `PolicyView`, and an optional `allowConfidential` on
  `initializePolicy` / `updatePolicy` (default `false`, which preserves the stricter behaviour).
- **Four integration tests for the confidential branch** (suite is now 15): with a limit set and
  `allow_confidential = false` the hook fails with `ConfidentialAmountNotEnforceable` (asserting
  the name *and* code 6005, so the number stays stable for deployed clients); with the flag set it
  passes; with no limit it passes either way; and the allowlist still rejects a non-allowlisted
  recipient while letting an allowlisted one through — confidentiality hides the amount, not the
  parties.
- `LICENSE` (Apache-2.0), `NOTICE`, `CONTRIBUTING.md` and a CI workflow (`cargo fmt`, `clippy`,
  test typecheck, SDK typecheck + build). `sdk/` carries its own `LICENSE`/`NOTICE` so the
  published npm package includes them.
- A `[lints.rust]` table on the program crate declaring the cfgs Anchor's macros expand to
  (`target_os = "solana"`, `custom-heap`, `custom-panic`, `anchor-debug`) so `clippy -D warnings`
  passes without blanket-allowing unknown cfgs. `deprecated` is allowed for the same reason —
  Anchor 0.31.1's generated code calls `AccountInfo::realloc`; nothing in this crate does.

### Verified
- Builds clean with Anchor 0.31.0 and Solana platform-tools v1.57. The regenerated IDL carries the
  fourth `allow_confidential` argument on `initialize_policy` and `update_policy`, the new
  `PolicyConfig` field, and error 6005 appended after the existing 6000–6004.
- The IDL is committed at `sdk/src/idl/sentinel.json` / `.ts`, so the SDK and CI build from the
  same interface the program exposes. `@softseco/sentinel` typechecks and builds against it.
- `anchor test --skip-build`: **15 passing**, including all four confidential-branch cases.
  `cargo fmt --all --check` is clean.

### Build requirements
- Solana platform-tools **v1.57 or newer**: `anchor build -- --tools-version v1.57`. Older
  tool-chains ship Cargo 1.84, which cannot parse dependencies that have moved to Rust edition
  2024. `Cargo.lock` pins `blake3` to 1.5.5 for the same reason; that pin can be relaxed once
  v1.57 is the baseline everywhere.

### Known limits
- The confidential-branch tests call `transfer_hook` directly with `u64::MAX` rather than issuing a
  real confidential transfer, which would additionally need Token-2022's confidential-transfer
  extension and the ZK ElGamal Proof program on the validator. They cover the program's own
  decision for that amount — the part that was wrong — not Token-2022's end of the interface.
- Not independently audited. Review before production use.

## [1.0.0] - 2026-07-14

First stable release of Sentinel — programmable compliance for Token-2022 tokenized assets.

The SDK at this version was not published to npm: `@softseco/sentinel` went from 0.1.0 to 2.0.0.

### Added
- **Compliance program** (Anchor): per-mint `PolicyConfig` toggling an **allowlist**, a **blocklist**
  (sender + recipient), and a **per-transfer limit**, enforced on every transfer via the Token-2022
  Transfer Hook. Authority-gated policy updates.
- **TypeScript SDK** `@softseco/sentinel`: compliant mint creation, policy + allow/blocklist
  management, hook-aware transfers, and reads (`getPolicy`, `isAllowlisted`, `isBlocklisted`).
- Runnable demo (`sdk/examples/compliant-asset-demo.ts`) and **11 integration tests**.

### Security
Self-audited before release. Fixed:
- **High** — allowlist/blocklist writes were not restricted to the policy authority, allowing anyone
  to allowlist wallets (compliance bypass) or blocklist wallets (griefing). Now gated by
  `has_one = authority`, with a negative test.
- **Medium** — anyone could initialize a mint's policy and become its authority (policy-authority
  squatting). Policy and hook-account setup are now bound to the **mint authority**, with a negative
  test.
- **Low** — the extra-account-meta-list initializer is now bound to the mint authority.

Informational (no exploit): the transfer hook relies on Token-2022's deterministic account
resolution for the allow/block entries; documented in-code. Not independently audited — review
before production use.

[Unreleased]: https://github.com/softseco/sentinel/compare/v2.3.0...HEAD
[2.3.0]: https://github.com/softseco/sentinel/releases/tag/v2.3.0
[2.2.0]: https://github.com/softseco/sentinel/releases/tag/v2.2.0
[2.1.1]: https://github.com/softseco/sentinel/releases/tag/v2.1.1
[2.1.0]: https://github.com/softseco/sentinel/releases/tag/v2.1.0
[2.0.2]: https://github.com/softseco/sentinel/releases/tag/v2.0.2
[2.0.1]: https://github.com/softseco/sentinel/releases/tag/v2.0.1
[2.0.0]: https://github.com/softseco/sentinel/releases/tag/v2.0.0
[1.0.0]: https://github.com/softseco/sentinel/releases/tag/v1.0.0
