import { describe, it, expect } from "vitest";
import { splitInlineBullets } from "./answerFormat";

describe("splitInlineBullets", () => {
  it("puts inline bullet points on their own lines", () => {
    expect(splitInlineBullets("Takeaway. - One. - Two. - Three.")).toBe("Takeaway.\n- One.\n- Two.\n- Three.");
  });

  it("leaves a single dash in a sentence alone", () => {
    const text = "It rained. - which nobody expected - and then it stopped.";
    expect(splitInlineBullets(text)).toBe(text);
  });

  it("leaves real lists and plain prose unchanged", () => {
    const list = "Takeaway.\n- One.\n- Two.";
    expect(splitInlineBullets(list)).toBe(list);
    expect(splitInlineBullets("A well-known fact - really.")).toBe("A well-known fact - really.");
  });
});

describe("splitInlineBullets on a pack's flattened list (Prism FMT-1)", () => {
  it("breaks the steps into a list and leaves the dash inside a sentence", () => {
    const text = "In a nutshell: Drop, cover and hold. - Drop to the floor. - Take cover. - Hold a cushion above your head if possible - many injuries are from flying objects.";
    expect(splitInlineBullets(text)).toBe(
      "In a nutshell: Drop, cover and hold.\n- Drop to the floor.\n- Take cover.\n- Hold a cushion above your head if possible - many injuries are from flying objects."
    );
  });
});

describe("splitInlineBullets on flattened numbered steps (FMT-1, Ready.gov)", () => {
  it("puts each numbered step on its own line; a lone number in a sentence stays", () => {
    expect(splitInlineBullets("Drop, Cover, and Hold On: 1. Drop where you are. 2. Cover your head. 3. Hold On until it stops.")).toBe(
      "Drop, Cover, and Hold On:\n1. Drop where you are.\n2. Cover your head.\n3. Hold On until it stops."
    );
    expect(splitInlineBullets("It happened in 1906. 2 people saw it.")).toBe("It happened in 1906. 2 people saw it.");
    expect(splitInlineBullets("See step 1. 2. Then go.")).toBe("See step 1. 2. Then go.");
  });
});

describe("splitInlineBullets on a dashed numbered list (Ready.gov, Tusk 7e9687a)", () => {
  it("becomes an ordered list, not bullets holding numbers", () => {
    const t = "Protect Yourself During Earthquakes: - 1. Drop (or Lock): Drop where you are. - 2. Cover: Cover your head. - 3. Hold On: Hold until the shaking stops. [1]";
    expect(splitInlineBullets(t)).toBe(
      "Protect Yourself During Earthquakes:\n1. Drop (or Lock): Drop where you are.\n2. Cover: Cover your head.\n3. Hold On: Hold until the shaking stops. [1]"
    );
  });
  it("a lone '- 1.' line stays a bullet", () => {
    expect(splitInlineBullets("Intro.\n- 1. only one")).toBe("Intro.\n- 1. only one");
  });
});
