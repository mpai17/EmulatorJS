/**
 * ShowdownBridge — Faint exchange handlers and message waiting.
 *
 * Extends ShowdownBridge.prototype with methods for handling
 * single faint, player faint, and double faint exchanges,
 * plus turn/faint message waiting helpers.
 * Loaded after showdown-bridge.js defines the class.
 *
 * Depends on: ADDR (showdown-config.js),
 *             writeEnemyMonFromSpecies (showdown-party.js)
 */

// =============================================================================
// Faint exchange handlers
// =============================================================================

/**
 * Enemy-only faint: wait for opponent's switch-in, write action, advance Phase.
 */
ShowdownBridge.prototype._handleFaintExchange = async function() {
  console.log('[ShowdownBridge] Handling faint exchange (enemy only)');

  // Wait for switch-in messages from server (no timeout — opponent may be slow)
  const switchData = await this._waitForFaintSwitch();

  // Battle ended (forfeit) during faint exchange — skip processing
  if (this._battleResult) {
    console.log('[ShowdownBridge] Battle ended during faint exchange — skipping');
    this._pendingFaintReplace = false;
    this._faintSide = null;
    return;
  }

  const result = this.translator.processForceSwitch(switchData);
  console.log(`[ShowdownBridge] Faint exchange: enemy sends out party slot ${result.enemyAction - 4} (action byte ${result.enemyAction})`);
  this.rom.write8(ADDR.SerialReceiveData, result.enemyAction);

  // In play mode, write the new enemy mon to WRAM party slots.
  // writeActive=false: ROM's switch routine copies party → active after faint message.
  if (this.mode === 'play') {
    const switchIdx = this.translator.active.p2;
    const enemyMon = this.translator.enemyParty[switchIdx];
    if (enemyMon) {
      const hp = this.translator.hp.p2[switchIdx];
      const maxHp = this.translator.maxHp.p2[switchIdx];
      const hpPct = maxHp > 0 ? Math.round(hp * 100 / maxHp) : 100;
      const sts = this._sdStatusToByte(this.translator.status.p2[switchIdx] || '');
      writeEnemyMonFromSpecies(this.rom, enemyMon.name, switchIdx, hpPct,
        { writeActive: false, statusByte: sts, moves: enemyMon.moves });
    }
  }

  this.rom.write8(ADDR.SD_Phase, 2);
  this._pendingFaintReplace = false;
  this._faintSide = null;
  const faintPhaseOk = await this._waitForPhase(3, 5000);
  if (!faintPhaseOk) {
    this._triggerDesync('ROM failed to execute faint exchange (phase 3 timeout)');
  }
};

/**
 * Player-only faint: send switch choice to Showdown, acknowledge the ROM's
 * ChooseNextMon exchange, then let the main loop handle the next Phase 1
 * (from SelectEnemyMove) as a normal turn.
 *
 * ROM flow: ChooseNextMon calls LinkBattleExchangeData → Phase 1.
 * After we set Phase 2, the ROM continues: loads battle mon, SendOutMon,
 * returns to MainInBattleLoop. Then the next SelectEnemyMove → Phase 1
 * is a normal turn that the main loop picks up.
 */
