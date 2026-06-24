// Package runtime читает/пишет helper.json — координаты живого локального сервера
// (порт, токен сессии, pid). `serve` пишет файл при старте, `nm` читает его, чтобы
// отдать расширению порт+токен для подключения.
package runtime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"mnemosyne-helper/internal/config"
)

// Info — содержимое helper.json.
type Info struct {
	Port      int    `json:"port"`
	Token     string `json:"token"`
	PID       int    `json:"pid"`
	Version   string `json:"version"`
	StartedAt string `json:"startedAt"`
}

// Write атомарно сохраняет helper.json (через временный файл + rename).
func Write(info Info) error {
	path, err := config.RuntimeFilePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	info.StartedAt = time.Now().UTC().Format(time.RFC3339)
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Read загружает helper.json. Возвращает ошибку, если файла нет.
func Read() (Info, error) {
	var info Info
	path, err := config.RuntimeFilePath()
	if err != nil {
		return info, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return info, err
	}
	err = json.Unmarshal(data, &info)
	return info, err
}

// Remove удаляет helper.json (вызывается сервером при штатном завершении).
func Remove() error {
	path, err := config.RuntimeFilePath()
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
