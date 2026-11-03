#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
#
# Test Vigilantis against the Token-2022 program that runs on mainnet today, not only against the
# v11.1.0 build in tests/fixtures. The script dumps Token-2022 from mainnet, says which release it
# is (from the program's own security.txt), then runs the integration tests on a local validator
# and the fuzz tests with that binary.
#
#   bash scripts/mainnet-token-2022.sh                     # dump, integration tests, fuzz tests
#   bash scripts/mainnet-token-2022.sh --dump-only         # dump and identify only
#   bash scripts/mainnet-token-2022.sh --from-file X.so    # skip the dump, test X.so
#
# RPC: the public mainnet endpoint unless RPC_URL is set. The URL is never printed, and errors are
# shown with everything after the host masked, so a URL with an API key stays out of logs.
# Needs: solana CLI and solana-test-validator (Agave 4.x), cargo build-sbf, node and npm ci done.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN_2022="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
VIGILANTIS="4DoDFZJmJWYuBx86UqXi3y24GkQ3Cq4nUBHZwDE5PQM5"
ZK_GATE="zkdoVwnSFnSLtGJG7irJPEYUpmb4i7sGMGcnN6T9rnC"
RPC="${RPC_URL:-https://api.mainnet-beta.solana.com}"
OUT_DIR="$ROOT/target/mainnet"
SO="$OUT_DIR/spl_token_2022.so"
MODE="all"

case "${1:-}" in
  --dump-only) MODE="dump" ;;
  --from-file) SO="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; MODE="file" ;;
  "") ;;
  *) echo "usage: $0 [--dump-only | --from-file PATH]" >&2; exit 2 ;;
esac

mask() { sed -E 's#(https?://[^/[:space:]]+)[^[:space:]]*#\1/…#g'; }

mkdir -p "$OUT_DIR"
if [ "$MODE" != "file" ]; then
  echo "=== dumping Token-2022 from mainnet ==="
  rm -f "$SO"
  for attempt in 1 2 3; do
    if solana program dump --url "$RPC" "$TOKEN_2022" "$SO" > "$OUT_DIR/dump.log" 2>&1; then break; fi
    mask < "$OUT_DIR/dump.log" >&2
    [ "$attempt" = 3 ] && { echo "dump failed" >&2; exit 1; }
    sleep 5
  done
  solana program show --url "$RPC" "$TOKEN_2022" 2>&1 | grep -E "Last Deployed In Slot|Data Length" | mask || true
fi

python3 - "$SO" <<'EOF'
import hashlib, sys
data = open(sys.argv[1], "rb").read()
begin, end = b"=======BEGIN SECURITY.TXT V1=======\0", b"=======END SECURITY.TXT V1=======\0"
release = "unknown (no security.txt)"
start = data.find(begin)
if start >= 0:
    parts = data[start + len(begin):data.find(end, start)].split(b"\0")
    fields = dict(zip(parts[0::2], parts[1::2]))
    release = fields.get(b"source_release", b"unknown").decode()
print(f"Token-2022 under test: {release}, {len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()}")
EOF
[ "$MODE" = "dump" ] && exit 0

echo "=== building Vigilantis ==="
(cd "$ROOT" && cargo build-sbf --manifest-path programs/vigilantis/Cargo.toml ${SBF_ARGS:-})
# The integration tests load the IDL the way `anchor test` does.
if [ ! -f "$ROOT/target/idl/vigilantis.json" ]; then
  mkdir -p "$ROOT/target/idl" && cp "$ROOT/sdk/src/idl/vigilantis.json" "$ROOT/target/idl/vigilantis.json"
fi

echo "=== integration tests on a local validator ==="
LEDGER="$(mktemp -d)"
WALLET="$(solana address)"
solana-test-validator --reset --quiet --ledger "$LEDGER" --bind-address 127.0.0.1 \
  --deactivate-feature "$ZK_GATE" \
  --upgradeable-program "$TOKEN_2022" "$SO" "$WALLET" \
  --upgradeable-program "$VIGILANTIS" "$ROOT/target/deploy/vigilantis.so" "$WALLET" \
  > "$LEDGER/validator-stdout.log" 2>&1 &
VALIDATOR=$!
cleanup() { kill "$VALIDATOR" 2>/dev/null || true; sleep 1; rm -rf "$LEDGER"; }
trap cleanup EXIT
for _ in $(seq 1 60); do
  solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1 && break
  sleep 1
done
INTEGRATION=0
(cd "$ROOT" && ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
  ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}" \
  npx ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.ts') || INTEGRATION=$?
cleanup
trap - EXIT

echo "=== fuzz tests (LiteSVM) ==="
FUZZ=0
(cd "$ROOT/tests-fuzz" && TOKEN_2022_SO="$SO" cargo test --test model -- --nocapture) || FUZZ=$?

echo "=== summary ==="
echo "integration: $([ "$INTEGRATION" = 0 ] && echo passed || echo FAILED)"
echo "fuzz:        $([ "$FUZZ" = 0 ] && echo passed || echo FAILED)"
[ "$INTEGRATION" = 0 ] && [ "$FUZZ" = 0 ]
