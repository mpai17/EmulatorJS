/**
 * ShowdownBridge — Status sync, HP sync, and desync detection.
 *
 * Extends ShowdownBridge.prototype with methods that synchronize
 * the translator's authoritative state to WRAM and detect divergence.
 * Loaded after showdown-bridge.js defines the class.
 *
 * Depends on: ADDR (showdown-config.js), MOVE_MAP (showdown-translator.js),
 *             PARTY_WRAM (showdown-party.js)
 */

// =============================================================================
// Pre-turn status sync
// =============================================================================

ShowdownBridge.prototype._syncPreTurnStatus = function(overrides) {
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

    // Determine if this side is switching this turn
    const isSwitching = overrides.switchIn?.[side] != null;

    // Only adjust WRAM status for sleep/freeze counter management or switches.
    // Do NOT unconditionally overwrite — the ROM already has the correct
    // non-volatile status from _syncPostTurnStatus of the previous turn.
    // Overwriting here would prematurely set statuses that are applied by
    // moves THIS turn (e.g. writing SLP before Hypnosis executes → "already asleep").
    //
    // Exception: on a switch, the active battle mon slot still holds the OUTGOING
    // mon's status. We must write the incoming mon's status so the ROM's move
    // execution sees the correct value (e.g. Thunder Wave checks target status).
    let statusByte = this.rom.read8(activeAddr);
    const STATUS_MAP_PRE = { par: 0x40, brn: 0x10, frz: 0x20, psn: 0x08, tox: 0x08 };

    if (isSwitching) {
      const incomingStatus = this.translator.status[side][activeIdx] || '';
      if (incomingStatus === 'slp') {
        statusByte = 0x03;
      } else {
        statusByte = STATUS_MAP_PRE[incomingStatus] || 0x00;
      }
      this.rom.write8(activeAddr, statusByte);
      this.rom.write8(partyStatusBase + activeIdx * PARTYMON_STRIDE, statusByte);
    } else if (cantEntry?.reason === 'slp') {
      // Mon is asleep and can't move — ensure sleep counter is > 0
      statusByte = (statusByte & ~0x07) | 0x02;
      this.rom.write8(activeAddr, statusByte);
      this.rom.write8(partyStatusBase + activeIdx * PARTYMON_STRIDE, statusByte);
    } else if (cureSleep) {
      // Mon wakes up this turn — set counter to 1 so ROM decrements to 0
      statusByte = (statusByte & ~0x07) | 0x01;
      this.rom.write8(activeAddr, statusByte);
      this.rom.write8(partyStatusBase + activeIdx * PARTYMON_STRIDE, statusByte);
    } else if (cantEntry?.reason === 'frz') {
      // Mon is frozen and can't move — ensure freeze bit is set
      statusByte |= 0x20;
      this.rom.write8(activeAddr, statusByte);
      this.rom.write8(partyStatusBase + activeIdx * PARTYMON_STRIDE, statusByte);
    } else if (cureFreeze) {
      // Mon thaws this turn — clear freeze bit
      statusByte &= ~0x20;
      this.rom.write8(activeAddr, statusByte);
      this.rom.write8(partyStatusBase + activeIdx * PARTYMON_STRIDE, statusByte);
    }

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
};

// =============================================================================
// Post-turn status sync
// =============================================================================

ShowdownBridge.prototype._syncPostTurnStatus = function() {
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
};

// =============================================================================
// HP sync
// =============================================================================

ShowdownBridge.prototype._syncHP = function() {
  if (!this.translator) return;
  const sync = this.translator.getHPSync();
  const PARTYMON_STRIDE = 0x2C;

  this.rom.write16be(ADDR.BattleMonHP, sync.playerActiveHP);
  this.rom.write16be(ADDR.EnemyMonHP, sync.enemyActiveHP);

  for (let i = 0; i < 6; i++) {
    this.rom.write16be(ADDR.PartyMon1HP + i * PARTYMON_STRIDE, sync.playerPartyHP[i]);
    // Skip unrevealed enemy slots (null) to preserve ROM template/placeholder HP
    if (sync.enemyPartyHP[i] !== null) {
      this.rom.write16be(ADDR.EnemyMon1HP + i * PARTYMON_STRIDE, sync.enemyPartyHP[i]);
    }
  }
};

// =============================================================================
// Desync management
// =============================================================================

ShowdownBridge.prototype._triggerDesync = function(reason) {
  if (this._desyncTriggered) return;
  this._desyncTriggered = true;
  console.error(`[ShowdownBridge] DESYNC: ${reason}`);

  this.liveMode = false;
  if (this.playerConn) this.playerConn.disconnect();
  if (this.enemyConn) this.enemyConn.disconnect();
  this.connected = false;
  this.rom.write8(ADDR.ShowdownConnected, 0);

  if (this.onDesync) this.onDesync(reason);
};

/**
 * Verify player team stats in WRAM match Showdown's calculated stats.
 * Called once at battle start after writePartyToWRAM.
 */
