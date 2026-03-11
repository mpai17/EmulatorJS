/**
 * ShowdownBridge — JS bridge between EmulatorJS (gambatte core) and Pokemon Showdown.
 *
 * Live mode: connects to Showdown server, translates protocol to WRAM overrides.
 * Supports two connection modes:
 *   - connectPlay(): single connection, search for battle or challenge a user
 *   - connectTest(): dual connection (player + enemy), self-play for testing
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
    this._playerRequest = null;
    this._enemyRequest = null;
    this.enemyAutoRandom = true;
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
    this.rom.write8(ADDR.SD_M1_Effectiveness, m1.effectiveness ?? 10);

    // M2 override data (second mover)
    const m2 = turn.m2 || {};
    this.rom.write8(ADDR.SD_M2_DamageHi, ((m2.damage ?? 0) >> 8) & 0xFF);
    this.rom.write8(ADDR.SD_M2_DamageLo, (m2.damage ?? 0) & 0xFF);
    this.rom.write8(ADDR.SD_M2_Crit, m2.crit ?? 0);
    this.rom.write8(ADDR.SD_M2_Miss, m2.miss ?? 0);
    this.rom.write8(ADDR.SD_M2_Effectiveness, m2.effectiveness ?? 10);

    // Multi-hit count overrides
    this.rom.write8(ADDR.SD_M1_Hits, (m1.hits ?? 0) & 0xFF);
    this.rom.write8(ADDR.SD_M2_Hits, (m2.hits ?? 0) & 0xFF);

    // Substitute break hit overrides (0 = no break, N = break on hit N)
    this.rom.write8(ADDR.SD_M1_SubBreakHit, (m1.subBreakHit ?? 0) & 0xFF);
    this.rom.write8(ADDR.SD_M2_SubBreakHit, (m2.subBreakHit ?? 0) & 0xFF);
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
    this.rom.write8(ADDR.SD_M1_Effectiveness, m1.effectiveness ?? 10); // EFFECTIVE = $10

    // Write M2 override data (second mover)
    const m2 = turn.m2 || {};
    this.rom.write8(ADDR.SD_M2_DamageHi, ((m2.damage ?? 0) >> 8) & 0xFF);
    this.rom.write8(ADDR.SD_M2_DamageLo, (m2.damage ?? 0) & 0xFF);
    this.rom.write8(ADDR.SD_M2_Crit, m2.crit ?? 0);
    this.rom.write8(ADDR.SD_M2_Miss, m2.miss ?? 0);
    this.rom.write8(ADDR.SD_M2_Effectiveness, m2.effectiveness ?? 10);

    // Signal ROM that turn data is ready (set phase to 2 = turn_ready)
    this.rom.write8(ADDR.SD_Phase, 2);

    this.state = 'IDLE';
    console.log('[ShowdownBridge] Turn data written, phase set to turn_ready');
  }

  // ===========================================================================
  // Live mode — WebSocket connection to Showdown server
  // ===========================================================================

  /**
   * Connect in Play mode — single connection, search for battle or challenge a user.
   *
   * @param {string} serverUrl - WebSocket URL
   * @param {object} playerAuth - { name, pass }
   * @param {string} packedTeam - Packed team string
   * @param {string} format - e.g. 'gen1ou'
   * @param {string} playMode - 'search' or 'challenge'
   * @param {string} [challengeTarget] - Username to challenge (if playMode === 'challenge')
   */
  async connectPlay(serverUrl, playerAuth, packedTeam, format, playMode, challengeTarget) {
    this.mode = 'play';
    this.liveMode = true;
    this.translator = new TurnTranslator();
    this.playerConn = new ShowdownConnection('player');
    this.enemyConn = null; // no enemy connection in play mode

    // Set up player connection callbacks
    this.playerConn.onBattleMessage = (roomId, msgs) => this._onPlayerBattleMessage(msgs);
    this.playerConn.onRequest = (req) => this._onPlayerRequest(req);
    this.playerConn.onBattleEnd = (result) => this._onBattleEnd(result);

    // Connect and authenticate
    await this.playerConn.connect(serverUrl);
    await this.playerConn.login(playerAuth.name, playerAuth.pass);
    console.log(`[ShowdownBridge] Player authenticated as "${this.playerConn.username}"`);

    // Set team
    this.playerConn.setTeam(packedTeam);
    await this._delay(500);

    // Initiate matchmaking
    if (playMode === 'challenge') {
      console.log(`[ShowdownBridge] Challenging "${challengeTarget}" in ${format}`);
      this.playerConn.challenge(challengeTarget, format);
    } else {
      console.log(`[ShowdownBridge] Searching for ${format} battle...`);
      this.playerConn.send(`|/search ${format}`);
    }

    // Wait for battle to start (longer timeout for matchmaking)
    await this._waitForBattleStart(60000);
    console.log('[ShowdownBridge] Battle started! Entering live polling loop.');

    // WRAM setup
    await this._initWRAM();

    // Process initial battle messages
    this._processInitialMessages();

    // Start live polling loop
    this._pollLive();
  }

  /**
   * Connect in Test mode — dual connection (player + enemy), self-play.
   *
   * @param {string} serverUrl - WebSocket URL
   * @param {object} playerAuth - { name, pass }
   * @param {object} enemyAuth - { name, pass }
   * @param {string} packedTeam - Packed team string
   * @param {string} format - e.g. 'gen1ou'
   */
  async connectTest(serverUrl, playerAuth, enemyAuth, packedTeam, format) {
    this.mode = 'test';
    this.liveMode = true;
    this.translator = new TurnTranslator();
    this.playerConn = new ShowdownConnection('player');
    this.enemyConn = new ShowdownConnection('enemy');

    // Set up player connection callbacks
    this.playerConn.onBattleMessage = (roomId, msgs) => this._onPlayerBattleMessage(msgs);
    this.playerConn.onRequest = (req) => this._onPlayerRequest(req);
    this.playerConn.onBattleEnd = (result) => this._onBattleEnd(result);

    // Set up enemy connection callbacks
    this.enemyConn.onRequest = (req) => this._onEnemyRequest(req);
    this.enemyConn.onChallenge = (from, format) => {
      console.log(`[ShowdownBridge] Enemy accepting challenge from ${from}`);
      this.enemyConn.setTeam(packedTeam);
      this.enemyConn.acceptChallenge();
    };

    // Connect both
    await this.playerConn.connect(serverUrl);
    await this.enemyConn.connect(serverUrl);

    // Authenticate both
    await this.playerConn.login(playerAuth.name, playerAuth.pass);
    await this.enemyConn.login(enemyAuth.name, enemyAuth.pass);
    console.log(`[ShowdownBridge] Both connections authenticated`);

    // Set teams and challenge
    this.playerConn.setTeam(packedTeam);
    this.enemyConn.setTeam(packedTeam);
    await this._delay(500);
    const actualEnemyName = this.enemyConn.username;
    console.log(`[ShowdownBridge] Challenging "${actualEnemyName}"`);
    this.playerConn.challenge(actualEnemyName, format);

    // Wait for battle to start
    await this._waitForBattleStart(20000);
    console.log('[ShowdownBridge] Battle started! Entering live polling loop.');

    // WRAM setup
    await this._initWRAM();

    // Process initial battle messages
    this._processInitialMessages();

    // Start live polling loop
    this._pollLive();
  }

  /** Shared WRAM initialization for both play and test modes. */
  async _initWRAM() {
    let wramOk = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      this.rom._wramPtr = null;
      this.rom._module = null;
      wramOk = this.rom._getWramPtr() !== null;
      if (wramOk) break;
      await this._delay(1000);
    }
    if (!wramOk) {
      console.error('[ShowdownBridge] WRAM not found — cannot start live mode');
      throw new Error('WRAM not found');
    }

    this.rom.write8(ADDR.ShowdownConnected, 1);
    this.rom.write8(ADDR.LinkState, 0x04);
    this.connected = true;
  }

  /** Process initial battle messages (switch events) to set up translator HP state. */
  _processInitialMessages() {
    if (this._turnMessages && this._turnMessages.length > 0) {
      for (const msg of this._turnMessages) {
        if (msg.cmd === 'switch' || msg.cmd === 'drag') {
          const side = this.translator._parseSide(msg.parts[1]);
          this.translator._handleSwitch(side, msg.parts[1], msg.parts[3]);
        }
      }
      console.log('[ShowdownBridge] Processed initial battle messages for HP state');
      this._turnMessages = [];
    }
  }

  async _waitForBattleStart(timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (this._battleStarted) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error('Battle start timeout')), timeout);
      this.playerConn.onBattleStarted = () => {
        this._battleStarted = true;
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Live polling loop: Phase 1 → read action → send to server → wait → write WRAM → Phase 2
   */
  async _pollLive() {
    console.log('[ShowdownBridge] Live poll loop started');

    // Wait for battle intro
    await this._delay(6000);

    while (this.connected && this.liveMode) {
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
            await this._handleDoubleFaintPlayerFirst();
            continue;
          } else if (this._faintSide === 'p2-double') {
            await this._handleDoubleFaintEnemySecond();
            continue;
          } else if (this._faintSide === 'p1') {
            await this._handlePlayerFaintExchange();
          } else {
            await this._handleFaintExchange();
          }
          continue;
        }

        // Read player's chosen action from WRAM.
        let choice;

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
            const moveSlot = this.rom.read8(ADDR.PlayerMoveListIndex);
            choice = `move ${moveSlot + 1}`; // Showdown is 1-indexed
            console.log(`[ShowdownBridge] Live: player picks move slot ${moveSlot} → "${choice}"`);
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

        // Wait for turn resolution messages
        const turnData = await this._waitForTurnResolution(30000);
        if (!turnData) {
          console.error('[ShowdownBridge] Timeout waiting for turn resolution');
          continue;
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

        // Small delay to let enemy's post-turn |request| arrive (has exact HP)
        await this._delay(100);

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

        // Sync status/volatile state before ROM executes
        this._syncPreTurnStatus(overrides);

        // Save stat modifiers before ROM executes
        const savedStatMods = { player: [], enemy: [] };
        for (let i = 0; i < 8; i++) {
          savedStatMods.player[i] = this.rom.read8(ADDR.PlayerMonStatMods + i);
          savedStatMods.enemy[i] = this.rom.read8(ADDR.EnemyMonStatMods + i);
        }

        // Write overrides to WRAM
        this._writeTurnOverrides(overrides);
        this.rom.write8(ADDR.SD_Phase, 2);

        // Wait for ROM to start executing
        await this._waitForPhase(3, 5000);

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

        // Correct WRAM HP to translator's authoritative values.
        // The ROM's internal calculations (e.g. DrainHP = damage/2) may differ from
        // Showdown's exact values due to rounding in damage overrides. This ensures
        // the displayed HP matches the translator after every turn.
        this._syncHP();

        // Log battle state after turn
        this._logBattleState();
      }

      await this._delay(50);
    }
  }

  async _handleFaintExchange() {
    console.log('[ShowdownBridge] Handling faint exchange');

    // Wait for switch-in messages from server
    const switchData = await this._waitForFaintSwitch(15000);
    if (switchData) {
      const result = this.translator.processForceSwitch(switchData);
      console.log(`[ShowdownBridge] Faint exchange: enemy sends out party slot ${result.enemyAction - 4} (action byte ${result.enemyAction})`);
      this.rom.write8(ADDR.SerialReceiveData, result.enemyAction);
    } else {
      console.error('[ShowdownBridge] Faint exchange: no switch data received!');
    }

    this.rom.write8(ADDR.SD_Phase, 2);
    this._pendingFaintReplace = false;
    this._faintSide = null;
    await this._waitForPhase(3, 5000);
  }

  async _handlePlayerFaintExchange() {
    console.log('[ShowdownBridge] Handling player faint exchange');

    // Read player's switch choice from WRAM
    const whichPokemon = this.rom.read8(ADDR.WhichPokemon);

    // Map ROM party index to Showdown request index
    const targetSpecies = window.PARTY[whichPokemon]?.name;
    let sdIndex = whichPokemon; // fallback
    if (this._playerRequest?.side?.pokemon && targetSpecies) {
      const idx = this._playerRequest.side.pokemon.findIndex(
        p => p.ident.split(': ')[1] === targetSpecies && !p.condition.includes('fnt')
      );
      if (idx >= 0) sdIndex = idx;
    }
    const choice = `switch ${sdIndex + 1}`; // Showdown is 1-indexed
    console.log(`[ShowdownBridge] Player faint switch: ${targetSpecies} (ROM slot ${whichPokemon}, SD slot ${sdIndex}) → "${choice}"`);

    // Update translator's active tracking
    this.translator.active.p1 = whichPokemon;
    console.log(`[ShowdownBridge] Updated translator active.p1 = ${whichPokemon}`);

    // Send to Showdown
    const rqid = this._playerForceRqid || this.playerConn._rqid;
    this.playerConn.sendChoice(choice, rqid);

    // ROM already knows which mon the player selected — no need to write SerialReceiveData.
    this.rom.write8(ADDR.SD_Phase, 2);
    this._pendingFaintReplace = false;
    this._faintSide = null;
    this._enemyFaintReplacement = null;
    await this._waitForPhase(3, 5000);

    // Wait for ROM to finish
    while (true) {
      await this._delay(100);
      const p = this.rom.read8(ADDR.SD_Phase);
      if (p === 0 || p === 1) break;
    }
  }

  async _handleDoubleFaintPlayerFirst() {
    console.log('[ShowdownBridge] Handling double faint — player replacement (phase 1 of 2)');

    // Read player's switch choice from WRAM
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

    // Send to Showdown
    const rqid = this._playerForceRqid || this.playerConn._rqid;
    this.playerConn.sendChoice(choice, rqid);

    // Advance ROM past player faint exchange
    this.rom.write8(ADDR.SD_Phase, 2);
    await this._waitForPhase(3, 5000);

    // Downgrade to p2 (enemy) faint — next Phase 1 will be enemy replacement
    this._faintSide = 'p2-double';

    // Wait for ROM to finish player faint sequence and hit Phase 1 again
    while (true) {
      await this._delay(100);
      const p = this.rom.read8(ADDR.SD_Phase);
      if (p === 0 || p === 1) break;
    }
  }

  async _handleDoubleFaintEnemySecond() {
    console.log('[ShowdownBridge] Handling double faint — enemy replacement (phase 2 of 2)');

    // Wait for enemy's forceSwitch request to arrive if it hasn't yet.
    for (let i = 0; i < 50 && !this._enemyFaintReplacement; i++) {
      await this._delay(100);
    }

    if (this._enemyFaintReplacement) {
      const { species, partyIdx } = this._enemyFaintReplacement;
      const enemyAction = 4 + partyIdx;
      console.log(`[ShowdownBridge] Double faint: enemy sends out ${species} (partyIdx=${partyIdx}, action=${enemyAction})`);
      this.rom.write8(ADDR.SerialReceiveData, enemyAction);
      this.translator.active.p2 = partyIdx;
    } else {
      console.error('[ShowdownBridge] Double faint: no enemy replacement tracked! Using fallback.');
      this.rom.write8(ADDR.SerialReceiveData, 4);
    }

    // Advance ROM past enemy faint exchange
    this.rom.write8(ADDR.SD_Phase, 2);
    this._pendingFaintReplace = false;
    this._faintSide = null;
    this._enemyFaintReplacement = null;
    await this._waitForPhase(3, 5000);

    // Wait for ROM to finish + drain post-switch messages
    while (true) {
      await this._delay(100);
      const p = this.rom.read8(ADDR.SD_Phase);
      if (p === 0 || p === 1) break;
    }

    // Drain messages to prevent contamination of next turn
    await this._delay(500);
    this._turnMessages = [];
    this._faintMessages = [];
    console.log('[ShowdownBridge] Double faint complete — drained post-switch messages');
  }

  _waitForTurnResolution(timeout = 30000) {
    return new Promise((resolve) => {
      this._turnMessages = [];
      const timer = setTimeout(() => {
        this._turnResolve = null;
        resolve(null);
      }, timeout);

      this._turnResolve = (msgs) => {
        clearTimeout(timer);
        this._turnResolve = null;
        resolve([...msgs]);
      };
    });
  }

  _waitForFaintSwitch(timeout = 15000) {
    const allMsgs = [...(this._faintMessages || []), ...(this._turnMessages || [])];
    const alreadyHasSwitch = allMsgs.some(m =>
      (m.cmd === 'switch' || m.cmd === 'drag') && this.translator._parseSide(m.parts[1]) === 'p2');
    if (alreadyHasSwitch) {
      console.log('[ShowdownBridge] Faint switch messages already received');
      return Promise.resolve(allMsgs);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.error('[ShowdownBridge] Timeout waiting for faint switch');
        this._faintResolve = null;
        resolve(null);
      }, timeout);

      this._faintResolve = (msgs) => {
        clearTimeout(timer);
        this._faintResolve = null;
        resolve(msgs);
      };
    });
  }

  _parseConditionHP(condition) {
    if (!condition) return [0, 0];
    if (condition.includes('fnt')) return [0, 0];
    const match = condition.match(/(\d+)\/(\d+)/);
    if (!match) return [0, 0];
    return [parseInt(match[1]), parseInt(match[2])];
  }

  /**
   * Log current battle state from WRAM for debugging.
   */
  _logBattleState() {
    const PARTYMON_STRUCT = 0x2C;
    const STAT_NAMES = ['atk', 'def', 'spd', 'spc', 'acc', 'eva'];
    const STATUS_NAMES = { 0: 'none', 4: 'par', 8: 'brn', 16: 'frz', 32: 'psn' };

    function fmtStatus(byte) {
      if (byte === 0) return 'none';
      if (byte & 0x07) return `slp(${byte & 0x07})`;
      return STATUS_NAMES[byte] || `0x${byte.toString(16)}`;
    }

    function fmtStatMods(mods) {
      const parts = [];
      for (let i = 0; i < 6; i++) {
        const stage = mods[i] - 7;
        if (stage !== 0) parts.push(`${STAT_NAMES[i]}${stage > 0 ? '+' : ''}${stage}`);
      }
      return parts.length ? parts.join(' ') : 'neutral';
    }

    function fmtBattleStatus(b1, b2, b3) {
      const flags = [];
      if (b1 & 0x01) flags.push('bide');
      if (b1 & 0x02) flags.push('thrash');
      if (b1 & 0x04) flags.push('multiHit');
      if (b1 & 0x08) flags.push('flinch');
      if (b1 & 0x10) flags.push('charging');
      if (b1 & 0x20) flags.push('multiturn');
      if (b1 & 0x40) flags.push('invulnerable');
      if (b1 & 0x80) flags.push('confused');
      if (b2 & 0x01) flags.push('xAccuracy');
      if (b2 & 0x04) flags.push('mist');
      if (b2 & 0x08) flags.push('focusEnergy');
      if (b2 & 0x10) flags.push('substitute');
      if (b2 & 0x20) flags.push('recharging');
      if (b2 & 0x40) flags.push('rage');
      if (b2 & 0x80) flags.push('leechSeed');
      if (b3 & 0x01) flags.push('toxic');
      if (b3 & 0x02) flags.push('lightScreen');
      if (b3 & 0x04) flags.push('reflect');
      if (b3 & 0x08) flags.push('transformed');
      return flags.length ? flags.join(',') : 'none';
    }

    const pMods = [], eMods = [];
    for (let i = 0; i < 8; i++) {
      pMods.push(this.rom.read8(ADDR.PlayerMonStatMods + i));
      eMods.push(this.rom.read8(ADDR.EnemyMonStatMods + i));
    }

    const pPartyHP = [], ePartyHP = [];
    for (let i = 0; i < 6; i++) {
      pPartyHP.push(this.rom.read16be(ADDR.PartyMon1HP + i * PARTYMON_STRUCT));
      ePartyHP.push(this.rom.read16be(ADDR.EnemyMon1HP + i * PARTYMON_STRUCT));
    }

    const overridesWritten = {
      whoFirst: this.rom.read8(ADDR.SD_WhoFirst),
      flags: this.rom.read8(ADDR.SD_Flags),
      enemyAction: this.rom.read8(ADDR.SerialReceiveData),
    };

    // Compare WRAM HP with Showdown's authoritative HP
    const wramP1HP = this.rom.read16be(ADDR.BattleMonHP);
    const wramP2HP = this.rom.read16be(ADDR.EnemyMonHP);
    const sdP1HP = this.translator?.hp?.p1?.[this.translator.active.p1] ?? '?';
    const sdP2HP = this.translator?.hp?.p2?.[this.translator.active.p2] ?? '?';
    // Exact HP from latest requests (ground truth)
    const reqP1HP = this._playerRequest?.side?.pokemon?.find(p => p.active)?.condition || '?';
    const reqP2HP = this._enemyRequest?.side?.pokemon?.find(p => p.active)?.condition || '?';
    const p1Match = wramP1HP === sdP1HP ? 'OK' : `MISMATCH(diff=${wramP1HP - sdP1HP})`;
    const p2Match = wramP2HP === sdP2HP ? 'OK' : `MISMATCH(diff=${wramP2HP - sdP2HP})`;

    const log = [
      `=== BATTLE STATE ===`,
      `Player: WRAM=${wramP1HP} translator=${sdP1HP} request="${reqP1HP}" ${p1Match}`,
      `Enemy:  WRAM=${wramP2HP} translator=${sdP2HP} request="${reqP2HP}" ${p2Match}`,
      `Player: status=${fmtStatus(this.rom.read8(ADDR.BattleMonStatus))} statMods=[${fmtStatMods(pMods)}] battleFlags=[${fmtBattleStatus(this.rom.read8(ADDR.PlayerBattleStatus1), this.rom.read8(ADDR.PlayerBattleStatus2), this.rom.read8(ADDR.PlayerBattleStatus3))}]`,
      `Enemy:  status=${fmtStatus(this.rom.read8(ADDR.EnemyMonStatus))} statMods=[${fmtStatMods(eMods)}] battleFlags=[${fmtBattleStatus(this.rom.read8(ADDR.EnemyBattleStatus1), this.rom.read8(ADDR.EnemyBattleStatus2), this.rom.read8(ADDR.EnemyBattleStatus3))}]`,
      `Party HP: player=[${pPartyHP.join(',')}] enemy=[${ePartyHP.join(',')}]`,
      `Overrides: whoFirst=${overridesWritten.whoFirst} flags=0x${overridesWritten.flags.toString(16)} enemyAction=${overridesWritten.enemyAction}`,
    ];
    console.log(log.join('\n'));
  }

  /**
   * Handle incoming battle messages from the player's connection.
   */
  _onPlayerBattleMessage(messages) {
    for (const msg of messages) {
      console.log(`[ShowdownBridge] Battle: ${msg.raw}`);
    }

    if (this._pendingFaintReplace) {
      this._faintMessages.push(...messages);
      const hasSwitch = messages.some(m => m.cmd === 'switch' || m.cmd === 'drag');
      if (hasSwitch && this._faintResolve) {
        this._faintResolve(this._faintMessages);
      }
      return;
    }

    this._turnMessages.push(...messages);

    const hasTurnMarker = messages.some(m => m.cmd === 'turn');
    const hasBattleEnd = messages.some(m => m.cmd === 'win' || m.cmd === 'tie');
    const hasFaint = messages.some(m => m.cmd === 'faint');

    if ((hasTurnMarker || hasBattleEnd || hasFaint) && this._turnResolve) {
      this._turnResolve(this._turnMessages);
    }
  }

  _onPlayerRequest(req) {
    this._playerRequest = req;
    if (this.translator && req.side) {
      if (!this.translator._initialized) {
        this.translator.initFromRequest(req, 'p1');
      }
      // NOTE: Do NOT call updateFromRequest here. The |request| arrives before
      // the turn log, so updating now would contaminate _atTurnStart.status
      // (e.g., writing PAR before the ROM executes Thunder Wave). The bridge
      // already calls updateFromRequest after processTurnLog (lines 627-628).
    }

    // If it's a force-switch request, player needs to pick a replacement
    if (req.forceSwitch) {
      this._playerForceRqid = req.rqid;
      if (this._faintSide === 'both') {
        console.log('[ShowdownBridge] Player forceSwitch: faintSide already "both"');
      } else if (this._pendingFaintReplace && this._faintSide === 'p2') {
        this._faintSide = 'both';
        this._faintMessages = [];
        console.log('[ShowdownBridge] Double faint detected: upgrading faintSide p2 → both');
      } else {
        this._pendingFaintReplace = true;
        this._faintSide = 'p1';
      }
    }
  }

  _onEnemyRequest(req) {
    this._enemyRequest = req;

    // Initialize p2 maxHP/HP from the first enemy request (exact values).
    // Without this, _handleSwitch falls back to estimateGen1HP() which can be off by 1-2 HP.
    if (this.translator && req.side && !this.translator._initialized_p2) {
      this.translator.initFromRequest(req, 'p2');
      this.translator._initialized_p2 = true;
    }

    // NOTE: Do NOT call updateFromRequest here — same reason as _onPlayerRequest.
    // The bridge calls updateFromRequest after processTurnLog (lines 623-624).

    // Auto-respond for enemy (force-switch always auto-responds; moves only if enabled)
    if (req.forceSwitch) {
      const pokemon = req.side?.pokemon || [];
      for (let i = 0; i < pokemon.length; i++) {
        if (!pokemon[i].active && !pokemon[i].condition.includes('fnt')) {
          const species = pokemon[i].ident.split(': ')[1];
          const partyIdx = this.translator._findPartyIndex(species);
          this._enemyFaintReplacement = { species, partyIdx, sdIndex: i };
          console.log(`[ShowdownBridge] Enemy force-switch to slot ${i + 1} (${species}, partyIdx=${partyIdx})`);
          this.enemyConn.sendChoice(`switch ${i + 1}`, req.rqid);
          return;
        }
      }
    } else if (req.active && this.enemyAutoRandom) {
      const moves = req.active[0]?.moves || [];
      const legal = moves.filter(m => !m.disabled && m.pp > 0);
      if (legal.length > 0) {
        const pick = legal[Math.floor(Math.random() * legal.length)];
        const moveIdx = moves.indexOf(pick) + 1;
        this.enemyConn.sendChoice(`move ${moveIdx}`, req.rqid);
        console.log(`[ShowdownBridge] Enemy auto-picks move ${moveIdx} (${pick.move})`);
      } else {
        this.enemyConn.sendChoice('move 1', req.rqid);
      }
    }
  }

  _onBattleEnd(result) {
    console.log(`[ShowdownBridge] Battle ended:`, result);
    if (result.type === 'win') {
      const playerWon = result.winner === this.playerConn.username;
      this.rom.write8(ADDR.SD_BattleEnd, playerWon ? 1 : 2);
    } else {
      this.rom.write8(ADDR.SD_BattleEnd, 3); // tie
    }
    this.liveMode = false;
  }

  /**
   * Pre-turn status sync.
   */
  _syncPreTurnStatus(overrides) {
    if (!this.translator) return;
    const PARTYMON_STRIDE = 0x2C;

    for (const side of ['p1', 'p2']) {
      const activeAddr = side === 'p1' ? ADDR.BattleMonStatus : ADDR.EnemyMonStatus;
      const partyStatusBase = side === 'p1' ? ADDR.PartyMon1Status : ADDR.EnemyMon1Status;
      const bs1Addr = side === 'p1' ? ADDR.PlayerBattleStatus1 : ADDR.EnemyBattleStatus1;
      const bs2Addr = side === 'p1' ? ADDR.PlayerBattleStatus2 : ADDR.EnemyBattleStatus2;
      const confCounterAddr = side === 'p1' ? ADDR.PlayerConfusedCounter : ADDR.EnemyConfusedCounter;
      const activeIdx = this.translator.active[side];
      const cantEntry = (overrides.cantReasons || []).find(c => c.side === side);
      const cureSleep = (overrides.statusChanges || []).some(
        s => s.side === side && s.statusId === 'slp' && s.type === 'cure');
      const cureFreeze = (overrides.statusChanges || []).some(
        s => s.side === side && s.statusId === 'frz' && s.type === 'cure');

      // Build status byte from the TURN-START snapshot, not the current (post-turn) state.
      // This ensures new status from this turn's moves (e.g. freeze from Blizzard)
      // isn't applied before the ROM executes the move animation.
      // Post-turn sync will apply the final status after the ROM finishes.
      const sdStatus = this.translator._atTurnStart?.status?.[side] || '';
      let statusByte = 0;
      if (sdStatus === 'par') statusByte = 0x40;
      else if (sdStatus === 'brn') statusByte = 0x10;
      else if (sdStatus === 'psn' || sdStatus === 'tox') statusByte = 0x08;
      else if (sdStatus === 'frz') statusByte = 0x20;
      else if (sdStatus === 'slp') statusByte = 0x02;

      // Sleep counter adjustments
      if (cantEntry?.reason === 'slp') {
        statusByte = (statusByte & ~0x07) | 0x02;
      } else if (cureSleep) {
        statusByte = (statusByte & ~0x07) | 0x01;
      }

      // Freeze adjustments
      if (cantEntry?.reason === 'frz') {
        statusByte |= 0x20;
      } else if (cureFreeze) {
        statusByte &= ~0x20;
      }

      this.rom.write8(activeAddr, statusByte);
      this.rom.write8(partyStatusBase + activeIdx * PARTYMON_STRIDE, statusByte);

      // Recharge flag
      let bs2 = this.rom.read8(bs2Addr);
      if (cantEntry?.reason === 'recharge') {
        bs2 |= 0x20;
      }
      this.rom.write8(bs2Addr, bs2);

      // Confusion bit
      let bs1 = this.rom.read8(bs1Addr);
      if (this.translator._atTurnStart.confused[side]) {
        bs1 |= 0x80;
        this.rom.write8(confCounterAddr, 3);
      } else {
        if (bs1 & 0x80) {
          bs1 &= ~0x80;
          this.rom.write8(confCounterAddr, 0);
        }
      }

      // Multi-turn flags on BattleStatus1
      if (this.translator.biding[side]) bs1 |= 0x01; else bs1 &= ~0x01;
      if (this.translator.thrashing[side]) bs1 |= 0x02; else bs1 &= ~0x02;
      if (this.translator.charging[side]) bs1 |= 0x10; else bs1 &= ~0x10;
      if (this.translator.trapped[side]) bs1 |= 0x20; else bs1 &= ~0x20;
      if (this.translator.invulnerable[side]) bs1 |= 0x40; else bs1 &= ~0x40;
      this.rom.write8(bs1Addr, bs1);

      // BattleStatus2 flags
      bs2 = this.rom.read8(bs2Addr);
      if (this.translator.raging[side]) bs2 |= 0x40; else bs2 &= ~0x40;
      const subAtStart = this.translator._atTurnStart.substitute[side];
      if (subAtStart) {
        bs2 |= 0x10;
      } else {
        bs2 &= ~0x10;
        const subHPAddr = side === 'p1' ? ADDR.PlayerSubstituteHP : ADDR.EnemySubstituteHP;
        this.rom.write8(subHPAddr, 0);
      }
      const seededAtStart = this.translator._atTurnStart.seeded[side];
      if (seededAtStart) bs2 |= 0x80; else bs2 &= ~0x80;
      this.rom.write8(bs2Addr, bs2);

      // Multi-turn counter sync
      const numAttacksAddr = side === 'p1' ? ADDR.PlayerNumAttacksLeft : ADDR.EnemyNumAttacksLeft;
      if (this.translator.thrashing[side]) {
        this.rom.write8(numAttacksAddr, 2);
      }
      if (this.translator.trapped[side]) {
        this.rom.write8(numAttacksAddr, 2);
      }

      // Disable sync
      const disabledMoveAddr = side === 'p1' ? ADDR.PlayerDisabledMove : ADDR.EnemyDisabledMove;
      const disabledMoveNumAddr = side === 'p1' ? ADDR.PlayerDisabledMoveNumber : ADDR.EnemyDisabledMoveNumber;

      const disabledAtStart = this.translator._atTurnStart.disabled[side];
      if (disabledAtStart && typeof disabledAtStart === 'string') {
        const moveName = disabledAtStart;
        const moveListBase = side === 'p1' ? ADDR.BattleMonMoves : ADDR.EnemyMonMoves;
        const moveId = MOVE_MAP[moveName] || 0;
        let slot = 0;
        for (let i = 0; i < 4; i++) {
          if (this.rom.read8(moveListBase + i) === moveId) { slot = i + 1; break; }
        }
        if (slot > 0) {
          const cur = this.rom.read8(disabledMoveAddr);
          if ((cur & 0xF0) === 0) {
            this.rom.write8(disabledMoveAddr, (slot << 4) | 5);
            this.rom.write8(disabledMoveNumAddr, moveId);
          } else {
            const existingSlot = (cur >> 4) & 0x0F;
            if (existingSlot === slot) {
              if ((cur & 0x0F) <= 1) this.rom.write8(disabledMoveAddr, (slot << 4) | 3);
            } else {
              this.rom.write8(disabledMoveAddr, (slot << 4) | 5);
              this.rom.write8(disabledMoveNumAddr, moveId);
            }
          }
        }
      } else {
        this.rom.write8(disabledMoveAddr, 0);
        this.rom.write8(disabledMoveNumAddr, 0);
      }
    }

    console.log('[ShowdownBridge] Pre-turn status sync complete');
  }

  /**
   * Post-turn status sync.
   */
  _syncPostTurnStatus() {
    if (!this.translator) return;
    const PARTYMON_STRIDE = 0x2C;
    const STATUS_MAP = { par: 0x40, brn: 0x10, frz: 0x20, psn: 0x08, tox: 0x08 };

    for (const side of ['p1', 'p2']) {
      const activeIdx = this.translator.active[side];
      const statusStr = this.translator.status[side][activeIdx] || '';
      const activeAddr = side === 'p1' ? ADDR.BattleMonStatus : ADDR.EnemyMonStatus;
      const partyBase = side === 'p1' ? ADDR.PartyMon1Status : ADDR.EnemyMon1Status;

      let statusByte;
      if (statusStr === 'slp') {
        statusByte = this.rom.read8(activeAddr);
        if ((statusByte & 0x07) === 0) statusByte = 0x03;
      } else {
        statusByte = STATUS_MAP[statusStr] || 0x00;
      }

      this.rom.write8(activeAddr, statusByte);
      this.rom.write8(partyBase + activeIdx * PARTYMON_STRIDE, statusByte);

      // Confusion volatile
      const bs1Addr = side === 'p1' ? ADDR.PlayerBattleStatus1 : ADDR.EnemyBattleStatus1;
      const confAddr = side === 'p1' ? ADDR.PlayerConfusedCounter : ADDR.EnemyConfusedCounter;
      let bs1 = this.rom.read8(bs1Addr);
      if (this.translator.confused[side] && !(bs1 & 0x80)) {
        this.rom.write8(bs1Addr, bs1 | 0x80);
        this.rom.write8(confAddr, 3);
      } else if (!this.translator.confused[side] && (bs1 & 0x80)) {
        this.rom.write8(bs1Addr, bs1 & ~0x80);
        this.rom.write8(confAddr, 0);
      }

      // Recharge flag
      const bs2Addr = side === 'p1' ? ADDR.PlayerBattleStatus2 : ADDR.EnemyBattleStatus2;
      let bs2 = this.rom.read8(bs2Addr);
      if (this.translator.recharging[side]) bs2 |= 0x20; else bs2 &= ~0x20;
      if (this.translator.raging[side]) bs2 |= 0x40; else bs2 &= ~0x40;
      if (this.translator.substitute[side]) {
        bs2 |= 0x10;
      } else {
        bs2 &= ~0x10;
        const subHPAddr = side === 'p1' ? ADDR.PlayerSubstituteHP : ADDR.EnemySubstituteHP;
        this.rom.write8(subHPAddr, 0);
      }
      if (this.translator.seeded[side]) bs2 |= 0x80; else bs2 &= ~0x80;
      this.rom.write8(bs2Addr, bs2);

      // Disable state
      const disabledMoveAddr = side === 'p1' ? ADDR.PlayerDisabledMove : ADDR.EnemyDisabledMove;
      const disabledMoveNumAddr = side === 'p1' ? ADDR.PlayerDisabledMoveNumber : ADDR.EnemyDisabledMoveNumber;
      if (!this.translator.disabled[side]) {
        this.rom.write8(disabledMoveAddr, 0);
        this.rom.write8(disabledMoveNumAddr, 0);
      }
    }

    console.log('[ShowdownBridge] Post-turn status sync complete');
  }

  /**
   * Sync HP from translator's authoritative state to WRAM.
   */
  _syncHP() {
    if (!this.translator) return;
    const sync = this.translator.getHPSync();
    const PARTYMON_STRIDE = 0x2C;

    this.rom.write16be(ADDR.BattleMonHP, sync.playerActiveHP);
    this.rom.write16be(ADDR.EnemyMonHP, sync.enemyActiveHP);

    for (let i = 0; i < 6; i++) {
      this.rom.write16be(ADDR.PartyMon1HP + i * PARTYMON_STRIDE, sync.playerPartyHP[i]);
      this.rom.write16be(ADDR.EnemyMon1HP + i * PARTYMON_STRIDE, sync.enemyPartyHP[i]);
    }
  }

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
    this.rom.write8(ADDR.ShowdownConnected, 0);
    console.log('[ShowdownBridge] Live mode disconnected');
  }
}

// =============================================================================
// Global instance
// =============================================================================

window.showdownBridge = new ShowdownBridge();
