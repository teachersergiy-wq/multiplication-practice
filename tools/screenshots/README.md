# C15 — mobile screenshots for student flow and BIG bank

The Playwright script captures the student login, the first numeric question, the same question with a reduced viewport that emulates the open mobile keyboard, the result screen, the BIG creation dialog, and the bank manager. It checks for horizontal overflow at both target sizes (**360×640** and **390×844**) and verifies that **«Зберегти й далі»** stays visible above the simulated keyboard.

## Prerequisites

- Node.js **22.18 or newer**, per the repository's package manifest.
- A running copy of the app configured against an **isolated staging/test Supabase project**, not production.
- Dedicated synthetic teacher and student test accounts. The student must have an enabled numeric test assigned. The teacher must have access to a BIG draft for the selected grade, unless the optional create-bank mode below is used.
- Playwright and the Chromium browser, installed locally without editing project dependency files:

    npm ci
    npm install --no-save --package-lock=false playwright
    npx playwright install chromium

The package manifests are intentionally unchanged. The script and this README are the only source files added for C15.

## Run

Start the configured app in one terminal, for example:

    npm run dev -- --host 127.0.0.1

In another terminal, provide credentials through environment variables. Do not paste credentials into the script, commit .env files, or use real student accounts/data.

macOS / Linux:

    export PLAYWRIGHT_BASE_URL='http://127.0.0.1:5173'
    export PLAYWRIGHT_TEACHER_EMAIL='synthetic-teacher@example.test'
    export PLAYWRIGHT_TEACHER_PASSWORD='set-locally'
    export PLAYWRIGHT_STUDENT_LOGIN='abcd'
    export PLAYWRIGHT_STUDENT_PASSWORD='set-locally'
    # Optional, when the account has multiple assignments / BIG drafts:
    export PLAYWRIGHT_STUDENT_ASSIGNMENT_TITLE='Numeric test'
    export PLAYWRIGHT_TEACHER_BANK_TEMPLATE_TITLE='BIG test'
    export PLAYWRIGHT_TEACHER_GRADE='3'
    node tools/screenshots/mobile-screenshots.mjs

Windows PowerShell:

    $env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:5173'
    $env:PLAYWRIGHT_TEACHER_EMAIL = 'synthetic-teacher@example.test'
    $env:PLAYWRIGHT_TEACHER_PASSWORD = 'set-locally'
    $env:PLAYWRIGHT_STUDENT_LOGIN = 'abcd'
    $env:PLAYWRIGHT_STUDENT_PASSWORD = 'set-locally'
    node tools/screenshots/mobile-screenshots.mjs

The script writes PNGs to **artifacts/mobile-screenshots/** by default; set **SCREENSHOT_DIR** to change the output directory. Captures use the exact viewport rather than full-page screenshots so clipped controls remain visible. The question-with-keyboard captures halve the viewport height to simulate the reduced visible area on a phone. Test answers are synthetic (**0**); they may be marked wrong and are used only to reach the result screen.

## BIG bank manager setup

By default, the script opens an existing BIG draft matching **PLAYWRIGHT_TEACHER_BANK_TEMPLATE_TITLE** (or the first available BIG draft for **PLAYWRIGHT_TEACHER_GRADE**). If no suitable draft exists, either prepare one in the isolated test project or explicitly opt in to creating a synthetic bank:

    PLAYWRIGHT_CREATE_BIG_BANK=1 PLAYWRIGHT_ALLOW_TEST_DATA_MUTATIONS=1 node tools/screenshots/mobile-screenshots.mjs

On PowerShell, set both variables to **1** before running the script. This mode creates a new draft in the configured database, so it is refused unless both flags are set. **Never use this mode against production.**

## Output and acceptance

The script produces up to 12 PNG files and exits non-zero if it detects horizontal overflow, fails to see the primary action with the reduced viewport, or cannot complete a required flow. Share the generated PNGs as PR artifacts or attach them in the PR conversation; generated screenshots are test output and are not committed by default. Never attach screenshots containing real student information.

Status is **PARTIAL** until this script has been run against the configured test environment and the PNGs have been reviewed. A syntax/help check does not verify the live UI or replace screenshots from a real browser session.
