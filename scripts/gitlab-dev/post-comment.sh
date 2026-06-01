#!/usr/bin/env bash
# Post a comment as the seeded `kodus-dev` user on the seeded MR. The
# helper exists because the @kody chat commands and the Note Hook
# delivery path are only reachable by actually posting a comment —
# neither is exercised by the bare MR.
#
# Authenticates with the *user* PAT (not the admin PAT) so the webhook
# payload's author matches what GitLab would emit in real use.
#
# Usage:
#   bash scripts/gitlab-dev/post-comment.sh --body "@kody start-review"
#   echo "@kody start-review" | bash scripts/gitlab-dev/post-comment.sh
#
# Pre-reqs: scripts/gitlab-dev/create-project.sh and create-mr.sh have
# been run (so .tmp/gitlab-dev-pat.txt and .tmp/gitlab-dev-mr-url.txt
# exist).

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

BODY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --body) BODY="$2"; shift 2 ;;
        --body=*) BODY="${1#--body=}"; shift ;;
        -h|--help)
            sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown arg: $1" >&2; exit 1 ;;
    esac
done

# Fall back to stdin if --body wasn't passed. Lets the script play
# nicely with `echo … |` and heredocs without quoting hell.
if [ -z "${BODY}" ]; then
    if [ -t 0 ]; then
        echo "error: pass --body \"…\" or pipe text on stdin" >&2
        exit 1
    fi
    BODY="$(cat)"
fi

for f in "${USER_PAT_FILE}" "${PROJECT_ID_FILE}" "${MR_URL_FILE}"; do
    if [ ! -f "${f}" ]; then
        cat >&2 <<EOF
error: ${f} missing.

Run the project + MR setup first:
    bash scripts/gitlab-dev/create-project.sh
    bash scripts/gitlab-dev/create-mr.sh
EOF
        exit 1
    fi
done

USER_PAT="$(cat "${USER_PAT_FILE}")"
PROJECT_ID="$(cat "${PROJECT_ID_FILE}")"
MR_URL="$(cat "${MR_URL_FILE}")"
# MR URL ends with "/-/merge_requests/<iid>"; pull the iid off the tail.
MR_IID="${MR_URL##*/}"

# Serialise the body through python's json module so newlines, quotes,
# emoji, and `@kody …` slashes survive into the JSON payload unmodified.
PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'body': sys.argv[1]}))" "${BODY}")

echo "==> posting comment as ${USER_NAME} on MR !${MR_IID}"
RESPONSE=$(curl -sf -X POST \
    -H "PRIVATE-TOKEN: ${USER_PAT}" \
    -H "Content-Type: application/json" \
    -d "${PAYLOAD}" \
    "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/merge_requests/${MR_IID}/notes")

NOTE_ID=$(echo "${RESPONSE}" | jq_field "['id']")
echo "    note id: ${NOTE_ID}"
echo "    on:      ${MR_URL}#note_${NOTE_ID}"
