package localdocker

import "testing"

func TestAppAnswered(t *testing.T) {
	for code, want := range map[int]bool{
		200: true, 204: true, 302: true,
		401: true, 403: true, 429: true, // behind a sign-in, or limiting the poll
		400: false, 404: false, 500: false, 502: false, 503: false,
	} {
		if got := appAnswered(code); got != want {
			t.Errorf("appAnswered(%d) = %v, want %v", code, got, want)
		}
	}
}
