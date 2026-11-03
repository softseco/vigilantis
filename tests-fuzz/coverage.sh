#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
#
# Line coverage of the program under the fuzz tests.
#
# Builds Vigilantis unoptimized with debug information, runs the fuzz tests with LiteSVM recording
# every instruction Vigilantis executes, and maps those traces back to lines of
# programs/vigilantis/src/lib.rs with sbpf-coverage (https://github.com/LimeChain/sbpf-coverage).
# Traces are large (about 1.5 GB per 8 cases), so the run goes in chunks and keeps only the
# per-chunk lcov files.
#
#   cargo install sbpf-coverage --version 0.2.12 --locked     # once
#   bash tests-fuzz/coverage.sh                               # from the repository root
#   CHUNKS=12 CASES=8 bash tests-fuzz/coverage.sh
#   SBF_ARGS="--tools-version v1.57" bash tests-fuzz/coverage.sh   # extra cargo build-sbf flags
#
# Output: target/fuzz-coverage/summary.txt (lines executed, and every line never executed) and the
# lcov files in target/fuzz-coverage/lcov/ (`genhtml` turns them into an HTML report).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/target/fuzz-coverage"
CHUNKS="${CHUNKS:-6}"
CASES="${CASES:-8}"
PROGRAM_ID="$(grep -m1 '^vigilantis = ' "$ROOT/Anchor.toml" | cut -d'"' -f2)"
command -v sbpf-coverage >/dev/null || { echo "sbpf-coverage is not installed (see the top of this script)"; exit 1; }

rm -rf "$OUT/lcov" "$OUT/trace"
mkdir -p "$OUT/lcov"
echo "building an unoptimized program with debug information"
(cd "$ROOT" && CARGO_TARGET_DIR="$OUT/build" cargo build-sbf \
  --manifest-path programs/vigilantis/Cargo.toml --debug --arch v1 ${SBF_ARGS:-} >"$OUT/build.log" 2>&1) \
  || { tail -n 30 "$OUT/build.log"; exit 1; }
SO_DIR="$OUT/build/deploy/debug"

for i in $(seq 1 "$CHUNKS"); do
  echo "chunk $i of $CHUNKS ($CASES cases)"
  (cd "$ROOT/tests-fuzz" && SBF_TRACE_DIR="$OUT/trace" SBF_TRACE_FILTER="program_id == $PROGRAM_ID" \
    VIGILANTIS_SO="$SO_DIR/vigilantis.so" FUZZ_SEED="$i" FUZZ_CASES="$CASES" \
    cargo test --features coverage --test model -- --nocapture >"$OUT/fuzz-$i.log" 2>&1) \
    || { tail -n 30 "$OUT/fuzz-$i.log"; exit 1; }
  sbpf-coverage --src-path="$ROOT/programs/vigilantis/src/" --sbf-path="$SO_DIR" \
    --sbf-trace-dir="$OUT/trace" >"$OUT/sbpf-coverage-$i.log" 2>&1
  for f in "$OUT"/trace/*.lcov; do mv "$f" "$OUT/lcov/$i-$(basename "$f")"; done
  rm -rf "$OUT/trace"
done

python3 - "$OUT/lcov" "$ROOT/programs/vigilantis/src/lib.rs" >"$OUT/summary.txt" <<'PY'
import collections, glob, sys
lcov_dir, src = sys.argv[1], sys.argv[2]
hits, lines = collections.Counter(), set()
for path in glob.glob(lcov_dir + "/*.lcov"):
    current = None
    for row in open(path):
        row = row.strip()
        if row.startswith("SF:"):
            current = row[3:]
        elif row.startswith("DA:") and current and current.endswith("programs/vigilantis/src/lib.rs"):
            n, h = row[3:].split(",")[:2]
            lines.add(int(n))
            hits[int(n)] += int(h)
text = open(src).read().split("\n")
run = [n for n in lines if hits[n] > 0]
print(f"lib.rs: {len(run)} of {len(lines)} lines with code executed ({100 * len(run) / len(lines):.1f}%)")
print("never executed:")
for n in sorted(lines):
    if hits[n] == 0:
        print(f"{n:5d}: {text[n - 1]}")
PY
head -n 1 "$OUT/summary.txt"
echo "details: $OUT/summary.txt"
