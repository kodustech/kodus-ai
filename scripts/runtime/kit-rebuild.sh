#!/usr/bin/env bash
# The microVM kit's patch cadence (docs/runtime/isolation-architecture.md,
# "Kit rebuild cadence"): rebuild the kit with the latest patch of its
# pinned kernel line and Firecracker minor and fresh distribution packages,
# scan its two root file systems, run the promotion test (the KVM security
# suite and fcregress against the new kit) and write a promotion record. It
# changes nothing remote: promoting is a reviewed change of the kit's pins
# (microvm-kit/Dockerfile) and of the cells' -firecracker-kit-digest.
#
# Usage (as root on the KVM host, from the repository root):
#   scripts/runtime/kit-rebuild.sh [-o OUT_DIR] [-s STATE_DIR] [-n]
#     -o  where the candidate kit, the scan and the record go (default ./kit-candidate)
#     -s  the suite's state directory (kvm-security-suite.sh -s)
#     -n  build and scan only, no promotion test
set -euo pipefail

OUT="./kit-candidate" STATE="/mnt/xfs/kody-e2e" TEST=1
while getopts "o:s:n" o; do
	case "$o" in
	o) OUT=$OPTARG ;;
	s) STATE=$OPTARG ;;
	n) TEST=0 ;;
	*) sed -n '2,16p' "$0"; exit 2 ;;
	esac
done
fail() { echo "kit-rebuild: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root"
command -v jq >/dev/null && command -v curl >/dev/null && command -v gpg >/dev/null || fail "jq, curl and gpg are required"
DF=apps/runtime-cell/microvm-kit/Dockerfile
pinned() { sed -n "s/^ARG $1=//p" "$DF" | head -1; }
KERNEL=$(pinned KERNEL_VERSION) FC=$(pinned FIRECRACKER_VERSION)

# The newest patch of the pinned kernel line (6.1.y: Firecracker's supported
# guest kernel) and of the pinned Firecracker minor (vX.Y.z).
line=${KERNEL%.*}
NEW_KERNEL=$(curl -fsS https://www.kernel.org/releases.json |
	jq -r --arg l "$line" '[.releases[] | select(.version | startswith($l + "."))][0].version // empty')
[ -n "$NEW_KERNEL" ] || fail "no $line.y release in kernel.org's releases.json"
minor=${FC%.*}
NEW_FC=$(curl -fsS "https://api.github.com/repos/firecracker-microvm/firecracker/releases?per_page=50" |
	jq -r --arg m "$minor" '[.[] | select(.draft | not) | select(.prerelease | not) | .tag_name | select(startswith($m + "."))] | sort_by(ltrimstr("v") | split(".") | map(tonumber)) | last // empty')
[ -n "$NEW_FC" ] || fail "no $minor.z Firecracker release"
echo "kit-rebuild: kernel $KERNEL -> $NEW_KERNEL, firecracker $FC -> $NEW_FC"

# The Dockerfile checks every download against a sha256 build arg; a new
# version needs its own. The kernel's comes from kernel.org's sha256sums.asc,
# read only after its signature verifies against kernel.org's checksum
# autosigner key (https://www.kernel.org/signature.html), so a mirror or CDN
# path cannot serve a matching sum with its tarball. Firecracker's comes from
# its release's .sha256.txt (unsigned: GitHub's TLS is its only check), and
# the guest config (no published sum) is hashed at the release's tag. The
# promotion change reviews all of them.
hex64() { [[ $1 =~ ^[0-9a-f]{64}$ ]] || fail "no sha256 for $2"; printf '%s' "$1"; }
KERNEL_SIGNER=B8868C80BA62A1FFFAF5FDA9632D3A06589DA6B1
GNUPGHOME=$(mktemp -d)
export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT
gpg --batch --quiet --auto-key-locate clear,wkd --locate-keys autosigner@kernel.org >/dev/null 2>&1 ||
	fail "could not fetch kernel.org's autosigner key"
curl -fsS "https://cdn.kernel.org/pub/linux/kernel/v${NEW_KERNEL%%.*}.x/sha256sums.asc" -o "$GNUPGHOME/sums.asc"
# --decrypt writes only the signed text; VALIDSIG names the key that signed it.
gpg --batch --status-file "$GNUPGHOME/status" --output "$GNUPGHOME/sums" --decrypt "$GNUPGHOME/sums.asc" 2>/dev/null ||
	fail "kernel.org's sha256sums.asc did not verify"
awk -v k="$KERNEL_SIGNER" '$1 == "[GNUPG:]" && $2 == "VALIDSIG" && ($3 == k || $NF == k) { ok = 1 } END { exit !ok }' "$GNUPGHOME/status" ||
	fail "kernel.org's sha256sums.asc is not signed by its autosigner key"
KERNEL_SHA256=$(hex64 "$(awk -v f="linux-$NEW_KERNEL.tar.xz" '$2 == f { print $1 }' "$GNUPGHOME/sums")" "linux-$NEW_KERNEL.tar.xz")
fc_sum() {
	hex64 "$(curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/$NEW_FC/firecracker-$NEW_FC-$1.tgz.sha256.txt" |
		awk -v f="firecracker-$NEW_FC-$1.tgz" '$2 == f { print $1 }')" "firecracker-$NEW_FC-$1.tgz"
}
config_sum() {
	hex64 "$(curl -fsSL "https://raw.githubusercontent.com/firecracker-microvm/firecracker/$NEW_FC/resources/guest_configs/microvm-kernel-ci-$1-${line}.config" |
		sha256sum | cut -d' ' -f1)" "the $1 guest config at $NEW_FC"
}
# One assignment per line: set -e sees each substitution's failure.
FC_SHA256_X86_64=$(fc_sum x86_64)
FC_SHA256_AARCH64=$(fc_sum aarch64)
CONFIG_SHA256_X86_64=$(config_sum x86_64)
CONFIG_SHA256_AARCH64=$(config_sum aarch64)
PINS="KERNEL_VERSION=$NEW_KERNEL FIRECRACKER_VERSION=$NEW_FC KERNEL_SHA256=$KERNEL_SHA256"
PINS="$PINS FIRECRACKER_SHA256_X86_64=$FC_SHA256_X86_64 FIRECRACKER_SHA256_AARCH64=$FC_SHA256_AARCH64"
PINS="$PINS GUEST_CONFIG_SHA256_X86_64=$CONFIG_SHA256_X86_64 GUEST_CONFIG_SHA256_AARCH64=$CONFIG_SHA256_AARCH64"
SETS=()
for pin in $PINS; do SETS+=(--set "*.args.$pin"); done

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
rm -rf "$OUT/kit"
# --no-cache: the root file systems' distribution packages come fresh (their
# security updates), not from a cached layer of an older build.
docker buildx bake --no-cache --allow=fs.write="$OUT" runtime-microvm-kit "${SETS[@]}" \
	--set "runtime-microvm-kit.output=type=local,dest=$OUT" >"$OUT/build.log" 2>&1 ||
	{ tail -30 "$OUT/build.log" >&2; fail "the candidate kit did not build"; }
