// Package procmgr запускает постоянный сервер (`serve`) отдельным, отвязанным от
// родителя процессом. Нужно, потому что native-messaging-хост (`nm`) живёт лишь
// пока открыт порт расширения, а сервер должен пережить его (будущая служба).
package procmgr

import (
	"os"
	"os/exec"
)

// SpawnServe запускает текущий бинарь с аргументом "serve" как самостоятельный
// фоновый процесс (детали отвязки — в платформенных файлах spawn_*.go).
func SpawnServe() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "serve")
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	detach(cmd) // платформенная отвязка процесса
	return cmd.Start()
}
