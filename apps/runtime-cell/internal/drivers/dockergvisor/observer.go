package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
)

// The claim network has no address on the host (inhibit_ipv4), so the cell
// cannot dial an observer there. Each observer also joins the cell's
// observer network: internal, with the host on it and no traffic between its
// containers. The cell reaches every observer on it; an observer reaches no
// other observer and nothing outside, and no workload is ever on it. The
// observer still probes the claim's services over the claim network.

func (d *Driver) observerNetwork() string { return "kodus-observers-" + d.cfg.CellID }

// ensureObserverNetwork creates the cell's observer network once.
func (d *Driver) ensureObserverNetwork(ctx context.Context) (string, error) {
	name := d.observerNetwork()
	owned := func() (bool, error) {
		labels, err := d.d.NetworkLabels(ctx, name)
		if err != nil || labels == nil {
			return false, err
		}
		if labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID {
			return false, fmt.Errorf("%w: network %s", driver.ErrNotOwned, name)
		}
		return true, nil
	}
	if ok, err := owned(); ok || err != nil {
		return name, err
	}
	err := d.d.NetworkCreate(ctx, dockercli.NetworkSpec{Name: name, HostOnly: true,
		Labels: toLabels(map[string]string{driver.TagCell: d.cfg.CellID})})
	if err != nil {
		// Another claim's observer made it first.
		if ok, oerr := owned(); ok {
			return name, nil
		} else if oerr != nil {
			return "", errors.Join(err, oerr)
		}
		return "", err
	}
	return name, nil
}

// Targets points each exposed port at its compose service's fixed address
// on the claim network, where the claim's observer machine reaches it. The
// workload holder is not the app: every service is a container of its own.
// A target whose service the project did not bring up is an error.
func (d *Driver) Targets(workload string, in []observer.Target) ([]observer.Target, error) {
	services := d.peek(workload).services
	if services == nil {
		return nil, fmt.Errorf("dockergvisor: %s has no project up", workload)
	}
	out := make([]observer.Target, 0, len(in))
	for _, t := range in {
		ip, ok := services[t.Service]
		if !ok {
			return nil, fmt.Errorf("dockergvisor: service %s is not up in %s", t.Service, workload)
		}
		t.Address = net.JoinHostPort(ip, strconv.Itoa(t.Port))
		out = append(out, t)
	}
	return out, nil
}
