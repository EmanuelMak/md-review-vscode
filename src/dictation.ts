// Diktieren für das Kommentarfeld. In VS Code-Webviews gibt es kein Mikrofon (getUserMedia scheitert an der
// Permissions-Policy, webkitSpeechRecognition an fehlendem Google-Key in Electron). Deshalb nimmt der
// Extension-Host auf: sox oder ffmpeg schreiben rohes PCM (16 kHz, mono, 16 bit) nach stdout, wir sammeln es,
// bauen daraus eine WAV-Datei und lassen sie lokal von whisper.cpp (whisper-cli) oder über eine
// OpenAI-kompatible API transkribieren. Weil das PCM über stdout kommt, ist egal, wie der Prozess endet.

import * as vscode from 'vscode';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { log } from './provider';

export const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const API_KEY_SECRET = 'mdReview.dictation.apiKey';

export type Engine = 'local' | 'openai';
export type RecorderTool = 'sox' | 'ffmpeg';

export interface DictationSettings {
  engine: Engine;
  language: string;
  recorder: 'auto' | RecorderTool;
  inputDevice: string;
  model: string;
  modelPath: string;
  whisperPath: string;
  soxPath: string;
  ffmpegPath: string;
  apiUrl: string;
  apiModel: string;
  maxSeconds: number;
}

/** Nachricht an die Webview. */
export type DictationMsg =
  | { type: 'dictation'; state: 'recording' | 'transcribing' | 'idle' }
  | { type: 'dictation'; state: 'done'; text: string }
  | { type: 'dictation'; state: 'error'; message: string };

// ------------------------------------------------------------ reine Hilfsfunktionen

/** Download-Adresse eines whisper.cpp-Modells (z. B. "small", "large-v3-turbo-q5_0"). */
export function modelUrl(name: string): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
}

/** Ungefähre Größe für die Rückfrage vor dem Download. */
export function modelSize(name: string): string {
  const sizes: Record<string, string> = {
    tiny: '75 MB',
    base: '142 MB',
    small: '466 MB',
    medium: '1,5 GB',
    'large-v3-turbo-q5_0': '547 MB',
    'large-v3-turbo': '1,6 GB',
    'large-v3': '2,9 GB',
  };
  return sizes[name] ?? 'einige hundert MB';
}

/** Sucht ein Programm: erst die Einstellung, dann PATH, dann die üblichen Homebrew-Ordner. */
export function findTool(
  names: string[],
  explicit: string,
  platform: NodeJS.Platform = process.platform,
  envPath = process.env.PATH ?? '',
  exists: (p: string) => boolean = isFile,
): string | undefined {
  if (explicit) return exists(explicit) ? explicit : undefined;
  const sep = platform === 'win32' ? ';' : ':';
  const extra = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : platform === 'linux' ? ['/usr/local/bin', '/usr/bin'] : [];
  const dirs = [...envPath.split(sep).filter(Boolean), ...extra];
  const exts = platform === 'win32' ? ['.exe', ''] : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        if (exists(p)) return p;
      }
    }
  }
  return undefined;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Kommandozeile für die Aufnahme: rohes PCM s16le, 16 kHz, mono nach stdout. */
export function recorderArgs(tool: RecorderTool, platform: NodeJS.Platform, device: string): string[] {
  const raw = ['-t', 'raw', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-'];
  if (tool === 'sox') {
    if (!device) return ['-q', '-d', ...raw];
    const driver = platform === 'darwin' ? 'coreaudio' : platform === 'win32' ? 'waveaudio' : 'alsa';
    return ['-q', '-t', driver, device, ...raw];
  }
  const input =
    platform === 'darwin'
      ? ['-f', 'avfoundation', '-i', `:${device || 'default'}`]
      : platform === 'win32'
        ? ['-f', 'dshow', '-i', `audio=${device}`]
        : ['-f', 'pulse', '-i', device || 'default'];
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'];
}

/** Audio-Geräte aus `ffmpeg -list_devices true -f dshow -i dummy` (stderr). */
export function parseDshowAudioDevices(stderr: string): string[] {
  const out: string[] = [];
  let audioSection = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/DirectShow audio devices/i.test(line)) audioSection = true;
    else if (/DirectShow video devices/i.test(line)) audioSection = false;
    const m = /"([^"]+)"(?:\s*\((audio|video|none)\))?\s*$/.exec(line);
    if (!m || /Alternative name/i.test(line)) continue;
    if (m[2] === 'audio' || (!m[2] && audioSection)) out.push(m[1]);
  }
  return out;
}

