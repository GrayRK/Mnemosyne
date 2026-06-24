// Package tools находит сторонние бинари (yt-dlp, ffmpeg), забандленные с хэлпером.
// Порядок поиска: рядом с exe (релиз) → подпапка tools/ рядом с exe → ../tools
// (dev: exe лежит в helper/bin, инструменты в helper/tools) → PATH.
package tools

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// Имена бинарей (на Windows — с .exe; на прочих ОС добавится позже, этап 5.7).
func exeName(base string) string {
	if runtime.GOOS == "windows" {
		return base + ".exe"
	}
	return base
}

// YtDlp возвращает путь к yt-dlp или ошибку, если инструмент не найден.
func YtDlp() (string, error) { return resolve(exeName("yt-dlp")) }

// FFmpeg возвращает путь к ffmpeg или ошибку, если инструмент не найден.
func FFmpeg() (string, error) { return resolve(exeName("ffmpeg")) }

// resolve ищет бинарь по фиксированным кандидатам, затем в PATH.
func resolve(name string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exeDir := filepath.Dir(exe)
	candidates := []string{
		filepath.Join(exeDir, name),                  // релиз: рядом с exe
		filepath.Join(exeDir, "tools", name),         // релиз: подпапка tools/
		filepath.Join(exeDir, "..", "tools", name),   // dev: helper/bin → helper/tools
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("инструмент %q не найден (нет в бандле и в PATH)", name)
}
