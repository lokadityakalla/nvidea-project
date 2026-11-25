// ══════════════════════════════════════════════════════════════════
//  Site Meeting Copilot v2 — app.js
//  Features: Audio (Whisper) · Agenda cross-ref · Schedule CSV impact
// ══════════════════════════════════════════════════════════════════

// ─── Config ───────────────────────────────────────────────────────
const OLLAMA_URL    = 'http://localhost:11434';
const LLM_MODEL     = 'phi3:mini';
const WHISPER_URL   = 'http://localhost:9000'; // whisper.cpp / faster-whisper server
const OLLAMA_TIMEOUT_MS = 90000;
const MAX_SCHEDULE_ROWS_FOR_PROMPT = 25;
const REQUIRED_SCHEDULE_COLUMNS = [
  { key: 'Task', aliases: ['task', 'activity', 'work item', 'schedule task', 'item', 'name'] },
  { key: 'Owner', aliases: ['owner', 'responsible', 'responsibility', 'assigned to', 'assignee'] },
  { key: 'Start Date', aliases: ['start date', 'start', 'planned start', 'start_date'] },
  { key: 'End Date', aliases: ['end date', 'finish date', 'finish', 'planned finish', 'due date', 'end_date'] },
  { key: 'Status', aliases: ['status', 'state', 'progress'] },
];

// ─── State ────────────────────────────────────────────────────────
let parsedData    = null;   // AI analysis result
let csvSchedule   = [];     // rows parsed from uploaded CSV
let audioBlob     = null;   // uploaded audio file
let csvWarnings   = [];     // non-fatal CSV cleanup notes

const SAMPLE_SCHEDULE = [
  ['Task', 'Owner', 'Start Date', 'End Date', 'Status'],
  ['Zone A concrete pour', 'Sarah Menon', '01 June 2026', '10 June 2026', 'Complete'],
  ['Zone B rebar delivery', 'Priya Nair', '12 June 2026', '14 June 2026', 'In Progress'],
  ['Zone B foundation work', 'Mohan Das', '18 June 2026', '30 June 2026', 'Not Started'],
  ['Safety inspection', 'Ahmed Sheikh', '13 June 2026', '13 June 2026', 'Scheduled'],
  ['Shuttering material order', 'Priya Nair', '12 June 2026', '12 June 2026', 'Not Started'],
  ['Project board review', 'Ravi Kumar', '14 June 2026', '14 June 2026', 'Not Started'],
  ['Plumbing rough-in Block B', 'Site Team', '01 July 2026', '15 July 2026', 'Not Started'],
  ['Electrical conduit laying', 'Site Team', '05 July 2026', '20 July 2026', 'Not Started'],
];

const LOADING_HTML = `
  <div class="spinner"></div>
  <p>phi3:mini is analyzing your meeting...</p>
  <small>This may take 20-40 seconds on first run</small>
`;

// ══════════════════════════════════════════════════════════════════
//  STATUS CHECKS
// ══════════════════════════════════════════════════════════════════

async function checkOllamaStatus() {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data  = await res.json();
      const hasPhi = (data.models || []).some(m => m.name.includes('phi3'));
      dot.className    = 'dot online';
      txt.textContent  = hasPhi ? 'phi3:mini ready' : 'Ollama online — run: ollama pull phi3:mini';
    } else throw new Error();
  } catch {
    dot.className   = 'dot offline';
    txt.textContent = 'Ollama offline — run: OLLAMA_ORIGINS=* ollama serve';
  }
}

