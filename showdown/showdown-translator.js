/**
 * TurnTranslator — Stateful parser that converts Showdown protocol messages
 * into WRAM override objects for the ROM bridge.
 *
 * Pure logic, no side effects. One instance per battle.
 */

// Move name (Showdown display name) → ROM move ID (from constants/move_constants.asm)
const MOVE_MAP = {
  'Pound':          0x01,
  'Karate Chop':    0x02,
  'Double Slap':    0x03,
  'Comet Punch':    0x04,
  'Mega Punch':     0x05,
  'Pay Day':        0x06,
  'Fire Punch':     0x07,
  'Ice Punch':      0x08,
  'Thunder Punch':  0x09,
  'Scratch':        0x0A,
  'Vise Grip':      0x0B,
  'Guillotine':     0x0C,
  'Razor Wind':     0x0D,
  'Swords Dance':   0x0E,
  'Cut':            0x0F,
  'Gust':           0x10,
  'Wing Attack':    0x11,
  'Whirlwind':      0x12,
  'Fly':            0x13,
  'Bind':           0x14,
  'Slam':           0x15,
  'Vine Whip':      0x16,
  'Stomp':          0x17,
  'Double Kick':    0x18,
  'Mega Kick':      0x19,
  'Jump Kick':      0x1A,
  'Rolling Kick':   0x1B,
  'Sand Attack':    0x1C,
  'Headbutt':       0x1D,
  'Horn Attack':    0x1E,
  'Fury Attack':    0x1F,
  'Horn Drill':     0x20,
  'Tackle':         0x21,
  'Body Slam':      0x22,
  'Wrap':           0x23,
  'Take Down':      0x24,
  'Thrash':         0x25,
  'Double-Edge':    0x26,
  'Tail Whip':      0x27,
  'Poison Sting':   0x28,
  'Twineedle':      0x29,
  'Pin Missile':    0x2A,
  'Leer':           0x2B,
  'Bite':           0x2C,
  'Growl':          0x2D,
  'Roar':           0x2E,
  'Sing':           0x2F,
  'Supersonic':     0x30,
  'Sonic Boom':     0x31,
  'Disable':        0x32,
  'Acid':           0x33,
  'Ember':          0x34,
  'Flamethrower':   0x35,
  'Mist':           0x36,
  'Water Gun':      0x37,
  'Hydro Pump':     0x38,
  'Surf':           0x39,
  'Ice Beam':       0x3A,
  'Blizzard':       0x3B,
  'Psybeam':        0x3C,
  'Bubble Beam':    0x3D,
  'Aurora Beam':    0x3E,
  'Hyper Beam':     0x3F,
  'Peck':           0x40,
  'Drill Peck':     0x41,
  'Submission':     0x42,
  'Low Kick':       0x43,
  'Counter':        0x44,
  'Seismic Toss':   0x45,
  'Strength':       0x46,
  'Absorb':         0x47,
  'Mega Drain':     0x48,
  'Leech Seed':     0x49,
  'Growth':         0x4A,
  'Razor Leaf':     0x4B,
  'Solar Beam':     0x4C,
  'Poison Powder':  0x4D,
  'Stun Spore':     0x4E,
  'Sleep Powder':   0x4F,
  'Petal Dance':    0x50,
  'String Shot':    0x51,
  'Dragon Rage':    0x52,
  'Fire Spin':      0x53,
  'Thunder Shock':  0x54,
  'Thunderbolt':    0x55,
  'Thunder Wave':   0x56,
  'Thunder':        0x57,
  'Rock Throw':     0x58,
  'Earthquake':     0x59,
  'Fissure':        0x5A,
  'Dig':            0x5B,
  'Toxic':          0x5C,
  'Confusion':      0x5D,
  'Psychic':        0x5E,
  'Hypnosis':       0x5F,
  'Meditate':       0x60,
  'Agility':        0x61,
  'Quick Attack':   0x62,
  'Rage':           0x63,
  'Teleport':       0x64,
  'Night Shade':    0x65,
  'Mimic':          0x66,
  'Screech':        0x67,
  'Double Team':    0x68,
  'Recover':        0x69,
  'Harden':         0x6A,
  'Minimize':       0x6B,
  'Smokescreen':    0x6C,
  'Confuse Ray':    0x6D,
  'Withdraw':       0x6E,
  'Defense Curl':   0x6F,
  'Barrier':        0x70,
  'Light Screen':   0x71,
  'Haze':           0x72,
  'Reflect':        0x73,
  'Focus Energy':   0x74,
  'Bide':           0x75,
  'Metronome':      0x76,
  'Mirror Move':    0x77,
  'Self-Destruct':  0x78,
  'Egg Bomb':       0x79,
  'Lick':           0x7A,
  'Smog':           0x7B,
  'Sludge':         0x7C,
  'Bone Club':      0x7D,
  'Fire Blast':     0x7E,
  'Waterfall':      0x7F,
  'Clamp':          0x80,
  'Swift':          0x81,
  'Skull Bash':     0x82,
  'Spike Cannon':   0x83,
  'Constrict':      0x84,
  'Amnesia':        0x85,
  'Kinesis':        0x86,
  'Soft-Boiled':    0x87,
  'Hi Jump Kick':   0x88,
  'Glare':          0x89,
  'Dream Eater':    0x8A,
  'Poison Gas':     0x8B,
  'Barrage':        0x8C,
  'Leech Life':     0x8D,
  'Lovely Kiss':    0x8E,
  'Sky Attack':     0x8F,
  'Transform':      0x90,
  'Bubble':         0x91,
  'Dizzy Punch':    0x92,
  'Spore':          0x93,
  'Flash':          0x94,
  'Psywave':        0x95,
  'Splash':         0x96,
  'Acid Armor':     0x97,
  'Crabhammer':     0x98,
  'Explosion':      0x99,
  'Fury Swipes':    0x9A,
  'Bonemerang':     0x9B,
  'Rest':           0x9C,
  'Rock Slide':     0x9D,
  'Hyper Fang':     0x9E,
  'Sharpen':        0x9F,
  'Conversion':     0xA0,
  'Tri Attack':     0xA1,
  'Super Fang':     0xA2,
  'Slash':          0xA3,
  'Substitute':     0xA4,
  'Struggle':       0xA5,
};

