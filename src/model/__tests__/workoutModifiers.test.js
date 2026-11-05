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
    // Setups compare by modifier name and value, not by internal id.
    expect(modifierSelectionSignature(set)).toBe("slingshot=red");

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

  test("band modifiers use the standard palette and store multi-band combinations canonically", () => {
    const modifier = createModifierDefinition({
      name: "Band support",
      kind: "assistance",
      control: "bands",
    });
    expect(modifier.control).toBe("bands");
    expect(modifier.options.map(option => option.id)).toEqual([
      "yellow", "orange", "red", "green", "blue", "purple", "black",
    ]);

    const assisted = setModifierSelection({}, modifier, ["blue", "green"]);
    expect(modifierSelectionLabel(assisted)).toBe("Band support: Green + Blue");
    expect(modifierSelectionSignature(assisted)).toBe("bandsupport=green+blue");
  });

  // Nathan's front lever sets carry an old "Band" definition beside its
  // replacement, both Red. They must match a set with only the new one, the
  // menu must offer one band picker, and carrying forward keeps one Band.
  test("duplicate band definitions match, list once, and carry forward once", () => {
    const { modifierMenu, carryModifierSelections, QUICK_MODIFIERS } = require("../workoutModifiers.js");
    const current = { id: "modifier_band_mglzk", name: "Band", kind: "setup", control: "bands",
      options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }] };
    const legacy = { modifierId: "modifier_band_iqdun", name: "Band", kind: "assistance", value: "red_1", valueLabel: "Red" };
    const both = { modifiers: { modifier_band_iqdun: legacy,
      modifier_band_mglzk: { modifierId: current.id, name: "Band", kind: "setup", value: "red", valueLabel: "Red" } } };
    const today = setModifierSelection({}, current, ["red"]);
    expect(modifierSelectionSignature(both)).toBe(modifierSelectionSignature(today));
    const menu = modifierMenu([current, ...QUICK_MODIFIERS]);
    expect(menu.filter(definition => definition.control === "bands").map(definition => definition.id)).toEqual([current.id]);
    expect(menu.map(definition => definition.name)).toEqual(expect.arrayContaining(["Band", "Slingshot", "Tempo"]));
    expect(modifierMenu([current, ...QUICK_MODIFIERS], ["modifier_tempo"]).some(definition => definition.id === "modifier_tempo")).toBe(false);
    expect(Object.keys(carryModifierSelections(both, menu))).toEqual([current.id]);
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
