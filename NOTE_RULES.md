# 📐 Vid2Study: the rules of note making

Every note Vid2Study writes follows the rules below. They come straight from the prompts in `lib/prompts.js` and the code in `lib/local-pipeline.js`, so this page describes what really happens.

**Two kinds of rule**

| Mark | Meaning |
|---|---|
| 🤖 **Asked** | The Strong AI is told to follow it in its prompt. It usually does, but it can slip. |
| ⚙️ **Guaranteed** | Plain code enforces or repairs it after the AI has written, so it holds whatever the AI did. |

---

## 1. The goals (what a note must be)

1. **Hard parts are explained in easy ways, with examples.** 🤖
2. **Code comes with its output**, or at least a small runnable example with output. 🤖 ⚙️
3. **Important frames sit at the right moment**, with a real explanation next to them. 🤖 ⚙️
4. **Diagrams, charts, tables, code and formulas are never ignored.** 🤖 ⚙️
5. **Every formula is LaTeX.** 🤖 ⚙️
6. **Step-by-step depiction** for processes (sorting, searching, derivations…). 🤖 ⚙️
7. **Maths subjects get detailed, easy, step-by-step solving.** 🤖
8. **Difficult practice questions with detailed answers** for every topic, fitted to the subject. 🤖
9. **As short as possible without losing a single piece of information.** 🤖
10. **Easy to read, with shortcut explanations.** 🤖
11. **Nothing the video names is lost:** quotes, books, papers, films and documents get their own place. 🤖 ⚙️

---

## 2. Language and voice 🤖

- The notes are **always English**, even if the lecture is Hindi, Hinglish or another language. The writer translates for meaning, not word for word.
- **Kept as spoken:** technical terms, code, formulas, symbols and proper names. A term the lecturer says in English stays in English. No "translated from…" note.
- **Voice:** casual, curious, a bit playful, like good handwritten notes and not a textbook. Short punchy lines. Light humour, analogies and memory tricks are welcome. **No filler, no cringe, no emoji.**
- **Explain the WHY before the HOW.** Never assume a term is known: define it in plain words the first time it appears.
- **Easy first:** the hard part in plain words, then the precise version, then an example a newcomer can follow.

## 3. How the writer treats the input 🤖

- It first **reviews silently**: fixes obvious speech-recognition and OCR mistakes (trust the slide for spelling, the speaker for meaning), drops greetings and housekeeping, merges duplicates, fixes the order.
- **It never invents** what the lecturer said. A real gap gets an `Unclear` callout.
- It covers **every topic from the first line to the last**: what it is, why it matters, how it works step by step, how it connects to the previous topic. It must check that the end of the input is in the notes.
- **Own knowledge goes only into "Extra" callouts**, and only if accurate (if unsure, leave it out). The lecture stays the main source and is never contradicted.
- With web results: "the video / the lecture says or shows" is used **only** for what is in the input. A web page *about* the video (its YouTube page, description, a summary site) is not the video.

---

## 4. The shape of the document ⚙️

```
# Title
## Overview            3-5 short bullets: what it is about, why it matters (no detail repeated below)
## Topics              the list of topic titles with their times
## Detailed notes      one ### section per topic, in lecture order
## References          every source the video names, researched (separate section)
## Practice questions  hard questions with worked answers, per topic
```

- The overview is written once; it must not echo the sections.
- **Topic times** are real: each `### Topic (mm:ss)` heading is snapped to the transcript line that matches the section's first points (never later than its first figure). Printed and exported pages strip the times; the stored notes keep them.
- **Length per topic** follows the Detail setting: **Brief** 60–120 words, **Standard** 150–300, **Deep** 250–450.

## 5. One topic section 🤖

```
### <Topic> (mm:ss)
- **Big idea:** one line
- **Key points:** bullets
> callouts, only where one clearly earns its place
```

