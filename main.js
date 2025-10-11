import {wrapRTCStatsWithDefaultOptions} from '@rtcstats/rtcstats-js';

// When offerCallback is set, don't auto-answer incoming calls.
let offerCallback = null;

// Mapping of remote metadata such as stream ids to content type.
const remoteMetadata = new Map();

// Mapping of local stream ids to content type. Javascript object for easy
// serialization.
const localMetadata = {};

// Whether to use trickle-ice which is the default,
// making call setup faster.
const useTrickleIce = true;

// Audio and video muting.
const audioBtn = document.getElementById('audioBtn');
audioBtn.addEventListener('click', () => {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack.enabled) {
        audioBtn.classList.add('muted');
    } else {
        audioBtn.classList.remove('muted');
    }
    audioTrack.enabled = !audioTrack.enabled;
});
const videoBtn = document.getElementById('videoBtn');
videoBtn.addEventListener('click', async () => {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack.enabled) {
        videoBtn.classList.add('muted');
    } else {
        videoBtn.classList.remove('muted');
    }
    videoTrack.enabled = !videoTrack.enabled;

    // The advanced version of this stops the track to disable and uses
    // replaceTrack to re-enable. Not necessary in Firefox which turns
    // off the camera light.
    if (videoTrack.enabled == false) {
        // Wait five seconds in case the user mutes by accident.
        setTimeout(async () => {
            if (videoTrack.enabled === false) {
                videoTrack.stop();
            }
        }, 5000);
    } else if (videoTrack.readyState === 'ended') {
        // We need to restart the camera and do replaceTrack.
        // Note that you should be using the same setting as when
        // getting the initial track. Either store those or use
        // track.getSettings() to get them.
        const stream = await navigator.mediaDevices.getUserMedia({video: true});
        const newTrack = stream.getTracks()[0];
        replaceVideoTrack(newTrack);
        // Pushing the new track before removing the old track avoids stopping the
        // stream.
        localStream.addTrack(newTrack);
        localStream.removeTrack(videoTrack);
    }
});

// Relatively self-contained screensharing/replaceTrack example.
let screenShare;
function replaceVideoTrack(withTrack) {
    peers.forEach(pc => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
            sender.replaceTrack(withTrack);
        }
    });
}
const shareBtn = document.getElementById('shareBtn');
shareBtn.addEventListener('click', async () => {
    if (screenShare) { // click-to-end.
        screenShare.getTracks().forEach(t => t.stop());
        screenShare = null;
        document.getElementById('localVideo').srcObject = localStream;
        replaceVideoTrack(localStream.getVideoTracks()[0]);
        shareBtn.classList.remove('sharing');
        return;
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({video: true});
    const track = stream.getVideoTracks()[0];
    replaceVideoTrack(track);
    document.getElementById('localVideo').srcObject = stream;
    track.addEventListener('ended', () => {
        console.log('Screensharing ended via the browser UI');
        screenShare = null;
        document.getElementById('localVideo').srcObject = localStream;
        replaceVideoTrack(localStream.getVideoTracks()[0]);
        shareBtn.classList.remove('sharing');
    });
    screenShare = stream;
    shareBtn.classList.add('sharing');
    // Here we might want to do a new signalling message that tells the other end we
    // changed our video source.
});

const copyBtn = document.getElementById('copyBtn');
copyBtn.onclick = () => {
    navigator.clipboard.writeText(document.getElementById('clientId').innerText);
};

// When clicking the hangup button, any connections will be closed.
const hangupBtn = document.getElementById('hangupButton');
hangupBtn.addEventListener('click', () => {
    hangupBtn.disabled = true;
    peers.forEach((pc, id) => {
        hangup(id);
    });
});

// Change the video bandwidth for all peers.
const bandwidthSelector = document.querySelector('select#bandwidth');
bandwidthSelector.onchange = () => {
    bandwidthSelector.disabled = true;
    const bandwidth = bandwidthSelector.options[bandwidthSelector.selectedIndex].value;
    if (!('RTCRtpSender' in window && 'setParameters' in window.RTCRtpSender.prototype)) {
        return; // Not supported.
    }
    peers.forEach((pc) => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (!sender) {
            return;
        }
        const parameters = sender.getParameters();
        if (!parameters.encodings) { // Firefox workaround.
          parameters.encodings = [{}];
        }

        if (bandwidth === 'unlimited') {
          delete parameters.encodings[0].maxBitrate;
        } else {
          parameters.encodings[0].maxBitrate = bandwidth * 1000;
        }
        sender.setParameters(parameters)
            .then(() => {
              bandwidthSelector.disabled = false;
            })
            .catch(e => console.error(e));
    });
}

