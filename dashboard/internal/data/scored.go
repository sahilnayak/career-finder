package data

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

// scoredJobsPath returns the first existing path to scored-jobs.tsv.
func scoredJobsPath(careerOpsPath string) string {
	candidates := []string{
		filepath.Join(careerOpsPath, "data", "scored-jobs.tsv"),
		filepath.Join(careerOpsPath, "scored-jobs.tsv"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return candidates[0]
}

var reScoredScore = regexp.MustCompile(`(\d+\.?\d*)`)

// isoLayouts are the timestamp shapes the pipeline emits for found_at. record-scored.mjs
// writes UTC (Z), but the LLM scoring step has historically written local-offset forms,
// including the colon-less "-0700" that Go's RFC3339 layout rejects. Try each in order so
// no qualifier is silently dropped from the board by a parse failure.
var isoLayouts = []string{
	time.RFC3339,                          // 2026-06-16T20:05:03Z and ...-07:00
	"2006-01-02T15:04:05.999999999Z07:00", // RFC3339Nano (fractional seconds)
	"2006-01-02T15:04:05Z0700",            // colon-less offset: ...-0700
	"2006-01-02T15:04:05.999999999Z0700",
}

// parseISO tries every known ISO layout; returns zero time if none match.
func parseISO(s string) (time.Time, bool) {
	for _, layout := range isoLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// parseFoundAt resolves a row's discovery time: prefer the precise found_at column
// (any common ISO form), else fall back to the day-level date at local noon.
func parseFoundAt(foundAtRaw, date string) time.Time {
	if foundAtRaw != "" {
		if t, ok := parseISO(foundAtRaw); ok {
			return t
		}
	}
	if t, err := time.ParseInLocation("2006-01-02", date, time.Local); err == nil {
		return t.Add(12 * time.Hour) // noon, a neutral midpoint for day-level rows
	}
	return time.Time{}
}

// ParseScoredJobs reads data/scored-jobs.tsv. Tolerant of the legacy 7-column layout
// and the 9-column layout (date company role score verdict why url found_at applied_at).
func ParseScoredJobs(careerOpsPath string) []model.ScoredJob {
	content, err := os.ReadFile(scoredJobsPath(careerOpsPath))
	if err != nil {
		return nil
	}
	var jobs []model.ScoredJob
	for i, line := range strings.Split(string(content), "\n") {
		if i == 0 || strings.TrimSpace(line) == "" {
			continue // header / blank
		}
		f := strings.Split(line, "\t")
		if len(f) < 7 {
			continue
		}
		j := model.ScoredJob{
			Date:     strings.TrimSpace(f[0]),
			Company:  strings.TrimSpace(f[1]),
			Role:     strings.TrimSpace(f[2]),
			ScoreRaw: strings.TrimSpace(f[3]),
			Verdict:  strings.TrimSpace(f[4]),
			Why:      strings.TrimSpace(f[5]),
			URL:      strings.TrimSpace(f[6]),
		}
		if sm := reScoredScore.FindStringSubmatch(j.ScoreRaw); sm != nil {
			j.Score, _ = strconv.ParseFloat(sm[1], 64)
		}
		foundAtRaw := ""
		if len(f) > 7 {
			foundAtRaw = strings.TrimSpace(f[7])
		}
		j.FoundAt = parseFoundAt(foundAtRaw, j.Date)
		if len(f) > 8 && strings.TrimSpace(f[8]) != "" {
			if t, ok := parseISO(strings.TrimSpace(f[8])); ok {
				j.Applied = true
				j.AppliedAt = t
			}
		}
		// Optional 10th column: dismissed_at (a job removed from the Found board by hand).
		if len(f) > 9 && strings.TrimSpace(f[9]) != "" {
			if t, ok := parseISO(strings.TrimSpace(f[9])); ok {
				j.Dismissed = true
				j.DismissedAt = t
			}
		}
		jobs = append(jobs, j)
	}
	return jobs
}

// QualifiersInWindow returns qualifier jobs (score >= minScore) found within the last
// `window`, newest first. This is the Found panel's ONLY source.
//
// HARD RULE (time-to-lead): the Found panel shows ONLY qualifiers found in the last 24h.
// The pipeline exists to surface roles within 24h of posting; a job older than the window is
// past its time-to-lead value, so it drops off the board regardless of applied/dismissed state.
// Do not reintroduce an unbounded/persistent Found list — keep the window. See modes/dashboard.md.
func QualifiersInWindow(jobs []model.ScoredJob, minScore float64, window time.Duration) []model.ScoredJob {
	cutoff := time.Now().Add(-window)
	var out []model.ScoredJob
	for _, j := range jobs {
		if j.Applied || j.Dismissed {
			continue // applied jobs live in the other panel; dismissed are off the board
		}
		if j.Score < minScore {
			continue
		}
		// "aged" joins pass/skip here: an aged req is real and open, but its found_at is when it was
		// SCORED, not posted, so it reads as fresh to any window filter. It has its own surface in
		// daily-quota and must never occupy a slot on the 24h board.
		if v := strings.ToLower(j.Verdict); v == "pass" || v == "skip" || v == "aged" {
			continue // deliberate non-pursuit (duplicate/downgrade) outranks raw score
		}
		if j.FoundAt.IsZero() || j.FoundAt.Before(cutoff) {
			continue
		}
		out = append(out, j)
	}
	// Newest first; on a tie (e.g. same-day backfilled timestamps), higher score first.
	sort.SliceStable(out, func(i, k int) bool {
		if !out[i].FoundAt.Equal(out[k].FoundAt) {
			return out[i].FoundAt.After(out[k].FoundAt)
		}
		return out[i].Score > out[k].Score
	})
	return out
}

// LiveLeads returns qualifier jobs (score >= minScore) found OLDER than `fresh` but within
// `stale` — the re-verified-live fallback the Found panel shows when the 24h board is empty
// (the UI mirror of daily-quota's LIVE FALLBACK). These are past the 24h time-to-lead window
// but still recent and worth a re-verify before applying; found_at is NEVER re-stamped to
// fake freshness. Newest first. See modes/_profile.md "Empty board -> keep searching" and
// memory feedback_empty_board_keep_searching.
func LiveLeads(jobs []model.ScoredJob, minScore float64, fresh, stale time.Duration) []model.ScoredJob {
	now := time.Now()
	freshCut := now.Add(-fresh)
	staleCut := now.Add(-stale)
	var out []model.ScoredJob
	for _, j := range jobs {
		if j.Applied || j.Dismissed {
			continue
		}
		if j.Score < minScore {
			continue
		}
		// "aged" joins pass/skip here: an aged req is real and open, but its found_at is when it was
		// SCORED, not posted, so it reads as fresh to any window filter. It has its own surface in
		// daily-quota and must never occupy a slot on the 24h board.
		if v := strings.ToLower(j.Verdict); v == "pass" || v == "skip" || v == "aged" {
			continue
		}
		// Keep only the 24h..7d band: within `fresh` belongs to the Found panel; older than
		// `stale` is past its lead value and dropped.
		if j.FoundAt.IsZero() || j.FoundAt.Before(staleCut) || !j.FoundAt.Before(freshCut) {
			continue
		}
		out = append(out, j)
	}
	sort.SliceStable(out, func(i, k int) bool {
		if !out[i].FoundAt.Equal(out[k].FoundAt) {
			return out[i].FoundAt.After(out[k].FoundAt)
		}
		return out[i].Score > out[k].Score
	})
	return out
}

// AppliedJobs returns all jobs marked applied, newest-applied first.
func AppliedJobs(jobs []model.ScoredJob) []model.ScoredJob {
	var out []model.ScoredJob
	for _, j := range jobs {
		if j.Applied {
			out = append(out, j)
		}
	}
	sort.SliceStable(out, func(i, k int) bool {
		if !out[i].AppliedAt.Equal(out[k].AppliedAt) {
			return out[i].AppliedAt.After(out[k].AppliedAt)
		}
		return out[i].Score > out[k].Score
	})
	return out
}

// normalizeRole lowercases and strips punctuation for loose role comparison.
func normalizeRole(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.NewReplacer(",", " ", "-", " ", "/", " ", "(", " ", ")", " ").Replace(s)
	return strings.Join(strings.Fields(s), " ")
}

var reParen = regexp.MustCompile(`\s*\([^)]*\)`)

// stripParen removes parenthetical qualifiers, e.g. "Sendbird (Delight.ai)" -> "Sendbird".
func stripParen(s string) string { return strings.TrimSpace(reParen.ReplaceAllString(s, "")) }

// matchesApp reports whether a scored job corresponds to a tracker entry (same company,
// and the roles are equal or one contains the other).
func matchesApp(j model.ScoredJob, app model.CareerApplication) bool {
	if normalizeCompany(stripParen(j.Company)) != normalizeCompany(stripParen(app.Company)) {
		return false
	}
	a, b := normalizeRole(j.Role), normalizeRole(app.Role)
	if a == "" || b == "" {
		return false
	}
	return a == b || strings.Contains(a, b) || strings.Contains(b, a)
}

// isDatePrefix reports whether a filename tail begins with a YYYY-MM-DD stamp, which is how the
// old {num}-{company}-{date}.md report convention is recognised.
func isDatePrefix(tail string) bool {
	if len(tail) < 10 {
		return false
	}
	d := tail[:10]
	if d[4] != '-' || d[7] != '-' {
		return false
	}
	for i, c := range d {
		if i == 4 || i == 7 {
			continue
		}
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// AttachReportPaths links each scored job to its evaluation report.
//
// TWO SOURCES, tracker first then the directory. The tracker (applications.md) is authoritative
// when it has a row, because that row was written deliberately and carries the canonical path.
//
// THE DIRECTORY FALLBACK EXISTS BECAUSE THE TRACKER IS INCOMPLETE. Measured 2026-08-24:
// 474 report files on disk against 220 applications.md rows — roughly 254 reports existed and
// were INVISIBLE to the dashboard, so `r` reported "no report linked for this job" on jobs whose
// report was sitting right there. A report is written by whoever evaluates the role; the tracker
// row is a separate merge-tracker step that is easy to skip, and skipping it silently orphaned
// the report. AttachOutreachPaths and AttachJDPaths already scan their own directories by
// filename slug; reports were the only artifact that did not.
//
// Report filenames are {num}-{company-slug}-{role-slug}-{date}.md, so the same tolerant match
// used for outreach and JDs works here: company-slug prefix (after the leading number) plus the
// first role-slug tokens. Newest wins, since the filename ends in a date.
func AttachReportPaths(jobs []model.ScoredJob, apps []model.CareerApplication, careerOpsPath string) {
	for i := range jobs {
		for _, app := range apps {
			if app.ReportPath != "" && matchesApp(jobs[i], app) {
				jobs[i].ReportPath = app.ReportPath
				break
			}
		}
	}

	dir := filepath.Join(careerOpsPath, "reports")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files) // filename ends in a date, so the newest sorts last

	// Strip the leading "{num}-" so the company slug is at the front.
	trimNum := func(f string) string {
		if i := strings.Index(f, "-"); i > 0 {
			if _, err := strconv.Atoi(f[:i]); err == nil {
				return f[i+1:]
			}
		}
		return f
	}
	roleTokens := func(role string, n int) string {
		parts := strings.Split(slugify(role), "-")
		if len(parts) > n {
			parts = parts[:n]
		}
		return strings.Join(parts, "-")
	}

	// How many scored roles does each employer have? A company-only filename match is only safe
	// when the answer is one.
	//
	// Example: an employer has two scored reqs, "Data Engineer" (4.7) and
	// "Head of Data Engineering" (2.5). Only ONE report exists for that employer, and it is
	// the exec one. The company fallback attached it to BOTH, so opening the 4.7 IC role served a
	// 2.5 exec role's stub. A wrong artifact is worse than a missing one: it sends you into an
	// interview holding the other job's evaluation.
	rolesPerCompany := map[string]int{}
	for i := range jobs {
		if cs := slugify(stripParen(jobs[i].Company)); cs != "" {
			rolesPerCompany[cs]++
		}
	}

	for i := range jobs {
		if jobs[i].ReportPath != "" {
			continue // the tracker already answered
		}
		companySlug := slugify(stripParen(jobs[i].Company))
		if companySlug == "" {
			continue
		}
		prefix := companySlug + "-"
		roleHint := roleTokens(jobs[i].Role, 3)
		// TWO FILENAME CONVENTIONS live in reports/ and both must resolve:
		//   old: {num}-{company}-{date}.md              e.g. 789-acme-2026-06-08.md
		//   new: {num}-{company}-{role}-{date}.md       e.g. 999-acme-data-engineer-...
		// Requiring a role slug silently failed EVERY old-convention report — which is most of the
		// back catalogue, including roles already applied to.
		// A role match is stronger, so prefer it; fall back to a company-level match when the tail
		// is just a date.
		var roleMatch, companyMatch string
		for _, f := range files {
			rest := trimNum(f)
			if !strings.HasPrefix(rest, prefix) {
				continue
			}
			tail := strings.TrimPrefix(rest, prefix)
			switch {
			case roleHint != "" && strings.HasPrefix(tail, roleHint):
				roleMatch = f // later (newer-dated) wins
			case isDatePrefix(tail):
				companyMatch = f
			}
		}
		match := roleMatch
		if match == "" && rolesPerCompany[companySlug] <= 1 {
			// Only fall back to a company-level match when this employer has a single scored role.
			match = companyMatch
		}
		if match != "" {
			jobs[i].ReportPath = filepath.Join("reports", match)
		}
	}
}

// AttachOutreachPaths links each scored job to its drafted outreach HTML in
// output/outreach/ (named {company-slug}-{role-slug}-{date}.html), so the report
// viewer can show a link to it. Matches by company slug prefix + the first role-slug
// tokens (tolerant of small role-string differences), and picks the newest by filename
// (date sorts last). Stores the ABSOLUTE path.
func AttachOutreachPaths(jobs []model.ScoredJob, careerOpsPath string) {
	dir := filepath.Join(careerOpsPath, "output", "outreach")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".html") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files) // ascending; the newest date sorts last

	roleTokens := func(role string, n int) string {
		parts := strings.Split(slugify(role), "-")
		if len(parts) > n {
			parts = parts[:n]
		}
		return strings.Join(parts, "-")
	}

	for i := range jobs {
		companySlug := slugify(stripParen(jobs[i].Company))
		if companySlug == "" {
			continue
		}
		prefix := companySlug + "-"
		roleHint := roleTokens(jobs[i].Role, 3) // e.g. "data-engineer"
		var match string
		for _, f := range files {
			if !strings.HasPrefix(f, prefix) {
				continue
			}
			rest := strings.TrimPrefix(f, prefix) // {role-slug}-{date}.html
			if roleHint == "" || strings.HasPrefix(rest, roleHint) {
				match = f // keep scanning; later (newer-dated) match wins
			}
		}
		if match != "" {
			abs, err := filepath.Abs(filepath.Join(dir, match))
			if err != nil {
				abs = filepath.Join(dir, match)
			}
			jobs[i].OutreachPath = abs
		}
	}
}

// AttachResumePaths links each scored job to its tailored resume PDF in output/.
//
// Filenames come in two shapes. The modern one carries the role,
// cv-{candidate}-{company}-{role-slug}-{date}.pdf; the legacy one is company-only,
// cv-{candidate}-{company}-{date}.pdf. {candidate} is the user's name slug (modes/pdf.md), which
// the dashboard does not need to know: it locates "-{company}-" after the "cv-" prefix.
// A role-carrying file must match the role, because an
// employer routinely runs several requisitions at once and the resume is tailored per req, not per
// employer. A company-only file is accepted ONLY when this employer has a single role on the board,
// the same guard AttachReportPaths already applies to company-only reports — otherwise Acme's
// April "Data Engineer" PDF would attach itself to September's "Data Engineer,
// Mid-Market, Remote" and the board would show the wrong CV as this job's.
//
// Newest matching file wins, so a regenerated resume supersedes an older one.
func AttachResumePaths(jobs []model.ScoredJob, careerOpsPath string) {
	dir := filepath.Join(careerOpsPath, "output")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var files []string
	for _, e := range entries {
		n := e.Name()
		if !e.IsDir() && strings.HasSuffix(strings.ToLower(n), ".pdf") && strings.HasPrefix(n, "cv-") {
			files = append(files, n)
		}
	}
	sort.Strings(files) // ascending; the date suffix makes the last match the newest

	rolesPerCompany := map[string]int{}
	seen := map[string]bool{}
	for i := range jobs {
		key := slugify(stripParen(jobs[i].Company)) + "|" + slugify(jobs[i].Role)
		if !seen[key] {
			seen[key] = true
			rolesPerCompany[slugify(stripParen(jobs[i].Company))]++
		}
	}

	for i := range jobs {
		companySlug := slugify(stripParen(jobs[i].Company))
		if companySlug == "" {
			continue
		}
		needle := "-" + companySlug + "-"
		roleSlug := slugify(jobs[i].Role)
		roleParts := strings.Split(roleSlug, "-")
		var match string
		var companyOnly string
		for _, f := range files {
			// "cv-{candidate}-{company}-..." : the first "-{company}-" after "cv" ends the prefix.
			at := strings.Index(f[2:], needle)
			if at < 0 {
				continue
			}
			rest := strings.TrimSuffix(f[2+at+len(needle):], ".pdf")
			// rest is either "{date}" (legacy) or "{role-slug}-{date}".
			if dateOnly.MatchString(rest) {
				companyOnly = f
				continue
			}
			body := dateSuffix.ReplaceAllString(rest, "")
			if body == "" {
				companyOnly = f
				continue
			}
			// Word overlap alone cannot separate "Data Engineer" from "Data Engineer,
			// Mid-Market, Remote": the shorter role's words are ALL present in the longer filename, so
			// overlap scores 1.00 in the wrong direction. Compare the segment/seniority tokens
			// directly and treat any disagreement as a different requisition.
			if !sameReqTokens(roleSlug, body) {
				continue
			}
			hits, total := 0, 0
			for _, w := range roleParts {
				if len(w) <= 3 {
					continue
				}
				total++
				if strings.Contains(body, w) {
					hits++
				}
			}
			if total == 0 || float64(hits)/float64(total) >= 0.6 {
				match = f
			}
		}
		if match == "" && companyOnly != "" && rolesPerCompany[companySlug] <= 1 {
			match = companyOnly
		}
		if match != "" {
			abs, err := filepath.Abs(filepath.Join(dir, match))
			if err != nil {
				abs = filepath.Join(dir, match)
			}
			jobs[i].ResumePath = abs
		}
	}
}

// sameReqTokens reports whether two role slugs carry the SAME segment/territory and seniority
// qualifiers. A difference in either means a different requisition, however much vocabulary the
// two titles share. Mirrors reqMismatch in scripts/pipeline-owed.mjs, deliberately: the board and
// the owed-check must agree on what counts as one job, or the board shows an artifact the owed
// list still considers missing.
func sameReqTokens(a, b string) bool {
	pick := func(s string) map[string]bool {
		out := map[string]bool{}
		for _, tok := range reqTokens {
			if strings.Contains(s, tok) {
				out[tok] = true
			}
		}
		return out
	}
	pa, pb := pick(a), pick(b)
	if len(pa) != len(pb) {
		return false
	}
	for k := range pa {
		if !pb[k] {
			return false
		}
	}
	return true
}

// Segment/territory first, then seniority. Order matters only for readability.
var reqTokens = []string{
	"mid-market", "midmarket", "enterprise", "smb", "commercial", "strategic", "majors",
	"public-sector", "federal", "government", "emerging", "corporate", "startups", "startup",
	"amer", "emea", "apac", "latam",
	"head-of", "director", "principal", "founding", "manager", "senior", "staff", "associate",
	"junior", "intern",
}

var dateOnly = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
var dateSuffix = regexp.MustCompile(`-?\d{4}-\d{2}-\d{2}$`)

// AttachJDPaths links each scored job to its local JD snapshot in data/jds/, named
// {company-slug}-{role-slug}-{reqid}.md. Same tolerant matching as AttachOutreachPaths:
// company-slug prefix plus the first role-slug tokens, so "Data Engineer" still matches
// "acme-data-engineer-32951312.md". Stores the ABSOLUTE path.
//
// Without this the dashboard had no concept of a JD file at all: snapshots were being written
// to data/jds/ by the pipeline and nothing ever read them, so every job showed as "not linked"
// no matter how complete its record was.
func AttachJDPaths(jobs []model.ScoredJob, careerOpsPath string) {
	dir := filepath.Join(careerOpsPath, "data", "jds")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	roleTokens := func(role string, n int) string {
		parts := strings.Split(slugify(role), "-")
		if len(parts) > n {
			parts = parts[:n]
		}
		return strings.Join(parts, "-")
	}

	for i := range jobs {
		companySlug := slugify(stripParen(jobs[i].Company))
		if companySlug == "" {
			continue
		}
		prefix := companySlug + "-"
		roleHint := roleTokens(jobs[i].Role, 3)
		var match string
		for _, f := range files {
			if !strings.HasPrefix(f, prefix) {
				continue
			}
			rest := strings.TrimPrefix(f, prefix)
			if roleHint == "" || strings.HasPrefix(rest, roleHint) {
				match = f
			}
		}
		if match != "" {
			abs, err := filepath.Abs(filepath.Join(dir, match))
			if err != nil {
				abs = filepath.Join(dir, match)
			}
			jobs[i].JDPath = abs
			// The rendered PDF is the same basename under output/jds/. Deriving it from the
			// snapshot we just matched, instead of running a second independent match, means the
			// PDF can never point at a different requisition than the markdown beside it.
			pdf := filepath.Join(careerOpsPath, "output", "jds",
				strings.TrimSuffix(match, ".md")+".pdf")
			if _, err := os.Stat(pdf); err == nil {
				if p, err := filepath.Abs(pdf); err == nil {
					jobs[i].JDPdfPath = p
				} else {
					jobs[i].JDPdfPath = pdf
				}
			}
		}
	}
}

// MarkScoredApplied records a job as applied: it stamps applied_at in scored-jobs.tsv and
// syncs the canonical tracker. trackerSynced is true when an existing applications.md row
// was updated in place; otherwise a tracker-addition TSV was queued for merge-tracker.mjs.
func MarkScoredApplied(careerOpsPath string, job model.ScoredJob, apps []model.CareerApplication) (trackerSynced bool, err error) {
	if err = stampAppliedAt(careerOpsPath, job); err != nil {
		return false, err
	}

	// 1) Existing tracker row -> update its status in place (sanctioned edit).
	for _, app := range apps {
		if matchesApp(job, app) && app.ReportNumber != "" {
			if uerr := UpdateApplicationStatus(careerOpsPath, app, "Applied"); uerr == nil {
				return true, nil
			}
		}
	}

	// 2) Not in tracker -> queue a tracker-addition TSV (folded in by merge-tracker.mjs).
	if qerr := queueTrackerAddition(careerOpsPath, job, apps); qerr != nil {
		// Non-fatal: scored-jobs.tsv already reflects the applied state.
		fmt.Fprintf(os.Stderr, "WARN: tracker-addition queue failed: %v\n", qerr)
	}
	return false, nil
}

// stampAppliedAt rewrites scored-jobs.tsv, setting applied_at=now on the matching row.
func stampAppliedAt(careerOpsPath string, job model.ScoredJob) error {
	path := scoredJobsPath(careerOpsPath)
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	now := time.Now().Format(time.RFC3339)
	lines := strings.Split(string(content), "\n")
	matched := false
	for i, line := range lines {
		if i == 0 || strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < 7 {
			continue
		}
		if strings.TrimSpace(f[1]) == job.Company && strings.TrimSpace(f[2]) == job.Role && strings.TrimSpace(f[6]) == job.URL {
			for len(f) < 9 {
				f = append(f, "")
			}
			f[8] = now
			lines[i] = strings.Join(f, "\t")
			matched = true
			break
		}
	}
	if !matched {
		return fmt.Errorf("scored job not found in scored-jobs.tsv: %s / %s", job.Company, job.Role)
	}
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0644)
}

// MarkDismissed removes a job from the Found board by stamping dismissed_at (col 10) in
// scored-jobs.tsv. It does not touch the tracker — a dismiss is "not pursuing", not "applied".
func MarkDismissed(careerOpsPath string, job model.ScoredJob) error {
	path := scoredJobsPath(careerOpsPath)
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	lines := strings.Split(string(content), "\n")
	matched := false
	for i, line := range lines {
		if i == 0 || strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < 7 {
			continue
		}
		if strings.TrimSpace(f[1]) == job.Company && strings.TrimSpace(f[2]) == job.Role && strings.TrimSpace(f[6]) == job.URL {
			for len(f) < 10 {
				f = append(f, "")
			}
			f[9] = now
			lines[i] = strings.Join(f, "\t")
			matched = true
			break
		}
	}
	if !matched {
		return fmt.Errorf("scored job not found in scored-jobs.tsv: %s / %s", job.Company, job.Role)
	}
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0644)
}

var reNonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	s = strings.ToLower(s)
	s = reNonSlug.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}

// queueTrackerAddition writes a tracker-addition TSV (status=Applied) for merge-tracker.mjs.
// Column order matches CLAUDE.md: num date company role status score/5 pdf report notes.
func queueTrackerAddition(careerOpsPath string, job model.ScoredJob, apps []model.CareerApplication) error {
	dir := filepath.Join(careerOpsPath, "batch", "tracker-additions")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	maxNum := 0
	for _, a := range apps {
		if a.Number > maxNum {
			maxNum = a.Number
		}
	}
	num := maxNum + 1
	date := time.Now().Format("2006-01-02")
	score := job.ScoreRaw
	if !strings.Contains(score, "/") {
		score = fmt.Sprintf("%.1f/5", job.Score)
	}
	note := "Marked applied via dashboard"
	row := strings.Join([]string{
		strconv.Itoa(num), date, job.Company, job.Role, "Applied", score, "❌", "-", note,
	}, "\t")
	file := filepath.Join(dir, fmt.Sprintf("dash-%s.tsv", slugify(job.Company+"-"+job.Role)))
	return os.WriteFile(file, []byte(row+"\n"), 0644)
}
