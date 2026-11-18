"use strict";

const STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const CHUNK_SIZE = 16 * 1024;
const MAX_BUFFERED_AMOUNT = 1024 * 1024;
const FILE_ID_BYTES = 16;

const setupView = document.querySelector("#setup-view");
const offerView = document.querySelector("#offer-view");
const connectedView = document.querySelector("#connected-view");
const createButton = document.querySelector("#create-button");
const joinForm = document.querySelector("#join-form");
const joinCode = document.querySelector("#join-code");
const answerPanel = document.querySelector("#answer-panel");
const answerCode = document.querySelector("#answer-code");
const setupError = document.querySelector("#setup-error");
const connectionStatus = document.querySelector("#connection-status");
const transferStatus = document.querySelector("#transfer-status");
const transferList = document.querySelector("#transfer-list");
const chatMessages = document.querySelector("#chat-messages");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const scannerDialog = document.querySelector("#scanner-dialog");
const scannerVideo = document.querySelector("#scanner-video");
const scannerStatus = document.querySelector("#scanner-status");
const toast = document.querySelector("#toast");

let peerConnection;
let dataChannel;
let incomingFiles = new Map();
let activeScanStream;
let scanFrameId;
let toastTimeout;

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
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const context = canvas.getContext("2d");
  const size = canvas.width;
  const margin = 4;
  const moduleCount = qr.getModuleCount();
  const scale = size / (moduleCount + margin * 2);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#17231e";
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qr.isDark(row, column)) {
        const x = Math.floor((column + margin) * scale);
        const y = Math.floor((row + margin) * scale);
        const nextX = Math.ceil((column + margin + 1) * scale);
        const nextY = Math.ceil((row + margin + 1) * scale);
        context.fillRect(x, y, nextX - x, nextY - y);
      }
    }
  }
}

function waitForIceGathering(connection) {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", onStateChange);
      reject(new Error("Gathering connection details took too long. Check your internet connection and try again."));
    }, 20000);
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

function createPeerConnection() {
  if (!("RTCPeerConnection" in window)) {
    throw new Error("This browser does not support WebRTC. Try a recent version of Chrome, Firefox, or Safari.");
  }
  peerConnection = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  peerConnection.addEventListener("connectionstatechange", () => {
    if (peerConnection.connectionState === "failed") {
      showToast("A direct connection could not be made. This network may require a relay, which Konnect does not use.");
    }
    if (peerConnection.connectionState === "disconnected") {
      showToast("The connection was interrupted. It may reconnect automatically.");
    }
  });
  return peerConnection;
}

function resetPeerConnection() {
  if (dataChannel && dataChannel.readyState !== "closed") dataChannel.close();
  if (peerConnection) peerConnection.close();
  dataChannel = undefined;
  peerConnection = undefined;
  incomingFiles.clear();
}

async function createRoom() {
  setupError.hidden = true;
  createButton.disabled = true;
  try {
    const connection = createPeerConnection();
    configureDataChannel(connection.createDataChannel("konnect", { ordered: true }));
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    setConnectionStatus("Preparing a direct connection…");
    showView(offerView);
    await waitForIceGathering(connection);
    const code = encodeDescription(connection.localDescription);
    document.querySelector("#offer-code").value = code;
    drawQr(document.querySelector("#offer-qr"), code);
    setConnectionStatus("Waiting for the other person to connect…");
  } catch (error) {
    resetPeerConnection();
    showView(setupView);
    showSetupError(error.message);
  } finally {
    createButton.disabled = false;
  }
}

async function joinRoom(code) {
  setupError.hidden = true;
  try {
    const offer = decodeDescription(code);
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
    showSetupError(error.message);
  }
}

async function completeConnection(code) {
  setupError.hidden = true;
  try {
    const answer = decodeDescription(code);
    if (answer.type !== "answer") throw new Error("That code is a room code. Paste the reply code from the person who joined.");
    if (!peerConnection || peerConnection.signalingState !== "have-local-offer") {
      throw new Error("Create a room first, then enter the reply code.");
    }
    await peerConnection.setRemoteDescription(answer);
    setConnectionStatus("Connecting directly…");
  } catch (error) {
    showToast(error.message);
  }
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
  if (!dataChannel || dataChannel.readyState !== "open") throw new Error("The peer is no longer connected.");
  const id = randomFileId();
  dataChannel.send(JSON.stringify({
    type: "file-start",
    id,
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
  }));
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    if (dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) await waitForBuffer(dataChannel);
    const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
    const frame = new Uint8Array(FILE_ID_BYTES + chunk.byteLength);
    for (let index = 0; index < FILE_ID_BYTES; index += 1) {
      frame[index] = Number.parseInt(id.slice(index * 2, index * 2 + 2), 16);
    }
    frame.set(chunk, FILE_ID_BYTES);
    dataChannel.send(frame.buffer);
    transferStatus.textContent = `Sending ${file.name} · ${Math.min(offset + chunk.byteLength, file.size) === file.size ? "finishing…" : formatBytes(offset + chunk.byteLength)}`;
  }
  dataChannel.send(JSON.stringify({ type: "file-end", id }));
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

