# Newman Run Summary

Total requests: 142

## Status Codes

- 200: 65
- 201: 11
- 204: 4
- 400: 16
- 401: 7
- 403: 1
- 404: 7
- 409: 1
- 429: 1
- 500: 29

## Non-2xx Responses

- POST http://localhost:3001/code-management/repositories → 400
- POST http://localhost:3001/code-management/auth-integration → 500
- POST http://localhost:3001/code-management/finish-onboarding → 400
- GET http://localhost:3001/dry-run/status/?teamId=c33ef663-70e7-4f43-9605-0bbef979b8e0 → 404
- GET http://localhost:3001/dry-run/events/?teamId=c33ef663-70e7-4f43-9605-0bbef979b8e0 → 404
- GET http://localhost:3001/user-log/code-review-settings?page=1&limit=100&skip=0&teamId=c33ef663-70e7-4f43-9605-0bbef979b8e0&action=delete&configLevel=directory&userId=37a98985-82e4-4b3e-8a6f-13efa0415b00&userEmail=vidaloka@teste.com&repositoryId=1135722979&startDate=2026-01-06T15:28:21.736Z&endDate=2026-02-05T15:28:21.736Z → 500
- POST http://localhost:3001/pull-request-messages → 500
- GET http://localhost:3001/issues/%3Cstring%3E → 500
- PATCH http://localhost:3001/issues/%3Cstring%3E → 500
- POST http://localhost:3001/kody-rules/create-or-update → 400
- POST http://localhost:3001/kody-rules/add-library-kody-rules → 400
- POST http://localhost:3001/kody-rules/generate-kody-rules → 400
- POST http://localhost:3001/kody-rules/change-status-kody-rules → 400
- POST http://localhost:3001/kody-rules/sync-ide-rules → 500
- POST http://localhost:3001/kody-rules/fast-sync-ide-rules → 500
- POST http://localhost:3001/kody-rules/review-fast-ide-rules → 500
- POST http://localhost:3001/kody-rules/resync-ide-rules → 500
- POST http://localhost:3001/parameters/create-or-update → 500
- GET http://localhost:3001/parameters/find-by-key?key=team_artifacts_config&teamId=c33ef663-70e7-4f43-9605-0bbef979b8e0 → 404
- POST http://localhost:3001/parameters/create-or-update-code-review → 400
- POST http://localhost:3001/parameters/apply-code-review-preset → 500
- POST http://localhost:3001/parameters/update-code-review-parameter-repositories → 500
- GET http://localhost:3001/parameters/code-review-parameter?teamId=c33ef663-70e7-4f43-9605-0bbef979b8e0 → 500
- GET http://localhost:3001/parameters/generate-kodus-config-file?teamId=c33ef663-70e7-4f43-9605-0bbef979b8e0&repositoryId=1135722979&directoryId= → 500
- POST http://localhost:3001/parameters/delete-repository-code-review-parameter → 403
- POST http://localhost:3001/parameters/preview-pr-summary → 400
- GET http://localhost:3001/organization-parameters/find-by-key?key=byok_config → 404
- GET http://localhost:3001/organization-parameters/list-models?provider=github → 400
- DELETE http://localhost:3001/organization-parameters/delete-byok-config?configType=main → 400
- POST http://localhost:3001/organization-parameters/cockpit-metrics-visibility → 500
- POST http://localhost:3001/organization-parameters/ignore-bots → 500
- POST http://localhost:3001/organization-parameters/auto-license/allowed-users → 500
- POST http://localhost:3001/teams/c33ef663-70e7-4f43-9605-0bbef979b8e0/cli-keys → 500
- GET http://localhost:3001/teams/c33ef663-70e7-4f43-9605-0bbef979b8e0/cli-keys → 500
- DELETE http://localhost:3001/teams/c33ef663-70e7-4f43-9605-0bbef979b8e0/cli-keys/ → 404
- POST http://localhost:3001/team-members → 500
- DELETE http://localhost:3001/team-members/%3Cstring%3E?removeAll=%3Cboolean%3E → 500
- POST http://localhost:3001/agent/conversation → 500
- POST http://localhost:3001/auth/refresh → 401
- POST http://localhost:3001/auth/signUp → 409
- POST http://localhost:3001/auth/confirm-email → 500
- GET http://localhost:3001/auth/sso/login/585e32e5-242e-4381-bef4-d2dfc61375f9 → 500
- POST http://localhost:3001/auth/sso/saml/callback/585e32e5-242e-4381-bef4-d2dfc61375f9 → 500
- POST http://localhost:3001/permissions/assign-repos → 500
- GET http://localhost:3001/pull-requests/executions?repositoryId=1135722979&repositoryName=kodus-extension&limit=20&page=1&hasSentSuggestions=false&pullRequestTitle={{pullRequestTitle}}&pullRequestNumber={{pullRequestNumber}}&teamId=c33ef663-70e7-4f43-9605-0bbef979b8e0 → 400
- GET http://localhost:3001/pull-requests/suggestions?prUrl=&repositoryId=1135722979&prNumber=&format=json&severity=high&category=bug → 401
- POST http://localhost:3001/pull-requests/cli/suggestions → 401
- GET http://localhost:3001/pull-requests/cli/suggestions?prUrl=&repositoryId=1135722979&prNumber=&format=json&severity=high&category=bug → 401
- GET http://localhost:3001/pull-requests/onboarding-signals?teamId=c33ef663-70e7-4f43-9605-0bbef979b8e0&repositoryIds=1135722979&repositoryIds=1135722979&limit=20 → 500
- POST http://localhost:3001/pull-requests/backfill → 400
- POST http://localhost:3001/user/invite/complete-invitation → 500
- POST http://localhost:3001/user/join-organization → 400
- PATCH http://localhost:3001/user/ → 404
- GET http://localhost:3001/cli/validate-key → 401
- POST http://localhost:3001/cli/validate-key → 401
- POST http://localhost:3001/cli/review → 401
- POST http://localhost:3001/cli/trial/review → 429
- POST http://localhost:3001/sso-config → 500
- GET http://localhost:3001/sso-config?protocol=saml&active=true → 404
- POST http://localhost:3001/mcp → 400
- GET http://localhost:3001/mcp → 400
- DELETE http://localhost:3001/mcp → 400