// Party definition — set dynamically from user's team via setParty()
// Default matches the sample comp team for backward compatibility
window.PARTY = [
  { name: 'Alakazam',  moves: ['Psychic', 'Thunder Wave', 'Recover', 'Seismic Toss'] },
  { name: 'Starmie',   moves: ['Surf', 'Psychic', 'Thunderbolt', 'Recover'] },
  { name: 'Snorlax',   moves: ['Body Slam', 'Earthquake', 'Ice Beam', 'Rest'] },
  { name: 'Tauros',    moves: ['Body Slam', 'Earthquake', 'Blizzard', 'Hyper Beam'] },
  { name: 'Chansey',   moves: ['Ice Beam', 'Thunderbolt', 'Thunder Wave', 'Soft-Boiled'] },
  { name: 'Exeggutor', moves: ['Psychic', 'Explosion', 'Mega Drain', 'Rest'] },
];

function setParty(packedTeamStr) {
  const parsed = parsePackedTeam(packedTeamStr);
  if (parsed.length > 0) window.PARTY = parsed;
}

class TurnTranslator {
  constructor() {
    // HP tracking for all 12 pokemon (6 per side)
    // p1 = player, p2 = enemy
    this.hp = { p1: [], p2: [] };
    this.maxHp = { p1: [], p2: [] };
    this.status = { p1: [], p2: [] };
    this.alive = { p1: [], p2: [] };

    // Active pokemon index (0-5) for each side
    this.active = { p1: 0, p2: 0 };

    // Previous HP for damage calculation
    this.prevHp = { p1: 0, p2: 0 };

    // Volatile state tracking (persists across turns, cleared on switch/faint)
    this.confused = { p1: false, p2: false };
    this.recharging = { p1: false, p2: false };
    this.trapped = { p1: false, p2: false };
    this.biding = { p1: false, p2: false };
    this.thrashing = { p1: false, p2: false };
    this.charging = { p1: false, p2: false };
    this.invulnerable = { p1: false, p2: false };
    this.raging = { p1: false, p2: false };
    this.disabled = { p1: null, p2: null };
    this.substitute = { p1: false, p2: false };
    this.seeded = { p1: false, p2: false };
    // Turn-start snapshots — pre-turn sync uses these so the ROM sees correct
    // state BEFORE executing the turn
    this._atTurnStart = {
      substitute: { p1: false, p2: false },
      seeded: { p1: false, p2: false },
      disabled: { p1: null, p2: null },
      confused: { p1: false, p2: false },
      status: { p1: '', p2: '' },
    };

    // Enemy party tracking — built up as enemy Pokemon are seen via |switch|
    // In test mode this mirrors window.PARTY; in play mode it's built dynamically
    this.enemyParty = [];

    this._initialized = false;
  }

