# Vigilantis: audit scope

Prepared on 17 October 2026 for Vigilantis's first independent audit, updated on 29 October
for the 1.0 enforcement functions (roles, pause, seizure), on 2 November after a second review
of our own, and on 5 November for forfeiture (1.0.0-rc.2). Vigilantis is self-audited, not
independently audited. The code under audit is the commit tagged `v1.0.0-rc.2` in the public
`vigilantis` repository, which this document describes.

The threat model ([threat-model.md](./threat-model.md)) is the companion to this page: who is
trusted, the sixteen invariants and the tests that check them, the known limits, the findings of our
own review, and the questions we would like answered. This page says what to read, how to build and
test it, and what it costs.

## In scope

| Path | What |
|---|---|
| `programs/vigilantis/src/lib.rs` | The whole program, in one file: 2,743 lines, about 2,100 of them code (without blank lines and comments). |
| `programs/vigilantis/Cargo.toml`, `Cargo.lock` | Dependencies and their exact versions. |

Built with Anchor 0.31.1 (`anchor-lang` and `anchor-spl` 0.31.1) on `solana-program` 2.3.0. The
program calls Token-2022 through `anchor-spl` (`spl-token-2022` crate 6.0.0) and uses
`spl-transfer-hook-interface` 0.9.0, `spl-tlv-account-resolution` 0.9.0 and `solana-security-txt`
1.1.3.

Program ID: `4DoDFZJmJWYuBx86UqXi3y24GkQ3Cq4nUBHZwDE5PQM5`, Vigilantis's own, in the source since 1.0.0-rc.1
and on devnet from its first deployment there. Sentinel 2.1.0, the earlier name, runs on devnet at
`5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD`. Nothing is deployed on mainnet.

## Out of scope

- The TypeScript SDK in `sdk/` and its command line (`sdk/src/cli.ts`). They only build
  instructions, and the program does not trust them.
- The tests (`tests/`, `tests-fuzz/`) and the scripts in `scripts/`.
- Token-2022, the ZK ElGamal Proof Program, the System program and Anchor itself. Vigilantis relies on
  Token-2022 behaving as documented: it calls the hook on every transfer with the accounts its meta
  list resolves, passes `amount = u64::MAX` for a confidential transfer, refuses every
  instruction on a frozen account, refuses transfers, mints and burns of a paused mint, and lets a
  mint's permanent delegate burn any account's public balance.
- Off-chain tools that do not exist yet (a sanctions-list sync, a moderation console).
- Arcantis (`@softseco/arcantis`, published until now as `@softseco/confidential-transfers`), the
  confidential-transfer SDK in a separate repository.

## The program on one page

### Instructions

