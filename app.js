"use strict";

const STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const CHUNK_SIZE = 16 * 1024;
const MAX_BUFFERED_AMOUNT = 1024 * 1024;
const FILE_ID_BYTES = 16;

const setupView = document.querySelector("#setup-view");
const offerView = document.querySelector("#offer-view");
const connectedView = document.querySelector("#connected-view");
const createButton = document.querySelector("#create-button");
const displayNameInput = document.querySelector("#display-name");
const roomCapInput = document.querySelector("#room-cap");
const joinForm = document.querySelector("#join-form");
const joinButton = joinForm.querySelector('button[type="submit"]');
const joinCode = document.querySelector("#join-code");
const joinStatus = document.querySelector("#join-status");
const answerPanel = document.querySelector("#answer-panel");
const answerCode = document.querySelector("#answer-code");
const setupError = document.querySelector("#setup-error");
const connectionStatus = document.querySelector("#connection-status");
const roomSize = document.querySelector("#room-size");
const roomCount = document.querySelector("#room-count");
const transferStatus = document.querySelector("#transfer-status");
const transferList = document.querySelector("#transfer-list");
const fileInput = document.querySelector("#file-input");
const dropZone = document.querySelector("#drop-zone");
const chatMessages = document.querySelector("#chat-messages");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const chatSendButton = chatForm.querySelector('button[type="submit"]');
const scannerDialog = document.querySelector("#scanner-dialog");
const scannerVideo = document.querySelector("#scanner-video");
const scannerStatus = document.querySelector("#scanner-status");
const toast = document.querySelector("#toast");
const visitCount = document.querySelector("#visit-count");

let peerConnection;
let dataChannel;
let incomingFiles = new Map();
let activeScanStream;
let scanFrameId;
let toastTimeout;
let lastScanTime = 0;
let currentInviteUrl = "";
let signalingSession;
let isJoining = false;
let roomMode = false;
let isRoomHost = false;
let localName = "";
let roomMaxUsers = 2;
let roomConnections = new Map();
let roomParticipants = new Map();
let roomClientConnection;
const scanCanvas = document.createElement("canvas");
const scanContext = scanCanvas.getContext("2d", { willReadFrequently: true });

