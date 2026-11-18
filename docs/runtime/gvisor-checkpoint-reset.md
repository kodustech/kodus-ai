# gVisor checkpoint/restore as the docker-gvisor reset (2026-11-17)

**Question.** A reset on the `docker-gvisor` driver takes 97 to 122 s on kodus-ai. Almost all of it is the processes
starting again: `seedMs` 88–111 s against `restoreMs` 1.3–2.6 s (measured on the dev cell,
2026-11-15). Firecracker resets from a memory
snapshot in under 1 s, but it needs KVM. Can gVisor's own checkpoint/restore give a memory snapshot of a booted
compose environment, restored per round, without KVM?

**Answer.** gVisor can do it. Docker 28 and 29 cannot, the way the cell runs services today.

- **gVisor works.** On Docker 27.5.1, the seeded postgres + HTTP project came back to its seeded state three times
  from one checkpoint. The memory came back, the data came back, and the app's open TCP connection to postgres
  survived. The first answer came 110–150 ms after the restore.
- **Docker 28.5.2 and 29.10.0 break it.** `docker start --checkpoint` fails for a container on any network other
  than `host`, `none` included: `bind-mount /proc/0/ns/net -> /var/run/docker/netns/…: no such file or directory`.
  The cell runs Docker 29.1.3, and `scripts/selfhosted/provision.sh:526` installs the latest Docker through
  `get.docker.com`.
- **One workaround works on Docker 29, and only in a single-container test.** Each service joins the network
  namespace of a plain runc holder container (`network_mode: container:<holder>`). Before every restore, the cell
  puts the holder's address and route back. This changes the topology the sandbox renders. It needs a decision, so
  nothing was built in the Resetter.

## 1. What the sources say

