/**
 * ShowdownEmu — Party WRAM Writer
 *
 * Writes a Showdown team (from |request| JSON) into GB WRAM so the ROM
 * uses the player's actual team instead of the hardcoded templates.
 *
 * Stats come directly from Showdown's request (no local recalculation).
 * Only needs lookup tables for: species internal IDs, types, move PPs.
 *
 * Depends on: MOVE_MAP (showdown-translator.js),
 *             _moveIdToDisplay (showdown-config.js),
 *             ROMInterface (showdown-rom.js)
 */

// =============================================================================
// WRAM Party Addresses
// =============================================================================
// These match the sym file values directly (sigAddr=0xD15B in showdown-rom.js).

const PARTY_WRAM = Object.freeze({
  player: {
    count:   0xD166,  // wPartyCount
    species: 0xD167,  // wPartySpecies (7 bytes: 6 + 0xFF terminator)
    mons:    0xD16E,  // wPartyMons (6 * 0x2C bytes)
    ot:      0xD276,  // wPartyMonOT (6 * 11 bytes)
    nicks:   0xD2B8,  // wPartyMonNicks (6 * 11 bytes)
  },
  enemy: {
    count:   0xD89F,  // wEnemyPartyCount
    species: 0xD8A0,  // wEnemyPartySpecies
    mons:    0xD8A7,  // wEnemyMons
    ot:      0xD9AF,  // wEnemyMonOT
    nicks:   0xD9F1,  // wEnemyMonNicks
  },
  enemyTrainerName: 0xD88A,  // wLinkEnemyTrainerName (11 bytes)
});

const STRUCT_LEN = 0x2C; // PARTYMON_STRUCT_LENGTH = 44 bytes
const NAME_LEN = 11;     // GB name length including terminator

// =============================================================================
// Type Constants (from type_constants.asm)
// =============================================================================

const TYPE_ID = Object.freeze({
  NORMAL:   0x00, FIGHTING: 0x01, FLYING: 0x02, POISON: 0x03,
  GROUND:   0x04, ROCK:     0x05, BUG:    0x07, GHOST:  0x08,
  FIRE:     0x14, WATER:    0x15, GRASS:  0x16, ELECTRIC: 0x17,
  PSYCHIC:  0x18, ICE:      0x19, DRAGON: 0x1A,
});

// =============================================================================
// Species Data: name → { id: internal ROM ID, t1: type1, t2: type2 }
// =============================================================================
// Internal IDs from pokemon_constants.asm, types from base stats data.

