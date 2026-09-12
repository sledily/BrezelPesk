// Xorshift32 is small, deterministic, serializable, and sufficient for a local game.
// A future authoritative server can replace this interface without changing rules code.
export function normalizeSeed(seed) {
  const text = String(seed ?? "dendarv");
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  value >>>= 0;
  return value === 0 ? 0x9e3779b9 : value;
}

export function nextRandom(state) {
  let x = state >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  const nextState = x >>> 0 || 0x9e3779b9;
  return { state: nextState, value: nextState / 0x100000000 };
}

export function randomInt(state, maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error("maxExclusive must be a positive integer");
  }
  const step = nextRandom(state);
  return { state: step.state, value: Math.floor(step.value * maxExclusive) };
}

export function shuffleWithState(items, state) {
  const result = [...items];
  let cursor = state;
  for (let i = result.length - 1; i > 0; i -= 1) {
    const step = randomInt(cursor, i + 1);
    cursor = step.state;
    [result[i], result[step.value]] = [result[step.value], result[i]];
  }
  return { items: result, state: cursor };
}

export function rollDice(state, count) {
  const rolls = [];
  let cursor = state;
  for (let i = 0; i < count; i += 1) {
    const step = randomInt(cursor, 6);
    cursor = step.state;
    rolls.push(step.value + 1);
  }
  return { rolls, state: cursor };
}
