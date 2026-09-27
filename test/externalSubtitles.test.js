const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { auditExternalSynchronization, publicCandidate, createExternalSubtitleSession, repairIncidentalSyncOverlaps, selectVerifiedExternalTimings } = require("../src/services/externalSubtitles");
const { prepareSubtitleSource, selectSubtitleSource } = require("../src/services/subtitleSource");
const { isTargetSubtitleLocale } = require("../src/services/languageStrategy");
const { serializeVtt } = require("../src/services/vtt");
const { formatTimestamp } = require("../src/services/subtitleQuality");
const cue = (start, end, text) => ({ time: `${formatTimestamp(start)} --> ${formatTimestamp(end)}`, text });
const raw = serializeVtt([cue(11, 13, "First."), cue(51, 53, "After cut.")]);
const synced = serializeVtt([cue(1, 3, "First."), cue(21, 23, "After cut.")]);
const speech = [{ start: 1, end: 3 }, { start: 21, end: 23 }];

test("small overlaps introduced by synchronization are trimmed without dropping dialogue", () => {
  const original = serializeVtt([cue(1, 3, "First."), cue(3.5, 5, "Second."), cue(6, 8, "Third.")]);
  const aligned = serializeVtt([cue(1, 4, "First."), cue(3.5, 5, "Second."), cue(6, 8, "Third.")]);
  const repaired = repairIncidentalSyncOverlaps(original, aligned);
  assert.equal(repaired.repairedOverlaps, 1);
  assert.match(repaired.vtt, /00:00:01\.000 --> 00:00:03\.480/);
  assert.doesNotThrow(() => auditExternalSynchronization(original, repaired.vtt, [{ start: 1, end: 8 }], 10));
});

test("large or widespread sync collisions still reject the external subtitle", () => {
  const original = serializeVtt([cue(1, 3, "First."), cue(4, 6, "Second.")]);
  const badlyAligned = serializeVtt([cue(1, 7, "First."), cue(4, 6, "Second.")]);
  const repaired = repairIncidentalSyncOverlaps(original, badlyAligned);
  assert.equal(repaired.repairedOverlaps, 0);
  assert.equal(repaired.vtt, badlyAligned);
});

test("uses original API timings when the aligner collapses the opening but audio and embedded packets confirm them", async () => {
  const originalCues = Array.from({ length: 40 }, (_, index) => cue(index * 3 + 1, index * 3 + 2, `Dialogue ${index}`));
  const result = {
    rawVtt: serializeVtt(originalCues),
    vtt: serializeVtt(originalCues.map((item, index) => index < 5 ? cue(0, 1, item.text) : item)),
    speechIntervals: originalCues.map((_, index) => ({ start: index * 3 + 1, end: index * 3 + 2 })),
  };
  const reference = { authoritative: true, trackIndex: 4, kind: "pgs-display-timestamps",
    intervals: originalCues.map((_, index) => ({ start: index * 3 + 1, end: index * 3 + 1.01 })) };
  const verified = await selectVerifiedExternalTimings(result, 125, undefined, async () => reference);
  assert.equal(verified.vtt, result.rawVtt);
  assert.equal(verified.audit.method, "original-verified");
  assert.equal(verified.audit.embeddedReference.approved, true);
  await assert.rejects(selectVerifiedExternalTimings(result, 125, undefined, async () => null), /sobreposições excessivas/);
});

test("a different middle cut is audited using the actual speech intervals", () => {
  const audit = auditExternalSynchronization(raw, synced, speech, 60);
  assert.equal(audit.coverageRatio, 1);
  assert.equal(audit.adjustedBySections, true);
  assert.equal(audit.minimumOffsetSeconds, -30);
  assert.equal(audit.maximumOffsetSeconds, -10);
  assert.equal(audit.semanticMatchVerified, false);
});

test("timing adjustment cannot delete text or hide missing dialogue", () => {
  assert.throws(() => auditExternalSynchronization(raw, serializeVtt([cue(1, 3, "First.")]), speech, 60), /perdeu falas/);
  assert.throws(() => auditExternalSynchronization(raw, synced, [...speech, { start: 30, end: 59 }], 60), /insuficiente/);
  assert.throws(() => auditExternalSynchronization(raw, raw, speech, 60), /insuficiente/);
  assert.throws(() => auditExternalSynchronization(raw, synced, [], 60), /Sem fala/);
  assert.throws(() => auditExternalSynchronization(raw, synced, speech, 20), /duração/);
});

