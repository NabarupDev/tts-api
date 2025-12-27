/**
 * Next.js API Route: Voice Chat Handler
 * ======================================
 * 
 * This API route orchestrates the full pipeline:
 * 1. Receives user text (from STT)
 * 2. Streams to Gemini LLM
 * 3. Chunks LLM response
 * 4. Forwards to TTS
 * 5. Streams audio back to client
 * 
 * Place this in: app/api/voice-chat/route.ts
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

// =============================================================================
// CONFIG
// =============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const TTS_URL = process.env.TTS_URL || 'http://localhost:8000';

// =============================================================================
// TEXT CHUNKER (same logic as frontend)
// =============================================================================

class TextChunker {
  private buffer: string = '';
  private minChars: number = 20;

  add(text: string): string | null {
    this.buffer += text;

    // Check for sentence boundaries
    const sentenceMatch = this.buffer.match(/^(.*?[.!?]\s+)/s);
    if (sentenceMatch && sentenceMatch[1].length >= this.minChars) {
      const chunk = sentenceMatch[1].trim();
      this.buffer = this.buffer.slice(sentenceMatch[1].length);
      return chunk;
    }

    // Check for clause boundaries if buffer is getting long
    if (this.buffer.length > 50) {
      const clauseMatch = this.buffer.match(/^(.*?[,;:]\s+)/s);
      if (clauseMatch && clauseMatch[1].length >= this.minChars) {
        const chunk = clauseMatch[1].trim();
        this.buffer = this.buffer.slice(clauseMatch[1].length);
        return chunk;
      }
    }

    return null;
  }

  flush(): string | null {
    if (this.buffer.trim()) {
      const chunk = this.buffer.trim();
      this.buffer = '';
      return chunk;
    }
    return null;
  }
}

// =============================================================================
// OPTION 1: Full pipeline (LLM → TTS → Audio stream to client)
// =============================================================================

export async function POST(request: Request) {
  const { message, language = 'english', mode = 'text' } = await request.json();

  if (mode === 'audio') {
    // Return audio stream
    return streamWithAudio(message, language);
  } else {
    // Return text + audio URLs
    return streamTextWithTTS(message, language);
  }
}

/**
 * Stream LLM text response with TTS audio chunks
 * Uses Server-Sent Events for real-time updates
 */
async function streamTextWithTTS(userMessage: string, language: string) {
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Initialize Gemini
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const chunker = new TextChunker();
        let fullResponse = '';
        let chunkIndex = 0;

        // Start streaming from Gemini
        const result = await model.generateContentStream(userMessage);

        for await (const chunk of result.stream) {
          const text = chunk.text();
          fullResponse += text;

          // Send raw token to client (for display)
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'token', text })}\n\n`
          ));

          // Check if we have a complete phrase for TTS
          const ttsChunk = chunker.add(text);
          if (ttsChunk) {
            // Get audio for this chunk
            const audioData = await synthesizeChunk(ttsChunk, language);
            if (audioData) {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ 
                  type: 'audio', 
                  chunk: audioData, 
                  index: chunkIndex++,
                  text: ttsChunk 
                })}\n\n`
              ));
            }
          }
        }

        // Flush remaining text
        const remaining = chunker.flush();
        if (remaining) {
          const audioData = await synthesizeChunk(remaining, language);
          if (audioData) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ 
                type: 'audio', 
                chunk: audioData, 
                index: chunkIndex++,
                text: remaining 
              })}\n\n`
            ));
          }
        }

        // Done
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'done', fullText: fullResponse })}\n\n`
        ));
        controller.close();

      } catch (error) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'error', message: String(error) })}\n\n`
        ));
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

/**
 * Get TTS audio for a text chunk
 */
async function synthesizeChunk(text: string, language: string): Promise<string | null> {
  try {
    const response = await fetch(`${TTS_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return data.audio_base64;
  } catch {
    return null;
  }
}

/**
 * OPTION 2: Stream raw audio (more efficient, lower latency)
 * Returns raw PCM audio stream
 */
async function streamWithAudio(userMessage: string, language: string) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const chunker = new TextChunker();

        const result = await model.generateContentStream(userMessage);

        for await (const chunk of result.stream) {
          const text = chunk.text();
          const ttsChunk = chunker.add(text);
          
          if (ttsChunk) {
            // Stream raw audio
            const audioResponse = await fetch(`${TTS_URL}/tts/stream`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: ttsChunk, language }),
            });

            if (audioResponse.ok && audioResponse.body) {
              const reader = audioResponse.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            }
          }
        }

        // Flush remaining
        const remaining = chunker.flush();
        if (remaining) {
          const audioResponse = await fetch(`${TTS_URL}/tts/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: remaining, language }),
          });

          if (audioResponse.ok && audioResponse.body) {
            const reader = audioResponse.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          }
        }

        controller.close();
      } catch (error) {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'audio/pcm',
      'X-Sample-Rate': '22050',
      'X-Channels': '1',
    },
  });
}
