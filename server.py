# ======================================================
# server.py — Deepfake Detector with Multiple Models (ViT + EfficientNet)
# ======================================================
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import ViTForImageClassification, ViTImageProcessor
from PIL import Image, ImageOps
import torch
import torch.nn.functional as F
import torch.backends.cudnn as cudnn
import torchvision.transforms as T
from torchvision.models import efficientnet_b0, EfficientNet_B0_Weights
import timm
from safetensors.torch import load_file as load_safetensors_file
import io
import requests
import cv2
import os
import numpy as np
from typing import Dict, Any, List, Optional
import time
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()
SIGHTENGINE_USER = os.getenv("SIGHTENGINE_USER")
SIGHTENGINE_SECRET = os.getenv("SIGHTENGINE_SECRET")
LOAD_LOCAL_EFFICIENTNET = str(os.getenv("LOAD_LOCAL_EFFICIENTNET", "false")).lower() in ("1", "true", "yes")

# Preload Haar/LBP cascades globally to avoid repeated disk I/O
_FRONTAL_CASCADES = []
try:
    _FRONTAL_CASCADES = [
        cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml"),
        cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_alt2.xml"),
        cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_alt_tree.xml"),
    ]
except Exception:
    _FRONTAL_CASCADES = []

try:
    _PROFILE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
except Exception:
    _PROFILE_CASCADE = None

# ------------------------------------------------------
# FACE DETECTION
# ------------------------------------------------------
def is_human_face(image_path: str) -> bool:
    face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    img = cv2.imread(image_path)
    if img is None:
        return False
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = face_cascade.detectMultiScale(gray, 1.2, 5)
    return len(faces) > 0


# ------------------------------------------------------
# MODEL CONFIG
# ------------------------------------------------------
MODEL_PATHS = {}

MODELS = {}
PROCESSORS = {}
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
cudnn.benchmark = True

# Initialize EfficientNet model
efficientnet = None
efficientnet_transform = None
EFFICIENTNET_FP16 = False

print("🔄 Loading models...")

# Load ViT models (disabled by setting MODEL_PATHS to empty)
for name, path in MODEL_PATHS.items():
    try:
        model = ViTForImageClassification.from_pretrained(path).to(device)
        processor = ViTImageProcessor.from_pretrained(path)
        MODELS[name] = model
        PROCESSORS[name] = processor
        print(f"✅ Loaded {name} model")
    except Exception as e:
        print(f"❌ Failed to load {name} model: {e}")

if LOAD_LOCAL_EFFICIENTNET:
    try:
        CKPT_DIR = r"C:\\Users\\rjhon\\Downloads\\checkpoint-6850"
        if not os.path.isdir(CKPT_DIR):
            raise FileNotFoundError(f"Checkpoint directory not found: {CKPT_DIR}")

        candidates = [
            os.path.join(CKPT_DIR, 'model.safetensors'),
            os.path.join(CKPT_DIR, 'pytorch_model.bin'),
            os.path.join(CKPT_DIR, 'model.bin'),
            os.path.join(CKPT_DIR, 'checkpoint.pth'),
            os.path.join(CKPT_DIR, 'model.pth'),
        ]
        ckpt_path = next((p for p in candidates if os.path.exists(p)), None)
        if ckpt_path is None:
            for fname in os.listdir(CKPT_DIR):
                if fname.lower().endswith(('.safetensors', '.bin', '.pth', '.pt')):
                    ckpt_path = os.path.join(CKPT_DIR, fname)
                    break
        if ckpt_path is None:
            raise FileNotFoundError(f"No checkpoint file found in {CKPT_DIR}")

        if ckpt_path.lower().endswith('.safetensors'):
            state = load_safetensors_file(ckpt_path)
        else:
            state = torch.load(ckpt_path, map_location=device)
        if isinstance(state, dict) and 'state_dict' in state:
            state = state['state_dict']
        if isinstance(state, dict):
            new_state = {}
            for k, v in state.items():
                if k.startswith('module.'):
                    k = k[len('module.'):]
                if k.startswith('model.'):
                    k = k[len('model.'):]
                new_state[k] = v
            state = new_state

        use_timm = True
        efficientnet = timm.create_model('efficientnet_b4', pretrained=False, num_classes=2)
        missing, unexpected = efficientnet.load_state_dict(state, strict=False)
        if missing:
            print(f"⚠️ EfficientNet missing keys: {missing}")
        if unexpected:
            print(f"⚠️ EfficientNet unexpected keys: {unexpected}")
        efficientnet = efficientnet.to(device).eval()
        if device.type == 'cuda':
            try:
                efficientnet.half()
                EFFICIENTNET_FP16 = True
                print("✅ EfficientNet set to FP16 on CUDA for faster inference")
            except Exception as e:
                print(f"ℹ️ FP16 not enabled: {e}")
        efficientnet_transform = T.Compose([
            T.Resize(380),
            T.CenterCrop(380),
            T.ToTensor(),
            T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
        ])
        print(f"✅ Loaded EfficientNet-B4 model from {ckpt_path} (timm={use_timm})")
    except Exception as e:
        print(f"❌ Failed to load EfficientNet model: {e}")
