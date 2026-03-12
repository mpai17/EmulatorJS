/**
 * ShowdownBridge — JS bridge between EmulatorJS (gambatte core) and Pokemon Showdown.
 *
 * Live mode: connects to Showdown server, translates protocol to WRAM overrides.
 *
 * Prototype extensions (loaded after this file):
 *   - showdown-bridge-input.js:  pressButton, _delay, _executePlayerInput
 *   - showdown-bridge-wram.js:   _applyWrites, _writeTurnOverrides, _waitForPhase/Not
 *   - showdown-bridge-sync.js:   _syncPreTurnStatus, _syncPostTurnStatus, _syncHP,
 *                                _triggerDesync, _verifyTeamSync, _checkDesync
 *   - showdown-bridge-format.js: _parseConditionHP, _sdStatusToByte, _logBattleState
 *
 * Depends on: ADDR, BTN, WRAM_BASE (showdown-config.js),
 *             ROMInterface (showdown-rom.js),
 *             TurnTranslator, PARTY (showdown-translator.js),
 *             ShowdownConnection (showdown-connection.js)
 */

// =============================================================================
// ShowdownBridge — state machine + polling loop
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

    // Callbacks
    this.onDesync = null;        // (message) => void — called when desync detected
    this.onBattleEnd = null;     // (result) => void — called when battle ends normally
    this._desyncTriggered = false;

    // Live mode state
    this.mode = null;          // 'play' or 'test'
    this.liveMode = false;
    this.playerConn = null;   // ShowdownConnection for player
    this.enemyConn = null;    // ShowdownConnection for enemy
    this.translator = null;   // TurnTranslator
    this._turnMessages = [];  // accumulated battle messages for current turn
    this._turnResolve = null; // promise resolve for waiting on turn data
    this._pendingFaintReplace = false;
    this._faintSide = null;           // 'p1' = player fainted, 'p2' = enemy fainted
    this._faintMessages = [];
    this._faintResolve = null;
    this._battleStarted = false;
    this._battleResult = null;  // set by _onBattleEnd: { type, winner }
    this._playerRequest = null;
    this._enemyRequest = null;
    this.enemyAutoRandom = true;
  }

  // ===========================================================================
  // Manual / test mode — offline polling
  // ===========================================================================

  /**
   * Initialize bridge in manual mode: enable ShowdownConnected flag, start 50ms polling.
   */
  start() {
    if (this.pollInterval) return;
    this.rom.write8(ADDR.ShowdownConnected, 1);
    this.rom.write8(ADDR.LinkState, 0x04); // LINK_STATE_BATTLING
    this.connected = true;
    this.state = 'IDLE';
    this.turnIndex = 0;
    this.pollInterval = setInterval(() => this._poll(), 50);
    console.log('[ShowdownBridge] Started (polling every 50ms)');
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.connected = false;
    this.rom.write8(ADDR.ShowdownConnected, 0);
    this.state = 'IDLE';
    console.log('[ShowdownBridge] Stopped');
  }

  loadMockTurns(turns) {
    this.turnQueue = turns;
    this.turnIndex = 0;
    console.log(`[ShowdownBridge] Loaded ${turns.length} mock turns`);
  }

  _poll() {
    if (!this.connected) return;
    const phase = this.rom.read8(ADDR.SD_Phase);

    if (phase === 1 && this.state === 'IDLE') {
      const playerAction = this.rom.read8(ADDR.PlayerSelectedMove);
      this.state = 'PROCESSING';
      console.log(`[ShowdownBridge] Phase 1 detected — player selected move 0x${playerAction.toString(16)}`);
      this._processTurn(playerAction);
    }
  }

  _processTurn(playerAction) {
    if (this.turnIndex >= this.turnQueue.length) {
      console.warn('[ShowdownBridge] No more mock turns available');
      this.state = 'IDLE';
      return;
    }

    const turn = this.turnQueue[this.turnIndex];
    this.turnIndex++;
    console.log(`[ShowdownBridge] Processing turn ${this.turnIndex}/${this.turnQueue.length}`);

    // Pre-turn status sync
    if (turn._overrides && this.translator) {
      this._syncPreTurnStatus(turn._overrides);
    }

    // Apply custom WRAM writes (e.g. status conditions, stat mods)
    this._applyWrites(turn.writes);

    // Write turn order
    this.rom.write8(ADDR.SD_WhoFirst, turn.whoFirst ?? 0);

    // Write turn override data
    this._writeTurnOverrides(turn);

    // Signal ROM that turn data is ready (set phase to 2 = turn_ready)
    this.rom.write8(ADDR.SD_Phase, 2);

    this.state = 'IDLE';
    console.log('[ShowdownBridge] Turn data written, phase set to turn_ready');
  }

  /** Process initial battle messages (switch events) to set up translator HP state. */
  _processInitialMessages() {
    if (this._turnMessages && this._turnMessages.length > 0) {
      for (const msg of this._turnMessages) {
        // Extract opponent name from |player|p2|username|...
        if (msg.cmd === 'player' && msg.parts[1] === 'p2' && msg.parts[2]) {
          const opponentName = msg.parts[2].trim();
          writeEnemyTrainerName(this.rom, opponentName);
        }

        if (msg.cmd === 'switch' || msg.cmd === 'drag') {
          const side = this.translator._parseSide(msg.parts[1]);
          this.translator._handleSwitch(side, msg.parts[1], msg.parts[3]);

          // In play mode, write enemy's initial Pokemon to WRAM
          if (side === 'p2' && this.mode === 'play') {
            const species = this.translator._parseSpecies(msg.parts[1]);
            const hpText = msg.parts[3] || '100/100';
            const [cur, max] = this.translator._parseHP(hpText);
            const hpPercent = max > 0 ? Math.round(cur * 100 / max) : 100;
            const partyIdx = this.translator.active.p2;
            writeEnemyMonFromSpecies(this.rom, species, partyIdx, hpPercent);
          }
        }
      }
      console.log('[ShowdownBridge] Processed initial battle messages for HP state');
      this._turnMessages = [];
    }
  }

  async _waitForBattleStart() {
    return new Promise((resolve, reject) => {
      if (this._battleStarted) { resolve(); return; }
      this._cancelSearch = () => {
        reject(new Error('Search cancelled'));
      };
      this.playerConn.onBattleStarted = () => {
        this._battleStarted = true;
        this._cancelSearch = null;
        resolve();
      };
    });
  }

  cancelSearch() {
    if (this.playerConn) {
      if (this._challengeTarget) {
        this.playerConn.send('|/cancelchallenge ' + this._challengeTarget);
      } else {
        this.playerConn.send('|/cancelsearch');
      }
      this.playerConn.disconnect();
    }
    if (this.enemyConn) {
      this.enemyConn.disconnect();
    }
    this.connected = false;
    this.liveMode = false;
    this._challengeTarget = null;
    if (this._cancelSearch) {
      this._cancelSearch();
      this._cancelSearch = null;
    }
  }

  // ===========================================================================
  // Live polling loop
  // ===========================================================================

  /**
   * Live polling loop: Phase 1 → read action → send to server → wait → write WRAM → Phase 2
   */
  async _pollLive() {
    console.log('[ShowdownBridge] Live poll loop started');

    // Wait for battle intro
    await this._delay(6000);

    while (this.connected && this.liveMode) {
      // Connection health check
      if (this.playerConn?.ws?.readyState !== WebSocket.OPEN) {
        this._triggerDesync('Lost connection to Showdown server');
        break;
      }

      const phase = this.rom.read8(ADDR.SD_Phase);

      if (phase === 1) {
        // Sync translator's active tracking with ROM BEFORE writing HP.
        const romPlayerActive = this.rom.read8(ADDR.PlayerMonNumber);
        const romEnemyActive = this.rom.read8(ADDR.EnemyMonPartyPos);
        if (this.translator.active.p1 !== romPlayerActive) {
          console.log(`[ShowdownBridge] Sync active.p1: translator=${this.translator.active.p1} → ROM=${romPlayerActive}`);
          this.translator.active.p1 = romPlayerActive;
        }
        if (this.translator.active.p2 !== romEnemyActive) {
          console.log(`[ShowdownBridge] Sync active.p2: translator=${this.translator.active.p2} → ROM=${romEnemyActive}`);
          this.translator.active.p2 = romEnemyActive;
        }

        this._syncHP();

        if (this._pendingFaintReplace) {
          // This is a faint exchange, not a new turn
          if (this._faintSide === 'both') {
            await this._handleDoubleFaint();
            continue;
          } else if (this._faintSide === 'p1') {
            await this._handlePlayerFaintExchange();
            continue;
          } else {
            await this._handleFaintExchange();
            continue;
          }
        }

        // Read player's chosen action from WRAM.
        // PlayerMoveListIndex encodes the action type:
        //   0x00-0x03 = FIGHT (move slot), 0x04-0x09 = SWITCH, 0x0F = RUN
        let choice;
        const playerMoveListIdx = this.rom.read8(ADDR.PlayerMoveListIndex);

        // RUN = forfeit (LINKBATTLE_RUN = 0x0F)
        if (playerMoveListIdx === 0x0F) {
          console.log('[ShowdownBridge] Live: player selected RUN — forfeiting');
          this.playerConn.sendToRoom(this.playerConn.battleRoomId, '/forfeit');
          // Write benign enemy action so ROM can process the player running
          this.rom.write8(ADDR.SerialReceiveData, 0x01);
          this.rom.write8(ADDR.SD_Phase, 2);
          break;
        }

        // If the player must recharge (Hyper Beam), override whatever they picked.
        if (this.translator?.recharging?.p1) {
          choice = 'move 1';
          console.log(`[ShowdownBridge] Live: player must recharge — forcing "move 1" (ignoring menu selection)`);
        } else {
          const isSwitch = this.rom.read8(ADDR.ActionResultOrTookBattleTurn);
          if (isSwitch) {
            const whichPokemon = this.rom.read8(ADDR.WhichPokemon);
            const targetSpecies = window.PARTY[whichPokemon]?.name;
            let sdIndex = whichPokemon; // fallback
            if (this._playerRequest?.side?.pokemon && targetSpecies) {
              const idx = this._playerRequest.side.pokemon.findIndex(
                p => p.ident.split(': ')[1] === targetSpecies && !p.active
              );
              if (idx >= 0) sdIndex = idx;
            }
            choice = `switch ${sdIndex + 1}`; // Showdown is 1-indexed
            console.log(`[ShowdownBridge] Live: player switches to ${targetSpecies} (ROM slot ${whichPokemon}, SD slot ${sdIndex}) → "${choice}"`);
          } else {
            choice = `move ${playerMoveListIdx + 1}`; // Showdown is 1-indexed
            console.log(`[ShowdownBridge] Live: player picks move slot ${playerMoveListIdx} → "${choice}"`);
          }
        }

        // Snapshot pre-turn HP from request data BEFORE sending choice
        const preTurnHP = {
          p1: this.translator.hp.p1[this.translator.active.p1],
          p2: this.translator.hp.p2[this.translator.active.p2],
        };

        // Save enemy rqid before turn — used to detect stale requests in HP correction
        const preTurnEnemyRqid = this._enemyRequest?.rqid;

        // Send to server
        this.playerConn.sendChoice(choice, this.playerConn._rqid);

        // Wait for turn resolution messages (no timeout — opponent may be slow)
        const turnData = await this._waitForTurnResolution();

        // Opponent forfeited mid-turn — _onBattleEnd resolved the waiter and
        // _handleForfeitTransition will write LINKBATTLE_RUN when it sees Phase 1.
        // Just exit the loop; _handleForfeitTransition handles the rest.
        if (this._battleResult && !turnData.some(m => m.cmd === 'faint')) {
          console.log('[ShowdownBridge] Opponent forfeited mid-turn — exiting poll loop');
          break;
        }

        // Set _pendingFaintReplace EARLY so incoming switch messages route to _faintMessages.
        const faintMsgs = turnData.filter(m => m.cmd === 'faint');
        if (faintMsgs.length > 0) {
          const faintSides = new Set(faintMsgs.map(m => this.translator._parseSide(m.parts[1])));
          if (faintSides.has('p1') && faintSides.has('p2')) {
            this._pendingFaintReplace = true;
            this._faintSide = 'both';
            this._faintMessages = [];
            console.log('[ShowdownBridge] Turn has double faint (p1 + p2)');
          } else if (faintSides.has('p2')) {
            if (this._pendingFaintReplace && this._faintSide === 'p1') {
              this._faintSide = 'both';
              this._faintMessages = [];
              console.log('[ShowdownBridge] Turn has double faint (p2 detected after p1 request)');
            } else {
              this._pendingFaintReplace = true;
              this._faintSide = 'p2';
              this._faintMessages = [];
            }
          }
        }

        // Small delay to let enemy's post-turn |request| and |win|/|tie| arrive
        await this._delay(200);

        // Battle-ending double faint (e.g. Explosion KOs both last Pokemon):
        // _onBattleEnd fires from |win|/|tie| and sets _battleResult.
        // Don't set up faint replacement — there are no replacements.
        if (this._battleResult && faintMsgs.length >= 2) {
          this._pendingFaintReplace = false;
          this._faintSide = null;
          console.log('[ShowdownBridge] Battle-ending double faint — skipping faint replacement');
        }

        // Translate messages to WRAM overrides (pass pre-turn HP to avoid race condition)
        const overrides = this.translator.processTurnLog(turnData, preTurnHP);

        // P2 HP correction — only available in test mode (enemy connection provides exact HP)
        const enemyRqidFresh = this._enemyRequest?.rqid !== preTurnEnemyRqid;
        if (this.enemyConn && this._enemyRequest?.side && overrides.faintSide !== 'p2' && enemyRqidFresh) {
          const enemyActive = this._enemyRequest.side.pokemon.find(p => p.active);
          if (enemyActive) {
            const [exactP2HP] = this._parseConditionHP(enemyActive.condition);
            const translatorP2HP = this.translator.hp.p2[this.translator.active.p2];
            const p2HPError = (translatorP2HP || 0) - exactP2HP;
            const p1DmgSlot = overrides.whoFirst === 0 ? 'm1' : 'm2';

            // For drain moves (Mega Drain, Absorb, etc.), the total HP error includes
            // both damage rounding error AND drain heal rounding error. We must only
            // adjust the damage by the DAMAGE error — the ROM calculates drain heal
            // internally as floor(damage/2), so correcting for the drain error too
            // would cause a double-correction.
            let pureDamageError = p2HPError;
            if (overrides.drainHeal?.p2 > 0) {
              const p2DmgSlot = overrides.whoFirst === 0 ? 'm2' : 'm1';
              const romDrainHeal = Math.floor(overrides[p2DmgSlot].damage / 2);
              const drainHealError = overrides.drainHeal.p2 - romDrainHeal;
              pureDamageError = p2HPError - drainHealError;
              console.log(`[ShowdownBridge] P2 drain correction: totalErr=${p2HPError} drainErr=${drainHealError} pureErr=${pureDamageError}`);
            }

            if (overrides[p1DmgSlot].damage > 0 && pureDamageError !== 0) {
              console.log(`[ShowdownBridge] P2 HP correction: translator=${translatorP2HP} exact=${exactP2HP} error=${pureDamageError}`);
              overrides[p1DmgSlot].damage = Math.max(0, overrides[p1DmgSlot].damage + pureDamageError);
            }
          }
        } else if (!this.enemyConn && overrides.faintSide !== 'p2' && !enemyRqidFresh) {
          // In play mode: p2 HP is estimated via estimateGen1HP() in translator._handleSwitch.
          // The percentage→exact conversion introduces ±1-3 HP error per event, acceptable for Gen 1.
        }

        // Correct p2's damage to p1 using player's exact HP
        if (this._playerRequest?.side && overrides.faintSide !== 'p1') {
          const pActive = this._playerRequest.side.pokemon.find(p => p.active);
          if (pActive) {
            const [exactP1HP] = this._parseConditionHP(pActive.condition);
            const translatorP1HP = this.translator.hp.p1[this.translator.active.p1];
            const p1HPError = (translatorP1HP || 0) - exactP1HP;
            const p2DmgSlot = overrides.whoFirst === 0 ? 'm2' : 'm1';
            if (overrides[p2DmgSlot].damage > 0 && p1HPError !== 0) {
              console.log(`[ShowdownBridge] P1 HP correction: translator=${translatorP1HP} exact=${exactP1HP} error=${p1HPError}`);
              overrides[p2DmgSlot].damage = Math.max(0, overrides[p2DmgSlot].damage + p1HPError);
            }
          }
        }

        // Re-sync translator HP from exact request data — only if fresh request arrived.
        // Using a stale request would overwrite post-turn HP with pre-turn values.
        if (this.enemyConn && this._enemyRequest?.side && enemyRqidFresh) {
          this.translator.updateFromRequest(this._enemyRequest, 'p2');
        }
        // In play mode: translator HP stays at estimated values from percentage conversion.
        if (this._playerRequest?.side) {
          this.translator.updateFromRequest(this._playerRequest, 'p1');
        }

        console.log('[ShowdownBridge] Live overrides:', JSON.stringify({
          whoFirst: overrides.whoFirst,
          flags: overrides.flags,
          enemyAction: overrides.enemyAction,
          enemyMove: overrides.enemyMove?.toString(16),
          enemyMoveSlot: overrides.enemyMoveSlot,
          m1: overrides.m1,
          m2: overrides.m2,
          hasFaint: overrides.hasFaint,
          faintSide: overrides.faintSide,
          statChanges: overrides.statChanges,
        }));

        // In play mode, write enemy switch-in data to WRAM party slots before ROM sees it.
        // writeActive=false: don't overwrite active battle mon — the ROM reads the OLD
        // mon's name for the "withdrew" message, then copies party data → active itself.
        // Use the switch-in HP (from the |switch| event), NOT the translator's post-turn HP.
        // The translator HP includes damage from moves that execute AFTER the switch,
        // but the ROM handles that damage itself via overrides.
        if (this.mode === 'play' && overrides.enemyAction >= 4) {
          const switchIdx = this.translator.active.p2;
          const enemyMon = this.translator.enemyParty[switchIdx];
          const switchEvent = overrides.switchIn?.p2;
          if (enemyMon && switchEvent) {
            const [cur, max] = this.translator._parseHP(switchEvent.hpText);
            const hpPct = max > 0 ? Math.round(cur * 100 / max) : 100;
            const sts = this._sdStatusToByte(this.translator.status.p2[switchIdx] || '');
            writeEnemyMonFromSpecies(this.rom, enemyMon.name, switchIdx, hpPct,
              { writeActive: false, statusByte: sts, moves: enemyMon.moves });
          }
        }

        // Sync status/volatile state before ROM executes
        this._syncPreTurnStatus(overrides);

        // Save stat modifiers before ROM executes
        const savedStatMods = { player: [], enemy: [] };
        for (let i = 0; i < 8; i++) {
          savedStatMods.player[i] = this.rom.read8(ADDR.PlayerMonStatMods + i);
          savedStatMods.enemy[i] = this.rom.read8(ADDR.EnemyMonStatMods + i);
        }

        // Write all known enemy moves to active battle mon move list.
        // The ROM reads wEnemyMonMoves[slot] to determine the move (core.asm:3111-3114),
        // so the move list must be populated with correct IDs.
        if (this.mode === 'play') {
          const activeP2 = this.translator.active.p2;
          const knownMoves = this.translator.enemyParty[activeP2]?.moves || [];
          for (let i = 0; i < 4; i++) {
            const moveId = (knownMoves[i] && MOVE_MAP[knownMoves[i]]) || 0;
            this.rom.write8(ADDR.EnemyMonMoves + i, moveId);
          }
        }

        // Write overrides to WRAM
        this._writeTurnOverrides(overrides);
        this.rom.write8(ADDR.SD_Phase, 2);

        // Wait for ROM to start executing
        const phase3ok = await this._waitForPhase(3, 5000);
        if (!phase3ok) {
          this._triggerDesync('ROM failed to execute turn (phase 3 timeout)');
          break;
        }

        // Wait for ROM to finish executing
        while (true) {
          await this._delay(100);
          const p = this.rom.read8(ADDR.SD_Phase);
          if (p === 0 || p === 1) break;
        }

        // Restore stat modifiers, then apply only Showdown-reported changes
        for (let i = 0; i < 8; i++) {
          this.rom.write8(ADDR.PlayerMonStatMods + i, savedStatMods.player[i]);
          this.rom.write8(ADDR.EnemyMonStatMods + i, savedStatMods.enemy[i]);
        }
        if (overrides.statChanges) {
          const STAT_INDEX = { atk: 0, def: 1, spe: 2, spa: 3, spd: 3, spc: 3, accuracy: 4, evasion: 5 };
          for (const sc of overrides.statChanges) {
            const idx = STAT_INDEX[sc.stat];
            if (idx === undefined) continue;
            const addr = sc.side === 'p1' ? ADDR.PlayerMonStatMods : ADDR.EnemyMonStatMods;
            const cur = this.rom.read8(addr + idx);
            const newVal = Math.max(1, Math.min(13, cur + sc.delta));
            this.rom.write8(addr + idx, newVal);
            console.log(`[ShowdownBridge] Stat change: ${sc.side} ${sc.stat} ${sc.delta > 0 ? '+' : ''}${sc.delta} (${cur}→${newVal})`);
          }
        }

        // Sync status/volatile state after ROM finishes
        this._syncPostTurnStatus();

        // Pre-sync sanity checks — catch divergence BEFORE _syncHP masks it.

        // HP divergence check (small rounding errors are expected, large ones are bugs)
        const preSyncP1HP = this.rom.read16be(ADDR.BattleMonHP);
        const preSyncP2HP = this.rom.read16be(ADDR.EnemyMonHP);
        const transP1 = this.translator.hp.p1[this.translator.active.p1] ?? 0;
        const transP2 = this.translator.hp.p2[this.translator.active.p2] ?? 0;
        const p1Div = Math.abs(preSyncP1HP - transP1);
        const p2Div = Math.abs(preSyncP2HP - transP2);
        const HP_TOLERANCE = 5;
        if (p1Div > HP_TOLERANCE) {
          console.warn(`[ShowdownBridge] P1 HP divergence: WRAM=${preSyncP1HP} translator=${transP1} (Δ${p1Div})`);
        }
        if (p2Div > HP_TOLERANCE) {
          console.warn(`[ShowdownBridge] P2 HP divergence: WRAM=${preSyncP2HP} translator=${transP2} (Δ${p2Div})`);
        }

        // Enemy move check — verify ROM used the correct move
        if (overrides.enemyAction < 4 && overrides.enemyMove) {
          const romEnemyMove = this.rom.read8(ADDR.EnemySelectedMove);
          if (romEnemyMove !== overrides.enemyMove) {
            console.error(`[ShowdownBridge] ENEMY MOVE MISMATCH: ROM used 0x${romEnemyMove.toString(16)} but expected 0x${overrides.enemyMove.toString(16)}`);
          }
        }

        // Correct WRAM HP to translator's authoritative values.
        // The ROM's internal calculations (e.g. DrainHP = damage/2) may differ from
        // Showdown's exact values due to rounding in damage overrides. This ensures
        // the displayed HP matches the translator after every turn.
        this._syncHP();

        // Log battle state after turn
        this._logBattleState();

        // Desync check — compare emu state against Showdown's authoritative values
        this._checkDesync();
        if (this._desyncTriggered) break;
      }

      await this._delay(50);
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Disconnect live mode.
   */
  disconnectLive() {
    this.liveMode = false;
    if (this.playerConn) this.playerConn.disconnect();
    if (this.enemyConn) this.enemyConn.disconnect();
    this.playerConn = null;
    this.enemyConn = null;
    this.translator = null;
    this.connected = false;
    this._desyncTriggered = false;
    this._battleResult = null;
    this._battleStarted = false;
    this._playerRequest = null;
    this._enemyRequest = null;
    this._turnMessages = [];
    this._pendingFaintReplace = false;
    this._faintSide = null;
    this._faintMessages = [];
    this._challengeTarget = null;
    this.rom.write8(ADDR.ShowdownConnected, 0);
    console.log('[ShowdownBridge] Live mode disconnected');
  }
}

// =============================================================================
// Global instance
// =============================================================================

window.showdownBridge = new ShowdownBridge();
