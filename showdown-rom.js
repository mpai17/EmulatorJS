/**
 * ROMInterface — reads/writes GB WRAM via the WASM heap.
 *
 * Depends on: WRAM_BASE from showdown-config.js
 */

class ROMInterface {
  constructor() {
    this._wramPtr = null;
    this._module = null;
  }

  /**
   * Get the WASM Module from EmulatorJS.
   * EmulatorJS stores it at window.EJS_emulator.Module.
   */
  _getModule() {
    return window.EJS_emulator?.Module ?? window.EJS_emulator?.gameManager?.Module ?? null;
  }

  /**
   * Lazily resolve the WRAM base offset within HEAPU8.
   * Since retro_get_memory_data is not exported by EmulatorJS, we scan
   * HEAPU8 for a known byte pattern: the player name "PLAYER@" at wPlayerName (0xD15B).
   * In the ROM's charmap: P=$8F L=$8B A=$80 Y=$98 E=$84 R=$91 @=$50
   */
  _getWramPtr() {
    if (this._wramPtr !== null) return this._wramPtr;

    const mod = this._getModule();
    if (!mod || !mod.HEAPU8) {
      console.warn('[ShowdownBridge] EJS_emulator.Module or HEAPU8 not available yet');
      return null;
    }

    this._module = mod;

    // Known signature: "PLAYER@" in GB charmap encoding at wPlayerName = 0xD15B
    const signature = [0x8F, 0x8B, 0x80, 0x98, 0x84, 0x91, 0x50]; // P L A Y E R @
    const sigAddr = 0xD15B; // GB address of wPlayerName
    const heap = mod.HEAPU8;

    // Scan HEAPU8 for the signature
    // WRAM is 8KB (0xC000-0xDFFF) — scan the entire heap
    const scanLimit = heap.length;
    for (let i = 0; i < scanLimit; i++) {
      if (heap[i] !== signature[0]) continue;

      // Check full signature
      let match = true;
      for (let j = 1; j < signature.length; j++) {
        if (heap[i + j] !== signature[j]) { match = false; break; }
      }
      if (!match) continue;

      // Found signature at heap offset i — this corresponds to GB address sigAddr
      // So WRAM base (0xC000) is at heap offset: i - (sigAddr - 0xC000)
      const wramBase = i - (sigAddr - WRAM_BASE);
      if (wramBase < 0) continue;

      // Verify: check a second known value — wPartyCount should be 6 (at 0xD166)
      const partyCount = heap[wramBase + (0xD166 - WRAM_BASE)];
      if (partyCount !== 6) continue;

      this._wramPtr = wramBase;
      console.log(`[ShowdownBridge] WRAM found via signature scan at heap offset ${wramBase} (0x${wramBase.toString(16)})`);
      return this._wramPtr;
    }

    // Don't log error here — caller may retry
    return null;
  }

  /** Convert a GB address (0xC000+) to an index into the WASM heap. */
  _heapIndex(gbAddr) {
    const ptr = this._getWramPtr();
    if (ptr === null) return null;
    return ptr + (gbAddr - WRAM_BASE);
  }

  /** Read a single byte from WRAM. */
  read8(gbAddr) {
    const idx = this._heapIndex(gbAddr);
    if (idx === null) return 0;
    return this._module.HEAPU8[idx];
  }

  /** Write a single byte to WRAM. */
  write8(gbAddr, value) {
    const idx = this._heapIndex(gbAddr);
    if (idx === null) return;
    this._module.HEAPU8[idx] = value & 0xFF;
  }

  /** Read a 16-bit big-endian value (GB native byte order). */
  read16be(gbAddr) {
    return (this.read8(gbAddr) << 8) | this.read8(gbAddr + 1);
  }

  /** Write a 16-bit big-endian value. */
  write16be(gbAddr, value) {
    this.write8(gbAddr, (value >> 8) & 0xFF);
    this.write8(gbAddr + 1, value & 0xFF);
  }
}