else:
    efficientnet = None
    efficientnet_transform = None
    EFFICIENTNET_FP16 = False
    print("ℹ️ Skipping local EfficientNet loading (LOAD_LOCAL_EFFICIENTNET=false)")

# ✅ Fix misconfigured label maps (public models sometimes use LABEL_0/LABEL_1)
for name, model in MODELS.items():
    if "LABEL" in str(model.config.id2label).upper():
        model.config.id2label = {0: "REAL", 1: "FAKE"}
        model.config.label2id = {"REAL": 0, "FAKE": 1}
    print(f"✅ {name} labels: {model.config.id2label}")

print("✅ Model loading complete.\n")

print("✅ Model loading complete.\n")


# ------------------------------------------------------
# LABEL NORMALIZATION
# ------------------------------------------------------
def normalize_label(raw: str) -> str:
    raw = raw.lower()
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

# ------------------------------------------------------
# RUN MODELS
# ------------------------------------------------------
def classify_image_with_model_from_pil(model_name: str, image: Image.Image):
    if model_name == "efficientnet_b0":
        return classify_with_efficientnet(image)
        
    if model_name not in MODELS:
        return {"error": f"Model {model_name} not found"}

    model = MODELS[model_name]
    processor = PROCESSORS[model_name]

    # Preprocess
    inputs = processor(images=image, return_tensors="pt").to(device)

    # Predict
    with torch.no_grad():
        outputs = model(**inputs)
        logits = outputs.logits
        probs = torch.nn.functional.softmax(logits, dim=-1)
        predicted_class = torch.argmax(probs, dim=-1).item()
        confidence = probs[0][predicted_class].item()

    # Get label
    label = model.config.id2label[predicted_class]
    normalized_label = normalize_label(label)

    return {
        "model": model_name,
        "label": normalized_label,
        "confidence": confidence,
        "is_fake": normalized_label == "fake"
    }

def classify_with_efficientnet(image: Image.Image):
    if efficientnet is None:
        return {"error": "EfficientNet model not loaded"}
    
    # Preprocess image
    image_tensor = efficientnet_transform(image).unsqueeze(0).to(device)
    if EFFICIENTNET_FP16:
        image_tensor = image_tensor.half()
    
    # Predict
    with torch.no_grad():
        if device.type == 'cuda':
            with torch.autocast(device_type='cuda', dtype=torch.float16):
                outputs = efficientnet(image_tensor)
        else:
            outputs = efficientnet(image_tensor)
        probs = F.softmax(outputs, dim=1)
        confidence, predicted = torch.max(probs, 1)
        confidence = confidence.item()
        predicted_label = "fake" if predicted.item() == 1 else "real"
    
    return {
        "model": "efficientnet_b4",
        "label": predicted_label,
        "confidence": confidence,
        "is_fake": predicted_label == "fake"
    }


