'use strict';

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

let pc = null;
let dc = null;
let ws = null;
let localStream = null;
let remoteStream = null;
let role = null;
let aesKey = null;
let identity = null;
let peerPublicJwk = null;
let connected = false;
let peerId = Math.random().toString(36).slice(2) + Date.now().toString(36);

const els = {
  status: $('statusPill'),
  myCode: $('myCode'),
  safetyCode: $('safetyCode'),
  room: $('roomInput'),
  ice: $('iceInput'),
  voice: $('voiceCheck'),
  relay: $('relayInput'),
  signalOut: $('signalOut'),
  signalIn: $('signalIn'),
  chatLog: $('chatLog'),
  chatInput: $('chatInput'),
  logBox: $('logBox'),
  remoteAudio: $('remoteAudio'),
};

window.addEventListener('load', async () => {
  bindUi();
  setStatus('Ready', false);
  await loadIdentity();
  els.room.value = localStorage.getItem('room') || randomRoom();
  els.relay.value = localStorage.getItem('relayUrl') || '';
  els.ice.value = localStorage.getItem('iceServers') || els.ice.value;
  log('FayLink started.');
});

function bindUi() {
  $('hostManualBtn').onclick = () => hostManual().catch(showError);
  $('guestManualBtn').onclick = () => guestManual().catch(showError);
  $('hostRelayBtn').onclick = () => connectRelay('host').catch(showError);
  $('guestRelayBtn').onclick = () => connectRelay('guest').catch(showError);
  $('applySignalBtn').onclick = () => applySignal().catch(showError);
  $('copySignalBtn').onclick = copySignal;
  $('sendBtn').onclick = sendChat;
  $('disconnectBtn').onclick = disconnect;
  els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  els.room.addEventListener('change', () => localStorage.setItem('room', els.room.value.trim()));
  els.relay.addEventListener('change', () => localStorage.setItem('relayUrl', els.relay.value.trim()));
  els.ice.addEventListener('change', () => localStorage.setItem('iceServers', els.ice.value.trim()));
}

function randomRoom() {
  return 'room-' + Math.random().toString(36).slice(2, 8);
}

async function loadIdentity() {
  const savedPriv = localStorage.getItem('faylink_private_jwk');
  const savedPub = localStorage.getItem('faylink_public_jwk');
  if (savedPriv && savedPub) {
    const privateKey = await crypto.subtle.importKey(
      'jwk', JSON.parse(savedPriv), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']
    );
    identity = { privateKey, publicJwk: JSON.parse(savedPub) };
  } else {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']
    );
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    localStorage.setItem('faylink_private_jwk', JSON.stringify(privateJwk));
    localStorage.setItem('faylink_public_jwk', JSON.stringify(publicJwk));
    identity = { privateKey: keyPair.privateKey, publicJwk };
  }
  const code = await shortHash(stableJson(identity.publicJwk));
  els.myCode.textContent = code.match(/.{1,4}/g).join('-');
}

function createPeer() {
  cleanupPeerOnly();
  const iceServers = parseIceServers(els.ice.value.trim());
  pc = new RTCPeerConnection({ iceServers });

  pc.onconnectionstatechange = () => {
    log('Peer state: ' + pc.connectionState);
    if (pc.connectionState === 'connected') {
      connected = true;
      setStatus('Direct P2P connected', true);
      addSystem('Direct P2P connected. Relay/manual signal is no longer used for chat.');
    }
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      if (pc.connectionState !== 'closed') setStatus('Connection ' + pc.connectionState, false);
    }
  };

  pc.oniceconnectionstatechange = () => log('ICE state: ' + pc.iceConnectionState);

  pc.ontrack = (event) => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      els.remoteAudio.srcObject = remoteStream;
    }
    remoteStream.addTrack(event.track);
    log('Remote audio track received.');
  };

  return pc;
}

function setupDataChannel(channel) {
  dc = channel;
  dc.onopen = () => {
    log('Data channel open.');
    sendPlain({ type: 'identity', publicKey: identity.publicJwk });
    setStatus('Secure handshake…', false);
  };
  dc.onclose = () => log('Data channel closed.');
  dc.onerror = (event) => log('Data channel error: ' + JSON.stringify(event));
  dc.onmessage = (event) => handleDataMessage(event.data).catch(showError);
}

