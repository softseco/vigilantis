#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
#
# Print the security.txt embedded in a built Vigilantis program and check it: the required fields are
# there, `source_release` matches the crate version, and the email it names is the one SECURITY.md
# gives. Works on a local build or on a program dumped from a cluster.
#
#   bash scripts/check-security-txt.sh                       # target/deploy/vigilantis.so
#   bash scripts/check-security-txt.sh path/to/vigilantis.so
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SO="${1:-$ROOT/target/deploy/vigilantis.so}"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/programs/vigilantis/Cargo.toml" | head -n 1)"

python3 - "$SO" "$VERSION" "$ROOT/SECURITY.md" <<'EOF'
import re, sys

so, version, security_md = sys.argv[1], sys.argv[2], sys.argv[3]
data = open(so, "rb").read()
begin, end = b"=======BEGIN SECURITY.TXT V1=======\0", b"=======END SECURITY.TXT V1=======\0"
start = data.find(begin)
if start < 0:
    sys.exit(f"{so}: no security.txt found")
stop = data.find(end, start)
if stop < 0:
    sys.exit(f"{so}: security.txt has no end marker")
parts = data[start + len(begin):stop].split(b"\0")[:-1]
if len(parts) % 2:
    sys.exit(f"{so}: security.txt has a key without a value")
fields = {parts[i].decode(): parts[i + 1].decode() for i in range(0, len(parts), 2)}
for key, value in fields.items():
    print(f"{key:20} {value}")

problems = [f"missing {key}" for key in ("name", "project_url", "contacts", "policy") if not fields.get(key)]
if fields.get("source_release") != f"v{version}":
    problems.append(f"source_release is {fields.get('source_release')!r}, the crate is v{version}")
emails = re.findall(r"email:([^,]+)", fields.get("contacts", ""))
policy_text = open(security_md).read()
problems += [f"{email} is not in SECURITY.md" for email in emails if email not in policy_text]
if problems:
    sys.exit("security.txt check failed: " + "; ".join(problems))
print("security.txt OK")
EOF
