package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
	"github.com/santifer/career-ops/dashboard/internal/ui/screens"
)

type viewState int

const (
	viewJobs viewState = iota
	viewReport
	viewProgress
)

type appModel struct {
	jobs            screens.JobsModel
	viewer          screens.ViewerModel
	progress        screens.ProgressModel
	state           viewState
	careerOpsPath   string
	theme           theme.Theme
	apps            []model.CareerApplication
	scored          []model.ScoredJob
	progressMetrics model.ProgressMetrics
}

// reload re-reads scored-jobs.tsv + applications.md from disk and refreshes the home screen.
func (m *appModel) reload(status string) {
	m.apps = data.ParseApplications(m.careerOpsPath)
	m.scored = data.ParseScoredJobs(m.careerOpsPath)
	data.AttachReportPaths(m.scored, m.apps, m.careerOpsPath)
	data.AttachOutreachPaths(m.scored, m.careerOpsPath)
	data.AttachJDPaths(m.scored, m.careerOpsPath)
	data.AttachResumePaths(m.scored, m.careerOpsPath)
	data.AttachOutreachSelected(m.scored, m.careerOpsPath)
	m.progressMetrics = data.ComputeProgressMetrics(m.apps)
	m.jobs = m.jobs.WithReloadedData(m.scored, status)
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n <= 1 {
		return s[:n]
	}
	return s[:n-1] + "…"
}

func (m appModel) Init() tea.Cmd { return nil }

func (m appModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.jobs.Resize(msg.Width, msg.Height)
		if m.state == viewReport {
			m.viewer.Resize(msg.Width, msg.Height)
		}
		if m.state == viewProgress {
			m.progress.Resize(msg.Width, msg.Height)
		}
		jm, cmd := m.jobs.Update(msg)
		m.jobs = jm
		return m, cmd

	case screens.JobsClosedMsg:
		return m, tea.Quit

	case screens.JobsMarkAppliedMsg:
		synced, err := data.MarkScoredApplied(m.careerOpsPath, msg.Job, m.apps)
		var status string
		if err != nil {
			fmt.Fprintf(os.Stderr, "WARN: mark applied failed: %v\n", err)
			status = "error marking applied (see stderr)"
		} else if synced {
			status = fmt.Sprintf("Applied: %s — %s (tracker updated)", msg.Job.Company, msg.Job.Role)
		} else {
			status = fmt.Sprintf("Applied: %s — %s (queued for tracker)", msg.Job.Company, msg.Job.Role)
		}
		m.reload(status)
		return m, nil

	case screens.JobsDismissMsg:
		var status string
		if err := data.MarkDismissed(m.careerOpsPath, msg.Job); err != nil {
			fmt.Fprintf(os.Stderr, "WARN: dismiss failed: %v\n", err)
			status = "error dismissing (see stderr)"
		} else {
			status = fmt.Sprintf("Dismissed: %s — %s", msg.Job.Company, msg.Job.Role)
		}
		m.reload(status)
		return m, nil

	case screens.JobsSelectOutreachMsg:
		// The outreach selection gate: authorises the drain to spend LinkedIn/email budget
		// on this job. Draft-only — nothing is ever sent from the dashboard.
		added, err := data.MarkOutreachSelected(m.careerOpsPath, msg.Job)
		var status string
		if err != nil {
			fmt.Fprintf(os.Stderr, "WARN: outreach select failed: %v\n", err)
			status = "error picking for outreach (see stderr)"
		} else if added {
			status = fmt.Sprintf("Outreach queued: %s — %s (run the drain to draft)", msg.Job.Company, msg.Job.Role)
		} else {
			status = fmt.Sprintf("Already queued for outreach: %s — %s", msg.Job.Company, msg.Job.Role)
		}
		m.reload(status)
		return m, nil

	case screens.JobsRefreshMsg:
		m.reload("refreshed from disk")
		return m, nil

	case screens.JobsOpenReportMsg:
		// Report paths are stored relative to the career-ops root (e.g. "reports/790-…md").
		// Resolve against careerOpsPath so the drill-in works regardless of the process cwd.
		reportPath := msg.Path
		if !filepath.IsAbs(reportPath) {
			reportPath = filepath.Join(m.careerOpsPath, msg.Path)
		}
		// Surface a link to the drafted outreach HTML (full path) at the top of the report.
		note := ""
		if msg.Outreach != "" {
			note = "**Outreach:** file://" + msg.Outreach
		}
		m.viewer = screens.NewViewerModel(m.theme, reportPath, msg.Title, note, m.jobs.Width(), m.jobs.Height())
		m.state = viewReport
		return m, nil

	case screens.ViewerClosedMsg:
		m.state = viewJobs
		return m, nil

	case screens.JobsOpenProgressMsg:
		m.progress = screens.NewProgressModel(theme.NewTheme("catppuccin-mocha"), m.progressMetrics, m.jobs.Width(), m.jobs.Height())
		m.state = viewProgress
		return m, nil

	case screens.ProgressClosedMsg:
		m.state = viewJobs
		return m, nil

	case screens.JobsOpenResumeMsg:
		// A PDF cannot render in the markdown viewer, so hand it to the OS the same way a live
		// posting URL is handed over.
		path := msg.Path
		return m, func() tea.Msg {
			var cmd *exec.Cmd
			switch runtime.GOOS {
			case "darwin":
				cmd = exec.Command("open", path)
			case "windows":
				cmd = exec.Command("cmd", "/c", "start", "", path)
			default:
				cmd = exec.Command("xdg-open", path)
			}
			_ = cmd.Run()
			return nil
		}

	case screens.JobsOpenURLMsg:
		url := msg.URL
		return m, func() tea.Msg {
			var cmd *exec.Cmd
			switch runtime.GOOS {
			case "darwin":
				cmd = exec.Command("open", url)
			case "windows":
				cmd = exec.Command("cmd", "/c", "start", "", url)
			default:
				cmd = exec.Command("xdg-open", url)
			}
			_ = cmd.Run()
			return nil
		}

	default:
		if m.state == viewReport {
			vm, cmd := m.viewer.Update(msg)
			m.viewer = vm
			return m, cmd
		}
		if m.state == viewProgress {
			pg, cmd := m.progress.Update(msg)
			m.progress = pg
			return m, cmd
		}
		jm, cmd := m.jobs.Update(msg)
		m.jobs = jm
		return m, cmd
	}
}