async function addLocalAudioIfNeeded() {
  if (!els.voice.checked) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This Android WebView does not expose microphone/WebRTC media APIs. Update Android System WebView or Chrome.');
  }
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }
  log('Microphone enabled.');
}

async function hostManual() {
  role = 'host';
  setStatus('Creating manual offer…', false);
  createPeer();
  setupDataChannel(pc.createDataChannel('secure-chat'));
  await addLocalAudioIfNeeded();
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  await waitForIceComplete();
  const signal = { app: 'FayLink', version: 1, type: 'offer', sdp: pc.localDescription };
  outputSignal(signal);
  addSystem('Offer created. Send it to the guest phone.');
  setStatus('Waiting for answer', false);
}

async function guestManual() {
  role = 'guest';
  const text = els.signalIn.value.trim();
  if (!text) throw new Error('Paste the host offer first.');
  const signal = parseSignal(text);
  if (signal.type !== 'offer') throw new Error('Guest needs an offer signal from the host.');
  setStatus('Creating manual answer…', false);
  await acceptOfferAndCreateAnswer(signal.sdp);
}

async function acceptOfferAndCreateAnswer(offerSdp) {
  createPeer();
  pc.ondatachannel = (event) => setupDataChannel(event.channel);
  await addLocalAudioIfNeeded();
  await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceComplete();
  const signal = { app: 'FayLink', version: 1, type: 'answer', sdp: pc.localDescription };
  outputSignal(signal);
  addSystem('Answer created. Send it back to the host.');
  if (ws && ws.readyState === WebSocket.OPEN) sendRelay(signal);
  setStatus('Waiting for direct connection', false);
}

async function applySignal() {
  const text = els.signalIn.value.trim();
  if (!text) throw new Error('Paste a signal first.');
  const signal = parseSignal(text);
  if (signal.type === 'offer') {
    role = 'guest';
    await acceptOfferAndCreateAnswer(signal.sdp);
  } else if (signal.type === 'answer') {
    if (!pc) throw new Error('Create a host offer first, then paste the guest answer.');
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    addSystem('Answer applied. Trying direct connection…');
    setStatus('Trying direct connection', false);
  } else {
    throw new Error('Unknown signal type.');
  }
}

async function connectRelay(selectedRole) {
  role = selectedRole;
  const relayUrl = els.relay.value.trim();
  const room = els.room.value.trim();
  if (!relayUrl) throw new Error('Enter a signaling relay URL, or use manual mode.');
  if (!room) throw new Error('Enter a room ID.');
  localStorage.setItem('relayUrl', relayUrl);
  localStorage.setItem('room', room);
  setStatus('Connecting to relay…', false);

  const url = new URL(relayUrl);
  url.searchParams.set('room', room);
  url.searchParams.set('peer', peerId);
  ws = new WebSocket(url.toString());

  ws.onopen = async () => {
    log('Relay connected.');
    addSystem('Relay connected for discovery/signaling only.');
    if (role === 'host') {
      createPeer();
      setupDataChannel(pc.createDataChannel('secure-chat'));
      await addLocalAudioIfNeeded();
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await waitForIceComplete();
      const signal = { app: 'FayLink', version: 1, type: 'offer', sdp: pc.localDescription };
      outputSignal(signal);
      sendRelay(signal);
      setStatus('Offer sent through relay', false);
    } else {
      setStatus('Waiting for relay offer', false);
    }
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.peer === peerId) return;
    if (msg.type === 'offer' && role === 'guest') {
      log('Relay offer received.');
      await acceptOfferAndCreateAnswer(msg.sdp);
    } else if (msg.type === 'answer' && role === 'host') {
      log('Relay answer received.');
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      setStatus('Trying direct connection', false);
    }
  };

  ws.onerror = () => showError(new Error('Relay connection error. Check URL and internet/local network.'));
  ws.onclose = () => log('Relay closed.');
}

