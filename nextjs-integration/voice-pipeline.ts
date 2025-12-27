/**
 * Next.js Voice Pipeline Integration
 * ===================================
 * 
 * Complete streaming architecture:
 * Mic → STT → LLM (Gemini) → TTS (FastAPI) → Audio Playback
 * 
 * This file contains:
 * 1. Audio streaming utilities
 * 2. LLM streaming with text chunking
 * 3. TTS WebSocket client
 * 4. Web Audio API playback buffer
 */

// =============================================================================
// TYPES
// =============================================================================

interface AudioConfig {
  sampleRate: number;
  channels: number;
  sampleWidth: number;
}

interface TTSChunk {
  text: string;
  language?: string;
  isFinal?: boolean;
}

// =============================================================================
// 1. AUDIO PLAYBACK BUFFER (Web Audio API)
// This is the KEY to smooth playback while receiving
// =============================================================================

export class AudioStreamPlayer {
  private audioContext: AudioContext | null = null;
  private nextStartTime: number = 0;
  private sampleRate: number;
  private isPlaying: boolean = false;
  private scheduledBuffers: AudioBufferSourceNode[] = [];

  constructor(sampleRate: number = 22050) {
    this.sampleRate = sampleRate;
  }

  async init(): Promise<void> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    this.nextStartTime = this.audioContext.currentTime;
    this.isPlaying = true;
  }

  /**
   * Add PCM audio chunk to playback queue
   * @param pcmData - Raw PCM bytes (16-bit signed little-endian)
   */
  addChunk(pcmData: ArrayBuffer): void {
    if (!this.audioContext || !this.isPlaying) return;

    // Convert PCM to Float32 for Web Audio
    const int16Array = new Int16Array(pcmData);
    const float32Array = new Float32Array(int16Array.length);
    
    for (let i = 0; i < int16Array.length; i++) {
      // Convert 16-bit signed to float (-1 to 1)
      float32Array[i] = int16Array[i] / 32768;
    }

    // Create audio buffer
    const audioBuffer = this.audioContext.createBuffer(
      1, // mono
      float32Array.length,
      this.sampleRate
    );
    audioBuffer.getChannelData(0).set(float32Array);

    // Schedule playback
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    // Schedule at next available time
    const startTime = Math.max(this.nextStartTime, this.audioContext.currentTime);
    source.start(startTime);
    
    // Update next start time
    this.nextStartTime = startTime + audioBuffer.duration;
    
    this.scheduledBuffers.push(source);
  }

  stop(): void {
    this.isPlaying = false;
    this.scheduledBuffers.forEach(source => {
      try { source.stop(); } catch {}
    });
    this.scheduledBuffers = [];
    this.nextStartTime = 0;
  }

  async close(): Promise<void> {
    this.stop();
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
  }
}

// =============================================================================
// 2. TTS WEBSOCKET CLIENT
// Connects to FastAPI WebSocket for real-time streaming
// =============================================================================

export class TTSWebSocketClient {
  private ws: WebSocket | null = null;
  private player: AudioStreamPlayer;
  private url: string;
  private onError?: (error: Error) => void;

  constructor(
    url: string = 'ws://localhost:8000/ws/tts',
    sampleRate: number = 22050
  ) {
    this.url = url;
    this.player = new AudioStreamPlayer(sampleRate);
  }

  async connect(): Promise<void> {
    await this.player.init();

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('WebSocket error'));
      
      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Audio chunk received - add to playback queue
          this.player.addChunk(event.data);
        }
      };

      this.ws.onclose = () => {
        console.log('TTS WebSocket closed');
      };
    });
  }

  /**
   * Send text chunk for TTS
   * Call this as you receive tokens from LLM
   */
  sendText(text: string, language: string = 'english', isFinal: boolean = false): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        text,
        language,
        is_final: isFinal
      }));
    }
  }

  stop(): void {
    this.player.stop();
    this.ws?.close();
    this.ws = null;
  }

  async close(): Promise<void> {
    this.stop();
    await this.player.close();
  }
}

// =============================================================================
// 3. LLM TEXT CHUNKER
// Buffers LLM tokens and sends complete phrases to TTS
// =============================================================================

export class LLMTextChunker {
  private buffer: string = '';
  private minChars: number;
  private onChunk: (chunk: string) => void;

