# Vigilantis: deployment plan and runbook

Written on 30 October 2026, before the `v1.0.0-rc.1` tag. Nothing is deployed on mainnet, and
nothing will be before an independent audit: Vigilantis is self-audited, not independently
audited. This page is the plan for devnet and, after the audit, mainnet: who holds which key, how a
build is verified, how the program is deployed and upgraded through a multisig, and what to do when
something goes wrong. The commands use the `vigilantis` CLI from `@softseco/vigilantis` (after
`npm install @softseco/vigilantis`, `npx vigilantis help` lists them), `solana` from Agave 4.2.2 and
`solana-verify` 0.5.2. The CLI takes the RPC from `VIGILANTIS_RPC_URL` or the Solana CLI config;
keep a URL with an API key in it off the command line, where the shell history would keep it.

## Keys and authorities

| What | Held by | Notes |
|---|---|---|
| Program ID keypair | Joachim, offline | Generated once per deployment (devnet and mainnet get different IDs). Needed only for the first deploy; it has no power after that. Never committed, never copied to a server. |
| Deployer key | Joachim's machine, hot | Pays for the deploy and the upgrade buffers. Holds only the SOL that needs. Is the upgrade authority for the minutes between the deploy and the handover below. |
| Program upgrade authority | Softseco's Squads multisig vault (mainnet); the deployer key is acceptable on devnet | Can replace the program, so it is the most powerful key in the system. |
| Policy authority of a mint | The issuer, ideally its own multisig | Changes the rules, grants roles, hands the freeze and pause authorities on. Vigilantis's two-step handover lets it move to a multisig safely. |
| Transfer-hook authority of a mint | The issuer's multisig, or nobody | Can point the mint at another hook, or none, which switches every rule off. `createCompliantMint` gives it to the provider wallet unless told otherwise; hand it on with `spl-token authorize <MINT> transfer-hook-program-id <ISSUER_VAULT>`, or give it up with `--disable`. |
| Role holders | Compliance staff, each on a hardware wallet | Only the permissions they need (see "Roles" below). The `vigilantis` command line reads keypair files only and cannot sign with a hardware wallet yet; until it can, an officer on a hardware wallet acts through the SDK with a wallet adapter, or through the multisig. |
| Freeze authority, pause authority, permanent delegate of a mint | Vigilantis's addresses for that mint (`["freeze-authority", mint]` and so on) | Nobody holds a key for these; the program signs for them when the policy authority or a role asks. |

The upgrade authority and an issuer's policy authority are different multisigs. Softseco's own
token (eUSD) gets a policy multisig of its own, separate from the upgrade authority.

## The multisig (Squads v4)

- Members: three hardware wallets, kept in three places. Threshold: two of three. A single lost
  or stolen device can neither upgrade the program nor block upgrades.
- Every member checks what they sign: the buffer hash for an upgrade (see below), the decoded
  instruction for anything else. Squads shows the instructions of a proposal before the vote.
- Time lock: Squads can delay execution after approval. A delay gives users time to react to an
  upgrade, and it also delays a security fix by the same amount. Decide before mainnet; until
  then, none.
- Test the whole flow on devnet with the same members and devices before mainnet: an upgrade from a
  buffer, a policy handover, and a few CLI exports.

The `vigilantis` CLI never needs a multisig member's key. With `--multisig <vault>` it builds the
transaction with the vault as the signer and prints it in base58, which Squads imports ("Add
instruction", then "Import base58 encoded tx"). Proposing, voting and executing then happen in
Squads.

## Verified build

The program that runs on chain must be the program built from a public, tagged commit, and anyone
must be able to check that.

1. `.github/workflows/verified-build.yml` builds the program with `solana-verify build` inside the
   Solana Foundation's Docker image for Agave 4.2.2 (`[workspace.metadata.cli]` in `Cargo.toml`
   picks it). It runs on every version tag, on pushes to `main` that touch the program, and by
   hand. It checks the embedded security.txt and, on a tag, that the tag matches the crate
   version.
