from fastapi import FastAPI
from piper import PiperVoice
import base64

app = FastAPI()

voice = PiperVoice.load("model.onnx")

@app.post("/tts")
def tts(text: str):
    wav_bytes = voice.synthesize(text)
    audio_base64 = base64.b64encode(wav_bytes).decode("utf-8")
    return {"audio_base64": audio_base64}
