package common

import (
	"braces.dev/errtrace"
	"bufio"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// LoggingMiddleware logs HTTP requests with method, path, status, and duration
func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lw := &logResponseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(lw, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, lw.status, time.Since(start).Round(time.Microsecond))
	})
}

type logResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *logResponseWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// Hijack implements http.Hijacker so WebSocket upgrades work through the logging middleware.
func (w *logResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return errtrace.Wrap3(w.ResponseWriter.(http.Hijacker).Hijack())
}

// RotatingLogger is a simple size-based rotating logger.
type RotatingLogger struct {
	mu         sync.Mutex
	path       string
	maxSize    int64
	maxBackups int
	file       *os.File
}

// NewRotatingLogger creates or opens the log file and returns a RotatingLogger.
func NewRotatingLogger(path string, maxSize int64, maxBackups int) (*RotatingLogger, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, errtrace.Wrap(err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return &RotatingLogger{path: path, maxSize: maxSize, maxBackups: maxBackups, file: f}, nil
}

func (r *RotatingLogger) Write(p []byte) (n int, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	fi, err := r.file.Stat()
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	if fi.Size()+int64(len(p)) > r.maxSize {
		if err := r.rotate(); err != nil {
			return 0, errtrace.Wrap(err)
		}
	}
	return errtrace.Wrap2(r.file.Write(p))
}

func (r *RotatingLogger) rotate() error {
	// Close current
	if r.file != nil {
		r.file.Close()
	}
	// Rename with timestamp
	ts := time.Now().UTC().Format("20060102T150405Z")
	newName := fmt.Sprintf("%s.%s", r.path, ts)
	if err := os.Rename(r.path, newName); err != nil {
		// If rename fails because file doesn't exist, ignore
		if !os.IsNotExist(err) {
			return errtrace.Wrap(err)
		}
	}
	// Recreate current log file
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return errtrace.Wrap(err)
	}
	r.file = f

	// Enforce backups limit
	if err := r.enforceBackups(); err != nil {
		return errtrace.Wrap(err)
	}
	return nil
}

func (r *RotatingLogger) enforceBackups() error {
	dir := filepath.Dir(r.path)
	base := filepath.Base(r.path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return errtrace.Wrap(err)
	}
	// collect rotated files matching base.
	var candidates []os.DirEntry
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, base+".") {
			candidates = append(candidates, e)
		}
	}
	if len(candidates) <= r.maxBackups {
		return nil
	}
	// Sort by name (timestamps) ascending
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].Name() < candidates[j].Name() })
	toRemove := len(candidates) - r.maxBackups
	for i := 0; i < toRemove; i++ {
		_ = os.Remove(filepath.Join(dir, candidates[i].Name()))
	}
	return nil
}