async function checkWhisperStatus() {
  const dot = document.getElementById('whisper-dot');
  const txt = document.getElementById('whisper-text');
  dot.className = 'dot checking';
  txt.textContent = 'Checking Whisper…';
  try {
    const res = await fetch(`${WHISPER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === 'ok') {
      dot.className   = 'dot online';
      const model = data.model ? ` (${data.model})` : '';
      const loadHint = data.model_loaded ? 'loaded' : 'loads on first transcription';
      txt.textContent = `Whisper server ready${model}, ${loadHint}`;
    } else if (data.status === 'missing_dependencies') {
      throw new Error('Whisper dependencies missing — run Install Python Dependencies');
    } else {
      throw new Error('Whisper server unavailable');
    }
  } catch (err) {
    dot.className   = 'dot offline';
    txt.textContent = err.message.includes('dependencies')
      ? err.message
      : 'Whisper offline — run Start Whisper Server';
  }
}

async function readWhisperError(res) {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    return [data.message, data.detail].filter(Boolean).join(': ') || 'Whisper server error';
  }
  return (await res.text().catch(() => '')).trim() || 'Whisper server error';
}

// ══════════════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════════════

function showTab(name) {
  ['input', 'minutes', 'tracker', 'schedule'].forEach(t => {
    document.getElementById('view-' + t).classList.toggle('hidden', t !== name);
  });
  document.querySelectorAll('.tab').forEach((el, i) => {
    el.classList.toggle('active', ['input', 'minutes', 'tracker', 'schedule'][i] === name);
  });
}

function toggleSection(id) {
  const body = document.getElementById(id);
  const icon = document.getElementById(id + '-icon');
  const isOpen = !body.classList.contains('hidden');
  body.classList.toggle('hidden', isOpen);
  icon.classList.toggle('open', !isOpen);
}

// ══════════════════════════════════════════════════════════════════
//  AUDIO — UPLOAD, PREVIEW, TRANSCRIBE
// ══════════════════════════════════════════════════════════════════

function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}
function handleDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function handleAudioDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadAudioFile(file);
}
function handleAudioFile(e) {
  const file = e.target.files[0];
  if (file) loadAudioFile(file);
}

function loadAudioFile(file) {
  const allowed = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg', 'audio/x-m4a', 'audio/webm', 'video/mp4'];
  if (!allowed.includes(file.type) && !file.name.match(/\.(mp3|wav|m4a|ogg|webm|mp4)$/i)) {
    showError('Please upload an audio file (.mp3, .wav, .m4a, .ogg, .webm, .mp4)');
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    showError('Audio file must be under 25 MB');
    return;
  }
  audioBlob = file;
  document.getElementById('audio-filename').textContent = file.name;
  const url = URL.createObjectURL(file);
  document.getElementById('audio-player').src = url;
  document.getElementById('audio-drop-zone').classList.add('hidden');
  document.getElementById('audio-preview').classList.remove('hidden');
}

function removeAudio() {
  audioBlob = null;
  document.getElementById('audio-player').src = '';
  document.getElementById('audio-drop-zone').classList.remove('hidden');
  document.getElementById('audio-preview').classList.add('hidden');
  document.getElementById('audio-file-input').value = '';
}

async function transcribeAudio() {
  if (!audioBlob) return;
  const btn = document.getElementById('transcribe-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;margin-right:6px;vertical-align:-3px"></span> Transcribing…';

  try {
    // ── Try Whisper server (faster-whisper / whisper.cpp) ──────────
    const formData = new FormData();
    formData.append('audio_file', audioBlob);
    formData.append('task', 'transcribe');
    formData.append('language', 'en');

    let transcript = '';

    try {
      const res = await fetch(`${WHISPER_URL}/asr?task=transcribe&language=en&output=txt`, {
        method: 'POST', body: formData,
        signal: AbortSignal.timeout(120000)
      });
      if (res.ok) {
        transcript = await res.text();
      } else {
        throw new Error(await readWhisperError(res));
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError' || /failed to fetch/i.test(err.message)) {
        throw new Error(`Whisper server is not ready. Start it with "python whisper_server.py". Details: ${err.message}`);
      }
      throw err;
    }

    if (transcript && transcript.trim()) {
      document.getElementById('transcript').value = transcript.trim();
      showSuccess('Transcription complete! Review the transcript below.');
    } else {
      showError('Transcription returned empty. Check Whisper server or try pasting transcript manually.');
    }

  } catch (err) {
    showError('Transcription failed: ' + err.message);
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="ti ti-ear"></i> Transcribe with Whisper';
}

// Web Speech API fallback (works with microphone in browser, not file)
function transcribeWithWebSpeech() {
  return new Promise((resolve, reject) => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      reject(new Error('Web Speech API not supported. Install the Whisper server for file transcription.'));
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    let text = '';
    recognition.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += e.results[i][0].transcript + ' ';
      }
    };
    recognition.onerror = e => reject(new Error('Speech recognition error: ' + e.error));
    recognition.onend   = () => resolve(text.trim());
    recognition.start();
    // Auto stop after 5 min
    setTimeout(() => recognition.stop(), 300000);
  });
}

function showWhisperHelp() {
  const box = document.getElementById('whisper-help');
  box.classList.toggle('hidden');
}

// ══════════════════════════════════════════════════════════════════
//  AGENDA — MONITOR INPUT
// ══════════════════════════════════════════════════════════════════

function initAgendaMonitor() {
  const ta = document.getElementById('agenda-input');
  const status = document.getElementById('agenda-status');
  ta.addEventListener('input', () => {
    if (ta.value.trim().length > 10) {
      status.classList.remove('hidden');
    } else {
      status.classList.add('hidden');
    }
  });
}

// ══════════════════════════════════════════════════════════════════
//  CSV SCHEDULE — UPLOAD, PARSE, PREVIEW
// ══════════════════════════════════════════════════════════════════

function handleCsvDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadCsvFile(file);
}
function handleCsvFile(e) {
  const file = e.target.files[0];
  if (file) loadCsvFile(file);
}

function loadCsvFile(file) {
  if (!file.name.toLowerCase().endsWith('.csv')) { showError('Please upload a .csv file'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const { rows, warnings } = prepareScheduleRows(e.target.result);
      csvSchedule = rows;
      csvWarnings = warnings;
      document.getElementById('csv-filename').textContent = file.name + ` (${csvSchedule.length - 1} tasks)`;
      document.getElementById('csv-drop-zone').classList.add('hidden');
      document.getElementById('csv-preview').classList.remove('hidden');
      renderCsvPreview(csvSchedule, csvWarnings);
      hideError();
    } catch (err) {
      csvSchedule = [];
      csvWarnings = [];
      document.getElementById('csv-file-input').value = '';
      showError(err.message);
    }
  };
  reader.onerror = () => showError('Could not read the CSV file. Please try again.');
  reader.readAsText(file);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];

    if (ch === '"' && inQuote && next === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' && !inQuote) {
      row.push(cell.trim());
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (inQuote) {
    throw new Error('CSV has an unclosed quoted cell. Check quotation marks and upload again.');
  }

  row.push(cell.trim());
  if (row.some(value => value.length > 0)) rows.push(row);
  return rows;
}

function prepareScheduleRows(text) {
  const rows = parseCsv(String(text || ''));
  if (rows.length < 2) {
    throw new Error('CSV appears empty or has no data rows.');
  }

  const rawHeaders = rows[0].map(value => String(value || '').trim());
  const headerIndexes = mapScheduleHeaders(rawHeaders);
  const missing = REQUIRED_SCHEDULE_COLUMNS
    .filter(column => headerIndexes[column.key] === undefined)
    .map(column => column.key);

  if (missing.length) {
    throw new Error(`CSV is missing required column(s): ${missing.join(', ')}. Use headers: Task, Owner, Start Date, End Date, Status.`);
  }

  const warnings = [];
  const normalizedRows = rows.slice(1)
    .map((row, index) => {
      const task = readCsvCell(row, headerIndexes.Task);
      if (!task) {
        warnings.push(`Skipped row ${index + 2}: task is blank.`);
        return null;
      }
      return [
        task,
        readCsvCell(row, headerIndexes.Owner) || 'TBD',
        readCsvCell(row, headerIndexes['Start Date']) || 'TBD',
        readCsvCell(row, headerIndexes['End Date']) || 'TBD',
        readCsvCell(row, headerIndexes.Status) || 'TBD',
      ];
    })
    .filter(Boolean);

  if (!normalizedRows.length) {
    throw new Error('CSV has headers but no usable schedule tasks.');
  }

  if (normalizedRows.length > MAX_SCHEDULE_ROWS_FOR_PROMPT) {
    warnings.push(`Only the first ${MAX_SCHEDULE_ROWS_FOR_PROMPT} tasks are sent to the model prompt; the full schedule still appears in the table.`);
  }

  return { rows: [['Task', 'Owner', 'Start Date', 'End Date', 'Status'], ...normalizedRows], warnings };
}

function mapScheduleHeaders(headers) {
  return REQUIRED_SCHEDULE_COLUMNS.reduce((result, column) => {
    const aliases = [column.key, ...column.aliases].map(normalizeHeaderName);
    const index = headers.findIndex(header => aliases.includes(normalizeHeaderName(header)));
    if (index >= 0) result[column.key] = index;
    return result;
  }, {});
}

function normalizeHeaderName(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function readCsvCell(row, index) {
  return String(row[index] ?? '').trim();
}

function renderCsvPreview(rows, warnings = []) {
  const headers = rows[0];
  const preview = rows.slice(1, 6); // show first 5 rows
  const warningHtml = warnings.length
    ? `<div class="csv-warning">${warnings.map(w => `<div>${escapeHtml(w)}</div>`).join('')}</div>`
    : '';
  const table = `
    <table class="csv-preview-table">
      <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${preview.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
    ${rows.length > 6 ? `<p style="font-size:11px;color:var(--text-tertiary);margin-top:6px">Showing 5 of ${rows.length - 1} tasks</p>` : ''}
    ${warningHtml}
  `;
  document.getElementById('csv-table-preview').innerHTML = table;
}

function removeCsv() {
  csvSchedule = [];
  csvWarnings = [];
  document.getElementById('csv-drop-zone').classList.remove('hidden');
  document.getElementById('csv-preview').classList.add('hidden');
  document.getElementById('csv-file-input').value = '';
  document.getElementById('csv-table-preview').innerHTML = '';
}

function downloadSampleCsv() {
  const csv = scheduleToCsv(SAMPLE_SCHEDULE);
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sample-project-schedule.csv';
  a.click();
}

// ══════════════════════════════════════════════════════════════════
//  LLM — BUILD PROMPT & CALL OLLAMA
// ══════════════════════════════════════════════════════════════════

function buildPrompt(transcript, project, date, location, agenda, scheduleRows) {
  const agendaSection = agenda.trim()
    ? `\nMEETING AGENDA (cross-reference which items were covered):\n${agenda.trim()}\n`
    : '';

  const promptScheduleRows = scheduleRows.slice(0, MAX_SCHEDULE_ROWS_FOR_PROMPT + 1);
  const omittedScheduleRows = Math.max(0, scheduleRows.length - promptScheduleRows.length);
  const scheduleSection = scheduleRows.length > 1
    ? `\nPROJECT SCHEDULE (identify tasks impacted by blockers or decisions):\n${promptScheduleRows.map(r => r.join(' | ')).join('\n')}${omittedScheduleRows ? `\n... ${omittedScheduleRows} additional schedule row(s) omitted from prompt for length.` : ''}\n`
    : '';

  return `You are a construction project management assistant creating site meeting minutes and an action tracker.

Goal: extract decisions, blockers, responsibilities, due dates, agenda coverage, and schedule impacts from a construction meeting transcript.

Return ONLY a raw JSON object. No explanation. No markdown. No backticks. Just JSON.

JSON structure:
{
  "summary": "2-3 sentence meeting summary",
  "attendees": ["Name (Role)"],
  "decisions": [{"text": "decision made", "context": "reason or context"}],
  "blockers": [{"text": "blocker description", "impact": "impact on project"}],
  "actions": [{"id": 1, "action": "task", "owner": "name", "due_date": "date or TBD", "priority": "high|medium|low"}],
  "agenda_coverage": [{"item": "agenda item text", "covered": true or false, "note": "brief note"}],
  "schedule_impacts": [{"task": "task name from schedule", "impact": "how it is affected", "severity": "high|medium|low"}],
  "next_meeting": "date and time or empty string"
}

Rules:
- Treat each action item as a responsibility. Include the owner and due_date exactly when stated; use "TBD" only when missing.
- Do not invent people, due dates, decisions, or blockers.
- Mark blockers that can delay site work, procurement, safety, budget approval, or schedule milestones.
- Link schedule_impacts to the closest task name in the schedule when a decision or blocker affects planned work.
- Use high priority/severity for critical path delays, safety issues, budget escalation, or urgent procurement.
If no agenda was provided, return agenda_coverage as [].
If no schedule was provided, return schedule_impacts as [].

Project: ${project}
Date: ${date}
Location: ${location}
${agendaSection}${scheduleSection}
TRANSCRIPT:
${transcript}

JSON:`;
}

async function callOllama(prompt) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.1, num_ctx: 4096, num_predict: 2048 }
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS)
    });

    if (!res.ok) {
      const details = await res.text().catch(() => '');
      throw new Error(`Ollama returned HTTP ${res.status}${details ? `: ${details.slice(0, 180)}` : ''}`);
    }

    const data = await res.json();
    return data.response || '';
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Ollama timed out after ${Math.round(OLLAMA_TIMEOUT_MS / 1000)} seconds. Shorten the transcript or try again after the model finishes loading.`);
    }
    if (err instanceof TypeError) {
      throw new Error('Cannot reach Ollama. Start it with: OLLAMA_ORIGINS=* ollama serve');
    }
    throw err;
  }
}