  /**
   * Initialize HP state from the first |request| object.
   * Call this once when battle starts.
   */
  initFromRequest(request, side) {
    if (!request.side) return;

    const pokemon = request.side.pokemon;
    for (let i = 0; i < pokemon.length; i++) {
      const mon = pokemon[i];
      const [cur, max] = this._parseHP(mon.condition);
      this.hp[side][i] = cur;
      this.maxHp[side][i] = max;
      this.status[side][i] = this._parseStatus(mon.condition);
      this.alive[side][i] = cur > 0;
    }
    this._initialized = true;
  }

  /**
   * Update HP tracking from |request| each turn.
   * Maps by species name, not array index — Showdown reorders the array after switches.
   */
  updateFromRequest(request, side) {
    if (!request.side) return;
    const pokemon = request.side.pokemon;
    for (let i = 0; i < pokemon.length; i++) {
      const mon = pokemon[i];
      const species = mon.ident.split(': ')[1];
      const partyIdx = this._findPartyIndex(species, side);
      const [cur, max] = this._parseHP(mon.condition);
      this.hp[side][partyIdx] = cur;
      this.maxHp[side][partyIdx] = max;
      this.status[side][partyIdx] = this._parseStatus(mon.condition);
      this.alive[side][partyIdx] = cur > 0;
    }
  }

