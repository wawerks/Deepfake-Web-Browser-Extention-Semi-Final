# ======================================================
# server.py — AI Image Detector Using SightEngine API
# ======================================================
from fastapi import FastAPI, File, UploadFile, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator
from PIL import Image
import io
import requests
import os
from typing import Dict, Any, Optional
from datetime import datetime
import csv
import json
from dotenv import load_dotenv

load_dotenv()
SIGHTENGINE_USER = os.getenv("SIGHTENGINE_USER")
SIGHTENGINE_SECRET = os.getenv("SIGHTENGINE_SECRET")

# ------------------------------------------------------
# LOGGING CONFIG
# ------------------------------------------------------
# Write logs next to this file by default (Windows-friendly)
_BASE_DIR = os.path.dirname(__file__)
CSV_LOG_PATH = os.path.join(_BASE_DIR, "logging_template.csv")
JSONL_LOG_PATH = os.path.join(_BASE_DIR, "logging_log.jsonl")

# Face detection removed (API-only classification)

# (removed local face detection helpers)


print("ℹ️ Using Sightengine API only; local models disabled.\n")


# ------------------------------------------------------
# LABEL NORMALIZATION
# ------------------------------------------------------
def normalize_label(raw: str) -> str:
    raw = str(raw or "").lower()
    if "fake" in raw or "deepfake" in raw or "synthetic" in raw or "manip" in raw:
        return "FAKE"
    if "real" in raw or "authentic" in raw or "realism" in raw:
        return "REAL"
    return "UNKNOWN"

def sightengine_enabled() -> bool:
    return bool(SIGHTENGINE_USER and SIGHTENGINE_SECRET)

def _format_sightengine_result(output: Dict[str, Any]) -> Dict[str, Any]:
    try:
        # GenAI model schema
        if isinstance(output, dict) and "genai" in output:
            genai = output.get("genai", {}) or {}
            prob = float(genai.get("ai_generated_prob", genai.get("prob", 0)))
            ai_generated = bool(genai.get("ai_generated", prob >= 0.5))
            return {
                "status": "success",
                "is_fake": ai_generated,
                "confidence": prob,
                "model": "sightengine:genai",
                "raw": output,
            }

        # Type model schema (ai_generated in [0..1])
        if isinstance(output, dict) and "type" in output:
            t = output.get("type", {}) or {}
            prob = float(t.get("ai_generated", 0))
            ai_generated = prob >= 0.5
            return {
                "status": "success",
                "is_fake": ai_generated,
                "confidence": prob,
                "model": "sightengine:type",
                "raw": output,
            }

        # Fallback heuristics for other models
        for key in ("nudity", "faces", "face-attributes", "weapon", "drugs", "alcohol"):
            if key in output:
                return {
                    "status": "success",
                    "is_fake": False,
                    "confidence": 0.0,
                    "model": f"sightengine:{key}",
                    "raw": output,
                }

        # Unknown schema
        return {
            "status": "success",
            "is_fake": False,
            "confidence": 0.0,
            "model": "sightengine:unknown",
            "raw": output,
        }
    except Exception as e:
        return {"status": "error", "message": f"Parse error: {e}", "raw": output}

def sightengine_classify_url(image_url: str, models: str = "genai", timeout: int = 15) -> Dict[str, Any]:
    params = {
        "url": image_url,
        "models": models,
        "api_user": SIGHTENGINE_USER,
        "api_secret": SIGHTENGINE_SECRET,
    }
    r = requests.get("https://api.sightengine.com/1.0/check.json", params=params, timeout=timeout)
    r.raise_for_status()
    output = r.json()
    return _format_sightengine_result(output)

def sightengine_classify_bytes(contents: bytes, models: str = "genai", timeout: int = 30) -> Dict[str, Any]:
    files = {"media": ("upload.jpg", contents, "image/jpeg")}
    data = {
        "models": models,
        "api_user": SIGHTENGINE_USER,
        "api_secret": SIGHTENGINE_SECRET,
    }
    r = requests.post("https://api.sightengine.com/1.0/check.json", files=files, data=data, timeout=timeout)
    r.raise_for_status()
    output = r.json()
    return _format_sightengine_result(output)

# (removed local model classification utilities)


# ------------------------------------------------------
# FASTAPI + CORS
# ------------------------------------------------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class ImageURL(BaseModel):
    url: str

