/**
 * ShowdownBridge — Input simulation methods.
 *
 * Extends ShowdownBridge.prototype with button press and menu navigation.
 * Loaded after showdown-bridge.js defines the class.
 *
 * Depends on: BTN (showdown-config.js)
 */

// =============================================================================
// Input simulation
// =============================================================================

ShowdownBridge.prototype.pressButton = async function(buttonId, holdFrames = 2) {
  const gm = window.EJS_emulator?.gameManager;
  if (!gm) return;
  gm.simulateInput(0, buttonId, 1);
  await this._delay(holdFrames * 17);
  gm.simulateInput(0, buttonId, 0);
  await this._delay(17);
};

ShowdownBridge.prototype._delay = function(ms) {
  return new Promise(r => setTimeout(r, ms));
};

// =============================================================================
// Player input execution
// =============================================================================

ShowdownBridge.prototype._executePlayerInput = async function(input) {
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
};
