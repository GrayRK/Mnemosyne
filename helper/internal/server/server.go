// Package server поднимает локальный HTTP-сервер хэлпера на 127.0.0.1 (loopback).
// Это «служба» on-demand: тяжёлые задачи (добыча медиа — этап 5.2; локальные LLM —
// 5.3) живут здесь. Безопасность: токен сессии на каждый запрос + CORS только для
// расширений из allow-list. Сервер сам выключается после простоя (не резидент в RAM).
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"mnemosyne-helper/internal/config"
	"mnemosyne-helper/internal/media"
	"mnemosyne-helper/internal/runtime"
)

const (
	tokenBytes        = 32
	healthTimeout     = 1500 * time.Millisecond
	shutdownGrace     = 3 * time.Second
	idleTimeout       = 5 * time.Minute  // выключаемся после стольки простоя…
	idleCheckInterval = 30 * time.Second // …проверяя простой с таким периодом
	fileWaitTimeout   = 20 * time.Minute // максимум ожидания готовности файла в /file
)

// srv хранит состояние живого сервера (токен, менеджер медиа, отметку активности).
type srv struct {
	token string
	media *media.Manager

	mu           sync.Mutex
	lastActivity time.Time
}

// Run запускает сервер и блокируется до сигнала завершения или выключения по простою.
// Если живой сервер уже зарегистрирован и отвечает на /health — выходит (один на машину).
func Run() error {
	if info, err := runtime.Read(); err == nil && Ping(info) {
		log.Printf("[Mnemosyne helper] сервер уже запущен на порту %d — выходим", info.Port)
		return nil
	}

	token, err := newToken()
	if err != nil {
		return fmt.Errorf("генерация токена: %w", err)
	}

	ln, err := net.Listen("tcp", config.ServerHost+":0")
	if err != nil {
		return fmt.Errorf("слушаем %s: %w", config.ServerHost, err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	if err := runtime.Write(runtime.Info{
		Port:    port,
		Token:   token,
		PID:     os.Getpid(),
		Version: config.Version,
	}); err != nil {
		_ = ln.Close()
		return fmt.Errorf("запись helper.json: %w", err)
	}
	defer func() { _ = runtime.Remove() }()

	s := &srv{token: token, media: media.NewManager(), lastActivity: time.Now()}
	httpSrv := &http.Server{Handler: s.handler()}

	go func() {
		log.Printf("[Mnemosyne helper] слушаю http://%s:%d (pid %d, v%s)", config.ServerHost, port, os.Getpid(), config.Version)
		if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("[Mnemosyne helper] сервер остановлен с ошибкой: %v", err)
		}
	}()

	// Завершение по сигналу ОС ИЛИ по простою (что наступит раньше).
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case <-stop:
		log.Printf("[Mnemosyne helper] завершение по сигналу…")
	case <-s.idleWatch():
		log.Printf("[Mnemosyne helper] завершение по простою (%s без активности)…", idleTimeout)
	}

	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	return httpSrv.Shutdown(ctx)
}

// idleWatch возвращает канал, который закроется, когда сервер простаивает дольше
// idleTimeout и нет выполняющихся задач. Так хэлпер не висит в памяти впустую.
func (s *srv) idleWatch() <-chan struct{} {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(idleCheckInterval)
		defer ticker.Stop()
		for range ticker.C {
			s.mu.Lock()
			idleFor := time.Since(s.lastActivity)
			s.mu.Unlock()
			if idleFor >= idleTimeout && s.media.Active() == 0 {
				close(done)
				return
			}
		}
	}()
	return done
}

func (s *srv) touch() {
	s.mu.Lock()
	s.lastActivity = time.Now()
	s.mu.Unlock()
}

func (s *srv) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.wrap(s.handleHealth))
	mux.HandleFunc("GET /media/title", s.wrap(s.handleMediaTitle))
	mux.HandleFunc("POST /media/jobs", s.wrap(s.handleMediaStart))
	mux.HandleFunc("GET /media/jobs/{id}", s.wrap(s.handleMediaStatus))
	mux.HandleFunc("GET /media/jobs/{id}/file", s.wrap(s.handleMediaFile))
	return mux
}

// wrap навешивает на обработчик отметку активности, CORS и проверку токена.
func (s *srv) wrap(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.touch()
		origin := r.Header.Get("Origin")
		if config.IsAllowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Vary", "Origin")
		}
		if !s.checkToken(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "bad token"})
			return
		}
		next(w, r)
	}
}

// checkToken принимает токен из заголовка Authorization или из query (?token=,
// для chrome.downloads, который не умеет ставить заголовки).
func (s *srv) checkToken(r *http.Request) bool {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if got == "" {
		got = r.URL.Query().Get("token")
	}
	return got == s.token
}

func (s *srv) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"name":    config.HostName,
		"version": config.Version,
		"pid":     os.Getpid(),
	})
}

func (s *srv) handleMediaStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VideoID string `json:"videoId"`
		Kind    string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad json"})
		return
	}
	kind, err := media.ParseKind(req.Kind)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	id, err := s.media.Start(kind, req.VideoID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id})
}

func (s *srv) handleMediaTitle(w http.ResponseWriter, r *http.Request) {
	videoID := r.URL.Query().Get("videoId")
	title, err := media.ResolveTitle(videoID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "title": title})
}

func (s *srv) handleMediaStatus(w http.ResponseWriter, r *http.Request) {
	status, ok := s.media.Get(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "job not found"})
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *srv) handleMediaFile(w http.ResponseWriter, r *http.Request) {
	// Блокируемся до готовности файла: клиент (chrome.downloads) уже показал диалог
	// выбора папки и ждёт. Прерывается по таймауту или отмене клиента.
	ctx, cancel := context.WithTimeout(r.Context(), fileWaitTimeout)
	defer cancel()
	path, name, err := s.media.WaitFile(ctx, r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	// filename* (RFC 5987) — корректно отдаём не-ASCII заголовки видео в имени файла.
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	http.ServeFile(w, r, path)
}

// Ping проверяет, что сервер из Info жив и принимает наш токен.
func Ping(info runtime.Info) bool {
	if info.Port == 0 || info.Token == "" {
		return false
	}
	client := &http.Client{Timeout: healthTimeout}
	url := fmt.Sprintf("http://%s:%d/health", config.ServerHost, info.Port)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+info.Token)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode == http.StatusOK
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func newToken() (string, error) {
	buf := make([]byte, tokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