func (m appModel) View() string {
	switch m.state {
	case viewReport:
		return m.viewer.View()
	case viewProgress:
		return m.progress.View()
	default:
		return m.jobs.View()
	}
}

func main() {
	pathFlag := flag.String("path", ".", "Path to career-finder directory")
	dumpFlag := flag.Bool("dump", false, "Print the Found/Applied lists and exit (no TUI; for verification)")
	flag.Parse()
	careerOpsPath := *pathFlag

	apps := data.ParseApplications(careerOpsPath)
	scored := data.ParseScoredJobs(careerOpsPath)
	if scored == nil && apps == nil {
		fmt.Fprintf(os.Stderr, "Error: could not find data/scored-jobs.tsv or data/applications.md in %s\n", careerOpsPath)
		os.Exit(1)
	}
	data.AttachReportPaths(scored, apps, careerOpsPath)
	data.AttachOutreachPaths(scored, careerOpsPath)
	data.AttachJDPaths(scored, careerOpsPath)
	data.AttachResumePaths(scored, careerOpsPath)
	data.AttachOutreachSelected(scored, careerOpsPath)

	board := data.LoadBoardConfig(careerOpsPath)

	if *dumpFlag {
		found := data.QualifiersInWindow(scored, board.QualifyScore, board.Window)
		// Board window and bar come from config/profile.yml (pipeline.window_hours / qualify_score).
		// The Applied panel is a PERSISTENT history (NOT windowed).
		applied := data.AppliedJobs(scored)
		fmt.Printf("FOUND (last %.0fh, >=%.1f): %d\n", board.Window.Hours(), board.QualifyScore, len(found))
		for _, j := range found {
			fmt.Printf("  %.1f  %-22s %-42s found %s  report=%v outreach=%v jd=%v picked=%v\n", j.Score, trunc(j.Company, 22), trunc(j.Role, 42), j.FoundAt.Format("01-02 15:04"), j.ReportPath != "", j.OutreachPath != "", j.JDPath != "", j.OutreachSelected)
		}
		fmt.Printf("APPLIED (all): %d\n", len(applied))
		for _, j := range applied {
			fmt.Printf("  %.1f  %-22s %-42s applied %s\n", j.Score, trunc(j.Company, 22), trunc(j.Role, 42), j.AppliedAt.Format("01-02 15:04"))
		}
		return
	}

	t := theme.NewTheme("auto")
	m := appModel{
		jobs:            screens.NewJobsModel(t, scored, 120, 40).WithBoard(board.QualifyScore, board.Window),
		careerOpsPath:   careerOpsPath,
		theme:           t,
		apps:            apps,
		scored:          scored,
		progressMetrics: data.ComputeProgressMetrics(apps),
	}

	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
