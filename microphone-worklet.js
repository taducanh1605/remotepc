class MicrophonePCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(960);
    this.used = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.samples[this.used++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      if (this.used === 960) {
        // DataView makes the wire format little-endian on every architecture.
        const buffer = new ArrayBuffer(1920), view = new DataView(buffer);
        for (let j = 0; j < 960; j++) view.setInt16(j * 2, this.samples[j], true);
        this.port.postMessage(buffer, [buffer]);
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor("njk-microphone-pcm", MicrophonePCM);
