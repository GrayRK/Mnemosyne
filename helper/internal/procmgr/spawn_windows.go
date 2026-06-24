//go:build windows

package procmgr

import (
	"os/exec"
	"syscall"
)

// Флаги создания процесса Windows: новый процесс без консольного окна и в своей
// группе, чтобы он не умер вместе с native-messaging-хостом.
const (
	createNoWindow      = 0x08000000 // CREATE_NO_WINDOW
	detachedProcess     = 0x00000008 // DETACHED_PROCESS
	newProcessGroupFlag = 0x00000200 // CREATE_NEW_PROCESS_GROUP
)

func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow | detachedProcess | newProcessGroupFlag,
	}
}
