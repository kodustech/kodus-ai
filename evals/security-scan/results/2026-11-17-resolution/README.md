# Resolution after a real fix — 2026-11-17

**Passed.** The step the [2026-11-16 run](../2026-11-16-full-e2e/README.md) left
unvalidated: an issue found in the code, then fixed, and resolved by two later scans.

Application commit `50721715a` ([deployment](deployment.json),
[services](services.json)), built with Nest webpack and started on the normal
API/worker entrypoints, with fresh migrations and seeds in an isolated PostgreSQL/Mongo
database and RabbitMQ vhost. Real REST, outbox relay, the `security-scan` worker, a
GitHub private clone, BYOK DeepSeek on Fireworks ([configuration](configuration.json))
and E2B. Nothing substituted.

| Step | Commit | Scan | Result |
| --- | --- | --- | --- |
| Vulnerable `lookupHost` (shell `exec`) | `c4b7946` | completed, 1/1 unit, $0.075 | CWE-78 issue created, reproduction ran and reproduced |
| Fix: DNS API, no shell, no network endpoint | `701b6c1` | completed, 1/1 unit, $0.031 | target class examined, 1 miss, issue **still open** |
| Same fix | `701b6c1` | completed, 2/2 units, $0.112 | 2nd miss, issue **resolved** |

Details are in [lifecycle.json](lifecycle.json). The issue fingerprint (`af4e782a…`)
is the same one the 2026-11-16 run produced for the same code. The web app shows the
result: Deep scan reports `1 resolved` with Open 0 and Resolved 1
([screenshot](ui-deep-scan.png)), and Issues reports `All 1 filed issue is resolved`
([screenshot](ui-issues.png), [text](ui-resolved.json)). Model spend was **$0.218**.

Why 2026-11-16 did not get here: its fixed scan read authz, injection and SSRF to the
end, but two other lenses did not finish. Its only unit failed, so the scan failed as
"could not finish examining any area" and resolved nothing. `50721715a` fails a scan
only when no class was examined in any file
(`libs/security-scan/application/security-scan-job.processor.ts`); its unit test fails
on the earlier code. Every unit in this run finished, so this run does not exercise that
partial path; the unit test covers it. The 2026-11-16 "fix" also kept an
unauthenticated HTTP endpoint and accepted a leading `-` in hosts, so reports there
were not clearly false. This fixture's fix removes both.

Scope: one Node.js fixture and one provider. The precision calibration in
[2026-11-16-review](../2026-11-16-review/README.md) stays failed or unmeasured.
[Cleanup](cleanup.json) removed this run's containers, volumes, databases and vhost.
It reused the retained fixture `kodustech/scan-e2e-1794869683954-vulnerable`, so no
repository was created.
