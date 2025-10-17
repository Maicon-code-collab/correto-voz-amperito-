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
  @state() isPaused = false;
  @state() status = '';
  @state() error = '';
  @state() currentOutputTranscription = '';
  @state() displayedLinks: string[] = [];

  // UI de texto e imagens
  @state() textInput = '';
  @state() imagePreviews: string[] = []; // dataURL para preview
  private pendingFiles: File[] = [];
  @state() isSending = false;

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
      bottom: calc(10vh + 230px);
      left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      background: rgba(20, 20, 30, 0.85);
      border-radius: 12px;
      padding: 15px 20px;
      font-family: sans-serif;
      color: white;
      width: 90%;
      max-width: 520px;
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
    .links-box a:hover { background: rgba(144, 200, 255, 0.25); color: #ffffff; }

    #status {
      position: absolute;
      bottom: 5vh;
      left: 0; right: 0;
      z-index: 10;
      text-align: center;
      color: #fff;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }

    /* Controles (rec, stop, pause) */
    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0; right: 0;
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
      width: 64px; height: 64px;
      cursor: pointer;
      font-size: 24px;
      padding: 0; margin: 0;
    }
    .controls button:hover { background: rgba(255, 255, 255, 0.2); }
    .controls button[disabled] { display: none; }

    /* Barra de entrada (texto + upload) */
    .input-bar {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: calc(10vh + 90px);
      display: flex;
      gap: 8px;
      width: 92%;
      max-width: 620px;
      z-index: 10;
      align-items: center;
    }
    .input-bar input[type="text"] {
      flex: 1;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(20,20,30,0.85);
      color: #fff;
      outline: none;
      font-size: 15px;
    }
    .input-bar input[type="file"] { display: none; }
    .icon-btn {
      width: 44px; height: 44px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.1);
      color: #fff; font-size: 20px; cursor: pointer;
    }
    .send-btn {
      padding: 0 16px; height: 44px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.2);
      background: #2f70ff; color: #fff; font-weight: 600; cursor: pointer;
    }
    .send-btn[disabled] { opacity: .6; cursor: not-allowed; }

    .previews {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: calc(10vh + 150px);
      display: flex;
      gap: 6px;
      width: 92%;
      max-width: 620px;
      z-index: 10;
      flex-wrap: wrap;
    }
    .thumb {
      width: 56px; height: 56px;
      border-radius: 8px; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.06);
    }
    .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
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
      // ====== API KEY INSERIDA DIRETAMENTE ======
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

            if (message.serverContent?.interrupted) {
              for (const src of this.sources.values()) { try { src.stop(); } catch {} this.sources.delete(src); }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => this.updateError(e.message),
          onclose: (e: CloseEvent) => this.updateStatus('Close: ' + e.reason),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          // ====== PROMPT DO AMPERITO ATUALIZADO ======
          systemInstruction: `
Você é o **Amperito**, assistente virtual oficial da **EFALL**.

## 1️⃣ IDENTIDADE E TOM
- Estilo simpático, direto e profissional.
- Frases curtas (máx. 2 linhas).
- Linguagem consultiva e humana.
- Sempre perguntar antes de oferecer.
- Nunca inventar informações.
- Nunca encerrar por conta própria.
- Sempre responder por voz.
- Foco: entender, orientar e direcionar.
- Valorizar os 9 anos de história da EFALL, construída com honestidade, inovação e confiança em cada relação.

## 2️⃣ FUNÇÃO
Sou o Amperito, assistente virtual da EFALL.
Atendo em três frentes:
⚡ Materiais Elétricos
🧱 Materiais de Construção
🔆 Energia Solar (Efall Engenharia)

Meu papel é entender a necessidade do cliente, oferecer orientação técnica com base em estoque real e direcionar para o setor correto via WhatsApp.

## 3️⃣ FLUXO DE ATENDIMENTO

### 🟢 ABERTURA
“Olá! Eu sou o Amperito, assistente virtual da EFALL. Como posso te ajudar hoje? ⚡😊”
Se o cliente não especificar o assunto, perguntar:
“Seu interesse é em energia solar, materiais elétricos ou materiais de construção?”

### 🟡 PERGUNTAS BÁSICAS
- “Qual seu nome?”
- “De qual cidade você fala?”

### 🔆 SE FOR ENERGIA SOLAR
- “Legal! Qual seu objetivo: economia, backup ou expansão?”
- “Perfeito! Vou te conectar com nosso especialista.”
👉 Efall Engenharia – (54) 9976-8875 — https://wa.me/555499768875
📍 Estr. Antiga Geral Bento – Dois Lajeados/RS
📬 CEP 99220-000
✉️ comercial@efall.net

### ⚡ SE FOR MATERIAIS ELÉTRICOS
- “Certo! Posso te ajudar com informações técnicas e estoque.”
- “Para finalizar sua compra ou garantir o melhor valor, chame direto pelo link.”
👉 Efall Materiais Elétricos – (54) 99694-1592 — https://wa.me/5554996941592
📍 Rua Arthur Schlichting, 198 – Jardim Glória, Bento Gonçalves/RS
📬 CEP 95701-210
✉️ comercial1@efall.net

### 🧱 SE FOR MATERIAIS DE CONSTRUÇÃO
- “Perfeito! Temos estoque completo para obras e reformas.”
- “Para seguir com orçamento, chame direto no link.”
👉 Efall Materiais de Construção – (54) 3471-1375 — https://wa.me/555434711375
📍 Rua Thomaz Gonzaga, 556 – Centro, Dois Lajeados/RS
📬 CEP 99220-000
✉️ comercial@efall.net

## 4️⃣ HISTÓRICO E POSICIONAMENTO
Há mais de 9 anos, a EFALL vem transformando a forma como pessoas e empresas se conectam com a energia.
Com uma trajetória marcada por inovação, segurança e excelência técnica, tornou-se uma das principais referências em energia solar, materiais elétricos e construção do Sul do Brasil.
Mais do que energia, a EFALL entrega confiança, economia real e futuro sustentável, com equipe própria, projetos personalizados e atendimento próximo.

## 5️⃣ POLÍTICA DE PREÇOS
- Nunca informar valores fixos.
- Explicar que os preços variam conforme tipo, bitola, potência ou aplicação.
- Dizer: “Depende de alguns fatores técnicos. Posso coletar informações para te encaminhar o melhor valor com meu colega humano?”

## 6️⃣ OBJEÇÕES COMUNS
🪙 Preço: “Depende de diagnóstico. Posso coletar alguns dados para te encaminhar o melhor valor?”
💰 Está caro: “Entendo. Nosso foco é economia real e segurança. Quer que eu peça uma avaliação pra você?”
🗣️ Quer falar com alguém: “Claro, vou te direcionar agora. Clique no link na tela.”
🏢 Quer cotar com outras empresas: “Aqui você encontra tudo em um só lugar, com estoque completo e suporte técnico real.”
😤 Cliente nervoso: “Compreendo, vamos resolver isso juntos. A EFALL sempre busca soluções seguras e rápidas.”

## 7️⃣ VALORES E PROPÓSITO
🌱 Missão: Fornecer soluções completas que unem qualidade, tecnologia e confiança, transformando obras, impulsionando negócios e tornando a energia mais acessível e segura.
⚡ Visão: Ser referência no Sul do Brasil em energia solar, materiais elétricos e construção, reconhecida pela inovação, atendimento especializado e crescimento sustentável.
💎 Valores: Honestidade, sustentabilidade, valorização das pessoas e compromisso com a eficiência energética.

## 8️⃣ DIFERENCIAL HISTÓRICO
“Mais do que uma empresa, a EFALL é um ecossistema de energia, engenharia e construção que nasceu para conectar pessoas, negócios e o futuro.
EFALL. Energia que nos conecta.”`,
        },
      });
    } catch (e) {
      console.error(e);
      this.updateError('Falha ao iniciar sessão.');
    }
  }

  // Ajusta nomes amigáveis conforme os novos números
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

  // ======= AUDIO (FALA DO USUÁRIO) =======
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
        const inputBuffer = ev.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);
        this.sessionPromise
          .then((session) => session.sendRealtimeInput({ media: createBlob(pcmData) }))
          .catch((err) => this.updateError(String(err)));
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.isPaused = false;
      this.updateStatus('🔴 Recording... Capturing PCM chunks.');
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
    this.updateStatus('⏸️ Pausado. Processando resposta...');
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

  // ======= TEXTO + IMAGENS =======
  private onTextChange(e: Event) {
    this.textInput = (e.target as HTMLInputElement).value;
  }

  private async onFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    // Guarda arquivos e gera previews
    const files = Array.from(input.files).filter((f) => f.type.startsWith('image/'));
    this.pendingFiles.push(...files);
    for (const f of files) {
      const dataUrl = await this.fileToDataURL(f);
      this.imagePreviews = [...this.imagePreviews, dataUrl];
    }

    // limpa o input para permitir re-seleção igual
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
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    return { mimeType: file.type || 'image/png', data: base64 };
  }

  private async sendTextAndImages() {
    if (this.isSending) return;
    const hasText = this.textInput.trim().length > 0;
    const hasImgs = this.pendingFiles.length > 0;
    if (!hasText && !hasImgs) return;

    this.isSending = true;

    // Pausa o mic (se estiver gravando) para o modelo responder sem sobrepor
    if (this.isRecording && !this.isPaused) {
      await this.pauseListening().catch(() => {});
    }

    try {
      const parts: any[] = [];

      if (hasText) {
        parts.push({ text: this.textInput.trim() });
      }

      if (hasImgs) {
        for (const f of this.pendingFiles) {
          const { mimeType, data } = await this.fileToBase64AndType(f);
          parts.push({ inlineData: { mimeType, data } });
        }
      }

      await this.sessionPromise.then((s) => {
        // Envia conteúdo do cliente (texto + imagens)
        (s as any).send?.({
          clientContent: { parts },
        });

        // Fecha o turno para forçar a resposta imediata
        s.sendRealtimeInput({ turnComplete: {} });
      });

      // limpa UI
      this.textInput = '';
      this.pendingFiles = [];
      this.imagePreviews = [];
      this.updateStatus('Mensagem enviada. Aguardando resposta…');
    } catch (e: any) {
      console.error(e);
      this.updateError(e?.message ?? String(e));
    } finally {
      this.isSending = false;
    }
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

        <!-- PREVIEWS DE IMAGEM -->
        ${this.imagePreviews.length
          ? html`
              <div class="previews">
                ${this.imagePreviews.map((src) => html`<div class="thumb"><img src=${src} alt="preview" /></div>`)}
              </div>
            `
          : null}

        <!-- BARRA DE TEXTO + UPLOAD -->
        <div class="input-bar">
          <input
            type="text"
            placeholder="Descreva sua demanda ou cole um link…"
            .value=${this.textInput}
            @input=${this.onTextChange}
            @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.sendTextAndImages(); }}
          />
          <label for="fileUpload" class="icon-btn" title="Enviar fotos">🖼️</label>
          <input id="fileUpload" type="file" accept="image/*" multiple @change=${this.onFileChange} />
          <button class="send-btn" @click=${this.sendTextAndImages} ?disabled=${this.isSending}>Enviar</button>
        </div>

        <!-- CONTROLES DE ÁUDIO -->
        <div class="controls">
          <button id="resetButton" @click=${this.reset} ?disabled=${this.isRecording} title="Reset">🔄</button>

          <button id="startButton" @click=${this.startRecording} ?disabled=${this.isRecording} title="Start">🔴</button>

          ${this.isRecording
            ? html`
                <button
                  id="pauseResumeButton"
                  @click=${this.isPaused ? this.resumeListening : this.pauseListening}
                  title=${this.isPaused ? 'Resume' : 'Pause & Respond'}
                >
                  ${this.isPaused ? '▶️' : '⏸️'}
                </button>
              `
            : null}

          <button id="stopButton" @click=${this.stopRecording} ?disabled=${!this.isRecording} title="Stop">⏹️</button>
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
