/**
 * SM-2 Spaced Repetition Algorithm
 *
 * Rating scale: 1-5
 *   1 = forgot completely
 *   2 = barely remembered
 *   3 = hard but got it
 *   4 = good recall
 *   5 = easy / perfect recall
 */

export interface SM2State {
  easeFactor: number;
  interval: number;      // days
  repetitions: number;
  nextReviewAt: Date;
}

export interface SM2Result extends SM2State {
  lastReviewedAt: Date;
}

const MAX_INTERVAL = 365;
const MIN_EASE_FACTOR = 1.3;

export function calculateSM2(
  rating: number,
  current: SM2State,
): SM2Result {
  const now = new Date();
  let { easeFactor, interval, repetitions } = current;

  if (rating < 3) {
    // Failed: reset
    repetitions = 0;
    interval = 1;
  } else {
    // Passed: advance
    repetitions += 1;
    if (repetitions === 1) {
      interval = 1;
    } else if (repetitions === 2) {
      interval = 3;
    } else {
      interval = Math.round(interval * easeFactor);
    }
  }

  // Adjust ease factor: ef' = ef + (0.1 - (5-q)*(0.08 + (5-q)*0.02))
  const q = rating;
  easeFactor = easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (easeFactor < MIN_EASE_FACTOR) easeFactor = MIN_EASE_FACTOR;

  if (interval > MAX_INTERVAL) interval = MAX_INTERVAL;

  const nextReviewAt = new Date(now);
  nextReviewAt.setDate(nextReviewAt.getDate() + interval);

  return {
    easeFactor,
    interval,
    repetitions,
    nextReviewAt,
    lastReviewedAt: now,
  };
}
