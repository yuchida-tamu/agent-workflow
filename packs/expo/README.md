# pack-expo — React Native Expo platform pack

Implements the four core capability interfaces (see `../../interfaces/`) for
RN Expo apps, and contributes platform policy rules and runner requirements.

| Piece | Status | Contents |
|---|---|---|
| `policies/expo.yaml` | ✅ | Platform hard triggers (native surface, SDK bumps, native deps) + navigation scoring |
| `runners.yml` | ✅ | Declares the self-hosted macOS simulator runner |
| `adapters/run` | ⬜ Phase 2 | Expo dev server + iOS simulator boot → `session_id` |
| `adapters/verify` | ⬜ Phase 2 | agent-device primitives (`snapshot` / `act` / `read`) → evidence bundle |
| `adapters/execute-step` | ⬜ Phase 2 | Deterministic replay of one compiled step trace via agent-device |
| `adapters/ship` | ⬜ Phase 2 | EAS build / submit, TestFlight distribution |
| `skills/` | ⬜ Phase 2 | `expo-dev` · `mobile-verify` · `release` |
