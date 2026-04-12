export interface IceCandidateEntry {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export interface PeerConnectionOptions {
  peerId: string;
  iceServers: RTCIceServer[];
  onIceCandidate: (entry: IceCandidateEntry) => void;
  onConnectionStateChange: (state: RTCPeerConnectionState) => void;
  onIceConnectionStateChange: (state: RTCIceConnectionState) => void;
  onIceCandidateError: (e: RTCPeerConnectionIceErrorEvent) => void;
  onSignalingStateChange: (state: RTCSignalingState) => void;
  onTrack?: (event: RTCTrackEvent) => void;
}

export function createCandidateDedupeSet(): Set<string> {
  return new Set<string>();
}

export function createPeerConnection(
  opts: PeerConnectionOptions
): RTCPeerConnection {
  const config: RTCConfiguration = {
    iceServers: opts.iceServers,
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  };

  const pc: RTCPeerConnection = new RTCPeerConnection(config);

  pc.onicecandidate = (event: RTCPeerConnectionIceEvent): void => {
    if (!event.candidate) {
      console.log(`[ICE][gathering][${opts.peerId}] complete — no more candidates`);
      return;
    }
    const c = event.candidate;
    const parts = c.candidate.split(' ');
    const type = parts[7] || 'unknown';
    console.log(`[ICE][candidate][${opts.peerId}] type=${type} proto=${c.protocol} addr=${c.address ?? '?'}:${c.port ?? '?'}`);
    console.log(`[ICE][candidate][${opts.peerId}] full: ${c.candidate}`);
    opts.onIceCandidate({
      candidate: c.candidate,
      sdpMid: c.sdpMid,
      sdpMLineIndex: c.sdpMLineIndex,
    });
  };

  pc.onicegatheringstatechange = (): void => {
    console.log(`[ICE][gathering][${opts.peerId}] ${pc.iceGatheringState} @ ${Date.now()}`);
  };

  pc.onicecandidateerror = (event: RTCPeerConnectionIceErrorEvent): void => {
    if (event.errorCode !== 487) {
      console.error(
        '[ICE][error] code=%d url=%s msg=%s',
        event.errorCode,
        event.url,
        event.errorText
      );
      opts.onIceCandidateError(event);
    }
  };

  pc.onconnectionstatechange = (): void => {
    console.log('[ICE][connection]', pc.connectionState);
    opts.onConnectionStateChange(pc.connectionState);
  };

  pc.oniceconnectionstatechange = (): void => {
    console.log('[ICE][iceConnection]', pc.iceConnectionState);
    opts.onIceConnectionStateChange(pc.iceConnectionState);
  };

  pc.onsignalingstatechange = (): void => {
    console.log('[ICE][signaling]', pc.signalingState);
    opts.onSignalingStateChange(pc.signalingState);
  };

  if (opts.onTrack) {
    pc.ontrack = opts.onTrack;
  }

  return pc;
}

export async function safeAddIceCandidate(
  pc: RTCPeerConnection,
  dedupeSet: Set<string>,
  entry: IceCandidateEntry
): Promise<void> {
  const key: string = entry.candidate;
  if (dedupeSet.has(key)) {
    console.log('[ICE][dedup] skipped duplicate candidate');
    return;
  }
  dedupeSet.add(key);
  try {
    await pc.addIceCandidate(
      new RTCIceCandidate({
        candidate: entry.candidate,
        sdpMid: entry.sdpMid,
        sdpMLineIndex: entry.sdpMLineIndex,
      })
    );
  } catch (err) {
    console.warn('[ICE][addCandidate] failed (non-fatal):', err);
  }
}

export async function logActiveCandidatePair(
  pc: RTCPeerConnection
): Promise<void> {
  const stats: RTCStatsReport = await pc.getStats();
  stats.forEach((report: RTCStats): void => {
    const maybePair = report as unknown as Record<string, unknown>;
    if (
      report.type === 'candidate-pair' &&
      maybePair.state === 'succeeded' &&
      maybePair.nominated === true
    ) {
      const localId = typeof maybePair.localCandidateId === 'string' ? maybePair.localCandidateId : null;
      const remoteId = typeof maybePair.remoteCandidateId === 'string' ? maybePair.remoteCandidateId : null;
      const local = localId
        ? (stats.get(localId) as unknown as Record<string, unknown> | undefined)
        : undefined;
      const remote = remoteId
        ? (stats.get(remoteId) as unknown as Record<string, unknown> | undefined)
        : undefined;
      const localType = typeof local?.candidateType === 'string' ? local.candidateType : '?';
      const remoteType = typeof remote?.candidateType === 'string' ? remote.candidateType : '?';
      const path =
        localType === 'relay' || remoteType === 'relay'
          ? 'RELAY (TURN)'
          : 'DIRECT (peer-to-peer)';
      const rtt = typeof maybePair.currentRoundTripTime === 'number'
        ? Math.round(maybePair.currentRoundTripTime * 1000)
        : '?';
      console.log(
        '[ICE][path] %s | local=%s remote=%s rtt=%sms',
        path,
        localType,
        remoteType,
        rtt
      );
    }
  });
}
