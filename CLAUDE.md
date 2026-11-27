# Vid2Study: project guide for Claude

Chrome MV3 extension (v3.0, **no build step, no bundler**, plain ES modules). It turns lecture videos
(LMS files, YouTube, local files, captions) into study notes. The extension root is THIS folder; load it
unpacked. `README.md` is the user-facing doc. Read this file first and open only the module you need.

## The one idea
Heavy work is done **locally with algorithms**; AI only **writes** the notes. Never send a whole video to an AI
(that was the old Gemini pipeline, still present as `engine: 'gemini'`, rarely touched).

```
captions (page / .vtt)  ─┐
else audio -> Whisper    ─┴-> segments {start,end,text}
video -> sample grid every ~2 s (YouTube ~1 s, <= 600). Seekable video: COARSE + REFINE (`scanRefine`, default 2:
      read every 2nd sample, fill in the ones between where the picture changed AND the interval after a change;
      1 = every sample). MotionMask learns the presenter's camera box and ignores it. -> scene change? ->
      keyframe = the scene's SETTLED moment (pickSettled; f.t = scene start, f.shot = picture time) -> OCR (+conf)
      -> classify frame: code | table | diagram | formula | text     (no AI)
mergeRepeats (no AI): text rules always (Jaccard, words contained >= 0.85, flip-backs of text slides). Picture rules
      (ink grid build-ups / subsets / flip-backs, drawing hashes) ONLY for technical videos (`boards`), after the video-type step:
      they can wrongly merge two different illustrations
TRANSCRIPT AI (3c, [TASK:DIGEST], slot `digest`, stage 'digest', ALWAYS used when the video has frames; empty slot = the Cheap pool; the old
  `classify` slot was merged into it, `normalizeSettings` migrates it): reads the whole trimmed transcript in parts of <= 60 min and returns
  (1) a BRIEF (-> the SCREEN call), (2) a TIMELINE = shortened but detailed transcript with timestamps (-> the DESCRIBE calls),
  (3) in its FIRST call only, with up to 6 frames spread from start to end, the video TYPE (technical or not, kind, subject: parseDigest /
  readClassify -> draft.technical, draft.videoKind), which decides prompts and frame weights. Cached in draft.digest. The writer never sees it.
VISION = TWO BIG CALLS (not per-batch judging; needsVision / MAX_SELECT are legacy):
  CODE SCREENING FIRST (no AI, `needsVision` + `capCandidates` + `codeRank`): distinct frames only (mergeRepeats), blank frames
      never go, plain typed text slides OCR read fully skip the AI (technical videos), then at most `screenInPerHour` (default 300)
      per hour, spread over the whole video in equal time slices (the best-ranked of each slice stays, flagged frames win).
      Frames cut by the cap are marked dropped and their copies deleted. Only the rest go to the screening AI.
      Ties in the cap go to the frame that stays on screen LONGEST (`f.dwell` = time to the next distinct screen): the finished
      state of an animation stays, a half-drawn one is gone in a second or two. The prompts / labels show "(on screen ~N s)"
      (`onScreen`), and SCREEN drops half-drawn animation states and decorative opening artwork.
  EVERY IMAGE IN A VISION REQUEST IS IDENTIFIED THREE WAYS (a model given hundreds of pictures slipped captions onto the
      neighbouring frame): a text part "Fn at mm:ss:" right before it (`label` on the image in lib/llm.js), the id printed in its
      top-left corner (`jpegB64(..., tag)`), and the list in the prompt (`ID_RULE`).
  SCREENING REVIEW (`fixScreen`, code, after every SCREEN reply): the reply's `drop` is "F20:dup>F19 F29:unfinished>F31 F5:blur" (`readScreen`
      -> drop / into). dup / unfinished drops are accepted ONLY with a kept replacement close in time (30 s / 60 s) and a similar picture
      (hash <= 30 bits); otherwise the frame is RESCUED. "Unfinished" on a frame that stays 10 s+ is rescued; a later, longer-lasting copy
      swaps with an earlier short-lived kept one. Hard reasons (blur, transition, title, logo, credits...) are left alone.
  DROPPED FRAMES' TEXT: OCR text (conf >= 60, not the first 6 s / last 30 s) of frames dropped as title / unfinished still reaches the writer
      as an "ON SCREEN (no figure: ...) text: ..." line (chunk.extra); repeats, blur, logos, credits do not.
  KIND "quote" (epigraph / key statement; synonyms quotation, citation, saying...): its WORDS matter, not its picture. A kept quote frame
      is TEXT-ONLY: not offered as a figure, not sent to the writer as a picture, but passed as "[mm:ss] ON SCREEN (quote) text: ..." (chunk.extra).
      The writer prompt has a QUOTES rule (own `> **Quote:** “words” — author` callout, never a bullet, never a figure), and `ensureQuotes`
      (code, before the figure stage) GUARANTEES it: a missing quote is added at its time (an epigraph right under the first heading), one the
      writer buried in a bullet becomes a callout of its own (`splitQuote`, `quoteKeys`). STORY_WEIGHT slide 8, document 8: other text slides
      (a statistic, a date caption) still rank as content in a story video.
  REFERENCES (`researchReferences`, default on): quotes, books, papers, films, documents, cited people, websites. The Transcript AI
      (also run for text-only videos when this is on) returns a `=== REFERENCES ===` JSON list per part (`readRefs`) from the transcript AND the
      on-screen OCR text (`onScreenFor`, e.g. credits) -> `draft.refs` (`collectRefs`, deduped, time order). The writer gets the ones in its part
      ("SOURCES FOUND IN THIS VIDEO", `partRefs`) and writes a `> **Source:**` callout where each comes up. Stage 6c: each source + each on-screen
      quote is web-searched by the extension (`refQuery`, cached in draft.refWeb; or the model's own search), the Strong model writes ONE
      `## References` section ([TASK:REFERENCES], stage 'references', skippable), and `ensureRefList` adds any source the model left out, so the list
      is always complete. The section sits after "Detailed notes", before the practice questions. Quotes keep their inline callout too.
  TWO GROUPS OF FRAMES FOR THE STRONG AI (never mix them up): (A) the top `writerImages` (10) by priority are ATTACHED as pictures
      (`toWriter`, `pictureSet`) and work as always: the writer puts inline `[[FRAME:n]]` markers, and an important one it leaves out is still
      added by the code (`important`). (B) every OTHER kept frame is an EXTRA, offered only through its ON SCREEN description: shown ONLY IF the
      writer finds it necessary, listed in ONE compact line after the notes, `<!--FIGS 12@2|first words of the bullet;14@3-->` (frame @ topic
      number, optional bullet words; `takeFigs` reads it, `applyFigs` turns each entry into a `[[FRAME:n]]` marker in its topic, after the whole
      bullet or at the end of the topic's points before its first callout). An extra is forced only for code / table / formula / chart / diagram /
      map kinds (`ALWAYS_SHOWN`). The figure cap (`totalFrames`) is a safety net: at least the number of kept frames, so it never overrules the
      writer. With no attached pictures the old rule (inline markers for every frame) applies.
  CALL 1 [TASK:SCREEN] (vision slot, stage 'select'): the code-screened frames as 512 px JPEGs (`screenImages` per request,
      ~85 MB Gemini / 17 MB others: `packByBudget`), with the Transcript AI brief, no timeline. It drops blur / transitions / titles / talking heads / REPEATS and keeps
      at most `screenKeepPerHour` per hour, labelled (kind, info, label): `readScreen`. Rejected frames' full-size copies are
      deleted (deleteFrame). Different people / deities / places are never duplicates (prompt + `readVerdicts` checks `same_as`).
  CALL 2 [TASK:DESCRIBE] (vision slot, stage 'describe'): survivors at 1280 px (re-encoded smaller if a request would exceed
      ~14 MB), `describeCalls(n)` = 1-2 calls (`splitEven`, consecutive time ranges, no cap on frames), EVERY call gets the same
      Transcript AI timeline (> 350k tokens is thinned by `fitTranscript`) and frames with their times. Returns rank (info 0-10),
      caption, text, lossless `detail` in the context of the talk (-> draft.vis). The WRITER always gets the raw trimmed transcript.
  Then: top `writerImages` frames by priority go to the strong model as pictures, the rest as their descriptions
  (the writer may place any [[FRAME:n]]). Unknown kinds (artwork, statue, deity...) map to "illustration", never a reason to drop.
align frames to transcript by timestamp -> chunk ~12 min
<= 60 min : strong model writes everything from the aligned text
 > 60 min : `writeFullTranscript` (default): strong model reads the FULL aligned text in partsFor(min) parts
            (2 up to 2 h, 3 up to 3 h), written in parallel (pool 3). Off: cheap bullets per chunk (map) + reduce.
TEMP DEBUG (`debugDump`, delete after testing): `gen()` wrapper + `mark()` record every AI call / step in draft.dbg;
  result.debug = plain-text dump (settings, raw + trimmed transcript, every frame's verdict, web, calls), "Debug dump"
  button in results.html. Search "TEMP DEBUG" to remove it.
bulk notes: the LMS lectures drawer (content.js, adapters/iitg.js): per-week checkbox (modchk), "Without notes", "Summarize selected (N)" -> ENQUEUE;
  the queue runs one job at a time and moves on past a paused one.
cheap model: math fixes (ALL broken sections in one [TASK:FIXMATH] call, fixMathBatchPrompt / readMathBatch), overview, code outputs. strong model: writing + PRACTICE QUESTIONS (`practiceQuestions`,
  [TASK:QUESTIONS], IIT/GATE or LeetCode level with worked answers, web hints via `practiceContext`)
guaranteed figures: every flagged frame is placed in the notes (writer's spot, else after the bullet whose words
  match the speech at that time: insertFrames). Markers are normalised ([[FRAME:F3]] -> [[FRAME:3]], normaliseMarkers)
  and leftovers stripped. Captions = the selector's (picture only); without vision: "Narration at mm:ss: ...".
  Section (mm:ss) snapped to the transcript line that matches the section's first points (snapSectionTimes),
  then never later than its first figure (headersBeforeFigures). balanceFigures: one picture per scene (photos /
  scenes closer than 20 s in a section, 8 s for videos <= 2 min; charts/code/maps exempt) + a figure for every
  section that has a fitting frame in its time range. Web search drops video-site pages (the video's own description).
writer reply cut off at its token limit (generate() returns `truncated`) -> retried once with 2x room, else a warning
every runnable code block gets an Output block (writer, else one OUTPUTS call: codeWithoutOutput / addOutputs)
no Exam hints inside sections, no interactive widgets (removed); algorithms are drawn phase by phase as ```steps blocks
note rules (STYLE in prompts.js): easy-first explanations + examples, Shortcut callout, every on-screen code / table /
  formula / chart kept, LaTeX only, numbered step-by-step derivations, compact (tables over prose), code -> Output
```
Notes are ALWAYS English (Hindi/Hinglish audio is transcribed then translated by the writer; `ENGLISH_RULE`).

## Speed
For a local file or a downloaded YouTube stream, `runLocalPipeline` runs the transcript (`transcriptStep`) and the slide scan + OCR (`visualStep`) side by side; with the page-player grabber they stay sequential (one player). Slides are OCR'd as the scan finds them (`scanScenes` `onFrame`), on a pool of `OCR_WORKERS` Tesseract workers. Write groups run 2 at a time. Stage times are in the Activity log ("Transcript ready in ...", "Finished in ...").

## Where things are (entry points first)
| File | What |
|---|---|
| `manifest.json` | MV3. CSP `extension_pages` must keep `'wasm-unsafe-eval'` (Whisper + Tesseract are WASM). `cross_origin_embedder_policy` / `cross_origin_opener_policy` make extension pages cross-origin isolated so Whisper (CPU) runs on several threads (`lib/asr.js`, `crossOriginIsolated`); every remote resource must be fetched with fetch() (CORS mode), never `<img>`/`<script>` from another origin. |
| `background.js` | Service worker: job queue (`enqueue/pump/finish/start`), content-script registration, request sniffing, relays `PAGE_CAPTURE_*` to the tab. Settings validated in `start()`. |
| `offscreen.js` | Worker page that runs a job (`runJob`): fetches video, builds the YouTube grabber, `youtubeAudio` (live audio from the tab). Only `chrome.runtime` exists here, so **settings travel inside the job message**. |
| `content.js` + `adapters/*` | Content script (Shadow DOM UI). `adapters/youtube.js` = YouTube capture (listen at 2x + frame grabs) on the page's own `<video>`. It normally runs in a **helper window** (see Message flow), not the tab the user watches. (An embedded-iframe player was tried and dropped: YouTube answers "This video is unavailable" for it inside youtube.com.) `adapters/util.js` = shared helpers (`parseCaptions`, `youtubeCaptions`, `grabFrame`). Classic scripts, no imports. |
| `options.*` | Settings UI. `SLOTS` array drives the model pickers (cheap / strong / vision / stt / legacy video / notes). |
| `local.*` | "Summarize from a file" page (video or audio, optional .vtt/.srt). Runs the pipeline in the page. |
| `results.*`, `lib/md.js`, `lib/zip.js`, `lib/katex/` | Notes viewer, markdown renderer, export (copy / zip / print-to-PDF; figures exported as JPEG). ```` ```steps ```` blocks render as rows of boxes (`renderSteps`). Figures in the PDF = `frames` of the result. |
| `lib/algoviz.js` | ```` ```algo ```` blocks (JSON from the writer): RUNS the real algorithm (sorts, binary/linear search, BFS, DFS, Dijkstra, linked-list reversal) and draws every step as SVG with legend, caption, pointer arrows and queue/stack/table. Pure; `traceAlgo` (frames) / `renderAlgo` (HTML). Tested against real answers in `tests/cases/algo.mjs`. New algorithm = a trace fn + `INFO` entry. |
| `lib/settings.js` | Defaults + `normalizeSettings` (migration), `slotRef`, `sttRef`, `settingsProblem`. **Add a setting here first.** |
| `lib/llm.js` | `generate` (Gemini / OpenAI-compatible / Anthropic, text + images), `gfetch` (auth, retries), `listModels`, `detectProvider`. |
| `bridge/` | NOT part of the extension: local Node helper (`server.mjs`, `claude.mjs`, `geminiweb.mjs`, `login.mjs`) behind provider types `claudecli` / `geminiweb` (`BRIDGE_TYPES`, `isBridge` in `lib/settings.js`; handled in `lib/llm.js` `generateOnce`, `listModels` = `/health`). Provider `apiKey` = bridge token, `baseUrl` = bridge URL. Claude CLI is stripped (`--tools "" --system-prompt --setting-sources "" --strict-mcp-config --disable-slash-commands`, empty cwd, no `--bare`, API-key env removed) to keep subscription auth at ~1K tokens. Gemini web selectors are unverified against the live site. |
| `lib/pipeline.js` | `runPipeline` dispatches: `engine !== 'gemini'` -> `local-pipeline.js`; else legacy Gemini path. Also exports `pool`, `unfence`, `figureMd`, `splitFinal`. |
| `lib/local-pipeline.js` | **The main pipeline** (`runLocalPipeline`). Resumable via IndexedDB `drafts`. Pure helpers exported: `mergeRepeats`, `chooseFigures`, `insertFrames`, `splitFull`, `topicList`. |
| `lib/prompts.js` | All prompts. Local engine: `chunkPrompt`, `writePrompt` (incl. the STEPS and CODE output rules), `visionPrompt`, `outputsPrompt`, `ENGLISH_RULE`. Rest is legacy. |
| `lib/asr.js` | Whisper (vendored transformers.js): `transcribeAudio`, `whisperOptions`, `createLiveAudio` (live source), `makeTimeMap`. |
| `lib/stt.js` | Cloud speech-to-text (`/audio/transcriptions`, Groq/OpenAI): `transcribeCloud`. Same contract as `transcribeAudio`. |
| `lib/audiofile.js`, `lib/mp4audio.js` | Stream audio out of big MP4/M4A/WAV without decoding the whole file (WebCodecs). `openAudioSource`. |
| `lib/segments.js`, `lib/spool.js` | HLS (fMP4 only) / DASH (static) manifest -> parallel in-order segment download (`downloadManifest`, used by offscreen for `.m3u8`/`.mpd` video jobs). `createSpool` keeps bytes in RAM up to ~768 MB, then spills to OPFS (also used by `download-pipeline.js`); `clearSpool` runs after each job. |
| `lib/log.js`, `logs.html/js` | Activity log. `log.info / log.alert (yellow) / log.error (red)` (scope, msg, data). Stored in `chrome.storage.local` `activityLog` (last 1500) by the service worker; other pages forward via a `LOG` message. `tapConsole()` also records every `console.warn/error` and uncaught error. Never log secrets: `clean()` drops key/token/auth fields. Every entry carries `job` / `jobTitle` / `jobKind`: the worker page calls `setJob()` for the whole run (`jobId` travels in the `RUN_JOB` / `RUN_DOWNLOAD` message), the service worker uses `log.job(item)` / `jobLog(item)`. The "Activity log" page (linked from Options) shows one collapsible block per summary / download via `groupJobs`; entries with no job go in an "Other activity" block. |
| (figure + time rules) | `balanceFigures` thins same-moment pictures against the LAST KEPT one, drops look-alike pictures anywhere (64-bit hash, <= 6 bits; code/tables exempt), and a text-poor "diagram" is not exempt unless a vision tag confirms it. `isOutro` drops credits / logo end cards. `stripTimestamps` (lib/common.js) removes times from the printed / exported HTML only; stored notes, `summary.md` and "copy" keep them for the AI. |
| `modelfix.html/js`, `lib/stagefix.js`, `lib/modelcheck.js` | **Model failure = pause, not skip.** An AI call that fails with an HTTP/network error in a stage (`STAGE` table in `lib/local-pipeline.js`: stt, select, describe, map, write, math, overview, outputs) throws `StageError` (`.info` = stage, slot, provider, model, status, reason, skip). `offscreen.js` reports `JOB_PAUSED`; `background.js` `pauseItem` parks the queue item as `status:'paused'` (+ badge "!", message `SUMMARY_PAUSED` to the tab, pop-up window `modelfix.html?id=<item id>`). The window picks another provider/model (tested with `checkModel` / `checkVision`), saves it to the slot, and sends `RESUME_JOB` (re-queued with `resume:true`, `regenerate:false`: continues from the IndexedDB draft; the video is not fetched again when transcript + scan are saved). "Skip this step" sends `RESUME_JOB {skip}` (`draft.skip[...]`, `'vision'` = `draft.visionOff`); `CANCEL_PAUSED` cancels. Only `isHttpError` (has `.status`) pauses; an unreadable reply keeps the old fallback. AI errors carry `.status` (`apiError`, `gfetch`). |
| `lib/scenes.js`, `lib/scan.js` | Scene-change detector (pure) and the video scan (saves one PNG per change). |
| `lib/ocr.js`, `lib/framekind.js` | Tesseract wrapper (returns word boxes) and the code/table/diagram/formula classifier (`classify`, `THRESHOLDS`). |
| `lib/align.js`, `lib/chunk.js`, `lib/transcript.js`, `lib/codedetect.js` | Timestamp alignment, chunking, caption parsing, "is this a programming lecture". All pure. |
| `lib/frames.js`, `lib/db.js`, `lib/lint.js`, `lib/source.js`, `lib/common.js` | Frame hashing/dup check, IndexedDB (results / frames / drafts), math lint, video source resolver, small utils. |
| `lib/vendor/` | Vendored, do not edit: `transformers.min.js` (self-contained build; the `.web` build has bare imports and BREAKS), `ort/` (onnxruntime wasm), `tesseract/` (+ `eng.traineddata.gz`). ~78 MB. |

## Data as files, notes as one Markdown document (setting `attachData`, default on)
- Rules are chat text; data (transcript, on-screen text, frame descriptions, sources, web results) is a `.txt` attachment: `generate(..., { attachments:[{name,text}] })` (`lib/llm.js`). Gemini = inline text/plain part, Anthropic = `document` block (cached), Claude CLI = `document` block in stream-json, Gemini web = uploaded file, OpenAI-compatible / Codex CLI = one `<attachment>` block ahead of the prompt. A 400 with a file part retries inline. Builders: `writerFile`, `transcriptFile`, `describeFile`, `chunkFile`, `trimFile` (+ `attached:` flag on the matching prompt) in `lib/prompts.js`. The flow before the writer (digest, OCR, vision) is unchanged: only its transport moved.
- A reply cut at the output limit (or inside a code / visual / `$$` block) is continued IN THE SAME CONVERSATION (`finishWriter` in `local-pipeline.js` -> `completeParts` / `stitch` in `lib/md-parts.js`): `session` where the provider keeps one (Gemini web), else `history` (the first turn with its attachment replayed from the provider's cache; CLI bridges flatten it, `bridge/convo.mjs`) + `mdContinuePrompt`. Up to 4 parts, overlap removed.
- Visuals: the writer emits ` ```visual ` + one small JSON object; `lib/textbook-visuals.js` is the registry (~45 types: maths, statistics, image processing, engineering, layouts, quiz): validation, maths, SVG and sliders live there, the model gives parameters only. `VISUAL_GUIDE` is what the writer and the assistant are told. `image_lab` draws a synthetic picture (procedural scenes), runs the real algorithm (CLAHE, equalise, gamma, blur, sharpen, Laplacian, Sobel, high-pass, median, noise...) and shows original / result with histograms, a row profile and a changed-pixel block; no canvas: images are BMP data URIs. The assistant never dead-ends on a bad visual: `settleScript` (textbook-assistant.js) tells the model what failed (`explainVisual`) up to twice in the same conversation, then salvages the text with `withoutBadVisuals`. Look changes outline what they touched (`flashLook`). Add a type = one `define()` + one guide line + a sample in `tests/cases/visuals.mjs`. A frame the writer redrew is listed `<!--RENDERED F12-->` and dropped by `placeTopicFigures` only when `canRedraw` (no photo, scene, map, handwriting...) and a visual sits in its topic. Exported HTML embeds this same file as a module (`visualRuntime`).

## Notes viewer: assistant, manual edits, library
- `lib/notes-edit.js` (pure): sections, outline, BM25-lite retrieval (`pickSections`: outline + only the needed sections), the `@@ append|after|replace|section` edit script (parse, validate, apply to raw AND saved Markdown), figure moves. `lib/notes-store.js`: the one writer of edits (locks, stale check, undo/redo). `lib/textbook-assistant.js`: orb + panel (Ask / Edit notes, real model dropdown, dock/float, review cards); `lib/notes-editor.js`: "Edit notes" button (section text, move/remove figures); `assistant.css`. The results page has no Preview button: the same page mounts all of this; only "Save as HTML" in the side panel opens a tab (folder pickers need a full page).
- Quote in assistant (`textbook-assistant.js`: `selectedText`, `placeFab`, `state.quotes`): selecting text in `#out` shows a floating button; a quote = `{text <= 1500 chars (formulas come back as their LaTeX from the KaTeX annotation), n, title}`, max 3. The request carries a `QUOTED FROM THE NOTES` block and `pickSections(..., { must })` always sends the quoted sections. Quotes clear after sending; the UI scope ignores them.
- `lib/ui-theme.js` (assistant scope "UI changes", `[TASK:UI_LOOK]`): the model returns a JSON PATCH of the page look, never code. `sanitizeLook` checks every field against closed lists (`FONTS`, `TARGETS`, `ANIMATIONS`, hex colours, `safeValue` for CSS values, `cleanSvg` rebuilds an orb drawing from a tag/attribute whitelist), `mergeLook` builds on the saved look (`localStorage` `vid2study:look`, re-sanitised on load), `lookCss` emits one `<style id="v2s-look">` scoped under `html[data-look]`. The assistant APPLIES it as a trial; "Keep this look" saves, "Revert" undoes. No notes, pipeline or bridge involved. Add a part = one `TARGETS` entry; add an animation = a keyframe in `keyframes` + the `ANIMATIONS` list; test in `tests/cases/uilook.mjs`.
- `lib/library-page.js`: the master `Vid2Study.html` (shelf of subject covers, contents pages, sidebar tree + search, sandboxed reader iframe, theme). Entries carry `savedAt`.

## Writer call extras
- Coverage is handled by the extension, not shown to the reader (the notes banner no longer lists checklist items). After the writer's own follow-up, `confirmCoverage` (`local-pipeline.js`, `[TASK:COVERAGE]`, cheap pool, `coveragePrompt` / `readCoverage` in `prompts.js`) JUDGES the checklist points the keyword matcher still flags: one call per part, notes attached as `notes.txt`, reply `{"missing":[n]}`. Points found taught in other words go to `draft.coverageConfirmed` and stop counting; only points truly missing trigger ONE more writer follow-up (additions only, never a rewrite). Best effort: a failed check logs a warning and leaves the notes alone.
- No silent skips: every AI call goes through `sure()` (one more try for an unusable reply: empty / not JSON / no
  verdicts), then pauses with `StageError` like an HTTP failure. Only an unreadable saved frame is dropped quietly.
- Frame priority (`framePriority`, `KIND_WEIGHT`): 2 x kind (map/chart 10, diagram/schematic/table/code/formula 9, patent 8,
  document 6, slide 5, photo 4, scene 3) + vision info 0-10 + time on screen (up to +3) + text (up to +1). `pictureSet` =
  top `writerImages` per write part (`planGroups`, same parts as the writer); kept frames with priority >=
  `IMPORTANT_PRIORITY` (20) that are NOT in that set and have no `detail` yet get the describe pass.
- Pictures: `pickPictures` sends up to `writerImages` (default 10; Gemini web max 10) of the part's frames as JPEGs with the
  WRITE call, listed in the prompt as "Image k = Fn at mm:ss". A model that refuses images (400 / "image" error) is retried
  once without them and `draft.noWriterImages` stops them for the video.
- `isTechnical` (code detected or >= 6 maths/tech words) decides whether TECH (steps, code output, algo/steps blocks) and
  MATH_RULES go into the prompt (`draft.technical`).
- Every WRITE reply ends with `<!--NEEDS practice=yes|no math=yes|no-->` (`takeNeeds` strips it, `draft.needs`). practice=no
  on all parts skips [TASK:QUESTIONS]; math=no skips the AI math fix (local lint still runs). Missing line = follow settings.
- Gemini web (bridge/geminiweb.mjs, browser path): waits up to `GEMINI_MAX_MS` (default 30 min, min 2 min, max 60 min) and returns as soon
  as the Stop button is gone and the text is stable; timeouts are HTTP 504 and are not retried. Model checks wait 10 min for Gemini web.
- Long silent requests (Gemini web HTTP `StreamGenerate`) use `bridge/longfetch.mjs` (node:http/https, no silence
  limit) because Node's `fetch` gives up after 5 min without a byte, which made the bridge fall back to the slow browser path. The bridge
  also logs `uncaughtException` / `unhandledRejection` instead of dying (a crash shows as "Failed to fetch" in the extension). Restart the
  bridge after editing anything in `bridge/`.

## YouTube transcript order (no listening when avoidable)
1. `content.js` `captionsFor` -> `YT_PAGE_CAPTIONS` -> background runs `pagePlayerCaptions` (`lib/ytcaptions.js`) in the page's
   MAIN world: the player loads the captions itself (YouTube's PO token included; captions toggled on briefly, then restored),
   the reply is kept (fetch/XHR hook) -> `json3ToLines`. Then the old direct fetch (`U.youtubeCaptions`).
2. `offscreen.js` `runJob`: no transcript -> `bridgeSubs` (yt-dlp captions via the bridge, `lib/ytbridge.js`, `BRIDGE_INFO` gives
   url + token: bridge provider in Options, else the native host, which starts the bridge).
3. Extension's own stream download (`resolveYoutubeStreams`); whatever is missing (audio without transcript, video) -> `bridgeMedia`.
4. Listening (`youtubeAudio`) only if all fail. `bridge/youtube.mjs`: yt-dlp in `bridge/bin` (downloaded on first use), clients
   `default,tv,android_vr`, `--update-to nightly` weekly (checked at start + every 6 h, skipped while a download runs).

## Message flow (YouTube)
content script `START_SUMMARY` -> background queue -> `RUN_JOB` to offscreen -> pipeline.
Offscreen asks for frames/audio via `PAGE_CAPTURE_*` -> background `relayCapture` -> content script -> adapter. Background opens a **helper window**
(`openHelper`: same watch URL, minimized, tab muted, waits for `CAPTURE_PING`) and relays there with `helper:true`, so the viewer keeps watching normally. ONE playback: while listening the adapter also sends `FRAME_SAMPLE` pictures on the scan grid; `youtubeGrabber` uses them and only seeks the player for missing ones;
only if that fails does it use the viewer's own tab (banner shown, player borrowed). Closed by `closeHelper` when the job ends (`finish`) or `PAGE_HELPER_CLOSE`.
Audio comes back as `{target:'offscreen', type:'AUDIO_CHUNK'|'AUDIO_PROGRESS'|'AUDIO_DONE'|'AUDIO_ERROR'}` straight to offscreen
(background ignores `target:'offscreen'`). `PROGRESS` messages feed the panel (`STAGES` map in `content.js`).

## Model pools (fallbacks)
- Cheap AI = a POOL: `cheap` then `cheapPool` [{provider, model}] (any number, tried in order). Strong AI = a pool of at most TWO:
  `strong` then `strongFallback`. `slotRef` returns `{provider, model, pool}`; empty Vision / Video type / Transcript summary use the
  whole Cheap pool; no Cheap AI at all = the Strong pool. Every call site passes `pool: ref.pool` to `gen()`/`sure()`.
- `gen()` (local-pipeline.js) tries the model, then each pool entry on any error (logged as an alert). 401 / 403 / 404 mark a model dead for
  the rest of the run. Only when ALL fail does the job pause (`StageError` names the FIRST model, so the fix dialog edits the main slot).
  An unusable reply (empty / not JSON) still retries the same model once in `sure()`, then pauses (no pool for that).
- Options: "Cheap AI fallbacks" (add/remove rows, `drawCheapPool`) and "Strong AI pool: second model" (a SLOTS entry).

## Settings you will touch
`engine` (local | gemini), model slots `cheap` / `strong` / `vision` / `stt` (each `{provider, model}`, empty cheap/vision = strong,
empty stt = local Whisper), `sceneThreshold` (fraction of pixels, default 0.05, NOT ffmpeg's scale), `sampleSeconds`, `maxScenes`,
`maxVision`, `ocrMinWords`, `chunkMinutes`, `shortVideoMinutes`, `asrModel` (tiny|base|small), `asrLanguage` (`en` | `hinglish` | `hi` | `auto` | code),
`listenSpeed` (1-4), `downloadFirst` + `downloadMaxHours` (YouTube longer than this, default 3 h, is heard + scanned via the page player instead of downloaded; 0 = no limit), `maxFrames` (figures per hour), `detail`, `webSearch` (writer may search; `searchTool()` in `lib/llm.js` says which models search natively; for the rest `lib/websearch.js` searches DuckDuckGo + Wikipedia in the extension, once per video, cached in `draft.web`).

## Rules and gotchas
- **No build step.** Extension pages use ES modules; `content.js` and `adapters/*` are classic scripts (IIFE, `window.__lhUtil`). Don't add imports there.
- **English-only Whisper (`*.en`) throws if given `task`/`language`.** Always build options with `whisperOptions()`.
- A new setting needs: default in `SETTING_DEFAULTS`, clamp in `normalizeSettings`, field in `options.html` + `options.js` (load + save).
- Frames are stored in IndexedDB as `${key}/${filename}`; unused scene frames are deleted after the result is saved.
- Windows + some files use **CRLF** (`background.js`, `lib/pipeline.js`, ...). Multi-line string replaces silently miss: prefer the Edit tool, or normalise first.
  Long shell heredocs break in this environment: write a small script file and run it.
- After editing `manifest.json` or `background.js` the user must reload the extension; after content-script edits also refresh the tab.
- Keep prompts short: every word is paid for on every call. Each starts with a `[TASK:NAME]` tag (tests key off it).

## Testing
`npm test` (= `node tests/run.mjs`): no dependencies, no browser. Copies `lib/` to a temp dir with `tests/stubs/` (in-memory db, fake AI)
and runs `tests/cases/*.mjs`. Covers chunking, alignment, scenes, frame classifier, MP4 audio reader, live/cloud transcription, language options, and the
pipeline end to end with a fake AI. **Not covered (needs Chrome, verify by hand):** Whisper/Tesseract running, canvas, WebCodecs decode,
the hidden YouTube player, the real provider APIs. When you change a pure module, add a case in `tests/cases/`.

## Known gaps / unverified in a real browser
The YouTube helper window (frame grabs from a minimized window may come out blank; listening is expected to work), WebCodecs AAC decode path, Groq/OpenAI transcription request shape, classifier
thresholds on real lectures, WebGPU Whisper (falls back to CPU wasm). OCR is English only (Devanagari slides are not read). By default (setting `downloadFirst`) the YouTube audio + video streams are downloaded first (`lib/download-pipeline.js`, URLs found by `lib/ytstreams.js` in the offscreen page: watch-page HTML first, then the app player endpoint; if YouTube only offers encrypted streams the reason is logged as an alert and the job listens instead) and processed at CPU speed; any download failure falls back to hearing them through the page player (`adapters/youtube.js`).
