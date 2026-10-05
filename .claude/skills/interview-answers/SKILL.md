---
name: interview-answers
description: Draft and rehearse answers to common interview questions ("Why do you want to work here?", "Why are you leaving?", "Tell me about yourself", strengths/weaknesses, and any question added to questions/). Use whenever the user asks for help answering an interview question, wants an answer critiqued or tightened, or is prepping for a specific interview round. Each question has its own playbook in questions/; this file holds the shared rules that apply to all of them.
user_invocable: true
args: question
argument-hint: "[why-this-company | why-leaving | tell-me-about-yourself | <any question, quoted>]"
---

# interview-answers — Answer Playbooks

One skill, one file per question. `SKILL.md` holds the rules that apply to every
answer; `questions/*.md` holds the framework for a specific question.

## Routing

1. Match the user's question against the index below (match on meaning, not wording —
   "what draws you to Stripe" is `why-this-company`).
2. Read that playbook and follow it exactly. Its structure wins over anything general here.
3. No match? Follow **Default shape** below, then offer to save the new playbook
   (see *Adding a question*).

| Playbook | Triggers |
|---|---|
| [`questions/why-this-company.md`](questions/why-this-company.md) | "why do you want to work here", "why [company]", "why are you interested in this role", "what draws you to us", "why us" |

**Already-written answers** live in `interview-prep/` and are the user's, not the system's.
Before drafting anything new, list `interview-prep/` and read any saved answer to the same
question (files are named `{question-slug}.html` or `.md`). The job is usually to adapt it to
this company, not to start over. Two files are shared across questions when they exist:
`interview-prep/story-bank.md` (STAR+R stories for behavioral questions) and
`interview-prep/mock-questions.md` (the running list of questions to prep). A fresh install has
neither; create them the first time the user saves an answer or a story.

## Shared rules

**Ground every claim.** Facts come from `cv.md`, `article-digest.md`, `config/profile.yml`,
`config/narrative.md`, and `interview-prep/story-bank.md`. Never invent a project, hobby,
metric, or opinion. If a slot in a framework needs a personal detail you cannot source, ask
the user one direct question rather than filling it with something plausible.

**Every answer must sell.** An answer that is merely true is a wasted turn. Before delivering,
check it lands at least one of these three levers:

- **Company research** — a specific, checkable thing about the company: a launch, an engineering
  blog post, a talk, a design decision, a change in the product you actually noticed. Specificity
  is the proof of effort; "great culture" and "you changed the world" prove nothing.
- **Relevant experience** — the answer itself carries evidence you can do the job. Name the thing
  you built or ran, what you learned from it, and why it points at this role.
- **Passion** — a true reason the problem matters to you personally. Strongest when the company
  is a startup or has a mission with a clear "who this helps."

**Calibrate to company size** (this changes which lever to lead with):

- *Big company* — they assume you want to work there, so research and enthusiasm buy little.
  Lead with fit for the **role or team**, and with experience that makes you good at it.
- *Startup* — passion for the space and a real opinion about the product carry weight.
  Use the product before the interview and have a view on it.

**Never say:**
- "It's a great stepping stone" / "great name on my resume" — reads as short tenure.
- "The financial upside" of a startup — reads as money-motivated and naive about the grind.
- Generic praise ("great culture", "you're changing the world", "everyone uses your product")
  with nothing behind it.
- Anything negative about a current or former employer.

**Two or three reasons, prepared in advance, practiced out loud.** If several interviewers ask
the same question, give them substantially the same answer — differing stories across a loop
looks improvised.

**Writing rules.** Apply the `avoid-ai-writing` skill to every line the user will say aloud:
no em dashes, no "I'm passionate about", no setup phrases ("That's a great question"), no
tricolons, no chatbot artifacts. Answers must sound like speech, not prose. Read them aloud
in your head; if a sentence needs a comma to survive, cut it.

## Default shape (question with no playbook yet)

1. **One-sentence answer** to the literal question. Lead with it.
2. **One piece of evidence** — a project, a number, a story from the story bank.
3. **One forward-looking line** tying it to this role.

Then stop. Silence invites the follow-up, and the follow-up is where the real credibility lands.

## Output

- Deliver the answer in chat as speakable lines, plus a small table mapping each part of the
  answer to the framework's slots so the user can check the structure held.
- Give a **60-second version and a 20-second version** when the answer is longer than three
  sentences.
- Flag any part that depends on a fact you could not verify, and say which file it should
  come from.
- If the user asks to keep it, write it to `interview-prep/{question-slug}.html` in the same
  format as the existing files there, or `.md` if they prefer.

## Adding a question

The user will keep adding questions. When they do:

1. Copy `questions/_template.md` to `questions/{question-slug}.md`.
2. Fill it in from what the user gave you, in their framing. Do not substitute a framework
   they didn't ask for, and keep any example they wrote verbatim as the canonical example.
3. Add a row to the routing table above, with the phrasings that should trigger it.
4. Add the question to `interview-prep/mock-questions.md` if it isn't there.
5. Persist any rule the user states as a preference ("always do X in this answer") into the
   playbook, not just into the answer at hand.
