/**
 * Showdown EmuLink — Configuration, addresses, and utility functions.
 *
 * Globals: ADDR, WRAM_BASE, BTN, DEFAULT_PACKED_TEAM, parsePackedTeam,
 *          GEN1_BASE_HP, GEN1_DEX, estimateGen1HP
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
  SD_M1_Hits:           0xD157,  // multi-hit count for first mover
  SD_M2_Hits:           0xD158,  // multi-hit count for second mover
  SD_M1_SubBreakHit:    0xD159,  // hit # on which M1's target sub breaks (0 = no break)
  SD_M2_SubBreakHit:    0xD15A,  // hit # on which M2's target sub breaks (0 = no break)

  // Native game variables
  SerialReceiveData:    0xCC3E,
  SerialSendData:       0xCC42,
  PlayerSelectedMove:   0xCCDC,
  EnemySelectedMove:    0xCCDD,
  EnemyMoveListIndex:   0xCCE2,

  // Active battle mon structs
  BattleMon:            0xD013,   // wBattleMon (player active, 29 bytes)
  BattleMonHP:          0xD014,
  BattleMonStatus:      0xD017,
  BattleMonMoves:       0xD01B,   // player active mon's 4 move IDs
  BattleMonPP:          0xD02C,   // 4 bytes (PP for moves 0-3)
  EnemyMonSpecies2:     0xCFD7,   // wEnemyMonSpecies2 — used for sprite lookup
  EnemyMonNick:         0xCFD9,   // wEnemyMonNick (11 bytes)
  EnemyMon:             0xCFE4,   // wEnemyMon (enemy active, 29 bytes)
  EnemyMonHP:           0xCFE5,
  EnemyMonStatus:       0xCFE8,
  EnemyMonMoves:        0xCFEC,   // enemy active mon's 4 move IDs

  // Battle status
  PlayerBattleStatus1:  0xD061,
  PlayerBattleStatus2:  0xD062,
  PlayerBattleStatus3:  0xD063,
  EnemyBattleStatus1:   0xD066,
  EnemyBattleStatus2:   0xD067,
  EnemyBattleStatus3:   0xD068,
  PlayerMonStatMods:    0xCD1A, // 6 bytes (atk, def, spd, spc, acc, eva) — but Gen 1 has 8
  EnemyMonStatMods:     0xCD2E, // 6 bytes

  // Player party
  PartyCount:           0xD166,
  PartySpecies:         0xD167,   // 7 bytes: 6 species + 0xFF terminator
  PartyMons:            0xD16E,   // 6 * 0x2C bytes
  PartyMonOT:           0xD276,   // 6 * 11 bytes
  PartyMonNicks:        0xD2B8,   // 6 * 11 bytes

  // Enemy party
  EnemyTrainerName:     0xD88A,   // wLinkEnemyTrainerName (11 bytes)
  EnemyPartyCount:      0xD89F,
  EnemyPartySpecies:    0xD8A0,   // 7 bytes: 6 species + 0xFF terminator
  EnemyMons:            0xD8A7,   // 6 * 0x2C bytes
  EnemyMonOT:           0xD9AF,   // 6 * 11 bytes
  EnemyMonNicks:        0xD9F1,   // 6 * 11 bytes

  // Player action (for live mode — wSerialExchangeNybbleSendData is NOT written in Showdown path)
  PlayerMoveListIndex:  0xCC2E,
  ActionResultOrTookBattleTurn: 0xCD6A,
  WhichPokemon:         0xCF91,

  // Active party slot indices (ROM updates these when switching BEFORE Phase 1)
  PlayerMonNumber:       0xCC2F,
  EnemyMonPartyPos:      0xCFE7,

  // Additional addresses
  PlayerName:            0xD15B,  // wPlayerName (11 bytes)
  PlayerConfusedCounter: 0xD06A,
  EnemyConfusedCounter:  0xD06F,
  LinkState:             0xD12A,
  PartyMon1HP:           0xD16F,  // 2 bytes each, stride = 0x2C
  EnemyMon1HP:           0xD8A8,

  // Status + multi-turn state
  PartyMon1Status:        0xD172,   // stride 0x2C
  EnemyMon1Status:        0xD8AB,   // stride 0x2C
  PlayerNumAttacksLeft:   0xD069,
  EnemyNumAttacksLeft:    0xD06E,
  PlayerDisabledMove:     0xD06C,
  EnemyDisabledMove:      0xD071,
  PlayerBideAccum:        0xD073,   // 2 bytes (also wPlayerNumHits)
  EnemyBideAccum:         0xCD05,   // 2 bytes (also wEnemyNumHits)

  // Substitute HP
  PlayerSubstituteHP:     0xCCD7,   // 1 byte
  EnemySubstituteHP:      0xCCD8,   // 1 byte

  // Disabled move number (actual move ID)
  PlayerDisabledMoveNumber: 0xCCEE, // 1 byte
  EnemyDisabledMoveNumber:  0xCCEF, // 1 byte
});

// WRAM starts at 0xC000 on the Game Boy
const WRAM_BASE = 0xC000;

// =============================================================================
// Button constants for input simulation
// =============================================================================

const BTN = { A: 8, B: 0, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, START: 3, SELECT: 2 };

// =============================================================================
// Default packed team — used as fallback in test mode only
// =============================================================================

const DEFAULT_PACKED_TEAM = 'Alakazam|||noability|psychic,thunderwave,recover,seismictoss|Serious|252,252,252,252,252,252||30,30,30,30,30,30||100|]Starmie|||noability|surf,psychic,thunderbolt,recover|Serious|252,252,252,252,252,252||30,30,30,30,30,30||100|]Snorlax|||noability|bodyslam,earthquake,icebeam,rest|Serious|252,252,252,252,252,252||30,30,30,30,30,30||100|]Tauros|||noability|bodyslam,earthquake,blizzard,hyperbeam|Serious|252,252,252,252,252,252||30,30,30,30,30,30||100|]Chansey|||noability|icebeam,thunderbolt,thunderwave,softboiled|Serious|252,252,252,252,252,252||30,30,30,30,30,30||100|]Exeggutor|||noability|psychic,explosion,megadrain,rest|Serious|252,252,252,252,252,252||30,30,30,30,30,30||100|';

// =============================================================================
// Packed team parser
// =============================================================================

/**
 * Parse Showdown packed team format into PARTY array.
 * Packed format: name|species|item|ability|move1,move2,...|nature|evs|gender|ivs|shiny|level|happiness
 * Mons separated by ]
 */
