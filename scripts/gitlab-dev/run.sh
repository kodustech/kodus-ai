#!/usr/bin/env bash
# All-in-one entry point: start GitLab, create the seeded project, open
# the review MR. For incremental work (e.g. boot now, seed later) call
# the individual scripts directly:
#
#   scripts/gitlab-dev/start.sh           # boot + wait healthy
#   scripts/gitlab-dev/create-project.sh  # user + project + seed + PAT
#   scripts/gitlab-dev/create-mr.sh       # feature branch + MR
#
# Env knobs forwarded to create-project.sh (see that script for the
# full list):
#   WEBHOOK_URL — pre-register a project webhook pointing at this URL
#                 (e.g. an existing zrok/ngrok tunnel).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "${HERE}/start.sh"
echo
bash "${HERE}/create-project.sh"
echo
bash "${HERE}/create-mr.sh"
