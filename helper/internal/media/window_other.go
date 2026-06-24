//go:build !windows

package media

import "os/exec"

// На *nix скрывать нечего — заглушка для кроссплатформенной сборки.
func hideWindow(cmd *exec.Cmd) {}
