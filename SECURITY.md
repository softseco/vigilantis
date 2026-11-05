# Security Policy

Vigilantis is security-sensitive, on-chain compliance software (a Token-2022 transfer hook that
gates asset transfers).

> **Maturity:** 1.0.0-rc.2, continuing Sentinel 2.3.0: self-audited, validated against a
> local validator and by model-based fuzzing. **Not independently audited and not production-proven.**
> Review carefully before any mainnet use.

## Supported versions

| Package | Version | Supported |
|---|---|---|
| Vigilantis (`@softseco/vigilantis` and the program) | `1.x` | ✅ from the first release |
| Sentinel (`@softseco/sentinel`, the earlier name) | all | ❌ (move to Vigilantis) |

## Reporting a vulnerability

Please do **not** open a public issue, pull request, or social post for security reports. Instead:

1. **GitHub private vulnerability reporting** (preferred) — on the repo, **Security** tab →
   **Report a vulnerability**.
2. **Email** — hello@softseco.com.

Please include the impact, reproduction steps / PoC, affected version(s), and any suggested fix.
We aim to acknowledge within **72 hours**.

The same contacts are embedded in the program itself as a
[security.txt](https://github.com/neodyme-labs/solana-security-txt), readable from a deployed
program with `query-security-txt <program id>` or from a build with
`bash scripts/check-security-txt.sh`.

## Self-audit

`v1.0.0` shipped after a self-audit that fixed an access-control issue on allowlist/blocklist
management and a policy-authority squatting issue (see [CHANGELOG.md](./CHANGELOG.md)).

`v2.0.0` fixed a correctness issue found in review, before any mainnet use: the per-transfer limit
compared Token-2022's confidential-transfer sentinel (`u64::MAX`) against `max_transfer_amount`,
so a limited mint could not perform confidential transfers at all. The hook now refuses such a
transfer explicitly unless the policy sets `allow_confidential`, rather than either failing
opaquely or skipping a limit that the policy still advertises as enforced.

`v2.1.0` fixed a gap found in our review, on devnet, before any mainnet use: the blocklist did not
cover the authority signing a transfer, so a blocklisted delegate could move a clean holder's
tokens. `v2.1.1` fixed another, found while preparing for an independent audit: a stranger could
block a new mint's setup for good by funding its meta-list address first. The review, the
invariants it checks, how they are tested and the known limits are in
[docs/threat-model.md](./docs/threat-model.md).

A self-audit is **not** a substitute for an independent audit.
