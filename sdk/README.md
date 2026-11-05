# @softseco/vigilantis

TypeScript SDK for **Vigilantis** — programmable compliance for Token-2022 tokenized assets, built on
the Transfer Hook extension. Create a compliant mint, set a policy (allowlist, blocklist, transfer
limit), manage entries, freeze and thaw accounts with the reason recorded, pause the token, seize a
frozen account's balance under a court order or record a forfeiture where it cannot be seized, give
compliance officers roles, and move tokens
through the hook — in a handful of async calls.

> **Status: 1.0.0-rc.2**, the release candidate for an independent audit, continuing
> `@softseco/sentinel` 2.3.0 under a new name. Self-audited, not independently audited. The program
> ID in the IDL is `4DoDFZJmJWYuBx86UqXi3y24GkQ3Cq4nUBHZwDE5PQM5` (devnet, from its first deployment there).
> Built by Softseco.

## Install

```bash
npm install @softseco/vigilantis
```

It depends on `@coral-xyz/anchor`, `@solana/web3.js` and `@solana/spl-token`, which npm installs
with it; an app that already uses them shares one copy when the versions match.

## Usage

```ts
import { AnchorProvider } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { VigilantisClient } from "@softseco/vigilantis";

const client = new VigilantisClient(provider); // AnchorProvider

// 1. Create a Token-2022 mint whose transfer hook is Vigilantis
const mint = Keypair.generate();
await client.createCompliantMint({ mint, decimals: 0 });

// 2. Set a policy: allowlist on, no blocklist, max 1000 per transfer
await client.initializePolicy({
  mint: mint.publicKey,
  allowlist: true,
  blocklist: false,
  maxTransferAmount: 1000n,
  allowConfidential: false, // default — see "Confidential transfers" below
});

// 3. Register the hook's extra accounts
await client.initializeExtraAccountMetaList(mint.publicKey);

// 4. Allowlist a recipient, then transfer to them (blocked otherwise)
await client.addToAllowlist(mint.publicKey, recipient);
await client.transfer({ mint: mint.publicKey, destinationOwner: recipient, amount: 100n, decimals: 0 });

// Reads
await client.getPolicy(mint.publicKey);
await client.isAllowlisted(mint.publicKey, recipient);
await client.isBlocklisted(mint.publicKey, someWallet);
```

## API

`VigilantisClient(provider)` exposes:

- `createCompliantMint({ mint, decimals, mintAuthority?, freezeAuthority?, transferHookAuthority? })`.
  `transferHookAuthority` can point the mint at another hook, or none, which switches every rule
  off; it defaults to the provider wallet. Pass the issuer's multisig, or `null` for nobody.
- `initializePolicy({ mint, allowlist, blocklist, maxTransferAmount, allowConfidential? })` /
  `updatePolicy(...)` — `allowConfidential` defaults to `false`
- `initializeExtraAccountMetaList(mint)`
- `addToAllowlist(mint, wallet)` / `removeFromAllowlist(mint, wallet)`
- `addToBlocklist(mint, wallet)` / `removeFromBlocklist(mint, wallet)`
- `transfer({ mint, amount, decimals, destinationOwner?, destination?, owner?, source? })`
- `getPolicy(mint)`, `isAllowlisted(mint, wallet)`, `isBlocklisted(mint, wallet)`
- PDA helpers: `policy`, `metaList`, `allowEntry`, `blockEntry`, `pendingAuthority`

Since 2.1:

- Batch list updates, eight per transaction: `addToAllowlistBatch(mint, wallets)`,
  `removeFromAllowlistBatch`, `addToBlocklistBatch`, `removeFromBlocklistBatch`
- Authority handover: `proposeAuthority(mint, newAuthority)`, `acceptAuthority(mint, newAuthoritySigner)`,
  `cancelAuthorityTransfer(mint)`, `getPendingAuthority(mint)`
- `updateExtraAccountMetaList(mint)`: run once for a mint set up before 2.1, so the blocklist also
  covers delegates
- Events: `getEvents(signature)` and `parseEvents(logs)` decode `transferRefused`, `policyUpdated`,
  `listEntryAdded`, `listEntryRemoved`, `authorityTransferred` and the rest, including from the logs
  of a failed transfer
