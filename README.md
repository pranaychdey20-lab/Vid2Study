<div align="center">

# 🎓 Vid2Study

### Turn any lecture video into **study notes you actually want to read**

*Local transcript, slide scanning and OCR, with configurable AI for the notes.*

<br>

![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)
![No build](https://img.shields.io/badge/build%20step-none-111111?style=for-the-badge)
![Local first](https://img.shields.io/badge/transcript%20·%20OCR%20·%20slides-run%20locally-2ea44f?style=for-the-badge)
![Tests](https://img.shields.io/badge/npm%20test-33%20suites-brightgreen?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge)
![Providers](https://img.shields.io/badge/AI-Gemini%20·%20OpenAI--compatible%20·%20Anthropic%20·%20Codex%20CLI%20·%20Claude%20CLI-8A2BE2?style=for-the-badge)

**[✨ What you get](#-what-you-get)** · **[🧠 How it works](#-how-it-works)** · **[🎭 Who does what](#-who-does-what-cheap-vs-strong)** · **[🚀 Install](#-install-in-2-minutes)** · **[🖱 Using it](#-using-it)** · **[🔒 Privacy](#-privacy-and-safety)**

</div>

---

## ✨ What you get

Turn a lecture into study notes with plain-English explanations, typeset equations, slide figures, references, and worked practice questions. The lecture transcript and slides ground the main notes.

| | |
|---|---|
| 🧾 **Easy first** | An **Explanation** box sits directly below a term or slide bullet the lecture mentions without elaborating. **Extra Context** boxes label material beyond the lecture. |
| ➗ **Real maths** | Every formula is LaTeX (KaTeX, bundled). Derivations are solved step by step with the reason for each step, and each symbol is defined. |
| 💻 **Code that runs** | Every code block is followed by its **Output**. Algorithms (sorting, searching, BFS/DFS, Dijkstra…) are *executed* and drawn phase by phase. |
| 🖼 **Figures in the right place** | Diagrams, charts, tables, code and formulas are never dropped. Other frames appear only when the writer decides the notes need them. |
| 💬 **Quotes, kept apart** | Slide definitions and quotations can appear in labelled callouts. The extension checks verbatim excerpts against the captured OCR. |
| 📚 **Sources and references** | Books, papers, films, documents and cited people are noted where they come up and collected in a **References** section, with background found by a web search. |
| 🧠 **Practice questions that fit** | Pick a dedicated **Practice Paper AI** for lecture-grounded questions and worked answers with references back to the notes. |
| 📦 **Bulk notes** | On a university LMS course page, tick a whole week (or "Without notes") and queue every lecture at once. |
| 🛟 **Never loses your work** | Everything is saved as it goes. If a model fails the job **pauses**, you pick another model, and it resumes from where it stopped. |
| 🔮 **The orb: ask or edit** | A small glowing orb opens an assistant that knows the **whole lecture**. **Ask** questions with clickable section citations, or switch to **Edit notes** and describe a change: it proposes edits you read, preview and approve one by one, with undo and redo. |
| 🧪 **Interactive examples, almost free** | Where the lecture lacks a clear example, the AI sends a *type and a few parameters* (about 25 tokens). Vid2Study already knows how to draw ~45 kinds: charts, matrices, vectors, circuits, sliders, quizzes. No generated code ever runs. |
| 🎨 **Restyle it with a sentence** | Choose **UI changes** in the assistant and say *"dark mode, serif font, make the orb spin when I hover it"*. Colours, type, layout, the orb icon and animations all change. You try it first, then keep or revert. |
| ✏️ **Edit by hand too** | **Edit notes** lets you rewrite any section and move or remove figures for alignment, with the same undo and redo. |
| 🖨 **Takes it with you** | Copy notes, save a PDF with clickable contents and practice-answer references, or save interactive HTML as a standalone file or in a searchable offline library: one master page, subject covers, a search box and a sandboxed reader. |

---

## 🧠 How it works

The browser handles slide scanning, OCR, and local transcription. The models you select help describe the slides, write the notes, and create practice questions.

```mermaid
flowchart LR
    V([🎬 Video / YouTube / file]) --> T["🗣 Transcript<br/>captions · Whisper in the browser · cloud STT"]
    V --> S["🔎 Slide scan + OCR<br/>coarse + refine · camera-box mask · no AI"]
    S --> CS["🧹 Code screening<br/>merge repeats · skip text-only slides · cap per hour"]
    T --> TA["📝 Transcript AI<br/>brief · timeline · video type · sources"]
    CS --> V1["👁 Vision call 1<br/>all frames, low quality:<br/>drop repeats, keep what matters"]
    TA -. brief .-> V1
    V1 --> V2["👁 Vision calls 2<br/>survivors in high quality:<br/>rank + describe losslessly"]
    TA -. timeline .-> V2
    T --> W
    V2 --> W["✍️ Strong AI writes the notes<br/>10 best frames attached as pictures"]
    W --> P["🧽 Cheap AI polish<br/>maths · overview · code outputs"]
    P --> R["📚 References + 💬 Quotes<br/>from lecture sources"]
    R --> Q["🎯 Practice Paper AI<br/>lecture-grounded questions and answers"]
    Q --> N([📄 Notes: web page · zip · PDF])
```

<details>
<summary><b>🔬 The stages in detail</b></summary>

<br>

1. **Transcript.** Page captions or a `.vtt`/`.srt` when they exist. Otherwise the audio is transcribed: **Whisper in the browser** (free, private, slow on very long audio) or an optional **cloud speech-to-text** model (Groq, OpenAI or any OpenAI-compatible `/audio/transcriptions`). Large MP4/M4A/WAV files are read piece by piece with flat memory, so a 12-hour file is fine. YouTube captions come from the page's own player, then `yt-dlp` in the bridge, then audio download.
2. **Trim, losslessly.** Fillers, stutters, sound tags and recognition loops are removed by code; timestamps stay. A transcript still longer than ~3 hours is also tightened by the Cheap AI, which may only drop repetition.
3. **Slide scan.** The extension reads every scheduled sample and saves one sharp capture per detected scene change. A motion mask helps ignore the presenter’s camera box. The sampling interval still affects whether a briefly shown slide is captured.
4. **OCR and a no-AI classifier.** Tesseract reads each frame; edge and layout analysis flags code, tables, diagrams and formulas.
5. **Deduplication.** The extension checks both the picture and OCR before merging slides that share text. Distinct captures keep their evidence through the writing stage.
6. **Transcript AI.** The model reads the transcript and sampled frames to build a brief, a timeline, a coverage checklist and the source list.
7. **Vision review.** With Vision AI enabled, all distinct, nonblank captures reach review in batches. The first pass ranks them. The detailed pass preserves their teaching content and identifies whether a screenshot adds information beyond text, math, code or a table.
8. **Write.** The data goes in as a **`.txt` attachment** (transcript, OCR, frame descriptions, sources) and only the rules travel as chat text. The Strong AI gets OCR and visual descriptions along with the transcript or chunk notes. If a reply is cut at the output limit, it is **continued in the same conversation** without resending anything, then stitched together. The notes come back as one Markdown file. The highest-ranked pictures are attached within the provider’s image limits. The extension checks for empty sections and uncovered items, puts figures within their relevant topic and source video, and omits a screenshot when the writer and vision review agree its content is reproduced in the notes.
9. **Finish.** The Cheap AI can polish equations, the overview, and code outputs. The extension assembles the references and figures, adds practice questions if enabled, and records which model actually wrote each part after any fallback.

</details>

---

## 🎭 Who does what (cheap vs strong)

Slots can use **any provider and model**. Empty slots fall back sensibly, so you can start with one key and refine later.

| Slot | Job | Good choices | If empty |
|---|---|---|---|
| ✍️ **Strong AI** *(+ one fallback)* | Writes the notes and References section | a top-tier model (Claude Sonnet, Gemini Pro/"neon"…) | required |
| 🪙 **Cheap AI** *(+ any number of fallbacks)* | Trims very long transcripts, fixes maths, writes the overview, predicts code outputs | Gemini Flash-Lite, Haiku, a local Ollama model | the Strong AI |
| 👁 **Vision AI** | Screens and describes frames (many images per call) | Gemini Flash-Lite (takes thousands of images) | the Cheap AI |
| 📝 **Transcript AI** | Brief, timeline, video type and sources from the transcript + 6 frames | a cheap long-context model | the Cheap AI |
| 🎯 **Practice Paper AI** | Writes lecture-grounded questions and worked answers | a model that accepts the transcript and slide images | the Strong AI |
| 🎙 **Speech-to-text** | Transcribes audio when there are no captions | Groq `whisper-large-v3-turbo` | Whisper on your computer |

The **Cheap AI is a pool**: if one model fails (rate limit, quota, outage) the next one answers, in the order you list them. The **Strong AI** is a pool of two. A model that answers 401/403/404 is skipped for the rest of the run, and the job only pauses when every model in a pool has failed.

---

## 📝 What the notes look like

The PDF starts with a contents section containing learning outcomes and a clickable lecture roadmap. Sections use slide excerpts, figures, tables, and typeset equations. Long tables can continue across A4 pages, and practice answers can link to a numbered section and its PDF page.

```markdown
### Gear Types and Mechanical Power Transmission (07:20)

- Backlash can affect positioning when the gearbox reverses direction.

> **Explanation:** Backlash is the small amount of play between meshing teeth.
> When the gears reverse, the driving tooth crosses that gap before it starts pushing again.
```

The writer adds an **Explanation** box immediately after an item the lecture leaves unexplained. **Extra Context** labels related material beyond the lecture.

---

## 🚀 Install in 2 minutes

1. **Get the code** and keep the folder somewhere permanent (Chrome loads it from there):
   ```bash
   git clone https://github.com/pranaychdey20-lab/Vid2Study.git
   ```
2. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, and choose the folder that contains `manifest.json`.
3. Click the toolbar icon → **Options** → **AI providers**. Add a provider and enter its API key, or follow the local bridge setup below for subscription sign-ins.
4. Pick a **Strong AI** model and set the other roles as needed, including **Practice Paper AI** if you want a separate question writer. Options save automatically. Each Cheap AI fallback has a model list for its own provider.
5. *(Optional)* In the extension's **Details**, turn on **Allow access to file URLs** so saved lectures are reused instead of fetched again.

> 💡 **Cheapest good start:** Strong = a strong writer, everything else on one Gemini Flash-Lite key. Leave Cheap/Vision/Transcript empty and they all follow the Cheap AI.

<details>
<summary><b>🔌 Use your subscriptions instead of API keys: the local bridge (optional)</b></summary>

<br>

The local bridge in [`bridge/`](bridge) connects Vid2Study to browser sessions and CLIs. It needs Node.js 18 or newer.

| Provider | Sign-in |
|---|---|
| **Gemini web** | Sign in with Google in the bridge’s dedicated Chrome profile. The bridge refreshes its session from that profile. |
| **ChatGPT (Codex CLI)** | Use **Sign in to ChatGPT** in Options or run `codex login`. The optional shared-profile button opens device-code verification in Gemini’s Chrome profile. Enable device-code sign-in in ChatGPT first. Codex saves its own CLI session and uses your plan’s Codex limits. |
| **Claude CLI** | Use **Sign in to Claude** in Options or run `claude auth login`. Claude Code saves its own CLI session. |

1. On Windows, run `bridge/Start-Bridge.cmd` once to set up the bridge and register automatic startup. Options can start it on demand after setup. On other systems, run `npm install` and `npm start` in `bridge/` to start it manually.
2. Open **Options → Local helper**. A green dot means connected. A red dot means the provider needs attention and its sign-in button is available. Grey means the bridge could not check the session.
3. In **Options → Add provider**, choose your bridge provider and assign it to a model role. On manual setup, use the token printed by the bridge in the provider’s **Bridge token** field.
4. After updating files in `bridge/`, restart the bridge once so it loads the changes. After updating extension files, reload Vid2Study in `chrome://extensions`.

Install Codex CLI with `npm install -g @openai/codex` if needed. A model ID such as `gpt-6.2-sol:high` sets the reasoning level for that role. Set `CODEX_BIN` before starting the bridge if it needs an explicit path to your Codex executable.

The bridge listens on localhost. Keep `bridge/token.txt`, the browser profiles, and the session files private. Git ignores those local files.

</details>

---

## 🖱 Using it

- **Sites.** The extension only runs on sites you enable (defaults: the university LMS it was built with, and YouTube; add your own in Options → Sites). Use the toolbar icon → *Enable on this site*, or *Scan this page now* for a one-off.
- **The NOTES button.** Any page with a video gets a small button, bottom right: **DOWNLOAD**, **SUMMARIZE**, **CAPTIONS**.
- **📚 Lectures drawer (university LMS).** Open a course page and click **LECTURES**. Every lecture is grouped by module and chapter. Tick a **whole week** with one click, or press **Without notes** to select everything not yet summarised, then **Summarize selected (N)**. They run one after another; a failure never stops the rest, and the queue survives a restart.
- **From a file.** *Options → Summarize from a file…* takes a video or audio file (and an optional `.vtt`/`.srt`).
- **YouTube.** The transcript is found without listening whenever possible (the page's player, then `yt-dlp`). Figures come from the video itself, and link back with "Watch at".
- **Results page.** The notes open with the toolbar on top and the **orb** in the corner. There is no separate preview step: it is the same page, so equations, interactive examples and the assistant are all there already. Click the orb to **Ask** (answers cite sections as links) or **Edit notes** (proposed edits you approve one by one; undo and redo; your hand edits and the assistant's share one history). **Ask** is a normal chatbot: talk about anything, in the notes or not, and it writes as much as the answer needs, with **interactive illustrations** drawn right in the chat (including before/after pictures of image-processing steps). Pick how much of the lecture it reads: **Smart context** (the outline plus only the sections it needs, the default), **Section in view**, **Whole lecture**, **No notes (general chat)** (sends nothing from the notes), **Quoted text** (appears only while you have a quote, and is picked for you), or **UI changes**. With web search on, it searches for current sources and names them. The panel docks beside the notes or floats; drag it, resize it, close it.
- **Quote in assistant.** Select any text in the notes, a sentence, a bullet, a formula, and a **Quote in assistant** button pops up beside it, just like replying to a selection in Claude. Click it and the quote lands above the text box with its section label; add up to three. The assistant gets your exact words plus that section in full, so you never retype a passage, and in **Edit notes** it changes the paragraph you quoted.
- **Edit notes (by hand).** The toolbar's **Edit notes** button turns every section into editable text and puts **↑ ↓ Remove** on each figure, so you can fix wording and move frames until they sit where they should.
- **Save as HTML.** Save one self-contained lecture or choose a folder for the local library. Open **Vid2Study.html** in that folder to browse it. In a library, every lecture shares **one** copy of the visual code (`.vid2study/visuals.js`) instead of carrying its own, so 50 lectures cost about 100 KB, not 5 MB. Equations, saved lecture images and visual examples work offline. The assistant runs from the extension page.
- **The library, with the assistant.** Click **Library** in the toolbar pop-up (or **Open library with the assistant** in the Save as HTML box), pick your library folder once, and your shelf opens inside Vid2Study. Read any lecture there with the **same orb**: Ask, Edit notes, Quote, UI changes, with the same API, CLI and Gemini web models from Options. Approved edits are written back to the lecture's file in the folder a few seconds later. The reader has the same **Edit notes**, **Fix formatting** and **Generate practice paper** tools as the saved-notes page, a **Full screen** button (the assistant stays with you), **zoom** (− / + / reset, or Ctrl + scroll over the notes) with a **Wide** switch for the whole window width, and your **Saved notes** in their own section. The page fills the browser as a dark dashboard (a rotating stack of subject covers, a lecture table with subject tabs, a sliding sidebar, animated rows, scroll bars you can actually see) with a matching light mode. A double-clicked `Vid2Study.html` looks the same and stays a plain offline reader (a file on disk cannot see your keys or reach the bridge); its **Open with the assistant** button copies this page's address for you to paste into the address bar. **Saved notes** and the **library** are separate on purpose: a lecture shows up on the shelf only after you add it with Save as HTML.
- **Save as PDF.** The local bridge creates the PDF and the browser asks where to save it. Interactive examples print at their saved defaults. You can also use Ctrl+P from the results page.
- **Visual examples.** The writer and the assistant describe an example as a *type plus parameters* and the renderer does the rest: validation, the maths, the SVG and the sliders. About 45 types cover pixel grids and histograms, brightness / gamma / convolution / filters, matrices and kernels, function and surface plots, vectors and free-body diagrams, robot arms, circuits and control blocks, statistics (bar, line, scatter, box, distributions), flowcharts, timelines, comparisons, steppers and quizzes. A slide frame is skipped only when a visual redraws it and the frame holds no photo, handwriting or scene the code could not draw. Model-generated scripts are never run.
- **Practice questions.** Generate a practice paper from the finished notes, with optional assignment text or screenshots. The paper includes worked solutions for matching assignment questions. Generating again adds a new paper to the saved notes.
- **Fix formatting.** Repair common Markdown and LaTeX problems in saved notes: formulas stuck in code spans, bracket formulas in the middle of a sentence, double-escaped commands, broken `$…$` pairs, and more. A formula that starts with a digit, like `$1/(MN)$`, now renders as maths instead of being read as a price. If local repair leaves items for review, you can choose whether to send them to the Cheap AI.
- **Activity log.** Use **Show logs** in the toolbar menu. Running jobs show their latest log line and step progress in the Lectures list, including combined summaries.
- **Storage cleanup.** In **Saved notes**, **Clear processing files** clears activity logs, debug dumps, transcripts, drafts, and unused frames. Check **Also remove figures from saved notes** to remove embedded figures as well. Finished note text and files you previously downloaded are kept.

---

## 🎨 Make it yours: UI changes

Open the orb, switch the dropdown to **UI changes**, and describe the look. It sends only your sentence and your current look (never the notes), so it is cheap. The reply is a small piece of data, **not code**: Vid2Study checks every field against closed lists, shows you the result as a **trial**, and keeps it only when you press **Keep this look**. Nothing touches the backend, your notes or your saved lectures.

| You can change | Examples |
|---|---|
| 🌗 **Mode** | light, dark, or follow the system |
| 🎨 **Colours** | accent, page, text, lines, code and table background, toolbar |
| 🔤 **Type** | serif, sans, rounded, slab, handwriting… plus size and line height |
| 📐 **Layout** | reading width, corner roundness, spacing, heading style (bar, underline, side line, boxed) |
| 🔮 **The orb** | a preset (dragon ball, star, spark, bolt, flame, heart, bulb, planet, book, atom), **any emoji**, or a drawing the AI makes itself; size, glow colour, which corner |
| ✨ **Motion** | spin, pulse, bounce, float, wiggle, shake, tilt, beat, fade, rise, slide, glow, shimmer, flip, swing: on hover, always, or once on load |
| 🧩 **Any part** | headings, figures, tables, code, quotes, formulas, links, toolbar, buttons, the assistant panel, with their hover states |

Ideas to try: *"make the orb spin when I hover it"* · *"a glowing owl orb in the bottom left"* · *"calm dark mode, serif text, headings with a coloured side line"* · *"figures lift and get a shadow on hover"* · *"reset the look"*.

🔒 **Why it is safe:** colours must be hex, values may not contain `url()`, braces or quotes, drawings are rebuilt from a whitelist of shapes (no text, images, links, scripts or styles), and motion respects your system's reduced-motion setting. Saved looks are checked again every time they load.

---

## 🧪 Tests

No dependencies, no browser:

```bash
npm test
```

It runs the pure logic (chunking, alignment, scene detection, the frame classifier, the dedup rules, the screening review, figure placement, quotes and references, model pools, the MP4 audio reader, cloud transcription) and the **whole pipeline end to end with a fake AI**. What it can't cover (Whisper, Tesseract, canvas, WebCodecs, the real provider APIs) is listed in [`CLAUDE.md`](CLAUDE.md), which is also the contributor guide.

---

## 🔒 Privacy and safety

- API keys live in `chrome.storage.local` and go only to their own provider, in a header. They are never logged.
- Transcription, slide detection and OCR run **on your computer**. The local pipeline sends text and selected frames to the providers configured for each role. Cloud speech-to-text can receive audio. The legacy Gemini video engine can upload video.
- `host_permissions` is `<all_urls>` because videos live on many hosts and AI endpoints are configurable. The content script only runs on sites you enable.
- It never tries to break DRM, and only downloads direct files you can already play. Use it for personal study and follow your institution's and the video site's rules.

---

## 🩺 Troubleshooting

<details>
<summary><b>Common problems</b></summary>

<br>

- **No NOTES button.** The site isn't enabled: toolbar icon → *Enable on this site*, then reload.
- **"Add an API key…" / "Choose a … model".** Fix it in Options; the page opens by itself.
- **Model list stays empty.** Check the key and URL (OpenAI-compatible URLs usually end in `/v1`); the status line under the provider shows the error.
- **A model failed mid-run.** The job pauses; a window lets you switch the model or skip the stage, then it continues from the saved draft.
- **"Failed to fetch" with a bridge provider.** The bridge isn't running (or was restarted): start it, or use *Start bridge* in Options.
- **Gemini web is taking a while.** The job shows when the bridge is uploading images, waiting for answer text, or receiving the answer. Higher reasoning settings can take longer.
- **Frames look wrong or missing.** While the testing option *Save a debug dump* is on, the results page has a **Debug dump** button: every frame shows whether the code merged it, which AI call kept or dropped it, and why.
- **"Could not download the video (HTTP 403)".** The link expired or the Referer check failed: reload the lecture page.
- **Save as PDF cannot connect to the bridge.** Start or restart the local bridge and try again. **Preview** remains available for browser printing. When an equation cannot be typeset, the export flags it in place and **Copy text** includes the original LaTeX.

</details>

---

## 🗂 Project map

```
Vid2Study/
├─ manifest.json            MV3 manifest (no build step, plain ES modules)
├─ background.js            service worker: job queue, site registration, Referer rules
├─ offscreen.js             hidden worker page that runs a job
├─ content.js + adapters/   the floating UI and per-site code (university LMS, YouTube, generic)
├─ options.* · results.*    settings and the notes viewer / export
├─ assistant.css            the orb and the assistant panel
├─ library-open.*           the library inside the extension, with the assistant
├─ pager.html               isolated print renderer
├─ lib/
│  ├─ local-pipeline.js     ⭐ the main pipeline (resumable, pauses on model failure)
│  ├─ prompts.js            every prompt
│  ├─ scan.js · scenes.js   slide scan, scene detector, motion mask
│  ├─ ocr.js · framekind.js OCR and the no-AI frame classifier
│  ├─ asr.js · stt.js       Whisper in the browser, cloud speech-to-text
│  ├─ llm.js                Gemini / OpenAI-compatible / Anthropic / bridge providers
│  ├─ algoviz.js            runs real algorithms and draws every step
│  ├─ textbook-visuals.js   ~45 interactive example types from small parameter blocks
│  ├─ textbook-assistant.js the orb: ask, edit notes, UI changes
│  ├─ ui-theme.js           validated look patches → CSS (colours, type, orb, motion)
│  ├─ notes-edit.js · notes-store.js · notes-editor.js   edit scripts, undo / redo, hand editing
│  ├─ md-parts.js           continues and stitches cut-off replies
│  ├─ library-page.js       the master Vid2Study.html (markup + styles)
│  ├─ library-ui.js         the shelf script: ONE copy, used by the folder and by the extension
│  ├─ notes-view.js         opens a lecture, draws it, attaches editor + assistant: shared by results and library
│  ├─ notes-tools.js        Fix formatting + practice paper, shared by results and library
│  ├─ standalone-html.js    one lecture as a self-contained page (save, PDF, keeping the library file in step)
│  ├─ library-handle.js     remembers your library folder
│  └─ vendor/               Whisper (transformers.js), ONNX runtime, Tesseract, KaTeX
├─ bridge/                  Codex CLI, Claude CLI, Gemini web, and yt-dlp
└─ tests/                   `npm test`: pure logic + the pipeline with a fake AI
```

---

## 📄 License

[MIT](LICENSE) © 2026 pranaychdey20-lab. Free to use, change and share; keep the license notice.

---

<div align="center">

**Built for students who would rather understand a lecture than transcribe it.** 🎓

<sub>Personal-study tool · Chrome MV3 · plain JavaScript · made with a lot of lecture videos</sub>

</div>
