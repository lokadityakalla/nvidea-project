"""
Local Whisper transcription server for Site Meeting Copilot v2.
Runs on http://localhost:9000.

Install dependencies:
    pip install -r requirements.txt

Run:
    python whisper_server.py

Useful environment variables:
    WHISPER_MODEL=base
    WHISPER_DEVICE=cpu
    WHISPER_COMPUTE_TYPE=int8
    WHISPER_LANGUAGE=en
    MAX_AUDIO_MB=25
"""

from __future__ import annotations

import importlib.util
import os
import tempfile
import threading
from typing import Any

from flask import Flask, Response, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

app = Flask(__name__)
CORS(app)

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "en")
MAX_AUDIO_MB = int(os.environ.get("MAX_AUDIO_MB", "25"))
MAX_AUDIO_BYTES = MAX_AUDIO_MB * 1024 * 1024
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".ogg", ".webm", ".mp4"}

app.config["MAX_CONTENT_LENGTH"] = MAX_AUDIO_BYTES

model: Any = None
USE_FASTER_WHISPER: bool | None = None
model_lock = threading.Lock()


def module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def dependency_status() -> dict[str, bool]:
    return {
        "faster_whisper": module_available("faster_whisper"),
        "openai_whisper": module_available("whisper"),
    }


def selected_library() -> str:
    if USE_FASTER_WHISPER is True:
        return "faster-whisper"
    if USE_FASTER_WHISPER is False:
        return "openai-whisper"
    return "not loaded yet"


def requested_output() -> str:
    return (
        request.args.get("output")
        or request.form.get("output")
        or "txt"
    ).lower()


def error_response(message: str, status_code: int, detail: str | None = None):
    payload = {
        "status": "error",
        "message": message,
    }
    if detail:
        payload["detail"] = detail

    if requested_output() == "json":
        return jsonify(payload), status_code

    text = message if detail is None else f"{message}: {detail}"
    return Response(text, status=status_code, mimetype="text/plain")


def health_payload() -> dict[str, Any]:
    deps = dependency_status()
    ready = deps["faster_whisper"] or deps["openai_whisper"]
    return {
        "status": "ok" if ready else "missing_dependencies",
        "service": "site-meeting-copilot-whisper",
        "model": WHISPER_MODEL,
        "model_loaded": model is not None,
        "loaded": model is not None,
        "library": selected_library(),
        "available_libraries": deps,
        "device": WHISPER_DEVICE,
        "compute_type": WHISPER_COMPUTE_TYPE,
        "language": WHISPER_LANGUAGE,
        "max_audio_mb": MAX_AUDIO_MB,
        "supported_extensions": sorted(ALLOWED_EXTENSIONS),
    }


def load_model():
    """Load Whisper lazily so the Flask server starts immediately."""
    global model, USE_FASTER_WHISPER

    if model is not None:
        return model

    with model_lock:
        if model is not None:
            return model

        print(
            f"Loading Whisper model ({WHISPER_MODEL})... first run may take a few minutes",
            flush=True,
        )

        try:
            from faster_whisper import WhisperModel

            model = WhisperModel(
                WHISPER_MODEL,
                device=WHISPER_DEVICE,
                compute_type=WHISPER_COMPUTE_TYPE,
            )
            USE_FASTER_WHISPER = True
            print("[OK] faster-whisper model loaded successfully", flush=True)
        except ImportError:
            print("faster-whisper not found, trying openai-whisper...", flush=True)
            try:
                import whisper

                model = whisper.load_model(WHISPER_MODEL)
                USE_FASTER_WHISPER = False
                print("[OK] openai-whisper model loaded successfully", flush=True)
            except ImportError as exc:
                raise RuntimeError(
                    "No Whisper library found. Run: pip install -r requirements.txt"
                ) from exc

        return model


def extract_audio_file():
    audio_file = request.files.get("audio_file") or request.files.get("file")
    if audio_file is None or not audio_file.filename:
        return None, error_response("No audio file uploaded", 400)

    filename = secure_filename(audio_file.filename)
    extension = os.path.splitext(filename)[1].lower()
    if extension not in ALLOWED_EXTENSIONS:
        return None, error_response(
            "Unsupported audio format",
            400,
            f"Use one of: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    return audio_file, None


def normalize_language(language: str | None) -> str | None:
    if not language:
        language = WHISPER_LANGUAGE
    language = language.strip().lower()
    if language in {"auto", "detect", "none"}:
        return None
    return language


@app.errorhandler(RequestEntityTooLarge)
def handle_large_upload(_exc):
    return error_response(
        "Audio file too large",
        413,
        f"Maximum supported upload size is {MAX_AUDIO_MB} MB",
    )


@app.route("/", methods=["GET"])
@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint used by the browser before audio transcription."""
    payload = health_payload()
    status_code = 200 if payload["status"] == "ok" else 503
    return jsonify(payload), status_code


@app.route("/warmup", methods=["POST"])
def warmup():
    """Optional endpoint to load the model before the first transcription."""
    try:
        load_model()
        return jsonify(health_payload())
    except Exception as exc:
        print(f"[ERROR] Whisper warmup failed: {exc}", flush=True)
        return error_response("Whisper warmup failed", 500, str(exc))


@app.route("/asr", methods=["POST"])
def transcribe():
    """
    Transcription endpoint.
    Accepts multipart/form-data with an audio_file field.
    Returns plain text by default, or JSON when output=json is requested.
    """
    task = (request.args.get("task") or request.form.get("task") or "transcribe").lower()
    if task != "transcribe":
        return error_response("Unsupported task", 400, "Only task=transcribe is enabled")

    audio_file, validation_error = extract_audio_file()
    if validation_error:
        return validation_error

    suffix = os.path.splitext(secure_filename(audio_file.filename))[1].lower() or ".wav"
    tmp_path = None

    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            audio_file.save(tmp.name)
            tmp_path = tmp.name

        print(f"Transcribing: {secure_filename(audio_file.filename)}", flush=True)
        active_model = load_model()
        language = normalize_language(
            request.args.get("language") or request.form.get("language")
        )

        if USE_FASTER_WHISPER:
            segments, info = active_model.transcribe(
                tmp_path,
                language=language,
                beam_size=5,
                vad_filter=True,
            )
            transcript = " ".join(seg.text.strip() for seg in segments if seg.text)
            detected_language = getattr(info, "language", language)
            duration = getattr(info, "duration", None)
            if duration is not None:
                print(f"[OK] Transcribed {duration:.1f}s of audio", flush=True)
        else:
            result = active_model.transcribe(tmp_path, language=language, fp16=False)
            transcript = result.get("text", "")
            detected_language = result.get("language", language)
            duration = None

        transcript = transcript.strip()
        if requested_output() == "json":
            return jsonify(
                {
                    "status": "ok",
                    "text": transcript,
                    "language": detected_language,
                    "duration": duration,
                    "model": WHISPER_MODEL,
                    "library": selected_library(),
                }
            )

        return Response(transcript, mimetype="text/plain")

    except Exception as exc:
        print(f"[ERROR] Transcription error: {exc}", flush=True)
        return error_response("Transcription error", 500, str(exc))

    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    print("\nWhisper server starting on http://localhost:9000")
    print("Press Ctrl+C to stop\n")
    app.run(host="127.0.0.1", port=9000, debug=False)