const GEN1_SPECIES = {
  'Bulbasaur':  { id: 0x99, t1: 0x16, t2: 0x03 },
  'Ivysaur':    { id: 0x09, t1: 0x16, t2: 0x03 },
  'Venusaur':   { id: 0x9A, t1: 0x16, t2: 0x03 },
  'Charmander': { id: 0xB0, t1: 0x14, t2: 0x14 },
  'Charmeleon': { id: 0xB2, t1: 0x14, t2: 0x14 },
  'Charizard':  { id: 0xB4, t1: 0x14, t2: 0x02 },
  'Squirtle':   { id: 0xB1, t1: 0x15, t2: 0x15 },
  'Wartortle':  { id: 0xB3, t1: 0x15, t2: 0x15 },
  'Blastoise':  { id: 0x1C, t1: 0x15, t2: 0x15 },
  'Caterpie':   { id: 0x7B, t1: 0x07, t2: 0x07 },
  'Metapod':    { id: 0x7C, t1: 0x07, t2: 0x07 },
  'Butterfree': { id: 0x7D, t1: 0x07, t2: 0x02 },
  'Weedle':     { id: 0x70, t1: 0x07, t2: 0x03 },
  'Kakuna':     { id: 0x71, t1: 0x07, t2: 0x03 },
  'Beedrill':   { id: 0x72, t1: 0x07, t2: 0x03 },
  'Pidgey':     { id: 0x24, t1: 0x00, t2: 0x02 },
  'Pidgeotto':  { id: 0x96, t1: 0x00, t2: 0x02 },
  'Pidgeot':    { id: 0x97, t1: 0x00, t2: 0x02 },
  'Rattata':    { id: 0xA5, t1: 0x00, t2: 0x00 },
  'Raticate':   { id: 0xA6, t1: 0x00, t2: 0x00 },
  'Spearow':    { id: 0x05, t1: 0x00, t2: 0x02 },
  'Fearow':     { id: 0x23, t1: 0x00, t2: 0x02 },
  'Ekans':      { id: 0x6C, t1: 0x03, t2: 0x03 },
  'Arbok':      { id: 0x2D, t1: 0x03, t2: 0x03 },
  'Pikachu':    { id: 0x54, t1: 0x17, t2: 0x17 },
  'Raichu':     { id: 0x55, t1: 0x17, t2: 0x17 },
  'Sandshrew':  { id: 0x60, t1: 0x04, t2: 0x04 },
  'Sandslash':  { id: 0x61, t1: 0x04, t2: 0x04 },
  'Nidoran-F':  { id: 0x0F, t1: 0x03, t2: 0x03 },
  'Nidorina':   { id: 0xA8, t1: 0x03, t2: 0x03 },
  'Nidoqueen':  { id: 0x10, t1: 0x03, t2: 0x04 },
  'Nidoran-M':  { id: 0x03, t1: 0x03, t2: 0x03 },
  'Nidorino':   { id: 0xA7, t1: 0x03, t2: 0x03 },
  'Nidoking':   { id: 0x07, t1: 0x03, t2: 0x04 },
  'Clefairy':   { id: 0x04, t1: 0x00, t2: 0x00 },
  'Clefable':   { id: 0x8E, t1: 0x00, t2: 0x00 },
  'Vulpix':     { id: 0x52, t1: 0x14, t2: 0x14 },
  'Ninetales':  { id: 0x53, t1: 0x14, t2: 0x14 },
  'Jigglypuff': { id: 0x64, t1: 0x00, t2: 0x00 },
  'Wigglytuff': { id: 0x65, t1: 0x00, t2: 0x00 },
  'Zubat':      { id: 0x6B, t1: 0x03, t2: 0x02 },
  'Golbat':     { id: 0x82, t1: 0x03, t2: 0x02 },
  'Oddish':     { id: 0xB9, t1: 0x16, t2: 0x03 },
  'Gloom':      { id: 0xBA, t1: 0x16, t2: 0x03 },
  'Vileplume':  { id: 0xBB, t1: 0x16, t2: 0x03 },
  'Paras':      { id: 0x6D, t1: 0x07, t2: 0x16 },
  'Parasect':   { id: 0x2E, t1: 0x07, t2: 0x16 },
  'Venonat':    { id: 0x41, t1: 0x07, t2: 0x03 },
  'Venomoth':   { id: 0x77, t1: 0x07, t2: 0x03 },
  'Diglett':    { id: 0x3B, t1: 0x04, t2: 0x04 },
  'Dugtrio':    { id: 0x76, t1: 0x04, t2: 0x04 },
  'Meowth':     { id: 0x4D, t1: 0x00, t2: 0x00 },
  'Persian':    { id: 0x90, t1: 0x00, t2: 0x00 },
  'Psyduck':    { id: 0x2F, t1: 0x15, t2: 0x15 },
  'Golduck':    { id: 0x80, t1: 0x15, t2: 0x15 },
  'Mankey':     { id: 0x39, t1: 0x01, t2: 0x01 },
  'Primeape':   { id: 0x75, t1: 0x01, t2: 0x01 },
  'Growlithe':  { id: 0x21, t1: 0x14, t2: 0x14 },
  'Arcanine':   { id: 0x14, t1: 0x14, t2: 0x14 },
  'Poliwag':    { id: 0x47, t1: 0x15, t2: 0x15 },
  'Poliwhirl':  { id: 0x6E, t1: 0x15, t2: 0x15 },
  'Poliwrath':  { id: 0x6F, t1: 0x15, t2: 0x01 },
  'Abra':       { id: 0x94, t1: 0x18, t2: 0x18 },
  'Kadabra':    { id: 0x26, t1: 0x18, t2: 0x18 },
  'Alakazam':   { id: 0x95, t1: 0x18, t2: 0x18 },
  'Machop':     { id: 0x6A, t1: 0x01, t2: 0x01 },
  'Machoke':    { id: 0x29, t1: 0x01, t2: 0x01 },
  'Machamp':    { id: 0x7E, t1: 0x01, t2: 0x01 },
  'Bellsprout': { id: 0xBC, t1: 0x16, t2: 0x03 },
  'Weepinbell': { id: 0xBD, t1: 0x16, t2: 0x03 },
  'Victreebel': { id: 0xBE, t1: 0x16, t2: 0x03 },
  'Tentacool':  { id: 0x18, t1: 0x15, t2: 0x03 },
  'Tentacruel': { id: 0x9B, t1: 0x15, t2: 0x03 },
  'Geodude':    { id: 0xA9, t1: 0x05, t2: 0x04 },
  'Graveler':   { id: 0x27, t1: 0x05, t2: 0x04 },
  'Golem':      { id: 0x31, t1: 0x05, t2: 0x04 },
  'Ponyta':     { id: 0xA3, t1: 0x14, t2: 0x14 },
  'Rapidash':   { id: 0xA4, t1: 0x14, t2: 0x14 },
  'Slowpoke':   { id: 0x25, t1: 0x15, t2: 0x18 },
  'Slowbro':    { id: 0x08, t1: 0x15, t2: 0x18 },
  'Magnemite':  { id: 0xAD, t1: 0x17, t2: 0x17 },
  'Magneton':   { id: 0x36, t1: 0x17, t2: 0x17 },
  "Farfetch'd": { id: 0x40, t1: 0x00, t2: 0x02 },
  'Doduo':      { id: 0x46, t1: 0x00, t2: 0x02 },
  'Dodrio':     { id: 0x74, t1: 0x00, t2: 0x02 },
  'Seel':       { id: 0x3A, t1: 0x15, t2: 0x15 },
  'Dewgong':    { id: 0x78, t1: 0x15, t2: 0x19 },
  'Grimer':     { id: 0x0D, t1: 0x03, t2: 0x03 },
  'Muk':        { id: 0x88, t1: 0x03, t2: 0x03 },
  'Shellder':   { id: 0x17, t1: 0x15, t2: 0x15 },
  'Cloyster':   { id: 0x8B, t1: 0x15, t2: 0x19 },
  'Gastly':     { id: 0x19, t1: 0x08, t2: 0x03 },
  'Haunter':    { id: 0x93, t1: 0x08, t2: 0x03 },
  'Gengar':     { id: 0x0E, t1: 0x08, t2: 0x03 },
  'Onix':       { id: 0x22, t1: 0x05, t2: 0x04 },
  'Drowzee':    { id: 0x30, t1: 0x18, t2: 0x18 },
  'Hypno':      { id: 0x81, t1: 0x18, t2: 0x18 },
  'Krabby':     { id: 0x4E, t1: 0x15, t2: 0x15 },
  'Kingler':    { id: 0x8A, t1: 0x15, t2: 0x15 },
  'Voltorb':    { id: 0x06, t1: 0x17, t2: 0x17 },
  'Electrode':  { id: 0x8D, t1: 0x17, t2: 0x17 },
  'Exeggcute':  { id: 0x0C, t1: 0x16, t2: 0x18 },
  'Exeggutor':  { id: 0x0A, t1: 0x16, t2: 0x18 },
  'Cubone':     { id: 0x11, t1: 0x04, t2: 0x04 },
  'Marowak':    { id: 0x91, t1: 0x04, t2: 0x04 },
  'Hitmonlee':  { id: 0x2B, t1: 0x01, t2: 0x01 },
  'Hitmonchan': { id: 0x2C, t1: 0x01, t2: 0x01 },
  'Lickitung':  { id: 0x0B, t1: 0x00, t2: 0x00 },
  'Koffing':    { id: 0x37, t1: 0x03, t2: 0x03 },
  'Weezing':    { id: 0x8F, t1: 0x03, t2: 0x03 },
  'Rhyhorn':    { id: 0x12, t1: 0x04, t2: 0x05 },
  'Rhydon':     { id: 0x01, t1: 0x04, t2: 0x05 },
  'Chansey':    { id: 0x28, t1: 0x00, t2: 0x00 },
  'Tangela':    { id: 0x1E, t1: 0x16, t2: 0x16 },
  'Kangaskhan': { id: 0x02, t1: 0x00, t2: 0x00 },
  'Horsea':     { id: 0x5C, t1: 0x15, t2: 0x15 },
  'Seadra':     { id: 0x5D, t1: 0x15, t2: 0x15 },
  'Goldeen':    { id: 0x9D, t1: 0x15, t2: 0x15 },
  'Seaking':    { id: 0x9E, t1: 0x15, t2: 0x15 },
  'Staryu':     { id: 0x1B, t1: 0x15, t2: 0x15 },
  'Starmie':    { id: 0x98, t1: 0x15, t2: 0x18 },
  'Mr. Mime':   { id: 0x2A, t1: 0x18, t2: 0x18 },
  'Scyther':    { id: 0x1A, t1: 0x07, t2: 0x02 },
  'Jynx':       { id: 0x48, t1: 0x19, t2: 0x18 },
  'Electabuzz': { id: 0x35, t1: 0x17, t2: 0x17 },
  'Magmar':     { id: 0x33, t1: 0x14, t2: 0x14 },
  'Pinsir':     { id: 0x1D, t1: 0x07, t2: 0x07 },
  'Tauros':     { id: 0x3C, t1: 0x00, t2: 0x00 },
  'Magikarp':   { id: 0x85, t1: 0x15, t2: 0x15 },
  'Gyarados':   { id: 0x16, t1: 0x15, t2: 0x02 },
  'Lapras':     { id: 0x13, t1: 0x15, t2: 0x19 },
  'Ditto':      { id: 0x4C, t1: 0x00, t2: 0x00 },
  'Eevee':      { id: 0x66, t1: 0x00, t2: 0x00 },
  'Vaporeon':   { id: 0x69, t1: 0x15, t2: 0x15 },
  'Jolteon':    { id: 0x68, t1: 0x17, t2: 0x17 },
  'Flareon':    { id: 0x67, t1: 0x14, t2: 0x14 },
  'Porygon':    { id: 0xAA, t1: 0x00, t2: 0x00 },
  'Omanyte':    { id: 0x62, t1: 0x05, t2: 0x15 },
  'Omastar':    { id: 0x63, t1: 0x05, t2: 0x15 },
  'Kabuto':     { id: 0x5A, t1: 0x05, t2: 0x15 },
  'Kabutops':   { id: 0x5B, t1: 0x05, t2: 0x15 },
  'Aerodactyl': { id: 0xAB, t1: 0x05, t2: 0x02 },
  'Snorlax':    { id: 0x84, t1: 0x00, t2: 0x00 },
  'Articuno':   { id: 0x4A, t1: 0x19, t2: 0x02 },
  'Zapdos':     { id: 0x4B, t1: 0x17, t2: 0x02 },
  'Moltres':    { id: 0x49, t1: 0x14, t2: 0x02 },
  'Dratini':    { id: 0x58, t1: 0x1A, t2: 0x1A },
  'Dragonair':  { id: 0x59, t1: 0x1A, t2: 0x1A },
  'Dragonite':  { id: 0x42, t1: 0x1A, t2: 0x02 },
  'Mewtwo':     { id: 0x83, t1: 0x18, t2: 0x18 },
  'Mew':        { id: 0x15, t1: 0x18, t2: 0x18 },
};

