//go:build windows

package register

import (
	"fmt"
	"os"
	"os/exec"

	"mnemosyne-helper/internal/config"
)

// browserRegKeys — ветки реестра HKCU, где Chromium-браузеры ищут манифесты
// native-messaging-хостов. Регистрируем под Chrome и Edge (dev-сценарий).
var browserRegKeys = []string{
	`HKCU\Software\Google\Chrome\NativeMessagingHosts\` + config.HostName,
	`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\` + config.HostName,
}

// Register пишет манифест и прописывает путь к нему в реестр для каждого браузера.
func Register() error {
	manifestPath, err := writeManifest()
	if err != nil {
		return fmt.Errorf("запись манифеста: %w", err)
	}
	for _, key := range browserRegKeys {
		// reg add "<key>" /ve /t REG_SZ /d "<manifestPath>" /f
		cmd := exec.Command("reg", "add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f")
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("reg add %s: %w (%s)", key, err, out)
		}
	}
	fmt.Printf("Зарегистрирован native-messaging-хост %q\n", config.HostName)
	fmt.Printf("  манифест: %s\n", manifestPath)
	for _, key := range browserRegKeys {
		fmt.Printf("  реестр:   %s\n", key)
	}
	return nil
}

// Unregister удаляет ключи реестра и файл манифеста.
func Unregister() error {
	for _, key := range browserRegKeys {
		cmd := exec.Command("reg", "delete", key, "/f")
		if out, err := cmd.CombinedOutput(); err != nil {
			// Отсутствие ключа — не ошибка для идемпотентного снятия.
			fmt.Printf("  (пропуск) reg delete %s: %s\n", key, out)
		}
	}
	manifestPath, err := config.NMManifestPath()
	if err != nil {
		return err
	}
	if err := os.Remove(manifestPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("удаление манифеста: %w", err)
	}
	fmt.Printf("native-messaging-хост %q снят с регистрации\n", config.HostName)
	return nil
}
