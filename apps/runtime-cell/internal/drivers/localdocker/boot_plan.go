package localdocker

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/checkoutfs"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// ComposeFile is the adapted compose file the driver writes into the
// checkout; the checkout's own files are never modified.
const ComposeFile = ".kodus-local-compose.yaml"

// EnvFile holds the recipe's services.compose.env for interpolation.
const EnvFile = ".kodus-local.env"

// ErrNoEnvironment: the checkout has neither a compose file nor a Dockerfile.
var ErrNoEnvironment = errors.New("localdocker: the checkout has no compose file and no Dockerfile")

// bootPlan is what a checkout boots, worked out before anything runs.
type bootPlan struct {
	// recipe is the checkout's .kodus/workspace.yaml; nil without one.
	recipe *recipe.Recipe
	// project is how Docker is told to run it.
	project ComposeProject
	// adapted is the compose file, adapted to run beside other claims.
	adapted []byte
	// exposed is what the machine publishes: the recipe's expose, or the
	// claim's when the checkout has no recipe.
	exposed []driver.ExposePort
	// published maps each exposed port to the compose service behind it.
	published []compose.PublishedPort
	// services are the compose project's services, sorted.
	services []string
	// pullFromRegistry are the services whose image is pulled, not built.
	pullFromRegistry []string
	// volumes are the named volumes each started service mounts: what a
	// data snapshot stops and copies.
	volumes map[string][]string
}

// newBootPlan reads the checkout's recipe and compose project and adapts
// the project to the cell. labels go on every container; nil when the plan
// is only read back (Resume, Reset) and never run.
func newBootPlan(checkout, project string, claimExpose []driver.ExposePort, labels map[string]string) (*bootPlan, error) {
	rec, err := recipe.Load(checkout)
	if err != nil {
		return nil, driver.WorkloadRecipeRefused(fmt.Errorf("localdocker: %w", err))
	}
	if err := refuseWhatLocalDockerCannotRun(rec); err != nil {
		return nil, err
	}
	exposed, err := portsToPublish(rec, claimExpose)
	if err != nil {
		return nil, err
	}
	proj, err := loadProject(checkout, rec, exposed)
	if err != nil {
		return nil, err
	}
	if rec != nil {
		if err := proj.ActivateProfiles(rec.Services.Compose.Profiles); err != nil {
			return nil, driver.WorkloadRecipeRefused(fmt.Errorf("localdocker: %w", err))
		}
	}
	if err := checkLocalFakeConnectivity(rec, proj); err != nil {
		return nil, err
	}
	if err := checkRecipeNamesServicesOf(rec, proj); err != nil {
		return nil, err
	}
	p := &bootPlan{recipe: rec, exposed: exposed, project: ComposeProject{
		Name: project,
		Dir:  checkout,
		File: filepath.Join(checkout, ComposeFile),
	}}
	if rec != nil && len(rec.Services.Compose.Env) > 0 {
		p.project.EnvFile = filepath.Join(checkout, EnvFile)
	}
	if err := p.adapt(proj, labels); err != nil {
		return nil, err
	}
	p.services = proj.ServiceNames()
	p.volumes = proj.NamedVolumes()
	return p, nil
}

// adapt makes the project safe to run side by side with other claims on
// one Docker (see the compose package for why each step exists).
func (p *bootPlan) adapt(proj *compose.Project, labels map[string]string) error {
	// The recipe's env reaches the containers, not only compose's
	// interpolation (EnvFile): an app reads a variable its compose file
	// never names, and the docker-gvisor driver does the same.
	if p.recipe != nil {
		if err := proj.AddEnvironment(p.recipe.Services.Compose.Env); err != nil {
			return fmt.Errorf("localdocker: %w", err)
		}
	}
	if err := proj.AddRecipeFakes(p.recipe); err != nil {
		return driver.WorkloadRecipeRefused(err)
	}
	asked := make([]compose.Port, len(p.exposed))
	for i, e := range p.exposed {
		asked[i] = compose.Port{Service: e.Service, Port: e.Port}
	}
	var err error
	if p.published, err = proj.PublishOnLoopback(asked); err != nil {
		return fmt.Errorf("localdocker: %w", err)
	}
	if err := proj.DropContainerNames(); err != nil {
		return fmt.Errorf("localdocker: %w", err)
	}
	if err := proj.AddLabels(labels, reservedLabelPrefix); err != nil {
		return fmt.Errorf("localdocker: %w", err)
	}
	if p.pullFromRegistry, err = proj.NameBuiltImagesAfterProject(p.project.Name); err != nil {
		return fmt.Errorf("localdocker: %w", err)
	}
	proj.MakeExternalNetworksPrivate()
	proj.MakeExternalVolumesPrivate()
	p.adapted, err = proj.Marshal()
	return err
}

// write puts the adapted compose file, and the recipe's env when it has
// one, in the checkout, once per boot.
//
// Both go through checkoutfs: the checkout is the PR's code, and either name
// may be a symlink it planted to send the write somewhere else.
func (p *bootPlan) write() error {
	if err := checkoutfs.Replace(p.project.Dir, ComposeFile, p.adapted, 0o600); err != nil {
		return fmt.Errorf("localdocker: %w", err)
	}
	if p.project.EnvFile == "" {
		return checkoutfs.Remove(p.project.Dir, EnvFile)
	}
	return checkoutfs.Replace(p.project.Dir, EnvFile, []byte(envFileContents(p.recipe.Services.Compose.Env)), 0o600)
}

// envFileContents is KEY=value lines, sorted. recipe.Parse refused
// newlines and secrets in the values already.
func envFileContents(env map[string]string) string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "%s=%s\n", k, env[k])
	}
	return b.String()
}

// lastBootPlan is the plan of the checkout the machine last booted from,
// read back for its ports and recipe; nil when it never booted.
func (d *Driver) lastBootPlan(name string) (*bootPlan, error) {
	m, ok := d.lookupMachine(name)
	if !ok {
		return nil, fmt.Errorf("localdocker: unknown machine %s", name)
	}
	if m.checkout == "" {
		return nil, nil
	}
	return newBootPlan(m.checkout, name, m.claimExpose, nil)
}

// loadProject is the recipe's compose files, the checkout's default compose
// file, or a one-service project from its Dockerfile.
func loadProject(checkout string, rec *recipe.Recipe, exposed []driver.ExposePort) (*compose.Project, error) {
	var files []string
	if rec != nil {
		files = rec.Services.Compose.Files
	}
	proj, err := compose.Load(checkout, files)
	if !errors.Is(err, compose.ErrNoComposeFile) {
		if err != nil {
			return nil, fmt.Errorf("localdocker: %w", err)
		}
		return proj, nil
	}
	if _, err := os.Stat(filepath.Join(checkout, "Dockerfile")); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNoEnvironment
		}
		return nil, err
	}
	service := "app"
	for _, e := range exposed {
		if e.Service != "" {
			service = e.Service
			break
		}
	}
	return compose.SingleService(service), nil
}