- Instruction builders, with the authority as a parameter: `updatePolicyInstruction`,
  `listInstruction`, `proposeAuthorityInstruction`, `acceptAuthorityInstruction`,
  `cancelAuthorityTransferInstruction`, `updateExtraAccountMetaListInstruction`

Since 2.2 (see "Freezing" below):

- `createCompliantMint({ ..., freezeAuthority: "vigilantis" })`, `freezeAuthority(mint)`,
  `setVigilantisAsFreezeAuthority(mint, currentFreezeAuthority)`
- `blockWallet(mint, wallet, why)` / `unblockWallet(mint, wallet, why)`
- `freezeTokenAccount(mint, tokenAccount, why)` / `thawTokenAccount(mint, tokenAccount, why)`
- `freezeWallet(mint, owner, why)` / `thawWallet(mint, owner, why)`: every token account the wallet
  holds, as many per transaction as fit (`packInstructions`, `MAX_TRANSACTION_BYTES`)
- `blockAndFreezeWallet(mint, wallet, why)`
- `tokenAccountsOf(mint, owner)`, `isFrozen(tokenAccount)`
- Builders: `blockWalletInstruction`, `unblockWalletInstruction`, `freezeInstruction`
- `ENFORCEMENT_REASONS`, `caseRef(caseId, salt)`, and the `enforcementAction` event in `parseEvents`

Since 2.3:

- `setFreezeAuthority(mint, newFreezeAuthority | null, why)`: Vigilantis hands the freeze authority
  to another address, or gives it up for good with `null`; `setFreezeAuthorityInstruction` for a
  multisig; `getFreezeAuthority(mint)`; the `freezeAuthorityChanged` event in `parseEvents`

Since 1.0 (see "Roles", "Pause" and "Seizure" below):

- `createCompliantMint({ ..., pausable: true, permanentDelegate: true })`, `pauseAuthority(mint)`,
  `permanentDelegate(mint)`
- Roles: `grantRole(mint, holder, permissions)`, `updateRole(mint, holder, permissions)`,
  `revokeRole(mint, holder)`, `renounceRole(mint, holderSigner)`, `getRole(mint, holder)`,
  `listRoles(mint)`, `PERMISSIONS`. A role view has `active: false` when the role was granted
  before the policy last changed hands
- Pause: `pause(mint, why)`, `resume(mint, why)`, `setPauseAuthority(mint, newPauseAuthority | null, why)`,
  `setVigilantisAsPauseAuthority(mint, currentPauseAuthority)`, `getPauseState(mint)`
- Seizure: `seize(mint, tokenAccount, why)`,
  `closeSeizure({ mint, tokenAccount, caseRef, outcome, reasonCode })`,
  `getFreezeRecord(mint, tokenAccount)`, `getSeizure(mint, tokenAccount, caseRef)`,
  `listSeizures(mint)`, `SEIZE_DELAY_SECONDS`
- Builders: `grantRoleInstruction`, `updateRoleInstruction`, `revokeRoleInstruction`,
  `renounceRoleInstruction`, `pauseInstruction`, `setPauseAuthorityInstruction`,
  `seizeInstruction`, `closeSeizureInstruction`
- PDA helpers: `role`, `freezeRecord`, `seizureRecord`
- Events: `roleChanged`, `pauseAuthorityChanged`, `seized`, `seizureClosed` in `parseEvents`
- The gated methods (lists, block, freeze, thaw, pause, resume, seize, close seizure) and their
  builders are now async: when the signer is not the policy authority, they look up its role entry
  and pass it

Since 1.0.0-rc.2 (see "Forfeiture" below):

- `forfeit(mint, tokenAccount, why, amountCommitment?)`, `releaseForfeiture(mint, tokenAccount, reasonCode)`,
  `getForfeiture(mint, tokenAccount)`, `listForfeitures(mint)`, `forfeitedAmong(mint, tokenAccounts)`,
  `amountCommitment(amount, salt)`
