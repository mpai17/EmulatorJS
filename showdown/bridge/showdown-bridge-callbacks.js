/**
 * ShowdownBridge — Connection callbacks and battle end handling.
 *
 * Extends ShowdownBridge.prototype with handlers for incoming
 * battle messages, player/enemy requests, and battle end events.
 * Loaded after showdown-bridge.js defines the class.
 *
 * Depends on: ADDR (showdown-config.js)
 */

// =============================================================================
// Connection callbacks
// =============================================================================

/**
 * Handle incoming battle messages from the player's connection.
 */
ShowdownBridge.prototype._onPlayerBattleMessage = function(messages) {
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
};

ShowdownBridge.prototype._onPlayerRequest = function(req) {
  this._playerRequest = req;
  if (this.translator && req.side) {
    if (!this.translator._initialized) {
      this.translator.initFromRequest(req, 'p1');
    }
    // NOTE: Do NOT call updateFromRequest here. The |request| arrives before
    // the turn log, so updating now would contaminate _atTurnStart.status
    // (e.g., writing PAR before the ROM executes Thunder Wave). The bridge
    // already calls updateFromRequest after processTurnLog.
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
};

ShowdownBridge.prototype._onEnemyRequest = function(req) {
  this._enemyRequest = req;

  // Initialize p2 maxHP/HP from the first enemy request (exact values).
  // Without this, _handleSwitch falls back to estimateGen1HP() which can be off by 1-2 HP.
  if (this.translator && req.side && !this.translator._initialized_p2) {
    this.translator.initFromRequest(req, 'p2');
    this.translator._initialized_p2 = true;
  }

  // NOTE: Do NOT call updateFromRequest here — same reason as _onPlayerRequest.

  // Auto-respond for enemy (force-switch always auto-responds; moves only if enabled)
  if (req.forceSwitch) {
    const pokemon = req.side?.pokemon || [];
    for (let i = 0; i < pokemon.length; i++) {
      if (!pokemon[i].active && !pokemon[i].condition.includes('fnt')) {
        const species = pokemon[i].ident.split(': ')[1];
        const partyIdx = this.translator._findPartyIndex(species, 'p2');
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
};

// =============================================================================
// Battle end handling
// =============================================================================

ShowdownBridge.prototype._onBattleEnd = function(result) {
  console.log(`[ShowdownBridge] Battle ended:`, result);
  this._battleResult = result;
  const playerWon = result.type === 'win' && result.winner === this.playerConn.username;
  if (result.type === 'win') {
    this.rom.write8(ADDR.SD_BattleEnd, playerWon ? 1 : 2);
  } else {
    this.rom.write8(ADDR.SD_BattleEnd, 3); // tie
  }
  this.liveMode = false;

  // Resolve any pending turn/faint waiters so _pollLive exits cleanly.
  if (this._turnResolve) {
    this._turnResolve(this._turnMessages);
  }
  if (this._faintResolve) {
    this._faintResolve(this._faintMessages);
  }

  // For player wins: the ROM may be stuck at Phase 0/1 (opponent forfeited).
  // _handleForfeitTransition polls until Phase 1, then writes LINKBATTLE_RUN
  // so the ROM handles it via EnemyRan → EndOfBattle.
  // For normal wins (last enemy fainted), the ROM is already in EndOfBattle
  // and LinkState will reach 0 naturally.
  if (playerWon) {
    this._handleForfeitTransition(result);
  } else {
    this._waitForBattleRestart(result);
  }
};

/**
 * Handle opponent forfeit: poll until Phase 1, write LINKBATTLE_RUN (0x0F)
 * to SerialReceiveData, advance to Phase 2. The ROM sees 0x0F in
 * MainInBattleLoop and jumps to EnemyRan → EndOfBattle.
 *
 * For normal wins (last enemy fainted), the ROM is already in EndOfBattle
 * and LinkState reaches 0 without Phase 1 ever occurring.
 */
ShowdownBridge.prototype._handleForfeitTransition = async function(result) {
  const POLL_MS = 50;
  const TIMEOUT = 60000; // player may take a while to select in Phase 0
  const start = Date.now();
  while (Date.now() - start < TIMEOUT) {
    const phase = this.rom.read8(ADDR.SD_Phase);
    if (phase === 1) {
      console.log('[ShowdownBridge] Writing LINKBATTLE_RUN for opponent forfeit');
      this.rom.write8(ADDR.SerialReceiveData, 0x0F); // LINKBATTLE_RUN
      this.rom.write8(ADDR.SD_Phase, 2);
      this._waitForBattleRestart(result);
      return;
    }
    // ROM already exited battle (normal win — last enemy fainted)
    const linkState = this.rom.read8(ADDR.LinkState);
    if (linkState === 0) {
      console.log('[ShowdownBridge] ROM already finished battle (normal win)');
      if (this.onBattleEnd) this.onBattleEnd(result);
      return;
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  console.warn('[ShowdownBridge] Forfeit transition timed out');
  if (this.onBattleEnd) this.onBattleEnd(result);
};

ShowdownBridge.prototype._waitForBattleRestart = async function(result) {
  const POLL_MS = 16;   // ~1 frame
  const TIMEOUT = 30000;
  const start = Date.now();
  while (Date.now() - start < TIMEOUT) {
    const linkState = this.rom.read8(ADDR.LinkState);
    if (linkState === 0) {
      console.log('[ShowdownBridge] ROM finished end-of-battle sequence');
      if (this.onBattleEnd) this.onBattleEnd(result);
      return;
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  // Timed out — return anyway
  console.warn('[ShowdownBridge] Timed out waiting for ROM battle restart');
  if (this.onBattleEnd) this.onBattleEnd(result);
};
