/**
 * YouTube adapter (youtube.com pages). Captions come from the page; when there are none the video is
 * listened to, and its slides are scanned, through the page's own <video>.
 *
 * Normally this code does NOT run in the tab the viewer is watching: background.js opens the same
 * watch page in a separate minimized, muted window ("helper") and sends the CAPTURE_* messages there,
 * so the viewer keeps watching at normal speed with sound. Only if that window cannot be used does it
 * run in the viewer's own tab, borrowing the player (paused / muted / restored afterwards, with a banner).
 * Classic script; registers itself in window.__lhAdapters.
 */
(() => {
  const U = window.__lhUtil;
  const player = () => document.querySelector('video.html5-main-video') || document.querySelector('video');
  /** The player state to give back (only matters in the viewer's own tab). */
  let saved = null;
  let stopListening = () => {};
  /** An ad plays in the same <video>. */
  const adShowing = () => !!document.querySelector('.ad-showing');
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const seekTo = (v, t) => new Promise((r) => { const to = setTimeout(r, 4000); v.addEventListener('seeked', () => { clearTimeout(to); r(); }, { once: true }); v.currentTime = t; });

  /**
   * The video's length once the player has really loaded it (0 if it never does). A freshly opened
   * page (the helper window) reports NaN for a while; an ad briefly reports the ad's length.
   * A true live stream stays at Infinity; that is checked by the caller.
   */
  async function realDuration(v) {
    for (let i = 0; i < 60; i++) { // up to ~15 s
      const d = v.duration;
      if (Number.isFinite(d) && d > 0 && !adShowing() && v.readyState >= 1) return d;
      if (d === Infinity && i >= 8) return 0; // stayed infinite after 2 s: really live
      await U.sleep(250);
    }
    return 0;
  }

  /** Pause the player (remember its state) and wait out ads. */
  async function takePlayer(keepRate) {
    const v = player();
    if (!v) throw new Error('No player found on this page.');
    saved = { t: v.currentTime, paused: v.paused, ...(keepRate ? { rate: v.playbackRate, muted: v.muted } : {}) };
    v.pause();
    for (let i = 0; i < 120 && adShowing(); i++) await U.sleep(500);
    if (adShowing()) throw new Error('An ad is still playing.');
    return v;
  }

  /**
   * Play the player muted at `rate`x from the start and stream its audio to the worker page as 16 kHz mono
   * PCM blocks (~5 s), each stamped with the video time it came from. Ads are skipped.
   * Returns { duration } once recording has started; progress / completion arrive as AUDIO_* messages.
   * Driven by audio and media events, not timers: a hidden window throttles timers heavily.
   */
  /**
   * One picture of what the player shows right now (JPEG base64), or null when it is blank (a minimized
   * window may not paint) or unreadable. Used to take the slide pictures WHILE listening, in the same pass.
   */
  async function shot(v, maxWidth) {
    try {
      const k = Math.min(1, maxWidth / (v.videoWidth || maxWidth));
      const c = document.createElement('canvas');
      c.width = Math.round((v.videoWidth || 0) * k);
      c.height = Math.round((v.videoHeight || 0) * k);
      if (!c.width || !c.height) return null;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const px = ctx.getImageData(0, 0, Math.min(64, c.width), Math.min(36, c.height)).data;
      let lit = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 24) lit++;
      if (!lit) return null;
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      return blob ? b64(new Uint8Array(await blob.arrayBuffer())) : null;
    } catch { return null; }
  }

  async function listen(rate, send, { sampleEvery = 0, maxWidth = 1600, maxSamples = 600 } = {}) {
    const v = await takePlayer(true);
    if (!v.captureStream) throw new Error("This browser cannot listen to the page's player.");
    const dur = await realDuration(v);
    if (!dur) throw new Error(v.duration === Infinity
      ? 'Live streams cannot be transcribed.'
      : 'The video player did not load (its length is unknown). Reload the page and try again.');
    v.muted = true;
    v.playbackRate = rate;
    // The audio track of a captured stream only appears once the media has played:
    // start it, wait for the track, then go back to the beginning.
    await v.play();
    const stream = v.captureStream();
    let tracks = stream.getAudioTracks();
    for (let i = 0; i < 25 && !tracks.length; i++) { await U.sleep(200); tracks = stream.getAudioTracks(); }
    v.pause();
    if (!tracks.length) throw new Error('The player has no audio to listen to (protected video?).');
    await seekTo(v, 0);

    const ac = new AudioContext({ sampleRate: 16000 });
    await ac.resume();
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const quiet = ac.createGain();
    quiet.gain.value = 0; // the tap must reach the destination to run, but stay inaudible
    ac.createMediaStreamSource(new MediaStream(tracks)).connect(proc);
    proc.connect(quiet);
    quiet.connect(ac.destination);

    let buf = [], bufN = 0, seq = 0, t0 = 0, peak = 0, over = false, unmuted = false, lastReport = 0;
    // pictures for the slide scan, on the same grid the scan uses (so it never has to play the video again)
    const step = sampleEvery > 0 ? Math.max(sampleEvery, dur / maxSamples) : 0;
    let nextShot = 0, shooting = false;
    const maybeShoot = () => {
      if (!step || shooting || v.currentTime < nextShot) return;
      shooting = true;
      const t = v.currentTime;
      nextShot = (Math.floor(t / step) + 1) * step;
      shot(v, maxWidth).then((data) => { if (data && !over) send({ type: 'FRAME_SAMPLE', t, b64: data }); }).finally(() => { shooting = false; });
    };
    const started = Date.now();
    const flush = () => {
      if (!bufN) return;
      const pcm = new Int16Array(bufN);
      let o = 0;
      for (const b of buf) { pcm.set(b, o); o += b.length; }
      send({ type: 'AUDIO_CHUNK', seq: seq++, n: bufN, t0, t1: v.currentTime, b64: b64(new Uint8Array(pcm.buffer)) });
      buf = []; bufN = 0;
    };
    const finish = (msg) => {
      if (over) return;
      over = true;
      flush();
      try { v.pause(); proc.disconnect(); ac.close(); } catch { /* already closed */ }
      send(msg);
    };
    proc.onaudioprocess = (e) => {
      if (over) return;
      const ad = adShowing();
      const now = Date.now();
      if (now - lastReport > 900) { // progress and checks ride on the audio callback (about 4x a second)
        lastReport = now;
        if (v.ended || v.currentTime >= dur - 0.3) return finish({ type: 'AUDIO_DONE', duration: dur });
        if (!v.isConnected) return finish({ type: 'AUDIO_ERROR', message: 'The page changed while the video was being heard.' });
        // If nothing came through while muted, let the element play audibly (the helper tab is muted by the browser anyway).
        if (!unmuted && !ad && now - started > 9000 && v.currentTime > 6 && peak < 1e-4) { unmuted = true; v.muted = false; }
        send({ type: 'AUDIO_PROGRESS', t: v.currentTime, duration: dur, ad });
      }
      if (ad || v.paused) return;
      maybeShoot();
      const d = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(d.length);
      for (let i = 0; i < d.length; i++) { const s = Math.max(-1, Math.min(1, d[i])); i16[i] = s < 0 ? s * 32768 : s * 32767; if (Math.abs(s) > peak) peak = Math.abs(s); }
      if (!bufN) t0 = Math.max(0, v.currentTime - (d.length / 16000) * v.playbackRate);
      buf.push(i16); bufN += i16.length;
      if (bufN >= 16000 * 5) flush();
    };
    v.addEventListener('ended', () => finish({ type: 'AUDIO_DONE', duration: dur }), { once: true });
    // Stop just BEFORE the end: once the video ends, YouTube's autoplay moves the page to the next video,
    // which would lose this job's player (and later frame grabs would come from the wrong video).
    const nearEnd = () => {
      if (over) return v.removeEventListener('timeupdate', nearEnd);
      if (v.currentTime >= dur - 0.5) { v.pause(); v.removeEventListener('timeupdate', nearEnd); finish({ type: 'AUDIO_DONE', duration: dur }); }
    };
    v.addEventListener('timeupdate', nearEnd);
    stopListening = () => finish({ type: 'AUDIO_DONE', duration: dur });
    await v.play();
    return { duration: dur, sampleStep: step };
  }

  window.__lhAdapters.push({
    id: 'youtube',
    match: (loc) => /(^|\.)youtube\.com$/.test(loc.hostname),
    refererFor: () => 'https://www.youtube.com/',
    getContext: () => ({ course: U.text(document.querySelector('ytd-channel-name a, #owner #channel-name a')) || 'YouTube' }),
    getTitle: () => U.text(document.querySelector('ytd-watch-metadata h1, h1.title')) || document.title.replace(/ - YouTube$/, ''),
    getVideos() {
      const id = U.ytId(location.href);
      if (!id) return [];
      return [{ id: `yt:${id}`, kind: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, youtubeId: id, title: this.getTitle(), tracks: [] }];
    },
    /** Frame capture and listening (see the CAPTURE_* messages in content.js). */
    capture: {
      async begin() {
        const v = await takePlayer(false);
        return { duration: (await realDuration(v)) || v.duration, width: v.videoWidth, height: v.videoHeight };
      },
      // never seek to the very end: an ended video makes YouTube autoplay the next one
      frame: (t, maxWidth) => { const v = player(); return U.grabFrame(v, Number.isFinite(v?.duration) ? Math.min(t, Math.max(0, v.duration - 1)) : t, maxWidth); },
      listen,
      stopListening() { stopListening(); },
      /** Put the player back where it was (the viewer's own tab only matters; harmless in the helper window). */
      async end(helper) {
        const v = player();
        if (!v || !saved) return;
        const s = saved;
        saved = null;
        if (s.rate) v.playbackRate = s.rate;
        if (s.muted != null) v.muted = s.muted;
        await seekTo(v, s.t);
        // Never resume in the background window: it would play on to the end and autoplay the next video.
        if (!s.paused && !helper) v.play().catch(() => {});
      }
    }
  });
})();
