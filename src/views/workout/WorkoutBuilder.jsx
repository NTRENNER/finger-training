import React, { useMemo, useState } from "react";
import { C } from "../../ui/theme.js";
import { useEscapeDismiss } from "../../hooks/useEscapeDismiss.js";
import {
  MOVEMENT_CATEGORIES,
  STIMULUS_OPTIONS,
  createCustomExercise,
  createModifierDefinition,
  defaultWorkoutProgram,
  exerciseMovementCategories,
  sanitizeWorkoutProgram,
} from "../../model/workoutProgram.js";
import {
  MODIFIER_CONTROLS,
  MODIFIER_KINDS,
} from "../../model/workoutModifiers.js";
import { ExercisePicker } from "./ExercisePicker.jsx";

const TEMPLATE_TABS = [
  { id: "A", label: "Strength A" },
  { id: "C", label: "Strength B" },
  { id: "S3", label: "Strength C" },
];

const fieldStyle = {
  width: "100%",
  boxSizing: "border-box",
  background: C.bg,
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: "9px 10px",
  font: "inherit",
};

function CategoryChips({ exercise }) {
  const ids = exerciseMovementCategories(exercise);
  if (ids.length === 0) return null;
  return (
    <div className="builder-category-row">
      {ids.map(id => (
        <span key={id} className="builder-category-chip">
          {MOVEMENT_CATEGORIES.find(item => item.id === id)?.label || id}
        </span>
      ))}
    </div>
  );
}

const EMPTY_DRAFT = {
  name: "",
  movementCategories: ["pull"],
  stimulus: "strength",
  tracking: "reps",
  intent: "",
};

const EMPTY_MODIFIER_DRAFT = {
  name: "",
  kind: "assistance",
  control: "standard",
  options: "",
};

