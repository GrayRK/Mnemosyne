//go:build windows

package media

import (
	"os/exec"
	"syscall"
)

// createNoWindow — CREATE_NO_WINDOW: консольный дочерний процесс (yt-dlp, ffmpeg)
// запускается без всплывающего окна консоли.
const createNoWindow = 0x08000000

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
