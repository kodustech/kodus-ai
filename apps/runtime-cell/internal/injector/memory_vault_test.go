package injector

import (
	"context"
	"errors"
	"sync"
)

// MemoryVault is a test and development vault.
type MemoryVault struct {
	mu    sync.Mutex
	creds map[string]Credential // claim|host
}

func (m *MemoryVault) Put(orgID, claimID, host string, c Credential) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.creds == nil {
		m.creds = map[string]Credential{}
	}
	m.creds[orgID+"|"+claimID+"|"+host] = c
}

func (m *MemoryVault) Credential(_ context.Context, orgID, claimID, host string) (Credential, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.creds[orgID+"|"+claimID+"|"+host]
	if !ok {
		return Credential{}, errors.New("no credential")
	}
	return c, nil
}
