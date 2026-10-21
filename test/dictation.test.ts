import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
vi.mock('../src/provider', () => ({ log: { info() {}, error() {} } }));
const {
  cleanTranscript, findTool, installHint, parseDshowAudioDevices, peakLevel, Recorder, recorderArgs,
  SILENCE_LEVEL, toWav, transcribeLocal, wavHeader,
} = await import('../src/dictation');

/** Sinuston als PCM s16le, 16 kHz. */
function tone(seconds: number, amplitude: number): Buffer {
  const n = Math.round(seconds * 16000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * amplitude * 32767), i * 2);
  return b;
}

describe('WAV', () => {
  it('schreibt einen gültigen 16-kHz-Mono-Kopf', () => {
    const h = wavHeader(32000);
    expect(h.length).toBe(44);
    expect(h.toString('ascii', 0, 4)).toBe('RIFF');
    expect(h.readUInt32LE(4)).toBe(36 + 32000);
    expect(h.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(h.readUInt16LE(22)).toBe(1);
    expect(h.readUInt32LE(24)).toBe(16000);
    expect(h.readUInt32LE(28)).toBe(32000);
    expect(h.readUInt16LE(34)).toBe(16);
    expect(h.readUInt32LE(40)).toBe(32000);
  });

  it('schneidet ein halbes Sample am Ende ab', () => {
    const w = toWav(Buffer.alloc(5));
    expect(w.length).toBe(44 + 4);
    expect(w.readUInt32LE(40)).toBe(4);
  });
});

describe('Pegel', () => {
  it('erkennt Stille und Sprache', () => {
    expect(peakLevel(Buffer.alloc(32000))).toBe(0);
    expect(peakLevel(tone(1, 0.001))).toBeLessThan(SILENCE_LEVEL);
    expect(peakLevel(tone(1, 0.2))).toBeGreaterThan(SILENCE_LEVEL);
  });

  it('reicht ein kurzer lauter Abschnitt in langer Stille', () => {
    const pcm = Buffer.concat([Buffer.alloc(64000), tone(0.2, 0.1), Buffer.alloc(64000)]);
    expect(peakLevel(pcm)).toBeGreaterThan(SILENCE_LEVEL);
  });
});

describe('Transkript bereinigen', () => {
  it('fügt Zeilen zusammen und entfernt Geräusch-Tags', () => {
    expect(cleanTranscript(' Hier fehlt ein Beleg.\n Bitte prüfen. [BLANK_AUDIO]\n')).toBe('Hier fehlt ein Beleg. Bitte prüfen.');
    expect(cleanTranscript('(Musik)\nText')).toBe('Text');
  });

  it('verwirft typische Halluzinationen bei Stille', () => {
    expect(cleanTranscript('Untertitelung des ZDF, 2020\n')).toBe('');
    expect(cleanTranscript('Untertitel im Auftrag des ZDF für funk, 2017')).toBe('');
    expect(cleanTranscript('Vielen Dank fürs Zuschauen!')).toBe('');
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
  });

  it('lässt normale Sätze mit denselben Wörtern stehen', () => {
    expect(cleanTranscript('Das ZDF hat dazu Untertitel.')).toBe('Das ZDF hat dazu Untertitel.');
  });
});

describe('Aufnahmebefehl', () => {
  it('sox nutzt das Standardgerät und schreibt rohes PCM nach stdout', () => {
    expect(recorderArgs('sox', 'darwin', '')).toEqual(['-q', '-d', '-t', 'raw', '-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer', '-']);
    expect(recorderArgs('sox', 'win32', 'Mikrofon').slice(0, 4)).toEqual(['-q', '-t', 'waveaudio', 'Mikrofon']);
  });

  it('ffmpeg je nach System', () => {
    expect(recorderArgs('ffmpeg', 'darwin', '')).toContain(':default');
    expect(recorderArgs('ffmpeg', 'win32', 'Mikrofon (Realtek)')).toContain('audio=Mikrofon (Realtek)');
    const a = recorderArgs('ffmpeg', 'linux', '');
    expect(a.slice(a.indexOf('-f'), a.indexOf('-f') + 4)).toEqual(['-f', 'pulse', '-i', 'default']);
    expect(a.slice(-7)).toEqual(['-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
  });

  it('liest DirectShow-Geräte (alt und neu)', () => {
    const neu = `[dshow @ 0] "Integrated Camera" (video)
[dshow @ 0]   Alternative name "@device_pnp_\\\\?\\usb"
[dshow @ 0] "Mikrofonarray (Realtek(R) Audio)" (audio)
[dshow @ 0]   Alternative name "@device_cm_{33D9A762}"`;
    expect(parseDshowAudioDevices(neu)).toEqual(['Mikrofonarray (Realtek(R) Audio)']);
    const alt = `[dshow @ 0] DirectShow video devices
[dshow @ 0]  "Integrated Camera"
[dshow @ 0] DirectShow audio devices
[dshow @ 0]  "Mikrofon (USB)"`;
    expect(parseDshowAudioDevices(alt)).toEqual(['Mikrofon (USB)']);
  });
});

describe('Programme finden', () => {
  it('nimmt die Einstellung, sonst PATH, sonst Homebrew', () => {
    const files = new Set(['/opt/homebrew/bin/sox', '/a/whisper-cli', '/x/sox']);
    const ex = (p: string) => files.has(p);
    expect(findTool(['sox'], '', 'darwin', '/usr/bin:/bin', ex)).toBe('/opt/homebrew/bin/sox');
    expect(findTool(['sox'], '', 'darwin', '/x:/usr/bin', ex)).toBe('/x/sox');
    expect(findTool(['whisper-cli', 'whisper-cpp'], '', 'darwin', '/a', ex)).toBe('/a/whisper-cli');
    expect(findTool(['sox'], '/fehlt/sox', 'darwin', '/x', ex)).toBeUndefined();
    expect(findTool(['ffmpeg'], '', 'darwin', '/x', ex)).toBeUndefined();
  });

  it('hängt unter Windows .exe an', () => {
    const ex = (p: string) => p === path.join('C:\\tools', 'ffmpeg.exe');
    expect(findTool(['ffmpeg'], '', 'win32', 'C:\\tools;C:\\other', ex)).toBe(path.join('C:\\tools', 'ffmpeg.exe'));
  });
});

describe('Installationshinweis', () => {
  it('nennt auf macOS den Homebrew-Befehl', () => {
    expect(installHint('darwin', { recorder: true, whisper: true }).command).toBe('brew install whisper-cpp sox');
    expect(installHint('darwin', { recorder: false, whisper: true }).command).toBe('brew install whisper-cpp');
    expect(installHint('darwin', { recorder: true, whisper: false }).text).toContain('sox oder ffmpeg');
  });

  it('verweist unter Windows auf winget und die whisper.cpp-Releases', () => {
    const h = installHint('win32', { recorder: true, whisper: true });
    expect(h.text).toContain('winget install Gyan.FFmpeg');
    expect(h.text).toContain('whisper.cpp/releases');
  });
});

describe('Recorder', () => {
  // Ein Node-Prozess spielt das Mikrofon: schreibt PCM nach stdout und läuft weiter, bis er beendet wird.
  const fakeMic = (bytes: number) => [
    '-e',
    `process.stdout.write(Buffer.alloc(${bytes}, 1)); setInterval(() => {}, 1000);`,
  ];

  it('sammelt stdout und liefert es beim Stoppen', async () => {
    const fail = vi.fn();
    const rec = new Recorder(process.execPath, fakeMic(32000), fail);
    await vi.waitFor(() => expect(rec.seconds).toBe(1), { timeout: 5000 });
    const pcm = await rec.stop();
    expect(pcm.length).toBe(32000);
    expect(fail).not.toHaveBeenCalled();
  });

  it('meldet, wenn die Aufnahme von selbst endet', async () => {
    const fail = vi.fn();
    new Recorder(process.execPath, ['-e', 'console.error("kein Gerät"); process.exit(3)'], fail);
    await vi.waitFor(() => expect(fail).toHaveBeenCalled(), { timeout: 5000 });
    expect(fail.mock.calls[0][0]).toContain('Code 3');
    expect(fail.mock.calls[0][0]).toContain('kein Gerät');
  });

  it('meldet, wenn das Programm fehlt', async () => {
    const fail = vi.fn();
    new Recorder('/gibt/es/nicht/sox', [], fail);
    await vi.waitFor(() => expect(fail).toHaveBeenCalled(), { timeout: 5000 });
    expect(fail.mock.calls[0][0]).toContain('konnte nicht starten');
  });
});

// Ganze Kette mit echten Programmen: `say` erzeugt deutsche Sprache, sox liest sie wie ein Mikrofon als rohes PCM,
// daraus wird WAV, whisper-cli transkribiert. Läuft nur, wenn alles da ist (macOS mit `brew install sox whisper-cpp`)
// und WHISPER_MODEL auf eine ggml-*.bin zeigt.
const sox = findTool(['sox'], '');
const whisper = findTool(['whisper-cli', 'whisper-cpp'], '');
const say = findTool(['say'], '');
const model = process.env.WHISPER_MODEL;
describe.skipIf(!sox || !whisper || !say || !model)('Kette sox → WAV → whisper-cli', () => {
  it('transkribiert gesprochenes Deutsch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-review-test-'));
    const speech = path.join(dir, 'sprache.wav');
    execFileSync(say!, ['-v', 'Anna', '--data-format=LEI16@16000', '-o', speech, 'Hier fehlt noch ein Beleg. Bitte die Quelle prüfen.']);
    const rec = new Recorder(sox!, ['-q', speech, ...recorderArgs('sox', 'darwin', '').slice(2)]);
    await rec.exited;
    const pcm = await rec.stop();
    expect(pcm.length).toBeGreaterThan(32000);
    expect(peakLevel(pcm)).toBeGreaterThan(SILENCE_LEVEL);
    const file = path.join(dir, 'diktat.wav');
    fs.writeFileSync(file, toWav(pcm));
    const text = cleanTranscript(await transcribeLocal(whisper!, model!, file, 'de'));
    expect(text).toMatch(/fehlt noch ein Beleg/i);
    expect(text).toMatch(/Quelle/);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
