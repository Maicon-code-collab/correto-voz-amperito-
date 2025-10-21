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

type PendingMedia = {
  file: File;
  kind: 'image' | 'audio' | 'other';
  preview?: string; // dataURL p/ imagens
  label?: string;   // nome p/ áudios/outros
};

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  // ===== States =====
  @state() isRecording = false;
  @state() isPaused = false;
  @state() status = '';
  @state() error = '';
  @state() currentOutputTranscription = '';
  @state() displayedLinks: string[] = [];

  // Entrada do usuário
  @state() textInput = '';
  @state() imagePreviews: string[] = []; // dataURL para preview
  @state() audioChips: string[] = [];    // nomes dos áudios
  private pendingFiles: PendingMedia[] = [];
  @state() isSending = false;

  // ===== Audio / Session =====
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

  // ===== Styles (minimal, ChatGPT-like) =====
  static styles = css`
    :host { display: block; width: 100%; height: 100%; }
    .links-box {
      position: fixed; left: 50%; transform: translateX(-50%);
      bottom: calc(18vh + 200px); z-index: 30;
      background: rgba(18,18,24,.9); backdrop-filter: blur(6px);
      border: 1px solid rgba(255,255,255,.1); border-radius: 12px;
      padding: 12px 14px; color: #fff; width: min(640px, 92%);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    .links-box h3 { margin: 0 0 6px 0; font-size: 14px; font-weight: 600; opacity:.9; border-bottom: 1px dashed rgba(255,255,255,.15); padding-bottom: 6px; }
    .links-list { display:flex; flex-wrap:wrap; gap:6px; }
    .links-list a { display:inline-block; color:#9cc3ff; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.08); border-radius:8px; padding:6px 10px; text-decoration:none; font-size:13px; }
    .links-list a:hover { background: rgba(156,195,255,.18); color:#fff; }

    .composer {
      position: fixed; left: 50%; transform: translateX(-50%);
      bottom: 18vh; z-index: 40; width: min(780px, 92%);
      display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: end;
    }
    .textarea-wrap {
      background: rgba(22,22,28,.9); border:1px solid rgba(255,255,255,.12);
      border-radius:14px; padding:8px; display:flex; gap:8px; align-items:center;
      box-shadow: 0 8px 20px rgba(0,0,0,.25);
    }
    textarea.input {
      width:100%; max-height:140px; min-height:44px; resize:none; border:none; outline:none;
      background:transparent; color:#fff; font-size:15px; line-height:1.35;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    .icon-btn, .send-btn {
      height:44px; border-radius:12px; border:1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.08); color:#fff; cursor:pointer; font-weight:600; transition:.15s ease;
    }
    .icon-btn { width:46px; display:grid; place-items:center; font-size:18px; }
    .icon-btn:hover { background: rgba(255,255,255,.18); }
    .send-btn { padding:0 14px; background:#2f70ff; border-color: rgba(47,112,255,.9); }
    .send-btn:hover { filter: brightness(1.05); }
    .send-btn[disabled] { opacity:.6; cursor:not-allowed; }
    .hidden-input { display:none; }

    .previews {
      position: fixed; left:50%; transform:translateX(-50%);
      bottom: calc(18vh + 60px); z-index:35; display:flex; gap:8px; flex-wrap:wrap; width:min(780px, 92%);
    }
    .thumb { width:56px; height:56px; border-radius:10px; overflow:hidden; border:1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); }
    .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
    .chip { height:28px; display:inline-flex; align-items:center; gap:6px; padding:0 10px; border-radius:999px; border:1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color:#fff; font-size:12px; }

    .controls {
      position: fixed; left: 50%; transform: translateX(-50%);
      bottom: 8vh; z-index: 20; display:flex; gap:10px; align-items:center; justify-content:center;
    }
    .circle {
      width:60px; height:60px; border-radius:14px; border:1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.08); color:#fff; font-size:24px; display:grid; place-items:center; cursor:pointer; transition:.15s ease;
    }
    .circle:hover { background: rgba(255,255,255,.18); }
    .circle[disabled] { opacity:.4; cursor:not-allowed; }

    #status { position:fixed; bottom:3.5vh; left:0; right:0; z-index:10; text-align:center; color:#fff; font-size:13px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; opacity:.9; padding:0 10px; }

    @media (max-width: 768px) {
      .links-box { bottom: calc(22vh + 200px); }
      .composer { bottom: 22vh; grid-template-columns: 1fr auto auto; }
      .controls { bottom: 11vh; }
      #status { bottom: 5vh; font-size: 12px; }
      .circle { width: 54px; height: 54px; font-size: 22px; }
      .icon-btn { width: 44px; }
    }
    @media (max-width: 420px) {
      .composer { width: min(96%, 560px); }
      .previews { width: min(96%, 560px); bottom: calc(22vh + 56px); }
      .links-box { width: min(96%, 560px); }
      textarea.input { font-size: 14px; }
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  // ===== Init =====
  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();
    try {
      // ===== SUA API KEY (frontend — use proxy em produção) =====
      const apiKey = "AIzaSyD3y3ZZ05zMSH3o_73gfcN7rmcgBhEphNE";

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
          onopen: () => this.updateStatus('Opened'),
          onmessage: async (message: LiveServerMessage) => {
            // 1) Tocar saída de ÁUDIO (fila para não cortar)
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

            // 2) Capturar texto (outputTranscription e/ou partes textuais)
            if (message.serverContent?.outputTranscription) {
              this.currentOutputTranscription += message.serverContent.outputTranscription.text;
            }
            const textParts =
              message.serverContent?.modelTurn?.parts?.filter((p: any) => typeof p.text === 'string') ?? [];
            for (const p of textParts) {
              this.currentOutputTranscription += p.text;
            }

            // 3) Fim do turno: extrair links, limpar buffer
            if (message.serverContent?.turnComplete) {
              this.displayedLinks = this.extractLinks(this.currentOutputTranscription);
              this.currentOutputTranscription = '';
            }

            // 4) Interrompido: parar áudio em reprodução
            if (message.serverContent?.interrupted) {
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
        // === Habilita ENTRADA multimodal e SAÍDA em áudio + texto ===
        config: {
          inputModalities: [Modality.TEXT, Modality.IMAGE, Modality.AUDIO],
          responseModalities: [Modality.AUDIO, Modality.TEXT],
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          // ===== System prompt — entender primeiro, responder depois =====
          systemInstruction: `
