from fastapi import FastAPI
from pydantic import BaseModel
from piper import PiperVoice
import base64

app = FastAPI()

voice = PiperVoice.load("model.onnx")

class TTSRequest(BaseModel):
    text: str

@app.post("/tts")
def tts(request: TTSRequest):
    # Piper generates small chunks of audio
    audio_chunks = voice.synthesize(request.text)

    # Combine chunks into full WAV bytes
    wav_bytes = b"".join(audio_chunks)

    # Convert to base64 for JSON response
    audio_base64 = base64.b64encode(wav_bytes).decode("utf-8")

    return {"audio_base64": audio_base64}

@app.get("/")
def root():
    return {"status": "running"}
