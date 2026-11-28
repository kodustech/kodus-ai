package dockergvisor

import "testing"

// Every build runs like the project's CI, and reaches the mirror's Firebase
// emulators only when the cell serves artifacts.
func TestBuildsGetCITrueAndTheEmulatorsMirror(t *testing.T) {
	got := mirrorBuildArgs(nil, Config{})
	if got["CI"] != "true" || len(got) != 1 {
		t.Fatalf("no mirror: %v", got)
	}
	got = mirrorBuildArgs(map[string]string{"CI": "false"}, Config{MirrorArtifacts: "http://mirror.cell.internal:8080/artifacts/"})
	if got["CI"] != "false" || got["FIREBASE_EMULATORS_MIRROR"] != "http://mirror.cell.internal:8080/artifacts/firebase-emulators" {
		t.Fatalf("with artifacts: %v", got)
	}
}
