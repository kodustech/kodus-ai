package rootfs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"time"
)

// MinE2fsprogs is the first mke2fs that takes a tar archive for -d.
var MinE2fsprogs = [3]int{1, 47, 1}

var mke2fsVersion = regexp.MustCompile(`mke2fs (\d+)\.(\d+)(?:\.(\d+))?`)

// CheckMkfs reports whether the mkfs.ext4 at bin can build from a tar,
// and names what is missing when it cannot. mke2fs also needs libarchive
// at run time for a tar; MakeExt4 says so when it is missing.
func CheckMkfs(ctx context.Context, bin string) error {
	out, err := exec.CommandContext(ctx, bin, "-V").CombinedOutput()
	if err != nil {
		return fmt.Errorf("rootfs: %s -V: %w (install e2fsprogs %d.%d.%d or later)", bin, err, MinE2fsprogs[0], MinE2fsprogs[1], MinE2fsprogs[2])
	}
	return checkVersion(string(out))
}

func checkVersion(out string) error {
	m := mke2fsVersion.FindStringSubmatch(out)
	if m == nil {
		return fmt.Errorf("rootfs: cannot read the mke2fs version from %q", out)
	}
	var v [3]int
	for i := range 3 {
		if m[i+1] != "" {
			v[i], _ = strconv.Atoi(m[i+1])
		}
	}
	for i := range 3 {
		if v[i] != MinE2fsprogs[i] {
			if v[i] < MinE2fsprogs[i] {
				return fmt.Errorf("rootfs: mke2fs %d.%d.%d cannot build from a tar; e2fsprogs %d.%d.%d or later can", v[0], v[1], v[2], MinE2fsprogs[0], MinE2fsprogs[1], MinE2fsprogs[2])
			}
			return nil
		}
	}
	return nil
}

// Ext4 says how the ext4 image is made.
type Ext4 struct {
	// Mkfs is the mkfs.ext4 binary ("mkfs.ext4" on PATH when empty).
	Mkfs string
	// Label is the file system's label.
	Label string
	// ExtraMB is free space on top of what the files take.
	ExtraMB int
	// SourceDate stamps the file system (reproducible builds); zero: now.
	SourceDate time.Time
}

// SizeMB is the image size for a flattened tar: its bytes plus a quarter
// for the file system's own blocks, plus extra.
func SizeMB(tarBytes int64, extraMB int) int64 {
	mb := (tarBytes + (1 << 20) - 1) >> 20
	return mb + mb/4 + 16 + int64(extraMB)
}

// MakeExt4 writes out, an ext4 image of the tar at tarPath (a Flatten
// output), with the file system's UUID and hash seed taken from the tar's
// digest, so the same input makes the same image.
func MakeExt4(ctx context.Context, tarPath, out string, o Ext4) error {
	bin := o.Mkfs
	if bin == "" {
		bin = "mkfs.ext4"
	}
	if err := CheckMkfs(ctx, bin); err != nil {
		return err
	}
	f, err := os.Open(tarPath) //nolint:gosec // G304: the builder's own scratch file
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(h, f)
	_ = f.Close()
	if err != nil {
		return err
	}
	sum := h.Sum(nil)
	uuid := fmt.Sprintf("%x-%x-%x-%x-%x", sum[0:4], sum[4:6], append([]byte{sum[6]&0x0f | 0x40}, sum[7]), append([]byte{sum[8]&0x3f | 0x80}, sum[9]), sum[10:16])
	if err := os.Remove(out); err != nil && !os.IsNotExist(err) {
		return err
	}
	size := SizeMB(n, o.ExtraMB)
	if err := os.WriteFile(out, nil, 0o644); err != nil { //nolint:gosec // G306: a root image every VM reads
		return err
	}
	if err := os.Truncate(out, size<<20); err != nil {
		return err
	}
	label := o.Label
	if label == "" {
		label = "kody-root"
	}
	args := []string{"-q", "-F", "-t", "ext4", "-L", label, "-U", uuid, "-E", "hash_seed=" + uuid + ",root_owner=0:0", "-d", tarPath, out}
	cmd := exec.CommandContext(ctx, bin, args...) //nolint:gosec // G204: the builder's own arguments
	date := o.SourceDate
	if date.IsZero() {
		date = time.Now()
	}
	// libarchive reads the tar's names in the current locale: a UTF-8 one,
	// or a non-ASCII name or link target fails the build.
	cmd.Env = append(os.Environ(), "E2FSPROGS_FAKE_TIME="+strconv.FormatInt(date.Unix(), 10), "LC_ALL=C.UTF-8")
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stderr, &stderr
	if err := cmd.Run(); err != nil {
		_ = os.Remove(out)
		hint := ""
		if bytes.Contains(stderr.Bytes(), []byte("libarchive")) {
			hint = " (mke2fs reads a tar through libarchive: install it next to e2fsprogs)"
		}
		return fmt.Errorf("rootfs: mkfs.ext4: %w: %s%s", err, bytes.TrimSpace(stderr.Bytes()), hint)
	}
	return nil
}
