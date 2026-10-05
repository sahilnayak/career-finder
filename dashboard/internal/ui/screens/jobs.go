package screens

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// ---- Messages emitted to the app shell ----

// JobsClosedMsg is emitted when the jobs screen is dismissed (quit).
type JobsClosedMsg struct{}

// JobsOpenURLMsg requests opening a job URL in the browser.
type JobsOpenURLMsg struct{ URL string }

// JobsOpenResumeMsg asks the app to hand a tailored resume PDF to the OS opener.
type JobsOpenResumeMsg struct{ Path string }

// JobsMarkAppliedMsg requests marking a found job as applied.
type JobsMarkAppliedMsg struct{ Job model.ScoredJob }

// JobsDismissMsg requests removing a found job from the board (not pursuing).
type JobsDismissMsg struct{ Job model.ScoredJob }

// JobsSelectOutreachMsg requests picking a found job for outreach (the selection gate).
// Outreach is NOT automatic on >=4.3 — LinkedIn profile visits are capped at 40/day, so
// the user decides where that budget goes. See data/outreach_queue.go.
type JobsSelectOutreachMsg struct{ Job model.ScoredJob }

// JobsOpenReportMsg requests opening a job's report in the Viewer.
type JobsOpenReportMsg struct {
	Path     string
	Title    string
	Outreach string // absolute path to the drafted outreach HTML, if any
}

// JobsOpenProgressMsg requests opening the Progress funnel.
type JobsOpenProgressMsg struct{}

// JobsRefreshMsg requests a reload of scored-jobs.tsv from disk.
type JobsRefreshMsg struct{}

const (
	focusFound = iota
	focusApplied
)

// JobsModel is the dashboard home: Found (last 24h, qualifiers) | Applied.
type JobsModel struct {
	all           []model.ScoredJob
	found         []model.ScoredJob
	applied       []model.ScoredJob
	focus         int
	cursorFound   int
	cursorApplied int
	width, height int
	theme         theme.Theme
	status        string // transient status line (e.g., "marked applied")
	minScore      float64
	window        time.Duration
	liveLeads     []model.ScoredJob // re-verified-live ≥4.3 fallback (>24h, within staleWindow)
	staleWindow   time.Duration
}

// NewJobsModel builds the jobs home screen from parsed scored jobs.
func NewJobsModel(t theme.Theme, jobs []model.ScoredJob, width, height int) JobsModel {
	m := JobsModel{
		theme:    t,
		width:    width,
		height:   height,
		minScore: 4.3,
		window:   24 * time.Hour, // default; main.go applies pipeline.window_hours via WithBoard. See modes/dashboard.md.
		// staleWindow bounds the (disabled) LIVE LEADS fallback: re-verified-live qualifiers up to 7d old.
		staleWindow: 7 * 24 * time.Hour,
	}
	m.setJobs(jobs)
	return m
}

// WithBoard applies the qualifying score and Found window from config/profile.yml (pipeline block).
func (m JobsModel) WithBoard(minScore float64, window time.Duration) JobsModel {
	if minScore > 0 {
		m.minScore = minScore
	}
	if window > 0 {
		m.window = window
	}
	m.setJobs(m.all)
	return m
}

func (m *JobsModel) setJobs(jobs []model.ScoredJob) {
	m.all = jobs
	// Found = qualifiers found in the last 24h only (time-to-lead). Excludes applied + dismissed.
	m.found = data.QualifiersInWindow(jobs, m.minScore, m.window)
	// HARD RULE (user-set 2026-06-22): the dashboard shows ONLY jobs found in the last 24h.
	// The >24h LIVE LEADS fallback panel is DISABLED — an empty Found stays empty rather than
	// showing older qualifiers. (Re-verified-live >24h fallback now lives only in the
	// daily-quota CLI output, not the dashboard.) To re-enable, restore:
	//   m.liveLeads = data.LiveLeads(jobs, m.minScore, m.window, m.staleWindow)
	m.liveLeads = nil
	// Applied panel is a PERSISTENT history (user-set 2026-06-22): intentionally NOT windowed to
	// 24h — it's the "what I've applied to" record, not a fresh-jobs list. Only the Found board
	// (and the disabled Live Leads) follow the 24h rule.
	m.applied = data.AppliedJobs(jobs)
	m.clampCursors()
}

// WithReloadedData returns a copy with fresh jobs but preserved focus/cursor + status.
func (m JobsModel) WithReloadedData(jobs []model.ScoredJob, status string) JobsModel {
	m.setJobs(jobs)
	m.status = status
	return m
}

