const ROOM_KEY_PREFIX = "dendarv.online.room.";
const NAME_KEY = "dendarv.online.name";
const SPECTATOR_KEY = "dendarv.online.spectator";

export class OnlineError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "OnlineError";
    this.code = code;
    this.status = status;
  }
}

function normalizeCode(code) {
  return String(code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function api(path, { method = "GET", token = null, body = null, spectatorId = null } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (spectatorId) headers["X-Dendarv-Spectator"] = spectatorId;
  if (body !== null) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new OnlineError("SERVER_UNREACHABLE", "The Dendarv online server could not be reached");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new OnlineError("INVALID_SERVER_RESPONSE", "The online server returned an unreadable response", response.status);
  }
  if (!response.ok) {
    throw new OnlineError(payload.error?.code ?? "ONLINE_ERROR", payload.error?.message ?? "The online request failed", response.status);
  }
  return payload;
}

export class OnlineClient {
  constructor(code, { spectate = false } = {}) {
    this.code = normalizeCode(code);
    this.spectate = spectate;
    this.token = spectate ? null : localStorage.getItem(`${ROOM_KEY_PREFIX}${this.code}`);
    this.spectatorId = localStorage.getItem(SPECTATOR_KEY) ?? randomId();
    localStorage.setItem(SPECTATOR_KEY, this.spectatorId);
  }

  static rememberedName() {
    return localStorage.getItem(NAME_KEY) ?? "";
  }

  static rememberName(name) {
    localStorage.setItem(NAME_KEY, String(name ?? "").trim());
  }

  static async create({ playerCount, playerName, seat, seed }) {
    const payload = await api("/api/rooms", {
      method: "POST",
      body: { playerCount, playerName, seat, seed },
    });
    const client = new OnlineClient(payload.code);
    client.token = payload.token;
    localStorage.setItem(`${ROOM_KEY_PREFIX}${payload.code}`, payload.token);
    OnlineClient.rememberName(playerName);
    return { client, payload: payload.view };
  }

  async join({ playerName, seat }) {
    const payload = await api(`/api/rooms/${this.code}/join`, {
      method: "POST",
      body: { playerName, seat },
    });
    this.spectate = false;
    this.token = payload.token;
    localStorage.setItem(`${ROOM_KEY_PREFIX}${this.code}`, payload.token);
    OnlineClient.rememberName(playerName);
    return payload.view;
  }

  view() {
    return api(`/api/rooms/${this.code}`, {
      token: this.token,
      spectatorId: this.token ? null : this.spectatorId,
    });
  }

  start() {
    return api(`/api/rooms/${this.code}/start`, { method: "POST", token: this.token });
  }

  command(command) {
    return api(`/api/rooms/${this.code}/command`, {
      method: "POST",
      token: this.token,
      body: { command },
    });
  }

  undo() {
    return api(`/api/rooms/${this.code}/undo`, { method: "POST", token: this.token });
  }

  pass() {
    return api(`/api/rooms/${this.code}/pass`, { method: "POST", token: this.token });
  }
}

export function roomCodeFromLocation() {
  return normalizeCode(new URLSearchParams(location.search).get("room"));
}

export function onlineShareUrl(code) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", normalizeCode(code));
  return url.href;
}
