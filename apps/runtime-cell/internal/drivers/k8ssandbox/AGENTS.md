# apps/runtime-cell/internal/drivers/k8ssandbox

The cell's driver on Kubernetes (`-driver k8s-sandbox`, or `-driver auto` in a pod with a service account): an adapter of the `internal/driver` port whose machines are pods in one sandbox namespace the chart made, on an isolated RuntimeClass (gVisor or Kata), under the chart's default-deny NetworkPolicies. It runs code sandboxes and, with `Config.Env`, environment Runs from prebuilt images, one pod per compose service in the cell's environment namespace (the gvisor backend of [`docs/runtime/kubernetes-environment-runs.md`](../../../../../docs/runtime/kubernetes-environment-runs.md)). It runs in the cell process (`cmd/cell/k8s.go`, `wire.go` `wireK8s`) and, cut down, in the reaper. The design is [`docs/runtime/kubernetes.md`](../../../../../docs/runtime/kubernetes.md).

## Owns
- Construction and settings: `driver.go` `New`, `Config` (namespace, RuntimeClass, holder and sandbox images by digest, egress address, claim sizes).
- Pods: `driver.go` `pod` (restricted security context, no token, the resolver as DNS, `activeDeadlineSeconds`), `Create` (a holder pod), `CreateSandbox` (waits until running, deletes a pod that fails), `Destroy`, `List`, `SetExpiry` (the `kodus.io/expires` annotation), `Sweep`.
- The guest agent over the API server's exec: `driver.go` `DialGuest`; `exec.go` `Client.Exec` (channel.k8s.io WebSocket).
- The REST client: `client.go` `Client`, `InClusterClient`, `InCluster`, `KubeAPI`, `Execer`, `APIError`.
- Proof the cluster enforces what the driver relies on, before the cell takes work: `preflight.go` `Preflight.Run` (a privileged pod is refused, a driver pod is admitted, a probe pod sees the expected kernel and cannot dial the API server; with `EnvNamespace`, a privileged hostPath pod there is refused by the environment gate by name, `ErrEnvGateMissing` otherwise, and a driver pod there is admitted, `ErrEnvPodRefused` otherwise); `probe.go` `RunProbe` is `cell probe`, the probe pod's side.
- The reaper's driver: `driver.go` `NewForReaper`; `env.go` `NewForReaperWithEnv` and `ReapOrphans` (a claim's environment objects whose holder pod is gone; `Sweep` runs it too).
- The environment mode (`Config.Env`, `EnvConfig`, `RunsEnvironments`; `Parts` gains `Composer`, `Recipes`, `Resetter`, `ServiceLogs`): `env.go` `Up` (the policy, the volume claims, every pod held at its gate, the golden copy on a first boot, hosts files, decoy, checkout copies and volume restore or wipe through the init container, gates opened in `depends_on` order, ready), `envReset` (pods deleted; claims, policy and golden copy kept), `cleanupEnv` from `Destroy` and `ReleaseClaim`; `envexec.go` `Exec` (the public service, over pods/exec), `RunRecipe`, `ServiceLogs`. The render is `internal/compose/kube`'s.
- Image builds in the environment mode (`EnvConfig.BuilderImage` with `BuildRegistry`): `envbuild.go` `buildImages` (one builder pod per build section, `kube.BuilderPod`, before any service; the hosts file `BuildHosts`, BuildKit's config and the context, `.dockerignore` applied and symlinks kept as links, through the init container; `buildctl` over pods/exec streamed line by line into `buildprogress` and the boot's output; pushed to `BuildRegistry` under `kodus-build/<claim>/<service>:<fingerprint>`, run by digest from `BuildRegistryPull`; a machine's build reused when its fingerprint stands; the builder pod deleted after its build; `kube.BuildPolicy` lets builder pods reach `BuildEgress`). A step that fails is the repository's error, an OOM kill `driver.ErrOutOfMemory`, the builder's own failure `driver.ErrBuilderFailed`; a build that reads an org secret the claim holds is `driver.ErrUnsupported`.
- The claim's observer in the environment mode (`EnvConfig.ObserverImage` with `ObserverTLSDir`): `envobserver.go` `createObserver` (the observer machine `Create` makes for `RoleObserver`: `kube.ObserverPod` and `kube.ObserverPolicy` in the environment namespace, the claim's labels in the observer's role, its TLS files copied in through the gate, owned by the observer's user, then opened; an observer that does not start leaves nothing), `DialObserver` (one connection per call: `kube.ObserverBridge` over pods/exec, as a `net.Conn`), `Targets` (each exposed port at its service pod's address while the project is up), `recycleObserver` (a reset starts a new observer under the same pod name, so the same machine ref: the next round's pods have new addresses and a bound observer refuses other targets), `destroyObserver`, `setObserverExpiry` (both ordered against a recycle by `observerLocks`). Its share (`ObserverMemoryMB`, `ObserverMilliCPU`) is `kube.Options.Reserved` for the services and the builder. `PrepareClaim` takes expose ports only on such a cell.
- The environment API: `envclient.go` `EnvAPI` (pods, their logs, `ResourceVolumeClaims`, `ResourceNetworkPolicies`), `CommandRunner` (`Client.RunCommand`: stdin closed with v5's signal, bounded output, the exit code from the status channel; `StreamCommand`: every line as it comes), `IsConflict`.
- The environment namespace's manifest: `envgate.go` `EnvironmentNamespace` (Pod Security privileged, the gate `EnvGatePolicy` as a ValidatingAdmissionPolicy and its binding, default deny, the cell's Role there (`EnvCellRules`: exactly the driver's EnvAPI and exec calls) and the reaper's (`EnvReaperRules`), each with its RoleBinding to the ServiceAccount `EnvAccess` names, `ReferenceEnvAccess` in the reference file); `deploy/kubernetes/environment-namespace.yaml` is its render, kept equal by `TestTheEnvironmentNamespaceManifest` (`-update-manifest`). Every rule is evaluated with cel-go on pods in `envgate_cel_test.go`: a new allowance gets a case that passes and cases that show what stays refused. Only the builder's `buildkitd` container (`kube.BuilderContainer`, on a pod labeled `kube.RoleLabel: kube.BuilderRole`) may run seccomp or AppArmor Unconfined, and only non-root, unprivileged, with no added capability and the default /proc. The observer pod needs no allowance: it passes the gate as it is (`TestTheObserverPodPassesTheEnvironmentGate`).

## Does not own
- The namespaces, the Roles and the default-deny NetworkPolicies: the chart. The driver never creates a namespace; in the sandbox namespace it creates no policy (`PrepareClaim` creates nothing and names the egress); in the environment namespace it creates each claim's own NetworkPolicies (the claim's, its builders' and its observer's) and volume claims, nothing else.
- Without `Config.Env`, environment Runs: `NoRuns` is the cell's transport and every call fails with `driver.ErrUnsupported`. `cmd/cell` sets `Config.Env` only with `-k8s-env-namespace` (`k8senv.go`).
- Either way, refused with `driver.ErrUnsupported`: image builds on a cell with no builder image or build registry, a build that reads org secrets, expose ports on a cell with no observer image, the cell's trust files in environment pods (a claim with org secrets), `exec.repository`, bakes, snapshots, the pool.
- Resolving the egress Service's address and the `k8s-` flags: `cmd/cell/k8s.go`.