function sendRelay(signal) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...signal, room: els.room.value.trim(), peer: peerId }));
  }
}

async function waitForIceComplete(timeoutMs = 8000) {
  if (!pc) return;
  if (pc.iceGatheringState === 'complete') return;
  await new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    setTimeout(done, timeoutMs);
  });
}

function outputSignal(signal) {
  els.signalOut.value = btoa(unescape(encodeURIComponent(JSON.stringify(signal))));
}

function parseSignal(text) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(text))));
  } catch (_) {
    return JSON.parse(text);
  }
}

async function copySignal() {
  if (!els.signalOut.value) return;
  try {
    await navigator.clipboard.writeText(els.signalOut.value);
    addSystem('Signal copied.');
  } catch (e) {
    els.signalOut.select();
    document.execCommand('copy');
    addSystem('Signal selected/copied.');
  }
}

function parseIceServers(value) {
  if (!value) return [];
  return value.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(url => ({ urls: url }));
}

function sendPlain(obj) {
  if (!dc || dc.readyState !== 'open') return;
  dc.send(JSON.stringify(obj));
}

async function handleDataMessage(raw) {
  const msg = JSON.parse(raw);
  if (msg.type === 'identity') {
    peerPublicJwk = msg.publicKey;
    await deriveSharedKey();
    const code = await safetyCode(identity.publicJwk, peerPublicJwk);
    els.safetyCode.textContent = code.match(/.{1,4}/g).join('-');
    setStatus('E2EE chat ready', true);
    addSystem('E2EE chat key ready. Compare safety code with the other phone.');
    return;
  }
  if (msg.type === 'chat') {
    if (!aesKey) throw new Error('Encrypted message arrived before key handshake finished.');
    const iv = b64ToBytes(msg.iv);
    const data = b64ToBytes(msg.data);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, data);
    addMessage(dec.decode(plain), 'peer');
  }
}

async function deriveSharedKey() {
  const remoteKey = await crypto.subtle.importKey(
    'jwk', peerPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  aesKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: remoteKey },
    identity.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  if (!dc || dc.readyState !== 'open') return showError(new Error('Not connected yet.'));
  if (!aesKey) return showError(new Error('E2EE handshake not ready yet. Wait a second.'));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(text));
  sendPlain({ type: 'chat', iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(cipher)) });
  addMessage(text, 'me');
  els.chatInput.value = '';
}

function addMessage(text, who) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  div.textContent = text;
  els.chatLog.appendChild(div);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'system';
  div.textContent = text;
  els.chatLog.appendChild(div);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function setStatus(text, ok) {
  els.status.textContent = text;
  els.status.classList.toggle('connected', !!ok);
  els.status.classList.toggle('error', false);
}

function showError(error) {
  const message = error && error.message ? error.message : String(error);
  els.status.textContent = 'Error';
  els.status.classList.remove('connected');
  els.status.classList.add('error');
  addSystem('Error: ' + message);
  log('ERROR: ' + message);
}

function log(text) {
  const line = '[' + new Date().toLocaleTimeString() + '] ' + text;
  els.logBox.textContent += line + '\n';
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

function disconnect() {
  cleanupPeerOnly();
  if (ws) { try { ws.close(); } catch (_) {} }
  ws = null;
  aesKey = null;
  peerPublicJwk = null;
  connected = false;
  els.safetyCode.textContent = 'Not connected';
  setStatus('Disconnected', false);
  addSystem('Disconnected.');
}

function cleanupPeerOnly() {
  if (dc) { try { dc.close(); } catch (_) {} }
  dc = null;
  if (pc) { try { pc.close(); } catch (_) {} }
  pc = null;
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  localStream = null;
  remoteStream = null;
  els.remoteAudio.srcObject = null;
  aesKey = null;
  peerPublicJwk = null;
}

async function shortHash(text) {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24).toUpperCase();
}

async function safetyCode(a, b) {
  const values = [stableJson(a), stableJson(b)].sort().join('|');
  return shortHash(values);
}

function stableJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableJson).join(',') + ']';
  return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + stableJson(obj[k])).join(',') + '}';
}

function bytesToB64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
