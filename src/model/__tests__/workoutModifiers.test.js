import {
  copyModifierSelections,
  createModifierDefinition,
  filterHistoryForModifierSetup,
  modifierSelectionLabel,
  modifierSelectionSignature,
  setModifierSelection,
} from "../workoutModifiers.js";

describe("workout modifiers", () => {
  test("a reusable modifier stores stable choices and immutable set snapshots", () => {
    const modifier = createModifierDefinition({
      name: "Slingshot",
      kind: "assistance",
      options: ["Red", "Blue"],
    });
    expect(modifier).toMatchObject({ name: "Slingshot", kind: "assistance" });
    expect(modifier.options.map(option => option.label)).toEqual(["Red", "Blue"]);

    const set = setModifierSelection({ reps: "5", weight: "225" }, modifier, modifier.options[0].id);
    expect(modifierSelectionLabel(set)).toBe("Slingshot: Red");
    expect(modifierSelectionSignature(set)).toBe(`${modifier.id}=${modifier.options[0].id}`);

    modifier.name = "Renamed later";
    expect(modifierSelectionLabel(set)).toBe("Slingshot: Red");
    expect(copyModifierSelections(set)).not.toBe(set.modifiers);
  });

  test("binary modifiers are on/off and removing one restores the raw setup", () => {
    const modifier = createModifierDefinition({ name: "Band support", kind: "assistance" });
    const assisted = setModifierSelection({}, modifier, "on");
    expect(modifierSelectionLabel(assisted)).toBe("Band support");
    expect(modifierSelectionSignature(assisted)).not.toBe("");
    expect(modifierSelectionSignature(setModifierSelection(assisted, modifier, ""))).toBe("");
  });

  test("history filtering keeps only directly comparable set setups", () => {
    const modifier = createModifierDefinition({ name: "Slingshot", kind: "assistance" });
    const raw = { reps: "5", weight: "200", done: true };
    const assisted = { ...setModifierSelection({ reps: "5", weight: "225" }, modifier, "on"), done: true };
    const history = [
      { date: "2026-10-20", exercises: { benchPress: { sets: [raw, assisted] } } },
      { date: "2026-10-22", exercises: { benchPress: { sets: [assisted] } } },
    ];

    const rawHistory = filterHistoryForModifierSetup(history, "benchPress", raw);
    expect(rawHistory).toHaveLength(1);
    expect(rawHistory[0].exercises.benchPress.sets).toEqual([raw]);

    const assistedHistory = filterHistoryForModifierSetup(history, "benchPress", assisted);
    expect(assistedHistory).toHaveLength(2);
    expect(assistedHistory.every(session => session.exercises.benchPress.sets
      .every(set => modifierSelectionLabel(set) === "Slingshot"))).toBe(true);
  });
});
