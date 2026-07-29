import React, { useMemo, useState } from "react";
import { Card } from "../../ui/components.js";
import { C } from "../../ui/theme.js";
import {
  buildStretchPlan,
  STRETCH_CATEGORIES,
  STRETCH_EQUIPMENT,
  STRETCH_EXERCISE_MAP,
  toggleStretchEquipment,
  toggleStretchPriority,
} from "../../model/stretching.js";
import { VideoLink } from "./VideoLink.js";

const CATEGORY_COLORS = {
  hipRotation: C.purple,
  hamstrings: C.orange,
  highStep: C.blue,
  hipOpening: C.green,
  hipExtension: C.yellow,
  forearms: C.red,
  overhead: C.blue,
  chest: C.orange,
};

function Pill({ active, color = C.purple, children, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      style={{
        minHeight: 32,
        padding: "5px 11px",
        borderRadius: 16,
        border: `1px solid ${active ? color : C.border}`,
        background: active ? `${color}28` : C.bg,
        color: active ? C.text : C.muted,
        fontSize: 12,
        fontWeight: active ? 700 : 500,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function ControlGroup({ label, children }) {
  return (
    <div>
      <div style={{
        color: C.muted,
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

function equipmentLabel(exercise) {
  const labels = (exercise?.equipment || [])
    .map(key => STRETCH_EQUIPMENT[key]?.label)
    .filter(Boolean);
  return labels.length > 0 ? labels.join(" + ") : "No equipment";
}

function CompletedMobility({ session, onRemove }) {
  const items = Object.entries(session?.exercises || {})
    .map(([id, data]) => ({
      exercise: STRETCH_EXERCISE_MAP[id],
      minutes: Number(data?.minutes) || 0,
      done: data?.done !== false,
    }))
    .filter(item => item.exercise && item.done);
  const total = items.reduce((sum, item) => sum + item.minutes, 0);

  return (
    <Card style={{ borderColor: `${C.green}88` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Climbing Mobility</div>
          <div style={{ color: C.green, fontSize: 12, marginTop: 2 }}>
            {total > 0 ? `${total} minutes logged today` : "Logged today"}
          </div>
        </div>
        <span style={{
          color: C.green,
          border: `1px solid ${C.green}`,
          borderRadius: 14,
          padding: "3px 8px",
          fontSize: 11,
          fontWeight: 700,
        }}>
          Complete
        </span>
      </div>

      {items.length > 0 && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}` }}>
          {items.map(({ exercise, minutes }, index) => (
            <div
              key={exercise.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                padding: "9px 0",
                borderBottom: index < items.length - 1 ? `1px solid ${C.border}` : "none",
                fontSize: 12,
              }}
            >
              <span>{exercise.name}</span>
              {minutes > 0 && <span style={{ color: C.muted }}>{minutes} min</span>}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onRemove}
        style={{
          width: "100%",
          marginTop: 14,
          padding: "10px 12px",
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          background: C.bg,
          color: C.muted,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Remove today's log
      </button>
    </Card>
  );
}

export function StretchSessionBuilder({
  preferences,
  coverage,
  completedSession = null,
  onPreferencesChange,
  onLog,
  onRemove,
}) {
  const [selectedByCategory, setSelectedByCategory] = useState({});
  const [openCategory, setOpenCategory] = useState(null);
  const plan = useMemo(
    () => buildStretchPlan({ ...preferences, coverage }),
    [preferences, coverage]
  );

  if (completedSession) {
    return <CompletedMobility session={completedSession} onRemove={onRemove} />;
  }

  const updatePreferences = patch => {
    onPreferencesChange?.({ ...preferences, ...patch });
  };

  const chosenItems = plan.items.map(item => {
    const selectedId = selectedByCategory[item.category];
    const selected = item.options.find(option => option.id === selectedId) || item.exercise;
    return { ...item, exercise: selected };
  });

  const logSession = () => {
    onLog?.({
      targetMinutes: plan.targetMinutes,
      items: chosenItems,
    });
  };

  return (
    <Card style={{ borderColor: `${C.purple}66` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Climbing Mobility</div>
          <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
            {plan.targetMinutes}-minute session
          </div>
        </div>
        <div style={{ fontSize: 24, fontWeight: 800, color: C.purple }}>
          {plan.targetMinutes}<span style={{ fontSize: 11, color: C.muted, marginLeft: 3 }}>min</span>
        </div>
      </div>

      <div style={{ display: "grid", gap: 14, marginBottom: 18 }}>
        <ControlGroup label="Time">
          {[5, 10, 15].map(minutes => (
            <Pill
              key={minutes}
              active={preferences.targetMinutes === minutes}
              onClick={() => updatePreferences({ targetMinutes: minutes })}
              label={`${minutes} minute mobility session`}
            >
              {minutes} min
            </Pill>
          ))}
        </ControlGroup>

        <ControlGroup label="Priorities (2 max)">
          {Object.values(STRETCH_CATEGORIES).map(category => (
            <Pill
              key={category.key}
              active={preferences.priorities.includes(category.key)}
              color={CATEGORY_COLORS[category.key]}
              onClick={() => updatePreferences({
                priorities: toggleStretchPriority(preferences.priorities, category.key),
              })}
              label={`${category.label} priority`}
            >
              {category.label}
            </Pill>
          ))}
        </ControlGroup>

        <ControlGroup label="Available">
          {Object.values(STRETCH_EQUIPMENT).map(equipment => (
            <Pill
              key={equipment.key}
              active={preferences.equipment.includes(equipment.key)}
              color={C.green}
              onClick={() => updatePreferences({
                equipment: toggleStretchEquipment(preferences.equipment, equipment.key),
              })}
              label={`${equipment.label} available`}
            >
              {equipment.label}
            </Pill>
          ))}
        </ControlGroup>
      </div>

      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        borderBottom: `1px solid ${C.border}`,
        paddingBottom: 7,
      }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>Today's plan</span>
        <span style={{ color: C.muted, fontSize: 11 }}>
          {chosenItems.length} movements
        </span>
      </div>

      <div>
        {chosenItems.map((item, index) => {
          const color = CATEGORY_COLORS[item.category] || C.purple;
          const expanded = openCategory === item.category;
          return (
            <div
              key={item.category}
              style={{
                padding: "11px 0",
                borderBottom: index < chosenItems.length - 1 ? `1px solid ${C.border}` : "none",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{
                  width: 42,
                  minHeight: 38,
                  flexShrink: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  borderLeft: `3px solid ${color}`,
                  color,
                  fontSize: 15,
                  fontWeight: 800,
                }}>
                  {item.minutes}
                  <span style={{ color: C.muted, fontSize: 8, fontWeight: 600 }}>MIN</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color, fontSize: 10, fontWeight: 700, marginBottom: 2 }}>
                    {item.categoryLabel}
                  </div>
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 6,
                    fontSize: 13,
                    fontWeight: 650,
                    color: C.text,
                  }}>
                    <span>{item.exercise.name}</span>
                    {item.exercise.videoUrl && (
                      <VideoLink
                        href={item.exercise.videoUrl}
                        ariaLabel={`View ${item.exercise.name} demo`}
                      />
                    )}
                  </div>
                  <div style={{ color: C.muted, fontSize: 10, marginTop: 2, lineHeight: 1.4 }}>
                    {item.exercise.prescription} · {equipmentLabel(item.exercise)}
                  </div>
                  {item.exercise.cue && (
                    <div style={{ color: C.muted, fontSize: 10, marginTop: 4, lineHeight: 1.4 }}>
                      {item.exercise.cue}
                    </div>
                  )}
                </div>
                {item.options.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setOpenCategory(expanded ? null : item.category)}
                    aria-expanded={expanded}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: C.blue,
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "4px 0 4px 6px",
                      cursor: "pointer",
                    }}
                  >
                    Swap
                  </button>
                )}
              </div>

              {expanded && (
                <div style={{ margin: "9px 0 0 52px", display: "grid", gap: 5 }}>
                  {item.options.map(option => {
                    const active = option.id === item.exercise.id;
                    return (
                      <div
                        key={option.id}
                        style={{ display: "flex", alignItems: "center", gap: 6 }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedByCategory(prev => ({ ...prev, [item.category]: option.id }));
                            setOpenCategory(null);
                          }}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 8,
                            textAlign: "left",
                            padding: "7px 9px",
                            borderRadius: 6,
                            border: `1px solid ${active ? color : C.border}`,
                            background: active ? `${color}18` : C.bg,
                            color: active ? C.text : C.muted,
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                          <span style={{ fontWeight: active ? 700 : 500 }}>{option.name}</span>
                          <span style={{ opacity: 0.8, whiteSpace: "nowrap" }}>
                            {equipmentLabel(option)}
                          </span>
                        </button>
                        {option.videoUrl && (
                          <VideoLink
                            href={option.videoUrl}
                            ariaLabel={`View ${option.name} demo`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, marginTop: 4 }}>
        <div style={{
          color: C.muted,
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          marginBottom: 7,
        }}>
          This week
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {Object.values(STRETCH_CATEGORIES).map(category => {
            const minutes = Number(coverage?.[category.key] || 0);
            return (
              <span
                key={category.key}
                style={{
                  border: `1px solid ${minutes > 0 ? `${CATEGORY_COLORS[category.key]}88` : C.border}`,
                  borderRadius: 12,
                  padding: "3px 7px",
                  color: minutes > 0 ? C.text : C.muted,
                  fontSize: 9,
                }}
              >
                {category.shortLabel} {minutes}m
              </span>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        onClick={logSession}
        disabled={chosenItems.length === 0}
        style={{
          width: "100%",
          minHeight: 44,
          marginTop: 16,
          padding: "11px 14px",
          border: "none",
          borderRadius: 8,
          background: chosenItems.length > 0 ? C.purple : C.border,
          color: chosenItems.length > 0 ? "#160c20" : C.muted,
          fontSize: 14,
          fontWeight: 800,
          cursor: chosenItems.length > 0 ? "pointer" : "not-allowed",
        }}
      >
        Log {plan.targetMinutes} minutes
      </button>
    </Card>
  );
}