/** 44-Byte-Kopf einer PCM-WAV-Datei. */
export function wavHeader(dataBytes: number, sampleRate = SAMPLE_RATE, channels = 1, bits = 16): Buffer {
  const h = Buffer.alloc(44);
  const blockAlign = (channels * bits) / 8;
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function toWav(pcm: Buffer): Buffer {
  const even = pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
  return Buffer.concat([wavHeader(even.length), even]);
}

/** Lautester 100-ms-Abschnitt als RMS (0…1). Stille oder ein gesperrtes Mikrofon liefern fast 0. */
export function peakLevel(pcm: Buffer): number {
  const win = SAMPLE_RATE / 10;
  let best = 0;
  for (let start = 0; start + 1 < pcm.length; start += win * 2) {
    let sum = 0;
    let n = 0;
    for (let i = start; i + 1 < Math.min(pcm.length, start + win * 2); i += 2) {
      const s = pcm.readInt16LE(i) / 32768;
      sum += s * s;
      n++;
    }
    if (n) best = Math.max(best, Math.sqrt(sum / n));
  }
  return best;
}

/** Unter diesem Pegel (≈ −42 dBFS) gilt die Aufnahme als stumm. */
export const SILENCE_LEVEL = 0.008;

// whisper erfindet bei Stille gern Abspann-Sätze aus seinen Trainingsdaten.
const HALLUCINATIONS = [
  /^untertitel(ung)?\b.*\b(zdf|ard|wdr|ndr|swr|br|mdr|funk|amara|stephanie geiges)\b.*$/i,
  /^(vielen )?dank (fürs|für's|für das) zu(schauen|hören)[.!]?$/i,
  /^bis zum nächsten mal[.!]?$/i,
  /^copyright\b.*$/i,
];

/** Macht aus der whisper-Ausgabe einen Kommentartext: Zeilen zusammen, Geräusch-Tags raus. */
export function cleanTranscript(text: string): string {
  const s = text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^\s*\((?:musik|stille|lachen|applaus|geräusche?|räuspern|husten)[^)]*\)\s*$/gim, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return HALLUCINATIONS.some((r) => r.test(s)) ? '' : s;
}

/** Text für den Hinweis, wenn Programme fehlen. `command`: was man im Terminal ausführen kann. */
export function installHint(platform: NodeJS.Platform, missing: { recorder: boolean; whisper: boolean }): { text: string; command?: string } {
  const parts: string[] = [];
  if (missing.recorder) parts.push('ein Aufnahmeprogramm (sox oder ffmpeg)');
  if (missing.whisper) parts.push('whisper.cpp (whisper-cli)');
  const what = `Zum Diktieren fehlt ${parts.join(' und ')}.`;
  if (platform === 'darwin') {
    const pkgs = [missing.whisper ? 'whisper-cpp' : '', missing.recorder ? 'sox' : ''].filter(Boolean).join(' ');
    return { text: `${what} Installieren mit: brew install ${pkgs}`, command: `brew install ${pkgs}` };
  }
  if (platform === 'win32') {
    const steps: string[] = [];
    if (missing.recorder) steps.push('ffmpeg: winget install Gyan.FFmpeg');
    if (missing.whisper) steps.push('whisper.cpp: whisper-bin-x64.zip aus github.com/ggml-org/whisper.cpp/releases entpacken und mdReview.dictation.whisperPath auf whisper-cli.exe setzen');
    return {
      text: `${what} ${steps.join('; ')}.`,
      command: missing.recorder && !missing.whisper ? 'winget install Gyan.FFmpeg' : undefined,
    };
  }
  const steps: string[] = [];
  if (missing.recorder) steps.push('sudo apt install sox');
  if (missing.whisper) steps.push('whisper.cpp bauen (github.com/ggml-org/whisper.cpp) und mdReview.dictation.whisperPath setzen');
  return { text: `${what} ${steps.join('; ')}.`, command: missing.recorder && !missing.whisper ? 'sudo apt install sox' : undefined };
}

// ------------------------------------------------------------ Prozesse

/** Ein laufender Aufnahmeprozess. Sammelt das PCM von stdout. */
export class Recorder {
  private readonly proc: ChildProcess;
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private stderr = '';
  private stopping = false;
  readonly exited: Promise<number | null>;

  /** `onFail`: Prozess endet von selbst (Gerät fehlt, keine Berechtigung …) oder startet gar nicht. */
  constructor(cmd: string, args: string[], onFail?: (message: string) => void) {
    log.info('Aufnahme:', cmd, args.join(' '));
    this.proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stdout!.on('data', (b: Buffer) => {
      this.chunks.push(b);
      this.bytes += b.length;
    });
    this.proc.stderr!.on('data', (b: Buffer) => (this.stderr = (this.stderr + b.toString()).slice(-4000)));
    this.exited = new Promise((resolve) => {
      this.proc.on('error', (e) => {
        if (!this.stopping) onFail?.(`Aufnahme konnte nicht starten: ${e.message}`);
        resolve(null);
      });
      this.proc.on('close', (code) => {
        if (!this.stopping) onFail?.(`Aufnahme beendet (Code ${code}): ${this.stderr.trim().split('\n').pop() || 'ohne Meldung'}`);
        resolve(code);
      });
    });
  }

  get seconds(): number {
    return this.bytes / BYTES_PER_SECOND;
  }

  get errorOutput(): string {
    return this.stderr;
  }

  /** Beendet die Aufnahme und liefert das bisher aufgenommene PCM. */
  async stop(): Promise<Buffer> {
    this.stopping = true;
    this.proc.kill('SIGTERM');
    const timeout = new Promise<void>((r) => setTimeout(r, 2000));
    await Promise.race([this.exited, timeout]);
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGKILL');
    return Buffer.concat(this.chunks);
  }

  cancel(): void {
    this.stopping = true;
    this.proc.kill('SIGKILL');
  }
}

function run(cmd: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal }, (err, stdout, stderr) => {
      if (err && typeof (err as any).code !== 'number') return reject(err);
      resolve({ code: child.exitCode, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Erstes DirectShow-Audiogerät (Windows, ffmpeg braucht einen Namen). */
export async function defaultDshowDevice(ffmpeg: string): Promise<string | undefined> {
  const r = await run(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], 10000).catch(() => undefined);
  return r ? parseDshowAudioDevices(r.stderr)[0] : undefined;
}

/** Transkribiert eine WAV-Datei lokal mit whisper.cpp. */
export async function transcribeLocal(whisper: string, model: string, wavFile: string, language: string, signal?: AbortSignal): Promise<string> {
  const base = wavFile.replace(/\.wav$/i, '');
  const args = ['-m', model, '-l', language || 'auto', '-f', wavFile, '-nt', '-np', '-otxt', '-of', base];
  log.info('Transkription:', whisper, args.join(' '));
  const t0 = Date.now();
  const r = await run(whisper, args, 5 * 60 * 1000, signal);
  const txt = base + '.txt';
  try {
    if (r.code !== 0) throw new Error(`whisper-cli meldet Fehler (Code ${r.code}): ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
    const out = await fs.promises.readFile(txt, 'utf8');
    log.info(`Transkription fertig in ${Date.now() - t0} ms`);
    return out;
  } finally {
    fs.promises.rm(txt, { force: true }).catch(() => undefined);
  }
}

/** Transkribiert über eine OpenAI-kompatible API (/v1/audio/transcriptions). */
export async function transcribeApi(url: string, key: string, model: string, language: string, wav: Buffer, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'diktat.wav');
  form.append('model', model);
  if (language && language !== 'auto') form.append('language', language);
  form.append('response_format', 'json');
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal });
  const body = await res.text();
  if (!res.ok) throw new Error(`Transkriptions-API: ${res.status} ${body.slice(0, 200)}`);
  return String(JSON.parse(body).text ?? '');
}

// ------------------------------------------------------------ VS Code

export function readSettings(): DictationSettings {
  const c = vscode.workspace.getConfiguration('mdReview.dictation');
  return {
    engine: c.get<Engine>('engine') ?? 'local',
    language: c.get<string>('language') || 'de',
    recorder: c.get<'auto' | RecorderTool>('recorder') ?? 'auto',
    inputDevice: c.get<string>('inputDevice') ?? '',
    model: c.get<string>('model') || 'large-v3-turbo-q5_0',
    modelPath: c.get<string>('modelPath') ?? '',
    whisperPath: c.get<string>('whisperPath') ?? '',
    soxPath: c.get<string>('soxPath') ?? '',
    ffmpegPath: c.get<string>('ffmpegPath') ?? '',
    apiUrl: c.get<string>('apiUrl') || 'https://api.openai.com/v1/audio/transcriptions',
    apiModel: c.get<string>('apiModel') || 'gpt-4o-transcribe',
    maxSeconds: c.get<number>('maxSeconds') ?? 300,
  };
}

export interface DictationOwner {
  post(msg: DictationMsg): void;
}

interface Ready {
  recorder: { cmd: string; args: string[] };
  transcribe: (wav: Buffer, file: string, signal: AbortSignal) => Promise<string>;
}

/** Eine Aufnahme zur Zeit (es gibt nur ein Mikrofon), egal wie viele Review-Editoren offen sind. */
export class Dictation implements vscode.Disposable {
  private owner: DictationOwner | undefined;
  private rec: Recorder | undefined;
  private ready: Ready | undefined;
  private abort: AbortController | undefined;
  private timer: NodeJS.Timeout | undefined;
  private gen = 0;
  private downloading: Promise<string | undefined> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose() {
    this.cancel();
  }

  private modelDir() {
    return path.join(this.context.globalStorageUri.fsPath, 'models');
  }

  private modelFile(s: DictationSettings) {
    return s.modelPath || path.join(this.modelDir(), `ggml-${s.model}.bin`);
  }

  private findRecorder(s: DictationSettings): { tool: RecorderTool; bin: string } | undefined {
    const order: RecorderTool[] = s.recorder === 'auto' ? ['sox', 'ffmpeg'] : [s.recorder];
    for (const tool of order) {
      const bin = tool === 'sox' ? findTool(['sox'], s.soxPath) : findTool(['ffmpeg'], s.ffmpegPath);
      if (bin) return { tool, bin };
    }
    return undefined;
  }

  /** Prüft Programme, Modell bzw. API-Key. Zeigt bei Problemen einen Hinweis und liefert die Meldung für die Webview. */
  private async prepare(s: DictationSettings, interactive: boolean): Promise<Ready | string> {
    const recorder = this.findRecorder(s);
    const whisper = s.engine === 'local' ? findTool(['whisper-cli', 'whisper-cpp'], s.whisperPath) : 'api';
    if (!recorder || !whisper) {
      const hint = installHint(process.platform, { recorder: !recorder, whisper: !whisper });
      void this.showInstallHint(hint);
      return hint.text;
    }
    let device = s.inputDevice;
    if (!device && recorder.tool === 'ffmpeg' && process.platform === 'win32') {
      device = (await defaultDshowDevice(recorder.bin)) ?? '';
      if (!device) return 'ffmpeg findet kein Mikrofon. Gerätename in mdReview.dictation.inputDevice eintragen.';
    }
    const rec = { cmd: recorder.bin, args: recorderArgs(recorder.tool, process.platform, device) };

    if (s.engine === 'openai') {
      const key = await this.context.secrets.get(API_KEY_SECRET);
      if (!key) {
        if (interactive) void this.offerApiKey();
        return 'Kein API-Key für die Transkription hinterlegt („Markdown Review: Diktieren – API-Key festlegen“).';
      }
      return { recorder: rec, transcribe: (wav, _file, signal) => transcribeApi(s.apiUrl, key, s.apiModel, s.language, wav, signal) };
    }

    const model = this.modelFile(s);
    if (!isFile(model)) {
      if (s.modelPath) return `Sprachmodell nicht gefunden: ${s.modelPath}`;
      void this.offerDownload(s.model);
      return `Das Sprachmodell „${s.model}“ fehlt noch – Download über den Hinweis unten rechts.`;
    }
    return { recorder: rec, transcribe: (_wav, file, signal) => transcribeLocal(whisper, model, file, s.language, signal) };
  }

  async start(owner: DictationOwner) {
    this.cancel();
    const gen = ++this.gen;
    this.owner = owner;
    const s = readSettings();
    const ready = await this.prepare(s, true);
    if (gen !== this.gen) return;
    if (typeof ready === 'string') return this.finish({ type: 'dictation', state: 'error', message: ready });
    const rec = new Recorder(ready.recorder.cmd, ready.recorder.args, (message) => {
      if (gen !== this.gen) return;
      log.error(message);
      this.rec = undefined;
      this.finish({ type: 'dictation', state: 'error', message });
    });
    this.rec = rec;
    this.ready = ready;
    owner.post({ type: 'dictation', state: 'recording' });
    this.timer = setTimeout(() => void this.stop(owner), Math.max(5, s.maxSeconds) * 1000);
  }

  async stop(owner: DictationOwner) {
    if (owner !== this.owner || !this.rec || !this.ready) return;
    const gen = this.gen;
    const rec = this.rec;
    const ready = this.ready;
    this.rec = undefined;
    clearTimeout(this.timer);
    owner.post({ type: 'dictation', state: 'transcribing' });
    const pcm = await rec.stop();
    const level = peakLevel(pcm);
    log.info(`Aufnahme: ${(pcm.length / BYTES_PER_SECOND).toFixed(1)} s, Pegel ${level.toFixed(4)}`);
    if (gen !== this.gen) return;
    if (pcm.length < BYTES_PER_SECOND / 2) return this.finish({ type: 'dictation', state: 'error', message: 'Aufnahme zu kurz.' });
    if (level < SILENCE_LEVEL) {
      const hint =
        process.platform === 'darwin'
          ? ' Ist das Mikrofon für Visual Studio Code erlaubt (Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon)?'
          : '';
      return this.finish({ type: 'dictation', state: 'error', message: 'Nichts gehört – die Aufnahme ist stumm.' + hint });
    }
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'md-review-diktat-'));
    const file = path.join(dir, 'diktat.wav');
    const wav = toWav(pcm);
    this.abort = new AbortController();
    try {
      await fs.promises.writeFile(file, wav);
      const text = cleanTranscript(await ready.transcribe(wav, file, this.abort.signal));
      if (gen !== this.gen) return;
      if (!text) return this.finish({ type: 'dictation', state: 'error', message: 'Nichts verstanden.' });
      this.finish({ type: 'dictation', state: 'done', text });
    } catch (e: any) {
      if (gen !== this.gen) return;
      log.error('Transkription fehlgeschlagen:', e);
      this.finish({ type: 'dictation', state: 'error', message: String(e?.message ?? e) });
    } finally {
      this.abort = undefined;
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Bricht Aufnahme oder Transkription ab. Mit `owner` nur, wenn sie diesem gehört. */
  cancel(owner?: DictationOwner) {
    if (owner && owner !== this.owner) return;
    const prev = this.owner;
    this.gen++;
    clearTimeout(this.timer);
    this.rec?.cancel();
    this.rec = undefined;
    this.abort?.abort();
    this.abort = undefined;
    this.owner = undefined;
    if (prev && prev !== owner) prev.post({ type: 'dictation', state: 'idle' });
  }

  private finish(msg: DictationMsg) {
    clearTimeout(this.timer);
    const o = this.owner;
    this.owner = undefined;
    o?.post(msg);
  }

  // ------------------------------------------------------------ Einrichtung

  private async showInstallHint(hint: { text: string; command?: string }) {
    const actions = [hint.command ? 'Im Terminal installieren' : '', hint.command ? 'Befehl kopieren' : '', 'Einstellungen'].filter(Boolean);
    const a = await vscode.window.showWarningMessage(hint.text, ...actions);
    if (a === 'Im Terminal installieren' && hint.command) {
      const t = vscode.window.createTerminal('Markdown Review: Diktieren');
      t.show();
      t.sendText(hint.command);
    } else if (a === 'Befehl kopieren' && hint.command) await vscode.env.clipboard.writeText(hint.command);
    else if (a === 'Einstellungen') await vscode.commands.executeCommand('workbench.action.openSettings', 'mdReview.dictation');
  }

  private async offerApiKey() {
    const a = await vscode.window.showWarningMessage('Für die Transkription per API fehlt der API-Key.', 'API-Key festlegen', 'Lokal (whisper.cpp) verwenden');
    if (a === 'API-Key festlegen') await this.setApiKey();
    else if (a) await vscode.workspace.getConfiguration('mdReview.dictation').update('engine', 'local', vscode.ConfigurationTarget.Global);
  }

  async setApiKey() {
    const key = await vscode.window.showInputBox({
      title: 'API-Key für die Transkription',
      prompt: 'Wird im Schlüsselbund von VS Code gespeichert (SecretStorage), nicht in den Einstellungen. Leer lassen = löschen.',
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    if (key.trim()) await this.context.secrets.store(API_KEY_SECRET, key.trim());
    else await this.context.secrets.delete(API_KEY_SECRET);
    vscode.window.showInformationMessage(key.trim() ? 'API-Key gespeichert.' : 'API-Key gelöscht.');
  }

  private async offerDownload(name: string) {
    if (this.downloading) return;
    const a = await vscode.window.showInformationMessage(
      `Zum Diktieren wird das Whisper-Sprachmodell „${name}“ gebraucht (einmalig ca. ${modelSize(name)}, danach offline).`,
      'Herunterladen',
      'Anderes Modell wählen',
    );
    if (a === 'Anderes Modell wählen') await vscode.commands.executeCommand('workbench.action.openSettings', 'mdReview.dictation.model');
    if (a !== 'Herunterladen') return;
    this.downloading = this.download(name).finally(() => (this.downloading = undefined));
    const file = await this.downloading;
    if (file) vscode.window.showInformationMessage('Sprachmodell geladen – im Kommentarfeld mit 🎙 oder ⌥M diktieren.');
  }

  /** Lädt ein Modell nach globalStorage/models (erst .part, dann umbenennen). */
  private download(name: string): Promise<string | undefined> {
    const file = path.join(this.modelDir(), `ggml-${name}.bin`);
    return Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Sprachmodell „${name}“ wird geladen`, cancellable: true },
        async (progress, token) => {
          const ctrl = new AbortController();
          token.onCancellationRequested(() => ctrl.abort());
          const part = file + '.part';
          try {
            await fs.promises.mkdir(this.modelDir(), { recursive: true });
            const res = await fetch(modelUrl(name), { signal: ctrl.signal });
            if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
            const total = Number(res.headers.get('content-length')) || 0;
            let done = 0;
            let shown = 0;
            const out = fs.createWriteStream(part);
            for await (const chunk of Readable.fromWeb(res.body as any)) {
              done += chunk.length;
              if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
              const pct = total ? Math.floor((done / total) * 100) : 0;
              if (pct > shown) {
                progress.report({ increment: pct - shown, message: `${Math.round(done / 1e6)} von ${Math.round(total / 1e6)} MB` });
                shown = pct;
              }
            }
            await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
            await fs.promises.rename(part, file);
            log.info('Modell geladen:', file);
            return file;
          } catch (e: any) {
            await fs.promises.rm(part, { force: true }).catch(() => undefined);
            if (!ctrl.signal.aborted) vscode.window.showErrorMessage(`Sprachmodell konnte nicht geladen werden: ${e?.message ?? e}`);
            return undefined;
          }
        },
      ),
    );
  }

  /** Befehl „Diktieren einrichten“: prüft alles und bietet Installation/Download an. */
  async setup() {
    const s = readSettings();
    const r = await this.prepare(s, true);
    if (typeof r === 'string') return;
    const rec = r.recorder.cmd;
    const detail = s.engine === 'local' ? `whisper.cpp mit Modell „${s.modelPath || s.model}“` : `API ${s.apiUrl} (${s.apiModel})`;
    vscode.window.showInformationMessage(`Diktieren ist bereit: Aufnahme mit ${path.basename(rec)}, Transkription über ${detail}, Sprache „${s.language}“.`);
  }
}
