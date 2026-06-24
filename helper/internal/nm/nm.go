// Package nm реализует native-messaging-хост: его запускает Chrome, когда
// расширение вызывает chrome.runtime.connectNative(). Обмен идёт по stdio в формате
// Chrome: 4 байта длины (little-endian uint32) + JSON. Хост проверяет ID вызвавшего
// расширения по allow-list, гарантирует, что локальный сервер поднят, и отдаёт
// расширению координаты подключения (порт + токен сессии).
package nm

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"mnemosyne-helper/internal/config"
	"mnemosyne-helper/internal/procmgr"
	"mnemosyne-helper/internal/runtime"
	"mnemosyne-helper/internal/server"
)

const (
	// maxMessageBytes — потолок размера входящего сообщения (защита от мусора).
	maxMessageBytes = 1 << 20 // 1 MiB
	// serverWaitTimeout — сколько ждём готовности только что запущенного сервера.
	serverWaitTimeout = 5 * time.Second
	// serverPollInterval — период опроса helper.json при ожидании сервера.
	serverPollInterval = 100 * time.Millisecond
)

// inbound — сообщение от расширения.
type inbound struct {
	Type    string `json:"type"`
	Version string `json:"version,omitempty"`
}

// outbound — ответ расширению.
type outbound struct {
	Type    string `json:"type"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
	Port    int    `json:"port,omitempty"`
	Token   string `json:"token,omitempty"`
}

// Run обрабатывает native-messaging-сессию: блокируется до закрытия stdin
// (расширение отключило порт).
func Run() error {
	origin := callerOrigin(os.Args)
	if !config.IsAllowedOrigin(origin) {
		// Отвечаем ошибкой и выходим: чужому расширению координаты не выдаём.
		_ = writeMessage(os.Stdout, outbound{
			Type:  "error",
			OK:    false,
			Error: "origin not allowed: " + origin,
		})
		return fmt.Errorf("origin not allowed: %q", origin)
	}

	for {
		msg, err := readMessage(os.Stdin)
		if err == io.EOF {
			return nil // расширение закрыло порт — штатное завершение
		}
		if err != nil {
			return err
		}
		if err := handle(msg); err != nil {
			return err
		}
	}
}

func handle(msg inbound) error {
	switch msg.Type {
	case "hello", "": // рукопожатие (пустой type — тоже трактуем как hello)
		info, err := ensureServer()
		if err != nil {
			return writeMessage(os.Stdout, outbound{
				Type:  "error",
				OK:    false,
				Error: "server not available: " + err.Error(),
			})
		}
		return writeMessage(os.Stdout, outbound{
			Type:    "welcome",
			OK:      true,
			Name:    config.HostName,
			Version: config.Version,
			Port:    info.Port,
			Token:   info.Token,
		})
	case "ping":
		return writeMessage(os.Stdout, outbound{Type: "pong", OK: true, Version: config.Version})
	default:
		return writeMessage(os.Stdout, outbound{Type: "error", OK: false, Error: "unknown type: " + msg.Type})
	}
}

// ensureServer возвращает координаты живого сервера, при необходимости запустив его.
func ensureServer() (runtime.Info, error) {
	if info, err := runtime.Read(); err == nil && server.Ping(info) {
		return info, nil
	}
	if err := procmgr.SpawnServe(); err != nil {
		return runtime.Info{}, fmt.Errorf("запуск сервера: %w", err)
	}
	deadline := time.Now().Add(serverWaitTimeout)
	for time.Now().Before(deadline) {
		if info, err := runtime.Read(); err == nil && server.Ping(info) {
			return info, nil
		}
		time.Sleep(serverPollInterval)
	}
	return runtime.Info{}, fmt.Errorf("сервер не поднялся за %s", serverWaitTimeout)
}

// callerOrigin достаёт "chrome-extension://<id>/" из аргументов, которыми Chrome
// запускает native-messaging-хост.
func callerOrigin(args []string) string {
	for _, a := range args {
		if strings.HasPrefix(a, "chrome-extension://") {
			return a
		}
	}
	return ""
}

func readMessage(r io.Reader) (inbound, error) {
	var msg inbound
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		if err == io.ErrUnexpectedEOF {
			return msg, io.EOF
		}
		return msg, err
	}
	n := binary.LittleEndian.Uint32(lenBuf[:])
	if n == 0 || n > maxMessageBytes {
		return msg, fmt.Errorf("некорректная длина сообщения: %d", n)
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return msg, err
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return msg, fmt.Errorf("разбор JSON: %w", err)
	}
	return msg, nil
}

func writeMessage(w io.Writer, msg outbound) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(payload)))
	if _, err := w.Write(lenBuf[:]); err != nil {
		return err
	}
	_, err = w.Write(payload)
	return err
}