- Builders: `forfeitInstruction`, `releaseForfeitureInstruction`; PDA helper: `forfeitureRecord`
- Events: `forfeited`, `forfeitureReleased` in `parseEvents`, and `forfeit` and `releaseForfeiture`
  as `enforcementAction` kinds
- `thawWallet` leaves forfeited accounts frozen and thaws the rest

## Policy authority held by a multisig

The `VigilantisClient` methods sign with the provider wallet. When the policy authority is a
multisig, build the instruction with the multisig's address as `authority` and propose it there:

```ts
// 1. Today's authority proposes the multisig vault; nothing changes yet.
await client.proposeAuthority(mint, vault);

// 2. The multisig accepts: put this instruction in a multisig transaction and execute it.
const accept = await client.acceptAuthorityInstruction(mint, vault, currentAuthority);

// 3. From then on, every change is a multisig transaction, for example:
const block = await client.listInstruction({ mint, wallet, list: "block", action: "add", authority: vault });
```

The handover takes two steps so that a mistyped address cannot lock the policy: until the new
authority signs `accept`, the old one stays in charge and can `cancelAuthorityTransfer`.

The command line below does the same with `--multisig <vault>`: it prints each transaction for
Squads to import instead of sending it.

## Command line

The package installs a `vigilantis` command for the same operations, for compliance staff and for
scripts. Every command is a thin layer over `VigilantisClient`.

```bash
npx vigilantis help
npx vigilantis status <mint>
npx vigilantis check <mint> <wallet>
npx vigilantis block add <mint> <wallet> --reason sanctions --case OFAC-2026-17 --freeze
npx vigilantis pause <mint> --reason internal-review
npx vigilantis role grant <mint> <officer> --permissions block,unblock,freeze,thaw --multisig <vault>
```

- **RPC and signer:** `--url` (a URL, or `mainnet-beta`, `devnet`, `localhost`) and `--keypair`;
  without them, `VIGILANTIS_RPC_URL` and then the Solana CLI config. Keep an RPC URL with an API key
  in the environment or the config, not on the command line.
- **Why:** `--reason` (`sanctions`, `court-order`, `fraud`, ... or a number) and `--case <id>` are
  recorded with the action. They are optional, so a freeze, a block or a pause during an incident
  never waits for paperwork; give them whenever you can, because they cannot be added afterwards.
  `seize` and `forfeit` need both; `seizure close` and `forfeiture release` need a reason. The case
  is hashed with a salt from `VIGILANTIS_CASE_SALT` or `--case-salt-file`; the salt never goes on
  the command line. `vigilantis case-ref <id>` prints the hash.