| Instruction | Signed by | What it does |
|---|---|---|
| `initialize_policy` | the mint authority | Creates the mint's `PolicyConfig` (allowlist on or off, blocklist on or off, limit, `allow_confidential`); the signer becomes the policy authority. |
| `update_policy` | policy authority | Changes those four settings. |
| `initialize_extra_account_meta_list` | the mint authority | Creates the meta list Token-2022 resolves the hook's accounts from, also when someone funded its address first. |
| `update_extra_account_meta_list` | policy authority | Rewrites the meta list to the current layout, resizing it and topping up the rent. |
| `add_to_allowlist`, `remove_from_allowlist` | policy authority, or a role with ALLOWLIST | Create or close an `AllowEntry`. |
| `add_to_blocklist`, `remove_from_blocklist` | policy authority, or a role with BLOCK / UNBLOCK | Create or close a `BlockEntry`. |
| `block_wallet`, `unblock_wallet` | policy authority, or a role with BLOCK / UNBLOCK | The same as the blocklist pair, with a reason code and case reference in an `EnforcementAction` event. |
| `freeze_token_account`, `thaw_token_account` | policy authority, or a role with FREEZE / THAW | Token-2022 `FreezeAccount` / `ThawAccount`, signed by the mint's freeze address; writes or deletes the `FreezeRecord`; `EnforcementAction` event. A thaw is refused while the account has a `ForfeitureRecord` (`AccountForfeited`), whoever signs. |
| `set_freeze_authority` | policy authority | Token-2022 `SetAuthority` (freeze) from the freeze address to another address or to none; `FreezeAuthorityChanged` event. |
| `grant_role`, `update_role`, `revoke_role` | policy authority | Create, change or close a `RoleEntry`; `RoleChanged` event. |
| `renounce_role` | the role holder | Closes its own `RoleEntry`; `RoleChanged` event. |
| `pause`, `resume` | policy authority, or a role with PAUSE / RESUME | Token-2022 Pausable `Pause` / `Resume`, signed by the mint's pause address; `EnforcementAction` event. |
| `set_pause_authority` | policy authority | Token-2022 `SetAuthority` (pause) from the pause address to another address or to none; `PauseAuthorityChanged` event. |
| `seize` | policy authority, or a role with SEIZE | On an account frozen through Vigilantis at least 24 hours before: Token-2022 `ThawAccount`, `Burn` of the whole public balance signed by the mint's permanent-delegate address, `FreezeAccount`; creates a `SeizureRecord`; `EnforcementAction` and `Seized` events. |
| `close_seizure` | policy authority, or a role with CLOSE_SEIZURE | Closes a `SeizureRecord` with its outcome; `EnforcementAction` and `SeizureClosed` events. |
| `forfeit` (1.0.0-rc.2) | policy authority, or a role with SEIZE | On an account frozen through Vigilantis at least 24 hours before, with a case reference: creates a `ForfeitureRecord` (reason, case, an optional 32-byte commitment to the amount). Calls no Token-2022 instruction and moves nothing; `EnforcementAction` and `Forfeited` events. |
| `release_forfeiture` (1.0.0-rc.2) | policy authority only | Closes a `ForfeitureRecord`, so the account can be thawed; `EnforcementAction` (with the record's case) and `ForfeitureReleased` events. |
| `propose_authority`, `cancel_authority_transfer` | policy authority | Open or close a `PendingAuthority`. |
| `accept_authority` | the proposed authority | Completes the handover; the pending account's rent goes back to the previous authority. |
| `transfer_hook` (and `fallback`, which routes Token-2022's `Execute` to it) | nobody: Token-2022 calls it during a transfer | Refuses a call outside a transfer (`NotInTransfer`) and token accounts whose owner can change (`OwnerCanChange`), then applies the rules. Reads accounts, writes nothing. |

### Accounts

| Account | Address | Holds |
|---|---|---|
| `PolicyConfig` | `["policy", mint]` | The rules and the policy authority. |
| `AllowEntry` | `["allow", mint, wallet]` | One allowlisted wallet. |
| `BlockEntry` | `["block", mint, wallet]` | One blocklisted wallet. |
| `PendingAuthority` | `["pending-authority", mint]` | A proposed policy authority, while a handover is open. |
| Meta list | `["extra-account-metas", mint]` | The SPL transfer-hook interface's `ExtraAccountMetaList` (TLV). |
| Freeze address | `["freeze-authority", mint]` | Nothing. It signs as the mint's freeze authority. |
| `RoleEntry` | `["role", mint, holder]` | One role holder's permission bits. |
| `FreezeRecord` | `["freeze-record", mint, token_account]` | When Vigilantis last froze the account. |
| `SeizureRecord` | `["seizure", mint, token_account, case_ref]` | One open seizure: the owner, the amount burnt, the reason, who seized and when. |
| `ForfeitureRecord` | `["forfeiture", mint, token_account]` | One forfeited account: the owner, the reason, the case, the amount commitment, who forfeited and when. |
| Pause address | `["pause-authority", mint]` | Nothing. It signs as the mint's pause authority. |
| Permanent-delegate address | `["permanent-delegate", mint]` | Nothing. It signs as the mint's permanent delegate, only in `seize`. |

All addresses are derived from the program ID. The hook receives the policy, the sender's and the
recipient's block entries and the recipient's allow entry through the meta list, and the transfer
authority's block entry as the fifth extra account (2.1), which it also checks by content.

### Events and errors

Events: `PolicyInitialized`, `PolicyUpdated`, `ListEntryAdded`, `ListEntryRemoved`,
`MetaListUpdated`, `AuthorityTransferProposed`, `AuthorityTransferCancelled`,
`AuthorityTransferred`, `EnforcementAction`, `FreezeAuthorityChanged`, `TransferRefused`,
`PauseAuthorityChanged`, `Seized`, `SeizureClosed`, `Forfeited`, `ForfeitureReleased`, `RoleChanged`.

Errors: 6000 `RecipientNotAllowlisted`, 6001 `TransferExceedsLimit`, 6002 `SenderBlocked`,
6003 `RecipientBlocked`, 6004 `Unauthorized`, 6005 `ConfidentialAmountNotEnforceable`,
6006 `AuthorityBlocked`, 6007 `InvalidAuthority`, 6008 `FreezeAuthorityNotVigilantis`,
6009 `InvalidPermissions`, 6010 `PauseAuthorityNotVigilantis`, 6011
`PermanentDelegateNotVigilantis`, 6012 `AccountNotFrozen`, 6013 `NothingToSeize`, 6014
`SeizeTooEarly`, 6015 `InvalidCaseRef`, 6016 `InvalidTokenAccount`, 6017 `NotInTransfer`,
6018 `OwnerCanChange`, 6019 `PausedMintHandover`, 6020 `AccountForfeited`.

### Calls to other programs

- System program: account creation (Anchor `init`, and `create_program_account` for the meta list
  and the freeze record: transfer, allocate, assign).
- Token-2022: `FreezeAccount`, `ThawAccount` and `SetAuthority` (freeze), each signed with the seeds
  `["freeze-authority", mint]`; `Burn`, signed with `["permanent-delegate", mint]`, only inside
  `seize`; Pausable `Pause` / `Resume` (instruction bytes `[44, 1]` / `[44, 2]`) and `SetAuthority`
  with authority type 16 (pause), signed with `["pause-authority", mint]`. These last three are
  built by hand, because the `spl-token-2022` crate in use (6.0) predates Pausable.
- Nothing else. The hook makes no calls.

## Build and test

Toolchain: Solana CLI and `solana-test-validator` from Agave 4.2.2, Anchor 0.31.1, Rust stable,
Node 22. The tests need Agave 4.x because older validators reject today's ZK proofs.

| What | Command |
|---|---|
| Build | `anchor build --no-idl` (or `cargo build-sbf --manifest-path programs/vigilantis/Cargo.toml`) |
| Check the embedded security.txt | `bash scripts/check-security-txt.sh` |
| Integration tests (96, local validator, Token-2022 v11.1.0 from `tests/fixtures`) | `anchor test --skip-build` |
| Verified build (Docker) and its hash | `solana-verify build --library-name vigilantis`, then `solana-verify get-executable-hash target/deploy/vigilantis.so` |
| Roles, pause, seizure and forfeiture in LiteSVM, with the clock moved for the 24-hour delay (13) | `cd tests-fuzz && cargo test --test enforcement` |
| Fuzz tests against a model (LiteSVM) | `cd tests-fuzz && cargo test --test model` (`FUZZ_CASES`, `FUZZ_STEPS`, `FUZZ_SEED`) |
| Planted bugs the fuzz tests must catch (79) | `python3 tests-fuzz/mutants.py` |
| Line coverage under fuzzing | `bash tests-fuzz/coverage.sh` |
| Integration and fuzz tests against the Token-2022 on mainnet | `bash scripts/mainnet-token-2022.sh` (CI runs it weekly) |

CI runs all of these on every push except the mutants, the coverage and the mainnet run. The
verified build runs on every tag and on pushes that touch the program.

SBF builds are not byte-for-byte reproducible across toolchains, so the build that counts is the
verified one: `solana-verify build` in the Solana Foundation's Docker image for Agave 4.2.2
(`[workspace.metadata.cli]` in `Cargo.toml` picks the image). CI runs it
(`.github/workflows/verified-build.yml`) and prints the executable hash; building the tagged commit
the same way on another machine must give the same hash, and so must
`solana-verify get-program-hash` on a deployed program.

## What the hook costs a transfer

Measured on 5 November 2026 (1.0.0-rc.2) by `tests/costs.ts` on a local validator (Agave 4.2.2,
Token-2022 v11.1.0), with every rule on: allowlist, blocklist, a limit and `allow_confidential`.
The fixed part grew by about 250 CU from 17 October (2.3.0) with the two checks 1.0.0-rc.1 added
to the hook (`NotInTransfer`, `OwnerCanChange`); forfeiture adds nothing to a transfer.

| Transfer | Vigilantis CU, fixed part | Transaction bytes | Bytes left of 1232 |
|---|---:|---:|---:|
| Public, signed by the owner | 7,922 | 478 | 754 |
| Public, signed by a delegate | 8,115 | 510 | 722 |
| Confidential, signed by the owner (the transaction with Token-2022's `Transfer`) | 7,584 | 792 | 440 |

On top of the fixed part, the hook pays for finding the meta list's bump. Anchor checks the meta
list's address with `find_program_address`, which tries bumps from 255 down at 1,500 CU a try, so
a mint whose meta-list address has bump 255 − k costs 1,500 × k more on every transfer. About half
of all mints need no extra try, a quarter one, an eighth two, and so on. Three runs with different
mints measured 1,500, 4,500 and 7,500 CU of extra tries, and the fixed part stayed exactly the
same. Whole transactions used 36,000–73,000 CU, most of it Token-2022's and, for the confidential
transfer, the closing of its proof accounts. The threat model asks the auditor whether the hook
needs this address check at all.

The test fails if the fixed part goes above 16,000 CU or if a public transfer leaves less than the
54 bytes a wallet needs to add priority-fee instructions. The confidential transfer's proofs travel
in separate transactions; the one measured here carries the transfer itself.

## Deployment context

Planned for mainnet, not done yet:

- **Upgrade authority:** a multisig (Squads), with a verified build.
- **Policy authority:** each issuer's own multisig. The two-step handover (`propose_authority` /
  `accept_authority`) is there so that it can be moved to one safely.
- **Freeze authority:** a mint that wants freezing through Vigilantis is created with Vigilantis's
  freeze address as its freeze authority, or hands it over later with Token-2022 `SetAuthority`.
- **Pause and seizure:** a mint that wants them is created with Token-2022's Pausable extension
  (pause authority: Vigilantis's pause address) and a permanent delegate (Vigilantis's
  permanent-delegate address). Neither extension can be added after the mint is created. Explorers
  show that a mint has a permanent delegate.
- **Roles:** one role per compliance officer, each on its own hardware key; the admin, a multisig,
  keeps everything a single key should not do alone, and is the only one who can release a
  forfeiture.

The deployment plan, with the multisig set-up, deploying and upgrading through it, the verified
build and the emergency procedures, is in [deployment.md](./deployment.md).

## Earlier reviews

No independent audit. Our own reviews found fourteen issues, on 12 October and 2 November, all
fixed or documented; they are listed with their status in the threat model. Security contact: [SECURITY.md](../SECURITY.md), also
embedded in the program (`query-security-txt` or `scripts/check-security-txt.sh`).
