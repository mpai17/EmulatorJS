/**
 * ShowdownBridge — JS bridge between EmulatorJS (gambatte core) and Pokemon Showdown.
 *
 * Phase 1: ROMInterface + mock event replay for offline testing.
 * The bridge polls WRAM for the ROM's phase signal, writes predetermined
 * battle override data, and lets the ROM execute turns with Showdown-determined outcomes.
 *
 * Extended with input automation and a comprehensive 22-turn test sequence.
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

  // Additional addresses for test automation
  PlayerConfusedCounter: 0xD06A,
  EnemyConfusedCounter:  0xD06F,
  LinkState:             0xD12A,
  BattleMonPP:           0xD02C,  // 4 bytes (PP for moves 0-3)
  PartyMon1HP:           0xD16B,  // 2 bytes each, stride = PARTYMON_STRUCT_LENGTH (0x2C)
  EnemyMon1HP:           0xD8A4,
});

// WRAM starts at 0xC000 on the Game Boy
const WRAM_BASE = 0xC000;

// =============================================================================
// Button constants for input simulation
// =============================================================================

const BTN = { A: 8, B: 0, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, START: 3, SELECT: 2 };

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

      // Verify: check a second known value — wPartyCount should be 6 (at 0xD162)
      const partyCount = heap[wramBase + (0xD162 - WRAM_BASE)];
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

// =============================================================================
// Comprehensive 22-turn test sequence
// =============================================================================
// Starting state: Player Alakazam (HP=250) vs Enemy Alakazam (HP=250)
// Default effectiveness for Psychic vs Psychic = 0x0A (not very effective)

const TEST_TURNS = [
  // Turn 1: Basic move, player first
  {
    desc: 'Basic move, player first',
    m1: { damage: 30, effectiveness: 0x0A },
    m2: { damage: 25, effectiveness: 0x0A },
    expectedPlayerHP: 225,
    expectedEnemyHP: 220,
  },
  // Turn 2: Basic move, enemy first
  {
    desc: 'Basic move, enemy first',
    whoFirst: 1,
    m1: { damage: 28, effectiveness: 0x0A },
    m2: { damage: 32, effectiveness: 0x0A },
    expectedPlayerHP: 197,
    expectedEnemyHP: 188,
  },
  // Turn 3: Player crit
  {
    desc: 'Player crit',
    m1: { damage: 55, crit: 1, effectiveness: 0x0A },
    m2: { damage: 20, effectiveness: 0x0A },
    expectedPlayerHP: 177,
    expectedEnemyHP: 133,
  },
  // Turn 4: Player miss
  {
    desc: 'Player miss',
    m1: { damage: 0, miss: 1 },
    m2: { damage: 22, effectiveness: 0x0A },
    expectedPlayerHP: 155,
    expectedEnemyHP: 133,
  },
  // Turn 5: Thunder Wave -> enemy paralyzed (ROM applies PAR)
  {
    desc: 'Thunder Wave paralyzes enemy',
    playerInput: { type: 'move', slot: 1 },
    enemyMove: 0x5E,
    m1: { damage: 0, miss: 0, effectiveness: 0x10 }, // TW: normal effectiveness
    m2: { damage: 20, effectiveness: 0x0A },
    expectedPlayerHP: 135,
    expectedEnemyHP: 133, // TW does 0 damage
  },
  // Turn 6: Enemy full paralysis (flags override)
  {
    desc: 'Enemy fully paralyzed (flag override)',
    flags: 0x02,
    m1: { damage: 30, effectiveness: 0x0A },
    m2: { damage: 0, effectiveness: 0x0A },
    expectedPlayerHP: 135,
    expectedEnemyHP: 103,
  },
  // Turn 7: Enemy attacks through paralysis
  {
    desc: 'Enemy attacks through paralysis',
    m1: { damage: 25, effectiveness: 0x0A },
    m2: { damage: 20, effectiveness: 0x0A },
    expectedPlayerHP: 115,
    expectedEnemyHP: 78,
    postWrite: [{ addr: 'EnemyMonStatus', value: 0x00 }], // clear PAR
  },
  // Turn 8: Player full paralysis
  {
    desc: 'Player fully paralyzed (flag override)',
    preWrite: [{ addr: 'BattleMonStatus', value: 0x40 }], // set PAR
    flags: 0x01,
    m1: { damage: 0, effectiveness: 0x0A },
    m2: { damage: 18, effectiveness: 0x0A },
    expectedPlayerHP: 97,
    expectedEnemyHP: 78,
    postWrite: [{ addr: 'BattleMonStatus', value: 0x00 }], // clear PAR
  },
  // Turn 9: Player confusion self-hit
  {
    desc: 'Player confusion self-hit',
    preWrite: [
      { addr: 'PlayerBattleStatus1', value: 0x80 }, // CONFUSED bit
      { addr: 'PlayerConfusedCounter', value: 3 },
    ],
    flags: 0x04,
    m2: { damage: 0, effectiveness: 0x0A },
    // expectedPlayerHP: undefined (skip - self-damage is ROM-calculated)
    // expectedEnemyHP: undefined (skip)
    postWrite: [{ addr: 'PlayerBattleStatus1', value: 0x00 }],
  },
  // Turn 10: Enemy confusion self-hit
  {
    desc: 'Enemy confusion self-hit',
    preWrite: [
      { addr: 'EnemyBattleStatus1', value: 0x80 },
      { addr: 'EnemyConfusedCounter', value: 3 },
    ],
    flags: 0x08,
    m1: { damage: 0, effectiveness: 0x0A },
    // both HP skip
    postWrite: [{ addr: 'EnemyBattleStatus1', value: 0x00 }],
  },
  // Turn 11: Burn end-of-turn damage
  {
    desc: 'Burn end-of-turn damage',
    preWrite: [{ addr: 'EnemyMonStatus', value: 0x10 }], // BRN
    m1: { damage: 0, effectiveness: 0x0A },
    m2: { damage: 0, effectiveness: 0x0A },
    // Skip both - burn chip makes exact HP unpredictable
  },
  // Turn 12: Correct-on-entry after burn
  {
    desc: 'Correct-on-entry after burn',
    preWrite: [
      { addr: 'EnemyMonStatus', value: 0x00 }, // clear BRN
    ],
    correctEnemyHP: true, // special flag: read current HP and compute expected dynamically
    m1: { damage: 3, effectiveness: 0x0A },
    m2: { damage: 0, effectiveness: 0x0A },
    // expectedPlayerHP/expectedEnemyHP set dynamically
  },
  // Turn 13: Poison end-of-turn
  {
    desc: 'Poison end-of-turn damage',
    preWrite: [{ addr: 'EnemyMonStatus', value: 0x08 }], // PSN
    m1: { damage: 0, effectiveness: 0x0A },
    m2: { damage: 0, effectiveness: 0x0A },
    // Skip - poison chip unpredictable
  },
  // Turn 14: Correct-on-entry after poison
  {
    desc: 'Correct-on-entry after poison',
    preWrite: [{ addr: 'EnemyMonStatus', value: 0x00 }],
    correctEnemyHP: true,
    m1: { damage: 3, effectiveness: 0x0A },
    m2: { damage: 0, effectiveness: 0x0A },
  },
  // Turn 15: KO enemy → faint exchange sends in Starmie
  {
    desc: 'KO enemy Alakazam + faint exchange',
    m1: { damage: 999, effectiveness: 0x0A },
    m2: { damage: 0, effectiveness: 0x0A },
    // Faint exchange: after KO, ROM calls ShowdownExchangeData for replacement
    faintExchange: { enemyAction: 5 }, // slot 1 = Starmie (4 + slot index)
    expectedEnemyHP: 260, // Starmie's HP after exchange
  },
  // Turn 16: Voluntary enemy switch to Snorlax
  {
    desc: 'Voluntary enemy switch to Snorlax',
    enemyAction: 6, // switch action (4 + slot 2)
    m1: { damage: 25, effectiveness: 0x0A },
    expectedEnemyHP: 435, // Snorlax 460-25
  },
  // Turn 17: Player switches to Starmie
  {
    desc: 'Player switches to Starmie',
    playerInput: { type: 'switch', partySlot: 1 },
    whoFirst: 1,
    enemyMove: 0x5E,
    m1: { damage: 30, effectiveness: 0x0A },
    expectedPlayerHP: 230, // Starmie 260-30
  },
  // Turn 18: Normal turn after switches
  {
    desc: 'Normal turn after switches',
    playerInput: { type: 'move', slot: 0 }, // Starmie Surf
    enemyMove: 0x22, // Snorlax Body Slam
    enemyMoveSlot: 0,
    m1: { damage: 40, effectiveness: 0x10 }, // Surf vs Snorlax = neutral
    m2: { damage: 35, effectiveness: 0x10 }, // Body Slam vs Starmie = neutral
    expectedPlayerHP: 195, // 230-35
    expectedEnemyHP: 395, // 435-40
  },
  // Turn 19: Hyper Beam recharge
  {
    desc: 'Hyper Beam recharge (enemy stuck)',
    preWrite: [{ addr: 'EnemyBattleStatus2', value: 0x20 }], // NEEDS_TO_RECHARGE bit 5
    m1: { damage: 30, effectiveness: 0x10 },
    m2: { damage: 0, effectiveness: 0x10 },
    expectedPlayerHP: 195,
    expectedEnemyHP: 365, // 395-30
    postWrite: [{ addr: 'EnemyBattleStatus2', value: 0x00 }],
  },
  // Turn 20: Freeze
  {
    desc: 'Enemy frozen solid',
    preWrite: [{ addr: 'EnemyMonStatus', value: 0x20 }], // FRZ
    m1: { damage: 25, effectiveness: 0x10 },
    m2: { damage: 0, effectiveness: 0x10 },
    expectedPlayerHP: 195,
    expectedEnemyHP: 340, // 365-25
    postWrite: [{ addr: 'EnemyMonStatus', value: 0x00 }], // thaw
  },
  // Turn 21: Sleep (stays asleep)
  {
    desc: 'Enemy asleep (stays asleep)',
    preWrite: [{ addr: 'EnemyMonStatus', value: 0x03 }], // SLP counter=3
    m1: { damage: 20, effectiveness: 0x10 },
    m2: { damage: 0, effectiveness: 0x10 },
    expectedPlayerHP: 195,
    expectedEnemyHP: 320, // 340-20
  },
  // Turn 22: Sleep (wakes up)
  {
    desc: 'Enemy wakes up and attacks',
    preWrite: [{ addr: 'EnemyMonStatus', value: 0x01 }], // SLP counter=1, will wake
    m1: { damage: 15, effectiveness: 0x10 },
    m2: { damage: 20, effectiveness: 0x10 },
    expectedPlayerHP: 195, // Gen 1: waking from sleep consumes the turn, enemy can't attack
    expectedEnemyHP: 305, // 320-15
  },
];

// =============================================================================
// ShowdownBridge — state machine + polling loop + test automation
// =============================================================================

class ShowdownBridge {
  constructor() {
    this.rom = new ROMInterface();
    this.pollInterval = null;
    this.state = 'IDLE';
    this.turnQueue = [];      // queue of mock turn data for manual testing
    this.turnIndex = 0;
    this.connected = false;
    this.testTurns = [];      // turns for automated test
    this.testResults = [];    // results from automated test
    this.lastMoveSlot = 0;   // track FIGHT menu cursor position (persists between turns)
  }

  // ===========================================================================
  // Input simulation
  // ===========================================================================

  async pressButton(buttonId, holdFrames = 2) {
    const gm = window.EJS_emulator?.gameManager;
    if (!gm) return;
    gm.simulateInput(0, buttonId, 1);
    await this._delay(holdFrames * 17);
    gm.simulateInput(0, buttonId, 0);
    await this._delay(17);
  }

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ===========================================================================
  // Player input execution
  // ===========================================================================

  async _executePlayerInput(input) {
    if (!input || input.type === 'move') {
      const slot = input?.slot ?? 0;
      // Enter FIGHT menu
      await this.pressButton(BTN.A);
      await this._delay(100);
      // Navigate from last cursor position to target slot (cursor persists, wraps)
      const diff = slot - this.lastMoveSlot;
      if (diff > 0) {
        for (let i = 0; i < diff; i++) {
          await this.pressButton(BTN.DOWN);
          await this._delay(50);
        }
      } else if (diff < 0) {
        for (let i = 0; i < -diff; i++) {
          await this.pressButton(BTN.UP);
          await this._delay(50);
        }
      }
      this._pendingMoveSlot = slot;
      // Select move
      await this.pressButton(BTN.A);
    } else if (input.type === 'switch') {
      const partySlot = input.partySlot ?? 1;
      // Navigate to POKEMON menu (RIGHT from FIGHT)
      await this.pressButton(BTN.RIGHT);
      await this._delay(50);
      await this.pressButton(BTN.A);
      await this._delay(150);
      // Navigate down to the target slot
      for (let i = 0; i < partySlot; i++) {
        await this.pressButton(BTN.DOWN);
        await this._delay(50);
      }
      // Select pokemon
      await this.pressButton(BTN.A);
      await this._delay(100);
      // Confirm switch
      await this.pressButton(BTN.A);
      await this._delay(100);
    }
  }

  // ===========================================================================
  // Phase waiting helpers
  // ===========================================================================

  async _waitForPhase(phase, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.rom.read8(ADDR.SD_Phase) === phase) return true;
      await this._delay(16);
    }
    console.error(`[Test] Timeout waiting for phase ${phase}`);
    return false;
  }

  async _waitForPhaseNot(phase, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.rom.read8(ADDR.SD_Phase) !== phase) return true;
      await this._delay(16);
    }
    console.error(`[Test] Timeout waiting for phase != ${phase}`);
    return false;
  }

  // ===========================================================================
  // WRAM write helpers
  // ===========================================================================

  _applyWrites(writes) {
    if (!writes) return;
    for (const w of writes) {
      const addr = typeof w.addr === 'string' ? ADDR[w.addr] : w.addr;
      if (w.value16 !== undefined) {
        this.rom.write16be(addr, w.value16);
      } else {
        this.rom.write8(addr, w.value);
      }
    }
  }

  _writeTurnOverrides(turn) {
    // Enemy action
    this.rom.write8(ADDR.SerialReceiveData, turn.enemyAction ?? 0);
    if (turn.enemyMove !== undefined) this.rom.write8(ADDR.EnemySelectedMove, turn.enemyMove);
    else this.rom.write8(ADDR.EnemySelectedMove, 0x5E); // default Psychic
    if (turn.enemyMoveSlot !== undefined) this.rom.write8(ADDR.EnemyMoveListIndex, turn.enemyMoveSlot);
    else this.rom.write8(ADDR.EnemyMoveListIndex, 0);

    // Turn order and flags
    this.rom.write8(ADDR.SD_WhoFirst, turn.whoFirst ?? 0);
    this.rom.write8(ADDR.SD_Flags, turn.flags ?? 0);

    // M1 override data (first mover)
    const m1 = turn.m1 || {};
    this.rom.write8(ADDR.SD_M1_DamageHi, ((m1.damage ?? 0) >> 8) & 0xFF);
    this.rom.write8(ADDR.SD_M1_DamageLo, (m1.damage ?? 0) & 0xFF);
    this.rom.write8(ADDR.SD_M1_Crit, m1.crit ?? 0);
    this.rom.write8(ADDR.SD_M1_Miss, m1.miss ?? 0);
    this.rom.write8(ADDR.SD_M1_Effectiveness, m1.effectiveness ?? 0x10);

    // M2 override data (second mover)
    const m2 = turn.m2 || {};
    this.rom.write8(ADDR.SD_M2_DamageHi, ((m2.damage ?? 0) >> 8) & 0xFF);
    this.rom.write8(ADDR.SD_M2_DamageLo, (m2.damage ?? 0) & 0xFF);
    this.rom.write8(ADDR.SD_M2_Crit, m2.crit ?? 0);
    this.rom.write8(ADDR.SD_M2_Miss, m2.miss ?? 0);
    this.rom.write8(ADDR.SD_M2_Effectiveness, m2.effectiveness ?? 0x10);
  }

  // ===========================================================================
  // Validation
  // ===========================================================================

  _validateTurn(turnDef, turnNum) {
    const pHP = this.rom.read16be(ADDR.BattleMonHP);
    const eHP = this.rom.read16be(ADDR.EnemyMonHP);

    let pResult = 'SKIP', eResult = 'SKIP';
    let pass = true;

    if (turnDef.expectedPlayerHP !== undefined) {
      pResult = pHP === turnDef.expectedPlayerHP ? 'PASS' : 'FAIL';
      if (pResult === 'FAIL') pass = false;
    }
    if (turnDef.expectedEnemyHP !== undefined) {
      eResult = eHP === turnDef.expectedEnemyHP ? 'PASS' : 'FAIL';
      if (eResult === 'FAIL') pass = false;
    }

    return {
      turnNum,
      pass,
      pHP,
      eHP,
      pResult,
      eResult,
      desc: turnDef.desc,
      expectedPlayerHP: turnDef.expectedPlayerHP,
      expectedEnemyHP: turnDef.expectedEnemyHP,
    };
  }

  // ===========================================================================
  // Test results printing
  // ===========================================================================

  _printTestResults() {
    console.log('\n========================================');
    console.log('  SHOWDOWN BRIDGE TEST RESULTS');
    console.log('========================================');

    let pass = 0, fail = 0, skip = 0;
    for (const r of this.testResults) {
      const pStr = r.pResult === 'SKIP' ? '??' : r.pHP;
      const eStr = r.eResult === 'SKIP' ? '??' : r.eHP;
      const expP = r.pResult === 'SKIP' ? 'skip' : (r.expectedPlayerHP ?? '??');
      const expE = r.eResult === 'SKIP' ? 'skip' : (r.expectedEnemyHP ?? '??');

      let status;
      if (r.pResult === 'SKIP' && r.eResult === 'SKIP') { status = 'SKIP'; skip++; }
      else if (r.pass) { status = 'PASS'; pass++; }
      else { status = 'FAIL'; fail++; }

      const turnStr = String(r.turnNum).padStart(2);
      const desc = r.desc.padEnd(38);
      console.log(`Turn ${turnStr}: ${status.padEnd(4)} | ${desc} | P:${pStr}(exp:${expP}) E:${eStr}(exp:${expE})`);
    }

    console.log('========================================');
    console.log(`TOTAL: ${pass}/${this.testResults.length} PASS, ${fail} FAIL, ${skip} SKIP`);
    console.log('========================================\n');
  }

  // ===========================================================================
  // Automated test runner
  // ===========================================================================

  async runTest() {
    this.testResults = [];
    this.lastMoveSlot = 0;

    // Retry WRAM scan — in a real browser the ROM may not have loaded yet
    let wramOk = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      this.rom._wramPtr = null; // force re-scan
      this.rom._module = null;  // force re-fetch module
      const mod = this.rom._getModule();
      if (attempt % 10 === 0) {
        console.log(`[Test] WRAM scan attempt ${attempt + 1}... (Module=${!!mod}, HEAPU8=${!!mod?.HEAPU8}, heapLen=${mod?.HEAPU8?.length ?? 0})`);
      }
      wramOk = this.rom._getWramPtr() !== null;
      if (wramOk) break;
      await this._delay(1000);
    }
    console.log(`[Test] WRAM scan: ${wramOk ? 'OK' : 'FAILED — signature not found in HEAPU8'}`);
    if (!wramOk) { console.log('__TEST_DONE__'); return; }

    this.rom.write8(ADDR.ShowdownConnected, 1);
    this.rom.write8(ADDR.LinkState, 0x04);
    console.log(`[Test] wShowdownConnected=${this.rom.read8(ADDR.ShowdownConnected)} wLinkState=${this.rom.read8(ADDR.LinkState)}`);

    // Enable 3x fast-forward for the duration of the test
    const gm = window.EJS_emulator?.gameManager;
    if (gm) {
      gm.setFastForwardRatio(3.0);
      gm.toggleFastForward(1);
      console.log('[Test] Fast-forward 3x enabled');
    }

    // Wait for the battle intro to finish.
    // At 3x speed, the intro (send-out animations, text) takes ~4-5s real time.
    console.log('[Test] Waiting for battle intro to finish...');
    await this._delay(6000);

    for (let i = 0; i < this.testTurns.length; i++) {
      const turn = this.testTurns[i];
      console.log(`[Test] === Turn ${i + 1}: ${turn.desc} ===`);

      // Restore PP for all 4 moves before each turn (Psychic only has 10 PP)
      this.rom.write8(ADDR.BattleMonPP, 10);
      this.rom.write8(ADDR.BattleMonPP + 1, 20);
      this.rom.write8(ADDR.BattleMonPP + 2, 20);
      this.rom.write8(ADDR.BattleMonPP + 3, 20);

      // Apply preWrites (status conditions, HP corrections, etc.)
      this._applyWrites(turn.preWrite);

      // Handle correct-on-entry patterns
      if (turn.correctEnemyHP) {
        const currentEHP = this.rom.read16be(ADDR.EnemyMonHP);
        turn._correctedEHP = currentEHP;
        turn.expectedEnemyHP = currentEHP - (turn.m1?.damage ?? 0);
        console.log(`[Test] Correct-on-entry: enemy HP ${currentEHP}, expect ${turn.expectedEnemyHP} after turn`);
      }
      if (turn.correctPlayerHP) {
        const currentPHP = this.rom.read16be(ADDR.BattleMonHP);
        turn._correctedPHP = currentPHP;
        turn.expectedPlayerHP = currentPHP - (turn.m2?.damage ?? 0);
      }

      // Retry-based input: press buttons, check for phase 1, retry if needed.
      // Text boxes from previous turns may eat early button presses.
      let gotPhase1 = false;
      if (turn.skipInput) {
        // Mash A to advance faint text / other text until exchange is triggered
        for (let tick = 0; tick < 20 && !gotPhase1; tick++) {
          await this.pressButton(BTN.A);
          await this._delay(300);
          gotPhase1 = this.rom.read8(ADDR.SD_Phase) === 1;
        }
      } else {
        for (let attempt = 0; attempt < 8 && !gotPhase1; attempt++) {
          if (attempt > 0) {
            console.log(`[Test] Turn ${i + 1}: retry input (attempt ${attempt + 1})`);
            await this._delay(500);
          }
          await this._executePlayerInput(turn.playerInput);
          gotPhase1 = await this._waitForPhase(1, 2000);
        }
      }

      if (!gotPhase1) {
        console.error(`[Test] Turn ${i + 1}: phase 1 never reached (phase=${this.rom.read8(ADDR.SD_Phase)}). Stopping.`);
        this.testResults.push({ turnNum: i + 1, pass: false, pHP: '??', eHP: '??', pResult: 'FAIL', eResult: 'FAIL', desc: turn.desc, expectedPlayerHP: turn.expectedPlayerHP, expectedEnemyHP: turn.expectedEnemyHP });
        break;
      }

      // Commit cursor position now that we know the input was accepted
      if (this._pendingMoveSlot !== undefined) {
        this.lastMoveSlot = this._pendingMoveSlot;
        this._pendingMoveSlot = undefined;
      }

      // Log what the player selected
      const playerAction = this.rom.read8(ADDR.SerialSendData);
      const playerMove = this.rom.read8(0xCCDC); // wPlayerSelectedMove
      const playerSlot = this.rom.read8(0xCC2E); // wPlayerMoveListIndex
      console.log(`[Test] Turn ${i + 1}: player action=${playerAction} move=0x${playerMove.toString(16)} slot=${playerSlot}`);

      // Write turn overrides
      this._writeTurnOverrides(turn);

      // Set phase 2 (tell ROM turn data is ready)
      this.rom.write8(ADDR.SD_Phase, 2);

      // Wait for ROM to pick up phase 2 and set phase 3 (executing)
      const gotPhase3 = await this._waitForPhase(3, 5000);
      if (!gotPhase3) {
        console.error(`[Test] Turn ${i + 1}: phase 3 never reached`);
      }

      // Wait for BOTH attacks and all text to finish before reading HP.
      // Mash B to advance any text boxes that need button input to dismiss
      // (e.g. "is paralyzed!", "woke up!"). B advances text without selecting menus.
      // Also watch for phase=1 which means a faint exchange was triggered.
      let faintPhase1 = false;
      for (let tick = 0; tick < 10; tick++) {
        await this.pressButton(BTN.B);
        await this._delay(450);
        if (this.rom.read8(ADDR.SD_Phase) === 1) {
          faintPhase1 = true;
          break;
        }
      }

      // Handle faint exchange if triggered
      if (turn.faintExchange && faintPhase1) {
        console.log(`[Test] Turn ${i + 1}: handling faint exchange`);
        this.rom.write8(ADDR.SerialReceiveData, turn.faintExchange.enemyAction ?? 0);
        this.rom.write8(ADDR.SD_Phase, 2);
        await this._waitForPhase(3, 5000);
        // B-mash through "sent out X!" text
        for (let tick = 0; tick < 10; tick++) {
          await this.pressButton(BTN.B);
          await this._delay(450);
        }
      } else if (turn.faintExchange && !faintPhase1) {
        console.error(`[Test] Turn ${i + 1}: faint exchange expected but phase 1 not reached`);
      }

      // Apply postWrites (clear status conditions, etc.)
      this._applyWrites(turn.postWrite);
      await this._delay(100);

      // Validate HP
      const result = this._validateTurn(turn, i + 1);
      this.testResults.push(result);
      const status = (result.pResult === 'SKIP' && result.eResult === 'SKIP') ? 'SKIP' : (result.pass ? 'PASS' : 'FAIL');
      console.log(`[Test] Turn ${i + 1}: ${status} | P:${result.pHP} E:${result.eHP}`);
      if (status === 'FAIL') {
        console.error(`[Test] Turn ${i + 1} FAILED — stopping test.`);
        break;
      }
    }

    // Disable fast-forward after test completes
    if (gm) {
      gm.toggleFastForward(0);
      console.log('[Test] Fast-forward disabled');
    }

    this._printTestResults();
    console.log('__TEST_DONE__');
  }

  // ===========================================================================
  // Original manual polling mode (start/stop/loadMockTurns)
  // ===========================================================================

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

// Automated 22-turn test (also callable manually)
window.startShowdownTest = async function() {
  const bridge = window.showdownBridge;
  bridge.testTurns = TEST_TURNS;
  await bridge.runTest();
};

// Auto-start: poll until EJS_emulator is ready, then launch the test
// Global timeout (120s) ensures clean exit if anything hangs
(async function autoStart() {
  const TIMEOUT_MS = 300000; // 5 minutes
  const timer = setTimeout(() => {
    console.error('[Test] GLOBAL TIMEOUT — test did not finish within 120s');
    console.log('__TEST_DONE__');
  }, TIMEOUT_MS);

  console.log('[ShowdownBridge] Loaded. Waiting for emulator to be ready...');
  // Wait for EJS_emulator and its gameManager to exist
  while (!window.EJS_emulator?.gameManager) {
    await new Promise(r => setTimeout(r, 200));
  }
  // Give the emulator a moment to fully initialize and start the ROM
  await new Promise(r => setTimeout(r, 2000));
  console.log('[ShowdownBridge] Emulator ready — auto-starting test.');
  try {
    await window.startShowdownTest();
  } catch (e) {
    console.error('[Test] Error:', e.message);
    console.log('__TEST_DONE__');
  }
  clearTimeout(timer);
})();
