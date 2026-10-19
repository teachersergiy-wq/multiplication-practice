/**
 * Authoring validation and split into public question row + private answer key.
 * Aligns with contracts/api.ts LIMITS and StoredAnswerKeyV1.
 */

export const LIMITS = {
  promptText: { min: 1, max: 1000 },
  optionText: { min: 1, max: 200 },
  singleChoiceOptions: { min: 4, max: 5 },
  multipleChoiceOptions: { min: 3, max: 8 },
  orderingItems: { min: 3, max: 8 },
  matchingPairs: { min: 2, max: 8 },
  shortAnswerAccepted: { min: 1, max: 10 },
  shortAnswerLength: { max: 200 },
  points: { min: 0.01, max: 100 },
  timeLimitSeconds: { min: 1, max: 3600 },
  questionsPerTemplate: { max: 100 },
} as const;

export type QuestionType =
  | "true_false"
  | "single_choice"
  | "multiple_choice"
  | "ordering"
  | "matching"
  | "numeric"
  | "short_answer";

export type AuthoredQuestion =
  | { type: "true_false"; promptText: string; points: number; timeLimitSeconds?: number | null; correct: boolean }
  | {
      type: "single_choice";
      promptText: string;
      points: number;
      timeLimitSeconds?: number | null;
      options: string[];
      correctIndex: number;
    }
  | {
      type: "multiple_choice";
      promptText: string;
      points: number;
      timeLimitSeconds?: number | null;
      options: string[];
      correctIndexes: number[];
    }
  | {
      type: "ordering";
      promptText: string;
      points: number;
      timeLimitSeconds?: number | null;
      itemsInCorrectOrder: string[];
    }
  | {
      type: "matching";
      promptText: string;
      points: number;
      timeLimitSeconds?: number | null;
      pairs: { left: string; right: string }[];
    }
  | {
      type: "numeric";
      promptText: string;
      points: number;
      timeLimitSeconds?: number | null;
      value: number;
      tolerance?: number;
    }
  | {
      type: "short_answer";
      promptText: string;
      points: number;
      timeLimitSeconds?: number | null;
      accepted: string[];
      caseSensitive?: boolean;
    };

export interface SplitResult {
  questionType: QuestionType;
  prompt: { text: string };
  choices: unknown[];
  points: number;
  timeLimitSeconds: number | null;
  answerKey: Record<string, unknown>;
}

