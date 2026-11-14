#!/usr/bin/env bash
# Fails if any Go dependency of the cell is not MIT, Apache-2.0, BSD or ISC.
set -euo pipefail
cd "$(dirname "$0")/.."
bad=0
while read -r path version dir; do
  f=$(ls "$dir" 2>/dev/null | grep -iE '^(license|licence|copying)' | head -1 || true)
  text=""
  [ -n "$f" ] && text=$(head -c 4000 "$dir/$f" | tr '\n' ' ')
  case "$text" in
    *"Apache License"*) kind=Apache-2.0 ;;
    *"Permission is hereby granted, free of charge"*) kind=MIT ;;
    *"Redistribution and use in source and binary forms"*) kind=BSD ;;
    *"Permission to use, copy, modify, and"*"distribute this software for any"*) kind=ISC ;;
    *) kind=UNKNOWN; bad=1 ;;
  esac
  printf '%-70s %-12s %s\n' "$path" "$version" "$kind"
done < <(go list -deps -f '{{if .Module}}{{.Module.Path}} {{.Module.Version}} {{.Module.Dir}}{{end}}' ./... | sort -u | grep -v '^github.com/kodustech/')
exit $bad