function parsePackedTeam(packed) {
  if (!packed || !packed.trim()) return [];
  return packed.split(']').filter(s => s.trim()).map(mon => {
    const fields = mon.split('|');
    const species = fields[1] || fields[0]; // species field, fallback to name
    const name = _capitalizeSpecies(species);
    const moveIds = (fields[4] || '').split(',').filter(Boolean);
    const moves = moveIds.map(id => _moveIdToDisplay(id));
    return { name, moves };
  });
}

// Convert "bodyslam" → "Body Slam" using MOVE_MAP reverse lookup (built lazily)
let _reverseMap = null;
function _moveIdToDisplay(moveId) {
  if (!_reverseMap && typeof MOVE_MAP !== 'undefined') {
    _reverseMap = {};
    for (const [display, romId] of Object.entries(MOVE_MAP)) {
      _reverseMap[display.toLowerCase().replace(/[\s\-]/g, '')] = display;
    }
  }
  return _reverseMap?.[moveId.toLowerCase()] || moveId;
}

// "alakazam" → "Alakazam", "mr-mime" → "Mr. Mime"
function _capitalizeSpecies(s) {
  return s.replace(/(^|[\s\-])(\w)/g, (_, sep, c) => (sep === '-' ? '-' : sep) + c.toUpperCase());
}