  /**
   * Process a batch of battle messages for one turn.
   * Returns a WRAMOverrides object ready for the bridge to write.
   *
   * @param {Array} messages - Array of {cmd, parts, raw} from ShowdownConnection
   * @returns {object} WRAMOverrides
   */
  processTurnLog(messages, preTurnHP) {
    // Use caller-provided pre-turn HP if available (avoids race with incoming |request| updates)
    const preHp = preTurnHP || {
      p1: this.hp.p1[this.active.p1],
      p2: this.hp.p2[this.active.p2],
    };

    // Snapshot state at turn start — pre-turn sync uses these so the ROM sees
    // correct state BEFORE executing the turn (e.g. freeze from Blizzard should
    // only appear AFTER the move animation, not before).
    this._atTurnStart = {
      substitute: { p1: this.substitute.p1, p2: this.substitute.p2 },
      seeded: { p1: this.seeded.p1, p2: this.seeded.p2 },
      disabled: { p1: this.disabled.p1, p2: this.disabled.p2 },
      confused: { p1: this.confused.p1, p2: this.confused.p2 },
      status: {
        p1: this.status.p1[this.active.p1] || '',
        p2: this.status.p2[this.active.p2] || '',
      },
    };

    // Set internal HP to pre-turn values (may have been corrupted by incoming requests)
    this.hp.p1[this.active.p1] = preHp.p1;
    this.hp.p2[this.active.p2] = preHp.p2;

    // Collect events AND track per-move damage
    const events = {
      moves: [],       // {side, moveName, target}
      damage: [],      // {side, hpText}
      crit: [],        // {side}
      miss: [],        // {side}
      supereffective: [],  // {side} (side = attacker)
      resisted: [],    // {side}
      immune: [],      // {side}
      cant: [],        // {side, reason}
      activate: [],    // {side, effect}
      faint: [],       // {side}
      switchIn: [],    // {side, speciesName, hpText}
      heal: [],        // {side, hpText}
      status: [],      // {side, statusId}
      curestatus: [],  // {side, statusId}
      boost: [],       // {side, stat, amount}
      unboost: [],     // {side, stat, amount}
      mustrecharge: [], // {side}
      subActivate: [],  // {side} — sub took a hit and survived
      subBroke: [],     // {side} — sub broke this turn
    };

    // Per-move damage tracking: damage dealt BY each side's move (not net HP change)
    const moveDamage = { p1: 0, p2: 0 };
    const moveHits = { p1: 0, p2: 0 };       // definitive hit count (from -hitcount, fallback to -damage count)
    const moveDmgEvents = { p1: 0, p2: 0 };  // raw count of -damage events (before -hitcount override)
    const moveFirstHit = { p1: 0, p2: 0 };   // first hit's damage (= per-hit for multi-hit)
    let lastMoveBy = null;

    // Substitute break tracking: count sub-absorb events per attacker to determine break hit
    const subHitsAbsorbed = { p1: 0, p2: 0 }; // -activate|Substitute events attributed to each attacker
    const subBreakHit = { p1: 0, p2: 0 };     // 0 = no break, N = sub breaks on attacker's hit N

    // Track whether each side's move triggered a secondary effect (stat change/status on opponent)
    const sideEffects = { p1: false, p2: false };

    // Track drain heals per side (Mega Drain, Absorb, Leech Life, Dream Eater)
    // Needed for HP correction to separate damage rounding error from drain rounding error
    const drainHeal = { p1: 0, p2: 0 };

    // Track the first action event (move or cant) to determine turn order
    let firstActionSide = null;

    for (const msg of messages) {
      const { cmd, parts } = msg;
      const side = this._parseSide(parts[1]);

      switch (cmd) {
        case 'move':
          events.moves.push({ side, moveName: parts[2], target: parts[3] });
          lastMoveBy = side;
          if (firstActionSide === null) firstActionSide = side;
          // Track multi-turn state from move names
          if (parts[2] === 'Rage') this.raging[side] = true;
          if (['Thrash', 'Petal Dance'].includes(parts[2])) this.thrashing[side] = true;
          // Charging move executed = no longer charging/invulnerable
          this.charging[side] = false;
          this.invulnerable[side] = false;
          break;
        case '-damage': {
          events.damage.push({ side, hpText: parts[2] });
          const hpBefore = this.hp[side][this.active[side]];
          this._updateHPFromText(side, parts[2]);
          const hpAfter = this.hp[side][this.active[side]];
          const dmg = Math.max(0, hpBefore - hpAfter);
          // Only count as move damage if NOT from a residual source
          // (poison, burn, Leech Seed, Wrap continuing, recoil, etc.)
          const fromSource = parts[3] || '';
          const isResidual = fromSource.includes('[from]');
          if (lastMoveBy && lastMoveBy !== side && !isResidual) {
            moveDamage[lastMoveBy] += dmg;
            moveDmgEvents[lastMoveBy]++;
            moveHits[lastMoveBy]++;  // fallback; overridden by -hitcount if present
            if (moveDmgEvents[lastMoveBy] === 1) {
              moveFirstHit[lastMoveBy] = dmg;
            }
          }
          break;
        }
        case '-heal': {
          const healBefore = this.hp[side]?.[this.active[side]] || 0;
          events.heal.push({ side, hpText: parts[2] });
          this._updateHPFromText(side, parts[2]);
          const healAfter = this.hp[side]?.[this.active[side]] || 0;
          // Track drain heals separately for HP correction
          if (parts[3]?.includes('[from] drain') && side) {
            drainHeal[side] = Math.max(0, healAfter - healBefore);
          }
          // Heals don't count as move damage
          break;
        }
        case '-crit':
          events.crit.push({ side: this._parseSide(parts[1]), by: lastMoveBy });
          break;
        case '-miss':
          // -miss|ATTACKER|TARGET — the miss is on the attacker's move
          events.miss.push({ side, by: lastMoveBy });
          break;
        case '-fail':
          // -fail|TARGET|REASON — move effect failed (Sleep Clause, etc.)
          // Treat as a miss for the attacker so the ROM shows "didn't affect"
          if (lastMoveBy) {
            events.miss.push({ by: lastMoveBy });
          }
          break;
        case '-supereffective':
          events.supereffective.push({ side: this._parseSide(parts[1]), by: lastMoveBy });
          break;
        case '-resisted':
          events.resisted.push({ side: this._parseSide(parts[1]), by: lastMoveBy });
          break;
        case '-immune':
          events.immune.push({ side: this._parseSide(parts[1]), by: lastMoveBy });
          break;
        case 'cant':
          events.cant.push({ side, reason: parts[2] });
          if (firstActionSide === null) firstActionSide = side;
          // Flinch: the OTHER side's move caused this flinch
          if (parts[2] === 'flinch') {
            const otherSide = side === 'p1' ? 'p2' : 'p1';
            sideEffects[otherSide] = true;
          }
          // Recharge: this turn consumed the recharge, clear state
          if (parts[2] === 'recharge') this.recharging[side] = false;
          break;
        case '-mustrecharge':
          events.mustrecharge.push({ side });
          break;
        case '-start': {
          const what = parts[2] || '';
          if (what === 'confusion') {
            this.confused[side] = true;
          } else if (what === 'Substitute') {
            this.substitute[side] = true;
          } else if (what.startsWith('move:') || what.startsWith('move: ')) {
            const moveName = what.replace(/^move:\s*/, '');
            if (moveName.toLowerCase() === 'bide') this.biding[side] = true;
            if (['wrap', 'bind', 'fire spin', 'clamp'].includes(moveName.toLowerCase())) this.trapped[side] = true;
            if (moveName.toLowerCase() === 'leech seed') this.seeded[side] = true;
          } else if (what === 'Disable') {
            this.disabled[side] = parts[3] || true;
          }
          break;
        }
        case '-end': {
          const what2 = parts[2] || '';
          if (what2 === 'confusion') {
            this.confused[side] = false;
          } else if (what2 === 'Substitute') {
            this.substitute[side] = false;
            events.subBroke.push({ side });
            // Compute which hit breaks the sub (absorbed hits + 1)
            if (lastMoveBy && lastMoveBy !== side) {
              subBreakHit[lastMoveBy] = subHitsAbsorbed[lastMoveBy] + 1;
            }
          } else if (what2.startsWith('move:') || what2.startsWith('move: ')) {
            const moveName = what2.replace(/^move:\s*/, '');
            if (moveName.toLowerCase() === 'bide') this.biding[side] = false;
            if (['wrap', 'bind', 'fire spin', 'clamp'].includes(moveName.toLowerCase())) this.trapped[side] = false;
            if (moveName.toLowerCase() === 'leech seed') this.seeded[side] = false;
          } else if (what2 === 'Disable') {
            this.disabled[side] = null;
          }
          // Rage ends when the mon uses a different move or faints
          if (what2 === 'Rage') this.raging[side] = false;
          // Thrash/Petal Dance ends
          if (['Thrash', 'Petal Dance'].includes(what2)) this.thrashing[side] = false;
          break;
        }
        case '-prepare':
          // Fly, Dig, Solar Beam, etc — charging turn
          this.charging[side] = true;
          // Only Fly and Dig grant invulnerability during the charge turn
          if (parts[2] && ['Fly', 'Dig'].includes(parts[2])) {
            this.invulnerable[side] = true;
          }
          break;
        case '-activate':
          events.activate.push({ side, effect: parts[2] });
          if ((parts[2] || '').includes('Substitute')) {
            events.subActivate.push({ side });
            // Count sub-absorb events per attacker (side = target, lastMoveBy = attacker)
            if (lastMoveBy && lastMoveBy !== side) {
              subHitsAbsorbed[lastMoveBy]++;
            }
          }
          break;
        case '-hitcount': {
          // Definitive hit count from server (includes sub hits that -damage misses)
          // Format: |-hitcount|POKEMON|N — POKEMON is the TARGET, not attacker
          const hitCount = parseInt(parts[2]) || 0;
          if (lastMoveBy) moveHits[lastMoveBy] = hitCount;
          break;
        }
        case 'faint':
          events.faint.push({ side });
          this._setFainted(side);
          break;
        case 'switch':
        case 'drag':
          events.switchIn.push({
            side,
            speciesName: this._parseSpecies(parts[1]),
            hpText: parts[3],
          });
          this._handleSwitch(side, parts[1], parts[3]);
          // Update turn-start snapshot to reflect the incoming mon's state at
          // switch-in, before any subsequent moves this turn modify it.
          // _handleSwitch clears all volatiles and updates active index.
          this._atTurnStart.status[side] = this.status[side][this.active[side]] || '';
          this._atTurnStart.confused[side] = false;
          this._atTurnStart.substitute[side] = false;
          this._atTurnStart.seeded[side] = false;
          this._atTurnStart.disabled[side] = null;
          // Switches happen before moves — count as first action for turn order
          if (firstActionSide === null) firstActionSide = side;
          break;
        case '-status':
          events.status.push({ side, statusId: parts[2] });
          // Update translator status so _syncPostTurnStatus has the correct value
          this.status[side][this.active[side]] = parts[2];
          // Status applied to opponent of last attacker = secondary effect (Body Slam→par, Ice Beam→frz)
          if (lastMoveBy && side !== lastMoveBy) {
            sideEffects[lastMoveBy] = true;
          }
          break;
        case '-curestatus':
          events.curestatus.push({ side, statusId: parts[2] });
          // Clear the status in translator
          this.status[side][this.active[side]] = '';
          // In Gen 1, waking from sleep or thawing from freeze costs the turn.
          // If this happens before any move/cant, it's a start-of-turn cure — treat as cant.
          if (firstActionSide === null && (parts[2] === 'slp' || parts[2] === 'frz')) {
            events.cant.push({ side, reason: parts[2] });
            firstActionSide = side;
          }
          break;
        case '-boost':
          events.boost.push({ side, stat: parts[2], amount: parseInt(parts[3]) || 1 });
          // Stat boost on opponent of last attacker = secondary effect
          if (lastMoveBy && side !== lastMoveBy) {
            sideEffects[lastMoveBy] = true;
          }
          break;
        case '-unboost':
          events.unboost.push({ side, stat: parts[2], amount: parseInt(parts[3]) || 1 });
          // Stat drop on opponent of last attacker = secondary effect (Psychic→spc down)
          if (lastMoveBy && side !== lastMoveBy) {
            sideEffects[lastMoveBy] = true;
          }
          break;
        case '-message': {
          // Clause activations (Sleep Clause, Freeze Clause, etc.) — move fails
          const msgText = parts.slice(1).join('|');
          if (msgText.includes('Clause') && lastMoveBy) {
            events.miss.push({ by: lastMoveBy });
            console.log(`[TurnTranslator] Clause blocked ${lastMoveBy}'s move: ${msgText}`);
          }
          break;
        }
      }
    }

    // Track mustrecharge after event loop
    for (const mr of events.mustrecharge) {
      this.recharging[mr.side] = true;
    }

    // Determine who moved first from the first action event (move or cant)
    const whoFirst = firstActionSide === 'p2' ? 1 : 0;

    console.log(`[TurnTranslator] Per-move damage: p1 dealt ${moveDamage.p1}, p2 dealt ${moveDamage.p2}, whoFirst=${whoFirst}`);

    // M1 = first mover's damage, M2 = second mover's damage
    const firstMover = whoFirst === 0 ? 'p1' : 'p2';
    const secondMover = whoFirst === 0 ? 'p2' : 'p1';
    // For multi-hit moves, use per-hit damage (firstHit) instead of total
    const m1Damage = moveFirstHit[firstMover] || moveDamage[firstMover];
    const m2Damage = moveFirstHit[secondMover] || moveDamage[secondMover];
    const m1Hits = moveHits[firstMover];
    const m2Hits = moveHits[secondMover];

    const m1 = this._buildMoverData(m1Damage, firstMover, events, m1Hits, subBreakHit[firstMover]);
    const m2 = this._buildMoverData(m2Damage, secondMover, events, m2Hits, subBreakHit[secondMover]);

    // Flags
    let flags = 0;
    for (const c of events.cant) {
      if (c.side === 'p1') flags |= 0x01; // playerCantMove
      if (c.side === 'p2') flags |= 0x02; // enemyCantMove
    }
    for (const a of events.activate) {
      if (a.effect && a.effect.includes('confusion')) {
        if (a.side === 'p1') flags |= 0x04; // playerConfHitSelf
        if (a.side === 'p2') flags |= 0x08; // enemyConfHitSelf
      }
    }
    // Side effect flags: bit4 = M1's move had a secondary effect, bit5 = M2's
    // These gate ALL move effects in ROM (flinch, paralysis chance, HyperBeamEffect, etc.)
    // In Showdown mode, ROM's effect handlers FORCE the outcome (no RNG) — so we only
    // set the flag when Showdown confirmed the effect actually happened.
    // Special case: -mustrecharge means HyperBeamEffect must execute (it's the only
    // non-secondary effect gated here; Charge/Fly/Thrash/etc are in SpecialEffects).
    if (sideEffects[firstMover]) flags |= 0x10;
    if (sideEffects[secondMover]) flags |= 0x20;
    // Hyper Beam: -mustrecharge indicates HyperBeamEffect must run to set NEEDS_TO_RECHARGE
    if (events.mustrecharge.some(e => e.side === firstMover)) flags |= 0x10;
    if (events.mustrecharge.some(e => e.side === secondMover)) flags |= 0x20;
    // Substitute broke flags: bit6 = player sub broke, bit7 = enemy sub broke
    if (events.subBroke.some(e => e.side === 'p1')) flags |= 0x40;
    if (events.subBroke.some(e => e.side === 'p2')) flags |= 0x80;
    console.log(`[TurnTranslator] Side effects: ${firstMover}=${sideEffects[firstMover]}, ${secondMover}=${sideEffects[secondMover]}, mustrecharge=${events.mustrecharge.map(e=>e.side)}, flags=0x${flags.toString(16)}`);

    // Enemy action
    const enemyAction = this._getEnemyAction(events);

    // Enemy move ROM ID and slot
    const enemyMoveInfo = this._getEnemyMoveInfo(events);

    // Faint info
    const hasFaint = events.faint.length > 0;
    const faintSide = hasFaint ? events.faint[0].side : null;

    // Collect stat changes for post-turn correction
    const statChanges = [];
    for (const b of events.boost) {
      statChanges.push({ side: b.side, stat: b.stat, delta: b.amount });
    }
    for (const u of events.unboost) {
      statChanges.push({ side: u.side, stat: u.stat, delta: -u.amount });
    }

    return {
      whoFirst,
      flags,
      enemyAction: enemyAction,
      enemyMove: enemyMoveInfo.moveId,
      enemyMoveSlot: enemyMoveInfo.slot,
      m1,
      m2,
      hasFaint,
      faintSide,
      statChanges,
      cantReasons: events.cant.map(c => ({ side: c.side, reason: c.reason })),
      statusChanges: [
        ...events.status.map(s => ({ side: s.side, statusId: s.statusId, type: 'set' })),
        ...events.curestatus.map(s => ({ side: s.side, statusId: s.statusId, type: 'cure' })),
      ],
      mustRecharge: {
        p1: events.mustrecharge.some(e => e.side === 'p1'),
        p2: events.mustrecharge.some(e => e.side === 'p2'),
      },
      subBroke: {
        p1: events.subBroke.some(e => e.side === 'p1'),
        p2: events.subBroke.some(e => e.side === 'p2'),
      },
      drainHeal,
      // Switch-in data for each side — HP at the time of the switch, before
      // any moves execute. The bridge uses this to write the correct pre-move HP
      // to the party struct (NOT the post-damage HP from the translator).
      switchIn: {
        p1: events.switchIn.find(s => s.side === 'p1') || null,
        p2: events.switchIn.find(s => s.side === 'p2') || null,
      },
    };
  }

