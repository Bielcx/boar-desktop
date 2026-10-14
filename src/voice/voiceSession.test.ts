import { describe, expect, it } from "vitest";
import { VoiceSessions } from "./voiceSession";

const partial = { type: "partial" };
const result = { type: "result" };

describe("VoiceSessions: late events of an old session (PR #24)", () => {
  it("a session hears nothing before its native start resolved", () => {
    const v = new VoiceSessions();
    const { session } = v.begin();
    expect(v.accepts(session, partial)).toBe(false);
    v.started(session);
    expect(v.accepts(session, partial)).toBe(true);
  });

  it("a superseded session's listeners drop everything, and the new one drops what came before its start", () => {
    const v = new VoiceSessions();
    const a = v.begin().session;
    v.started(a);
    const { session: b, superseded } = v.begin();
    expect(superseded).toBe(a);
    // A's late result, delivered to both sets of listeners before B's start resolved.
    expect(v.accepts(a, result)).toBe(false);
    expect(v.accepts(b, result)).toBe(false);
    v.started(b);
    expect(v.accepts(a, partial)).toBe(false);
    expect(v.accepts(b, partial)).toBe(true);
  });

  it("iOS's cancelled-request errors (our teardown of the previous task) never end the new session", () => {
    const v = new VoiceSessions();
    const b = v.begin().session;
    v.started(b);
    expect(v.accepts(b, { type: "error", code: "216" })).toBe(false);
    expect(v.accepts(b, { type: "error", code: "301" })).toBe(false);
    expect(v.accepts(b, { type: "error", code: "no_speech" })).toBe(true);
  });

  it("an ended session hears nothing more", () => {
    const v = new VoiceSessions();
    const s = v.begin().session;
    v.started(s);
    v.end(s);
    expect(v.accepts(s, result)).toBe(false);
    expect(v.current).toBeNull();
  });
});

describe("VoiceSessions: stop or cancel while starting (PR #24)", () => {
  it("done during the start is deferred, then sent as soon as the start resolves", () => {
    const v = new VoiceSessions();
    const s = v.begin().session;
    expect(v.requestStop()).toBe(false);
    expect(v.started(s)).toBe(true);
    // Still its session: the final text after the stop counts.
    expect(v.accepts(s, result)).toBe(true);
  });

  it("cancel during the start: the native session is stopped once it starts, and says nothing", () => {
    const v = new VoiceSessions();
    const s = v.begin().session;
    expect(v.requestStop()).toBe(false);
    v.end(s);
    expect(v.started(s)).toBe(true);
    expect(v.accepts(s, partial)).toBe(false);
  });

  it("a cancelled start that resolves after a newer session began leaves the newer one alone", () => {
    const v = new VoiceSessions();
    const a = v.begin().session;
    v.requestStop();
    v.end(a);
    const b = v.begin().session;
    expect(v.started(a)).toBe(false);
    expect(v.started(b)).toBe(false);
    expect(v.accepts(b, partial)).toBe(true);
  });

  it("a stop on a running session goes at once; with no session there is nothing to defer", () => {
    const v = new VoiceSessions();
    expect(v.requestStop()).toBe(true);
    const s = v.begin().session;
    v.started(s);
    expect(v.requestStop()).toBe(true);
  });
});
