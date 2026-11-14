package driver

import (
	"context"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerauth"
)

// SQLObserverProvisioner is an explicit optional driver capability. Credentials
// stay in memory and travel only on the cell-to-observer control connection.
type SQLObserverProvisioner interface {
	ProvisionObserverSQL(context.Context, MachineRef, string) ([]observerauth.Credential, error)
	ObserverSQLCredentials(machineID string) []observerauth.Credential
	ObserverSQLSecrets(machineID string) []string
	ForgetObserverSQL(machineID string)
}

type ObserverSQLError struct{ Reason string }

func (e *ObserverSQLError) Error() string {
	switch e.Reason {
	case "sql_seed_target_unsupported":
		return "observer SQL needs one PostgreSQL expose target matching an explicit seed service, user and database; use HTTP probes for unsupported targets"
	case "sql_schema_unsafe":
		return "observer SQL requires a plain read-only schema without executable user routines, views, RLS, foreign tables or effective public write privileges; use HTTP probes"
	case "sql_machine_unavailable":
		return "observer SQL database container is unavailable or not owned by this cell"
	case "sql_credential_failed":
		return "observer SQL credential generation failed"
	default:
		return "observer SQL account could not be provisioned after seed"
	}
}
