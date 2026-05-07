/**
 * Encode an AudioBuffer to a WAV Blob.
 *
 * Resamples to 16 kHz mono 16-bit PCM — the format whisper.cpp expects
 * for best quality speech recognition without a large file size overhead
 * (~1 MB per minute of audio).
 */

export async function encodeWav(
  audioBuffer: AudioBuffer,
  targetSampleRate = 16_000,
): Promise<Blob> {
  const numChannels = 1; // mono
  const sampleRate = targetSampleRate;

  // Resample to target rate via OfflineAudioContext
  const offlineCtx = new OfflineAudioContext(
    numChannels,
    Math.ceil((audioBuffer.duration * sampleRate)),
    sampleRate,
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;

  // Mix down to mono by connecting all channels to a ChannelMerger
  const merger = offlineCtx.createChannelMerger(1);
  // Connect first channel of source to merger input (browser will mix down)
  source.connect(merger);
  merger.connect(offlineCtx.destination);
  source.start(0);

  const resampled = await offlineCtx.startRendering();
  const pcmData = resampled.getChannelData(0);

  // Convert Float32 PCM → Int16 PCM
  const int16 = new Int16Array(pcmData.length);
  for (let i = 0; i < pcmData.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcmData[i]!));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  // Write WAV container
  const dataBytes = int16.byteLength;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const setStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF chunk
  setStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  setStr(8, "WAVE");
  // fmt sub-chunk
  setStr(12, "fmt ");
  view.setUint32(16, 16, true); // sub-chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true); // byte rate
  view.setUint16(32, numChannels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  // data sub-chunk
  setStr(36, "data");
  view.setUint32(40, dataBytes, true);
  new Int16Array(buffer, 44).set(int16);

  return new Blob([buffer], { type: "audio/wav" });
}
