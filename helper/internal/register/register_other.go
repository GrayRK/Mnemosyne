//go:build !windows

package register

import "errors"

// errUnsupported — регистрация под macOS/Linux появится в этапе 5.7 (launchd/systemd
// и каталоги манифестов NativeMessagingHosts конкретной ОС).
var errUnsupported = errors.New("регистрация native-messaging пока поддержана только на Windows (см. этап 5.7)")

func Register() error   { return errUnsupported }
func Unregister() error { return errUnsupported }
