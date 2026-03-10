/**
 * ShowdownBridge — JS bridge between EmulatorJS (gambatte core) and Pokemon Showdown.
 *
 * Phase 1: ROMInterface + mock event replay for offline testing.
 * The bridge polls WRAM for the ROM's phase signal, writes predetermined
 * battle override data, and lets the ROM execute turns with Showdown-determined outcomes.
 */

// =============================================================================
// WRAM Address Map (from pokeyellow.sym)
// =============================================================================

const ADDR = Object.freeze({
  // Turn override data (wLinkBattleRandomNumberList, 10 bytes)
  SD_M1_DamageHi:      0xD147,
  SD_M1_DamageLo:      0xD148,
  SD_M1_Crit:          0xD149,
  SD_M1_Miss:          0xD14A,
  SD_M1_Effectiveness: 0xD14B,
  SD_M2_DamageHi:      0xD14C,
  SD_M2_DamageLo:      0xD14D,
  SD_M2_Crit:          0xD14E,
  SD_M2_Miss:          0xD14F,
  SD_M2_Effectiveness: 0xD150,

  // Handshake/control
  ShowdownConnected:    0xD152,
  SD_Flags:             0xD153,
  SD_Phase:             0xD154,
  SD_WhoFirst:          0xD155,
  SD_BattleEnd:         0xD156,

  // Native game variables
  SerialReceiveData:    0xCC3E,
  SerialSendData:       0xCC42,
  EnemySelectedMove:    0xCCDD,
  EnemyMoveListIndex:   0xCCE2,
  EnemyMonHP:           0xCFE5,
  EnemyMonStatus:       0xCFE8,
  BattleMonHP:          0xD014,
  BattleMonStatus:      0xD017,
  PlayerBattleStatus1:  0xD061,
  PlayerBattleStatus2:  0xD062,
  PlayerBattleStatus3:  0xD063,
  EnemyBattleStatus1:   0xD066,
  EnemyBattleStatus2:   0xD067,
  EnemyBattleStatus3:   0xD068,
  PlayerMonStatMods:    0xCD1A, // 6 bytes (atk, def, spd, spc, acc, eva) — but Gen 1 has 8
  EnemyMonStatMods:     0xCD2E, // 6 bytes
  PartyCount:           0xD162,
  PartyMons:            0xD16A,
  EnemyPartyCount:      0xD89B,
  EnemyMons:            0xD8A3,
});

// WRAM starts at 0xC000 on the Game Boy
const WRAM_BASE = 0xC000;

// =============================================================================
// ROMInterface — reads/writes GB WRAM via the WASM heap
// =============================================================================

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
   * HEAPU8 for a known byte pattern: the player name "PLAYER@" at wPlayerName (0xD157).
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

    // Known signature: "PLAYER@" in GB charmap encoding at wPlayerName = 0xD157
    const signature = [0x8F, 0x8B, 0x80, 0x98, 0x84, 0x91, 0x50]; // P L A Y E R @
    const sigAddr = 0xD157; // GB address of wPlayerName
    const heap = mod.HEAPU8;

    // Scan HEAPU8 for the signature
    // WRAM is 8KB (0xC000-0xDFFF), typically within the first few MB of heap
    const scanLimit = Math.min(heap.length, 64 * 1024 * 1024); // scan up to 64MB
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

      // Verify: check a second known value — wPartyCount should be 6 (at 0xD162)
      const partyCount = heap[wramBase + (0xD162 - WRAM_BASE)];
      if (partyCount !== 6) continue;

      this._wramPtr = wramBase;
      console.log(`[ShowdownBridge] WRAM found via signature scan at heap offset ${wramBase} (0x${wramBase.toString(16)})`);
      return this._wramPtr;
    }

    console.error('[ShowdownBridge] Could not find WRAM in HEAPU8 (signature not found). Is the game loaded?');
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

// =============================================================================
// ShowdownBridge — state machine + polling loop
// =============================================================================

class ShowdownBridge {
  constructor() {
    this.rom = new ROMInterface();
    this.pollInterval = null;
    this.state = 'IDLE';
    this.turnQueue = [];      // queue of mock turn data for testing
    this.turnIndex = 0;
    this.connected = false;
  }

  /**
   * Start the bridge. Sets wShowdownConnected = 1 and begins polling.
   */
  start() {
    if (this.pollInterval) return;

    this.rom.write8(ADDR.ShowdownConnected, 1);
    this.connected = true;
    this.state = 'IDLE';

    console.log('[ShowdownBridge] Started — polling WRAM');

    this.pollInterval = setInterval(() => this._poll(), 50);
  }

