// Package media реализует добычу аудио/видео через бандл yt-dlp + ffmpeg по модели
// «задача → прогресс → результат» (этап 5.2). Браузер не тянет это сам из-за защиты
// YouTube (poToken/BotGuard) — хэлпер делает это поддерживаемым инструментом.
package media

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"mnemosyne-helper/internal/config"
	"mnemosyne-helper/internal/tools"
)

// State — состояние задачи добычи.
type State string

const (
	StateRunning State = "running"
	StateDone    State = "done"
	StateError   State = "error"
)

// Kind — что добываем.
type Kind string

const (
	KindAudio Kind = "audio"
	KindVideo Kind = "video"
)

const (
	watchURLPrefix = "https://www.youtube.com/watch?v="
	// Шаблон имени файла: заголовок (обрезанный) + id, расширение подставит yt-dlp.
	outputTemplate = "%(title).150B [%(id)s].%(ext)s"
	idBytes        = 8
)

// progressRe выдёргивает процент из строк прогресса yt-dlp ("[download]  23.4% …").
var progressRe = regexp.MustCompile(`(\d+(?:\.\d+)?)%`)

// ParseKind валидирует тип задачи из запроса.
func ParseKind(s string) (Kind, error) {
	switch Kind(s) {
	case KindAudio:
		return KindAudio, nil
	case KindVideo:
		return KindVideo, nil
	default:
		return "", fmt.Errorf("неизвестный тип медиа: %q (ожидается audio|video)", s)
	}
}

// Job — одна задача добычи (потокобезопасна через mu).
type Job struct {
	id      string
	kind    Kind
	videoID string
	created time.Time

	done      chan struct{} // закрывается при завершении (готово/ошибка)
	closeOnce sync.Once

	mu       sync.Mutex
	state    State
	progress float64
	fileName string
	filePath string
	errMsg   string
}

// closeDone закрывает канал готовности ровно один раз.
func (j *Job) closeDone() {
	j.closeOnce.Do(func() { close(j.done) })
}

// Status — JSON-снимок задачи для отдачи расширению.
type Status struct {
	ID       string  `json:"id"`
	Kind     string  `json:"kind"`
	VideoID  string  `json:"videoId"`
	State    string  `json:"state"`
	Progress float64 `json:"progress"`
	FileName string  `json:"fileName,omitempty"`
	Error    string  `json:"error,omitempty"`
}

func (j *Job) snapshot() Status {
	j.mu.Lock()
	defer j.mu.Unlock()
	return Status{
		ID:       j.id,
		Kind:     string(j.kind),
		VideoID:  j.videoID,
		State:    string(j.state),
		Progress: j.progress,
		FileName: j.fileName,
		Error:    j.errMsg,
	}
}

func (j *Job) setProgress(p float64) {
	j.mu.Lock()
	if p > j.progress {
		j.progress = p
	}
	j.mu.Unlock()
}

func (j *Job) fail(msg string) {
	j.mu.Lock()
	j.state = StateError
	j.errMsg = msg
	j.mu.Unlock()
	j.closeDone()
}

func (j *Job) finish(fileName, filePath string) {
	j.mu.Lock()
	j.state = StateDone
	j.progress = 100
	j.fileName = fileName
	j.filePath = filePath
	j.mu.Unlock()
	j.closeDone()
}

// Manager хранит задачи и запускает их.
type Manager struct {
	mu   sync.Mutex
	jobs map[string]*Job
}

// NewManager создаёт пустой менеджер задач.
func NewManager() *Manager {
	return &Manager{jobs: make(map[string]*Job)}
}

// Start создаёт задачу и запускает добычу в фоне. Возвращает её id.
func (m *Manager) Start(kind Kind, videoID string) (string, error) {
	if videoID == "" {
		return "", fmt.Errorf("пустой videoId")
	}
	id, err := newID()
	if err != nil {
		return "", err
	}
	job := &Job{
		id:      id,
		kind:    kind,
		videoID: videoID,
		created: time.Now(),
		state:   StateRunning,
		done:    make(chan struct{}),
	}
	m.mu.Lock()
	m.jobs[id] = job
	m.mu.Unlock()
	go m.run(job)
	return id, nil
}

// Get возвращает снимок задачи.
func (m *Manager) Get(id string) (Status, bool) {
	m.mu.Lock()
	job, ok := m.jobs[id]
	m.mu.Unlock()
	if !ok {
		return Status{}, false
	}
	return job.snapshot(), true
}

// File возвращает путь и имя готового файла. ok=false, если задача не завершена.
func (m *Manager) File(id string) (path string, name string, ok bool) {
	m.mu.Lock()
	job, found := m.jobs[id]
	m.mu.Unlock()
	if !found {
		return "", "", false
	}
	job.mu.Lock()
	defer job.mu.Unlock()
	if job.state != StateDone || job.filePath == "" {
		return "", "", false
	}
	return job.filePath, job.fileName, true
}

