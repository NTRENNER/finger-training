# Evidence and context contract

September 24, 2026. This defines the next modified-training feature; it does not add that mode or invent historical context.

- Preserve recorded activity, force and time regardless of model eligibility.
- Valid muscular failure after climbing remains evidence of performance that day. Climbing and fatigue reports are context, not grounds to discard a weak result. Missing climb logs mean unknown activity, not a confirmed rest day. Compare pre/post climbing only when ordering is known.
- A fatigue report is separate from choosing a load adjustment. Keeping the recommended load must never retroactively inflate a fresh-equivalent estimate. Preserve the adjustment captured at recording.
- Illness or modified training must be explicitly reported, never inferred from a low result. Test any stable-capacity downweighting in research first. Repeated valid low performances must still inform current prescriptions; context cannot permanently protect an old high floor.
- A pain-limited or deliberately submaximal stop is activity, not demonstrated muscular failure. A future mode must write `failure_valid: false` and an explicit stop reason, with compatible storage validation. Keep its force/time but exclude it from failure-duration fits and progression gates. A completed submaximal hold is, at most, a lower bound; do not treat it as exact failure or silently convert it into a maximum.
- Equipment interruptions keep elapsed activity and interruption metadata. No fabricated zero-second capacity point, no bridging an interrupted recovery prefix.
- Manual nominal settings can anchor load suggestions, but cannot establish measured force consistency for recovery.
- Whole Curve remains optional. Later mixed-load holds are training exposure and experimental fatigue observations, not fresh anchors or ordinary constant-load recovery evidence. First in a set does not mean recovered from climbing.

Before enabling a modified-training mode, test capture, persistence, history editing, exports, progression and research exclusions end to end. Add only metadata the athlete actually supplied. Do not apply an arbitrary “sick day” allowance, population readiness band, or automatic clinical recommendation.
