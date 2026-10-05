package screens

import (
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

func sampleJobs() []model.ScoredJob {
	now := time.Now()
	return []model.ScoredJob{
		{Company: "Sendbird", Role: "Data Engineer", Score: 4.7, Verdict: "QUALIFIED", URL: "https://s/1", FoundAt: now.Add(-30 * time.Minute), ReportPath: "reports/763-sendbird.md"},
		{Company: "Vercel", Role: "Senior Analytics Engineer", Score: 4.3, Verdict: "QUALIFIED", URL: "https://v/1", FoundAt: now.Add(-2 * time.Hour)},
		{Company: "Pass", Role: "Support", Score: 3.1, Verdict: "pass", URL: "https://p/1", FoundAt: now.Add(-1 * time.Hour)},
		{Company: "Closure", Role: "Founding Deployment Strategist", Score: 4.3, Verdict: "QUALIFIED", URL: "https://c/1", FoundAt: now.Add(-90 * time.Minute), Applied: true, AppliedAt: now.Add(-10 * time.Minute)},
	}
}

func TestJobsViewRenders(t *testing.T) {
	m := NewJobsModel(theme.NewTheme("catppuccin-mocha"), sampleJobs(), 120, 40)
	out := m.View()
	if !strings.Contains(out, "FOUND") || !strings.Contains(out, "APPLIED") {
		t.Fatalf("view missing panels:\n%s", out)
	}
	if !strings.Contains(out, "Sendbird") {
		t.Fatalf("view missing a found qualifier:\n%s", out)
	}
	// Found = 2 qualifiers (Sendbird, Vercel, Closure-applied excluded, Pass<4.3 excluded)
	if len(m.found) != 2 {
		t.Fatalf("want 2 found, got %d", len(m.found))
	}
	if len(m.applied) != 1 {
		t.Fatalf("want 1 applied, got %d", len(m.applied))
	}
}

func key(s string) tea.KeyMsg {
	switch s {
	case "tab":
		return tea.KeyMsg{Type: tea.KeyTab}
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	default:
		return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
	}
}

func TestJobsNavigationAndApplyCmd(t *testing.T) {
	m := NewJobsModel(theme.NewTheme("catppuccin-mocha"), sampleJobs(), 120, 40)

	// Navigation + focus toggles must not panic.
	for _, k := range []string{"j", "down", "k", "up", "tab", "j", "tab", "o", "r", "p", "R"} {
		var cmd tea.Cmd
		m, cmd = m.Update(key(k))
		if cmd != nil {
			cmd() // exercise the command; we only care it doesn't panic
		}
	}

	// Focus Found, select first, press "a" -> should emit JobsMarkAppliedMsg.
	if m.focus != focusFound {
		m.focus = focusFound
	}
	m.cursorFound = 0
	_, cmd := m.Update(key("a"))
	if cmd == nil {
		t.Fatal("apply produced no command")
	}
	msg := cmd()
	applied, ok := msg.(JobsMarkAppliedMsg)
	if !ok {
		t.Fatalf("want JobsMarkAppliedMsg, got %T", msg)
	}
	if applied.Job.Company == "" {
		t.Fatal("apply message missing job")
	}

	// Quit emits JobsClosedMsg.
	_, qcmd := m.Update(key("q"))
	if _, ok := qcmd().(JobsClosedMsg); !ok {
		t.Fatal("q did not emit JobsClosedMsg")
	}
}
