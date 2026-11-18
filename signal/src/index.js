import { DurableObject } from "cloudflare:workers";

const ROOM_LIFETIME_MS = 5 * 60 * 1000;
const MAX_SIGNAL_BYTES = 32 * 1024;
const MAX_ROOM_USERS = 20;
const TURN_REQUEST_LIMIT = 20;
const TURN_RATE_WINDOW_MS = 60 * 1000;
const STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function validName(name) {
  return typeof name === "string" &&
    name === name.trim() &&
    Array.from(name).length > 0 &&
    Array.from(name).length <= 24 &&
    !/[\u0000-\u001f\u007f]/.test(name);
}

function validSdp(sdp) {
  return typeof sdp === "string" &&
    sdp.startsWith("v=0") &&
    new TextEncoder().encode(sdp).byteLength <= MAX_SIGNAL_BYTES;
}

function jsonResponse(body, status, origin) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-origin": origin,
      "cache-control": "no-store",
      "content-type": "application/json",
      "vary": "Origin",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      return new Response("ok", { headers: { "cache-control": "no-store" } });
    }

    const origin = request.headers.get("Origin");
    const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((value) => value.trim());
    if (!origin || !allowedOrigins.includes(origin)) {
      return new Response("Origin not allowed", { status: 403 });
    }

    if (url.pathname === "/visits") {
      if (request.method === "OPTIONS") {
        return jsonResponse({}, 204, origin);
      }
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405, origin);
      }
      const counter = env.SIGNAL_ROOMS.get(env.SIGNAL_ROOMS.idFromName("site-visits"));
      const response = await counter.fetch(new Request("https://internal/_record-visit"));
      if (!response.ok) {
        return jsonResponse({ error: "Could not record this page load." }, 503, origin);
      }
      return jsonResponse(await response.json(), 200, origin);
    }

    if (url.pathname === "/ice-servers") {
      if (request.method === "OPTIONS") {
        return jsonResponse({}, 204, origin);
      }
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, origin);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid request" }, 400, origin);
      }
      if (!/^[a-f0-9]{48}$/.test(body?.roomId) ||
          !["creator", "participant"].includes(body?.role) ||
          (body.role === "participant" && !/^[a-f0-9]{32}$/.test(body?.participantId || ""))) {
        return jsonResponse({ error: "Invalid room request" }, 400, origin);
      }

      const room = env.SIGNAL_ROOMS.get(env.SIGNAL_ROOMS.idFromName(body.roomId));
      const authorized = await room.fetch(
        new Request(
          `https://internal/_authorize-ice?role=${body.role}&participantId=${body.participantId || ""}`,
        ),
      );
      if (!authorized.ok) {
        const status = authorized.status;
        const error = status === 409
          ? "This room is full."
          : status === 503
            ? "The room creator is starting or reconnecting."
            : "This participant is not connected to the room.";
        return jsonResponse({ error, retryable: status === 503 }, status, origin);
      }

      if (!env.METERED_TURN_APP || !env.METERED_TURN_API_KEY) {
        return jsonResponse({ iceServers: STUN_SERVERS, relayAvailable: false }, 200, origin);
      }
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(env.METERED_TURN_APP)) {
        return jsonResponse({ error: "TURN provider configuration is invalid." }, 503, origin);
      }

      const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
      const limiter = env.SIGNAL_ROOMS.get(
        env.SIGNAL_ROOMS.idFromName(`turn-rate:${clientIp}`),
      );
      const rateLimit = await limiter.fetch(new Request("https://internal/_rate-limit"));
      if (!rateLimit.ok) {
        return jsonResponse(
          { error: "Too many relay requests. Try again shortly.", retryable: true },
          429,
          origin,
        );
      }

      let turnResponse;
      try {
        turnResponse = await fetch(
          `https://${env.METERED_TURN_APP}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_TURN_API_KEY)}`,
          {
            method: "GET",
            headers: { accept: "application/json" },
          },
        );
      } catch (error) {
        console.error("Could not request Metered TURN credentials", error);
        return jsonResponse(
          { error: "Relay credentials are temporarily unavailable.", retryable: true },
          502,
          origin,
        );
      }
      if (!turnResponse.ok) {
        console.error("Metered TURN credential request failed", turnResponse.status);
        return jsonResponse(
          { error: "Relay credentials are temporarily unavailable.", retryable: true },
          502,
          origin,
        );
      }

      let iceServers;
      try {
        iceServers = await turnResponse.json();
      } catch {
        console.error("Metered TURN returned invalid JSON");
        return jsonResponse(
          { error: "Relay credentials are temporarily unavailable.", retryable: true },
          502,
          origin,
        );
      }
      if (!Array.isArray(iceServers) || iceServers.length === 0) {
        console.error("Metered TURN returned no ICE servers");
        return jsonResponse(
          { error: "Relay credentials are temporarily unavailable.", retryable: true },
          502,
          origin,
        );
      }

      return jsonResponse({ iceServers, relayAvailable: true }, 200, origin);
    }

    const match = url.pathname.match(/^\/room\/([a-f0-9]{48})$/);
    const role = url.searchParams.get("role");
    const name = url.searchParams.get("name");
    const maxUsers = Number(url.searchParams.get("maxUsers"));
    const participantId = url.searchParams.get("participantId");
    if (
      !match ||
      !["creator", "participant"].includes(role) ||
      !validName(name) ||
      (role === "creator" && (!Number.isInteger(maxUsers) || maxUsers < 2 || maxUsers > MAX_ROOM_USERS)) ||
      (role === "participant" && !/^[a-f0-9]{32}$/.test(participantId || ""))
    ) {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", {
        status: 426,
        headers: { Upgrade: "websocket" },
      });
    }

    const roomId = match[1];
    const id = env.SIGNAL_ROOMS.idFromName(roomId);
    return env.SIGNAL_ROOMS.get(id).fetch(request);
  },
};

