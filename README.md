<div align="center">

# 🎓 Vid2Study

### Turn any lecture video into **study notes you actually want to read**

*Local transcript, slide scanning and OCR, with configurable AI for the notes.*

<br>

![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)
![No build](https://img.shields.io/badge/build%20step-none-111111?style=for-the-badge)
![Local first](https://img.shields.io/badge/transcript%20·%20OCR%20·%20slides-run%20locally-2ea44f?style=for-the-badge)
![Tests](https://img.shields.io/badge/npm%20test-22%20suites-brightgreen?style=for-the-badge)
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
| 🖨 **Takes it with you** | Copy the notes, download an offline ZIP, or print a PDF with a separate clickable contents page and linked practice-answer references. |

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
3. **Slide scan.** The video is sampled every ~2 s (every 2nd sample first, the ones between only where something changed). A learned **motion mask** ignores the presenter's camera box, and the best moment of each scene is picked (still, sharp, fully drawn in).
4. **OCR and a no-AI classifier.** Tesseract reads each frame; edge and layout analysis flags code, tables, diagrams and formulas.
5. **Code screening.** Repeats and step-by-step build-ups are merged, blank frames dropped, plain text slides OCR already read skip the AI, and the rest is capped per hour, spread over the whole video.
6. **Transcript AI.** One model reads the whole transcript (plus six frames from start to end) and returns a **brief**, a detailed **timeline**, the **video type** (technical or not) and every **source** mentioned.
7. **Vision, in very few calls.** *Call 1* looks at **all** candidate frames at low quality in one request (thousands fit) and drops repeats, blur, titles and half-drawn animation states. A code check rescues any drop that names no replacement. *Calls 2* (at most two) look at the survivors in high quality, with the transcript timeline, and rank and describe each in lossless detail. Every image is labelled in three ways (a text line, the id printed on the picture, the prompt list) so captions can never slip onto a neighbouring frame.
8. **Write.** Up to 60 minutes the **Strong AI** writes everything in one pass; longer lectures it reads the full transcript in 2–3 parts. The ten best frames are attached as **pictures**; every other frame is offered as a description, and it adds one only if it finds it necessary, in one compact line the code places.
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
- **Results page.** Copy text or download an offline **Bundle .zip**. **Print** saves a PDF in the Lectures downloads folder through the local bridge. **Preview** opens the full notes in a browser tab and can also be printed with Ctrl+P.
- **Practice questions.** Generate a practice paper from the finished notes, with optional assignment text or screenshots.
- **Activity log.** Use **Show logs** in the toolbar menu. Running jobs show their latest log line and step progress in the Lectures list, including combined summaries.
- **Storage cleanup.** In **Saved notes**, **Clear processing files** clears activity logs, debug dumps, transcripts, drafts, and unused frames. Check **Also remove figures from saved notes** to remove embedded figures as well. Finished note text and files you previously downloaded are kept.

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
- **Print cannot connect to the bridge.** Start or restart the local bridge and try again. **Preview** remains available for browser printing. When an equation cannot be typeset, the export flags it in place and **Copy text** includes the original LaTeX.

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
├─ pager.html               isolated print renderer
├─ lib/
│  ├─ local-pipeline.js     ⭐ the main pipeline (resumable, pauses on model failure)
│  ├─ prompts.js            every prompt
│  ├─ scan.js · scenes.js   slide scan, scene detector, motion mask
│  ├─ ocr.js · framekind.js OCR and the no-AI frame classifier
│  ├─ asr.js · stt.js       Whisper in the browser, cloud speech-to-text
│  ├─ llm.js                Gemini / OpenAI-compatible / Anthropic / bridge providers
│  ├─ algoviz.js            runs real algorithms and draws every step
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