function parseResponse(raw) {
  if (!raw || !raw.trim()) throw new Error('Empty model response. Try again.');
  let clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    // Some smaller local models still wrap JSON in text. Extract the object.
  }
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in model response. Try again.');
  clean = clean.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(clean);
}

function formatAnalyzeError(err) {
  const msg = String(err?.message || err || 'Analysis failed.');
  if (msg.toLowerCase().includes('model') && msg.toLowerCase().includes('not found')) {
    return `The ${LLM_MODEL} model is not installed. Run: ollama pull ${LLM_MODEL}`;
  }
  if (msg.toLowerCase().includes('json')) {
    return `${msg} Try again, or shorten the transcript so the model can stay inside the JSON schema.`;
  }
  return msg;
}

// ══════════════════════════════════════════════════════════════════
//  MAIN ANALYZE
// ══════════════════════════════════════════════════════════════════

async function analyzeTranscript() {
  const transcript = document.getElementById('transcript').value.trim();
  if (!transcript) { showError('Please paste or transcribe a meeting transcript first.'); return; }
  hideError();

  const project  = document.getElementById('project-name').value    || 'Construction Project';
  const date     = document.getElementById('meeting-date').value     || 'N/A';
  const location = document.getElementById('meeting-location').value || 'N/A';
  const agenda   = document.getElementById('agenda-input').value     || '';

  const btn = document.getElementById('analyze-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;margin-right:6px;vertical-align:-3px"></span> Analyzing…';

  showTab('minutes');
  document.getElementById('minutes-empty').classList.add('hidden');
  document.getElementById('minutes-loading').innerHTML = LOADING_HTML;
  document.getElementById('minutes-loading').classList.remove('hidden');
  document.getElementById('minutes-content').classList.add('hidden');

  try {
    const prompt = buildPrompt(transcript, project, date, location, agenda, csvSchedule);
    const raw    = await callOllama(prompt);
    parsedData   = enrichAnalysisData(normalizeAnalysisData(parseResponse(raw)), transcript, agenda, csvSchedule);

    renderMinutes(parsedData, project, date, location);
    renderTracker(parsedData);
    renderScheduleImpact(parsedData);

  } catch (err) {
    const message = formatAnalyzeError(err);
    document.getElementById('minutes-loading').innerHTML = `
      <i class="ti ti-alert-circle" style="font-size:32px;color:var(--danger);margin-bottom:12px"></i>
      <p style="color:var(--danger)">${escapeHtml(message)}</p>
      <small>Check that Ollama is running and that <code>${LLM_MODEL}</code> is installed.</small>
      <br>
      <button class="btn-outline" style="margin-top:14px" onclick="analyzeTranscript()"><i class="ti ti-sparkles"></i> Retry Analysis</button>
      <button class="btn-outline" style="margin-top:14px" onclick="showTab('input')"><i class="ti ti-arrow-left"></i> Back to Input</button>
    `;
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="ti ti-sparkles"></i> Analyze Meeting';
}

// ══════════════════════════════════════════════════════════════════
//  RENDER — MINUTES
// ══════════════════════════════════════════════════════════════════

function renderMinutes(d, project, date, location) {
  document.getElementById('minutes-empty').classList.add('hidden');
  document.getElementById('minutes-loading').classList.add('hidden');
  document.getElementById('minutes-content').classList.remove('hidden');

  // Metrics
  const coveredCount = d.agenda_coverage.filter(a => a.covered).length;
  const missedCount  = d.agenda_coverage.filter(a => !a.covered).length;
  document.getElementById('metrics-row').innerHTML = `
    <div class="metric"><div class="metric-label">Actions</div><div class="metric-val">${d.actions.length}</div></div>
    <div class="metric"><div class="metric-label">Decisions</div><div class="metric-val">${d.decisions.length}</div></div>
    <div class="metric"><div class="metric-label">Blockers</div><div class="metric-val">${d.blockers.length}</div></div>
    <div class="metric"><div class="metric-label">Attendees</div><div class="metric-val">${d.attendees.length}</div></div>
    <div class="metric"><div class="metric-label">Missed Items</div><div class="metric-val" style="color:${missedCount>0?'var(--warning)':'var(--success)'}">${missedCount}</div></div>
  `;

  // Header & summary
  document.getElementById('summary-block').innerHTML = `
    <div class="meeting-header">
      <div>
        <div class="meeting-title">${escapeHtml(project)}</div>
        <div class="meeting-meta">
          <span><i class="ti ti-calendar"></i>${escapeHtml(date)}</span>
          <span><i class="ti ti-map-pin"></i>${escapeHtml(location)}</span>
        </div>
      </div>
      ${d.next_meeting ? `<div class="next-badge"><i class="ti ti-clock" style="font-size:11px;margin-right:4px"></i>Next: ${escapeHtml(d.next_meeting)}</div>` : ''}
    </div>
    <p class="summary-text">${escapeHtml(d.summary)}</p>
    <div class="attendee-chips">${d.attendees.map(a => `<span class="chip">${escapeHtml(a)}</span>`).join('')}</div>
  `;

  // Agenda coverage (NEW)
  if (d.agenda_coverage.length) {
    document.getElementById('agenda-gaps-block').innerHTML = `
      <div class="section-block">
        <div class="section-label">Agenda Coverage</div>
        ${d.agenda_coverage.map(item => `
          <div class="item-row">
            <span class="badge ${item.covered ? 'badge-covered' : 'badge-missed'}">${item.covered ? 'Covered' : 'Missed'}</span>
            <div class="item-text">${escapeHtml(item.item)}
              ${item.note ? `<div class="item-sub">${escapeHtml(item.note)}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>`;
  } else {
    document.getElementById('agenda-gaps-block').innerHTML = '';
  }

  // Decisions
  document.getElementById('decisions-block').innerHTML = d.decisions.length ? `
    <div class="section-block">
      <div class="section-label">Decisions Made</div>
      ${d.decisions.map(dec => `
        <div class="item-row">
          <span class="badge badge-decision">Decision</span>
          <div class="item-text">${escapeHtml(dec.text)}
            ${dec.context ? `<div class="item-sub">${escapeHtml(dec.context)}</div>` : ''}
          </div>
        </div>`).join('')}
    </div>` : '';

  // Blockers
  document.getElementById('blockers-block').innerHTML = d.blockers.length ? `
    <div class="section-block">
      <div class="section-label">Blockers &amp; Risks</div>
      ${d.blockers.map(b => `
        <div class="item-row">
          <span class="badge badge-blocker">Blocker</span>
          <div class="item-text">${escapeHtml(b.text)}
            ${b.impact ? `<div class="item-sub">Impact: ${escapeHtml(b.impact)}</div>` : ''}
          </div>
        </div>`).join('')}
    </div>` : '';
}

// ══════════════════════════════════════════════════════════════════
//  RENDER — ACTION TRACKER
// ══════════════════════════════════════════════════════════════════

function renderTracker(d) {
  if (!d.actions.length) {
    document.getElementById('tracker-content').classList.add('hidden');
    document.getElementById('tracker-empty').classList.remove('hidden');
    return;
  }

  document.getElementById('tracker-empty').classList.add('hidden');
  document.getElementById('tracker-content').classList.remove('hidden');
  const pc = { high: 'priority-high', medium: 'priority-medium', low: 'priority-low' };
  document.getElementById('action-tbody').innerHTML = d.actions.map((a, i) => `
    <tr>
      <td class="num-cell">${i + 1}</td>
      <td>${escapeHtml(a.action)}</td>
      <td style="color:var(--text-secondary);white-space:nowrap">${escapeHtml(a.owner || 'TBD')}</td>
      <td style="color:var(--text-secondary);white-space:nowrap">${escapeHtml(a.due_date || 'TBD')}</td>
      <td><span class="${pc[a.priority] || 'priority-medium'}">${escapeHtml(a.priority || 'medium')}</span></td>
      <td><span class="status-open"><i class="ti ti-circle-dashed"></i> Open</span></td>
    </tr>`).join('');
}

// ══════════════════════════════════════════════════════════════════
//  RENDER — SCHEDULE IMPACT (NEW)
// ══════════════════════════════════════════════════════════════════

function renderScheduleImpact(d) {
  const hasSchedule = csvSchedule.length > 1;
  const hasImpacts  = d.schedule_impacts && d.schedule_impacts.length > 0;

  if (!hasSchedule && !hasImpacts) {
    document.getElementById('schedule-empty').classList.remove('hidden');
    document.getElementById('schedule-impact-content').classList.add('hidden');
    return;
  }

  document.getElementById('schedule-empty').classList.add('hidden');
  document.getElementById('schedule-impact-content').classList.remove('hidden');

  // Impact summary cards
  const impactHtml = hasImpacts
    ? d.schedule_impacts.map(imp => `
        <div class="item-row">
          <span class="badge ${imp.severity === 'high' ? 'badge-risk' : imp.severity === 'medium' ? 'badge-impacted' : 'badge-ok'}">
            ${imp.severity || 'medium'}
          </span>
          <div class="item-text"><strong>${escapeHtml(imp.task)}</strong>
            <div class="item-sub">${escapeHtml(imp.impact)}</div>
          </div>
        </div>`).join('')
    : '<p style="font-size:13px;color:var(--text-tertiary)">No schedule impacts detected.</p>';

  document.getElementById('schedule-impact-body').innerHTML = impactHtml;

  // Full schedule table with risk flags
  if (hasSchedule) {
    const rows    = csvSchedule.slice(1);

    document.getElementById('schedule-tbody').innerHTML = rows.map((row, i) => {
      const taskName = row[0] || '';
      const impactDetail = findMatchingScheduleImpact(taskName, d.schedule_impacts || []);
      const isImpacted = Boolean(impactDetail);

      const flagCell = isImpacted
        ? `<span class="badge ${impactDetail?.severity === 'high' ? 'badge-risk' : 'badge-impacted'}">⚠ ${impactDetail?.severity || 'impacted'}</span>`
        : `<span class="badge badge-ok">✓ OK</span>`;

      return `<tr${isImpacted ? ' style="background:var(--warning-light)"' : ''}>
        <td class="num-cell">${i + 1}</td>
        ${row.map(c => `<td>${escapeHtml(c)}</td>`).join('')}
        <td>${flagCell}</td>
      </tr>`;
    }).join('');
  }
}

// ══════════════════════════════════════════════════════════════════
//  COPY HELPERS
// ══════════════════════════════════════════════════════════════════

function findMatchingScheduleImpact(taskName, impacts) {
  const normalizedTask = normalizeMatchText(taskName);
  if (!normalizedTask) return null;

  const exact = impacts.find(impact => {
    const normalizedImpact = normalizeMatchText(impact.task);
    return normalizedImpact && (normalizedTask.includes(normalizedImpact) || normalizedImpact.includes(normalizedTask));
  });
  if (exact) return exact;

  const taskTokens = meaningfulTokens(taskName);
  return impacts.find(impact => {
    const impactTokens = meaningfulTokens(impact.task);
    if (!taskTokens.length || !impactTokens.length) return false;
    const matches = impactTokens.filter(token => taskTokens.includes(token)).length;
    const ratio = matches / Math.min(taskTokens.length, impactTokens.length);
    return matches >= 2 || ratio >= 0.6;
  }) || null;
}

function normalizeMatchText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function meaningfulTokens(value) {
  const stopWords = new Set(['and', 'the', 'for', 'with', 'work', 'task', 'site', 'zone', 'block', 'date', 'owner', 'status']);
  return normalizeMatchText(value).split(' ').filter(token => token.length > 2 && !stopWords.has(token));
}

function copyMinutes() {
  if (!parsedData) return;
  navigator.clipboard.writeText(buildMinutesText(parsedData))
    .then(() => alert('Minutes copied to clipboard!'));
  return;

  const d = parsedData;
  const project  = document.getElementById('project-name').value;
  const date     = document.getElementById('meeting-date').value;
  const location = document.getElementById('meeting-location').value;
  const chaired  = document.getElementById('chaired-by').value;

  const agendaLines = d.agenda_coverage.length
    ? ['\n── AGENDA COVERAGE ──────────────────────────────',
       ...d.agenda_coverage.map(a => `${a.covered ? '✓' : '✗'} ${a.item}${a.note ? ' — ' + a.note : ''}`)]
    : [];

  const lines = [
    '╔══════════════════════════════════════════╗',
    '   SITE MEETING MINUTES',
    '╚══════════════════════════════════════════╝',
    `Project  : ${project}`,
    `Date     : ${date}`,
    `Location : ${location}`,
    `Chaired  : ${chaired}`,
    '',
    '── SUMMARY ──────────────────────────────────',
    d.summary,
    '',
    '── ATTENDEES ────────────────────────────────',
    d.attendees.join(' · '),
    ...agendaLines,
    '',
    '── DECISIONS ────────────────────────────────',
    ...d.decisions.map((x, i) => `${i+1}. ${x.text}`),
    '',
    '── BLOCKERS ─────────────────────────────────',
    ...d.blockers.map((x, i) => `${i+1}. ${x.text}  [Impact: ${x.impact}]`),
    '',
    '── ACTION ITEMS ─────────────────────────────',
    ...d.actions.map(a => `${a.id}. ${a.action}\n   Owner: ${a.owner}  |  Due: ${a.due_date}  |  Priority: ${a.priority}`),
    '',
    d.next_meeting ? `── NEXT MEETING: ${d.next_meeting}` : '',
  ];
  navigator.clipboard.writeText(lines.join('\n'))
    .then(() => alert('Minutes copied to clipboard!'));
}

function copyTracker() {
  if (!parsedData) return;
  const header = '#\tAction\tOwner\tDue Date\tPriority\tStatus';
  const rows   = parsedData.actions.map(a =>
    `${a.id}\t${a.action}\t${a.owner}\t${a.due_date}\t${a.priority}\tOpen`);
  navigator.clipboard.writeText([header, ...rows].join('\n'))
    .then(() => alert('Action tracker copied! Paste into Excel or Sheets.'));
}

function copyScheduleImpact() {
  if (!parsedData) return;
  navigator.clipboard.writeText(buildScheduleImpactText(parsedData))
    .then(() => alert('Schedule impact report copied!'));
}

// ══════════════════════════════════════════════════════════════════
//  DEMO & CLEAR
// ══════════════════════════════════════════════════════════════════

function downloadMinutes() {
  if (!parsedData) return;
  downloadFile(reportFilename('minutes', 'txt'), buildMinutesText(parsedData), 'text/plain');
}

function downloadTrackerCsv() {
  if (!parsedData) return;
  downloadFile(reportFilename('action-tracker', 'csv'), buildTrackerCsv(parsedData), 'text/csv');
}

function downloadScheduleImpactReport() {
  if (!parsedData) return;
  downloadFile(reportFilename('schedule-impact', 'txt'), buildScheduleImpactText(parsedData), 'text/plain');
}

function buildMinutesText(d) {
  const context = getMeetingContext();
  return [
    'SITE MEETING MINUTES',
    '',
    `Project: ${context.project}`,
    `Date: ${context.date}`,
    `Location: ${context.location}`,
    `Chaired by: ${context.chaired}`,
    '',
    'SUMMARY',
    d.summary || 'No summary returned.',
    '',
    'ATTENDEES',
    d.attendees.length ? d.attendees.join(', ') : 'None recorded.',
    '',
    'AGENDA COVERAGE',
    ...formatAgendaCoverage(d.agenda_coverage),
    '',
    'DECISIONS',
    ...formatNumberedList(d.decisions, item => `${item.text}${item.context ? ` (${item.context})` : ''}`),
    '',
    'BLOCKERS',
    ...formatNumberedList(d.blockers, item => `${item.text}${item.impact ? ` Impact: ${item.impact}` : ''}`),
    '',
    'ACTION TRACKER',
    ...formatActionLines(d.actions),
    '',
    d.next_meeting ? `NEXT MEETING: ${d.next_meeting}` : 'NEXT MEETING: Not recorded',
  ].join('\n');
}

function buildTrackerCsv(d) {
  const rows = [
    ['ID', 'Action', 'Owner', 'Due Date', 'Priority', 'Status'],
    ...d.actions.map((action, index) => [
      action.id || index + 1,
      action.action,
      action.owner || 'TBD',
      action.due_date || 'TBD',
      action.priority || 'medium',
      action.status || 'Open',
    ]),
  ];
  return scheduleToCsv(rows);
}

function buildScheduleImpactText(d) {
  const impactLines = (d.schedule_impacts || []).length
    ? d.schedule_impacts.map((impact, index) => `${index + 1}. [${(impact.severity || 'medium').toUpperCase()}] ${impact.task} - ${impact.impact || 'Impact not specified.'}`)
    : ['No schedule impacts detected.'];

  const scheduleLines = csvSchedule.length > 1
    ? [
        '',
        'FULL SCHEDULE WITH RISK FLAGS',
        ...csvSchedule.slice(1).map((row, index) => {
          const impact = findMatchingScheduleImpact(row[0], d.schedule_impacts || []);
          const flag = impact ? `${(impact.severity || 'medium').toUpperCase()} risk` : 'OK';
          return `${index + 1}. ${row[0]} | Owner: ${row[1]} | Start: ${row[2]} | End: ${row[3]} | Status: ${row[4]} | Flag: ${flag}`;
        }),
      ]
    : ['', 'No schedule CSV was loaded.'];

  return [
    'SCHEDULE IMPACT REPORT',
    '',
    ...impactLines,
    ...scheduleLines,
  ].join('\n');
}

function formatAgendaCoverage(items) {
  return items.length
    ? items.map(item => `[${item.covered ? 'Covered' : 'Missed'}] ${item.item}${item.note ? ` - ${item.note}` : ''}`)
    : ['No agenda was provided.'];
}

function formatNumberedList(items, formatter) {
  return items.length ? items.map((item, index) => `${index + 1}. ${formatter(item)}`) : ['None recorded.'];
}

function formatActionLines(actions) {
  return actions.length
    ? actions.map((action, index) => `${index + 1}. ${action.action} | Owner: ${action.owner || 'TBD'} | Due: ${action.due_date || 'TBD'} | Priority: ${action.priority || 'medium'} | Status: ${action.status || 'Open'}`)
    : ['None recorded.'];
}

function getMeetingContext() {
  return {
    project: document.getElementById('project-name').value || 'Construction Project',
    date: document.getElementById('meeting-date').value || 'N/A',
    location: document.getElementById('meeting-location').value || 'N/A',
    chaired: document.getElementById('chaired-by').value || 'N/A',
  };
}

function reportFilename(kind, extension) {
  const project = getMeetingContext().project;
  const slug = String(project || 'site-meeting')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'site-meeting';
  return `${slug}-${kind}.${extension}`;
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadDemo() {
  document.getElementById('project-name').value     = 'Prestige Tower — Block B';
  document.getElementById('meeting-date').value     = '11 June 2026';
  document.getElementById('meeting-location').value = 'Level 4 Site Office';
  document.getElementById('chaired-by').value       = 'Ravi Kumar (Project Manager)';

  document.getElementById('agenda-input').value = `1. Review of previous action items
2. Zone A concrete pour — status update
3. Zone B rebar delivery — supplier update
4. Safety inspection preparation
5. Budget review — civil works overrun
6. Subcontractor coordination update
7. AOB / Next steps`;
  document.getElementById('agenda-status').classList.remove('hidden');
  csvSchedule = SAMPLE_SCHEDULE.map(row => [...row]);
  csvWarnings = [];
  document.getElementById('csv-filename').textContent = 'sample-project-schedule.csv (8 tasks)';
  document.getElementById('csv-drop-zone').classList.add('hidden');
  document.getElementById('csv-preview').classList.remove('hidden');
  renderCsvPreview(csvSchedule);

  document.getElementById('transcript').value = `Meeting commenced at 10:00 AM.
Present: Ravi Kumar (PM), Sarah Menon (Civil Lead), Priya Nair (Procurement), Mohan Das (Site Engineer), Ahmed Sheikh (Safety Officer).

1. Ravi reviewed last week's action items — all closed.

2. Sarah confirmed Zone A concrete pour is fully complete and signed off by the structural consultant. Milestone achieved ahead of schedule.

3. Critical concern: rebar delivery from Sunrise Steel delayed by 2 weeks due to logistics issues. This is a major blocker for Zone B foundation work scheduled to begin 18 June. Decision: explore alternate suppliers immediately. Action: Priya to contact 3 backup rebar suppliers and present cost and timeline comparison by 15 June 2026. High priority.

4. Ahmed confirmed Friday safety inspection is on track. Action: Mohan to prepare complete safety checklist and submit to Ahmed by 13 June 2026.

5. Budget overrun of Rs.4.2 lakhs on civil works due to unforeseen soil conditions. Decision: escalate to project board for additional funds. Action: Ravi to prepare budget variance report for project board by 14 June 2026.

6. Subcontractor coordination was not discussed — carried forward to next meeting.

7. Sarah flagged shuttering material running low. Action: Priya to raise purchase order by 12 June 2026.

Next meeting: 18 June 2026 at 10:00 AM.`;
}

function clearAll() {
  ['project-name','meeting-date','meeting-location','chaired-by'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('transcript').value    = '';
  document.getElementById('agenda-input').value  = '';
  document.getElementById('agenda-status').classList.add('hidden');
  removeAudio();
  removeCsv();
  hideError();
  parsedData   = null;
  csvSchedule  = [];
  document.getElementById('minutes-loading').innerHTML = LOADING_HTML;
  document.getElementById('minutes-loading').classList.add('hidden');
  document.getElementById('minutes-empty').classList.remove('hidden');
  document.getElementById('minutes-content').classList.add('hidden');
  document.getElementById('tracker-content').classList.add('hidden');
  document.getElementById('tracker-empty').classList.remove('hidden');
  document.getElementById('schedule-impact-content').classList.add('hidden');
  document.getElementById('schedule-empty').classList.remove('hidden');
  document.getElementById('metrics-row').innerHTML = '';
  document.getElementById('action-tbody').innerHTML = '';
  document.getElementById('schedule-tbody').innerHTML = '';
}

// ══════════════════════════════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════════════════════════════

function showError(msg) {
  const box = document.getElementById('error-box');
  box.removeAttribute('style');
  document.getElementById('error-msg').textContent = msg;
  box.classList.remove('hidden');
}
function hideError()   { document.getElementById('error-box').classList.add('hidden'); }
function showSuccess(msg) {
  // Briefly show a success toast
  const box = document.getElementById('error-box');
  box.style.background = 'var(--success-light)';
  box.style.borderColor = '#6EE7B7';
  box.style.color = 'var(--success)';
  document.getElementById('error-msg').textContent = msg;
  box.classList.remove('hidden');
  setTimeout(() => {
    box.classList.add('hidden');
    box.removeAttribute('style');
  }, 4000);
}

function normalizeAnalysisData(data) {
  const normalized = data && typeof data === 'object' ? data : {};
  normalized.summary = normalized.summary || 'No summary returned.';
  normalized.next_meeting = normalized.next_meeting || '';

  normalized.attendees = asArray(normalized.attendees).map(value => String(value || '').trim()).filter(Boolean);
  normalized.decisions = asArray(normalized.decisions).map(item => ({
    text: item?.text || item?.decision || String(item || ''),
    context: item?.context || ''
  })).filter(item => item.text);
  normalized.blockers = asArray(normalized.blockers).map(item => ({
    text: item?.text || item?.blocker || String(item || ''),
    impact: item?.impact || ''
  })).filter(item => item.text);
  normalized.actions = asArray(normalized.actions).map((item, index) => ({
    id: index + 1,
    action: item?.action || item?.task || item?.text || String(item || ''),
    owner: item?.owner || item?.responsible || item?.responsibility || item?.assignee || item?.person_responsible || 'TBD',
    due_date: normalizeDueDate(item?.due_date || item?.due || item?.deadline || item?.target_date || 'TBD'),
    priority: normalizePriority(item?.priority),
    status: item?.status || 'Open',
  })).filter(item => item.action);
  normalized.agenda_coverage = asArray(normalized.agenda_coverage).map(item => ({
    item: item?.item || item?.agenda_item || String(item || ''),
    covered: Boolean(item?.covered),
    note: item?.note || ''
  })).filter(item => item.item);
  normalized.schedule_impacts = asArray(normalized.schedule_impacts).map(item => ({
    task: item?.task || item?.task_name || String(item || ''),
    impact: item?.impact || '',
    severity: normalizePriority(item?.severity)
  })).filter(item => item.task);

  return normalized;
}

function enrichAnalysisData(data, transcript, agenda, scheduleRows) {
  const enriched = {
    ...data,
    attendees: [...data.attendees],
    decisions: [...data.decisions],
    blockers: [...data.blockers],
    actions: [...data.actions],
    agenda_coverage: [...data.agenda_coverage],
    schedule_impacts: [...data.schedule_impacts],
  };

  const attendeeNames = extractAttendeesFromTranscript(transcript);
  mergeUniqueStrings(enriched.attendees, attendeeNames);
  const ownerMap = buildOwnerMap(enriched.attendees);
  const sentences = splitMeetingSentences(transcript);

  const explicitDecisions = extractExplicitDecisions(sentences);
  mergeUniqueObjects(enriched.decisions, explicitDecisions, item => item.text);

  const explicitActions = extractExplicitActions(sentences, ownerMap);
  mergeUniqueObjects(enriched.actions, explicitActions, item => `${item.action} ${item.owner} ${item.due_date}`);
  enriched.actions = dedupeActionItems(enriched.actions);

  const explicitBlockers = extractExplicitBlockers(sentences);
  mergeUniqueObjects(enriched.blockers, explicitBlockers, item => item.text);

  if (!enriched.next_meeting) {
    enriched.next_meeting = extractNextMeeting(transcript);
  }

  const agendaItems = parseAgendaItems(agenda);
  if (agendaItems.length) {
    enriched.agenda_coverage = deriveAgendaCoverage(agendaItems, transcript);
  }

  const scheduleImpacts = deriveScheduleImpactsFromTranscript(transcript, scheduleRows, enriched.blockers);
  mergeUniqueObjects(enriched.schedule_impacts, scheduleImpacts, item => item.task);
  enriched.schedule_impacts = canonicalizeScheduleImpacts(enriched.schedule_impacts, scheduleRows);

  return enriched;
}

function extractAttendeesFromTranscript(transcript) {
  const match = String(transcript || '').match(/\bPresent:\s*([^\n.]+)/i);
  if (!match) return [];
  return match[1]
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
}

function buildOwnerMap(attendees) {
  return attendees.reduce((map, attendee) => {
    const name = String(attendee || '').replace(/\s*\([^)]*\)\s*/g, '').trim();
    if (!name) return map;
    const firstName = name.split(/\s+/)[0].toLowerCase();
    map[firstName] = name;
    map[name.toLowerCase()] = name;
    return map;
  }, {});
}

function splitMeetingSentences(transcript) {
  return String(transcript || '')
    .replace(/\r/g, '')
    .split(/\n+/)
    .flatMap(line => line.match(/[^.!?]+[.!?]?/g) || [])
    .map(sentence => sentence.trim().replace(/^\d+\.\s*/, ''))
    .filter(Boolean);
}

function extractExplicitDecisions(sentences) {
  return sentences
    .filter(sentence => /\bDecision:/i.test(sentence))
    .map(sentence => ({
      text: cleanTrailingPriority(sentence.replace(/^.*?\bDecision:\s*/i, '')),
      context: '',
    }))
    .filter(item => item.text);
}

function extractExplicitActions(sentences, ownerMap) {
  const actions = [];
  sentences.forEach((sentence, index) => {
    if (!/\bAction:/i.test(sentence)) return;

    const rawAction = cleanTrailingPriority(sentence.replace(/^.*?\bAction:\s*/i, ''));
    const nextSentence = sentences[index + 1] || '';
    const priority = inferPriority(`${sentence} ${nextSentence}`);
    const dueDate = extractDueDate(rawAction);
    const parsed = parseOwnerAndAction(rawAction, ownerMap);

    actions.push({
      id: actions.length + 1,
      action: parsed.action,
      owner: parsed.owner,
      due_date: dueDate,
      priority,
      status: 'Open',
    });
  });
  return actions.filter(item => item.action);
}

function parseOwnerAndAction(rawAction, ownerMap) {
  const text = rawAction.replace(/\s+/g, ' ').trim();
  const match = text.match(/^([A-Z][A-Za-z .'-]+?)\s+(?:to|must|should|will)\s+(.+)$/);
  if (!match) {
    return { owner: 'TBD', action: sentenceCase(removeDueDate(text)) };
  }

  const ownerText = match[1].trim();
  const firstName = ownerText.split(/\s+/)[0].toLowerCase();
  const owner = ownerMap[ownerText.toLowerCase()] || ownerMap[firstName] || ownerText;
  return { owner, action: sentenceCase(removeDueDate(match[2])) };
}

function extractDueDate(text) {
  const match = String(text || '').match(/\bby\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})\b/i);
  return match ? match[1] : 'TBD';
}

function removeDueDate(text) {
  return String(text || '').replace(/\s+by\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}\b\.?/i, '').trim();
}

function cleanTrailingPriority(text) {
  return String(text || '')
    .replace(/\b(high|medium|low)\s+priority\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[.;]\s*$/, '')
    .trim();
}

function inferPriority(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(high priority|critical|urgent|immediately|major blocker|safety|delay|delayed|overrun)\b/.test(lower)) return 'high';
  if (/\b(low priority)\b/.test(lower)) return 'low';
  return 'medium';
}

function extractExplicitBlockers(sentences) {
  return sentences
    .filter(sentence => /\b(blocker|delayed|delay|overrun|running low|shortage|critical concern)\b/i.test(sentence))
    .map(sentence => ({
      text: cleanTrailingPriority(sentence),
      impact: inferBlockerImpact(sentence),
    }))
    .filter(item => item.text);
}

function inferBlockerImpact(sentence) {
  const lower = String(sentence || '').toLowerCase();
  if (lower.includes('foundation')) return 'May delay Zone B foundation work.';
  if (lower.includes('budget') || lower.includes('overrun')) return 'May require project board approval or additional funds.';
  if (lower.includes('shuttering') || lower.includes('running low')) return 'May disrupt upcoming site work if procurement is not completed.';
  if (lower.includes('safety')) return 'May affect inspection readiness.';
  return '';
}

function extractNextMeeting(transcript) {
  const match = String(transcript || '').match(/\bNext meeting:\s*([^\n.]+)/i);
  return match ? match[1].trim() : '';
}

function parseAgendaItems(agenda) {
  return String(agenda || '')
    .split(/\n+/)
    .map(line => line.replace(/^\s*(?:\d+[\).]|[-*])\s*/, '').trim())
    .filter(Boolean);
}

function deriveAgendaCoverage(agendaItems, transcript) {
  const transcriptText = normalizeMatchText(transcript);
  return agendaItems.map(item => {
    const itemText = normalizeMatchText(item);
    const tokens = meaningfulTokens(item).filter(token => token.length > 3);
    const tokenMatches = tokens.filter(token => transcriptText.includes(token)).length;
    const missed = transcriptText.includes(`${itemText} was not discussed`) ||
      (tokens.includes('subcontractor') && transcriptText.includes('subcontractor') && transcriptText.includes('not discussed'));
    const isNextSteps = /\baob\b|next steps/i.test(item);
    const nextStepsCovered = isNextSteps && (/\bnext meeting\b/i.test(transcript) || /\brunning low|purchase order|aob\b/i.test(transcript));
    return {
      item,
      covered: !missed && (nextStepsCovered || tokenMatches >= Math.min(2, tokens.length) || transcriptText.includes(itemText)),
      note: missed ? 'Carried forward or not discussed.' : '',
    };
  });
}

function deriveScheduleImpactsFromTranscript(transcript, scheduleRows, blockers) {
  if (!scheduleRows || scheduleRows.length < 2) return [];

  const transcriptText = normalizeMatchText(transcript);
  const blockerText = normalizeMatchText(blockers.map(blocker => blocker.text).join(' '));
  return scheduleRows.slice(1).map(row => {
    const task = row[0] || '';
    const taskText = normalizeMatchText(task);
    const tokens = meaningfulTokens(task);
    const tokenHits = tokens.filter(token => transcriptText.includes(token)).length;
    const hasTaskMention = transcriptText.includes(taskText) || tokenHits >= Math.min(2, tokens.length);

    if (!hasTaskMention) return null;

    if (taskText.includes('rebar') && /\bdelay|delayed|blocker\b/.test(transcriptText)) {
      return { task, impact: 'Rebar delivery delay can hold up dependent Zone B work.', severity: 'high' };
    }
    if (taskText.includes('foundation') && transcriptText.includes('rebar') && /\bdelay|delayed|blocker\b/.test(transcriptText)) {
      return { task, impact: 'Foundation start may slip because rebar delivery is delayed.', severity: 'high' };
    }
    if (taskText.includes('shuttering') && /\brunning low|shortage|purchase order\b/.test(transcriptText)) {
      return { task, impact: 'Material is running low and needs purchase-order follow-up.', severity: 'medium' };
    }
    if (taskText.includes('project board') && /\bbudget|overrun|additional funds|escalate\b/.test(transcriptText)) {
      return { task, impact: 'Budget escalation needs board review and funding approval.', severity: 'medium' };
    }
    if (blockerText && tokens.filter(token => blockerText.includes(token)).length >= 2) {
      return { task, impact: 'Task is mentioned in a blocker or risk discussion.', severity: 'medium' };
    }
    return null;
  }).filter(Boolean);
}

function dedupeActionItems(actions) {
  const cleaned = [];
  actions.forEach(action => {
    const candidate = {
      ...action,
      due_date: normalizeDueDate(action.due_date),
      priority: normalizePriority(action.priority),
      status: action.status || 'Open',
    };
    const index = cleaned.findIndex(existing => areSimilarActionItems(existing, candidate));
    if (index === -1) {
      cleaned.push(candidate);
    } else {
      cleaned[index] = chooseBetterAction(cleaned[index], candidate);
    }
  });
  return cleaned.map((action, index) => ({ ...action, id: index + 1 }));
}

function areSimilarActionItems(a, b) {
  const aOwner = normalizeMatchText(a.owner);
  const bOwner = normalizeMatchText(b.owner);
  const sameOwner = aOwner && bOwner && (aOwner.includes(bOwner) || bOwner.includes(aOwner));
  const aDue = normalizeDueDate(a.due_date);
  const bDue = normalizeDueDate(b.due_date);
  const sameDue = aDue === bDue && aDue !== 'TBD';
  const overlap = tokenOverlap(a.action, b.action);
  return (sameOwner && overlap >= 0.35) || (sameDue && overlap >= 0.3) || overlap >= 0.65;
}

function chooseBetterAction(a, b) {
  return scoreAction(b) > scoreAction(a) ? b : a;
}

function scoreAction(action) {
  const dueScore = normalizeDueDate(action.due_date) === 'TBD' ? 0 : 20;
  const specificityScore = Math.min(20, meaningfulTokens(action.action).length * 3);
  const ownerScore = normalizeMatchText(action.owner) === 'tbd' ? 0 : 5;
  return dueScore + specificityScore + ownerScore;
}

function tokenOverlap(a, b) {
  const aTokens = meaningfulTokens(a);
  const bTokens = meaningfulTokens(b);
  if (!aTokens.length || !bTokens.length) return 0;
  const matches = aTokens.filter(token => bTokens.includes(token)).length;
  return matches / Math.min(aTokens.length, bTokens.length);
}

function canonicalizeScheduleImpacts(impacts, scheduleRows) {
  if (!scheduleRows || scheduleRows.length < 2) return impacts;

  const tasks = scheduleRows.slice(1).map(row => row[0]).filter(Boolean);
  const canonical = [];
  impacts.forEach(impact => {
    const task = findBestScheduleTask(impact.task, tasks);
    if (!task) return;
    const candidate = { ...impact, task, severity: normalizePriority(impact.severity) };
    const index = canonical.findIndex(existing => normalizeMatchText(existing.task) === normalizeMatchText(candidate.task));
    if (index === -1) {
      canonical.push(candidate);
    } else {
      canonical[index] = chooseHigherImpact(canonical[index], candidate);
    }
  });
  return canonical;
}

function findBestScheduleTask(impactTask, tasks) {
  const exact = tasks.find(task => {
    const normalizedTask = normalizeMatchText(task);
    const normalizedImpact = normalizeMatchText(impactTask);
    return normalizedImpact && (normalizedTask.includes(normalizedImpact) || normalizedImpact.includes(normalizedTask));
  });
  if (exact) return exact;

  let best = { task: '', score: 0 };
  tasks.forEach(task => {
    const score = tokenOverlap(task, impactTask);
    if (score > best.score) best = { task, score };
  });
  return best.score >= 0.5 ? best.task : '';
}

function chooseHigherImpact(a, b) {
  const rank = { low: 1, medium: 2, high: 3 };
  const aRank = rank[normalizePriority(a.severity)] || 2;
  const bRank = rank[normalizePriority(b.severity)] || 2;
  if (bRank !== aRank) return bRank > aRank ? b : a;
  return String(b.impact || '').length > String(a.impact || '').length ? b : a;
}

function mergeUniqueStrings(target, additions) {
  const seen = new Set(target.map(value => normalizeMatchText(value)));
  additions.forEach(value => {
    const key = normalizeMatchText(value);
    if (key && !seen.has(key)) {
      target.push(value);
      seen.add(key);
    }
  });
}

function mergeUniqueObjects(target, additions, keyFn) {
  const seen = new Set(target.map(item => normalizeMatchText(keyFn(item))));
  additions.forEach(item => {
    const key = normalizeMatchText(keyFn(item));
    if (key && !seen.has(key)) {
      target.push(item);
      seen.add(key);
    }
  });
}

function sentenceCase(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').replace(/[.;]\s*$/, '').trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : '';
}

function normalizeDueDate(value) {
  const text = String(value || '').trim();
  if (!text || /^tbd\b/i.test(text)) return 'TBD';
  const dateMatch = text.match(/\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\b/);
  return dateMatch ? dateMatch[0] : text;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePriority(value) {
  const priority = String(value || 'medium').toLowerCase();
  return ['high', 'medium', 'low'].includes(priority) ? priority : 'medium';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function scheduleToCsv(rows) {
  return rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
}

// ══════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  checkOllamaStatus();
  checkWhisperStatus();
  initAgendaMonitor();

  // Open all collapsible sections by default
  ['audio-section', 'agenda-section', 'schedule-section'].forEach(id => {
    document.getElementById(id).classList.remove('hidden');
    const icon = document.getElementById(id + '-icon');
    if (icon) icon.classList.add('open');
  });

  setInterval(checkOllamaStatus, 30000);
  setInterval(checkWhisperStatus, 30000);
});
