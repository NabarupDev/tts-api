from fastapi import FastAPI
from pydantic import BaseModel
from piper import PiperVoice
import base64
import io
import wave

app = FastAPI()

voice = PiperVoice.load("model.onnx")

class TTSRequest(BaseModel):
    text: str

@app.post("/tts")
def tts(request: TTSRequest):
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