# ------------------------------------------------------
# ENSEMBLE (Multiple models with weighted voting)
# ------------------------------------------------------
def ensemble_decision(results):
    if not results:
        return {"error": "No results provided"}

    # Weighted voting based on model confidence
    total_weight = 0
    weighted_sum = 0
    model_results = []
    
    for result in results:
        if "error" in result:
            continue
            
        weight = result.get("confidence", 0.5)
        vote = 1 if result.get("is_fake") else -1
        weighted_sum += vote * weight
        total_weight += weight
        model_results.append(result)
    
    if total_weight == 0:
        return {"error": "No valid model results"}
    
    # Calculate final score and make decision
    final_score = weighted_sum / total_weight
    is_fake = final_score > 0
    confidence = abs(final_score)  # Confidence is the magnitude of the score
    
    # Count votes for each class
    fake_votes = sum(1 for r in model_results if r.get("is_fake"))
    total_votes = len(model_results)
    
    return {
        "label": "fake" if is_fake else "real",
        "confidence": confidence,
        "is_fake": is_fake,
        "votes": {"fake": fake_votes, "total": total_votes},
        "models": model_results,
        "ensemble_score": final_score
    }


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
    use_efficientnet: bool = True
    use_vit: bool = False

# ------------------------------------------------------
# DETECT FACE
# ------------------------------------------------------
@app.post("/detect-face")
async def detect_face(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        # Decode image directly from memory to avoid disk I/O
        np_arr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if img is None:
            return {"status": "error", "message": "Failed to decode image."}

        # Upscale very small crops (helps Haar recall)
        h, w = img.shape[:2]
        min_edge = min(h, w)
        if min_edge < 120:
            scale = 120.0 / max(1, min_edge)
            img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)

        # Use cached cascades (defined globally) for speed; lenient params
        faces_frontal = []
        for cas in _FRONTAL_CASCADES:
            try:
                det = cas.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=2, minSize=(24, 24))
                if len(det):
                    faces_frontal.extend(list(det))
            except Exception:
                pass

        faces_profile = []
        faces_profile_flipped = []
        if _PROFILE_CASCADE is not None:
            try:
                faces_profile = _PROFILE_CASCADE.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=2, minSize=(24, 24))
            except Exception:
                faces_profile = []
            try:
                gray_flipped = cv2.flip(gray, 1)
                faces_profile_flipped = _PROFILE_CASCADE.detectMultiScale(gray_flipped, scaleFactor=1.05, minNeighbors=2, minSize=(24, 24))
            except Exception:
                faces_profile_flipped = []

        faces_all = list(faces_frontal) + list(faces_profile)
        face_count = len(faces_all) + (len(faces_profile_flipped) if isinstance(faces_profile_flipped, (list, tuple, np.ndarray)) else 0)
        face_positions = [{"x": int(x), "y": int(y), "width": int(w), "height": int(h)} for (x, y, w, h) in faces_all]

        has_face = face_count > 0
        return {
            "status": "success",
            "has_face": has_face,
            "face_count": face_count,
            "face_positions": face_positions,
            "image_size": {"width": img.shape[1], "height": img.shape[0]}
        }
                
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ------------------------------------------------------
# CLASSIFY FROM URL
# ------------------------------------------------------
@app.post("/classify/url")
async def classify_url(data: ImageURL, use_sightengine: bool = True, models: str = "genai"):
    try:
        # Prefer Sightengine if enabled and keys are present
        if use_sightengine and sightengine_enabled():
            se = sightengine_classify_url(data.url, models=models)
            if se.get("status") == "success":
                # For URL flow, we may not know image size without fetching; keep optional
                return {
                    "status": "success",
                    "is_fake": se.get("is_fake", False),
                    "confidence": se.get("confidence", 0.0),
                    "model": se.get("model", "sightengine"),
                    "models_used": [se.get("model", "sightengine")],
                    "timestamp": datetime.utcnow().isoformat(),
                    "raw": se.get("raw"),
                }
        
        # Fallback: download and evaluate locally
        response = requests.get(data.url, stream=True, timeout=10)
        response.raise_for_status()
        content_type = response.headers.get('content-type', '').lower()
        if 'image' not in content_type:
            return {"status": "error", "message": "URL does not point to a valid image"}
        image = Image.open(io.BytesIO(response.content)).convert("RGB")
        image.verify()
        image = Image.open(io.BytesIO(response.content)).convert("RGB")

        results = []
        if data.use_efficientnet and efficientnet is not None:
            result = classify_with_efficientnet(image)
            if "error" not in result:
                results.append(result)
        if data.use_vit:
            for model_name in MODEL_PATHS.keys():
                result = classify_image_with_model_from_pil(model_name, image)
                if "error" not in result:
                    results.append(result)
        if not results:
            return {"status": "error", "message": "No models were able to process the image"}
        ensemble = ensemble_decision(results)
        return {
            "status": "success",
            "result": ensemble,
            "models_used": [r["model"] for r in results],
            "timestamp": datetime.utcnow().isoformat(),
            "image_size": f"{image.width}x{image.height}"
        }
    except requests.exceptions.RequestException as e:
        return {"status": "error", "message": f"Failed to fetch image: {str(e)}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/")
