/**
 * ShowdownBridge — Formatting utilities and debug logging.
 *
 * Extends ShowdownBridge.prototype with HP/status parsing and
 * battle state logging for debug output.
 * Loaded after showdown-bridge.js defines the class.
 *
 * Depends on: ADDR (showdown-config.js)
 */

// =============================================================================
// HP / Status parsing
// =============================================================================

ShowdownBridge.prototype._parseConditionHP = function(condition) {
  if (!condition) return [0, 0];
  if (condition.includes('fnt')) return [0, 0];
  const match = condition.match(/(\d+)\/(\d+)/);
  if (!match) return [0, 0];
  return [parseInt(match[1]), parseInt(match[2])];
};

/** Convert Showdown status string ('par','brn','psn','tox','frz','slp') to GB status byte. */
ShowdownBridge.prototype._sdStatusToByte = function(sdStatus) {
  if (sdStatus === 'par') return 0x40;
  if (sdStatus === 'brn') return 0x10;
  if (sdStatus === 'psn' || sdStatus === 'tox') return 0x08;
  if (sdStatus === 'frz') return 0x20;
  if (sdStatus === 'slp') return 0x02;
  return 0;
};

// =============================================================================
// Battle state logging
// =============================================================================

ShowdownBridge.prototype._logBattleState = function() {
  const PARTYMON_STRUCT = 0x2C;
  const STAT_NAMES = ['atk', 'def', 'spd', 'spc', 'acc', 'eva'];
  const STATUS_NAMES = { 0: 'none', 0x40: 'par', 0x10: 'brn', 0x20: 'frz', 0x08: 'psn' };

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
};