# ------------------------------------------------------
# DETECT FACE
# ------------------------------------------------------
@app.post("/detect-face")
async def detect_face(file: UploadFile = File(...)):
    return {"status": "error", "message": "Face detection removed in API-only mode"}


# ------------------------------------------------------
# CLASSIFY FROM URL
# ------------------------------------------------------
@app.post("/classify/url")
async def classify_url(data: ImageURL, use_sightengine: bool = True, models: str = "genai"):
    try:
        print("\n=== Received URL classification request ===")
        print(f"URL: {data.url}")
        if not sightengine_enabled():
            return {"status": "error", "message": "Sightengine credentials not configured"}

        # Prefer bytes path to compute dimensions when possible
        image_w_h = None
        try:
            resp = requests.get(data.url, timeout=15)
            resp.raise_for_status()
            contents = resp.content
            try:
                img = Image.open(io.BytesIO(contents)).convert("RGB")
                image_w_h = f"{img.width}x{img.height}"
            except Exception:
                image_w_h = None
            se = sightengine_classify_bytes(contents, models=models)
        except Exception:
            se = sightengine_classify_url(data.url, models=models)

        if se.get("status") == "success":
            try:
                if not se.get("is_fake", False):
                    se_conf = float(se.get("confidence", 0.0))
                    se["confidence"] = max(0.0, min(1.0, 1.0 - se_conf))
            except Exception:
                pass
            return {
                "status": "success",
                "is_fake": se.get("is_fake", False),
                "confidence": se.get("confidence", 0.0),
                "model": se.get("model", "sightengine"),
                "models_used": [se.get("model", "sightengine")],
                "timestamp": datetime.utcnow().isoformat(),
                "image_size": image_w_h,
                "raw": se.get("raw"),
            }
        return {"status": "error", "message": "Sightengine classification failed"}
    except requests.exceptions.RequestException as e:
        return {"status": "error", "message": f"Failed to fetch image: {str(e)}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/")
def root():
    return {"message": "✅ Deepfake Detection API (Sightengine) Running!"}


@app.get("/health")
async def health_check():
    """Health check endpoint for the API"""
    return {
        "status": "ok",
        "model": "Sightengine API",
        "device": "cpu",
        "vit_loaded": False,
        "efficientnet_loaded": False,
        "timestamp": datetime.utcnow().isoformat()
    }


# ------------------------------------------------------
# CLASSIFY FROM FILE UPLOAD
# ------------------------------------------------------
@app.post("/classify/file")
async def classify_file(
    file: UploadFile = File(...),
    models: str = "genai",
):
    """
    Classify an image from file upload using Sightengine API.
    """
    try:
        print(f"\n=== Received file upload classification request ===")
        print(f"File info - Name: {file.filename}, Type: {file.content_type}")
        contents = await file.read()
        if not sightengine_enabled():
            return {"status": "error", "message": "Sightengine credentials not configured"}

        se = sightengine_classify_bytes(contents, models=models)
        if se.get("status") == "success":
            try:
                if not se.get("is_fake", False):
                    se_conf = float(se.get("confidence", 0.0))
                    se["confidence"] = max(0.0, min(1.0, 1.0 - se_conf))
            except Exception:
                pass
            try:
                image = Image.open(io.BytesIO(contents)).convert("RGB")
                image_w_h = f"{image.width}x{image.height}"
            except Exception:
                image_w_h = None
            response = {
                "status": "success",
                "is_fake": se.get("is_fake", False),
                "confidence": se.get("confidence", 0.0),
                "model": se.get("model", "sightengine"),
                "models_used": [se.get("model", "sightengine")],
                "timestamp": datetime.utcnow().isoformat(),
                "image_size": image_w_h,
                "raw": se.get("raw"),
            }
            print(f"Final response (sightengine): {response}")
            return response
        return {"status": "error", "message": "Sightengine classification failed"}
    except Exception as e:
        error_msg = f"Error processing image: {str(e)}"
        print(error_msg)
        return {"status": "error", "message": error_msg}

# ------------------------------------------------------
# LOGGING MODELS AND ENDPOINT
# ------------------------------------------------------
class PipelineTimings(BaseModel):
    capture_start: Optional[float] = None
    capture_end: Optional[float] = None
    backend_receive: Optional[float] = None
    api_request_start: Optional[float] = None
    api_response_end: Optional[float] = None
    notification_sent: Optional[float] = None


