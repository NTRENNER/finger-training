export const MODIFIER_KINDS = [
  { id: "assistance", label: "Assistance" },
  { id: "resistance", label: "Resistance" },
  { id: "setup", label: "Setup" },
];

export const MODIFIER_CONTROLS = [
  { id: "standard", label: "On/off or choices" },
  { id: "bands", label: "Band colors" },
];

export const BAND_MODIFIER_OPTIONS = [
  { id: "yellow", label: "Yellow" },
  { id: "orange", label: "Orange" },
  { id: "red", label: "Red" },
  { id: "green", label: "Green" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "black", label: "Black" },
];

function cleanString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}
function slug(value, fallback) {
  return cleanString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36) || fallback;
}

function sanitizeOption(raw, index) {
  const label = cleanString(typeof raw === "string" ? raw : raw?.label);
  if (!label) return null;
  const id = cleanString(typeof raw === "object" ? raw?.id : "")
    || `${slug(label, "option")}_${index + 1}`;
  return { id, label };
}

export function sanitizeModifierDefinition(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanString(raw.id);
  const name = cleanString(raw.name);
  if (!id.startsWith("modifier_") || !name) return null;
  const kind = MODIFIER_KINDS.some(item => item.id === raw.kind) ? raw.kind : "setup";
  const control = MODIFIER_CONTROLS.some(item => item.id === raw.control)
    ? raw.control
    : "standard";
  const seen = new Set();
  const rawOptions = control === "bands" ? BAND_MODIFIER_OPTIONS : raw.options;
  const options = (Array.isArray(rawOptions) ? rawOptions : [])
    .map(sanitizeOption)
    .filter(option => option && !seen.has(option.id) && seen.add(option.id));
  return { id, name, kind, control, options };
}

export function createModifierDefinition(values) {
  const name = cleanString(values?.name);
  if (!name) return null;
  const suffix = Math.random().toString(36).slice(2, 7);
  return sanitizeModifierDefinition({
    ...values,
    id: `modifier_${slug(name, "setup")}_${suffix}`,
  });
}

export function modifierValueOptions(definition) {
  const options = Array.isArray(definition?.options) ? definition.options : [];
  return options.length > 0
    ? options
    : [{ id: "on", label: `Use ${definition?.name || "modifier"}` }];
}

export function modifierSelections(setOrSelections) {
  const raw = setOrSelections?.modifiers ?? setOrSelections;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, selection] of Object.entries(raw)) {
    if (!id || !selection || typeof selection !== "object") continue;
    const value = cleanString(selection.value);
    const name = cleanString(selection.name);
    if (!value || !name) continue;
    out[id] = {
      modifierId: id,
      name,
      kind: MODIFIER_KINDS.some(item => item.id === selection.kind) ? selection.kind : "setup",
      value,
      valueLabel: cleanString(selection.valueLabel),
    };
  }
  return out;
}
export function copyModifierSelections(setOrSelections) {
  return Object.fromEntries(Object.entries(modifierSelections(setOrSelections))
    .map(([id, selection]) => [id, { ...selection }]));
}

export function setModifierSelection(set, definition, value) {
  const next = copyModifierSelections(set);
  const isBands = definition.control === "bands";
  const requested = isBands
    ? (Array.isArray(value) ? value : cleanString(value).split("+")).filter(Boolean)
    : [value].filter(Boolean);
  if (requested.length === 0) {
    delete next[definition.id];
  } else {
    const available = modifierValueOptions(definition);
    const options = isBands
      ? available.filter(option => requested.includes(option.id))
      : available.filter(option => option.id === requested[0]).slice(0, 1);
    if (options.length === 0) return { ...set, modifiers: next };
    next[definition.id] = {
      modifierId: definition.id,
      name: definition.name,
      kind: definition.kind,
      value: options.map(option => option.id).join("+"),
      valueLabel: definition.options?.length
        ? options.map(option => option.label).join(" + ")
        : "",
    };
  }
  return { ...set, modifiers: next };
}

export function modifierSelectionSignature(setOrSelections) {
  return Object.entries(modifierSelections(setOrSelections))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, selection]) => `${id}=${selection.value}`)
    .join("|");
}

export function modifierSelectionLabel(setOrSelections) {
  return Object.values(modifierSelections(setOrSelections))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(selection => selection.valueLabel
      ? `${selection.name}: ${selection.valueLabel}`
      : selection.name)
    .join(" · ");
}

export function filterHistoryForModifierSetup(history, exerciseId, setOrSelections) {
  const signature = modifierSelectionSignature(setOrSelections);
  const out = [];
  for (const session of history || []) {
    const data = session?.exercises?.[exerciseId];
    if (!Array.isArray(data?.sets)) continue;
    const sets = data.sets.filter(set => set?.done
      && modifierSelectionSignature(set) === signature);
    if (sets.length === 0) continue;
    out.push({
      ...session,
      exercises: {
        ...session.exercises,
        [exerciseId]: { ...data, sets },
      },
    });
  }
  return out;
}
