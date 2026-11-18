package dockerignore

import (
	"strings"
	"testing"
)

func compile(t *testing.T, file string) *Matcher {
	t.Helper()
	m, err := Compile([]byte(file))
	if err != nil {
		t.Fatalf("Compile(%q): %v", file, err)
	}
	return m
}

// check asserts which paths a file leaves out, read both on their own and
// in a walk that reaches each path through its directories.
func check(t *testing.T, file string, out, in []string) {
	t.Helper()
	m := compile(t, file)
	for _, want := range []struct {
		paths    []string
		excluded bool
	}{{out, true}, {in, false}} {
		for _, p := range want.paths {
			if got := m.Matches(p); got != want.excluded {
				t.Errorf("%q: Matches(%q) = %v, want %v", file, p, got, want.excluded)
			}
			if got := walkTo(m, p); got != want.excluded {
				t.Errorf("%q: walk to %q left it out = %v, want %v", file, p, got, want.excluded)
			}
		}
	}
}

// walkTo visits every directory above p, then p, as a context walk does,
// and reports whether p is left out (a skipped directory leaves out all
// it holds).
func walkTo(m *Matcher, p string) bool {
	w := m.Walk()
	parts := strings.Split(p, "/")
	for i := range parts {
		rel := strings.Join(parts[:i+1], "/")
		excluded, skip := w.Visit(rel, i < len(parts)-1)
		if skip {
			return true
		}
		if i == len(parts)-1 {
			return excluded
		}
	}
	return false
}

// The examples of https://docs.docker.com/build/concepts/context/#dockerignore-files.
func TestDocumentedExamples(t *testing.T) {
	t.Run("comment and one-level wildcard", func(t *testing.T) {
		check(t, "# comment\n*/temp*\n",
			[]string{"somedir/temporary.txt", "somedir/temp", "somedir/temp/inner.txt"},
			[]string{"temporary.txt", "a/b/temp.txt", "# comment"})
	})
	t.Run("two-level wildcard", func(t *testing.T) {
		check(t, "*/*/temp*", []string{"somedir/subdir/temporary.txt"}, []string{"somedir/temporary.txt", "temp"})
	})
	t.Run("one character", func(t *testing.T) {
		check(t, "temp?", []string{"tempa", "tempb"}, []string{"temp", "tempab", "dir/tempa"})
	})
	t.Run("any number of directories", func(t *testing.T) {
		check(t, "**/*.go", []string{"main.go", "a/b/c.go"}, []string{"main.goo", "a/go"})
	})
	t.Run("leading and trailing slashes", func(t *testing.T) {
		for _, line := range []string{"/foo/bar/", "/foo/bar", "foo/bar/", "foo/bar"} {
			check(t, line, []string{"foo/bar", "foo/bar/baz.txt"}, []string{"foo", "foo/barbaz", "x/foo/bar"})
		}
	})
	t.Run("cleaned, blank and the dot pattern", func(t *testing.T) {
		check(t, "  a/../b/./c  \n\n.\n", []string{"b/c"}, []string{"a", "x"})
	})
	t.Run("exception after a wildcard", func(t *testing.T) {
		check(t, "*.md\n!README.md\n", []string{"CHANGELOG.md"}, []string{"README.md", "docs/guide.md"})
	})
	t.Run("the last line that names a file decides", func(t *testing.T) {
		check(t, "*.md\n!README*.md\nREADME-secret.md\n", []string{"other.md", "README-secret.md"}, []string{"README.md", "README-x.md"})
	})
	t.Run("a later exception overrides a middle line", func(t *testing.T) {
		check(t, "*.md\nREADME-secret.md\n!README*.md\n", []string{"other.md"}, []string{"README.md", "README-secret.md"})
	})
	t.Run("an exception inside a left-out directory", func(t *testing.T) {
		check(t, "docs\n!docs/keep.txt\n", []string{"docs", "docs/a.txt", "docs/sub/b.txt"}, []string{"docs/keep.txt", "src/a.go"})
	})
}