class LogRecord(BaseModel):
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
    session_id: str
    image_id: str
    image_source: Optional[str] = None
    ground_truth_label: Optional[str] = None
    predicted_label: Optional[str] = None
    confidence_score: Optional[float] = None
    pipeline_timings: Optional[PipelineTimings] = None
    api_status: Optional[str] = "unknown"
    error_message: Optional[str] = None
    user_action: Optional[str] = None
    browser: Optional[str] = None
    os: Optional[str] = None
    network_type: Optional[str] = None
    device_model: Optional[str] = None
    user_agent: Optional[str] = None
    detection_type: Optional[str] = None
    client_api_latency_ms: Optional[float] = None
    client_total_latency_ms: Optional[float] = None
    inference_time_ms: Optional[float] = None

    @validator("confidence_score")
    def clamp_confidence(cls, v):
        if v is None:
            return v
        if not (0.0 <= v <= 1.0):
            raise ValueError("confidence_score must be between 0 and 1")
        return v


def ensure_csv_has_header(csv_path: str = CSV_LOG_PATH):
    headers = [
        "timestamp","session_id","image_id","image_source","ground_truth_label","predicted_label",
        "confidence_score","capture_time_ms","api_latency_ms","total_latency_ms",
        "client_api_latency_ms","client_total_latency_ms","inference_time_ms",
        "api_status","error_message","user_action","detection_type","browser","os","network_type",
        "capture_start","capture_end","backend_receive","api_request_start","api_response_end","notification_sent",
        "device_model","user_agent"
    ]
    if not os.path.exists(csv_path) or os.path.getsize(csv_path) == 0:
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(headers)
        return
    try:
        with open(csv_path, "r", encoding="utf-8") as f:
            first_line = f.readline()
        if not first_line:
            with open(csv_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(headers)
            return
        existing = [h.strip() for h in first_line.strip().split(",")]
        if existing != headers:
            with open(csv_path, "r", encoding="utf-8") as f:
                lines = f.read().splitlines()[1:]
            with open(csv_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(headers)
                for line in lines:
                    f.write(line + "\n")
    except Exception:
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(headers)


def compute_latencies(pt: Optional[PipelineTimings]) -> Dict[str, Optional[float]]:
    if not pt:
        return {"capture_time_ms": None, "api_latency_ms": None, "total_latency_ms": None}
    capture_time = None
    api_latency = None
    total_latency = None
    try:
        if pt.capture_start is not None and pt.capture_end is not None:
            capture_time = max(0.0, (pt.capture_end - pt.capture_start) * 1000.0)
    except Exception:
        capture_time = None
    try:
        if pt.api_request_start is not None and pt.api_response_end is not None:
            api_latency = max(0.0, (pt.api_response_end - pt.api_request_start) * 1000.0)
    except Exception:
        api_latency = None
    try:
        if pt.capture_start is not None and pt.notification_sent is not None:
            total_latency = max(0.0, (pt.notification_sent - pt.capture_start) * 1000.0)
    except Exception:
        total_latency = None
    return {
        "capture_time_ms": capture_time,
        "api_latency_ms": api_latency,
        "total_latency_ms": total_latency,
    }


@app.post("/log_event")
async def log_event(record: LogRecord, request: Request):
    latencies = compute_latencies(record.pipeline_timings)
    ensure_csv_has_header()

    pt = record.pipeline_timings or PipelineTimings()
    row = [
        record.timestamp,
        record.session_id,
        record.image_id,
        record.image_source,
        record.ground_truth_label,
        record.predicted_label,
        record.confidence_score,
        latencies.get("capture_time_ms"),
        latencies.get("api_latency_ms"),
        latencies.get("total_latency_ms"),
        record.client_api_latency_ms,
        record.client_total_latency_ms,
        record.inference_time_ms,
        record.api_status,
        record.error_message,
        record.user_action,
        record.detection_type,
        record.browser,
        record.os,
        record.network_type,
        pt.capture_start,
        pt.capture_end,
        pt.backend_receive,
        pt.api_request_start,
        pt.api_response_end,
        pt.notification_sent,
        record.device_model,
        record.user_agent,
    ]

    try:
        with open(CSV_LOG_PATH, "a", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(row)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write CSV: {e}")

    try:
        with open(JSONL_LOG_PATH, "a", encoding="utf-8") as jf:
            jf.write(json.dumps(record.dict()) + "\n")
    except Exception:
        pass

    return {"status": "ok", "written_to": CSV_LOG_PATH}
