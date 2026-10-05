package data

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestScoredParseWindowAndMarkApplied(t *testing.T) {
	tmp := t.TempDir()
	fresh := time.Now().Add(-time.Hour).Format(time.RFC3339)

	scored := "date\tcompany\trole\tscore\tverdict\twhy\turl\tfound_at\tapplied_at\n" +
		"2026-06-08\tAcme\tData Engineer\t4.5\tQUALIFIED\tgreat\thttps://acme/1\t" + fresh + "\t\n" +
		"2026-06-01\tOldCo\tData Engineer\t4.4\tQUALIFIED\told\thttps://old/1\t2026-06-01T12:00:00-07:00\t\n" +
		"2026-06-08\tLowCo\tSupport\t3.1\tpass\tnope\thttps://low/1\t" + fresh + "\t\n"
	writeFile(t, filepath.Join(tmp, "data", "scored-jobs.tsv"), scored)

	apps := "# Applications Tracker\n\n" +
		"| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n" +
		"|---|------|---------|------|-------|--------|-----|--------|-------|\n" +
		"| 1 | 2026-06-08 | Acme | Data Engineer | 4.5/5 | Evaluated | ✅ | [1](reports/1-acme.md) | n |\n"
	writeFile(t, filepath.Join(tmp, "data", "applications.md"), apps)

	// Parse
	jobs := ParseScoredJobs(tmp)
	if len(jobs) != 3 {
		t.Fatalf("want 3 parsed jobs, got %d", len(jobs))
	}

	// 24h window, qualifiers only: Acme (fresh, 4.5) yes; OldCo (>24h) no; LowCo (<4.3) no.
	found := QualifiersInWindow(jobs, 4.3, 24*time.Hour)
	if len(found) != 1 || found[0].Company != "Acme" {
		t.Fatalf("want [Acme], got %+v", found)
	}

	// Report drill-in linked from the tracker.
	trackerApps := ParseApplications(tmp)
	AttachReportPaths(jobs, trackerApps, t.TempDir()) // empty reports dir: exercises the tracker path only
	var acme model.ScoredJob                          // re-find Acme with ReportPath attached
	for _, j := range jobs {
		if j.Company == "Acme" {
			acme = j
		}
	}
	if acme.ReportPath != "reports/1-acme.md" {
		t.Fatalf("want Acme report linked, got %q", acme.ReportPath)
	}

	// Mark applied -> should sync the existing tracker row (synced=true).
	synced, err := MarkScoredApplied(tmp, acme, trackerApps)
	if err != nil {
		t.Fatalf("MarkScoredApplied error: %v", err)
	}
	if !synced {
		t.Fatalf("want trackerSynced=true (Acme is in applications.md)")
	}

	// scored-jobs.tsv now records the applied row.
	jobs2 := ParseScoredJobs(tmp)
	applied := AppliedJobs(jobs2)
	if len(applied) != 1 || applied[0].Company != "Acme" || !applied[0].Applied {
		t.Fatalf("want Acme applied, got %+v", applied)
	}
	// ...and Acme drops out of the Found window (applied jobs move panels).
	if got := QualifiersInWindow(jobs2, 4.3, 24*time.Hour); len(got) != 0 {
		t.Fatalf("want Acme removed from Found after apply, got %+v", got)
	}

	// applications.md status flipped to Applied.
	out, _ := os.ReadFile(filepath.Join(tmp, "data", "applications.md"))
	if !strings.Contains(string(out), "Applied") {
		t.Fatalf("applications.md not updated to Applied:\n%s", out)
	}
}

