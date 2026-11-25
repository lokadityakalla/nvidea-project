# Site Meeting Copilot v2

Local AI assistant for construction site meeting minutes. It turns meeting audio or a pasted transcript, an agenda, and a project schedule CSV into meeting minutes, decisions, blockers, owner-based action items, due dates, agenda coverage, and schedule-impact flags.

This version is aligned with problem statement PS239:

- Domain: Construction and real estate
- Process: Site meeting minutes
- AI focus: LLM summarization
- Business function: Project governance
- Expected deliverables: Minutes and action tracker

## Features

- Upload `.mp3`, `.wav`, `.m4a`, `.ogg`, `.webm`, or `.mp4` meeting audio up to 25 MB.
- Transcribe audio locally through the Flask Whisper server on `http://localhost:9000`, with `/health`, `/warmup`, and `/asr` endpoints.
- Analyze transcript, agenda, and schedule rows locally with Ollama `phi3:mini`.
- Extract meeting summary, attendees, decisions, blockers, responsibilities, due dates, priorities, agenda coverage, and next meeting.
- Parse schedule CSV files with validation for `Task`, `Owner`, `Start Date`, `End Date`, and `Status`.
- Highlight schedule tasks affected by blockers or decisions with fuzzy task matching.
- Copy or download:
  - meeting minutes as TXT,
  - action tracker as CSV,
  - schedule-impact report as TXT.
- Includes a repeatable demo dataset and an evaluation pack under `evaluation/`.
- No cloud API key or hosted database is required.

## Project Structure

```text
site-meeting-copilot-v2/
|-- index.html
|-- style.css
|-- icons.css
|-- app.js
|-- whisper_server.py
|-- requirements.txt
|-- sample-project-schedule.csv
|-- evaluation/
|   |-- README.md
|   |-- scoring-sheet.csv
|   |-- transcripts/
|   |-- schedules/
|   `-- expected/
|-- FINAL_REPORT.md
|-- install_dependencies.ps1
|-- start_ollama.ps1
|-- start_whisper.ps1
|-- start_app.ps1
`-- .vscode/tasks.json
```

## One-Time Setup

Install Ollama from `https://ollama.com`, then pull the local model:

```powershell
ollama pull phi3:mini
```

Install Python dependencies:

```powershell
pip install -r requirements.txt
```

If your launcher is `py`, use:

```powershell
py -m pip install -r requirements.txt
```

## Run the Project

Open `D:\site-meeting-copilot-v2` in VS Code and run these tasks in separate terminals:

```text
Terminal > Run Task... > Start Ollama
Terminal > Run Task... > Start Whisper Server
Terminal > Run Task... > Start Web App
```

Then open:

```text
http://127.0.0.1:5500/index.html
```

Manual commands:

```powershell
$env:OLLAMA_ORIGINS="*"; ollama serve
python whisper_server.py
python -m http.server 5500 --bind 127.0.0.1
```

## Whisper Self-Check

Before a demo, verify the audio layer without loading a large model:

```powershell
python evaluation/check_whisper_server.py
```

In VS Code, you can also run:

```text
Terminal > Run Task... > Check Whisper Server
```

With the server running, you can also check:

```powershell
Invoke-RestMethod http://localhost:9000/health
```

If you want the first transcription to start faster during a review, warm up the model before uploading audio:

```powershell
Invoke-RestMethod -Method Post http://localhost:9000/warmup
```

## Quick Demo

1. Confirm the header says `phi3:mini ready`.
2. Confirm the audio section says `Whisper server ready` if audio testing is required.
3. Click `Load Demo`.
4. Click `Analyze Meeting`.
5. Review the `Minutes`, `Action Tracker`, and `Schedule Impact` tabs.
6. Use the download buttons to export the final deliverables.

## Schedule CSV Format

The app accepts flexible header names, but the recommended format is:

```csv
Task,Owner,Start Date,End Date,Status
Zone B rebar delivery,Priya Nair,12 June 2026,14 June 2026,In Progress
```

Rows with blank tasks are skipped with a warning. Missing owner/date/status cells are filled as `TBD` instead of crashing the app.

## Evaluation Pack

Use the files in `evaluation/` to score the app against the project-progress deck:

- `evaluation/transcripts/demo-meeting.txt`: expected happy-path transcript.
- `evaluation/expected/demo-expected-output.json`: answer key for the demo transcript.
- `evaluation/schedules/demo-schedule.csv`: schedule used for impact matching.
- `evaluation/schedules/malformed-schedule.csv`: robustness case for bad CSV quotes.
- `evaluation/scoring-sheet.csv`: manual scoring sheet for transcription, JSON extraction, agenda coverage, schedule impact, and robustness.
- `evaluation/check_whisper_server.py`: route-level Whisper smoke test that avoids model download/load.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Ollama offline | Run `$env:OLLAMA_ORIGINS="*"; ollama serve` |
| Model missing | Run `ollama pull phi3:mini` |
| Whisper offline | Run `python whisper_server.py` from the project folder |
| `ModuleNotFoundError: flask_cors` | Run `pip install -r requirements.txt` |
| Whisper dependencies missing | Run `pip install -r requirements.txt`, or the VS Code task `Install Python Dependencies` |
| Audio upload fails | Keep the file under 25 MB and use `.mp3`, `.wav`, `.m4a`, `.ogg`, `.webm`, or `.mp4` |
| JSON parse error | Retry or shorten the transcript so the local model stays inside the JSON schema |
| CSV rejected | Use columns for Task, Owner, Start Date, End Date, and Status |
