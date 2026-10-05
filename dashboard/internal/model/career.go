package model

import "time"

// CareerApplication represents a single job application from the tracker.
type CareerApplication struct {
	Number       int
	Date         string
	DatePosted   string // Date the job was posted (YYYY-MM-DD), parsed from report
	Company      string
	Role         string
	Status       string
	Score        float64
	ScoreRaw     string
	HasPDF       bool
	ReportPath   string
	ReportNumber string
	Notes        string
	JobURL       string // URL of the original job posting
	// Enrichment (lazy loaded from report)
	Archetype    string
	TlDr         string
	Remote       string
	CompEstimate string
}

// ScoredJob represents one row of data/scored-jobs.tsv (the speed-loop output).
type ScoredJob struct {
	Date        string
	Company     string
	Role        string
	Score       float64
	ScoreRaw    string
	Verdict     string // QUALIFIED / near / pass
	Why         string
	URL         string
	FoundAt     time.Time // precise discovery time (col found_at, or date@noon fallback)
	Applied     bool
	AppliedAt   time.Time // when marked applied (col applied_at)
	Dismissed   bool
	DismissedAt time.Time // when dismissed from the Found board (col dismissed_at)
	// Resolved drill-in (matched against applications.md by company+role)
	ReportPath string
	// Resolved outreach HTML (matched against output/outreach/ by company+role); absolute path
	OutreachPath string
	// Resolved local JD snapshot (data/jds/{company}-{role}-{reqid}.md); absolute path.
	// This is the durable copy of the posting text taken at scoring time — the live URL can be
	// edited or pulled by the employer (a Mixpanel req flipped Hybrid->Remote three hours after
	// being scored), so the snapshot is the only before-record we have.
	JDPath string
	// Resolved tailored resume PDF (output/cv-{candidate}-{company}[-{role}]-{date}.pdf); absolute
	// path. The board previously had no concept of the resume at all, even though every qualifier
	// owes one and pipeline-owed.mjs tracks it — so a job could be fully worked up and the board
	// still gave no way to see the CV that was tailored for it.
	ResumePath string
	// Rendered PDF of the JD snapshot (output/jds/{same basename}.pdf); absolute path. Derived
	// directly from JDPath rather than matched separately, so it cannot drift from the snapshot it
	// claims to be a copy of.
	JDPdfPath string
	// User picked this job for outreach (data/outreach-queue.tsv, status != drafted).
	// Outreach only runs on picked jobs — see the selection gate in data/outreach_queue.go.
	OutreachSelected bool
}

// PipelineMetrics holds aggregate stats for the pipeline dashboard.
type PipelineMetrics struct {
	Total      int
	ByStatus   map[string]int
	AvgScore   float64
	TopScore   float64
	WithPDF    int
	Actionable int
}

// ProgressMetrics holds job search progress analytics.
type ProgressMetrics struct {
	// Funnel
	FunnelStages []FunnelStage

	// Score distribution
	ScoreBuckets []ScoreBucket

	// Timeline (weekly activity)
	WeeklyActivity []WeekActivity

	// Rates
	ResponseRate  float64 // Responded / Applied
	InterviewRate float64 // Interview / Applied
	OfferRate     float64 // Offer / Applied

	// Averages
	AvgScore    float64
	TopScore    float64
	TotalOffers int
	ActiveApps  int // not skip/rejected/discarded
}

// FunnelStage represents one stage of the application funnel.
type FunnelStage struct {
	Label string
	Count int
	Pct   float64 // percentage of total
}

// ScoreBucket represents a score range and its count.
type ScoreBucket struct {
	Label string // e.g., "4.5-5.0", "4.0-4.4", "3.5-3.9", "3.0-3.4", "<3.0"
	Count int
}

// WeekActivity represents application activity for a given ISO week.
type WeekActivity struct {
	Week  string // e.g., "2026-W14", "2026-W13"
	Count int
}