// Change the video codec.
const codecPreferences = document.querySelector('#codecPreferences');
const supportsSetCodecPreferences = window.RTCRtpTransceiver &&
  'setCodecPreferences' in window.RTCRtpTransceiver.prototype;
if (supportsSetCodecPreferences && codecPreferences) {
    const {codecs} = RTCRtpReceiver.getCapabilities('video');
    codecs.forEach(codec => {
        if (['video/red', 'video/ulpfec', 'video/rtx', 'video/flexfec-03'].includes(codec.mimeType)) {
            return;
        }
        const option = document.createElement('option');
        option.value = (codec.mimeType + ' ' + (codec.sdpFmtpLine || '')).trim();
        option.innerText = option.value;
        codecPreferences.appendChild(option);
    });
    codecPreferences.disabled = false;
}

const connectionState = document.getElementById('connectionState');

// We connect to the same server and same protocol. Note that in production
// you will end up connecting to wss (secure websockets) all the time.
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const peers = new Map(); // A map of all peer ids to their peerconnections.
let clientId; // our client id.
let ws; // our websocket.
let localStream; // local stream to be acquired from getUserMedia.
let iceServers = null; // the latest iceServers we got from the signaling server.
window.iceTransportPolicy = undefined; // Can be set to 'relay' to force TURN.

async function getUserMedia() {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true, video: true});
    document.getElementById('localVideo').srcObject = stream;
    localStream = stream;
    // Associate metadata with the stream id.
    localMetadata[stream.id] = 'webcam';
    return stream;
}

// Connect the websocket and listen for messages.
function connect() {
    return new Promise((resolve, reject) => {
        ws = new WebSocket(protocol + '://' + window.location.host);
        ws.addEventListener('open', () => {
            // wait until we have received the iceServers message.
            // resolve();
            console.log('websocket opened');
        });
        ws.addEventListener('error', (e) => {
            console.log('websocket error, is the server running?', e);
            reject(e);
        });
        ws.addEventListener('close', (e) => {
            console.log('websocket closed', e);
        });
        ws.addEventListener('message', async (e) => {
            let data;
            try {
                data = JSON.parse(e.data);
            } catch(err) {
                console.log('Received invalid JSON', err, e.data);
                return;
            }
            switch(data.type) {
            case 'hello':
                clientId = data.id;
                document.getElementById('clientId').innerText = clientId;
                break;
            case 'iceServers':
                iceServers = data.iceServers;
                resolve(); // resolve the promise only now so we always have an ice server configuration
                break;
            case 'bye':
                if (peers.has(data.id)) {
                    peers.get(data.id).close();
                    peers.delete(data.id);
                    remoteMetadata.delete(data.id);
                } else {
                    console.log('Peer not found', data.id);
                }
                break;
            case 'offer':
                if (!peers.has(data.id)) {
                    console.log('Incoming call from', data.id);
                    document.getElementById('peerId').innerText = data.id;
                    if (peers.size >= 1) { // Already in a call. Reject.
                        console.log('Already in a call, rejecting');
                        ws.send(JSON.stringify({
                            type: 'bye',
                            id: data.id,
                        }));
                        return;
                    }
                    console.log('offer metadata', data.metadata);
                    remoteMetadata.set(data.id, data.metadata); // overwrite metadata.
                    // Create a new peer.
                    const pc = createPeerConnection(data.id);
                    if (localStream) {
                        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
                    }
                    await pc.setRemoteDescription({
                        type: data.type,
                        sdp: data.sdp
                    });

                    // Automatically answering is appropriate for things like multi-user chats.
                    // It is not for 1:1 typically.
                    if (!offerCallback) {
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        if (useTrickleIce) {
                            ws.send(JSON.stringify({
                                type: 'answer',
                                sdp: answer.sdp,
                                id: data.id,
                                metadata: localMetadata, // metadata, full and not incremental.
                            }));
                        }
                    } else {
                        offerCallback(data.id);
                    }
                    hangupBtn.disabled = false;
                } else {
                    console.log('Subsequent offer not implemented');
                }
                break;
            case 'answer':
                if (peers.has(data.id)) {
                    console.log('answer metadata', data.metadata, data);
                    remoteMetadata.set(data.id, data.metadata); // overwrite metadata.
                    const pc = peers.get(data.id);
                    await pc.setRemoteDescription({
                        type: data.type,
                        sdp: data.sdp
                    });
                } else {
                    console.log('Peer not found', data.id);
                }
                break;
            case 'candidate':
                if (peers.has(data.id)) {
                    const pc = peers.get(data.id);
                    console.log('addIceCandidate', data);
                    await pc.addIceCandidate(data.candidate);
                } else {
                    console.log('Peer not found', data.id);
                }
                break;
            case 'rtcstats':
                // Connect to the rtcstats-server instance.
                trace.connect(data.url + window.location.pathname + '?rtcstats-token=' + data.token);
                break;

            default:
                console.log('Unhandled', data);
                break;
            }
        });
    });
}