## Rules and limits
- The ownership rules of [`../../../AGENTS.md`](../../../AGENTS.md) "Untrusted input" apply: `Destroy`, `DialGuest` and `SetExpiry` act only on a pod carrying this cell's label, read from the cluster (`ownPod`, `owns`).
- Every request is pods (or pods/exec) in the configured namespace, and with `Config.Env` pods, pods/exec, pods/log, persistentvolumeclaims and networkpolicies in the environment namespace (the Role `EnvironmentNamespace` renders), always selected by this cell's label.
- The environment namespace is never the sandbox namespace (`EnvConfig.defaults`): Pod Security privileged there, the gate is the admission policy.
- An environment pod's init container is the cell's: its operations are `kube.InitScript`'s, with positional arguments only; the hosts file, the decoy and the copies are written before the gate opens, never after.
- Ids go in labels (`kodus.io/` plus the tag name), times in annotations: label values cannot hold `:` or timestamps.
- A sandbox that must trust the cell CA (a claim with org secrets) gets it only when the cell has its CA (`Config.CellCA`, `-cell-ca-cert`, checked by `machinetrust.CellCA`: one CA certificate, never a key): `sandboxTrust` adds an unprivileged init container of the sandbox image that writes `cell-ca.pem` and `ca-bundle.pem` (the image's roots, then the CA) into a memory volume, mounted read-only at machinetrust's paths and over the system store. The certificate travels in the pod spec: no ConfigMap, no RBAC beyond pods. Without `CellCA` such a sandbox is refused (`Capabilities.SandboxCellTrust` false).
- Without a sandbox image the driver makes no sandboxes (`ErrNoSandboxImage`, `SandboxesEnabled`).

## Where new code goes
- A new pod field: `driver.go` `pod`, with a case in `TestSandboxPodIsRestrictedOnTheRuntimeClass` or `requests_test.go`.
- A new cluster check: a step of `Preflight.Run`, failing with a named error from `preflight.go`.
- A new API call: `KubeAPI`, `Client`, and the fake API server in `apiserver_test.go`; in the environment namespace, `EnvAPI` and the in-memory cluster in `env_test.go`.
- A new step of an environment boot: a phase of `envBoot.run`, in its place, through `initOp` when it touches a pod before it starts.

## Tests
- `go test ./internal/drivers/k8ssandbox`: a fake API server over HTTP (`apiserver_test.go`), `drivertest.Run` and `drivertest.RunRequests`; the environment mode against an in-memory cluster (`env_test.go`; the observer in `envobserver_test.go`, its pods/exec stream a pipe the test serves) and the client's environment calls over HTTP (`envclient_test.go`). No cluster needed.
- `kind_e2e_test.go` (opt-in, `KODY_E2E_K8S_*`): on a real cluster through `kubectl proxy`, a sandbox with the cell's trust verifies a server the cell CA issued, one without does not. Kind: a RuntimeClass with handler `runc`, the namespace labeled PSA `restricted`, the sandbox image loaded with `kind load docker-image`.
- `kind_env_e2e_test.go` (opt-in, `KODY_E2E_K8S_ENV=1` and `KODY_E2E_K8S_ENV_BUILD=1` with their `KODY_E2E_K8S_ENV_*` images and registry addresses): environment Runs on a real cluster through `kubectl proxy --reject-paths='^/api/.*/pods/.*/attach'`. One test: the gate, a two-service boot, names both ways, reset to the golden data, the claim boundary, cleanup. The other: a base and a PR claim each build their service in a builder pod, push it to an in-cluster registry and run it by digest, and their own observer pod probes it through the real `observerclient` over `DialObserver` with mTLS; a reset reuses the image and recycles the observer. `.github/workflows/runtime-cell-kind.yml` sets both up on kind (registry, mirror, containerd `hosts.toml`, the observer image); results in `docs/runtime/kubernetes-environment-runs.md`, "Local test results".

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (11, tests apart): `client.go`, `driver.go`, `env.go`, `envbuild.go`, `envclient.go`, `envexec.go`, `envgate.go`, `envobserver.go`, `exec.go`, `preflight.go`, `probe.go`

Imports these Runtime modules:

- [`apps/runtime-cell/internal/buildfingerprint`](../../buildfingerprint/AGENTS.md)
- [`apps/runtime-cell/internal/buildmirror`](../../buildmirror/AGENTS.md)
- [`apps/runtime-cell/internal/buildprogress`](../../buildprogress/AGENTS.md)
- [`apps/runtime-cell/internal/checkoutfs`](../../checkoutfs/AGENTS.md)
- [`apps/runtime-cell/internal/compose/kube`](../../compose/kube/AGENTS.md)
- [`apps/runtime-cell/internal/compose/sandbox`](../../compose/sandbox/AGENTS.md)
- [`apps/runtime-cell/internal/dockerignore`](../../dockerignore/AGENTS.md)
- [`apps/runtime-cell/internal/driver`](../../driver/AGENTS.md)
- [`apps/runtime-cell/internal/kodyexec`](../../kodyexec/AGENTS.md)
- [`apps/runtime-cell/internal/machinetrust`](../../machinetrust/AGENTS.md)
- [`apps/runtime-cell/internal/observer`](../../observer/AGENTS.md)
- [`apps/runtime-cell/internal/recipe`](../../recipe/AGENTS.md)

Imported by:

- [`apps/runtime-cell/cmd/cell`](../../../cmd/cell/AGENTS.md)
- [`apps/runtime-cell/cmd/reaper`](../../../cmd/reaper/AGENTS.md)

<!-- module-map:end -->