// =============================================================================
// Gen 1 base HP stats for all 151 Pokemon
// =============================================================================

// Index = National Dex number (0 = unused placeholder).
const GEN1_BASE_HP = [
  0,   // 0: placeholder
  45,  // 1: Bulbasaur
  60,  // 2: Ivysaur
  80,  // 3: Venusaur
  39,  // 4: Charmander
  58,  // 5: Charmeleon
  78,  // 6: Charizard
  44,  // 7: Squirtle
  59,  // 8: Wartortle
  79,  // 9: Blastoise
  45,  // 10: Caterpie
  50,  // 11: Metapod
  60,  // 12: Butterfree
  40,  // 13: Weedle
  45,  // 14: Kakuna
  65,  // 15: Beedrill
  40,  // 16: Pidgey
  63,  // 17: Pidgeotto
  83,  // 18: Pidgeot
  30,  // 19: Rattata
  55,  // 20: Raticate
  40,  // 21: Spearow
  65,  // 22: Fearow
  35,  // 23: Ekans
  60,  // 24: Arbok
  35,  // 25: Pikachu
  60,  // 26: Raichu
  50,  // 27: Sandshrew
  75,  // 28: Sandslash
  55,  // 29: Nidoran♀
  70,  // 30: Nidorina
  90,  // 31: Nidoqueen
  46,  // 32: Nidoran♂
  61,  // 33: Nidorino
  81,  // 34: Nidoking
  70,  // 35: Clefairy
  95,  // 36: Clefable
  38,  // 37: Vulpix
  73,  // 38: Ninetales
  115, // 39: Jigglypuff
  140, // 40: Wigglytuff
  40,  // 41: Zubat
  75,  // 42: Golbat
  45,  // 43: Oddish
  60,  // 44: Gloom
  75,  // 45: Vileplume
  35,  // 46: Paras
  60,  // 47: Parasect
  60,  // 48: Venonat
  70,  // 49: Venomoth
  10,  // 50: Diglett
  35,  // 51: Dugtrio
  40,  // 52: Meowth
  65,  // 53: Persian
  50,  // 54: Psyduck
  80,  // 55: Golduck
  40,  // 56: Mankey
  65,  // 57: Primeape
  55,  // 58: Growlithe
  90,  // 59: Arcanine
  40,  // 60: Poliwag
  65,  // 61: Poliwhirl
  90,  // 62: Poliwrath
  25,  // 63: Abra
  40,  // 64: Kadabra
  55,  // 65: Alakazam
  70,  // 66: Machop
  80,  // 67: Machoke
  90,  // 68: Machamp
  50,  // 69: Bellsprout
  65,  // 70: Weepinbell
  80,  // 71: Victreebel
  40,  // 72: Tentacool
  80,  // 73: Tentacruel
  40,  // 74: Geodude
  55,  // 75: Graveler
  80,  // 76: Golem
  50,  // 77: Ponyta
  65,  // 78: Rapidash
  90,  // 79: Slowpoke
  95,  // 80: Slowbro
  25,  // 81: Magnemite
  50,  // 82: Magneton
  52,  // 83: Farfetch'd
  35,  // 84: Doduo
  60,  // 85: Dodrio
  65,  // 86: Seel
  90,  // 87: Dewgong
  80,  // 88: Grimer
  105, // 89: Muk
  30,  // 90: Shellder
  50,  // 91: Cloyster
  30,  // 92: Gastly
  45,  // 93: Haunter
  60,  // 94: Gengar
  35,  // 95: Onix
  60,  // 96: Drowzee
  85,  // 97: Hypno
  30,  // 98: Krabby
  55,  // 99: Kingler
  40,  // 100: Voltorb
  60,  // 101: Electrode
  60,  // 102: Exeggcute
  95,  // 103: Exeggutor
  50,  // 104: Cubone
  60,  // 105: Marowak
  50,  // 106: Hitmonlee
  50,  // 107: Hitmonchan
  90,  // 108: Lickitung
  40,  // 109: Koffing
  65,  // 110: Weezing
  80,  // 111: Rhyhorn
  105, // 112: Rhydon
  250, // 113: Chansey
  65,  // 114: Tangela
  105, // 115: Kangaskhan
  30,  // 116: Horsea
  55,  // 117: Seadra
  45,  // 118: Goldeen
  80,  // 119: Seaking
  30,  // 120: Staryu
  60,  // 121: Starmie
  40,  // 122: Mr. Mime
  70,  // 123: Scyther
  65,  // 124: Jynx
  65,  // 125: Electabuzz
  65,  // 126: Magmar
  65,  // 127: Pinsir
  75,  // 128: Tauros
  20,  // 129: Magikarp
  95,  // 130: Gyarados
  130, // 131: Lapras
  48,  // 132: Ditto
  55,  // 133: Eevee
  130, // 134: Vaporeon
  65,  // 135: Jolteon
  65,  // 136: Flareon
  65,  // 137: Porygon
  35,  // 138: Omanyte
  70,  // 139: Omastar
  30,  // 140: Kabuto
  60,  // 141: Kabutops
  80,  // 142: Aerodactyl
  160, // 143: Snorlax
  90,  // 144: Articuno
  90,  // 145: Zapdos
  90,  // 146: Moltres
  41,  // 147: Dratini
  61,  // 148: Dragonair
  91,  // 149: Dragonite
  106, // 150: Mewtwo
  100, // 151: Mew
];