function opaqueId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function trimText(v: unknown, min: number, max: number, field: string): string {
  if (typeof v !== "string") throw new Error(`${field} must be string`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new Error(`${field} length ${min}–${max}`);
  return t;
}

function numPoints(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("points must be a number");
  if (v < LIMITS.points.min || v > LIMITS.points.max) {
    throw new Error(`points must be ${LIMITS.points.min}–${LIMITS.points.max}`);
  }
  return Math.round(v * 100) / 100;
}

function optTime(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error("timeLimitSeconds must be integer or null");
  if (v < LIMITS.timeLimitSeconds.min || v > LIMITS.timeLimitSeconds.max) {
    throw new Error("timeLimitSeconds out of range");
  }
  return v;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Parse and validate authored question; split into public row + private key. */
export function splitAuthoredQuestion(raw: unknown): SplitResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("question must be an object");
  }
  const q = raw as Record<string, unknown>;
  const type = q.type;
  if (
    type !== "true_false" &&
    type !== "single_choice" &&
    type !== "multiple_choice" &&
    type !== "ordering" &&
    type !== "matching" &&
    type !== "numeric" &&
    type !== "short_answer"
  ) {
    throw new Error("invalid question type");
  }

  const promptText = trimText(q.promptText, LIMITS.promptText.min, LIMITS.promptText.max, "promptText");
  const points = numPoints(q.points);
  const timeLimitSeconds = optTime(q.timeLimitSeconds);
  const prompt = { text: promptText };

  if (type === "true_false") {
    if (typeof q.correct !== "boolean") throw new Error("correct must be boolean");
    return {
      questionType: type,
      prompt,
      choices: [],
      points,
      timeLimitSeconds,
      answerKey: { type, value: q.correct },
    };
  }

  if (type === "single_choice") {
    if (!Array.isArray(q.options)) throw new Error("options required");
    const { min, max } = LIMITS.singleChoiceOptions;
    if (q.options.length < min || q.options.length > max) throw new Error(`options: ${min}–${max}`);
    const options = q.options.map((o, i) =>
      trimText(o, LIMITS.optionText.min, LIMITS.optionText.max, `options[${i}]`),
    );
    if (typeof q.correctIndex !== "number" || !Number.isInteger(q.correctIndex)) {
      throw new Error("correctIndex must be integer");
    }
    if (q.correctIndex < 0 || q.correctIndex >= options.length) throw new Error("correctIndex out of range");
    const choices = options.map((text) => ({ id: opaqueId(), text }));
    return {
      questionType: type,
      prompt,
      choices,
      points,
      timeLimitSeconds,
      answerKey: { type, choiceId: choices[q.correctIndex].id },
    };
  }

  if (type === "multiple_choice") {
    if (!Array.isArray(q.options)) throw new Error("options required");
    const { min, max } = LIMITS.multipleChoiceOptions;
    if (q.options.length < min || q.options.length > max) throw new Error(`options: ${min}–${max}`);
    const options = q.options.map((o, i) =>
      trimText(o, LIMITS.optionText.min, LIMITS.optionText.max, `options[${i}]`),
    );
    if (!Array.isArray(q.correctIndexes) || q.correctIndexes.length < 1) {
      throw new Error("correctIndexes required (≥1)");
    }
    const idxs = q.correctIndexes.map((x) => {
      if (typeof x !== "number" || !Number.isInteger(x)) throw new Error("correctIndexes must be integers");
      if (x < 0 || x >= options.length) throw new Error("correctIndexes out of range");
      return x;
    });
    if (new Set(idxs).size !== idxs.length) throw new Error("correctIndexes must be unique");
    const choices = options.map((text) => ({ id: opaqueId(), text }));
    return {
      questionType: type,
      prompt,
      choices,
      points,
      timeLimitSeconds,
      answerKey: { type, choiceIds: idxs.map((i) => choices[i].id).sort() },
    };
  }

  if (type === "ordering") {
    if (!Array.isArray(q.itemsInCorrectOrder)) throw new Error("itemsInCorrectOrder required");
    const { min, max } = LIMITS.orderingItems;
    if (q.itemsInCorrectOrder.length < min || q.itemsInCorrectOrder.length > max) {
      throw new Error(`itemsInCorrectOrder: ${min}–${max}`);
    }
    const items = q.itemsInCorrectOrder.map((o, i) =>
      trimText(o, LIMITS.optionText.min, LIMITS.optionText.max, `items[${i}]`),
    );
    const withIds = items.map((text) => ({ id: opaqueId(), text }));
    const correctOrder = withIds.map((c) => c.id);
    let choices = shuffle(withIds);
    // Ensure public order differs from correct when possible
    let guard = 0;
    while (arraysEqual(choices.map((c) => c.id), correctOrder) && guard < 20) {
      choices = shuffle(withIds);
      guard++;
    }
    if (arraysEqual(choices.map((c) => c.id), correctOrder) && withIds.length >= 2) {
      choices = [...withIds].reverse();
    }
    return {
      questionType: type,
      prompt,
      choices,
      points,
      timeLimitSeconds,
      answerKey: { type, order: correctOrder },
    };
  }

  if (type === "matching") {
    if (!Array.isArray(q.pairs)) throw new Error("pairs required");
    const { min, max } = LIMITS.matchingPairs;
    if (q.pairs.length < min || q.pairs.length > max) throw new Error(`pairs: ${min}–${max}`);
    const pairs = q.pairs.map((p, i) => {
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`pairs[${i}] invalid`);
      const rec = p as Record<string, unknown>;
      return {
        left: trimText(rec.left, LIMITS.optionText.min, LIMITS.optionText.max, `pairs[${i}].left`),
        right: trimText(rec.right, LIMITS.optionText.min, LIMITS.optionText.max, `pairs[${i}].right`),
      };
    });
    const leftItems = pairs.map((p) => ({ id: opaqueId(), side: "left" as const, text: p.left }));
    const rightItems = pairs.map((p) => ({ id: opaqueId(), side: "right" as const, text: p.right }));
    const keyPairs = leftItems.map((l, i) => ({ leftId: l.id, rightId: rightItems[i].id }));
    let rightShuffled = shuffle(rightItems);
    let guard = 0;
    const sameOrder = () => rightShuffled.every((r, i) => r.id === rightItems[i].id);
    while (sameOrder() && rightItems.length >= 2 && guard < 20) {
      rightShuffled = shuffle(rightItems);
      guard++;
    }
    if (sameOrder() && rightItems.length >= 2) {
      rightShuffled = [...rightItems].reverse();
    }
    return {
      questionType: type,
      prompt,
      choices: [...leftItems, ...rightShuffled],
      points,
      timeLimitSeconds,
      answerKey: { type, pairs: keyPairs },
    };
  }

  if (type === "numeric") {
    if (typeof q.value !== "number" || !Number.isFinite(q.value)) throw new Error("value must be number");
    let tolerance = 0;
    if (q.tolerance !== undefined && q.tolerance !== null) {
      if (typeof q.tolerance !== "number" || !Number.isFinite(q.tolerance) || q.tolerance < 0) {
        throw new Error("tolerance must be >= 0");
      }
      tolerance = q.tolerance;
    }
    return {
      questionType: type,
      prompt,
      choices: [],
      points,
      timeLimitSeconds,
      answerKey: { type, value: q.value, tolerance },
    };
  }

  // short_answer
  if (!Array.isArray(q.accepted)) throw new Error("accepted required");
  const { min, max } = LIMITS.shortAnswerAccepted;
  if (q.accepted.length < min || q.accepted.length > max) throw new Error(`accepted: ${min}–${max}`);
  const accepted = q.accepted.map((a, i) =>
    trimText(a, 1, LIMITS.shortAnswerLength.max, `accepted[${i}]`),
  );
  const caseSensitive = q.caseSensitive === true;
  return {
    questionType: type,
    prompt,
    choices: [],
    points,
    timeLimitSeconds,
    answerKey: { type, accepted, caseSensitive },
  };
}

