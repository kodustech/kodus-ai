---
name: kodus-runtime-setup
description: Use when the user wants Kody Runtime to boot their app, set up a Kody Runtime environment, or write `.kodus/workspace.yaml` / `.kodus/workspace.runtime.yaml`, via `kodus env recipe`.
---

# Kodus Runtime Setup

## Overview

Kody Runtime boots the user's app on a clean machine to test its pull requests. You write the recipe with what you know about this repository; Kodus checks it, boots it from zero, and says why it failed. Use only `kodus env` to check, send and debug it.

## Goal

Write a recipe that boots this app on a clean machine, from what already runs it:

- The CI job that boots the app for e2e or integration tests: mirror its steps and services.
- `docker-compose.yml`, `Dockerfile`: prefer the repository's own files.
- README, `.nvmrc`, `.tool-versions`, `package.json` scripts.

## Recipe format (version 1)

```
version: 1
setup: [commands that install the toolchain and dependencies]
services:
  compose: { files: [docker-compose.yml], public: <service the app answers on>, health: /health, health_timeout: 120s }
  expose: [{ service: <name>, port: <port>, kind: http | postgres }]
data:
  migrate: <command that runs the migrations>
  seed: <command or { service, sql, user, database } that loads test data>
```

A `health` path needs `public` and an `http` entry for that service in `expose`.

## Where to write it

- `.kodus/workspace.yaml`; if it already exists for another tool, `.kodus/workspace.runtime.yaml` (read first). Read the existing file before writing.
- A Dockerfile or compose file the repository lacks, or that is broken (a compose service building from a Dockerfile that is not there), goes directly under `.kodus/`: flat, at most 4 files, 16 KiB each, 48 KiB together, named like `.kodus/Dockerfile.web`. The recipe names it by that path.

## Hard rules

- Never copy `.env` or any secret into the recipe or the `.kodus/` files. Name the variables the app needs and give test values that say so (`kodus-test-...`) or fakes.
- External services (Firebase, payment providers, email, maps) get emulators or fakes, never real credentials or tokens.
- Builds reach package and image registries only: no downloads from other hosts.

## Loop

1. Write or edit the recipe and the build files.
2. `kodus env recipe check` until it passes. Fix every error it lists. Add `--env <id>` when it asks you to name the environment.
3. `kodus env recipe submit --wait` (30 minutes by default, `--timeout <minutes>`): Kodus sets the environment up from it on a clean machine.
4. Blocked: read each blocker's title, evidence lines and fixes (`kodus env status` prints them again). Fix the recipe or the files, then go back to step 2.
5. Stop after 5 attempts and tell the user what still blocks it, with the evidence.
6. Active: open a pull request that commits the recipe and the `.kodus/` files. Until it is merged, Kodus keeps booting the sent one; once merged, the committed one wins.

Add `--json` to any of these for machine-readable output.

## Requirements

- A team key (`kodus auth team-key --key <key>`) with `env:fix` to send a recipe (`env:exec` or `env:fix` to check it and read the status), turned on for the key in Organization → CLI keys.
- The repository added to that key.
- 403: the key lacks the capability. 404: the repository is not on the key.