- **Bullets first.** A short paragraph only when an idea really needs connected reasoning.
- Skip any part that adds nothing. Most sections need no callout or just one.

### The callouts

| Callout | Use it for | Never for |
|---|---|---|
| `> **Example:**` | the lecturer's own worked example, with their numbers | your own examples |
| `> **Extra example:**` | a simple example of your own that makes the idea click | replacing a good lecturer example |
| `> **Analogy:**` | a technical or abstract idea that is hard to picture (an API as a waiter) | events, stories, history, anything already concrete |
| `> **Extra (beyond the lecture):**` | accurate background the lecturer did not say | anything uncertain |
| `> **Watch out:**` | a mistake learners commonly make about *this* topic, or a place the lecturer seems wrong (said politely); also when what is *shown* contradicts history | extra facts (those go in Extra) |
| `> **Quick check:**` | a technical skill a learner must apply: one question, the answer on the next line | history, news, stories, entertainment |
| `> **Shortcut:**` | a quick rule, memory trick or exam shortcut, when a real one exists | padding |
| `> **Quote:**` | a quote or key statement (see §10) | bullets |
| `> **Source:**` | a book, paper, film, document, website or cited person (see §11) | bullets |
| `> **Unclear:**` | a part that could not be made sense of | guessing |

---

## 6. Maths 🤖 + ⚙️

- **LaTeX only for real maths:** inline `$...$`, key equations on their own line `$$...$$`.
- Symbols are LaTeX commands (`\theta`, `\alpha`, `\Delta`, `\times`, `\le`…), **never spelled as words** inside maths. ⚙️ Spelled-out Greek names ("theta") inside maths are fixed free by code.
- **Maths contains only maths.** No sentences and no `\text{…}` explanations inside `$$…$$`: the words go in bullets. ⚙️ A section that still has sentences inside maths is rewritten by the Cheap AI (all such sections in one call).
- After every key equation a **"Where:" list defines every symbol**: symbol, meaning, unit.
- **No bare letter as shorthand** without a definition: spell the name once, then abbreviate ("revolute joint (R): a hinge that rotates").
- **A tiny numeric example for every formula.**
- **Step by step** (derivations, numericals): numbered steps, each with its reason ("expand", "use $\cos(90^\circ+\theta)=-\sin\theta$"), ending in a boxed result $\boxed{\dots}$. Never jump steps.
- These rules apply only to **technical** videos. A story, history or religion video gets no formulas, code, steps blocks or Quick check unless the lecture itself has them.

## 7. Code and algorithms 🤖 + ⚙️

- **Every code block is followed by `**Output:**` and a ```` ```text ```` block** with exactly what it prints. If it prints nothing, show the value it returns or the state it leaves ("list is now [1, 2, 3]"). ⚙️ A runnable block the writer left without output gets it from one Cheap-AI call.
- The lecturer's own code is kept **exactly as shown**. In a programming lecture, every extra example is short, runnable code with brief comments and the expected output.
- **Algorithm walkthroughs are executed, not written out.** For sorting (bubble, selection, insertion, merge, quick), binary / linear search, BFS, DFS, Dijkstra and linked-list reversal, the writer gives one ```` ```algo ```` block (JSON). The extension **runs the real algorithm** on that input and draws every step with a picture and a caption. ⚙️ Input is the lecturer's data, or 4–7 values (at most 7 nodes) that show the interesting cases.
- **Any other step-by-step process** (stacks, queues, hashing, number conversion, matrix steps): every phase is a ```` ```steps ```` block, one line per phase, cells separated by spaces, then `|` and what happened and why. Marks: `x*` processing, `x~` changed or swapped, `x!` finished, `_` empty, `# ` a caption.

---

## 8. Figures (frames) 🤖 + ⚙️