export class SignalingRoom extends DurableObject {
  async fetch(request) {
    const sockets = this.ctx.getWebSockets();
    const url = new URL(request.url);

    if (url.pathname === "/_record-visit") {
      const count = await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get("siteVisits") || 0;
        const next = current + 1;
        await transaction.put("siteVisits", next);
        return next;
      });
      return new Response(JSON.stringify({ count }), {
        headers: { "cache-control": "no-store", "content-type": "application/json" },
      });
    }

    if (url.pathname === "/_authorize-ice") {
      const role = url.searchParams.get("role");
      const participantId = url.searchParams.get("participantId");
      const creatorConnected = sockets.some(
        (socket) => socket.deserializeAttachment()?.role === "creator",
      );
      if (!creatorConnected) return new Response(null, { status: 503 });
      if (role === "creator") {
        return new Response(null, {
          status: sockets.some((socket) => socket.deserializeAttachment()?.role === "creator") ? 204 : 403,
        });
      }
      if (role === "participant") {
        const participants = await this.ctx.storage.get("participants") || {};
        return new Response(null, {
          status: Object.hasOwn(participants, participantId) ? 204 : 403,
        });
      }
      return new Response(null, { status: 403 });
    }

    if (url.pathname === "/_rate-limit") {
      const window = Math.floor(Date.now() / TURN_RATE_WINDOW_MS);
      const allowed = await this.ctx.storage.transaction(async (transaction) => {
        const state = await transaction.get("turnRate");
        const count = state?.window === window ? state.count : 0;
        if (count >= TURN_REQUEST_LIMIT) return false;
        await transaction.put("turnRate", { window, count: count + 1 });
        return true;
      });
      if (!allowed) return new Response(null, { status: 429 });
      return new Response(null, { status: 204 });
    }

    const role = url.searchParams.get("role");
    const name = url.searchParams.get("name");
    const maxUsers = Number(url.searchParams.get("maxUsers"));
    const participantId = url.searchParams.get("participantId");
    const creator = sockets.find(
      (socket) => socket.deserializeAttachment()?.role === "creator",
    );
    let config;
    let reservedParticipant = false;

    if (role === "creator") {
      if (creator) return this.rejectSocket("This room has already been created.");
      const created = await this.ctx.storage.transaction(async (transaction) => {
        if (await transaction.get("roomConfig")) return false;
        await transaction.put("roomConfig", { maxUsers });
        await transaction.put("participants", {});
        return true;
      });
      if (!created) return this.rejectSocket("This room has already been created.");
    } else {
      if (!creator) {
        return this.rejectSocket("The room creator is starting or reconnecting.", true);
      }
      const reservation = await this.ctx.storage.transaction(async (transaction) => {
        const roomConfig = await transaction.get("roomConfig");
        if (!roomConfig) {
          return { error: "The room creator is starting or reconnecting.", retryable: true };
        }
        const participants = await transaction.get("participants") || {};
        if (Object.hasOwn(participants, participantId)) {
          return { error: "You are already connected to this room." };
        }
        if (Object.keys(participants).length >= roomConfig.maxUsers - 1) {
          return { error: "This room is full." };
        }
        participants[participantId] = name;
        await transaction.put("participants", participants);
        return { config: roomConfig };
      });
      if (reservation.error) return this.rejectSocket(reservation.error, reservation.retryable);
      config = reservation.config;
      reservedParticipant = true;
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment = role === "creator"
      ? { role, name, maxUsers }
      : { role, name, participantId };
    try {
      this.ctx.acceptWebSocket(server, [role]);
      server.serializeAttachment(attachment);
    } catch (error) {
      if (role === "creator") {
        await this.ctx.storage.deleteAll();
      } else if (reservedParticipant) {
        await this.ctx.storage.transaction(async (transaction) => {
          const participants = await transaction.get("participants") || {};
          delete participants[participantId];
          await transaction.put("participants", participants);
        });
      }
      throw error;
    }

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_LIFETIME_MS);
    }
    if (role === "creator") {
      server.send(JSON.stringify({ type: "room-ready", maxUsers }));
    } else {
      server.send(JSON.stringify({
        type: "room-ready",
        creatorName: creator.deserializeAttachment()?.name,
        maxUsers: config.maxUsers,
      }));
      creator.send(JSON.stringify({
        type: "participant-joined",
        participantId,
        name,
      }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, rawMessage) {
    if (typeof rawMessage !== "string" || new TextEncoder().encode(rawMessage).byteLength > MAX_SIGNAL_BYTES) {
      this.sendError(socket, "Invalid signaling message");
      return;
    }

    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      this.sendError(socket, "Invalid signaling message");
      return;
    }

    const attachment = socket.deserializeAttachment();
    const sockets = this.ctx.getWebSockets();
    if (attachment?.role === "creator" && message?.type === "disconnect") {
      const participant = sockets.find((candidate) => {
        const candidateAttachment = candidate.deserializeAttachment();
        return candidateAttachment?.role === "participant" &&
          candidateAttachment.participantId === message.participantId;
      });
      participant?.close(4002, "The room creator could not connect you");
      return;
    }

    if (!validSdp(message?.sdp) ||
        (attachment?.role === "creator" && message.type !== "offer") ||
        (attachment?.role === "participant" && message.type !== "answer")) {
      this.sendError(socket, "Invalid signaling description");
      return;
    }

    if (attachment?.role === "creator") {
      const participantId = message.participantId;
      const recipient = sockets.find((candidate) => {
        const candidateAttachment = candidate.deserializeAttachment();
        return candidateAttachment?.role === "participant" &&
          candidateAttachment.participantId === participantId;
      });
      if (!recipient) {
        this.sendError(socket, "That participant is no longer connected.");
        return;
      }
      recipient.send(JSON.stringify({ type: "offer", sdp: message.sdp }));
      return;
    }

    if (attachment?.role === "participant") {
      const creator = sockets.find(
        (candidate) => candidate.deserializeAttachment()?.role === "creator",
      );
      if (!creator) {
        this.sendError(socket, "The room creator is no longer connected.");
        return;
      }
      creator.send(JSON.stringify({
        type: "answer",
        participantId: attachment.participantId,
        sdp: message.sdp,
      }));
    }
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.role === "creator") {
      for (const participant of this.ctx.getWebSockets("participant")) {
        participant.close(4001, "The room creator disconnected");
      }
      await this.ctx.storage.deleteAll();
      return;
    }

    if (attachment?.role === "participant") {
      await this.ctx.storage.transaction(async (transaction) => {
        const participants = await transaction.get("participants") || {};
        delete participants[attachment.participantId];
        await transaction.put("participants", participants);
      });
      const creator = this.ctx.getWebSockets("creator")[0];
      if (creator) {
        creator.send(JSON.stringify({
          type: "participant-left",
          participantId: attachment.participantId,
        }));
      }
    }
  }

  async alarm() {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(4000, "Room expired");
    }
    await this.ctx.storage.deleteAll();
  }

  rejectSocket(message, retryable = false) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "error", message, retryable }));
    server.close(1008, message);
    return new Response(null, { status: 101, webSocket: client });
  }

  sendError(socket, message) {
    try {
      socket.send(JSON.stringify({ type: "error", message }));
      socket.close(1008, message);
    } catch {
      socket.close(1011, "Signaling error");
    }
  }
}
