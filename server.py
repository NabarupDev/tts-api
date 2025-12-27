from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from piper import PiperVoice
import base64
import io
import wave
from typing import Optional

app = FastAPI()

# CORS - Allow Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Or specify: ["http://localhost:3000"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load voices for different languages
voices = {
    "english": PiperVoice.load("English/model.onnx"),
    "hindi": PiperVoice.load("Hindi/model.onnx")
}

class TTSRequest(BaseModel):
    text: str
    language: Optional[str] = None

@app.post("/tts")
def tts(request: TTSRequest):
    if request.language is None:
        return {"languages": list(voices.keys())}
    
    lang = request.language.lower()
    if lang not in voices:
        return {"error": f"Invalid language: {request.language}. Available: {list(voices.keys())}"}
    
    voice = voices[lang]
    
    # Use BytesIO to create WAV in memory
    wav_buffer = io.BytesIO()
    with wave.open(wav_buffer, 'wb') as wav_file:
        voice.synthesize_wav(request.text, wav_file)
    
    # Get WAV bytes
    wav_bytes = wav_buffer.getvalue()

    # Convert to base64 for JSON response
    audio_base64 = base64.b64encode(wav_bytes).decode("utf-8")

    return {"audio_base64": audio_base64}

@app.get("/")
def root():
    return {"status": "running"}
