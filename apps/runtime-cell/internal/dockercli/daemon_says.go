package dockercli

import "strings"

// The docker CLI tells these daemon answers apart only by the text it prints
// on stderr (every one exits 1), so the cell recognizes them by the daemon's
// own phrase. One helper per answer keeps every phrase in this file.

// NoSuchImage is an image reference the daemon does not have.
func NoSuchImage(err error) bool { return daemonSays(err, "No such image") }

// NoSuchContainer is a container the daemon does not have.
func NoSuchContainer(err error) bool { return daemonSays(err, "No such container") }

// NotConnected is a disconnect of a container not attached to the network.
func NotConnected(err error) bool { return daemonSays(err, "is not connected") }

// PoolOverlap is a network create whose subnet another network already holds
// ("Pool overlaps with other one on this address space").
func PoolOverlap(err error) bool { return daemonSays(err, "overlap") }

func daemonSays(err error, phrase string) bool {
	return err != nil && strings.Contains(err.Error(), phrase)
}
