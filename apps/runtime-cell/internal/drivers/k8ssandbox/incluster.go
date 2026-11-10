package k8ssandbox

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

// Where a pod's service account finds the API server's CA and its token.
const (
	serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"
	maxListBody       = 64 << 20
)

// errReadOnly: the reaper's API client lists, reads and deletes; it never
// creates anything.
var errReadOnly = errors.New("k8ssandbox: this client only lists, reads and deletes pods")

// PodClient is a KubeAPI for pods only, over the API server's REST API: what
// the reaper needs (list, get, delete) with its service account. Apply is
// refused.
type PodClient struct {
	// Base is the API server, https://host:port.
	Base string
	// Token returns the bearer token (re-read: projected tokens rotate).
	Token func() (string, error)
	HTTP  *http.Client
}

// InClusterPodClient is a PodClient with the pod's service account.
func InClusterPodClient() (*PodClient, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("k8ssandbox: not in a cluster (KUBERNETES_SERVICE_HOST unset)")
	}
	ca, err := os.ReadFile(serviceAccountDir + "/ca.crt")
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("k8ssandbox: no CA in the service account")
	}
	return &PodClient{
		Base: "https://" + net.JoinHostPort(host, port),
		Token: func() (string, error) {
			b, err := os.ReadFile(serviceAccountDir + "/token")
			return strings.TrimSpace(string(b)), err
		},
		HTTP: &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}},
	}, nil
}

func (c *PodClient) do(ctx context.Context, method, path string, query url.Values) ([]byte, error) {
	u := strings.TrimRight(c.Base, "/") + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return nil, err
	}
	if c.Token != nil {
		tok, err := c.Token()
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxListBody))
	if err != nil {
		return nil, err
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, ErrNotFound
	case resp.StatusCode/100 != 2:
		msg := string(body)
		if len(msg) > 256 {
			msg = msg[:256]
		}
		return nil, fmt.Errorf("k8ssandbox: %s %s: %d: %s", method, path, resp.StatusCode, strings.TrimSpace(msg))
	}
	return body, nil
}

func podsOnly(apiVersion, kind string) error {
	if apiVersion != "v1" || kind != "Pod" {
		return fmt.Errorf("%w (asked for %s %s)", errReadOnly, apiVersion, kind)
	}
	return nil
}

func podPath(namespace, name string) string {
	return "/api/v1/namespaces/" + url.PathEscape(namespace) + "/pods/" + url.PathEscape(name)
}

func (c *PodClient) Apply(context.Context, Object) error { return errReadOnly }

func (c *PodClient) Get(ctx context.Context, apiVersion, kind, namespace, name string) (Object, error) {
	if err := podsOnly(apiVersion, kind); err != nil {
		return nil, err
	}
	body, err := c.do(ctx, http.MethodGet, podPath(namespace, name), nil)
	if err != nil {
		return nil, err
	}
	var o Object
	return o, json.Unmarshal(body, &o)
}

func (c *PodClient) Delete(ctx context.Context, apiVersion, kind, namespace, name string) error {
	if err := podsOnly(apiVersion, kind); err != nil {
		return err
	}
	_, err := c.do(ctx, http.MethodDelete, podPath(namespace, name), nil)
	return err
}

// List is every pod, in every namespace, carrying all of labels.
func (c *PodClient) List(ctx context.Context, apiVersion, kind string, labels map[string]string) ([]Object, error) {
	if err := podsOnly(apiVersion, kind); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	sel := make([]string, 0, len(keys))
	for _, k := range keys {
		sel = append(sel, k+"="+labels[k])
	}
	body, err := c.do(ctx, http.MethodGet, "/api/v1/pods", url.Values{"labelSelector": {strings.Join(sel, ",")}})
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []Object `json:"items"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, err
	}
	return list.Items, nil
}

// NewForReaper is a driver that can only list and destroy this cell's pods:
// the reaper's (its role has list, get and delete on pods, nothing else).
func NewForReaper(k KubeAPI, cellID string) *Driver {
	return &Driver{k: k, cfg: Config{CellID: cellID}}
}

var _ KubeAPI = (*PodClient)(nil)
