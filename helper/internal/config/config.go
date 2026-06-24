// Package config держит единые константы хэлпера Mnemosyne: имя native-messaging
// хоста, версию, allow-list ID расширений и пути к рантайм-данным. Без магических
// строк по месту использования — единый источник правды (правило проекта).
package config

import (
	"os"
	"path/filepath"
)

const (
	// HostName — имя native-messaging хоста. Должно совпадать с ключом реестра
	// HKCU\Software\Google\Chrome\NativeMessagingHosts\<HostName> и с именем,
	// которое расширение передаёт в chrome.runtime.connectNative().
	HostName = "com.mnemosyne.helper"

	// Version — версия хэлпера. Возвращается расширению при рукопожатии для
	// индикатора «подключён / версия» в popup.
	Version = "0.0.1"

	// ServerHost — хэлпер слушает ТОЛЬКО loopback (требование безопасности 5.1).
	ServerHost = "127.0.0.1"

	// appDataSubdir — подпапка в %LOCALAPPDATA% (и аналогах) под рантайм-файлы.
	appDataSubdir = "Mnemosyne"

	// runtimeFileName — файл с координатами живого сервера (порт/токен/pid),
	// который пишет `serve` и читает `nm`.
	runtimeFileName = "helper.json"

	// nmManifestSubdir — подпапка под native-messaging-манифест (dev-регистрация).
	nmManifestSubdir = "nm"
)

// AllowedExtensionIDs — разрешённые ID расширения. У dev/unpacked сборки и у сборки
// из Chrome Web Store РАЗНЫЕ ID — здесь должны быть оба (требование 5.1). Сейчас
// зафиксирован детерминированный dev-ID (он задаётся через manifest.key в
// wxt.config.ts). Web Store ID добавится при публикации.
var AllowedExtensionIDs = []string{
	"fgdljagjbgmkjebhadodlahahapnbalp", // dev/unpacked (manifest.key)
	// "<web-store-id>",                // TODO: добавить после публикации
}

// DataDir — каталог рантайм-данных хэлпера (%LOCALAPPDATA%\Mnemosyne на Windows).
// Создаётся при необходимости вызывающим кодом.
func DataDir() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, appDataSubdir), nil
}

// RuntimeFilePath — путь к helper.json.
func RuntimeFilePath() (string, error) {
	dir, err := DataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, runtimeFileName), nil
}

// NMManifestPath — путь к native-messaging-манифесту хоста.
func NMManifestPath() (string, error) {
	dir, err := DataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, nmManifestSubdir, HostName+".json"), nil
}

// IsAllowedOrigin проверяет, что origin вида "chrome-extension://<id>/" входит в
// allow-list. Сравнение по ID, завершающий слэш и регистр не важны.
func IsAllowedOrigin(origin string) bool {
	const prefix = "chrome-extension://"
	if len(origin) <= len(prefix) || origin[:len(prefix)] != prefix {
		return false
	}
	id := origin[len(prefix):]
	if i := indexByte(id, '/'); i >= 0 {
		id = id[:i]
	}
	for _, allowed := range AllowedExtensionIDs {
		if id == allowed {
			return true
		}
	}
	return false
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}