### What is allowed to be a figure
- **A frame shows only what it shows.** A description may use only the frame's own text, its caption, or what is visible in its attached picture. Never describe, name or interpret anything beyond that, never borrow from the speech to say what a picture contains, and never repeat in a sentence what the caption already says.
- **On-screen text is content:** a sign, headline, document title, stamp or date is used in the notes where it adds to the point.
- **Captions** describe only what is visible (written from the picture alone). With no vision model, the caption honestly says it is the narration at that moment.

### Two groups of frames for the Strong AI

| Group | What it is | How it reaches the notes |
|---|---|---|
| **A. The 10 best frames** | ranked highest; **attached as real pictures** | the writer puts a `[[FRAME:n]]` marker right after the bullet each one shows; an important one it forgets is added by code ⚙️ |
| **B. Every other kept frame** | only a text description | shown **only if the writer finds it necessary** (a map, chart, key scene or person, a statistic). Choosing none is fine. It lists its choices in **one compact line after the notes**: `<!--FIGS 12@2\|first words of the bullet;14@3-->` (frame @ topic, optional bullet words). The code places each one after the whole bullet, or at the end of the topic's points. ⚙️ |

### What is never left out ⚙️
Frames the system recognises as **code, table, formula, chart, diagram, schematic, map or patent drawing** are shown no matter what: placed where the writer put them, else under the topic being spoken at that time.

### How figures are balanced ⚙️
- **One picture per scene:** photos or scenes closer than 20 s inside one section are thinned (8 s for videos under 2 minutes). Charts, code, tables and maps are exempt.
- **Look-alikes are dropped** (nearly identical picture hash), except code and tables.
- **Every section gets a figure** when a fitting frame lies in its time range.
- End cards (credits, channel logo, "view full lesson") are never figures. Quote frames are never figures (§10).
- The figure cap is only a safety net: it never goes below the number of described frames, so it never overrules the writer.

### How frames are chosen before the writer sees them ⚙️
The code screens first (merge repeats and step-by-step build-ups, drop blank frames, skip plain text slides OCR already read, cap per hour, spread over the whole video). A vision AI then screens them at low quality in one call and describes the survivors in high quality. Its drops are **reviewed by code**: a repeat or an "unfinished" frame may only be dropped if it names a kept frame that replaces it; frames on screen 10 s or more are never "unfinished"; the longer-lasting copy of a repeat wins; title or unfinished frames still pass their readable text to the writer.

---

## 9. Nothing repeated, nothing wasted 🤖

- **State every fact once**, in the one place it fits best. Never restate names, credits, titles or facts already given. The Overview, the topics and the callouts must not echo each other.
- **Compact:** the shortest form that loses nothing. A **table beats prose** for a comparison, steps beat paragraphs, one line beats three.
- Short *and* complete beats long: keep every real detail, drop only repetition and filler.
- **Not a lesson?** (a song, music video, trailer, vlog, entertainment): no Quick check, no Analogy. Say what it is (credits once), what happens or what the lyrics say and mean, and the notable moments. If the audio could not be understood, say so in one short line.

---

## 10. Quotes: always their own callout 🤖 + ⚙️

- A quote or key statement **shown on screen or read aloud** goes into the notes in **its own callout**, separate from the other points: `> **Quote:** “the exact words” — who said it`.
- It is placed at the moment it appears. An **epigraph at the very start** goes first, right under the first heading.
- A quote is **never a bullet and never a figure**: its words are the content, not its picture.
- ⚙️ After the writer finishes, the code checks every on-screen quote: already a callout, it stays; buried in a bullet, it becomes a callout of its own (words kept, nothing repeated); missing, it is added where its time belongs.

## 11. Sources and references 🤖 + ⚙️

