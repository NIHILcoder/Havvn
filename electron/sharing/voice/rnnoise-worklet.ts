// The RNNoise AudioWorkletProcessor source, kept as a STRING (not a module) because
// an AudioWorklet is loaded as a classic script — it can't `import`/`export`, and the
// engine has no bundler to emit a separate worklet file. At runtime the engine wraps
// this in a Blob URL and calls `audioWorklet.addModule(url)` (the engine page is a
// packaged file:// host explicitly permits blob: worklets + WebAssembly in its CSP).
//
// The processor instantiates the RNNoise WASM directly against its minimal Emscripten
// import surface (two functions), so we don't need the Emscripten JS glue (which is an
// ES module and won't run in a worklet). WASM export/import names below were confirmed
// against the module (imports a.a/a.b; exports c=memory d=ctors f=create g=malloc
// h=destroy i=free j=process_frame). RNNoise processes mono 480-sample frames at 48kHz,
// PCM scaled to the int16 range (±32768); we ring-buffer the 128-sample render quantum
// into 480-frames, so it adds ~one frame (~10ms) of latency.
export const RNNOISE_WORKLET_SOURCE = String.raw`
class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.FRAME = 480;
    this.ready = false;
    this.inFrame = new Float32Array(this.FRAME);
    this.inFill = 0;
    this.outFifo = new Float32Array(this.FRAME * 4);
    this.outRead = 0; this.outWrite = 0; this.outCount = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === 'wasm') { try { this._init(d.bytes); } catch (err) { this.port.postMessage({ type: 'error', message: String(err) }); } }
    };
  }

  _views() {
    const b = this.memory.buffer;
    this.HEAPU8 = new Uint8Array(b);
    this.HEAPF32 = new Float32Array(b);
  }

  _init(bytes) {
    const imports = { a: {
      // _emscripten_resize_heap — grow linear memory (unused in practice; our footprint
      // is a single 480-float buffer well within the 16MB initial memory).
      a: (requestedSize) => {
        try {
          const old = this.HEAPU8.length;
          const need = Math.ceil((requestedSize - old) / 65536);
          if (need > 0) this.memory.grow(need);
          this._views();
          return 1;
        } catch (_e) { return 0; }
      },
      // _emscripten_memcpy_big
      b: (dest, src, num) => { this.HEAPU8.copyWithin(dest, src, src + num); },
    } };
    const module = new WebAssembly.Module(bytes);          // sync compile is allowed off the main thread
    const instance = new WebAssembly.Instance(module, imports);
    const ex = instance.exports;
    this.memory = ex.c;
    this._views();
    if (typeof ex.d === 'function') ex.d();                // __wasm_call_ctors
    this.j = ex.j;                                          // rnnoise_process_frame(st, out, in)
    this.state = ex.f(0);                                  // rnnoise_create(NULL) — default model
    this.ptr = ex.g(this.FRAME * 4);                       // malloc one 480-float scratch buffer
    this.fptr = this.ptr >> 2;
    this.ready = true;
    this.port.postMessage({ type: 'ready' });
  }

  _pushOut(v) {
    this.outFifo[this.outWrite] = v;
    this.outWrite = (this.outWrite + 1) % this.outFifo.length;
    if (this.outCount < this.outFifo.length) this.outCount++;
    else this.outRead = (this.outRead + 1) % this.outFifo.length; // overflow: drop oldest
  }
  _pullOut() {
    if (this.outCount === 0) return 0;
    const v = this.outFifo[this.outRead];
    this.outRead = (this.outRead + 1) % this.outFifo.length;
    this.outCount--;
    return v;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outCh = output[0];
    const input = inputs[0];
    const inCh = input && input.length ? input[0] : null;
    const n = outCh.length;

    if (!this.ready || !inCh) {
      // Warm-up (WASM not ready) or no input: pass through untouched (or silence).
      if (inCh) outCh.set(inCh); else outCh.fill(0);
      for (let c = 1; c < output.length; c++) output[c].set(outCh);
      return true;
    }

    try {
      for (let i = 0; i < n; i++) {
        this.inFrame[this.inFill++] = inCh[i] * 32768;
        if (this.inFill === this.FRAME) {
          this.HEAPF32.set(this.inFrame, this.fptr);
          this.j(this.state, this.ptr, this.ptr);          // denoise in place
          for (let k = 0; k < this.FRAME; k++) this._pushOut(this.HEAPF32[this.fptr + k] / 32768);
          this.inFill = 0;
        }
        outCh[i] = this._pullOut();
      }
    } catch (_e) {
      // A WASM trap here would otherwise permanently disable the processor (Web Audio
      // silences a throwing processor for its lifetime) → dead mic. Degrade to
      // pass-through instead so voice keeps working.
      this.ready = false;
      if (inCh) outCh.set(inCh); else outCh.fill(0);
    }
    for (let c = 1; c < output.length; c++) output[c].set(outCh);
    return true;
  }
}
registerProcessor('rnnoise', RnnoiseProcessor);
`;