// =============================================================================
// Move Base PP (ROM move ID → base PP, from moves.asm)
// =============================================================================

const MOVE_BASE_PP = {
  0x01:35, 0x02:25, 0x03:10, 0x04:15, 0x05:20, 0x06:20, 0x07:15, 0x08:15,
  0x09:15, 0x0A:35, 0x0B:30, 0x0C:5,  0x0D:10, 0x0E:30, 0x0F:30, 0x10:35,
  0x11:35, 0x12:20, 0x13:15, 0x14:20, 0x15:20, 0x16:10, 0x17:20, 0x18:30,
  0x19:5,  0x1A:25, 0x1B:15, 0x1C:15, 0x1D:15, 0x1E:25, 0x1F:20, 0x20:5,
  0x21:35, 0x22:15, 0x23:20, 0x24:20, 0x25:20, 0x26:15, 0x27:30, 0x28:35,
  0x29:20, 0x2A:20, 0x2B:30, 0x2C:25, 0x2D:40, 0x2E:20, 0x2F:15, 0x30:20,
  0x31:20, 0x32:20, 0x33:30, 0x34:25, 0x35:15, 0x36:30, 0x37:25, 0x38:5,
  0x39:15, 0x3A:10, 0x3B:5,  0x3C:20, 0x3D:20, 0x3E:20, 0x3F:5,  0x40:35,
  0x41:20, 0x42:25, 0x43:20, 0x44:20, 0x45:20, 0x46:15, 0x47:20, 0x48:10,
  0x49:10, 0x4A:40, 0x4B:25, 0x4C:10, 0x4D:35, 0x4E:30, 0x4F:15, 0x50:20,
  0x51:40, 0x52:10, 0x53:15, 0x54:30, 0x55:15, 0x56:20, 0x57:10, 0x58:15,
  0x59:10, 0x5A:5,  0x5B:10, 0x5C:10, 0x5D:25, 0x5E:10, 0x5F:20, 0x60:40,
  0x61:30, 0x62:30, 0x63:20, 0x64:20, 0x65:15, 0x66:10, 0x67:40, 0x68:15,
  0x69:20, 0x6A:30, 0x6B:20, 0x6C:20, 0x6D:10, 0x6E:40, 0x6F:40, 0x70:30,
  0x71:30, 0x72:30, 0x73:20, 0x74:30, 0x75:10, 0x76:10, 0x77:20, 0x78:5,
  0x79:10, 0x7A:30, 0x7B:20, 0x7C:20, 0x7D:20, 0x7E:5,  0x7F:15, 0x80:10,
  0x81:20, 0x82:15, 0x83:15, 0x84:35, 0x85:20, 0x86:15, 0x87:10, 0x88:20,
  0x89:30, 0x8A:15, 0x8B:40, 0x8C:20, 0x8D:15, 0x8E:10, 0x8F:5,  0x90:10,
  0x91:30, 0x92:10, 0x93:15, 0x94:20, 0x95:15, 0x96:40, 0x97:40, 0x98:10,
  0x99:5,  0x9A:15, 0x9B:10, 0x9C:10, 0x9D:10, 0x9E:15, 0x9F:30, 0xA0:30,
  0xA1:10, 0xA2:10, 0xA3:20, 0xA4:10, 0xA5:10,
};

