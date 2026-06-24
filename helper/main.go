// Command mnemosyne-helper — нативный десктоп-компаньон Mnemosyne (Стадия 5).
// Тонкое расширение делегирует ему тяжёлую работу (добыча медиа, локальные LLM —
// этапы 5.2/5.3). Сейчас реализован каркас связки «расширение ↔ хэлпер» (5.1).
//
// Подкоманды:
//
//	serve        запустить локальный сервер на 127.0.0.1 (будущая служба)
//	nm           режим native-messaging-хоста (запускается браузером)
//	register     прописать native-messaging-манифест и реестр (dev)
//	unregister   снять регистрацию
//	version      показать версию
package main

import (
	"fmt"
	"log"
	"os"
	"strings"

	"mnemosyne-helper/internal/config"
	"mnemosyne-helper/internal/nm"
	"mnemosyne-helper/internal/register"
	"mnemosyne-helper/internal/server"
)

func main() {
	// В режиме native-messaging stdout занят протоколом — логи только в stderr.
	log.SetOutput(os.Stderr)
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)

	// Браузер запускает native-messaging-хост ПО ПУТИ ИЗ МАНИФЕСТА и передаёт только
	// origin расширения (chrome-extension://…/) и --parent-window=…, без нашей подкоманды.
	// Поэтому запуск с origin-аргументом трактуем как режим nm (а не как подкоманду).
	if isNativeMessagingLaunch(os.Args) {
		if err := nm.Run(); err != nil {
			log.Printf("[Mnemosyne helper] ошибка: %v", err)
			os.Exit(1)
		}
		return
	}

	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "serve":
		err = server.Run()
	case "nm":
		err = nm.Run()
	case "register":
		err = register.Register()
	case "unregister":
		err = register.Unregister()
	case "uninstall":
		err = doUninstall()
	case "version", "-v", "--version":
		fmt.Printf("mnemosyne-helper v%s (%s)\n", config.Version, config.HostName)
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "неизвестная команда: %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}

	if err != nil {
		log.Printf("[Mnemosyne helper] ошибка: %v", err)
		os.Exit(1)
	}
}

// doUninstall полностью убирает следы хэлпера: снимает регистрацию native-messaging
// (реестр + манифест) и удаляет каталог рантайм-данных (helper.json, добытые медиа).
// Вызывается деинсталлятором перед удалением файлов программы.
func doUninstall() error {
	if err := register.Unregister(); err != nil {
		log.Printf("[Mnemosyne helper] снятие регистрации: %v (продолжаем очистку)", err)
	}
	dir, err := config.DataDir()
	if err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("удаление данных %s: %w", dir, err)
	}
	fmt.Printf("Данные хэлпера удалены: %s\n", dir)
	return nil
}

// isNativeMessagingLaunch распознаёт запуск браузером: среди аргументов есть origin
// расширения (chrome-extension://…) или хэндл родительского окна (--parent-window=…).
func isNativeMessagingLaunch(args []string) bool {
	for _, a := range args[1:] {
		if strings.HasPrefix(a, "chrome-extension://") || strings.HasPrefix(a, "--parent-window") {
			return true
		}
	}
	return false
}

func usage() {
	fmt.Fprintf(os.Stderr, `mnemosyne-helper v%s

Использование:
  mnemosyne-helper <команда>

Команды:
  serve        запустить локальный сервер на 127.0.0.1 (будущая служба)
  nm           режим native-messaging-хоста (запускается браузером)
  register     прописать native-messaging-манифест и реестр (dev)
  unregister   снять регистрацию
  uninstall    снять регистрацию И удалить рантайм-данные (для деинсталлятора)
  version      показать версию
`, config.Version)
}
