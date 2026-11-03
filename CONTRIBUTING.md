# Contributing

Thanks for your interest in Vigilantis. This repository holds two pieces that are released together:

- **Program** (`programs/vigilantis`) — the Anchor/Token-2022 transfer-hook program
- **TypeScript SDK** (`sdk/`) — `@softseco/vigilantis`

## Prerequisites

- **Rust** (stable) with `rustfmt` and `clippy`
- **Solana CLI** 4.x (tested on 4.2.2) and its `solana-test-validator`; the confidential-transfer
  tests do not run on 2.x or 3.x
- **Anchor** 0.31.0, installed through `avm`
- **Node ≥ 20** and npm

## Program

```bash
anchor build -- --tools-version v1.57   # see "Build requirements" below
RUSTC_BOOTSTRAP=1 anchor idl build -o sdk/src/idl/vigilantis.json -t sdk/src/idl/vigilantis.ts   # see below
cargo fmt --all --check
cargo clippy -p vigilantis --all-targets -- -D warnings
```

### Build requirements

- **The IDL** is built with `RUSTC_BOOTSTRAP=1`: anchor 0.31.1's IDL build needs proc-macro2's span
  features, which stable Rust keeps behind that switch. Without it the build fails with "cannot find
  value `mint` in this scope". Solana's platform-tools compiler is a dev build and needs no switch.

`anchor build` invokes the Solana SBF toolchain. The default platform-tools build (**v1.48**) ships
Cargo 1.84, which cannot parse `edition2024` manifests, so any dependency that has moved to
edition 2024 fails to build. Two things follow:

- Build with **platform-tools v1.57**: `anchor build -- --tools-version v1.57`. Solana CLI 4.2.2
  ships platform-tools v1.54 as its default, which is also new enough, so a plain `anchor build`
  works there (CI uses it).
- `Cargo.lock` pins **`blake3 = 1.5.5`**. Later blake3 pulls `cpufeatures 0.3.x`, which is
  edition 2024. Do not bump it without also confirming the toolchain version above.

The `--tools-version` flag is forwarded to the IDL step's `cargo test` invocation, where it is not a
valid argument, so run `anchor idl build` as a separate command (as above) rather than relying on the
IDL that `anchor build` would emit.

### Lints

`programs/vigilantis/Cargo.toml` carries a `[lints.rust]` table. Anchor's `#[program]` and
`#[derive(Accounts)]` macros expand to code guarded by cfgs that exist only in the SBF build
(`target_os = "solana"`) or as Anchor's own opt-in features (`custom-heap`, `custom-panic`,
`anchor-debug`), and to a call to the deprecated `AccountInfo::realloc`. On a host-target clippy run
all of these surface as errors under `-D warnings`, and none of them come from this crate.

The cfgs are **declared**, not blanket-allowed, so a genuinely misspelled cfg still fails.
`deprecated = "allow"` is blunter — it is scoped to this crate and should be removed once Anchor's
generated code moves to `AccountInfo::resize`. Until then, check deprecations by eye when touching
the program.

## Tests

```bash
anchor test --skip-build   # 66 integration tests against a local validator
```

`anchor test` deploys `target/deploy/vigilantis.so` to a fresh local validator, so run a successful
`anchor build` first; `--skip-build` then reuses that artifact and avoids rebuilding with the default
toolchain.

`tests/confidential.ts` makes real confidential transfers. It needs `solana-test-validator` from
Agave 4.x first in `PATH` (2.x and 3.x reject today's ZK proofs), and the validator that
`anchor test` starts loads a newer Token-2022 from `tests/fixtures/`, which `Anchor.toml` sets up.
See [`tests/fixtures/README.md`](./tests/fixtures/README.md).

`bash scripts/mainnet-token-2022.sh` dumps the Token-2022 program deployed on mainnet and runs the
integration and fuzz tests against it instead of the pinned build in `tests/fixtures`. It reads
mainnet through the public RPC endpoint (or `RPC_URL`, which it never prints). A separate workflow
runs it every Monday.

`bash scripts/check-security-txt.sh` prints the security.txt embedded in the built program and
checks it against the crate version and `SECURITY.md`. CI runs it after every build.

`tests-fuzz/` is a separate Cargo project: model-based fuzzing of the built program in LiteSVM
(`cd tests-fuzz && cargo test --test model -- --nocapture`, after `anchor build`). See its README
for the settings and for reproducing a failure from its seed.

CI runs the same build and test suite on every push and pull request, and fails if the committed IDL
in `sdk/src/idl/` no longer matches what `anchor idl build` produces from the program. It also runs
`cargo audit` on `Cargo.lock`.

## SDK

```bash
cd sdk
npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsup → dist/
```

The SDK reads the program interface from `sdk/src/idl/vigilantis.json` and `sdk/src/idl/vigilantis.ts`.
Both are generated — regenerate them with `anchor idl build` (above) whenever the program's
instructions, accounts or errors change, and commit the result in the same change.

## Conventions

- Every source file carries `// SPDX-License-Identifier: BUSL-1.1`.
- Program errors are append-only: add new variants at the end of `VigilantisError` so existing error
  codes keep their meaning for deployed clients.
- Changes that alter on-chain account layout, instruction arguments or error codes are breaking and
  belong in a major version, with a `CHANGELOG.md` entry naming the migration.
