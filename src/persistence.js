import { validateInvariants } from "./rules.js";

export function serializeMatch(state) {
  return JSON.stringify({
    file_type: "DENDARV_MATCH",
    schema_version: state.schema_version,
    ruleset_version: state.ruleset_version,
    saved_at: new Date().toISOString(),
    state,
  }, null, 2);
}

export function deserializeMatch(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`The selected file is not valid JSON: ${error.message}`);
  }
  if (parsed?.file_type !== "DENDARV_MATCH") throw new Error("This is not a Dendarv match file");
  if (parsed.schema_version !== 1) throw new Error(`Unsupported save schema: ${parsed.schema_version}`);
  if (!parsed.state || parsed.state.ruleset_version !== parsed.ruleset_version) throw new Error("Save metadata does not match its state");
  const errors = validateInvariants(parsed.state);
  if (errors.length) throw new Error(`Save invariant failure: ${errors.join("; ")}`);
  return parsed.state;
}

export function saveToBrowser(state, key = "dendarv.autosave") {
  localStorage.setItem(key, serializeMatch(state));
}

export function loadFromBrowser(key = "dendarv.autosave") {
  const text = localStorage.getItem(key);
  return text ? deserializeMatch(text) : null;
}
