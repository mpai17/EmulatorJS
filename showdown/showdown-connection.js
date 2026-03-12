/**
 * ShowdownConnection — WebSocket lifecycle, authentication, message routing
 * for connecting to a Pokemon Showdown server.
 *
 * Supports guest login via the public login server (action.php).
 */

// Login server endpoint — use local proxy to avoid CORS when on localhost
const LOGIN_SERVER_URL = (typeof window !== 'undefined' && window.location?.hostname === 'localhost')
  ? '/api/login'
  : 'https://play.pokemonshowdown.com/~~showdown/action.php';

class ShowdownConnection {
  constructor(name = 'conn') {
    this.name = name;
    this.ws = null;
    this.state = 'disconnected'; // disconnected | connecting | connected | authenticated
    this.username = '';
    this.battleRoomId = null;
    this._challstr = null;
    this._rqid = 0;

    // Callbacks
    this.onBattleMessage = null;  // (roomId, messages[]) => void
    this.onRequest = null;        // (request) => void
    this.onBattleEnd = null;      // (result) => void
    this.onAuthenticated = null;  // () => void
    this.onBattleStarted = null;  // (roomId) => void
    this.onChallenge = null;      // (from, format) => void
    this.onPopup = null;          // (message) => void
  }

  connect(serverUrl, timeout = 10000) {
    return new Promise((resolve, reject) => {
      if (this.ws) this.disconnect();

      this.state = 'connecting';
      console.log(`[${this.name}] Connecting to ${serverUrl}...`);

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.disconnect();
          reject(new Error(`[${this.name}] Connection timeout after ${timeout / 1000}s`));
        }
      }, timeout);

      try {
        this.ws = new WebSocket(serverUrl);
      } catch (e) {
        clearTimeout(timer);
        reject(new Error(`[${this.name}] WebSocket creation failed: ${e.message}`));
        return;
      }

