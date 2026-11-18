package main

import (
	"context"
	"crypto/tls"
	"net/url"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/remotecache"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/enrollment"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/preflight"
)

// `cell preflight -network`: what a fresh install fails on that the host
// checks cannot see, read only (internal/preflight network.go). The checks
// run at once, each under networkCheckTimeout, the run under
// networkRunTimeout.
const (
	networkCheckTimeout = 15 * time.Second
	networkRunTimeout   = 45 * time.Second
)

// checkNetwork adds the -network checks for a cell of kind: the hub and
// the Git API for every driver; on docker-gvisor also the images, the
// egress container and the registries the cell writes to.
func checkNetwork(r *preflight.Report, st settings, kind string, p preflightProbes) {
	ctx, cancel := context.WithTimeout(context.Background(), networkRunTimeout)
	defer cancel()
	cellTLS, loadErr := hubClientTLS(st)
	checks := []preflight.NetCheck{
		{Name: preflight.NameHub, Below: preflight.Fail, Run: func(ctx context.Context) preflight.Result {
			return preflight.CheckHub(ctx, preflight.Hub{URL: st.HubURL, TLS: cellTLS, LoadErr: loadErr, LookupHost: p.lookupHost})
		}},
		{Name: preflight.NameGitAPI, Below: preflight.Fail, Run: func(ctx context.Context) preflight.Result {
			return preflight.CheckGit(ctx, p.httpClient, gitHosts(st.GitAPI))
		}},
	}
	switch kind {
	case dockergvisor.Kind:
		for _, im := range gvisorImages(st) {
			checks = append(checks, preflight.NetCheck{Name: im.Name, Below: im.Below, Run: func(ctx context.Context) preflight.Result {
				return preflight.CheckImage(ctx, p.netDocker, im)
			}})
		}
		if name := st.GVisorEgressContainer; name != "" {
			checks = append(checks, preflight.NetCheck{Name: preflight.NameEgressContainer, Below: preflight.Fail, Run: func(ctx context.Context) preflight.Result {
				return preflight.CheckEgressContainer(ctx, p.netDocker, name)
			}})
		}
		checks = append(checks, gvisorRegistries(st)...)
	default:
		r.Notes = append(r.Notes, "-network on "+kind+": the hub and the Git API are checked; this driver pulls no image through this host's Docker")
	}
	r.Add(preflight.RunNetwork(ctx, networkCheckTimeout, checks)...)
	r.Notes = append(r.Notes, "-network: the hub was asked GET /health without a hello; it accepts or refuses the cell's certificate when the agent connects")
}

// hubClientTLS is the TLS the agent dials the hub with (run: the holder's
// ClientTLS on the hub roots of loadRoots).
func hubClientTLS(st settings) (*tls.Config, error) {
	holder, err := enrollment.LoadCertHolder(st.Cert, st.Key)
	if err != nil {
		return nil, err
	}
	roots, err := loadRoots(rootFiles{Hub: st.CA, Local: st.LocalCA, CellCA: st.Trust.CellCA, Issuer: st.Issuer, Observer: observerCAFile(st)}, st.EgressEPs != "", st.Dev)
	if err != nil {
		return nil, err
	}
	return holder.ClientTLS(roots.Hub), nil
}

// gitHosts are the URLs a claim's download reaches on -git-api
// (gitsource.TarballURL): the API itself and, on github.com, the host its
// tarball endpoint redirects to. GitHub Enterprise serves both on its own
// host.
func gitHosts(api string) []string {
	base := strings.TrimRight(api, "/")
	out := []string{base + "/"}
	if u, err := url.Parse(base); err == nil && u.Host == "api.github.com" {
		out = append(out, "https://codeload.github.com/")
	}
	return out
}