test("sparse voice detection requires independent embedded timings to approve external subtitles", () => {
  const captions = Array.from({ length: 40 }, (_, index) => cue(index * 3 + 1, index * 3 + 2, `Dialogue ${index}`));
  const content = serializeVtt(captions);
  const detectedSpeech = captions.slice(0, 20).map((_, index) => ({ start: index * 3 + 1, end: index * 3 + 2 }));
  const reference = { authoritative: true, trackIndex: 4, kind: "pgs-display-timestamps",
    intervals: captions.map((_, index) => ({ start: index * 3 + 1, end: index * 3 + 1.01 })) };
  assert.throws(() => auditExternalSynchronization(content, content, detectedSpeech, 125), { code: "EXTERNAL_CUE_SPEECH_RATIO" });
  const audit = auditExternalSynchronization(content, content, detectedSpeech, 125, undefined, reference);
  assert.equal(audit.cueSpeechRatio, 0.5);
  assert.equal(audit.validationBasis, "audio-and-embedded-timings");
  assert.equal(audit.embeddedReference.approved, true);
  assert.equal(audit.embeddedReference.spokenCoverage.coverageRatio, 1);
  assert.equal(audit.semanticMatchVerified, false);
  assert.throws(() => auditExternalSynchronization(content, content, detectedSpeech, 125, undefined, { ...reference, authoritative: false }), /insuficiente/);
  assert.throws(() => auditExternalSynchronization(content, content, detectedSpeech, 125, undefined, { ...reference, intervals: reference.intervals.map(v => ({ start: v.start + 150, end: v.end + 150 })) }), /insuficiente/);
  const missing = serializeVtt(captions.filter((_, index) => ![5, 8].includes(index)));
  assert.throws(() => auditExternalSynchronization(missing, missing, detectedSpeech, 125, undefined, reference), /insuficiente/);
  assert.throws(() => auditExternalSynchronization(content, content, [...detectedSpeech, { start: 120, end: 124 }], 125, { minimumSpeechCoverage: 0.99, minimumCueSpeechRatio: 0.65 }, reference), /insuficiente/);
});

test("public subtitle metadata excludes download addresses and authentication", () => {
  const result = publicCandidate({ provider: "subdl", id: "1", lang: "pt-br", score: 0.8, url: "https://private.example", token: "secret" });
  assert.equal(result.url, undefined);
  assert.equal(result.token, undefined);
});

test("native Portuguese avoids all external requests", async () => {
  const result = await selectSubtitleSource({ embedded: async () => ({ lang: "pt-br", name: "embedded" }), external: async () => { throw new Error("must not search"); } });
  assert.equal(result.name, "embedded");
});

test("external PT-BR takes priority over translating an original-language track", async () => {
  const result = await selectSubtitleSource({ embedded: async () => ({ lang: "en", name: "embedded" }), external: async (tier) => { assert.equal(tier, "target"); return { lang: "pt-br", name: "external" }; } });
  assert.equal(result.name, "external");
});

test("an embedded Portuguese (Portugal) track yields to a verified external PT-BR candidate", async () => {
  const result = await selectSubtitleSource({
    embedded: async () => ({ lang: "pt", trackTitle: "Portuguese (Portugal)", name: "track-12" }),
    external: async (tier) => { assert.equal(tier, "target"); return { lang: "pt-br", name: "external-subdl" }; },
    isTarget: (candidate) => isTargetSubtitleLocale(candidate, "pt-BR"),
  });
  assert.equal(result.name, "external-subdl");
});

test("external SRT styling does not appear as markup in published dialogue", async () => {
  const content = serializeVtt([cue(1, 3, "<i>Xena!</i>"), cue(5, 7, "Olá?")]);
  const prepared = await prepareSubtitleSource({ name: "external-subdl", lang: "pt-br", external: {}, content }, { duration: 10 });
  assert.equal(prepared.cues[0].text, "Xena!");
  assert.match(prepared.rawContent, /<i>Xena!<\/i>/);
});