// Species name → National Dex number (for GEN1_BASE_HP lookup)
const GEN1_DEX = {
  'Bulbasaur':1,'Ivysaur':2,'Venusaur':3,'Charmander':4,'Charmeleon':5,
  'Charizard':6,'Squirtle':7,'Wartortle':8,'Blastoise':9,'Caterpie':10,
  'Metapod':11,'Butterfree':12,'Weedle':13,'Kakuna':14,'Beedrill':15,
  'Pidgey':16,'Pidgeotto':17,'Pidgeot':18,'Rattata':19,'Raticate':20,
  'Spearow':21,'Fearow':22,'Ekans':23,'Arbok':24,'Pikachu':25,
  'Raichu':26,'Sandshrew':27,'Sandslash':28,'Nidoran-F':29,'Nidorina':30,
  'Nidoqueen':31,'Nidoran-M':32,'Nidorino':33,'Nidoking':34,'Clefairy':35,
  'Clefable':36,'Vulpix':37,'Ninetales':38,'Jigglypuff':39,'Wigglytuff':40,
  'Zubat':41,'Golbat':42,'Oddish':43,'Gloom':44,'Vileplume':45,
  'Paras':46,'Parasect':47,'Venonat':48,'Venomoth':49,'Diglett':50,
  'Dugtrio':51,'Meowth':52,'Persian':53,'Psyduck':54,'Golduck':55,
  'Mankey':56,'Primeape':57,'Growlithe':58,'Arcanine':59,'Poliwag':60,
  'Poliwhirl':61,'Poliwrath':62,'Abra':63,'Kadabra':64,'Alakazam':65,
  'Machop':66,'Machoke':67,'Machamp':68,'Bellsprout':69,'Weepinbell':70,
  'Victreebel':71,'Tentacool':72,'Tentacruel':73,'Geodude':74,'Graveler':75,
  'Golem':76,'Ponyta':77,'Rapidash':78,'Slowpoke':79,'Slowbro':80,
  'Magnemite':81,'Magneton':82,"Farfetch'd":83,'Doduo':84,'Dodrio':85,
  'Seel':86,'Dewgong':87,'Grimer':88,'Muk':89,'Shellder':90,
  'Cloyster':91,'Gastly':92,'Haunter':93,'Gengar':94,'Onix':95,
  'Drowzee':96,'Hypno':97,'Krabby':98,'Kingler':99,'Voltorb':100,
  'Electrode':101,'Exeggcute':102,'Exeggutor':103,'Cubone':104,'Marowak':105,
  'Hitmonlee':106,'Hitmonchan':107,'Lickitung':108,'Koffing':109,'Weezing':110,
  'Rhyhorn':111,'Rhydon':112,'Chansey':113,'Tangela':114,'Kangaskhan':115,
  'Horsea':116,'Seadra':117,'Goldeen':118,'Seaking':119,'Staryu':120,
  'Starmie':121,'Mr. Mime':122,'Scyther':123,'Jynx':124,'Electabuzz':125,
  'Magmar':126,'Pinsir':127,'Tauros':128,'Magikarp':129,'Gyarados':130,
  'Lapras':131,'Ditto':132,'Eevee':133,'Vaporeon':134,'Jolteon':135,
  'Flareon':136,'Porygon':137,'Omanyte':138,'Omastar':139,'Kabuto':140,
  'Kabutops':141,'Aerodactyl':142,'Snorlax':143,'Articuno':144,'Zapdos':145,
  'Moltres':146,'Dratini':147,'Dragonair':148,'Dragonite':149,'Mewtwo':150,
  'Mew':151,
};

