package data

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// BoardConfig is the slice of config/profile.yml the dashboard needs: the qualifying score and
// the Found-board window. Both come from the `pipeline:` block that onboarding writes, so the
// board agrees with the scripts (scripts/targets.mjs) instead of carrying its own numbers.
type BoardConfig struct {
	QualifyScore float64
	Window       time.Duration
}

// DefaultBoardConfig mirrors the defaults in scripts/targets.mjs.
var DefaultBoardConfig = BoardConfig{QualifyScore: 4.3, Window: 24 * time.Hour}

// LoadBoardConfig reads pipeline.qualify_score and pipeline.window_hours from
// {root}/config/profile.yml (or $CAREER_FINDER_PROFILE). Missing file or keys fall back to
// the defaults. A deliberately tiny reader: it only understands `pipeline:` followed by
// indented `key: value` lines, which is all onboarding writes there, and avoids a YAML dependency.
func LoadBoardConfig(root string) BoardConfig {
	cfg := DefaultBoardConfig
	path := os.Getenv("CAREER_FINDER_PROFILE")
	if path == "" {
		path = filepath.Join(root, "config", "profile.yml")
	}
	f, err := os.Open(path)
	if err != nil {
		return cfg
	}
	defer f.Close()
	inPipeline := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			inPipeline = strings.HasPrefix(trimmed, "pipeline:")
			continue
		}
		if !inPipeline {
			continue
		}
		key, val, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		if i := strings.Index(val, "#"); i >= 0 {
			val = val[:i]
		}
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		n, err := strconv.ParseFloat(val, 64)
		if err != nil || n <= 0 {
			continue
		}
		switch strings.TrimSpace(key) {
		case "qualify_score":
			cfg.QualifyScore = n
		case "window_hours":
			cfg.Window = time.Duration(n * float64(time.Hour))
		}
	}
	return cfg
}