DIGEST=$(cat "$OUT/kit/DIGEST")

# Scan each root file system read-only (Trivy's rootfs scan, when present).
scan="not scanned (no trivy on PATH)"
if command -v trivy >/dev/null; then
	scan=""
	for img in "$OUT"/kit/rootfs/*.ext4; do
		mnt=$(mktemp -d)
		mount -o loop,ro,noload "$img" "$mnt"
		trivy rootfs --quiet --severity HIGH,CRITICAL --format json "$mnt" >"$OUT/scan-$(basename "$img").json" || true
		umount "$mnt"
		rmdir "$mnt"
		n=$(jq '[.Results[]?.Vulnerabilities[]?] | length' "$OUT/scan-$(basename "$img").json")
		scan="$scan$(basename "$img"): $n HIGH/CRITICAL; "
	done
fi

suite="skipped (-n)"
if [ "$TEST" = 1 ]; then
	if scripts/runtime/kvm-security-suite.sh -k "$OUT/kit" -s "$STATE" -o "$OUT/suite"; then
		suite="passed"
	else
		suite="failed"
	fi
fi
jq -n --arg digest "$DIGEST" --arg kernel "$NEW_KERNEL" --arg fc "$NEW_FC" --arg was_kernel "$KERNEL" --arg was_fc "$FC" \
	--arg scan "$scan" --arg suite "$suite" --arg at "$(date -u +%FT%TZ)" \
	'{at: $at, digest: $digest, kernel: {from: $was_kernel, to: $kernel}, firecracker: {from: $was_fc, to: $fc}, scan: $scan, promotionTest: $suite}' |
	tee "$OUT/promotion.json"
[ "$suite" != failed ] || fail "the promotion test failed: the candidate is not promoted"
echo "kit-rebuild: to promote, set these ARGs in $DF, release the kit, and pin the cells to $DIGEST:"
printf '  %s\n' $PINS