// WaitFile блокируется до завершения задачи и возвращает путь+имя готового файла.
// Прерывается по ctx (таймаут запроса/отмена клиента). Так клиент может выбрать папку
// сразу, а скачивание начнётся, как только файл будет готов.
func (m *Manager) WaitFile(ctx context.Context, id string) (path string, name string, err error) {
	m.mu.Lock()
	job, found := m.jobs[id]
	m.mu.Unlock()
	if !found {
		return "", "", errors.New("job not found")
	}
	select {
	case <-job.done:
	case <-ctx.Done():
		return "", "", ctx.Err()
	}
	job.mu.Lock()
	defer job.mu.Unlock()
	if job.state != StateDone || job.filePath == "" {
		if job.errMsg != "" {
			return "", "", errors.New(job.errMsg)
		}
		return "", "", errors.New("file not ready")
	}
	return job.filePath, job.fileName, nil
}

// Active возвращает число выполняющихся задач (для idle-таймера сервера).
func (m *Manager) Active() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, j := range m.jobs {
		j.mu.Lock()
		if j.state == StateRunning {
			n++
		}
		j.mu.Unlock()
	}
	return n
}

// run выполняет yt-dlp, парсит прогресс и фиксирует результат.
func (m *Manager) run(job *Job) {
	ytdlp, err := tools.YtDlp()
	if err != nil {
		job.fail(err.Error())
		return
	}
	ffmpeg, err := tools.FFmpeg()
	if err != nil {
		job.fail(err.Error())
		return
	}

	dataDir, err := config.DataDir()
	if err != nil {
		job.fail(err.Error())
		return
	}
	outDir := filepath.Join(dataDir, "media", job.id)
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		job.fail(err.Error())
		return
	}

	args := buildArgs(job.kind, ffmpeg, outDir)
	args = append(args, watchURLPrefix+job.videoID)

	cmd := exec.Command(ytdlp, args...)
	hideWindow(cmd) // не показывать консольное окно yt-dlp/ffmpeg
	sink := &progressSink{job: job}
	cmd.Stdout = sink
	cmd.Stderr = sink

	if err := cmd.Run(); err != nil {
		job.fail(fmt.Sprintf("yt-dlp: %v", err))
		return
	}

	name, path, err := findOutput(outDir)
	if err != nil {
		job.fail(err.Error())
		return
	}
	job.finish(name, path)
}

// buildArgs собирает аргументы yt-dlp под тип задачи.
func buildArgs(kind Kind, ffmpeg, outDir string) []string {
	common := []string{
		"--no-playlist",
		"--newline", // прогресс отдельными строками, без перезаписи каретки
		"--no-cache-dir",
		"--ffmpeg-location", ffmpeg,
		"-o", filepath.Join(outDir, outputTemplate),
	}
	switch kind {
	case KindAudio:
		return append(common, "-x", "--audio-format", "mp3", "--audio-quality", "0")
	default: // KindVideo
		// Предпочитаем совместимый набор H.264 (avc1) + AAC (mp4a) — играется везде;
		// если такого нет — мерджим лучшее видео+аудио и ремуксим в mp4.
		return append(common,
			"-f", "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[vcodec^=avc1]+ba/b[vcodec^=avc1]/bv*+ba/b",
			"--merge-output-format", "mp4",
		)
	}
}

// ResolveTitle быстро получает заголовок видео (без скачивания) — для осмысленного
// имени файла в диалоге сохранения ещё до начала загрузки.
func ResolveTitle(videoID string) (string, error) {
	if videoID == "" {
		return "", errors.New("пустой videoId")
	}
	ytdlp, err := tools.YtDlp()
	if err != nil {
		return "", err
	}
	cmd := exec.Command(ytdlp, "--no-playlist", "--skip-download", "--print", "%(title)s", watchURLPrefix+videoID)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("yt-dlp title: %w", err)
	}
	title := strings.TrimSpace(string(out))
	if title == "" {
		return "", errors.New("пустой заголовок")
	}
	return title, nil
}

// findOutput выбирает итоговый файл в каталоге задачи (наибольший не-временный).
func findOutput(outDir string) (name string, path string, err error) {
	entries, err := os.ReadDir(outDir)
	if err != nil {
		return "", "", err
	}
	var bestSize int64 = -1
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if strings.HasSuffix(n, ".part") || strings.HasSuffix(n, ".ytdl") || strings.HasSuffix(n, ".temp") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.Size() > bestSize {
			bestSize = info.Size()
			name = n
			path = filepath.Join(outDir, n)
		}
	}
	if path == "" {
		return "", "", fmt.Errorf("итоговый файл не найден после добычи")
	}
	return name, path, nil
}

// progressSink — io.Writer для stdout/stderr yt-dlp: режет на строки и тянет процент.
type progressSink struct {
	job *Job
	mu  sync.Mutex
	buf []byte
}

func (s *progressSink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf = append(s.buf, p...)
	for {
		i := indexAny(s.buf, '\r', '\n')
		if i < 0 {
			break
		}
		line := string(s.buf[:i])
		s.buf = s.buf[i+1:]
		s.handleLine(line)
	}
	return len(p), nil
}

func (s *progressSink) handleLine(line string) {
	if !strings.Contains(line, "[download]") {
		return
	}
	match := progressRe.FindStringSubmatch(line)
	if match == nil {
		return
	}
	if v, err := strconv.ParseFloat(match[1], 64); err == nil {
		s.job.setProgress(v)
	}
}

func indexAny(b []byte, chars ...byte) int {
	for i, c := range b {
		for _, ch := range chars {
			if c == ch {
				return i
			}
		}
	}
	return -1
}

func newID() (string, error) {
	buf := make([]byte, idBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
