#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT INT TERM

mkdir -p "$TMPDIR/work/site"
cp "$REPO_ROOT/install.sh" "$TMPDIR/work/install.sh"
cp "$REPO_ROOT/site/install" "$TMPDIR/work/site/install"
chmod +x "$TMPDIR/work/install.sh"
chmod +x "$TMPDIR/work/site/install"

mkdir -p "$TMPDIR/work/.claude"
mkdir -p "$TMPDIR/home"
mkdir -p "$TMPDIR/mockbin"
NPM_CALLS_LOG="$TMPDIR/npm_calls.log"
KODUS_CALLS_LOG="$TMPDIR/kodus_calls.log"
mkdir -p "$TMPDIR/work/.claude/commands"
echo "legacy" > "$TMPDIR/work/.claude/commands/business-rules-validation.md"

cat > "$TMPDIR/mockbin/kodus" <<'EOF'
#!/bin/sh
printf "%s\n" "$*" >> "$KODUS_CALLS_LOG"
if [ "${1:-}" = "--version" ]; then
  echo "kodus 0.0.0-test"
  exit 0
fi

if [ "${1:-}" = "skills" ] && [ "${2:-}" = "install" ]; then
  mkdir -p "$PWD/.claude/commands"
  rm -f "$PWD/.claude/commands/business-rules-validation.md"
  cat > "$PWD/.claude/commands/kodus-business-rules-validation.md" <<'SKILL'
---
name: kodus-business-rules-validation
---
SKILL
  exit 0
fi

exit 0
EOF
chmod +x "$TMPDIR/mockbin/kodus"

cat > "$TMPDIR/mockbin/npm" <<EOF
#!/bin/sh
printf "%s\n" "\$*" >> "$NPM_CALLS_LOG"
exit 0
EOF
chmod +x "$TMPDIR/mockbin/npm"

(
  cd "$TMPDIR/work"
  HOME="$TMPDIR/home" PATH="$TMPDIR/mockbin:$PATH" KODUS_CALLS_LOG="$KODUS_CALLS_LOG" ./install.sh >/dev/null
)

TARGET="$TMPDIR/work/.claude/commands/kodus-business-rules-validation.md"
if [ ! -f "$TARGET" ]; then
  echo "Expected $TARGET to exist after install."
  exit 1
fi

if [ -f "$TMPDIR/work/.claude/commands/business-rules-validation.md" ]; then
  echo "Expected legacy business-rules-validation.md to be removed."
  exit 1
fi

if ! grep -q "name: kodus-business-rules-validation" "$TARGET"; then
  echo "Expected kodus-business-rules-validation command content in $TARGET."
  exit 1
fi

if [ ! -f "$NPM_CALLS_LOG" ] || ! grep -q '^install -g @kodus/cli$' "$NPM_CALLS_LOG"; then
  echo "Expected npm to be called with: install -g @kodus/cli"
  exit 1
fi

if [ ! -f "$KODUS_CALLS_LOG" ] || ! grep -q '^skills install$' "$KODUS_CALLS_LOG"; then
  echo "Expected kodus to be called with: skills install"
  exit 1
fi

echo "PASS: kodus-business-rules-validation command installed"
