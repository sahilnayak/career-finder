package data

import (
	"path/filepath"
	"testing"
	"time"
)

func TestLoadBoardConfig(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CAREER_FINDER_PROFILE", "")
	if got := LoadBoardConfig(tmp); got != DefaultBoardConfig {
		t.Fatalf("missing profile: got %+v, want defaults", got)
	}
	writeFile(t, filepath.Join(tmp, "config", "profile.yml"),
		"targets:\n  roles: [\"Data Engineer\"]\npipeline:\n  qualify_score: 4.0   # lower bar\n  window_hours: 48\noutreach:\n  window_hours: 1\n")
	got := LoadBoardConfig(tmp)
	if got.QualifyScore != 4.0 || got.Window != 48*time.Hour {
		t.Fatalf("got %+v, want 4.0 / 48h (and outreach.window_hours ignored)", got)
	}
}