func (m *JobsModel) clampCursors() {
	if m.cursorFound >= len(m.leftList()) {
		m.cursorFound = max(0, len(m.leftList())-1)
	}
	if m.cursorApplied >= len(m.applied) {
		m.cursorApplied = max(0, len(m.applied)-1)
	}
}

func (m JobsModel) Init() tea.Cmd { return nil }

// Resize updates dimensions.
func (m *JobsModel) Resize(width, height int) { m.width, m.height = width, height }

// Width / Height accessors (used by the shell when opening drill-ins).
func (m JobsModel) Width() int  { return m.width }
func (m JobsModel) Height() int { return m.height }

func (m JobsModel) curList() []model.ScoredJob {
	if m.focus == focusApplied {
		return m.applied
	}
	return m.leftList()
}

// leftList is the left panel's content: the 24h Found qualifiers, or — when that is empty —
// the re-verified-live fallback (>24h, within staleWindow), so the board is never blank when
// recent qualifiers exist. See "Empty board -> keep searching" (modes/_profile.md).
func (m JobsModel) leftList() []model.ScoredJob {
	if len(m.found) > 0 {
		return m.found
	}
	return m.liveLeads
}

func (m JobsModel) leftIsFallback() bool { return len(m.found) == 0 && len(m.liveLeads) > 0 }

func (m JobsModel) selected() (model.ScoredJob, bool) {
	list := m.curList()
	idx := m.cursorFound
	if m.focus == focusApplied {
		idx = m.cursorApplied
	}
	if idx < 0 || idx >= len(list) {
		return model.ScoredJob{}, false
	}
	return list[idx], true
}

// Update handles input.
func (m JobsModel) Update(msg tea.Msg) (JobsModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c", "esc":
			return m, func() tea.Msg { return JobsClosedMsg{} }

		case "up", "k":
			m.status = ""
			if m.focus == focusApplied {
				if m.cursorApplied > 0 {
					m.cursorApplied--
				}
			} else if m.cursorFound > 0 {
				m.cursorFound--
			}
			return m, nil

		case "down", "j":
			m.status = ""
			if m.focus == focusApplied {
				if m.cursorApplied < len(m.applied)-1 {
					m.cursorApplied++
				}
			} else if m.cursorFound < len(m.leftList())-1 {
				m.cursorFound++
			}
			return m, nil

		case "tab", "left", "right", "h", "l":
			m.status = ""
			if m.focus == focusFound {
				m.focus = focusApplied
			} else {
				m.focus = focusFound
			}
			return m, nil

		case "a":
			// Mark the selected FOUND job as applied. Explicit key only — Enter opens the
			// report (drill-in), so a stray Enter never files an application by accident.
			if m.focus != focusFound {
				return m, nil
			}
			job, ok := m.selected()
			if !ok {
				return m, nil
			}
			return m, func() tea.Msg { return JobsMarkAppliedMsg{Job: job} }

		case "x":
			// Dismiss the selected FOUND job from the board (not pursuing). Removes it from
			// the persistent worklist without filing an application. Found panel only.
			if m.focus != focusFound {
				return m, nil
			}
			job, ok := m.selected()
			if !ok {
				return m, nil
			}
			return m, func() tea.Msg { return JobsDismissMsg{Job: job} }

		case "w":
			// Pick the selected FOUND job for outreach (the selection gate). Nothing is
			// sent — this only authorises spending the LinkedIn/email budget on drafting.
			if m.focus != focusFound {
				return m, nil
			}
			job, ok := m.selected()
			if !ok {
				return m, nil
			}
			return m, func() tea.Msg { return JobsSelectOutreachMsg{Job: job} }

		case "o":
			if job, ok := m.selected(); ok && job.URL != "" {
				return m, func() tea.Msg { return JobsOpenURLMsg{URL: job.URL} }
			}
			m.status = "no URL for this job"
			return m, nil

		case "d":
			// Open the local JD snapshot. NOTE: 'j' is vim-down, so the JD key is 'd' (document). This is the posting text captured at scoring time, which
			// is the only record that survives the employer editing or pulling the live req.
			job, ok := m.selected()
			if !ok {
				return m, nil
			}
			if job.JDPath == "" {
				m.status = "no JD snapshot for this job — press o for the live posting"
				return m, nil
			}
			return m, func() tea.Msg {
				return JobsOpenReportMsg{Path: job.JDPath, Title: job.Company + " — " + job.Role + " (JD)", Outreach: job.OutreachPath}
			}

		case "r", "enter":
			// Drill into the job's evaluation report (works on both panels).
			job, ok := m.selected()
			if !ok {
				return m, nil
			}
			title := job.Company + " — " + job.Role
			if job.ReportPath == "" {
				// A job can be on the board before its report is written (report is OWED, not
				// required, at qualify time). Falling back to the JD means the drill-in always
				// shows SOMETHING readable instead of dead-ending on "no report linked" — which
				// is what made a fully-populated job look broken.
				if job.JDPath != "" {
					m.status = "no report yet — showing the JD snapshot"
					return m, func() tea.Msg {
						return JobsOpenReportMsg{Path: job.JDPath, Title: title + " (JD)", Outreach: job.OutreachPath}
					}
				}
				m.status = "no report or JD for this job — press o for the live posting"
				return m, nil
			}
			return m, func() tea.Msg {
				return JobsOpenReportMsg{Path: job.ReportPath, Title: title, Outreach: job.OutreachPath}
			}

		case "D":
			// Open the rendered PDF of the JD snapshot. Lowercase d stays the in-TUI markdown view;
			// a PDF cannot render there, so this one goes to the OS like the resume does.
			job, ok := m.selected()
			if !ok {
				return m, nil
			}
			if job.JDPdfPath == "" {
				m.status = "no JD PDF yet - run: node scripts/gen-jd-pdfs.mjs"
				return m, nil
			}
			m.status = "opening " + filepath.Base(job.JDPdfPath)
			return m, func() tea.Msg { return JobsOpenResumeMsg{Path: job.JDPdfPath} }

		case "c":
			// Open the resume PDF tailored for THIS requisition. 'c' for CV: 'r' is the report and
			// 'p' is the progress screen, both already taken.
			job, ok := m.selected()
			if !ok {
				return m, nil
			}
			if job.ResumePath == "" {
				m.status = "no tailored resume for this job yet — it is owed, see pipeline-owed"
				return m, nil
			}
			m.status = "opening " + filepath.Base(job.ResumePath)
			return m, func() tea.Msg { return JobsOpenResumeMsg{Path: job.ResumePath} }

		case "p":
			return m, func() tea.Msg { return JobsOpenProgressMsg{} }

		case "R":
			return m, func() tea.Msg { return JobsRefreshMsg{} }
		}
	}
	return m, nil
}