// =============================================================================
// GB Charmap Encoder
// =============================================================================

function _gbCharCode(ch) {
  if (ch >= 'A' && ch <= 'Z') return 0x80 + (ch.charCodeAt(0) - 65);
  if (ch >= 'a' && ch <= 'z') return 0xA0 + (ch.charCodeAt(0) - 97);
  if (ch >= '0' && ch <= '9') return 0xF6 + (ch.charCodeAt(0) - 48);
  if (ch === ' ') return 0x7F;
  if (ch === '.') return 0xE8;
  if (ch === '-') return 0xE3;
  if (ch === "'") return 0xE0;
  if (ch === '♂') return 0xEF;
  if (ch === '♀') return 0xF5;
  if (ch === '!') return 0xE7;
  if (ch === '?') return 0xE6;
  return 0x50; // terminator for unknown chars
}

/**
 * Encode a string to GB charmap bytes, padded/terminated to exactly `len` bytes.
 * Uses @ (0x50) as terminator, remaining bytes filled with 0x00.
 */
function encodeGBName(str, len = NAME_LEN) {
  const out = new Array(len).fill(0x00);
  const maxChars = len - 1; // leave room for terminator
  let i = 0;
  for (const ch of str) {
    if (i >= maxChars) break;
    out[i++] = _gbCharCode(ch);
  }
  out[i] = 0x50; // @ terminator
  return out;
}

