package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// The fixtures live with the TS protocol (libs/runtime/protocol/fixtures)
// and run in jest too: both decoders accept the same frames with the same
// body and refuse the same frames with the same code.
const fixturesDir = "../../../../libs/runtime/protocol/fixtures"

type fixture struct {
	Name    string          `json:"name"`
	Frame   *string         `json:"frame"`
	Message json.RawMessage `json:"message"`
	Expect  struct {
		OK   bool   `json:"ok"`
		Type string `json:"type"`
		Code string `json:"code"`
	} `json:"expect"`
}

func generic(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestSharedFixtures(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(fixturesDir, "*.json"))
	if err != nil || len(files) < 20 {
		t.Fatalf("fixtures: %v (%d files)", err, len(files))
	}
	sort.Strings(files)
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var f fixture
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		t.Run(f.Name, func(t *testing.T) {
			frame := []byte(nil)
			if f.Frame != nil {
				frame = []byte(*f.Frame)
			} else {
				frame = f.Message
			}
			m, err := Decode(frame)
			if !f.Expect.OK {
				if err == nil {
					t.Fatalf("decoded, want %s", f.Expect.Code)
				}
				if got := codeOf(t, err); string(got) != f.Expect.Code {
					t.Fatalf("code %s, want %s (%v)", got, f.Expect.Code, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("refused: %v", err)
			}
			if string(m.Envelope.Type) != f.Expect.Type {
				t.Fatalf("type %s, want %s", m.Envelope.Type, f.Expect.Type)
			}
			// The typed body, encoded again, is the body that came in.
			var in struct {
				Body json.RawMessage `json:"body"`
			}
			_ = json.Unmarshal(f.Message, &in)
			out, err := json.Marshal(m.Body)
			if err != nil {
				t.Fatal(err)
			}
			if want, got := generic(t, in.Body), generic(t, out); !reflect.DeepEqual(want, got) {
				t.Fatalf("body differs\nwant %s\ngot  %s", in.Body, out)
			}
		})
	}
}
