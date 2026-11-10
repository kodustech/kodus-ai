package claimlimits

import (
	"fmt"
	"io/fs"
)

// Every resource property is decoded without coercion: omitted ceilings are
// different from zero. Slice units do not support delegation; an unexpected
// Delegate property is still checked when a manager exposes one.
func decodeSystemdUnit(p map[string]any) (systemdUnit, error) {
	u := systemdUnit{}
	for name, to := range map[string]*string{"Id": &u.Name, "Description": &u.Description, "Slice": &u.Slice, "ControlGroup": &u.ControlGroup, "ActiveState": &u.ActiveState} {
		v, ok := p[name].(string)
		if !ok {
			return u, fmt.Errorf("%w: missing/invalid %s", ErrUnavailable, name)
		}
		*to = v
	}
	for name, to := range map[string]*bool{"Transient": &u.Transient, "StopWhenUnneeded": &u.StopWhenUnneeded, "CPUAccounting": &u.CPUAccounting, "MemoryAccounting": &u.MemoryAccounting, "TasksAccounting": &u.TasksAccounting} {
		v, ok := p[name].(bool)
		if !ok {
			return u, fmt.Errorf("%w: missing/invalid %s", ErrUnavailable, name)
		}
		*to = v
	}
	if v, exists := p["Delegate"]; exists {
		var ok bool
		u.Delegate, ok = v.(bool)
		if !ok {
			return u, fmt.Errorf("%w: invalid Delegate", ErrUnavailable)
		}
	}
	for name, to := range map[string]*uint64{"MemoryMax": &u.MemoryMax, "MemorySwapMax": &u.MemorySwapMax, "TasksMax": &u.TasksMax, "CPUQuotaPerSecUSec": &u.CPUQuotaPerSecUSec, "CPUQuotaPeriodUSec": &u.CPUQuotaPeriodUSec} {
		v, ok := p[name].(uint64)
		if !ok {
			return u, fmt.Errorf("%w: missing/invalid %s", ErrUnavailable, name)
		}
		*to = v
	}
	return u, nil
}

// A read can materialize an automatic slice object even before a unit has
// been created. Only a fully identified, file-free inactive placeholder under
// our generated namespace is absent; configured/transient units stay intact.
func decodeNativeSystemdUnit(name string, p map[string]any) (systemdUnit, error) {
	unit, err := decodeSystemdUnit(p)
	if err != nil {
		return unit, err
	}
	fragment, fok := p["FragmentPath"].(string)
	source, sok := p["SourcePath"].(string)
	dropins, dok := p["DropInPaths"].([]string)
	load, lok := p["LoadState"].(string)
	if systemdParentPattern.MatchString(name) && unit.Name == name && unit.ActiveState == "inactive" && !unit.Transient && unit.ControlGroup == "" && fok && fragment == "" && sok && source == "" && dok && len(dropins) == 0 && lok && load == "loaded" {
		return systemdUnit{}, fs.ErrNotExist
	}
	return unit, nil
}
