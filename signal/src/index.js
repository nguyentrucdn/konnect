import { DurableObject } from "cloudflare:workers";

const ROOM_LIFETIME_MS = 5 * 60 * 1000;
const MAX_SIGNAL_BYTES = 32 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      return new Response("ok", { headers: { "cache-control": "no-store" } });
    }

    const match = url.pathname.match(/^\/room\/([a-f0-9]{48})$/);
    const role = url.searchParams.get("role");
    const origin = request.headers.get("Origin");
    const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((value) => value.trim());

    if (!match || !["offerer", "answerer"].includes(role)) {
      return new Response("Not found", { status: 404 });
    }
    if (!origin || !allowedOrigins.includes(origin)) {
      return new Response("Origin not allowed", { status: 403 });
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
    const role = new URL(request.url).searchParams.get("role");
    const sockets = this.ctx.getWebSockets();
    const roles = sockets.map((socket) => socket.deserializeAttachment()?.role);
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