  /**
   * Process a force-switch scenario (after a faint).
   * Returns the enemy action byte for the switch.
   */
  processForceSwitch(messages) {
    for (const msg of messages) {
      if (msg.cmd === 'switch' || msg.cmd === 'drag') {
        const side = this._parseSide(msg.parts[1]);
        if (side === 'p2') {
          const species = this._parseSpecies(msg.parts[1]);
          const partyIdx = this._findPartyIndex(species, side);
          this._handleSwitch(side, msg.parts[1], msg.parts[3]);
          return { enemyAction: 4 + partyIdx };
        }
      }
    }
    return { enemyAction: 4 }; // fallback
  }

  /**
   * Get current authoritative HP values for WRAM correction.
   */
  getHPSync() {
    const PARTYMON_STRUCT_LENGTH = 0x2C;
    const result = {
      playerActiveHP: this.hp.p1[this.active.p1] || 0,
      enemyActiveHP: this.hp.p2[this.active.p2] || 0,
      playerPartyHP: [],
      enemyPartyHP: [],
    };

    for (let i = 0; i < 6; i++) {
      result.playerPartyHP.push(this.hp.p1[i] || 0);
      // Use null for unrevealed enemy slots so _syncHP preserves ROM template HP
      result.enemyPartyHP.push(this.hp.p2[i] !== undefined ? (this.hp.p2[i] || 0) : null);
    }

    return result;
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  _parseSide(pokemonIdent) {
    if (!pokemonIdent) return null;
    if (pokemonIdent.startsWith('p1')) return 'p1';
    if (pokemonIdent.startsWith('p2')) return 'p2';
    return null;
  }

  _parseSpecies(pokemonIdent) {
    if (!pokemonIdent) return '';
    // Format: "p1a: Alakazam" or "p2a: Starmie"
    const match = pokemonIdent.match(/p[12]a?: (.+)/);
    return match ? match[1].trim() : '';
  }

  _parseHP(conditionText) {
    if (!conditionText) return [0, 0];
    // "0 fnt" = fainted
    if (conditionText.includes('fnt')) return [0, 0];
    // "250/250" or "250/250 par"
    const match = conditionText.match(/(\d+)\/(\d+)/);
    if (!match) return [0, 0];
    return [parseInt(match[1]), parseInt(match[2])];
  }

  _parseStatus(conditionText) {
    if (!conditionText) return '';
    const parts = conditionText.split(' ');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

  _updateHPFromText(side, hpText) {
    if (!side) return;
    let [cur, max] = this._parseHP(hpText);
    const idx = this.active[side];
    if (idx === undefined) return;

    // Showdown sends opponent HP as percentage (X/100) — convert to exact
    const knownMax = this.maxHp[side][idx];
    if (knownMax && knownMax > 100 && max === 100) {
      cur = Math.round(cur * knownMax / 100);
      console.log(`[TurnTranslator] Converted ${side} HP from ${hpText} → ${cur}/${knownMax}`);
    }

    this.hp[side][idx] = cur;
  }

  _setFainted(side) {
    if (!side) return;
    const idx = this.active[side];
    if (idx !== undefined) {
      this.hp[side][idx] = 0;
      this.alive[side][idx] = false;
    }
  }

  _handleSwitch(side, pokemonIdent, hpText) {
    if (!side) return;
    const species = this._parseSpecies(pokemonIdent);
    const partyIdx = this._findPartyIndex(species, side);
    if (partyIdx >= 0) {
      this.active[side] = partyIdx;
      if (hpText) {
        let [cur, max] = this._parseHP(hpText);
        const knownMax = this.maxHp[side][partyIdx];
        if (knownMax && knownMax > 100 && max === 100) {
          // Already know exact maxHP — convert percentage
          cur = Math.round(cur * knownMax / 100);
        } else if (max === 100 && !knownMax && typeof estimateGen1HP === 'function') {
          // Play mode — no exact HP available, estimate from species base stats
          const estimated = estimateGen1HP(species);
          this.maxHp[side][partyIdx] = estimated;
          cur = Math.round(cur * estimated / 100);
          console.log(`[TurnTranslator] Estimated ${species} maxHP=${estimated}, cur=${cur}`);
        } else {
          this.maxHp[side][partyIdx] = max;
        }
        this.hp[side][partyIdx] = cur;
        this.alive[side][partyIdx] = cur > 0;
      }
    }
    // Clear volatiles on switch-in
    this.confused[side] = false;
    this.recharging[side] = false;
    this.trapped[side] = false;
    this.biding[side] = false;
    this.thrashing[side] = false;
    this.charging[side] = false;
    this.invulnerable[side] = false;
    this.raging[side] = false;
    this.disabled[side] = null;
    this.substitute[side] = false;
    this.seeded[side] = false;
    // Snapshot pre-turn HP after switch
    this.prevHp[side] = this.hp[side][this.active[side]];
  }

  _getParty(side) {
    if (side === 'p2') return this.enemyParty;
    return window.PARTY;
  }

  _findPartyIndex(species, side) {
    const party = this._getParty(side);
    for (let i = 0; i < party.length; i++) {
      if (party[i].name.toLowerCase() === species.toLowerCase()) return i;
    }
    // For enemy side, register new Pokemon as they appear
    if (side === 'p2') {
      const idx = party.length;
      party.push({ name: species, moves: [] });
      console.log(`[TurnTranslator] Registered enemy Pokemon: ${species} at slot ${idx}`);
      return idx;
    }
    console.warn(`[TurnTranslator] Unknown species: ${species}`);
    return 0;
  }

  _findMoveSlot(partyIdx, moveName, side) {
    const party = this._getParty(side || 'p1');
    const mon = party[partyIdx];
    if (!mon) return 0;
    for (let i = 0; i < mon.moves.length; i++) {
      if (mon.moves[i].toLowerCase() === moveName.toLowerCase()) return i;
    }
    // For enemy, register new moves as they're used
    if (side === 'p2' && mon.moves.length < 4) {
      const idx = mon.moves.length;
      mon.moves.push(moveName);
      return idx;
    }
    console.warn(`[TurnTranslator] Move "${moveName}" not found in ${mon.name}'s moveset`);
    return 0;
  }

  _buildMoverData(damage, attackerSide, events, hits = 0, subBreakHit = 0) {
    // Filter events by this specific attacker
    const crit = events.crit.some(c => c.by === attackerSide) ? 1 : 0;
    const miss = events.miss.some(m => m.by === attackerSide) ? 1 : 0;
    const effectiveness = this._calcEffectiveness(attackerSide, events);

    return {
      damage: miss ? 0 : damage,
      crit,
      miss,
      effectiveness,
      hits,
      subBreakHit,
    };
  }

  _calcEffectiveness(attackerSide, events) {
    // ROM effectiveness system uses DECIMAL multipliers:
    // EFFECTIVE=10, SUPER_EFFECTIVE=20, NOT_VERY_EFFECTIVE=5, NO_EFFECT=0
    // For dual-type: multiply per matchup (20*20/10=40 for 4x SE, 5*5/10=2 for 4x NVE)
    if (events.immune.some(e => e.by === attackerSide)) return 0; // NO_EFFECT

    let superCount = events.supereffective.filter(e => e.by === attackerSide).length;
    let resistCount = events.resisted.filter(e => e.by === attackerSide).length;

    // 10 * 2^super / 2^resist — covers all mixed cases (e.g. 2,1 → 20)
    return Math.round(10 * Math.pow(2, superCount) / Math.pow(2, resistCount));
  }

  _getEnemyAction(events) {
    // Check if enemy used a move
    const enemyMove = events.moves.find(m => m.side === 'p2');
    if (enemyMove) {
      const slot = this._findMoveSlot(this.active.p2, enemyMove.moveName, 'p2');
      return slot; // 0-3 for move slots
    }

    // Check if enemy switched
    const enemySwitch = events.switchIn.find(s => s.side === 'p2');
    if (enemySwitch) {
      const partyIdx = this._findPartyIndex(enemySwitch.speciesName, 'p2');
      return 4 + partyIdx; // 4+ for switch
    }

    return 0; // default: move slot 0
  }

  _getEnemyMoveInfo(events) {
    const enemyMove = events.moves.find(m => m.side === 'p2');
    if (!enemyMove) return { moveId: 0x5E, slot: 0 }; // default Psychic

    const moveId = MOVE_MAP[enemyMove.moveName] || 0x5E;
    const slot = this._findMoveSlot(this.active.p2, enemyMove.moveName, 'p2');
    return { moveId, slot };
  }
}
