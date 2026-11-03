# Vigilantis threat model

Version 1.0.0-rc.1, 3 November 2026. First written for 2.1.0 on 12 October; the version
numbers 2.0 to 2.3 below are releases of Sentinel, as the project was called until 28 October.
Written by the author as part of a self-review. Vigilantis has not been independently
audited; this document is meant to make that audit faster and cheaper. What to read, how to build
and test it, and what the hook costs are in [audit-scope.md](./audit-scope.md).

## Scope

The on-chain program in `programs/vigilantis/src/lib.rs`: one file, about 1,900 lines of Rust
without blank lines and comments, built with Anchor 0.31.1. Twenty-seven instructions:
`initialize_policy`, `update_policy`, `initialize_extra_account_meta_list`,
`update_extra_account_meta_list`, `add_to_allowlist`, `remove_from_allowlist`, `add_to_blocklist`,
`remove_from_blocklist`, `block_wallet`, `unblock_wallet`, `freeze_token_account`,
`thaw_token_account`, `set_freeze_authority`, `pause`, `resume`, `set_pause_authority`, `seize`,
`close_seizure`, `grant_role`, `update_role`, `revoke_role`, `renounce_role`, `propose_authority`,
`cancel_authority_transfer`, `accept_authority`, `transfer_hook`, and the `fallback` that routes
Token-2022's `Execute` call to `transfer_hook`.

Out of scope: the TypeScript SDK in `sdk/` (it only builds instructions; the program does not
trust it), Token-2022 itself, and the ZK ElGamal Proof Program.

## What Vigilantis protects

An issuer's rules for one Token-2022 mint, enforced on every transfer of that mint:

- **Allowlist**: when on, a transfer is refused unless the recipient (the owner of the destination
  token account) has an allow entry.
- **Blocklist**: when on, a transfer is refused if the sender, the recipient, or the authority
  signing the transfer (a delegate) has a block entry.
- **Limit**: a public transfer above `max_transfer_amount` is refused. A confidential transfer
  hides its amount from the hook; on a mint with a limit it is refused unless the issuer has set
  `allow_confidential`.
- **Freeze** (2.2): on a mint whose freeze authority is Vigilantis's freeze address
  (`["freeze-authority", mint]`), the policy authority can freeze and thaw any token account of the
  mint through Vigilantis. Token-2022 then refuses every instruction on a frozen account: transfers in
  and out, burns, approvals, and the confidential deposit, transfer and withdraw. Since 2.3 the
  policy authority can also hand the freeze authority on to another address, or give it up, with
  `set_freeze_authority`.
- **Pause** (1.0): on a mint with Token-2022's Pausable extension whose pause authority is
  Vigilantis's pause address (`["pause-authority", mint]`), `pause` stops every transfer, mint and
  burn of the token, confidential ones included, until `resume`. Freezing and thawing still work.
  `set_pause_authority` hands the pause authority on or gives it up.
- **Seizure** (1.0): on a mint whose permanent delegate is Vigilantis's permanent-delegate address
  (`["permanent-delegate", mint]`), `seize` burns the whole public balance of a token account that
  Vigilantis froze at least 24 hours before, and leaves the account frozen. Nothing is moved to
  anyone: the reserve behind the burnt tokens stays with the issuer, and paying out under the
  judgment is the issuer's own step, off this program. A `SeizureRecord` stays open until
  `close_seizure` records the outcome.
- **Roles** (1.0): the policy authority can give other addresses some of nine permissions
  (allowlist, block, unblock, freeze, thaw, pause, resume, seize, close seizure), so that a
  compliance officer can, say, freeze but not thaw, without holding the key that changes the rules.
- **Record** (2.2): `block_wallet`, `unblock_wallet`, `freeze_token_account` and
  `thaw_token_account` take the issuer's reason code and a 32-byte case reference and put them,
  with who did what to whom, in an `EnforcementAction` event. `set_freeze_authority` (2.3) does
  the same in a `FreezeAuthorityChanged` event, and in 1.0 `pause`, `resume`, `seize` and
  `close_seizure` emit `EnforcementAction` too, `set_pause_authority` emits
  `PauseAuthorityChanged`, `seize` and `close_seizure` emit `Seized` and `SeizureClosed`, and the
  role instructions emit `RoleChanged`.

