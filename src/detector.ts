import { choice, noul, type SystemOneRequest, type TypeSafeClient } from "@typesafe-ai/sdk";
import type { ChannelMessage } from "./buffer.js";

export interface DetectionThresholds {
  /** Minimum P(the new message replies to or continues some earlier message). */
  replyThreshold: number;
  /** Minimum probability on the specific parent the model picked. */
  parentThreshold: number;
}

export interface Suggestion {
  parentTs: string;
  parentUser: string;
  /** Kept in memory only, to quote a snippet back to the person in their nudge. */
  parentText: string;
  replyProbability: number;
  parentProbability: number;
}

export type NoNudgeReason = "picked_none" | "unknown_label" | "below_reply_threshold" | "below_parent_threshold";

/** What the model said about one message, nudge or not; probabilities and labels only. */
export interface Detection {
  replyProbability: number;
  /** The label the model picked: m1…mN or `none`. */
  picked: string;
  parentProbability: number;
  suggestion: Suggestion | null;
  reason?: NoNudgeReason;
}

export type DecisionClient = Pick<TypeSafeClient, "systemOne">;

export const NONE = "none";

/** Enough of a message to judge what it's about, without sending pasted logs to the model. */
export const MAX_TEXT_CHARS = 1000;

const clip = (text: string) => (text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS - 1)}…`);

/**
 * Builds the System One request. Candidates are labelled by recency (m1 = most recent) and listed
 * in that order as choice options: the most recent message is the likeliest parent, and Jev leans
 * toward earlier options, so that bias works with us rather than against us.
 */
export function buildRequest(newMessage: ChannelMessage, candidates: ChannelMessage[]) {
  const labelled = [...candidates]
    .sort((a, b) => Number(b.ts) - Number(a.ts))
    .map((message, i) => ({ id: `m${i + 1}`, message }));
  const minutesBefore = (m: ChannelMessage) => Math.max(0, Math.round((Number(newMessage.ts) - Number(m.ts)) / 60));

  const state = {
    channel_messages_oldest_first: [...labelled].reverse().map(({ id, message }) => ({
      id,
      author: `<@${message.user}>`,
      minutes_before_new_message: minutesBefore(message),
      already_has_thread: message.replyCount > 0,
      text: clip(message.text),
    })),
    new_message: { author: `<@${newMessage.user}>`, text: clip(newMessage.text) },
  };

  const parentOptions: Record<string, string> = {};
  for (const { id, message } of labelled) {
    parentOptions[id] = `Message ${id} by <@${message.user}>, ${minutesBefore(message)} min earlier`;
  }
  parentOptions[NONE] = "None of them: the new message starts a new topic or stands on its own";

  const request = {
    state,
    questions: {
      is_reply: noul(
        "Is the new message a direct response to, or continuation of, one specific earlier channel message (answering it, reacting to it, or adding follow-up detail to it) rather than a standalone message or a new topic?",
        {
          true: "It responds to or continues one specific earlier message",
          false: "It is standalone, a new topic, or addressed to the whole channel",
        },
      ),
      parent: choice("Which earlier message is the new message responding to or continuing?", parentOptions),
    },
  } satisfies SystemOneRequest;

  return { request, idToMessage: new Map(labelled.map(({ id, message }) => [id, message])) };
}

export class ThreadDetector {
  constructor(
    private readonly client: DecisionClient,
    private readonly thresholds: DetectionThresholds,
  ) {}

  /**
   * Null when there's nothing earlier to reply to (no model call is made).
   *
   * `burst` is the person's open run of follow-ups, if any. Its parent and earlier follow-ups are
   * one conversation, so the model's vote across them is added up: otherwise a third follow-up
   * that splits 0.4 / 0.3 / 0.2 between them falls below the parent threshold despite being a
   * clear 0.9 for "this conversation".
   */
  async detect(
    newMessage: ChannelMessage,
    candidates: ChannelMessage[],
    burst?: { parentTs: string; messages: string[] },
  ): Promise<Detection | null> {
    if (candidates.length === 0) return null;

    const { request, idToMessage } = buildRequest(newMessage, candidates);
    const { answers } = await this.client.systemOne(request);
    const probabilities: Record<string, number> = answers.parent.probabilities;

    const replyProbability = answers.is_reply.noul;
    let picked: string = answers.parent.choice;
    let parentProbability = probabilities[picked] ?? 0;
    let parent = idToMessage.get(picked);

    if (burst) {
      const members = new Set([burst.parentTs, ...burst.messages]);
      const inBurst = [...idToMessage].filter(([, message]) => members.has(message.ts));
      const burstProbability = inBurst.reduce((sum, [id]) => sum + (probabilities[id] ?? 0), 0);
      // Prefer the burst's own parent; failing that (it's aged out of the window), its latest member.
      const [id, message] = inBurst.find(([, m]) => m.ts === burst.parentTs) ?? inBurst[0] ?? [];
      if (id && message && burstProbability >= parentProbability) {
        picked = id;
        parent = message;
        parentProbability = burstProbability;
      }
    }
    const detection = { replyProbability, picked, parentProbability };

    if (picked === NONE) return { ...detection, suggestion: null, reason: "picked_none" };
    if (!parent) return { ...detection, suggestion: null, reason: "unknown_label" };
    if (replyProbability < this.thresholds.replyThreshold) {
      return { ...detection, suggestion: null, reason: "below_reply_threshold" };
    }
    if (parentProbability < this.thresholds.parentThreshold) {
      return { ...detection, suggestion: null, reason: "below_parent_threshold" };
    }

    return {
      ...detection,
      suggestion: {
        parentTs: parent.ts,
        parentUser: parent.user,
        parentText: parent.text,
        replyProbability,
        parentProbability,
      },
    };
  }
}
