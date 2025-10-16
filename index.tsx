/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, LiveServerMessage, Modality, Session } from '@google/genai';
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createBlob, decode, decodeAudioData } from './utils';
import './visual-3d';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() currentOutputTranscription = '';
  @state() displayedLinks: string[] = [];

  private client!: GoogleGenAI;
  private sessionPromise!: Promise<Session>;

  // Audio contexts (com fallback para Safari)
  private inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
  private outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();

  private nextStartTime = 0;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    .links-box {
      position: absolute;
      bottom: calc(10vh + 160px);
      left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      background: rgba(20, 20, 30, 0.85);
      border-radius: 12px;
      padding: 15px 20px;
      font-family: sans-serif;
      color: white;
      width: 90%;
      max-width: 420px;
      text-align: center;
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    }
    .links-box h3 {
      margin: 0 0 10px 0;
      font-size: 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.2);
      padding-bottom: 8px;
    }
    .links-box a {
      display: inline-block;
      color: #90c8ff;
      text-decoration: none;
      font-size: 15px;
      margin: 4px 8px;
      padding: 8px 12px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 8px;
    }
    .links-box a:hover {
      background: rgba(144, 200, 255, 0.25);
      color: #ffffff;
    }
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: #fff;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;
    }
    .controls button {
      outline: none;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.1);
      width: 64px;
      height: 64px;
      cursor: pointer;
      font-size: 24px;
      padding: 0;
      margin: 0;
    }
    .controls button:hover {
      background: rgba(255, 255, 255, 0.2);
    }
    .controls button[disabled] {
      display: none;
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();
    try {
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('VITE_GEMINI_API_KEY ausente (configure nas Environment Variables da Vercel).');
      }

      this.client = new GoogleGenAI({ apiKey });
      this.outputNode.connect(this.outputAudioContext.destination);
      await this.initSession();
    } catch (e: any) {
      console.error(e);
      this.updateError(e?.message ?? String(e));
    }
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';

    try {
      this.sessionPromise = this.client.live.connect({
        model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Opened');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData;

            if (audio) {
              this.nextStartTime = Math.max(this.nextStartTime, this.outputAudioContext.currentTime);

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );

              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => this.sources.delete(source));

              source.start(this.nextStartTime);
              this.nextStartTime += audioBuffer.duration;
              this.sources.add(source);
            }

            if (message.serverContent?.outputTranscription) {
              this.currentOutputTranscription += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              this.displayedLinks = this.extractLinks(this.currentOutputTranscription);
              this.currentOutputTranscription = '';
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const src of this.sources.values()) {
                try { src.stop(); } catch {}
                this.sources.delete(src);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => this.updateError(e.message),
          onclose: (e: CloseEvent) => this.updateStatus('Close: ' + e.reason),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
          },
          systemInstruction: `Você é o Amperito, assistente virtual da EFALL.

# 1. Identidade e Tom
- Estilo simpático, direto e profissional. Frases curtas (até 2 linhas).
- Objetivo: identificar a necessidade e encaminhar para o WhatsApp correto.
- Regra: Pergunte antes de oferecer. Não invente infos. Não finalize por conta.

# 2. Fluxo
1) "Eu sou o Amperito, assistente virtual da EFALL! Como posso te ajudar? 😊"
2) Pergunte UMA DE CADA VEZ: "Qual seu nome?", "De qual cidade você fala?", "Seu interesse é em energia solar, materiais elétricos ou materiais de construção?"
3) Se solar: "Legal! Qual seu objetivo: economia, backup ou expansão?"
4) Roteie com a frase certa e diga que o link está na tela (não leia o link).

# 3. Setores e Links
- Energia Solar → "Fale com nosso especialista pelo link na tela." → https://wa.me/5554997121367
- Materiais Elétricos → "Chame direto pelo link na tela." → https://wa.me/555496941592
- Materiais de Construção → "Chame direto no link da tela." → https://wa.me/555499892871

# 4. Objeções
- Preços → "Depende de diagnóstico. Posso coletar alguns dados?"
- Está caro → "Entendo. Nosso foco é economia real e segurança. Posso pedir avaliação?"
- Quer falar com alguém → "Vou te direcionar agora. Clique no link na tela."

# 5. Regra Final
- Usuário fala por voz. Você responde SEMPRE por voz.`,
        },
      });
    } catch (e) {
      console.error(e);
      this.updateError('Falha ao iniciar sessão.');
    }
  }

  private getLinkName(link: string): string {
    if (link.includes('5554997121367')) return 'Especialista Solar';
    if (link.includes('555496941592')) return 'Materiais Elétricos';
    if (link.includes('555499892871')) return 'Materiais de Construção';
    return link;
  }

  private extractLinks(text: string): string[] {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.match(urlRegex) || [];
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) return;

    await this.inputAudioContext.resume();
    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(bufferSize, 1, 1);

      this.scriptProcessorNode.onaudioprocess = (ev) => {
        if (!this.isRecording) return;
        const inputBuffer = ev.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);
        this.sessionPromise.then((session) => {
          session.sendRealtimeInput({ media: createBlob(pcmData) });
        }).catch(err => this.updateError(String(err)));
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴 Recording... Capturing PCM chunks.');
    } catch (err: any) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err?.message ?? err}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext) return;

    this.updateStatus('Stopping recording...');
    this.isRecording = false;

    try { this.scriptProcessorNode?.disconnect(); } catch {}
    try { this.sourceNode?.disconnect(); } catch {}

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private reset() {
    try { (this as any).sessionPromise?.then((s: Session) => s.close()); } catch {}
    this.initSession();
    this.updateStatus('Session cleared.');
  }

  render() {
    return html`
      <div>
        ${this.displayedLinks.length
          ? html`
              <div class="links-box">
                <h3>Links úteis</h3>
                ${this.displayedLinks.map(
                  (l) => html`<a href=${l} target="_blank" rel="noreferrer">${this.getLinkName(l)}</a>`
                )}
              </div>
            `
          : null}

        <div class="controls">
          <button id="resetButton" @click=${this.reset} ?disabled=${this.isRecording} title="Reset">
            🔄
          </button>

          <button id="startButton" @click=${this.startRecording} ?disabled=${this.isRecording} title="Start">
            🔴
          </button>

          <button id="stopButton" @click=${this.stopRecording} ?disabled=${!this.isRecording} title="Stop">
            ⏹️
          </button>
        </div>

        <div id="status">${this.error ? `Erro: ${this.error}` : this.status}</div>

        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}>
        </gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}

export {};
