---
name: career-finder-language-modes
description: Non-English mode files for career-finder (German/DACH, French, Japanese in .claude/skills/career-finder/modes/{de,fr,ja}/) and the rules for when to switch to them. Use when the user targets a non-English job posting, sets language.modes_dir in config/profile.yml, or asks for output in another language.
---

### Language Modes

Default modes are in `.claude/skills/career-finder/modes/` (English), bundled with the career-finder router skill. `language.modes_dir` takes a bare language code (`de`) and resolves to `.claude/skills/career-finder/modes/{code}/`; a legacy value like `modes/de` means the same folder. Additional language-specific modes are available:

- **German (DACH market):** `.claude/skills/career-finder/modes/de/` — native German translations with DACH-specific vocabulary (13. Monatsgehalt, Probezeit, Kündigungsfrist, AGG, Tarifvertrag, etc.). Includes `_shared.md`, `angebot.md` (evaluation), `bewerben.md` (apply), `pipeline.md`.
- **French (Francophone market):** `.claude/skills/career-finder/modes/fr/` — native French translations with France/Belgium/Switzerland/Luxembourg-specific vocabulary (CDI/CDD, convention collective SYNTEC, RTT, mutuelle, prévoyance, 13e mois, intéressement/participation, titres-restaurant, CSE, portage salarial, etc.). Includes `_shared.md`, `offre.md` (evaluation), `postuler.md` (apply), `pipeline.md`.
- **Japanese (Japan market):** `.claude/skills/career-finder/modes/ja/` — native Japanese translations with Japan-specific vocabulary (正社員, 業務委託, 賞与, 退職金, みなし残業, 年俸制, 36協定, 通勤手当, 住宅手当, etc.). Includes `_shared.md`, `kyujin.md` (evaluation), `oubo.md` (apply), `pipeline.md`.

**File mapping (translated filenames).** Language folders do not mirror the English filenames. Resolve a mode to its file like this; any mode not listed for a language falls back to the English file in `.claude/skills/career-finder/modes/`:

| mode | de | fr | ja |
|---|---|---|---|
| `_shared` | `_shared.md` | `_shared.md` | `_shared.md` |
| `offer` / auto-pipeline evaluation | `angebot.md` | `offre.md` | `kyujin.md` |
| `apply` | `bewerben.md` | `postuler.md` | `oubo.md` |
| `pipeline` | `pipeline.md` | `pipeline.md` | `pipeline.md` |

**When to use German modes:** If the user is targeting German-language job postings, lives in DACH, or asks for German output. Either:
1. User says "use German modes" → read from `.claude/skills/career-finder/modes/de/` instead of `.claude/skills/career-finder/modes/`
2. User sets `language.modes_dir: de` (or the legacy `modes/de`) in `config/profile.yml` → always use German modes
3. You detect a German JD → suggest switching to German modes

**When to use French modes:** If the user is targeting French-language job postings, lives in France/Belgium/Switzerland/Luxembourg/Quebec, or asks for French output. Either:
1. User says "use French modes" → read from `.claude/skills/career-finder/modes/fr/` instead of `.claude/skills/career-finder/modes/`
2. User sets `language.modes_dir: fr` (or the legacy `modes/fr`) in `config/profile.yml` → always use French modes
3. You detect a French JD → suggest switching to French modes

**When to use Japanese modes:** If the user is targeting Japanese-language job postings, lives in Japan, or asks for Japanese output. Either:
1. User says "use Japanese modes" → read from `.claude/skills/career-finder/modes/ja/` instead of `.claude/skills/career-finder/modes/`
2. User sets `language.modes_dir: ja` (or the legacy `modes/ja`) in `config/profile.yml` → always use Japanese modes
3. You detect a Japanese JD → suggest switching to Japanese modes

**When NOT to:** If the user applies to English-language roles, even at French, German, or Japanese companies, use the default English modes.