// ---- View ----

func (m JobsModel) View() string {
	th := m.theme
	gap := 1
	panelW := (m.width - gap) / 2
	if panelW < 24 {
		panelW = 24
	}
	bodyH := m.height - 4 // header(1) + blank(1) + footer(2)
	if bodyH < 4 {
		bodyH = 4
	}

	win := fmtWindow(m.window)
	foundTitle := fmt.Sprintf("FOUND · last %s · ≥%.1f  (%d)", win, m.minScore, len(m.found))
	if m.leftIsFallback() {
		foundTitle = fmt.Sprintf("LIVE LEADS · >%s · re-verify · ≥%.1f  (%d)", win, m.minScore, len(m.liveLeads))
	}
	appliedTitle := fmt.Sprintf("APPLIED  (%d)", len(m.applied))

	left := m.renderPanel(foundTitle, m.leftList(), m.cursorFound, m.focus == focusFound, panelW, bodyH, false)
	right := m.renderPanel(appliedTitle, m.applied, m.cursorApplied, m.focus == focusApplied, panelW, bodyH, true)

	sub := fmt.Sprintf("   %d qualifiers in %s · %d applied", len(m.found), win, len(m.applied))
	if m.leftIsFallback() {
		sub = fmt.Sprintf("   0 in %s · showing %d live leads (>%s · re-verify) · %d applied", win, len(m.liveLeads), win, len(m.applied))
	}
	header := lipgloss.NewStyle().Bold(true).Foreground(th.Mauve).
		Render("career-finder · jobs") +
		lipgloss.NewStyle().Foreground(th.Subtext).Render(sub)

	body := lipgloss.JoinHorizontal(lipgloss.Top, left, strings.Repeat(" ", gap), right)

	footerKeys := "↑↓ move · tab switch · ⏎/r report · d JD · D JD-pdf · c CV · w outreach · a apply · x dismiss · o open · p progress · R refresh · q quit"
	footer := lipgloss.NewStyle().Foreground(th.Subtext).Render(footerKeys)
	if m.status != "" {
		footer = lipgloss.NewStyle().Foreground(th.Green).Render("✓ "+m.status) + "\n" + footer
	} else {
		footer = "\n" + footer
	}

	return header + "\n" + body + "\n" + footer
}

