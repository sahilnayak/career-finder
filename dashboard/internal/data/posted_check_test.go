package data

import "testing"

func TestExtractPostedDate(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"canonical header", "**Date:** 2026-04-21\n**Posted:** 2026-04-10\n**Score:** 4.2/5", "2026-04-10"},
		{"table ISO", "| Posted | 2026-04-10 | freshly listed |", "2026-04-10"},
		{"table long-form", "| Posted | April 10, 2026 (11 days fresh) |", "2026-04-10"},
		{"table bolded header", "| **Posted date** | 2026-02-26 (56 days ago) |", "2026-02-26"},
		{"prose fallback", "**Posting freshness:** Posted 2026-02-26 (56 days ago)", "2026-02-26"},
		{"prose with colon", "- **Posted:** 2025-09-24 (per JSON-LD datePosted)", "2025-09-24"},
		{"no date", "| Posted base range | $220K-$350K | JD |", ""},
		{"unrelated prose", "Posted on JD (line 46) — unusually transparent", ""},
		{"empty", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := extractPostedDate(tc.in)
			if got != tc.want {
				t.Errorf("extractPostedDate(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