- Every **book, paper, article, film, document, website, or person cited as a source**, whether the speaker names it or the screen shows it (credits included), is noted **where it comes up** in its own callout: `> **Source:** *Title* — author (what it is and how the lecture uses it)`.
- The Transcript AI finds them in the speech and the on-screen text. Narration, music and animation credits are not sources; the lesson's author is.
- ⚙️ After the notes a **References section** is written: each source, and each on-screen quote, is web-searched; the Strong AI writes one bullet per source (what it is, why it matters here, where to read more, with a link only when a result clearly matches). It **never invents** a title, author, year or link, and says so if a source cannot be identified. The code adds any source the model left out, so the list is always complete.

---

## 12. Practice questions 🤖

- Written once, by the Strong AI, at the end, **only if the writer judged they fit** (not for songs, vlogs or news).
- **The writer decides what kind fits the video.** The question style follows the subject:

| Subject | Style |
|---|---|
| Maths | JEE Advanced / IIT end-semester / GATE level: numericals, proofs, derivations, conceptual traps |
| Physics | JEE Advanced / Olympiad level: numericals with units, "what happens if", derivations |
| Chemistry | JEE Advanced / NEET level: reactions, mechanisms, numericals, exceptions |
| Biology | NEET / university level: processes, cause and effect, case-based |
| Engineering | IIT end-semester / GATE level: numericals, design and apply, "find the error" |
| Code | LeetCode medium/hard and FAANG-interview problems plus concept questions |
| **Everything else** (history, religion, stories, literature, social science, business) | **understanding questions:** why and how, compare and contrast, cause and effect, apply to a new situation, interpret a scene or a quote, common misconceptions. **No numericals or formulas** unless the topic has them |

- **2–3 difficult but fair questions for every topic**, answerable from the lecture plus standard knowledge; never trivial recall, never a type that does not fit (no maths for a story, no coding for history).
- Layout: `### Topic`, then `**Q1.** …` and `**Answer:** …`.
- **Answers are complete and easy to follow:** step by step with a reason for each step and a boxed result for maths subjects; a few short bullets with the reasoning (not just the fact) for the others. An optional `Shortcut:` line when there is a faster way.
- **Coding problems:** the problem with constraints and one example, the idea first, clean runnable code, time and space complexity, and the **Output** of the example.
- Real exam styles found by a web search (kept only if they match the subject) set the level; a question the model cannot fully answer is never copied.

---

## 13. What the code guarantees, whatever the AI did ⚙️

| Guarantee | By |
|---|---|
| Notes in English only | the writer prompt + review step |
| Greek words in maths become LaTeX | free code fix |
| Sentences inside maths are rewritten | one batched Cheap-AI call |
| Every runnable code block has an Output | one Cheap-AI call for the missing ones |
| Algorithm walkthroughs are correct | the extension **runs** the algorithm |
| Code, tables, formulas, charts, diagrams and maps appear | forced into the notes |
| Every on-screen quote has its own callout | `ensureQuotes` |
| Every source is in the References section | `ensureRefList` |
| Section times match the transcript | `snapSectionTimes`, header never after its first figure |
| No stray markers or raw lists in the notes | marker clean-up |
| A cut-off reply is not silently accepted | retried once with twice the room, else a warning |
| A failed model never silently skips a stage | the job pauses; you switch the model or skip the stage |

---

## 14. Where each rule lives

| Rules | File |
|---|---|
| Voice, format, callouts, quotes, sources, code, steps, figures | `lib/prompts.js` (`STYLE`, `TECH`, `writePrompt`) |
| Maths rules | `lib/prompts.js` (`MATH_RULES`) and `lib/lint.js` |
| Question styles | `lib/prompts.js` (`QUESTION_STYLES`, `questionsPrompt`) |
| References | `lib/prompts.js` (`referencesPrompt`) and `lib/local-pipeline.js` (`collectRefs`, `ensureRefList`) |
| Figures: choosing, placing, balancing | `lib/local-pipeline.js` (`chooseFigures`, `applyFigs`, `balanceFigures`, `fixScreen`) |
| Quotes | `lib/local-pipeline.js` (`ensureQuotes`) |
| Algorithms | `lib/algoviz.js` |