export function WorkoutBuilder({ program: incoming, workouts, catalog, onChange, onClose }) {
  const program = useMemo(() => sanitizeWorkoutProgram(incoming), [incoming]);
  const [templateId, setTemplateId] = useState("A");
  const [pickerOpen, setPickerOpen] = useState(false);
  useEscapeDismiss(!pickerOpen, onClose);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [setupExerciseId, setSetupExerciseId] = useState(null);
  const [modifierDraft, setModifierDraft] = useState(EMPTY_MODIFIER_DRAFT);

  const ids = program.templates[templateId] || [];
  const selectedWorkout = workouts[templateId];
  const updateTemplate = nextIds => onChange({
    ...program,
    templates: { ...program.templates, [templateId]: nextIds },
  });
  const move = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target], next[index]];
    updateTemplate(next);
  };
  const resetTemplate = () => {
    const defaults = defaultWorkoutProgram();
    updateTemplate(defaults.templates[templateId]);
  };
  const toggleCategory = id => setDraft(current => ({
    ...current,
    movementCategories: current.movementCategories.includes(id)
      ? current.movementCategories.filter(item => item !== id)
      : [...current.movementCategories, id],
  }));
  const saveCustom = () => {
    const exercise = createCustomExercise(draft);
    if (!exercise) return;
    onChange({
      ...program,
      customExercises: [...program.customExercises, exercise],
      templates: { ...program.templates, [templateId]: [...ids, exercise.id] },
    });
    setCreating(false);
    setDraft(EMPTY_DRAFT);
  };
  const toggleExerciseModifier = modifierId => {
    if (!setupExerciseId) return;
    const attached = program.exerciseModifierIds[setupExerciseId] || [];
    const next = attached.includes(modifierId)
      ? attached.filter(id => id !== modifierId)
      : [...attached, modifierId];
    const exerciseModifierIds = { ...program.exerciseModifierIds };
    if (next.length > 0) exerciseModifierIds[setupExerciseId] = next;
    else delete exerciseModifierIds[setupExerciseId];
    onChange({ ...program, exerciseModifierIds });
  };
  const saveModifier = () => {
    if (!setupExerciseId) return;
    const options = modifierDraft.control === "standard"
      ? modifierDraft.options.split(",").map(value => value.trim()).filter(Boolean)
      : [];
    const modifier = createModifierDefinition({ ...modifierDraft, options });
    if (!modifier) return;
    onChange({
      ...program,
      modifierDefinitions: [...program.modifierDefinitions, modifier],
      exerciseModifierIds: {
        ...program.exerciseModifierIds,
        [setupExerciseId]: [...(program.exerciseModifierIds[setupExerciseId] || []), modifier.id],
      },
    });
    setModifierDraft(EMPTY_MODIFIER_DRAFT);
  };
  const deleteModifier = modifier => {
    if (!window.confirm(`Delete ${modifier.name} from the modifier library? Saved workout history will keep its labels.`)) return;
    const exerciseModifierIds = {};
    for (const [exerciseId, ids] of Object.entries(program.exerciseModifierIds)) {
      const next = ids.filter(id => id !== modifier.id);
      if (next.length) exerciseModifierIds[exerciseId] = next;
    }
    onChange({
      ...program,
      modifierDefinitions: program.modifierDefinitions.filter(item => item.id !== modifier.id),
      exerciseModifierIds,
    });
  };

  return (
    <div className="workout-builder-overlay" onMouseDown={onClose}>
      <div className="workout-builder-panel" onMouseDown={event => event.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Workout builder">
        <header className="workout-builder-header">
          <div>
            <div className="workout-eyebrow">Workout builder</div>
            <h2>Build your support training</h2>
          </div>
          <button type="button" className="icon-close-button" aria-label="Close workout builder" onClick={onClose}>×</button>
        </header>

        <div className="builder-template-tabs" role="tablist" aria-label="Workout template">
          {TEMPLATE_TABS.map(tab => (
            <button
              type="button"
              role="tab"
              aria-selected={templateId === tab.id}
              key={tab.id}
              onClick={() => { setTemplateId(tab.id); setCreating(false); setSetupExerciseId(null); }}
            >{tab.label}</button>
          ))}
        </div>

        <div className="builder-body">
          <div className="builder-summary-row">
            <div>
              <div className="builder-workout-name">{selectedWorkout?.name}</div>
              <div className="builder-workout-purpose">{selectedWorkout?.purpose}</div>
            </div>
            <button type="button" className="text-button" onClick={resetTemplate}>Reset</button>
          </div>

          <div className="builder-exercise-list">
            {ids.length === 0 && <div className="builder-empty">Add an exercise to this workout.</div>}
            {ids.map((id, index) => {
              const exercise = catalog[id];
              if (!exercise) return null;
              return (
                <div className="builder-exercise-row" key={id}>
                  <div className="builder-order-controls">
                    <button type="button" aria-label={`Move ${exercise.name} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                    <button type="button" aria-label={`Move ${exercise.name} down`} disabled={index === ids.length - 1} onClick={() => move(index, 1)}>↓</button>
                  </div>
                  <div className="builder-exercise-copy">
                    <div className="builder-exercise-name">{exercise.name}</div>
                    <div className="builder-exercise-prescription">{exercise.prescription}</div>
                    <CategoryChips exercise={exercise} />
                  </div>
                  {exercise.loggable && (
                    <button
                      type="button"
                      className="text-button builder-setup-button"
                      aria-expanded={setupExerciseId === id}
                      onClick={() => setSetupExerciseId(current => current === id ? null : id)}
                    >Setup</button>
                  )}
                  <button type="button" className="icon-remove-button" aria-label={`Remove ${exercise.name}`} onClick={() => updateTemplate(ids.filter(item => item !== id))}>×</button>
                </div>
              );
            })}
          </div>

          {setupExerciseId && catalog[setupExerciseId] && (
            <section className="builder-setup-editor" aria-label={`Setup options for ${catalog[setupExerciseId].name}`}>
              <div className="builder-summary-row">
                <div>
                  <div className="builder-workout-name">Setup options · {catalog[setupExerciseId].name}</div>
                  <div className="builder-workout-purpose">Attach reusable equipment or technique modifiers.</div>
                </div>
                <button type="button" className="text-button" onClick={() => setSetupExerciseId(null)}>Done</button>
              </div>

              {program.modifierDefinitions.length > 0 && (
                <div className="builder-modifier-library">
                  {program.modifierDefinitions.map(modifier => {
                    const checked = (program.exerciseModifierIds[setupExerciseId] || []).includes(modifier.id);
                    const kind = MODIFIER_KINDS.find(item => item.id === modifier.kind)?.label || "Setup";
                    const control = MODIFIER_CONTROLS.find(item => item.id === modifier.control)?.label;
                    return (
                      <div key={modifier.id} className="builder-modifier-row">
                        <label className="builder-modifier-option">
                          <input type="checkbox" checked={checked} onChange={() => toggleExerciseModifier(modifier.id)} />
                          <span>
                            <strong>{modifier.name}</strong>
                            <small>
                              {kind} · {modifier.control === "bands"
                                ? control
                                : modifier.options.length
                                  ? modifier.options.map(item => item.label).join(", ")
                                  : "On/off"}
                            </small>
                          </span>
                        </label>
                        <button type="button" className="icon-remove-button" aria-label={`Delete ${modifier.name}`} onClick={() => deleteModifier(modifier)}>×</button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="builder-modifier-create">
                <label>
                  <span>New modifier</span>
                  <input
                    style={fieldStyle}
                    placeholder="Slingshot"
                    value={modifierDraft.name}
                    onChange={event => setModifierDraft({ ...modifierDraft, name: event.target.value })}
                  />
                </label>
                <label>
                  <span>Effect</span>
                  <select style={fieldStyle} value={modifierDraft.kind} onChange={event => setModifierDraft({ ...modifierDraft, kind: event.target.value })}>
                    {MODIFIER_KINDS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
                <label>
                  <span>Control</span>
                  <select style={fieldStyle} value={modifierDraft.control} onChange={event => setModifierDraft({ ...modifierDraft, control: event.target.value })}>
                    {MODIFIER_CONTROLS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
                {modifierDraft.control === "standard" && (
                  <label>
                    <span>Choices, optional</span>
                    <input
                      style={fieldStyle}
                      placeholder="Red, Blue, Maddog"
                      value={modifierDraft.options}
                      onChange={event => setModifierDraft({ ...modifierDraft, options: event.target.value })}
                    />
                  </label>
                )}
                <button type="button" className="builder-primary-action" disabled={!modifierDraft.name.trim()} onClick={saveModifier}>Add and attach</button>
              </div>
            </section>
          )}

          {!creating && !setupExerciseId ? (
            <div className="builder-actions">
              <button type="button" className="builder-primary-action" onClick={() => setPickerOpen(true)}>Add from library</button>
              <button type="button" className="builder-secondary-action" onClick={() => setCreating(true)}>New exercise</button>
            </div>
          ) : creating ? (
            <div className="custom-exercise-form">
              <div className="builder-workout-name">New exercise</div>
              <label>
                <span>Name</span>
                <input style={fieldStyle} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <fieldset>
                <legend>Movement</legend>
                <div className="builder-option-row">
                  {MOVEMENT_CATEGORIES.map(item => (
                    <button type="button" aria-pressed={draft.movementCategories.includes(item.id)} key={item.id} onClick={() => toggleCategory(item.id)}>{item.label}</button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Training effect</legend>
                <div className="builder-option-row">
                  {STIMULUS_OPTIONS.map(item => (
                    <button type="button" aria-pressed={draft.stimulus === item.id} key={item.id} onClick={() => setDraft({ ...draft, stimulus: item.id })}>{item.label}</button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Log</legend>
                <div className="builder-option-row">
                  {[{ id: "weight", label: "Weight + reps" }, { id: "reps", label: "Reps" }, { id: "time", label: "Reps × seconds" }, { id: "completion", label: "Completion" }].map(item => (
                    <button type="button" aria-pressed={draft.tracking === item.id} key={item.id} onClick={() => setDraft({ ...draft, tracking: item.id })}>{item.label}</button>
                  ))}
                </div>
              </fieldset>
              <p className="builder-note">No prescription needed. Log your first session however it goes; it becomes the starting point, and later sessions progress from there.</p>
              <label><span>Why it is in the plan</span><textarea style={{ ...fieldStyle, resize: "vertical" }} rows="2" value={draft.intent} onChange={event => setDraft({ ...draft, intent: event.target.value })} /></label>
              <div className="builder-actions">
                <button type="button" className="builder-primary-action" disabled={!draft.name.trim()} onClick={saveCustom}>Add exercise</button>
                <button type="button" className="builder-secondary-action" onClick={() => setCreating(false)}>Cancel</button>
              </div>
            </div>
          ) : null}
        </div>

        {pickerOpen && (
          <ExercisePicker
            title={`Add to ${TEMPLATE_TABS.find(tab => tab.id === templateId)?.label}`}
            catalog={catalog}
            excludeIds={ids}
            onPick={exercise => { updateTemplate([...ids, exercise.id]); setPickerOpen(false); }}
            onCancel={() => setPickerOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
