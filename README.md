# TTS API

A simple Text-to-Speech (TTS) API built with FastAPI and Piper, supporting English and Hindi languages.

## Features

- Convert text to speech in English or Hindi.
- Returns audio as base64-encoded WAV.
- Easy to use REST API.
- Supports multiple voices.

## Installation

1. Clone or download this repository.
2. Install dependencies:
   ```
   pip install -r requirements.txt
   ```
3. Download voice models (if not already present):
   - Place English model files in `English/` folder (e.g., `model.onnx` and `model.onnx.json`).
   - Place Hindi model files in `Hindi/` folder (e.g., `model.onnx` and `model.onnx.json`).
   - You can download voices using: `python -m piper.download_voices <voice-name>`

## Running the Server

Start the server with:
```
uvicorn server:app --reload
```

The API will be available at `http://localhost:8000`.

## API Endpoints

### GET /
- **Description**: Check server status.
- **Response**: `{"status": "running"}`

### POST /tts
- **Description**: Generate speech from text.
- **Request Body** (JSON):
  ```json
  {
    "text": "Hello world",
    "language": "english"  // optional, defaults to english if not provided
  }
  ```
- **Responses**:
  - If `language` not provided: `{"languages": ["english", "hindi"]}`
  - If invalid language: `{"error": "Invalid language: <lang>. Available: ['english', 'hindi']"}`
  - Success: `{"audio_base64": "<base64-encoded-wav>"}`

## Examples

### Using Postman
1. Set method to POST, URL to `http://localhost:8000/tts`.
2. Set body to JSON: `{"text": "Hello", "language": "english"}`.
3. Send request. Decode the `audio_base64` to get the WAV file.

### Using curl
```bash
curl -X POST "http://localhost:8000/tts" -H "Content-Type: application/json" -d '{"text": "Hello", "language": "english"}'
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.</content>