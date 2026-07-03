package heads

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/trolleyman/hydra/internal/mcpclient"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// captureMCPToolRW introspects the allow-listed stdio MCP servers and returns a
// map of "<server>__<tool>" → "read"/"write" derived from each tool's declared
// readOnlyHint annotation. Only tools that declare a hint are recorded (others
// fall back to the gate's name heuristic).
//
// It is strictly best-effort and cached per server (keyed by a hash of its launch
// command): a server that can't be introspected - times out, errors, is non-stdio,
// or needs auth - is simply omitted. Successful results are cached under
// cacheDir/mcp-rw so subsequent launches don't re-spawn every server.
func captureMCPToolRW(names []string, claudeJSON, mcpJSON []byte, cacheDir string) map[string]string {
	out := map[string]string{}
	for _, spec := range sandbox.MCPServerSpecs(claudeJSON, mcpJSON, names) {
		for tool, readOnly := range serverToolHints(spec, cacheDir) {
			rw := "write"
			if readOnly {
				rw = "read"
			}
			out[spec.Name+"__"+tool] = rw
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// serverToolHints returns tool→readOnly for one server, from cache when present
// or by introspecting it once and caching the result. Only tools with an explicit
// readOnlyHint appear in the map.
func serverToolHints(spec sandbox.MCPServerSpec, cacheDir string) map[string]bool {
	cachePath := filepath.Join(cacheDir, "mcp-rw", specHash(spec)+".json")
	if data, err := os.ReadFile(cachePath); err == nil {
		var cached map[string]bool
		if json.Unmarshal(data, &cached) == nil {
			return cached
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), mcpclient.DefaultTimeout)
	defer cancel()
	tools, err := mcpclient.ListTools(ctx, spec.Command, spec.Args, envList(spec.Env))
	if err != nil {
		return nil // best-effort: fall back to the heuristic, retry next launch
	}
	hints := map[string]bool{}
	for _, t := range tools {
		if t.ReadOnly != nil {
			hints[t.Name] = *t.ReadOnly
		}
	}
	// Cache even an empty (no-hints) result: the server answered, so re-spawning it
	// next launch would just cost time for the same "no annotations" answer.
	if data, err := json.Marshal(hints); err == nil {
		_ = os.MkdirAll(filepath.Dir(cachePath), 0o755)
		_ = os.WriteFile(cachePath, data, 0o644)
	}
	return hints
}

// specHash is a stable cache key for a server's launch command.
func specHash(spec sandbox.MCPServerSpec) string {
	h := sha256.Sum256([]byte(spec.Command + "\x00" + strings.Join(spec.Args, "\x00")))
	return hex.EncodeToString(h[:8])
}

// envList merges the server's declared env over the host environment.
func envList(env map[string]string) []string {
	if len(env) == 0 {
		return nil
	}
	out := os.Environ()
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}
