package data

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

// The outreach selection gate (user-set 2026-07-25).
//
// Scoring >= 4.3 makes a job ELIGIBLE for outreach, not owed. The user picks which
// qualifiers are worth the LinkedIn spend (profile visits are capped at 40/day) by
// pressing `w` on the Found panel; only picked jobs are drafted. The queue file is
// shared with scripts/outreach-queue.mjs, which is the same gate from the CLI and the
// read API that outreach-owed.mjs / drain-outreach.mjs consult.
//
// Columns must stay in sync with HEADER in scripts/outreach-queue.mjs.
var outreachQueueHeader = []string{
	"selected_at", "company", "role", "score", "url", "li_mode", "status", "drafted_at",
}

func outreachQueuePath(careerOpsPath string) string {
	return filepath.Join(careerOpsPath, "data", "outreach-queue.tsv")
}

// queueRow is one line of data/outreach-queue.tsv.
type queueRow struct {
	fields []string
}

func (r queueRow) get(header []string, name string) string {
	for i, h := range header {
		if strings.TrimSpace(h) == name && i < len(r.fields) {
			return strings.TrimSpace(r.fields[i])
		}
	}
	return ""
}

// readOutreachQueue returns the header and rows of the queue file. A missing file is not
// an error — it just means nothing has been picked yet.
func readOutreachQueue(careerOpsPath string) ([]string, []queueRow, error) {
	content, err := os.ReadFile(outreachQueuePath(careerOpsPath))
	if err != nil {
		if os.IsNotExist(err) {
			return outreachQueueHeader, nil, nil
		}
		return nil, nil, err
	}
	lines := strings.Split(string(content), "\n")
	var header []string
	var rows []queueRow
	for i, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if i == 0 {
			header = f
			continue
		}
		rows = append(rows, queueRow{fields: f})
	}
	if len(header) == 0 {
		header = outreachQueueHeader
	}
	return header, rows, nil
}

// sameQueuedJob reports whether a queue row refers to the same posting as a job.
// URL match wins when both sides have one; otherwise fall back to company+role.
// Mirrors sameJob() in scripts/outreach-queue.mjs.
func sameQueuedJob(rowCompany, rowRole, rowURL, company, role, url string) bool {
	if rowURL != "" && url != "" {
		return rowURL == url
	}
	return normKey(rowCompany) == normKey(company) && normKey(rowRole) == normKey(role)
}

func normKey(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// AttachOutreachSelected marks each job that the user has already picked for outreach,
// so the Found panel can show which ones are queued.
func AttachOutreachSelected(jobs []model.ScoredJob, careerOpsPath string) {
	header, rows, err := readOutreachQueue(careerOpsPath)
	if err != nil || len(rows) == 0 {
		return
	}
	for i := range jobs {
		for _, r := range rows {
			if r.get(header, "status") == "drafted" {
				continue
			}
			if sameQueuedJob(r.get(header, "company"), r.get(header, "role"), r.get(header, "url"),
				jobs[i].Company, jobs[i].Role, jobs[i].URL) {
				jobs[i].OutreachSelected = true
				break
			}
		}
	}
}

// MarkOutreachSelected adds a job to the outreach queue (idempotent). Returns false with
// no error when the job was already queued, so the caller can say so instead of implying
// it did something. Re-picking an already-drafted job re-opens it for a redraft.
func MarkOutreachSelected(careerOpsPath string, job model.ScoredJob) (added bool, err error) {
	header, rows, err := readOutreachQueue(careerOpsPath)
	if err != nil {
		return false, err
	}
	now := time.Now().UTC().Format(time.RFC3339)

	for i, r := range rows {
		if !sameQueuedJob(r.get(header, "company"), r.get(header, "role"), r.get(header, "url"),
			job.Company, job.Role, job.URL) {
			continue
		}
		if r.get(header, "status") != "drafted" {
			return false, nil // already queued, nothing to do
		}
		// Already drafted: re-open it as a deliberate redraft request.
		fields := padTo(r.fields, len(header))
		set(header, fields, "status", "selected")
		set(header, fields, "drafted_at", "")
		set(header, fields, "selected_at", now)
		rows[i] = queueRow{fields: fields}
		return true, writeOutreachQueue(careerOpsPath, header, rows)
	}

	fields := make([]string, len(header))
	set(header, fields, "selected_at", now)
	set(header, fields, "company", job.Company)
	set(header, fields, "role", job.Role)
	set(header, fields, "score", fmt.Sprintf("%.1f", job.Score))
	set(header, fields, "url", job.URL)
	set(header, fields, "li_mode", "auto")
	set(header, fields, "status", "selected")
	rows = append(rows, queueRow{fields: fields})
	return true, writeOutreachQueue(careerOpsPath, header, rows)
}

func padTo(f []string, n int) []string {
	for len(f) < n {
		f = append(f, "")
	}
	return f
}

func set(header, fields []string, name, value string) {
	for i, h := range header {
		if strings.TrimSpace(h) == name && i < len(fields) {
			fields[i] = strings.ReplaceAll(value, "\t", " ")
			return
		}
	}
}

func writeOutreachQueue(careerOpsPath string, header []string, rows []queueRow) error {
	out := []string{strings.Join(header, "\t")}
	for _, r := range rows {
		out = append(out, strings.Join(padTo(r.fields, len(header)), "\t"))
	}
	return os.WriteFile(outreachQueuePath(careerOpsPath), []byte(strings.Join(out, "\n")+"\n"), 0644)
}
