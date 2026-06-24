//go:build !windows

package procmgr

import (
	"os/exec"
	"syscall"
)

// На *nix отвязываем процесс в новую сессию (Setsid), чтобы он пережил родителя.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