Você é o **Amperito**, assistente virtual oficial da **EFALL**.
Regra de ouro: **sempre entender a demanda primeiro** (faça ao menos 1 pergunta objetiva quando houver dúvida) e **só então responder/encaminhar**. Fale sempre por voz. Seja simples, direto e humano.

## Identidade e Tom
- Frases curtas (até 2 linhas). Simpático, consultivo e profissional.
- Nunca inventar informações. Nunca encerrar por conta.
- Se a pergunta for ambígua/incompleta: peça esclarecimento antes de responder.

## Função
Atender três frentes: ⚡ Materiais Elétricos | 🧱 Materiais de Construção | 🔆 Energia Solar (Efall Engenharia).
Entender o que o cliente precisa, orientar com base em estoque real e direcionar ao WhatsApp correto.

## Abertura
“Olá! Eu sou o Amperito, assistente virtual da EFALL. Como posso te ajudar hoje? ⚡😊”
Se o assunto não for claro: “Seu interesse é em energia solar, materiais elétricos ou materiais de construção?”

## Perguntas Básicas
- “Qual seu nome?”
- “De qual cidade você fala?”

## Rotas
### Energia Solar
- “Legal! Qual seu objetivo: economia, backup ou expansão?”
- “Perfeito! Vou te conectar com nosso especialista.”
👉 Efall Engenharia – (54) 9976-8875 — https://wa.me/555499768875

### Materiais Elétricos
- “Certo! Posso te ajudar com informações técnicas e estoque.”
- “Para finalizar sua compra ou garantir o melhor valor, chame direto pelo link.”
👉 Efall Materiais Elétricos – (54) 99694-1592 — https://wa.me/5554996941592

