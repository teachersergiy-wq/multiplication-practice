# Student UI: mobile-first requirements

Status: requirement (owner, 2026-10-22). Students use the app mainly on **smartphones**.
Applies to every student-facing screen: login, assignment list, test-taking, result.
Teacher screens should work on a phone but are desktop-first.

## Viewport and layout
- Design for 360×640 first; must also work at 390×844, 412×915, tablets and desktop.
- No horizontal page scroll at any width ≥ 320 px.
- Single column on phones. Respect safe areas (`env(safe-area-inset-*)`), use `100dvh`, not `100vh`.
- Primary action (Next / Finish) reachable with one thumb: sticky bottom bar is fine.

## Touch targets and type
- Interactive targets ≥ 44×44 px with ≥ 8 px spacing.
- Question text ≥ 18 px; answer options ≥ 16 px; no text below 14 px on student screens.
- Form inputs font-size ≥ 16 px (prevents iOS zoom on focus).

## Input per question type (D2)
- Numeric answers: `inputmode="numeric"` (or `decimal` when decimals allowed), `autocomplete="off"`.
- Login field: 4 Latin letters, `autocapitalize="none"`, `autocorrect="off"`, `spellcheck="false"`.
- Password: `autocomplete="current-password"`.
- Matching / ordering: drag-and-drop must not be the only way. Provide tap-to-select / up-down buttons that work by touch and keyboard.
- Multiple choice: whole option row is the tap target.

## Resilience
- The server owns the deadline (start + limit + 15 s); the client timer is display-only and re-syncs from the server value on resume (`visibilitychange`, `online`).
- Do not lose typed input on screen lock, tab switch or brief network loss: keep the draft in memory/sessionStorage and retry submit-answer idempotently.
- Show a clear offline/retry state; never silently drop an answer.
- Keep payloads small (no large images/fonts on student screens); target usable on a mid-range phone over 3G/4G.

## Graded vs practice (D5)
Layout must not reveal correctness before finish in graded mode; do not rely on colour alone for correct/incorrect in practice mode.

## Acceptance (added to C6 #29 / C7 #44 for student screens)
- [ ] Checked at 360×640 and 390×844: no horizontal scroll, nothing clipped.
- [ ] Targets ≥ 44 px; question ≥ 18 px; inputs ≥ 16 px.
- [ ] All 7 question types answerable by touch only.
- [ ] Numeric keypad appears for numeric answers.
- [ ] Locking the screen / switching tabs mid-test does not lose the draft answer.
- [ ] (Optional, separate task) Playwright screenshots at the two sizes in CI.
