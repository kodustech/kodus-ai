package localdocker

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

const (
	// tagImage is the image id the claim asked for, kept with the machine.
	tagImage = "kodus:image"
	// labelMachine names the machine on each of its containers.
	labelMachine = "kodus.machine"
	// labelProject is the label compose puts on what it makes for a project.
	labelProject = "com.docker.compose.project"
	// reservedLabelPrefix is the cell's: a checkout cannot set these labels.
	reservedLabelPrefix = "kodus."
)

// projectName makes a compose project name (lowercase letters, digits, '-'
// and '_'), which also keeps it a valid transport machine id (no '/' or '.').
func projectName(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

// claimGroup stands in for the claim's security group: local-docker has none.
func claimGroup(claimID string) string { return "kodus-" + projectName(claimID) }

// machineName is the machine id, also its compose project name.
func machineName(claimID string, role driver.Role) string {
	return projectName(fmt.Sprintf("kodus-%s-%s", claimID, role))
}

// exposeKey is how a published port is remembered and asked for.
func exposeKey(service string, port int) string { return service + "/" + strconv.Itoa(port) }