ShowdownBridge.prototype._handlePlayerFaintExchange = async function() {
  console.log('[ShowdownBridge] Handling player faint exchange');

  // Capture forceSwitch rqid BEFORE it gets overwritten by later requests
  const forceRqid = this._playerRequest?.rqid || 0;

  // Read player's switch choice from WRAM (already selected via ROM party menu)
  const whichPokemon = this.rom.read8(ADDR.WhichPokemon);
  const targetSpecies = window.PARTY[whichPokemon]?.name;
  let sdIndex = whichPokemon;
  if (this._playerRequest?.side?.pokemon && targetSpecies) {
    const idx = this._playerRequest.side.pokemon.findIndex(
      p => p.ident.split(': ')[1] === targetSpecies && !p.condition.includes('fnt')
    );
    if (idx >= 0) sdIndex = idx;
  }
  const choice = `switch ${sdIndex + 1}`;
  console.log(`[ShowdownBridge] Player faint switch: ${targetSpecies} (ROM slot ${whichPokemon}, SD slot ${sdIndex}) → "${choice}"`);

  // Update translator's active tracking
  this.translator.active.p1 = whichPokemon;

  // Send forceSwitch response to Showdown
  const rqid = this._playerForceRqid || this.playerConn._rqid;
  this.playerConn.sendChoice(choice, rqid);

  // Acknowledge ChooseNextMon's exchange — ROM doesn't read SerialReceiveData here
  this.rom.write8(ADDR.SD_Phase, 2);
  const phaseOk = await this._waitForPhase(3, 5000);
  if (!phaseOk) {
    this._triggerDesync('ROM failed to execute player faint exchange (phase 3 timeout)');
  }

  // Clear faint state
  this._pendingFaintReplace = false;
  this._faintSide = null;
  this._playerForceRqid = null;

  // Wait for Showdown to process the switch and send a new |request|
  // with move options for the next turn. Pass forceRqid so we don't miss
  // a request that arrived while we were handling Phase cycles.
  await this._waitForNewRequest(forceRqid);

  // Drain leftover messages
  await this._delay(300);
  this._turnMessages = [];
  this._faintMessages = [];
  console.log('[ShowdownBridge] Player faint exchange complete');
};

/**
 * Double faint: both sides need replacements. The ROM calls ShowdownExchangeData
 * TWICE — once inside ChooseNextMon (player switch sync) and once inside
 * ReplaceFaintedEnemyMon (enemy switch). We handle both Phase 1 cycles here:
 *   Phase 1 #1: ChooseNextMon exchange — just acknowledge (ROM doesn't read data)
 *   Phase 1 #2: ReplaceFaintedEnemyMon — ROM reads SerialReceiveData for enemy switch
 */
ShowdownBridge.prototype._handleDoubleFaint = async function() {
  console.log('[ShowdownBridge] Handling double faint (two Phase 1 cycles)');

  // Capture forceSwitch rqid BEFORE it gets overwritten by later requests
  const forceRqid = this._playerRequest?.rqid || 0;

  // 1. Read player's switch choice from WRAM (already selected via ROM party menu)
  const whichPokemon = this.rom.read8(ADDR.WhichPokemon);
  const targetSpecies = window.PARTY[whichPokemon]?.name;
  let sdIndex = whichPokemon;
  if (this._playerRequest?.side?.pokemon && targetSpecies) {
    const idx = this._playerRequest.side.pokemon.findIndex(
      p => p.ident.split(': ')[1] === targetSpecies && !p.condition.includes('fnt')
    );
    if (idx >= 0) sdIndex = idx;
  }
  const choice = `switch ${sdIndex + 1}`;
  console.log(`[ShowdownBridge] Double faint player switch: ${targetSpecies} (ROM slot ${whichPokemon}, SD slot ${sdIndex}) → "${choice}"`);

  // Update translator's active tracking
  this.translator.active.p1 = whichPokemon;

  // 2. Send player's switch to Showdown
  const rqid = this._playerForceRqid || this.playerConn._rqid;
  this.playerConn.sendChoice(choice, rqid);

  // 3. Wait for enemy switch-in from Showdown (opponent may be slow)
  const switchData = await this._waitForFaintSwitch();

  // Battle ended (forfeit) during double faint exchange — skip processing
  if (this._battleResult) {
    console.log('[ShowdownBridge] Battle ended during double faint exchange — skipping');
    this._pendingFaintReplace = false;
    this._faintSide = null;
    return;
  }

  const result = this.translator.processForceSwitch(switchData);
  console.log(`[ShowdownBridge] Double faint enemy switch: party slot ${result.enemyAction - 4} (action byte ${result.enemyAction})`);

  // 4. Write enemy action to SerialReceiveData
  this.rom.write8(ADDR.SerialReceiveData, result.enemyAction);

  // 5. In play mode, write the new enemy mon to WRAM party slots
  if (this.mode === 'play') {
    const switchIdx = this.translator.active.p2;
    const enemyMon = this.translator.enemyParty[switchIdx];
    if (enemyMon) {
      const hp = this.translator.hp.p2[switchIdx];
      const maxHp = this.translator.maxHp.p2[switchIdx];
      const hpPct = maxHp > 0 ? Math.round(hp * 100 / maxHp) : 100;
      const sts = this._sdStatusToByte(this.translator.status.p2[switchIdx] || '');
      writeEnemyMonFromSpecies(this.rom, enemyMon.name, switchIdx, hpPct,
        { writeActive: false, statusByte: sts, moves: enemyMon.moves });
    }
  }

  // 6. Advance ROM past ChooseNextMon's exchange (first of two Phase 1 cycles).
  //    ROM doesn't read SerialReceiveData here — it just needs Phase 2 to continue.
  this.rom.write8(ADDR.SD_Phase, 2);
  this._pendingFaintReplace = false;
  this._faintSide = null;
  this._playerForceRqid = null;
  const firstPhaseOk = await this._waitForPhase(3, 5000);
  if (!firstPhaseOk) {
    this._triggerDesync('ROM failed to execute first double faint exchange (phase 3 timeout)');
  }

  // 7. Wait for second Phase 1 from ReplaceFaintedEnemyMon's ShowdownExchangeData.
  //    Between Phase 3 and this Phase 1, the ROM shows the player's send-out
  //    animation (ChooseNextMon → SendOutMon), which can take several seconds.
  console.log('[ShowdownBridge] Waiting for second Phase 1 (ReplaceFaintedEnemyMon)');
  const secondPhase1Ok = await this._waitForPhase(1, 20000);
  if (!secondPhase1Ok) {
    this._triggerDesync('ROM failed to reach second Phase 1 for double faint');
  }

  // 8. Acknowledge the second exchange — SerialReceiveData already has the
  //    enemy's switch action from step 4. ROM reads it in EnemySendOut.
  this.rom.write8(ADDR.SD_Phase, 2);
  const secondPhase3Ok = await this._waitForPhase(3, 5000);
  if (!secondPhase3Ok) {
    this._triggerDesync('ROM failed to execute second double faint exchange (phase 3 timeout)');
  }

  // 9. Wait for new |request| from Showdown (move options for next turn).
  //    Pass forceRqid so we don't miss a request that arrived during Phase cycles.
  await this._waitForNewRequest(forceRqid);

  // Drain leftover messages to prevent contamination of next turn
  await this._delay(300);
  this._turnMessages = [];
  this._faintMessages = [];
  console.log('[ShowdownBridge] Double faint complete');
};

