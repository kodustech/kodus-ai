// gitstub is an explicitly local, read-only fixture GitHub tarball API. It never proxies requests.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

func main() {
	root := flag.String("root", "", "owned tarball directory")
	listen := flag.String("listen", "127.0.0.1:0", "loopback listener")
	flag.Parse()
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || host != "127.0.0.1" || *root == "" {
		panic("root and loopback listen required")
	}
	addr, err := net.Listen("tcp", *listen)
	if err != nil {
		panic(err)
	}
	re := regexp.MustCompile(`^/repos/owned/fixture/tarball/([123]{40})$`)
	var mu sync.Mutex
	counts := map[string]int{}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/counts" {
			mu.Lock()
			defer mu.Unlock()
			_ = json.NewEncoder(w).Encode(counts)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/health" {
			w.WriteHeader(204)
			return
		}
		if r.Method == http.MethodDelete && r.URL.Path == "/installation/token" {
			w.WriteHeader(204)
			return
		}
		m := re.FindStringSubmatch(r.URL.Path)
		if r.Method != http.MethodGet || len(m) != 2 {
			http.NotFound(w, r)
			return
		}
		// Only the three immutable fixture SHAs; never join a caller-supplied path.
		sha := m[1]
		if sha != stringRepeat(sha[0], 40) {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(filepath.Join(*root, sha+".tgz"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || !st.Mode().IsRegular() || st.Size() > 1024*1024 {
			http.Error(w, "invalid fixture", 500)
			return
		}
		mu.Lock()
		counts[sha]++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/gzip")
		http.ServeContent(w, r, "fixture.tgz", time.Time{}, f)
	})
	fmt.Println(addr.Addr().String())
	s := &http.Server{Handler: handler, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 8192}
	if err := s.Serve(addr); err != nil {
		panic(err)
	}
}
func stringRepeat(b byte, n int) string {
	v := make([]byte, n)
	for i := range v {
		v[i] = b
	}
	return string(v)
}