2. The run's summary shows the executable hash, and the run keeps `vigilantis.so` and its hashes
   as an artifact. Record the hash in the release notes of the tag.
3. To reproduce it on another machine (Docker needed):
   ```bash
   git checkout v1.0.0-rc.1
   solana-verify build --library-name vigilantis
   solana-verify get-executable-hash target/deploy/vigilantis.so   # must equal the CI hash
   ```
4. Deploy the artifact from that CI run, not a local `anchor build`: SBF builds outside the Docker
   image do not come out byte for byte the same.

Before building for a cluster, check whether SIMD-0500 is active there
(`solana feature status B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g -u <cluster>`). Once it is,
the cluster refuses new deployments of SBPF v0 to v2 binaries, which is what the default build
produces. The build would then need a newer SBPF version (`solana-verify build --arch ...`, with
the same `--arch` in every later verification command) and a full test run on that build first.

## First deployment

Devnet first, with a new program ID: the Sentinel program at
`5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD` stays as it is, and is never upgraded to
Vigilantis. Mainnet repeats the same steps with its own ID, after the audit.

**1. The program ID, in the source before the tag.** The ID is compiled into the program
(`declare_id!`), so it has to be in the commit that gets tagged and built. For devnet this is
done: since 1.0.0-rc.1, `4DoDFZJmJWYuBx86UqXi3y24GkQ3Cq4nUBHZwDE5PQM5` is in `declare_id!`
(`programs/vigilantis/src/lib.rs`), in `Anchor.toml` (localnet and devnet) and in the IDL, whose
`address` is the ID the SDK uses. Its keypair is kept offline, outside every repository. For
mainnet, the same with a new keypair:

```bash
solana-keygen new --no-bip39-passphrase --silent -o <offline folder>/vigilantis-mainnet.json
solana-keygen pubkey <offline folder>/vigilantis-mainnet.json
```

`--silent` keeps the seed phrase off the screen: the file is the key, and a phrase shown in a
terminal ends up in logs and screenshots. Only the address leaves that folder.

The commands below name the two keypairs with two variables. The Solana CLI cannot read a keypair
whose path contains a space ("unrecognized signer source"), so link such a file from a path
without one:

```bash
ln -sf "<offline folder>/<program keypair>.json" /tmp/program.json
ln -sf "<offline folder>/<deployer keypair>.json" /tmp/deployer.json
PROGRAM_KEYPAIR=/tmp/program.json
DEPLOYER=/tmp/deployer.json
```

**2. Tag and build.** Bump the version, tag `v1.0.0-rc.1`, push the tag to the public
`vigilantis` repository, and wait for the verified build. Download its artifact.

```bash
solana-verify get-executable-hash vigilantis.so    # the hash in the CI summary
bash scripts/check-security-txt.sh vigilantis.so
```

**3. Deploy.** The program account needs rent for its size (about 556 KB today; `solana rent
556000` gives the exact figure, roughly 3.9 SOL). The deploy writes a buffer first, so the deployer
needs about twice that for a moment; the buffer's lamports come back at the end.

```bash
solana program deploy vigilantis.so \
  --program-id "$PROGRAM_KEYPAIR" \
  --keypair "$DEPLOYER" \
  --upgrade-authority "$DEPLOYER" \
  --with-compute-unit-price 10000 \
  -u devnet
```

**4. Check what landed.**

```bash
solana-verify get-program-hash <PROGRAM_ID> -u devnet    # must equal the CI hash
solana program dump <PROGRAM_ID> onchain.so -u devnet
bash scripts/check-security-txt.sh onchain.so
```

If the hash differs, stop and find out why before anything else touches the program.

**5. Hand the upgrade authority to the multisig vault.** On devnet this step can wait; on mainnet
it follows the deploy at once.

```bash
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <VAULT> --skip-new-upgrade-authority-signer-check \
  --keypair "$DEPLOYER" -u devnet
solana program show <PROGRAM_ID> -u devnet    # Authority: <VAULT>
```

**6. Publish the verification.** The verification record is written by the upgrade authority, so
with a multisig it goes through Squads:

