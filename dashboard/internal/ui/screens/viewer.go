package screens

import (
	"os"
	"regexp"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// ViewerClosedMsg is emitted when the viewer is dismissed.
type ViewerClosedMsg struct{}

// ViewerModel implements an integrated file viewer screen.
type ViewerModel struct {
	lines        []string // raw logical lines from the file
	visual       []string // pre-rendered, wrapped visual lines
	title        string
	scrollOffset int // in visual-line space
	width        int
	height       int
	theme        theme.Theme
}

// NewViewerModel creates a new file viewer for the given path. An optional non-empty
// `note` is prepended as the first content line (used to surface the outreach HTML link).
func NewViewerModel(t theme.Theme, path, title, note string, width, height int) ViewerModel {
	content, err := os.ReadFile(path)
	if err != nil {
		content = []byte("Error reading file: " + err.Error())
	}

	lines := strings.Split(string(content), "\n")
	if note != "" {
		lines = append([]string{note, ""}, lines...)
	}

	m := ViewerModel{
		lines:  lines,
		title:  title,
		width:  width,
		height: height,
		theme:  t,
	}
	m.rebuildVisual()
	return m
}

func (m ViewerModel) Init() tea.Cmd {
	return nil
}

func (m *ViewerModel) Resize(width, height int) {
	if width != m.width {
		m.width = width
		m.height = height
		m.rebuildVisual()
		// Clamp scroll after reflow
		if max := m.maxScroll(); m.scrollOffset > max {
			m.scrollOffset = max
		}
		return
	}
	m.height = height
}

func (m ViewerModel) Update(msg tea.Msg) (ViewerModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "esc":
			return m, func() tea.Msg { return ViewerClosedMsg{} }

		case "down", "j":
			if m.scrollOffset < m.maxScroll() {
				m.scrollOffset++
			}

		case "up", "k":
			if m.scrollOffset > 0 {
				m.scrollOffset--
			}

		case "pgdown", "ctrl+d":
			jump := m.bodyHeight() / 2
			m.scrollOffset += jump
			if m.scrollOffset > m.maxScroll() {
				m.scrollOffset = m.maxScroll()
			}

		case "pgup", "ctrl+u":
			jump := m.bodyHeight() / 2
			m.scrollOffset -= jump
			if m.scrollOffset < 0 {
				m.scrollOffset = 0
			}

		case "home", "g":
			m.scrollOffset = 0

		case "end", "G":
			m.scrollOffset = m.maxScroll()
		}

	case tea.WindowSizeMsg:
		if msg.Width != m.width {
			m.width = msg.Width
			m.height = msg.Height
			m.rebuildVisual()
			if max := m.maxScroll(); m.scrollOffset > max {
				m.scrollOffset = max
			}
		} else {
			m.height = msg.Height
		}
	}

	return m, nil
}

func (m ViewerModel) bodyHeight() int {
	h := m.height - 4 // header + footer + padding
	if h < 3 {
		h = 3
	}
	return h
}

func (m ViewerModel) maxScroll() int {
	max := len(m.visual) - m.bodyHeight()
	if max < 0 {
		return 0
	}
	return max
}

func (m ViewerModel) View() string {
	header := m.renderHeader()
	body := m.renderBody()
	footer := m.renderFooter()

	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

func (m ViewerModel) renderHeader() string {
	style := lipgloss.NewStyle().
		Bold(true).
		Foreground(m.theme.Text).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render(m.title)

	right := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	scroll := right.Render(func() string {
		if len(m.visual) == 0 {
			return ""
		}
		max := m.maxScroll()
		if max == 0 {
			return "All"
		}
		if m.scrollOffset == 0 {
			return "Top"
		}
		if m.scrollOffset >= max {
			return "End"
		}
		pct := m.scrollOffset * 100 / max
		return string(rune('0'+pct/10%10)) + string(rune('0'+pct%10)) + "%"
	}())

	gap := m.width - lipgloss.Width(m.title) - lipgloss.Width(scroll) - 4
	if gap < 1 {
		gap = 1
	}

	return style.Render(title + strings.Repeat(" ", gap) + scroll)
}

func (m ViewerModel) renderBody() string {
	bh := m.bodyHeight()
	padStyle := lipgloss.NewStyle().Padding(0, 2)

	if len(m.visual) == 0 {
		emptyStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)
		return padStyle.Render(emptyStyle.Render("(empty file)"))
	}

	end := m.scrollOffset + bh
	if end > len(m.visual) {
		end = len(m.visual)
	}
	visible := append([]string{}, m.visual[m.scrollOffset:end]...)

	for len(visible) < bh {
		visible = append(visible, "")
	}

	return padStyle.Render(strings.Join(visible, "\n"))
}