// =============================================================================
// Team import / pack — adapted from Showdown's Storage.importTeam + packTeam
// Accepts pokepaste (human-readable) OR packed format, always returns packed.
// =============================================================================

/** Showdown's toID: lowercase, strip non-alphanumeric */
function toID(s) {
  if (!s) return '';
  return ('' + s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const BattleStatIDs = {
  HP:'hp', hp:'hp', Atk:'atk', atk:'atk', Def:'def', def:'def',
  SpA:'spa', SAtk:'spa', SpAtk:'spa', spa:'spa', spc:'spa', Spc:'spa',
  SpD:'spd', SDef:'spd', SpDef:'spd', spd:'spd',
  Spe:'spe', Spd:'spe', spe:'spe',
};

/**
 * Parse pokepaste / Showdown export text into array of set objects.
 * Adapted from Showdown's Storage.importTeam (storage.js).
 */
function importTeam(buffer) {
  var text = buffer.split('\n');
  // If single line with pipes, it's already packed
  if (text.length === 1 || (text.length === 2 && !text[1])) {
    if (text[0].includes('|')) return text[0]; // already packed string
  }
  var team = [];
  var curSet = null;
  for (var i = 0; i < text.length; i++) {
    var line = text[i].trim();
    if (line === '' || line === '---') {
      curSet = null;
    } else if (line.substr(0, 3) === '===' ) {
      // Team header line — skip
      curSet = null;
    } else if (line.includes('|') && !curSet) {
      // Packed line embedded in text — return as-is
      return line;
    } else if (!curSet) {
      curSet = { name: '', species: '', gender: '' };
      team.push(curSet);
      var atIndex = line.lastIndexOf(' @ ');
      if (atIndex !== -1) {
        curSet.item = line.substr(atIndex + 3);
        if (toID(curSet.item) === 'noitem') curSet.item = '';
        line = line.substr(0, atIndex);
      }
      if (line.substr(line.length - 4) === ' (M)') {
        curSet.gender = 'M';
        line = line.substr(0, line.length - 4);
      }
      if (line.substr(line.length - 4) === ' (F)') {
        curSet.gender = 'F';
        line = line.substr(0, line.length - 4);
      }
      var parenIndex = line.lastIndexOf(' (');
      if (line.substr(line.length - 1) === ')' && parenIndex !== -1) {
        line = line.substr(0, line.length - 1);
        curSet.species = line.substr(parenIndex + 2);
        line = line.substr(0, parenIndex);
        curSet.name = line;
      } else {
        curSet.species = line;
        curSet.name = '';
      }
    } else if (line.substr(0, 9) === 'Ability: ') {
      curSet.ability = line.substr(9);
    } else if (line.substr(0, 7) === 'Trait: ') {
      curSet.ability = line.substr(7);
    } else if (line === 'Shiny: Yes') {
      curSet.shiny = true;
    } else if (line.substr(0, 7) === 'Level: ') {
      curSet.level = +line.substr(7);
    } else if (line.substr(0, 11) === 'Happiness: ') {
      curSet.happiness = +line.substr(11);
    } else if (line.substr(0, 5) === 'EVs: ') {
      var evLines = line.substr(5).split('/');
      curSet.evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
      for (var j = 0; j < evLines.length; j++) {
        var evLine = evLines[j].trim();
        var spaceIndex = evLine.indexOf(' ');
        if (spaceIndex === -1) continue;
        var statid = BattleStatIDs[evLine.substr(spaceIndex + 1)];
        if (statid) curSet.evs[statid] = parseInt(evLine, 10);
      }
    } else if (line.substr(0, 5) === 'IVs: ') {
      var ivLines = line.substr(5).split(' / ');
      curSet.ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
      for (var j = 0; j < ivLines.length; j++) {
        var ivLine = ivLines[j];
        var spaceIndex = ivLine.indexOf(' ');
        if (spaceIndex === -1) continue;
        var statid = BattleStatIDs[ivLine.substr(spaceIndex + 1)];
        var statval = parseInt(ivLine, 10);
        if (statid) curSet.ivs[statid] = isNaN(statval) ? 31 : statval;
      }
    } else if (line.match(/^[A-Za-z]+ [Nn]ature/)) {
      var natureIndex = line.indexOf(' Nature');
      if (natureIndex === -1) natureIndex = line.indexOf(' nature');
      if (natureIndex !== -1) curSet.nature = line.substr(0, natureIndex);
    } else if (line.charAt(0) === '-' || line.charAt(0) === '~') {
      line = line.substr(1).trim();
      if (!curSet.moves) curSet.moves = [];
      curSet.moves.push(line);
    }
  }
  // Gen 1 competitive: all EVs default to 252 (no 510 cap).
  // Pokepastes rarely include EVs lines, and partial EVs lines leave unmentioned
  // stats at 0. Fill any missing/zero EVs with 252 so Showdown calculates correct stats.
  for (var k = 0; k < team.length; k++) {
    if (!team[k].evs) {
      team[k].evs = { hp: 252, atk: 252, def: 252, spa: 252, spd: 252, spe: 252 };
    } else {
      var stats = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
      for (var s = 0; s < stats.length; s++) {
        if (!team[k].evs[stats[s]]) team[k].evs[stats[s]] = 252;
      }
    }
  }
  return team;
}

/**
 * Pack a team (array of set objects) into Showdown's packed string format.
 * Adapted from Showdown's Storage.packTeam (storage.js).
 */
function packTeam(team) {
  if (!team) return '';
  if (typeof team === 'string') return team; // already packed
  var buf = '';
  for (var i = 0; i < team.length; i++) {
    var set = team[i];
    if (buf) buf += ']';
    buf += set.name || set.species;
    var id = toID(set.species);
    buf += '|' + (toID(set.name || set.species) === id ? '' : id);
    buf += '|' + toID(set.item);
    buf += '|' + toID(set.ability);
    buf += '|';
    if (set.moves) for (var j = 0; j < set.moves.length; j++) {
      var moveid = toID(set.moves[j]);
      if (j && !moveid) continue;
      buf += (j ? ',' : '') + moveid;
    }
    buf += '|' + (set.nature || '');
    var evs = '|';
    if (set.evs) {
      evs = '|' + (set.evs.hp || '') + ',' + (set.evs.atk || '') + ',' + (set.evs.def || '') + ',' + (set.evs.spa || '') + ',' + (set.evs.spd || '') + ',' + (set.evs.spe || '');
    }
    if (evs === '|,,,,,') {
      buf += '|';
      if (set.evs && set.evs.hp === 0) buf += '0';
    } else {
      buf += evs;
    }
    buf += '|' + (set.gender || '');
    var ivs = '|';
    if (set.ivs) {
      ivs = '|' + (set.ivs.hp === 31 || set.ivs.hp === undefined ? '' : set.ivs.hp) + ',' + (set.ivs.atk === 31 || set.ivs.atk === undefined ? '' : set.ivs.atk) + ',' + (set.ivs.def === 31 || set.ivs.def === undefined ? '' : set.ivs.def) + ',' + (set.ivs.spa === 31 || set.ivs.spa === undefined ? '' : set.ivs.spa) + ',' + (set.ivs.spd === 31 || set.ivs.spd === undefined ? '' : set.ivs.spd) + ',' + (set.ivs.spe === 31 || set.ivs.spe === undefined ? '' : set.ivs.spe);
    }
    buf += ivs === '|,,,,,' ? '|' : ivs;
    buf += '|' + (set.shiny ? 'S' : '');
    buf += '|' + (set.level && set.level !== 100 ? set.level : '');
    buf += '|' + (set.happiness !== undefined && set.happiness !== 255 ? set.happiness : '');
  }
  return buf;
}

/**
 * Normalize team input: accepts pokepaste OR packed format, returns packed string.
 * Returns { packed, pokemon, error }.
 */
function normalizeTeamInput(text) {
  text = text.trim();
  if (!text) return { packed: '', pokemon: [], error: 'No team provided' };

  // Detect format: if it has pipes and no move lines, it's packed
  const isPacked = text.includes('|') && !text.match(/^- /m);
  if (isPacked) {
    // Validate by parsing
    const parsed = parsePackedTeam(text);
    if (parsed.length === 0) return { packed: text, pokemon: [], error: 'Could not parse packed team' };
    // Gen 1: default missing/zero EVs to 252
    const fixed = text.split(']').filter(s => s.trim()).map(mon => {
      const f = mon.split('|');
      const evStr = f[6] || '';
      const evs = evStr.split(',').map(v => parseInt(v, 10) || 0);
      while (evs.length < 6) evs.push(0);
      f[6] = evs.map(v => v || 252).join(',');
      return f.join('|');
    }).join(']');
    return { packed: fixed, pokemon: parsed, error: null };
  }

  // Pokepaste format — import then pack
  const sets = importTeam(text);
  if (typeof sets === 'string') {
    // importTeam returned a packed string (single-line packed input)
    return { packed: sets, pokemon: parsePackedTeam(sets), error: null };
  }
  if (!sets || sets.length === 0) {
    return { packed: '', pokemon: [], error: 'Could not parse team' };
  }
  const packed = packTeam(sets);
  const pokemon = sets.map(s => s.species || s.name);
  return { packed, pokemon, error: null };
}

/**
 * Estimate max HP for a Gen 1 Pokemon at a given level.
 * Assumes max DVs (15) and max Stat Exp (65535) — competitive standard.
 * Formula: floor(((BaseHP + 15) * 2 + 64) * Level / 100) + Level + 10
 * At level 100: (BaseHP + 15) * 2 + 64 + 110 = 2*BaseHP + 204
 */
function estimateGen1HP(species, level = 100) {
  const dexNum = GEN1_DEX[species];
  const baseHP = dexNum ? GEN1_BASE_HP[dexNum] : 80; // fallback to 80
  // Gen 1 HP formula with DV=15, StatExp=65535
  const dvContrib = 15;
  const statExpContrib = Math.floor(Math.ceil(Math.sqrt(65535)) / 4); // = 64
  return Math.floor(((baseHP + dvContrib) * 2 + statExpContrib) * level / 100) + level + 10;
}