// gvisorImages are the images wireDockerGVisor gives the driver, each by
// the flag that names it (the defaults included), with what fails when it
// does not pull: Fail for an image every claim runs.
func gvisorImages(st settings) []preflight.Image {
	var out []preflight.Image
	add := func(name, flag, ref string, below preflight.Status, why string) {
		if ref != "" {
			out = append(out, preflight.Image{Name: name, Flag: flag, Ref: ref, Below: below, Why: why})
		}
	}
	add("image-holder", "-gvisor-holder-image", st.GVisorHolderImage, preflight.Fail, "every claim runs a holder")
	if st.ObsMode == observerHTTP {
		add("image-observer", "-gvisor-observer-image", st.GVisorObserverImage, preflight.Fail, "every claim runs an observer")
	}
	add("image-builder", "-gvisor-builder-image", st.GVisorBuilderImage, preflight.Warn, "a project with a build section cannot build")
	if st.GVisorImageTransfer == "registry" {
		add("image-registry", "-gvisor-registry-image", st.GVisorRegistryImage, preflight.Warn, "builds hand their image over through it (-gvisor-image-transfer registry)")
	}
	if helper, err := dockergvisor.HelperImage(st.GVisorHelperImage); err == nil {
		add("image-helper", "-gvisor-helper-image", helper, preflight.Warn, "a bake cannot copy its data volumes, nor a claim start from them")
	}
	add("image-sandbox", "-gvisor-sandbox-image", st.Sandbox.Image, preflight.Warn, "code sandboxes do not start")
	add("image-browser", "-gvisor-browser-image", st.GVisorBrowserImage, preflight.Warn, "browser probes do not run")
	return out
}

// gvisorRegistries are the registries off the cell the driver itself
// pushes to or pulls from (dockergvisor.New: remotecache stores), each
// opened as New opens it, with the credential file run reads.
func gvisorRegistries(st settings) []preflight.NetCheck {
	var out []preflight.NetCheck
	add := func(name, flag, where, authFlag, authFile, why string) {
		if where == "" {
			return
		}
		reg := preflight.Registry{Name: name, Flag: flag, Where: where, AuthFlag: authFlag, HasAuth: authFile != "", Why: why}
		auth, err := readAuthFile(authFile)
		if err != nil {
			reg.StartErr = err
		} else if store, err := remotecache.New(remotecache.Config{URL: where, Auth: auth}); err != nil {
			reg.StartErr = err
		} else {
			reg.Check = store.Check
		}
		out = append(out, preflight.NetCheck{Name: name, Below: preflight.Warn, Run: func(ctx context.Context) preflight.Result {
			return preflight.CheckRegistry(ctx, reg)
		}})
	}
	add(preflight.NameBuildCacheRemote, "-gvisor-build-cache-remote", st.GVisorBuildCacheRemote, "-gvisor-build-cache-remote-auth-file", st.GVisorBuildCacheRemoteAuthFile,
		"a build whose state and cache are gone runs cold, and the seed's cache stays on this cell")
	add(preflight.NameBakeShare, "-gvisor-bake-share", st.GVisorBakeShare, "-gvisor-bake-share-auth-file", st.GVisorBakeShareAuthFile,
		"bakes stay on this cell, and the org's other cells build instead of pulling")
	add(preflight.NameBakeSharePull, "-gvisor-bake-share-pull", st.GVisorBakeSharePull, "-gvisor-bake-share-auth-file", st.GVisorBakeShareAuthFile,
		"claims build instead of pulling a shared baked image")
	return out
}

// ImagePresent is `docker image inspect` under the cell's environment.
func (d preflightDocker) ImagePresent(ctx context.Context, ref string) (bool, error) {
	_, err := dockercli.ExecCommand(ctx, nil, "docker", "image", "inspect", "--format", "{{.Id}}", ref)
	if dockercli.NoSuchImage(err) {
		return false, nil
	}
	return err == nil, err
}

// ManifestReadable is `docker manifest inspect`: the docker CLI reads the
// manifest from the registry with the credentials of the cell's
// environment (DOCKER_CONFIG, else none: dockercli gives docker its own
// HOME), and pulls nothing.
func (d preflightDocker) ManifestReadable(ctx context.Context, ref string) error {
	_, err := dockercli.ExecCommand(ctx, nil, "docker", "manifest", "inspect", ref)
	return err
}

// ContainerStatus is `docker container inspect`'s State.Status.
func (d preflightDocker) ContainerStatus(ctx context.Context, name string) (string, bool, error) {
	out, err := dockercli.ExecCommand(ctx, nil, "docker", "container", "inspect", "--format", "{{.State.Status}}", name)
	if dockercli.NoSuchContainer(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return strings.TrimSpace(string(out)), true, nil
}
