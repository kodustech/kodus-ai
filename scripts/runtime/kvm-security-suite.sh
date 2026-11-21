#!/usr/bin/env bash
# Runs the microVM security suite (S-01..S-52 on Firecracker), the conformance
# cases, the reaper, the per-VM limits and the rest of test/fcregress on a KVM
# host, then checks the host is left clean. It is what a CI job on a KVM
# runner runs (.github/workflows/runtime-kvm-security.yml), and what an
# operator runs by hand on the KVM test host. See
# docs/runtime/isolation-architecture.md, "Security suite on a KVM host".
#
# Usage (as root, from the repository root, on a host with /dev/kvm):
#   scripts/runtime/kvm-security-suite.sh [-k KIT_DIR] [-s STATE_DIR] [-r REGEX] [-o OUT_DIR]
#     -k  the microVM kit to test (default: build it from this tree into OUT_DIR/kit)
#     -s  the state directory: XFS with reflink, direct I/O if on a loop device
#         (default /mnt/xfs/kody-e2e)
#     -r  go test -run regex (default: every fcregress test)
#     -o  where the log, the summary and a built kit go (default ./kvm-suite-out)
# Optional: KODY_E2E_KRSHOP_BASE / KODY_E2E_KRSHOP_PR (and *_SHA) run the demo-shop cases.
#
# Exit: 0 when every test passed and nothing of a machine is left on the host.
set -euo pipefail

KIT="" STATE="/mnt/xfs/kody-e2e" RUN="" OUT="./kvm-suite-out"
while getopts "k:s:r:o:" o; do
	case "$o" in
	k) KIT=$OPTARG ;;
	s) STATE=$OPTARG ;;
	r) RUN=$OPTARG ;;
	o) OUT=$OPTARG ;;
	*) sed -n '2,20p' "$0"; exit 2 ;;
	esac
done

fail() { echo "kvm-suite: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root (the jailer, cgroups, taps and namespaces)"
[ -c /dev/kvm ] || fail "no /dev/kvm: a bare-metal host or one with nested virtualization"
command -v go >/dev/null || fail "no go on PATH"
command -v nft >/dev/null && command -v ip >/dev/null || fail "nftables and iproute2 are required"
mkdir -p "$OUT" "$STATE"
OUT=$(cd "$OUT" && pwd)
[ "$(stat -f -c %T "$STATE")" = xfs ] || echo "kvm-suite: $STATE is not on XFS; the backend refuses a state directory without reflink" >&2
dev=$(findmnt -n -o SOURCE --target "$STATE" || true)
if [[ "$dev" == /dev/loop* ]] && [ "$(cat "/sys/block/${dev#/dev/}/loop/dio")" != 1 ]; then
	fail "$STATE is on $dev without direct I/O (losetup --direct-io=on $dev)"
fi

if [ -z "$KIT" ]; then
	KIT="$OUT/kit"
	rm -rf "$KIT"
	echo "kvm-suite: building the kit from this tree into $KIT"
	docker buildx bake --allow=fs.write="$OUT" runtime-microvm-kit \
		--set "runtime-microvm-kit.output=type=local,dest=$OUT" >"$OUT/kit-build.log" 2>&1 ||
		{ tail -30 "$OUT/kit-build.log" >&2; fail "the kit did not build"; }
fi
DIGEST=$(cat "$KIT/DIGEST")

left() {
	local n=0
	n=$((n + $(pgrep -c -x firecracker || true)))
	n=$((n + $(find /sys/fs/cgroup/kodus-microvm -maxdepth 1 -name 'kfc-*' 2>/dev/null | wc -l)))
	n=$((n + $(ip -o link show | grep -c -E ': (kft|kfb)' || true)))
	n=$((n + $(ip netns list | grep -c '^kfn' || true)))
	echo "$n"
}
before=$(left)
[ "$before" = 0 ] || echo "kvm-suite: the host already holds $before machine traces before the run" >&2

args=(-count=1 -timeout 60m -v)
[ -n "$RUN" ] && args+=(-run "$RUN")
cd apps/runtime-cell
set +e
env PATH="$PATH" HOME="${HOME:-/root}" GOFLAGS=-mod=mod \
	KODY_E2E_FIRECRACKER=1 KODY_E2E_FIRECRACKER_KIT="$KIT" KODY_E2E_FIRECRACKER_KIT_DIGEST="$DIGEST" KODY_E2E_FIRECRACKER_STATE="$STATE" \
	go test "${args[@]}" ./test/fcregress/ >"$OUT/fcregress.log" 2>&1
code=$?
set -e
cd - >/dev/null

after=$(left)
oom=$(dmesg 2>/dev/null | grep -c 'Killed process .*(firecracker)' || true)
{
	echo "kit $DIGEST"
	echo "exit $code"
	echo "machine traces left $after (before $before)"
	echo "VMMs OOM-killed since boot $oom"
	grep -E '^(--- |ok|FAIL)' "$OUT/fcregress.log" || true
	grep -E '^    --- FAIL' "$OUT/fcregress.log" || true
	grep -E 'EVIDENCE' "$OUT/fcregress.log" | cut -c1-400 || true
} | tee "$OUT/summary.txt"
[ "$code" = 0 ] || exit "$code"
[ "$after" -le "$before" ] || fail "the run left $after machine traces on the host"
