# Tindeq battery monitoring

The connection setup requests battery voltage once after subscribing to notifications and awaits that write before exposing the connection to session controls. A reconnect repeats the check when no measurement is active. There is no periodic polling or battery control write during a rep.

Protocol source: [Tindeq's published Python example](https://github.com/blims/Tindeq-Progressor-API/blob/main/progressor_client.py), linked from [the manufacturer API documentation](https://tindeq.com/progressor_api/): command 111 requests voltage, response 0 contains a uint32 little-endian millivolt value, and response 4 indicates low power.

A voltage response is accepted only while that query is pending and its four-byte payload is valid. A missing, malformed, or unsupported response becomes unavailable after two seconds. Battery-query errors do not prevent training. Voltage is displayed as voltage, without an estimated percentage or a claim that the battery is healthy. The replaceable-battery warning is driven by the device's low-power notification, not an unverified voltage threshold.

Battery messages do not refresh the force-stream watchdog, start or end reps, or enter force/time calculations. A low-battery warning alone does not interrupt a rep. Existing signal-loss handling still classifies missing force data as an equipment interruption.

Every sensor result carries an immutable `force_recording.battery` snapshot containing the read status, voltage in millivolts, voltage timestamp, whether a warning was observed, and the warning timestamp. This uses the existing force-recording JSON and requires no database schema change. Interrupted results display this context in the rest screen, session summary, and history without claiming the battery caused the interruption. Warm-ups show the warning but remain unlogged.

Automated checks cover valid and malformed messages, missing replies, unsupported commands, startup warnings, reconnects, force-stream stalls despite battery notifications, manual/automatic interruption snapshots, and persistence. The response on Nathan's physical replaceable-battery unit remains to be verified after deployment.
