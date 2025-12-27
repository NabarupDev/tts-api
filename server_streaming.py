"""
Streaming TTS Server - Production-Ready Architecture
=====================================================
Supports:
- Streaming audio chunks (raw PCM)
- WebSocket for real-time streaming
- Sentence chunking for LLM integration
- Low-latency response
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from piper import PiperVoice
import io
import wave
import struct
import asyncio
from typing import Optional, Generator
import re

app = FastAPI(title="Streaming TTS API")

# CORS for Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify your Next.js domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load voices
voices = {
    "english": PiperVoice.load("English/model.onnx"),
    "hindi": PiperVoice.load("Hindi/model.onnx")
}

# Audio config (Piper default)
SAMPLE_RATE = 22050
CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit

class TTSRequest(BaseModel):
    text: str
    language: Optional[str] = "english"

class ChunkedTTSRequest(BaseModel):
    """For streaming from LLM - accepts text chunks"""
    text: str
    language: Optional[str] = "english"
    is_final: bool = False  # True when this is the last chunk

# =============================================================================
# OPTION 1: Streaming HTTP Response (raw PCM bytes)
# Use this for simple integration - Next.js can fetch and stream
# =============================================================================

def generate_audio_stream(text: str, language: str) -> Generator[bytes, None, None]:
    """
    Generate audio as raw PCM chunks.
    This allows the frontend to start playing before synthesis completes.
    """
    voice = voices.get(language.lower())
    if not voice:
        return
    
    # Piper synthesizes to a buffer - we'll stream it in chunks
    wav_buffer = io.BytesIO()
    with wave.open(wav_buffer, 'wb') as wav_file:
        voice.synthesize_wav(text, wav_file)
    
    # Skip WAV header (44 bytes) and stream raw PCM
    wav_buffer.seek(44)
    
    # Stream in chunks (4096 bytes = ~93ms of audio at 22050Hz 16-bit mono)
    chunk_size = 4096
    while True:
        chunk = wav_buffer.read(chunk_size)
        if not chunk:
            break
        yield chunk

@app.post("/tts/stream")
async def tts_stream(request: TTSRequest):
    """
    Stream audio as raw PCM bytes.
    
    Frontend should:
    1. Fetch with streaming
    2. Decode PCM (16-bit, 22050Hz, mono)
    3. Push to Web Audio API buffer
    """
    if request.language.lower() not in voices:
        return {"error": f"Invalid language. Available: {list(voices.keys())}"}
    
    return StreamingResponse(
        generate_audio_stream(request.text, request.language),
        media_type="audio/pcm",
        headers={
            "X-Sample-Rate": str(SAMPLE_RATE),
            "X-Channels": str(CHANNELS),
            "X-Sample-Width": str(SAMPLE_WIDTH),
        }
    )

# =============================================================================
# OPTION 2: WebSocket for true real-time streaming
# Best for: LLM token streaming → TTS → audio chunks
# =============================================================================

class TextChunkBuffer:
    """
    Intelligent text buffering for LLM streaming.
    Collects tokens until a natural break point for TTS.
    """
    def __init__(self):
        self.buffer = ""
        self.min_chars = 20  # Minimum characters before TTS
        
    def add(self, text: str) -> Optional[str]:
        """Add text, return chunk if ready for TTS"""
        self.buffer += text
        
        # Check for sentence boundaries
        sentence_ends = re.finditer(r'[.!?]\s+', self.buffer)
        last_end = None
        for match in sentence_ends:
            if match.end() >= self.min_chars:
                last_end = match.end()
        
        # Also check for clause boundaries if buffer is getting long
        if last_end is None and len(self.buffer) > 50:
            clause_ends = re.finditer(r'[,;:]\s+', self.buffer)
            for match in clause_ends:
                if match.end() >= self.min_chars:
                    last_end = match.end()
                    break
        
        if last_end:
            chunk = self.buffer[:last_end].strip()
            self.buffer = self.buffer[last_end:]
            return chunk
        
        return None
    
    def flush(self) -> Optional[str]:
        """Get remaining text"""
        if self.buffer.strip():
            result = self.buffer.strip()
            self.buffer = ""
            return result
        return None

@app.websocket("/ws/tts")
async def websocket_tts(websocket: WebSocket):
    """
    WebSocket endpoint for real-time TTS streaming.
    
    Protocol:
    - Client sends: {"text": "...", "language": "english", "is_final": false}
    - Server sends: binary audio chunks (raw PCM)
    - Client sends: {"text": "...", "is_final": true} for last chunk
    - Server sends final audio + closes
    
    This is the CORRECT way to handle LLM streaming → TTS
    """
    await websocket.accept()
    
    buffer = TextChunkBuffer()
    language = "english"
    
    try:
        while True:
            # Receive text chunk from client (from LLM stream)
            data = await websocket.receive_json()
            
            text = data.get("text", "")
            language = data.get("language", language)
            is_final = data.get("is_final", False)
            
            # Add to buffer
            chunk_to_speak = buffer.add(text)
            
            # If we have a complete phrase/sentence, synthesize and stream
            if chunk_to_speak:
                await synthesize_and_stream(websocket, chunk_to_speak, language)
            
            # If this is the final chunk, flush buffer and close
            if is_final:
                remaining = buffer.flush()
                if remaining:
                    await synthesize_and_stream(websocket, remaining, language)
                await websocket.close()
                break
                
    except WebSocketDisconnect:
        pass
    except Exception as e:
        await websocket.close(code=1011, reason=str(e))

async def synthesize_and_stream(websocket: WebSocket, text: str, language: str):
    """Synthesize text and stream audio chunks over WebSocket"""
    voice = voices.get(language.lower())
    if not voice:
        return
    
    # Synthesize
    wav_buffer = io.BytesIO()
    with wave.open(wav_buffer, 'wb') as wav_file:
        voice.synthesize_wav(text, wav_file)
    
    # Skip WAV header, stream PCM chunks
    wav_buffer.seek(44)
    chunk_size = 4096
    
    while True:
        chunk = wav_buffer.read(chunk_size)
        if not chunk:
            break
        await websocket.send_bytes(chunk)
        # Small delay to prevent overwhelming the client
        await asyncio.sleep(0.01)

# =============================================================================
# OPTION 3: Server-Sent Events (SSE) for simpler streaming
# Good middle ground between HTTP and WebSocket
# =============================================================================

@app.post("/tts/sse")
async def tts_sse(request: TTSRequest):
    """
    Stream audio via Server-Sent Events.
    Each event contains a base64-encoded audio chunk.
    Easier to consume in Next.js than raw streaming.
    """
    import base64
    
    async def event_generator():
        voice = voices.get(request.language.lower())
        if not voice:
            yield f"data: {{'error': 'Invalid language'}}\n\n"
            return
        
        # Send audio config first
        yield f"data: {{\"type\": \"config\", \"sampleRate\": {SAMPLE_RATE}, \"channels\": {CHANNELS}}}\n\n"
        
        # Synthesize
        wav_buffer = io.BytesIO()
        with wave.open(wav_buffer, 'wb') as wav_file:
            voice.synthesize_wav(request.text, wav_file)
        
        # Stream chunks
        wav_buffer.seek(44)
        chunk_size = 4096
        chunk_num = 0
        
        while True:
            chunk = wav_buffer.read(chunk_size)
            if not chunk:
                break
            
            # Base64 encode for SSE (yes, overhead, but easier to parse)
            b64_chunk = base64.b64encode(chunk).decode('utf-8')
            yield f"data: {{\"type\": \"audio\", \"chunk\": \"{b64_chunk}\", \"index\": {chunk_num}}}\n\n"
            chunk_num += 1
            await asyncio.sleep(0.01)
        
        yield f"data: {{\"type\": \"done\"}}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )

# =============================================================================
# Keep original endpoint for backward compatibility
# =============================================================================

@app.post("/tts")
def tts_original(request: TTSRequest):
    """Original endpoint - kept for compatibility"""
    import base64
    
    if request.language is None:
        return {"languages": list(voices.keys())}
    
    lang = request.language.lower()
    if lang not in voices:
        return {"error": f"Invalid language. Available: {list(voices.keys())}"}
    
    voice = voices[lang]
    
    wav_buffer = io.BytesIO()
    with wave.open(wav_buffer, 'wb') as wav_file:
        voice.synthesize_wav(request.text, wav_file)
    
    wav_bytes = wav_buffer.getvalue()
    audio_base64 = base64.b64encode(wav_bytes).decode("utf-8")
    
    return {"audio_base64": audio_base64}

@app.get("/")
def root():
    return {
        "status": "running",
        "endpoints": {
            "/tts": "Original base64 response",
            "/tts/stream": "Streaming PCM response",
            "/tts/sse": "Server-Sent Events streaming",
            "/ws/tts": "WebSocket for real-time LLM→TTS"
        },
        "audio_config": {
            "sample_rate": SAMPLE_RATE,
            "channels": CHANNELS,
            "sample_width": SAMPLE_WIDTH,
            "format": "PCM 16-bit signed little-endian"
        }
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
