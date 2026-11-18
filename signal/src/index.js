import { DurableObject } from "cloudflare:workers";

const ROOM_LIFETIME_MS = 5 * 60 * 1000;
const MAX_SIGNAL_BYTES = 32 * 1024;
const TURN_REQUEST_LIMIT = 20;
const TURN_RATE_WINDOW_MS = 60 * 1000;
const STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function jsonResponse(body, status, origin) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST, OPTIONS",
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
      if (
        !/^[a-f0-9]{48}$/.test(body?.roomId) ||
        !["offerer", "answerer"].includes(body?.role)
      ) {
        return jsonResponse({ error: "Invalid room request" }, 400, origin);
      }

      const room = env.SIGNAL_ROOMS.get(env.SIGNAL_ROOMS.idFromName(body.roomId));
      const authorized = await room.fetch(
        new Request(`https://internal/_authorize-ice?role=${body.role}`),
      );
      if (!authorized.ok) {
        return jsonResponse({ error: "Signaling room is not connected" }, 403, origin);
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
        return jsonResponse({ error: "Too many relay requests. Try again shortly." }, 429, origin);
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
        return jsonResponse({ error: "Relay credentials are temporarily unavailable." }, 502, origin);
      }
      if (!turnResponse.ok) {
        console.error("Metered TURN credential request failed", turnResponse.status);
        return jsonResponse({ error: "Relay credentials are temporarily unavailable." }, 502, origin);
      }

      let iceServers;
      try {
        iceServers = await turnResponse.json();
      } catch {
        console.error("Metered TURN returned invalid JSON");
        return jsonResponse({ error: "Relay credentials are temporarily unavailable." }, 502, origin);
      }
      if (!Array.isArray(iceServers) || iceServers.length === 0) {
        console.error("Metered TURN returned no ICE servers");
        return jsonResponse({ error: "Relay credentials are temporarily unavailable." }, 502, origin);
      }

      return jsonResponse({ iceServers, relayAvailable: true }, 200, origin);
    }

    const match = url.pathname.match(/^\/room\/([a-f0-9]{48})$/);
    const role = url.searchParams.get("role");
    if (!match || !["offerer", "answerer"].includes(role)) {
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
    const roles = sockets.map((socket) => socket.deserializeAttachment()?.role);
    const url = new URL(request.url);

    if (url.pathname === "/_authorize-ice") {
      const role = url.searchParams.get("role");
      return new Response(null, {
        status: ["offerer", "answerer"].includes(role) && roles.includes(role) ? 204 : 403,
      });
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
    if (sockets.length >= 2 || roles.includes(role)) {
      return new Response("Room is full", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_LIFETIME_MS);
    }

    if (role === "answerer") {
      const offer = await this.ctx.storage.get("offer");
      if (offer) {
        server.send(offer);
        await this.ctx.storage.delete("offer");
      }
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

    const role = socket.deserializeAttachment()?.role;
    const expectedType = role === "offerer" ? "offer" : "answer";
    if (
      !["offerer", "answerer"].includes(role) ||
      message?.type !== expectedType ||
      typeof message.sdp !== "string" ||
      !message.sdp.startsWith("v=0")
    ) {
      this.sendError(socket, "Invalid signaling description");
      return;
    }

    const payload = JSON.stringify({ type: expectedType, sdp: message.sdp });
    if (new TextEncoder().encode(payload).byteLength > MAX_SIGNAL_BYTES) {
      this.sendError(socket, "Signaling description is too large");
      return;
    }

    if (role === "offerer") {
      if (await this.ctx.storage.get("offerSent")) {
        this.sendError(socket, "An offer was already sent for this room");
        return;
      }
      await this.ctx.storage.put("offerSent", true);
      await this.ctx.storage.put("offer", payload);
      for (const recipient of this.ctx.getWebSockets("answerer")) {
        recipient.send(payload);
        await this.ctx.storage.delete("offer");
      }
      return;
    }

    if (await this.ctx.storage.get("answerSent")) {
      this.sendError(socket, "An answer was already sent for this room");
      return;
    }
    const offerers = this.ctx.getWebSockets("offerer");
    if (!offerers.length) {
      this.sendError(socket, "The room creator is no longer connected");
      return;
    }
    await this.ctx.storage.put("answerSent", true);
    for (const recipient of offerers) {
      recipient.send(payload);
    }
  }

  async alarm() {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(4000, "Room expired");
    }
    await this.ctx.storage.deleteAll();
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
