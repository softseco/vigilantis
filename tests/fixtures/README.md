# Test fixtures

## `spl_token_2022.so`

Token-2022 **v11.1.0**, built from the official source and loaded by `anchor test` in place of the
validator's bundled Token-2022 (see `[[test.genesis]]` in `Anchor.toml`).

`tests/confidential.ts` makes real confidential transfers with `@solana-program/token-2022` 0.19
(through `@softseco/confidential-transfers`). The Token-2022 that ships inside
`solana-test-validator` is older and rejects that client's confidential `Deposit` with
`InvalidInstructionData`, so the tests need a program that matches the client.

| | |
|---|---|
| Source | [solana-program/token-2022](https://github.com/solana-program/token-2022), tag `program@v11.1.0` (commit `8867f751c0f69367ba03af4f85510b5611989491`) |
| Built with | `cargo build-sbf --manifest-path program/Cargo.toml`, Solana CLI 4.2.2 (platform-tools v1.54) |
| SHA-256 | `6b76b305fae61f47e18640fb0121f0e8a85abe19d076b3c9c547c3e5eeadef4e` |

The JS client 0.19.0 was published from a commit whose program code is identical to
`program@v11.1.0` apart from the version number.

SBF builds are not byte-for-byte reproducible across toolchains, so a rebuild may hash differently.
To rebuild: `bash scripts/build-token-2022.sh`, then copy the `.so` it prints here and update the
hash above.

The validator itself must come from **Agave 4.x** (tested with 4.2.2). The ZK ElGamal Proof Program
in Agave 2.x and 3.x verifies proofs in an older format and rejects the ones `@solana/zk-sdk` makes
today, with `SigmaProof(PubkeyValidity, AlgebraicRelation)`; `tests/confidential.ts` checks the
validator's version first and says so. `Anchor.toml` also turns off the feature gate older releases
used to disable that program (`zkdoVwnSFnSLtGJG7irJPEYUpmb4i7sGMGcnN6T9rnC`); on 4.2 it makes no
difference.

## The Token-2022 on mainnet

The fixture is a pinned build, so the tests do not change when Token-2022 does. To check Sentinel
against the program that mainnet actually runs, `bash scripts/mainnet-token-2022.sh` dumps it,
prints its release (from the program's own security.txt) and hash, and runs the integration and
fuzz tests with it in place of this file. The dump goes to `target/mainnet/` and is not committed.
The `mainnet Token-2022` workflow runs the same script every Monday.
