package dockercli

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

const copyHelperTimeout = 90 * time.Minute

// CopyVolumeBound places the no-network data helper under the claim's
// aggregate budget. A failed/cancelled CLI is not proof that its container
// stopped: remove the named helper independently before returning capacity.
func (c CLI) CopyVolumeBound(ctx context.Context, runtime, helperImage, from, to string, labels map[string]string, parent string) error {
	return c.copyVolume(ctx, runtime, helperImage, from, to, labels, parent, "", "")
}

// CopyVolumeGeneration proves the source exists at the actual read, even if
// Docker auto-created an empty volume after a concurrent external removal.
func (c CLI) CopyVolumeGeneration(ctx context.Context, runtime, helperImage, from, to string, labels map[string]string, parent, expected, write string) error {
	for _, value := range []string{expected, write} {
		if value != "" {
			if len(value) != 24 {
				return errors.New("dockercli: invalid bake generation")
			}
			for _, c := range value {
				if !(c >= 'a' && c <= 'f' || c >= '0' && c <= '9') {
					return errors.New("dockercli: invalid bake generation")
				}
			}
		}
	}
	return c.copyVolume(ctx, runtime, helperImage, from, to, labels, parent, expected, write)
}

// Generation markers are fixed regular files. Neither a checkout symlink,
// FIFO nor directory may turn a trusted write/read into something else.
const generationCopyScript = `if [ -n "$1" ]; then test -f /from/.kodus-bake-generation && test ! -L /from/.kodus-bake-generation && test "$(cat /from/.kodus-bake-generation)" = "$1" || exit 78; fi
rm -rf /to/* /to/.[!.]* /to/..?*; cp -a /from/. /to/
if [ -n "$2" ]; then
  if [ -e /to/.kodus-bake-generation ] || [ -L /to/.kodus-bake-generation ]; then
    test -f /to/.kodus-bake-generation && test ! -L /to/.kodus-bake-generation || exit 78
    rm -f /to/.kodus-bake-generation
  fi
  (set -C; printf '%s' "$2" > /to/.kodus-bake-generation)
fi`

func (c CLI) copyVolume(ctx context.Context, runtime, helperImage, from, to string, labels map[string]string, parent, expected, write string) error {
	if err := ValidateCgroupParent(parent); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	deadline := time.Now().Add(copyHelperTimeout)
	if until, ok := ctx.Deadline(); ok && until.Before(deadline) {
		deadline = until
	}
	if value := labels[LabelFromTag(driver.TagHardExpires)]; value != "" {
		until, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return errors.New("dockercli: invalid data helper source ceiling")
		}
		if until.Before(deadline) {
			deadline = until
		}
	}
	if !deadline.After(time.Now()) {
		return context.DeadlineExceeded
	}
	runCtx, stop := context.WithDeadline(ctx, deadline)
	defer stop()
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return fmt.Errorf("dockercli: data helper identity: %w", err)
	}
	name := fmt.Sprintf("kodus-copy-%x", nonce)
	if labels != nil {
		if err := c.VolumeRemove(runCtx, to); err != nil {
			return err
		}
		args := []string{"volume", "create"}
		args = append(args, labelArgs(labels)...)
		if _, err := c.run(runCtx, nil, append(args, to)...); err != nil {
			return err
		}
	}
	// Container-only expiry/role must not change the baked volume's metadata.
	containerLabels := maps.Clone(labels)
	if containerLabels == nil {
		containerLabels = map[string]string{}
	}
	containerLabels[LabelFromTag(driver.TagHardExpires)] = driver.FormatTime(deadline)
	containerLabels[LabelFromTag(driver.TagRole)] = "copy"
	// A helper is independently reapable, never a compose service/holder.
	delete(containerLabels, "com.docker.compose.project")
	delete(containerLabels, "com.docker.compose.service")
	args := []string{"run", "--rm", "--name", name, "--network", "none"}
	if runtime != "" {
		args = append(args, "--runtime", runtime)
	}
	if parent != "" {
		args = append(args, "--cgroup-parent", parent)
	}
	args = append(args, labelArgs(containerLabels)...)
	args = append(args, "-v", from+":/from:ro", "-v", to+":/to", helperImage,
		"sh", "-ec", generationCopyScript, "kodus-copy", expected, write)
	guarded := expected != "" || write != ""
	var err error
	if guarded {
		// A created helper keeps the mounted source in use while its backend
		// metadata is checked. Auto-created empty volumes have no provenance.
		args[0] = "create"
		_, err = c.run(runCtx, nil, args...)
		if err == nil {
			var raw []byte
			raw, err = c.run(runCtx, nil, "volume", "inspect", "--format", "{{json .Labels}}", from)
			var source map[string]string
			if err == nil {
				err = json.Unmarshal(raw, &source)
			}
			if err == nil {
				if expected != "" && source["kodus.bake-generation"] != expected {
					err = errors.New("dockercli: source generation unavailable")
				}
				if write != "" && (labels["kodus.bake-source"] == "" || source["com.docker.compose.project"] != labels["kodus.bake-source"] || source["com.docker.compose.volume"] != labels["kodus.bake-volume"]) {
					err = errors.New("dockercli: setup source unavailable")
				}
			}
		}
		if err == nil {
			_, err = c.run(runCtx, nil, "start", "-a", name)
		}
	} else {
		_, err = c.run(runCtx, nil, args...)
	}
	if !guarded && err == nil && runCtx.Err() == nil {
		return nil
	}
	err = errors.Join(err, runCtx.Err())
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, removeErr := c.run(cleanup, nil, "rm", "-f", "-v", name); removeErr != nil && !strings.Contains(removeErr.Error(), "No such container") {
		return errors.Join(err, driver.ErrResourceCleanupPending, removeErr)
	}
	return err
}