// =============================================================================
// Showdown Move ID → ROM Move ID
// =============================================================================

let _sdMoveMap = null;

/**
 * Convert Showdown lowercase move ID (e.g. "psychic", "thunderwave")
 * to ROM move ID (e.g. 0x5E, 0x56).
 */
function sdMoveToRomId(sdMoveId) {
  if (!_sdMoveMap && typeof MOVE_MAP !== 'undefined') {
    _sdMoveMap = {};
    for (const [displayName, romId] of Object.entries(MOVE_MAP)) {
      const key = displayName.toLowerCase().replace(/[\s\-]/g, '');
      _sdMoveMap[key] = romId;
    }
  }
  return _sdMoveMap?.[sdMoveId.toLowerCase()] || 0;
}

// =============================================================================
// Species Name Normalization
// =============================================================================

// Showdown species names that need special handling for ROM lookup
const _SPECIES_ALIASES = {
  'nidoranf':  'Nidoran-F',
  'nidoranm':  'Nidoran-M',
  'farfetchd': "Farfetch'd",
  'mrmime':    'Mr. Mime',
  'mr.mime':   'Mr. Mime',
};

/**
 * Normalize a species name from Showdown to match GEN1_SPECIES keys.
 * Handles: "Alakazam" (direct), "p1: Alakazam" (ident prefix),
 *          "Nidoran-F", "Farfetch'd", "Mr. Mime", etc.
 */
