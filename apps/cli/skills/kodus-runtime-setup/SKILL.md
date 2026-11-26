---
name: kodus-runtime-setup
description: Use when the user wants Kody Runtime to boot their app, set up a Kody Runtime environment, or write `.kodus/workspace.yaml` / `.kodus/workspace.runtime.yaml`, via `kodus env recipe`.
---

# Kodus Runtime Setup

## Overview

Kody Runtime boots the user's app on a clean machine to test its pull requests. You write the recipe with what you know about this repository; Kodus checks it, boots it from zero, and says why it failed. Use only `kodus env` to check, send and debug it.

## Goal

Write a recipe that boots this app on a clean machine, from what already runs it: the CI job that boots the app for e2e or integration tests (mirror its steps and services), the repository's own `docker-compose.yml` and `Dockerfile`, then the README and manifests.

## First: read the guide

Run `kodus env recipe guide` before writing anything. It prints the recipe format and the rules Kody's own author follows (what to boot, Node and monorepo builds, which Dockerfile and compose keys are refused), and what the sandbox does that the repository does not show (compose paths are relative to the repository root, builds reach registries only, the mirror's build args). Follow it over anything you remember.

## Where to write it

- `.kodus/workspace.yaml`; if it already exists for another tool, `.kodus/workspace.runtime.yaml` (read first). Read the existing file before writing.
- A Dockerfile or compose file the repository lacks, or that is broken, goes directly under `.kodus/`: flat, at most 4 files, 16 KiB each, 48 KiB together, named like `.kodus/Dockerfile.web`. The recipe names it by that path.

## Hard rules

- Never copy `.env` or any secret into the recipe or the `.kodus/` files. Name the variables the app needs and give test values that say so (`kodus-test-...`) or fakes.
- External services (Firebase, payment providers, email, maps) get emulators or fakes, never real credentials or tokens.

## Loop

1. Write or edit the recipe and the build files.
2. `kodus env recipe check` until it has no errors: it reads the repository at its default-branch head, so fix every error; warnings are advice. In a repository with several environments it picks the one of the git remote `origin`; add `--env <id>` when it asks you to name it.
3. `kodus env recipe submit --wait` (30 minutes by default, `--timeout <minutes>`): Kodus sets the environment up from it on a clean machine.
4. Blocked: read each blocker's failed step and its evidence lines (the output of that step) and fixes; `kodus env status` prints them again. Fix the recipe or the files, then go back to step 2.
5. Stop after 5 attempts and tell the user what still blocks it, with the evidence.
6. Active: open a pull request that commits the recipe and the `.kodus/` files. Until it is merged, Kodus keeps booting the sent one; once merged, the committed one wins.

Add `--json` to any of these for machine-readable output.

## Requirements

- A team key (`kodus auth team-key --key <key>`) with `env:fix` to send a recipe (`env:exec` or `env:fix` to check it and read the status), turned on for the key in Organization → CLI keys.
- The repository added to that key.
- 403: the key lacks the capability. 404: the repository is not on the key.
