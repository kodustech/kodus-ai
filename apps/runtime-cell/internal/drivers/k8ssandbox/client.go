package k8ssandbox

import (
	"bytes"
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
	maxBody           = 64 << 20
)

// Object is an unstructured manifest (apiVersion, kind, metadata, spec).
type Object = map[string]any

// KubeAPI is what the driver asks of the cluster: pods in one namespace,
// nothing else. The cell's Role grants exactly these verbs there.
type KubeAPI interface {
	// CreatePod creates the pod, or with dryRun has the API server run
	// admission on it and persist nothing (the preflight).
	CreatePod(ctx context.Context, namespace string, pod Object, dryRun bool) (Object, error)
	GetPod(ctx context.Context, namespace, name string) (Object, error)
	DeletePod(ctx context.Context, namespace, name string) error
	// ListPods is the namespace's pods carrying every label given.
	ListPods(ctx context.Context, namespace string, labels map[string]string) ([]Object, error)
	// PatchPodAnnotations merges the annotations into the pod's.
	PatchPodAnnotations(ctx context.Context, namespace, name string, annotations map[string]string) error
}

// Execer opens a command's stdin and stdout in a pod's container.
type Execer interface {
	Exec(ctx context.Context, namespace, pod, container string, command []string) (io.ReadWriteCloser, error)
}

// ErrNotFound is the API server's 404.
var ErrNotFound = errors.New("k8ssandbox: not found")

// APIError is an answer of the API server other than 2xx and 404: a 403
// from admission (Pod Security, a ValidatingAdmissionPolicy, the
// ResourceQuota) or a 422 from validation.
type APIError struct {
	Method, Path string
	Code         int
	Reason       string
	Message      string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("k8ssandbox: %s %s: %d %s: %s", e.Method, e.Path, e.Code, e.Reason, e.Message)
}

// Refused reports whether the API server refused the request on its merits
// (admission or validation), not because it could not answer.
func (e *APIError) Refused() bool {
	return e.Code == http.StatusForbidden || e.Code == http.StatusUnprocessableEntity || e.Code == http.StatusBadRequest
}

// Client is a KubeAPI and an Execer over the API server's REST API, with
// a bearer token. No client-go: pods are the only resource it knows.
type Client struct {
	// Base is the API server, https://host:port.
	Base string
	// Token returns the bearer token (re-read: projected tokens rotate).
	Token func() (string, error)
	HTTP  *http.Client
}

// InClusterClient is a Client with the pod's service account.
func InClusterClient() (*Client, error) {
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
	return &Client{
		Base: "https://" + net.JoinHostPort(host, port),
		Token: func() (string, error) {
			b, err := os.ReadFile(serviceAccountDir + "/token")
			return strings.TrimSpace(string(b)), err
		},
		HTTP: &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}},
	}, nil
}

// InCluster reports whether this process runs in a pod with a service
// account: the API server's address in the environment and the token file.
func InCluster(getenv func(string) string, exists func(string) bool) bool {
	return getenv("KUBERNETES_SERVICE_HOST") != "" && getenv("KUBERNETES_SERVICE_PORT") != "" && exists(serviceAccountDir+"/token")
}

func (c *Client) authorize(h http.Header) error {
	if c.Token == nil {
		return nil
	}
	tok, err := c.Token()
	if err != nil {
		return err
	}
	h.Set("Authorization", "Bearer "+tok)
	return nil
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, contentType string, body []byte) ([]byte, error) {
	u := strings.TrimRight(c.Base, "/") + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, err
	}
	if err := c.authorize(req.Header); err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	out, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, err
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, ErrNotFound
	case resp.StatusCode/100 != 2:
		return nil, statusError(method, path, resp.StatusCode, out)
	}
	return out, nil
}

// statusError reads the API server's Status object (reason, message),
// clipped: it ends up in logs and blockers.
func statusError(method, path string, code int, body []byte) *APIError {
	var st struct {
		Reason  string `json:"reason"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &st) != nil || st.Message == "" {
		st.Message = strings.TrimSpace(string(body))
	}
	if len(st.Message) > 512 {
		st.Message = st.Message[:512]
	}
	return &APIError{Method: method, Path: path, Code: code, Reason: st.Reason, Message: st.Message}
}

func podsPath(namespace string) string {
	return "/api/v1/namespaces/" + url.PathEscape(namespace) + "/pods"
}

func podPath(namespace, name string) string {
	return podsPath(namespace) + "/" + url.PathEscape(name)
}

func decode(body []byte) (Object, error) {
	var o Object
	if err := json.Unmarshal(body, &o); err != nil {
		return nil, err
	}
	return o, nil
}

func (c *Client) CreatePod(ctx context.Context, namespace string, pod Object, dryRun bool) (Object, error) {
	body, err := json.Marshal(pod)
	if err != nil {
		return nil, err
	}
	var q url.Values
	if dryRun {
		q = url.Values{"dryRun": {"All"}}
	}
	out, err := c.do(ctx, http.MethodPost, podsPath(namespace), q, "application/json", body)
	if err != nil {
		return nil, err
	}
	return decode(out)
}

func (c *Client) GetPod(ctx context.Context, namespace, name string) (Object, error) {
	out, err := c.do(ctx, http.MethodGet, podPath(namespace, name), nil, "", nil)
	if err != nil {
		return nil, err
	}
	return decode(out)
}

func (c *Client) DeletePod(ctx context.Context, namespace, name string) error {
	_, err := c.do(ctx, http.MethodDelete, podPath(namespace, name), nil, "", nil)
	return err
}

// labelSelector is the selector of labels, sorted so a request is stable.
func labelSelector(labels map[string]string) string {
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	sel := make([]string, 0, len(keys))
	for _, k := range keys {
		sel = append(sel, k+"="+labels[k])
	}
	return strings.Join(sel, ",")
}

func (c *Client) ListPods(ctx context.Context, namespace string, labels map[string]string) ([]Object, error) {
	out, err := c.do(ctx, http.MethodGet, podsPath(namespace), url.Values{"labelSelector": {labelSelector(labels)}}, "", nil)
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []Object `json:"items"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, err
	}
	return list.Items, nil
}

func (c *Client) PatchPodAnnotations(ctx context.Context, namespace, name string, annotations map[string]string) error {
	body, err := json.Marshal(map[string]any{"metadata": map[string]any{"annotations": annotations}})
	if err != nil {
		return err
	}
	_, err = c.do(ctx, http.MethodPatch, podPath(namespace, name), nil, "application/merge-patch+json", body)
	return err
}

var (
	_ KubeAPI = (*Client)(nil)
	_ Execer  = (*Client)(nil)
)