```bash
solana-verify export-pda-tx https://github.com/softseco/vigilantis \
  --program-id <PROGRAM_ID> --uploader <VAULT> \
  --commit-hash <TAGGED_COMMIT> --library-name vigilantis -u devnet
# import the printed transaction in Squads, approve, execute; then:
solana-verify remote submit-job --program-id <PROGRAM_ID> --uploader <VAULT>
solana-verify remote get-status --program-id <PROGRAM_ID>
```

While the deployer is still the authority (devnet), `solana-verify verify-from-repo` with the same
arguments and `--keypair "$DEPLOYER"` writes the record directly.

**7. Update the SDK and the docs** with the new program ID, and keep a record of the deployment
(see the end of this page).

## Upgrades

1. The change is merged with CI green, and an upgrade check shows that the new program reads
   every account the previous release wrote: the previous release built from its tag, a mint set
   up under it, then upgraded in place on a local validator. The first upgrade of Vigilantis brings
   that check back for its own releases (Sentinel's, from 2.0.2 and 2.1.0, ended with the new
   program ID). Accounts only grow at the end; fields are never reordered or reused.
2. Tag it. The verified build gives the new hash.
3. Write the new binary to a buffer and give the buffer to the vault:
   ```bash
   solana program write-buffer vigilantis.so --keypair "$DEPLOYER" -u <cluster>
   solana-verify get-buffer-hash <BUFFER> -u <cluster>    # must equal the CI hash
   solana program set-buffer-authority <BUFFER> --new-buffer-authority <VAULT> \
     --keypair "$DEPLOYER" -u <cluster>
   ```
   If the new binary is larger than the program account, the account has to be extended first
   (`solana program extend`); depending on the cluster's features the upgrade authority has to
   sign that too, so it goes through the multisig as well.