/** Rebuild AuthoredQuestion from stored public row + private key (teacher draft view). */
export function reconstructAuthored(
  type: QuestionType,
  promptText: string,
  points: number,
  timeLimitSeconds: number | null,
  choices: unknown[],
  answerKey: Record<string, unknown> | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type,
    promptText,
    points,
    timeLimitSeconds,
  };
  if (!answerKey || answerKey.type !== type) {
    return { ...base, _missingKey: true };
  }

  if (type === "true_false") {
    return { ...base, correct: answerKey.value === true };
  }
  if (type === "single_choice") {
    const list = Array.isArray(choices) ? choices : [];
    const texts = list.map((c) => (c as { text?: string }).text ?? "");
    const ids = list.map((c) => (c as { id?: string }).id);
    const idx = ids.indexOf(answerKey.choiceId as string);
    return { ...base, options: texts, correctIndex: idx >= 0 ? idx : 0 };
  }
  if (type === "multiple_choice") {
    const list = Array.isArray(choices) ? choices : [];
    const texts = list.map((c) => (c as { text?: string }).text ?? "");
    const ids = list.map((c) => (c as { id?: string }).id);
    const correctIds = new Set((answerKey.choiceIds as string[]) ?? []);
    const correctIndexes = ids
      .map((id, i) => (correctIds.has(id as string) ? i : -1))
      .filter((i) => i >= 0);
    return { ...base, options: texts, correctIndexes };
  }
  if (type === "ordering") {
    const list = Array.isArray(choices) ? choices : [];
    const byId = new Map(list.map((c) => [(c as { id: string }).id, (c as { text: string }).text]));
    const order = (answerKey.order as string[]) ?? [];
    return { ...base, itemsInCorrectOrder: order.map((id) => byId.get(id) ?? "") };
  }
  if (type === "matching") {
    const list = Array.isArray(choices) ? choices : [];
    const byId = new Map(
      list.map((c) => [
        (c as { id: string }).id,
        { text: (c as { text: string }).text, side: (c as { side: string }).side },
      ]),
    );
    const pairs = ((answerKey.pairs as { leftId: string; rightId: string }[]) ?? []).map((p) => ({
      left: byId.get(p.leftId)?.text ?? "",
      right: byId.get(p.rightId)?.text ?? "",
    }));
    return { ...base, pairs };
  }
  if (type === "numeric") {
    return {
      ...base,
      value: answerKey.value,
      tolerance: typeof answerKey.tolerance === "number" ? answerKey.tolerance : 0,
    };
  }
  return {
    ...base,
    accepted: answerKey.accepted ?? [],
    caseSensitive: answerKey.caseSensitive === true,
  };
}