function showSetupError(message) {
  setupError.textContent = message;
  setupError.hidden = false;
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function showView(view) {
  setupView.hidden = view !== setupView;
  offerView.hidden = view !== offerView;
  connectedView.hidden = view !== connectedView;
}

function encodeDescription(description) {
  const json = JSON.stringify({
    version: 1,
    type: description.type,
    sdp: description.sdp,
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `KONNECT1.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

function makeInviteUrl(roomId) {
  const inviteUrl = new URL(window.location.href);
  inviteUrl.hash = new URLSearchParams({ room: roomId }).toString();
  return inviteUrl.toString();
}

function parseInvite(value) {
  const input = value.trim();
  if (/^https?:\/\//i.test(input)) {
    const inviteUrl = new URL(input);
    const currentUrl = new URL(window.location.href);
    if (inviteUrl.origin !== currentUrl.origin || inviteUrl.pathname !== currentUrl.pathname) {
      throw new Error("That invite link isn’t for this Konnect page.");
    }
    const params = new URLSearchParams(inviteUrl.hash.slice(1));
    const roomId = params.get("room");
    const code = params.get("join");
    if (roomId && /^[a-f0-9]{48}$/.test(roomId)) return { roomId };
    if (code) return { code };
    throw new Error("That invite link doesn’t contain a room code.");
  }
  if (/^[a-f0-9]{48}$/.test(input)) return { roomId: input };
  return { code: input };
}

function decodeDescription(code) {
  let encoded = code.trim().replace(/\s/g, "");
  if (encoded.startsWith("KONNECT1.")) encoded = encoded.slice("KONNECT1.".length);
  if (!encoded || !/^[A-Za-z0-9+/_=-]+$/.test(encoded)) {
    throw new Error("That doesn’t look like a connection code. Paste the full code or scan its QR.");
  }
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (
    value?.version !== 1 ||
    !["offer", "answer"].includes(value.type) ||
    typeof value.sdp !== "string" ||
    !value.sdp.startsWith("v=0")
  ) {
    throw new Error("This code isn’t a valid Konnect connection code.");
  }
  return { type: value.type, sdp: value.sdp };
}

function drawQr(canvas, value) {
  const qr = qrcode(0, "L");
  qr.addData(value);
  qr.make();
  const context = canvas.getContext("2d");
  const margin = 4;
  const moduleCount = qr.getModuleCount();
  const moduleSize = 4;
  const size = (moduleCount + margin * 2) * moduleSize;
  canvas.width = size;
  canvas.height = size;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#17231e";
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qr.isDark(row, column)) {
        context.fillRect(
          (column + margin) * moduleSize,
          (row + margin) * moduleSize,
          moduleSize,
          moduleSize,
        );
      }
    }
  }
}

function waitForIceGathering(connection) {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", onStateChange);
      reject(new Error("ICE route discovery took longer than a minute. Check your connection or try another network, then create a new room."));
    }, 60000);
    function onStateChange() {
      if (connection.iceGatheringState !== "complete") return;
      window.clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }
    connection.addEventListener("icegatheringstatechange", onStateChange);
  });
}

function setConnectionStatus(message) {
  connectionStatus.textContent = message;
}

function setJoinStatus(message) {
  joinStatus.textContent = message;
  joinStatus.hidden = !message;
}

function getSignalUrl(roomId, role, options = {}) {
  const configuredUrl = window.KONNECT_SIGNAL_URL;
  if (!configuredUrl) {
    throw new Error("The signaling service isn’t configured yet. Please try again later.");
  }
  const url = new URL(configuredUrl);
  if (url.protocol !== "https:") {
    throw new Error("The signaling service must use HTTPS.");
  }
  url.protocol = "wss:";
  url.pathname = `/room/${roomId}`;
  const params = new URLSearchParams({ role });
  if (options.name) params.set("name", options.name);
  if (options.maxUsers) params.set("maxUsers", String(options.maxUsers));
  if (options.participantId) params.set("participantId", options.participantId);
  url.search = params.toString();
  url.hash = "";
  return url.toString();
}

async function getIceServers(roomId, role, participantId) {
  const configuredUrl = window.KONNECT_SIGNAL_URL;
  if (!configuredUrl) {
    throw new Error("The signaling service isn’t configured yet. Please try again later.");
  }
  const url = new URL(configuredUrl);
  if (url.protocol !== "https:") {
    throw new Error("The signaling service must use HTTPS.");
  }
  url.pathname = "/ice-servers";
  url.search = "";
  url.hash = "";

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, role, participantId }),
      cache: "no-store",
    });
  } catch {
    throw new Error("Could not reach the relay configuration service. Check your connection and try again.");
  }
  let config;
  try {
    config = await response.json();
  } catch {
    throw new Error("The signaling service returned an invalid relay configuration.");
  }
  if (!response.ok) {
    throw new Error(config.error || "Could not obtain relay credentials. Please try again.");
  }
  if (!Array.isArray(config.iceServers) || typeof config.relayAvailable !== "boolean") {
    throw new Error("The signaling service returned an invalid relay configuration.");
  }
  if (!config.relayAvailable) {
    showToast("TURN relay is not configured; some networks may not connect.");
  }
  return config;
}

function connectSignaling(roomId, role, options = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = getSignalUrl(roomId, role, options);
    } catch (error) {
      reject(error);
      return;
    }

    const socket = new WebSocket(url);
    const session = {
      socket,
      messages: [],
      waiters: [],
      closed: false,
      error: undefined,
    };
    signalingSession = session;
    const timeout = window.setTimeout(() => {
      socket.close();
      reject(new Error("Could not reach the signaling service. Check your connection and try again."));
    }, 15000);

    socket.addEventListener("open", () => {
      window.clearTimeout(timeout);
      resolve(session);
    }, { once: true });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        closeSignaling(session, "Invalid signaling message");
        return;
      }
      if (message?.type === "error") {
        session.error = new Error(message.message || "The signaling service rejected this room.");
        rejectSignalWaiters(session, session.error);
        return;
      }
      const waiterIndex = session.waiters.findIndex(
        (waiter) =>
          (waiter.type === message?.type || waiter.type === "*") &&
          waiter.predicate(message),
      );
      if (waiterIndex !== -1) {
        const [waiter] = session.waiters.splice(waiterIndex, 1);
        window.clearTimeout(waiter.timeout);
        waiter.resolve(message);
      } else {
        session.messages.push(message);
      }
    });
    socket.addEventListener("close", () => {
      session.closed = true;
      if (signalingSession === session) signalingSession = undefined;
      window.clearTimeout(timeout);
      rejectSignalWaiters(session, new Error("The signaling connection closed before setup completed."));
    });
    socket.addEventListener("error", () => {
      if (socket.readyState !== WebSocket.OPEN) {
        window.clearTimeout(timeout);
        reject(new Error("Could not connect to the signaling service."));
      }
    });
  });
}

function waitForSignal(session, type, timeoutMs = 240000, predicate = () => true) {
  const queuedIndex = session.messages.findIndex(
    (message) => message?.type === type && predicate(message),
  );
  if (queuedIndex !== -1) return Promise.resolve(session.messages.splice(queuedIndex, 1)[0]);
  if (session.error) return Promise.reject(session.error);
  if (session.closed || session.socket.readyState === WebSocket.CLOSED) {
    return Promise.reject(new Error("The signaling connection closed before setup completed."));
  }
  return new Promise((resolve, reject) => {
    const waiter = { type, predicate, resolve, reject };
    waiter.timeout = window.setTimeout(() => {
      session.waiters = session.waiters.filter((item) => item !== waiter);
      reject(new Error("Timed out waiting for the other browser. Create a new room and try again."));
    }, timeoutMs);
    session.waiters.push(waiter);
  });
}

function waitForAnySignal(session, types, timeoutMs = 240000) {
  const queuedIndex = session.messages.findIndex((message) => types.includes(message?.type));
  if (queuedIndex !== -1) return Promise.resolve(session.messages.splice(queuedIndex, 1)[0]);
  if (session.error) return Promise.reject(session.error);
  if (session.closed || session.socket.readyState === WebSocket.CLOSED) {
    return Promise.reject(new Error("The signaling connection closed before setup completed."));
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      type: "*",
      predicate: (message) => types.includes(message?.type),
      resolve,
      reject,
    };
    if (timeoutMs > 0) {
      waiter.timeout = window.setTimeout(() => {
        session.waiters = session.waiters.filter((item) => item !== waiter);
        reject(new Error("Timed out waiting for room activity."));
      }, timeoutMs);
    }
    session.waiters.push(waiter);
  });
}

function rejectSignalWaiters(session, error) {
  for (const waiter of session.waiters.splice(0)) {
    window.clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
}

function closeSignaling(session, reason = "Setup complete") {
  if (!session || session.closed) return;
  session.closed = true;
  rejectSignalWaiters(session, new Error(reason));
  if (session.socket.readyState < WebSocket.CLOSING) session.socket.close(1000, reason);
  if (signalingSession === session) signalingSession = undefined;
}

function sendSignal(session, message) {
  if (session.closed || session.socket.readyState !== WebSocket.OPEN) {
    throw new Error("The signaling connection is no longer available.");
  }
  session.socket.send(JSON.stringify(message));
}

function newRoomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function configureDataChannel(channel) {
  dataChannel = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 256 * 1024;
  channel.addEventListener("open", () => {
    if (peerConnection?.sctp?.transport?.state !== "connected") {
      disconnect();
      showToast("Could not verify an encrypted connection. No data was sent; try a supported browser.");
      return;
    }
    showView(connectedView);
    chatInput.focus();
    updateRoomAvailability();
  });
  channel.addEventListener("close", () => {
    if (!connectedView.hidden) {
      showToast("The peer-to-peer connection closed.");
      disconnect();
    }
  });
  channel.addEventListener("message", handleDataMessage);
  channel.addEventListener("error", () => showToast("A data channel error occurred. Try reconnecting."));
}

function getDisplayName() {
  const name = displayNameInput.value.trim();
  if (!name || Array.from(name).length > 24 || /[\u0000-\u001f\u007f]/.test(name)) {
    displayNameInput.setCustomValidity("Choose a name of 1–24 characters without control characters.");
    displayNameInput.reportValidity();
    throw new Error("Choose a name of 1–24 characters.");
  }
  displayNameInput.setCustomValidity("");
  return name;
}

function updateRoomSize(count = roomParticipants.size + 1) {
  const text = `${count}/${roomMaxUsers} people in the room`;
  roomSize.textContent = text;
  roomCount.textContent = text;
}

function updateHostConnectionStatus(message) {
  setConnectionStatus(`${roomParticipants.size + 1}/${roomMaxUsers} people in the room. ${message}`);
}

function updateRoomAvailability() {
  const ready = roomMode
    ? getOpenRoomChannels().length > 0
    : dataChannel?.readyState === "open";
  fileInput.disabled = !ready;
  dropZone.setAttribute("aria-disabled", String(!ready));
  chatInput.disabled = !ready;
  chatSendButton.disabled = !ready;
  if (ready) {
    chatInput.placeholder = "Write a message…";
    transferStatus.textContent = roomMode
      ? "Files are shared with everyone in the room."
      : "Files are sent only to your connected peer.";
  } else {
    chatInput.placeholder = "Waiting for another person to connect…";
    transferStatus.textContent = "Waiting for another person to connect before sharing files.";
  }
}

async function recordPageLoad() {
  const configuredUrl = window.KONNECT_SIGNAL_URL;
  if (!configuredUrl) {
    visitCount.textContent = "Website page loads: unavailable";
    return;
  }
  try {
    const url = new URL(configuredUrl);
    if (url.protocol !== "https:") {
      visitCount.textContent = "Website page loads: unavailable";
      return;
    }
    url.pathname = "/visits";
    url.search = "";
    url.hash = "";
    const response = await fetch(url, { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !Number.isSafeInteger(result.count) || result.count < 0) {
      throw new Error("Invalid page-load count response.");
    }
    visitCount.textContent = `Website page loads: ${result.count.toLocaleString()}`;
  } catch {
    visitCount.textContent = "Website page loads: unavailable";
  }
}

function getOpenRoomChannels(exceptChannel) {
  if (!isRoomHost) {
    return dataChannel?.readyState === "open" && dataChannel !== exceptChannel
      ? [dataChannel]
      : [];
  }
  return Array.from(roomConnections.values())
    .map((participant) => participant.channel)
    .filter((channel) => channel?.readyState === "open" && channel !== exceptChannel);
}

function sendRoomPayload(payload, exceptChannel) {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const channel of getOpenRoomChannels(exceptChannel)) {
    channel.send(serialized);
  }
}

function sendRoomBinary(data, exceptChannel) {
  for (const channel of getOpenRoomChannels(exceptChannel)) {
    channel.send(data);
  }
}

async function sendRoomDataToChannels(channels, data) {
  if (!channels.length) throw new Error("No other room members are connected.");
  for (const channel of channels) {
    if (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) await waitForBuffer(channel);
  }
  for (const channel of channels) {
    if (channel.readyState !== "open") throw new Error("A room connection closed while sending data.");
    channel.send(data);
  }
}

function broadcastRoomPresence() {
  if (!isRoomHost) return;
  const names = [localName, ...roomParticipants.values()];
  updateRoomSize(names.length);
  sendRoomPayload({
    type: "presence",
    count: names.length,
    maxUsers: roomMaxUsers,
  });
}

function configureRoomDataChannel(channel, connection, participantId, participantName) {
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 256 * 1024;
  if (isRoomHost) {
    const participant = roomConnections.get(participantId);
    if (participant) participant.channel = channel;
  } else {
    dataChannel = channel;
    roomClientConnection = connection;
  }
  channel.addEventListener("open", () => {
    if (connection.sctp?.transport?.state !== "connected") {
      channel.close();
      showToast("Could not verify an encrypted connection. No data was sent; try a supported browser.");
      return;
    }
    showView(connectedView);
    document.querySelector("#copy-room-invite-button").hidden = !isRoomHost;
    updateRoomSize();
    updateRoomAvailability();
    chatInput.focus();
    if (isRoomHost) {
      broadcastRoomPresence();
      updateHostConnectionStatus(
        `Connection to ${participantName} is ready. Keep sharing the invite for others to join.`,
      );
    }
  });
  channel.addEventListener("close", () => {
    if (isRoomHost) {
      const participant = roomConnections.get(participantId);
      if (participant?.channel === channel) {
        participant.connection.close();
        roomConnections.delete(participantId);
        roomParticipants.delete(participantId);
        broadcastRoomPresence();
        updateRoomAvailability();
        if (roomConnections.size === 0) showView(offerView);
      }
    } else if (dataChannel === channel && roomMode) {
      showToast("The room connection closed.");
      disconnect();
    }
  });
  channel.addEventListener("message", (event) => {
    handleRoomDataMessage(event, channel, participantName);
  });
  connection.addEventListener("connectionstatechange", () => {
    if (isRoomHost && connection.connectionState === "failed") {
      updateHostConnectionStatus(
        `Connection to ${participantName} failed. Check the network and relay settings, then ask them to rejoin.`,
      );
    }
  });
  channel.addEventListener("error", () => showToast("A room data channel error occurred. Try reconnecting."));
}

function createRoomPeerConnection(iceServers, relayAvailable) {
  if (!("RTCPeerConnection" in window)) {
    throw new Error("This browser does not support WebRTC. Try a recent version of Chrome, Firefox, or Safari.");
  }
  const connection = new RTCPeerConnection({ iceServers });
  connection.addEventListener("connectionstatechange", () => {
    if (connection.connectionState === "failed") {
      showToast(
        relayAvailable
          ? "Could not establish a connection, even with the relay. Try switching one device to another network."
          : "Could not establish a direct connection. A TURN relay is not configured for this site yet.",
      );
    }
    if (connection.connectionState === "disconnected") {
      showToast("The room connection was interrupted. It may reconnect automatically.");
    }
  });
  return connection;
}

function createPeerConnection(iceServers = STUN_SERVERS, relayAvailable = false) {
  if (!("RTCPeerConnection" in window)) {
    throw new Error("This browser does not support WebRTC. Try a recent version of Chrome, Firefox, or Safari.");
  }
  peerConnection = new RTCPeerConnection({ iceServers });
  peerConnection.addEventListener("connectionstatechange", () => {
    if (peerConnection.connectionState === "failed") {
      showToast(
        relayAvailable
          ? "Could not establish a connection, even with the relay. Try switching one device to another network."
          : "Could not establish a direct connection. A TURN relay is not configured for this site yet.",
      );
    }
    if (peerConnection.connectionState === "disconnected") {
      showToast("The connection was interrupted. It may reconnect automatically.");
    }
  });
  return peerConnection;
}

function resetPeerConnection() {
  closeSignaling(signalingSession);
  for (const participant of roomConnections.values()) {
    if (participant.channel && participant.channel.readyState !== "closed") participant.channel.close();
    participant.connection.close();
  }
  roomConnections.clear();
  roomParticipants.clear();
  if (dataChannel && dataChannel.readyState !== "closed") dataChannel.close();
  if (peerConnection) peerConnection.close();
  if (roomClientConnection) roomClientConnection.close();
  dataChannel = undefined;
  peerConnection = undefined;
  roomClientConnection = undefined;
  incomingFiles.clear();
  roomMode = false;
  isRoomHost = false;
  roomSize.textContent = "";
  roomCount.textContent = "1/2 people in the room";
  updateRoomAvailability();
}

async function createRoom() {
  setupError.hidden = true;
  createButton.disabled = true;
  try {
    localName = getDisplayName();
    roomMaxUsers = Number(roomCapInput.value);
    roomMode = true;
    isRoomHost = true;
    roomParticipants = new Map();
    roomConnections = new Map();
    const roomId = newRoomId();
    const signaling = await connectSignaling(roomId, "creator", {
      name: localName,
      maxUsers: roomMaxUsers,
    });
    await waitForSignal(signaling, "room-ready");
    const iceConfig = await getIceServers(roomId, "creator");
    currentInviteUrl = makeInviteUrl(roomId);
    document.querySelector("#offer-code").value = roomId;
    drawQr(document.querySelector("#offer-qr"), currentInviteUrl);
    setConnectionStatus("Invite ready. Waiting for people to join…");
    updateRoomSize();
    showView(offerView);
    void handleRoomSignaling(signaling, iceConfig);
  } catch (error) {
    resetPeerConnection();
    showView(setupView);
    showSetupError(error.message);
  } finally {
    createButton.disabled = false;
  }
}

async function handleRoomSignaling(signaling, iceConfig) {
  while (!signaling.closed) {
    let message;
    try {
      message = await waitForAnySignal(signaling, ["participant-joined", "participant-left"], 0);
    } catch (error) {
      if (!signaling.closed) {
        setConnectionStatus(error.message);
        showToast(error.message);
      }
      return;
    }

    if (message.type === "participant-joined") {
      roomParticipants.set(message.participantId, message.name);
      broadcastRoomPresence();
      updateHostConnectionStatus(`Connecting with ${message.name}…`);
      void connectRoomParticipant(signaling, iceConfig, message).catch((error) => {
        updateHostConnectionStatus(`Could not connect with ${message.name}: ${error.message}`);
        showToast(error.message);
      });
    } else {
      const participant = roomConnections.get(message.participantId);
      participant?.channel?.close();
      participant?.connection.close();
      roomConnections.delete(message.participantId);
      roomParticipants.delete(message.participantId);
      broadcastRoomPresence();
      updateRoomAvailability();
      if (roomConnections.size === 0) showView(offerView);
    }
  }
}

async function connectRoomParticipant(signaling, iceConfig, participantInfo) {
  const { participantId, name } = participantInfo;
  const connection = createRoomPeerConnection(iceConfig.iceServers, iceConfig.relayAvailable);
  const participant = { connection, channel: undefined, name };
  roomConnections.set(participantId, participant);
  configureRoomDataChannel(
    connection.createDataChannel("konnect", { ordered: true }),
    connection,
    participantId,
    name,
  );
  try {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection);
    sendSignal(signaling, {
      type: "offer",
      participantId,
      sdp: connection.localDescription.sdp,
    });
    const answer = await waitForSignal(
      signaling,
      "answer",
      240000,
      (message) => message.participantId === participantId,
    );
    if (!answer.sdp.startsWith("v=0")) {
      throw new Error("A participant sent an invalid connection answer.");
    }
    await connection.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    updateHostConnectionStatus(`Establishing an encrypted connection with ${name}…`);
  } catch (error) {
    if (roomConnections.get(participantId) === participant) {
      roomConnections.delete(participantId);
      roomParticipants.delete(participantId);
      connection.close();
      broadcastRoomPresence();
    }
    if (!signaling.closed) {
      sendSignal(signaling, { type: "disconnect", participantId });
    }
    throw error;
  }
}

async function joinRoom(code) {
  if (isJoining || roomMode) return;
  isJoining = true;
  joinButton.disabled = true;
  setupError.hidden = true;
  setJoinStatus("");
  try {
    localName = getDisplayName();
    const invite = parseInvite(code);
    if (invite.roomId) {
      await joinSignalingRoom(invite.roomId);
      return;
    }
    const offer = decodeDescription(invite.code);
    if (offer.type !== "offer") throw new Error("That code is a reply. Paste a room code from the person who created it.");
    const connection = createPeerConnection();
    connection.addEventListener("datachannel", (event) => configureDataChannel(event.channel));
    await connection.setRemoteDescription(offer);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    answerPanel.hidden = false;
    await waitForIceGathering(connection);
    const reply = encodeDescription(connection.localDescription);
    answerCode.value = reply;
    drawQr(document.querySelector("#answer-qr"), reply);
    document.querySelector("#answer-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    setupError.hidden = true;
  } catch (error) {
    resetPeerConnection();
    answerPanel.hidden = true;
    setJoinStatus("");
    showSetupError(error.message);
  } finally {
    isJoining = false;
    joinButton.disabled = false;
  }
}

async function joinSignalingRoom(roomId) {
  const participantId = randomFileId();
  roomMode = true;
  isRoomHost = false;
  roomParticipants = new Map();
  roomConnections = new Map();
  setJoinStatus("Connecting to the room…");
  const signaling = await connectSignaling(roomId, "participant", {
    name: localName,
    participantId,
  });
  const ready = await waitForSignal(signaling, "room-ready");
  roomMaxUsers = ready.maxUsers;
  setJoinStatus("Waiting for the room creator…");
  const iceConfig = await getIceServers(roomId, "participant", participantId);
  const offer = await waitForSignal(signaling, "offer");
  if (typeof offer.sdp !== "string" || !offer.sdp.startsWith("v=0")) {
    throw new Error("The room sent an invalid connection offer.");
  }
  const connection = createRoomPeerConnection(iceConfig.iceServers, iceConfig.relayAvailable);
  roomClientConnection = connection;
  connection.addEventListener("datachannel", (event) => {
    configureRoomDataChannel(event.channel, connection, participantId, ready.creatorName);
  });
  await connection.setRemoteDescription({ type: "offer", sdp: offer.sdp });
  const answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);
  await waitForIceGathering(connection);
  sendSignal(signaling, { type: "answer", sdp: connection.localDescription.sdp });
  setJoinStatus("Connected to the room creator. Establishing the encrypted connection…");
}

function randomFileId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(FILE_ID_BYTES)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function waitForBuffer(channel) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
    }
    function onLow() {
      cleanup();
      resolve();
    }
    function onClose() {
      cleanup();
      reject(new Error("The connection closed while sending a file."));
    }
    channel.addEventListener("bufferedamountlow", onLow, { once: true });
    channel.addEventListener("close", onClose, { once: true });
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) onLow();
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function sendFile(file) {
  if (!roomMode && (!dataChannel || dataChannel.readyState !== "open")) {
    throw new Error("The peer is no longer connected.");
  }
  const targets = roomMode
    ? getOpenRoomChannels()
    : [dataChannel];
  if (!targets.length) throw new Error("No other room members are connected.");
  const send = roomMode
    ? (data) => sendRoomDataToChannels(targets, data)
    : async (data) => dataChannel.send(data);
  const id = randomFileId();
  await send(JSON.stringify({
    type: "file-start",
    id,
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
  }));
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
    const frame = new Uint8Array(FILE_ID_BYTES + chunk.byteLength);
    for (let index = 0; index < FILE_ID_BYTES; index += 1) {
      frame[index] = Number.parseInt(id.slice(index * 2, index * 2 + 2), 16);
    }
    frame.set(chunk, FILE_ID_BYTES);
    await send(frame.buffer);
    transferStatus.textContent = `Sending ${file.name} · ${Math.min(offset + chunk.byteLength, file.size) === file.size ? "finishing…" : formatBytes(offset + chunk.byteLength)}`;
  }
  await send(JSON.stringify({ type: "file-end", id }));
  transferStatus.textContent = `${file.name} sent · ${formatBytes(file.size)}`;
}

function makeTransferItem(name, detail, downloadUrl, downloadName) {
  const item = document.createElement("li");
  item.className = "transfer-item";
  const description = document.createElement("div");
  description.className = "transfer-name";
  const strong = document.createElement("strong");
  strong.textContent = name;
  const meta = document.createElement("span");
  meta.className = "transfer-meta";
  meta.textContent = detail;
  description.append(strong, meta);
  item.append(description);
  if (downloadUrl) {
    const link = document.createElement("a");
    link.className = "download-link";
    link.href = downloadUrl;
    link.download = downloadName;
    link.textContent = "Download";
    item.append(link);
  }
  transferList.prepend(item);
}

function handleFileStart(message, senderName) {
  if (!/^[a-f0-9]{32}$/.test(message.id) || typeof message.name !== "string" ||
      !Number.isSafeInteger(message.size) || message.size < 0 || typeof message.mime !== "string") {
    showToast("The peer sent invalid file details.");
    return false;
  }
  incomingFiles.set(message.id, {
    name: message.name,
    senderName: message.senderName || senderName,
    size: message.size,
    mime: message.mime,
    chunks: [],
    received: 0,
  });
  transferStatus.textContent = `Receiving ${message.name} · 0%`;
  return true;
}

function handleFileEnd(message) {
  const file = incomingFiles.get(message.id);
  if (!file) {
    showToast("Could not finish an incoming file.");
    return false;
  }
  incomingFiles.delete(message.id);
  if (file.received !== file.size) {
    showToast(`${file.name} arrived incomplete. Ask the sender to try again.`);
    return false;
  }
  const blob = new Blob(file.chunks, { type: file.mime });
  const url = URL.createObjectURL(blob);
  makeTransferItem(
    file.name,
    `Received from ${file.senderName || "Peer"} · ${formatBytes(file.size)}`,
    url,
    file.name,
  );
  transferStatus.textContent = `${file.name} received · ${formatBytes(file.size)}`;
  return true;
}

function appendMessage(text, own, senderName) {
  const empty = chatMessages.querySelector(".chat-empty");
  if (empty) empty.remove();
  const message = document.createElement("div");
  message.className = own ? "message own" : "message";
  const sender = document.createElement("span");
  sender.className = "message-sender";
  sender.textContent = own ? "You" : senderName || "Peer";
  const content = document.createElement("span");
  content.textContent = text;
  message.append(sender, content);
  chatMessages.append(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function handleDataMessage(event, senderName) {
  if (typeof event.data !== "string") {
    const frame = new Uint8Array(event.data);
    if (frame.byteLength < FILE_ID_BYTES) {
      showToast("The peer sent an invalid file chunk.");
      return;
    }
    const id = Array.from(frame.subarray(0, FILE_ID_BYTES), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const file = incomingFiles.get(id);
    if (!file) {
      showToast("Received file data without matching file details.");
      return;
    }
    const chunk = frame.slice(FILE_ID_BYTES);
    file.chunks.push(chunk);
    file.received += chunk.byteLength;
    const progress = file.size === 0 ? 100 : Math.min(100, Math.floor((file.received / file.size) * 100));
    transferStatus.textContent = `Receiving ${file.name} from ${file.senderName || "Peer"} · ${progress}%`;
    return;
  }

  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    showToast("The peer sent an unreadable message.");
    return;
  }
  if (message?.type === "chat" && typeof message.text === "string" && message.text.length <= 4000) {
    appendMessage(message.text, false, message.senderName || senderName);
  } else if (message?.type === "file-start") {
    handleFileStart(message, senderName);
  } else if (message?.type === "file-end" && typeof message.id === "string") {
    handleFileEnd(message);
  } else {
    showToast("The peer sent an unsupported message.");
  }
}

function handleRoomDataMessage(event, channel, participantName) {
  if (typeof event.data !== "string") {
    if (isRoomHost) {
      const frame = new Uint8Array(event.data);
      if (frame.byteLength < FILE_ID_BYTES) {
        showToast("A participant sent an invalid file chunk.");
        return;
      }
      const id = Array.from(
        frame.subarray(0, FILE_ID_BYTES),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (!incomingFiles.has(id)) {
        showToast("Received file data without matching file details.");
        return;
      }
      sendRoomBinary(event.data, channel);
      handleDataMessage(event, participantName);
      return;
    }
    handleDataMessage(event, localName);
    return;
  }

  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    showToast("A room participant sent an unreadable message.");
    return;
  }

  if (message?.type === "presence" && !isRoomHost) {
    if (Number.isInteger(message.count) && Number.isInteger(message.maxUsers)) {
      roomMaxUsers = message.maxUsers;
      updateRoomSize(message.count);
    }
    return;
  }

  if (isRoomHost) {
    if (message?.type === "chat" && typeof message.text === "string" && message.text.length <= 4000) {
      const relayMessage = { type: "chat", text: message.text, senderName: participantName };
      appendMessage(message.text, false, participantName);
      sendRoomPayload(relayMessage, channel);
    } else if (message?.type === "file-start") {
      const trustedFileMessage = { ...message, senderName: participantName };
      if (handleFileStart(trustedFileMessage, participantName)) {
        sendRoomPayload({ ...message, senderName: participantName }, channel);
      }
    } else if (message?.type === "file-end" && typeof message.id === "string") {
      if (handleFileEnd(message)) sendRoomPayload(message, channel);
    } else {
      showToast("A room participant sent an unsupported message.");
    }
    return;
  }

  if (message?.type === "chat" && typeof message.text === "string" && message.text.length <= 4000) {
    appendMessage(message.text, false, message.senderName || participantName);
  } else if (message?.type === "file-start") {
    handleFileStart(message, participantName);
  } else if (message?.type === "file-end" && typeof message.id === "string") {
    handleFileEnd(message);
  } else {
    showToast("The room sent an unsupported message.");
  }
}

async function sendFiles(files) {
  const selectedFiles = Array.from(files);
  if (!selectedFiles.length) return;
  for (const file of selectedFiles) {
    try {
      await sendFile(file);
      makeTransferItem(file.name, `Sent · ${formatBytes(file.size)}`);
    } catch (error) {
      transferStatus.textContent = error.message;
      showToast(error.message);
      break;
    }
  }
}

async function copyCode(textarea) {
  textarea.focus();
  textarea.select();
  try {
    await navigator.clipboard.writeText(textarea.value);
    showToast("Connection code copied.");
  } catch {
    showToast("Copy wasn’t available. The code is selected so you can copy it manually.");
  }
}

function stopScanner() {
  if (scanFrameId) cancelAnimationFrame(scanFrameId);
  scanFrameId = undefined;
  lastScanTime = 0;
  if (activeScanStream) {
    activeScanStream.getTracks().forEach((track) => track.stop());
    activeScanStream = undefined;
  }
  scannerVideo.srcObject = null;
}

async function startScanner(target) {
  if (typeof jsQR !== "function") {
    showToast("The QR scanner couldn’t load. Paste the connection code into the text box instead.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("Camera access requires HTTPS. Paste the code into the text box instead.");
    return;
  }
  scannerStatus.textContent = "Starting camera…";
  scannerDialog.showModal();
  try {
    activeScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    scannerVideo.srcObject = activeScanStream;
    await scannerVideo.play();
    scannerStatus.textContent = "Point the camera at the other person’s QR code.";
    const scan = async () => {
      if (!scannerDialog.open || !activeScanStream) return;
      const now = performance.now();
      if (now - lastScanTime >= 200 && scannerVideo.videoWidth) {
        lastScanTime = now;
        const scale = Math.min(1, 1280 / scannerVideo.videoWidth);
        const width = Math.round(scannerVideo.videoWidth * scale);
        const height = Math.round(scannerVideo.videoHeight * scale);
        if (scanCanvas.width !== width || scanCanvas.height !== height) {
          scanCanvas.width = width;
          scanCanvas.height = height;
        }
        scanContext.drawImage(scannerVideo, 0, 0, width, height);
        const image = scanContext.getImageData(0, 0, width, height);
        const result = jsQR(image.data, width, height, { inversionAttempts: "dontInvert" });
        if (result?.data) {
          target.value = result.data;
          stopScanner();
          scannerDialog.close();
          target.dispatchEvent(new Event("input", { bubbles: true }));
          if (target === joinCode) await joinRoom(target.value);
          else if (target === answerCode) showToast("Reply code scanned. Ask the room creator to scan it or paste it into their room.");
          return;
        }
      }
      scanFrameId = requestAnimationFrame(scan);
    };
    scanFrameId = requestAnimationFrame(scan);
  } catch (error) {
    stopScanner();
    scannerStatus.textContent = error.name === "NotAllowedError"
      ? "Camera permission was denied. Paste the connection code into the text box instead."
      : `Could not start the camera: ${error.message}`;
  }
}

function disconnect() {
  stopScanner();
  resetPeerConnection();
  answerPanel.hidden = true;
  joinCode.value = "";
  answerCode.value = "";
  setupError.hidden = true;
  setJoinStatus("");
  showView(setupView);
}

createButton.addEventListener("click", createRoom);

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void joinRoom(joinCode.value);
});

document.querySelector("#back-button").addEventListener("click", disconnect);
document.querySelector("#disconnect-button").addEventListener("click", disconnect);

document.querySelector("#copy-offer-button").addEventListener("click", () => {
  void copyCode(document.querySelector("#offer-code"));
});
document.querySelector("#copy-invite-button").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentInviteUrl);
    showToast("Invite link copied.");
  } catch {
    showToast("Copy wasn’t available. Use the room code instead.");
  }
});
document.querySelector("#copy-answer-button").addEventListener("click", () => {
  void copyCode(answerCode);
});

document.querySelector("#scan-join-button").addEventListener("click", () => void startScanner(joinCode));
document.querySelector("#close-scanner-button").addEventListener("click", () => scannerDialog.close());
scannerDialog.addEventListener("close", stopScanner);

fileInput.addEventListener("change", (event) => {
  void sendFiles(event.target.files);
  event.target.value = "";
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  void sendFiles(event.dataTransfer.files);
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  const message = { type: "chat", text, senderName: localName };
  if (roomMode) {
    if (isRoomHost) {
      if (!getOpenRoomChannels().length) {
        updateRoomAvailability();
        return;
      }
      sendRoomPayload(message);
    } else {
      if (!dataChannel || dataChannel.readyState !== "open") {
        updateRoomAvailability();
        return;
      }
      dataChannel.send(JSON.stringify(message));
    }
  } else {
    if (!dataChannel || dataChannel.readyState !== "open") {
      updateRoomAvailability();
      return;
    }
    dataChannel.send(JSON.stringify(message));
  }
  appendMessage(text, true);
  chatInput.value = "";
});

document.querySelector("#copy-room-invite-button").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentInviteUrl);
    showToast("Room invite copied.");
  } catch {
    showToast("Copy wasn’t available. Return to the room invite to copy the code.");
  }
});

void recordPageLoad();

window.addEventListener("beforeunload", () => {
  stopScanner();
  resetPeerConnection();
});

const initialInvite = new URLSearchParams(window.location.hash.slice(1));
const initialRoomId = initialInvite.get("room");
const initialInviteCode = initialInvite.get("join");
if (initialRoomId || initialInviteCode) {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  joinCode.value = initialRoomId || initialInviteCode;
  setJoinStatus("Choose your name, then select Join room to connect.");
}