// rebuildVisual re-computes the wrapped, styled visual lines from m.lines.
// Called once on init and whenever the width changes.
func (m *ViewerModel) rebuildVisual() {
	m.visual = m.visual[:0]
	contentWidth := m.width - 4 // account for body padding
	if contentWidth < 20 {
		contentWidth = 20
	}

	i := 0
	for i < len(m.lines) {
		if isTableLine(m.lines[i]) {
			// Collect consecutive table lines
			start := i
			for i < len(m.lines) && isTableLine(m.lines[i]) {
				i++
			}
			tableLines := m.lines[start:i]
			colWidths := computeColumnWidths(tableLines, contentWidth)
			rendered := m.renderTableBlock(tableLines, colWidths, start)
			m.visual = append(m.visual, rendered...)
			continue
		}

		// Non-table: style then wrap
		line := m.lines[i]
		i++

		if strings.TrimSpace(line) == "" {
			m.visual = append(m.visual, "")
			continue
		}

		// Horizontal rule — render as a single full-width rule
		if t := strings.TrimSpace(line); t == "---" || t == "***" {
			rule := lipgloss.NewStyle().
				Foreground(m.theme.Overlay).
				Render(strings.Repeat("─", contentWidth))
			m.visual = append(m.visual, rule)
			continue
		}

		segments := m.styleAndWrap(line, contentWidth)
		m.visual = append(m.visual, segments...)
	}
}

// isTableLine checks if a line is part of a markdown table.
func isTableLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	return len(trimmed) > 1 && trimmed[0] == '|'
}

// isTableSeparator checks if a line is a table separator (|---|---|).
func isTableSeparator(line string) bool {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "|") {
		return false
	}
	cleaned := strings.NewReplacer("|", "", "-", "", ":", "", " ", "").Replace(trimmed)
	return cleaned == ""
}

// parseTableCells splits a table line into trimmed cells.
func parseTableCells(line string) []string {
	trimmed := strings.TrimSpace(line)
	if len(trimmed) > 0 && trimmed[0] == '|' {
		trimmed = trimmed[1:]
	}
	if len(trimmed) > 0 && trimmed[len(trimmed)-1] == '|' {
		trimmed = trimmed[:len(trimmed)-1]
	}
	parts := strings.Split(trimmed, "|")
	cells := make([]string, len(parts))
	for i, p := range parts {
		cells[i] = strings.TrimSpace(p)
	}
	return cells
}

// computeColumnWidths calculates max width per column across all table rows.
func computeColumnWidths(lines []string, maxTotal int) []int {
	maxCols := 0
	for _, line := range lines {
		if isTableSeparator(line) {
			continue
		}
		cells := parseTableCells(line)
		if len(cells) > maxCols {
			maxCols = len(cells)
		}
	}
	if maxCols == 0 {
		return nil
	}

	widths := make([]int, maxCols)
	for _, line := range lines {
		if isTableSeparator(line) {
			continue
		}
		cells := parseTableCells(line)
		for i, cell := range cells {
			if i < maxCols {
				w := lipgloss.Width(cell)
				if w > widths[i] {
					widths[i] = w
				}
			}
		}
	}

	maxColW := 45
	if maxCols > 5 {
		maxColW = 30
	}
	if maxCols > 7 {
		maxColW = 22
	}
	for i := range widths {
		if widths[i] > maxColW {
			widths[i] = maxColW
		}
		if widths[i] < 3 {
			widths[i] = 3
		}
	}

	for {
		total := 1
		for _, w := range widths {
			total += w + 3
		}
		if total <= maxTotal {
			break
		}
		widestIdx := 0
		widestVal := 0
		for i, w := range widths {
			if w > widestVal {
				widestVal = w
				widestIdx = i
			}
		}
		if widths[widestIdx] <= 3 {
			break
		}
		widths[widestIdx]--
	}

	return widths
}

