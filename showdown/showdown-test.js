/**
 * Showdown EmuLink — Test automation.
 *
 * Contains TEST_TURNS, runTest, _validateTurn, _printTestResults,
 * window.startShowdownTest, and the auto-start IIFE.
 *
 * Depends on: ShowdownBridge (showdown-bridge.js), ADDR/BTN (showdown-config.js)
 */

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
    m1: { damage: 0, miss: 0, effectiveness: 10 }, // TW: normal effectiveness
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
    m1: { damage: 40, effectiveness: 10 }, // Surf vs Snorlax = neutral
    m2: { damage: 35, effectiveness: 10 }, // Body Slam vs Starmie = neutral
    expectedPlayerHP: 195, // 230-35
    expectedEnemyHP: 395, // 435-40
  },
  // Turn 19: Hyper Beam recharge
  {
    desc: 'Hyper Beam recharge (enemy stuck)',
    preWrite: [{ addr: 'EnemyBattleStatus2', value: 0x20 }], // NEEDS_TO_RECHARGE bit 5
    m1: { damage: 30, effectiveness: 10 },
    m2: { damage: 0, effectiveness: 10 },
    expectedPlayerHP: 195,
    expectedEnemyHP: 365, // 395-30
    postWrite: [{ addr: 'EnemyBattleStatus2', value: 0x00 }],
  },
  // Turn 20: Freeze
  {
    desc: 'Enemy frozen solid',
    preWrite: [{ addr: 'EnemyMonStatus', value: 0x20 }], // FRZ
    m1: { damage: 25, effectiveness: 10 },
    m2: { damage: 0, effectiveness: 10 },
    expectedPlayerHP: 195,
    expectedEnemyHP: 340, // 365-25
    postWrite: [{ addr: 'EnemyMonStatus', value: 0x00 }], // thaw
  },
  // Turn 21: Sleep (stays asleep)
  {
    desc: 'Enemy asleep (stays asleep)',
    preWrite: [{ addr: 'EnemyMonStatus', value: 0x03 }], // SLP counter=3
    m1: { damage: 20, effectiveness: 10 },
    m2: { damage: 0, effectiveness: 10 },
    expectedPlayerHP: 195,
    expectedEnemyHP: 320, // 340-20
  },
  // Turn 22: Sleep (wakes up)
  {
    desc: 'Enemy wakes up and attacks',
    preWrite: [{ addr: 'EnemyMonStatus', value: 0x01 }], // SLP counter=1, will wake
    m1: { damage: 15, effectiveness: 10 },
    m2: { damage: 20, effectiveness: 10 },
    expectedPlayerHP: 195, // Gen 1: waking from sleep consumes the turn, enemy can't attack
    expectedEnemyHP: 305, // 320-15
  },
];

// =============================================================================
// Test methods — attached to ShowdownBridge.prototype
// =============================================================================

ShowdownBridge.prototype._validateTurn = function(turnDef, turnNum) {
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
};

ShowdownBridge.prototype._printTestResults = function() {
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
};

ShowdownBridge.prototype.runTest = async function() {
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
    const playerMove = this.rom.read8(ADDR.PlayerSelectedMove);
    const playerSlot = this.rom.read8(ADDR.PlayerMoveListIndex);
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
};

// =============================================================================
// Global test entry point
// =============================================================================

window.startShowdownTest = async function() {
  const bridge = window.showdownBridge;
  bridge.testTurns = TEST_TURNS;
  await bridge.runTest();
};

// Auto-start: poll until EJS_emulator is ready, then launch the test
// Skip auto-test in live mode (?live in URL) or when login-screen is present
(async function autoStart() {
  if (typeof window !== 'undefined' && !window.location?.search?.includes('test')) {
    console.log('[ShowdownBridge] Live mode — skipping auto-test.');
    return;
  }

  const TIMEOUT_MS = 300000; // 5 minutes
  const timer = setTimeout(() => {
    console.error('[Test] GLOBAL TIMEOUT — test did not finish within 300s');
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