func TestParseFollowsTheFrontend(t *testing.T) {
	got, err := Parse([]byte("\xEF\xBB\xBFbom\n#comment\n #not-a-comment\n\t\n ! /x/../y/ \n!\n/\n"))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"bom", "#not-a-comment", "!y", "!", "/"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("Parse = %q, want %q", got, want)
	}
}

// What BuildKit fails the build on is an error, never a matcher that
// leaves something out.
func TestBuildKitRefusesTheseFiles(t *testing.T) {
	for _, file := range []string{"!", "!/", "[", "a[b", "x\\", strings.Repeat("a", 70_000)} {
		if _, err := Compile([]byte(file)); err == nil {
			t.Errorf("Compile(%.20q) accepted a file BuildKit refuses", file)
		}
	}
}

// patternmatcher's shortcuts decide some patterns otherwise than a regexp
// would; the builder uses the shortcuts.
func TestPatternmatcherQuirks(t *testing.T) {
	check(t, "**foo", []string{"foo", "barfoo", "a/barfoo"}, []string{"foobar"})
	check(t, "**", []string{"a", "a/b"}, nil)
	check(t, "lib**", []string{"lib", "library", "lib/a"}, []string{"alib"})
	check(t, "a/**", []string{"a/b", "a/b/c"}, []string{"ab"})
	check(t, "**/node_modules", []string{"node_modules", "a/node_modules/x"}, []string{"node_modules2"})
	check(t, "a.b", []string{"a.b"}, []string{"axb"})
	check(t, "a?.(x)", []string{"ab.(x)"}, []string{"ab.x"})
}

// Where judging a path on its own and fsutil's walk disagree, the entry
// stays in: only what both leave out is out.
func TestDisagreementKeepsTheEntry(t *testing.T) {
	// Judged on its own, "!a" names a/b through its directory; the walk
	// skipped that pattern on "a" and never sees it again.
	m := compile(t, "a/b\n!a\n")
	if m.Matches("a/b") {
		t.Fatal("Matches: a/b should be put back by !a")
	}
	if walked, _ := m.matchUsingParent("a/b", []bool{false, false}); !walked {
		t.Fatal("walk: a/b should be left out")
	}
	if walkTo(m, "a/b") {
		t.Error("a/b is left out although one reading keeps it")
	}
	// The other way round: the walk keeps a/b, judged on its own it is out.
	m = compile(t, "a\n!a/b\na\n")
	if !m.Matches("a/b") {
		t.Fatal("Matches: the last a should leave a/b out")
	}
	if walkTo(m, "a/b") {
		t.Error("a/b is left out although the walk keeps it")
	}
}

func TestPruning(t *testing.T) {
	for _, c := range []struct {
		file string
		skip bool
	}{
		{"node_modules", true},
		{"node_modules\n!src", true},
		{"node_modules\n!node_modules/keep", false},
		{"node_modules\n!node_modules/keep/*", false},
		{"node_modules\n!**/keep", false},
	} {
		_, skip := compile(t, c.file).Walk().Visit("node_modules", true)
		if skip != c.skip {
			t.Errorf("%q: skip node_modules = %v, want %v", c.file, skip, c.skip)
		}
	}
}

// A walk forgets a directory's results once it leaves it.
func TestWalkLeavesDirectories(t *testing.T) {
	w := compile(t, "a\n!a/keep\n").Walk()
	for _, step := range []struct {
		rel      string
		dir      bool
		excluded bool
	}{
		{"a", true, true},
		{"a/drop", false, true},
		{"a/keep", false, false},
		{"b", true, false},
		{"b/drop", false, false},
	} {
		if excluded, _ := w.Visit(step.rel, step.dir); excluded != step.excluded {
			t.Errorf("Visit(%q) = %v, want %v", step.rel, excluded, step.excluded)
		}
	}
}
