/**
 * One voice session at a time, JS side (VoiceInput.ts). Pure, tested (voiceSession.test.ts).
 *
 * Native events carry no session id, and the recognizer may keep delivering after a stop: iOS runs the
 * recognition callback through the main queue, so a cancelled task's result or error can land after the
 * next session started and be sent as its own. Rules:
 * - A session hears events only while it is the current one, and only once its native start resolved
 *   (whatever came before belongs to the previous session).
 * - iOS's "request cancelled" errors (216, 301: our own teardown of the previous task) never end a session.
 * - A stop or cancel asked while the native start is still pending (permission prompt, audio engine start)
 *   is kept, and sent as soon as the start resolves, so the mic never keeps recording after Cancel.
 */

export interface VoiceSession {
  readonly token: number;
  /** The native start resolved: the recognizer is running for this session. */
  started: boolean;
  /** Stop (or cancel) was asked before the native start resolved. */
  stopRequested: boolean;
  /** Finished, cancelled or superseded: none of its events count any more. */
  ended: boolean;
}

export type SessionEvent = { type: string; code?: string };

/** iOS NSError codes of a recognition request we cancelled ourselves. */
const CANCEL_NOISE = new Set(["216", "301"]);

export class VoiceSessions {
  private seq = 0;
  current: VoiceSession | null = null;

  /** A new session; the previous one (returned, to release it) is ended and loses its events. */
  begin(): { session: VoiceSession; superseded: VoiceSession | null } {
    const superseded = this.current;
    if (superseded) superseded.ended = true;
    const session: VoiceSession = { token: ++this.seq, started: false, stopRequested: false, ended: false };
    this.current = session;
    return { session, superseded };
  }

  /**
   * The native start of `s` resolved. True when the native session must be stopped right away: a stop was
   * asked meanwhile, or `s` was cancelled with no newer session (a newer one tears it down itself).
   */
  started(s: VoiceSession): boolean {
    if (this.current === s && !s.ended) {
      s.started = true;
      return s.stopRequested;
    }
    return s.ended && this.current === null;
  }

  /** Stop asked on the current session. True when the native stop can go now; false when deferred to started(). */
  requestStop(): boolean {
    const s = this.current;
    if (!s || s.ended) return true;
    if (!s.started) {
      s.stopRequested = true;
      return false;
    }
    return true;
  }

  /** `s` is over (result, error, cancel). */
  end(s: VoiceSession): void {
    s.ended = true;
    if (this.current === s) this.current = null;
  }

  /** Whether an event reaching `s`'s listeners is really its own. */
  accepts(s: VoiceSession, event: SessionEvent): boolean {
    if (s !== this.current || s.ended || !s.started) return false;
    return !(event.type === "error" && event.code !== undefined && CANCEL_NOISE.has(event.code));
  }
}