def root():
    return {"message": "✅ Deepfake Detection API (2 models) Running!"}


@app.get("/health")
async def health_check():
    """Health check endpoint for the API"""
    return {
        "status": "ok",
        "model": "EfficientNet (local only)",
        "device": str(device),
        "vit_loaded": False,
        "efficientnet_loaded": efficientnet is not None,
        "timestamp": datetime.utcnow().isoformat()
    }


# ------------------------------------------------------
# CLASSIFY FROM FILE UPLOAD
# ------------------------------------------------------
@app.post("/classify/file")
async def classify_file(
    file: UploadFile = File(...),
    use_efficientnet: bool = True,
    use_vit: bool = False,
    use_sightengine: bool = True,
    models: str = "genai",
):
    """
    Classify an image from file upload with multiple models.
    Returns results in the same format as /classify/url for UI consistency.
    """
    try:
        print(f"\n=== Received file upload classification request ===")
        print(f"File info - Name: {file.filename}, Type: {file.content_type}")
        
        # Read the uploaded file
        contents = await file.read()
        print(f"File size: {len(contents)} bytes")

        # Try Sightengine first if enabled
        if use_sightengine and sightengine_enabled():
            print("Running Sightengine (upload path)...")
            se = sightengine_classify_bytes(contents, models=models)
            if se.get("status") == "success":
                # We can still compute image size locally for convenience
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

        # Fallback to local model
        image = Image.open(io.BytesIO(contents)).convert("RGB")
        print(f"Image loaded - Size: {image.width}x{image.height}, Mode: {image.mode}")

        if use_efficientnet and efficientnet is not None:
            print("Running EfficientNet (fallback path)...")
            result = classify_with_efficientnet(image)
            if "error" in result:
                raise RuntimeError(result["error"])

            response = {
                "status": "success",
                "is_fake": result["is_fake"],
                "confidence": result["confidence"],
                "model": result["model"],
                "models_used": [result["model"]],
                "timestamp": datetime.utcnow().isoformat(),
                "image_size": f"{image.width}x{image.height}"
            }
            print(f"Final response (fallback local): {response}")
            return response

        # Fallback if model missing
        error_msg = "EfficientNet model not available"
        print(error_msg)
        return {
            "status": "error",
            "message": error_msg,
            "is_fake": False,
            "confidence": 0,
            "model": "none"
        }
        
    except Exception as e:
        error_msg = f"Error processing image: {str(e)}"
        print(error_msg)
        return {
            "status": "error",
            "message": error_msg,
            "is_fake": False,
            "confidence": 0,
            "model": "none"
        }
