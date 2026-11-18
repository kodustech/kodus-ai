package cellupdate

import (
	"fmt"
	"io"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubprotocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/releasesig"
)

// checkProtocol refuses a release the hub this cell last reached would
// refuse at hello (the skew policy, docs/runtime/cell-distribution.md):
// its highest protocol, the one its cell frames in, above the highest the
// hub accepts (cell_too_new) or below the lowest (cell_too_old). Installed,
// such a release leaves a cell that never connects until a rollback. What
// cannot be checked installs, saying why on notes: a release that does not
// say its protocol (one from before PROTOCOL, unless RequireProtocol) and a
// cell that never reached a hub.
func checkProtocol(o Options, manifest map[string]string, notes io.Writer) error {
	if o.SkipProtocolCheck {
		note(notes, "-skip-protocol-check: release %s is not checked against the protocols the hub accepts", o.Release)
		return nil
	}
	speaks, said, err := releasesig.ReadProtocol(o.From, manifest)
	if err != nil {
		return err
	}
	if !said {
		if o.RequireProtocol {
			return refuseOrder("release %s does not say which protocol it speaks (%s lists no %s), and -require-protocol is set", o.Release, releasesig.ManifestName, releasesig.ProtocolName)
		}
		note(notes, "release %s does not say which protocol it speaks (no %s in %s): it is not checked against the hub; -require-protocol refuses such a release", o.Release, releasesig.ProtocolName, releasesig.ManifestName)
		return nil
	}
	if o.HubState == "" {
		note(notes, "no hub state to check release %s (protocol v%d) against", o.Release, speaks.Max)
		return nil
	}
	st, reached, err := hubprotocol.Load(o.HubState)
	if err != nil {
		return &releasesig.Error{File: o.HubState, Reason: fmt.Sprintf("the hub protocol state does not read (%v): start the cell so it reaches the hub again, remove the file knowingly, or pass -skip-protocol-check", err)}
	}
	if !reached {
		note(notes, "this cell has not reached a hub yet (no %s): release %s (protocol v%d) is not checked against one", o.HubState, o.Release, speaks.Max)
		return nil
	}
	accepts, named := st.Accepted()
	hub := fmt.Sprintf("the hub this cell last reached (%s) accepts cells of protocol v%d to v%d", st.At.UTC().Format(time.RFC3339), accepts.Min, accepts.Max)
	if !named {
		hub = fmt.Sprintf("the hub this cell last reached (%s) named no range (a hub from before cellProtocols, which speaks the v%d it chose), so it accepts cells of protocol v%d to v%d", st.At.UTC().Format(time.RFC3339), st.Version, accepts.Min, accepts.Max)
	}
	switch {
	case speaks.Max > accepts.Max:
		return refuseOrder("release %s speaks protocol v%d, and %s: the hub would refuse it at hello (cell_too_new): upgrade the hub first and let this cell reconnect to it, then update; -skip-protocol-check installs it anyway", o.Release, speaks.Max, hub)
	case speaks.Max < accepts.Min:
		return refuseOrder("release %s speaks protocol v%d, and %s: the hub would refuse it at hello (cell_too_old): install a release of protocol v%d or newer; -skip-protocol-check installs it anyway", o.Release, speaks.Max, hub, accepts.Min)
	}
	return nil
}

func note(w io.Writer, format string, a ...any) {
	if w != nil {
		_, _ = fmt.Fprintf(w, "cell update: note: "+format+"\n", a...)
	}
}