// renderTableBlock renders table lines with aligned columns and box-drawing borders.
// Cells exceeding their column width are word-wrapped into multiple visual rows.
func (m ViewerModel) renderTableBlock(lines []string, colWidths []int, firstLineIdx int) []string {
	if len(lines) == 0 || len(colWidths) == 0 {
		var result []string
		for _, line := range lines {
			result = append(result, m.styleLine(line))
		}
		return result
	}

	maxCols := len(colWidths)
	borderStyle := lipgloss.NewStyle().Foreground(m.theme.Overlay)
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky)
	dataStyle := lipgloss.NewStyle().Foreground(m.theme.Text)

	var result []string

	var topParts []string
	for _, w := range colWidths {
		topParts = append(topParts, strings.Repeat("─", w+2))
	}
	result = append(result, borderStyle.Render("┌"+strings.Join(topParts, "┬")+"┐"))

	isFirstDataRow := true
	for _, line := range lines {
		if isTableSeparator(line) {
			var sepParts []string
			for _, w := range colWidths {
				sepParts = append(sepParts, strings.Repeat("─", w+2))
			}
			result = append(result, borderStyle.Render("├"+strings.Join(sepParts, "┼")+"┤"))
			continue
		}

		cells := parseTableCells(line)

		// Wrap each cell to its column width; collect the rows it needs.
		wrappedCells := make([][]string, maxCols)
		rowCount := 1
		for i := 0; i < maxCols; i++ {
			cell := ""
			if i < len(cells) {
				cell = cells[i]
			}
			segs := wrapToWidth(cell, colWidths[i])
			if len(segs) == 0 {
				segs = []string{""}
			}
			wrappedCells[i] = segs
			if len(segs) > rowCount {
				rowCount = len(segs)
			}
		}

		border := borderStyle.Render("│")
		for r := 0; r < rowCount; r++ {
			var rowParts []string
			for i := 0; i < maxCols; i++ {
				cell := ""
				if r < len(wrappedCells[i]) {
					cell = wrappedCells[i][r]
				}
				colW := colWidths[i]
				padding := colW - lipgloss.Width(cell)
				if padding < 0 {
					padding = 0
				}
				padded := " " + cell + strings.Repeat(" ", padding) + " "
				if isFirstDataRow {
					rowParts = append(rowParts, headerStyle.Render(padded))
				} else {
					rowParts = append(rowParts, dataStyle.Render(padded))
				}
			}
			result = append(result, border+strings.Join(rowParts, border)+border)
		}
		isFirstDataRow = false
	}

	var bottomParts []string
	for _, w := range colWidths {
		bottomParts = append(bottomParts, strings.Repeat("─", w+2))
	}
	result = append(result, borderStyle.Render("└"+strings.Join(bottomParts, "┴")+"┘"))

	return result
}

// wrapToWidth word-wraps plain text to visual width, falling back to hard breaks
// for words longer than width. Returns at least one segment for empty input.
func wrapToWidth(text string, width int) []string {
	if width <= 0 {
		return []string{text}
	}
	if text == "" {
		return []string{""}
	}
	// Preserve leading whitespace on the first line for list/quote indentation.
	leading := ""
	rest := text
	for i, r := range text {
		if r != ' ' && r != '\t' {
			leading = text[:i]
			rest = text[i:]
			break
		}
		if i == len(text)-1 {
			leading = text
			rest = ""
		}
	}
	if rest == "" {
		return []string{leading}
	}

	words := strings.Fields(rest)
	if len(words) == 0 {
		return []string{leading}
	}

	var lines []string
	var cur strings.Builder
	curWidth := 0
	writeWord := func(w string) {
		ww := lipgloss.Width(w)
		// Hard-break a word that exceeds the line width on its own.
		if ww > width {
			// Flush current line first
			if cur.Len() > 0 {
				lines = append(lines, cur.String())
				cur.Reset()
				curWidth = 0
			}
			runes := []rune(w)
			var segBuilder strings.Builder
			segWidth := 0
			for _, r := range runes {
				rw := lipgloss.Width(string(r))
				if segWidth+rw > width && segBuilder.Len() > 0 {
					lines = append(lines, segBuilder.String())
					segBuilder.Reset()
					segWidth = 0
				}
				segBuilder.WriteRune(r)
				segWidth += rw
			}
			if segBuilder.Len() > 0 {
				cur.WriteString(segBuilder.String())
				curWidth = segWidth
			}
			return
		}

		if curWidth == 0 {
			cur.WriteString(w)
			curWidth = ww
			return
		}
		if curWidth+1+ww <= width {
			cur.WriteByte(' ')
			cur.WriteString(w)
			curWidth += 1 + ww
			return
		}
		lines = append(lines, cur.String())
		cur.Reset()
		cur.WriteString(w)
		curWidth = ww
	}

	// Account for the indent on the first line only.
	leadWidth := lipgloss.Width(leading)
	firstWidth := width - leadWidth
	if firstWidth < 1 {
		firstWidth = width
	}
	// Simple approach: use `width` as the wrap width but prefix the first line
	// with leading whitespace.
	_ = firstWidth

	for _, w := range words {
		writeWord(w)
	}
	if cur.Len() > 0 {
		lines = append(lines, cur.String())
	}

	if len(lines) == 0 {
		return []string{leading}
	}
	lines[0] = leading + lines[0]
	// Indent continuation lines to match the leading whitespace so bullet/quote
	// content visually aligns.
	if leading != "" {
		indent := strings.Repeat(" ", leadWidth)
		for i := 1; i < len(lines); i++ {
			lines[i] = indent + lines[i]
		}
	}
	return lines
}

