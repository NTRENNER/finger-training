# Performance trend charts

Analysis → Fingers has linked long- and short-term cards above the existing
collapsed overall-curve summary. The shared two-handle date slider, date inputs,
and Show all dates control change only the visible window. Fits always use
history available at each plotted date. Grip and hand changes reset the window;
new history preserves a deliberately selected date window. Counts mean plotted
training dates, not repetitions or sessions. Rest days do not generate points.

Long-term capacity uses the existing experimental established-curve fit (90-day
half-life, one total weight per training date). It is shown as percentage change
from the first available established estimate, separately for each grip. Both-hand
capacity uses the geometric mean of the two hand scores with equal hand weights,
and requires both curves. Each hand needs five eligible prior-or-current dates.
This baseline is separate from the older frozen-baseline summary. These are
whole-curve estimates; sparse duration coverage can still affect their shape.

Short-term performance compares eligible measured opening force with the
established curve available strictly before that training day, evaluated at the
observed hold duration. It is a force ratio, not seconds or percentage points.
Only durations within that hand's prior observed range are scored. Within a day,
observations are averaged per hand, then available hands are averaged equally.
Later fatigued reps, interruptions, manual load estimates and duplicate evidence
cannot supply fresh performance points. Recording intervals use the shared
conversion rules; incompatible transitions cannot produce short-term scores.

The fitted curve itself may have error: a residual is not proof of fatigue,
recovery, or physiological change. Charts are descriptive and experimental. They
do not update prescriptions, the 4–5–6 ladder, or stored workout records. Both
cards use measured force rather than bodyweight normalization; that distinction
is shown when the bodyweight toggle is selected. Optional climbing bars represent
the existing same-day/previous-day load estimate at plotted dates, not a causal
explanation. Chart scales include a minimum ±5% range to avoid magnifying noise.

Validation covers historical stability when future data is appended, pre-day
comparisons, invalid evidence, duration extrapolation, independent range handles,
keyboard access, shared windows without model refits, and empty/single-date cases.
Phone (375px) and desktop (1280px) previews use synthetic training data.