| Topic | What it says | Source |
| --- | --- | --- |
| Commands | `runsc checkpoint --image-path`, then `runsc create` + `runsc restore --image-path` into a new container. With Docker: `docker checkpoint create`, `docker start --checkpoint`. Flags include `--leave-running`, `--compression`, `--direct`, and `--background` on restore (asynchronous page loading by default) | [gVisor checkpoint/restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/) |
| Docker | "expects the container which created the checkpoint to be the same container used to restore". No `--checkpoint-dir`. The daemon must run with `experimental: true` | same |
| Network | Supported with `--network=sandbox` (Docker's default for runsc), `none` and `host`. With `host`, apps must reconnect. Pending backlog connections are lost | same |
| Same image twice | Two checkpoints cannot be **saved** to one directory. Restoring from one image several times is not restricted (tested below: it works) | same |
| GPU and host FDs | No GPU checkpoint on arm64 (cuda-checkpoint). Host sockets (`--network=host`) are not saved. A background restore keeps FDs open on the image files until it ends | same |
| Time | Per the docs, `CLOCK_MONOTONIC` does not count checkpointed time, and `REALTIME`/`BOOTTIME` jump forward by it. In our test monotonic advanced by the full 9 s gap too (release-20261026.0, arm64) | same, and §2 |
| CPU | The restore host needs every CPU feature of the checkpoint host | same |
| Docker 28 regression | The same `/proc/0/ns/net` error is reported on Docker 28.3.3 with runc+CRIU, so it is a Docker bug, not a gVisor one. No fix is known | [Docker forum](https://forums.docker.com/t/using-criu-for-checkpointing-docker-containers/149448), [reply](https://forums.docker.com/t/using-criu-for-checkpointing-docker-containers/149448/6) |
| Restore flake | `failed to upload checkpoint to containerd: commit failed: content sha256:…: already exists` | [moby#42900](https://github.com/moby/moby/issues/42900), [moby#47456](https://github.com/moby/moby/pull/47456) |

Volumes and bind mounts: the checkpoint saves the sandbox's memory and its rootfs overlay. Files on volumes and bind
mounts stay on the host, outside the image, so their data has to be put back from a copy taken at the same instant
as the checkpoint. That is the golden copy (`dockergvisor/golden.go`).

## 2. What was measured

Setup: OrbStack on an Apple M-series Mac (linux/arm64, 10 CPUs). Privileged `docker:<v>-dind` containers,
runsc `release-20261026.0`, runtime `{"path": "runsc"}`. The
shared dev cell host was not touched. Scripts: `small.sh`, `net.sh` and `raw.sh` in the session scratchpad.

**The small case (Docker 27.5.1).** Compose project `db` (postgres:16-alpine, named volume), `app` (Python +
pg8000) and `probe`, all under runsc, on a user network with fixed `ipv4_address` (the sandbox fixes addresses and
MACs too: `internal/compose/sandbox/sandbox.go:931`). The app opens one postgres connection at boot and never reconnects. It keeps an
in-memory hit counter. Steps: boot, seed (`CREATE TABLE` + `'seeded'`), `docker checkpoint create` on app and db,
copy the volume to a golden volume, then per round: restore the data, `docker start --checkpoint` db then app, and
GET.

| Step | Result |
| --- | --- |
| Checkpoint, 2 containers | 1.2–2.4 s, 14–19 MB each |
| Round 1 after restore | `rows: [seeded]`, `hits: 3` (2 at checkpoint), pid 1, the old connection alive |
| Change | two `changed` rows written |
| Rounds 2 and 3 (kill, restore data, restore memory) | `rows: [seeded]`, `hits: 3` again; a write works afterwards; postgres's log has no new start |
| Restore time | data copy 0.8–4.6 s (an alpine `cp -a` helper) + memory 1.0–4.9 s (two `docker start --checkpoint`); first answer 110–150 ms later |
| Today's reset of the same project, same host | `down -v` 0.7–14.3 s + up, seed and first answer 5.8–11.8 s |
| Clocks after restore | wall clock correct (not frozen at the checkpoint); `time.monotonic()` advanced by the full gap |

**Network modes, one runsc container, `docker start --checkpoint` twice:**

| Docker | `host` | `none` | default bridge | user network | `container:<runc holder>` |
| --- | --- | --- | --- | --- | --- |
| 25.0.5 | | | | works | |
| 27.5.1 | | | | works | |
| 28.5.2 | | | | `/proc/0/ns/net` | |
| 29.10.0 | works | `/proc/0/ns/net` | `/proc/0/ns/net` | `/proc/0/ns/net` | restores, **no network** until the holder's address is put back; then works, 80–110 ms per restore |

Also seen on Docker 29 with the runsc containerd shim (`runtimeType: io.containerd.runsc.v1`): postgres exits 1 with
no logs, even before any checkpoint. That path was dropped.

Reproduction of the regression (a daemon with `experimental: true` and the runsc runtime):

```sh
docker network create tnet
docker run -d --name cc --runtime=runsc --network tnet alpine sh -c 'i=0; while :; do i=$((i+1)); echo $i >/tmp/n; sleep .2; done'
docker checkpoint create cc ck
docker start --checkpoint ck cc   # 25/27: running; 28/29: bind-mount /proc/0/ns/net ... no such file or directory
```

**Why "no network" with a holder.** At start, runsc in `--network=sandbox` mode takes the interface's address
into its own netstack and leaves the interface in the namespace without one (`ip -br addr`: `eth0 UP`, no
address). A restore into the same namespace then finds none. The raw-runsc test (`raw.sh`: two sandboxes, two
netns, one bridge, no Docker) shows the same thing, and the fix:
- without the addresses: `Network unreachable`;
- with the addresses put back before the restore: the client's open keep-alive connection to the server kept
  working across the restore, the server's counter continued from its checkpointed value, and one image restored
  twice gave the same state;
- restore took 40–120 ms for two sandboxes of about 12 MB each.

**The restore flake.** `content sha256:…: already exists` hit about one first restore in three, on Docker 27 and
29 alike. A second `docker start --checkpoint` passed every time.

## 3. The design, if the holder topology is accepted

Not built. It changes what `internal/compose/sandbox` renders and adds a root `nsenter` on the host, which the
S-10 threat model must allow first.

1. **Render.** For each service, the sandbox adds a runc holder: a pause image, on the claim network with the
   service's fixed address and MAC. The service gets `network_mode: container:<holder>` and its `networks` key is
   dropped. The egress wiring and `VerifyCanonical` have to accept this shape.
2. **Golden boot.** After the first Up is healthy and the recipe's seed has run:
   - `docker checkpoint create` every service, in dependency order (apps before databases);
   - copy every project volume to its golden copy while the services are stopped, as `takeGolden` does today;
   - restore them (round 1).

   Checkpoints are labeled by machine, and Destroy, the sweep and the reaper remove them with the golden volumes.
3. **Reset.** `Reset` kills the services, puts the golden volumes back (`restoreGolden`), re-adds each holder's
   address and route with `nsenter -t <holder pid> -n ip addr add …`, and restores in dependency order (databases
   before apps). The restore is retried once on `already exists` (moby#42900). The next `Up` finds the machine
   restored and skips build, render, data and up.
4. **Fallback.** Any failure (checkpoint, copy, address, restore, a first probe that does not answer) turns the
   machine's checkpoint off, and the reset becomes today's `down -v` and up, as `goldenOff` does for data.
5. **Flag.** `-gvisor-checkpoint-reset` (default off), under the `gvisor-` prefix in `cmd/cell`, plus a
   preflight check: the Docker daemon is experimental, and the restore probe passes.

**Limits to measure before trusting it on kodus-ai:**
- **Image size.** The checkpoint holds every service's resident memory: tens of MB here, likely GBs for kodus-ai's
  API and worker. Measure checkpoint and restore time at that size, and the disk per claim.
- **Connections that cross the reset.** The probe's or observer's connections to a service are restored half-open.
  The agent side has to reconnect.
- **Time.** Wall and monotonic clocks jump forward by the time between checkpoint and restore. Timers due in the gap
  fire at once. Sessions, JWTs and cron jobs see the jump.
- **Determinism.** Each round starts from the same memory, so it reuses RNG state, request ids and pids. That is
  good for the gate's comparisons. A process that seeds its RNG once at boot repeats its "random" values every round.
- **Bind-mounted files.** A file under a bind mount (the checkout, resolv.conf, the decoy, trust files) that changes
  between checkpoint and restore is seen as changed by the restored process. A round that writes to the checkout
  needs it restored too.
- **Only one environment checkpointed in a test so far.** The sandbox's whole rendering (cgroup parent, limits,
  coverage, trust files, decoy) has not been checkpointed. Neither has a heavy app.
- **Docker.** If moby fixes the regression, the holder becomes unnecessary and the plain path of §2 (Docker 27) is
  the design. Track the forum thread, or file the bug in moby.

## 4. Recommendation

1. **Next best, no Docker dependency: warm duplicate environments.** Built behind `-gvisor-warm-fork-reset`: design,
   isolation and measurements in [gvisor-warm-fork-reset.md](gvisor-warm-fork-reset.md).
   - While round N runs, a second copy of the environment boots from the golden data and the bake, so the reset is
     a swap of addresses (about 1 s) instead of 97–122 s.
   - Cost: twice the claim's memory during the gate, and the host has 4 vCPUs.
   - It reuses what exists: the warm pool (`pool.go`), `Adopt`, golden data.
2. **Then the holder workaround, as a spike.**
   - Decide first whether the S-10 threat model allows `nsenter` as root and a runc holder per service.
   - Measure checkpoint size and restore time on kodus-ai's API and worker before building it.
3. **Report the Docker 28+ regression to moby** with the reproduction in §2. A fix there turns this back into the
   small plain-path change.