func TestQualifiersWindowAndDismiss(t *testing.T) {
	tmp := t.TempDir()
	now := time.Now()
	fresh := now.Add(-1 * time.Hour).Format(time.RFC3339)       // within 24h
	stillFresh := now.Add(-20 * time.Hour).Format(time.RFC3339) // within 24h
	old := now.Add(-48 * time.Hour).Format(time.RFC3339)        // OUTSIDE 24h
	applied := now.Add(-2 * time.Hour).Format(time.RFC3339)
	dismissed := now.Add(-2 * time.Hour).Format(time.RFC3339)

	// HARD RULE: Found = qualifiers found in the last 24h, excluding applied + dismissed.
	scored := "date\tcompany\trole\tscore\tverdict\twhy\turl\tfound_at\tapplied_at\tdismissed_at\n" +
		"2026-06-17\tFreshA\tAnalytics Engineer\t4.5\tQUALIFIED\tfresh\thttps://a/1\t" + fresh + "\t\t\n" +
		"2026-06-17\tFreshB\tData Engineer\t4.3\tQUALIFIED\tfresh20h\thttps://b/1\t" + stillFresh + "\t\t\n" +
		"2026-06-15\tStaleAge\tPlatform Engineer\t4.6\tQUALIFIED\ttoo old\thttps://c/1\t" + old + "\t\t\n" +
		"2026-06-17\tAppliedCo\tData Engineer\t4.4\tQUALIFIED\tdone\thttps://d/1\t" + applied + "\t" + applied + "\t\n" +
		"2026-06-17\tDismissedCo\tAnalytics Engineer\t4.7\tQUALIFIED\tnope\thttps://e/1\t" + fresh + "\t\t" + dismissed + "\n" +
		"2026-06-17\tPassCo\tSupport\t4.4\tpass\tdup\thttps://f/1\t" + fresh + "\t\t\n"
	writeFile(t, filepath.Join(tmp, "data", "scored-jobs.tsv"), scored)

	jobs := ParseScoredJobs(tmp)
	found := QualifiersInWindow(jobs, 4.3, 24*time.Hour)
	// Only FreshA + FreshB qualify: StaleAge=out-of-window, AppliedCo=applied, DismissedCo=dismissed, PassCo=pass.
	if len(found) != 2 {
		t.Fatalf("want 2 in-window qualifiers (FreshA, FreshB), got %d: %+v", len(found), names(found))
	}
	if found[0].Company != "FreshA" || found[1].Company != "FreshB" {
		t.Fatalf("want [FreshA, FreshB] newest-first, got %v", names(found))
	}

	// Dismiss FreshA -> it leaves the board even though it's still in-window.
	if err := MarkDismissed(tmp, found[0]); err != nil {
		t.Fatalf("MarkDismissed error: %v", err)
	}
	found2 := QualifiersInWindow(ParseScoredJobs(tmp), 4.3, 24*time.Hour)
	if len(found2) != 1 || found2[0].Company != "FreshB" {
		t.Fatalf("want [FreshB] after dismissing FreshA, got %v", names(found2))
	}
}

func names(jobs []model.ScoredJob) []string {
	var out []string
	for _, j := range jobs {
		out = append(out, j.Company)
	}
	return out
}

func TestParseISOFormats(t *testing.T) {
	cases := []string{
		"2026-06-16T20:05:03Z",
		"2026-06-16T20:05:03-07:00",
		"2026-06-14T05:25:46-0700",
		"2026-06-10T06:40:15.045Z",
	}
	for _, c := range cases {
		if _, ok := parseISO(c); !ok {
			t.Errorf("parseISO failed on %q", c)
		}
	}
	if _, ok := parseISO("not-a-time"); ok {
		t.Errorf("parseISO should reject garbage")
	}
}

func TestMarkAppliedQueuesWhenNotInTracker(t *testing.T) {
	tmp := t.TempDir()
	fresh := time.Now().Add(-time.Hour).Format(time.RFC3339)
	scored := "date\tcompany\trole\tscore\tverdict\twhy\turl\tfound_at\tapplied_at\n" +
		"2026-06-08\tNovel\tAnalytics Engineer\t4.4\tQUALIFIED\tnew\thttps://novel/1\t" + fresh + "\t\n"
	writeFile(t, filepath.Join(tmp, "data", "scored-jobs.tsv"), scored)
	writeFile(t, filepath.Join(tmp, "data", "applications.md"),
		"# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n")

	jobs := ParseScoredJobs(tmp)
	synced, err := MarkScoredApplied(tmp, jobs[0], ParseApplications(tmp))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if synced {
		t.Fatalf("want synced=false (Novel not in tracker)")
	}
	// A tracker-addition TSV should be queued for merge-tracker.mjs.
	matches, _ := filepath.Glob(filepath.Join(tmp, "batch", "tracker-additions", "dash-*.tsv"))
	if len(matches) != 1 {
		t.Fatalf("want 1 queued tracker-addition, got %d", len(matches))
	}
	body, _ := os.ReadFile(matches[0])
	if !strings.Contains(string(body), "Applied") || !strings.Contains(string(body), "Novel") {
		t.Fatalf("tracker-addition missing data: %s", body)
	}
}