  /**
   * Stop the bridge and disconnect.
   */
  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.rom.write8(ADDR.ShowdownConnected, 0);
    this.connected = false;
    this.state = 'IDLE';
    console.log('[ShowdownBridge] Stopped');
  }

  /**
   * Load mock turn data for offline testing.
   * Each entry is a turn plan object with the structure:
   * {
   *   whoFirst: 0 | 1,          // 0=player first, 1=enemy first
   *   enemyAction: number,       // value for wSerialExchangeNybbleReceiveData
   *   enemyMove: number,         // ROM move ID for wEnemySelectedMove
   *   enemyMoveSlot: number,     // index for wEnemyMoveListIndex
   *   flags: number,             // wSD_Flags byte
   *   m1: { damage, crit, miss, effectiveness },
   *   m2: { damage, crit, miss, effectiveness },
   * }
   */
  loadMockTurns(turns) {
    this.turnQueue = turns;
    this.turnIndex = 0;
    console.log(`[ShowdownBridge] Loaded ${turns.length} mock turns`);
  }

  /** Internal poll loop — called every 50ms. */
  _poll() {
    if (!this.connected) return;

    const phase = this.rom.read8(ADDR.SD_Phase);

    if (phase === 1 && this.state === 'IDLE') {
      // Player has selected an action
      const playerAction = this.rom.read8(ADDR.SerialSendData);
      console.log(`[ShowdownBridge] Player selected action: ${playerAction}`);

      this.state = 'WAITING_FOR_SERVER';
      this._processTurn(playerAction);
    }
  }

  /** Process a turn — in Phase 1, use mock data. */
  _processTurn(playerAction) {
    if (this.turnIndex >= this.turnQueue.length) {
      console.warn('[ShowdownBridge] No more mock turns available');
      // Cycle back to start for repeated testing
      this.turnIndex = 0;
    }

    const turn = this.turnQueue[this.turnIndex];
    this.turnIndex++;

    if (!turn) {
      console.error('[ShowdownBridge] Turn data is null');
      return;
    }

    console.log(`[ShowdownBridge] Writing turn ${this.turnIndex} overrides:`, turn);

    // Write enemy action into receive data
    this.rom.write8(ADDR.SerialReceiveData, turn.enemyAction ?? 0);

    // Write enemy move info
    if (turn.enemyMove !== undefined) {
      this.rom.write8(ADDR.EnemySelectedMove, turn.enemyMove);
    }
    if (turn.enemyMoveSlot !== undefined) {
      this.rom.write8(ADDR.EnemyMoveListIndex, turn.enemyMoveSlot);
    }

    // Write turn order
    this.rom.write8(ADDR.SD_WhoFirst, turn.whoFirst ?? 0);

    // Write flags (paralysis/confusion overrides)
    this.rom.write8(ADDR.SD_Flags, turn.flags ?? 0);

    // Write M1 override data (first mover)
    const m1 = turn.m1 || {};
    this.rom.write8(ADDR.SD_M1_DamageHi, ((m1.damage ?? 0) >> 8) & 0xFF);
    this.rom.write8(ADDR.SD_M1_DamageLo, (m1.damage ?? 0) & 0xFF);
    this.rom.write8(ADDR.SD_M1_Crit, m1.crit ?? 0);
    this.rom.write8(ADDR.SD_M1_Miss, m1.miss ?? 0);
    this.rom.write8(ADDR.SD_M1_Effectiveness, m1.effectiveness ?? 0x10); // EFFECTIVE = $10

    // Write M2 override data (second mover)
    const m2 = turn.m2 || {};
    this.rom.write8(ADDR.SD_M2_DamageHi, ((m2.damage ?? 0) >> 8) & 0xFF);
    this.rom.write8(ADDR.SD_M2_DamageLo, (m2.damage ?? 0) & 0xFF);
    this.rom.write8(ADDR.SD_M2_Crit, m2.crit ?? 0);
    this.rom.write8(ADDR.SD_M2_Miss, m2.miss ?? 0);
    this.rom.write8(ADDR.SD_M2_Effectiveness, m2.effectiveness ?? 0x10);

    // Signal ROM that turn data is ready (set phase to 2 = turn_ready)
    this.rom.write8(ADDR.SD_Phase, 2);

    this.state = 'IDLE';
    console.log('[ShowdownBridge] Turn data written, phase set to turn_ready');
  }
}

// =============================================================================
// Global instance + console API
// =============================================================================

window.showdownBridge = new ShowdownBridge();

// Convenience: start bridge from console with mock data
window.startShowdownTest = function() {
  const bridge = window.showdownBridge;

  // Example mock turns: both sides use Thunderbolt, player faster
  bridge.loadMockTurns([
    {
      whoFirst: 0,        // player moves first
      enemyAction: 0,     // enemy used move slot 0
      enemyMove: 0x57,    // THUNDERBOLT (move ID 87 = 0x57)
      enemyMoveSlot: 0,
      flags: 0,
      m1: { damage: 50, crit: 0, miss: 0, effectiveness: 0x10 },
      m2: { damage: 50, crit: 0, miss: 0, effectiveness: 0x10 },
    },
    {
      whoFirst: 0,
      enemyAction: 0,
      enemyMove: 0x57,
      enemyMoveSlot: 0,
      flags: 0,
      m1: { damage: 50, crit: 0, miss: 0, effectiveness: 0x10 },
      m2: { damage: 50, crit: 0, miss: 0, effectiveness: 0x10 },
    },
    {
      whoFirst: 1,        // enemy moves first this time
      enemyAction: 0,
      enemyMove: 0x57,
      enemyMoveSlot: 0,
      flags: 0,
      m1: { damage: 60, crit: 1, miss: 0, effectiveness: 0x10 }, // enemy crits
      m2: { damage: 45, crit: 0, miss: 0, effectiveness: 0x10 },
    },
  ]);

  // Set wShowdownConnected and wLinkState so Showdown mode activates immediately
  bridge.start();
  bridge.rom.write8(0xD12A, 0x04); // wLinkState = LINK_STATE_BATTLING

  console.log('[ShowdownBridge] Test started. wLinkState forced to LINK_STATE_BATTLING.');
  console.log('[ShowdownBridge] Select FIGHT → Thunderbolt to begin the first turn.');
};

console.log('[ShowdownBridge] Loaded. Call startShowdownTest() to begin mock testing.');
