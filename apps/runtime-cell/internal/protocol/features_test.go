package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The features this build advertises are the ones the shared fixture names,
// which the TS side checks against CELL_FEATURES: a feature added on one
// side only fails one of the two suites.
func TestFeaturesAreTheSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(fixturesDir, "hello-features-recipe-execution.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Message struct {
			Body HelloBody `json:"body"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(Features(), f.Message.Body.Features) {
		t.Fatalf("Features() %v, fixture %v", Features(), f.Message.Body.Features)
	}
}

// The clamp bounds are the hello schema's (MACHINE_SIZE_LIMITS): a cell
// clamped to stale numbers would send a hello the hub refuses, or advertise
// less than it grants.
func TestMachineSizeBoundsAreTheHelloSchemas(t *testing.T) {
	var doc struct {
		Schemas struct {
			Hello struct {
				Properties struct {
					MaxClaimSize struct {
						Properties map[string]struct {
							Minimum int64 `json:"minimum"`
							Maximum int64 `json:"maximum"`
						} `json:"properties"`
					} `json:"maxClaimSize"`
				} `json:"properties"`
			} `json:"hello"`
		} `json:"schemas"`
	}
	if err := json.Unmarshal(schemaDoc, &doc); err != nil {
		t.Fatal(err)
	}
	p := doc.Schemas.Hello.Properties.MaxClaimSize.Properties
	if p["memoryMb"].Minimum != MinMachineMemoryMB || p["memoryMb"].Maximum != MaxMachineMemoryMB {
		t.Fatalf("memoryMb bounds %+v, constants %d..%d", p["memoryMb"], MinMachineMemoryMB, MaxMachineMemoryMB)
	}
	if p["cpus"].Minimum != MinMachineCPUs || p["cpus"].Maximum != MaxMachineCPUs {
		t.Fatalf("cpus bounds %+v, constants %d..%d", p["cpus"], MinMachineCPUs, MaxMachineCPUs)
	}
}

func TestMaxClaimSizeClampsToTheProtocolAndDropsWhatNoClaimAsks(t *testing.T) {
	for name, c := range map[string]struct {
		mem, cpus int64
		want      *MachineSize
	}{
		"within":         {16384, 8, &MachineSize{MemoryMb: 16384, Cpus: 8}},
		"at the minimum": {MinMachineMemoryMB, MinMachineCPUs, &MachineSize{MemoryMb: MinMachineMemoryMB, Cpus: MinMachineCPUs}},
		"above":          {1 << 20, 256, &MachineSize{MemoryMb: MaxMachineMemoryMB, Cpus: MaxMachineCPUs}},
		"zero":           {0, 0, nil},
		"memory too low": {MinMachineMemoryMB - 1, 8, nil},
		"no cpu":         {16384, 0, nil},
	} {
		t.Run(name, func(t *testing.T) {
			if got := MaxClaimSize(c.mem, c.cpus); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("MaxClaimSize(%d, %d) = %+v, want %+v", c.mem, c.cpus, got, c.want)
			}
		})
	}
}

// A hub older than readyBuildSteps acks hello without accepts: nothing it
// would refuse is sent. A name this build does not send is not accepted.
func TestAcceptedIsWhatTheHubEchoedOfWhatThisBuildSends(t *testing.T) {
	if got := Accepted(&AckBody{}); len(got) != 0 {
		t.Fatalf("an ack without accepts: %v", got)
	}
	if got := Accepted(nil); len(got) != 0 {
		t.Fatalf("no ack: %v", got)
	}
	got := Accepted(&AckBody{Accepts: []string{FeatureReadyBuildSteps, "someFutureField", FeatureClaimSize}})
	if !got[FeatureReadyBuildSteps] || len(got) != 1 {
		t.Fatalf("accepted %v", got)
	}
}