// renderPanel draws one bordered list panel.
func (m JobsModel) renderPanel(title string, items []model.ScoredJob, cursor int, focused bool, w, h int, appliedView bool) string {
	th := m.theme
	border := th.Overlay
	titleColor := th.Subtext
	if focused {
		border = th.Mauve
		titleColor = th.Mauve
	}

	inner := w - 4 // account for border + padding
	if inner < 10 {
		inner = 10
	}

	var lines []string
	lines = append(lines, lipgloss.NewStyle().Bold(true).Foreground(titleColor).Render(truncate(title, inner)))
	lines = append(lines, lipgloss.NewStyle().Foreground(border).Render(strings.Repeat("─", inner)))

	if len(items) == 0 {
		empty := fmt.Sprintf("No qualifiers in %s and no live leads in 7d.", fmtWindow(m.window))
		if appliedView {
			empty = "Nothing applied yet. Press a on a Found job."
		}
		lines = append(lines, lipgloss.NewStyle().Foreground(th.Subtext).Italic(true).Render(truncate(empty, inner)))
	}

	rows := h - 3
	start := 0
	if cursor >= rows {
		start = cursor - rows + 1
	}
	for i := start; i < len(items) && i < start+rows; i++ {
		lines = append(lines, m.renderRow(items[i], i == cursor && focused, inner, appliedView))
	}

	content := strings.Join(lines, "\n")
	style := lipgloss.NewStyle().
		Width(w-2).
		Height(h).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(border).
		Padding(0, 1)
	return style.Render(content)
}

// renderRow renders one job line: marker, score badge, company — role, time-ago.
func (m JobsModel) renderRow(j model.ScoredJob, sel bool, w int, appliedView bool) string {
	th := m.theme
	marker := "  "
	if sel {
		marker = lipgloss.NewStyle().Foreground(th.Mauve).Bold(true).Render("▸ ")
	}

	badge := lipgloss.NewStyle().Foreground(scoreColor(th, j.Score)).Bold(true).
		Render(fmt.Sprintf("%.1f", j.Score))

	// Picked-for-outreach flag: shows which Found jobs have been authorised to spend the
	// LinkedIn/email budget on drafting. Drafts still need a drain run to be produced.
	flag := ""
	if j.OutreachSelected && !appliedView {
		flag = lipgloss.NewStyle().Foreground(th.Green).Render(" ✉")
	}

	var ago string
	if appliedView {
		ago = "applied " + humanizeAgo(j.AppliedAt)
	} else {
		ago = humanizeAgo(j.FoundAt)
	}
	agoStr := lipgloss.NewStyle().Foreground(th.Subtext).Render(ago)

	// title = "Company — Role", truncated to fit the remaining width
	title := j.Company + " — " + j.Role
	used := lipgloss.Width(marker) + lipgloss.Width(badge) + lipgloss.Width(flag) + 1 + lipgloss.Width(ago) + 2
	titleW := w - used
	if titleW < 8 {
		titleW = 8
	}
	titleColor := th.Text
	if sel {
		titleColor = th.Text
	}
	titleStr := lipgloss.NewStyle().Foreground(titleColor).Render(truncate(title, titleW))

	// pad between title and ago so ago is right-aligned
	pad := w - lipgloss.Width(marker) - lipgloss.Width(badge) - lipgloss.Width(flag) - 1 - lipgloss.Width(titleStr) - lipgloss.Width(ago)
	if pad < 1 {
		pad = 1
	}
	return marker + badge + flag + " " + titleStr + strings.Repeat(" ", pad) + agoStr
}

// ---- helpers ----

func scoreColor(th theme.Theme, score float64) lipgloss.Color {
	switch {
	case score >= 4.5:
		return th.Green
	case score >= 4.3:
		return th.Sky
	case score >= 4.0:
		return th.Yellow
	default:
		return th.Subtext
	}
}

func humanizeAgo(t time.Time) string {
	if t.IsZero() {
		return "—"
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func truncate(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= w {
		return s
	}
	if w <= 1 {
		return "…"
	}
	r := []rune(s)
	for len(r) > 0 && lipgloss.Width(string(r))+1 > w {
		r = r[:len(r)-1]
	}
	return string(r) + "…"
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// fmtWindow renders a board window compactly: 24h, 36h, 90m.
func fmtWindow(d time.Duration) string {
	if d%time.Hour == 0 {
		return fmt.Sprintf("%dh", int(d/time.Hour))
	}
	return fmt.Sprintf("%dm", int(d/time.Minute))
}