var reBold = regexp.MustCompile(`\*\*([^*]+)\*\*`)

// styleAndWrap styles a non-table line and wraps it to the given visual width,
// returning one or more visual rows.
func (m ViewerModel) styleAndWrap(line string, width int) []string {
	trimmed := strings.TrimSpace(line)

	// Headings: strip markdown, style, wrap with continuation indent.
	if strings.HasPrefix(trimmed, "# ") && !strings.HasPrefix(trimmed, "## ") {
		content := strings.TrimPrefix(trimmed, "# ")
		style := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue)
		wrapped := wrapToWidth("  "+content, width)
		for i := range wrapped {
			wrapped[i] = style.Render(wrapped[i])
		}
		return wrapped
	}
	if strings.HasPrefix(trimmed, "## ") && !strings.HasPrefix(trimmed, "### ") {
		content := strings.TrimPrefix(trimmed, "## ")
		style := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve)
		wrapped := wrapToWidth("  "+content, width)
		for i := range wrapped {
			wrapped[i] = style.Render(wrapped[i])
		}
		return wrapped
	}
	if strings.HasPrefix(trimmed, "### ") {
		content := strings.TrimPrefix(trimmed, "### ")
		style := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky)
		wrapped := wrapToWidth("  "+content, width)
		for i := range wrapped {
			wrapped[i] = style.Render(wrapped[i])
		}
		return wrapped
	}

	// Blockquote: "▎ " prefix + italic subtext.
	if strings.HasPrefix(trimmed, "> ") {
		content := strings.TrimPrefix(trimmed, "> ")
		textStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Italic(true)
		borderChar := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("▎ ")
		// Reserve 2 cells for the "▎ " prefix.
		innerWidth := width - 2
		if innerWidth < 10 {
			innerWidth = 10
		}
		wrapped := wrapToWidth(content, innerWidth)
		out := make([]string, len(wrapped))
		for i, seg := range wrapped {
			out[i] = borderChar + textStyle.Render(seg)
		}
		return out
	}

	// Bold field like "**Score:** 4.0/5".
	if strings.HasPrefix(trimmed, "**") && strings.Contains(trimmed, ":**") {
		return m.wrapInlineBold(line, m.theme.Yellow, width)
	}

	// Bullet / numbered list — keep leading whitespace + marker intact.
	if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
		return m.wrapInlineBold(line, m.theme.Text, width)
	}
	if len(trimmed) > 2 && trimmed[0] >= '0' && trimmed[0] <= '9' && strings.Contains(trimmed[:3], ".") {
		return m.wrapInlineBold(line, m.theme.Text, width)
	}

	// Default paragraph text — check for inline bold regardless.
	if strings.Contains(trimmed, "**") {
		return m.wrapInlineBold(line, m.theme.Subtext, width)
	}

	style := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	wrapped := wrapToWidth(line, width)
	for i := range wrapped {
		wrapped[i] = style.Render(wrapped[i])
	}
	return wrapped
}

// styleLine is retained for the table fallback path when column widths are empty.
func (m ViewerModel) styleLine(line string) string {
	segs := m.styleAndWrap(line, m.width-4)
	return strings.Join(segs, "\n")
}

