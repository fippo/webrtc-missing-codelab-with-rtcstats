import {wrapRTCPeerConnection} from '@rtcstats/rtcstats-js';
import {wrapGetUserMedia, wrapEnumerateDevices} from '@rtcstats/rtcstats-js';
import {WebSocketTrace} from '@rtcstats/rtcstats-js';

// Instantiate a trace function, e.g. as an instance of the Websocket trace.
const trace = WebSocketTrace();

// Wrap RTCPeerConnection-related APIs and events
wrapRTCPeerConnection(trace, window, {getStatsInterval: 1000});
// Wrap getUserMedia, getDisplayMedia and related events.
wrapGetUserMedia(trace, window);
// Wrap enumerateDevices.
wrapEnumerateDevices(trace, window);

// Connect to the rtcstats-server instance.
trace.connect('wss://clownfish-stats-uk8td.ondigitalocean.app' + window.location.pathname);