// Helper function to create a peerconnection and set up a couple of useful
// event listeners.
function createPeerConnection(id) {
    const pc = new RTCPeerConnection({iceServers, iceTransportPolicy});
    let signalledCandidates = false;
    pc.addEventListener('icecandidate', (e) => {
        const {candidate} = e;
        /*
         * the following code block demonstrates a failure to connect.
         * Do not use in production.
        if (candidate && candidate.candidate !== '') {
            const parts = candidate.candidate.split(' ');
            parts[5] = 10000; // replace port with 10000 to make ice fail.
            ws.send(JSON.stringify({
                type: 'candidate',
                candidate: {
                    candidate: parts.join(' '),
                    sdpMid: candidate.sdpMid,
                    sdpMLineIndex: candidate.sdpMLineIndex,
                },
                id,
            }));
            return;
        }
        */
        if (useTrickleIce) {
            ws.send(JSON.stringify({
                type: 'candidate',
                candidate,
                id,
            }));
        } else if (!signalledCandidates) {
            // Signal the full offer/answer including the candidates which
            // are added automatically on two conditions:
            // 1. when e.candidate is not set (which is a legacy way of saying
            //    ICE gathering is done (and icegatheringstate is now complete)
            // 2. when you see a relay candidate. This avoids a 15s timeout in
            //    ICE gathering on machines with multiple interfaces where on
            //    of them is not routable.
            if (!candidate || candidate.type === 'relay') {
                signalledCandidates = true;
                ws.send(JSON.stringify({
                    type: pc.localDescription.type,
                    sdp: pc.localDescription.sdp,
                    id,
                    metadata: localMetadata, // metadata, full and not incremental.
                }));
            }
        }
    });
    pc.addEventListener('track', (e) => {
        const remoteVideo = document.getElementById('remoteVideo');
        remoteVideo.onloadedmetadata = () => {
            // called when the first frame is rendered.
            console.log(id, 'loaded metadata');
        };
        remoteVideo.srcObject = e.streams[0];
        connectionState.style.display = 'block';
        // Log remote metadata. Currently assumed to be a {streamid => metadata} object.
        if (remoteMetadata.has(id)) {
            console.log('metadata', e.streams[0].id, remoteMetadata.get(id)[e.streams[0].id]);
        }
    });
    pc.addEventListener('iceconnectionstatechange', () => {
        console.log(id, 'iceconnectionstatechange', pc.iceConnectionState);
    });
    pc.addEventListener('connectionstatechange', () => {
        console.log(id, 'connectionstatechange', pc.connectionState);
        if (pc.connectionState === 'connected') {
            hangupBtn.disabled = false;
            pc.getStats().then(onConnectionStats);
        }
    });
    pc.addEventListener('signalingstatechange', () => {
        console.log(id, 'signalingstatechange', pc.signalingState);
    });
    pc.addEventListener('icegatheringstatechange', () => {
        console.log(id, 'icegatheringstatechange', pc.iceGatheringState);
    });

    let lastResult = null; // the last getStats result.
    const intervalId = setInterval(async () => {
        if (pc.signalingState === 'closed') {
            clearInterval(intervalId);
            return;
        }
        lastResult = await queryL4SStats(pc, lastResult);
    }, 2000);
    peers.set(id, pc);
    return pc;
}

function onConnectionStats(results) {
  // figure out the peer's ip
  let activeCandidatePair = null;
  let remoteCandidate = null;

  // Search for the candidate pair, spec-way first.
  results.forEach(report => {
    if (report.type === 'transport') {
      activeCandidatePair = results.get(report.selectedCandidatePairId);
    }
  });
  // Fallback for Firefox.
  if (!activeCandidatePair) {
    results.forEach(report => {
      if (report.type === 'candidate-pair' && report.selected) {
        activeCandidatePair = report;
      }
    });
  }
  if (activeCandidatePair && activeCandidatePair.remoteCandidateId) {
    remoteCandidate = results.get(activeCandidatePair.remoteCandidateId);
  }
  if (remoteCandidate) {
    // Statistics are a bit of a mess still...
    console.log('Remote is',
        remoteCandidate.address || remoteCandidate.ip || remoteCandidate.ipAddress,
        remoteCandidate.port || remoteCandidate.portNumber);
  }
}