### Materiais de Construção
- “Perfeito! Temos estoque completo para obras e reformas.”
- “Para seguir com orçamento, chame direto no link.”
👉 Efall Materiais de Construção – (54) 3471-1375 — https://wa.me/555434711375

## Política de Preços
Nunca passar valores sem contexto. Explique que varia por tipo/bitola/potência/aplicação.
Use: “Depende de alguns fatores técnicos. Posso coletar informações para te encaminhar o melhor valor?”

## Objeções
- Preço: “Entendo. Nosso foco é economia real e segurança. Quer que eu peça uma avaliação?”
- Humano: “Claro, vou te direcionar agora. Clique no link na tela.”

## Fechamento
Confirme se ajudou e mantenha a conversa aberta.
          `,
        },
      });
    } catch (e) {
      console.error(e);
      this.updateError('Falha ao iniciar sessão.');
    }
  }

  // ===== Helpers =====
  private getLinkName(link: string): string {
    if (link.includes('555499768875')) return 'Especialista Solar';
    if (link.includes('5554996941592')) return 'Materiais Elétricos';
    if (link.includes('555434711375')) return 'Materiais de Construção';
    return link;
  }

  private extractLinks(text: string): string[] {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.match(urlRegex) || [];
  }

  private updateStatus(msg: string) { this.status = msg; }
  private updateError(msg: string) { this.error = msg; }

  // ===== Mic control =====
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
        if (!this.isRecording || this.isPaused) return;
        const pcmData = ev.inputBuffer.getChannelData(0);
        this.sessionPromise
          .then((session) => session.sendRealtimeInput({ media: createBlob(pcmData) }))
          .catch((err) => this.updateError(String(err)));
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.isPaused = false;
      this.updateStatus('🔴 Gravando… Capturando áudio.');
    } catch (err: any) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err?.message ?? err}`);
      this.stopRecording();
    }
  }

  private async pauseListening() {
    if (!this.isRecording || this.isPaused) return;
    try { this.mediaStream?.getAudioTracks().forEach((t) => (t.enabled = false)); } catch {}
    try { await this.sessionPromise.then((s) => s.sendRealtimeInput({ turnComplete: {} })); } catch {}
    this.isPaused = true;
    this.updateStatus('⏸️ Pausado. Processando resposta…');
  }

  private async resumeListening() {
    if (!this.isRecording || !this.isPaused) return;
    try { this.mediaStream?.getAudioTracks().forEach((t) => (t.enabled = true)); } catch {}
    try { await this.inputAudioContext.resume(); } catch {}
    this.isPaused = false;
    this.updateStatus('🎙️ Retomado. Capturando áudio novamente.');
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext) return;

    this.updateStatus('Stopping recording...');
    this.isRecording = false;
    this.isPaused = false;

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

  // ===== Text & Media =====
  private autoResize(el: HTMLTextAreaElement) {
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  private onTextInput(e: Event) {
    const el = e.target as HTMLTextAreaElement;
    this.textInput = el.value;
    this.autoResize(el);
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendTextAndMedia();
    }
  }

  private async onFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const files = Array.from(input.files);
    for (const f of files) {
      const mime = (f.type || '').toLowerCase();
      const isImg = mime.startsWith('image/');
      const isAudio = mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm)$/i.test(f.name);

      const entry: PendingMedia = {
        file: f,
        kind: isImg ? 'image' : isAudio ? 'audio' : 'other',
        label: f.name
      };

      if (isImg) {
        entry.preview = await this.fileToDataURL(f);
        this.imagePreviews = [...this.imagePreviews, entry.preview];
      } else if (isAudio) {
        this.audioChips = [...this.audioChips, f.name];
      }
      this.pendingFiles.push(entry);
    }
    input.value = '';
  }

  private async fileToDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  private async fileToBase64AndType(file: File): Promise<{ mimeType: string; data: string }> {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return { mimeType: file.type || 'application/octet-stream', data: btoa(bin) };
    // Nota: o SDK aceita inlineData com mimeType correto (image/*, audio/*, etc.)
  }

  private async sendTextAndMedia() {
    if (this.isSending) return;
    const hasText = this.textInput.trim().length > 0;
    const hasMedia = this.pendingFiles.length > 0;
    if (!hasText && !hasMedia) return;

    this.isSending = true;

    // Pausa o mic para não sobrepor
    if (this.isRecording && !this.isPaused) {
      try { await this.pauseListening(); } catch {}
    }

    try {
      const parts: any[] = [];

      // Texto
      if (hasText) {
        parts.push({ text: this.textInput.trim() });
      }

      // Mídias (imagens/áudios)
      for (const item of this.pendingFiles) {
        const { mimeType, data } = await this.fileToBase64AndType(item.file);
        parts.push({ inlineData: { mimeType, data } });
      }

      // Envia para a sessão Live
      await this.sessionPromise.then((s) => {
        (s as any).send?.({ clientContent: { parts } });
        s.sendRealtimeInput({ turnComplete: {} });
      });

      // Limpa UI
      this.textInput = '';
      this.pendingFiles = [];
      this.imagePreviews = [];
      this.audioChips = [];

      // reseta altura do textarea
      const ta = this.renderRoot?.querySelector('textarea.input') as HTMLTextAreaElement | null;
      if (ta) { ta.value = ''; this.autoResize(ta); }

      this.updateStatus('Mensagem enviada. Aguardando resposta…');
    } catch (e: any) {
      console.error(e);
      this.updateError(e?.message ?? String(e));
    } finally {
      this.isSending = false;
    }
  }

  // ===== Render =====
  render() {
    return html`
      <div>
        ${this.displayedLinks.length ? html`
          <div class="links-box">
            <h3>Links úteis</h3>
            <div class="links-list">
              ${this.displayedLinks.map(
                (l) => html`<a href=${l} target="_blank" rel="noreferrer">${this.getLinkName(l)}</a>`
              )}
            </div>
          </div>
        ` : null}

        ${(this.imagePreviews.length || this.audioChips.length) ? html`
          <div class="previews">
            ${this.imagePreviews.map((src) => html`<div class="thumb" title="imagem selecionada"><img src=${src} alt="preview" /></div>`)}
            ${this.audioChips.map((name) => html`<div class="chip" title="áudio selecionado">🎵 ${name}</div>`)}
          </div>
        ` : null}

        <!-- Composer (ChatGPT-like) -->
        <div class="composer" role="form" aria-label="Enviar mensagem e mídias">
          <div class="textarea-wrap">
            <textarea
              class="input"
              placeholder="Descreva sua demanda (Shift+Enter quebra linha)…"
              .value=${this.textInput}
              @input=${this.onTextInput}
              @keydown=${this.onKeyDown}
              rows="1"
            ></textarea>
          </div>

          <label class="icon-btn" for="fileUpload" title="Enviar foto/áudio (📷/🎵)">
            📷
          </label>
          <input
            id="fileUpload"
            class="hidden-input"
            type="file"
            accept="image/*,audio/*,.mp3,.wav,.m4a,.ogg,.webm"
            multiple
            @change=${this.onFileChange}
          />

          <button class="send-btn" @click=${this.sendTextAndMedia} ?disabled=${this.isSending}>Enviar</button>
        </div>

        <!-- Mic controls -->
        <div class="controls" aria-label="Controles de microfone">
          <button class="circle" @click=${this.reset} ?disabled=${this.isRecording} title="Reset">🔄</button>
          <button class="circle" @click=${this.startRecording} ?disabled=${this.isRecording} title="Start">🎙️</button>
          ${this.isRecording ? html`
            <button class="circle"
              @click=${this.isPaused ? this.resumeListening : this.pauseListening}
              title=${this.isPaused ? 'Retomar' : 'Pausar e Responder'}
            >
              ${this.isPaused ? '▶️' : '⏸️'}
            </button>
          ` : null}
          <button class="circle" @click=${this.stopRecording} ?disabled=${!this.isRecording} title="Stop">⏹️</button>
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