test("complete intermediate subtitles precede transcription when external integration is enabled", async () => {
  const attempts = [];
  const result = await selectSubtitleSource({ embedded: async (intermediate) => { if (!intermediate) throw new Error("no original"); attempts.push("intermediate"); return { name: "english" }; },
    external: async (tier) => { attempts.push(tier); throw new Error("no match"); }, transcribe: async () => { throw new Error("must not transcribe"); } });
  assert.equal(result.name, "english");
  assert.deepEqual(attempts, ["target", "original", "intermediate"]);
});

test("external English is tried before any image subtitle is sent to OCR", async () => {
  const attempts = [];
  const result = await selectSubtitleSource({
    embedded: async (intermediate, options = {}) => {
      attempts.push(intermediate ? "intermediate-text" : "original-text");
      assert.equal(options.allowOcr, false, "OCR must not run before external fallback");
      throw new Error("only image subtitles available");
    },
    external: async (tier) => {
      attempts.push(tier);
      if (tier === "fallback") return { name: "external-english", lang: "en" };
      throw new Error("no match");
    },
    transcribe: async () => { throw new Error("must not transcribe"); },
  });
  assert.equal(result.name, "external-english");
  assert.deepEqual(attempts, ["original-text", "target", "original", "intermediate-text", "fallback"]);
});

test("OCR remains available after all external textual alternatives fail", async () => {
  const attempts = [];
  const result = await selectSubtitleSource({
    embedded: async (intermediate, options = {}) => {
      if (options.allowOcr === false) throw new Error("no text");
      attempts.push(intermediate ? "intermediate-ocr" : "original-ocr");
      if (!intermediate) throw new Error("no original-language OCR");
      return { name: "ocr-pgs-track-4", lang: "en" };
    },
    external: async (tier) => { attempts.push(tier); throw new Error("no match"); },
    transcribe: async () => { throw new Error("must not transcribe"); },
  });
  assert.equal(result.name, "ocr-pgs-track-4");
  assert.deepEqual(attempts, ["target", "original", "fallback", "original-ocr", "intermediate-ocr"]);
});

test("rejected Portuguese candidates leave attempts for original and English subtitles", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-priority-"));
  const mediaInput = path.join(directory, "video.mkv");
  fs.writeFileSync(mediaInput, "test");
  const searches = [];
  const session = createExternalSubtitleSession({
    source: { sourceId: path.basename(directory), type: "series", videoId: "tt1528406:2:38" },
    mediaInput, outputDir: directory, mediaTracks: { duration: 100, audioTracks: [{ lang: "ja", disposition: { original: 1 } }] },
    settings: { enabled: true, subdlKey: "test", maxCandidates: 4 },
    client: {
      configured: () => ["subdl"],
      search: async (_provider, _source, { language }) => {
        searches.push(language);
        return Array.from({ length: 5 }, (_, index) => ({ provider: "subdl", id: `${language}-${index}`, lang: language, score: 1 }));
      },
      download: async () => { throw new Error("unconfirmed audio must prevent download"); },
    },
  });
  try {
    // Unconfirmed audio rejects candidates without making external downloads.
    await assert.rejects(session.find("target"), /Nenhuma legenda externa aprovada/);
    assert.equal(session.failures.length, 2);
    await assert.rejects(session.find("original"), /Nenhuma legenda externa aprovada/);
    assert.equal(session.failures.length, 3);
    await assert.rejects(session.find("fallback"), /Nenhuma legenda externa aprovada/);
    assert.equal(session.failures.length, 4);
    assert.deepEqual(searches, ["pt-br", "ja", "en"]);
  } finally {
    session.cleanup();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("external cancellation never falls through into expensive transcription", async () => {
  await assert.rejects(selectSubtitleSource({ embedded: async () => { throw new Error("no track"); },
    external: async () => { throw Object.assign(new Error("cancelled"), { code: "SOURCE_CANCELLED" }); }, transcribe: async () => { throw new Error("must not run"); } }), { code: "SOURCE_CANCELLED" });
});
