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

type ChatEntry = {
  role: 'user' | 'assistant';
  kind: 'text' | 'media' | 'audio';
  text?: string;
  images?: string[];  // dataURLs
  audios?: string[];  // nomes de arquivos
  ts: number;
};

type PendingMedia = {
  file: File;
  kind: 'image' | 'audio' | 'other';
  preview?: string;
  label?: string;
};

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  // ===== States =====
  @state() isRecording = false;
  @state() isPaused = false; // quando true: mic travado p/ o Amperito responder
  @state() status = '';
  @state() error = '';
  @state() currentOutputTranscription = '';
  @state() displayedLinks: string[] = [];

  // Entrada do usuário
  @state() textInput = '';
  @state() imagePreviews: string[] = [];
  @state() audioChips: string[] = [];
  private pendingFiles: PendingMedia[] = [];
  @state() isSending = false;

  // Histórico + overlay
  @state() chatHistory: ChatEntry[] = [];
  private readonly overlayMax = 6;

  // ===== Audio / Session =====
  private client!: GoogleGenAI;
  private sessionPromise!: Promise<Session>;

  // Audio contexts (com fallback Safari)
  private inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
  private outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();

  private nextStartTime = 0;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();

  // ===== Styles =====
  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background: radial-gradient(1200px 1200px at 70% 0%, #183a84 0%, #0b1f4a 50%, #081533 100%);
      position: relative;
      color: #eaf1ff;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }

    /* Painel de chat (WhatsApp-like) */
    .chat-panel {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      top: 20px;
      bottom: 28vh; /* espaço para previews/composer/controles */
      width: min(860px, 92%);
      overflow-y: auto;
      padding: 12px 8px 80px;
      box-sizing: border-box;
    }
    .day-sep {
      text-align: center;
      margin: 8px 0 12px;
      font-size: 12px;
      opacity: .75;
    }
    .msg {
      display: inline-block;
      max-width: 76%;
      margin: 6px 0;
      padding: 10px 12px;
      border-radius: 16px;
      line-height: 1.35;
      position: relative;
      box-shadow: 0 6px 20px rgba(0,0,0,.18);
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .msg.user {
      background: #2f70ff;
      color: #fff;
      border: 1px solid rgba(255,255,255,.12);
      margin-left: auto;
      border-bottom-right-radius: 6px;
    }
    .msg.assistant {
      background: rgba(255,255,255,.06);
      color: #eaf1ff;
      border: 1px solid rgba(255,255,255,.08);
      margin-right: auto;
      border-bottom-left-radius: 6px;
    }
    .bubble { display: flex; flex-direction: column; gap: 8px; }
    .thumbs { display: flex; gap: 6px; flex-wrap: wrap; }
    .thumb {
      width: 120px; height: 120px; border-radius: 10px; overflow: hidden;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.06);
    }
    .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip {
      height: 26px; display:inline-flex; align-items:center; gap:6px; padding:0 10px;
      border-radius:999px; border:1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.08); color:#fff; font-size:12px;
    }
    .ts { font-size: 11px; opacity: .75; margin-top: 2px; align-self: flex-end; }

    /* Overlay "máquina de escrever" meio apagado */
    .overlay {
      position: fixed;
      left: 24px; right: 24px; bottom: calc(18vh + 230px);
      z-index: 22;
      display: grid;
      gap: 4px;
      pointer-events: none;
      font-family: "Courier New", ui-monospace, SFMono-Regular, Menlo, monospace;
      opacity: .55;
      color: #cfe0ff;
      text-shadow: 0 1px 0 rgba(0,0,0,.25);
      max-height: 34vh;
      overflow: hidden;
      mask-image: linear-gradient(to bottom, rgba(0,0,0,1), rgba(0,0,0,.85), rgba(0,0,0,0));
    }
    .overlay-line { font-size: 13px; letter-spacing: .2px; white-space: pre-wrap; }

    /* Caixa de links úteis */
    .links-box {
      position: fixed; left: 50%; transform: translateX(-50%);
      bottom: calc(18vh + 200px); z-index: 30;
      background: rgba(8,21,51,.85); backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,.12); border-radius: 12px;
      padding: 12px 14px; color: #fff; width: min(640px, 92%);
    }
    .links-box h3 { margin: 0 0 6px 0; font-size: 14px; font-weight: 600; opacity:.9; border-bottom: 1px dashed rgba(255,255,255,.15); padding-bottom: 6px; }
    .links-list { display:flex; flex-wrap:wrap; gap:6px; }
    .links-list a {
      display:inline-block; color:#9cc3ff; background:rgba(255,255,255,.06);
      border:1px solid rgba(255,255,255,.08); border-radius:8px; padding:6px 10px; text-decoration:none; font-size:13px;
    }
    .links-list a:hover { background: rgba(156,195,255,.18); color:#fff; }

    /* Previews antes de enviar */
    .previews {
      position: fixed; left: 50%; transform: translateX(-50%);
      bottom: calc(18vh + 60px); z-index: 35; display:flex; gap:8px; flex-wrap:wrap; width:min(780px, 92%);
    }
    .p-thumb { width:56px; height:56px; border-radius:10px; overflow:hidden; border:1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); }
    .p-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
    .p-chip { height:28px; display:inline-flex; align-items:center; gap:6px; padding:0 10px; border-radius:999px; border:1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.08); color:#fff; font-size:12px; }

    /* Composer (ChatGPT-like) */
    .composer {
      position: fixed; left: 50%; transform: translateX(-50%);
      bottom: 18vh; z-index: 40; width: min(780px, 92%);
      display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: end;
    }
    .textarea-wrap {
      background: rgba(8,21,51,.85); border:1px solid rgba(255,255,255,.18);
      border-radius:14px; padding:8px; display:flex; gap:8px; align-items:center;
      box-shadow: 0 8px 22px rgba(0,0,0,.35);
    }
    textarea.input {
      width:100%; max-height:140px; min-height:44px; resize:none; border:none; outline:none;
      background:transparent; color:#fff; font-size:15px; line-height:1.35;
    }
    .icon-btn, .send-btn {
      height:44px; border-radius:12px; border:1px solid rgba(255,255,255,.18);
      background: rgba(255,255,255,.08); color:#fff; cursor:pointer; font-weight:600; transition:.15s ease;
    }
    .icon-btn { width:46px; display:grid; place-items:center; font-size:18px; }
    .icon-btn:hover { background: rgba(255,255,255,.18); }
    .send-btn { padding:0 14px; background:#2f70ff; border-color: rgba(47,112,255,.9); }
    .send-btn:hover { filter: brightness(1.05); }
    .send-btn[disabled] { opacity:.6; cursor:not-allowed; }
    .hidden-input { display:none; }

    /* Controles — mic único com 3 estados */
    .controls {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      bottom: 8vh;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .mic {
      width: 64px; height: 64px;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,.18);
      background: rgba(255,255,255,.10);
      color:#fff; font-size:26px;
      display:grid; place-items:center;
      cursor:pointer; transition:.15s ease;
      box-shadow: 0 8px 22px rgba(0,0,0,.35);
    }
    .mic:hover { background: rgba(255,255,255,.20); }
    .mic.active { outline: 2px solid rgba(47,112,255,.9); }
    .mic.locked { background: rgba(8,21,51,.55); }

    #status {
      position:fixed; bottom:3.5vh; left:0; right:0; z-index:10;
      text-align:center; color:#cfe0ff; font-size:13px; opacity:.9; padding:0 10px;
    }

    @media (max-width: 768px) {
      .composer { bottom: 22vh; }
      .controls { bottom: 11vh; }
      .overlay { bottom: calc(22vh + 230px); }
      .chat-panel { bottom: 30vh; }
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
      // ⚠️ Em produção, mover para backend/proxy
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
          onopen: async () => {
            this.updateStatus('Opened');
            // 👋 Saudação automática na abertura (fala e escreve)
            try {
              const s = await this.sessionPromise;
              (s as any).send?.({
                clientContent: {
                  parts: [{
                    text:
`Apresente-se imediatamente com a abertura oficial:
"Olá! Eu sou o Amperito, assistente virtual da EFALL. Como posso te ajudar hoje? ⚡😊"
Pergunte de forma objetiva:
"Seu interesse é em energia solar, materiais elétricos ou materiais de construção?"
E peça também:
"Qual seu nome e de qual cidade você fala?"`
                  }]
                }
              });
              s.sendRealtimeInput({ turnComplete: {} });
            } catch (e) {
              console.error('Saudação automática falhou', e);
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            // ÁUDIO de saída (fila)
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData;
            if (audio) {
              this.nextStartTime = Math.max(this.nextStartTime, this.outputAudioContext.currentTime);
              const audioBuffer = await decodeAudioData(decode(audio.data), this.outputAudioContext, 24000, 1);
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => this.sources.delete(source));
              source.start(this.nextStartTime);
              this.nextStartTime += audioBuffer.duration;
              this.sources.add(source);
            }

            // TEXTO (transcrição e partes textuais)
            if (message.serverContent?.outputTranscription) {
              this.currentOutputTranscription += message.serverContent.outputTranscription.text;
            }
            const textParts = message.serverContent?.modelTurn?.parts?.filter((p: any) => typeof p.text === 'string') ?? [];
            for (const p of textParts) this.currentOutputTranscription += p.text;

            // Fim do turno → push no histórico + links
            if (message.serverContent?.turnComplete) {
              const text = this.currentOutputTranscription.trim();
              if (text) {
                this.pushAssistantText(text);
                this.displayedLinks = this.extractLinks(text);
              }
              this.currentOutputTranscription = '';
            }

            // Interrompido → para fila
            if (message.serverContent?.interrupted) {
              for (const src of this.sources.values()) { try { src.stop(); } catch {} this.sources.delete(src); }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => this.updateError(e.message),
          onclose: (e: CloseEvent) => this.updateStatus('Close: ' + e.reason),
        },
        config: {
          inputModalities: [Modality.TEXT, Modality.IMAGE, Modality.AUDIO],
          responseModalities: [Modality.AUDIO, Modality.TEXT],
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          systemInstruction: `
Você é o **Amperito**, assistente virtual oficial da **EFALL**.
Regra de ouro: entenda primeiro; responda/encaminhe depois. Fale por voz e escreva curto. Se houver dúvida, faça 1 pergunta objetiva.

Frentes: ⚡ Materiais Elétricos | 🧱 Materiais de Construção | 🔆 Energia Solar.
Abra: “Olá! Eu sou o Amperito, assistente virtual da EFALL. Como posso te ajudar hoje? ⚡😊”
Se não estiver claro: “Seu interesse é em energia solar, materiais elétricos ou materiais de construção?”
Pergunte: nome e cidade. Nunca passe preços sem contexto. Mantenha a conversa aberta.
Rotas WhatsApp:
- Engenharia Solar: https://wa.me/555499768875
- Materiais Elétricos: https://wa.me/5554996941592
- Materiais de Construção: https://wa.me/555434711375
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
  private scrollChatToBottom() {
    const panel = this.renderRoot?.querySelector('.chat-panel') as HTMLElement | null;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }

  // ===== Mic: botão único com 3 estados =====
  private async toggleMic() {
    try {
      // Parado → iniciar
      if (!this.isRecording) {
        await this.startRecording();
        this.updateStatus('🎙️ Ouvindo… fale com o Amperito.');
        return;
      }
      // Ouvindo → travar (envia turnComplete)
      if (this.isRecording && !this.isPaused) {
        await this.pauseListening(); // já envia turnComplete
        this.updateStatus('🔇 Microfone travado. Processando resposta…');
        return;
      }
      // Travado → retomar
      if (this.isRecording && this.isPaused) {
        await this.resumeListening();
        this.updateStatus('🎙️ Retomado. Pode falar.');
        return;
      }
    } catch (e:any) {
      console.error(e);
      this.updateError(e?.message ?? String(e));
    }
  }

  // ===== Mic control (stream PCM para Live) =====
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
      this.pushUserAudioMarker();
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
  }

  private async resumeListening() {
    if (!this.isRecording || !this.isPaused) return;
    try { this.mediaStream?.getAudioTracks().forEach((t) => (t.enabled = true)); } catch {}
    try { await this.inputAudioContext.resume(); } catch {}
    this.isPaused = false;
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

    this.updateStatus('Recording stopped. Clique no microfone para iniciar.');
  }

  private reset() {
    try { (this as any).sessionPromise?.then((s: Session) => s.close()); } catch {}
    this.initSession();
    this.updateStatus('Session cleared.');
  }

  // ===== Entrada de texto & mídia =====
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
  }

  private async sendTextAndMedia() {
    if (this.isSending) return;
    const hasText = this.textInput.trim().length > 0;
    const hasMedia = this.pendingFiles.length > 0;
    if (!hasText && !hasMedia) return;

    this.isSending = true;

    // Se estiver ouvindo, travar para o Amperito responder em paz
    if (this.isRecording && !this.isPaused) {
      try { await this.pauseListening(); } catch {}
    }

    try {
      const parts: any[] = [];
      if (hasText) parts.push({ text: this.textInput.trim() });

      // Mídias (imagens/áudios)
      const sentImages: string[] = [];
      const sentAudios: string[] = [];

      for (const item of this.pendingFiles) {
        const { mimeType, data } = await this.fileToBase64AndType(item.file);
        parts.push({ inlineData: { mimeType, data } });
        if (item.kind === 'image' && item.preview) sentImages.push(item.preview);
        if (item.kind === 'audio' && item.label) sentAudios.push(item.label);
      }

      const s = await this.sessionPromise;
      (s as any).send?.({ clientContent: { parts } });
      s.sendRealtimeInput({ turnComplete: {} });

      // Histórico
      if (hasText) this.pushUserText(this.textInput.trim());
      if (sentImages.length || sentAudios.length) this.pushUserMedia(sentImages, sentAudios);

      // Limpeza UI
      this.textInput = '';
      this.pendingFiles = [];
      this.imagePreviews = [];
      this.audioChips = [];

      const ta = this.renderRoot?.querySelector('textarea.input') as HTMLTextAreaElement | null;
      if (ta) { ta.value = ''; this.autoResize(ta); }

      this.updateStatus('Mensagem enviada. Aguardando resposta…');
      this.scrollChatToBottom();
    } catch (e: any) {
      console.error(e);
      this.updateError(e?.message ?? String(e));
    } finally {
      this.isSending = false;
    }
  }

  // ===== Histórico (helpers) =====
  private pushUserText(text: string) {
    this.chatHistory = [...this.chatHistory, { role: 'user', kind: 'text', text, ts: Date.now() }];
    this.scrollChatToBottom();
  }
  private pushUserMedia(images: string[], audios: string[]) {
    if (!images.length && !audios.length) return;
    this.chatHistory = [...this.chatHistory, { role: 'user', kind: 'media', images, audios, ts: Date.now() }];
    this.scrollChatToBottom();
  }
  private pushUserAudioMarker() {
    this.chatHistory = [...this.chatHistory, { role: 'user', kind: 'audio', text: '🎙️ Você enviou áudio pelo microfone', ts: Date.now() }];
    this.scrollChatToBottom();
  }
  private pushAssistantText(text: string) {
    this.chatHistory = [...this.chatHistory, { role: 'assistant', kind: 'text', text, ts: Date.now() }];
    this.scrollChatToBottom();
  }

  // ===== Render =====
  private fmtTime(ts: number) {
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  }
  private overlayLines(): string[] {
    const lines: string[] = [];
    const pick = [...this.chatHistory].slice(-this.overlayMax);
    for (const m of pick) {
      const who = m.role === 'user' ? 'Você' : 'Amperito';
      if (m.kind === 'text' && m.text) lines.push(`> ${who}: ${m.text}`);
      else if (m.kind === 'audio') lines.push(`> ${who}: [ÁUDIO]`);
      else if (m.kind === 'media') {
        const parts: string[] = [];
        if (m.images?.length) parts.push(`[${m.images.length} FOTO(s)]`);
        if (m.audios?.length) parts.push(`[${m.audios.length} ÁUDIO(s)]`);
        lines.push(`> ${who}: ${parts.join(' ') || '[MÍDIA]'}`);
      }
    }
    return lines;
  }

  render() {
    return html`
      <!-- Chat -->
      <div class="chat-panel" aria-live="polite">
        ${this.chatHistory.length === 0 ? html`<div class="day-sep">Hoje</div>` : null}
        ${this.chatHistory.map((m) => html`
          <div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">
            <div class="bubble">
              ${m.kind === 'text' && m.text ? html`<div>${m.text}</div>` : null}
              ${m.kind === 'audio' ? html`<div class="chips"><span class="chip">🎙️ Áudio enviado</span></div>` : null}
              ${m.kind === 'media' ? html`
                ${m.images?.length ? html`
                  <div class="thumbs">
                    ${m.images.map((src) => html`<div class="thumb"><img src=${src} alt="imagem enviada" /></div>`)}
                  </div>` : null}
                ${m.audios?.length ? html`
                  <div class="chips">
                    ${m.audios.map((name) => html`<span class="chip">🎵 ${name}</span>`)}
                  </div>` : null}
              ` : null}
              <div class="ts">${this.fmtTime(m.ts)}</div>
            </div>
          </div>
        `)}
      </div>

      <!-- Overlay máquina de escrever -->
      <div class="overlay" aria-hidden="true">
        ${this.overlayLines().map((line) => html`<div class="overlay-line">${line}</div>`)}
      </div>

      ${this.displayedLinks.length ? html`
        <div class="links-box">
          <h3>Links úteis</h3>
          <div class="links-list">
            ${this.displayedLinks.map(
              (l) => html`<a href=${l} target="_blank" rel="noreferrer">${this.getLinkName(l)}</a>`
            )}
          </div>
        </div>` : null}

      ${(this.imagePreviews.length || this.audioChips.length) ? html`
        <div class="previews">
          ${this.imagePreviews.map((src) => html`<div class="p-thumb"><img src=${src} alt="preview" /></div>`)}
          ${this.audioChips.map((name) => html`<div class="p-chip">🎵 ${name}</div>`)}
        </div>` : null}

      <!-- Composer -->
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

        <label class="icon-btn" for="fileUpload" title="Enviar foto/áudio (📷/🎵)">📷</label>
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

      <!-- Controles: botão único do microfone -->
      <div class="controls" aria-label="Microfone">
        <button
          class="mic ${this.isRecording ? (this.isPaused ? 'locked' : 'active') : ''}"
          @click=${this.toggleMic}
          title=${!this.isRecording
            ? 'Iniciar microfone'
            : this.isPaused
              ? 'Retomar microfone'
              : 'Travar microfone para o Amperito responder'}
        >
          ${!this.isRecording ? '🎙️' : this.isPaused ? '🔇' : '🎙️'}
        </button>
      </div>

      <div id="status">${this.error ? `Erro: ${this.error}` : this.status}</div>

      <gdm-live-audio-visuals-3d
        .inputNode=${this.inputNode}
        .outputNode=${this.outputNode}>
      </gdm-live-audio-visuals-3d>
    `;
  }
}

export {};