// wrapInlineBold wraps a line that contains **bold** segments, applying bold
// styling per-segment after wrapping. It splits the raw text into words while
// tracking which words fall inside a bold region.
func (m ViewerModel) wrapInlineBold(line string, baseColor lipgloss.Color, width int) []string {
	baseStyle := lipgloss.NewStyle().Foreground(baseColor)
	boldStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow)

	// Build a sequence of (text, bold) tokens by splitting on ** markers.
	type token struct {
		text string
		bold bool
	}
	var tokens []token
	rest := line
	for {
		loc := reBold.FindStringIndex(rest)
		if loc == nil {
			if rest != "" {
				tokens = append(tokens, token{text: rest, bold: false})
			}
			break
		}
		if loc[0] > 0 {
			tokens = append(tokens, token{text: rest[:loc[0]], bold: false})
		}
		inner := rest[loc[0]+2 : loc[1]-2]
		tokens = append(tokens, token{text: inner, bold: true})
		rest = rest[loc[1]:]
	}

	// Flatten tokens into a sequence of whitespace-preserving runs that we can
	// break on spaces while keeping styling info. We walk characters and group
	// contiguous non-space chars as "word" tokens with their bold flag.
	type piece struct {
		text  string
		bold  bool
		space bool // is this piece pure whitespace
	}
	var pieces []piece
	for _, tk := range tokens {
		if tk.text == "" {
			continue
		}
		var buf strings.Builder
		inSpace := false
		for _, r := range tk.text {
			if r == ' ' || r == '\t' {
				if !inSpace && buf.Len() > 0 {
					pieces = append(pieces, piece{text: buf.String(), bold: tk.bold})
					buf.Reset()
				}
				inSpace = true
				buf.WriteRune(r)
			} else {
				if inSpace && buf.Len() > 0 {
					pieces = append(pieces, piece{text: buf.String(), bold: false, space: true})
					buf.Reset()
				}
				inSpace = false
				buf.WriteRune(r)
			}
		}
		if buf.Len() > 0 {
			pieces = append(pieces, piece{text: buf.String(), bold: tk.bold, space: inSpace})
		}
	}

	// Now word-wrap by emitting pieces. Track current visual width; on a space
	// that would push us past `width`, break and start a new line (dropping the
	// leading space on the wrapped line).
	var lines []string
	var cur strings.Builder
	curWidth := 0
	flush := func() {
		lines = append(lines, cur.String())
		cur.Reset()
		curWidth = 0
	}

	render := func(p piece) string {
		if p.bold {
			return boldStyle.Render(p.text)
		}
		return baseStyle.Render(p.text)
	}

	for i, p := range pieces {
		w := lipgloss.Width(p.text)
		if p.space {
			// Never start a line with whitespace (except the very first line,
			// which we allow for indent preservation).
			if curWidth == 0 && len(lines) > 0 {
				continue
			}
			// Look ahead to the next non-space piece: if adding this space plus
			// the next word would overflow, break here instead of printing it.
			nextW := 0
			for j := i + 1; j < len(pieces); j++ {
				if pieces[j].space {
					break
				}
				nextW += lipgloss.Width(pieces[j].text)
				break
			}
			if curWidth+w+nextW > width && curWidth > 0 {
				flush()
				continue
			}
			cur.WriteString(render(p))
			curWidth += w
			continue
		}

		// Non-space (word) piece.
		if w > width {
			// Hard-break an extremely long token.
			if curWidth > 0 {
				flush()
			}
			runes := []rune(p.text)
			var seg strings.Builder
			segW := 0
			for _, r := range runes {
				rw := lipgloss.Width(string(r))
				if segW+rw > width && seg.Len() > 0 {
					stylized := render(piece{text: seg.String(), bold: p.bold})
					cur.WriteString(stylized)
					curWidth += segW
					flush()
					seg.Reset()
					segW = 0
				}
				seg.WriteRune(r)
				segW += rw
			}
			if seg.Len() > 0 {
				stylized := render(piece{text: seg.String(), bold: p.bold})
				cur.WriteString(stylized)
				curWidth += segW
			}
			continue
		}

		if curWidth+w > width && curWidth > 0 {
			flush()
		}
		cur.WriteString(render(p))
		curWidth += w
	}
	if cur.Len() > 0 || len(lines) == 0 {
		lines = append(lines, cur.String())
	}
	return lines
}

func (m ViewerModel) renderFooter() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 1)

	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	return style.Render(
		keyStyle.Render("↑↓") + descStyle.Render(" scroll  ") +
			keyStyle.Render("PgUp/Dn") + descStyle.Render(" page  ") +
			keyStyle.Render("g/G") + descStyle.Render(" top/end  ") +
			keyStyle.Render("Esc") + descStyle.Render(" back"))
}