function normalizeSpecies(raw) {
  // Strip "p1: " or "p2: " prefix from ident strings
  let name = raw.includes(': ') ? raw.split(': ')[1] : raw;
  // Strip form suffixes like "-Mega"
  if (name.includes('-') && !name.startsWith('Nidoran') && !name.startsWith("Farfetch")) {
    const base = name.split('-')[0];
    if (GEN1_SPECIES[base]) return base;
  }
  // Direct lookup
  if (GEN1_SPECIES[name]) return name;
  // Alias lookup
  const key = name.toLowerCase().replace(/[\s\-\.\']/g, '');
  if (_SPECIES_ALIASES[key]) return _SPECIES_ALIASES[key];
  // Capitalize first letter fallback
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  if (GEN1_SPECIES[capitalized]) return capitalized;
  console.warn(`[PartyWriter] Unknown species: "${name}"`);
  return name;
}

/**
 * Get the ROM nickname for a species (uppercase, max 10 chars).
 * Handles special names: Nidoran-F → NIDORAN♀, Nidoran-M → NIDORAN♂
 */
function speciesNickname(species) {
  if (species === 'Nidoran-F') return 'NIDORAN♀';
  if (species === 'Nidoran-M') return 'NIDORAN♂';
  if (species === "Farfetch'd") return "FARFETCH'D";
  if (species === 'Mr. Mime') return 'MR.MIME';
  return species.toUpperCase();
}

// =============================================================================
// PP Encoding
// =============================================================================

/**
 * Compute PP byte for a move with 3 PP ups (competitive standard).
 * PP byte = (pp_ups << 6) | max_pp
 * max_pp = base_pp + floor(base_pp * 3/5)
 */
function computeMaxPP(romMoveId) {
  const basePP = MOVE_BASE_PP[romMoveId] || 10;
  const maxPP = basePP + Math.floor(basePP * 3 / 5);
  return (3 << 6) | maxPP; // 0xC0 | maxPP
}

// =============================================================================
// Main: Write Party to WRAM
// =============================================================================

/**
 * Write a Showdown team to WRAM from the |request| JSON.
 *
 * @param {ROMInterface} rom - ROM interface for WRAM access
 * @param {object} request - Showdown |request| JSON (must have .side.pokemon)
 * @param {'player'|'enemy'} side - Which party to write
 */
function writePartyToWRAM(rom, request, side) {
  const pokemon = request.side?.pokemon;
  if (!pokemon || pokemon.length === 0) {
    console.warn('[PartyWriter] No pokemon in request');
    return;
  }

  const addrs = PARTY_WRAM[side];
  if (!addrs) {
    console.warn(`[PartyWriter] Unknown side: ${side}`);
    return;
  }

  const count = Math.min(pokemon.length, 6);

  // Write party count
  rom.write8(addrs.count, count);

  // Write species list + 0xFF terminator
  for (let i = 0; i < count; i++) {
    const species = normalizeSpecies(pokemon[i].ident || pokemon[i].details);
    const info = GEN1_SPECIES[species];
    rom.write8(addrs.species + i, info ? info.id : 0x99); // fallback to Bulbasaur
  }
  rom.write8(addrs.species + count, 0xFF); // terminator

  // Write each PARTYMON_STRUCT
  for (let i = 0; i < count; i++) {
    const mon = pokemon[i];
    const species = normalizeSpecies(mon.ident || mon.details);
    const info = GEN1_SPECIES[species] || { id: 0x99, t1: 0x00, t2: 0x00 };

    // Parse condition "curHP/maxHP" or "curHP/maxHP status"
    const condition = mon.condition || '1/1';
    const hpParts = condition.split(' ')[0].split('/');
    const curHP = parseInt(hpParts[0]) || 1;
    const maxHP = parseInt(hpParts[1]) || curHP;

    // Stats from Showdown (already calculated with correct EVs/DVs)
    const stats = mon.stats || {};
    const atk = stats.atk || 100;
    const def = stats.def || 100;
    const spe = stats.spe || 100;
    const spc = stats.spa || stats.spc || 100; // Gen 1: spa = spd = Special

    // Parse level from details "Species, L100" or "Species, L50"
    let level = 100;
    const detailMatch = (mon.details || '').match(/L(\d+)/);
    if (detailMatch) level = parseInt(detailMatch[1]);

    // Moves: Showdown lowercase IDs → ROM move IDs
    const sdMoves = mon.moves || [];
    const romMoves = sdMoves.map(m => sdMoveToRomId(m));
    while (romMoves.length < 4) romMoves.push(0); // pad to 4

    // Base address for this mon's struct
    const base = addrs.mons + i * STRUCT_LEN;

    // 0x00: Species
    rom.write8(base + 0x00, info.id);

    // 0x01-0x02: Current HP (big-endian)
    rom.write16be(base + 0x01, curHP);

    // 0x03: Box Level
    rom.write8(base + 0x03, level);

    // 0x04: Status (0 = healthy)
    rom.write8(base + 0x04, 0);

    // 0x05-0x06: Types
    rom.write8(base + 0x05, info.t1);
    rom.write8(base + 0x06, info.t2);

    // 0x07: Catch rate (doesn't affect battles)
    rom.write8(base + 0x07, 45);

    // 0x08-0x0B: Moves
    for (let m = 0; m < 4; m++) {
      rom.write8(base + 0x08 + m, romMoves[m]);
    }

    // 0x0C-0x0D: OT ID (big-endian)
    rom.write16be(base + 0x0C, 0x0123);

    // 0x0E-0x10: Experience (3 bytes big-endian, 1,000,000 for L100)
    rom.write8(base + 0x0E, 0x0F);
    rom.write8(base + 0x0F, 0x42);
    rom.write8(base + 0x10, 0x40);

    // 0x11-0x1A: Stat Exp (5 × 2 bytes, set to max for competitive)
    for (let s = 0; s < 5; s++) {
      rom.write16be(base + 0x11 + s * 2, 0xFFFF);
    }

    // 0x1B-0x1C: DVs (perfect = 0xFF 0xFF)
    rom.write8(base + 0x1B, 0xFF);
    rom.write8(base + 0x1C, 0xFF);

    // 0x1D-0x20: PP for each move (3 PP ups + max PP)
    for (let m = 0; m < 4; m++) {
      const ppByte = romMoves[m] ? computeMaxPP(romMoves[m]) : 0;
      rom.write8(base + 0x1D + m, ppByte);
    }

    // 0x21: Level
    rom.write8(base + 0x21, level);

    // 0x22-0x23: Max HP (big-endian)
    rom.write16be(base + 0x22, maxHP);

    // 0x24-0x25: Attack
    rom.write16be(base + 0x24, atk);

    // 0x26-0x27: Defense
    rom.write16be(base + 0x26, def);

    // 0x28-0x29: Speed
    rom.write16be(base + 0x28, spe);

    // 0x2A-0x2B: Special
    rom.write16be(base + 0x2A, spc);

    console.log(`[PartyWriter] ${side}[${i}] ${species}: HP=${curHP}/${maxHP} ATK=${atk} DEF=${def} SPE=${spe} SPC=${spc} moves=[${romMoves.map(m => '0x' + m.toString(16)).join(',')}]`);
  }

  // Write OT names (11 bytes each, "PLAYER@" padded)
  const otName = encodeGBName('PLAYER');
  for (let i = 0; i < count; i++) {
    const otBase = addrs.ot + i * NAME_LEN;
    for (let j = 0; j < NAME_LEN; j++) {
      rom.write8(otBase + j, otName[j]);
    }
  }

  // Write nicknames (11 bytes each, species name in GB charmap)
  for (let i = 0; i < count; i++) {
    const species = normalizeSpecies(pokemon[i].ident || pokemon[i].details);
    const nick = speciesNickname(species);
    const encoded = encodeGBName(nick);
    const nickBase = addrs.nicks + i * NAME_LEN;
    for (let j = 0; j < NAME_LEN; j++) {
      rom.write8(nickBase + j, encoded[j]);
    }
  }

  console.log(`[PartyWriter] Wrote ${count} Pokemon to ${side} party WRAM`);
}

// =============================================================================
// Write Active Battle Mon to WRAM
// =============================================================================
// The ROM copies the lead Pokemon into a "battle mon" struct (wBattleMon /
// wEnemyMon) during InitOpponent. This happens BEFORE our WRAM write, so the
// active mon has stale data from the hardcoded ROM party. We overwrite it here
// so the FIGHT menu shows correct moves and stats are accurate from turn 1.
//
// Battle mon struct (29 bytes, NOT the same as party struct):
//   0x00  Species (1)
//   0x01  HP (2, big-endian)
//   0x03  PartyPos / BoxLevel (1)
//   0x04  Status (1)
//   0x05  Type1 (1)
//   0x06  Type2 (1)
//   0x07  CatchRate (1)
//   0x08  Moves (4)
//   0x0C  DVs (2)          ← no OT/Exp/StatExp gap like party struct
//   0x0E  Level (1)
//   0x0F  MaxHP (2)
//   0x11  Attack (2)
//   0x13  Defense (2)
//   0x15  Speed (2)
//   0x17  Special (2)
//   0x19  PP (4)

/**
 * Write the active (lead) Pokemon's data to the battle mon struct.
 *
 * @param {ROMInterface} rom
 * @param {object} request - Showdown |request| JSON
 * @param {'player'|'enemy'} side
 */
function writeActiveBattleMonToWRAM(rom, request, side) {
  const pokemon = request.side?.pokemon;
  if (!pokemon?.length) return;

  const activeMon = pokemon.find(p => p.active) || pokemon[0];
  const activeIndex = pokemon.indexOf(activeMon);

  // Base address: 1 byte before HP (species field)
  // Derived from existing verified ADDR constants
  const base = side === 'player'
    ? ADDR.BattleMonHP - 1   // 0xD013
    : ADDR.EnemyMonHP - 1;   // 0xCFE4

  const species = normalizeSpecies(activeMon.ident || activeMon.details);
  const info = GEN1_SPECIES[species] || { id: 0x99, t1: 0x00, t2: 0x00 };

  // Parse condition
  const condition = activeMon.condition || '1/1';
  const hpParts = condition.split(' ')[0].split('/');
  const curHP = parseInt(hpParts[0]) || 1;
  const maxHP = parseInt(hpParts[1]) || curHP;

  // Stats
  const stats = activeMon.stats || {};
  const atk = stats.atk || 100;
  const def = stats.def || 100;
  const spe = stats.spe || 100;
  const spc = stats.spa || stats.spc || 100;

  // Level
  let level = 100;
  const m = (activeMon.details || '').match(/L(\d+)/);
  if (m) level = parseInt(m[1]);

  // Moves
  const sdMoves = activeMon.moves || [];
  const romMoves = sdMoves.map(mv => sdMoveToRomId(mv));
  while (romMoves.length < 4) romMoves.push(0);

  // Write battle mon struct
  rom.write8(base + 0x00, info.id);            // Species
  rom.write16be(base + 0x01, curHP);            // HP
  rom.write8(base + 0x03, activeIndex);         // PartyPos
  rom.write8(base + 0x04, 0);                   // Status (healthy)
  rom.write8(base + 0x05, info.t1);             // Type1
  rom.write8(base + 0x06, info.t2);             // Type2
  rom.write8(base + 0x07, 45);                  // CatchRate
  for (let i = 0; i < 4; i++)
    rom.write8(base + 0x08 + i, romMoves[i]);   // Moves
  rom.write8(base + 0x0C, 0xFF);                // DVs high
  rom.write8(base + 0x0D, 0xFF);                // DVs low
  rom.write8(base + 0x0E, level);               // Level
  rom.write16be(base + 0x0F, maxHP);             // MaxHP
  rom.write16be(base + 0x11, atk);               // Attack
  rom.write16be(base + 0x13, def);               // Defense
  rom.write16be(base + 0x15, spe);               // Speed
  rom.write16be(base + 0x17, spc);               // Special
  for (let i = 0; i < 4; i++) {
    const ppByte = romMoves[i] ? computeMaxPP(romMoves[i]) : 0;
    rom.write8(base + 0x19 + i, ppByte);         // PP
  }

  // Also update the BattleMonPP mirror at the ADDR location (used by FIGHT menu)
  if (side === 'player') {
    for (let i = 0; i < 4; i++) {
      const ppByte = romMoves[i] ? computeMaxPP(romMoves[i]) : 0;
      rom.write8(ADDR.BattleMonPP + i, ppByte);
    }
  }

  console.log(`[PartyWriter] Wrote ${side} active battle mon: ${species} (slot ${activeIndex})`);
}