// AttachResumePaths must bind a resume to the REQUISITION, not the employer. The bug this guards:
// Factory ran "Data Engineer" (April) and "Data Engineer, Mid-Market, Remote" (September) at
// once, and a company-only match handed April's PDF to September's req.
func TestAttachResumePathsMatchesRequisitionNotCompany(t *testing.T) {
	tmp := t.TempDir()
	for _, f := range []string{
		"cv-jane-doe-factory-2026-06-18.pdf",                          // legacy, company-only
		"cv-jane-doe-factory-data-engineer-mid-market-2026-09-08.pdf", // this req
		"cv-jane-doe-acme-2026-06-01.pdf",                             // sole req at Acme
	} {
		writeFile(t, filepath.Join(tmp, "output", f), "%PDF-1.4")
	}

	jobs := []model.ScoredJob{
		{Company: "Factory", Role: "Data Engineer, Mid-Market, Remote"},
		{Company: "Factory", Role: "Data Engineer"},
		{Company: "Acme", Role: "Analytics Engineer"},
		{Company: "Nobody", Role: "Data Engineer"},
	}
	AttachResumePaths(jobs, tmp)

	if got := filepath.Base(jobs[0].ResumePath); got != "cv-jane-doe-factory-data-engineer-mid-market-2026-09-08.pdf" {
		t.Errorf("Mid-Market req should get its own tailored PDF, got %q", got)
	}
	// Factory has TWO reqs on the board, so the company-only legacy PDF is ambiguous and must not
	// attach to the unsegmented req.
	if jobs[1].ResumePath != "" {
		t.Errorf("ambiguous company-only PDF must not attach when the employer has 2 reqs, got %q",
			filepath.Base(jobs[1].ResumePath))
	}
	// Acme has exactly one req, so its company-only PDF is unambiguous and should attach.
	if got := filepath.Base(jobs[2].ResumePath); got != "cv-jane-doe-acme-2026-06-01.pdf" {
		t.Errorf("sole-req employer should accept its company-only PDF, got %q", got)
	}
	if jobs[3].ResumePath != "" {
		t.Errorf("employer with no PDF must stay empty, got %q", jobs[3].ResumePath)
	}
}

// The JD PDF must be derived from the matched snapshot, never matched independently, so it can
// never point at a different requisition than the markdown beside it.
func TestAttachJDPathsAlsoLinksRenderedPdf(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "data", "jds", "acme-data-engineer-123.md"), "# Acme")
	writeFile(t, filepath.Join(tmp, "output", "jds", "acme-data-engineer-123.pdf"), "%PDF-1.4")
	writeFile(t, filepath.Join(tmp, "data", "jds", "nopdf-analytics-engineer-9.md"), "# NoPdf")

	jobs := []model.ScoredJob{
		{Company: "Acme", Role: "Data Engineer"},
		{Company: "NoPdf", Role: "Analytics Engineer"},
	}
	AttachJDPaths(jobs, tmp)

	if filepath.Base(jobs[0].JDPath) != "acme-data-engineer-123.md" {
		t.Fatalf("snapshot not matched, got %q", jobs[0].JDPath)
	}
	if filepath.Base(jobs[0].JDPdfPath) != "acme-data-engineer-123.pdf" {
		t.Errorf("want the sibling PDF, got %q", jobs[0].JDPdfPath)
	}
	// A snapshot with no rendered PDF must leave the field empty, not guess.
	if jobs[1].JDPath == "" {
		t.Fatalf("second snapshot should still match its markdown")
	}
	if jobs[1].JDPdfPath != "" {
		t.Errorf("no PDF exists, field must stay empty, got %q", jobs[1].JDPdfPath)
	}
}
