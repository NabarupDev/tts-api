'use client';

/**
 * React Hook for Voice Chat
 * =========================
 * 
 * Complete implementation for Next.js frontend
 * Handles: LLM streaming + TTS audio playback
 * 
 * Usage:
 * ```tsx
 * const { sendMessage, isPlaying, transcript } = useVoiceChat();
 * 
 * // Send a message (from STT or user input)
 * await sendMessage("Hello, how are you?");
 * ```
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// =============================================================================
// AUDIO PLAYER (same as voice-pipeline.ts but as a hook-friendly class)
// =============================================================================

class AudioQueuePlayer {
  private audioContext: AudioContext | null = null;
  private nextStartTime: number = 0;
  private sampleRate: number;
  private sources: AudioBufferSourceNode[] = [];

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
  }

  /**
   * Add base64 WAV audio to queue
   */
  addBase64WAV(base64Audio: string): void {
    if (!this.audioContext) return;

    // Decode base64 to bytes
    const binaryString = atob(base64Audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Skip WAV header (44 bytes), extract PCM
    const pcmData = bytes.slice(44);
    this.addPCM(pcmData.buffer);
  }

  /**
   * Add raw PCM audio to queue
   */
  addPCM(pcmBuffer: ArrayBuffer): void {
    if (!this.audioContext) return;

    // Convert Int16 to Float32
    const int16Array = new Int16Array(pcmBuffer);
    const float32Array = new Float32Array(int16Array.length);
    
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768;
    }

    // Create and schedule buffer
    const audioBuffer = this.audioContext.createBuffer(
      1,
      float32Array.length,
      this.sampleRate
    );
    audioBuffer.getChannelData(0).set(float32Array);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const startTime = Math.max(this.nextStartTime, this.audioContext.currentTime);
    source.start(startTime);
    this.nextStartTime = startTime + audioBuffer.duration;
    
    this.sources.push(source);
  }

  stop(): void {
    this.sources.forEach(s => { try { s.stop(); } catch {} });
    this.sources = [];
    if (this.audioContext) {
      this.nextStartTime = this.audioContext.currentTime;
    }
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
// TYPES
// =============================================================================

interface VoiceChatOptions {
  apiEndpoint?: string;
  ttsEndpoint?: string;
  language?: string;
  sampleRate?: number;
}

interface VoiceChatState {
  isLoading: boolean;
  isPlaying: boolean;
  transcript: string;
  error: string | null;
}

// =============================================================================
// HOOK
// =============================================================================

export function useVoiceChat(options: VoiceChatOptions = {}) {
  const {
    apiEndpoint = '/api/voice-chat',
    language = 'english',
    sampleRate = 22050,
  } = options;

  const [state, setState] = useState<VoiceChatState>({
    isLoading: false,
    isPlaying: false,
    transcript: '',
    error: null,
  });

  const playerRef = useRef<AudioQueuePlayer | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Initialize audio player
  useEffect(() => {
    playerRef.current = new AudioQueuePlayer(sampleRate);
    return () => {
      playerRef.current?.close();
    };
  }, [sampleRate]);

  /**
   * Send a message and receive streaming audio response
   */
  const sendMessage = useCallback(async (message: string) => {
    if (!playerRef.current) return;

    // Cancel any ongoing request
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    setState(s => ({ ...s, isLoading: true, transcript: '', error: null }));

    try {
      // Initialize audio
      await playerRef.current.init();
      setState(s => ({ ...s, isPlaying: true }));

      // Start streaming request
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, language }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

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
          if (!line.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(line.slice(6));

            switch (data.type) {
              case 'token':
                // Update transcript as tokens arrive
                setState(s => ({
                  ...s,
                  transcript: s.transcript + data.text,
                }));
                break;

              case 'audio':
                // Add audio chunk to playback queue
                if (data.chunk) {
                  playerRef.current?.addBase64WAV(data.chunk);
                }
                break;

              case 'done':
                setState(s => ({ ...s, isLoading: false }));
                break;

              case 'error':
                throw new Error(data.message);
            }
          } catch (e) {
            // Skip malformed events
          }
        }
      }

    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        setState(s => ({
          ...s,
          error: (error as Error).message,
          isLoading: false,
          isPlaying: false,
        }));
      }
    }
  }, [apiEndpoint, language]);

  /**
   * Stop playback and cancel request
   */
  const stop = useCallback(() => {
    abortControllerRef.current?.abort();
    playerRef.current?.stop();
    setState(s => ({ ...s, isLoading: false, isPlaying: false }));
  }, []);

  return {
    ...state,
    sendMessage,
    stop,
  };
}

// =============================================================================
// EXAMPLE COMPONENT
// =============================================================================

export function VoiceChatDemo() {
  const { sendMessage, stop, isLoading, isPlaying, transcript, error } = useVoiceChat();
  const [input, setInput] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    
    await sendMessage(input);
    setInput('');
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <form onSubmit={handleSubmit} className="flex gap-2 mb-4">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          className="flex-1 px-4 py-2 border rounded"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading}
          className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          Send
        </button>
        {isPlaying && (
          <button
            type="button"
            onClick={stop}
            className="px-4 py-2 bg-red-500 text-white rounded"
          >
            Stop
          </button>
        )}
      </form>

      {error && (
        <div className="p-2 bg-red-100 text-red-700 rounded mb-4">
          {error}
        </div>
      )}

      {transcript && (
        <div className="p-4 bg-gray-100 rounded">
          <div className="text-sm text-gray-500 mb-1">
            {isLoading ? '🔊 Speaking...' : '✓ Complete'}
          </div>
          <p>{transcript}</p>
        </div>
      )}
    </div>
  );
}

export default useVoiceChat;