- **Multisig:** `--multisig <vault>` sends nothing and needs no keypair. It prints each transaction
  in base58, with the vault as signer, for Squads ("Add instruction", then "Import base58 encoded
  tx"). Long lists are split so each transaction leaves the multisig room for its own wrapper.
- **Scripts:** `--json` prints machine-readable output. Exit codes: 0 done; 1 failed: the RPC, a
  refused transaction (with the program's error name, for example `Unauthorized (6004)`) or nothing
  on chain to act on; 2 a mistake in the command line.

The deployment plan and the emergency procedures in the repository
([docs/deployment.md](https://github.com/softseco/vigilantis/blob/main/docs/deployment.md)) are
written with these commands.

## Freezing

A transfer hook can only refuse transfers. Burning, approving, and the confidential deposit and
withdraw never reach it. To stop a wallet completely, freeze its token accounts: Token-2022 then
refuses every instruction on them, confidential ones included, until they are thawed.

Vigilantis freezes through its freeze-authority address for the mint (`freezeAuthority(mint)`), and
only for the policy authority. Choose it when you create the mint, because Token-2022 cannot add a
freeze authority later:

```ts
import { ENFORCEMENT_REASONS, caseRef } from "@softseco/vigilantis";

await client.createCompliantMint({ mint, decimals: 2, freezeAuthority: "vigilantis" });

// Why: a reason code from your own list (or ENFORCEMENT_REASONS) and a 32-byte case reference.
const why = { reasonCode: ENFORCEMENT_REASONS.fraud, caseRef: caseRef("CASE-2026-0042", secretSalt) };

await client.blockAndFreezeWallet(mint.publicKey, suspect, why); // blocklist + freeze its accounts
await client.thawWallet(mint.publicKey, suspect, { ...why, reasonCode: ENFORCEMENT_REASONS.caseClosed });
await client.unblockWallet(mint.publicKey, suspect, { ...why, reasonCode: ENFORCEMENT_REASONS.caseClosed });
```

A mint created with your own key as freeze authority can hand it over with
`setVigilantisAsFreezeAuthority(mint, freezeAuthoritySigner)`. Since 2.3 the policy authority can
move it on again, recording why, for example to a newer compliance program:

```ts
await client.setFreezeAuthority(mint.publicKey, successor, { reasonCode: ENFORCEMENT_REASONS.internalReview, caseRef: caseRef("MIGRATION-1", secretSalt) });
// or give it up for good: nobody can freeze the mint afterwards
await client.setFreezeAuthority(mint.publicKey, null, why);
```

From then on only `successor` can freeze, thaw or hand the authority back. Check the address
twice: Vigilantis cannot tell a mistyped one from the right one.

Freezing is per token account, and a wallet can open a new one, so block the wallet as well;
`blockAndFreezeWallet` does both, the block and the first accounts in one transaction.

Each of these emits an `enforcementAction` event with the mint, the wallet, the token account, the
action, the reason code, the case reference and the authority that signed. Vigilantis does not
interpret the reason code. `caseRef` hashes your case number with a salt, so no case number or
personal data goes on-chain; keep the salt secret, or short case numbers can be found from their
hashes by trying them all.

## Roles

The policy authority does not have to do every enforcement action with its own key. It can give an
address a role with some of nine permissions: `allowlist`, `block`, `unblock`, `freeze`, `thaw`,
`pause`, `resume`, `seize`, `closeSeizure`. The holder can then do exactly those actions on that one
mint; the policy authority can still do all of them. Only the policy authority changes the rules,
the meta list, the authorities and the roles.

```ts
import { PERMISSIONS } from "@softseco/vigilantis";

await client.grantRole(mint.publicKey, officer, PERMISSIONS.freeze | PERMISSIONS.block);
await client.updateRole(mint.publicKey, officer, PERMISSIONS.freeze);
await client.revokeRole(mint.publicKey, officer);

// The officer, with its own provider:
await officerClient.freezeTokenAccount(mint.publicKey, tokenAccount, why);
await officerClient.renounceRole(mint.publicKey, officerKeypair); // e.g. when its key may be stolen
```

One role per person, each on its own hardware key, with the fewest permissions that do the job. A
stolen role key can do what the role allows until the policy authority revokes it.

A handover of the policy (`proposeAuthority`, `acceptAuthority`) ends every role granted before it.
The new authority brings back the ones it wants with `updateRole`; `listRoles` shows the others with
`active: false` until they are revoked.

## Pause

A mint created with Token-2022's Pausable extension, with Vigilantis as its pause authority, can be
stopped as a whole: no transfers, mints or burns, confidential ones included, until it resumes.
Freezing and thawing still work while it is paused. Pausable cannot be added to an existing mint.

```ts
await client.createCompliantMint({ mint, decimals: 2, freezeAuthority: "vigilantis", pausable: true });
await client.pause(mint.publicKey, { reasonCode: ENFORCEMENT_REASONS.internalReview, caseRef: caseRef("INCIDENT-7", secretSalt) });
await client.getPauseState(mint.publicKey); // { authority, paused: true }
await client.resume(mint.publicKey, { reasonCode: ENFORCEMENT_REASONS.caseClosed, caseRef: caseRef("INCIDENT-7", secretSalt) });
```

`setPauseAuthority(mint, successor | null, why)` hands the pause authority on, or gives it up, like
`setFreezeAuthority`.

## Seizure

Under a court order, Vigilantis can burn the public balance of a token account it froze. The mint
needs a permanent delegate held by Vigilantis, chosen when the mint is created; explorers show that
a mint has one.

```ts
await client.createCompliantMint({ mint, decimals: 2, freezeAuthority: "vigilantis", permanentDelegate: true });

const order = { reasonCode: ENFORCEMENT_REASONS.courtOrder, caseRef: caseRef("CASE-2026-0042", secretSalt) };
await client.freezeTokenAccount(mint.publicKey, tokenAccount, order);
// ... at least 24 hours later (SEIZE_DELAY_SECONDS), the same for everyone:
await client.getFreezeRecord(mint.publicKey, tokenAccount); // { frozenAt, seizableFrom, ... }
await client.seize(mint.publicKey, tokenAccount, order);

// When the case is settled:
await client.closeSeizure({ mint: mint.publicKey, tokenAccount, caseRef: order.caseRef, outcome: "paidToVictim", reasonCode: ENFORCEMENT_REASONS.caseClosed });
```

`seize` thaws the account, burns its whole public balance and freezes it again, in one instruction.
It refuses an account that is not frozen, one frozen less than 24 hours ago or before 1.0 (thaw and
freeze it again), an empty one, a mint that is paused, and an all-zero case reference. A thaw
deletes the freeze record, so a new freeze starts the 24 hours again. Nothing is moved to anyone:
the reserve behind the burnt tokens stays with the issuer, and paying out under the judgment is the
issuer's own step. Tokens held confidentially are encrypted and cannot be seized, only frozen.

The seizure stays open in a `SeizureRecord` (`getSeizure`, `listSeizures`) until `closeSeizure`
records how it ended: `returnedToOwner`, `paidToVictim`, `paidToState` or `other`.

## Forfeiture

A confidential balance cannot be seized, and a case can end with nothing to burn. `forfeit` closes
such a case on the record: the account, frozen through Vigilantis at least 24 hours before, gets a
`ForfeitureRecord`, and from then on no thaw gets past it, whoever signs. Nothing is burnt or
moved; the tokens stay in the supply, and the issuer reports them apart from the supply in
circulation.

```ts
import { amountCommitment } from "@softseco/vigilantis";

// The amount, worked out with the auditor key, committed to without making it public:
const commitment = amountCommitment(forfeitedAmount, secretAmountSalt);
await client.forfeit(mint.publicKey, tokenAccount, order, commitment);

await client.getForfeiture(mint.publicKey, tokenAccount); // { caseRef, amountCommitment, forfeitedAt, ... }
await client.listForfeitures(mint.publicKey);

// After an appeal, the admin (never a role) releases it; a thaw then works again:
await client.releaseForfeiture(mint.publicKey, tokenAccount, ENFORCEMENT_REASONS.caseClosed);
```

A role with `seize` can forfeit. Only the policy authority releases a forfeiture, so keep that key
in a multisig. Forfeiture is per token account; the wallet's blocklist entry keeps it from using a
new one. Vigilantis does not check the commitment: it is SHA-256 of the salt and the amount as eight
little-endian bytes, which the issuer can open to a court or an auditor by showing both.

## Confidential transfers

Token-2022 invokes a transfer hook for a **confidential** transfer with `amount = u64::MAX`, because
the real amount is encrypted and never reaches the hook. A per-transfer limit therefore cannot be
checked against it.

Vigilantis does not quietly skip the limit — that would leave a policy that reads as enforced but is
not. On a mint that sets `maxTransferAmount`, a confidential transfer is refused with
`ConfidentialAmountNotEnforceable` (error 6005) unless the policy sets `allowConfidential: true`,
which is the issuer accepting, explicitly, that the limit does not reach those transfers. With
`maxTransferAmount: 0` there is no limit to be unenforceable, so the flag is irrelevant.

The allowlist and blocklist work on **addresses**, which stay public, so they apply to confidential
transfers exactly as they do to public ones. To watch the amounts of confidential transfers, give
the mint an auditor key: the auditor decrypts every amount off-chain (see Arcantis,
`@softseco/arcantis`, published until now as `@softseco/confidential-transfers`). `getPolicy(mint)` returns `allowConfidential` alongside
the other fields.

## License

Business Source License 1.1, the same as the program; see [LICENSE](./LICENSE). Using the SDK
with the Vigilantis program Softseco deploys is free for everyone; deploying your own copy needs
a commercial license (developers@softseco.com). The repository's COMMERCIAL-LICENSE.md says it
in plain words.