  constructor(onChunk: (chunk: string) => void, minChars: number = 20) {
    this.onChunk = onChunk;
    this.minChars = minChars;
  }

  /**
   * Add token from LLM stream
   * Will automatically emit chunks when appropriate
   */
  addToken(token: string): void {
    this.buffer += token;

    // Check for sentence boundaries
    const sentenceMatch = this.buffer.match(/^(.*?[.!?]\s+)/);
    if (sentenceMatch && sentenceMatch[1].length >= this.minChars) {
      this.emitChunk(sentenceMatch[1]);
      this.buffer = this.buffer.slice(sentenceMatch[1].length);
      return;
    }

    // Check for clause boundaries if buffer is getting long
    if (this.buffer.length > 50) {
      const clauseMatch = this.buffer.match(/^(.*?[,;:]\s+)/);
      if (clauseMatch && clauseMatch[1].length >= this.minChars) {
        this.emitChunk(clauseMatch[1]);
        this.buffer = this.buffer.slice(clauseMatch[1].length);
      }
    }
  }

  /**
   * Flush remaining buffer (call when LLM stream ends)
   */
  flush(): void {
    if (this.buffer.trim()) {
      this.emitChunk(this.buffer.trim());
      this.buffer = '';
    }
  }

  private emitChunk(chunk: string): void {
    this.onChunk(chunk.trim());
  }
}

// =============================================================================
// 4. COMPLETE VOICE PIPELINE
// Orchestrates: STT → LLM → TTS → Playback
// =============================================================================

export class VoicePipeline {
  private ttsClient: TTSWebSocketClient;
  private chunker: LLMTextChunker;
  private language: string;

  constructor(ttsUrl: string = 'ws://localhost:8000/ws/tts', language: string = 'english') {
    this.language = language;
    this.ttsClient = new TTSWebSocketClient(ttsUrl);
    this.chunker = new LLMTextChunker((chunk) => {
      this.ttsClient.sendText(chunk, this.language, false);
    });
  }

  async start(): Promise<void> {
    await this.ttsClient.connect();
  }

  /**
   * Process LLM token stream
   * Call this for each token received from Gemini/GPT
   */
  processToken(token: string): void {
    this.chunker.addToken(token);
  }

  /**
   * Call when LLM stream ends
   */
  finalize(): void {
    this.chunker.flush();
    this.ttsClient.sendText('', this.language, true);
  }

  stop(): void {
    this.ttsClient.stop();
  }

  async close(): Promise<void> {
    await this.ttsClient.close();
  }
}

// =============================================================================
// 5. HTTP STREAMING ALTERNATIVE (simpler, no WebSocket)
// =============================================================================

export async function streamTTSFromHTTP(
  text: string,
  language: string = 'english',
  ttsUrl: string = 'http://localhost:8000/tts/stream',
  onChunk?: (progress: number) => void
): Promise<void> {
  const player = new AudioStreamPlayer(22050);
  await player.init();

  try {
    const response = await fetch(ttsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language })
    });

    if (!response.ok) throw new Error(`TTS request failed: ${response.status}`);
    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Add chunk to player
      player.addChunk(value.buffer);
      totalBytes += value.length;
      
      onChunk?.(totalBytes);
    }

    // Wait for playback to finish (approximate)
    const durationMs = (totalBytes / 2 / 22050) * 1000;
    await new Promise(resolve => setTimeout(resolve, durationMs + 100));

  } finally {
    await player.close();
  }
}

// =============================================================================
// 6. SSE STREAMING ALTERNATIVE
// =============================================================================

export async function streamTTSFromSSE(
  text: string,
  language: string = 'english',
  ttsUrl: string = 'http://localhost:8000/tts/sse'
): Promise<void> {
  const player = new AudioStreamPlayer(22050);
  await player.init();

  try {
    const response = await fetch(ttsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language })
    });

    if (!response.ok) throw new Error(`TTS request failed: ${response.status}`);
    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      
      // Parse SSE events
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          
          if (data.type === 'audio' && data.chunk) {
            // Decode base64 and play
            const binaryString = atob(data.chunk);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            player.addChunk(bytes.buffer);
          }
        }
      }
    }

    // Wait for playback
    await new Promise(resolve => setTimeout(resolve, 1000));

  } finally {
    await player.close();
  }
}
