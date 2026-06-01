#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
INSTALLER="$REPO_ROOT/site/install"

if rg -n '\./skills/|\$\{PWD\}/skills/|raw\.githubusercontent\.com/kodustech/cli/main/skills/' "$INSTALLER" >/dev/null; then
  echo "Expected site/install to be self-contained and not depend on local or GitHub-hosted skill files."
  exit 1
fi

if ! rg -n 'skills install' "$INSTALLER" >/dev/null; then
  echo "Expected site/install to delegate bundled skill installation to the CLI."
  exit 1
fi

echo "PASS: site/install is self-contained"
