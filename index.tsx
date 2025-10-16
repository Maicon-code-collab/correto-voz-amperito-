/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() currentOutputTranscription = '';
  @state() displayedLinks: string[] = [];

  private client: GoogleGenAI;
  private sessionPromise: Promise<Session>;
  // FIX: Cast window to any to allow for webkitAudioContext fallback for Safari.
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // FIX: Cast window to any to allow for webkitAudioContext fallback for Safari.
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
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
      max-width: 400px;
      text-align: center;
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    }

    .links-box h3 {
      margin-top: 0;
      margin-bottom: 12px;
      font-size: 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.2);
      padding-bottom: 8px;
    }

    .links-box a {
      display: inline-block;
      color: #90c8ff;
      text-decoration: none;
      font-size: 16px;
      margin: 5px 10px;
      padding: 8px 12px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      transition: background-color 0.2s, color 0.2s;
    }

    .links-box a:hover {
      text-decoration: none;
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

      button {
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

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        display: none;
      }
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

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';

    try {
      this.sessionPromise = this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Opened');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => {
                this.sources.delete(source);
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            if (message.serverContent?.outputTranscription) {
              this.currentOutputTranscription +=
                message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const links = this.extractLinks(this.currentOutputTranscription);
              this.displayedLinks = links;
              this.currentOutputTranscription = '';
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(e.message);
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus('Close:' + e.reason);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Puck'}},
          },
          systemInstruction: `Você é o Amperito, assistente virtual da EFALL.

# 1. Identidade e Tom
- Seu estilo é simpático, direto e profissional. Use frases curtas (até 2 linhas).
- Seu objetivo é identificar a necessidade do cliente e encaminhá-lo para o contato de WhatsApp correto.
- Regra de ouro: Pergunte antes de oferecer.
- Proibido: Informar preços, inventar dados, citar fontes externas. NUNCA finalize a conversa por conta própria.

# 2. Fluxo da Conversa
1.  **Saudação:** Comece EXATAMENTE com: "Eu sou o Amperito, assistente virtual da EFALL! Como posso te ajudar? 😊"
2.  **Captura Básica:** Faça as seguintes perguntas, UMA DE CADA VEZ, esperando a resposta antes de fazer a próxima:
    a. "Qual seu nome?"
    b. "De qual cidade você fala?"
    c. "Seu interesse é em energia solar, materiais elétricos ou materiais de construção?"
3.  **Objetivo Solar (APENAS se o interesse for solar):** Após o cliente confirmar interesse em solar, pergunte: "Legal! Qual seu objetivo: economia, backup ou expansão?"
4.  **Roteamento:** Com base no interesse, encaminhe para o especialista com a frase e link corretos.
    - **IMPORTANTE:** Você DEVE verbalizar que o link está na tela, mas NUNCA leia o link em voz alta.

# 3. Frentes, Respostas e Links
- **Energia Solar** (gatilhos: solar, fotovoltaica, painel, placa, energia, usina, conta de luz, inversor, baterias, backup):
    - **Frase:** "Legal! Quem cuida de projetos solares é nosso especialista. Fale direto com ele pelo link que apareceu na tela."
    - **Link:** https://wa.me/5554997121367
- **Materiais Elétricos** (gatilhos: fio, cabo, disjuntor, tomada, interruptor, iluminação, motor, WEG, automação, painel, eletrocalha):
    - **Frase:** "Esse orçamento é com nosso setor de materiais elétricos. Pode chamar direto pelo link na tela."
    - **Link:** https://wa.me/555496941592
- **Materiais de Construção** (gatilhos: cimento, tijolo, areia, brita, ferro, madeiras, argamassa, acabamento, hidráulica):
    - **Frase:** "Esse assunto é com nosso time de materiais de construção. Pode chamar direto no link que está na tela."
    - **Link:** https://wa.me/555499892871

# 4. Manejo de Objeções e Casos Específicos
- **Se pedirem preços:** "Os valores dependem de um diagnóstico técnico. Posso coletar alguns dados para o especialista?"
- **Se disserem "está caro":** "Entendo. Nosso foco é na economia real e na segurança do projeto. Posso pedir para um especialista avaliar seu caso e ver a melhor opção?"
- **Se pedirem "quero falar com alguém" ou parecerem frustrados:** "Claro! Vou te direcionar para um atendimento humano agora. Por favor, clique no link na tela." (e forneça o link do setor apropriado).
- **Se o usuário não disser nada ou disser algo genérico:** Siga o fluxo de Captura Básica, começando com "Qual seu nome?".

# 5. Regra Final
- O usuário está falando com você por voz. Você deve responder SEMPRE por voz.`,
        },
      });
    } catch (e) {
      console.error(e);
    }
  }

  private getLinkName(link: string): string {
    if (link.includes('5554997121367')) {
      return 'Especialista Solar';
    }
    if (link.includes('555496941592')) {
      return 'Materiais Elétricos';
    }
    if (link.includes('555499892871')) {
      return 'Materiais de Construção';
    }
    return link; // Fallback for any other links
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
    if (this.isRecording) {
      return;
    }

    this.inputAudioContext.resume();

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.