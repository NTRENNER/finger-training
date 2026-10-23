import React, { useMemo, useState } from "react";
import { C } from "../../ui/theme.js";
import {
  MOVEMENT_CATEGORIES,
  STIMULUS_OPTIONS,
  createCustomExercise,
  defaultWorkoutProgram,
  exerciseMovementCategories,
  sanitizeWorkoutProgram,
} from "../../model/workoutProgram.js";
import { ExercisePicker } from "./ExercisePicker.jsx";

const TEMPLATE_TABS = [
  { id: "A", label: "Strength A" },
  { id: "C", label: "Strength B" },
  { id: "S3", label: "Strength C" },
  { id: "B", label: "Power Primer" },
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

export function WorkoutBuilder({ program: incoming, workouts, catalog, onChange, onClose }) {
  const program = useMemo(() => sanitizeWorkoutProgram(incoming), [incoming]);
  const [templateId, setTemplateId] = useState("A");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    movementCategories: ["pull"],
    stimulus: "strength",
    tracking: "reps",
    sets: 3,
    reps: "5–8",
    prescription: "",
    intent: "",
  });

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
    setDraft({
      name: "", movementCategories: ["pull"], stimulus: "strength",
      tracking: "reps", sets: 3, reps: "5–8", prescription: "", intent: "",
    });
  };

  return (
    <div className="workout-builder-overlay" onMouseDown={onClose}>
      <div className="workout-builder-panel" onMouseDown={event => event.stopPropagation()}>
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
              onClick={() => { setTemplateId(tab.id); setCreating(false); }}
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
                  <button type="button" className="icon-remove-button" aria-label={`Remove ${exercise.name}`} onClick={() => updateTemplate(ids.filter(item => item !== id))}>×</button>
                </div>
              );
            })}
          </div>

          {!creating ? (
            <div className="builder-actions">
              <button type="button" className="builder-primary-action" onClick={() => setPickerOpen(true)}>Add from library</button>
              <button type="button" className="builder-secondary-action" onClick={() => setCreating(true)}>New exercise</button>
            </div>
          ) : (
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
                  {[{ id: "weight", label: "Weight + reps" }, { id: "reps", label: "Reps" }, { id: "completion", label: "Completion" }].map(item => (
                    <button type="button" aria-pressed={draft.tracking === item.id} key={item.id} onClick={() => setDraft({ ...draft, tracking: item.id })}>{item.label}</button>
                  ))}
                </div>
              </fieldset>
              <div className="builder-form-grid">
                <label><span>Sets</span><input type="number" min="1" max="10" style={fieldStyle} value={draft.sets} onChange={event => setDraft({ ...draft, sets: event.target.value })} /></label>
                <label><span>Reps</span><input style={fieldStyle} value={draft.reps} onChange={event => setDraft({ ...draft, reps: event.target.value })} /></label>
              </div>
              <label><span>Prescription override</span><input style={fieldStyle} placeholder="Optional" value={draft.prescription} onChange={event => setDraft({ ...draft, prescription: event.target.value })} /></label>
              <label><span>Why it is in the plan</span><textarea style={{ ...fieldStyle, resize: "vertical" }} rows="2" value={draft.intent} onChange={event => setDraft({ ...draft, intent: event.target.value })} /></label>
              <div className="builder-actions">
                <button type="button" className="builder-primary-action" disabled={!draft.name.trim()} onClick={saveCustom}>Add exercise</button>
                <button type="button" className="builder-secondary-action" onClick={() => setCreating(false)}>Cancel</button>
              </div>
            </div>
          )}
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