4. Propose the upgrade in Squads (Developers, Programs: the buffer, and a spill address for the
   buffer's rent). Each member runs `solana-verify get-buffer-hash <BUFFER>` and compares it with
   the CI summary before approving.
5. After execution: `solana-verify get-program-hash` equals the CI hash; publish the new
   verification (step 6 above) for the new commit.
6. Mints set up before a change to the meta list need `vigilantis meta-list update <mint>`, signed
   by their policy authority (`--multisig` for a vault).

A rollback is an upgrade to the previous tag's verified build. It works only if the previous
version can read what the new one wrote, so before each upgrade decide whether a rollback is
possible and write it in the release notes.

## Setting up a mint for an issuer

```bash
vigilantis policy init <MINT> --blocklist on            # signed by the mint authority
vigilantis meta-list init <MINT>
vigilantis authority propose <MINT> <ISSUER_VAULT>
vigilantis authority accept <MINT> --multisig <ISSUER_VAULT>    # import in Squads, approve, execute
vigilantis status <MINT>                                # Policy authority: <ISSUER_VAULT>
spl-token authorize <MINT> transfer-hook-program-id <ISSUER_VAULT>   # or --disable: nobody
```

A handover of the policy ends every role granted before it. After `authority accept`, the new
authority brings back the roles it wants to keep with `vigilantis role update`, and
`vigilantis role list` shows the others as inactive until they are revoked.

The mint itself is created with Vigilantis as its transfer hook and, for freezing, pausing and
seizure, with Vigilantis's freeze authority, Pausable extension and permanent delegate
(`createCompliantMint` in the SDK). Token-2022 cannot add the freeze authority, the Pausable
extension or the permanent delegate to a mint later.

Holders use associated token accounts. Vigilantis refuses transfers to or from a token account
whose owner can change, so a program that keeps the token in its own vault (a pool, an escrow)
must create that account with Token-2022's `InitializeImmutableOwner` before `InitializeAccount3`.

### Roles

| Role | Permissions | Key |
|---|---|---|
| Compliance officer | `block,unblock,freeze,thaw` | A hardware wallet per person |
| Incident lead | `pause,resume` | A hardware wallet |
| Onboarding system (after KYC) | `allowlist` | A hot key on the issuer's server; it can do nothing else |
| Seizure | stays with the multisig | Seizure burns a balance; it waits 24 hours after the freeze anyway |

```bash
vigilantis role grant <MINT> <OFFICER> --permissions block,unblock,freeze,thaw --multisig <ISSUER_VAULT>
vigilantis role list <MINT>
```

## Emergency procedures

Every enforcement command records a reason and, with `--case`, a case reference in the
`EnforcementAction` event. The salt for `--case` comes from `VIGILANTIS_CASE_SALT` or
`--case-salt-file`; each issuer keeps one salt, privately, for good.

**A wallet must be stopped now** (sanctions match, stolen funds, a court order). An officer runs:

```bash
vigilantis block add <MINT> <WALLET> --reason sanctions --case <CASE_ID> --freeze
vigilantis check <MINT> <WALLET>     # Blocklisted: yes; every token account frozen
```

The block and as many freezes as fit go in one transaction (six or seven, depending on who signs),
so the wallet is never blocked with its first accounts still open. If a later transaction fails,
the command lists the ones that went through; run `vigilantis freeze <MINT> <WALLET>` for the rest. A confidential balance can be frozen but not seized.

**The whole token must stop** (the issuer's mint key is compromised, a bug in the hook, a
regulator's request):

```bash
vigilantis pause <MINT> --reason internal-review --case <CASE_ID>
vigilantis status <MINT>             # Pause: PAUSED
```

A pause stops every transfer, mint and burn of the token, confidential ones included. Freezing and
thawing still work. `vigilantis resume` ends it.

**A role holder's key is lost or compromised:**

```bash
vigilantis role revoke <MINT> <HOLDER> --multisig <ISSUER_VAULT>
```

Then go through the `EnforcementAction` events that key signed and undo what should not stand
(`thaw`, `block remove`). A holder who still has the key can also give the role up with
`vigilantis role renounce <MINT>`.

**A multisig member's device is lost or compromised:** replace the member in Squads (a
configuration proposal, approved by the remaining members) before anything else.

**A vulnerability in the program** (reported as in SECURITY.md, or found by us): Vigilantis has
no switch that stops every mint at once, by design. Issuers can pause their own mints; tell them
directly if the bug lets through transfers their policy should refuse. The fix goes out as an
upgrade (above), from a tag, with a verified build, through the multisig.

**The hash on chain is not the hash of the last tag:** stop. Check `solana program show
<PROGRAM_ID>` for the authority and the last deployed slot, and Squads for the executed
proposals. An upgrade nobody proposed means the upgrade authority is compromised: tell the issuers
to pause their mints, and treat it as an incident.

## Later decisions

- Making the program immutable (`solana program set-upgrade-authority <PROGRAM_ID> --final`):
  no more upgrades, so no more fixes. Not before the audit and a long, quiet time on mainnet.
- Publishing the IDL on chain. The SDK ships it, so nothing depends on it.
- Automating upgrades from CI with a Squads proposal step (the Solana Foundation's
  `squads-program-action` does the buffer, the proposal and the verification record).

## Before mainnet

- [ ] Independent audit done, its findings fixed, the report linked from SECURITY.md and from
      `auditors` in the program's security.txt.
- [ ] A new mainnet program ID in the source; the tag; the verified build's hash in the release
      notes.
- [ ] The Squads multisig set up and tested on devnet with the same devices: an upgrade from a
      buffer, a policy handover, `--multisig` exports of a block, a freeze and a pause.
- [ ] After the deploy: the hash on chain equals the CI hash; the upgrade authority is the vault;
      the verification record published and the remote job shows the program as verified; the
      security.txt read back from chain.
- [ ] This runbook rehearsed on devnet: block and freeze, pause and resume, revoke a role, an
      upgrade.

## Deployment record

Keep one row per deployment and upgrade.

| Date | Cluster | Program ID | Tag and commit | CI run | Executable hash | Deploy or upgrade tx | Authority handover tx | Verification record tx |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
