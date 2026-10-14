import { describe, it, expect } from "vitest";
import { smallTalkReply } from "./smallTalk";

const at = new Date(2026, 9, 1, 9, 5);

describe("smallTalkReply", () => {
  it("answers greetings in English and Portuguese, from the phrase itself", () => {
    expect(smallTalkReply("hi", false)?.text).toBe("Hi! What would you like to know?");
    expect(smallTalkReply("Good morning!", false)?.text).toBe("Good morning! What would you like to know?");
    expect(smallTalkReply("oi", false)?.text).toBe("Oi! O que você quer saber?");
    expect(smallTalkReply("Bom dia", false)?.text).toBe("Bom dia! O que você quer saber?");
    expect(smallTalkReply("E aí, tudo bem?", false)?.text).toMatch(/^Tudo certo/);
    expect(smallTalkReply("valeu!", false)?.text).toBe("De nada!");
    expect(smallTalkReply("thanks a lot", false)?.text).toBe("You're welcome!");
  });

  it("answers the most meaningful part of a compound greeting", () => {
    expect(smallTalkReply("hey, what's up?", false)?.text).toMatch(/^All good/);
    expect(smallTalkReply("ok, thanks", false)?.text).toBe("You're welcome!");
    expect(smallTalkReply("oi, obrigado", false)?.text).toBe("De nada!");
  });

  it("says who it is, and the time and date from the phone's clock", () => {
    expect(smallTalkReply("who are you?", false)?.kind).toBe("about");
    expect(smallTalkReply("Quem é você?", true)?.text).toMatch(/^Sou o BOAR/);
    expect(smallTalkReply("what time is it?", false, at)?.text).toMatch(/^It's 09:05/);
    expect(smallTalkReply("que horas são?", false, at)?.text).toMatch(/^São 09:05/);
    expect(smallTalkReply("what day is it today", false, at)?.kind).toBe("date");
  });

  it("leaves anything else to the normal answer: a real question after hi, a joke, a question about a name", () => {
    expect(smallTalkReply("hi, what is a monsoon?", false)).toBeNull();
    expect(smallTalkReply("tell me a joke", false)).toBeNull();
    expect(smallTalkReply("what is the name of the capital of Australia?", false)).toBeNull();
    expect(smallTalkReply("como tratar uma queimadura?", true)).toBeNull();
    expect(smallTalkReply("good morning in Japanese", false)).toBeNull();
    expect(smallTalkReply("", false)).toBeNull();
  });
});
