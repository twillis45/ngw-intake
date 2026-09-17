#!/usr/bin/env python3
"""Seeded speech fixtures for the intake recorder.

A seed picks one concrete script — same seed, same words, same audio, every
run — so a failure can be reproduced exactly instead of described. The text is
then SPOKEN by espeak-ng and resampled to 48 kHz mono, which is what Chromium
accepts for --use-file-for-fake-audio-capture.

This replaces a sine tone. A tone proves the recorder captured *something*; a
sentence proves it captured something a transcriber could read back.
"""
import argparse, audioop, hashlib, json, subprocess, sys, wave
from pathlib import Path

# Answer components, per question. The generator picks one from each slot, so a
# seed yields a coherent answer rather than a bag of sentences. Wording is the
# kind of thing an operator says out loud — hedges, asides and all.
POOLS = {
    "q1": [
        ["So the way this actually works is",
         "The short answer is",
         "It depends who you ask, but really"],
        ["the controller has to be released by their own facility first.",
         "their facility manager is the one who signs off, not headquarters.",
         "nobody travels until the facility says they can spare them."],
        ["It always comes down to staffing and coverage on the day.",
         "Coverage on the day decides it, every single time.",
         "If they are short that week the answer is no."],
        ["So if they are short we are not travelling, no matter what I already booked.",
         "I have had to cancel on a school twice because of that.",
         "That is the part schools never understand about our side."],
    ],
    "q3": [
        ["The worst one was a career fair in Ohio.",
         "There was one at a community college that went badly wrong.",
         "I had a trade school event fall apart on me last spring."],
        ["The speaker got pulled two days out with no warning.",
         "My controller got recalled the night before.",
         "We lost both speakers in the same week."],
        ["I ended up running the whole thing myself off a borrowed laptop,",
         "I drove up and did it solo with no slides,",
         "I presented alone and the AV did not work either,"],
        ["because the school had already printed the flyers.",
         "because two hundred students were already signed up.",
         "because cancelling would have burned the relationship."],
        ["Now I never confirm a date until I have a second controller who can cover.",
         "Since then I always line up a backup before I say yes.",
         "That is why I hold dates loosely until the travel is approved."],
    ],
    "q4": [
        ["Honestly, I just ask around.",
         "There is no list. I ask people I know.",
         "It is word of mouth, mostly."],
        ["It ends up being the same four or five people every time.",
         "The same handful of volunteers carry all of it.",
         "Maybe six controllers do ninety percent of these."],
        ["That is not sustainable and I know it.",
         "One retirement and this whole thing stalls.",
         "I need a wider bench and I have not built one."],
    ],
    "q7": [
        ["I need about three months of lead time.",
         "Realistically it is ninety days minimum.",
         "Anything under two months is a gamble."],
        ["The travel approval is what binds it, not the school calendar.",
         "It is the paperwork on our side that sets the date.",
         "Their calendar is flexible. Ours is not."],
        ["The approval itself takes roughly six weeks to come back.",
         "Travel orders take about a month and a half.",
         "I have waited eight weeks for an approval before."],
    ],
}


def rng(seed):
    """Deterministic stream: seed -> repeatable integers, no numpy, no state."""
    n = int(hashlib.sha256(str(seed).encode()).hexdigest(), 16)
    while True:
        n = (n * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)
        yield n >> 33


def script_for(seed):
    r = rng(seed)
    out = {}
    for qid, slots in POOLS.items():
        out[qid] = " ".join(slot[next(r) % len(slot)] for slot in slots)
    return out


def speak(text, path, rate=48000, wpm=150, voice="en-us"):
    raw = path.with_suffix(".raw.wav")
    subprocess.run(["espeak-ng", "-v", voice, "-s", str(wpm), "-w", str(raw), text],
                   check=True, capture_output=True)
    with wave.open(str(raw), "rb") as w:
        src, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        frames = w.readframes(w.getnframes())
    if ch != 1:
        frames = audioop.tomono(frames, width, 0.5, 0.5)
    frames, _ = audioop.ratecv(frames, width, 1, src, rate, None)
    # Normalise to -3 dBFS. espeak plus resampling overshoots into clipping,
    # and a clipped fixture makes a clean recording look distorted — the test
    # would then be measuring the generator, not the recorder.
    peak = audioop.max(frames, width)
    if peak:
        frames = audioop.mul(frames, width, (32768 * 0.708) / peak)
    # A beat of room tone at each end: a recorder that clips its own start is a
    # bug worth catching, and a file that begins mid-syllable would hide it.
    pad = b"\x00\x00" * int(rate * 0.35)
    frames = pad + frames + pad
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(width); w.setframerate(rate)
        w.writeframes(frames)
    raw.unlink(missing_ok=True)
    return len(frames) / (width * rate)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", default="cory-001")
    ap.add_argument("--out", default="/tmp/claude-0/speech")
    ap.add_argument("--wpm", type=int, default=150)
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    s = script_for(a.seed)
    man = {"seed": a.seed, "wpm": a.wpm, "answers": {}}
    for qid, text in s.items():
        f = out / f"{qid}.wav"
        secs = speak(text, f, wpm=a.wpm)
        man["answers"][qid] = {"text": text, "wav": str(f), "seconds": round(secs, 2),
                               "words": len(text.split())}
        print(f"{qid}  {secs:5.2f}s  {len(text.split()):3d}w  {text[:66]}...")
    (out / "manifest.json").write_text(json.dumps(man, indent=2))
    print("\nmanifest: " + str(out / "manifest.json"))