function handleFileStart(message) {
  if (!/^[a-f0-9]{32}$/.test(message.id) || typeof message.name !== "string" ||
      !Number.isSafeInteger(message.size) || message.size < 0 || typeof message.mime !== "string") {
    showToast("The peer sent invalid file details.");
    return;
  }
  incomingFiles.set(message.id, {
    name: message.name,
    size: message.size,
    mime: message.mime,
    chunks: [],
    received: 0,
  });
  transferStatus.textContent = `Receiving ${message.name} · 0%`;
}

function handleFileEnd(message) {
  const file = incomingFiles.get(message.id);
  if (!file) {
    showToast("Could not finish an incoming file.");
    return;
  }
  incomingFiles.delete(message.id);
  if (file.received !== file.size) {
    showToast(`${file.name} arrived incomplete. Ask the sender to try again.`);
    return;
  }
  const blob = new Blob(file.chunks, { type: file.mime });
  const url = URL.createObjectURL(blob);
  makeTransferItem(file.name, `Received · ${formatBytes(file.size)}`, url, file.name);
  transferStatus.textContent = `${file.name} received · ${formatBytes(file.size)}`;
}

function appendMessage(text, own) {
  const empty = chatMessages.querySelector(".chat-empty");
  if (empty) empty.remove();
  const message = document.createElement("div");
  message.className = own ? "message own" : "message";
  const sender = document.createElement("span");
  sender.className = "message-sender";
  sender.textContent = own ? "You" : "Peer";
  const content = document.createElement("span");
  content.textContent = text;
  message.append(sender, content);
  chatMessages.append(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function handleDataMessage(event) {
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
    transferStatus.textContent = `Receiving ${file.name} · ${progress}%`;
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
    appendMessage(message.text, false);
  } else if (message?.type === "file-start") {
    handleFileStart(message);
  } else if (message?.type === "file-end" && typeof message.id === "string") {
    handleFileEnd(message);
  } else {
    showToast("The peer sent an unsupported message.");
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
  if (activeScanStream) {
    activeScanStream.getTracks().forEach((track) => track.stop());
    activeScanStream = undefined;
  }
  scannerVideo.srcObject = null;
}

async function startScanner(target) {
  if (!("BarcodeDetector" in window)) {
    showToast("QR scanning isn’t supported by this browser. Paste the code into the text box instead.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("Camera access requires HTTPS. Paste the code into the text box instead.");
    return;
  }
  scannerStatus.textContent = "Starting camera…";
  scannerDialog.showModal();
  try {
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    activeScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    scannerVideo.srcObject = activeScanStream;
    await scannerVideo.play();
    scannerStatus.textContent = "Point the camera at the other person’s QR code.";
    const scan = async () => {
      if (!scannerDialog.open || !activeScanStream) return;
      try {
        const codes = await detector.detect(scannerVideo);
        if (codes.length && codes[0].rawValue) {
          target.value = codes[0].rawValue;
          stopScanner();
          scannerDialog.close();
          target.dispatchEvent(new Event("input", { bubbles: true }));
          if (target === joinCode) await joinRoom(target.value);
          else if (target === answerCode) showToast("Reply code scanned. Ask the room creator to scan it or paste it into their room.");
          else await completeConnection(target.value);
          return;
        }
      } catch {
        scannerStatus.textContent = "Couldn’t read this QR code. Hold it steady and try again.";
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
  document.querySelector("#remote-answer").value = "";
  setupError.hidden = true;
  showView(setupView);
}

createButton.addEventListener("click", createRoom);

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void joinRoom(joinCode.value);
});

document.querySelector("#answer-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void completeConnection(document.querySelector("#remote-answer").value);
});

document.querySelector("#back-button").addEventListener("click", disconnect);
document.querySelector("#disconnect-button").addEventListener("click", disconnect);

document.querySelector("#copy-offer-button").addEventListener("click", () => {
  void copyCode(document.querySelector("#offer-code"));
});
document.querySelector("#copy-answer-button").addEventListener("click", () => {
  void copyCode(answerCode);
});

document.querySelector("#scan-join-button").addEventListener("click", () => void startScanner(joinCode));
document.querySelector("#scan-remote-answer-button").addEventListener("click", () =>
  void startScanner(document.querySelector("#remote-answer")),
);
document.querySelector("#close-scanner-button").addEventListener("click", () => scannerDialog.close());
scannerDialog.addEventListener("close", stopScanner);

document.querySelector("#file-input").addEventListener("change", (event) => {
  void sendFiles(event.target.files);
  event.target.value = "";
});

const dropZone = document.querySelector("#drop-zone");
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
  if (!text || !dataChannel || dataChannel.readyState !== "open") return;
  dataChannel.send(JSON.stringify({ type: "chat", text }));
  appendMessage(text, true);
  chatInput.value = "";
});

window.addEventListener("beforeunload", () => {
  stopScanner();
  resetPeerConnection();
});