ShowdownBridge.prototype._verifyTeamSync = function() {
  if (!this._playerRequest?.side?.pokemon) {
    console.warn('[ShowdownBridge] No player request to verify team sync');
    return;
  }

  const pokemon = this._playerRequest.side.pokemon;
  const mismatches = [];

  for (let i = 0; i < pokemon.length; i++) {
    const mon = pokemon[i];
    const species = mon.ident.split(': ')[1];
    const stats = mon.stats || {};
    const condition = mon.condition || '1/1';
    const hpParts = condition.split(' ')[0].split('/');
    const sdHP = parseInt(hpParts[1]) || 0; // max HP from Showdown

    // Read from WRAM party struct
    const base = PARTY_WRAM.player.mons + i * 0x2C;
    const wramMaxHP = this.rom.read16be(base + 0x22);
    const wramAtk   = this.rom.read16be(base + 0x24);
    const wramDef   = this.rom.read16be(base + 0x26);
    const wramSpe   = this.rom.read16be(base + 0x28);
    const wramSpc   = this.rom.read16be(base + 0x2A);

    const diffs = [];
    if (wramMaxHP !== sdHP)           diffs.push(`HP: WRAM=${wramMaxHP} SD=${sdHP}`);
    if (wramAtk !== (stats.atk || 0)) diffs.push(`ATK: WRAM=${wramAtk} SD=${stats.atk}`);
    if (wramDef !== (stats.def || 0)) diffs.push(`DEF: WRAM=${wramDef} SD=${stats.def}`);
    if (wramSpe !== (stats.spe || 0)) diffs.push(`SPE: WRAM=${wramSpe} SD=${stats.spe}`);
    if (wramSpc !== (stats.spa || 0)) diffs.push(`SPC: WRAM=${wramSpc} SD=${stats.spa}`);

    if (diffs.length > 0) {
      mismatches.push(`${species}[${i}]: ${diffs.join(', ')}`);
    } else {
      console.log(`[TeamSync] ${species}[${i}]: OK (HP=${sdHP} ATK=${stats.atk} DEF=${stats.def} SPE=${stats.spe} SPC=${stats.spa})`);
    }
  }

  if (mismatches.length > 0) {
    console.error('[TeamSync] STAT MISMATCHES DETECTED:');
    for (const m of mismatches) console.error(`  ${m}`);
  } else {
    console.log('[TeamSync] All player team stats match Showdown');
  }
};

/**
 * Check for state mismatch between emulator and Showdown server.
 * Called after each turn completes (post-sync). Triggers desync on divergence.
 */
ShowdownBridge.prototype._checkDesync = function() {
  if (!this.translator || !this.connected || this._desyncTriggered) return;

  const errors = [];

  // P1 party HP — player request always has exact HP
  if (this._playerRequest?.side?.pokemon) {
    for (const mon of this._playerRequest.side.pokemon) {
      const species = mon.ident.split(': ')[1];
      const partyIdx = this.translator._findPartyIndex(species, 'p1');
      const [reqHP] = this._parseConditionHP(mon.condition);
      const transHP = this.translator.hp.p1[partyIdx] ?? 0;
      if (transHP !== reqHP) {
        errors.push(`P1 ${species}: emu=${transHP} server=${reqHP}`);
      }
    }
  }

  // P2 party HP — only checkable in test mode (enemy connection has exact HP)
  if (this.enemyConn && this._enemyRequest?.side?.pokemon) {
    for (const mon of this._enemyRequest.side.pokemon) {
      const species = mon.ident.split(': ')[1];
      const partyIdx = this.translator._findPartyIndex(species, 'p2');
      const [reqHP] = this._parseConditionHP(mon.condition);
      const transHP = this.translator.hp.p2[partyIdx] ?? 0;
      if (transHP !== reqHP) {
        errors.push(`P2 ${species}: emu=${transHP} server=${reqHP}`);
      }
    }
  }

  // Active mon WRAM HP vs translator (verifies _syncHP worked)
  const wramP1HP = this.rom.read16be(ADDR.BattleMonHP);
  const wramP2HP = this.rom.read16be(ADDR.EnemyMonHP);
  const transP1HP = this.translator.hp.p1[this.translator.active.p1] ?? 0;
  const transP2HP = this.translator.hp.p2[this.translator.active.p2] ?? 0;
  if (wramP1HP !== transP1HP) {
    errors.push(`P1 active: WRAM=${wramP1HP} translator=${transP1HP}`);
  }
  if (wramP2HP !== transP2HP) {
    errors.push(`P2 active: WRAM=${wramP2HP} translator=${transP2HP}`);
  }

  // Faint tracking — server says fainted but translator says alive
  if (this._playerRequest?.side?.pokemon) {
    for (const mon of this._playerRequest.side.pokemon) {
      const species = mon.ident.split(': ')[1];
      const partyIdx = this.translator._findPartyIndex(species, 'p1');
      const serverFainted = mon.condition.includes('fnt');
      const transAlive = this.translator.alive.p1[partyIdx];
      if (serverFainted && transAlive) {
        errors.push(`P1 ${species}: server=fainted emu=alive`);
      }
    }
  }

  if (errors.length > 0) {
    this._triggerDesync(errors.join('\n'));
  }
};
