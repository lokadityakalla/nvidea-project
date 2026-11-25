# Site Meeting Copilot v2 - Final Report

## Problem Statement Alignment

PS239 asks for a construction site meeting copilot that extracts decisions, blockers, responsibilities, and due dates from meeting recordings, with minutes and an action tracker as the deliverable.

The project satisfies this by accepting meeting audio or a pasted transcript, agenda text, and a project schedule CSV. It produces meeting minutes, decisions, blockers, agenda coverage, an owner-based action tracker, and a schedule-impact report.

## Architecture

```text
Browser UI
  index.html, style.css, app.js
  Inputs: meeting details, audio, agenda, schedule CSV, transcript
        |
        | audio upload
        v
Whisper Server
  Flask /health, /warmup, and /asr endpoints on localhost:9000
  faster-whisper CPU transcription with openai-whisper fallback
        |
        | transcript + agenda + schedule rows
        v
Ollama LLM
  phi3:mini on localhost:11434
  strict JSON extraction prompt
        |
        v
Reports
  Minutes TXT, action tracker CSV, schedule-impact TXT
```

## Implemented Requirements

| Requirement | Implementation |
| --- | --- |
| Meeting audio input | Audio upload, preview, file validation, and local Whisper transcription |
| Whisper reliability | Health endpoint, warmup endpoint, upload-size guard, supported-format validation, structured error responses |
| Agenda input | Pasteable agenda with coverage extraction |
| Project schedule input | CSV upload, schema validation, normalized preview, sample CSV |
| Decisions extraction | Prompt schema plus minutes rendering |
| Blocker extraction | Prompt schema plus blocker/risk section |
| Responsibilities | Action tracker rows include owner/responsible person |
| Due dates | Action tracker rows include due date or `TBD` |
| Minutes deliverable | Minutes tab, copy button, and TXT download |
| Action tracker deliverable | Action Tracker tab, copy-as-table, and CSV download |
| Schedule awareness | Schedule-impact tab with fuzzy task matching and risk badges |
| Local-first design | Ollama and Whisper run on localhost; no cloud API key required |

## Robustness Improvements

- CSV validation now checks required schedule columns before accepting a file.
- Common schedule header variants such as `Activity`, `Assigned To`, and `Finish` are normalized.
- Blank task rows are skipped with warnings; missing optional cells become `TBD`.
- Malformed quoted CSV cells produce a clear error message.
- Ollama calls now use a 90-second timeout with retry guidance.
- Model-missing, JSON parse, and connection failures display actionable recovery messages.
- Whisper health checks now report dependency availability, model name, load state, device, compute type, and supported audio formats.
- Whisper upload handling now rejects unsupported formats and files above 25 MB before transcription.
- Whisper errors can be returned as JSON for diagnostics while preserving plain-text transcript compatibility for the browser.
- Schedule matching now handles close task names through token overlap, not only exact string matches.

## Evaluation Plan

The `evaluation/` folder contains a repeatable manual test pack:

1. Run `python evaluation/check_whisper_server.py` to verify Whisper route wiring and dependency status.
2. Run the app and click `Load Demo`, or paste `evaluation/transcripts/demo-meeting.txt`.
3. Use `evaluation/schedules/demo-schedule.csv` as the schedule input.
4. Analyze the meeting.
5. Compare the output with `evaluation/expected/demo-expected-output.json`.
6. Record scores in `evaluation/scoring-sheet.csv`.
7. Try `evaluation/schedules/malformed-schedule.csv` and confirm the app shows a clear CSV error.

## Known Limitations

- Small local LLMs can still miss wording nuance or produce incomplete JSON.
- Noisy audio may reduce transcription accuracy, so transcript editing remains supported.
- The first Whisper transcription may be slow because the model is loaded lazily; `/warmup` can be called before a demo.
- The app is a local guided-demo MVP, not a multi-user production system.
- Schedule matching is intentionally lightweight and should be replaced with stronger semantic matching for production use.

## Final Status

The project now demonstrates a complete local workflow from meeting evidence to project-governance outputs: minutes, decisions, blockers, responsible owners, due dates, an action tracker, and schedule-risk visibility.
