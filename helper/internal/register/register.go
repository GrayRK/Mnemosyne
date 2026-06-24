// Package register пишет/удаляет native-messaging-манифест хоста и связывает его
// с браузером. Платформенная часть (реестр Windows / пути браузеров) — в
// register_*.go; здесь общий код сборки манифеста.
package register

import (
	"encoding/json"
	"os"
	"path/filepath"

	"mnemosyne-helper/internal/config"
)

// manifest — структура native-messaging-манифеста (формат Chrome).
type manifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

// writeManifest сохраняет манифест, указывающий на текущий бинарь хэлпера, и
// возвращает путь к нему. allowed_origins формируется из allow-list ID расширений.
func writeManifest() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	manifestPath, err := config.NMManifestPath()
	if err != nil {
		return "", err
	}
	origins := make([]string, 0, len(config.AllowedExtensionIDs))
	for _, id := range config.AllowedExtensionIDs {
		origins = append(origins, "chrome-extension://"+id+"/")
	}
	m := manifest{
		Name:           config.HostName,
		Description:    "Mnemosyne native helper",
		Path:           exe,
		Type:           "stdio",
		AllowedOrigins: origins,
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(manifestPath, data, 0o644); err != nil {
		return "", err
	}
	return manifestPath, nil
}