      this.ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.state = 'connected';
        console.log(`[${this.name}] WebSocket connected`);
        resolve();
      };

      this.ws.onerror = (e) => {
        console.error(`[${this.name}] WebSocket error`, e);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`[${this.name}] WebSocket connection failed`));
        }
      };

      this.ws.onclose = (e) => {
        console.log(`[${this.name}] WebSocket closed (code=${e.code})`);
        this.state = 'disconnected';
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`[${this.name}] WebSocket closed before connecting (code=${e.code})`));
        }
      };

      this.ws.onmessage = (event) => {
        // Log all raw messages for debugging
        for (const line of event.data.split('\n')) {
          if (line.trim()) console.log(`[${this.name}] RAW: ${line}`);
        }
        this._handleMessage(event.data);
      };
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.state = 'disconnected';
    this.battleRoomId = null;
    this._challstr = null;
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error(`[${this.name}] Cannot send — not connected`);
      return;
    }
    this.ws.send(msg);
  }

  sendToRoom(roomId, msg) {
    this.send(`${roomId}|${msg}`);
  }

  /**
   * Login with optional password.
   * Guest:      login('name')          → getassertion
   * Registered: login('name', 'pass')  → login action (returns assertion)
   */
  login(username, password) {
    return new Promise(async (resolve, reject) => {
      this.username = username;

      // Timeout after 15 seconds
      const timer = setTimeout(() => {
        reject(new Error(`[${this.name}] Login timeout for "${username}"`));
      }, 15000);

      const wrappedResolve = () => { clearTimeout(timer); resolve(); };
      const wrappedReject = (e) => { clearTimeout(timer); reject(e); };

      if (!this._challstr) {
        this._pendingLogin = { username, password, resolve: wrappedResolve, reject: wrappedReject };
        return;
      }

      await this._doLogin(username, password, wrappedResolve, wrappedReject);
    });
  }

  async _doLogin(username, password, resolve, reject) {
    this.onAuthenticated = resolve;
    const userid = username.toLowerCase().replace(/[^a-z0-9]/g, '');

    try {
      let assertion;

      if (password) {
        // Registered account: POST login with password
        const body = new URLSearchParams({
          act: 'login',
          name: username,
          pass: password,
          challstr: this._challstr,
        });

        const resp = await fetch(LOGIN_SERVER_URL, { method: 'POST', body });
        const text = await resp.text();
        // Response is "]" + JSON (the ] prefix prevents CSRF)
        const json = JSON.parse(text.startsWith(']') ? text.slice(1) : text);

        if (!json.actionsuccess) {
          reject(new Error(`Login failed for "${username}": ${json.assertion || 'bad credentials'}`));
          return;
        }

        assertion = json.assertion;
        console.log(`[${this.name}] Password login OK for ${username}`);
      } else {
        // Guest: get assertion for unregistered name
        const body = new URLSearchParams({
          act: 'getassertion',
          userid,
          challstr: this._challstr,
        });

        const resp = await fetch(LOGIN_SERVER_URL, { method: 'POST', body });
        assertion = await resp.text();

        if (assertion.startsWith(';;')) {
          reject(new Error(`Name "${username}" is registered — use password login`));
          return;
        }
      }

      console.log(`[${this.name}] Got assertion for ${username}: ${assertion.slice(0, 30)}...`);
      this.send(`|/trn ${username},0,${assertion}`);
      // resolve is called when |updateuser| confirms authentication
    } catch (e) {
      console.error(`[${this.name}] Login failed:`, e);
      reject(new Error(`Login failed for "${username}": ${e.message}`));
    }
  }

  setTeam(packedTeam) {
    this.send(`|/utm ${packedTeam}`);
  }

  challenge(opponent, format = 'gen1ou') {
    this.send(`|/challenge ${opponent}, ${format}`);
  }

  sendChoice(choice, rqid) {
    if (!this.battleRoomId) {
      console.error(`[${this.name}] No battle room — cannot send choice`);
      return;
    }
    const msg = rqid ? `/choose ${choice}|${rqid}` : `/choose ${choice}`;
    this.sendToRoom(this.battleRoomId, msg);
  }

  // =========================================================================
  // Message parsing
  // =========================================================================

  _handleMessage(raw) {
    const lines = raw.split('\n');
    let roomId = '';

    // First line may be a room identifier: >roomid
    if (lines[0] && lines[0].startsWith('>')) {
      roomId = lines[0].slice(1).trim();
      lines.shift();
    }

    // If this is a battle room, collect messages
    if (roomId.startsWith('battle-')) {
      if (!this.battleRoomId) {
        this.battleRoomId = roomId;
        console.log(`[${this.name}] Joined battle room: ${roomId}`);
        if (this.onBattleStarted) this.onBattleStarted(roomId);
      }
      this._processBattleMessages(roomId, lines);
      return;
    }

    // Global / lobby messages
    for (const line of lines) {
      this._processGlobalLine(line);
    }
  }

  _processGlobalLine(line) {
    if (!line.startsWith('|')) return;
    const parts = line.slice(1).split('|');
    const cmd = parts[0];

    switch (cmd) {
      case 'challstr':
        this._challstr = parts.slice(1).join('|');
        console.log(`[${this.name}] Got challstr`);
        if (this._pendingLogin) {
          const { username, password, resolve, reject } = this._pendingLogin;
          this._pendingLogin = null;
          this._doLogin(username, password, resolve, reject);
        }
        break;

      case 'updateuser': {
        const loggedIn = parts[2]?.trim() === '1';
        if (loggedIn) {
          this.state = 'authenticated';
          this.username = parts[1]?.trim();
          console.log(`[${this.name}] Authenticated as "${this.username}"`);
          if (this.onAuthenticated) {
            const cb = this.onAuthenticated;
            this.onAuthenticated = null;
            cb();
          }
        }
        break;
      }

      case 'updatechallenges': {
        try {
          const data = JSON.parse(parts[1]);
          if (data.challengesFrom) {
            for (const [from, format] of Object.entries(data.challengesFrom)) {
              console.log(`[${this.name}] Challenge from ${from} (${format})`);
              if (this.onChallenge) this.onChallenge(from, format);
            }
          }
        } catch (e) { /* ignore parse errors */ }
        break;
      }

      // Challenge also arrives as PM: |pm|SENDER|RECEIVER|/challenge FORMAT|...
      case 'pm': {
        if (parts[3]?.startsWith('/challenge ')) {
          const from = parts[1]?.trim();
          const format = parts[3].replace('/challenge ', '');
          console.log(`[${this.name}] Challenge PM from ${from} (${format})`);
          if (this.onChallenge) this.onChallenge(from, format);
        }
        break;
      }

      case 'popup': {
        const msg = parts.slice(1).join('|').replace(/\|\|/g, '\n');
        console.log(`[${this.name}] Popup: ${msg}`);
        if (this.onPopup) this.onPopup(msg);
        break;
      }
    }
  }

  _processBattleMessages(roomId, lines) {
    const messages = [];
    let battleEndResult = null;
    for (const line of lines) {
      if (!line.startsWith('|')) continue;
      const parts = line.slice(1).split('|');
      const cmd = parts[0];

      if (cmd === 'request') {
        try {
          const req = parts[1] ? JSON.parse(parts[1]) : {};
          this._rqid = req.rqid || this._rqid;
          console.log(`[${this.name}] Request: rqid=${this._rqid}, forceSwitch=${!!req.forceSwitch}`);
          if (this.onRequest) this.onRequest(req);
        } catch (e) {
          console.error(`[${this.name}] Failed to parse request:`, e);
        }
        continue;
      }

      if (cmd === 'win' || cmd === 'tie') {
        console.log(`[${this.name}] Battle ended: ${line}`);
        battleEndResult = { type: cmd, winner: parts[1] };
      }

      messages.push({ cmd, parts, raw: line });
    }

    // Deliver battle messages BEFORE battle end so turn data is fully
    // accumulated before _onBattleEnd resolves any pending waiters.
    if (messages.length > 0 && this.onBattleMessage) {
      this.onBattleMessage(roomId, messages);
    }

    if (battleEndResult && this.onBattleEnd) {
      this.onBattleEnd(battleEndResult);
    }
  }
}