async function queryL4SStats(pc, lastResult) {
    const stats = await pc.getStats();
    document.getElementById('localStats').innerText = '';
    document.getElementById('remoteStats').innerText = '';
    stats.forEach(report => {
      if (report.type === 'outbound-rtp') {
        const now = report.timestamp;
        const packets = report.packetsSentWithEct1;
        if (lastResult && lastResult.has(report.id)) {
          const packetrate = Math.floor(1000 * (packets - lastResult.get(report.id).packetsSentWithEct1) /
            (now - lastResult.get(report.id).timestamp));
          document.getElementById('localStats').innerText +=
              report.kind + ' ' + report.ssrc +  ' packets sent with ECT1 ' + packets + ' (' + packetrate + '/s)\n';
        }
      } else if (report.type === 'inbound-rtp') {
        const now = report.timestamp;
        const ect1 = report.packetsReceivedWithEct1;
        const ce = report.packetsReceivedWithCe;
        if (lastResult && lastResult.has(report.id)) {
          const packetrate_ect1 = Math.floor(1000 * (ect1 - lastResult.get(report.id).packetsReceivedWithEct1) /
            (now - lastResult.get(report.id).timestamp));
          const packetrate_ce = Math.floor(1000 * (ce - lastResult.get(report.id).packetsReceivedWithCe) /
            (now - lastResult.get(report.id).timestamp));
          document.getElementById('remoteStats').innerText +=
              report.kind + ' ' + report.ssrc + ' packets received with ECT1 ' + ect1 + ' (' + packetrate_ect1 + '/s)\n' +
              report.kind + ' ' + report.ssrc + ' packets received with CE ' + ce + ' (' + packetrate_ce + '/s)\n';
        }
      } else if (report.type === 'transport') {
        const pair = stats.get(report.selectedCandidatePairId);
        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        document.getElementById('localStats').innerText +=
            'Sending from local port ' + local.port;
        if (local.relayProtocol) {
          document.getElementById('localStats').innerText +=
              ' relayProtocol ' + local.relayProtocol + ' server ' + local.url;
        }
        document.getElementById('remoteStats').innerText +=
            'Receiving from remote port ' + remote.port;
      }
    });
    return stats;
}

// Call a peer based on its id. Adds any tracks from the local stream.
async function call(id) {
    if (peers.has(id)) {
        console.log('it seems you are already in a call with', id);
        return;
    }
    const pc = createPeerConnection(id);
    if (localStream) {
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    // Change the codec. Only on the no-autodial page.
    if (supportsSetCodecPreferences && codecPreferences) {
        const preferredCodec = codecPreferences.options[codecPreferences.selectedIndex];
        if (preferredCodec.value !== '') {
            const [mimeType, sdpFmtpLine] = preferredCodec.value.split(' ');
            const {codecs} = RTCRtpReceiver.getCapabilities('video');
            const selectedCodecIndex = codecs.findIndex(c => c.mimeType === mimeType && c.sdpFmtpLine === sdpFmtpLine);
            const selectedCodec = codecs[selectedCodecIndex];
            codecs.slice(selectedCodecIndex, 1);
            codecs.unshift(selectedCodec);
            const transceiver = pc.getTransceivers().find(t => t.sender && t.sender.track === localStream.getVideoTracks()[0]);
            transceiver.setCodecPreferences(codecs);
            console.log('Preferred video codec', selectedCodec);
        }
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (useTrickleIce) {
        ws.send(JSON.stringify({
            type: 'offer',
            sdp: offer.sdp,
            id,
            metadata: localMetadata, // metadata, full and not incremental.
        }));
    }
    hangupBtn.disabled = false;
    document.getElementById('peerId').innerText = id;
}

async function answer(id) {
    if (!peers.has(id)) {
        console.log('can not answer, no peer with', id);
        return;
    }
    const pc = peers.get(id);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (useTrickleIce) {
        ws.send(JSON.stringify({
            type: 'answer',
            sdp: answer.sdp,
            id: id,
            metadata: localMetadata, // metadata, full and not incremental.
        }));
    }
    hangupBtn.disabled = false;
}

// Send a signal to the peer that the call has ended and close the connection.
function hangup(id) {
    if (!peers.has(id)) {
        console.log('no such peer');
        return;
    }
    const pc = peers.get(id);
    pc.close();
    peers.delete(id);
    // Tell the other side
    ws.send(JSON.stringify({
        type: 'bye',
        id,
    }));
    if (codecPreferences) {
        codecPreferences.disabled = !supportsSetCodecPreferences;
    }
}

window.addEventListener('beforeunload', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        peers.forEach((pc, id) => {
            hangup(id);
        });
    }
});

// Instantiate an RTCStats trace function with the defaults.
const trace = wrapRTCStatsWithDefaultOptions();

// Get the camera, then connect to signaling. Makes things simple.
getUserMedia().then((/*stream*/) => {
   return connect();
});

const callBtn = document.getElementById('callButton');
callBtn.addEventListener('click', () => {
    call(document.getElementById('peerId').value);
    callBtn.disabled = true;
});

offerCallback = (id) => { // Setting this disables autoanswer behaviour
    document.getElementById('peerId').value = id;
    answer(id);
};