// =============================================================================
// Message & request waiting
// =============================================================================

ShowdownBridge.prototype._waitForTurnResolution = function() {
  return new Promise((resolve) => {
    this._turnMessages = [];
    this._turnResolve = (msgs) => {
      this._turnResolve = null;
      resolve([...msgs]);
    };
  });
};

ShowdownBridge.prototype._waitForFaintSwitch = function() {
  const allMsgs = [...(this._faintMessages || []), ...(this._turnMessages || [])];
  const alreadyHasSwitch = allMsgs.some(m =>
    (m.cmd === 'switch' || m.cmd === 'drag') && this.translator._parseSide(m.parts[1]) === 'p2');
  if (alreadyHasSwitch) {
    console.log('[ShowdownBridge] Faint switch messages already received');
    return Promise.resolve(allMsgs);
  }

  return new Promise((resolve) => {
    this._faintResolve = (msgs) => {
      this._faintResolve = null;
      resolve(msgs);
    };
  });
};

/**
 * Wait for a new |request| from Showdown with move options.
 * @param {number} [baselineRqid] - rqid to compare against (e.g. the forceSwitch rqid).
 *   If omitted, uses the current _playerRequest.rqid. Pass the forceSwitch rqid
 *   when calling from faint handlers to avoid the race where the new request
 *   has already arrived before this function is called.
 */
ShowdownBridge.prototype._waitForNewRequest = function(baselineRqid) {
  return new Promise((resolve) => {
    const minRqid = baselineRqid ?? this._playerRequest?.rqid ?? 0;
    const check = () => {
      if (this._playerRequest &&
          this._playerRequest.rqid > minRqid &&
          !this._playerRequest.forceSwitch &&
          !this._playerRequest.wait) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
};
