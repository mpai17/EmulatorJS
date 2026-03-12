/**
 * ShowdownBridge — WRAM write operations and phase polling.
 *
 * Extends ShowdownBridge.prototype with WRAM helpers for writing
 * turn override data and waiting on ROM phase transitions.
 * Loaded after showdown-bridge.js defines the class.
 *
 * Depends on: ADDR (showdown-config.js), MOVE_MAP (showdown-translator.js)
 */

// =============================================================================
// Phase waiting helpers
// =============================================================================

ShowdownBridge.prototype._waitForPhase = async function(phase, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (this.rom.read8(ADDR.SD_Phase) === phase) return true;
    await this._delay(16);
  }
  console.error(`[Test] Timeout waiting for phase ${phase}`);
  return false;
};

ShowdownBridge.prototype._waitForPhaseNot = async function(phase, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (this.rom.read8(ADDR.SD_Phase) !== phase) return true;
    await this._delay(16);
  }
  console.error(`[Test] Timeout waiting for phase != ${phase}`);
  return false;
};

// =============================================================================
// WRAM write helpers
// =============================================================================

ShowdownBridge.prototype._applyWrites = function(writes) {
  if (!writes) return;
  for (const w of writes) {
    const addr = typeof w.addr === 'string' ? ADDR[w.addr] : w.addr;
    if (w.value16 !== undefined) {
      this.rom.write16be(addr, w.value16);
    } else {
      this.rom.write8(addr, w.value);
    }
  }
};

ShowdownBridge.prototype._writeTurnOverrides = function(turn) {
  // Enemy action
  this.rom.write8(ADDR.SerialReceiveData, turn.enemyAction ?? 0);
  if (turn.enemyMove !== undefined) this.rom.write8(ADDR.EnemySelectedMove, turn.enemyMove);
  else this.rom.write8(ADDR.EnemySelectedMove, 0x5E); // default Psychic
  if (turn.enemyMoveSlot !== undefined) this.rom.write8(ADDR.EnemyMoveListIndex, turn.enemyMoveSlot);
  else this.rom.write8(ADDR.EnemyMoveListIndex, 0);

  // Write the move ID into wEnemyMonMoves[slot] — the ROM reads from the move list
  // (core.asm:3111-3114) and OVERWRITES wEnemySelectedMove, so our direct write above
  // is not enough. The move list must have the correct ID at the chosen slot.
  if (turn.enemyMove !== undefined) {
    const slot = turn.enemyMoveSlot ?? 0;
    this.rom.write8(ADDR.EnemyMonMoves + slot, turn.enemyMove);
  }

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
};
