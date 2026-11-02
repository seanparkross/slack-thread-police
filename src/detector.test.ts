import { describe, expect, it, vi } from "vitest";
import type { ChannelMessage } from "./buffer.js";
import { buildRequest, type DecisionClient, MAX_TEXT_CHARS, NONE, ThreadDetector } from "./detector.js";

const NOW = 1_700_000_000;

const msg = (minutesAgo: number, user: string, text: string, replyCount = 0): ChannelMessage => ({
  ts: `${NOW - minutesAgo * 60}.000100`,
  user,
  text,
  replyCount,
});

const newMessage = msg(0, "UNEW", "yes, ship it");
const candidates = [
  msg(30, "UA", "Morning all", 2),
  msg(10, "UB", "Anyone know if the release is ready?"),
  msg(2, "UC", "Lunch at 12?"),
];

describe("buildRequest", () => {
  const { request, idToMessage } = buildRequest(newMessage, candidates);

  it("lists recent messages oldest first, labelled by recency", () => {
    expect(request.state.channel_messages_oldest_first).toEqual([
      { id: "m3", author: "<@UA>", minutes_before_new_message: 30, already_has_thread: true, text: "Morning all" },
      {
        id: "m2",
        author: "<@UB>",
        minutes_before_new_message: 10,
        already_has_thread: false,
        text: "Anyone know if the release is ready?",
      },
      { id: "m1", author: "<@UC>", minutes_before_new_message: 2, already_has_thread: false, text: "Lunch at 12?" },
    ]);
    expect(request.state.new_message).toEqual({ author: "<@UNEW>", text: "yes, ship it" });
  });

  it("asks is_reply as a noul and parent as a choice, newest option first and none last", () => {
    expect(request.questions.is_reply.type).toBe("noul");
    expect(request.questions.parent.type).toBe("choice");
    expect(Object.keys(request.questions.parent.criteria)).toEqual(["m1", "m2", "m3", NONE]);
    expect(request.questions.parent.criteria.m2).toBe("Message m2 by <@UB>, 10 min earlier");
  });

  it("tells the model that quick reactions and context-free details continue a message", () => {
    const { instructions, criteria } = request.questions.is_reply;
    expect(instructions).toContain("A short remark or reaction posted moments after a message");
    expect(instructions).toContain("doesn't make sense on its own");
    expect(instructions).toContain("a greeting or a question that is clear on its own does not");
    expect(criteria?.true).toBe("It responds to, reacts to or continues one specific earlier message");
  });

  it("does not depend on the order candidates are passed in", () => {
    const shuffled = buildRequest(newMessage, [candidates[2]!, candidates[0]!, candidates[1]!]);
    expect(shuffled.request).toEqual(request);
  });

  it("clips long messages so pasted logs don't blow up the request", () => {
    const long = "x".repeat(MAX_TEXT_CHARS * 5);
    const clipped = buildRequest({ ...newMessage, text: long }, [msg(1, "UA", long)]).request.state;
    expect(clipped.new_message.text).toHaveLength(MAX_TEXT_CHARS);
    expect(clipped.new_message.text.endsWith("…")).toBe(true);
    expect(clipped.channel_messages_oldest_first[0]?.text).toHaveLength(MAX_TEXT_CHARS);
  });

  it("maps labels back to messages", () => {
    expect(idToMessage.get("m1")).toEqual(candidates[2]);
    expect(idToMessage.get("m3")).toEqual(candidates[0]);
  });
});