The state that carries these rules: one `PolicyConfig` per mint, one `AllowEntry` or `BlockEntry`
per listed wallet, the mint's `ExtraAccountMetaList`, a `PendingAuthority` while a handover is
in progress, one `RoleEntry` per role holder, one `FreezeRecord` per account Vigilantis froze, and
one `SeizureRecord` per open seizure. All are PDAs of the program, seeded by the mint. The freeze,
pause and permanent-delegate addresses hold no data; they only sign. A token account's frozen state
lives in the token account and a mint's paused state in the mint, both kept by Token-2022.

## Who is trusted

| Actor | Trust | What it can do |
|---|---|---|
| Policy authority (the admin) | Fully trusted for its mint | Change the rules and the lists, hand the policy over, rewrite the meta list, grant and take away roles. It can also stop every transfer of the mint (for example, allowlist on and empty). On a mint that gave Vigilantis its freeze authority, it can freeze any holder's token account, for as long as it likes (2.2), and hand the freeze authority to any address or give it up (2.3). On a mint that gave Vigilantis its pause authority and permanent delegate, it can pause the whole token and, 24 hours after a freeze, burn a frozen account's public balance (1.0). A multisig is recommended. |
| Role holder | Trusted for its permissions | Exactly the actions its `RoleEntry` allows, on that one mint: some of allowlist, block, unblock, freeze, thaw, pause, resume, seize and close seizure. It cannot change the rules, the meta list, the authorities or the roles, and it waits the same 24 hours as the admin before a seizure. It can give its own role up (`renounce_role`). A stolen role key can do what the role allows until the admin revokes it, so one role per person, each on a hardware key, with the fewest permissions that do the job. A handover of the policy ends every role (1.0). |
| Mint's transfer-hook authority | Fully trusted | Chosen when the mint is created (`createCompliantMint`'s `transferHookAuthority`, the provider wallet by default). It can point the mint at another hook program, or at none, with Token-2022 `UpdateTransferHook`, which switches every Vigilantis rule off and leaves no Vigilantis event. Give it to the issuer's multisig, or give it up so the hook can never change (Vigilantis can still be upgraded in place). `vigilantis status` shows it. |
| Mint authority | Trusted at setup | Creates the policy and the meta list (so nobody else can claim a mint's policy first). Can mint to any account; minting does not run the hook. |
| Mint's freeze authority | Trusted | Chosen when the mint is created. If it is Vigilantis's freeze address, only Vigilantis can freeze and thaw, and only for the policy authority. If it is anyone else (from the start, or after `set_freeze_authority`), Vigilantis cannot freeze at all, and that key freezes outside Vigilantis's rules and records; a `FreezeAuthorityChanged` event shows when it left Vigilantis. |
| Program upgrade authority | Fully trusted | Can replace the program. On devnet it is a single key; on mainnet it must be a multisig, with a verified build. |
| Mint's pause authority and permanent delegate | Trusted | Chosen when the mint is created (neither extension can be added later). If they are Vigilantis's addresses, only Vigilantis can pause and resume, and only Vigilantis's `seize` can burn through the permanent delegate. If the permanent delegate is anyone else, that key can move or burn any holder's tokens at any time, outside Vigilantis; `seize` then refuses (`PermanentDelegateNotVigilantis`). |
| Token-2022 | Trusted | Calls the hook on every transfer, with the accounts resolved from the meta list and with `amount = u64::MAX` for a confidential transfer. Refuses every instruction on a frozen account, and checks that a frozen or thawed account belongs to the mint. Refuses transfers, mints and burns of a paused mint. Lets the permanent delegate burn from any account that is not frozen. |
| Holders, delegates, anyone else | Untrusted | Can send any instruction with any accounts. |

## Invariants

These must hold for every mint whose transfer hook is Vigilantis. The integration tests check each
of them; the tests named here are in `tests/`. The model-based fuzz tests in `tests-fuzz/` check
all fifteen together, after every step of random sequences of operations (see "How the invariants
are tested" below).

1. **Fail closed.** If the policy or the meta list is missing, every transfer of the mint fails.
   (Anchor cannot load the policy account, or Token-2022 cannot resolve the hook's accounts.)
   (`admin.ts`)
2. **Only the policy authority changes the rules.** `update_policy`, `propose_authority`,
   `cancel_authority_transfer`, `update_extra_account_meta_list`, `set_freeze_authority`,
   `set_pause_authority` and the role instructions (except `renounce_role`) check
   `has_one = authority` against the policy. The list, freeze, thaw, pause, resume, seize and
   close-seizure instructions accept the policy authority or the holder of a role with the matching
   permission, checked in the instruction by `authorize` (invariant 12). (`admin.ts`,
   `vigilantis.ts`, `roles-pause.ts`)
3. **Only the mint authority creates a policy and a meta list**, so a stranger cannot set up
   rules for someone else's mint first, and a stranger cannot stop the mint authority from
   creating them either, for example by funding their addresses first (2.1.1). (`vigilantis.ts`,
   `admin.ts`, `setup.ts`)
4. **A handover needs both sides.** The policy authority changes only when the proposed authority
   signs `accept_authority`; until then the old authority can cancel. (`admin.ts`, `sdk.ts`)
5. **Blocklist.** With the blocklist on, no transfer succeeds whose sender, recipient or signing
   authority is blocklisted, on public and confidential transfers alike. (`vigilantis.ts`,
   `confidential.ts`, `admin.ts`)
6. **Allowlist.** With the allowlist on, no transfer succeeds to a recipient without an allow
   entry. (`vigilantis.ts`, `confidential.ts`)
7. **Limit.** A public transfer above the limit fails. A confidential transfer on a mint with a
   limit fails unless `allow_confidential` is set. (`vigilantis.ts`, `confidential.ts`)
8. **Entries cannot be forged.** Allow and block entries are PDAs that only the authority-gated
   instructions create. Token-2022 hands the hook exactly the PDAs the meta list resolves; the
   fifth entry, read from `remaining_accounts`, is checked by content (owner, discriminator,
   mint, wallet) as well.
9. **The hook runs only inside a transfer.** It refuses a call unless both token accounts are
   Token-2022 accounts of the mint and the source carries Token-2022's `transferring` flag, which
   Token-2022 sets just before it calls the hook (`NotInTransfer`, 6017). The check comes before
   any rule and emits no event, so nobody can call the hook directly with someone else's accounts
   and leave a `TransferRefused` naming them in the logs. The hook holds no state either way.
   (`vigilantis.ts`, `model.rs`)
10. **Only the policy authority, or a role holder allowed to, uses the freeze authority, and only
    through the mint's own freeze address.** `freeze_token_account` and `thaw_token_account` pass
    `authorize` (FREEZE, THAW), `set_freeze_authority` checks `has_one = authority`, and all three
    sign with the seeds `["freeze-authority", mint]`.
    A mint whose freeze authority is any other address, or none, gets `FreezeAuthorityNotVigilantis`
    (6008). Because the address is derived from the mint, Vigilantis can sign for no other mint.
    `set_freeze_authority` refuses the default address and the six addresses Vigilantis derives from
    the mint alone (policy, meta list, freeze, pause, permanent delegate, pending authority), none of
    which can sign a freeze (`InvalidAuthority`, 6007); giving the authority up is an explicit
    `None`. Vigilantis's per-wallet addresses (roles, list entries, records) are not checked: only
    the admin can name one, and only by mistake. (`enforcement.ts`, `confidential.ts`)
11. **Enforcement is recorded.** Every successful `block_wallet`, `unblock_wallet`,
    `freeze_token_account` and `thaw_token_account` emits exactly one `EnforcementAction`: the mint,
    the wallet (the owner, for a token account), the token account (the default address for a block
    or unblock), the action, the issuer's reason code and case reference, and the authority that
    signed. Every successful `set_freeze_authority` emits exactly one `FreezeAuthorityChanged`: the
    mint, the new freeze authority (or none), the reason and the authority. The plain list
    instructions emit neither. In 1.0 the same holds for `pause`, `resume`, `seize` and
    `close_seizure` (`EnforcementAction`; for a pause the wallet and token account are the default
    address), `set_pause_authority` (`PauseAuthorityChanged`), and the four role instructions
    (`RoleChanged`, with the permissions before and after). (`enforcement.ts`, `roles-pause.ts`)
12. **A role does exactly what it says.** A signer other than the policy authority passes a gated
    instruction only with a `RoleEntry` owned by Vigilantis whose mint is the instruction's mint,
    whose holder is the signer, whose permissions include every bit the instruction needs, and
    whose epoch equals the policy's role epoch. A role entry is created only by `grant_role` (the
    policy authority), at `["role", mint, holder]`, with at least one permission and no unknown bits
    (`InvalidPermissions`, 6009); it is closed by `revoke_role` or by its holder's `renounce_role`.
    `accept_authority` raises the policy's role epoch, so a handover ends every role granted
    before it, including any the outgoing authority gave itself; the new authority brings a role
    back with `update_role`. (`roles-pause.ts`, `tests-fuzz/tests/enforcement.rs`, `model.rs`)
13. **Pause goes only through the mint's own pause address.** `pause` and `resume` refuse a mint
    whose pause authority is not `["pause-authority", mint]` (`PauseAuthorityNotVigilantis`, 6010)
    and sign with those seeds; `set_pause_authority` refuses the same addresses as
    `set_freeze_authority`, and refuses to run while the mint is paused (`PausedMintHandover`,
    6019): handed on or given up then, the mint could stay paused for good. (`roles-pause.ts`,
    `enforcement.rs`, `model.rs`)
14. **A seizure is slow, complete and recorded.** `seize` succeeds only if: the signer passes
    `authorize` (SEIZE); the case reference is not all zeros (`InvalidCaseRef`, 6015); the mint's
    freeze authority and permanent delegate are Vigilantis's addresses (6008, 6011); the token
    account belongs to the mint (`InvalidTokenAccount`, 6016), is frozen (`AccountNotFrozen`, 6012)
    and holds a public balance (`NothingToSeize`, 6013); and its `FreezeRecord` is at least
    `SEIZE_DELAY_SECONDS` (24 hours) old (`SeizeTooEarly`, 6014). It then burns exactly the whole
    public balance, so the supply falls by that amount and nobody else's balance changes, leaves the
    account frozen, and creates one `SeizureRecord` per token account and case reference (a second
    seizure under the same case fails). A thaw deletes the freeze record, so a thaw and a new freeze
    start the 24 hours again. (`enforcement.rs`, `model.rs`)
15. **The owner of a token account cannot change under the rules.** Every transfer is refused
    unless both token accounts carry the ImmutableOwner extension (`OwnerCanChange`, 6018), which
    every associated token account has. Without this, a holder could hand a whole account, balance
    included, to a wallet the rules refuse, because Token-2022's `SetAuthority` on the account
    owner does not call the hook, and that wallet could spend from it and hand it on again. The
    check emits `TransferRefused` like any other rule. (`enforcement.ts`)

## Known limits

These follow from how Token-2022 and transfer hooks work. They are documented, not bugs.

- **Every token account needs an owner that cannot change** (invariant 15). Associated token
  accounts have one. A program that keeps the token in a vault account of its own must create it
  with `InitializeImmutableOwner` before `InitializeAccount3`, or its transfers are refused. An
  account without the extension can still be minted to, frozen and thawed; it just cannot send or
  receive.

- **Confidential amounts are invisible to the hook.** No on-chain rule can depend on the amount of
  a confidential transfer. Amounts are watched off-chain with the mint's auditor key, which
  decrypts every confidential transfer (`confidential.ts` shows the auditor reading an amount
  above the limit that the hook could not see).
- **The hook runs on transfers only.** `mint_to`, `burn`, and moving one's own balance between
  public and confidential (`deposit`, `withdraw`) do not call it. The allowlist therefore does not
  stop the mint authority from minting to any account, and a blocklisted wallet can still burn.
  To stop those too, freeze the account (2.2).
- **Freezing needs a freeze authority chosen when the mint is created.** Token-2022 cannot add a
  freeze authority to a mint created without one, so such a mint can never freeze, through Vigilantis
  or otherwise. A mint created with the issuer as freeze authority can hand it to Vigilantis later
  (Token-2022 `SetAuthority`; the SDK's `setVigilantisAsFreezeAuthority`).
- **Giving the freeze authority up leaves frozen accounts frozen.** After `set_freeze_authority`
  with `None`, nobody can thaw them, ever. Thaw first what should not stay frozen.
- **A seized account can be closed and opened again.** After `seize` the account is frozen with a
  zero public balance; Token-2022 lets its owner close it (unless it still holds a confidential
  balance) and open a new one at the same address, unfrozen. Its `FreezeRecord` stays behind until
  the next freeze through Vigilantis overwrites it, and the thaw of the closed account fails, so
  that rent stays locked. A blocklist entry keeps covering the wallet, so block a wallet whose
  account was seized.
- **Handing the freeze authority on is final for Vigilantis.** After `set_freeze_authority`, only
  the new holder can hand it back (Token-2022 `SetAuthority`); after giving it up (`None`), nobody
  can freeze the mint ever again. Vigilantis cannot check that the new address is the one the issuer
  meant, so a mistyped address loses the freeze power for good. The policy authority (a multisig)
  should check the address before signing. In 2.2 the hand-over to Vigilantis was one-way.
- **A freeze covers the token accounts that exist.** A frozen wallet can open a new token account
  of the mint. Blocking the wallet as well stops transfers into that new account, which is what
  the SDK's `blockAndFreezeWallet` does. `freezeWallet` finds a wallet's accounts with an RPC
  query, so it does not see an account created after it ran.
- **Vigilantis does not interpret reasons.** `reason_code` is whatever the issuer's own list says
  (the SDK suggests one), and `case_ref` is 32 opaque bytes. The SDK's `caseRef` hashes the case
  number with a salt; the salt must stay secret, or a short case number can be found from its hash
  by trying them all.
- **The allowlist checks the recipient, not the sender.** A wallet that received tokens before it
  was removed from the allowlist (or by `mint_to`) can still send them to allowlisted wallets.
  This lets holders exit; an issuer who wants otherwise also blocklists them.
- **`u64::MAX` means "confidential".** A public transfer of exactly `u64::MAX` base units would be
  read as confidential. It needs a supply of at least `u64::MAX`, so in practice it cannot happen.
- **A confidential balance cannot be seized.** `seize` burns the public balance only; tokens held
  confidentially are encrypted, and burning them would need the holder's proof. They stay frozen
  for as long as the account is frozen.
- **Seizure waits for a resume.** While the mint is paused, Token-2022 refuses the burn, so `seize`
  fails (`MintPaused`, 0x43). Freezing still works during a pause.
- **A mint with `ConfidentialMintBurn` cannot be seized.** That extension makes Token-2022 refuse
  public burns, the permanent delegate's included. Such a mint can still freeze and pause.
- **Pause and seizure need extensions chosen when the mint is created.** Pausable and
  PermanentDelegate cannot be added later. A permanent delegate is visible on explorers, and holders
  may read it as a risk; with Vigilantis's address as the delegate, the only way to use it is
  `seize`, with its 24 hours and its record.
- **A freeze record can outlive the freeze it describes.** The record is written by Vigilantis's
  freeze and deleted by Vigilantis's thaw. If the freeze authority leaves Vigilantis, another key
  thaws the account and freezes it again, and the authority later comes back to Vigilantis, the old
  record still counts, and the 24 hours may already have passed. The way back to Vigilantis goes
  through the issuer's own key, so the issuer controls this; a thaw and refreeze through Vigilantis
  resets the record.
- **An account frozen before 1.0 has no freeze record** and cannot be seized until it is thawed and
  frozen again through Vigilantis.
- **Rent goes to whoever closes.** The signer of a freeze pays for the freeze record and the signer
  of the thaw gets it back, which may be a different role holder; the same for a seizure record and
  `close_seizure`. The amounts are about 0.0015 and 0.0022 SOL.
- **Mints set up before 2.1** do not check the transfer authority until the policy authority runs
  `update_extra_account_meta_list` once.
- **A self-transfer never reaches the hook.** When the source and destination accounts are the
  same, Token-2022 (v11.1) returns before calling the transfer hook. Nothing moves, so no rule is
  bypassed, but such a transfer succeeds even for a blocklisted owner and leaves no `TransferRefused`
  event. The fuzz tests model this.
- **Setup needs a mint authority that can sign.** The policy and the meta list are created by the
  mint authority. Set Vigilantis up before revoking the mint authority (a fixed-supply token), and
  note that an SPL Token multisig account cannot sign for it; a multisig vault program such as
  Squads, which signs through CPI, can.

## Findings of our own review (12 October 2026)

| # | Finding | Severity (our estimate) | Status |
|---|---|---|---|
| 1 | A blocklisted wallet acting as a delegate (or as a permanent delegate) could move a clean holder's tokens to a clean wallet: the blocklist checked the owners of the two token accounts, not the signing authority. Reproduced on a local validator. | Medium | Fixed in 2.1.0: the meta list includes the authority's block entry and the hook refuses with `AuthorityBlocked`. Existing mints run `update_extra_account_meta_list`. Test: `admin.ts`. |
| 2 | The policy authority was a single key with no way to change it. A lost key froze the rules forever; a typo in a future "set authority" would have done the same. | Medium (operational) | Fixed in 2.1.0: two-step handover, multisig-ready. |
| 3 | The meta list could not be changed after creation, so no new rule could reach existing mints. | Low | Fixed in 2.1.0: `update_extra_account_meta_list`. |
| 4 | Refusals left only an error code; nothing recorded policy changes. | Informational | 2.1.0: events for every change and refusal. |
| 5 | Anyone can call `transfer_hook` directly. Harmless while the hook holds no state (invariant 9). A future stateful rule, such as a per-wallet daily limit, must first check that Token-2022 is mid-transfer (the `transferring` flag on the source account). | Informational | Superseded in 1.0.0-rc.1: the hook now checks the flag (finding 10). |
| 6 | Minting does not run the hook, so the allowlist does not limit who can receive newly minted tokens. | Informational | Documented above. |
| 7 | The devnet program's upgrade authority is a single key. | n/a on devnet | Mainnet: multisig upgrade authority and a verified build, before launch. The verified build runs in CI; the multisig set-up and the upgrade procedure are in [deployment.md](./deployment.md). |
| 8 | A stranger could block a mint's setup for good. `initialize_extra_account_meta_list` created the list with System `CreateAccount`, which refuses an address that already holds lamports, and anyone can send lamports to any address. About 0.0009 SOL sent to a mint's meta-list address before the issuer created the list made the list impossible to create, and every transfer of the mint then failed. Found in our own review on 14 October; reproduced on a local validator, and found again by the fuzz tests on the 2.1.0 build. The policy account was not affected: Anchor's `init` already handles a funded address. | Medium (a permanent denial of service for a mint whose list is created in a separate transaction) | Fixed in 2.1.1: the list is created the way Anchor's `init` does it (top up the rent, allocate, assign) when its address already holds lamports. A second `initialize_extra_account_meta_list` still fails. Tests: `setup.ts`, `tests-fuzz`. On 2.1.0, creating the meta list in the same transaction as the mint avoids it. Mints already set up are not affected. |

## Findings of our own review (2 November 2026)

A second review before 1.0.0-rc.1: four separate passes over the program, the SDK and its command
line, each finding reproduced before it was fixed.

| # | Finding | Severity (our estimate) | Status |
|---|---|---|---|
| 9 | A holder could get round the allowlist, the limit and the blocklist by handing a whole token account to someone else. Token-2022's `SetAuthority` on the account owner does not call the hook, and the hook takes the parties from the token accounts' owner fields. Reproduced in LiteSVM: an allowlisted holder re-keyed an account holding five times the limit to a wallet that was not allowlisted, which then spent from it; a blocked wallet re-keyed its account to a fresh key and kept transferring. | High | Fixed in 1.0.0-rc.1: both token accounts must carry ImmutableOwner (`OwnerCanChange`, invariant 15). Tests: `enforcement.ts`; the fuzz fixtures now use such accounts. |
| 10 | A direct call of the hook, which needs no signature, emitted `TransferRefused` before failing, with owners read from any accounts passed. Anyone could put a refusal naming an innocent wallet into the logs, misleading indexers and alerts that read these events. | Low | Fixed in 1.0.0-rc.1: the hook refuses any call outside a Token-2022 transfer before evaluating or emitting anything (`NotInTransfer`, invariant 9). Test: `vigilantis.ts`; the fuzz model checks every direct call. |
| 11 | `set_pause_authority` could give up, or hand on, the pause authority of a paused mint, leaving it paused for good. Both authority handovers accepted Vigilantis's other addresses (for example the permanent delegate), which can never sign for that role. | Low | Fixed in 1.0.0-rc.1: refused while paused (`PausedMintHandover`), and the six addresses Vigilantis derives from the mint alone are refused (`InvalidAuthority`). Tests: `roles-pause.ts`, `enforcement.ts`, `model.rs`. |
| 12 | Roles survived a handover of the policy. An outgoing admin, or a stolen admin key, could grant itself every permission before the handover and keep freezing, pausing and seizing after it. | Low (medium for key rotation) | Fixed in 1.0.0-rc.1: a role epoch on the policy, raised by `accept_authority` (invariant 12). Tests: `roles-pause.ts`, `model.rs`. |
| 13 | The SDK made the mint creator's key the transfer-hook authority, which can switch every rule off, and nothing documented or showed it. | Low (trust model) | 1.0.0-rc.1: `createCompliantMint` takes `transferHookAuthority` (a multisig, or `null` for nobody), `vigilantis status` shows it, and the trust table above lists it. |
| 14 | In the SDK and command line, freezing a wallet with seven or eight token accounts built a transaction over 1,232 bytes, so the freeze, or the block and freeze, failed with nothing done. Anyone can open empty token accounts to set this up. | Medium (operational) | Fixed in 1.0.0-rc.1: instructions are packed by size, not only by count. |

## How the invariants are tested

- **Integration tests** (`tests/`, 91 on a local validator with Token-2022 v11.1 and the ZK ElGamal
  Proof Program): each rule, each instruction's authority checks, delegates, the handover, the
  meta-list update, events, setup with funded addresses, freezing and thawing (what a frozen
  account can no longer do, who may freeze, mints whose freeze authority is not Vigilantis's),
  handing the freeze authority on and giving it up, the enforcement record, and 12 tests with real
  confidential transfers where Token-2022 itself calls the hook, one of them to a frozen account,
  and (1.0) roles, pause and the refusals of an early seizure through the SDK (`roles-pause.ts`),
  and the `vigilantis` command line (`cli.ts`, 13), including the transactions it prints for a
  multisig, signed and sent the way the multisig would. Three more (`costs.ts`) measure what the hook costs a public, a delegated and a confidential
  transfer, and fail if that grows past the limits in the audit scope.
- **Enforcement tests in LiteSVM** (`tests-fuzz/tests/enforcement.rs`, 11): a seizure needs the
  clock 24 hours ahead, which a validator cannot do, so its success path, every refusal and the
  role checks are tested here, with the clock moved.
- **Model-based fuzzing** (`tests-fuzz/`, in LiteSVM with the same Token-2022 build). Random
  sequences of every instruction, signed by the right authority or by someone else; freezes and
  thaws with reasons, on mints whose freeze authority is Vigilantis's address, the issuer or nobody,
  and on accounts that are not the mint's; the freeze authority handed to Vigilantis, and by
  Vigilantis to another address or to nobody, including the addresses it must refuse;
  public transfers by owners and by delegates; approvals; direct calls to the hook with public
  amounts, with `u64::MAX` (confidential) and with made-up accounts; strangers funding the
  program's addresses before setup; and (1.0) roles granted, changed, revoked and renounced and used
  by their holders and by others, pauses and resumes, the pause authority handed on, seizures and
  their closing, and the clock moved forward (one hour, 12 hours, one second short of 24 hours,
exactly 24 hours, about 28 hours). A plain Rust model of the rules predicts each outcome, down to
  the exact error code, and after every step the test compares the whole state with the model: the
  policy, every entry, a pending handover, balances, delegations, which accounts are frozen, the
  mint's freeze authority, the meta list's bytes, the total supply, every role entry, the pause
  state, every freeze record and every open seizure. It also decodes every `EnforcementAction` and
  `FreezeAuthorityChanged` a step emitted and compares them with the
  model, field by field. CI runs a
  new random set of cases on every push; a failure prints the seed that reproduces it.
- **Is the fuzzing strong enough?** It found finding 8 on the 2.1.0 build. We also broke the
  program on purpose in 70 ways (a dropped authority check, a rule switched off, an off-by-one, a
  freeze recorded with the wrong action or reason, a role that works for another mint, a seizure a
  second too early or one base unit short), and the fuzz tests catch all 70. Four of the 1.0
  mutants were caught only in some runs at first, which led to changes in what the generator
  tries. The fuzz tests execute 986 of the 1,025 lines of `lib.rs` that carry code (96.2%); the
  other 39 are listed with the reason, and the paths among them that can be reached at all are
  tested in `enforcement.rs`. Both are in `tests-fuzz/README.md`.
- **CI** also runs `cargo clippy -D warnings`, `cargo audit`, a check that the committed IDL matches
  the program, a check of the security.txt embedded in the program, and the verified build
  (`solana-verify`, on tags and on changes to the program). Until 1.0.0-rc.1 it also upgraded
  Sentinel 2.0.2 and 2.1.0 in place at their program ID; Vigilantis has its own, and a check of
  the upgrade from its previous release comes with its first upgrade. Once a week a separate
  workflow runs the integration and fuzz tests against the Token-2022 deployed on mainnet.

## What we ask an auditor to look at

- Every instruction's account validation: signers, `has_one`, seeds and bumps, `close` targets,
  and the unchecked accounts marked `CHECK`.
- The meta-list seeds (`extra_account_metas`) against what Token-2022 passes to the hook, for
  public transfers, delegated transfers and confidential transfers.
- `update_extra_account_meta_list`: the resize, the rent top-up, and the rewrite of an existing
  list.
- `create_program_account` (2.1.1): creating the meta list at an address that already holds
  lamports.
- The authority handover, including cancel and accept races.
- `SetFrozen` (2.2): the freeze-authority constraint on the mint, the signer seeds of the freeze
  address, and the unchecked `token_account`, which Vigilantis passes to Token-2022 and reads only
  for the event and the freeze record's address. In 1.0 it also carries the unchecked
  `freeze_record` (seeds checked, created or closed by hand) and the optional role.
- `SetFreezeAuthority` (2.3): the same constraint and seeds, the checks on the new address, and the
  `SetAuthority` CPI on the mint.
- Roles (1.0): `authorize`, which checks a passed `RoleEntry` by content (mint, holder, permission
  bits) rather than by its address. The account is an `Option<Account<RoleEntry>>`, so Anchor checks
  its owner and discriminator, and only `grant_role` creates one, at `["role", mint, holder]`. Is a
  content check enough, or should the seeds be checked as well?
- Pause (1.0): the hand-built Token-2022 calls (`Pause` `[44, 1]`, `Resume` `[44, 2]`, and
  `SetAuthority` with authority type 16 and a `COption` new authority), and `mint_extension` /
  `mint_extension_address`, which read the mint's TLV extensions directly (account type at byte
  165, entries from 166) because `spl-token-2022` 6.0 does not know Pausable.
- Seizure (1.0): the thaw, burn, refreeze sequence inside one instruction; the checks before it
  (the token account's mint, state and amount read from raw bytes at the base-layout offsets, the
  permanent delegate read from the TLV, the freeze record's age); the `SeizureRecord` seeds, which
  include the case reference so one account can be seized under several cases; and whether
  anything can make the burn take less than the whole public balance.
- Freeze records (1.0): `write_freeze_record` (creating the record, or overwriting one left by an
  earlier freeze) and `close_freeze_record`, which closes the account by hand (lamports to the
  signer, assign to the System program, resize to zero) because Anchor's close helper is not
  public in 0.31.
- The hook's check of the meta list's address. Anchor derives it with `find_program_address` on
  every transfer, so the hook costs 1,500 CU more for every bump below 255 that the mint's address
  needs (see the audit scope). Token-2022 derives that address itself before calling the hook, and
  the hook does not read the list. Is the check worth its cost, or should it go (or use a stored
  bump)?
- `require_in_transfer` and `check_owners_fixed` (1.0.0-rc.1): the raw reads of the token
  accounts (owner program, mint at bytes 0–31, account type 2 at byte 165, extension 15's
  `transferring` byte, extension 7), and whether Token-2022 sets `transferring` on every path that
  calls the hook: public, delegated, confidential and confidential with a fee. With the
  `transferring` check in place, does the meta list address check below add anything?
- The role epoch (1.0.0-rc.1): `accept_authority` raises it, `grant_role` and `update_role` stamp
  it, `authorize` compares it.
- Invariants 1–15 above.

The tests run on a local validator with a current Token-2022 and the ZK ElGamal Proof Program
enabled; `anchor test` reproduces them, and CI runs them on every push.