describe("ThreadDetector", () => {
  const thresholds = { replyThreshold: 0.75, parentThreshold: 0.6 };

  function fakeClient(isReply: number, picked: string, probabilities: Record<string, number>) {
    const systemOne = vi.fn().mockResolvedValue({
      model: "jev-test",
      usage: { input_tokens: null, output_tokens: null },
      answers: {
        is_reply: { type: "noul", noul: isReply },
        parent: { type: "choice", choice: picked, confidence: probabilities[picked] ?? 0, probabilities },
      },
    });
    return { client: { systemOne } as unknown as DecisionClient, systemOne };
  }

  it("suggests the picked parent when both thresholds are met", async () => {
    const { client } = fakeClient(0.9, "m2", { m1: 0.1, m2: 0.8, m3: 0.05, none: 0.05 });
    await expect(new ThreadDetector(client, thresholds).detect(newMessage, candidates)).resolves.toEqual({
      replyProbability: 0.9,
      picked: "m2",
      parentProbability: 0.8,
      suggestion: {
        parentTs: candidates[1]!.ts,
        parentUser: "UB",
        parentText: "Anyone know if the release is ready?",
        replyProbability: 0.9,
        parentProbability: 0.8,
      },
    });
  });

  it("accepts probabilities exactly at the thresholds", async () => {
    const { client } = fakeClient(0.75, "m1", { m1: 0.6, none: 0.4 });
    const detection = await new ThreadDetector(client, thresholds).detect(newMessage, candidates);
    expect(detection?.suggestion).not.toBeNull();
  });

  it.each([
    ["below_reply_threshold", 0.7, "m2", { m2: 0.9, none: 0.1 }],
    ["below_parent_threshold", 0.9, "m2", { m1: 0.45, m2: 0.5, none: 0.05 }],
    ["picked_none", 0.9, NONE, { m1: 0.1, none: 0.9 }],
    ["unknown_label", 0.9, "m9", { m9: 0.9 }],
  ])("reports %s without a suggestion, keeping the probabilities", async (reason, isReply, picked, probabilities: Record<string, number>) => {
    const { client } = fakeClient(isReply, picked, probabilities);
    await expect(new ThreadDetector(client, thresholds).detect(newMessage, candidates)).resolves.toEqual({
      replyProbability: isReply,
      picked,
      parentProbability: probabilities[picked],
      suggestion: null,
      reason,
    });
  });

  it("nudges someone following up on their own message", async () => {
    const own = [msg(1, "UNEW", "Quick question about the release")];
    const { client } = fakeClient(0.95, "m1", { m1: 0.95, none: 0.05 });
    const detection = await new ThreadDetector(client, thresholds).detect(newMessage, own);
    expect(detection?.suggestion).toMatchObject({ parentTs: own[0]!.ts, parentUser: "UNEW" });
  });

  describe("with an open burst", () => {
    // The person's question (m3) and two follow-ups (m2, m1); a third follow-up splits the vote.
    const question = msg(6, "UNEW", "Has anyone renewed the SSL certificate?");
    const first = msg(4, "UNEW", "It expires on Friday");
    const second = msg(2, "UNEW", "I think Priya did it last time");
    const thread = [question, first, second];
    const burst = { parentTs: question.ts, messages: [first.ts, second.ts] };

    it("adds up the vote across the burst and points at its parent", async () => {
      const { client } = fakeClient(0.8, "m1", { m1: 0.4, m2: 0.3, m3: 0.2, none: 0.1 });
      const detection = await new ThreadDetector(client, thresholds).detect(newMessage, thread, burst);
      expect(detection?.picked).toBe("m3");
      expect(detection?.parentProbability).toBeCloseTo(0.9);
      expect(detection?.suggestion?.parentTs).toBe(question.ts);
    });

    it("lets the burst outvote a single other message", async () => {
      const other = msg(1, "UA", "Lunch at 12?");
      // m1 is the other message (most recent); the burst's 0.25 + 0.25 + 0.15 beats its 0.3.
      const { client } = fakeClient(0.8, "m1", { m1: 0.3, m2: 0.25, m3: 0.25, m4: 0.15, none: 0.05 });
      const detection = await new ThreadDetector(client, thresholds).detect(newMessage, [...thread, other], burst);
      expect(detection?.suggestion?.parentTs).toBe(question.ts);
    });

    it("still says no when the message isn't a reply at all", async () => {
      const { client } = fakeClient(0.2, "m1", { m1: 0.4, m2: 0.3, m3: 0.2, none: 0.1 });
      const detection = await new ThreadDetector(client, thresholds).detect(newMessage, thread, burst);
      expect(detection?.suggestion).toBeNull();
      expect(detection?.reason).toBe("below_reply_threshold");
    });

    it("leaves a clear vote for something else alone", async () => {
      const other = msg(1, "UA", "Lunch at 12?");
      const { client } = fakeClient(0.9, "m1", { m1: 0.8, m2: 0.05, m3: 0.05, m4: 0.05, none: 0.05 });
      const detection = await new ThreadDetector(client, thresholds).detect(newMessage, [...thread, other], burst);
      expect(detection?.suggestion?.parentTs).toBe(other.ts);
    });
  });

  it("skips the model call when there is nothing to reply to", async () => {
    const { client, systemOne } = fakeClient(0.9, "m1", { m1: 0.9 });
    await expect(new ThreadDetector(client, thresholds).detect(newMessage, [])).resolves.toBeNull();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("propagates model errors to the caller", async () => {
    const client = { systemOne: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as DecisionClient;
    await expect(new ThreadDetector(client, thresholds).detect(newMessage, candidates)).rejects.toThrow("boom");
  });
});
